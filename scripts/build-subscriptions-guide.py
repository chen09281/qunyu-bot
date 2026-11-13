"""Build the same fixed guide sent by /订阅 文档. Requires python-docx."""
from pathlib import Path
import runpy
import sys

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / '.local/subscriptions-guide/订阅推送使用说明.docx'
output.parent.mkdir(parents=True, exist_ok=True)
renderer = runpy.run_path(str(root / 'src/document-worker.py'))
content = (root / 'src/subscriptions/usage-guide.md').read_text(encoding='utf-8')
renderer['docx_file'](output, '订阅推送使用说明', renderer['blocks'](content, rich=True), guide=True)
print(output)
