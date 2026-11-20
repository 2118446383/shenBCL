import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { InstanceLog, LauncherInstance } from '../../shared/contracts';

const sensitiveKey = '(?:--)?(?:access[_-]?token|refresh[_-]?token|client[_-]?token|id[_-]?token|identity[_-]?token|session[_-]?token|xsts[_-]?token|xbox[_-]?token|device[_-]?code|client[_-]?secret|rps[_-]?ticket|api[_-]?key|authorization|password|passwd|token)';
const quotedSecret = new RegExp(`(${sensitiveKey}(?:["']?\\s*[:=]\\s*|\\s+))(["'])(.*?)\\2`, 'gi');
const unquotedSecret = new RegExp(`(${sensitiveKey}(?:["']?\\s*[:=]\\s*|\\s+)(?:Bearer\\s+)?)(?!["'])[^\\s,"'\\]}]+`, 'gi');

/** Keep game logs local and remove common credentials before exposing them to the UI. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(quotedSecret, '$1$2[已隐藏]$2')
    .replace(/(\bauthorization["']?\s*[:=]\s*)XBL3\.0\s+x=[^\s,"'\]}]+/gi, '$1[已隐藏]')
    .replace(/\bXBL3\.0\s+x=[^\s,"'\]}]+/gi, 'XBL3.0 [已隐藏]')
    .replace(unquotedSecret, '$1[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏的令牌]');
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function ordinaryDirectory(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch(() => undefined);
  return !!info?.isDirectory() && !info.isSymbolicLink()
    && samePath(await realpath(directory).catch(() => ''), directory);
}

function sameFile(expected: Stats, actual: Stats): boolean {
  // Windows path lstat and handle stat can report different dev values.
  const deviceMatches = process.platform === 'win32' && (!expected.dev || !actual.dev) || expected.dev === actual.dev;
  return actual.isFile() && !actual.isSymbolicLink() && deviceMatches && expected.ino === actual.ino;
}

export async function readInstanceLog(instance: LauncherInstance, maximumBytes = 192 * 1024): Promise<InstanceLog> {
  const root = await realpath(instance.gameDirectory).catch(() => undefined);
  const logDirectory = root && path.join(root, 'logs');
  const crashDirectory = root && path.join(root, 'crash-reports');
  const files = logDirectory && await ordinaryDirectory(logDirectory)
    ? [path.join(logDirectory, 'latest.log'), path.join(logDirectory, 'debug.log')] : [];
  const crashes = crashDirectory && await ordinaryDirectory(crashDirectory)
    ? await readdir(crashDirectory, { withFileTypes: true }).catch(() => []) : [];
  for (const crash of crashes.filter(file => file.isFile() && !file.isSymbolicLink() && /^crash-.*\.txt$/i.test(file.name)).slice(-20)) {
    files.push(path.join(crashDirectory!, crash.name));
  }
  const found = await Promise.all(files.map(async file => ({ file, info: await lstat(file).catch(() => undefined) })));
  const selected = found.filter(item => item.info?.isFile() && !item.info.isSymbolicLink()).sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs)[0];
  if (!selected?.info) return { found: false, path: '', content: '这个实例还没有日志。首次启动游戏或导入含 logs 目录的实例后，可以在这里查看。', truncated: false, redacted: false };
  const handle = await open(selected.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const current = await lstat(selected.file);
    if (!sameFile(selected.info, info) || !sameFile(info, current) || !await ordinaryDirectory(path.dirname(selected.file))) {
      throw new Error('日志文件或目录在读取过程中发生变化，请重试。');
    }
    const boundedBytes = Math.max(1024, Math.min(1024 * 1024, maximumBytes));
    const length = Math.min(info.size, boundedBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // A tail can begin in the middle of a UTF-8 codepoint or a log line.
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : text.replace(/^\uFFFD+/, '');
    }
    const content = redactSensitiveText(text);
    return { found: true, path: selected.file, content, updatedAt: info.mtime.toISOString(), truncated: start > 0, redacted: content !== text };
  } finally {
    await handle.close();
  }
}
