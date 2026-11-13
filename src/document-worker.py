"""Render bounded document data. Never execute model code or fetch external assets."""
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def plain(value):
    value = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'[图片：\1]', value)
    value = re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', r'\1 (\2)', value)
    return re.sub(r'\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`', lambda match: next(group for group in match.groups() if group is not None), value)


def blocks(content, rich=False):
    text_value = (lambda value: value) if rich else plain
    lines, output, index = content.replace('\r\n', '\n').split('\n'), [], 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        fence = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence:
            code, index = [], index + 1
            while index < len(lines) and not re.match(r'^\s*' + re.escape(fence[1]) + r'\s*$', lines[index]):
                code.append(lines[index]); index += 1
            output.append(('code', '\n'.join(code))); index += 1
            continue
        heading = re.match(r'^\s{0,3}(#{1,6})\s+(.+?)\s*#*$', line)
        if heading:
            output.append(('heading', (min(3, len(heading[1])), plain(heading[2])))); index += 1
            continue
        if index + 1 < len(lines) and '|' in line and re.fullmatch(r'\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*', lines[index + 1]):
            cells = lambda text: [text_value(cell.strip()) for cell in text.strip().strip('|').split('|')]
            rows = [cells(line)]; index += 2
            while index < len(lines) and '|' in lines[index] and lines[index].strip():
                rows.append(cells(lines[index])); index += 1
            columns = len(rows[0])
            if columns <= 8 and len(rows) <= 300:
                output.append(('table', [(row + [''] * columns)[:columns] for row in rows]))
            else:
                output.extend(('paragraph', ' | '.join(row)) for row in rows)
            continue
        item = re.match(r'^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$', line)
        if item:
            output.append(('number' if item[2] else 'bullet', text_value(item[3]))); index += 1
            continue
        if re.fullmatch(r'\s*(?:-{3,}|\*{3,}|_{3,})\s*', line):
            index += 1
            continue
        output.append(('paragraph', text_value(line.removeprefix('> ').strip()))); index += 1
    return output


def column_weights(rows):
    return [max(8, min(35, max(len(row[column]) for row in rows))) for column in range(len(rows[0]))]


def docx_file(path, title, parts, guide=False):
    from docx import Document
    from docx.shared import Mm, Pt, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.opc.constants import RELATIONSHIP_TYPE as RT

    def inline(paragraph, text):
        # The fixed member guide uses emphasis and named links; no HTML or remote assets.
        pattern = r'\[([^\]]+)\]\((https?://[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`'
        end = 0
        for match in re.finditer(pattern, text):
            paragraph.add_run(text[end:match.start()])
            if match[1]:
                link = OxmlElement('w:hyperlink')
                link.set(qn('r:id'), paragraph.part.relate_to(match[2], RT.HYPERLINK, is_external=True))
                run = OxmlElement('w:r'); properties = OxmlElement('w:rPr')
                color = OxmlElement('w:color'); color.set(qn('w:val'), '245A81'); properties.append(color)
                underline = OxmlElement('w:u'); underline.set(qn('w:val'), 'single'); properties.append(underline)
                run.append(properties); value = OxmlElement('w:t'); value.text = match[1]; run.append(value)
                link.append(run); paragraph._p.append(link)
            else:
                run = paragraph.add_run(plain(match[3]) if match[3] else match[4])
                if match[3]:
                    run.bold = True
                else:
                    run.font.name = 'Consolas'
            end = match.end()
        paragraph.add_run(text[end:])
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Mm(20)
    for name, size in [('Normal', 11), ('Title', 24), ('Heading 1', 16), ('Heading 2', 13), ('Heading 3', 12), ('List Bullet', 11), ('List Number', 11)]:
        style = doc.styles[name]
        style.font.name, style.font.size, style.font.color.rgb = 'Noto Sans CJK SC', Pt(size), RGBColor(0, 0, 0)
        style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Noto Sans CJK SC')
        for attribute in ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme']:
            style.element.rPr.rFonts.attrib.pop(qn('w:' + attribute), None)
        if style.element.pPr is not None:
            for border in list(style.element.pPr.findall(qn('w:pBdr'))):
                style.element.pPr.remove(border)
        style.paragraph_format.line_spacing = Pt(size * 1.4) if guide else 1.4
        style.paragraph_format.space_after = Pt(6 if guide else 7)
        if name.startswith('Heading'):
            style.paragraph_format.keep_with_next = True
            style.paragraph_format.space_before = Pt(10 if guide else 14)
    doc.core_properties.title, doc.core_properties.author = title, ''
    doc.core_properties.last_modified_by, doc.core_properties.comments = '', ''
    doc.add_paragraph(title, 'Title')
    main_heading_seen = False
    for kind, value in parts:
        if kind == 'heading':
            if value[1].strip() == title.strip():
                continue
            heading = doc.add_heading(value[1], level=value[0])
            if guide and value[0] == 1:
                heading.paragraph_format.page_break_before = main_heading_seen
                main_heading_seen = True
        elif kind == 'table':
            table = doc.add_table(rows=0, cols=len(value[0])); table.autofit = False
            weights = column_weights(value)
            for column, weight in zip(table.columns, weights):
                column.width = Mm(170 * weight / sum(weights))
            borders = OxmlElement('w:tblBorders')
            for edge in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
                border = OxmlElement('w:' + edge)
                for key, attr in [('val', 'single'), ('sz', '4'), ('color', 'D9D9D9')]:
                    border.set(qn('w:' + key), attr)
                borders.append(border)
            table._tbl.tblPr.append(borders)
            for row_index, values in enumerate(value):
                row = table.add_row()
                if guide:
                    row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
                if row_index == 0:
                    row._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
                for column, (cell, text) in enumerate(zip(row.cells, values)):
                    cell.width, cell.vertical_alignment = Mm(170 * weights[column] / sum(weights)), WD_CELL_VERTICAL_ALIGNMENT.CENTER
                    properties = cell._tc.get_or_add_tcPr()
                    margins = OxmlElement('w:tcMar')
                    for edge in ['top', 'left', 'bottom', 'right']:
                        margin = OxmlElement('w:' + edge); margin.set(qn('w:w'), '100'); margin.set(qn('w:type'), 'dxa'); margins.append(margin)
                    properties.append(margins)
                    if row_index == 0:
                        shade = OxmlElement('w:shd'); shade.set(qn('w:fill'), 'E8EFF6'); properties.append(shade)
                    paragraph = cell.paragraphs[0]
                    paragraph.paragraph_format.space_after = Pt(3)
                    if guide:
                        inline(paragraph, text)
                        for run in paragraph.runs:
                            run.font.size = Pt(10); run.bold = row_index == 0 or run.bold
                    else:
                        run = paragraph.add_run(text); run.font.size = Pt(10); run.bold = row_index == 0
            doc.add_paragraph().paragraph_format.space_after = Pt(3)
        else:
            paragraph = doc.add_paragraph('', 'List Bullet' if kind == 'bullet' else 'List Number' if kind == 'number' else 'Normal')
            if guide and kind != 'code':
                inline(paragraph, value)
            else:
                paragraph.add_run(value)
            if guide:
                paragraph.paragraph_format.keep_together = True
                if re.fullmatch(r'\*\*[^*]+\*\*', value):
                    paragraph.paragraph_format.keep_with_next = True
            if kind == 'code':
                paragraph.paragraph_format.line_spacing = Pt(15) if guide else 1.15
                for run in paragraph.runs:
                    run.font.name, run.font.size = 'Consolas', Pt(10 if guide else 9)
                if guide:
                    paragraph.paragraph_format.left_indent = Mm(3)
                    paragraph.paragraph_format.space_before = Pt(3)
                    paragraph.paragraph_format.space_after = Pt(9)
    footer = section.footer.paragraphs[0]; footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE'); footer._p.append(field)
    doc.save(path)


def pdf_file(path, title, parts, chromium):
    if not chromium or not Path(chromium).is_file():
        raise ImportError('Chromium unavailable')
    body, number = ['<h1 class="title">' + html.escape(title) + '</h1>'], 0
    for kind, value in parts:
        number = number + 1 if kind == 'number' else 0
        if kind == 'heading':
            if value[1].strip() != title.strip():
                body.append('<h%d>%s</h%d>' % (value[0] + 1, html.escape(value[1]), value[0] + 1))
        elif kind == 'table':
            weights = column_weights(value)
            body.append('<table><colgroup>' + ''.join('<col style="width:%.2f%%">' % (100 * weight / sum(weights)) for weight in weights) + '</colgroup><thead>')
            for row_index, row in enumerate(value):
                tag = 'th' if row_index == 0 else 'td'
                body.append('<tr>' + ''.join('<%s>%s</%s>' % (tag, html.escape(text), tag) for text in row) + '</tr>')
                if row_index == 0:
                    body.append('</thead><tbody>')
            body.append('</tbody></table>')
        else:
            tag = 'pre' if kind == 'code' else 'p'
            body.append('<%s>%s%s</%s>' % (tag, '• ' if kind == 'bullet' else str(number) + '. ' if kind == 'number' else '', html.escape(value), tag))
    source = path.with_suffix('.html')
    source.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>''' + html.escape(title) + '''</title><style>
@page { size:A4; margin:20mm; } * { box-sizing:border-box; }
body { font:11pt/1.5 "Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif; color:#000; }
h1,h2,h3,h4 { color:#000; line-height:1.3; break-after:avoid; margin:16pt 0 8pt; }
.title { font-size:24pt; margin-top:0; } h2 { font-size:16pt; } h3 { font-size:13pt; } h4 { font-size:12pt; }
p { margin:0 0 8pt; orphans:2; widows:2; overflow-wrap:anywhere; }
pre { font:9pt/1.4 monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
table { border-collapse:collapse; table-layout:fixed; width:100%; margin:12pt 0; font-size:10pt; }
th,td { border:1px solid #d9d9d9; padding:6pt; vertical-align:middle; overflow-wrap:anywhere; }
th { background:#e8eff6; text-align:left; } thead { display:table-header-group; } tr { break-inside:avoid; }
</style><body>''' + ''.join(body) + '</body></html>', encoding='utf-8')
    subprocess.run([chromium, '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
                    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run',
                    '--no-default-browser-check', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
                    '--user-data-dir=' + str(path.parent / 'chromium-profile'), '--no-pdf-header-footer',
                    '--print-to-pdf=' + str(path), source.as_uri()], capture_output=True, timeout=60, check=True)
    if not path.is_file() or not path.read_bytes().startswith(b'%PDF-'):
        raise ValueError('Invalid PDF')


def main():
    raw = sys.stdin.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise ValueError('Input too large')
    data = json.loads(raw)
    title, content, formats = data['title'], data['content'], data['formats']
    if not isinstance(title, str) or not 0 < len(title) <= 150 or not isinstance(content, str) or not 0 < len(content) <= 60000 \
            or not isinstance(formats, list) or not 1 <= len(formats) <= 4 or len(set(formats)) != len(formats) \
            or any(fmt not in ('docx', 'pdf', 'md', 'txt') for fmt in formats):
        raise ValueError('Invalid document')
    directory = Path(data['directory'])
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('Invalid output directory')
    directory = directory.resolve()
    os.umask(0o077)
    if os.name == 'posix':
        import resource
        # Chromium needs larger scratch files; exported documents remain capped at 10 MiB below.
        file_limit = (64 if 'pdf' in formats else 10) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    parts, files = blocks(content), []
    for fmt in formats:
        path = directory / ('document.' + fmt)
        if fmt == 'docx':
            guide = data.get('layout') in ('checkin-binding', 'subscription-guide', 'tavern-guide')
            docx_file(path, title, blocks(content, rich=True) if guide else parts, guide=guide)
        elif fmt == 'pdf':
            pdf_file(path, title, parts, data.get('chromium'))
        else:
            text = content if fmt == 'md' else title + '\n\n' + '\n\n'.join('\n'.join('\t'.join(row) for row in value) if kind == 'table'
                        else value[1] if kind == 'heading' else value for kind, value in parts)
            path.write_text(text, encoding='utf-8')
        if not path.is_file() or not 0 < path.stat().st_size <= 10 * 1024 * 1024:
            raise ValueError('Invalid output size')
        files.append(path.name)
    return {'files': files}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except ImportError:
        print(json.dumps({'error': 'dependencies'})); sys.exit(1)
    except subprocess.TimeoutExpired:
        print(json.dumps({'error': 'timeout'})); sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'render'})); sys.exit(1)
