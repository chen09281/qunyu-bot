import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location('rsshub_sync', Path(__file__).resolve().parents[1] / 'scripts/rsshub-cookie-sync.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
NOW = 1793102400


def session(**patch):
    def row(key, value, prefix=''):
        return prefix + '.bilibili.com\tTRUE\t/\tTRUE\t0\t' + key + '\t' + value
    return {'state': 'refreshed', 'lastCheckedAt': NOW * 1000,
            'cookieContent': '\n'.join([row('SESSDATA','SYNTHETIC_SESSION=ENCODED','#HttpOnly_'),row('bili_jct','SYNTHETIC_CSRF'),row('DedeUserID','12345')]), **patch}


def info(values=None, managed=True):
    return {'Config': {'Env': [key + '=' + value for key, value in (values or {}).items()], 'Labels': {
        'com.docker.compose.project': 'qqbot-rsshub', 'com.docker.compose.service': 'rsshub'} if managed else {}}, 'State': {'Running': True}}


class CookieSyncTests(unittest.TestCase):
    def test_same_session_with_changed_csrf_is_not_silently_skipped(self):
        data = session()
        old = 'BILIBILI_COOKIE_12345=SESSDATA=SYNTHETIC_SESSION=ENCODED; bili_jct=OLD_CSRF; DedeUserID=12345\nDOUYIN_COOKIE=SYNTHETIC_DY\nCACHE_EXPIRE=600\n'
        plan = sync.plan_sync(data, old, sync.parse_env(old), NOW)
        self.assertTrue(plan['diskChanged'])
        self.assertTrue(plan['needsRecreate'])
        self.assertEqual(sync.parse_env(plan['content'])['DOUYIN_COOKIE'],'SYNTHETIC_DY')
        self.assertIn('bili_jct=SYNTHETIC_CSRF',plan['content'])

    def test_disk_already_updated_but_running_container_still_stale(self):
        plan = sync.plan_sync(session(), '', {}, NOW)
        stale = {'BILIBILI_COOKIE_12345':'SESSDATA=STALE'}
        again = sync.plan_sync(session(), plan['content'], stale, NOW)
        self.assertFalse(again['diskChanged'])
        self.assertTrue(again['needsRecreate'])
        consistent = sync.plan_sync(session(), plan['content'], sync.parse_env(plan['content']), NOW)
        self.assertFalse(consistent['diskChanged'])
        self.assertFalse(consistent['needsRecreate'])

    def test_one_login_pool_does_not_need_a_hardcoded_creator_uid_list(self):
        old = 'BILIBILI_COOKIE_99999=SESSDATA=old; DedeUserID=12345\nBILIBILI_COOKIE_88888=SESSDATA=old; DedeUserID=12345\n'
        plan = sync.plan_sync(session(), old, {}, NOW)
        self.assertEqual(plan['cookieKeys'], ['BILIBILI_COOKIE_12345'])
        self.assertEqual(len(sync.parse_env(plan['content'])),1)

    def test_invalid_expired_unchecked_and_stale_login_never_replace_credentials(self):
        for patch in [{'state':'expired'}, {'state':'error'}, {'state':'imported'}, {'state':'confirm_pending'},
                      {'lastCheckedAt':(NOW-86401)*1000}, {'lastCheckedAt':(NOW+10)*1000},
                      {'lastCheckedAt':None}, {'cookieContent':session()['cookieContent'].replace('\t0\t','\t1\t')}]:
            with self.subTest(patch=patch), self.assertRaises(sync.SyncError):
                sync.plan_sync(session(**patch), 'DOUYIN_COOKIE=old\n', {}, NOW)

    def test_fingerprints_not_shared_when_switching_login_account(self):
        old = {'BILIBILI_COOKIE_54321':'DedeUserID=54321; buvid3=OTHER_DEVICE'}
        expected = sync.verified_cookie(session(), old, NOW)
        self.assertNotIn('OTHER_DEVICE', json.dumps(expected))
        old = {'BILIBILI_COOKIE_12345':'DedeUserID=12345; buvid3=SAME_DEVICE'}
        self.assertIn('SAME_DEVICE', json.dumps(sync.verified_cookie(session(),old,NOW)))

    def test_environment_private_reads_and_atomic_updates_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'rsshub.env'
            sync.atomic_write(path,'DOUYIN_COOKIE=SYNTHETIC\n')
            self.assertEqual(os.stat(path).st_mode&0o777,0o600)
            self.assertEqual(sync.private_text(path),'DOUYIN_COOKIE=SYNTHETIC\n')
            link = Path(folder)/'link';link.symlink_to(path)
            with self.assertRaises(OSError):sync.private_text(link)
            with self.assertRaises(sync.SyncError):sync.atomic_write(link,'overwritten')
            self.assertNotIn('overwritten',path.read_text())

    def test_nonmanaged_container_requires_migration_before_any_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'rsshub.env';sync.atomic_write(path,'DOUYIN_COOKIE=old\n')
            plan = sync.plan_sync(session(),path.read_text(),{},NOW)
            with self.assertRaises(sync.SyncError):sync.apply_sync(path,path.read_text(),plan,info(managed=False),Path('/test/compose.yaml'),run=lambda *a,**k: self.fail('must not run Docker'))
            self.assertEqual(path.read_text(),'DOUYIN_COOKIE=old\n')

    def test_apply_recreates_container_and_verifies_loaded_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'rsshub.env';original='DOUYIN_COOKIE=old\n';sync.atomic_write(path,original)
            plan=sync.plan_sync(session(),original,{},NOW);calls=[]
            def run(command,**options):
                calls.append(command)
                if command[1]=='inspect':return types.SimpleNamespace(stdout=json.dumps([info(sync.parse_env(path.read_text()))]))
                self.assertIn('--force-recreate',command)
                self.assertEqual(options['env']['RSSHUB_ENV_FILE'],str(path))
                self.assertNotIn('SYNTHETIC',json.dumps(command))
                return types.SimpleNamespace(returncode=0)
            self.assertTrue(sync.apply_sync(path,original,plan,info(),Path('/test/compose.yaml'),run=run))
            self.assertEqual(len(calls),2)

    def test_failed_verification_restores_original_file_and_reports_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'rsshub.env';original='DOUYIN_COOKIE=old\n';sync.atomic_write(path,original)
            plan=sync.plan_sync(session(),original,{},NOW);calls=[]
            def run(command,**options):
                calls.append(command)
                if command[1]=='inspect':return types.SimpleNamespace(stdout=json.dumps([info({'BILIBILI_COOKIE_12345':'STALE'})]))
                return types.SimpleNamespace(returncode=0)
            with self.assertRaisesRegex(sync.SyncError,'已恢复原环境文件'):
                sync.apply_sync(path,original,plan,info(),Path('/test/compose.yaml'),run=run)
            self.assertEqual(path.read_text(),original)
            self.assertEqual(sum(command[1]=='compose' for command in calls),2)

    def test_failed_recreate_and_failed_rollback_are_reported_without_secret_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'rsshub.env';original='DOUYIN_COOKIE=old\n';sync.atomic_write(path,original)
            plan=sync.plan_sync(session(),original,{},NOW)
            def run(command,**options):raise subprocess.CalledProcessError(1,command,stderr='PRIVATE_COOKIE')
            with self.assertRaisesRegex(sync.SyncError,'回滚未确认') as failure:
                sync.apply_sync(path,original,plan,info(),Path('/test/compose.yaml'),run=run)
            self.assertNotIn('PRIVATE_COOKIE',str(failure.exception))
            self.assertEqual(path.read_text(),original)


if __name__ == '__main__':
    unittest.main()
