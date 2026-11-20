import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Only dated Minecraft/Forge archives are managed; current logs and crash reports are untouched. */
export const LOG_ARCHIVE_RETENTION = Object.freeze({ maximumFiles: 10, maximumAgeDays: 14, maximumBytes: 100 * 1024 * 1024 });

export interface LogArchiveRetentionResult { removedFiles: number; removedBytes: number; retainedFiles: number; retainedBytes: number }

/** Minecraft's dated rolling archive names, including the older underscore separator. */
export function isStandardLogArchive(name: string): boolean {
  const match = /^(?:debug-)?(\d{4})-(\d{2})-(\d{2})[-_]([1-9]\d*)\.log\.gz$/i.exec(name);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2009 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function canonical(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function plainDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() && canonical(await realpath(directory)) === canonical(directory);
  } catch { return false; }
}

/**
 * Call only while this instance is stopped, immediately before launching it or after it exits.
 * Refuse directory junctions/symlinks, and never recurse into game folders or touch unknown logs.
 * Cleanup failures cannot prevent a game launch; locked/changed archives remain for the next run.
 */
export async function pruneInstanceLogArchives(gameDirectory: string, now = Date.now()): Promise<LogArchiveRetentionResult> {
  const result: LogArchiveRetentionResult = { removedFiles: 0, removedBytes: 0, retainedFiles: 0, retainedBytes: 0 };
  if (!Number.isFinite(now) || !path.isAbsolute(gameDirectory) || !await plainDirectory(gameDirectory)) return result;
  const logDirectory = path.join(gameDirectory, 'logs');
  if (!await plainDirectory(logDirectory)) return result;
  const entries = await readdir(logDirectory, { withFileTypes: true }).catch(() => []);
  const archives = (await Promise.all(entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && isStandardLogArchive(entry.name)).map(async entry => {
    const file = path.join(logDirectory, entry.name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || canonical(await realpath(file)) !== canonical(file)) return undefined;
      return { file, info };
    } catch { return undefined; }
  }))).filter(item => item !== undefined).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.file.localeCompare(a.file));
  const cutoff = now - LOG_ARCHIVE_RETENTION.maximumAgeDays * 24 * 60 * 60 * 1000;
  for (const archive of archives) {
    const overLimit = archive.info.mtimeMs < cutoff
      || result.retainedFiles >= LOG_ARCHIVE_RETENTION.maximumFiles
      || result.retainedBytes + archive.info.size > LOG_ARCHIVE_RETENTION.maximumBytes;
    let removed = false;
    if (overLimit && await plainDirectory(gameDirectory) && await plainDirectory(logDirectory)) {
      try {
        const current = await lstat(archive.file);
        // An archive replaced or written since enumeration may still belong to an active writer.
        if (current.isFile() && !current.isSymbolicLink() && current.dev === archive.info.dev && current.ino === archive.info.ino
          && current.mtimeMs === archive.info.mtimeMs && current.size === archive.info.size
          && canonical(await realpath(archive.file)) === canonical(archive.file)) {
          await unlink(archive.file);
          result.removedFiles++; result.removedBytes += archive.info.size; removed = true;
        }
      } catch { /* Best effort: leave locked archives for a later stopped-instance cleanup. */ }
    }
    if (!removed) { result.retainedFiles++; result.retainedBytes += archive.info.size; }
  }
  return result;
}
