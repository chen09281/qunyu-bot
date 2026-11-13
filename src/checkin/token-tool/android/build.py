"""Build and sign a small native APK using an existing JDK 17+ and Android SDK 35.
No Gradle, external runtime dependencies, embedded signing keys or committed binaries.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent

def build(args):
    jdk = Path(args.jdk).resolve()
    sdk = Path(args.sdk).resolve()
    platform = sdk / 'platforms' / 'android-35' / 'android.jar'
    candidates = sorted(p for p in (sdk / 'build-tools').iterdir() if (p / 'aapt2').is_file() and (p / 'lib' / 'd8.jar').is_file())
    if not candidates or not platform.is_file(): raise RuntimeError('需要 Android 35 platform 和 build-tools 35.0.0+')
    tools = candidates[-1]
    java, javac, keytool = [jdk / 'bin' / name for name in ('java', 'javac', 'keytool')]
    if not all(p.is_file() for p in (java, javac, keytool)): raise RuntimeError('请指定 JDK 17+ 目录')
    signing = Path(args.signing_dir).resolve()
    signing.mkdir(parents=True, exist_ok=True, mode=0o700); signing.chmod(0o700)
    keystore, password_file = signing / 'release.p12', signing / 'password'
    if keystore.is_symlink() or password_file.is_symlink(): raise RuntimeError('签名文件不能为符号链接')
    if keystore.exists() != password_file.exists(): raise RuntimeError('签名文件不完整，请恢复原密钥；不会自动覆盖')
    env = os.environ.copy()
    if not keystore.exists():
        if not args.create_key: raise RuntimeError('首次构建请加 --create-key；请备份该目录以便后续更新 App')
        password = secrets.token_urlsafe(36)
        with password_file.open('x', encoding='utf-8') as out: out.write(password)
        password_file.chmod(0o600)
        env['KURO_SIGNING_PASSWORD'] = password
        try:
            subprocess.run([str(keytool), '-genkeypair', '-keystore', str(keystore), '-storetype', 'PKCS12', '-alias', 'kuro-token',
                '-storepass:env', 'KURO_SIGNING_PASSWORD', '-keypass:env', 'KURO_SIGNING_PASSWORD', '-keyalg', 'RSA', '-keysize', '3072',
                '-validity', '10000', '-dname', 'CN=QQ Bot Kuro Token Tool', '-noprompt'], env=env, check=True, capture_output=True)
        except Exception:
            password_file.unlink(missing_ok=True); raise RuntimeError('创建签名密钥失败') from None
    else:
        env['KURO_SIGNING_PASSWORD'] = password_file.read_text().strip()
    keystore.chmod(0o600); password_file.chmod(0o600)
    output = Path(args.output).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink(): raise RuntimeError('输出不能为符号链接')
    with tempfile.TemporaryDirectory(prefix='kuro-apk-') as directory:
        work = Path(directory); classes = work / 'classes'; dex = work / 'dex'; classes.mkdir(); dex.mkdir()
        sources = sorted(str(p) for p in (ROOT / 'java').rglob('*.java'))
        def run(command): subprocess.run([str(p) for p in command], env=env, check=True)
        run([javac, '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', platform, '-d', classes, *sources])
        run([java, '-cp', tools / 'lib' / 'd8.jar', 'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', platform,
             '--output', dex, *sorted(classes.rglob('*.class'))])
        unsigned, aligned, signed = [work / name for name in ('unsigned.apk', 'aligned.apk', 'signed.apk')]
        run([tools / 'aapt2', 'link', '-I', platform, '--manifest', ROOT / 'AndroidManifest.xml', '-o', unsigned])
        with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(dex.glob('*.dex')): archive.write(path, path.name)
        run([tools / 'zipalign', '-f', '4', unsigned, aligned])
        signer = [java, '-jar', tools / 'lib' / 'apksigner.jar']
        run(signer + ['sign', '--ks', keystore, '--ks-key-alias', 'kuro-token', '--ks-pass', 'env:KURO_SIGNING_PASSWORD',
             '--key-pass', 'env:KURO_SIGNING_PASSWORD', '--v4-signing-enabled', 'false', '--out', signed, aligned])
        verify = subprocess.check_output([str(p) for p in signer + ['verify', '--verbose', '--print-certs', signed]], env=env, text=True)
        if 'Verified using v2 scheme (APK Signature Scheme v2): true' not in verify: raise RuntimeError('APK 签名验证未通过')
        temporary = output.with_name(output.name + '.tmp')
        shutil.copyfile(signed, temporary); temporary.chmod(0o644); temporary.replace(output)
        metadata = {'version':'1.1.0', 'package':'local.qqbot.kuro', 'minAndroid':'8.0', 'bytes':output.stat().st_size,
            'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'certificateSha256':next(line.split(': ',1)[1] for line in verify.splitlines() if 'certificate SHA-256 digest:' in line)}
        output.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'apk':str(output), **metadata},ensure_ascii=False))
    return metadata

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jdk',required=True); parser.add_argument('--sdk',required=True)
    parser.add_argument('--output',required=True); parser.add_argument('--signing-dir',required=True)
    parser.add_argument('--create-key',action='store_true')
    build(parser.parse_args())
