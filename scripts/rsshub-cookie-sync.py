"""Synchronize the bot's verified Bilibili login to a managed RSSHub instance.

Read-only by default. --apply requires the qqbot-rsshub Compose service and
recreates it: restarting a container never reloads its env_file.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time


class SyncError(Exception):
    pass


def private_text(path, maximum=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or info.st_mode & 0o077:
            raise SyncError('登录态和 RSSHub 环境文件必须是私有普通文件，权限需为 600')
        with os.fdopen(fd, encoding='utf-8', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def parse_env(content):
    result = {}
    for line in content.splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in result:
            raise SyncError('环境文件包含无效或重复键，请先检查文件格式')
        result[key] = value
    return result


def cookie_values(header):
    return dict(part.strip().split('=', 1) for part in header.split(';') if '=' in part)


def verified_cookie(session, old_env, now):
    if session.get('state') not in ('valid', 'refreshed'):
        raise SyncError('B 站登录尚未确认有效，保留 RSSHub 原凭据，请先在机器人后台检查登录')
    checked = session.get('lastCheckedAt') or session.get('lastRefreshedAt')
    if not isinstance(checked, (int, float)) or not 0 <= now * 1000 - checked <= 24 * 3600000:
        raise SyncError('B 站登录检查已超过 24 小时，保留原凭据，请先在机器人后台检查登录')
    rows = []
    for line in session.get('cookieContent', '').splitlines():
        if line.startswith('#HttpOnly_'):
            line = line[10:]
        elif line.startswith('#'):
            continue
        fields = line.split('\t')
        if len(fields) != 7:
            continue
        domain, _, path, _, expires, name, value = fields
        # This cookie is for api.bilibili.com, not an unrelated subdomain.
        if domain.lstrip('.') not in ('bilibili.com', 'api.bilibili.com') or path != '/':
            continue
        try:
            if float(expires) and float(expires) <= now:
                continue
        except ValueError:
            continue
        if not re.fullmatch(r'[A-Za-z0-9_]+', name) or any(char in value for char in '\r\n\t;'):
            raise SyncError('登录数据含无效 Cookie 字段，已保留原凭据')
        rows.append((domain.lstrip('.') == 'api.bilibili.com', name, value))
    values = {name: value for _, name, value in sorted(rows)}
    if not values.get('SESSDATA') or not values.get('bili_jct') or not re.fullmatch(r'[1-9]\d{0,19}', values.get('DedeUserID', '')):
        raise SyncError('有效登录字段不完整或已过期，已保留原凭据')
    # Fingerprint fallback belongs to this login account. Never mix devices when
    # an administrator switches the bound Bilibili account.
    previous = next((cookie_values(value) for key, value in old_env.items()
                     if key.startswith('BILIBILI_COOKIE_') and cookie_values(value).get('DedeUserID') == values['DedeUserID']), {})
    for name in ('buvid3', 'buvid4', 'b_nut'):
        if name not in values and name in previous:
            values[name] = previous[name]
    header = '; '.join(f'{key}={values[key]}' for key in sorted(values))
    return {'BILIBILI_COOKIE_' + values['DedeUserID']: header}


def with_cookies(content, cookies):
    lines = [line for line in content.splitlines() if not line.partition('=')[0].startswith('BILIBILI_COOKIE_')]
    return '\n'.join(lines + [f'{key}={value}' for key, value in cookies.items()]) + '\n'


def plan_sync(session, content, running_env, now=None):
    cookies = verified_cookie(session, parse_env(content), now if now is not None else time.time())
    updated = with_cookies(content, cookies)
    running = {key: value for key, value in running_env.items() if key.startswith('BILIBILI_COOKIE_')}
    return {'content': updated, 'diskChanged': parse_env(updated) != parse_env(content),
            'needsRecreate': running != cookies, 'cookieKeys': sorted(cookies)}


def atomic_write(path, content):
    if path.is_symlink():
        raise SyncError('拒绝写入符号链接环境文件')
    previous = path.stat() if path.exists() else None
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            if previous and (previous.st_uid != os.geteuid() or previous.st_gid != os.getegid()):
                os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def inspect_container(name, run=subprocess.run):
    result = run(['docker', 'inspect', name], check=True, capture_output=True, text=True, timeout=15)
    return json.loads(result.stdout)[0]


def environment(info):
    return dict(row.split('=', 1) for row in info['Config'].get('Env', []) if '=' in row)


def apply_sync(path, original, plan, info, compose, container='rsshub', run=subprocess.run):
    labels = info['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != 'qqbot-rsshub' or labels.get('com.docker.compose.service') != 'rsshub':
        raise SyncError('旧 RSSHub 尚未迁移到 compose.rsshub.yaml；已停止，未写入凭据或改动容器')
    if not plan['diskChanged'] and not plan['needsRecreate']:
        return False
    command = ['docker', 'compose', '--project-name', 'qqbot-rsshub', '--file', str(compose), 'up', '-d', '--no-deps', '--force-recreate', 'rsshub']
    env = {**os.environ, 'RSSHUB_ENV_FILE': str(path)}
    try:
        if plan['diskChanged']:
            atomic_write(path, plan['content'])
        run(command, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        actual = inspect_container(container, run)
        loaded = {key: value for key, value in environment(actual).items() if key.startswith('BILIBILI_COOKIE_')}
        expected = {key: parse_env(plan['content'])[key] for key in plan['cookieKeys']}
        if not actual['State'].get('Running') or loaded != expected:
            raise SyncError('RSSHub 重建后凭据未生效')
    except Exception:
        # Restore the original file and attempt to restart the original settings.
        # Report rollback failure explicitly, never claim that stale env is synced.
        atomic_write(path, original)
        try:
            run(command, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        except Exception:
            raise SyncError('RSSHub 更新失败，环境文件已恢复，容器回滚未确认，请检查服务') from None
        raise SyncError('RSSHub 更新未确认，已恢复原环境文件并执行容器回滚') from None
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument('--session', type=Path, default=root / 'data/bilibili-session.json')
    parser.add_argument('--env-file', type=Path, default=root / 'rsshub.env')
    parser.add_argument('--compose-file', type=Path, default=Path(__file__).resolve().parents[1] / 'compose.rsshub.yaml')
    parser.add_argument('--container', default='rsshub')
    parser.add_argument('--apply', action='store_true', help='Apply only after migrating RSSHub to the supplied Compose file')
    args = parser.parse_args()
    lock = None
    try:
        if args.apply:
            lock = os.open(str(args.env_file) + '.sync.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        session = json.loads(private_text(args.session, 256 * 1024))
        original = private_text(args.env_file)
        info = inspect_container(args.container)
        plan = plan_sync(session, original, environment(info))
        if args.apply:
            changed = apply_sync(args.env_file, original, plan, info, args.compose_file, args.container)
            print('RSSHub 凭据已通过容器重建加载' if changed else 'RSSHub 凭据一致，无需重建')
        else:
            print(json.dumps({'readOnly': True, 'diskChanged': plan['diskChanged'], 'needsRecreate': plan['needsRecreate'], 'cookieKeys': plan['cookieKeys']}, ensure_ascii=False))
    except Exception as error:
        print(str(error) if isinstance(error, SyncError) else '检查或同步未完成，原凭据未主动清除；请检查私有文件和 Docker 服务')
        return 1
    finally:
        if lock is not None:
            os.close(lock)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
