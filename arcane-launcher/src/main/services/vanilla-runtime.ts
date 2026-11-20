import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { createNodeInstallRuntime, type DefaultNodeInstallRuntimeOptions, type InstallFile, type InstallRuntime } from '@xmcl/installer';
import { DownloadSourceHttpError, fetchFromSources, getDownloadSource, resolveDownloadSources, validateDownloadUrl, type DownloadPurpose } from './download-sources';

export interface NetworkRetryOptions {
  signal?: AbortSignal;
  /** Tests replace the delay without changing the production retry budget. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

class TransientHttpError extends Error {
  constructor(message: string, readonly retryAfter = 0) { super(message); }
}

function transientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof AggregateError) return error.errors.some(transientNetworkError);
  if (error instanceof DownloadSourceHttpError) return error.status === 408 || error.status === 429 || error.status >= 500 && error.status <= 599;
  if (error instanceof TransientHttpError || ['TimeoutError', 'AbortError'].includes(error.name)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)) return true;
  if (/net::ERR_(?:CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b|\bfetch failed\b|\bfailed to fetch\b|\bterminated\b/i.test(error.message)) return true;
  return transientNetworkError(error.cause);
}

function retryAfter(error: unknown): number {
  if (error instanceof AggregateError) return Math.max(0, ...error.errors.map(retryAfter));
  return error instanceof TransientHttpError || error instanceof DownloadSourceHttpError ? error.retryAfter : 0;
}

/** Three attempts total; only transport failures and temporary HTTP errors retry. */
export async function withNetworkRetry<T>(operation: () => Promise<T>, options: NetworkRetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (attempt >= 2 || !transientNetworkError(error)) throw error;
      const delay = Math.min(5000, Math.max(500 * 2 ** attempt, retryAfter(error)));
      if (options.wait) await options.wait(delay, options.signal);
      else await wait(delay, undefined, { signal: options.signal });
    }
  }
}

/** Cancel rejected bodies before retrying, so a failed response does not hold a socket. */
export async function requireSuccessfulDownload(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  const message = `${label}（HTTP ${response.status}）。`;
  if (response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599) {
    const header = response.headers.get('retry-after');
    const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
    throw new TransientHttpError(message, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  }
  throw new Error(message);
}

function operationLimiter(concurrency: number) {
  let active = 0;
  const pending: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => pending.push(resolve));
    else active++;
    try { return await operation(); }
    finally {
      const next = pending.shift();
      if (next) next();
      else active--;
    }
  };
}

function officialUrl(value: string): string {
  return validateDownloadUrl(value, vanillaPurpose(value));
}

function vanillaPurpose(value: string): DownloadPurpose {
  const url = new URL(value);
  return url.hostname === 'resources.download.minecraft.net' || url.pathname.startsWith('/assets/') ? 'asset' : url.hostname === 'libraries.minecraft.net' || url.pathname.startsWith('/maven/') ? 'library' : 'vanilla-metadata';
}

async function ordinaryPath(filename: string): Promise<void> {
  if (!path.isAbsolute(filename) || filename.includes('\0')) throw new Error('原版下载路径无效。');
  let current = path.parse(filename).root;
  const parts = path.relative(current, filename).split(path.sep);
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('原版下载路径不能包含符号链接或目录联接。');
  }
}

async function hashFile(filename: string, algorithm: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** A request adapter lets Electron use the same proxy stack for metadata and file downloads. */
export function createVanillaRuntime(options: DefaultNodeInstallRuntimeOptions, request: typeof fetch, retryOptions: Omit<NetworkRetryOptions, 'signal'> = {}, onTransfer?: (progress: { transferredBytes: number; currentFile: string }) => void): InstallRuntime {
  const base = createNodeInstallRuntime(options);
  let transferredBytes = 0;
  const reportTransfer = (filename: string) => { try { onTransfer?.({ transferredBytes, currentFile: filename }); } catch { /* Observers do not control file integrity. */ } };
  const io = operationLimiter(Math.max(1, Math.min(6, options.maxConcurrency ?? 6)));
  // The SDK may call download again after a failure. A new user retry creates a
  // new runtime; within this runtime each source keeps its three-attempt budget.
  const exhaustedSources = new Map<string, unknown>();

  const verifiedExisting = async (file: InstallFile): Promise<boolean> => {
    if (file.replace || !file.checksum?.value) return false;
    const info = await lstat(file.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info?.isFile() || (file.size !== undefined && file.size >= 0 && info.size !== file.size)) return false;
    if ((await hashFile(file.path, file.checksum.algorithm, options.signal)).toLowerCase() !== file.checksum.value.toLowerCase()) return false;
    return !file.validator || await base.validate(file.path, file.validator);
  };

  const download = async (files: InstallFile[]): Promise<void> => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        options.signal?.throwIfAborted();
        const file = files[cursor++];
        reportTransfer(file.path);
        await ordinaryPath(file.path);
        if (!file.urls.length) throw new Error('原版文件缺少下载地址。');
        file.urls.forEach(officialUrl);
        const single = options.tracker?.subSingle();
        const accessor = { url: file.urls[0], total: Math.max(0, file.size ?? 0), progress: 0 };
        if (single) { single.expectedTotal = accessor.total; single.setAccessor(accessor); }
        if (await verifiedExisting(file)) {
          accessor.progress = accessor.total || (await lstat(file.path)).size;
          accessor.total = accessor.progress;
          if (single) single.done = true;
          continue;
        }
        await mkdir(path.dirname(file.path), { recursive: true });
        let failure: unknown;
        let succeeded = false;
        for (const source of file.urls) {
          const sourceKey = `${file.path}\0${source}\0${file.checksum?.value ?? ''}\0${file.size ?? ''}`;
          if (exhaustedSources.has(sourceKey)) { failure = exhaustedSources.get(sourceKey); continue; }
          const rejectedSources = new Set<string>();
          for (let choice = 0; choice < resolveDownloadSources(source, vanillaPurpose(source)).length; choice++) {
          let chosenSource: string | undefined;
          try {
            await withNetworkRetry(async () => {
              const temporary = `${file.path}.${randomUUID()}.download`;
              try {
                options.signal?.throwIfAborted();
                accessor.url = source;
                accessor.progress = 0;
                const response = await fetchFromSources(source, { purpose: vanillaPurpose(source), request, signal: options.signal, exclude: rejectedSources, timeoutMs: 300_000 });
                chosenSource = getDownloadSource(response);
                await requireSuccessfulDownload(response, 'Minecraft 官方下载失败');
                if (!response.body) throw new Error('Minecraft 官方下载返回了空响应。');
                if (!accessor.total) accessor.total = Math.max(0, Number(response.headers.get('content-length')) || 0);
                const hash = file.checksum ? createHash(file.checksum.algorithm) : undefined;
                let size = 0;
                const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.length;
                  transferredBytes += chunk.length;
                  reportTransfer(file.path);
                  accessor.progress = size;
                  hash?.update(chunk);
                  if (size > (file.size !== undefined && file.size >= 0 ? file.size : 2 * 1024 ** 3)) { callback(new Error('原版下载文件超出预期大小。')); return; }
                  callback(null, chunk);
                } });
                await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(temporary, { flags: 'wx' }), { signal: options.signal });
                if (file.size !== undefined && file.size >= 0 && size !== file.size) throw new Error('原版下载文件大小不匹配。');
                if (file.checksum && hash!.digest('hex').toLowerCase() !== file.checksum.value.toLowerCase()) throw new Error('原版下载文件校验失败。');
                if (file.validator && !await base.validate(temporary, file.validator)) throw new Error('原版下载文件格式校验失败。');
                options.signal?.throwIfAborted();
                await ordinaryPath(file.path);
                await rename(temporary, file.path);
                accessor.total = size;
                accessor.progress = size;
                if (single) single.done = true;
              } finally { await unlink(temporary).catch(() => undefined); }
            }, { ...retryOptions, signal: options.signal });
            succeeded = true;
            break;
          } catch (error) {
            failure = error;
            options.signal?.throwIfAborted();
            if (chosenSource) rejectedSources.add(chosenSource);
            else break;
          }
          }
          if (succeeded) break;
          exhaustedSources.set(sourceKey, failure);
        }
        if (!succeeded) throw new Error(`原版文件下载失败：${path.basename(file.path)}`, { cause: failure });
      }
    };
    const concurrency = Math.max(1, Math.min(6, options.maxConcurrency ?? 6, files.length || 1));
    const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    options.signal?.throwIfAborted();
    const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), '部分原版文件未下载完成。');
  };

  return {
    ...base,
    stat: filename => io(async () => { options.signal?.throwIfAborted(); await ordinaryPath(filename); return base.stat(filename); }),
    checksum: (filename, algorithm) => io(async () => { options.signal?.throwIfAborted(); await ordinaryPath(filename); return options.checksum ? base.checksum(filename, algorithm) : hashFile(filename, algorithm, options.signal); }),
    validate: (filename, validator) => io(async () => { options.signal?.throwIfAborted(); await ordinaryPath(filename); return base.validate(filename, validator); }),
    download,
  };
}
