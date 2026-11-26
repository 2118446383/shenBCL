import type { AccountState } from './contracts';

export interface AccountPresentation {
  kind: 'microsoft' | 'signed-out';
  verified: boolean;
  label: string;
  description: string;
}

/** Only an online-verified Minecraft identity can carry the正版 label. */
export function accountPresentation(account: AccountState): AccountPresentation {
  const verified = account.status === 'connected' && !!account.profile;
  if (verified) return {
    kind: 'microsoft', verified: true, label: '正版账号 · 已登录',
    description: '已验证 Minecraft Java 版所有权与角色资料，使用正版身份启动游戏。',
  };
  if (account.status === 'refreshing') return {
    kind: account.profile ? 'microsoft' : 'signed-out', verified: false, label: 'Microsoft · 正在验证',
    description: '正在恢复 Microsoft 登录并验证 Minecraft 角色，完成后可使用正版身份。',
  };
  if (account.status === 'authorizing') return {
    kind: account.profile ? 'microsoft' : 'signed-out', verified: false, label: '正在登录 Microsoft',
    description: '等待 Microsoft 授权与游戏所有权验证，尚未建立新的正版登录。',
  };
  if (account.profile && account.status === 'reauthentication-required') return {
    kind: 'microsoft', verified: false, label: 'Microsoft · 登录已失效',
    description: '当前保留缓存角色，授权已失效。重新登录后才能使用此正版身份。',
  };
  if (account.profile) return {
    kind: 'microsoft', verified: false, label: '缓存账号 · 未在线验证',
    description: '当前显示缓存角色。启动前会重新验证账号和游戏所有权。',
  };
  return {
    kind: 'signed-out', verified: false, label: '未登录',
    description: '请连接拥有 Minecraft Java 版的 Microsoft 账号。',
  };
}
