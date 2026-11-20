import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CatalogDownload } from './catalog';

type FileMetadata = Pick<CatalogDownload, 'size' | 'sha512' | 'sha1' | 'type'>;
interface ExportOptions { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }

function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('文件保存已取消。', { cause: signal.reason });
}

/** Copies an integrity-checked public download to the exact path chosen by a native save dialog. */
export async function exportCatalogFile(source: string, destination: string, file: FileMetadata, options: ExportOptions = {}): Promise<string> {
  active(options.signal);
  const extension = file.type === 'mod' ? '.jar' : '.mrpack';
  if (!path.isAbsolute(destination) || !destination.toLowerCase().endsWith(extension)) throw new Error(`请选择 ${extension} 文件保存位置。`);
  const name = path.basename(destination);
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('保存文件名无效。');
  const directory = path.dirname(destination);
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('请选择普通目录保存下载文件。');
  const root = await realpath(directory), target = path.join(root, name);
  if (path.resolve(source).toLowerCase() === target.toLowerCase()) throw new Error('保存位置不能是下载缓存文件本身。');
  const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('保存目标必须是普通文件。');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== file.size) throw new Error('下载缓存文件已变化，请重新下载。');
  const algorithm = file.sha512 ? 'sha512' : 'sha1', expectedHash = file.sha512 ?? file.sha1;
  if (!expectedHash || !new RegExp(`^[a-f\\d]{${algorithm === 'sha512' ? 128 : 40}}$`, 'i').test(expectedHash)) throw new Error('下载校验信息缺失。');
  const temporary = path.join(root, `.shenbcl-${randomUUID()}.part`);
  const handle = await open(temporary, 'wx');
  const stream = createReadStream(source);
  const abort = () => stream.destroy(new Error('文件保存已取消。', { cause: options.signal?.reason }));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const checksum = createHash(algorithm);
    let size = 0;
    for await (const chunk of stream) {
      active(options.signal);
      size += chunk.length;
      if (size > file.size) throw new Error('下载缓存文件大小已变化，请重新下载。');
      checksum.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        active(options.signal);
        const written = (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        if (!written) throw new Error('下载文件保存失败。');
        offset += written;
      }
      try { options.onProgress?.(size, file.size); } catch { /* The UI cannot invalidate the integrity check. */ }
    }
    active(options.signal);
    if (size !== file.size || checksum.digest('hex') !== expectedHash.toLowerCase()) throw new Error('下载文件校验失败，未覆盖保存目标。');
    await handle.sync();
    await handle.close();
    active(options.signal);
    const current = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('保存目标在下载期间发生变化，请重新选择。');
    if (previous ? !current || current.ino !== previous.ino || current.dev !== previous.dev || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs : !!current) throw new Error('保存目标已被其他程序修改，请重新选择。');
    active(options.signal);
    await rename(temporary, target);
    return target;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    stream.destroy();
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
