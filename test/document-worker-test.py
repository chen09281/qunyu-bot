import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('document_worker', Path(__file__).resolve().parent.parent / 'src' / 'document-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
chromium = os.environ.get('DOCUMENT_CHROMIUM') or shutil.which('chromium') or shutil.which('chromium-browser')


class DocumentTests(unittest.TestCase):
    content = '# 主题\n\n正文内容\n\n- 列表一\n- 列表二\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | 正常 |\n\n```python\nprint("hello")\n```'

    def test_markdown_structure_preserves_code_and_table_cells(self):
        parts = worker.blocks(self.content)
        self.assertEqual([part[0] for part in parts], ['heading', 'paragraph', 'bullet', 'bullet', 'table', 'code'])
        self.assertEqual(parts[-2][1][1], ['中文', '正常'])
        self.assertEqual(parts[-1][1], 'print("hello")')

    def test_code_and_html_are_data_not_commands_and_text_is_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            content = self.content + '\n__import__("os").system("touch SHOULD_NOT_EXIST")\n<script>test</script>'
            data = {'title': '中文标题', 'content': content, 'formats': ['md', 'txt'], 'directory': directory}
            result = subprocess.run([sys.executable, '-I', worker.__file__], input=json.dumps(data), text=True, capture_output=True, cwd=directory)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual((Path(directory) / 'document.md').read_text(), content)
            self.assertIn('中文标题', (Path(directory) / 'document.txt').read_text())
            self.assertIn('print("hello")', (Path(directory) / 'document.txt').read_text())
            self.assertFalse((Path(directory) / 'SHOULD_NOT_EXIST').exists())

    def test_pdf_escapes_scripts_and_files_and_disables_external_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'document.pdf'
            def run(args, **_kwargs):
                self.assertIn('--proxy-server=http://127.0.0.1:9', args)
                self.assertIn('--no-pdf-header-footer', args)
                path.write_bytes(b'%PDF-1.7\n')
            with patch.object(worker.subprocess, 'run', side_effect=run):
                worker.pdf_file(path, '<script>标题</script>', worker.blocks('1. 第一条\n2. 第二条\n<script>bad()</script>\n![图片](file:///etc/passwd)'), sys.executable)
            html = path.with_suffix('.html').read_text()
            self.assertNotIn('<script>', html); self.assertNotIn('<img', html)
            self.assertIn('default-src \'none\'', html)
            self.assertIn('1. 第一条', html); self.assertIn('2. 第二条', html)

    @unittest.skipUnless(chromium and Path(chromium).is_file(), 'Chromium not installed')
    def test_pdf_worker_renders_with_process_file_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            data = {'title': '中文标题', 'content': self.content, 'formats': ['pdf'], 'directory': directory, 'chromium': chromium}
            result = subprocess.run([sys.executable, '-I', worker.__file__], input=json.dumps(data), text=True,
                                    capture_output=True, cwd=directory, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout)
            path = Path(directory) / 'document.pdf'
            self.assertTrue(path.read_bytes().startswith(b'%PDF-'))
            self.assertLessEqual(path.stat().st_size, 10 * 1024 * 1024)

    @unittest.skipUnless(importlib.util.find_spec('docx'), 'python-docx not installed')
    def test_word_has_real_headings_cjk_styles_and_visible_table_borders(self):
        from docx import Document
        from docx.oxml.ns import qn
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'document.docx'
            worker.docx_file(path, '中文标题', worker.blocks(self.content))
            doc = Document(path)
            self.assertEqual(doc.paragraphs[0].style.name, 'Title')
            self.assertEqual(doc.paragraphs[0].text, '中文标题')
            self.assertEqual(doc.tables[0].cell(1, 0).text, '中文')
            self.assertIn('tblBorders', doc.tables[0]._tbl.xml)
            self.assertEqual(doc.styles['Normal'].element.rPr.rFonts.get(qn('w:eastAsia')), 'Noto Sans CJK SC')
            self.assertNotIn('pBdr', doc.styles['Title'].element.xml)

    @unittest.skipUnless(importlib.util.find_spec('docx'), 'python-docx not installed')
    def test_binding_guide_keeps_commands_links_emphasis_and_section_boundaries(self):
        from docx import Document
        content = (Path(worker.__file__).parent / 'checkin' / 'binding-guide.md').read_text()
        with tempfile.TemporaryDirectory() as directory:
            data = {'title': '签到账号绑定教程', 'content': content, 'formats': ['docx'],
                    'directory': directory, 'layout': 'checkin-binding'}
            result = subprocess.run([sys.executable, '-I', worker.__file__], input=json.dumps(data), text=True,
                                    capture_output=True, cwd=directory)
            self.assertEqual(result.returncode, 0, result.stdout)
            doc = Document(Path(directory) / 'document.docx')
            headings = [p for p in doc.paragraphs if p.style.name == 'Heading 1']
            self.assertEqual([p.text for p in headings], ['快速开始', '森空岛绑定', '米游社绑定', '库街区电脑获取与绑定', '库街区安卓 App 获取与绑定', '库街区 iOS 获取与绑定', '命令速查与常见问题'])
            self.assertFalse(headings[0].paragraph_format.page_break_before)
            self.assertTrue(all(p.paragraph_format.page_break_before for p in headings[1:]))
            self.assertTrue(any(r.bold for p in doc.paragraphs for r in p.runs))
            targets = [r.target_ref for r in doc.part.rels.values() if r.reltype.endswith('/hyperlink')]
            self.assertIn('https://web-api.skland.com/account/info/hg', targets)
            download = 'https://bot.example.com/tools/kuro/'
            self.assertIn(download, targets)
            self.assertIn('https://scriptable.app/', targets)
            self.assertTrue(all(url.startswith('https://') or url == download for url in targets))
            self.assertTrue(any(p.text == '/签到 绑定 米游社 account_id_v2=123456789; cookie_token_v2=YOUR_COOKIE_TOKEN' for p in doc.paragraphs))
            self.assertTrue(all('cantSplit' in row._tr.xml for table in doc.tables for row in table.rows))
            self.assertNotIn('**', doc.element.xml)
            self.assertNotIn('`Cookie:`', doc.element.xml)


if __name__ == '__main__':
    unittest.main()
