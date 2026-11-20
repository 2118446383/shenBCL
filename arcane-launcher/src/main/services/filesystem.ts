import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export function stableId(value: string): string {
  const canonical = process.platform === 'win32' ? value.toLowerCase() : value;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 20);
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeChild(parent: string, relative: string): string {
  const candidate = path.resolve(parent, relative);
  if (!isWithin(parent, candidate)) throw new Error('文件路径超出了实例目录。');
  return candidate;
}

export async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

export async function directories(directory: string): Promise<string[]> {
  return readdir(directory, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name))
    .catch(() => []);
}

export async function readText(file: string, maximumBytes = 4 * 1024 * 1024): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximumBytes) throw new Error('配置文件大小异常，已跳过读取。');
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}

export async function readJson<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await readText(file)) as T;
}

export function safeVersionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 180 && !/[\\/\x00-\x1f]/.test(id) && id !== '.' && id !== '..';
}

export async function countEntries(directory: string, predicate: (name: string, isDirectory: boolean) => boolean): Promise<number> {
  return readdir(directory, { withFileTypes: true })
    .then(entries => entries.filter(entry => !entry.isSymbolicLink() && predicate(entry.name, entry.isDirectory())).length)
    .catch(() => 0);
}
