import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('kuro_token', Path(__file__).resolve().parent.parent / 'src/checkin/token-tool/kuro_token.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
SECRET = 'PRIVATE_TEST_TOKEN_12345678'


class Response(io.BytesIO):
    status = 200


class Transport:
    def __init__(self, data):
        self.data = data
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        return Response(json.dumps(self.data).encode())


@contextlib.contextmanager
def server(login_fn=None):
    calls = []
    def mocked(mobile, code):
        calls.append((mobile, code))
        return {'token': SECRET, 'userId': '12345', 'devCode': 'device123'}
    app = tool.ToolServer(login_fn=login_fn or mocked)
    thread = threading.Thread(target=app.serve_forever, daemon=True)
    thread.start()
    try:
        yield app, calls
    finally:
        app.shutdown()
        app.server_close()
        thread.join(timeout=2)


def request(app, path, data=None, headers=None):
    headers = headers or {}
    raw = None if data is None else json.dumps(data).encode()
    try:
        with urlopen(Request(app.origin + path, data=raw, headers=headers), timeout=2) as response:
            return response.status, response.read(), response.headers
    except HTTPError as error:
        return error.code, error.read(), error.headers


class KuroToolTests(unittest.TestCase):
    def test_login_uses_fixed_https_and_same_device_then_generates_compatible_command(self):
        transport = Transport({'code': 200, 'data': {'token': SECRET, 'userId': 12345}})
        credential = tool.login('13800000000', '123456', 'same-device', transport)
        self.assertEqual(credential, {'token': SECRET, 'userId': '12345', 'devCode': 'same-device'})
        req, timeout = transport.calls[0]
        self.assertEqual(req.full_url, 'https://api.kurobbs.com/user/sdkLogin')
        self.assertEqual(req.get_header('Devcode'), 'same-device')
        self.assertEqual(parse_qs(req.data.decode())['devCode'], ['same-device'])
        self.assertEqual(timeout, 20)
        self.assertEqual(json.loads(tool.binding_command(credential).split(' ', 3)[3]), credential)

    def test_rejects_invalid_input_and_redacts_platform_errors(self):
        transport = Transport({})
        for mobile, code in [('bad', '123456'), ('13800000000', 'x'), ('13800000000\r\nX:1', '123456')]:
            with self.assertRaises(tool.ToolError):
                tool.login(mobile, code, transport=transport)
        self.assertEqual(transport.calls, [])
        for data in [{'code': 220, 'msg': SECRET}, {'code': -130, 'msg': SECRET}, {'code': 200, 'success': False, 'data': {'token': SECRET}}, {'code': 200, 'data': {'token': SECRET}}]:
            with self.assertRaises(tool.ToolError) as context:
                tool.login('13800000000', '123456', transport=Transport(data))
            self.assertNotIn(SECRET, str(context.exception))
        with self.assertRaises(tool.ToolError):
            tool.NoRedirect().redirect_request(None, None, None, None, None, 'https://evil.example')

    def test_offline_extraction_rejects_failed_response_and_injection(self):
        self.assertEqual(tool.credential(SECRET), {'token': SECRET})
        self.assertEqual(tool.credential(json.dumps({'data': {'token': SECRET, 'userId': '123'}}))['userId'], '123')
        for value in ['', '{bad', json.dumps({'code': 220, 'data': {'token': SECRET}}), json.dumps({'token': SECRET, 'userId': '../123'}), json.dumps({'token': SECRET, 'devCode': 'bad\nheader'}), 'x' * 24001]:
            with self.assertRaises(tool.ToolError):
                tool.credential(value)

    def test_local_ui_requires_nonce_host_origin_and_confirmation(self):
        with server() as (app, calls):
            status, _, _ = request(app, '/')
            self.assertEqual(status, 403)
            self.assertEqual(request(app, '/?key=wrong')[0], 403)
            self.assertEqual(request(app, '/?key=%CE%A9')[0], 403)
            status, page, headers = request(app, '/?key=' + app.access_key)
            self.assertEqual(status, 200)
            self.assertIn(app.access_key.encode(), page)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            good = {'Content-Type': 'application/json', 'Origin': app.origin, 'X-Tool-Key': app.access_key}
            for bad in [{}, {**good, 'Origin': 'https://evil.example'}, {**good, 'Host': 'evil.example'}, {**good, 'X-Tool-Key': 'bad'}]:
                self.assertEqual(request(app, '/login', {}, bad)[0], 403)
            self.assertEqual(request(app, '/login', {'mobile': '13800000000', 'code': '123456'}, good)[0], 400)
            self.assertEqual(calls, [])
            status, body, _ = request(app, '/login', {'mobile': '13800000000', 'code': '123456', 'confirmed': True}, good)
            self.assertEqual(status, 200)
            self.assertIn(SECRET, json.loads(body)['command'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(request(app, '/login', {'confirmed': True}, good)[0], 429)
            status, body, _ = request(app, '/extract', {'raw': SECRET}, good)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['credential'], {'token': SECRET})
            self.assertEqual(len(calls), 1, '离线提取不调用官方接口')
            self.assertEqual(request(app, '/unknown', {}, good)[0], 404)
            self.assertEqual(request(app, '/extract', {'raw': 'x' * 40000}, good)[0], 413)


if __name__ == '__main__':
    unittest.main()
