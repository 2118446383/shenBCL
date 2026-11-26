import { setTimeout as delay } from 'node:timers/promises';
import type { AccountState, PlayerProfile } from '../../shared/contracts';
import { MICROSOFT_APPLICATION } from '../../shared/microsoft-app';

const MS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MC = 'https://api.minecraftservices.com';
const scope = 'XboxLive.signin offline_access';
const MAX_AUTH_JSON_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 32_768;
export interface GameIdentity { id: string; name: string; accessToken: string; clientId: string; xuid: string }
const issuedIdentities = new WeakMap<GameIdentity, () => boolean>();

export function assertGameIdentity(identity: GameIdentity | undefined): asserts identity is GameIdentity {
  if (!identity || identity.clientId !== MICROSOFT_APPLICATION.clientId || !issuedIdentities.get(identity)?.()) {
    throw new Error('启动前请登录拥有 Minecraft Java 版的 Microsoft 账号，并完成在线验证。');
  }
}
export interface StoredAccount {
  clientId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  profile: PlayerProfile;
  xuid: string;
}
export interface AccountDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  persist: (account: StoredAccount | null) => Promise<void>;
  changed: (state: AccountState) => void;
}

type ConnectionStatus = 'signed-out' | 'connected' | 'offline' | 'reauthentication-required';
type AccountStatus = ConnectionStatus | 'authorizing' | 'refreshing';
interface PublicAccountState extends AccountState { status: AccountStatus; stage?: string }
type AccountError = Error & { code?: string; reauthenticate?: boolean };

function accountError(message: string, code: string, reauthenticate = false): AccountError {
  return Object.assign(new Error(message), { code, reauthenticate });
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\r\n\x00]/.test(value);
}

async function serviceJson(response: Response, signal: AbortSignal): Promise<Record<string, any>> {
  if (Number(response.headers.get('content-length')) > MAX_AUTH_JSON_BYTES) {
    await response.body?.cancel();
    throw accountError('账号服务响应超过允许大小，请稍后重试。', 'INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_AUTH_JSON_BYTES) throw accountError('账号服务响应超过允许大小，请稍后重试。', 'INVALID_RESPONSE');
      chunks.push(next.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch {
      if (!response.ok) return {};
      throw accountError('账号服务返回了无效响应，请稍后重试。', 'INVALID_RESPONSE');
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted || (error as AccountError).code === 'INVALID_RESPONSE') throw error;
    throw accountError('账号服务返回了无效响应，请稍后重试。', 'INVALID_RESPONSE');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function cachedTexture(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_400_000 || !/^data:image\/png;base64,[A-Za-z\d+/]*={0,2}$/.test(value)) return;
  try { validateSkinPng(Buffer.from(value.slice('data:image/png;base64,'.length), 'base64')); return value; } catch { return; }
}

/** An encrypted file may still be corrupt or belong to an older application configuration. */
function restoredRecord(value: unknown, clientId: string): StoredAccount | null {
  const record = value as Partial<StoredAccount> | null;
  if (!record || !clientId || typeof record.clientId !== 'string' || record.clientId.toLowerCase() !== clientId.toLowerCase()
    || typeof record.refreshToken !== 'string' || !record.refreshToken || record.refreshToken.length > 32_768
    || typeof record.accessToken !== 'string' || !record.accessToken || record.accessToken.length > 32_768
    || !Number.isFinite(record.expiresAt) || record.expiresAt! < 0
    || typeof record.xuid !== 'string' || !/^\d{0,32}$/.test(record.xuid)
    || !/^[a-f\d]{32}$/i.test(record.profile?.id ?? '') || !/^[A-Za-z\d_]{3,16}$/.test(record.profile?.name ?? '')) return null;
  return {
    clientId, refreshToken: record.refreshToken, accessToken: record.accessToken, expiresAt: record.expiresAt!, xuid: record.xuid,
    profile: {
      id: record.profile!.id, name: record.profile!.name, model: record.profile!.model === 'slim' ? 'slim' : 'default',
      skinDataUrl: cachedTexture(record.profile!.skinDataUrl), capeDataUrl: cachedTexture(record.profile!.capeDataUrl),
    },
  };
}

export function validateClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.trim())) {
    throw new Error('请填写 shenBCL 在 Microsoft 注册的应用 Client ID（GUID）。');
  }
  return value.trim().toLowerCase();
}

export function validateSkinPng(bytes: Buffer): void {
  if (bytes.length < 33 || bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('请选择有效的 PNG 皮肤文件，大小不超过 1 MB。');
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (![64, 128, 256, 512, 1024].includes(w) || (h !== w && h !== w / 2)) throw new Error('皮肤尺寸应为 64×64、64×32，或它们的整数倍。');
}

export function textureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || url.port || url.username || url.password || !/^\/texture\/[a-f\d]{32,64}$/i.test(url.pathname) || url.search || url.hash) return;
    // Official profile metadata can still contain a legacy HTTP texture URL.
    url.protocol = 'https:';
    return url.href;
  } catch { /* Invalid service response. */ }
}

/** Tokens never cross IPC. The storage adapter encrypts this entire record using Electron safeStorage. */
export class AccountService {
  private record: StoredAccount | null;
  private readonly clientId: string;
  private controller?: AbortController;
  private refreshJob?: Promise<GameIdentity>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private committing = false;
  private connection: ConnectionStatus = 'signed-out';
  private operation?: 'authorizing' | 'refreshing';
  private stage?: string;
  private notice = '';
  private device?: AccountState['device'];
  private localSkin?: string;
  private request: typeof fetch;
  private sleep: NonNullable<AccountDependencies['sleep']>;
  constructor(clientId: string, saved: StoredAccount | null, private deps: AccountDependencies) {
    try { this.clientId = validateClientId(clientId); } catch { this.clientId = ''; }
    this.record = restoredRecord(saved, this.clientId);
    if (this.record) {
      this.connection = 'offline';
      this.notice = '已读取缓存角色，登录状态尚未在线验证。';
    }
    this.request = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }
  state(): PublicAccountState {
    const expired = this.connection === 'connected' && !!this.record && this.record.expiresAt <= Date.now();
    return { configured: !!this.clientId, clientId: this.clientId, profile: this.record ? { ...this.record.profile, capeDataUrl: this.connection === 'connected' && !expired && !this.operation ? this.record.profile.capeDataUrl : undefined } : null, status: this.operation ?? (expired ? 'offline' : this.connection), stage: this.stage, busy: this.busy, notice: expired ? '登录验证已到期，启动前会重新验证正版身份。' : this.notice || undefined, device: this.device ? { ...this.device } : undefined, localSkin: this.localSkin };
  }
  private clearExpiry() { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
  private scheduleExpiry() {
    this.clearExpiry();
    if (!this.record || this.connection !== 'connected') return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.record || this.connection !== 'connected') return;
      if (this.record.expiresAt > Date.now()) return this.scheduleExpiry();
      this.connection = 'offline';
      this.notice = '登录验证已到期，启动前会重新验证正版身份。';
      this.emit();
    }, Math.min(2_147_483_647, Math.max(1, this.record.expiresAt - Date.now())));
    this.expiryTimer.unref();
  }
  private emit() { try { this.deps.changed(this.state()); } catch { /* A closed window must not interrupt account storage. */ } }
  private progress(stage: string, signal: AbortSignal) { if (!signal.aborted) { this.stage = stage; this.emit(); } }
  setLocalSkin(data: string) { this.localSkin = data; this.emit(); return this.state(); }
  cancel() {
    if (this.refreshJob || this.committing) throw new Error('正在保存或刷新账号，请稍后再试。');
    this.controller?.abort();
    this.controller = undefined;
    this.busy = false;
    this.operation = undefined;
    this.stage = undefined;
    this.device = undefined;
    this.notice = '';
    this.emit();
    return this.state();
  }
  async logout() {
    if (this.refreshJob) throw new Error('账号正在刷新，请稍后再退出。');
    this.cancel();
    this.committing = true; this.busy = true; this.emit();
    try {
      await this.deps.persist(null);
      this.record = null; this.connection = 'signed-out'; this.clearExpiry();
    } finally { this.committing = false; this.busy = false; this.emit(); }
    return this.state();
  }
  /** Revalidate a restored account in the background; a cached skin is not proof of a live login. */
  async restore(): Promise<PublicAccountState> {
    if (!this.record || this.busy) return this.state();
    try { await this.identity(true); }
    catch { /* identity publishes offline or reauthentication-required without losing cached appearance. */ }
    return this.state();
  }
  private async json(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
    let response: Response;
    let body: Record<string, any>;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
    try {
      requestSignal.throwIfAborted();
      response = await this.request(url, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: requestSignal });
      requestSignal.throwIfAborted();
      body = await serviceJson(response, requestSignal);
    }
    catch (cause) {
      if (signal?.aborted) throw cause;
      if ((cause as AccountError).code === 'INVALID_RESPONSE') throw cause;
      throw accountError(`无法连接 ${new URL(url).hostname}，请检查网络后重试。`, 'NETWORK_UNAVAILABLE');
    }
    if (!response.ok) {
      const error = new Error(this.serviceError(url, response.status, body)) as AccountError;
      error.code = new URL(url).hostname === 'login.microsoftonline.com' && typeof body.error === 'string' && /^[a-z_]{1,80}$/.test(body.error) ? body.error : undefined;
      error.reauthenticate = ['invalid_grant', 'interaction_required', 'login_required'].includes(error.code ?? '')
        || response.status === 401 || (url.endsWith('/minecraft/profile') && response.status === 404);
      throw error;
    }
    return body;
  }
  private serviceError(url: string, status: number, data: any) {
    if (new URL(url).hostname === 'api.minecraftservices.com' && status === 403) return 'Minecraft 服务拒绝访问：请检查 shenBCL 的 Minecraft API 应用审批状态及账号权限。请在应用获准接入后重试。';
    if (new URL(url).hostname === 'login.microsoftonline.com') {
      if (data.error === 'authorization_pending') return '等待浏览器授权';
      if (data.error === 'slow_down') return '等待授权服务';
      if (data.error === 'authorization_declined' || data.error === 'access_denied') return '你已取消微软授权。';
      if (data.error === 'expired_token') return '设备代码已过期，请重新登录。';
      if (data.error === 'invalid_grant') return '登录凭据已失效，请退出账号后重新登录。';
      if (data.error === 'interaction_required' || data.error === 'login_required') return '此账号需要重新完成 Microsoft 授权。';
      if (data.error === 'invalid_client' || data.error === 'unauthorized_client') return '应用尚未正确接入：请检查 Client ID、个人 Microsoft 账号支持和公共客户端设备代码流配置。';
    }
    if (data.XErr === 2148916233) return '此 Microsoft 账号尚未建立 Xbox 个人资料，请先在 Xbox 网站完成设置。';
    if (data.XErr === 2148916238) return '此账号需要先完成 Xbox 家庭或年龄相关设置。';
    if (url.endsWith('/minecraft/profile') && status === 404) return '未找到 Minecraft Java 版角色，请确认账号拥有 Java 版并已创建角色。';
    return `账号服务请求失败（${new URL(url).hostname}，HTTP ${status}），请稍后重试。`;
  }
  async begin(): Promise<AccountState> {
    if (this.busy) throw new Error('已有账号任务正在进行。');
    if (!this.clientId) throw new Error('shenBCL 的 Microsoft 应用接入尚未完成，请等待开发者配置后再登录。');
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    this.operation = 'authorizing'; this.stage = '获取登录代码';
    this.notice = '';
    this.emit();
    try {
      const result = await this.json(`${MS}/devicecode`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scope }) }, controller.signal);
      if (controller.signal.aborted) return this.state();
      if (typeof result.device_code !== 'string' || !result.device_code || result.device_code.length > 16_384 || typeof result.user_code !== 'string' || !/^[A-Z\d-]{4,32}$/i.test(result.user_code) || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 3600) throw new Error('微软授权服务返回了无效的设备代码。');
      this.device = { code: result.user_code, verificationUri: 'https://www.microsoft.com/link', expiresAt: Date.now() + result.expires_in * 1000 };
      this.stage = '等待 Microsoft 授权';
      this.emit();
      const pollSeconds = Number(result.interval ?? 5);
      void this.poll(result.device_code, (Number.isFinite(pollSeconds) && pollSeconds > 0 && pollSeconds <= 60 ? Math.max(5, pollSeconds) : 5) * 1000, this.device.expiresAt, controller);
      return this.state();
    } catch (error) {
      if (this.controller === controller) { this.busy = false; this.operation = undefined; this.stage = undefined; this.controller = undefined; this.notice = error instanceof Error ? error.message : '登录失败，请重试。'; this.emit(); }
      if (!controller.signal.aborted) throw error;
      return this.state();
    }
  }
  private async poll(code: string, interval: number, expiresAt: number, controller: AbortController) {
    try {
      while (!controller.signal.aborted && Date.now() < expiresAt) {
        await this.sleep(Math.min(interval, Math.max(1, expiresAt - Date.now())), controller.signal);
        if (controller.signal.aborted || Date.now() >= expiresAt) break;
        try {
          const token = await this.json(`${MS}/token`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code }) }, controller.signal);
          const { record: next, appearanceNotice } = await this.exchange(token, controller.signal);
          if (controller.signal.aborted) return;
          this.committing = true;
          this.progress('保存加密凭据', controller.signal);
          try { await this.deps.persist(next); } finally { this.committing = false; }
          this.record = next;
          this.connection = 'connected';
          this.scheduleExpiry();
          this.notice = appearanceNotice || 'Microsoft 账号已连接，角色资料已同步。';
          return;
        } catch (error) {
          const tag = (error as { code?: string }).code;
          if (tag === 'authorization_pending') continue;
          if (tag === 'slow_down') { interval += 5000; continue; }
          throw error;
        }
      }
      if (!controller.signal.aborted) this.notice = '设备代码已过期，请重新登录。';
    } catch (error) {
      if (!controller.signal.aborted) this.notice = error instanceof Error ? error.message : '登录失败，请重试。';
    } finally {
      if (this.controller === controller) { this.busy = false; this.operation = undefined; this.stage = undefined; this.device = undefined; this.controller = undefined; this.emit(); }
    }
  }
  private async texture(url: unknown, signal: AbortSignal): Promise<string | undefined> {
    const safe = textureUrl(url);
    if (!safe) return;
    try {
      const response = await this.request(safe, { redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
      if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) {
        const result = await reader.read(); if (result.done) break;
        total += result.value.length;
        if (total > 1024 * 1024) { await reader.cancel(); return; }
        chunks.push(result.value);
      }
      const bytes = Buffer.concat(chunks);
      validateSkinPng(bytes);
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch { return; }
  }
  private async exchange(token: any, signal: AbortSignal): Promise<{ record: StoredAccount; appearanceNotice: string }> {
    signal.throwIfAborted();
    if (!validToken(token.access_token) || !validToken(token.refresh_token)) throw new Error('微软授权未返回有效的可刷新凭据，请确认 offline_access 权限。');
    const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    this.progress('验证 Xbox 身份', signal);
    const xbox = await this.json('https://user.auth.xboxlive.com/user/authenticate', post({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${token.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }), signal);
    if (!validToken(xbox.Token)) throw new Error('Xbox 认证响应不完整。');
    const xsts = await this.json('https://xsts.auth.xboxlive.com/xsts/authorize', post({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }), signal);
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (typeof uhs !== 'string' || !/^\d{1,32}$/.test(uhs) || !validToken(xsts.Token)) throw new Error('Xbox 授权响应不完整。');
    const minecraft = await this.json(`${MC}/authentication/login_with_xbox`, post({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }), signal);
    if (!validToken(minecraft.access_token) || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0 || minecraft.expires_in > 7 * 24 * 60 * 60) throw new Error('Minecraft 认证响应不完整。');
    const expiresAt = Date.now() + minecraft.expires_in * 1000;
    const headers = { Authorization: `Bearer ${minecraft.access_token}` };
    this.progress('验证 Minecraft 所有权', signal);
    const owned = await this.json(`${MC}/entitlements/mcstore`, { headers }, signal);
    if (!Array.isArray(owned.items) || !owned.items.some((item: any) => item && ['game_minecraft', 'product_minecraft'].includes(item.name))) throw accountError('此账号未返回 Minecraft Java 版所有权，请确认购买状态。', 'OWNERSHIP_REQUIRED', true);
    this.progress('同步角色与皮肤', signal);
    const profile = await this.json(`${MC}/minecraft/profile`, { headers }, signal);
    if (!/^[a-f\d]{32}$/i.test(profile.id ?? '') || !/^[A-Za-z\d_]{3,16}$/.test(profile.name ?? '')) throw new Error('Minecraft 角色资料无效。');
    const skin = Array.isArray(profile.skins) ? profile.skins.find((item: any) => item?.state === 'ACTIVE') : undefined;
    const cape = Array.isArray(profile.capes) ? profile.capes.find((item: any) => item?.state === 'ACTIVE') : undefined;
    const [skinTexture, capeDataUrl] = await Promise.all([this.texture(skin?.url, signal), this.texture(cape?.url, signal)]);
    let skinDataUrl = skinTexture;
    let model: PlayerProfile['model'] = skin?.variant === 'SLIM' ? 'slim' : 'default';
    const appearanceFailures: string[] = [];
    const cachedRecord = this.record;
    const cached = cachedRecord?.profile.id === profile.id ? cachedRecord?.profile : undefined;
    if (skin && !skinDataUrl) {
      skinDataUrl = cached?.skinDataUrl;
      if (skinDataUrl) model = cached!.model;
      appearanceFailures.push(skinDataUrl ? '皮肤下载失败，暂时展示上次缓存' : '皮肤下载失败，暂时展示默认角色');
    }
    if (cape && !capeDataUrl) appearanceFailures.push('官方披风暂未获取');
    signal.throwIfAborted();
    if (expiresAt <= Date.now()) throw new Error('Minecraft 登录凭据已到期，请重试。');
    const xuid = xsts.DisplayClaims?.xui?.[0]?.xid ?? '';
    if (typeof xuid !== 'string' || !/^\d{0,32}$/.test(xuid)) throw new Error('Xbox 账号标识无效。');
    return { record: { clientId: this.clientId, xuid, refreshToken: token.refresh_token, accessToken: minecraft.access_token, expiresAt, profile: { id: profile.id, name: profile.name, model, skinDataUrl, capeDataUrl } }, appearanceNotice: appearanceFailures.length ? `账号已连接；${appearanceFailures.join('；')}。` : '' };
  }
  private issueIdentity(record: StoredAccount): GameIdentity {
    const identity = Object.freeze({ id: record.profile.id, name: record.profile.name, accessToken: record.accessToken, clientId: this.clientId, xuid: record.xuid });
    issuedIdentities.set(identity, () => this.record === record && !this.committing && !this.operation && this.connection === 'connected' && record.expiresAt > Date.now());
    return identity;
  }
  async requireGameIdentity(force = true): Promise<GameIdentity> {
    const identity = await this.identity(force);
    assertGameIdentity(identity);
    return identity;
  }
  async identity(force = false): Promise<GameIdentity | undefined> {
    if (this.refreshJob) return this.refreshJob;
    if (this.busy) throw new Error('请先完成或取消当前账号操作，再启动游戏。');
    if (!this.record) return;
    if (this.connection === 'reauthentication-required') throw new Error('登录凭据已失效，请重新连接 Microsoft 账号。');
    if (!force && this.connection === 'connected' && this.record.expiresAt > Date.now() + 120_000) return this.issueIdentity(this.record);
    const controller = new AbortController();
    const previous = this.record;
    this.controller = controller;
    this.clearExpiry();
    this.busy = true; this.operation = 'refreshing'; this.stage = '恢复 Microsoft 登录'; this.notice = ''; this.emit();
    this.refreshJob = (async () => {
      const token = await this.json(`${MS}/token`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: previous.refreshToken, scope }) }, controller.signal);
      token.refresh_token ??= previous.refreshToken;
      const { record: next, appearanceNotice } = await this.exchange(token, controller.signal);
      if (next.profile.id !== previous.profile.id) throw accountError('刷新后的账号身份不一致，请重新登录。', 'IDENTITY_MISMATCH', true);
      this.progress('保存加密凭据', controller.signal);
      await this.deps.persist(next);
      this.record = next;
      this.connection = 'connected';
      this.scheduleExpiry();
      this.notice = appearanceNotice || 'Microsoft 登录状态已验证，角色资料已同步。';
      return this.issueIdentity(next);
    })();
    try { return await this.refreshJob; }
    catch (error) { this.connection = (error as AccountError).reauthenticate ? 'reauthentication-required' : 'offline'; this.notice = error instanceof Error ? error.message : '账号刷新失败'; throw error; }
    finally { this.refreshJob = undefined; this.busy = false; this.operation = undefined; this.stage = undefined; if (this.controller === controller) this.controller = undefined; this.emit(); }
  }
}
