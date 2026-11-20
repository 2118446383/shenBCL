import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const BACKUP_MANIFEST = '.arcane-backup.json';

export interface BackupSource {
  path: string;
  /** A single directory name in the resulting backup, such as saves or world. */
  name: string;
}

export interface BackupDirectoriesOptions {
  sources: BackupSource[];
  /** A new backup directory, not an existing destination or a source descendant. */
  destination: string;
}

interface SourceEntry {
  path: string;
  relativePath: string;
  info: Stats;
  children?: SourceEntry[];
}

interface PreparedSource {
  name: string;
  physicalPath: string;
  tree: SourceEntry;
}

interface BackupFileRecord {
  path: string;
  size: number;
  sha256: string;
}

export class BackupError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupError';
  }
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function directoryName(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > 120 || value === '.' || value === '..'
    || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    || value.toLowerCase() === BACKUP_MANIFEST.toLowerCase()
  ) throw new BackupError('INVALID_SOURCE_NAME', '备份源名称必须是单个有效目录名。');
  return value;
}

async function optionalLstat(filename: string): Promise<Stats | undefined> {
  try { return await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

/** Resolve existing ancestors before creating any directory, including junction ancestors. */
async function physicalDestination(destination: string): Promise<string> {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new BackupError('INVALID_DESTINATION', '备份目录必须是有效的绝对路径。');
  }
  const target = path.resolve(destination);
  if (await optionalLstat(target)) throw new BackupError('DESTINATION_EXISTS', '备份目标已经存在，已停止以保护原有文件。');
  const tail: string[] = [];
  let ancestor = target;
  while (!await optionalLstat(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new BackupError('INVALID_DESTINATION', '无法解析备份目标目录。');
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const physicalAncestor = await realpath(ancestor);
  if (!(await lstat(physicalAncestor)).isDirectory()) throw new BackupError('INVALID_DESTINATION', '备份目标的父路径不是目录。');
  return path.join(physicalAncestor, ...tail);
}

function assertSameEntry(expected: Stats, actual: Stats, filename: string): void {
  if (actual.isSymbolicLink()) throw new BackupError('SYMLINK_NOT_SUPPORTED', `备份源包含符号链接或目录联接，已停止：${filename}`);
  // Node/libuv on Windows can report dev=0 for path lstat but the real volume ID for fstat.
  const comparableDevice = process.platform !== 'win32' || (expected.dev !== 0 && actual.dev !== 0);
  if ((comparableDevice && expected.dev !== actual.dev) || expected.ino !== actual.ino || expected.isDirectory() !== actual.isDirectory() || expected.isFile() !== actual.isFile()) {
    throw new BackupError('SOURCE_CHANGED', `备份源在复制过程中发生变化，请关闭游戏后重试：${filename}`);
  }
  if (expected.isFile() && (expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs || expected.ctimeMs !== actual.ctimeMs)) {
    throw new BackupError('SOURCE_CHANGED', `存档文件在备份过程中发生变化，请关闭游戏后重试：${filename}`);
  }
}

async function inspectTree(filename: string, relativePath = ''): Promise<SourceEntry> {
  const info = await lstat(filename);
  if (info.isSymbolicLink()) throw new BackupError('SYMLINK_NOT_SUPPORTED', `备份源包含符号链接或目录联接，已停止：${filename}`);
  if (!info.isDirectory() && !info.isFile()) throw new BackupError('UNSUPPORTED_FILE', `备份源包含非常规文件，已停止：${filename}`);
  const entry: SourceEntry = { path: filename, relativePath, info };
  if (info.isDirectory()) {
    const children = (await readdir(filename)).sort();
    entry.children = [];
    for (const child of children) entry.children.push(await inspectTree(path.join(filename, child), path.join(relativePath, child)));
    assertSameEntry(info, await lstat(filename), filename);
  }
  return entry;
}

async function verifyTree(entry: SourceEntry): Promise<void> {
  assertSameEntry(entry.info, await lstat(entry.path), entry.path);
  if (entry.children) {
    const current = (await readdir(entry.path)).sort();
    const expected = entry.children.map(child => path.basename(child.path)).sort();
    if (current.length !== expected.length || current.some((name, index) => name !== expected[index])) {
      throw new BackupError('SOURCE_CHANGED', `存档目录内容在备份过程中发生变化，请关闭游戏后重试：${entry.path}`);
    }
    for (const child of entry.children) await verifyTree(child);
    assertSameEntry(entry.info, await lstat(entry.path), entry.path);
  }
}

async function copyFile(entry: SourceEntry, destination: string): Promise<BackupFileRecord> {
  assertSameEntry(entry.info, await lstat(entry.path), entry.path);
  const source = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assertSameEntry(entry.info, await source.stat(), entry.path);
    // A link replacement between lstat and open is rejected before any bytes are read.
    assertSameEntry(entry.info, await lstat(entry.path), entry.path);
    target = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error('备份磁盘未能写入文件。');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    assertSameEntry(entry.info, await source.stat(), entry.path);
    assertSameEntry(entry.info, await lstat(entry.path), entry.path);
    if (position !== entry.info.size) throw new BackupError('SOURCE_CHANGED', `备份文件长度发生变化：${entry.path}`);
    await target.sync();
    await target.close();
    target = undefined;
    await utimes(destination, entry.info.atime, entry.info.mtime);
    return { path: entry.relativePath.split(path.sep).join('/'), size: position, sha256: hash.digest('hex') };
  } finally {
    await target?.close().catch(() => undefined);
    await source.close();
  }
}

async function copyTree(entry: SourceEntry, destination: string, prefix: string, records: BackupFileRecord[]): Promise<void> {
  assertSameEntry(entry.info, await lstat(entry.path), entry.path);
  if (entry.children) {
    await mkdir(destination, { mode: 0o700 });
    for (const child of entry.children) await copyTree(child, path.join(destination, path.basename(child.path)), prefix, records);
    await utimes(destination, entry.info.atime, entry.info.mtime);
  } else {
    const file = await copyFile(entry, destination);
    records.push({ ...file, path: `${prefix}/${file.path}` });
  }
}

/**
 * Copy closed-world directories into a new, self-contained backup.
 * All links are rejected, originals are read-only, and only a completed staging directory is published.
 */
export async function backupDirectories(options: BackupDirectoriesOptions): Promise<string> {
  if (!Array.isArray(options.sources) || options.sources.length < 1 || options.sources.length > 30) {
    throw new BackupError('INVALID_SOURCES', '请提供 1–30 个需要备份的存档目录。');
  }
  const seenNames = new Set<string>();
  const sources: PreparedSource[] = [];
  for (const source of options.sources) {
    const name = directoryName(source.name);
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) throw new BackupError('DUPLICATE_SOURCE_NAME', '备份源名称不能重复。');
    seenNames.add(nameKey);
    if (typeof source.path !== 'string' || !path.isAbsolute(source.path) || source.path.includes('\0')) {
      throw new BackupError('INVALID_SOURCE', '存档来源必须是有效的绝对目录路径。');
    }
    const rootInfo = await lstat(source.path);
    if (rootInfo.isSymbolicLink()) throw new BackupError('SYMLINK_NOT_SUPPORTED', `备份源包含符号链接或目录联接，已停止：${source.path}`);
    if (!rootInfo.isDirectory()) throw new BackupError('INVALID_SOURCE', '存档备份来源必须是目录。');
    const physicalPath = await realpath(source.path);
    const tree = await inspectTree(physicalPath);
    assertSameEntry(rootInfo, tree.info, source.path);
    sources.push({ name, physicalPath, tree });
  }

  const destination = await physicalDestination(options.destination);
  if (sources.some(source => isWithin(source.physicalPath, destination))) {
    throw new BackupError('NESTED_DESTINATION', '备份目标不能位于原存档目录内部。');
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const physicalParent = await realpath(parent);
  if (!samePath(parent, physicalParent) || sources.some(source => isWithin(source.physicalPath, physicalParent))) {
    throw new BackupError('DESTINATION_CHANGED', '备份目标的父目录在准备过程中发生变化，已停止。');
  }
  if (await optionalLstat(destination)) throw new BackupError('DESTINATION_EXISTS', '备份目标已经存在，已停止以保护原有文件。');
  const staging = await mkdtemp(path.join(physicalParent, '.arcane-backup-staging-'));
  const stagingInfo = await lstat(staging);
  const records: BackupFileRecord[] = [];
  const manifest = {
    schemaVersion: 1,
    state: 'copying',
    createdAt: new Date().toISOString(),
    sources: sources.map(source => ({ name: source.name, originalPath: source.physicalPath })),
    files: records,
  };
  const writeManifest = async (state: 'copying' | 'complete' | 'failed', error?: string) => {
    assertSameEntry(stagingInfo, await lstat(staging), staging);
    if (!samePath(await realpath(staging), staging)) throw new BackupError('DESTINATION_CHANGED', '备份临时目录发生变化，已停止。');
    const temporary = path.join(staging, `${BACKUP_MANIFEST}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({
      ...manifest, state, ...(state === 'complete' ? { completedAt: new Date().toISOString() } : {}), ...(error ? { error } : {}),
    }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(staging, BACKUP_MANIFEST));
  };
  try {
    await writeManifest('copying');
    for (const source of sources) {
      await verifyTree(source.tree);
      await copyTree(source.tree, path.join(staging, source.name), source.name, records);
    }
    for (const source of sources) await verifyTree(source.tree);
    if (!samePath(await realpath(parent), physicalParent)) throw new BackupError('DESTINATION_CHANGED', '备份目标父目录发生变化，已停止。');
    if (await optionalLstat(destination)) throw new BackupError('DESTINATION_EXISTS', '备份目标刚刚被创建，已停止以保护原有文件。');
    await writeManifest('complete');
    await rename(staging, destination);
    return destination;
  } catch (cause) {
    await writeManifest('failed', cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
    // Only recursively remove the exact random staging directory this call created.
    const remaining = await optionalLstat(staging).catch(() => undefined);
    if (remaining && !remaining.isSymbolicLink() && remaining.isDirectory()
      && remaining.dev === stagingInfo.dev && remaining.ino === stagingInfo.ino
      && path.dirname(path.resolve(staging)) === path.resolve(physicalParent)
      && path.basename(staging).startsWith('.arcane-backup-staging-')
      && samePath(await realpath(staging).catch(() => ''), staging)) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    if (cause instanceof BackupError) throw cause;
    throw new BackupError('BACKUP_FAILED', `备份未完成：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
