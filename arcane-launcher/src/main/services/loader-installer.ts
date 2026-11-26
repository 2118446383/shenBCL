import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MinecraftFolder, Version } from '@xmcl/core';
import {
  createModernForgeInstallWorkflow,
  createNodeInstallRuntime,
  executeInstallManifest,
  resolveNeoForgedInstallerFile,
  runInstallWorkflow,
  type InstallFile,
  type InstallForgeOptions,
  type InstallManifest,
  type InstallRuntime,
  type JavaCommand,
  type NodeInstallRuntimeOptions,
} from '@xmcl/installer';
import { cleanJavaEnvironment, probeJava } from './java';
import { inspectClientResources, javaRequirement, neoForgeMetadataVersions } from './instances';
import { requireSuccessfulDownload, withNetworkRetry, type NetworkRetryOptions } from './vanilla-runtime';
import { fetchFromSources, getDownloadSource, resolveDownloadSources, validateDownloadUrl } from './download-sources';

export interface LoaderInstallProgress {
  phase: 'checking' | 'installer' | 'materialize' | 'libraries' | 'processors' | 'complete';
  percent: number;
  message: string;
  completedFiles?: number;
  totalFiles?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  phasePercent?: number;
  stepId?: 'installer' | 'materialize' | 'libraries' | 'processors' | 'runtime-libraries';
  transferredBytes?: number;
  currentFile?: string;
  completedTasks?: number;
  totalTasks?: number;
}

export interface InstallNeoForgeOptions {
  destination: string;
  minecraftVersion: string;
  loaderVersion: string;
  javaPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: LoaderInstallProgress) => void;
}

export interface LoaderInstallerDependencies {
  fetch?: typeof fetch;
  probeJava?: typeof probeJava;
  /** Tests may replace effects while still using the real SDK workflow parser. */
  createRuntime?: (options: NodeInstallRuntimeOptions) => InstallRuntime;
  retryWait?: NetworkRetryOptions['wait'];
}

export class LoaderInstallError extends Error {
  constructor(public readonly code: 'INVALID_VERSION' | 'INVALID_DESTINATION' | 'JAVA_REQUIRED' | 'UNTRUSTED_DOWNLOAD' | 'UNSAFE_INSTALL_PLAN' | 'CANCELLED' | 'INSTALL_FAILED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LoaderInstallError';
  }
}

export function validateLoaderDownloadUrl(value: string): string {
  try { return validateDownloadUrl(value, 'neoforge'); } catch {
    throw new LoaderInstallError('UNTRUSTED_DOWNLOAD', '加载器安装清单包含不受信任的下载来源。');
  }
}

export function neoForgeVersionId(minecraftVersion: string, loaderVersion: string): string {
  if (!/^1\.(?:20|21)(?:\.\d{1,2})?$/.test(minecraftVersion) || !/^\d{2}\.\d{1,2}\.\d{1,5}(?:-beta)?$/.test(loaderVersion)) {
    throw new LoaderInstallError('INVALID_VERSION', '暂只支持 Minecraft 1.20/1.21 的标准 NeoForge 版本。');
  }
  const parts = minecraftVersion.split('.').map(Number);
  if (!loaderVersion.startsWith(`${parts[1]}.${parts[2] ?? 0}.`)) {
    throw new LoaderInstallError('INVALID_VERSION', 'NeoForge 版本与 Minecraft 版本不匹配。');
  }
  return `${minecraftVersion}-neoforge-${loaderVersion}`;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LoaderInstallError('CANCELLED', 'NeoForge 安装已取消。', { cause: signal.reason });
}

function errorDetail(error: unknown): string {
  return error instanceof AggregateError ? error.errors.map(errorDetail).join('；') : error instanceof Error ? error.message : String(error);
}

export function parseNeoForgeInstallerModule(value: unknown, loaderVersion: string): { sha1: string; size: number } {
  const metadata = value as { component?: { group?: string; module?: string; version?: string }; variants?: Array<{ name?: string; files?: Array<{ name?: string; url?: string; sha1?: string; size?: number }> }> };
  const name = `neoforge-${loaderVersion}-installer.jar`;
  if (metadata?.component?.group !== 'net.neoforged' || metadata.component.module !== 'neoforge' || metadata.component.version !== loaderVersion || !Array.isArray(metadata.variants)) throw new Error('NeoForge 发布元数据的坐标或版本不匹配。');
  const files = metadata.variants.filter(variant => variant && variant.name === 'installerJar' && Array.isArray(variant.files)).flatMap(variant => variant.files!).filter(file => file && typeof file === 'object');
  const file = files.find(file => file.name === name && file.url === name);
  if (!file || files.filter(item => item.name === name).length !== 1 || !/^[a-f\d]{40}$/i.test(file.sha1 ?? '') || !Number.isSafeInteger(file.size) || file.size! < 1 || file.size! > 1024 ** 3) throw new Error('NeoForge 发布元数据缺少有效的安装器哈希或大小。');
  return { sha1: file.sha1!.toLowerCase(), size: file.size! };
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function assertChild(root: string, value: string): Promise<void> {
  if (!path.isAbsolute(value)) throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器安装路径必须为绝对路径。');
  const relative = path.relative(root, path.resolve(value));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器安装任务超出当前实例目录。');
  }
  let ancestor = root;
  for (const part of relative.split(path.sep)) {
    ancestor = path.join(ancestor, part);
    const info = await lstat(ancestor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器安装目录内含符号链接或目录联接，请使用独立实例。');
  }
}

/** Every SDK-produced stage is checked before any filesystem or Java effect. */
export async function assertSafeLoaderManifest(plan: InstallManifest, root: string, javaPath: string, versionId: string, minecraftVersion: string): Promise<void> {
  const check = (value: string) => assertChild(root, value);
  for (const task of plan.tasks) {
    if (task.type === 'files') {
      for (const file of task.files) {
        await check(file.path);
        if (!file.urls.length) throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器依赖缺少下载来源。');
        file.urls.forEach(validateLoaderDownloadUrl);
      }
    } else {
      for (const output of task.outputs) await check(output.path);
      if (task.type === 'java') {
        for (const strategy of task.strategies) for (const command of strategy) {
          if (!samePath(command.executable, javaPath) || command.env || (command.cwd && !samePath(path.resolve(command.cwd), root))) {
            throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器处理器尝试使用未授权的运行环境。');
          }
          const classpath = command.args[command.args.indexOf('-cp') + 1];
          if (command.args[0] !== '-cp' || !classpath || command.args.length < 3) {
            throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', '加载器处理器的 Java 参数无效。');
          }
          for (const entry of classpath.split(path.delimiter)) await check(entry);
        }
      } else {
        for (const operation of task.operations) {
          await check(operation.path);
          if ('source' in operation) await check(operation.source);
          if ('archive' in operation) await check(operation.archive);
          if (operation.type === 'merge-zip') for (const archive of operation.archives) await check(archive);
          if (operation.type === 'link' || operation.type === 'extract-archive') {
            throw new LoaderInstallError('UNSAFE_INSTALL_PLAN', 'NeoForge 安装不应创建外部链接或解压未知目录。');
          }
          if (operation.type === 'write' && operation.path.endsWith(`${path.sep}${versionId}.json`)) {
            const metadata = JSON.parse(operation.content);
            if (metadata.id !== versionId || metadata.inheritsFrom !== minecraftVersion) throw new LoaderInstallError('INVALID_VERSION', 'NeoForge 安装器返回的客户端版本不匹配。');
          }
          if (operation.type === 'write' && path.basename(operation.path) === 'install_profile.json') {
            const metadata = JSON.parse(operation.content);
            if (metadata.minecraft !== minecraftVersion) throw new LoaderInstallError('INVALID_VERSION', 'NeoForge 安装器的 Minecraft 版本不匹配。');
          }
        }
      }
    }
  }
}

async function safeFetch(request: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal, exclude?: ReadonlySet<string>): Promise<Response> {
  validateLoaderDownloadUrl(url);
  return fetchFromSources(url, { purpose: 'neoforge', request, init, signal, exclude, timeoutMs: init.method === 'HEAD' ? 8000 : url.endsWith('.sha1') || url.endsWith('.module') ? 20_000 : 300_000 });
}

function runProcessor(command: JavaCommand, root: string, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: root, env: cleanJavaEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: 10 * 60_000 });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`NeoForge 客户端处理器退出（${code ?? '已中止'}）：${stderr.slice(-2000)}`)));
  });
}

export async function installNeoForge(options: InstallNeoForgeOptions, dependencies: LoaderInstallerDependencies = {}): Promise<{ versionId: string; loader: 'NeoForge'; loaderVersion: string }> {
  const versionId = neoForgeVersionId(options.minecraftVersion, options.loaderVersion);
  const emit = (value: LoaderInstallProgress) => { try { options.onProgress?.(value); } catch { /* A UI listener cannot fail installation. */ } };
  cancelled(options.signal);
  emit({ phase: 'checking', percent: 0, message: '检查 NeoForge 安装环境' });
  try {
    if (!path.isAbsolute(options.destination) || (await lstat(options.destination)).isSymbolicLink() || !(await lstat(options.destination)).isDirectory()) {
      throw new LoaderInstallError('INVALID_DESTINATION', 'NeoForge 必须安装到已有的独立客户端实例中。');
    }
    const root = await realpath(options.destination);
    const java = await (dependencies.probeJava ?? probeJava)(options.javaPath);
    const required = javaRequirement(options.minecraftVersion);
    if (!java || java.major !== required) throw new LoaderInstallError('JAVA_REQUIRED', `安装此 NeoForge 客户端需要 Java ${required}，请先配置对应运行环境。`);
    const baseVersion = await Version.parse(MinecraftFolder.from(root), options.minecraftVersion);
    if (baseVersion.id !== options.minecraftVersion) throw new LoaderInstallError('INVALID_VERSION', '请先安装对应的 Minecraft 原版客户端。');
    cancelled(options.signal);
    const request = dependencies.fetch ?? fetch;
    const retry = { signal: options.signal, wait: dependencies.retryWait };
    const minecraft = MinecraftFolder.from(root);
    let checksumFailure: unknown;
    let moduleInstaller: { sha1: string; size: number } | undefined;
    const installOptions: InstallForgeOptions & { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
      side: 'client', java: java.path, versionId, inheritsFrom: options.minecraftVersion, signal: options.signal,
      fetch: async (url, init) => {
        try {
          return await withNetworkRetry(async () => {
            if (url.endsWith('-installer.jar.sha1') && init?.method !== 'HEAD') {
              const metadataController = new AbortController();
              const metadataSignal = options.signal ? AbortSignal.any([options.signal, metadataController.signal]) : metadataController.signal;
              const sidecar = async () => {
                const response = await safeFetch(request, url, init ?? {}, metadataSignal);
                const text = (await response.text()).trim();
                const sha1 = text.split(/\s+/)[0];
                if (text.length > 512 || !/^[a-f\d]{40}$/i.test(sha1)) throw new Error(`NeoForge 官方校验信息格式无效（HTTP ${response.status}）。`);
                return sha1;
              };
              const publishedModule = async () => {
                const moduleUrl = url.replace(/-installer\.jar\.sha1$/, '.module');
                const response = await safeFetch(request, moduleUrl, {}, metadataSignal);
                const text = await response.text();
                if (text.length > 4 * 1024 * 1024) throw new Error('NeoForge 发布元数据过大。');
                const result = parseNeoForgeInstallerModule(JSON.parse(text), options.loaderVersion);
                moduleInstaller = result;
                return result.sha1;
              };
              try {
                // BMCLAPI mirrors Gradle module metadata even when a standalone
                // .sha1 sidecar is absent. Both contain the publisher's digest.
                const sha1 = await Promise.any([sidecar(), publishedModule()]);
                return new Response(sha1);
              } finally { metadataController.abort(); }
            }
            const response = await safeFetch(request, url, init ?? {}, options.signal);
            await requireSuccessfulDownload(response, 'NeoForge 安装器元数据请求失败');
            // Read the tiny checksum response within the retry boundary; a body
            // socket failure must not be mistaken for a missing official hash.
            if (url.endsWith('.sha1') && init?.method !== 'HEAD') {
              const checksum = await response.text();
              if (checksum.length > 512 || !/^[a-f\d]{40}(?:\s|$)/i.test(checksum.trim())) {
                throw new Error(`NeoForge 官方校验信息格式无效（HTTP ${response.status}）。`);
              }
              return new Response(checksum, { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            return response;
          }, retry);
        } catch (error) {
          if (url.endsWith('.sha1')) checksumFailure = error instanceof AggregateError ? new Error(errorDetail(error), { cause: error }) : error;
          throw error;
        }
      },
      libraryHost: library => {
        if (library.download.url) return [validateLoaderDownloadUrl(library.download.url)];
        return [`https://maven.neoforged.net/releases/${library.download.path}`, `https://libraries.minecraft.net/${library.download.path}`];
      },
    };
    emit({ phase: 'installer', percent: 1, message: '获取 NeoForge 官方安装器与校验信息' });
    const installer = await resolveNeoForgedInstallerFile('neoforge', options.loaderVersion, minecraft, installOptions);
    if (moduleInstaller) installer.file.size = moduleInstaller.size;
    if (installer.file.checksum?.algorithm !== 'sha1' || !/^[a-f\d]{40}$/i.test(installer.file.checksum.value)) {
      cancelled(options.signal);
      const detail = checksumFailure instanceof Error ? ` 原因：${checksumFailure.message.slice(0, 250)}` : '';
      throw new LoaderInstallError('UNTRUSTED_DOWNLOAD', `未能取得 NeoForge 官方安装器校验值，请稍后重试。${detail}`, { cause: checksumFailure });
    }
    const workflow = createModernForgeInstallWorkflow({ id: `neoforge-${options.loaderVersion}`, minecraft, minecraftVersion: options.minecraftVersion, installer: installer.file, artifactVersion: options.loaderVersion, java: java.path, installOptions, side: 'client' });
    let currentPhase: LoaderInstallProgress['phase'] = 'installer';
    let currentPercent = 2;
    let currentStageEnd = 14;
    let currentStepId: LoaderInstallProgress['stepId'] = 'installer';
    let transferredBytes = 0;
    const exhaustedSources = new Map<string, unknown>();
    const download = async (files: InstallFile[]) => {
      let completedFiles = 0;
      let satisfiedBytes = 0;
      const inflight = new Map<string, number>();
      let currentFile: string | undefined;
      const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size ?? 0), 0);
      const knownBytes = files.every(file => file.size !== undefined && file.size >= 0);
      let lastNotify = 0;
      const report = () => {
        const downloadedBytes = satisfiedBytes + [...inflight.values()].reduce((sum, value) => sum + value, 0);
        const ratio = knownBytes && totalBytes ? Math.min(1, downloadedBytes / totalBytes) : completedFiles / Math.max(1, files.length);
        emit({ phase: currentPhase, stepId: currentStepId, percent: Math.round(currentPercent + (currentStageEnd - currentPercent) * ratio), phasePercent: Math.min(99.9, ratio * 100), message: `下载 NeoForge 依赖 ${completedFiles}/${files.length}`, completedFiles, totalFiles: files.length, downloadedBytes, totalBytes: knownBytes ? totalBytes : undefined, transferredBytes, currentFile });
      };
      let cursor = 0;
      const worker = async () => {
        while (cursor < files.length) {
          cancelled(options.signal);
          const file = files[cursor++];
          currentFile = path.relative(root, file.path).replaceAll('\\', '/');
          let writtenBytes = 0;
          await assertChild(root, file.path);
          await mkdir(path.dirname(file.path), { recursive: true });
          let failure: unknown;
          let success = false;
          for (const url of file.urls) {
            const sourceKey = `${file.path}\0${url}\0${file.checksum?.value ?? ''}\0${file.size ?? ''}`;
            if (exhaustedSources.has(sourceKey)) { failure = exhaustedSources.get(sourceKey); continue; }
            const rejectedSources = new Set<string>();
            for (let choice = 0; choice < resolveDownloadSources(url, 'neoforge').length; choice++) {
            let chosenSource: string | undefined;
            try {
              await withNetworkRetry(async () => {
                const temporary = `${file.path}.${randomUUID()}.download`;
                try {
                  const response = await safeFetch(request, url, {}, options.signal, rejectedSources);
                  chosenSource = getDownloadSource(response);
                  await requireSuccessfulDownload(response, 'NeoForge 依赖下载失败');
                  if (!response.body) throw new Error('NeoForge 依赖下载返回了空响应。');
                  const hash = createHash(file.checksum?.algorithm ?? 'sha1');
                  let size = 0;
                  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                    size += chunk.length;
                    transferredBytes += chunk.length;
                    inflight.set(file.path, size);
                    currentFile = path.relative(root, file.path).replaceAll('\\', '/');
                    hash.update(chunk);
                    if (Date.now() - lastNotify >= 200) { lastNotify = Date.now(); report(); }
                    if (size > (file.size !== undefined && file.size >= 0 ? file.size : 1024 * 1024 * 1024)) { callback(new Error('加载器依赖文件超出大小限制。')); return; }
                    callback(null, chunk);
                  } });
                  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(temporary, { flags: 'wx' }), { signal: options.signal });
                  if ((file.size !== undefined && file.size >= 0 && size !== file.size) || (file.checksum && hash.digest('hex').toLowerCase() !== file.checksum.value.toLowerCase())) throw new Error('文件大小或校验值不匹配');
                  await rename(temporary, file.path);
                  writtenBytes = size;
                } finally { inflight.delete(file.path); await unlink(temporary).catch(() => undefined); }
              }, retry);
              success = true;
              break;
            } catch (error) {
              failure = error; cancelled(options.signal);
              if (chosenSource) rejectedSources.add(chosenSource);
              else break;
            }
            }
            if (success) break;
            exhaustedSources.set(sourceKey, failure);
          }
          if (!success) throw new Error(`加载器依赖下载失败：${path.basename(file.path)}`, { cause: failure });
          completedFiles++;
          satisfiedBytes += writtenBytes;
          report();
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(6, files.length) }, worker));
      const failures = workers.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'NeoForge 依赖下载未完成');
    };
    const runtime = (dependencies.createRuntime ?? createNodeInstallRuntime)({ signal: options.signal, download, runJava: command => runProcessor(command, root, options.signal) });
    const phases: Array<[LoaderInstallProgress['phase'], number, string, LoaderInstallProgress['stepId']]> = [
      ['installer', 3, '下载并校验 NeoForge 官方安装器', 'installer'], ['materialize', 15, '解析 NeoForge 客户端安装配置', 'materialize'],
      ['libraries', 25, '下载 NeoForge 安装依赖', 'libraries'], ['processors', 65, '生成 NeoForge 客户端文件', 'processors'], ['libraries', 88, '补全 NeoForge 客户端运行依赖', 'runtime-libraries'],
    ];
    const result = await runInstallWorkflow(workflow, async (plan, stage) => {
      cancelled(options.signal);
      const [phase, percent, message, stepId] = phases[stage] ?? ['libraries', 95, '校验 NeoForge 安装结果', 'runtime-libraries'];
      currentPhase = phase;
      currentStepId = stepId;
      currentPercent = percent;
      currentStageEnd = (phases[stage + 1]?.[1] ?? 100) - 1;
      await assertSafeLoaderManifest(plan, root, java.path, versionId, options.minecraftVersion);
      const files = plan.tasks.flatMap(task => task.type === 'files' ? task.files : []);
      let completedTasks = 0;
      emit({ phase, stepId, percent, phasePercent: 0, message, transferredBytes, totalTasks: plan.tasks.length, completedTasks });
      await executeInstallManifest(plan, runtime, { signal: options.signal, attempts: 3, retryBaseDelay: 500, retryMaxDelay: 5000, onEvent: event => {
        if (event.type === 'task-end' && !event.error) {
          completedTasks++;
          if (phase === 'processors' || phase === 'materialize') emit({ phase, stepId, percent, phasePercent: 100 * completedTasks / Math.max(1, plan.tasks.length), message: `${message}（${completedTasks}/${plan.tasks.length}）`, completedTasks, totalTasks: plan.tasks.length, transferredBytes });
        }
      } });
      const knownBytes = files.every(file => file.size !== undefined && file.size >= 0);
      const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size ?? 0), 0);
      emit({ phase, stepId, percent: currentStageEnd, phasePercent: 100, message, transferredBytes, completedTasks: plan.tasks.length, totalTasks: plan.tasks.length, ...(files.length ? { completedFiles: files.length, totalFiles: files.length, downloadedBytes: knownBytes ? totalBytes : undefined, totalBytes: knownBytes ? totalBytes : undefined } : {}) });
    });
    cancelled(options.signal);
    if (result.version !== versionId || result.profile.minecraft !== options.minecraftVersion) throw new LoaderInstallError('INVALID_VERSION', 'NeoForge 安装结果不匹配。');
    const raw = JSON.parse(await readFile(minecraft.getVersionJson(versionId), 'utf8'));
    const modern = neoForgeMetadataVersions(raw);
    const legacy = raw.libraries?.some((library: { name?: string }) => library.name?.startsWith(`net.neoforged:neoforge:${options.loaderVersion}:`) || library.name === `net.neoforged:neoforge:${options.loaderVersion}`);
    if (raw.id !== versionId || raw.inheritsFrom !== options.minecraftVersion || !(legacy || (modern?.loaderVersion === options.loaderVersion && modern.minecraftVersion === options.minecraftVersion))) {
      throw new LoaderInstallError('INVALID_VERSION', 'NeoForge 客户端版本配置缺少对应加载器。');
    }
    const issues = await inspectClientResources(root, versionId);
    if (issues.length) throw new LoaderInstallError('INSTALL_FAILED', `NeoForge 客户端校验未通过：${issues.join('；')}`);
    emit({ phase: 'complete', percent: 100, message: `NeoForge ${options.loaderVersion} 已安装完成` });
    return { versionId, loader: 'NeoForge', loaderVersion: options.loaderVersion };
  } catch (cause) {
    if (options.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw new LoaderInstallError('CANCELLED', 'NeoForge 安装已取消。', { cause });
    if (cause instanceof LoaderInstallError) throw cause;
    const errors = cause instanceof AggregateError ? cause.errors.map(error => error instanceof Error ? error.message : String(error)).slice(0, 2).join('；') : cause instanceof Error ? cause.message : String(cause);
    throw new LoaderInstallError('INSTALL_FAILED', `NeoForge 安装失败：${errors}`, { cause });
  }
}
