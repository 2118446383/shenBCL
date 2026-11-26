import { isIP } from 'node:net';

export type DownloadPurpose = 'vanilla-metadata' | 'library' | 'asset' | 'neoforge' | 'modpack' | 'catalog';
export const BMCLAPI_ORIGIN = 'https://bmclapi2.bangbang93.com';
export const MCIM_ORIGIN = 'https://mod.mcimirror.top';

const VANILLA_HOSTS = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net']);
const LOADER_HOSTS = new Set([...VANILLA_HOSTS, 'maven.neoforged.net', 'maven.minecraftforge.net', 'repo.maven.apache.org', 'repo1.maven.org']);
const MOD_HOSTS = new Set(['cdn.modrinth.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net']);
const CATALOG_HOSTS = new Set(['api.modrinth.com']);
const BMCL_LOADER_PATHS = /^\/maven\/(?:net\/minecraftforge|net\/neoforged)\//;
const MCIM_CATALOG_PATHS = /^\/modrinth\/v2\/(?:search(?:\?|$)|project\/|version\/|tag\/)/;
const EDUCATION_MIRRORS = new Set(['mirrors.cernet.edu.cn', 'mirrors.ustc.edu.cn', 'mirror.nju.edu.cn', 'mirrors.nju.edu.cn', 'mirror.lzu.edu.cn', 'mirrors.qlu.edu.cn', 'mirrors.cqu.edu.cn', 'mirror.nyist.edu.cn', 'mirrors.hit.edu.cn', 'mirrors.ha.edu.cn']);
const responseSources = new WeakMap<Response, string>();

function parsedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('下载来源必须使用受信任的 HTTPS 地址。');
  return url;
}

export function validateDownloadUrl(value: string, purpose: DownloadPurpose): string {
  const url = parsedUrl(value);
  const hosts = purpose === 'catalog' ? CATALOG_HOSTS : purpose === 'modpack' ? MOD_HOSTS : purpose === 'neoforge' || purpose === 'library' ? LOADER_HOSTS : VANILLA_HOSTS;
  const mirror = url.origin === BMCLAPI_ORIGIN && purpose === 'neoforge' && BMCL_LOADER_PATHS.test(url.pathname)
    || url.origin === MCIM_ORIGIN && (purpose === 'modpack' && /^\/(?:data|files)\//.test(url.pathname) || purpose === 'catalog' && MCIM_CATALOG_PATHS.test(url.pathname + url.search));
  if (!hosts.has(url.hostname) && !mirror) throw new Error('下载清单包含不受信任的来源。');
  return url.href;
}

/** Mappings follow BMCLAPI and MCIM's public documentation; no PCL code is reused. */
export function resolveDownloadSources(value: string, purpose: DownloadPurpose): string[] {
  const official = validateDownloadUrl(value, purpose);
  const url = new URL(official);
  let mirror: string | undefined;
  if (purpose === 'catalog' && url.hostname === 'api.modrinth.com') mirror = `${MCIM_ORIGIN}/modrinth${url.pathname}${url.search}`;
  else if (purpose === 'modpack' && MOD_HOSTS.has(url.hostname)) mirror = `${MCIM_ORIGIN}${url.pathname}${url.search}`;
  else if (purpose === 'neoforge' && url.hostname === 'maven.minecraftforge.net' && url.pathname.startsWith('/net/minecraftforge/')) mirror = BMCLAPI_ORIGIN + '/maven' + url.pathname + url.search;
  else if (purpose === 'neoforge' && url.hostname === 'maven.neoforged.net' && url.pathname.startsWith('/releases/net/neoforged/')) mirror = BMCLAPI_ORIGIN + '/maven/' + url.pathname.slice('/releases/'.length) + url.search;
  return [...new Set([official, ...(mirror ? [validateDownloadUrl(mirror, purpose)] : [])])];
}

function delegatedUrl(value: string, previous: string, purpose: DownloadPurpose): string {
  try { return validateDownloadUrl(value, purpose); } catch { /* Check narrowly delegated CDN responses below. */ }
  const next = new URL(value);
  const prior = new URL(previous);
  if (next.protocol !== 'https:' || next.username || next.password || next.hash || isIP(next.hostname) || !next.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(next.hostname)) throw new Error('下载重定向指向不安全地址。');
  // BMCLAPI dispatches university mirrors and signed OpenBMCLAPI nodes. Only a
  // response received over the trusted dispatcher's TLS connection can delegate.
  if ((prior.origin === BMCLAPI_ORIGIN || EDUCATION_MIRRORS.has(prior.hostname)) && EDUCATION_MIRRORS.has(next.hostname) && !next.port && next.pathname.startsWith('/bmclapi/')) return next.href;
  if (prior.origin === BMCLAPI_ORIGIN && /^\/download\/[a-f\d]{32,64}$/i.test(next.pathname) && next.searchParams.has('s') && next.searchParams.has('e')) return next.href;
  if (prior.origin === MCIM_ORIGIN && (next.hostname.endsWith('.mcimirror.top') || MOD_HOSTS.has(next.hostname)) && !next.port && /^\/(?:data|files)\//.test(next.pathname)) return next.href;
  throw new Error('下载重定向超出受信任的分发范围。');
}

export interface DownloadSourceOptions {
  purpose: DownloadPurpose;
  request?: typeof fetch;
  signal?: AbortSignal;
  init?: RequestInit;
  /** Deadline covers body transfer too; delayed hedging avoids waiting for a dead origin. */
  timeoutMs?: number;
  headerTimeoutMs?: number;
  hedgeDelayMs?: number;
  exclude?: ReadonlySet<string>;
}

export class DownloadSourceHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: number, host: string) { super(`下载来源 ${host} 返回 HTTP ${status}`); }
}

async function checkedMetadataResponse(response: Response, value: string, purpose: DownloadPurpose): Promise<Response> {
  const pathname = new URL(value).pathname;
  const json = purpose === 'catalog' || purpose === 'vanilla-metadata' && pathname.endsWith('.json') || purpose === 'neoforge' && pathname.endsWith('.module');
  const sha1 = purpose === 'neoforge' && pathname.endsWith('.sha1');
  if (!json && !sha1) return response;
  if (!response.body) throw new Error('下载来源返回了空的元数据。');
  const limit = sha1 ? 1024 : 32 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('下载来源返回的元数据超出大小限制。');
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (json) JSON.parse(text);
  else if (!/^[a-f\d]{40}(?:\s|$)/i.test(text.trim())) throw new Error('下载来源返回了无效的 SHA1 元数据。');
  // Preserve exact bytes for Mojang's published metadata checksum validation.
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function getDownloadSource(response: Response): string | undefined { return responseSources.get(response); }

export async function fetchFromSources(value: string, options: DownloadSourceOptions): Promise<Response> {
  const callerSignal = options.signal && options.init?.signal ? AbortSignal.any([options.signal, options.init.signal]) : options.signal ?? options.init?.signal ?? undefined;
  callerSignal?.throwIfAborted();
  const candidates = resolveDownloadSources(value, options.purpose).filter(source => !options.exclude?.has(source));
  if (!candidates.length) throw new Error('此文件的可用下载来源均已尝试。');
  const request = options.request ?? fetch;
  const controllers = candidates.map(() => new AbortController());
  const errors: unknown[] = [];
  const timeoutMs = options.timeoutMs ?? (options.purpose === 'catalog' || options.purpose === 'vanilla-metadata' || value.endsWith('.sha1') ? 20_000 : 300_000);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let started = 0;
    let failed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortOthers = (winner = -1) => controllers.forEach((controller, index) => { if (index !== winner) controller.abort(); });
    const abort = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); abortOthers(); reject(callerSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    callerSignal?.addEventListener('abort', abort, { once: true });
    const start = (index: number) => {
      if (settled || index >= candidates.length) return;
      started = Math.max(started, index + 1);
      if (index + 1 < candidates.length) timer = setTimeout(() => start(index + 1), options.hedgeDelayMs ?? 700);
      const signal = AbortSignal.any([controllers[index].signal, AbortSignal.timeout(timeoutMs), ...(callerSignal ? [callerSignal] : [])]);
      void (async () => {
        let next = candidates[index];
        for (let redirect = 0; redirect <= 5; redirect++) {
          const headersController = new AbortController();
          const headersTimer = setTimeout(() => headersController.abort(new DOMException('下载来源连接超时。', 'TimeoutError')), options.headerTimeoutMs ?? 12_000);
          let response: Response;
          const headers = new Headers(options.init?.headers);
          if (new URL(next).origin !== new URL(value).origin) for (const header of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(header);
          try { response = await request(next, { ...options.init, headers, credentials: new URL(next).origin === new URL(value).origin ? options.init?.credentials : 'omit', redirect: 'manual', signal: AbortSignal.any([signal, headersController.signal]) }); }
          finally { clearTimeout(headersTimer); }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('下载重定向缺少目标地址。');
            next = delegatedUrl(new URL(location, next).href, next, options.purpose);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            const header = response.headers.get('retry-after');
            const retryAfter = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Math.max(0, Date.parse(header) - Date.now()) : 0;
            throw new DownloadSourceHttpError(response.status, Number.isFinite(retryAfter) ? retryAfter : 0, new URL(candidates[index]).hostname);
          }
          if (response.url && new URL(response.url).href !== next) throw new Error('下载请求绕过了重定向检查。');
          response = await checkedMetadataResponse(response, candidates[index], options.purpose);
          if (settled) { await response.body?.cancel(); return; }
          settled = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); abortOthers(index);
          responseSources.set(response, candidates[index]); resolve(response); return;
        }
        throw new Error('下载重定向次数过多。');
      })().catch(error => {
        if (settled) return;
        errors.push(error); failed++;
        if (started < candidates.length) { clearTimeout(timer); start(started); }
        if (failed === candidates.length) {
          settled = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); abortOthers();
          reject(new AggregateError(errors, `所有下载来源均不可用：${errors.map(error => error instanceof Error ? error.message : String(error)).join('；')}`));
        }
      });
    };
    start(0);
  });
}
