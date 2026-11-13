"""Private JSON worker: yt-dlp extraction + bounded local media download.

No bot framework, third-party parsing service, browser cookies or shell commands.
Only a sanitized result or a stable error code is written to stdout.
"""
import contextlib
import html
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from email.utils import parsedate_to_datetime
from http.cookiejar import Cookie, CookieJar, MozillaCookieJar
from html.parser import HTMLParser
from urllib.parse import urlparse, parse_qs, unquote, urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler, HTTPCookieProcessor, HTTPHandler, HTTPSHandler


class ParseError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


original_getaddrinfo = socket.getaddrinfo


def public_addresses(addresses):
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0].split('%')[0])
        mapped = getattr(ip, 'ipv4_mapped', None)
        if not ip.is_global or (mapped and not mapped.is_global):
            raise ParseError('blocked')
    return addresses


def safe_url(value):
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ParseError('blocked')
    if parsed.port not in (None, 80, 443):
        raise ParseError('blocked')
    return value


def install_network_guard():
    original = socket.getaddrinfo

    def guarded(host, port, *args, **kwargs):
        return public_addresses(original(host, port, *args, **kwargs))

    socket.getaddrinfo = guarded


def proxy_public_addresses(host, port, resolver, timeout=15):
    """Resolve over the proxy's TLS connection, then reject and pin non-public answers."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal:
        family = socket.AF_INET if literal.version == 4 else socket.AF_INET6
        return public_addresses([(family, socket.SOCK_STREAM, 0, '', (str(literal), port))])
    for record_type, family in [('A', socket.AF_INET), ('AAAA', socket.AF_INET6)]:
        request = Request('https://1.1.1.1/dns-query?' + urlencode({'name': host, 'type': record_type}),
                          headers={'Accept': 'application/dns-json'})
        with resolver.open(request, timeout=timeout) as response:
            data = response.read(65537)
        if len(data) > 65536:
            raise ParseError('network')
        payload = json.loads(data)
        if payload.get('Status') != 0:
            raise ParseError('network')
        addresses = []
        for answer in payload.get('Answer') or []:
            if answer.get('type') == (1 if record_type == 'A' else 28):
                ip = ipaddress.ip_address(answer['data'])
                if ip.version != (4 if record_type == 'A' else 6):
                    raise ParseError('network')
                addresses.append((family, socket.SOCK_STREAM, 0, '', (str(ip), port)))
        if addresses:
            return public_addresses(addresses)
    raise ParseError('network')


def network_opener(cookie_file=None, proxy_url=''):
    """Pin public destinations before SOCKS5; only the administrator's proxy may be private."""
    handlers = [ProxyHandler({}), SafeRedirect()]
    if cookie_file and cookie_file.is_file() and not cookie_file.is_symlink():
        handlers.append(HTTPCookieProcessor(metadata_cookies(cookie_file)))
    if proxy_url:
        proxy = urlparse(proxy_url)
        try:
            port = proxy.port
        except ValueError:
            raise ParseError('proxy') from None
        if proxy.scheme != 'socks5' or not proxy.hostname or not port or proxy.username or proxy.password \
                or proxy.path not in ('', '/') or proxy.query or proxy.fragment:
            raise ParseError('proxy')
        # Resolve the explicitly configured endpoint separately from media destinations.
        endpoints = original_getaddrinfo(proxy.hostname, port, 0, socket.SOCK_STREAM)
        resolved = {}

        def recv_exact(sock, size):
            result = b''
            while len(result) < size:
                block = sock.recv(size - len(result))
                if not block:
                    raise OSError('SOCKS connection closed')
                result += block
            return result

        def connect(address, timeout=15, source_address=None):
            if address not in resolved:
                resolved[address] = proxy_public_addresses(address[0], address[1], dns_opener, timeout)
            destinations = public_addresses(resolved[address])
            if not destinations:
                raise OSError('No public destination')
            target = next((item for item in destinations if item[0] == socket.AF_INET), destinations[0])
            family, _, _, _, destination = target
            last_error = None
            for proxy_family, kind, protocol, _, endpoint in endpoints:
                sock = socket.socket(proxy_family, kind, protocol)
                try:
                    sock.settimeout(timeout)
                    if source_address:
                        sock.bind(source_address)
                    sock.connect(endpoint)
                    sock.sendall(b'\x05\x01\x00')
                    if recv_exact(sock, 2) != b'\x05\x00':
                        raise OSError('SOCKS authentication unsupported')
                    kind = 1 if family == socket.AF_INET else 4
                    sock.sendall(b'\x05\x01\x00' + bytes([kind]) + socket.inet_pton(family, destination[0]) + struct.pack('!H', address[1]))
                    reply = recv_exact(sock, 4)
                    if reply[:2] != b'\x05\x00':
                        raise OSError('SOCKS connect failed')
                    size = {1: 4, 4: 16}.get(reply[3])
                    if reply[3] == 3:
                        size = recv_exact(sock, 1)[0]
                    if size is None:
                        raise OSError('Invalid SOCKS response')
                    recv_exact(sock, size + 2)
                    return sock
                except OSError as error:
                    last_error = error
                    sock.close()
            raise last_error or OSError('Proxy unavailable')

        def connection(base):
            def create(*args, **kwargs):
                result = base(*args, **kwargs)
                result._create_connection = connect
                return result
            return create

        class SocksHTTP(HTTPHandler):
            def http_open(self, request):
                return self.do_open(connection(http.client.HTTPConnection), request)

        class SocksHTTPS(HTTPSHandler):
            def https_open(self, request):
                return self.do_open(connection(http.client.HTTPSConnection), request, context=self._context)

        class NoDNSRedirect(HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                raise ParseError('network')

        # A literal, certificate-verified resolver avoids polluted system DNS and recursive lookups.
        dns_opener = build_opener(ProxyHandler({}), NoDNSRedirect(), SocksHTTPS())
        handlers.extend([SocksHTTP(), SocksHTTPS()])
    return build_opener(*handlers)


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


opener = build_opener(ProxyHandler({}), SafeRedirect())
agent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
MAX_LINK_IMAGES = 9
MAX_LINK_MEDIA_BYTES = 400 * 1024 * 1024


def metadata_cookies(path):
    jar = MozillaCookieJar(str(path))
    jar.load(ignore_discard=True, ignore_expires=True)
    for cookie in list(jar):
        if cookie.expires == 0:
            cookie.expires = None
            cookie.discard = True
        elif cookie.expires is not None and cookie.expires < time.time():
            jar.clear(cookie.domain, cookie.path, cookie.name)
    return jar


def read_public(url, limit, accept='*/*', headers=None):
    request = Request(safe_url(url), headers={'User-Agent': agent, 'Accept': accept, **(headers or {})})
    with opener.open(request, timeout=15) as response:
        safe_url(response.url)
        size = int(response.headers.get('Content-Length') or 0)
        if size > limit:
            raise ParseError('size')
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ParseError('size')
        return data, response.headers.get('Content-Type', ''), response.url


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.in_title, self.title = {}, False, ''

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'meta':
            key = (values.get('property') or values.get('name') or '').lower()
            if values.get('content'):
                self.meta.setdefault(key, values['content'])
        if tag == 'title':
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title += value[:1000]


def clean(value, limit):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', html.unescape(str(value or '')))[:limit].strip()


def page_metadata(url):
    data, content_type, final = read_public(url, 2 * 1024 * 1024, 'text/html')
    if 'html' not in content_type:
        raise ParseError('unsupported')
    parser = Metadata()
    parser.feed(data.decode('utf-8', errors='replace'))
    title = clean(parser.meta.get('og:title') or parser.meta.get('twitter:title') or parser.title, 200)
    if not title or re.search(r'安全验证|验证码|访问受限|登录后|sign in|log in|just a moment', title, re.I):
        raise ParseError('login')
    return {'title': title, 'description': parser.meta.get('og:description') or parser.meta.get('description') or '',
            'uploader': parser.meta.get('author') or '', 'thumbnails': [{'url': parser.meta.get('og:image') or parser.meta.get('twitter:image')}],
            'has_video': bool(parser.meta.get('og:video') or parser.meta.get('og:video:url') or parser.meta.get('twitter:player:stream')),
            'webpage_url': final}


mobile_agent = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'


def bilibili_dynamic_id(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if host != 'bilibili.com' and not host.endswith('.bilibili.com'):
        return None
    match = re.fullmatch(r'/(\d{5,25})/?', parsed.path) if host == 't.bilibili.com' else None
    match = match or re.fullmatch(r'/(?:opus|dynamic)/(\d{5,25})/?', parsed.path)
    value = match.group(1) if match else ''
    if not value and re.fullmatch(r'/(?:opus|dynamic)/?', parsed.path):
        query = parse_qs(parsed.query)
        value = query.get('dynamic_id', query.get('id', ['']))[0]
    return value if re.fullmatch(r'\d{5,25}', value) else None


def bilibili_url(url):
    """Resolve App short links and use the desktop URL accepted by the video extractor."""
    parsed = urlparse(safe_url(url))
    host = (parsed.hostname or '').lower()
    if host == 'b23.tv' or host.endswith('.b23.tv'):
        _, _, url = read_public(url, 2 * 1024 * 1024, 'text/html', {'User-Agent': mobile_agent})
        parsed = urlparse(safe_url(url))
        host = (parsed.hostname or '').lower()
    if host != 'bilibili.com' and not host.endswith('.bilibili.com'):
        raise ParseError('unsupported')
    dynamic_id = bilibili_dynamic_id(url)
    if dynamic_id:
        return 'https://t.bilibili.com/' + dynamic_id
    query = parse_qs(parsed.query)
    match = re.match(r'^/(?:video|mobile/video)/(BV[\da-zA-Z]{10}|av\d+)(?:/|$)', parsed.path, re.I)
    video_id = match.group(1) if match else query.get('bvid', [''])[0]
    if not video_id and re.fullmatch(r'\d+', query.get('aid', [''])[0]):
        video_id = 'av' + query['aid'][0]
    if re.fullmatch(r'(?:BV[\da-zA-Z]{10}|av\d+)', video_id, re.I):
        video_id = 'BV' + video_id[2:] if video_id.lower().startswith('bv') else video_id.lower()
        page = query.get('p', [''])[0]
        return 'https://www.bilibili.com/video/' + video_id + ('?p=' + page if re.fullmatch(r'[1-9]\d{0,3}', page) else '')
    return url


def bilibili_dynamic_info(item, post_id, depth=0):
    """Read only this dynamic and its embedded original; never traverse recommendations."""
    if not isinstance(item, dict) or depth > 3 or str(item.get('id_str') or '') != post_id:
        raise ParseError('unsupported')
    if item.get('type') == 'DYNAMIC_TYPE_NONE' or item.get('visible') is False:
        raise ParseError('unsupported')
    modules = item.get('modules') or {}
    author = modules.get('module_author') or {}
    dynamic = modules.get('module_dynamic') or {}
    major = dynamic.get('major') or {}
    opus = major.get('opus') or {}
    summary = opus.get('summary') or dynamic.get('desc') or {}
    text = clean(summary.get('text') or ''.join(str(node.get('text') or '') for node in summary.get('rich_text_nodes', []) if isinstance(node, dict)), 1000)
    pictures = opus.get('pics') or (major.get('draw') or {}).get('items') or []
    groups = []
    for picture in pictures[:40]:
        if not isinstance(picture, dict):
            continue
        image = picture.get('url') or picture.get('src')
        if isinstance(image, str) and image.startswith(('http://', 'https://', '//')):
            # Strip Bilibili CDN resize/format instructions, keeping the original image.
            groups.append([image.split('@', 1)[0]])
    archive = major.get('archive') or {}
    live = major.get('live') or major.get('live_rcmd') or {}
    live_url = live.get('jump_url') or live.get('url') or ''
    if isinstance(live_url, str) and live_url.startswith('//'):
        live_url = 'https:' + live_url
    if not isinstance(live_url, str) or not re.fullmatch(r'https://live\.bilibili\.com/\d+(?:\?[^\s]*)?', live_url):
        live_url = None
    bvid = archive.get('bvid') or ''
    video_url = 'https://www.bilibili.com/video/' + bvid if re.fullmatch(r'BV[\da-zA-Z]{10}', bvid) else None
    if not video_url:
        jump = archive.get('jump_url') or (major.get('pgc') or {}).get('jump_url') or ''
        if isinstance(jump, str) and jump:
            jump = 'https:' + jump if jump.startswith('//') else jump
            parsed = urlparse(jump)
            if parsed.hostname in ('www.bilibili.com', 'm.bilibili.com', 'bilibili.com') and re.match(r'^/(?:video/|bangumi/play/)', parsed.path):
                video_url = bilibili_url(jump)
    title = clean(opus.get('title') or archive.get('title') or live.get('title') or text.split('\n', 1)[0], 200)
    description = text
    if item.get('type') == 'DYNAMIC_TYPE_FORWARD':
        original = item.get('orig') or {}
        original_id = str(original.get('id_str') or '')
        if re.fullmatch(r'\d{5,25}', original_id) and original.get('type') != 'DYNAMIC_TYPE_NONE':
            source = bilibili_dynamic_info(original, original_id, depth + 1)
            description = clean(text + '\n\n转发自 ' + (source['uploader'] or '原作者') + '：\n' + (source['description'] or source['title']), 1000)
            groups = groups or source['image_groups']
            video_url = video_url or source.get('video_url')
            title = title or source['title']
        else:
            description = clean(text + '\n\n原动态已删除或不可见', 1000)
    if not title and not description and not groups and not video_url and not live_url:
        raise ParseError('unsupported')
    cover = archive.get('cover') or (major.get('pgc') or {}).get('cover') or live.get('cover')
    return {'title': title or clean(author.get('name') or '哔哩哔哩', 100) + '的动态',
            'description': description, 'uploader': clean(author.get('name'), 100), 'uploader_id': str(author.get('mid') or ''),
            'timestamp': author.get('pub_ts'), 'avatar': author.get('face'), 'image_groups': groups,
            'thumbnail': cover, 'webpage_url': 'https://t.bilibili.com/' + post_id,
            'video_url': video_url, 'own_video': bool(video_url) and item.get('type') != 'DYNAMIC_TYPE_FORWARD',
            'live_url': live_url, 'has_video': bool(video_url), 'is_album': not bool(video_url)}


def bilibili_dynamic(url):
    post_id = bilibili_dynamic_id(url)
    if not post_id:
        return None
    payload, _, _ = read_public('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' +
                                urlencode({'id': post_id, 'features': 'itemOpusStyle'}), 2 * 1024 * 1024,
                                'application/json', {'Referer': 'https://t.bilibili.com/' + post_id})
    data = json.loads(payload)
    if data.get('code') in (-101, -111, -352, -403, -412):
        raise ParseError('login')
    if data.get('code') != 0:
        raise ParseError('unsupported')
    return bilibili_dynamic_info((data.get('data') or {}).get('item'), post_id)


def bilibili_feed(input_data):
    global opener
    uid = str(input_data.get('uid') or '')
    if not re.fullmatch(r'[1-9]\d{0,19}', uid):
        raise ParseError('unsupported')
    install_network_guard()
    cookies = Path(input_data.get('cookieFile', ''))
    if cookies.is_file() and not cookies.is_symlink():
        opener = build_opener(ProxyHandler({}), SafeRedirect(), HTTPCookieProcessor(metadata_cookies(cookies)))
    data = bilibili_api('polymer/web-dynamic/v1/feed/space', {
        'host_mid': uid, 'timezone_offset': -480, 'features': 'itemOpusStyle'})
    rows = data.get('items') if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ParseError('output')
    items = []
    for item in rows[:100]:
        if not isinstance(item, dict):
            continue
        post_id = str(item.get('id_str') or '')
        author = (item.get('modules') or {}).get('module_author') or {}
        if not re.fullmatch(r'\d{5,25}', post_id) or str(author.get('mid') or '') != uid:
            continue
        try:
            info = bilibili_dynamic_info(item, post_id)
        except ParseError:
            continue
        info['id'] = post_id
        items.append(info)
    if not items:
        raise ParseError('upstream_empty')
    return {'items': items}


def douyin_id(url):
    parsed = urlparse(url)
    host = parsed.hostname or ''
    if not any(host == root or host.endswith('.' + root) for root in ('douyin.com', 'iesdouyin.com')):
        raise ParseError('unsupported')
    match = re.search(r'/(?:share/)?(?:video|note|slides)/(\d+)', parsed.path)
    value = match.group(1) if match else parse_qs(parsed.query).get('modal_id', [''])[0]
    return value if re.fullmatch(r'\d{10,25}', value) else None


def find_douyin_item(value, video_id, depth=0):
    # Feed endpoints can return recommendations. Only use the requested work, never the first item.
    if depth > 12:
        return None
    if isinstance(value, dict):
        if str(value.get('aweme_id') or value.get('awemeId')) == video_id and ('video' in value or 'images' in value):
            return value
        for child in value.values():
            if isinstance(child, (dict, list)):
                found = find_douyin_item(child, video_id, depth + 1)
                if found:
                    return found
    elif isinstance(value, list):
        for child in value[:50]:
            found = find_douyin_item(child, video_id, depth + 1)
            if found:
                return found
    return None


def douyin_item_info(item, video_id):
    status = item.get('status') or {}
    if status.get('is_private') or status.get('is_delete'):
        raise ParseError('login')
    author, video = item.get('author') or {}, item.get('video') or {}
    images = item.get('images') or []
    cover = ((video.get('cover') or {}).get('url_list') or (video.get('origin_cover') or {}).get('url_list') or [None])[0]
    avatar = ((author.get('avatar_thumb') or {}).get('url_list') or (author.get('avatar_larger') or {}).get('url_list') or [None])[0]
    info = {'id': video_id, 'title': item.get('desc') or '抖音分享', 'description': item.get('desc') or '',
            'uploader': author.get('nickname') or author.get('unique_id') or '',
            'duration': positive(video.get('duration')) / 1000, 'formats': [], 'thumbnails': [],
            'timestamp': positive(item.get('create_time')) or None,
            'webpage_url': f'https://www.douyin.com/video/{video_id}', 'http_headers': {'Referer': 'https://www.douyin.com/'}}
    if isinstance(cover, str):
        info['thumbnail'] = cover
    if isinstance(avatar, str):
        info['avatar'] = avatar
    if images:
        info['is_album'] = True
        info['image_groups'] = []
        for image in images[:20]:
            urls = list(dict.fromkeys(value for value in (
                (image.get('url_list') or []) + ((image.get('display_image') or {}).get('url_list') or [])
            ) if isinstance(value, str) and value.startswith(('http://', 'https://', '//'))))
            if urls:
                info['image_groups'].append(urls)
                info['thumbnails'].append({'url': urls[0]})
        return info
    streams = [(stream.get('play_addr') or {}, stream) for stream in video.get('bit_rate') or []]
    streams += [(video.get(key) or {}, video) for key in ('play_addr_h264', 'play_addr', 'play_addr_lowbr')]
    seen = set()
    for address, stream in streams:
        for url in address.get('url_list') or []:
            if not isinstance(url, str) or url in seen:
                continue
            safe_url(url); seen.add(url)
            info['formats'].append({'format_id': f'douyin-{len(seen)}', 'url': url, 'ext': 'mp4',
                                    'width': address.get('width') or video.get('width'), 'height': address.get('height') or video.get('height'),
                                    'filesize': positive(address.get('data_size')) or None,
                                    'tbr': positive(stream.get('bit_rate')) / 1000 or None,
                                    'vcodec': 'hevc' if stream.get('is_h265') else 'h264', 'acodec': 'aac'})
    if not info['formats']:
        raise ParseError('format')
    return info


def douyin_info(url):
    video_id = douyin_id(url)
    if not video_id:
        _, _, final = read_public(url, 2 * 1024 * 1024, 'text/html')
        video_id = douyin_id(final)
    if not video_id:
        raise ParseError('unsupported')
    # Ordinary public mobile API, without sending browser credentials to an unrelated host.
    try:
        data, _, _ = read_public(f'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id={video_id}&aid=1128',
                                 4 * 1024 * 1024, 'application/json', {'User-Agent': mobile_agent})
        item = find_douyin_item(json.loads(data), video_id)
        if item:
            return douyin_item_info(item, video_id)
    except Exception as error:
        if isinstance(error, ParseError) and error.code in ('blocked', 'size', 'login'):
            raise
    # The public share endpoint sometimes returns a shell without this work's data.
    # Retry that read once; an empty shell is not evidence that saved login expired.
    last_error = None
    for attempt in range(2):
        try:
            data, _, _ = read_public(f'https://www.iesdouyin.com/share/video/{video_id}', 4 * 1024 * 1024,
                                     'text/html', {'User-Agent': mobile_agent, **({'Cache-Control': 'no-cache'} if attempt else {})})
        except Exception as error:
            if isinstance(error, ParseError) and error.code in ('blocked', 'size'):
                raise
            last_error = error
            continue
        page = data.decode('utf-8', errors='replace')
        match = re.search(r'(?:window\.)?_ROUTER_DATA\s*=\s*', page)
        value = None
        try:
            if match:
                value = json.JSONDecoder().raw_decode(page[match.end():].lstrip())[0]
            else:
                render = re.search(r'<script[^>]*\bid=["\']RENDER_DATA["\'][^>]*>(.*?)</script>', page, re.S)
                if render:
                    value = json.loads(unquote(render.group(1)))
        except (ValueError, TypeError):
            pass
        item = find_douyin_item(value, video_id)
        if item:
            return douyin_item_info(item, video_id)
        last_error = None
    raise ParseError(error_code(last_error) if last_error else 'upstream_empty')


class QuietLogger:
    def debug(self, *_):
        pass

    def warning(self, *_):
        pass

    def error(self, *_):
        pass


bid_alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'


def bid_to_mid(bid):
    """微博短链 ID（bid）与数字 ID（mid）互转；同一帖子两种写法都要能取图。"""
    if not isinstance(bid, str) or not re.fullmatch(r'[0-9A-Za-z]{4,16}', bid):
        return None
    size = len(bid) % 4 or 4
    groups = [bid[:size]] + [bid[index:index + 4] for index in range(size, len(bid), 4)]
    result = []
    for position, group in enumerate(groups):
        value = 0
        for char in group:
            if char not in bid_alphabet:
                return None
            value = value * 62 + bid_alphabet.index(char)
        result.append(str(value) if position == 0 else str(value).rjust(7, '0'))
    return ''.join(result)


def mid_to_bid(mid):
    if not isinstance(mid, str) or not re.fullmatch(r'\d{10,20}', mid):
        return None
    size = len(mid) % 7 or 7
    groups = [mid[:size]] + [mid[index:index + 7] for index in range(size, len(mid), 7)]
    result = []
    for position, group in enumerate(groups):
        value = int(group)
        encoded = ''
        while value:
            encoded = bid_alphabet[value % 62] + encoded
            value //= 62
        result.append(encoded if position == 0 else encoded.rjust(4, '0'))
    return ''.join(result)


weibo_hosts = ('weibo.com', 'weibo.cn', 'm.weibo.cn')


def weibo_mid(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if not any(host == item or host.endswith('.' + item) for item in weibo_hosts):
        return None
    path = unquote(parsed.path)
    candidates = re.findall(r'/(?:detail|status|statuses)/([0-9A-Za-z]{6,20})', path)
    candidates += re.findall(r'^/(?:\d+|u/\d+)/([0-9A-Za-z]{6,20})/?$', path)
    candidates += [value for value in parse_qs(parsed.query).get('id', []) if re.fullmatch(r'[0-9A-Za-z]{6,20}', value)]
    for value in candidates:
        if value.isdigit():
            return value
        converted = bid_to_mid(value)
        if converted:
            return converted
    return None


weibo_session = None


def weibo_opener(cookie_file=''):
    """微博对未登录访客返回 432/登录页，先用 passport 访客票据换取 SUB Cookie 再读接口。"""
    global weibo_session
    if weibo_session is not None:
        return weibo_session
    jar = CookieJar()
    path = Path(cookie_file) if cookie_file else None
    if path and path.is_file() and not path.is_symlink():
        try:
            for cookie in metadata_cookies(path):
                jar.set_cookie(cookie)
        except (OSError, ValueError):
            pass
    opener = build_opener(ProxyHandler({}), SafeRedirect(), HTTPCookieProcessor(jar))
    # m.weibo.cn 只认 .weibo.cn 上的访客票据；仅补缺失的域，不覆盖用户已登录的 Cookie。
    if not any(cookie.name == 'SUB' and 'weibo.cn' in cookie.domain for cookie in jar):
        try:
            fingerprint = json.dumps({'os': '1', 'browser': 'Chrome130,0,0,0', 'fonts': 'undefined',
                                      'screenInfo': '1920*1080*24', 'plugins': ''}, separators=(',', ':'))
            request = Request(safe_url('https://passport.weibo.com/visitor/genvisitor'),
                              data=urlencode({'cb': 'gen_callback', 'fp': fingerprint}).encode(),
                              headers={'User-Agent': mobile_agent, 'Referer': 'https://weibo.com/'})
            with opener.open(request, timeout=15) as response:
                raw = response.read(64 * 1024).decode('utf-8', 'replace')
            tid = json.loads(raw[raw.index('(') + 1:raw.rindex(')')])['data']['tid']
            query = urlencode({'a': 'incarnate', 't': tid, 'w': 3, 'c': 100, 'gc': '',
                               'cb': 'cross_domain', 'from': 'weibo', '_rand': random.random()})
            request = Request(safe_url('https://passport.weibo.com/visitor/visitor?' + query),
                              headers={'User-Agent': mobile_agent, 'Referer': 'https://weibo.com/'})
            with opener.open(request, timeout=15) as response:
                raw = response.read(64 * 1024).decode('utf-8', 'replace')
            payload = json.loads(raw[raw.index('(') + 1:raw.rindex(')')]).get('data') or {}
            existing = {(cookie.name, cookie.domain) for cookie in jar}
            for domain in ('.weibo.com', '.weibo.cn'):
                for name, value in (('SUB', payload.get('sub')), ('SUBP', payload.get('subp'))):
                    if value and (name, domain) not in existing:
                        jar.set_cookie(Cookie(0, name, value, None, False, domain, True, False, '/', True, False, None, False, None, None, {}))
        except (OSError, ValueError, KeyError, TypeError):
            pass
    weibo_session = opener
    return opener


def weibo_json(opener, url):
    desktop = (urlparse(url).hostname or '') == 'weibo.com'
    request = Request(safe_url(url), headers={'User-Agent': agent if desktop else mobile_agent, 'Referer': 'https://weibo.com/' if desktop else 'https://m.weibo.cn/',
                                              'X-Requested-With': 'XMLHttpRequest', 'MWeibo-Pwa': '1'})
    with opener.open(request, timeout=15) as response:
        safe_url(response.url)
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ParseError('size')
    return json.loads(data.decode('utf-8', 'replace'))


weibo_text = re.compile(r'<[^>]+>')


def weibo_post(url, cookie_file=''):
    """返回公开微博的文案与全部原图；自带图文页（微博的图片不在 yt-dlp 结果里）。"""
    mid = weibo_mid(url)
    if not mid:
        # t.cn 短链先跟随跳转后再识别
        if (urlparse(url).hostname or '').lower() != 't.cn':
            return None
        try:
            _, _, final = read_public(url, 512 * 1024, 'text/html')
        except Exception:
            return None
        mid = weibo_mid(final)
        if not mid:
            return None
    status = None
    session = weibo_opener(cookie_file)
    for endpoint in ('https://m.weibo.cn/statuses/show?id=', 'https://weibo.com/ajax/statuses/show?id='):
        try:
            body = weibo_json(session, endpoint + mid)
        except ParseError as error:
            if error.code == 'blocked':
                raise
            continue
        except (OSError, ValueError, TypeError):
            continue
        if isinstance(body, dict):
            candidate = body.get('data') if body.get('ok') == 1 else body if isinstance(body.get('user'), dict) else None
            if isinstance(candidate, dict) and candidate:
                status = candidate
                break
    if not status:
        return None
    for _ in range(3):
        if status.get('pics') or (status.get('pic_infos') and status.get('pic_ids')):
            break
        original = status.get('retweeted_status')
        if not isinstance(original, dict) or not original:
            break
        status = original
    images = []
    pictures = status.get('pics') or [(status.get('pic_infos') or {}).get(key) for key in (status.get('pic_ids') or [])]
    for picture in pictures[:20]:
        if not isinstance(picture, dict):
            continue
        source = picture.get('large') or picture.get('original') or {}
        link = source.get('url') or picture.get('url')
        if isinstance(link, str) and link.startswith(('http://', 'https://', '//')):
            images.append(weibo_size_prefix.sub(r'\1large/', link))
    text = clean(weibo_text.sub(' ', html.unescape(status.get('text') or '')), 1000)
    user = status.get('user') or {}
    author = clean(user.get('screen_name'), 100)
    avatars = list(dict.fromkeys(value for value in [user.get('avatar_hd'), user.get('avatar_large'), user.get('profile_image_url')]
                                if isinstance(value, str) and value.startswith(('http://', 'https://', '//'))))
    published = ''
    try:
        created = parsedate_to_datetime(status.get('created_at') or '')
        published = published_text(created.timestamp())
    except (TypeError, ValueError):
        published = ''
    return {'title': text[:200], 'description': text, 'author': author, 'images': images,
            'avatar': avatars[0] if avatars else '', 'avatar_candidates': avatars,
            'published': published}


def image_size(data):
    """Best-effort pixel size from JPEG/PNG/WebP headers; (0, 0) when unknown."""
    try:
        if data[:2] == b'\xff\xd8':
            index = 2
            while index < len(data) - 9:
                if data[index] != 0xFF:
                    index += 1
                    continue
                marker = data[index + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    return int.from_bytes(data[index + 7:index + 9], 'big'), int.from_bytes(data[index + 5:index + 7], 'big')
                if marker in (0xD8, 0xD9):
                    index += 2
                    continue
                index += 2 + int.from_bytes(data[index + 2:index + 4], 'big')
            return 0, 0
        if data[:8] == b'\x89PNG\r\n\x1a\n':
            return int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
        if data[:6] in (b'GIF87a', b'GIF89a'):
            return int.from_bytes(data[6:8], 'little'), int.from_bytes(data[8:10], 'little')
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            chunk = data[12:16]
            if chunk == b'VP8 ':
                return int.from_bytes(data[26:28], 'little') & 0x3FFF, int.from_bytes(data[28:30], 'little') & 0x3FFF
            if chunk == b'VP8L':
                bits = int.from_bytes(data[21:25], 'little')
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if chunk == b'VP8X':
                return int.from_bytes(data[24:27], 'little') + 1, int.from_bytes(data[27:30], 'little') + 1
    except (IndexError, ValueError):
        pass
    return 0, 0


weibo_size_prefix = re.compile(r'(sinaimg\.cn/)(?:orj360|orj480|orj1080|orj1440|thumb150|thumb180|thumb300|thumb600|mw690|mw1024|mw2000|bmiddle|small|square|crop\.[\d.]+)/')


def image_variants(url, platform):
    """Original-quality URL candidates first. Every CDN style suffix on 小红书 is a re-compressed
    derivative, and 微博 thumbnails use short-lived prefixes; both need the large original."""
    if not isinstance(url, str) or not url or len(url) > 8192:
        return []
    if url.startswith('//'):
        url = 'https:' + url
    if urlparse(url).scheme not in ('http', 'https'):
        return []
    if platform == 'weibo':
        upgraded = weibo_size_prefix.sub(r'\1large/', url)
        # 微博的 large 就是上传原图（更高前缀返回同一文件），一次请求即可。
        return [upgraded]
    if platform == 'xiaohongshu':
        base = url.split('!')[0]
        candidates = [base]
        match = re.search(r'/([0-9a-z]{16,})(?:[!?]|$)', base)
        if match:
            candidates.append('https://ci.xiaohongshu.com/%s?imageView2/2/w/1440/format/jpg' % match.group(1))
        candidates.append(url)
        return candidates
    return [url]


def image_label(url, platform):
    """同一相册里按「图片规格」跳过已确认失效的候选，避免 20 张图重复试错。"""
    if platform == 'xiaohongshu':
        if '!' in url:
            return 'derivative'
        return 'ci' if (urlparse(url).hostname or '').endswith('xiaohongshu.com') else 'original'
    return 'large' if platform == 'weibo' else ''


def image_headers(url):
    """微博图片校验 Referer，缺失时返回 403；小红书图床同理。"""
    host = (urlparse(url).hostname or '').lower()
    if host.endswith('sinaimg.cn') or host.endswith('weibo.com') or host.endswith('weibo.cn'):
        return {'Referer': 'https://weibo.com/'}
    if host.endswith('xhscdn.com') or host.endswith('xiaohongshu.com'):
        return {'Referer': 'https://www.xiaohongshu.com/'}
    if host == 'hdslb.com' or host.endswith('.hdslb.com'):
        return {'Referer': 'https://www.bilibili.com/'}
    return {}


def transcode_webp(path):
    """QQ 转码 webp 时会掉到很低的画质，先在本地转成高质量 JPEG 再发送。"""
    target = path.with_suffix('.jpg')
    try:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(path), '-q:v', '2',
                        '-map_metadata', '-1', str(target)], capture_output=True, timeout=60, check=True)
        if target.is_file() and target.stat().st_size:
            path.unlink()
            return target
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        if target.exists():
            target.unlink()
    except OSError:
        pass
    return path


def image_identity(url, platform=''):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if platform == 'bilibili' and (host == 'hdslb.com' or host.endswith('.hdslb.com')):
        return ('bilibili', parsed.path.split('@', 1)[0])
    if platform == 'douyin' and any(host == root or host.endswith('.' + root) for root in ('douyinpic.com', 'byteimg.com', 'pstatp.com')):
        # Different CDN nodes, signatures and thumbnail templates can refer to the same photo.
        return ('douyin', unquote(parsed.path).split('~', 1)[0])
    if platform == 'xiaohongshu' or host.endswith('.xhscdn.com') or host == 'ci.xiaohongshu.com':
        # CDN 域名、签名路径、查询参数与样式后缀都会变化，素材 ID 才代表同一张原图。
        asset = unquote(parsed.path).split('!')[0].rstrip('/').rsplit('/', 1)[-1]
        return ('xiaohongshu', re.sub(r'\.(?:jpe?g|png|webp)$', '', asset, flags=re.I))
    return ('url', url)


def album_image_groups(info, platform=''):
    if isinstance(info, dict) and isinstance(info.get('image_groups'), list):
        sources = info['image_groups']
    elif isinstance(info, dict):
        sources = [item.get('url') if isinstance(item, dict) else item for item in (info.get('thumbnails') or [])]
        if info.get('thumbnail'):
            sources.append(info['thumbnail'])
    else:
        sources = list(info or [])
    groups, seen = [], {}
    for source in sources[:40]:
        candidates = source if isinstance(source, list) else [source]
        urls = ['https:' + url if url.startswith('//') else url for url in candidates[:12]
                if isinstance(url, str) and 0 < len(url) <= 8192]
        if not urls:
            continue
        identities = [image_identity(url, platform) for url in urls]
        group = next((seen[key] for key in identities if key in seen), None)
        if group is None:
            group = []
            groups.append(group)
        for key, url in zip(identities, urls):
            seen[key] = group
            if url not in group:
                group.append(url)
    return groups


def download_images(info, directory, max_bytes=MAX_LINK_MEDIA_BYTES, platform=''):
    images, total, failed = [], 0, set()
    for sources in album_image_groups(info, platform):
        try:
            remaining = max_bytes - total
            if remaining <= 0:
                raise ParseError('size')
            # Keep the sharpest reachable variant: take the original when the CDN serves it.
            chosen = None
            candidates = dict.fromkeys(candidate for url in sources for candidate in image_variants(url, platform)[:3])
            for candidate in candidates:
                label = image_label(candidate, platform)
                if label and label in failed:
                    continue
                try:
                    data, _, _ = read_public(candidate, remaining, 'image/*', image_headers(candidate))
                except ParseError as error:
                    if error.code in ('size', 'blocked'):
                        raise
                    if label:
                        failed.add(label)
                    continue
                except Exception:
                    if label:
                        failed.add(label)
                    continue
                width, height = image_size(data)
                if chosen is None or width * height > chosen[1]:
                    chosen = (data, width * height)
                if min(width, height) >= 1000:
                    break
            if chosen is None:
                continue
            data = chosen[0]
            ext = 'jpg' if data.startswith(b'\xff\xd8\xff') else 'png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'webp' if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else None
            if not ext:
                continue
            if total + len(data) > max_bytes:
                raise ParseError('size')
            name = 'image-%d.%s' % (len(images), ext)
            path = directory / name
            path.write_bytes(data)
            if ext == 'webp':
                path = transcode_webp(path)
                name = path.name
            if total + path.stat().st_size > max_bytes:
                path.unlink(missing_ok=True)
                raise ParseError('size')
            images.append(name)
            total += path.stat().st_size
        except ParseError as error:
            if error.code in ('size', 'blocked'):
                raise
        except Exception:
            continue
        if len(images) >= MAX_LINK_IMAGES:
            break
    return images


def twitter_info(url, allow_video=True):
    from yt_dlp.jsinterp import js_number_to_string
    from yt_dlp.utils import unified_timestamp
    target = urlparse(safe_url(url))
    if target.hostname == 't.co':
        _, _, url = read_public(url, 2 * 1024 * 1024, 'text/html')
        target = urlparse(safe_url(url))
    if (target.hostname or '').removeprefix('www.').removeprefix('mobile.').removeprefix('m.') not in ('x.com', 'twitter.com'):
        raise ParseError('unsupported')
    match = re.fullmatch(r'/(?:[^/]+/status(?:es)?|i/web/status)/(\d{1,25})(?:/(?:photo|video)/(\d+))?/?', target.path)
    if not match:
        raise ParseError('unsupported')
    tweet_id, selected = match.groups()
    token = js_number_to_string((int(tweet_id) / 1e15) * math.pi, 36).translate(str.maketrans('', '', '0.'))
    data, _, _ = read_public('https://cdn.syndication.twimg.com/tweet-result?' + urlencode({'id': tweet_id, 'token': token}),
                             2 * 1024 * 1024, 'application/json', {'User-Agent': 'Googlebot'})
    payload = json.loads(data)
    if not isinstance(payload, dict) or payload.get('id_str') != tweet_id:
        raise ParseError('unavailable')
    media = payload.get('mediaDetails') or [{'type': 'photo', 'media_url_https': item.get('url')} for item in payload.get('photos', []) if isinstance(item, dict)]
    media = [item for item in media if isinstance(item, dict)]
    if selected:
        index = int(selected) - 1
        if not 0 <= index < len(media):
            raise ParseError('unavailable')
        media = [media[index]]
    def cdn(value):
        parsed = urlparse(value or '')
        return value if parsed.scheme == 'https' and parsed.hostname in ('pbs.twimg.com', 'video.twimg.com') and not parsed.username and not parsed.password else ''
    photos = []
    for item in media:
        if item.get('type') != 'photo':
            continue
        source = cdn(item.get('media_url_https') or item.get('media_url'))
        if source:
            parsed = urlparse(source)
            query = parse_qs(parsed.query)
            query['name'] = ['orig']
            photos.append(parsed._replace(query=urlencode(query, doseq=True)).geturl())
    video = next((item for item in media if item.get('type') in ('video', 'animated_gif')), None)
    formats, duration = [], 0
    if video and allow_video:
        detail = video.get('video_info') or {}
        duration = positive(detail.get('duration_millis') or video.get('duration_millis')) / 1000
        for index, variant in enumerate(detail.get('variants') or []):
            source = cdn(variant.get('url'))
            if not source or variant.get('content_type') != 'video/mp4':
                continue
            dimensions = re.search(r'/(\d+)x(\d+)/', urlparse(source).path)
            width, height = map(int, dimensions.groups()) if dimensions else (0, 0)
            formats.append({'format_id': 'twitter-%d' % index, 'url': source, 'ext': 'mp4', 'width': width, 'height': height,
                            'tbr': positive(variant.get('bitrate')) / 1000, 'vcodec': 'avc1', 'acodec': 'aac'})
        if not formats:
            raise ParseError('format')
    user = payload.get('user') or {}
    text = clean(payload.get('text') or payload.get('full_text'), 1000)
    return {'id': tweet_id, 'title': text[:200] or 'X / Twitter 推文', 'description': text,
            'uploader': clean(user.get('name') or user.get('screen_name'), 100),
            'avatar': cdn(user.get('profile_image_url_https') or user.get('profile_image_url')),
            'timestamp': unified_timestamp(payload.get('created_at')), 'formats': formats, 'duration': duration,
            'image_groups': [[photo] for photo in photos[:MAX_LINK_IMAGES]], 'is_album': bool(photos) and not formats,
            'has_video': bool(video), 'thumbnail': cdn((video or {}).get('media_url_https')) or next(iter(photos), '')}


def positive(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else 0


def estimated_size(fmt, duration):
    return positive(fmt.get('filesize')) or positive(fmt.get('filesize_approx')) or positive(fmt.get('tbr')) * duration * 1000 / 8


def select_video_format(info, max_bytes):
    """Budget the video AND audio before yt-dlp invokes its merger."""
    formats = info.get('formats') or []
    duration = positive(info.get('duration'))
    audio = [fmt for fmt in formats if fmt.get('vcodec') == 'none' and fmt.get('acodec') != 'none']
    candidates = []
    for video in formats:
        dimensions = [positive(video.get(key)) for key in ('width', 'height') if positive(video.get(key))]
        if video.get('vcodec') == 'none' or (dimensions and min(dimensions) > 720):
            continue
        tracks = audio if video.get('acodec') == 'none' else [None]
        for sound in tracks:
            parts = [video] + ([sound] if sound else [])
            ids = [fmt.get('format_id') for fmt in parts]
            if not all(isinstance(value, str) and re.fullmatch(r'[\w.-]+', value) for value in ids):
                continue
            sizes = [estimated_size(fmt, duration) for fmt in parts]
            if all(sizes) and sum(sizes) > max_bytes * 0.94:
                continue
            codec = str(video.get('vcodec') or '')
            score = (positive(video.get('height')), codec.startswith(('avc', 'h264')), positive(video.get('tbr')), positive((sound or {}).get('abr')))
            candidates.append((score, '+'.join(ids)))
    if candidates:
        return max(candidates)[1]
    if formats and all(fmt.get('format_id') for fmt in formats):
        raise ParseError('size')
    return 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]/worst'


platform_labels = {
    'bilibili': ('哔哩哔哩', '#FB7299'), 'douyin': ('抖音', '#161823'), 'kuaishou': ('快手', '#FF6B00'),
    'xiaohongshu': ('小红书', '#FF2442'), 'weibo': ('微博', '#E6162D'), 'youtube': ('YouTube', '#FF0000'),
    'tiktok': ('TikTok', '#161823'), 'twitter': ('X', '#111111'), 'instagram': ('Instagram', '#C13584'),
    'facebook': ('Facebook', '#1877F2'), 'reddit': ('Reddit', '#FF4500'), 'acfun': ('AcFun', '#FD4C5D'),
    'zhihu': ('知乎', '#0066FF'), 'tieba': ('百度贴吧', '#3385FF'), 'wechat': ('微信公众号', '#07C160'),
}

icon_dir = Path(__file__).resolve().parent / 'platform-icons'
card_font_paths = ('/usr/share/fonts/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                   '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc',
                   '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')


@lru_cache(maxsize=64)
def card_font(size, bold=False):
    from PIL import ImageFont
    paths = [path.replace('Regular', 'Bold') for path in card_font_paths] if bold else list(card_font_paths)
    for path in paths:
        if not os.path.isfile(path):
            continue
        for index in (2, 0):
            try:
                return ImageFont.truetype(path, size, index=index)
            except (OSError, ValueError):
                continue
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


symbol_fonts = {}
def card_symbol_font(size):
    from PIL import ImageFont
    if size in symbol_fonts:
        return symbol_fonts[size]
    font = None
    for path in (str(Path(__file__).resolve().parent / 'fonts' / 'NotoEmoji.ttf'),
                 '/usr/share/fonts/noto/NotoEmoji-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf',
                 '/usr/share/fonts/noto/NotoColorEmoji.ttf'):
        if os.path.isfile(path):
            try:
                font = ImageFont.truetype(path, size)
                break
            except OSError:
                continue
    symbol_fonts[size] = font
    return font


def text_clusters(text):
    """Keep emoji joiners, modifiers, flags and combining marks in one layout unit."""
    clusters = []
    for char in text or '':
        code = ord(char)
        extender = unicodedata.combining(char) or unicodedata.category(char) in ('Mn', 'Me') or char in ('\ufe0e', '\ufe0f', '\u200d') or 0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F
        flag_pair = 0x1F1E6 <= code <= 0x1F1FF and clusters and len(clusters[-1]) == 1 and 0x1F1E6 <= ord(clusters[-1]) <= 0x1F1FF
        if clusters and (extender or clusters[-1].endswith('\u200d') or flag_pair):
            clusters[-1] += char
        else:
            clusters.append(char)
    return clusters


@lru_cache(maxsize=8192)
def font_supports(font, text):
    missing = font.getmask('\U0010ffff')
    missing = (missing.size, bytes(missing))
    for char in text:
        if char in ('\u200d', '\ufe0e', '\ufe0f') or 0xE0020 <= ord(char) <= 0xE007F:
            continue
        glyph = font.getmask(char)
        if (glyph.size, bytes(glyph)) == missing:
            return False
    return True


@lru_cache(maxsize=8192)
def font_for_char(char, font):
    # Explicit emoji sequences must be shaped as a whole, even if the CJK font
    # has a text-presentation glyph for the first character (e.g. a heart).
    emoji = any(ord(c) >= 0x1F000 for c in char) or '\ufe0f' in char or '\u20e3' in char
    if not emoji and font_supports(font, char):
        return font
    fallback = card_symbol_font(font.size)
    return fallback if fallback and font_supports(fallback, char) else font


def text_runs(text, font):
    """Shape adjacent clusters in the same font together, preserving kerning."""
    runs = []
    for cluster in text_clusters(text):
        current = font_for_char(cluster, font)
        if runs and runs[-1][1] is current:
            runs[-1] = (runs[-1][0] + cluster, current)
        else:
            runs.append((cluster, current))
    return runs


def text_width(text, font):
    return sum(current.getlength(run) for run, current in text_runs(text, font))


@lru_cache(maxsize=64)
def card_baseline_offset(font):
    # A stable CJK/Latin reference keeps the existing top-based card layout,
    # without aligning each glyph (punctuation, lowercase, emoji) to its top.
    return -font.getbbox('国Ag', anchor='ls')[1]


def draw_text(draw, position, text, font, fill, anchor='lt'):
    x, y = position
    runs = text_runs(text, font)
    if anchor[0] == 'r':
        x -= sum(current.getlength(run) for run, current in runs)
    baseline = y + (font.getmetrics()[0] if anchor[1] == 'a' else card_baseline_offset(font))
    for run, current in runs:
        # Right alignment is applied once above. All font runs share the same
        # baseline, including emoji whose ascender differs from the CJK font.
        draw.text((x, baseline), run, font=current, fill=fill, anchor='ls')
        x += current.getlength(run)


def wrap_lines(text, font, max_width, max_lines):
    lines, current, overflow = [], '', False
    for char in text_clusters((text or '').strip()):
        if char in ('\r', '\n', '\r\n'):
            if len(lines) < max_lines:
                lines.append(current)
            else:
                overflow = True
            current = ''
            continue
        if current and text_width(current + char, font) > max_width:
            if len(lines) < max_lines:
                lines.append(current)
            else:
                overflow = True
            current = char
        else:
            current += char
    if current:
        if len(lines) < max_lines:
            lines.append(current)
        else:
            overflow = True
    if overflow and lines:
        last = text_clusters(lines[-1])
        while last and text_width(''.join(last) + '…', font) > max_width:
            last.pop()
        lines[-1] = ''.join(last) + '…'
    return lines


def download_asset(url, directory, name):
    """头像、封面等小图下载，失败时返回 None，不影响解析结果。"""
    if not isinstance(url, str) or not url:
        return None
    if url.startswith('//'):
        url = 'https:' + url
    candidates = ['https:' + url[5:], url] if url.startswith('http:') else [url]
    for candidate in candidates:
        try:
            data, _, _ = read_public(candidate, 12 * 1024 * 1024, 'image/*', image_headers(candidate))
            width, height = image_size(data)
            if not width or not height:
                # HTML login/error pages must not masquerade as downloaded avatars.
                continue
            (directory / name).write_bytes(data)
            return name
        except Exception:
            continue
    return None


def platform_icon(platform):
    path = icon_dir / ('%s.png' % platform)
    return path if path.is_file() else None


def bilibili_avatar(uploader_id):
    if not re.fullmatch(r'\d{1,20}', str(uploader_id or '')):
        return None
    try:
        data, _, _ = read_public('https://api.bilibili.com/x/web-interface/card?mid=%s&photo=false' % uploader_id,
                                 256 * 1024, 'application/json', {'Referer': 'https://www.bilibili.com/'})
        face = ((json.loads(data).get('data') or {}).get('card') or {}).get('face')
        return face if isinstance(face, str) and face.startswith(('http://', 'https://')) else None
    except Exception:
        return None


xhs_state = re.compile(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>', re.S)


def xiaohongshu_url(url):
    host = (urlparse(url).hostname or '').lower()
    if any(host == root or host.endswith('.' + root) for root in ('xhslink.com', 'xhslink.cn')):
        _, _, final = read_public(url, 2 * 1024 * 1024, 'text/html')
        parsed = urlparse(final)
        host = (parsed.hostname or '').lower()
        if host != 'xiaohongshu.com' and not host.endswith('.xiaohongshu.com'):
            raise ParseError('unsupported')
        safe_url(final)
        if re.match(r'^/(?:login|captcha|verify)(?:/|$)', parsed.path):
            raise ParseError('login')
        # Keep xsec_token and other access parameters when expanding new short-link domains.
        return final
    return url


def xiaohongshu_note(url):
    """只读取当前笔记的结构化图片条目，不能把 urlDefault / urlPre 当作两张图。"""
    try:
        data, _, final_url = read_public(url, 2 * 1024 * 1024, 'text/html')
        match = xhs_state.search(data.decode('utf-8', 'replace'))
        if not match:
            return None
        try:
            from yt_dlp.utils import js_to_json
            state = json.loads(js_to_json(match.group(1)))
        except ImportError:
            state = json.loads(re.sub(r'(?<=[\[:,])\s*undefined(?=\s*[,}\]])', 'null', match.group(1)))
        detail = ((state.get('note') or {}).get('noteDetailMap') or {})
        note_id = urlparse(final_url or url).path.rstrip('/').rsplit('/', 1)[-1]
        note = (detail.get(note_id) or {}).get('note') or {}
        if not note or str(note.get('noteId', note_id)) != note_id:
            return None
        user = note.get('user') or {}
        groups = []
        for item in (note.get('imageList') or [])[:40]:
            if not isinstance(item, dict):
                continue
            candidates = [item.get('urlDefault'), item.get('url')]
            candidates += [variant.get('url') for variant in (item.get('infoList') or []) if isinstance(variant, dict)]
            candidates.append(item.get('urlPre'))
            urls = list(dict.fromkeys(value for value in candidates if isinstance(value, str) and value.startswith(('http://', 'https://', '//'))))
            if urls:
                groups.append(urls)
        result = {'uploader': clean(user.get('nickname'), 100), 'avatar': user.get('avatar') or user.get('image'),
                  'title': clean(note.get('title'), 200), 'description': clean(note.get('desc'), 1000)}
        if isinstance(note.get('imageList'), list):
            result['image_groups'] = groups
        if positive(note.get('time')):
            result['timestamp'] = note['time'] / 1000 if note['time'] > 1e11 else note['time']
        return result
    except ParseError as error:
        if error.code == 'blocked':
            raise
        return None
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def xiaohongshu_author(url):
    note = xiaohongshu_note(url)
    return (note or {}).get('avatar')


def circle_avatar(path, size):
    from PIL import Image, ImageDraw, ImageOps
    try:
        image = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    except (OSError, ValueError):
        return None
    image = ImageOps.fit(image, (size, size), Image.LANCZOS, centering=(0.5, 0.4))
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    return image, mask.resize((size, size), Image.LANCZOS)


def compose_card(directory, platform, kind, title, description, author, published, images, avatar=None, allow_empty=False, caption_lines=3, single_cover=False):
    """方案 A：封面在前，标题/摘要分层，作者与时间置底。原图与视频发送不受影响。"""
    try:
        from PIL import Image, ImageDraw, ImageOps, ImageFilter
    except ImportError:
        return None
    files = [name for name in (images or []) if isinstance(name, str)][:MAX_LINK_IMAGES]
    if single_cover:
        files = files[:1]
    if not files and not allow_empty:
        return None
    label, brand = platform_labels.get(platform, ({'github': 'GitHub', 'game': '游戏资讯', 'rss': 'RSS'}.get(platform, platform or '链接'), '#256852'))
    width, media_pad, pad = 1080, 26, 46
    cover_width, text_max_width = width - media_pad * 2, width - pad * 2
    ink, subtle = '#202632', '#707C8C'
    fonts = {'nick': card_font(30, True), 'time': card_font(24), 'title': card_font(42, True),
             'body': card_font(30), 'badge': card_font(24, True)}
    display_author = (author or '分享内容').strip() or '分享内容'
    # 订阅正文可能已包含标题；动态标题也可能只是正文的截断前缀。
    headline, body = (title or '').strip(), (description or '').strip()
    short_title = re.sub(r'(?:\.{3}|…)+$', '', headline).strip()
    if headline and body:
        if body == headline or headline.startswith(body):
            body = ''
        elif short_title and body.startswith(short_title):
            if short_title != headline:
                headline = ''
            else:
                body = body[len(headline):].lstrip()
    title_lines = wrap_lines(headline, fonts['title'], text_max_width, 2)
    body_lines = wrap_lines(body, fonts['body'], text_max_width, caption_lines)

    def load(name):
        try:
            image = ImageOps.exif_transpose(Image.open(directory / name)).convert('RGB')
            image.thumbnail((1600, 1600))
            return image
        except (OSError, ValueError):
            return None

    grid = kind != 'video' and len(files) in (4, 6, 9)
    columns = (2 if len(files) == 4 else 3) if grid else 1
    gap = 16
    cell = (cover_width - gap * (columns - 1)) // columns
    first = load(files[0]) if files else None
    if files and first is None:
        return None
    if grid:
        frame_height = ((len(files) + columns - 1) // columns) * (cell + gap) - gap
    elif first is not None:
        # 保留竖屏和长图边缘，过长图片缩入有柔化背景的区域，避免横向白框。
        frame_height = min(1400, max(160, round(cover_width * first.height / first.width)))
    else:
        frame_height = 0
    cursor = media_pad + frame_height + 32 if files else 110
    title_top = cursor
    cursor += len(title_lines) * 58
    if title_lines and body_lines:
        cursor += 12
    body_top = cursor
    cursor += len(body_lines) * 44
    footer_top = cursor + 30
    size = 58
    # 原始日期（包含年份）保留；附带订阅类型过长时移到第二行。
    time_lines = wrap_lines(published or '', fonts['time'], text_max_width, 2)
    inline_time = len(time_lines) <= 1 and text_width(published or '', fonts['time']) <= text_max_width * 0.52
    footer_height = size if inline_time else size + 14 + 34 * len(time_lines)
    canvas = Image.new('RGB', (width, footer_top + footer_height + 38), 'white')
    if single_cover and first is not None:
        backdrop = ImageOps.fit(first, canvas.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(32))
        canvas = Image.blend(backdrop, canvas, 0.86)
    draw = ImageDraw.Draw(canvas)
    if single_cover:
        draw.rectangle((0, title_top - 18, width, canvas.height), fill='white')

    def paste_rounded(image, position, radius=28):
        mask = Image.new('L', image.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius=radius, fill=255)
        canvas.paste(image, position, mask)

    if grid:
        for index, name in enumerate(files):
            image = first if index == 0 else load(name)
            if image is None:
                return None
            tile = ImageOps.fit(image, (cell, cell), Image.LANCZOS, centering=(0.5, 0.4))
            paste_rounded(tile, (media_pad + (index % columns) * (cell + gap),
                                 media_pad + (index // columns) * (cell + gap)), 20)
    elif first is not None:
        fitted = ImageOps.contain(first, (cover_width, frame_height), Image.LANCZOS)
        if fitted.size != (cover_width, frame_height):
            cover = ImageOps.fit(first, (cover_width, frame_height), Image.LANCZOS).filter(ImageFilter.GaussianBlur(32))
            cover = Image.blend(cover, Image.new('RGB', cover.size, 'white'), 0.35)
            cover.paste(fitted, ((cover_width - fitted.width) // 2, (frame_height - fitted.height) // 2))
        else:
            cover = fitted
        paste_rounded(cover, (media_pad, media_pad))

    # 小标签说明来源与类型；视频不再用遮挡画面的居中播放按钮。
    content_label = '视频' if kind == 'video' else ('%d 张图片' % len(files) if len(files) > 1 else '图文' if files else '动态')
    badge = label + ' · ' + content_label
    badge_width = round(text_width(badge, fonts['badge'])) + 32
    badge_top = media_pad + 18 if files else 38
    draw.rounded_rectangle((pad, badge_top, pad + badge_width, badge_top + 48), radius=14, fill='white', outline='#EDF0F4', width=1)
    draw_text(draw, (pad + 16, badge_top + 12), badge, fonts['badge'], brand, anchor='lt')
    for index, line in enumerate(title_lines):
        draw_text(draw, (pad, title_top + index * 58), line, fonts['title'], ink, anchor='lt')
    for index, line in enumerate(body_lines):
        draw_text(draw, (pad, body_top + index * 44), line, fonts['body'], subtle if title_lines else ink, anchor='lt')

    round_avatar = circle_avatar(directory / avatar, size) if avatar else None
    if round_avatar:
        canvas.paste(round_avatar[0], (pad, footer_top), round_avatar[1])
    else:
        draw.ellipse((pad, footer_top, pad + size, footer_top + size), fill='#EBF2F8')
        initial = text_clusters(display_author)[0]
        box = draw.textbbox((0, 0), initial, font=font_for_char(initial, fonts['nick']))
        draw_text(draw, (pad + (size - box[2] + box[0]) / 2 - box[0], footer_top + (size - box[3] + box[1]) / 2 - box[1]),
                  initial, fonts['nick'], '#365B80', anchor='la')
    text_left = pad + size + 18
    time_width = text_width(published or '', fonts['time']) if inline_time else 0
    author_width = width - pad - text_left - (time_width + 28 if time_width else 0)
    author_lines = wrap_lines(display_author, fonts['nick'], author_width, 1)
    draw_text(draw, (text_left, footer_top + 15), author_lines[0], fonts['nick'], ink, anchor='lt')
    if inline_time:
        draw_text(draw, (width - pad, footer_top + 18), published or '', fonts['time'], subtle, anchor='rt')
    else:
        for index, line in enumerate(time_lines):
            draw_text(draw, (pad, footer_top + size + 14 + index * 34), line, fonts['time'], subtle, anchor='lt')
    name = 'card.png'
    try:
        canvas.save(directory / name, 'PNG', optimize=True)
    except OSError:
        return None
    return name


def compose_game_calendar_card(directory, input_data):
    """Render game redeem codes or activity calendar into a clean HD card."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    width, pad = 1080, 44
    inner_width = width - pad * 2
    fonts = {
        'eyebrow': card_font(22, True),
        'title': card_font(42, True),
        'sub': card_font(24),
        'game': card_font(30, True),
        'primary': card_font(28, True),
        'secondary': card_font(23),
        'badge': card_font(21, True),
        'footer': card_font(22)
    }
    title = clean(input_data.get('title') or '游戏兑换码与活动日历', 80)
    subtitle = clean(input_data.get('subtitle') or '群屿 · 游戏日历速查', 120)
    generated = clean(input_data.get('generatedAt') or published_text(None), 60)
    footer_note = clean(input_data.get('footer') or '发送「/兑换码 游戏名」或「/日历 游戏名」按游戏查看', 120)
    raw_sections = input_data.get('sections')
    if not isinstance(raw_sections, list):
        raw_sections = []

    prepared_sections = []
    for section in raw_sections[:6]:
        if not isinstance(section, dict):
            continue
        game_name = clean(section.get('game') or '游戏', 40)
        color = str(section.get('color') or '#4B6B94').strip()
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            color = '#4B6B94'
        raw_items = section.get('items')
        if not isinstance(raw_items, list):
            raw_items = []
        items = []
        for item in raw_items[:10]:
            if not isinstance(item, dict):
                continue
            badge = clean(item.get('badge') or '资讯', 24)
            tone = str(item.get('tone') or 'active')
            primary_lines = wrap_lines(clean(item.get('primary') or '', 160), fonts['primary'], inner_width - 210, 2)
            secondary_lines = wrap_lines(clean(item.get('secondary') or '', 220), fonts['secondary'], inner_width - 56, 2)
            if not primary_lines:
                continue
            row_h = 26 + len(primary_lines) * 38 + (8 + len(secondary_lines) * 32 if secondary_lines else 0) + 18
            items.append({
                'badge': badge,
                'tone': tone,
                'primary': primary_lines,
                'secondary': secondary_lines,
                'height': row_h
            })
        if not items:
            empty_text = clean(section.get('emptyText') or '当前暂无有效记录', 80)
            items.append({
                'badge': '暂无',
                'tone': 'muted',
                'primary': [empty_text],
                'secondary': [],
                'height': 78
            })
        sec_h = 68 + sum(row['height'] + 14 for row in items) + 10
        prepared_sections.append({'game': game_name, 'color': color, 'items': items, 'height': sec_h})

    if not prepared_sections:
        prepared_sections.append({
            'game': '提示',
            'color': '#4B6B94',
            'items': [{'badge': '提示', 'tone': 'muted', 'primary': ['当前没有可展示的兑换码或活动日程'], 'secondary': [], 'height': 78}],
            'height': 166
        })

    header_h = 186
    footer_h = 84
    total_h = header_h + sum(sec['height'] + 24 for sec in prepared_sections) + footer_h
    canvas = Image.new('RGB', (width, total_h), '#F6F8FC')
    draw = ImageDraw.Draw(canvas)

    # Top header banner
    draw.rounded_rectangle((pad, 32, width - pad, header_h - 14), radius=24, fill='#FFFFFF', outline='#E3EAF4', width=2)
    draw_text(draw, (pad + 32, 54), 'QUNYU GAME ASSISTANT', fonts['eyebrow'], '#4F6F9F', anchor='lt')
    draw_text(draw, (width - pad - 32, 54), generated, fonts['sub'], '#7B8798', anchor='rt')
    draw_text(draw, (pad + 32, 90), title, fonts['title'], '#1E2532', anchor='lt')
    draw_text(draw, (pad + 32, 140), subtitle, fonts['sub'], '#697586', anchor='lt')

    tone_styles = {
        'active': ('#EAF5EE', '#266847'),
        'urgent': ('#FDF1EC', '#B84A27'),
        'info': ('#EDF2FB', '#3B5E9C'),
        'muted': ('#F0F2F6', '#6E7887')
    }

    cursor = header_h + 10
    for sec in prepared_sections:
        sec_top = cursor
        sec_bottom = sec_top + sec['height']
        draw.rounded_rectangle((pad, sec_top, width - pad, sec_bottom), radius=22, fill='#FFFFFF', outline='#E5ECF5', width=2)
        draw.rounded_rectangle((pad + 24, sec_top + 22, pad + 34, sec_top + 54), radius=5, fill=sec['color'])
        draw_text(draw, (pad + 48, sec_top + 22), sec['game'], fonts['game'], '#1E2532', anchor='lt')
        row_y = sec_top + 68
        for row in sec['items']:
            row_bottom = row_y + row['height']
            draw.rounded_rectangle((pad + 22, row_y, width - pad - 22, row_bottom), radius=16, fill='#F9FBFE', outline='#EDF2F8', width=1)
            badge_bg, badge_fg = tone_styles.get(row['tone'], tone_styles['info'])
            bw = round(text_width(row['badge'], fonts['badge'])) + 28
            bx = width - pad - 42 - bw
            by = row_y + 18
            draw.rounded_rectangle((bx, by, bx + bw, by + 38), radius=11, fill=badge_bg)
            draw_text(draw, (bx + 14, by + 8), row['badge'], fonts['badge'], badge_fg, anchor='lt')
            ty = row_y + 20
            for line in row['primary']:
                draw_text(draw, (pad + 42, ty), line, fonts['primary'], '#1F2735', anchor='lt')
                ty += 38
            if row['secondary']:
                ty += 6
                for line in row['secondary']:
                    draw_text(draw, (pad + 42, ty), line, fonts['secondary'], '#667284', anchor='lt')
                    ty += 32
            row_y = row_bottom + 14
        cursor = sec_bottom + 24

    draw_text(draw, (pad + 8, cursor + 12), footer_note, fonts['footer'], '#748094', anchor='lt')
    name = 'card.png'
    try:
        canvas.save(directory / name, 'PNG', optimize=True)
    except OSError:
        return None
    return name


def published_text(value):
    """卡片展示的发布时间；容器默认 UTC，这里统一按北京时间（UTC+8）显示。"""
    stamp = value if isinstance(value, (int, float)) and value > 0 else None
    if stamp and stamp > 1e11:  # 毫秒时间戳
        stamp /= 1000
    try:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime((stamp or time.time()) + 8 * 3600))
    except (OverflowError, ValueError, OSError):
        return ''


def error_code(error):
    if isinstance(error, ParseError):
        return error.code
    text = str(error).lower()
    if 'blocked' in text:
        return 'blocked'
    if any(word in text for word in ('file too large', 'size limit')):
        return 'size'
    if 'postprocessing' in text or isinstance(error, subprocess.SubprocessError):
        return 'processing'
    if any(word in text for word in ('cookie', 'login', 'sign in', '403', '412', '429', 'captcha')):
        return 'login'
    if any(word in text for word in ('timed out', 'connection', 'resolve', '404', 'ssl', 'urlopen', 'socks', 'proxy')):
        return 'network'
    if 'requested format' in text or 'no video formats' in text:
        return 'format'
    return 'unsupported'


def bilibili_api(endpoint, params, allow_guest=False):
    payload, _, _ = read_public('https://api.bilibili.com/x/' + endpoint + '?' + urlencode(params),
                                2 * 1024 * 1024, 'application/json', {'Referer': 'https://www.bilibili.com/'})
    data = json.loads(payload)
    if data.get('code') != 0 and not (allow_guest and endpoint == 'web-interface/nav' and data.get('code') == -101 and isinstance(data.get('data'), dict)):
        raise ParseError('login' if data.get('code') in (-101, -352, -403, -412, -799) else 'unsupported')
    return data.get('data')


def analysis_download(url, target, max_bytes, referer='https://www.bilibili.com/'):
    """Stream through the guarded Python opener; ffmpeg only ever sees local files."""
    request = Request(safe_url(url), headers={'User-Agent': agent, 'Referer': referer})
    with opener.open(request, timeout=15) as response, target.open('wb') as output:
        safe_url(response.url)
        if int(response.headers.get('Content-Length') or 0) > max_bytes:
            raise ParseError('size')
        total = 0
        while True:
            chunk = response.read(128 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ParseError('size')
            output.write(chunk)
        if not total:
            raise ParseError('output')


def bilibili_playinfo(bvid, cid):
    params = {'bvid': bvid, 'cid': cid, 'qn': 32, 'fnval': 16, 'fourk': 0}
    try:
        return bilibili_api('player/playurl', params)
    except Exception:
        # Some videos require the current WBI endpoint; sign exactly the requested video and part.
        nav = bilibili_api('web-interface/nav', {}, allow_guest=True)
        images = nav.get('wbi_img') or {}
        key = ''.join(Path(urlparse(images.get(name, '')).path).stem for name in ('img_url', 'sub_url'))
        order = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
                 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
                 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
        if len(key) != 64:
            raise ParseError('format')
        mixin = ''.join(key[index] for index in order)[:32]
        params['wts'] = round(time.time())
        query = urlencode(sorted((name, re.sub(r"[!'()*]", '', str(value))) for name, value in params.items()))
        params['w_rid'] = hashlib.md5((query + mixin).encode()).hexdigest()
        return bilibili_api('player/wbi/playurl', params)


def bilibili_download(play, source, max_bytes, audio_only=False):
    durl = play.get('durl') or []
    tracks = (play.get('dash') or {}).get('audio' if audio_only else 'video') or []
    if len(durl) == 1:
        track = durl[0]
    elif tracks:
        select = max if audio_only else min
        track = select(tracks, key=lambda item: positive(item.get('bandwidth')) or (0 if audio_only else float('inf')))
    else:
        raise ParseError('format')
    # Bilibili's primary PCDN URL can use a nonstandard port; prefer an allowed backup CDN.
    urls = [track.get('baseUrl') or track.get('base_url') or track.get('url')]
    urls += list(track.get('backupUrl') or track.get('backup_url') or [])[:3]
    failure = 'format'
    for url in dict.fromkeys(value for value in urls if isinstance(value, str) and value):
        try:
            analysis_download('https:' + url if url.startswith('//') else url, source, max_bytes)
            return
        except Exception as error:
            source.unlink(missing_ok=True)
            failure = error_code(error)
            if failure == 'size':
                break
    raise ParseError(failure)


def bilibili_audio(input_data):
    global opener
    max_bytes, max_duration = int(input_data['maxBytes']), int(input_data['maxDuration'])
    if not (1024 * 1024 <= max_bytes <= MAX_LINK_MEDIA_BYTES and 10 <= max_duration <= 1800):
        raise ParseError('size')
    directory = Path(input_data['directory']).resolve()
    install_network_guard()
    cookies = Path(input_data.get('cookieFile', ''))
    if cookies.is_file() and not cookies.is_symlink():
        opener = build_opener(ProxyHandler({}), SafeRedirect(), HTTPCookieProcessor(metadata_cookies(cookies)))
    url = bilibili_url(safe_url(input_data['url']))
    match = re.fullmatch(r'/video/(BV[\da-zA-Z]{10}|av\d+)/?', urlparse(url).path)
    if not match or urlparse(url).hostname != 'www.bilibili.com':
        raise ParseError('unsupported')
    video_id = match[1]
    identity = {'bvid': video_id} if video_id.startswith('BV') else {'aid': video_id[2:]}
    view = bilibili_api('web-interface/view', identity)
    if not isinstance(view, dict) or not re.fullmatch(r'BV[\da-zA-Z]{10}', str(view.get('bvid', ''))) \
            or str(view.get('aid', '')) == '' or any(str(view.get(key)) != value for key, value in identity.items()):
        raise ParseError('output')
    page = int(parse_qs(urlparse(url).query).get('p', ['1'])[0])
    pages = view.get('pages') or [{'page': 1, 'cid': view.get('cid'), 'duration': view.get('duration')}]
    selected = next((item for item in pages if item.get('page') == page), None)
    if not selected or not isinstance(selected.get('cid'), int) or selected['cid'] <= 0:
        raise ParseError('unsupported')
    duration = positive(selected.get('duration'))
    if not math.isfinite(duration) or not 0 < duration <= max_duration:
        raise ParseError('duration')
    play = bilibili_playinfo(view['bvid'], selected['cid'])
    source = directory / 'source.mp4'
    bilibili_download(play, source, max_bytes, audio_only=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                            '-show_format', '-show_streams', '-of', 'json', str(source)],
                           capture_output=True, timeout=15, check=True)
    info = json.loads(probe.stdout)
    actual_duration = float(info.get('format', {}).get('duration') or 0)
    if not math.isfinite(actual_duration) or not 0 < actual_duration <= max_duration \
            or not any(stream.get('codec_type') == 'audio' for stream in info.get('streams', [])):
        raise ParseError('output')
    return {'file': source.name, 'title': clean(view.get('title'), 200), 'duration': actual_duration}


def bilibili_contact_sheets(source, directory, max_duration, max_sheets):
    try:
        from PIL import Image, ImageDraw, ImageOps
    except ImportError:
        raise ParseError('dependencies') from None
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ParseError('dependencies')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                            '-show_format', '-show_streams', '-of', 'json', str(source)],
                           capture_output=True, timeout=15, check=True)
    info = json.loads(probe.stdout)
    duration = float(info.get('format', {}).get('duration') or 0)
    if not math.isfinite(duration) or not 0 < duration <= max_duration:
        raise ParseError('duration')
    if not any(stream.get('codec_type') == 'video' for stream in info.get('streams', [])):
        raise ParseError('output')
    count = min(max_sheets * 4, max(1, math.ceil(duration)))
    stamps = [round((max(0, duration - 0.2)) * i / max(1, count - 1), 2) for i in range(count)]
    frames = []
    for index, stamp in enumerate(stamps):
        name = directory / ('frame-%02d.jpg' % index)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-threads', '2',
                        '-protocol_whitelist', 'file,pipe', '-ss', str(stamp), '-i', str(source),
                        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease',
                        '-threads', '2', str(name)], capture_output=True, timeout=15, check=True)
        if not name.is_file():
            raise ParseError('output')
        frames.append(name)
    sheets = []
    for offset in range(0, len(frames), 4):
        sheet = Image.new('RGB', (1280, 784), '#161b22')
        draw = ImageDraw.Draw(sheet)
        for cell, name in enumerate(frames[offset:offset + 4]):
            x, y = (cell % 2) * 640, (cell // 2) * 392
            with Image.open(name) as frame:
                frame = ImageOps.contain(frame.convert('RGB'), (640, 360))
                sheet.paste(frame, (x + (640 - frame.width) // 2, y + (360 - frame.height) // 2))
            draw.text((x + 12, y + 366), '#%02d  %.2fs' % (offset + cell + 1, stamps[offset + cell]), fill='white')
        name = 'analysis-%d.jpg' % len(sheets)
        sheet.save(directory / name, 'JPEG', quality=88)
        sheets.append(name)
    return sheets, stamps, any(stream.get('codec_type') == 'audio' for stream in info.get('streams', []))


def analyze_bilibili(input_data):
    """Collect evidence for DS without posting videos or executing model-provided commands."""
    global opener
    max_bytes, max_duration = int(input_data['maxBytes']), int(input_data['maxDuration'])
    if not (1024 * 1024 <= max_bytes <= MAX_LINK_MEDIA_BYTES and 10 <= max_duration <= 1800):
        raise ParseError('size')
    directory = Path(input_data['directory']).resolve()
    install_network_guard()
    cookies = Path(input_data.get('cookieFile', ''))
    if cookies.is_file() and not cookies.is_symlink():
        opener = build_opener(ProxyHandler({}), SafeRedirect(), HTTPCookieProcessor(metadata_cookies(cookies)))
    url = bilibili_url(safe_url(input_data['url']))
    match = re.fullmatch(r'/video/(BV[\da-zA-Z]{10}|av\d+)/?', urlparse(url).path)
    if not match or urlparse(url).hostname != 'www.bilibili.com':
        raise ParseError('unsupported')
    video_id = match[1]
    identity = {'bvid': video_id} if video_id.startswith('BV') else {'aid': video_id[2:]}
    view = bilibili_api('web-interface/view', identity)
    if not isinstance(view, dict) or not re.fullmatch(r'BV[\da-zA-Z]{10}', str(view.get('bvid', ''))) \
            or str(view.get('aid', '')) == '' or any(str(view.get(key)) != value for key, value in identity.items()):
        raise ParseError('output')
    page = int(parse_qs(urlparse(url).query).get('p', ['1'])[0])
    pages = view.get('pages') or [{'page': 1, 'cid': view.get('cid'), 'duration': view.get('duration')}]
    selected = next((item for item in pages if item.get('page') == page), None)
    if not selected or not isinstance(selected.get('cid'), int) or selected['cid'] <= 0:
        raise ParseError('unsupported')
    bvid, aid, cid = view['bvid'], view['aid'], selected['cid']
    canonical = 'https://www.bilibili.com/video/' + bvid + ('?p=%d' % page if page != 1 else '')
    result = {'url': canonical, 'bvid': bvid, 'page': page, 'part': clean(selected.get('part'), 200),
              'title': clean(view.get('title'), 200), 'author': clean((view.get('owner') or {}).get('name'), 100),
              'description': clean(view.get('desc'), 6000), 'duration': positive(selected.get('duration')),
              'published': published_text(view['pubdate']) if positive(view.get('pubdate')) else '',
              'dimensions': selected.get('dimension') or view.get('dimension'),
              'tags': [], 'comments': [], 'related': [], 'subtitles': [], 'sheets': [], 'frameTimes': [],
              'visualStatus': 'disabled', 'audioAnalyzed': False, 'warnings': {}}

    def optional(callback):
        try:
            return callback()
        except Exception as error:
            return {'_error': error_code(error)}

    tasks = {
        'page': lambda: page_metadata(canonical),
        'tags': lambda: bilibili_api('tag/archive/tags', {'bvid': bvid}),
        'comments': lambda: bilibili_api('v2/reply', {'type': 1, 'oid': aid, 'pn': 1, 'ps': 10, 'sort': 2}),
        'related': lambda: bilibili_api('web-interface/archive/related', {'bvid': bvid}),
        'player': lambda: bilibili_api('player/wbi/v2', {'bvid': bvid, 'cid': cid})
    }
    with ThreadPoolExecutor(max_workers=5) as pool:
        pending = {key: pool.submit(optional, callback) for key, callback in tasks.items()}
        extra = {key: future.result() for key, future in pending.items()}
    for key, value in extra.items():
        if isinstance(value, dict) and '_error' in value:
            result['warnings'][key] = value['_error']
    result['pageDescription'] = clean((extra.get('page') or {}).get('description'), 2000)
    tags = extra['tags'] if isinstance(extra['tags'], list) else []
    result['tags'] = [clean(tag.get('tag_name'), 80) for tag in tags[:20] if isinstance(tag, dict)]
    comments = extra['comments'] if isinstance(extra['comments'], dict) else {}
    seen = set()
    for item in (comments.get('hots') or []) + (comments.get('replies') or []):
        if not isinstance(item, dict) or item.get('rpid') in seen:
            continue
        seen.add(item.get('rpid'))
        result['comments'].append({'text': clean((item.get('content') or {}).get('message'), 700)})
        if len(result['comments']) >= 10:
            break
    related = extra['related'] if isinstance(extra['related'], list) else []
    result['related'] = [{'title': clean(item.get('title'), 200), 'bvid': clean(item.get('bvid'), 30)}
                         for item in related[:5] if isinstance(item, dict)]
    player = extra['player'] if isinstance(extra['player'], dict) else {}
    subtitles = (player.get('subtitle') or {}).get('subtitles') or []
    subtitles = sorted((item for item in subtitles if isinstance(item, dict)), key=lambda item: not str(item.get('lan', '')).startswith('zh'))
    if subtitles:
        try:
            subtitle_url = str(subtitles[0].get('subtitle_url') or '')
            if subtitle_url.startswith('//'):
                subtitle_url = 'https:' + subtitle_url
            payload, _, _ = read_public(subtitle_url, 2 * 1024 * 1024, 'application/json')
            size = 0
            for line in (json.loads(payload).get('body') or [])[:2000]:
                text = clean(line.get('content'), 500)
                size += len(text)
                if size > 16000:
                    result['warnings']['subtitles'] = 'truncated'
                    break
                result['subtitles'].append({'from': positive(line.get('from')), 'to': positive(line.get('to')), 'text': text})
        except Exception as error:
            result['warnings']['subtitles'] = error_code(error)
    max_sheets = max(0, min(3, int(input_data.get('maxSheets', 3))))
    if input_data.get('allowVideo') is False or not max_sheets:
        result['warnings']['visual'] = 'disabled_by_settings' if input_data.get('allowVideo') is False else 'image_limit'
        return result
    result['visualStatus'] = 'failed'
    try:
        if result['duration'] > max_duration:
            raise ParseError('duration')
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            raise ParseError('dependencies')
        play = bilibili_playinfo(bvid, cid)
        # A DASH video track is sufficient for visual analysis; do not claim to have listened to it.
        source = directory / 'analysis-source.mp4'
        bilibili_download(play, source, max_bytes)
        sheets, times, has_audio = bilibili_contact_sheets(source, directory, max_duration, max_sheets)
        result.update({'sheets': sheets, 'frameTimes': times, 'downloadedTrackHasAudio': has_audio, 'visualStatus': 'completed'})
    except Exception as error:
        result['warnings']['visual'] = error_code(error)
    return result


def parse(input_data):
    global opener
    try:
        from yt_dlp import YoutubeDL
    except ImportError:
        raise ParseError('dependencies')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ParseError('dependencies')
    safe_url(input_data['url'])
    directory = Path(input_data['directory']).resolve()
    max_bytes, max_duration = int(input_data['maxBytes']), int(input_data['maxDuration'])
    if not (1024 * 1024 <= max_bytes <= MAX_LINK_MEDIA_BYTES and 10 <= max_duration <= 1800):
        raise ParseError('size')
    # Inherited by ffmpeg: even unknown-length streams cannot create an unbounded file.
    if os.name == 'posix':
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (max_bytes, max_bytes))
    install_network_guard()
    options = {'quiet': True, 'no_warnings': True, 'logger': QuietLogger(), 'noplaylist': True,
               'playlistend': 1, 'extract_flat': False, 'skip_download': True, 'ignore_no_formats_error': True,
               'socket_timeout': 15, 'retries': 1, 'fragment_retries': 1, 'extractor_retries': 1,
               'cachedir': False, 'proxy': '', 'enable_file_urls': False, 'usenetrc': False,
               'js_runtimes': {'node': {'path': shutil.which('node')}}, 'remote_components': [],
               'http_headers': {'User-Agent': agent}}
    cookies = Path(input_data.get('cookieFile', ''))
    opener = network_opener(cookies, input_data.get('proxyUrl', '') if input_data['platform'] == 'twitter' else '')
    if cookies.is_file() and not cookies.is_symlink():
        options['cookiefile'] = str(cookies)
    url = bilibili_url(input_data['url']) if input_data['platform'] == 'bilibili' else xiaohongshu_url(input_data['url']) if input_data['platform'] == 'xiaohongshu' else input_data['url']
    info, extraction_error, direct_douyin, douyin_direct_info = None, None, False, False
    # The group may disable video parsing: then never download a video, only read page metadata.
    wants_video = bool(input_data.get('video')) and input_data.get('allowVideo', True)
    with contextlib.redirect_stdout(sys.stderr):
        if input_data['platform'] == 'twitter':
            info = twitter_info(url, allow_video=wants_video)
        dynamic = bilibili_dynamic(url) if input_data['platform'] == 'bilibili' else None
        if dynamic:
            info = dynamic
        if wants_video and input_data['platform'] == 'douyin':
            direct_douyin = True
            try:
                info = douyin_info(input_data['url'])
                douyin_direct_info = True
            except Exception as error:
                extraction_error = error_code(error)
                if extraction_error == 'blocked':
                    raise ParseError('blocked')
        if wants_video and input_data['platform'] != 'twitter' and (not dynamic or dynamic.get('video_url')) \
                and (not direct_douyin or info is None):
            try:
                with YoutubeDL(options) as ydl:
                    info = ydl.extract_info(dynamic['video_url'] if dynamic else url, download=False)
                extraction_error = None
            except Exception as error:
                extraction_error = error_code(error)
                if extraction_error == 'blocked':
                    raise ParseError('blocked')
        if dynamic:
            extracted = info if isinstance(info, dict) else {}
            info = {**extracted, **dynamic}
            if extracted.get('thumbnail'):
                info['thumbnail'] = extracted['thumbnail']
        weibo = None
        if input_data['platform'] == 'weibo':
            # 微博图文帖没有视频格式，yt-dlp 会当作不支持；改用访客接口取文案与全部原图。
            try:
                weibo = weibo_post(input_data['url'], str(cookies) if cookies.is_file() else '')
            except ParseError:
                raise
            except Exception:
                weibo = None
        if not isinstance(info, dict):
            info = {'title': weibo['title'], 'description': weibo['description'], 'uploader': weibo['author'],
                    'thumbnails': [{'url': url} for url in weibo['images']]} if weibo else page_metadata(url)
        elif weibo:
            # 视频帖也可能带图，图文信息以访客接口为准补全。
            if not info.get('title'):
                info['title'] = weibo['title']
            if not info.get('description'):
                info['description'] = weibo['description']
            if not info.get('uploader'):
                info['uploader'] = weibo['author']
            if weibo['images']:
                info['thumbnails'] = [{'url': url} for url in weibo['images']] + (info.get('thumbnails') or [])
        if input_data['platform'] == 'xiaohongshu':
            note = xiaohongshu_note(url)
            if note:
                for key, value in note.items():
                    if value or key == 'image_groups':
                        info[key] = value
        # Process a single video/post; never crawl playlists, feeds or comment sections.
        if info.get('_type') in ('playlist', 'multi_video'):
            entries = iter(info.get('entries') or [])
            info = next((entry for entry in entries if isinstance(entry, dict)), None)
            if not info:
                raise ParseError('unsupported')
        result = {'title': clean(info.get('title'), 200), 'description': clean(info.get('description'), 1000),
                  'author': clean(info.get('uploader') or info.get('channel') or info.get('uploader_id'), 100), 'images': []}
        published = (weibo or {}).get('published') or published_text(info.get('timestamp'))
        # 卡片用的作者头像：优先平台返回的字段，其次按平台单独取。
        avatar_urls = list(dict.fromkeys(value for value in [
            *((weibo or {}).get('avatar_candidates') or []), (weibo or {}).get('avatar'), info.get('avatar')
        ] if isinstance(value, str) and value))
        if not avatar_urls and input_data['platform'] == 'bilibili':
            avatar_url = bilibili_avatar(info.get('uploader_id') or info.get('channel_id'))
            if avatar_url:
                avatar_urls.append(avatar_url)
        avatar_file = next((name for name in (download_asset(url, directory, 'avatar.jpg') for url in avatar_urls) if name), None)
        formats = info.get('formats') or ([] if not info.get('url') else [info])
        if formats:
            if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming') or (info.get('duration') or 0) > max_duration:
                raise ParseError('duration')

            def progress(_):
                size = sum(file.stat().st_size for file in directory.iterdir() if file.is_file())
                if size > max_bytes * 2:
                    raise ParseError('size')

            def filter_video(value, *, incomplete=False):
                if value.get('is_live') or (value.get('duration') or 0) > max_duration:
                    return 'duration'
                if (value.get('filesize') or 0) > max_bytes:
                    return 'size'

            options.update({'skip_download': False, 'ignore_no_formats_error': False,
                            'format': select_video_format(info, max_bytes),
                            'outtmpl': str(directory / 'source.%(ext)s'), 'merge_output_format': 'mp4',
                            'max_filesize': max_bytes, 'match_filter': filter_video, 'progress_hooks': [progress],
                            'hls_prefer_native': True, 'concurrent_fragment_downloads': 1, 'overwrites': True})
            # Do not retain the initial metadata pass's default (often 4K) selection.
            if info.get('formats'):
                for key in ('requested_formats', 'requested_downloads', 'url', 'format', 'format_id', 'ext', 'protocol', 'filepath', '_filename'):
                    info.pop(key, None)
            try:
                if input_data['platform'] == 'twitter' or (input_data['platform'] == 'douyin' and douyin_direct_info):
                    selected = next((item for item in formats if item.get('format_id') == options['format']), None)
                    if not selected:
                        raise ParseError('format')
                    referer = 'https://x.com/' if input_data['platform'] == 'twitter' else 'https://www.douyin.com/'
                    analysis_download(selected['url'], directory / 'source.mp4', max_bytes, referer=referer)
                else:
                    with YoutubeDL(options) as ydl:
                        ydl.process_ie_result(info, download=True)
            except Exception as error:
                if any(file.is_file() and file.stat().st_size >= max_bytes for file in directory.iterdir()):
                    raise ParseError('size') from None
                raise ParseError(error_code(error)) from None
            source = next((file for file in directory.glob('source.*') if file.suffix in ('.mp4', '.mkv', '.webm', '.flv', '.mov')), None)
            if not source or source.stat().st_size > max_bytes:
                raise ParseError('size' if source else 'output')
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)],
                                   capture_output=True, timeout=20, check=True)
            details = json.loads(probe.stdout)
            duration = float(details.get('format', {}).get('duration') or 0)
            if duration <= 0 or duration > max_duration:
                raise ParseError('duration')
            streams = details.get('streams') or []
            videos = [stream for stream in streams if stream.get('codec_type') == 'video']
            if not videos:
                raise ParseError('output')
            copy = all(stream.get('codec_name') in ('h264', 'aac') for stream in streams if stream.get('codec_type') in ('video', 'audio'))
            codecs = ['-c', 'copy'] if copy else ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '28', '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '96k']
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?', *codecs,
                            '-movflags', '+faststart', str(directory / 'video.mp4')], capture_output=True, timeout=120, check=True)
            result['video'] = 'video.mp4'
            result['duration'] = duration
            # 视频卡片只需要一张封面，不额外保存整组图片。
            thumb = info.get('thumbnail') or next((item.get('url') for item in (info.get('thumbnails') or [])
                                                   if isinstance(item, dict) and item.get('url')), '')
            cover = download_asset(thumb, directory, 'cover.jpg') if thumb else None
            if cover:
                card = compose_card(directory, input_data['platform'], 'video', result['title'],
                                    result['description'] or result['title'], result['author'], published, [cover], avatar_file)
                if card:
                    result['card'] = card
        else:
            # A known video page must never be reported as a successful text-only parse.
            paths = [urlparse(value).path for value in (url, info.get('webpage_url') or url)]
            known_video = not info.get('is_album') and (info.get('has_video') or input_data['platform'] in ('youtube', 'tiktok')
                or any(re.search(r'/(?:video|shorts|reel|short-video|tv)/', path) for path in paths))
            if known_video and wants_video:
                raise ParseError(extraction_error or 'format')
            # With video parsing disabled the group only gets the title and description.
            if not known_video:
                result['images'] = download_images(info, directory, max_bytes, input_data['platform'])
                # 记录实际拿到的像素尺寸，便于判断画质瓶颈在来源、CDN 还是 QQ 转码。
                sizes = []
                for name in result['images']:
                    with open(directory / name, 'rb') as handle:
                        sizes.append(list(image_size(handle.read(65536))))
                if sizes:
                    result['imageSizes'] = sizes
                if result['images']:
                    # 4/6/9 张用宫格，其他数量仅用首张做封面；聊天记录仍包含全部已取原图。
                    card = compose_card(directory, input_data['platform'], 'photo', result['title'],
                                        result['description'] or result['title'], result['author'], published, result['images'], avatar_file)
                    if card:
                        result['card'] = card
    return result


def main():
    input_data = json.load(sys.stdin)
    if input_data.get('action') == 'subscription_card':
        # Rendering only: use the same layout as link parsing without invoking
        # an extractor, loading credentials or making network requests.
        directory = Path(input_data['directory']).resolve()
        files = input_data.get('images') or []
        avatar = input_data.get('avatar') or None
        kind = input_data.get('kind', 'video')
        if input_data.get('platform') not in ('bilibili', 'douyin', 'github', 'game', 'rss') or kind not in ('video', 'photo', 'text') or not isinstance(files, list) or len(files) > MAX_LINK_IMAGES:
            raise ParseError('output')
        for name in files + ([avatar] if avatar else []):
            if not isinstance(name, str) or not re.fullmatch(r'(?:image-\d+|avatar)\.(?:jpg|png|webp|gif)', name):
                raise ParseError('output')
            path = directory / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 6 * 1024 * 1024:
                raise ParseError('output')
        return {'card': compose_card(directory, input_data['platform'], kind,
                    clean(input_data.get('title'), 300), clean(input_data.get('description'), 1000),
                    clean(input_data.get('author'), 100), clean(input_data.get('published'), 60), files, avatar,
                    allow_empty=True, caption_lines=6 if files else 10, single_cover=True)}
    if input_data.get('action') == 'game_calendar_card':
        directory = Path(input_data['directory']).resolve()
        return {'card': compose_game_calendar_card(directory, input_data)}
    if input_data.get('action') == 'status':
        try:
            import yt_dlp.version
            ready = bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))
            return {'available': ready, 'version': yt_dlp.version.__version__, 'detail': '解析器已就绪' if ready else '缺少 ffmpeg / ffprobe'}
        except ImportError:
            return {'available': False, 'detail': '缺少 yt-dlp，请安装 requirements-parser.txt 或重建镜像'}
    if input_data.get('action') == 'analyze_bilibili':
        return analyze_bilibili(input_data)
    if input_data.get('action') == 'bilibili_audio':
        return bilibili_audio(input_data)
    if input_data.get('action') == 'bilibili_feed':
        return bilibili_feed(input_data)
    return parse(input_data)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except ParseError as error:
        print(json.dumps({'error': error.code}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'error': error_code(error)}))
        sys.exit(1)
