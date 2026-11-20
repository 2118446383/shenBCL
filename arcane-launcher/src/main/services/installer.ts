import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createVanillaRuntime } from './vanilla-runtime';
import { fetchFromSources, validateDownloadUrl } from './download-sources';
import { MinecraftFolder, Version } from '@xmcl/core';
import {
  createDefaultNodeInstallRuntime,
  executeInstallManifest,
  getVersionList,
  ProgressTrackerMultiple,
  resolveAssetMetadataInstallManifest,
  resolveAssetObjectInstallFiles,
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  resolveMinecraftVersionJsonInstallFile,
  type DefaultNodeInstallRuntimeOptions,
  type InstallManifest,
  type InstallRuntime,
  type MinecraftVersion,
} from '@xmcl/installer';

export const DEFAULT_VANILLA_VERSION = '1.20.1';
export const OFFICIAL_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const INSTALLATION_MARKER = '.arcane-installation.json';

export type VanillaInstallPhase =
  | 'checking'
  | 'manifest'
  | 'version'
  | 'client'
  | 'libraries'
  | 'assets-index'
  | 'assets'
  | 'complete'
  | 'cancelled'
  | 'error';

export interface VanillaInstallProgress {
  versionId: string;
  destination: string;
  phase: VanillaInstallPhase;
  percent: number;
  message: string;
  downloadedBytes?: number;
  totalBytes?: number;
  completedFiles?: number;
  totalFiles?: number;
  /** Measured fraction of this phase, independent of the legacy overall estimate. */
  phasePercent?: number;
  /** Bytes received from network in this phase, including failed attempts; excludes cache hits. */
  transferredBytes?: number;
  currentFile?: string;
}

export interface InstallVanillaOptions {
  versionId?: string;
  destination: string;
  /** Existing parent directory controlled by the main process. */
  instancesRoot?: string;
  signal?: AbortSignal;
  /** Resume only an existing directory created and marked by this installer. */
  resume?: boolean;
  onProgress?: (progress: VanillaInstallProgress) => void;
  onError?: (error: VanillaInstallError) => void;
}

export interface VanillaInstallResult {
  versionId: string;
  destination: string;
  requiredJavaMajor: number;
  libraryCount: number;
  assetCount: number;
  installedAt: string;
}

export type VanillaInstallErrorCode =
  | 'INVALID_VERSION'
  | 'UNKNOWN_VERSION'
  | 'INVALID_DESTINATION'
  | 'DESTINATION_EXISTS'
  | 'DESTINATION_OUTSIDE_ROOT'
  | 'UNTRUSTED_DOWNLOAD'
  | 'UNSAFE_INSTALL_PLAN'
  | 'CANCELLED'
  | 'INSTALL_FAILED';

export class VanillaInstallError extends Error {
  constructor(
    public readonly code: VanillaInstallErrorCode,
    message: string,
    public readonly destination?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VanillaInstallError';
  }
}

export interface OfficialVanillaVersion extends MinecraftVersion {
  sha1?: string;
}

/** Dependency injection for deterministic tests; production callers use the defaults. */
export interface VanillaInstallerDependencies {
  fetch?: typeof globalThis.fetch;
  createRuntime?: (options: DefaultNodeInstallRuntimeOptions) => InstallRuntime;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VanillaInstallError('CANCELLED', '安装已取消。', undefined, { cause: signal.reason });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function validateVanillaVersionId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 100
    || value.trim() !== value
    || value === '.'
    || value === '..'
    || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  ) {
    throw new VanillaInstallError('INVALID_VERSION', '游戏版本号格式无效，请选择官方 Minecraft 版本。');
  }
  return value;
}

function requireOfficialUrl(value: string): string {
  try {
    return validateDownloadUrl(value, 'vanilla-metadata');
  } catch {
    throw new VanillaInstallError('UNTRUSTED_DOWNLOAD', '安装清单包含非官方或不安全的下载地址，已停止安装。');
  }
}

/** Resolve an exact, path-safe ID from Mojang's manifest; no custom URLs or loader IDs. */
export async function resolveOfficialVanillaVersion(
  versionId: string = DEFAULT_VANILLA_VERSION,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<OfficialVanillaVersion> {
  const id = validateVanillaVersionId(versionId);
  throwIfAborted(options.signal);
  const request = options.fetch ?? globalThis.fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const manifest = await getVersionList({
    remote: OFFICIAL_VERSION_MANIFEST,
    signal,
    fetch: async (url, init) => {
      requireOfficialUrl(url);
      const response = await fetchFromSources(url, { purpose: 'vanilla-metadata', request, signal, init });
      if (!response.ok) throw new Error(`Mojang 版本清单请求失败（HTTP ${response.status}）。`);
      return response;
    },
  });
  throwIfAborted(options.signal);
  if (!manifest || !Array.isArray(manifest.versions)) {
    throw new Error('Mojang 返回的版本清单格式无效。');
  }
  const selected = manifest.versions.find(version => version && version.id === id) as OfficialVanillaVersion | undefined;
  if (!selected) {
    throw new VanillaInstallError('UNKNOWN_VERSION', `官方版本清单中没有“${id}”，请选择原版版本号。`);
  }
  if (typeof selected.url !== 'string') throw new Error('官方版本清单缺少版本下载地址。');
  requireOfficialUrl(selected.url);
  if (selected.sha1 !== undefined && !/^[a-f0-9]{40}$/i.test(selected.sha1)) {
    throw new Error('官方版本清单中的校验值无效。');
  }
  return selected;
}

/** Read-only guard: the destination must be new, absolute, and inside the allowed root. */
export async function assertFreshInstallDestination(destination: string, instancesRoot?: string): Promise<string> {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new VanillaInstallError('INVALID_DESTINATION', '安装目录必须是主进程指定的绝对路径。');
  }
  const target = path.resolve(destination);
  const existing = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    throw new VanillaInstallError('DESTINATION_EXISTS', '目标目录已经存在，请为新实例选择一个新的目录。', target);
  }
  let parent: string;
  try {
    parent = await realpath(path.dirname(target));
    if (!(await lstat(parent)).isDirectory()) throw new Error('Not a directory');
  } catch (cause) {
    throw new VanillaInstallError('INVALID_DESTINATION', '安装目录的父目录不存在或不可访问。', target, { cause });
  }
  const physicalTarget = path.join(parent, path.basename(target));
  if (instancesRoot) {
    let root: string;
    try {
      root = await realpath(instancesRoot);
      if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory');
    } catch (cause) {
      throw new VanillaInstallError('INVALID_DESTINATION', '实例根目录不存在或不可访问。', target, { cause });
    }
    if (!isWithin(root, physicalTarget)) {
      throw new VanillaInstallError('DESTINATION_OUTSIDE_ROOT', '安装目录必须位于启动器的实例根目录内。', target);
    }
  }
  return physicalTarget;
}

async function assertResumeDestination(destination: string, versionId: string, instancesRoot?: string): Promise<string> {
  if (!path.isAbsolute(destination) || !instancesRoot || !path.isAbsolute(instancesRoot)) throw new VanillaInstallError('INVALID_DESTINATION', '继续安装需要启动器管理的实例目录。');
  const target = path.resolve(destination);
  const info = await lstat(target);
  const root = await realpath(instancesRoot);
  const physical = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(root, physical)) throw new VanillaInstallError('DESTINATION_OUTSIDE_ROOT', '继续安装的目录不在启动器实例库中。');
  const markerPath = path.join(target, INSTALLATION_MARKER);
  const markerInfo = await lstat(markerPath).catch(() => undefined);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16_384) throw new VanillaInstallError('INVALID_DESTINATION', '此目录没有有效的启动器安装记录，不能继续安装。');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.schemaVersion !== 1 || marker.versionId !== versionId || !['installing', 'failed', 'cancelled', 'complete'].includes(marker.state)) throw new VanillaInstallError('INVALID_DESTINATION', '安装记录与所选版本不一致。');
  let entries = 0;
  async function inspect(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 200_000) throw new VanillaInstallError('INVALID_DESTINATION', '安装目录文件数量异常。');
      const child = path.join(directory, item.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink() || (!childInfo.isFile() && !childInfo.isDirectory())) throw new VanillaInstallError('INVALID_DESTINATION', '安装目录包含目录联接或特殊文件，请使用新实例。');
      if (childInfo.isDirectory()) await inspect(child);
    }
  }
  await inspect(physical);
  return physical;
}

function assertSafeManifest(manifest: InstallManifest, destination: string): void {
  const checkPath = (value: string) => {
    if (!path.isAbsolute(value) || !isWithin(destination, path.resolve(value))) {
      throw new VanillaInstallError('UNSAFE_INSTALL_PLAN', '安装任务试图写入实例目录以外的位置。', destination);
    }
  };
  for (const task of manifest.tasks) {
    if (task.type === 'java') {
      throw new VanillaInstallError('UNSAFE_INSTALL_PLAN', '原版安装不应执行外部 Java 安装任务。', destination);
    }
    if (task.type === 'files') {
      for (const file of task.files) {
        checkPath(file.path);
        if (file.urls.length === 0) throw new Error('安装文件缺少下载地址。');
        file.urls.forEach(requireOfficialUrl);
      }
    } else {
      for (const operation of task.operations) {
        checkPath(operation.path);
        if ('source' in operation) checkPath(operation.source);
        if ('archive' in operation) checkPath(operation.archive);
        if (operation.type === 'merge-zip') operation.archives.forEach(checkPath);
      }
      for (const output of task.outputs) checkPath(output.path);
    }
  }
}

function notify<T>(listener: ((value: T) => void) | undefined, value: T): void {
  try { listener?.(value); } catch { /* UI listeners must not corrupt an installation. */ }
}

function installationError(cause: unknown, signal: AbortSignal | undefined, destination: string): VanillaInstallError {
  if (cause instanceof VanillaInstallError) return cause;
  if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
    return new VanillaInstallError('CANCELLED', '安装已取消，已下载的文件保留在新实例目录中。', destination, { cause });
  }
  const detail = cause instanceof AggregateError
    ? cause.errors.map(error => error instanceof Error ? error.message : String(error)).slice(0, 2).join('；')
    : cause instanceof Error ? cause.message : String(cause);
  return new VanillaInstallError('INSTALL_FAILED', `原版安装失败：${detail}`, destination, { cause });
}

export async function installVanilla(
  options: InstallVanillaOptions,
  dependencies: VanillaInstallerDependencies = {},
): Promise<VanillaInstallResult> {
  let versionId = DEFAULT_VANILLA_VERSION;
  let destination = options.destination;
  let createdDestination = false;
  let resuming = false;
  let lastPercent = 0;
  const emit = (phase: VanillaInstallPhase, percent: number, message: string, extra: Partial<VanillaInstallProgress> = {}) => {
    lastPercent = Math.max(lastPercent, Math.min(100, Math.round(percent)));
    notify(options.onProgress, { versionId, destination, phase, percent: lastPercent, message, ...extra });
  };
  const writeMarker = async (state: 'installing' | 'complete' | 'failed' | 'cancelled', error?: string) => {
    await writeFile(path.join(destination, INSTALLATION_MARKER), JSON.stringify({
      schemaVersion: 1,
      versionId,
      state,
      updatedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    }, null, 2), { encoding: 'utf8', flag: 'w' });
  };
  try {
    versionId = validateVanillaVersionId(options.versionId ?? DEFAULT_VANILLA_VERSION);
    throwIfAborted(options.signal);
    emit('checking', 0, '检查新实例目录');
    if (options.resume && await lstat(destination).catch(() => undefined)) {
      destination = await assertResumeDestination(destination, versionId, options.instancesRoot);
      resuming = true;
      createdDestination = true;
    } else destination = await assertFreshInstallDestination(destination, options.instancesRoot);
    emit('manifest', 2, '正在读取 Mojang 官方版本清单');
    const official = await resolveOfficialVanillaVersion(versionId, {
      signal: options.signal,
      fetch: dependencies.fetch,
    });
    throwIfAborted(options.signal);
    // Atomic, non-recursive mkdir closes the check/create race without overwriting a directory.
    try {
      if (!resuming) await mkdir(destination);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VanillaInstallError('DESTINATION_EXISTS', '目标目录刚刚被创建，已停止安装以保护现有文件。', destination, { cause });
      }
      throw cause;
    }
    createdDestination = true;
    await writeMarker('installing');
    const folder = MinecraftFolder.from(destination);

    const executeStage = async (
      phase: VanillaInstallPhase,
      start: number,
      end: number,
      message: string,
      manifest: InstallManifest,
    ) => {
      throwIfAborted(options.signal);
      assertSafeManifest(manifest, destination);
      // Resuming must verify content, including SDK assets with size-only hints.
      for (const task of manifest.tasks) if (task.type === 'files') for (const file of task.files) {
        file.trustExistingSize = false;
        file.validatedAt = undefined;
      }
      const tracker = new ProgressTrackerMultiple();
      const runtimeOptions: DefaultNodeInstallRuntimeOptions = {
        signal: options.signal,
        tracker,
        maxConcurrency: 6,
      };
      let transferredBytes: number | undefined;
      let currentFile: string | undefined;
      const runtime = dependencies.createRuntime ? dependencies.createRuntime(runtimeOptions) : createVanillaRuntime(runtimeOptions, dependencies.fetch ?? fetch, {}, progress => {
        transferredBytes = progress.transferredBytes;
        currentFile = path.relative(destination, progress.currentFile).replaceAll('\\', '/');
      });
      const files = manifest.tasks.flatMap(task => task.type === 'files' ? task.files : []);
      const expectedBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
      const knownBytes = files.every(file => file.size !== undefined && file.size >= 0);
      const update = () => {
        const totalBytes = Math.max(expectedBytes, tracker.total);
        const downloadedBytes = Math.min(totalBytes || Number.MAX_SAFE_INTEGER, tracker.progress);
        const completedFiles = tracker.trackers.filter(file => file.done).length;
        const ratio = knownBytes && totalBytes > 0 ? Math.max(0, Math.min(1, downloadedBytes / totalBytes)) : completedFiles / Math.max(1, files.length);
        emit(phase, start + (end - start) * ratio, message, {
          downloadedBytes,
          totalBytes: knownBytes ? totalBytes : undefined,
          completedFiles,
          totalFiles: files.length,
          phasePercent: Math.min(99.9, ratio * 100),
          transferredBytes,
          currentFile,
        });
      };
      emit(phase, start, message, { phasePercent: 0, completedFiles: 0, totalFiles: files.length, totalBytes: knownBytes ? expectedBytes : undefined });
      const timer = setInterval(update, 200);
      timer.unref();
      try {
        await executeInstallManifest(manifest, runtime, {
          signal: options.signal,
          attempts: 3,
          retryBaseDelay: 500,
          retryMaxDelay: 5_000,
          onEvent: event => {
            if (event.type === 'file-retry') {
              emit(phase, lastPercent, `${message}，正在重试（第 ${event.attempt} 次）`);
            }
          },
        });
        throwIfAborted(options.signal);
        emit(phase, end, message, { phasePercent: 100, completedFiles: files.length, totalFiles: files.length, downloadedBytes: knownBytes ? expectedBytes : tracker.progress, totalBytes: knownBytes ? expectedBytes : undefined, transferredBytes });
      } finally {
        clearInterval(timer);
      }
    };

    const metadataFile = resolveMinecraftVersionJsonInstallFile(official, folder);
    if (official.sha1) metadataFile.checksum = { algorithm: 'sha1', value: official.sha1 };
    await executeStage('version', 5, 12, '下载并校验游戏版本信息', {
      schemaVersion: 1,
      tasks: [{ id: 'vanilla-version-json', type: 'files', files: [metadataFile] }],
    });
    const version = await Version.parse(folder, versionId);
    if (version.id !== versionId || version.inheritances.some(id => id !== versionId)) {
      throw new VanillaInstallError('INVALID_VERSION', '官方版本信息包含意外的版本继承关系。', destination);
    }
    const clientJar = resolveMinecraftJarInstallFile(version, { side: 'client' });
    if (!clientJar) throw new Error('该官方版本没有可安装的客户端文件。');
    // XMCL otherwise appends Maven Central as a fallback. Vanilla installs use
    // only the official URL in Mojang metadata (or the official library host).
    const libraryFiles = resolveLibraryInstallFiles(version.libraries, folder, {
      libraryHost: library => [requireOfficialUrl(library.download.url
        || new URL(library.download.path, 'https://libraries.minecraft.net/').href)],
    });
    await executeStage('client', 12, 28, '下载并校验 Minecraft 游戏本体', {
      schemaVersion: 1,
      tasks: [{ id: 'vanilla-client', type: 'files', files: [clientJar] }],
    });
    await executeStage('libraries', 28, 52, '下载并校验游戏依赖库', {
      schemaVersion: 1,
      tasks: [{ id: 'vanilla-libraries', type: 'files', files: libraryFiles }],
    });
    await executeStage('assets-index', 52, 57, '下载资源索引与日志配置', resolveAssetMetadataInstallManifest(version, folder));
    const assetFiles = await resolveAssetObjectInstallFiles(version, folder);
    await executeStage('assets', 57, 99, '下载并校验游戏资源', {
      schemaVersion: 1,
      tasks: [{ id: 'vanilla-assets', type: 'files', files: assetFiles }],
    });
    await writeMarker('complete');
    const result: VanillaInstallResult = {
      versionId,
      destination,
      requiredJavaMajor: version.javaVersion.majorVersion,
      libraryCount: libraryFiles.length,
      assetCount: assetFiles.length,
      installedAt: new Date().toISOString(),
    };
    emit('complete', 100, `Minecraft ${versionId} 已安装完成`);
    return result;
  } catch (cause) {
    const error = installationError(cause, options.signal, destination);
    if (createdDestination) {
      await writeMarker(error.code === 'CANCELLED' ? 'cancelled' : 'failed', error.message).catch(() => undefined);
    }
    emit(error.code === 'CANCELLED' ? 'cancelled' : 'error', lastPercent, error.message);
    notify(options.onError, error);
    throw error;
  }
}

