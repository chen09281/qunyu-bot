"""库街区 Token 工具：只在本机运行；官方 HTTPS 接口；不自动发短信、不保存凭据。"""
import argparse
import json
import re
import secrets
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

VERSION = '1.1.0'
OFFICIAL_LOGIN = 'https://www.kurobbs.com/mc/home/'
MAX_BYTES = 1024 * 1024


class ToolError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ToolError('官方接口发生重定向，已停止；请勿将验证码提交到其他地址。')


def equal_key(value, expected):
    return isinstance(value, str) and value.isascii() and secrets.compare_digest(value, expected)


def identifier(value, name):
    if not isinstance(value, str) or not 8 <= len(value) <= 8192 or not re.fullmatch(r'[\x21-\x7e]+', value):
        raise ToolError(name + '格式不正确，请复制完整值，勿加入换行。')
    return value


def credential(raw, dev_code=None):
    if not isinstance(raw, str) or len(raw) > 24000:
        raise ToolError('请粘贴原始 token 或登录响应 JSON，最多 24000 字符。')
    raw = raw.strip()
    if raw.startswith('{'):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            raise ToolError('JSON 不完整，请复制登录响应。') from None
        if not isinstance(data, dict):
            raise ToolError('请提供 JSON 对象。')
        if 'code' in data and (type(data['code']) is not int or data['code'] != 200 or data.get('success') is False):
            raise ToolError('这是登录失败响应，没有可用 token。')
        inner = data.get('data') if isinstance(data.get('data'), dict) else data
    else:
        data = inner = {'token': raw}
    result = {'token': identifier(inner.get('token'), 'token')}
    user_id = inner.get('userId')
    if user_id is not None:
        if isinstance(user_id, bool) or not re.fullmatch(r'\d{1,30}', str(user_id)):
            raise ToolError('userId 应为库街区社区用户 ID。')
        result['userId'] = str(user_id)
    device = dev_code or inner.get('devCode') or data.get('devCode')
    if device is not None:
        if not isinstance(device, str) or len(device) > 256:
            raise ToolError('devCode 格式不正确。')
        result['devCode'] = identifier(device, 'devCode')
    return result


def binding_command(value):
    return '/签到 绑定 库街区 ' + json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def official_request(path, values, device, transport=None):
    if path != '/user/sdkLogin':
        raise ToolError('不支持的官方接口。')
    headers = {'Content-Type': 'application/x-www-form-urlencoded', 'devCode': device, 'distinct_id': str(uuid.uuid4()),
               'source': 'android', 'version': '2.2.1', 'versionCode': '2210', 'osVersion': 'Android',
               'countryCode': 'CN', 'model': '23127PN0CC', 'lang': 'zh-Hans', 'channelId': '2',
               'User-Agent': 'okhttp/3.11.0'}
    request = Request('https://api.kurobbs.com' + path, data=urlencode(values).encode(), headers=headers, method='POST')
    try:
        opener = transport or build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise ToolError('官方接口暂时不可用，请稍后重试。')
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ToolError('官方响应过大，已停止。')
            data = json.loads(raw)
    except ToolError:
        raise
    except HTTPError as error:
        if error.code in (403, 429):
            raise ToolError('官方接口限制访问或请求过多，请稍后重试；本工具不会绕过人机验证。') from None
        raise ToolError('官方接口请求未成功，请稍后重试。') from None
    except (URLError, OSError, ValueError):
        raise ToolError('无法连接官方接口或返回格式异常，请检查网络。') from None
    if not isinstance(data, dict):
        raise ToolError('官方响应格式异常。')
    return data


def login(mobile, code, device=None, transport=None):
    if not isinstance(mobile, str) or not re.fullmatch(r'1[3-9]\d{9}', mobile):
        raise ToolError('请填写中国大陆手机号。')
    if not isinstance(code, str) or not re.fullmatch(r'\d{4,8}', code):
        raise ToolError('请填写刚收到的 4 至 8 位短信验证码。')
    device = device or uuid.uuid4().hex
    identifier(device, 'devCode')
    data = official_request('/user/sdkLogin', {'mobile': mobile, 'code': code, 'devCode': device, 'gameList': ''}, device, transport)
    if data.get('code') != 200 or data.get('success') is False:
        if data.get('code') == -130:
            raise ToolError('验证码错误或已过期，请回官网重新领取；领取后不要先点官网登录。')
        if data.get('code') in (220, 1034):
            raise ToolError('官方要求安全验证。请回官网手动完成验证；若仍被拦截，使用 App 登录响应提取模式。')
        raise ToolError('官方未完成登录。请检查验证码、网络，或改用已有登录响应提取模式。')
    result = credential(json.dumps(data), device)
    if 'userId' not in result:
        raise ToolError('登录响应缺少社区用户 ID，已停止输出。')
    return result


class ToolServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address=('127.0.0.1', 0), login_fn=login):
        super().__init__(address, Handler)
        self.access_key = secrets.token_hex(24)
        self.origin = 'http://127.0.0.1:' + str(self.server_port)
        self.login_fn = login_fn
        self.lock = threading.Lock()
        self.last_login = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No URLs, phone numbers, codes, tokens or request bodies in logs.

    def send_data(self, status, content, mime='application/json; charset=utf-8'):
        raw = content.encode() if isinstance(content, str) else content
        self.send_response(status)
        for key, value in {'Content-Type': mime, 'Content-Length': str(len(raw)), 'Cache-Control': 'no-store',
                           'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
                           'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def reply(self, status, value):
        self.send_data(status, json.dumps(value, ensure_ascii=False))

    def valid_host(self):
        return self.headers.get('Host') == self.server.origin.removeprefix('http://')

    def do_GET(self):
        url = urlsplit(self.path)
        if not self.valid_host() or url.path != '/' or not equal_key(parse_qs(url.query).get('key', [''])[0], self.server.access_key):
            return self.reply(403, {'error': '请从工具启动时打开的本机页面操作。'})
        page = Path(__file__).with_name('desktop.html').read_text(encoding='utf-8')
        self.send_data(200, page.replace('__ACCESS_KEY__', self.server.access_key), 'text/html; charset=utf-8')

    def do_POST(self):
        if not self.valid_host() or self.headers.get('Origin') != self.server.origin or not equal_key(self.headers.get('X-Tool-Key', ''), self.server.access_key):
            return self.reply(403, {'error': '只允许本机工具页面操作。'})
        if self.path not in ('/login', '/extract'):
            return self.reply(404, {'error': '接口不存在。'})
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            return self.reply(415, {'error': '请求格式错误。'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                return self.reply(413, {'error': '输入内容过大或为空。'})
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict):
                raise ToolError('输入格式错误。')
            if self.path == '/extract':
                result = credential(value.get('raw'))
            else:
                if value.get('confirmed') is not True:
                    raise ToolError('请先确认新登录可能使 App 旧会话失效。')
                if not self.server.lock.acquire(blocking=False):
                    return self.reply(429, {'error': '已有登录请求执行中。'})
                try:
                    if self.server.last_login is not None and time.monotonic() - self.server.last_login < 5:
                        return self.reply(429, {'error': '请等待 5 秒再尝试。'})
                    self.server.last_login = time.monotonic()
                    result = self.server.login_fn(value.get('mobile', ''), value.get('code', ''))
                finally:
                    self.server.lock.release()
            self.reply(200, {'command': binding_command(result), 'credential': result})
        except (ValueError, TypeError):
            self.reply(400, {'error': '输入格式错误。'})
        except ToolError as error:
            self.reply(400, {'error': str(error)})
        except Exception:
            self.reply(500, {'error': '工具执行失败，请重新打开；请勿公开包含凭据的截图。'})


def main():
    parser = argparse.ArgumentParser(description='库街区 Token 本机获取工具')
    parser.add_argument('--no-browser', action='store_true', help='只显示本机地址，不自动打开浏览器')
    args = parser.parse_args()
    server = ToolServer()
    url = server.origin + '/?key=' + server.access_key
    print('库街区 Token 工具 ' + VERSION + '：凭据只在本机处理，按 Ctrl+C 退出。')
    print(url)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
