import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export interface DownloadedMod { filename: string; source: string; size: number; sha512?: string; sha1?: string }
async function ordinary(filename: string): Promise<void> {
  let current = path.parse(path.resolve(filename)).root;
  for (const part of path.relative(current, path.resolve(filename)).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error('模组安装目录不能包含符号链接或目录联接。');
  }
}
async function matches(filename: string, mod: DownloadedMod, signal?: AbortSignal): Promise<boolean> {
  const info = await lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== mod.size) return false;
  const algorithm = mod.sha512 ? 'sha512' : 'sha1';
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex') === (mod.sha512 ?? mod.sha1)?.toLowerCase();
}

/** Publish all selected dependencies without replacing any existing player file. */
export async function publishMods(gameDirectory: string, files: DownloadedMod[], signal?: AbortSignal): Promise<{ added: number; reused: number }> {
  signal?.throwIfAborted();
  if (!path.isAbsolute(gameDirectory) || !files.length || files.length > 200) throw new Error('模组安装目标或文件列表无效。');
  await ordinary(gameDirectory);
  const root = await realpath(gameDirectory);
  const mods = path.join(root, 'mods');
  await ordinary(mods);
  const info = await lstat(mods).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (info && !info.isDirectory()) throw new Error('实例的 mods 位置不是普通目录。');
  const names = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    if (!/^[^<>:"/\\|?*\x00-\x1f]{1,180}\.jar$/i.test(file.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file.filename)
      || !Number.isSafeInteger(file.size) || file.size < 0 || !(file.sha512 && /^[a-f\d]{128}$/i.test(file.sha512) || file.sha1 && /^[a-f\d]{40}$/i.test(file.sha1))) throw new Error('模组文件名或校验信息无效。');
    if (names.has(file.filename.toLowerCase())) throw new Error('所选模组依赖包含同名文件冲突。');
    names.add(file.filename.toLowerCase());
    await ordinary(file.source);
    if (!await matches(file.source, file, signal)) throw new Error(`模组缓存校验失败：${file.filename}`);
    const target = path.join(mods, file.filename);
    await ordinary(target);
    const existing = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (existing && !await matches(target, file, signal)) throw new Error(`已有不同内容的同名模组：${file.filename}。请先在资源管理中处理该文件。`);
  }
  await mkdir(mods, { recursive: true });
  const prepared: Array<{ temporary: string; target: string; file: DownloadedMod }> = [];
  const published: typeof prepared = [];
  let reused = 0;
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const target = path.join(mods, file.filename);
      if (await matches(target, file, signal)) { reused++; continue; }
      const temporary = path.join(mods, `.shenbcl-mod-${randomUUID()}.tmp`);
      prepared.push({ temporary, target, file });
      await copyFile(file.source, temporary);
      if (!await matches(temporary, file, signal)) throw new Error(`模组复制后校验失败：${file.filename}`);
    }
    for (const item of prepared) {
      signal?.throwIfAborted();
      await ordinary(mods);
      // A hard link publishes atomically with no overwrite on every platform.
      await link(item.temporary, item.target);
      published.push(item);
    }
    return { added: published.length, reused };
  } catch (error) {
    for (const item of published) if (await matches(item.target, item.file).catch(() => false)) await rm(item.target, { force: true }).catch(() => {});
    throw error;
  } finally { for (const item of prepared) await rm(item.temporary, { force: true }).catch(() => {}); }
}
