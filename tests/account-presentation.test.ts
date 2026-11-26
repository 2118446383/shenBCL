import assert from 'node:assert/strict';
import test from 'node:test';
import { accountPresentation } from '../arcane-launcher/src/shared/account-presentation';
import type { AccountState } from '../arcane-launcher/src/shared/contracts';

const base: AccountState = { configured: false, clientId: '', profile: null, busy: false };
const profile = { id: 'a'.repeat(32), name: 'Player', model: 'default' as const };

test('signed-out state is unchanged by an app ID or imported preview', () => {
  for (const account of [base, { ...base, configured: true, clientId: 'public-id' }, { ...base, localSkin: 'data:image/png;base64,example' }]) {
    const result = accountPresentation(account);
    assert.equal(result.kind, 'signed-out');
    assert.equal(result.verified, false);
    assert.equal(result.label, '未登录');
  }
});

test('only a verified connected profile receives the正版 label', () => {
  const connected = accountPresentation({ ...base, configured: true, status: 'connected', profile });
  assert.equal(connected.kind, 'microsoft');
  assert.equal(connected.verified, true);
  assert.match(connected.label, /正版账号/);
  for (const status of ['signed-out', 'offline', 'refreshing', 'authorizing', 'reauthentication-required'] as const) {
    const result = accountPresentation({ ...base, status, profile });
    assert.equal(result.verified, false);
    assert.doesNotMatch(result.label, /正版/);
  }
  assert.equal(accountPresentation({ ...base, status: 'connected' }).verified, false);
});

test('cached and revoked accounts retain their distinction from a signed-out profile', () => {
  const cached = accountPresentation({ ...base, profile, status: 'offline' });
  assert.equal(cached.kind, 'microsoft');
  assert.match(cached.label, /缓存账号/);
  assert.match(cached.description, /重新验证账号和游戏所有权/);
  const revoked = accountPresentation({ ...base, profile, status: 'reauthentication-required' });
  assert.match(revoked.label, /登录已失效/);
  assert.match(revoked.description, /重新登录/);
});
