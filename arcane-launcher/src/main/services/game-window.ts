import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Version } from '@xmcl/core';

export interface GameWindowSize { width: number; height: number }
export const DEFAULT_GAME_WINDOW: Readonly<GameWindowSize> = { width: 1280, height: 720 };

/** Leave room for the frame and taskbar; logical units also fit DPI-scaled Java. */
export function gameWindowSize(workArea?: GameWindowSize): GameWindowSize {
  if (!workArea || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height) || workArea.width < 160 || workArea.height < 160) return { ...DEFAULT_GAME_WINDOW };
  const ratio = Math.min(1, (workArea.width - 64) / DEFAULT_GAME_WINDOW.width, (workArea.height - 96) / DEFAULT_GAME_WINDOW.height);
  return { width: Math.floor(DEFAULT_GAME_WINDOW.width * ratio), height: Math.floor(DEFAULT_GAME_WINDOW.height * ratio) };
}

/** Remove inherited window flags before asking XMCL to add one consistent size. */
export function withoutWindowArguments(args: Version.LaunchArgument[]): Version.LaunchArgument[] {
  let skipValue = false;
  const clean = (values: string[]): string[] => values.filter(value => {
    if (skipValue) { skipValue = false; if (!value.startsWith('--')) return false; }
    if (/^--(?:width|height)$/.test(value)) { skipValue = true; return false; }
    return !/^--(?:width|height)=/.test(value) && !/^--fullscreen(?:=.*)?$/.test(value);
  });
  const result: Version.LaunchArgument[] = [];
  for (const argument of args) {
    if (typeof argument === 'string') { if (clean([argument]).length) result.push(argument); }
    else {
      const values = clean(Array.isArray(argument.value) ? argument.value : [argument.value]);
      if (values.length) result.push({ ...argument, value: Array.isArray(argument.value) ? values : values[0] });
    }
  }
  return result;
}

/** Minecraft's saved overrides take priority over --width and --height. */
export function windowedOptions(source: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const values: Record<string, string> = { fullscreen: 'false', overrideWidth: '0', overrideHeight: '0' };
  const seen = new Set<string>();
  const lines = source.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '');
  const result: string[] = [];
  for (const line of lines) {
    const key = line.match(/^(?:\uFEFF)?(fullscreen|overrideWidth|overrideHeight):/)?.[1];
    if (!key) result.push(line);
    else if (!seen.has(key)) { result.push(`${line.startsWith('\uFEFF') ? '\uFEFF' : ''}${key}:${values[key]}`); seen.add(key); }
  }
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) result.push(`${key}:${value}`);
  return result.join(newline) + newline;
}

/** Called only on actual client launch, after preflight. Preserve a first backup. */
export async function prepareGameWindow(gameDirectory: string): Promise<void> {
  const target = path.join(gameDirectory, 'options.txt');
  const info = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)) throw new Error('无法安全调整游戏窗口：options.txt 不是正常配置文件。');
  const original = info ? await readFile(target, 'utf8') : '';
  let base = original;
  // Preserve pack defaults that YOSBR / Default Options would copy on first launch.
  if (!info) for (const template of ['config/yosbr/options.txt', 'config/defaultoptions/options.txt']) {
    const filename = path.join(gameDirectory, template);
    const templateInfo = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (!templateInfo) continue;
    if (!templateInfo.isFile() || templateInfo.isSymbolicLink() || templateInfo.size > 4 * 1024 * 1024) throw new Error('无法安全读取整合包的默认窗口配置。');
    base = await readFile(filename, 'utf8');
    break;
  }
  const updated = windowedOptions(base);
  if (updated === original) return;
  if (info) await writeFile(path.join(gameDirectory, 'options.txt.shenbcl-window.bak'), original, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const temporary = path.join(gameDirectory, `.shenbcl-window-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, updated, { flag: 'wx' });
    const current = await readFile(target, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    if (current !== original) throw new Error('游戏窗口配置刚被其他程序修改，请关闭该实例后重试。');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}
