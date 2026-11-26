import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CatalogFile, CatalogMinecraftVersion, CatalogProject, CatalogSearchQuery, CatalogSearchResult, CatalogVersion } from '../../shared/contracts';
import { catalogIconUrl } from '../../shared/catalog-icon';
import { OFFICIAL_VERSION_MANIFEST, validateVanillaVersionId } from './installer';
import { DownloadSourceHttpError, fetchFromSources, getDownloadSource, resolveDownloadSources } from './download-sources';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MAX_JSON = 8 * 1024 * 1024;
const TICKET_LIFETIME = 30 * 60_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const LOADERS = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'liteloader']);
type ProjectType = 'mod' | 'modpack';
export interface CatalogVersionFilter { type: ProjectType; minecraftVersion?: string; loader?: string }
interface Dependency { projectId?: string; versionId?: string }
export interface CatalogDownload {
  id: string; type: ProjectType; projectId: string; versionId: string; filename: string; size: number;
  url: string; sha512?: string; sha1?: string; minecraftVersions: string[]; loaders: string[];
}
interface Ticket extends CatalogDownload { expiresAt: number; dependencies: Dependency[] }
/** fetch is the raw transport; source selection is owned by this service. */
export interface CatalogOptions { fetch?: typeof fetch; userAgent?: string }
export interface CatalogDownloadOptions { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }
export interface CatalogDownloadedFile { path: string; filename: string; type: ProjectType; projectId: string; versionId: string; minecraftVersions: string[]; loaders: string[] }

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z\d_-]{1,80}$/.test(value)) throw new Error('项目或版本标识无效。');
  return value;
}
function text(value: unknown, max: number): string { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : ''; }
function strings(value: unknown, max = 200): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 100))].slice(0, max) : []; }
function projectType(value: unknown): ProjectType { if (value !== 'mod' && value !== 'modpack') throw new Error('请选择模组或整合包。'); return value; }
function filter(input: CatalogVersionFilter): CatalogVersionFilter {
  const type = projectType(input?.type);
  const minecraftVersion = input.minecraftVersion ? validateVanillaVersionId(input.minecraftVersion) : undefined;
  const loader = input.loader?.toLowerCase();
  if (loader && !LOADERS.has(loader)) throw new Error('加载器筛选无效。');
  return { type, minecraftVersion, loader };
}
function officialFileUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('文件下载地址缺失。');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' || url.port || url.username || url.password || url.hash || !url.pathname.startsWith('/data/')) throw new Error('文件地址不是可信的 Modrinth CDN。');
  return url.href;
}
function filename(value: unknown, type: ProjectType): string {
  if (typeof value !== 'string' || !value || value.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || !value.toLowerCase().endsWith(type === 'mod' ? '.jar' : '.mrpack')) throw new Error('下载文件名或类型无效。');
  return value;
}
function hash(value: unknown, length: number): string | undefined { return typeof value === 'string' && new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(value) ? value.toLowerCase() : undefined; }
function compatible(file: CatalogDownload, target: { minecraftVersion: string; loader: string }): boolean { return file.minecraftVersions.includes(target.minecraftVersion) && file.loaders.includes(target.loader.toLowerCase()); }
class CatalogTransferError extends Error {}
function downloadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('资源下载已取消或超时。', { cause: signal.reason });
}
async function digest(file: string, algorithm: string, signal?: AbortSignal): Promise<string> {
  downloadActive(signal);
  const value = createHash(algorithm);
  const stream = createReadStream(file);
  const abort = () => stream.destroy(new Error('资源下载已取消或超时。', { cause: signal?.reason }));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    downloadActive(signal);
    for await (const chunk of stream) { downloadActive(signal); value.update(chunk); }
    downloadActive(signal);
    return value.digest('hex');
  } finally { signal?.removeEventListener('abort', abort); stream.destroy(); }
}

async function writeDownload(response: Response, temporary: string, file: CatalogDownload, signal: AbortSignal, onProgress?: CatalogDownloadOptions['onProgress']): Promise<void> {
  if (!response.ok || !response.body) throw new CatalogTransferError(`资源下载失败（HTTP ${response.status}）。`);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== file.size) throw new CatalogTransferError('下载文件大小与项目清单不一致。');
  downloadActive(signal);
  const handle = await open(temporary, 'wx');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const value = createHash(file.sha512 ? 'sha512' : 'sha1');
  let completed = 0, finished = false;
  try {
    for (;;) {
      downloadActive(signal);
      let item: ReadableStreamReadResult<Uint8Array>;
      try { item = await reader.read(); }
      catch (cause) { throw new CatalogTransferError('资源下载连接中断，请重试。', { cause }); }
      downloadActive(signal);
      if (item.done) break;
      completed += item.value.length;
      if (completed > file.size) throw new CatalogTransferError('下载文件超过清单声明的大小。');
      value.update(item.value);
      let written = 0;
      while (written < item.value.length) {
        downloadActive(signal);
        const count = (await handle.write(item.value, written, item.value.length - written)).bytesWritten;
        if (!count) throw new Error('资源缓存写入失败。');
        written += count;
      }
      try { onProgress?.(completed, file.size); } catch { /* UI progress cannot invalidate file integrity. */ }
    }
    if (completed !== file.size || value.digest('hex') !== (file.sha512 ?? file.sha1)) throw new CatalogTransferError('资源文件校验失败，请重新下载。');
    downloadActive(signal);
    await handle.sync();
    downloadActive(signal);
    finished = true;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
    await handle.close();
  }
}

/** Public catalog metadata is separated from short-lived download capabilities held in the main process. */
export class CatalogService {
  private request: typeof fetch;
  private userAgent: string;
  private tickets = new Map<string, Ticket>();
  private vanilla?: { expiresAt: number; items: CatalogMinecraftVersion[] };
  constructor(options: CatalogOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? 'shenBCL/0.3.7 (Minecraft Java launcher)';
  }
  private async json(url: string, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await fetchFromSources(url, { purpose: url.startsWith(MODRINTH_API) ? 'catalog' : 'vanilla-metadata', request: this.request, signal: requestSignal, init: { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } } });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AggregateError && error.errors.length && error.errors.every(item => item instanceof DownloadSourceHttpError && item.status === 429)) throw new Error('下载源请求过于频繁，请稍后重试。', { cause: error });
      throw error;
    }
    requestSignal.throwIfAborted();
    if (Number(response.headers.get('content-length')) > MAX_JSON) { await response.body?.cancel(); throw new Error('下载源返回的元数据过大。'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('下载源返回了空响应。');
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        total += item.value.length;
        if (total > MAX_JSON) throw new Error('下载源返回的元数据过大。');
        chunks.push(item.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('下载源返回的元数据格式无效。'); }
  }
  async minecraftVersions(): Promise<CatalogMinecraftVersion[]> {
    if (this.vanilla && this.vanilla.expiresAt > Date.now()) return structuredClone(this.vanilla.items);
    const data = await this.json(OFFICIAL_VERSION_MANIFEST);
    if (!data || !Array.isArray(data.versions)) throw new Error('Mojang 官方版本清单格式无效。');
    const items: CatalogMinecraftVersion[] = [];
    for (const item of data.versions.slice(0, 10_000)) {
      if (!item || !['release','snapshot','old_beta','old_alpha'].includes(item.type)) continue;
      try { validateVanillaVersionId(item.id); } catch { continue; }
      if (typeof item.releaseTime !== 'string' || !Number.isFinite(Date.parse(item.releaseTime))) continue;
      items.push({ id: item.id, type: item.type, releaseTime: new Date(item.releaseTime).toISOString() });
    }
    this.vanilla = { expiresAt: Date.now() + 10 * 60_000, items };
    return structuredClone(items);
  }
  async search(input: CatalogSearchQuery): Promise<CatalogSearchResult> {
    const selected = filter(input);
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 120) : '';
    const offset = Number.isInteger(input.offset) && input.offset! >= 0 && input.offset! <= 1_000_000 ? input.offset! : 0;
    const facets = [[`project_type:${selected.type}`], ['client_side:required', 'client_side:optional']];
    if (selected.minecraftVersion) facets.push([`versions:${selected.minecraftVersion}`]);
    if (selected.loader) facets.push([`categories:${selected.loader}`]);
    const params = new URLSearchParams({ query, facets: JSON.stringify(facets), index: 'relevance', offset: String(offset), limit: '20' });
    const data = await this.json(`${MODRINTH_API}/search?${params}`);
    if (!data || !Array.isArray(data.hits)) throw new Error('Modrinth 项目列表格式无效。');
    const hits: CatalogProject[] = [];
    for (const hit of data.hits.slice(0, 20)) {
      try {
        if (hit.project_type !== selected.type) continue;
        const id = identifier(hit.project_id), iconUrl = catalogIconUrl(hit.icon_url, id);
        hits.push({ id, slug: identifier(hit.slug), title: text(hit.title, 150), description: text(hit.description, 600), author: text(hit.author, 80), downloads: Number.isSafeInteger(hit.downloads) && hit.downloads >= 0 ? hit.downloads : 0, ...(iconUrl ? { iconUrl } : {}), type: selected.type });
      } catch { /* Skip malformed remote entries. */ }
    }
    return { hits, total: Number.isSafeInteger(data.total_hits) && data.total_hits >= 0 ? Math.min(1_000_000, data.total_hits) : hits.length, offset, limit: 20 };
  }
  private parseVersions(data: unknown, selected: CatalogVersionFilter, expectedProject: string): CatalogVersion[] {
    if (!Array.isArray(data)) throw new Error('Modrinth 版本列表格式无效。');
    for (const [key, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(key);
    const items: CatalogVersion[] = [];
    for (const raw of data.slice(0, 200)) {
      if (!raw || typeof raw !== 'object') continue;
      try {
        const versionId = identifier(raw.id), projectId = identifier(raw.project_id);
        if (projectId !== expectedProject) continue;
        const minecraftVersions = strings(raw.game_versions), loaders = strings(raw.loaders).map(item => item.toLowerCase());
        if ((selected.minecraftVersion && !minecraftVersions.includes(selected.minecraftVersion)) || (selected.loader && !loaders.includes(selected.loader))) continue;
        const dependencies: Dependency[] = [];
        for (const dependency of Array.isArray(raw.dependencies) ? raw.dependencies.slice(0, 100) : []) {
          if (dependency?.dependency_type !== 'required') continue;
          const projectId = dependency.project_id ? identifier(dependency.project_id) : undefined;
          const versionId = dependency.version_id ? identifier(dependency.version_id) : undefined;
          if (!projectId && !versionId) throw new Error('必需依赖缺少项目标识。');
          dependencies.push({ projectId, versionId });
        }
        const files: CatalogFile[] = [];
        for (const file of Array.isArray(raw.files) ? raw.files.slice(0, 10) : []) {
          try {
            const safeName = filename(file.filename, selected.type), url = officialFileUrl(file.url);
            const sha512 = hash(file.hashes?.sha512, 128), sha1 = hash(file.hashes?.sha1, 40);
            const max = selected.type === 'mod' ? 512 * 1024 ** 2 : 2 * 1024 ** 3;
            if ((!sha512 && !sha1) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > max) continue;
            const id = randomUUID();
            this.tickets.set(id, { id, type: selected.type, projectId, versionId, filename: safeName, url, size: file.size, sha512, sha1, minecraftVersions, loaders, dependencies, expiresAt: Date.now() + TICKET_LIFETIME });
            files.push({ ticket: id, filename: safeName, size: file.size, primary: file.primary === true });
          } catch { /* Invalid side files cannot grant a download capability. */ }
        }
        if (!files.length) continue;
        files.sort((a,b) => Number(b.primary) - Number(a.primary));
        items.push({ id: versionId, projectId, name: text(raw.name, 150), versionNumber: text(raw.version_number, 100), versionType: ['release','beta','alpha'].includes(raw.version_type) ? raw.version_type : 'release', publishedAt: typeof raw.date_published === 'string' && Number.isFinite(Date.parse(raw.date_published)) ? new Date(raw.date_published).toISOString() : '', minecraftVersions, loaders, files, requiredDependencies: dependencies.length });
      } catch { /* Skip malformed version metadata without trusting partial dependency information. */ }
    }
    while (this.tickets.size > 5000) this.tickets.delete(this.tickets.keys().next().value!);
    return items.sort((a,b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  async versions(project: string, input: CatalogVersionFilter, options: { signal?: AbortSignal } = {}): Promise<CatalogVersion[]> {
    const selected = filter(input), id = identifier(project);
    const params = new URLSearchParams();
    if (selected.minecraftVersion) params.set('game_versions', JSON.stringify([selected.minecraftVersion]));
    if (selected.loader) params.set('loaders', JSON.stringify([selected.loader]));
    const [projectData, data] = await Promise.all([this.json(`${MODRINTH_API}/project/${id}`, options.signal), this.json(`${MODRINTH_API}/project/${id}/version?${params}`, options.signal)]);
    if (projectData?.project_type !== selected.type || projectData?.client_side === 'unsupported') throw new Error('该项目不支持所选客户端资源类型。');
    return this.parseVersions(data, selected, identifier(projectData.id));
  }
  ticket(id: string): CatalogDownload {
    const found = typeof id === 'string' ? this.tickets.get(id) : undefined;
    if (!found || found.expiresAt <= Date.now()) { this.tickets.delete(id); throw new Error('下载选择已过期，请重新选择项目版本。'); }
    const { dependencies: _dependencies, expiresAt: _expiresAt, ...download } = found;
    return structuredClone(download);
  }
  async resolveModDependencies(id: string, target: { minecraftVersion: string; loader: string }, options: { signal?: AbortSignal } = {}): Promise<CatalogDownload[]> {
    const selected = filter({ type: 'mod', ...target });
    const first = this.ticket(id);
    if (first.type !== 'mod' || !compatible(first, target)) throw new Error('此模组与当前实例的 Minecraft 或加载器版本不兼容。');
    const seen = new Map<string,string>(), result: CatalogDownload[] = [];
    const visit = async (file: CatalogDownload): Promise<void> => {
      options.signal?.throwIfAborted();
      const existing = seen.get(file.projectId);
      if (existing) { if (existing !== file.versionId) throw new Error('必需依赖要求了同一项目的不同版本，已停止安装。'); return; }
      if (seen.size >= 100) throw new Error('必需依赖数量过多，已停止自动安装。');
      seen.set(file.projectId, file.versionId);
      const record = this.tickets.get(file.id)!;
      for (const dependency of record.dependencies) {
        let versions: CatalogVersion[];
        if (dependency.versionId) {
          const data = await this.json(`${MODRINTH_API}/version/${dependency.versionId}`, options.signal);
          const projectId = identifier(data?.project_id);
          if (dependency.projectId && dependency.projectId !== projectId) throw new Error('必需依赖的项目与版本标识不一致。');
          const projectData = await this.json(`${MODRINTH_API}/project/${projectId}`, options.signal);
          if (projectData?.project_type !== 'mod' || projectData?.client_side === 'unsupported') throw new Error('必需依赖不支持客户端。');
          versions = this.parseVersions([data], selected, projectId);
        } else versions = await this.versions(dependency.projectId!, selected, options);
        const version = versions.find(item => item.versionType === 'release') ?? versions[0];
        const chosen = version?.files.find(item => item.primary) ?? version?.files[0];
        if (!chosen) throw new Error('未找到兼容当前 Minecraft 与加载器的必需依赖。');
        await visit(this.ticket(chosen.ticket));
      }
      result.push(file);
    };
    await visit(first);
    return result;
  }
  async download(id: string, cacheRoot: string, options: CatalogDownloadOptions = {}): Promise<CatalogDownloadedFile> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000);
    downloadActive(signal);
    const file = this.ticket(id);
    if (!path.isAbsolute(cacheRoot)) throw new Error('下载缓存目录无效。');
    await mkdir(cacheRoot, { recursive: true });
    const rootInfo = await lstat(cacheRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('下载缓存目录不能是链接。');
    const root = await realpath(cacheRoot), algorithm = file.sha512 ? 'sha512' : 'sha1', expectedHash = file.sha512 ?? file.sha1!;
    const target = path.join(root, `${expectedHash}${file.type === 'mod' ? '.jar' : '.mrpack'}`);
    const result = () => ({ path: target, filename: file.filename, type: file.type, projectId: file.projectId, versionId: file.versionId, minecraftVersions: file.minecraftVersions, loaders: file.loaders });
    const existing = await lstat(target).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('缓存目标不是普通文件。');
      if (existing.size === file.size && await digest(target, algorithm, signal) === expectedHash) {
        try { options.onProgress?.(file.size, file.size); } catch {}
        downloadActive(signal);
        return result();
      }
    }
    const rejectedSources = new Set<string>();
    const sources = resolveDownloadSources(file.url, 'modpack');
    let failure: unknown;
    for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      downloadActive(signal);
      if (sources.every(source => rejectedSources.has(source))) break;
      const temporary = path.join(root, `${randomUUID()}.part`);
      let response: Response | undefined, source: string | undefined;
      try {
        try {
          response = await fetchFromSources(file.url, { purpose: 'modpack', request: this.request, signal, exclude: rejectedSources, init: { headers: { 'User-Agent': this.userAgent } } });
        } catch (cause) { throw new CatalogTransferError(`资源下载连接失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
        source = getDownloadSource(response);
        await writeDownload(response, temporary, file, signal, options.onProgress);
        downloadActive(signal);
        const current = await lstat(target).catch(() => undefined);
        if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('缓存目标在下载期间发生变化。');
        downloadActive(signal);
        await rename(temporary, target);
        downloadActive(signal);
        return result();
      } catch (error) {
        downloadActive(signal);
        // Filesystem and cache-target failures require user action, not another download.
        if (!(error instanceof CatalogTransferError)) throw error;
        failure = error;
        if (source) rejectedSources.add(source);
      } finally {
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
      if (attempt + 1 < MAX_DOWNLOAD_ATTEMPTS && !sources.every(source => rejectedSources.has(source))) {
        try { await delay(200 * (attempt + 1), undefined, { signal }); }
        catch { downloadActive(signal); }
      }
    }
    throw new Error(`资源下载重试后仍失败：${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
  }
}
