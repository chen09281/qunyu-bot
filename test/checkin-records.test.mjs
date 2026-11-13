import test from 'node:test';
import assert from 'node:assert/strict';
import {accountStatus,checkinRecordSummary,filterCheckinMembers,memberStatus} from '../frontend/src/utils/checkinRecords.js';
const account=(platform,status,extra={})=>({platform,name:platform==='kuro'?'库街区':'森空岛',needsLogin:false,last:status?{at:'2026-10-23T01:00:00Z',items:[{status,label:'鸣潮 · 玩家',playerName:'小团子',uid:'987654321'}]}:null,...extra});
test('最近签到状态区分成功、未执行、中断、暂停与需重新绑定，混合失败不会显示完成',()=>{
 assert.equal(accountStatus(account('kuro','already')).key,'success');
 assert.equal(accountStatus(account('kuro',null)).key,'pending');
 assert.equal(accountStatus(account('kuro','cancelled')).key,'pending');
 assert.equal(accountStatus(account('kuro',null,{last:{items:[]}})).key,'pending');
 assert.equal(accountStatus(account('kuro','success',{needsLogin:true})).key,'attention');
 for(const status of ['verification','missing','network','unknown'])assert.equal(accountStatus(account('kuro',status)).key,'attention');
 assert.equal(memberStatus([account('kuro','success'),account('skland','expired')]).key,'attention');
 assert.equal(memberStatus([]).label,'尚未绑定');
});
test('搜索匹配 QQ、群号、游戏昵称和旧记录编号，平台与状态在同一账号内组合，筛选不修改原始数据',()=>{
 const members=[{user:'10001',group:'60001',auto:true,accounts:[account('skland','network'),account('kuro','success')]},
 {user:'10002',group:'60002',auto:false,accounts:[account('kuro',null)]},
 {user:'10003',group:'60002',auto:true,accounts:[]}];
 const before=structuredClone(members);
 assert.deepEqual(checkinRecordSummary(members),{members:3,accounts:3,attention:1});
 for(const query of ['10001','60001','987654321','玩家','小团子'])assert.deepEqual(filterCheckinMembers(members,{query}).map(m=>m.user),['10001']);
 assert.equal(filterCheckinMembers(members,{platform:'kuro',status:'attention'}).length,0);
 assert.deepEqual(filterCheckinMembers(members,{platform:'skland',status:'attention'}).map(m=>m.user),['10001']);
 assert.deepEqual(filterCheckinMembers(members,{status:'paused'}).map(m=>m.user),['10002']);
 assert.deepEqual(filterCheckinMembers(members,{status:'unbound'}).map(m=>m.user),['10003']);
 assert.deepEqual(filterCheckinMembers(members,{platform:'kuro'}).map(m=>m.accounts.length),[1,1]);
 assert.deepEqual(members,before);
});
