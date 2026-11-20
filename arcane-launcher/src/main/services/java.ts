import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JavaInstallation } from '../../shared/contracts';
import { directories, exists, stableId } from './filesystem';

const execFileAsync = promisify(execFile);

export function parseJavaVersion(output: string): { version: string; major: number; vendor: string; architecture: string } | undefined {
  const version = /^\s*java\.version\s*=\s*(\S+)/m.exec(output)?.[1]
    || /(?:openjdk|java)\s+(?:version\s+)?"?([\d][\w.+_-]*)/i.exec(output)?.[1];
  if (!version) return undefined;
  const numbers = version.split(/[._+-]/).map(Number);
  const major = numbers[0] === 1 ? numbers[1] : numbers[0];
  if (!Number.isFinite(major) || major < 6) return undefined;
  const vendor = /^\s*java\.vendor\s*=\s*(.+)$/m.exec(output)?.[1]?.trim()
    || (/Temurin|Adoptium/i.test(output) ? 'Eclipse Adoptium' : /Microsoft/i.test(output) ? 'Microsoft' : /Oracle/i.test(output) ? 'Oracle' : 'OpenJDK');
  const architecture = /^\s*os\.arch\s*=\s*(\S+)/m.exec(output)?.[1] || (/64-Bit/i.test(output) ? 'amd64' : '未知');
  return { version, major, vendor, architecture };
}

export async function probeJava(executable: string, source = '自定义'): Promise<JavaInstallation | undefined> {
  try {
    const resolved = await realpath(executable);
    const { stdout, stderr } = await execFileAsync(resolved, ['-XshowSettings:properties', '-version'], {
      windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8', shell: false,
    });
    const output = `${stdout}\n${stderr}`;
    const parsed = parseJavaVersion(output);
    const javaHome = /^\s*java\.home\s*=\s*(.+)$/m.exec(output)?.[1]?.trim();
    const canonicalCandidate = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : resolved;
    const canonicalPath = await exists(canonicalCandidate) ? await realpath(canonicalCandidate).catch(() => resolved) : resolved;
    return parsed ? { id: stableId(canonicalPath), path: canonicalPath, source, ...parsed } : undefined;
  } catch {
    return undefined;
  }
}

/** Detect well-known installations; no shell execution, registry mutation or installation. */
export async function detectJava(extraPaths: string[] = []): Promise<JavaInstallation[]> {
  const candidates = new Map<string, string>();
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const add = (candidate: string | undefined, source: string) => {
    if (!candidate) return;
    const absolute = path.resolve(candidate);
    candidates.set(absolute, source);
  };
  for (const candidate of extraPaths.slice(0, 30)) {
    add(candidate, '自定义');
    add(path.join(candidate, 'bin', executable), '自定义');
  }
  for (const variable of ['JAVA_HOME', 'JDK_HOME']) {
    const home = process.env[variable];
    if (home) add(path.join(home, 'bin', executable), variable);
  }
  for (const item of (process.env.PATH || '').split(path.delimiter)) if (item.trim()) add(path.join(item.replace(/^"|"$/g, ''), executable), '系统 PATH');
  const roots = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BellSoft'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Zulu'),
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium')] : []),
      ]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home'];
  for (const root of roots) {
    add(path.join(root, 'bin', executable), '常见安装目录');
    for (const name of (await directories(root)).slice(0, 40)) {
      if (/Microsoft$/i.test(root) && !/jdk|openjdk/i.test(name)) continue;
      add(path.join(root, name, 'bin', executable), '常见安装目录');
      add(path.join(root, name, 'Contents', 'Home', 'bin', executable), '常见安装目录');
    }
  }
  const present: { executable: string; source: string }[] = [];
  const seen = new Set<string>();
  for (const [candidate, source] of candidates) {
    if (!await exists(candidate)) continue;
    const resolved = await realpath(candidate).catch(() => candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    present.push({ executable: resolved, source });
  }
  const found: JavaInstallation[] = [];
  for (let start = 0; start < present.length; start += 4) {
    const batch = await Promise.all(present.slice(start, start + 4).map(candidate => probeJava(candidate.executable, candidate.source)));
    found.push(...batch.filter((java): java is JavaInstallation => !!java));
  }
  return [...new Map(found.map(java => [java.id, java])).values()].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}
