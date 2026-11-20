import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { LaunchOption } from '@xmcl/core';
import type { JavaInstallation, LauncherInstance, LauncherSettings, LaunchPlan } from '../../shared/contracts';
import { exists, isWithin, readJson, readText, safeChild, safeVersionId } from './filesystem';
import { inspectClientResources, javaRequirement, readVersionChain } from './instances';
import { probeJava } from './java';
import { redactSensitiveText } from './logs';
import type { GameIdentity } from './account';
import { DEFAULT_GAME_WINDOW, prepareGameWindow, withoutWindowArguments, type GameWindowSize } from './game-window';
import { pruneInstanceLogArchives } from './log-retention';

function offlineId(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function commandPreview(executable: string, args: string[]): string {
  // Presentation only. This string is never sent to a shell.
  return redactSensitiveText([executable, ...args].map(argument => /[\s"]/.test(argument) ? JSON.stringify(argument) : argument).join(' '));
}

async function selectJava(instance: LauncherInstance, settings: LauncherSettings, installed: JavaInstallation[]): Promise<JavaInstallation> {
  const required = instance.requiredJavaMajor || javaRequirement(instance.minecraftVersion);
  let chosen: JavaInstallation | undefined;
  if (settings.javaPath.trim()) {
    chosen = installed.find(java => path.resolve(java.path).toLowerCase() === path.resolve(settings.javaPath).toLowerCase())
      || await probeJava(settings.javaPath);
    if (!chosen) throw new Error('指定的 Java 无法运行，请在设置里重新选择 java.exe。');
  } else {
    chosen = installed.find(java => java.major === required);
  }
  if (!chosen) throw new Error(`没有找到 Java ${required}。请安装对应 Java，并在设置中选择路径后重新检测。`);
  if (chosen.major !== required) throw new Error(`这个实例使用 Java ${required}，当前选择的是 Java ${chosen.major}。请在设置中选择对应版本。`);
  const validated = await probeJava(chosen.path, chosen.source);
  if (!validated) throw new Error('Java 文件已移动或无法执行，请重新检测。');
  if (validated.major !== required) throw new Error(`当前 Java 版本已变化，请选择 Java ${required} 后重试。`);
  return validated;
}

function validateMemory(memoryMb: number): void {
  const limit = Math.max(1024, Math.floor(os.totalmem() / 1024 / 1024) - 1536);
  if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > Math.min(65536, limit)) {
    throw new Error(`内存设置应在 512 MB 至 ${Math.min(65536, limit)} MB 之间，并为系统保留内存。`);
  }
}

async function validateAssets(root: string, indexId: string | undefined): Promise<void> {
  if (!indexId) return;
  if (!safeVersionId(indexId)) throw new Error('游戏资源索引名称无效。');
  const index = await readJson<{ objects?: Record<string, { hash?: string }> }>(path.join(root, 'assets', 'indexes', `${indexId}.json`));
  let missing = 0;
  for (const value of Object.values(index.objects || {})) {
    if (!value.hash || !/^[a-f0-9]{40}$/i.test(value.hash)) throw new Error('游戏资源索引中有无效的文件摘要。');
    if (!await exists(path.join(root, 'assets', 'objects', value.hash.slice(0, 2), value.hash))) missing++;
  }
  if (missing) throw new Error(`缺少 ${missing} 个游戏资源文件。请先使用原启动器补全这个实例，再重新扫描。`);
}

async function clientOptions(instance: LauncherInstance, settings: LauncherSettings, java: JavaInstallation, identity?: GameIdentity, windowSize: GameWindowSize = DEFAULT_GAME_WINDOW): Promise<LaunchOption> {
  if (!instance.versionId || !safeVersionId(instance.versionId)) throw new Error('这个目录还没有可启动的客户端版本。请导入完整 Minecraft 目录。');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(settings.playerName)) throw new Error('本地玩家名应为 3–16 位英文字母、数字或下划线。');
  const quickIssues = await inspectClientResources(instance.path, instance.versionId);
  if (quickIssues.length) throw new Error(quickIssues.join('；'));
  const chain = await readVersionChain(instance.path, instance.versionId);
  const asset = chain.find(entry => entry.data.assetIndex?.id || entry.data.assets)?.data;
  await validateAssets(instance.path, asset?.assetIndex?.id || asset?.assets);
  const { Version } = await import('@xmcl/core');
  const resolved = await Version.parse(instance.path, instance.versionId);
  resolved.arguments = { ...resolved.arguments, game: withoutWindowArguments(resolved.arguments.game) };
  // Check the SDK's resolved paths as well as the raw JSON to catch malformed coordinates.
  for (const library of resolved.libraries) {
    if (library.download?.path) safeChild(path.join(instance.path, 'libraries'), library.download.path);
  }
  return {
    version: resolved,
    gamePath: instance.gameDirectory,
    resourcePath: instance.path,
    javaPath: java.path,
    minMemory: Math.min(1024, settings.memoryMb),
    maxMemory: settings.memoryMb,
    gameProfile: identity ? { name: identity.name, id: identity.id } : { name: settings.playerName, id: offlineId(settings.playerName) },
    accessToken: identity?.accessToken ?? '0',
    // XMCL 2.16 defaults to msa; its older type declaration only lists legacy/mojang.
    userType: identity ? undefined : 'legacy',
    features: { account: { clientid: identity?.clientId ?? '', auth_xuid: identity?.xuid ?? '' } },
    resolution: { width: windowSize.width, height: windowSize.height, fullscreen: false },
    launcherName: 'shenBCL',
    launcherBrand: '0.3.6',
    extraJVMArgs: ['-XX:+UseG1GC'],
    extraExecOption: { cwd: instance.gameDirectory, windowsHide: true, shell: false, stdio: 'pipe' },
  };
}

async function serverArguments(instance: LauncherInstance, settings: LauncherSettings): Promise<string[]> {
  if (!instance.serverArgumentsFile || !isWithin(instance.path, instance.serverArgumentsFile)) throw new Error('未找到标准 Forge 服务端参数文件。');
  const relative = path.relative(instance.path, instance.serverArgumentsFile).replaceAll('\\', '/');
  if (!/^libraries\/net\/minecraftforge\/forge\/[^/]+\/(?:win|unix)_args\.txt$/i.test(relative)) {
    throw new Error('服务端参数文件不属于标准 Forge 安装目录。');
  }
  const eula = await readText(path.join(instance.path, 'eula.txt')).catch(() => '');
  if (!/^\s*eula\s*=\s*true\s*$/im.test(eula)) throw new Error('请先阅读服务端 EULA，并在 eula.txt 中自行确认同意。');
  const argsText = await readText(instance.serverArgumentsFile).catch(() => { throw new Error('缺少 Forge 服务端 libraries 运行依赖，请导入完整服务端包。'); });
  if (/(?:^|\s)@[^\s]+/m.test(argsText)) throw new Error('服务端参数包含嵌套参数文件，首版暂不支持。');
  const referencedLibraries = [...new Set(argsText.match(/libraries[\\/][^\s;"']+\.jar/gi) || [])];
  if (!referencedLibraries.length || !/bootstraplauncher\.BootstrapLauncher|forge.*server|forgeserver/i.test(argsText)) {
    throw new Error('服务端参数不完整，无法识别 Forge 服务端入口。');
  }
  let missing = 0;
  for (const relativeLibrary of referencedLibraries) {
    if (!await exists(safeChild(instance.path, relativeLibrary.replace(/[\\/]/g, path.sep)))) missing++;
  }
  if (missing) throw new Error(`服务端还缺少 ${missing} 个运行依赖，请先补全 libraries 目录。`);
  return [`-Xms${Math.min(1024, settings.memoryMb)}M`, `-Xmx${settings.memoryMb}M`, `@${instance.serverArgumentsFile}`, 'nogui'];
}

/** Generate a reviewed launch command. Does not spawn Java or change game files. */
export async function prepareLaunch(instance: LauncherInstance, settings: LauncherSettings, installedJava: JavaInstallation[], identity?: GameIdentity, windowSize?: GameWindowSize): Promise<LaunchPlan> {
  validateMemory(settings.memoryMb);
  const java = await selectJava(instance, settings, installedJava);
  let args: string[];
  const warnings: string[] = [];
  if (instance.kind === 'server') {
    args = await serverArguments(instance, settings);
  } else {
    const { generateArguments } = await import('@xmcl/core');
    const fullCommand = await generateArguments(await clientOptions(instance, settings, java, identity, windowSize));
    args = fullCommand.slice(1);
    if (!identity) warnings.push('当前使用本地玩家身份。连接 Microsoft 账号后可使用正版身份启动。');
  }
  if (identity) args = args.map(arg => arg.replaceAll(identity.accessToken, '[已隐藏]'));
  return { instanceId: instance.id, executable: java.path, args, cwd: instance.gameDirectory,
    displayCommand: commandPreview(java.path, args), warnings, kind: instance.kind };
}

/** Only call after the user explicitly presses Launch. Returns the process for main-process event handling. */
export async function launchInstance(instance: LauncherInstance, settings: LauncherSettings, installedJava: JavaInstallation[], identity?: GameIdentity, windowSize?: GameWindowSize): Promise<ChildProcess> {
  validateMemory(settings.memoryMb);
  const java = await selectJava(instance, settings, installedJava);
  if (instance.kind === 'server') {
    const args = await serverArguments(instance, settings);
    await pruneInstanceLogArchives(instance.gameDirectory);
    return spawn(java.path, args, { cwd: instance.gameDirectory, windowsHide: true, shell: false, stdio: 'pipe' });
  }
  const { launch } = await import('@xmcl/core');
  const options = await clientOptions(instance, settings, java, identity, windowSize);
  await prepareGameWindow(instance.gameDirectory);
  await pruneInstanceLogArchives(instance.gameDirectory);
  // XMCL validates hashes and extracts native libraries at the actual launch step.
  return launch(options);
}
