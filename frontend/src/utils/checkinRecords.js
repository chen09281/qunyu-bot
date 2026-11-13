export const checkinPlatforms = { skland: '森空岛', miyoushe: '米游社', kuro: '库街区' };
export const checkinResultLabels = { success: '成功', already: '已签到', expired: '登录失效', verification: '需官方验证', device: '设备标识获取失败', network: '网络失败', failed: '接口异常', empty: '无游戏角色', missing: '缺少 stoken，未签到社区', first: '需首次手动签到', cancelled: '已暂停' };

export function accountStatus(account) {
  if (account.needsLogin) return { key: 'attention', label: '需重新绑定' };
  if (!account.last) return { key: 'pending', label: '尚未执行' };
  const items = account.last.items || [];
  if (!items.length) return { key: 'pending', label: '暂无完成结果' };
  if (items.every(item => ['success', 'already'].includes(item.status))) return { key: 'success', label: '签到完成' };
  if (items.every(item => item.status === 'cancelled')) return { key: 'pending', label: '任务已暂停' };
  return { key: 'attention', label: '需要处理' };
}

export function memberStatus(accounts) {
  if (!accounts.length) return { key: 'pending', label: '尚未绑定' };
  const states = accounts.map(accountStatus);
  return states.find(state => state.key === 'attention') || states.find(state => state.key === 'pending') || { key: 'success', label: '签到完成' };
}

export function checkinRecordSummary(members = []) {
  const accounts = members.flatMap(member => member.accounts || []);
  return { members: members.length, accounts: accounts.length, attention: accounts.filter(account => accountStatus(account).key === 'attention').length };
}

export function latestCheckin(accounts) {
  return accounts.reduce((latest, account) => {
    const time = Date.parse(account.last?.at || '');
    return Number.isFinite(time) && time > latest ? time : latest;
  }, 0);
}

export function filterCheckinMembers(members, { query = '', platform = '', status = '' } = {}) {
  const search = query.trim().toLowerCase();
  return members.map(member => ({ ...member, accounts: (member.accounts || []).filter(account => !platform || account.platform === platform) }))
    .filter(member => {
      if (platform && !member.accounts.length) return false;
      if (status === 'unbound' && member.accounts.length) return false;
      if (status === 'paused' && member.auto !== false) return false;
      if (['attention', 'success', 'pending'].includes(status) && !member.accounts.some(account => accountStatus(account).key === status)) return false;
      if (!search) return true;
      const content = [member.user, member.group, ...member.accounts.flatMap(account => [account.name, checkinPlatforms[account.platform], ...(account.last?.items || []).flatMap(item => [item.label, item.playerName, item.uid])])];
      return content.some(value => String(value || '').toLowerCase().includes(search));
    }).sort((a, b) => Number(memberStatus(b.accounts).key === 'attention') - Number(memberStatus(a.accounts).key === 'attention')
      || latestCheckin(b.accounts) - latestCheckin(a.accounts) || a.user.localeCompare(b.user, 'en', { numeric: true }));
}
