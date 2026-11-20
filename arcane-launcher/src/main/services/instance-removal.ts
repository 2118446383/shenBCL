import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InstanceRemovalPreview, LauncherInstance } from '../../shared/contracts';
import { isWithin } from './filesystem';
import type { GameDirectoryUsage } from './game-process-probe';

function key(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function marker(directory: string, name: string): Promise<{ value: Record<string, unknown>; fingerprint: string } | undefined> {
  const filename = path.join(directory, name);
  const info = await lstat(filename).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16_384) return undefined;
  try {
    const content = await readFile(filename, 'utf8');
    const after = await lstat(filename);
    if (!after.isFile() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs) return undefined;
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, fingerprint: `${name}|${info.dev}|${info.ino}|${info.birthtimeMs}|${info.size}|${info.mtimeMs}|${createHash('sha256').update(content).digest('hex')}` }
      : undefined;
  } catch { return undefined; }
}

export interface InstanceRemovalPlan {
  instanceId: string;
  /** Present only for one independent, app-owned instance directory. */
  ownedPath?: string;
  jobId?: string;
  markerFingerprint?: string;
  identity?: { dev: number; ino: number; birthtimeMs: number };
}

/** External/shared Minecraft roots are only hidden from the library; never delete their files. */
export async function planInstanceRemoval(instance: LauncherInstance, instances: LauncherInstance[], managedRoot: string): Promise<InstanceRemovalPlan> {
  const plan: InstanceRemovalPlan = { instanceId: instance.id };
  if (instance.kind !== 'client' || !path.isAbsolute(instance.path) || !path.isAbsolute(managedRoot)) return plan;
  const target = path.resolve(instance.path);
  const root = path.resolve(managedRoot);
  if (key(path.dirname(target)) !== key(root) || !isWithin(target, instance.gameDirectory)) return plan;
  // One library entry must never remove another entry's shared versions, libraries or saves.
  if (instances.some(other => other.id !== instance.id && (isWithin(target, other.path) || isWithin(target, other.gameDirectory) || isWithin(other.gameDirectory, target)))) return plan;
  const [rootInfo, targetInfo] = await Promise.all([lstat(root).catch(() => undefined), lstat(target).catch(() => undefined)]);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !targetInfo?.isDirectory() || targetInfo.isSymbolicLink()) return plan;
  if (key(await realpath(root)) !== key(root) || key(await realpath(target)) !== key(target)) return plan;
  const realGame = await realpath(instance.gameDirectory).catch(() => undefined);
  if (!realGame || !isWithin(target, realGame)) return plan;
  const otherLocations = await Promise.all(instances.filter(other => other.id !== instance.id).map(async other => ({
    path: await realpath(other.path).catch(() => path.resolve(other.path)),
    gameDirectory: await realpath(other.gameDirectory).catch(() => path.resolve(other.gameDirectory)),
  })));
  if (otherLocations.some(other => isWithin(target, other.path) || isWithin(target, other.gameDirectory) || isWithin(other.gameDirectory, target))) return plan;
  const packExists = await lstat(path.join(target, '.arcane-modpack.json')).then(() => true, () => false);
  const pack = packExists ? await marker(target, '.arcane-modpack.json') : undefined;
  const vanilla = packExists ? undefined : await marker(target, '.arcane-installation.json');
  const selectedMarker = pack ?? vanilla;
  const record = selectedMarker?.value;
  if (record?.schemaVersion !== 1 || record.state !== 'complete' || record.versionId !== instance.versionId) return plan;
  return {
    ...plan, ownedPath: target, markerFingerprint: selectedMarker!.fingerprint,
    identity: { dev: targetInfo.dev, ino: targetInfo.ino, birthtimeMs: targetInfo.birthtimeMs },
    ...(pack && typeof record.jobId === 'string' && /^[a-f\d-]{36}$/i.test(record.jobId) ? { jobId: record.jobId } : {}),
  };
}

/** Validate immediately before permanent deletion; paths only originate from a confirmed private ticket. */
export async function deleteOwnedInstance(plan: InstanceRemovalPlan, instance: LauncherInstance, instances: LauncherInstance[], managedRoot: string, remove: (directory: string) => Promise<void>, checkProcess?: () => Promise<void>): Promise<void> {
  await checkProcess?.();
  const current = await planInstanceRemoval(instance, instances, managedRoot);
  if (plan.instanceId !== instance.id || !plan.ownedPath || current.ownedPath !== plan.ownedPath || !plan.markerFingerprint || plan.markerFingerprint !== current.markerFingerprint || !plan.identity || !current.identity
    || current.identity.dev !== plan.identity.dev || current.identity.ino !== plan.identity.ino || current.identity.birthtimeMs !== plan.identity.birthtimeMs) {
    throw new Error('实例目录或安装记录已经变化，请重新扫描后再删除。');
  }
  await remove(current.ownedPath);
}

export const INSTANCE_REMOVAL_TTL = 5 * 60_000;
export interface InstanceRemovalAuthorization {
  instanceId: string;
  instancePath: string;
  action: 'delete' | 'remove';
  plan: InstanceRemovalPlan;
  issuedAt: number;
  blockedReason?: string;
}

/** A renderer can confirm one prepared action; it cannot choose paths or turn list removal into deletion. */
export class InstanceRemovalTickets {
  private readonly tickets = new Map<string, InstanceRemovalAuthorization>();
  constructor(private readonly now: () => number = Date.now) {}
  prepare(instance: LauncherInstance, plan: InstanceRemovalPlan, usage: GameDirectoryUsage): InstanceRemovalPreview {
    const issuedAt = this.now();
    for (const [token, ticket] of this.tickets) if (issuedAt - ticket.issuedAt >= INSTANCE_REMOVAL_TTL || ticket.instanceId === instance.id) this.tickets.delete(token);
    while (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomUUID();
    const action = plan.ownedPath ? 'delete' : 'remove';
    const reason = usage === 'running' ? '此客户端仍在运行，请先关闭游戏后重试。'
      : usage === 'uncertain' ? '暂时无法确认游戏进程是否已退出，请关闭游戏和相关 Java 程序后重试。' : undefined;
    this.tickets.set(token, { instanceId: instance.id, instancePath: instance.path, action, plan: { ...plan, identity: plan.identity && { ...plan.identity } }, issuedAt, blockedReason: reason });
    return {
      token, name: instance.name, path: plan.ownedPath ?? instance.gameDirectory, action, blocked: !!reason,
      ...(reason ? { reason } : {}),
      warning: action === 'delete'
        ? '此操作会永久删除整个客户端，包括存档、模组、配置、截图和日志，无法从回收站恢复。请先备份重要文件。'
        : '此实例位于外部或共享游戏目录，只会从启动器列表中移除，不会删除游戏文件、模组或存档。以后可通过“导入目录”重新添加。',
    };
  }
  consume(token: unknown): InstanceRemovalAuthorization {
    if (typeof token !== 'string') throw new Error('删除确认已失效，请重新打开确认窗口。');
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || this.now() - ticket.issuedAt >= INSTANCE_REMOVAL_TTL) throw new Error('删除确认已失效，请重新打开确认窗口。');
    if (ticket.blockedReason) throw new Error(ticket.blockedReason);
    return ticket;
  }
}

/** Hidden IDs persist separately from player settings and are restored only by explicit import. */
export class HiddenInstanceRegistry {
  private ids = new Set<string>();
  private writes = Promise.resolve();
  constructor(private readonly filename: string) {}
  async load(): Promise<void> {
    const info = await lstat(this.filename).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      const record = parsed as { schemaVersion?: unknown; ids?: unknown };
      if (record.schemaVersion === 1 && Array.isArray(record.ids)) this.ids = new Set(record.ids.filter((id): id is string => typeof id === 'string' && /^[a-f\d]{20}$/.test(id)).slice(0, 10_000));
    } catch { /* A damaged library preference must not block the launcher. */ }
  }
  isHidden(id: string): boolean { return this.ids.has(id); }
  private change(change: (ids: Set<string>) => void): Promise<void> {
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = new Set(this.ids); change(next);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(this.filename), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ids: [...next] }), { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.filename);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.ids = next;
    });
    this.writes = operation;
    return operation;
  }
  hide(id: string): Promise<void> {
    if (!/^[a-f\d]{20}$/.test(id)) return Promise.reject(new Error('无效的实例标识。'));
    return this.change(ids => { ids.add(id); });
  }
  restore(ids: string[]): Promise<void> {
    if (!ids.some(id => this.ids.has(id))) return Promise.resolve();
    return this.change(next => { for (const id of ids) next.delete(id); });
  }
}
