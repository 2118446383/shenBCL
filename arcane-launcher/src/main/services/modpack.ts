import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fetchFromSources, getDownloadSource } from './download-sources';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { open as openZip, type Entry, type ZipFile } from '@xmcl/yauzl';
import { javaRequirement } from './instances';

const MAX_ENTRIES = 100_000;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_TOTAL_BYTES = 20 * 1024 ** 3;
const MAX_INDEX_BYTES = 8 * 1024 ** 2;
const DOWNLOAD_HOSTS = new Set(['cdn.modrinth.com', 'mediafilez.forgecdn.net', 'edge.forgecdn.net', 'media.forgecdn.net']);
const PROTECTED_ROOTS = new Set(['versions', 'libraries', 'assets', 'runtime', 'runtimes']);
const OTHER_LAUNCHER_ROOTS = new Set(['pcl', 'hmcl', '.hmcl', 'launcher_accounts.json', 'launcher_profiles.json', 'accounts.json']);

export class ModpackError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ModpackError'; }
}
export interface ValidatedModpackFile {
  path: string;
  hashAlgorithm: 'sha512' | 'sha1';
  hash: string;
  downloads: string[];
  fileSize: number;
  optional: boolean;
}
export interface ModpackAnalysis {
  format: 'modrinth';
  name: string;
  versionId: string;
  summary: string;
  minecraftVersion: string;
  loader: 'vanilla' | 'neoforge' | 'forge' | 'fabric' | 'quilt';
  loaderVersion?: string;
  requiredJavaMajor: number;
  fileCount: number;
  downloadBytes: number;
  overrideCount: number;
  overrideBytes: number;
  modCount: number;
  warnings: string[];
  files: ValidatedModpackFile[];
  archiveFingerprint: { size: number; mtimeMs: number };
}
export interface ModpackFileProgress {
  phase: 'downloading' | 'extracting' | 'complete';
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
  reusedFiles: number;
  currentFile?: string;
  message: string;
  phasePercent?: number;
  phaseCompletedFiles?: number;
  phaseTotalFiles?: number;
  phaseCompletedBytes?: number;
  phaseTotalBytes?: number;
  /** Network bytes only, including retries; never includes ZIP files or verified existing content. */
  transferredBytes?: number;
}
export interface InstallModpackFilesOptions {
  archivePath: string;
  destination: string;
  signal?: AbortSignal;
  concurrency?: number;
  /** Pins the archive selected in the preview, including after long base downloads. */
  expectedArchive?: { size: number; mtimeMs: number };
  onProgress?: (progress: ModpackFileProgress) => void;
  /** Test injection; production uses the native fetch implementation. */
  fetch?: typeof globalThis.fetch;
}
interface ArchiveEntry { entry: Entry; name: string; directory: boolean }
interface OverrideFile extends ArchiveEntry { target: string }
interface InspectedArchive { zip: ZipFile; analysis: ModpackAnalysis; overrides: OverrideFile[] }

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModpackError('CANCELLED', '整合包安装已取消，校验通过的文件可在重试时复用。', { cause: signal.reason });
}
function fail(message: string): never { throw new ModpackError('INVALID_PACK', message); }
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Paths are checked against Windows semantics even when tests run on another OS. */
export function validateModpackPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || /[\x00-\x1f<>:"|?*]/.test(value)) fail('整合包包含无效文件路径。');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) fail('整合包不能使用绝对文件路径。');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('整合包包含不安全的文件路径。');
  return normalized;
}
function allowedTarget(target: string): boolean {
  const first = target.split('/')[0].toLowerCase();
  if (PROTECTED_ROOTS.has(first) || first.startsWith('.arcane') || first.startsWith('.shenbcl')) fail('整合包文件试图覆盖游戏核心或启动器安装记录。');
  return !OTHER_LAUNCHER_ROOTS.has(first);
}
export function validateModpackDownload(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096) fail('整合包下载地址格式无效。');
  let url: URL;
  try { url = new URL(value); } catch { fail('整合包下载地址格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new ModpackError('UNTRUSTED_DOWNLOAD', '整合包下载地址不属于受支持的 Modrinth / CurseForge 文件源。');
  }
  return url.href;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function updateCrc(crc: number, bytes: Buffer): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function crc32(bytes: Buffer): number { return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
function decodeName(entry: Entry): string {
  const raw = entry.fileName as unknown as Buffer;
  if (!Buffer.isBuffer(raw)) return entry.fileName;
  const unicode = entry.extraFields.find(field => field.id === 0x7075 && field.data.length > 5 && field.data[0] === 1 && field.data.readUInt32LE(1) === crc32(raw));
  try {
    if (unicode) return new TextDecoder('utf-8', { fatal: true }).decode(unicode.data.subarray(5));
    if (entry.generalPurposeBitFlag & 0x800) return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { return new TextDecoder('gb18030', { fatal: true }).decode(raw); }
  } catch { fail('ZIP 文件名编码无法识别，请重新导出整合包。'); }
}
function zipStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error) { reject(error); return; }
    // fd-slicer uses a legacy Readable whose destroyed flag is set before its
    // end event. A modern boundary keeps async iterators/pipeline from waiting
    // forever on stored (uncompressed) ZIP entries.
    const boundary = new PassThrough();
    stream.on('error', failure => boundary.destroy(failure));
    boundary.once('close', () => { if (!stream.destroyed) stream.destroy(); });
    stream.pipe(boundary);
    resolve(boundary);
  }));
}
async function readIndex(zip: ZipFile, entry: Entry, signal?: AbortSignal): Promise<unknown> {
  if (entry.uncompressedSize > MAX_INDEX_BYTES) fail('整合包索引过大。');
  const stream = await zipStream(zip, entry);
  const cancelled = () => stream.destroy(new ModpackError('CANCELLED', '整合包读取已取消。'));
  signal?.addEventListener('abort', cancelled, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    abort(signal);
    for await (const chunk of stream) {
      abort(signal);
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_INDEX_BYTES) fail('整合包索引解压大小超出限制。');
      chunks.push(bytes);
    }
    const data = Buffer.concat(chunks);
    if (size !== entry.uncompressedSize || crc32(data) !== entry.crc32) fail('整合包索引损坏，CRC 校验失败。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, ''));
  } finally { signal?.removeEventListener('abort', cancelled); stream.destroy(); }
}
async function openArchive(archivePath: string, signal?: AbortSignal): Promise<{ zip: ZipFile; entries: ArchiveEntry[] }> {
  abort(signal);
  const info = await stat(archivePath);
  if (!info.isFile() || info.size > MAX_TOTAL_BYTES) fail('请选择大小合理的整合包 ZIP / MRPACK 文件。');
  const zip = await new Promise<ZipFile>((resolve, reject) => openZip(archivePath, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  zip.on('error', () => {});
  const entries: ArchiveEntry[] = [];
  try {
    if (zip.entryCount > MAX_ENTRIES) fail('整合包中的文件数量过多。');
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      const names = new Set<string>();
      const cancelled = () => { cleanup(); reject(new ModpackError('CANCELLED', '整合包读取已取消。')); };
      const cleanup = () => { signal?.removeEventListener('abort', cancelled); zip.removeListener('error', onError); zip.removeListener('end', onEnd); zip.removeListener('entry', onEntry); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onEnd = () => { cleanup(); resolve(); };
      const onEntry = (entry: Entry) => {
        try {
          abort(signal);
          const rawName = decodeName(entry).replaceAll('\\', '/');
          const directory = rawName.endsWith('/');
          const name = validateModpackPath(directory ? rawName.slice(0, -1) : rawName);
          const key = name.toLowerCase();
          if (names.has(key)) fail('ZIP 含有重复或大小写冲突的文件路径。');
          names.add(key);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode === 0xa000 || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)) fail('整合包不允许包含符号链接或特殊文件。');
          if (entry.isEncrypted()) fail('暂不支持加密整合包。');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_FILE_BYTES) fail('整合包中的单个文件过大。');
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES || entries.length >= MAX_ENTRIES) fail('整合包解压大小或文件数量超出限制。');
          entries.push({ entry, name, directory });
          zip.readEntry();
        } catch (error) { cleanup(); reject(error); }
      };
      zip.on('error', onError); zip.on('end', onEnd); zip.on('entry', onEntry);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled(); else zip.readEntry();
    });
    // Keep an error listener while streams are read, so a damaged archive cannot
    // emit an unhandled EventEmitter error after directory enumeration.
    zip.on('error', () => {});
    return { zip, entries };
  } catch (error) { zip.close(); throw error; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('整合包索引结构无效。');
  return value as Record<string, unknown>;
}
function displayString(value: unknown, fallback: string, limit = 200): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f]/.test(value)) fail('整合包名称或版本信息格式无效。');
  return value.trim() || fallback;
}
function dependency(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(value)) fail('整合包依赖版本格式无效。');
  return value;
}
function rejectFileParentCollisions(files: string[]): void {
  const names = new Set(files.map(value => value.toLowerCase()));
  for (const file of names) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) fail('整合包文件与目录路径发生冲突。');
  }
}
async function inspectArchive(archivePath: string, signal?: AbortSignal): Promise<InspectedArchive> {
  const fingerprint = await stat(archivePath);
  const { zip, entries } = await openArchive(archivePath, signal);
  try {
    const manifests = entries.filter(item => !item.directory && (item.name === 'modrinth.index.json' || item.name.endsWith('/modrinth.index.json')));
    if (manifests.length !== 1) throw new ModpackError('UNSUPPORTED_FORMAT', '没有找到唯一的 Modrinth 整合包索引。当前支持带 modrinth.index.json 的 ZIP / MRPACK。');
    const manifest = manifests[0];
    const prefix = manifest.name.slice(0, -'modrinth.index.json'.length);
    const data = object(await readIndex(zip, manifest.entry, signal));
    if (data.game !== 'minecraft' || data.formatVersion !== 1) fail('不支持此游戏或 Modrinth 整合包格式版本。');
    const dependencies = object(data.dependencies);
    const minecraftVersion = dependency(dependencies.minecraft);
    const loaders = [['neoforge', 'neoforge'], ['forge', 'forge'], ['fabric-loader', 'fabric'], ['quilt-loader', 'quilt']] as const;
    const present = loaders.filter(([key]) => dependencies[key] !== undefined);
    if (present.length > 1) fail('整合包同时指定了多个模组加载器。');
    for (const key of Object.keys(dependencies)) if (key !== 'minecraft' && !loaders.some(([loader]) => loader === key)) fail(`整合包包含尚不支持的依赖：${key}`);
    const loader = present[0]?.[1] ?? 'vanilla';
    const loaderVersion = present[0] ? dependency(dependencies[present[0][0]]) : undefined;
    if (!Array.isArray(data.files) || data.files.length > MAX_ENTRIES) fail('整合包文件清单格式无效。');
    const files: ValidatedModpackFile[] = [];
    const seen = new Set<string>();
    let downloadBytes = 0;
    let skippedLauncherFiles = false;
    for (const input of data.files) {
      const item = object(input);
      const target = validateModpackPath(item.path);
      const key = target.toLowerCase();
      if (seen.has(key)) fail('整合包下载清单存在重复路径。');
      seen.add(key);
      const accepted = allowedTarget(target);
      if (!accepted) skippedLauncherFiles = true;
      const environment = item.env === undefined ? {} : object(item.env);
      for (const value of Object.values(environment)) if (!['required', 'optional', 'unsupported'].includes(String(value))) fail('整合包环境配置无效。');
      const hashes = object(item.hashes);
      if (hashes.sha512 !== undefined && (typeof hashes.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(hashes.sha512))) fail('整合包 SHA-512 校验值格式无效。');
      if (hashes.sha1 !== undefined && (typeof hashes.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(hashes.sha1))) fail('整合包 SHA-1 校验值格式无效。');
      const algorithm = typeof hashes.sha512 === 'string' ? 'sha512' : 'sha1';
      const hash = hashes[algorithm];
      if (typeof hash !== 'string' || !(algorithm === 'sha512' ? /^[a-f0-9]{128}$/i : /^[a-f0-9]{40}$/i).test(hash)) fail('整合包文件缺少有效的 SHA-512 / SHA-1 校验值。');
      if (!Number.isSafeInteger(item.fileSize) || Number(item.fileSize) < 0 || Number(item.fileSize) > MAX_FILE_BYTES) fail('整合包文件大小无效。');
      if (!Array.isArray(item.downloads) || item.downloads.length < 1 || item.downloads.length > 10) fail('整合包文件缺少下载地址。');
      const downloads = [...new Set(item.downloads.map(validateModpackDownload))];
      if (environment.client === 'unsupported' || !accepted) continue;
      downloadBytes += Number(item.fileSize);
      if (downloadBytes > MAX_TOTAL_BYTES) fail('整合包下载总大小超出限制。');
      files.push({ path: target, hashAlgorithm: algorithm, hash: hash.toLowerCase(), fileSize: Number(item.fileSize), downloads, optional: environment.client === 'optional' });
    }
    const overridesByName = new Map<string, OverrideFile>();
    for (const folder of ['overrides/', 'client-overrides/']) {
      for (const item of entries) {
        const start = `${prefix}${folder}`;
        if (item.directory || !item.name.startsWith(start)) continue;
        const target = validateModpackPath(item.name.slice(start.length));
        if (!allowedTarget(target)) { skippedLauncherFiles = true; continue; }
        overridesByName.set(target.toLowerCase(), { ...item, target });
      }
    }
    const overrides = [...overridesByName.values()];
    const overrideBytes = overrides.reduce((sum, file) => sum + file.entry.uncompressedSize, 0);
    if (downloadBytes + overrideBytes > MAX_TOTAL_BYTES) fail('整合包安装总大小超出限制。');
    rejectFileParentCollisions([...new Set([...files.map(file => file.path.toLowerCase()), ...overrides.map(file => file.target.toLowerCase())])]);
    const warnings: string[] = [];
    if (skippedLauncherFiles) warnings.push('已忽略整合包中的其他启动器设置，shenBCL 使用自己的账号与启动配置。');
    const optional = files.filter(file => file.optional).length;
    if (optional) warnings.push(`本次包含 ${optional} 个标为客户端可选的文件。`);
    if (prefix) warnings.push('整合包索引位于外层文件夹中，已自动识别内容根目录。');
    const after = await stat(archivePath);
    if (after.size !== fingerprint.size || after.mtimeMs !== fingerprint.mtimeMs) fail('读取期间整合包发生变化，请重新选择。');
    const modPaths = new Set([...files.map(file => file.path), ...overrides.map(file => file.target)].filter(value => /^mods\/[^/]+\.jar$/i.test(value)).map(value => value.toLowerCase()));
    const analysis: ModpackAnalysis = {
      format: 'modrinth', name: displayString(data.name, path.basename(archivePath, path.extname(archivePath))),
      versionId: displayString(data.versionId, '未知版本'), summary: displayString(data.summary, '', 4_096),
      minecraftVersion, loader, loaderVersion, requiredJavaMajor: javaRequirement(minecraftVersion),
      fileCount: files.length, downloadBytes, overrideCount: overrides.length,
      overrideBytes, modCount: modPaths.size,
      warnings, files, archiveFingerprint: { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs },
    };
    return { zip, analysis, overrides };
  } catch (error) { zip.close(); throw error; }
}
export async function analyzeModpack(archivePath: string, options: { signal?: AbortSignal } = {}): Promise<ModpackAnalysis> {
  try { const inspected = await inspectArchive(archivePath, options.signal); inspected.zip.close(); return inspected.analysis; }
  catch (error) {
    abort(options.signal);
    if (error instanceof ModpackError) throw error;
    throw new ModpackError('INVALID_PACK', '无法读取整合包，文件可能损坏或格式不受支持。', { cause: error });
  }
}

async function checkedRoot(destination: string): Promise<string> {
  if (!path.isAbsolute(destination)) fail('整合包安装位置必须是主进程指定的绝对路径。');
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('整合包目标必须是普通实例目录，不能是目录链接。');
  return realpath(destination);
}
async function checkedTarget(root: string, relative: string): Promise<string> {
  const safe = validateModpackPath(relative);
  if (!allowedTarget(safe)) fail('不能写入其他启动器的设置。');
  const segments = safe.split('/');
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    let info = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (!info) { await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); info = await lstat(directory); }
    if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(directory))) fail('目标路径中存在不安全的目录链接或文件。');
  }
  const target = path.join(root, ...segments);
  const info = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) fail('目标文件不能是目录链接或特殊文件。');
  return target;
}
async function verifiedExisting(target: string, file: ValidatedModpackFile, signal?: AbortSignal): Promise<boolean> {
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== file.fileSize) return false;
  const hash = createHash(file.hashAlgorithm);
  const stream = createReadStream(target);
  const cancelled = () => stream.destroy(new ModpackError('CANCELLED', '校验已取消。'));
  signal?.addEventListener('abort', cancelled, { once: true });
  try { abort(signal); for await (const chunk of stream) { abort(signal); hash.update(chunk); } return hash.digest('hex') === file.hash; }
  finally { signal?.removeEventListener('abort', cancelled); stream.destroy(); }
}
async function fetchDownload(url: string, request: typeof globalThis.fetch, signal?: AbortSignal, exclude?: ReadonlySet<string>): Promise<Response> {
  validateModpackDownload(url);
  const response = await fetchFromSources(url, { purpose: 'modpack', request, signal, exclude });
  if (!response.body) throw new ModpackError('DOWNLOAD_FAILED', '文件源返回空响应。');
  return response;
}
async function publishStream(root: string, relative: string, source: Readable, options: { size: number; hash?: { algorithm: 'sha512' | 'sha1'; value: string }; crc?: number; signal?: AbortSignal; progress?: (size: number) => void }): Promise<void> {
  let temporary: string | undefined;
  let size = 0; let crc = 0xffffffff;
  const hash = options.hash ? createHash(options.hash.algorithm) : undefined;
  const checker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      options.progress?.(size);
      if (size > options.size) { callback(new ModpackError('HASH_MISMATCH', `文件大小校验失败：${relative}`)); return; }
      hash?.update(chunk);
      if (options.crc !== undefined) crc = updateCrc(crc, chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (size !== options.size || (options.hash && hash?.digest('hex') !== options.hash.value) || (options.crc !== undefined && ((crc ^ 0xffffffff) >>> 0) !== options.crc)) callback(new ModpackError('HASH_MISMATCH', `文件校验失败：${relative}`));
      else callback();
    },
  });
  try {
    abort(options.signal);
    const target = await checkedTarget(root, relative);
    temporary = path.join(path.dirname(target), `.shenbcl-${randomUUID()}.part`);
    await pipeline(source, checker, createWriteStream(temporary, { flags: 'wx' }), { signal: options.signal });
    abort(options.signal);
    await checkedTarget(root, relative);
    await rename(temporary, target);
  } finally { source.destroy(); if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
}

/** Only installs pack files. The caller installs Minecraft / loader first. */
export async function installModpackFiles(options: InstallModpackFilesOptions): Promise<{ downloadedFiles: number; reusedFiles: number; overrideFiles: number }> {
  const inspected = await inspectArchive(options.archivePath, options.signal);
  const { zip, analysis, overrides } = inspected;
  try {
    if (options.expectedArchive && (analysis.archiveFingerprint.size !== options.expectedArchive.size || analysis.archiveFingerprint.mtimeMs !== options.expectedArchive.mtimeMs)) throw new ModpackError('ARCHIVE_CHANGED', '整合包在安装过程中发生变化，请重新导入。');
    const root = await checkedRoot(options.destination);
    abort(options.signal);
    if (options.concurrency !== undefined && !Number.isFinite(options.concurrency)) fail('下载并发数无效。');
    const concurrency = Math.max(1, Math.min(12, Math.floor(options.concurrency ?? 6)));
    const request = options.fetch ?? globalThis.fetch;
    let cursor = 0; let completed = 0; let satisfiedBytes = 0; let reusedFiles = 0; let downloadedFiles = 0; let lastProgressAt = 0; let transferredBytes = 0; let extractedBytes = 0;
    const inflight = new Map<string, number>();
    const totalFiles = analysis.files.length + overrides.length;
    const totalBytes = analysis.downloadBytes + analysis.overrideBytes;
    const emit = (phase: ModpackFileProgress['phase'], message: string, currentFile?: string) => {
      const phaseCompletedFiles = phase === 'extracting' ? completed - analysis.files.length : completed;
      const phaseTotalFiles = phase === 'extracting' ? overrides.length : phase === 'complete' ? totalFiles : analysis.files.length;
      const phaseCompletedBytes = phase === 'extracting' ? Math.max(0, satisfiedBytes - analysis.downloadBytes) + extractedBytes : satisfiedBytes + [...inflight.values()].reduce((sum, value) => sum + value, 0);
      const phaseTotalBytes = phase === 'extracting' ? analysis.overrideBytes : phase === 'complete' ? totalBytes : analysis.downloadBytes;
      const ratio = phaseTotalBytes > 0 ? phaseCompletedBytes / phaseTotalBytes : phaseCompletedFiles / Math.max(1, phaseTotalFiles);
      const phasePercent = phaseCompletedFiles === phaseTotalFiles ? 100 : Math.min(99.9, Math.max(0, ratio * 100));
      try { options.onProgress?.({ phase, message, currentFile, completedFiles: completed, totalFiles, downloadedBytes: satisfiedBytes + [...inflight.values()].reduce((sum, value) => sum + value, 0), totalBytes, reusedFiles, phasePercent, phaseCompletedFiles, phaseTotalFiles, phaseCompletedBytes, phaseTotalBytes, transferredBytes }); } catch { /* UI listeners do not control the install. */ }
    };
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const worker = async () => {
      while (cursor < analysis.files.length) {
        abort(signal);
        const file = analysis.files[cursor++];
        const target = await checkedTarget(root, file.path);
        if (await verifiedExisting(target, file, signal)) {
          reusedFiles++; completed++; satisfiedBytes += file.fileSize;
          emit('downloading', '复用已通过校验的文件', file.path); continue;
        }
        let failure: unknown;
        const rejectedSources = new Set<string>();
        for (let attempt = 0; attempt < Math.max(3, file.downloads.length); attempt++) {
          abort(signal);
          let source: string | undefined;
          try {
            emit('downloading', attempt ? `重试下载（第 ${attempt + 1} 次）` : '正在下载并校验整合包文件', file.path);
            const response = await fetchDownload(file.downloads[attempt % file.downloads.length], request, signal, rejectedSources);
            source = getDownloadSource(response);
            const length = response.headers.get('content-length');
            if (length && Number(length) > file.fileSize) { await response.body?.cancel(); throw new ModpackError('HASH_MISMATCH', `下载文件大小超出索引声明：${file.path}`); }
            await publishStream(root, file.path, Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), { size: file.fileSize, hash: { algorithm: file.hashAlgorithm, value: file.hash }, signal, progress: size => {
              const previous = inflight.get(file.path) ?? 0;
              transferredBytes += Math.max(0, size - previous);
              inflight.set(file.path, size);
              if (Date.now() - lastProgressAt >= 200) { lastProgressAt = Date.now(); emit('downloading', '正在下载并校验整合包文件', file.path); }
            } });
            inflight.delete(file.path); satisfiedBytes += file.fileSize; downloadedFiles++; completed++;
            emit('downloading', '文件校验通过', file.path); failure = undefined; break;
          } catch (error) {
            inflight.delete(file.path); abort(signal); failure = error;
            if (source && error instanceof ModpackError && error.code === 'HASH_MISMATCH') rejectedSources.add(source);
            if (attempt + 1 < Math.max(3, file.downloads.length)) await delay(250 * Math.min(4, attempt + 1), undefined, { signal });
          }
        }
        if (failure) throw new ModpackError('DOWNLOAD_FAILED', `下载或校验失败：${file.path}。可重试并复用已完成文件。`, { cause: failure });
      }
    };
    emit('downloading', '正在校验整合包文件');
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, analysis.files.length)) }, () => worker().catch(error => { controller.abort(error); throw error; }));
    const outcomes = await Promise.allSettled(workers);
    const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) { abort(options.signal); throw controller.signal.reason ?? rejected.reason; }
    emit('downloading', '模组与整合包文件已校验完成');
    // Modrinth overrides deliberately take precedence over downloaded files;
    // client-overrides take precedence over the common overrides directory.
    for (const item of overrides) {
      abort(options.signal);
      emit('extracting', '正在导入整合包配置与附带文件', item.target);
      const stream = await zipStream(zip, item.entry);
      await publishStream(root, item.target, stream, { size: item.entry.uncompressedSize, crc: item.entry.crc32, signal: options.signal, progress: size => {
        extractedBytes = size;
        if (Date.now() - lastProgressAt >= 200) { lastProgressAt = Date.now(); emit('extracting', '正在导入整合包配置与附带文件', item.target); }
      } });
      extractedBytes = 0;
      completed++; satisfiedBytes += item.entry.uncompressedSize;
    }
    emit('extracting', '整合包配置与附带文件已导入');
    emit('complete', '整合包文件已下载并校验完成');
    return { downloadedFiles, reusedFiles, overrideFiles: overrides.length };
  } catch (error) { abort(options.signal); throw error; }
  finally { zip.close(); }
}
