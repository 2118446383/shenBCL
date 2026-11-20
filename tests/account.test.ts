import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountService, textureUrl, validateClientId, validateSkinPng, type StoredAccount } from '../arcane-launcher/src/main/services/account';
import type { AccountState } from '../arcane-launcher/src/shared/contracts';

const clientId = '11111111-2222-3333-4444-555555555555';
const profileId = 'a'.repeat(32);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const saved = (): StoredAccount => ({ clientId, xuid: '123456', accessToken: 'private-minecraft-token', refreshToken: 'private-refresh-token', expiresAt: Date.now() + 500_000, profile: { id: profileId, name: 'TestPlayer', model: 'default' } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(done: () => boolean) { for (let i = 0; i < 100; i++) { if (done()) return; await tick(); } throw new Error('Account task did not settle'); }

function fixture(options: { owned?: boolean; pending?: boolean; saveError?: boolean; expired?: boolean; maliciousTexture?: boolean } = {}) {
  const states: AccountState[] = [], records: Array<StoredAccount | null> = [], urls: string[] = [], sleeps: number[] = [];
  let polls = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    if (url.endsWith('/devicecode')) return response({ device_code: 'private-device-secret', user_code: 'ABCD-EFGH', expires_in: 900, interval: 1 });
    if (url.endsWith('/token')) {
      polls++;
      if (options.expired) return response({ error: 'invalid_grant', error_description: 'NEVER SHOW private-refresh-token' }, 400);
      if (options.pending && polls === 1) return response({ error: 'authorization_pending' }, 400);
      if (options.pending && polls === 2) return response({ error: 'slow_down' }, 400);
      return response({ access_token: 'private-microsoft-token', refresh_token: 'private-refreshed-token' });
    }
    if (url.includes('user.auth.xboxlive.com')) {
      assert.match(String(init?.body), /d=private-microsoft-token/);
      return response({ Token: 'private-xbox-token' });
    }
    if (url.includes('xsts.auth.xboxlive.com')) return response({ Token: 'private-xsts-token', DisplayClaims: { xui: [{ uhs: '1234567890123456', xid: '123456' }] } });
    if (url.endsWith('/authentication/login_with_xbox')) return response({ access_token: 'private-minecraft-token', expires_in: 86400 });
    if (url.endsWith('/entitlements/mcstore')) return response({ items: options.owned === false ? [] : [{ name: 'game_minecraft' }] });
    if (url.endsWith('/minecraft/profile')) return response({ id: profileId, name: 'TestPlayer', skins: [{ state: 'ACTIVE', variant: 'SLIM', url: options.maliciousTexture ? 'http://127.0.0.1/private' : undefined }], capes: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const service = new AccountService(clientId, null, { fetch: request, sleep: async ms => { sleeps.push(ms); await tick(); }, persist: async record => { if (options.saveError) throw new Error('Encrypted storage unavailable'); records.push(record); }, changed: state => states.push(structuredClone(state)) });
  return { service, request, states, records, urls, sleeps };
}

test('device login handles pending/backoff and never exposes secrets in public state', async () => {
  const f = fixture({ pending: true, maliciousTexture: true });
  const state = await f.service.begin();
  assert.equal(state.device?.code, 'ABCD-EFGH');
  assert.equal(state.device?.verificationUri, 'https://www.microsoft.com/link');
  await until(() => !f.service.state().busy);
  assert.equal(f.service.state().profile?.name, 'TestPlayer');
  assert.equal(f.service.state().profile?.model, 'slim');
  assert.equal(f.records.length, 1);
  assert.deepEqual(f.sleeps, [5000, 5000, 10000]);
  assert.doesNotMatch(JSON.stringify(f.states), /private-|accessToken|refreshToken|device_code/);
  assert.ok(!f.urls.some(url => url.includes('127.0.0.1')));
  const identity = await f.service.identity();
  assert.equal(identity?.accessToken, 'private-minecraft-token');
  assert.equal(identity?.xuid, '123456');
  assert.equal(identity?.clientId, clientId);
});

test('missing game ownership never installs an authenticated identity', async () => {
  const f = fixture({ owned: false });
  await f.service.begin(); await until(() => !f.service.state().busy);
  assert.equal(f.service.state().profile, null);
  assert.equal(f.records.length, 0);
  assert.match(f.service.state().notice!, /所有权/);
  assert.ok(!f.urls.some(url => url.endsWith('/minecraft/profile')));
});

test('cancelling authorization stops polling without persisting an account', async () => {
  let polls = 0, persisted = 0;
  const service = new AccountService(clientId, null, {
    fetch: async input => { if (String(input).endsWith('/token')) polls++; return response({ device_code: 'secret', user_code: 'CODE', expires_in: 900 }); },
    sleep: async (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    persist: async () => { persisted++; }, changed: () => {},
  });
  await service.begin(); service.cancel(); await tick();
  assert.equal(service.state().busy, false); assert.equal(service.state().device, undefined);
  assert.equal(polls, 0); assert.equal(persisted, 0);
});

test('encrypted storage failure does not claim a successful login', async () => {
  const f = fixture({ saveError: true });
  await f.service.begin(); await until(() => !f.service.state().busy);
  assert.equal(f.service.state().profile, null);
  assert.match(f.service.state().notice!, /Encrypted storage/);
});

test('expired credentials fail explicitly and never silently return an offline identity', async () => {
  const f = fixture({ expired: true });
  const record = saved(); record.expiresAt = 0;
  const service = new AccountService(clientId, record, { fetch: f.request, persist: async () => {}, changed: () => {} });
  await assert.rejects(service.identity(), /凭据已失效/);
  assert.equal(service.state().profile?.id, profileId);
  assert.doesNotMatch(service.state().notice!, /private-refresh-token/);
});

test('concurrent refresh requests share one token exchange and logout clears the record', async () => {
  const f = fixture(); const record = saved(); record.expiresAt = 0;
  const records: Array<StoredAccount | null> = [];
  const service = new AccountService(clientId, record, { fetch: f.request, persist: async r => { records.push(r); }, changed: () => {} });
  const [first, second] = await Promise.all([service.identity(), service.identity()]);
  assert.deepEqual(first, second);
  assert.equal(f.urls.filter(url => url.endsWith('/token')).length, 1);
  await service.logout();
  assert.equal(records.at(-1), null); assert.equal(service.state().profile, null);
  assert.equal(await service.identity(), undefined);
});

test('unconfigured or invalid application IDs cannot begin login', async () => {
  let requests = 0;
  const service = new AccountService('', null, { fetch: async () => { requests++; return response({}); }, persist: async () => {}, changed: () => {} });
  await assert.rejects(service.begin(), /应用接入尚未完成/);
  assert.equal(requests, 0);
  assert.throws(() => validateClientId('https://untrusted.example'), /Client ID/);
  assert.equal(validateClientId(` ${clientId} `), clientId);
  assert.equal(service.state().status, 'signed-out');
  const invalid = new AccountService('not-a-client-id', saved(), { persist: async () => {}, changed: () => {} });
  assert.equal(invalid.state().configured, false);
  assert.equal(invalid.state().profile, null);
});

test('an active account cannot be reused with a different client ID', async () => {
  const service = new AccountService(clientId, saved(), { persist: async () => {}, changed: () => {} });
  await assert.rejects(service.configure('22222222-3333-4444-5555-666666666666'), /退出当前账号/);
  const other = new AccountService('22222222-3333-4444-5555-666666666666', saved(), { persist: async () => {}, changed: () => {} });
  assert.equal(other.state().profile, null);
});

test('skin downloads only accept bounded official texture URLs and valid dimensions', () => {
  assert.equal(textureUrl('https://textures.minecraft.net/texture/' + 'a'.repeat(64)), 'https://textures.minecraft.net/texture/' + 'a'.repeat(64));
  for (const url of ['file:///private.png', 'https://textures.minecraft.net.evil.test/texture/' + 'a'.repeat(64), 'https://textures.minecraft.net/texture/../../private', 'https://user@textures.minecraft.net/texture/' + 'a'.repeat(64)]) assert.equal(textureUrl(url), undefined);
  assert.throws(() => validateSkinPng(Buffer.from('not an image')), /PNG/);
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(64,16); png.writeUInt32BE(64,20);
  assert.doesNotThrow(() => validateSkinPng(png));
  png.writeUInt32BE(8000,16); assert.throws(() => validateSkinPng(png), /尺寸/);
});

test('a restarted account exposes cached appearance until an online restore verifies the identity', async () => {
  const f = fixture();
  const diskRecord = JSON.parse(JSON.stringify(saved()));
  const persisted: Array<StoredAccount | null> = [];
  const service = new AccountService(clientId, diskRecord, { fetch: f.request, persist: async record => { persisted.push(record); }, changed: () => {} });
  assert.equal(service.state().profile?.id, profileId);
  assert.equal(service.state().status, 'offline');
  assert.match(service.state().notice!, /缓存/);
  const restoring = service.restore();
  assert.equal(service.state().status, 'refreshing');
  const restored = await restoring;
  assert.equal(restored.status, 'connected');
  assert.equal(restored.busy, false);
  assert.equal(restored.stage, undefined);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.refreshToken, 'private-refreshed-token');
  assert.ok(f.urls.some(url => url.endsWith('/minecraft/profile')));
  assert.doesNotMatch(JSON.stringify(restored), /private-|accessToken|refreshToken/);
  await service.identity();
  assert.equal(f.urls.filter(url => url.endsWith('/token')).length, 1, 'validated fresh token should be reused');
});

test('restore distinguishes an unreachable service from revoked credentials and permits retry', async () => {
  const f = fixture();
  let online = false;
  const service = new AccountService(clientId, saved(), {
    fetch: async (...args) => { if (!online) throw new Error('private-refresh-token must not be shown'); return f.request(...args); },
    persist: async () => {}, changed: () => {},
  });
  const offline = await service.restore();
  assert.equal(offline.status, 'offline');
  assert.equal(offline.busy, false);
  assert.equal(offline.profile?.id, profileId);
  assert.match(offline.notice!, /网络/);
  assert.doesNotMatch(offline.notice!, /private-/);
  await assert.rejects(service.identity(), /网络/);
  online = true;
  assert.equal((await service.restore()).status, 'connected');

  const revoked = fixture({ expired: true });
  const other = new AccountService(clientId, saved(), { fetch: revoked.request, persist: async () => {}, changed: () => {} });
  assert.equal((await other.restore()).status, 'reauthentication-required');
  assert.equal(other.state().profile?.id, profileId, 'cached appearance remains available for the account dialog');
  const calls = revoked.urls.length;
  await assert.rejects(other.identity(), /重新连接/);
  assert.equal(revoked.urls.length, calls, 'do not repeatedly submit a known revoked credential');
});

test('failed skin sync retains only the same player cached appearance with a clear notice', async () => {
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(64,16); png.writeUInt32BE(64,20);
  const cachedSkin = `data:image/png;base64,${png.toString('base64')}`;
  const f = fixture({ maliciousTexture: true });
  const record = saved(); record.profile.skinDataUrl = cachedSkin;
  const service = new AccountService(clientId, record, { fetch: f.request, persist: async () => {}, changed: () => {} });
  const restored = await service.restore();
  assert.equal(restored.status, 'connected');
  assert.equal(restored.profile?.skinDataUrl, cachedSkin);
  assert.equal(restored.profile?.model, 'default', 'cached texture keeps its own arm geometry');
  assert.match(restored.notice!, /皮肤下载失败.*上次缓存/);
  assert.ok(!f.urls.some(url => url.includes('127.0.0.1')));
});

test('corrupt saved records cannot produce a connected identity', async () => {
  for (const record of [
    { ...saved(), refreshToken: '' },
    { ...saved(), expiresAt: Number.NaN },
    { ...saved(), profile: { id: '../../private', name: 'Wrong', model: 'default' } },
  ]) {
    const service = new AccountService(clientId, record as StoredAccount, { fetch: async () => { throw new Error('must not request'); }, persist: async () => {}, changed: () => {} });
    assert.equal(service.state().status, 'signed-out');
    assert.equal(service.state().profile, null);
    assert.equal(await service.identity(), undefined);
    assert.equal((await service.restore()).status, 'signed-out');
  }
});

test('logout holds the account operation until encrypted deletion completes', async () => {
  let release!: () => void;
  const writing = new Promise<void>(resolve => { release = resolve; });
  const service = new AccountService(clientId, saved(), { persist: async () => writing, changed: () => {} });
  const loggingOut = service.logout();
  assert.equal(service.state().busy, true);
  await assert.rejects(service.begin(), /账号任务/);
  await assert.rejects(service.configure(clientId), /等待刷新/);
  release();
  const result = await loggingOut;
  assert.equal(result.status, 'signed-out');
  assert.equal(result.busy, false);
  assert.equal(result.profile, null);
});

test('a cancelled exchange cannot overwrite a later successful login', async () => {
  const f = fixture();
  let release!: () => void;
  let blocked = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let persists = 0;
  const service = new AccountService(clientId, null, {
    fetch: async (input, init) => {
      if (String(input).includes('user.auth.xboxlive.com') && !blocked) { blocked = true; await waiting; }
      return f.request(input, init);
    },
    sleep: async () => tick(), persist: async () => { persists++; }, changed: () => {},
  });
  await service.begin();
  await until(() => blocked);
  service.cancel();
  await service.begin();
  await until(() => !service.state().busy);
  assert.equal(service.state().status, 'connected');
  release();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(persists, 1);
  assert.equal(service.state().status, 'connected');
  assert.equal(service.state().stage, undefined);
});

test('verified identity expiration notifies the renderer and requires online validation again', { timeout: 3000 }, async () => {
  const f = fixture();
  const updates: AccountState[] = [];
  let exchanges = 0;
  const service = new AccountService(clientId, saved(), {
    fetch: async (input, init) => {
      if (String(input).endsWith('/authentication/login_with_xbox')) {
        exchanges++;
        return response({ access_token: 'private-short-lived-token', expires_in: 0.08 });
      }
      return f.request(input, init);
    },
    persist: async () => {}, changed: value => updates.push(value),
  });
  await service.restore();
  assert.equal(service.state().status, 'connected');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(service.state().status, 'offline');
  assert.equal(updates.at(-1)?.status, 'offline');
  assert.match(service.state().notice!, /到期/);
  assert.equal(service.state().profile?.id, profileId);
  await service.identity();
  assert.equal(exchanges, 2, 'expiration must not reuse stale online identity or fall back to an offline identity');
  await service.logout();
  assert.equal(service.state().status, 'signed-out');
});

test('pending initial Microsoft login cannot silently launch as an offline identity', async () => {
  const service = new AccountService(clientId, null, {
    fetch: async () => response({ device_code: 'pending-secret', user_code: 'CODE', expires_in: 900 }),
    sleep: async (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    persist: async () => {}, changed: () => {},
  });
  await service.begin();
  await assert.rejects(service.identity(), /完成或取消当前账号操作/);
  service.cancel();
  assert.equal(await service.identity(), undefined, 'explicitly cancelling login restores the visible offline mode');
});

test('oversized authorization responses fail before exposing data or starting token polling', async () => {
  for (const declared of [true, false]) {
    let requests = 0;
    const service = new AccountService(clientId, null, {
      fetch: async () => { requests++; return new Response(' '.repeat(1024 * 1024 + 1), { headers: declared ? { 'Content-Length': String(1024 * 1024 + 1) } : {} }); },
      persist: async () => assert.fail('invalid responses must not persist credentials'), changed: () => {},
    });
    await assert.rejects(service.begin(), /超过允许大小/);
    assert.equal(requests, 1);
    assert.equal(service.state().busy, false);
    assert.equal(service.state().device, undefined);
    assert.equal(service.state().profile, null);
  }
});

test('Minecraft API rejection describes application approval for JSON and plain responses', async () => {
  for (const plain of [false, true]) {
    const f = fixture();
    const updates: AccountState[] = [];
    const service = new AccountService(clientId, null, {
      fetch: async (input, init) => String(input).endsWith('/authentication/login_with_xbox')
        ? plain ? new Response('Forbidden', { status: 403 }) : response({ error: 'access_denied', error_description: 'private-server-secret' }, 403)
        : f.request(input, init),
      sleep: async () => tick(), persist: async () => assert.fail('rejected application must not acquire a game identity'), changed: state => updates.push(state),
    });
    await service.begin(); await until(() => !service.state().busy);
    assert.equal(service.state().profile, null);
    assert.match(service.state().notice!, /Minecraft.*审批/);
    assert.doesNotMatch(service.state().notice!, /你已取消/);
    assert.doesNotMatch(JSON.stringify(updates), /private-/);
    assert.ok(!f.urls.some(url => url.endsWith('/entitlements/mcstore')));
  }
});

test('malformed Xbox claims and Microsoft tokens cannot cross into a later authentication stage', async () => {
  for (const malformed of ['token', 'hash', 'expiry'] as const) {
    const f = fixture();
    const service = new AccountService(clientId, null, {
      fetch: async (input, init) => {
        const url = String(input);
        if (malformed === 'token' && url.endsWith('/token')) return response({ access_token: 'private-token\r\n', refresh_token: 'private-refresh-token' });
        if (malformed === 'hash' && url.includes('xsts.auth.xboxlive.com')) return response({ Token: 'private-xsts-token', DisplayClaims: { xui: [{ uhs: 'invalid;claim', xid: '123456' }] } });
        if (malformed === 'expiry' && url.endsWith('/authentication/login_with_xbox')) return response({ access_token: 'private-minecraft-token', expires_in: 1e30 });
        return f.request(input, init);
      },
      sleep: async () => tick(), persist: async () => assert.fail('malformed credentials must not be stored'), changed: () => {},
    });
    await service.begin(); await until(() => !service.state().busy);
    assert.equal(service.state().profile, null);
    assert.doesNotMatch(service.state().notice!, /private-/);
    assert.ok(!f.urls.some(url => url.endsWith('/entitlements/mcstore')));
    if (malformed === 'token') assert.ok(!f.urls.some(url => url.includes('user.auth.xboxlive.com')));
    if (malformed === 'hash') assert.ok(!f.urls.some(url => url.endsWith('/authentication/login_with_xbox')));
  }
});

test('device deadline prevents a token request after a pending polling delay', async () => {
  const realNow = Date.now;
  let clock = realNow(), polls = 0;
  Date.now = () => clock;
  const service = new AccountService(clientId, null, {
    fetch: async input => { if (String(input).endsWith('/token')) polls++; return response({ device_code: 'private-device', user_code: 'CODE', expires_in: 1, interval: 5 }); },
    sleep: async milliseconds => { clock += milliseconds; }, persist: async () => assert.fail('expired flow must not persist'), changed: () => {},
  });
  try {
    await service.begin(); await until(() => !service.state().busy);
    assert.equal(polls, 0);
    assert.match(service.state().notice!, /过期/);
    assert.equal(service.state().device, undefined);
  } finally { Date.now = realNow; }
});

test('public device-code snapshots cannot mutate the active authorization', async () => {
  const service = new AccountService(clientId, null, {
    fetch: async () => response({ device_code: 'private-device', user_code: 'CODE', expires_in: 900 }),
    sleep: async (_milliseconds, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    persist: async () => assert.fail('cancelled flow must not persist'), changed: () => {},
  });
  const snapshot = await service.begin();
  snapshot.device!.code = 'CHANGED'; snapshot.device!.expiresAt = 0;
  assert.equal(service.state().device?.code, 'CODE');
  assert.ok(service.state().device!.expiresAt > Date.now());
  service.cancel(); await tick();
});
