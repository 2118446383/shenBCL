import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModpackJob, ModpackPreview } from '../../shared/contracts';
import { installVanilla, INSTALLATION_MARKER, type InstallVanillaOptions } from './installer';
import { installNeoForge } from './loader-installer';
import { analyzeModpack, installModpackFiles, ModpackError, type ModpackAnalysis } from './modpack';
import { inspectClientResources } from './instances';
import { cloneInstallProgress, InstallProgressTracker, type MeasuredInstallProgress } from './install-progress';

export const MODPACK_MARKER = '.arcane-modpack.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface PrivateJob {
  schemaVersion: 1;
  job: ModpackJob;
  archivePath: string;
  archiveFingerprint: ModpackAnalysis['archiveFingerprint'];
  destination: string;
  minecraftVersion: string;
  loader: 'vanilla' | 'neoforge';
  loaderVersion?: string;
  requiredJavaMajor: number;
  versionId: string;
  completedStages: { vanilla: boolean; loader: boolean; files: boolean };
}
interface PreviewTicket { archivePath: string; analysis: ModpackAnalysis; createdAt: number }
export interface ModpackManagerOptions {
  instancesRoot: string;
  jobsRoot: string;
  fetch?: typeof globalThis.fetch;
  onChange?: (job: ModpackJob) => void;
  findJava: (major: number) => Promise<string | undefined>;
}
export interface ModpackManagerDependencies {
  analyzeModpack?: typeof analyzeModpack;
  installVanilla?: (options: InstallVanillaOptions & { resume?: boolean }, dependencies?: Parameters<typeof installVanilla>[1]) => ReturnType<typeof installVanilla>;
  installNeoForge?: typeof installNeoForge;
  installModpackFiles?: typeof installModpackFiles;
  validateInstance?: (destination: string, versionId: string) => Promise<string[]>;
}

/** Owns app-created install directories and durable jobs, never renderer paths. */
export class ModpackInstallManager {
  private readonly tickets = new Map<string, PreviewTicket>();
  private readonly records = new Map<string, PrivateJob>();
  private readonly active = new Map<string, AbortController>();
  private readonly changes = new Map<string, Promise<void>>();
  private initialization?: Promise<void>;
  private persistence = Promise.resolve();
  private instancesRoot = '';
  private jobsRoot = '';
  private busy = false;
  private lastSavedAt = 0;
  private readonly lastEmittedAt = new Map<string, number>();
  private readonly progressTrackers = new Map<string, InstallProgressTracker>();

  constructor(private readonly options: ModpackManagerOptions, private readonly dependencies: ModpackManagerDependencies = {}) {}

  private async ensureDirectory(directory: string): Promise<string> {
    if (!path.isAbsolute(directory)) throw new ModpackError('INVALID_DESTINATION', '整合包管理目录必须是绝对路径。');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ModpackError('INVALID_DESTINATION', '整合包管理目录不能是目录链接。');
    return realpath(directory);
  }
  private init(): Promise<void> {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }
  private async load(): Promise<void> {
    this.instancesRoot = await this.ensureDirectory(this.options.instancesRoot);
    this.jobsRoot = await this.ensureDirectory(this.options.jobsRoot);
    const names = (await readdir(this.jobsRoot)).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).slice(0, 500);
    for (const name of names) {
      const filename = path.join(this.jobsRoot, name);
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) continue;
        const raw: unknown = JSON.parse(await readFile(filename, 'utf8'));
        if (!this.validRecord(raw, name.slice(0, -5))) continue;
        // Network counters, rates and a current file belong to one live run only.
        // Rebuild from durable verified stage boundaries, including records from older versions.
        raw.job.progress = new InstallProgressTracker(raw.loader, raw.completedStages, undefined, raw.job.status === 'complete').progress;
        raw.job.archiveName = path.basename(raw.archivePath); raw.job.loaderVersion = raw.loaderVersion; raw.job.requiredJavaMajor = raw.requiredJavaMajor;
        this.records.set(raw.job.id, raw);
        if (raw.job.status === 'running') {
          raw.job.status = 'error'; raw.job.message = '上次安装被中断，可以继续安装并复用已校验文件。'; raw.job.updatedAt = new Date().toISOString();
          await this.save(raw); this.emit(raw);
        }
      } catch { /* Ignore unrelated or corrupt private job records. */ }
    }
  }
  private validRecord(value: unknown, id: string): value is PrivateJob {
    if (!value || typeof value !== 'object') return false;
    const record = value as PrivateJob;
    if (record.schemaVersion !== 1 || record.job?.id !== id || !UUID.test(id)) return false;
    if (!['running', 'cancelled', 'error', 'complete'].includes(record.job.status) || !['vanilla', 'loader', 'files', 'complete'].includes(record.job.phase)) return false;
    if (typeof record.job.name !== 'string' || !record.job.name || record.job.name.length > 60 || typeof record.job.message !== 'string' || record.job.message.length > 4_096) return false;
    if (!Number.isFinite(record.job.completed) || record.job.completed < 0 || record.job.completed > 100 || record.job.total !== 100) return false;
    if (typeof record.archivePath !== 'string' || !path.isAbsolute(record.archivePath) || typeof record.destination !== 'string' || path.dirname(path.resolve(record.destination)) !== this.instancesRoot) return false;
    if (typeof record.minecraftVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(record.minecraftVersion)) return false;
    if (!['vanilla', 'neoforge'].includes(record.loader) || typeof record.versionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,179}$/.test(record.versionId)) return false;
    if (record.loader === 'neoforge' && (typeof record.loaderVersion !== 'string' || !/^[\d.-]+(?:beta)?$/.test(record.loaderVersion))) return false;
    if (!Number.isInteger(record.requiredJavaMajor) || record.requiredJavaMajor < 8 || record.requiredJavaMajor > 100) return false;
    if (!record.archiveFingerprint || !Number.isSafeInteger(record.archiveFingerprint.size) || record.archiveFingerprint.size < 0 || !Number.isFinite(record.archiveFingerprint.mtimeMs)) return false;
    if (!record.completedStages || Object.values(record.completedStages).some(value => typeof value !== 'boolean')) return false;
    return ['vanilla', 'loader', 'files'].every(key => typeof record.completedStages[key as keyof PrivateJob['completedStages']] === 'boolean');
  }
  private emit(record: PrivateJob): void {
    this.lastEmittedAt.set(record.job.id, Date.now());
    try { this.options.onChange?.({ ...record.job, ...(record.job.progress ? { progress: cloneInstallProgress(record.job.progress) } : {}) }); } catch { /* A closed UI must not fail an install. */ }
  }
  private save(record: PrivateJob): Promise<void> {
    if (this.records.get(record.job.id) !== record) return Promise.resolve();
    const { progress: _transientProgress, ...durableJob } = record.job;
    const content = JSON.stringify({ ...record, job: durableJob }, null, 2);
    const id = record.job.id;
    const operation = this.persistence.catch(() => {}).then(async () => {
      const temporary = path.join(this.jobsRoot, `${id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, path.join(this.jobsRoot, `${id}.json`));
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.persistence = operation;
    return operation;
  }
  private update(record: PrivateJob, message: string, completed?: number, signal?: AbortSignal, force = false): void {
    if (signal?.aborted || record.job.status !== 'running' || this.records.get(record.job.id) !== record) return;
    record.job.message = message; record.job.updatedAt = new Date().toISOString();
    if (completed !== undefined) record.job.completed = Math.min(100, Math.max(0, Math.round(completed)));
    if (force || Date.now() - (this.lastEmittedAt.get(record.job.id) ?? 0) >= 200) this.emit(record);
    if (Date.now() - this.lastSavedAt >= 1_000) { this.lastSavedAt = Date.now(); void this.save(record).catch(() => {}); }
  }
  private measured(record: PrivateJob, tracker: InstallProgressTracker, stepId: string, message: string, measurement: MeasuredInstallProgress = {}, signal?: AbortSignal, source?: string): void {
    if (signal?.aborted || record.job.status !== 'running' || this.records.get(record.job.id) !== record) return;
    const previousStep = tracker.progress.activeStep;
    tracker.update(stepId, measurement, source);
    record.job.progress = tracker.progress;
    this.update(record, message, tracker.checklistPercent(), signal, previousStep !== stepId || measurement.phasePercent === 100);
  }
  private async checkedDestination(record: PrivateJob): Promise<boolean> {
    if (path.dirname(path.resolve(record.destination)) !== this.instancesRoot) throw new ModpackError('INVALID_DESTINATION', '安装记录中的实例位置无效。');
    const info = await lstat(record.destination).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(await realpath(record.destination)) !== this.instancesRoot) throw new ModpackError('INVALID_DESTINATION', '实例目录已被移动或替换为目录链接。');
    return true;
  }
  private async assertOwnedMarker(record: PrivateJob): Promise<void> {
    const readMarker = async (name: string): Promise<Record<string, unknown> | undefined> => {
      const filename = path.join(record.destination, name);
      const info = await lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (!info) return undefined;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new ModpackError('INVALID_DESTINATION', '实例安装记录已被替换，请重新导入为新实例。');
      try {
        const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch { /* Report a consistent ownership error below. */ }
      throw new ModpackError('INVALID_DESTINATION', '实例安装记录损坏，请重新导入为新实例。');
    };
    const modpack = await readMarker(MODPACK_MARKER);
    if (modpack) {
      if (modpack.schemaVersion === 1 && modpack.jobId === record.job.id && modpack.minecraftVersion === record.minecraftVersion) return;
    } else if (!record.completedStages.vanilla) {
      // A process can exit while the first vanilla stage is creating its directory,
      // before the manager gets a chance to write the pack-specific marker.
      const installation = await readMarker(INSTALLATION_MARKER);
      if (installation?.schemaVersion === 1 && installation.versionId === record.minecraftVersion && ['installing', 'failed', 'cancelled', 'complete'].includes(String(installation.state))) return;
    }
    throw new ModpackError('INVALID_DESTINATION', '原实例目录已被移动或替换，无法继续向此目录写入文件。请重新导入为新实例。');
  }
  private async marker(record: PrivateJob, state: 'installing' | 'complete' | 'error' | 'cancelled'): Promise<void> {
    if (!await this.checkedDestination(record)) return;
    const marker = path.join(record.destination, MODPACK_MARKER);
    const temporary = path.join(record.destination, `${MODPACK_MARKER}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, jobId: record.job.id, name: record.job.name, state, minecraftVersion: record.minecraftVersion, loader: record.loader, loaderVersion: record.loaderVersion, versionId: record.versionId, updatedAt: record.job.updatedAt }, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, marker);
  }
  private requireSupported(analysis: ModpackAnalysis): asserts analysis is ModpackAnalysis & { loader: 'vanilla' | 'neoforge' } {
    if (!['vanilla', 'neoforge'].includes(analysis.loader)) throw new ModpackError('UNSUPPORTED_LOADER', '当前支持原版与 NeoForge 整合包，Forge / Fabric / Quilt 的自动安装尚未接入。');
  }
  async inspect(archivePath: string): Promise<ModpackPreview> {
    await this.init();
    const source = await realpath(archivePath);
    const analysis = await (this.dependencies.analyzeModpack ?? analyzeModpack)(source);
    const id = randomUUID();
    for (const [key, ticket] of this.tickets) if (Date.now() - ticket.createdAt > 30 * 60_000) this.tickets.delete(key);
    if (this.tickets.size >= 16) this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(id, { archivePath: source, analysis, createdAt: Date.now() });
    const javaAvailable = !!await this.options.findJava(analysis.requiredJavaMajor);
    const sourceKey = process.platform === 'win32' ? source.toLowerCase() : source;
    const existing = [...this.records.values()].filter(record => record.job.status !== 'complete'
      && (process.platform === 'win32' ? record.archivePath.toLowerCase() : record.archivePath) === sourceKey
      && record.archiveFingerprint.size === analysis.archiveFingerprint.size
      && record.archiveFingerprint.mtimeMs === analysis.archiveFingerprint.mtimeMs
      && record.minecraftVersion === analysis.minecraftVersion && record.loader === analysis.loader
      && record.loaderVersion === analysis.loaderVersion).sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt))[0];
    return { id, name: analysis.name, archiveName: path.basename(source), format: analysis.format, version: analysis.versionId, minecraftVersion: analysis.minecraftVersion, loader: analysis.loader, loaderVersion: analysis.loaderVersion, requiredJavaMajor: analysis.requiredJavaMajor, javaAvailable, fileCount: analysis.fileCount, modCount: analysis.modCount, downloadBytes: analysis.downloadBytes, overrideBytes: analysis.overrideBytes, warnings: [...analysis.warnings], ...(existing ? { existingJobId: existing.job.id } : {}) };
  }
  async list(): Promise<ModpackJob[]> {
    await this.init();
    return [...this.records.values()].map(record => ({ ...record.job, ...(record.job.progress ? { progress: cloneInstallProgress(record.job.progress) } : {}) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private claim(): void {
    if (this.busy) throw new ModpackError('INSTALL_BUSY', '已有整合包安装任务正在运行，请等待或取消后继续。');
    this.busy = true;
  }
  async start(previewId: string, name: string): Promise<{ destination: string; versionId: string }> {
    this.claim();
    try {
      await this.init();
      const ticket = this.tickets.get(previewId);
      if (!ticket || Date.now() - ticket.createdAt > 30 * 60_000) throw new ModpackError('PREVIEW_EXPIRED', '整合包预览已失效，请重新选择压缩包。');
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (!cleanName || cleanName.length > 60 || /[<>:"/\\|?*\x00-\x1f]/.test(cleanName) || /[. ]$/.test(cleanName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleanName)) throw new ModpackError('INVALID_NAME', '请填写不超过 60 字的有效实例名称。');
      const analysis = await (this.dependencies.analyzeModpack ?? analyzeModpack)(ticket.archivePath);
      this.requireSupported(analysis);
      if (!this.sameArchive(ticket.analysis, analysis)) throw new ModpackError('ARCHIVE_CHANGED', '整合包在预览后发生变化，请重新选择。');
      const javaPath = await this.options.findJava(analysis.requiredJavaMajor);
      if (!javaPath) throw new ModpackError('JAVA_REQUIRED', `此整合包需要 Java ${analysis.requiredJavaMajor}，请先配置后再安装。`);
      const id = randomUUID();
      const job: ModpackJob = { id, name: cleanName, status: 'running', phase: 'vanilla', message: '准备安装 Minecraft 客户端', completed: 0, total: 100, minecraftVersion: analysis.minecraftVersion, loader: analysis.loader, archiveName: path.basename(ticket.archivePath), loaderVersion: analysis.loaderVersion, requiredJavaMajor: analysis.requiredJavaMajor, updatedAt: new Date().toISOString() };
      const record: PrivateJob = { schemaVersion: 1, job, archivePath: ticket.archivePath, archiveFingerprint: analysis.archiveFingerprint, destination: path.join(this.instancesRoot, `${cleanName}-${id.slice(0, 8)}`), minecraftVersion: analysis.minecraftVersion, loader: analysis.loader, loaderVersion: analysis.loaderVersion, requiredJavaMajor: analysis.requiredJavaMajor, versionId: analysis.minecraftVersion, completedStages: { vanilla: false, loader: false, files: false } };
      this.records.set(id, record); this.tickets.delete(previewId);
      return await this.run(record, javaPath, false);
    } finally { this.busy = false; }
  }
  private sameArchive(before: ModpackAnalysis, after: ModpackAnalysis): boolean {
    return before.archiveFingerprint.size === after.archiveFingerprint.size && before.archiveFingerprint.mtimeMs === after.archiveFingerprint.mtimeMs && before.minecraftVersion === after.minecraftVersion && before.loader === after.loader && before.loaderVersion === after.loaderVersion;
  }
  private async checkArchive(record: PrivateJob, signal?: AbortSignal): Promise<void> {
    const analysis = await (this.dependencies.analyzeModpack ?? analyzeModpack)(record.archivePath, { signal });
    this.requireSupported(analysis);
    if (analysis.archiveFingerprint.size !== record.archiveFingerprint.size || analysis.archiveFingerprint.mtimeMs !== record.archiveFingerprint.mtimeMs || analysis.minecraftVersion !== record.minecraftVersion || analysis.loader !== record.loader || analysis.loaderVersion !== record.loaderVersion) throw new ModpackError('ARCHIVE_CHANGED', '原整合包已发生变化，请作为新实例重新导入。');
  }
  async resume(jobId: string): Promise<{ destination: string; versionId: string }> {
    this.claim();
    let controller: AbortController | undefined;
    try {
      await this.init();
      if (this.changes.has(jobId)) throw new ModpackError('INSTALL_BUSY', '此任务正在取消或移除，请稍后继续。');
      const record = this.records.get(jobId);
      if (!record) throw new ModpackError('UNKNOWN_JOB', '找不到此整合包安装任务。');
      if (record.job.status === 'complete') {
        if (!await this.checkedDestination(record)) throw new ModpackError('MISSING_INSTANCE', '已安装的实例目录不存在。');
        await this.assertOwnedMarker(record);
        return { destination: record.destination, versionId: record.versionId };
      }
      controller = new AbortController(); this.active.set(jobId, controller);
      await this.checkArchive(record, controller.signal);
      if (controller.signal.aborted) throw new ModpackError('CANCELLED', '安装已取消，可以稍后继续。');
      const javaPath = await this.options.findJava(record.requiredJavaMajor);
      if (controller.signal.aborted) throw new ModpackError('CANCELLED', '安装已取消，可以稍后继续。');
      if (!javaPath) throw new ModpackError('JAVA_REQUIRED', `继续安装需要 Java ${record.requiredJavaMajor}，请先配置对应运行环境。`);
      return await this.run(record, javaPath, true, controller);
    } finally {
      if (controller && this.active.get(jobId) === controller) this.active.delete(jobId);
      this.busy = false;
    }
  }
  private changeJob(jobId: string, change: () => Promise<void>): Promise<void> {
    if (this.changes.has(jobId)) return Promise.reject(new ModpackError('INSTALL_BUSY', '此任务正在取消或移除，请稍后重试。'));
    const pending = (async () => { await this.init(); await change(); })();
    this.changes.set(jobId, pending);
    return pending.finally(() => { if (this.changes.get(jobId) === pending) this.changes.delete(jobId); });
  }
  cancel(jobId: string): Promise<void> {
    // Interrupt an active request synchronously, before disk persistence or init.
    this.active.get(jobId)?.abort(new ModpackError('CANCELLED', '安装已取消，可以稍后继续。'));
    return this.changeJob(jobId, async () => {
      const record = this.records.get(jobId);
      if (!record) throw new ModpackError('UNKNOWN_JOB', '找不到此整合包安装任务。');
      if (record.job.status === 'complete') return;
      this.active.get(jobId)?.abort(new ModpackError('CANCELLED', '安装已取消，可以稍后继续。'));
      record.job.status = 'cancelled'; record.job.updatedAt = new Date().toISOString();
      record.job.message = '安装已取消，已校验文件保留，可稍后继续。';
      this.progressTrackers.get(jobId)?.stop('cancelled');
      this.emit(record);
      await this.assertOwnedMarker(record).then(() => this.marker(record, 'cancelled')).catch(() => {});
      await this.save(record);
    });
  }
  dismiss(jobId: string): Promise<void> {
    return this.changeJob(jobId, async () => {
      if (this.active.has(jobId)) throw new ModpackError('INSTALL_BUSY', '安装仍在运行或停止中，请稍后移除记录。');
      const record = this.records.get(jobId);
      if (!record) throw new ModpackError('UNKNOWN_JOB', '找不到此整合包安装任务。');
      // Serialize after pending progress saves so a late write cannot recreate it.
      const removal = this.persistence.catch(() => {}).then(() => rm(path.join(this.jobsRoot, `${record.job.id}.json`), { force: true }));
      this.persistence = removal;
      await removal;
      this.records.delete(jobId);
      this.lastEmittedAt.delete(jobId);
    });
  }

  private async run(record: PrivateJob, javaPath: string, allowResume: boolean, controller = new AbortController()): Promise<{ destination: string; versionId: string }> {
    this.active.set(record.job.id, controller);
    const signal = controller.signal;
    let destinationOwned = false;
    const check = () => { if (signal.aborted) throw new ModpackError('CANCELLED', '安装已取消，可以稍后继续。'); };
    check();
    record.job.status = 'running'; record.job.updatedAt = new Date().toISOString();
    const tracker = new InstallProgressTracker(record.loader, record.completedStages);
    this.progressTrackers.set(record.job.id, tracker);
    record.job.progress = tracker.progress;
    record.job.completed = tracker.checklistPercent();
    const timer = setInterval(() => {
      if (record.job.status !== 'running' || signal.aborted || this.records.get(record.job.id) !== record) return;
      tracker.tick();
      if (Date.now() - (this.lastEmittedAt.get(record.job.id) ?? 0) >= 200) this.emit(record);
    }, 250);
    timer.unref();
    try {
      await this.save(record); this.emit(record);
      const exists = await this.checkedDestination(record);
      if (exists && !allowResume) throw new ModpackError('DESTINATION_EXISTS', '新实例目录已存在，已停止安装以保护现有文件。');
      if (record.completedStages.vanilla && !exists) throw new ModpackError('MISSING_INSTANCE', '已下载的实例目录不存在，请重新导入为新实例。');
      if (exists) await this.assertOwnedMarker(record);
      destinationOwned = true;
      await this.marker(record, 'installing'); check();
      if (!record.completedStages.vanilla) {
        record.job.phase = 'vanilla'; this.measured(record, tracker, 'vanilla-metadata', '正在安装 Minecraft 客户端', {}, signal); await this.save(record);
        await (this.dependencies.installVanilla ?? installVanilla)({ destination: record.destination, instancesRoot: this.instancesRoot, versionId: record.minecraftVersion, resume: exists, signal, onProgress: progress => {
          if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'error') return;
          const step = ['checking', 'manifest', 'version'].includes(progress.phase) ? 'vanilla-metadata' : `vanilla-${progress.phase}`;
          this.measured(record, tracker, step, progress.message, progress, signal);
        } }, { fetch: this.options.fetch });
        check(); await this.marker(record, 'installing');
        tracker.finishPrefix('vanilla-');
        record.completedStages.vanilla = true; await this.save(record);
      }
      if (!record.completedStages.loader) {
        check(); record.job.phase = 'loader'; this.measured(record, tracker, 'loader-installer', record.loader === 'neoforge' ? '正在安装 NeoForge 客户端加载器' : '原版无需额外加载器', {}, signal); await this.save(record);
        if (record.loader === 'neoforge') {
          const loader = await (this.dependencies.installNeoForge ?? installNeoForge)({ destination: record.destination, minecraftVersion: record.minecraftVersion, loaderVersion: record.loaderVersion!, javaPath, signal, onProgress: progress => {
            if (progress.phase === 'complete') return;
            const id = progress.stepId ?? (progress.phase === 'checking' ? 'installer' : progress.phase);
            this.measured(record, tracker, `loader-${id}`, progress.message, progress, signal, 'loader');
          } }, { fetch: this.options.fetch });
          record.versionId = loader.versionId;
        }
        tracker.finishPrefix('loader-');
        check(); record.completedStages.loader = true; await this.marker(record, 'installing'); await this.save(record);
      }
      if (!record.completedStages.files) {
        check(); record.job.phase = 'files'; this.measured(record, tracker, 'pack-downloads', '正在下载模组并导入整合包配置', {}, signal); await this.save(record);
        await this.checkArchive(record, signal); check();
        await (this.dependencies.installModpackFiles ?? installModpackFiles)({ archivePath: record.archivePath, destination: record.destination, expectedArchive: record.archiveFingerprint, signal, fetch: this.options.fetch, onProgress: progress => {
          if (progress.phase === 'complete') return;
          this.measured(record, tracker, progress.phase === 'extracting' ? 'pack-overrides' : 'pack-downloads', progress.message, {
            phasePercent: progress.phasePercent,
            completedFiles: progress.phaseCompletedFiles ?? progress.completedFiles,
            totalFiles: progress.phaseTotalFiles ?? progress.totalFiles,
            downloadedBytes: progress.phaseCompletedBytes ?? progress.downloadedBytes,
            totalBytes: progress.phaseTotalBytes ?? progress.totalBytes,
            transferredBytes: progress.transferredBytes,
            currentFile: progress.currentFile,
          }, signal, 'pack-files');
        } });
        tracker.finishPrefix('pack-');
        check(); record.completedStages.files = true; await this.save(record);
      }
      check();
      this.measured(record, tracker, 'verify', '正在校验客户端版本与依赖', {}, signal);
      const issues = await (this.dependencies.validateInstance ?? inspectClientResources)(record.destination, record.versionId);
      if (issues.length) {
        record.completedStages = { vanilla: false, loader: false, files: false };
        throw new ModpackError('INCOMPLETE_INSTANCE', `整合包基础文件检查未通过：${issues.slice(0, 2).join('；')}`);
      }
      check(); tracker.stop('complete'); record.job.status = 'complete'; record.job.phase = 'complete'; record.job.completed = 100; record.job.message = '整合包安装完成'; record.job.updatedAt = new Date().toISOString();
      await this.marker(record, 'complete'); await this.save(record); this.emit(record);
      return { destination: record.destination, versionId: record.versionId };
    } catch (error) {
      record.job.status = signal.aborted ? 'cancelled' : 'error'; record.job.updatedAt = new Date().toISOString();
      tracker.stop(record.job.status);
      record.job.message = signal.aborted ? '安装已取消，已校验文件保留，可稍后继续。' : error instanceof Error ? error.message : '安装未完成，可稍后重试。';
      if (destinationOwned) await this.assertOwnedMarker(record).then(() => this.marker(record, record.job.status as 'error' | 'cancelled')).catch(() => {});
      await this.save(record); this.emit(record);
      if (signal.aborted) throw new ModpackError('CANCELLED', record.job.message, { cause: error });
      throw error;
    } finally {
      clearInterval(timer);
      if (this.progressTrackers.get(record.job.id) === tracker) this.progressTrackers.delete(record.job.id);
      if (this.active.get(record.job.id) === controller) this.active.delete(record.job.id);
    }
  }
}
