import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export type GameDirectoryUsage = 'clear' | 'running' | 'uncertain';
export interface JavaGameDirectories { directories: string[]; uncertain: boolean }

const execute = promisify(execFile);
// Fixed query only. Never interpolate renderer values, persist or report the raw command lines:
// Minecraft's arguments can contain account credentials.
const PROCESS_QUERY = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$rows=@(Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'java.exe' OR Name = 'javaw.exe'\" -ErrorAction Stop | Select-Object ProcessId,CommandLine);ConvertTo-Json -InputObject $rows -Compress -Depth 3";

function windowsArguments(command: string): string[] | undefined {
  if (command.includes('\0')) return undefined;
  const args: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '') && index < command.length) index++;
    if (index >= command.length) break;
    let argument = '', quoted = false;
    while (index < command.length) {
      const character = command[index];
      if (!quoted && /\s/.test(character)) break;
      if (character === '\\') {
        let count = 0;
        while (command[index] === '\\') { count++; index++; }
        if (command[index] === '"') {
          argument += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) { argument += '"'; index++; }
          else if (quoted && command[index + 1] === '"') { argument += '"'; index += 2; }
          else { quoted = !quoted; index++; }
        } else argument += '\\'.repeat(count);
      } else if (character === '"') {
        if (quoted && command[index + 1] === '"') { argument += '"'; index += 2; }
        else { quoted = !quoted; index++; }
      } else { argument += character; index++; }
    }
    if (quoted) return undefined;
    args.push(argument);
  }
  return args;
}

/** No drive-relative paths: a Java working directory is unavailable to this read-only probe. */
export function normalizeWindowsGameDirectory(value: string): string | undefined {
  let normalized = value;
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/i.test(normalized)) normalized = normalized.slice(4);
  if (/^\\\\[.?]\\/.test(normalized)) return undefined;
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(normalized) || /[\0-\x1f"<>|?*]/.test(normalized)) return undefined;
  normalized = path.win32.normalize(normalized).toLowerCase();
  const root = path.win32.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
}

/** Discard every argument except absolute game directories before returning to callers. */
export function parseJavaGameDirectories(output: string): JavaGameDirectories {
  const result: JavaGameDirectories = { directories: [], uncertain: false };
  try {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : undefined;
    if (!rows || rows.length > 2_048) return { directories: [], uncertain: true };
    for (const row of rows) {
      if (!row || typeof row !== 'object') { result.uncertain = true; continue; }
      const record = row as { ProcessId?: unknown; CommandLine?: unknown };
      if (!Number.isSafeInteger(record.ProcessId) || Number(record.ProcessId) < 1 || typeof record.CommandLine !== 'string' || !record.CommandLine || record.CommandLine.length > 32_768) {
        result.uncertain = true; continue;
      }
      const args = windowsArguments(record.CommandLine);
      if (!args) { result.uncertain = true; continue; }
      const values: string[] = [];
      let incomplete = false;
      for (let index = 1; index < args.length; index++) {
        const argument = args[index];
        if (argument.toLowerCase() === '--gamedir') {
          const value = args[++index];
          if (!value || value.startsWith('--')) incomplete = true;
          else values.push(value);
        } else if (argument.toLowerCase().startsWith('--gamedir=')) values.push(argument.slice(10));
        // Java @argument files can contain an overriding game directory; do not open them.
        else if (argument.startsWith('@')) incomplete = true;
      }
      const directory = values.length === 1 ? normalizeWindowsGameDirectory(values[0]) : undefined;
      // A Java process without a readable game directory cannot be ruled out as this game.
      if (incomplete || !directory) result.uncertain = true;
      if (directory) result.directories.push(directory);
    }
    result.directories = [...new Set(result.directories)];
    return result;
  } catch { return { directories: [], uncertain: true }; }
}

export function assessGameDirectoryUsage(parsed: JavaGameDirectories, directories: string[]): GameDirectoryUsage {
  if (!directories.length) return 'uncertain';
  const targets = directories.map(normalizeWindowsGameDirectory);
  if (targets.some(target => !target)) return 'uncertain';
  for (const gameDirectory of parsed.directories) for (const target of targets) {
    const relative = path.win32.relative(target!, gameDirectory);
    if (!relative || relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)) return 'running';
  }
  return parsed.uncertain ? 'uncertain' : 'clear';
}

interface ProbeDependencies {
  platform?: string;
  query?: () => Promise<string>;
  canonicalize?: (directory: string) => Promise<string>;
}

/** Read-only Windows process inspection, including games launched before this app session. */
export async function probeGameDirectoryUsage(directories: string[], dependencies: ProbeDependencies = {}): Promise<GameDirectoryUsage> {
  if ((dependencies.platform ?? process.platform) !== 'win32') return 'uncertain';
  try {
    const query = dependencies.query ?? (async () => {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], { windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
      return result.stdout;
    });
    const parsed = parseJavaGameDirectories(await query());
    const immediate = assessGameDirectoryUsage(parsed, directories);
    if (immediate === 'running') return immediate;
    const canonicalize = dependencies.canonicalize ?? realpath;
    let uncertain = parsed.uncertain;
    const canonical = async (directory: string) => {
      try { return await canonicalize(directory); } catch { uncertain = true; return directory; }
    };
    const [games, targets] = await Promise.all([Promise.all(parsed.directories.map(canonical)), Promise.all(directories.map(canonical))]);
    const normalizedGames = games.map(normalizeWindowsGameDirectory);
    return assessGameDirectoryUsage({ directories: normalizedGames.filter((value): value is string => !!value), uncertain: uncertain || normalizedGames.some(value => !value) }, targets);
  } catch {
    // execFile errors can contain its stdout/stderr and secrets; never forward the error.
    return 'uncertain';
  }
}
