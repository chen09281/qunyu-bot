import test from 'node:test';
import assert from 'node:assert/strict';
import {groupSubscriptions,removeGroupRequest} from '../frontend/src/utils/subscriptionGroups.js';

test('按群归类共用来源，保留空的授权群和已取消授权的目标，不修改订阅',()=>{
 const entries=[{id:'one',name:'博主甲',source:'123',groups:['10002','10001','10001']},
 {id:'two',name:'博主乙',source:'456',groups:['10001','10004']}];
 const original=structuredClone(entries);
 const result=groupSubscriptions(entries,[{id:'10001'},'10002','10003','10002']);
 assert.deepEqual(result.map(g=>[g.id,g.authorized,g.entries.map(e=>e.id)]),[
  ['10001',true,['one','two']],['10002',true,['one']],['10003',true,[]],['10004',false,['two']],
 ]);
 assert.deepEqual(entries,original);
});

test('群筛选与博主昵称、主页 ID 搜索组合，群号搜索显示该群全部订阅',()=>{
 const entries=[{id:'one',name:'手动备注',lastTitle:'阿明的 B 站投稿',source:'12345',groups:['10001','10002']},
 {id:'two',name:'GitHub',source:'OWNER/repo',groups:['10001']}];
 assert.deepEqual(groupSubscriptions(entries,['10001','10002'],{query:'阿明',group:'10002'}).map(g=>g.entries.map(e=>e.id)),[['one']]);
 assert.equal(groupSubscriptions(entries,['10001'],{query:'owner'}).flatMap(g=>g.entries).length,1);
 assert.equal(groupSubscriptions(entries,['10001'],{query:'10001'})[0].entries.length,2);
 assert.equal(groupSubscriptions(entries,['10001'],{query:'不存在'}).length,0);
 assert.equal(groupSubscriptions(entries,['10001','10003'],{query:'10003'})[0].entries.length,0);
});

test('取消本群仅移除该群，保留其他群；最后一个目标才删除来源',()=>{
 const entry={id:'one',groups:['10001','10002']};
 assert.deepEqual(removeGroupRequest(entry,'10001'),{path:'subscriptions/one',method:'PUT',body:{groups:['10002']}});
 assert.deepEqual(removeGroupRequest({id:'one',groups:['10001']},'10001'),{path:'subscriptions/one/remove',method:'POST',body:{}});
 assert.equal(removeGroupRequest(entry,'99999'),null);assert.deepEqual(entry.groups,['10001','10002']);
});
