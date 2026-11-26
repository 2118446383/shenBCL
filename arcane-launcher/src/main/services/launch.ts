import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { LaunchOption } from '@xmcl/core';
import type { JavaInstallation, LauncherInstance, LauncherSettings, LaunchPlan } from '../../shared/contracts';
import { exists, isWithin, readJson, readText, safeChild, safeVersionId } from './filesystem';
import { inspectClientResources, javaRequirement, readVersionChain } from './instances';
import { cleanJavaEnvironment, probeJava } from './java';
import { redactSensitiveText } from './logs';
import { assertGameIdentity, type GameIdentity } from './account';
import { DEFAULT_GAME_WINDOW, prepareGameWindow, withoutWindowArguments, type GameWindowSize } from './game-window';
import { pruneInstanceLogArchives } from './log-retention';

const alternateAuth = /authlib[-_.]?injector|yggdrasil[-_.]?connect|ely\.by|--(?:authserver|auth-server|sessionserver|session-server|offline(?:-mode)?|demo)(?:[\s="']|$)|-Dminecraft\.(?:api\.|auth\.|session\.|services\.)|-Dauthlib(?:[.=]|$)|-Dcom\.mojang\.authlib\.|-(?:javaagent|agentlib|agentpath|Xrun)(?:[:=]|$)/i;

function verifyLaunchArguments(args: readonly string[], identity: GameIdentity): void {
  if (args.some(arg => alternateAuth.test(arg) || arg.startsWith('@'))) throw new Error('此实例的启动参数包含认证覆盖、Java 代理或额外参数文件。请重新安装标准版本。');
  const expected = new Map([
    ['--username', identity.name], ['--uuid', identity.id], ['--accessToken', identity.accessToken], ['--session', identity.accessToken],
    ['--userType', 'msa'], ['--clientId', identity.clientId], ['--xuid', identity.xuid],
  ]);
  const seen = new Set<string>();
  for (const [index, argument] of args.entries()) {
    const equals = argument.indexOf('=');
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!expected.has(flag)) continue;
    const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
    if (seen.has(flag) || value !== expected.get(flag)) throw new Error('此实例覆盖了 Minecraft 登录参数。请重新安装标准版本。');
    seen.add(flag);
  }
  if (!seen.has('--username') || (!seen.has('--accessToken') && !seen.has('--session'))) throw new Error('此版本没有可用的正版会话启动参数。');
}

async function requireOnlineServer(instance: LauncherInstance): Promise<void> {
  const properties = await readText(path.join(instance.gameDirectory, 'server.properties'), 256 * 1024).catch(() => { throw new Error('请确认服务端目录中存在可读取的 server.properties。'); });
  const lines = properties.split(/\r\n|\n|\r/).map(line => line.replace(/^[ \t\f]+/, '')).filter(line => line && !/^[#!]/.test(line));
  // Reject escaped property keys and continued lines so Java cannot read a hidden second setting.
  if (lines.some(line => /^(?:[^\s:=\\]*\\)|(?:^|[^\\])(?:\\\\)*\\$/.test(line))) throw new Error('请移除 server.properties 中的转义键或续行，再启用正版验证。');
  const mode = lines.filter(line => /^online-mode(?:[\t\f :=]|$)/.test(line));
  if (mode.length !== 1 || !/^online-mode[ \t\f]*(?:[=:][ \t\f]*|[ \t\f]+)true$/i.test(mode[0])) {
    throw new Error('请在 server.properties 中设置唯一的 online-mode=true，再启动服务端。');
  }
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

async function clientOptions(instance: LauncherInstance, settings: LauncherSettings, java: JavaInstallation, identity: GameIdentity, windowSize: GameWindowSize = DEFAULT_GAME_WINDOW): Promise<LaunchOption> {
  if (!instance.versionId || !safeVersionId(instance.versionId)) throw new Error('这个目录还没有可启动的客户端版本。请导入完整 Minecraft 目录。');
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
    gameProfile: { name: identity.name, id: identity.id },
    accessToken: identity.accessToken,
    // XMCL defaults to msa; its type declaration only lists legacy/mojang.
    features: { account: { clientid: identity.clientId, auth_xuid: identity.xuid } },
    resolution: { width: windowSize.width, height: windowSize.height, fullscreen: false },
    launcherName: 'shenBCL',
    launcherBrand: '0.3.7',
    extraJVMArgs: ['-XX:+UseG1GC'],
    extraExecOption: { cwd: instance.gameDirectory, env: cleanJavaEnvironment(), windowsHide: true, shell: false, stdio: 'pipe' },
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
  if (alternateAuth.test(argsText) || /(?:^|[\s"'])@[^\s]+/m.test(argsText)) throw new Error('服务端参数包含认证覆盖、Java 代理或嵌套参数文件。');
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

/** Generate a redacted launch command without starting the game. */
export async function prepareLaunch(instance: LauncherInstance, settings: LauncherSettings, installedJava: JavaInstallation[], identity?: GameIdentity, windowSize?: GameWindowSize): Promise<LaunchPlan> {
  assertGameIdentity(identity);
  validateMemory(settings.memoryMb);
  const java = await selectJava(instance, settings, installedJava);
  let args: string[];
  if (instance.kind === 'server') {
    await requireOnlineServer(instance);
    args = await serverArguments(instance, settings);
  } else {
    const { generateArguments } = await import('@xmcl/core');
    const fullCommand = await generateArguments(await clientOptions(instance, settings, java, identity, windowSize));
    args = fullCommand.slice(1);
    verifyLaunchArguments(args, identity);
  }
  assertGameIdentity(identity);
  args = args.map(arg => redactSensitiveText(arg.replaceAll(identity.accessToken, '[已隐藏]')));
  return { instanceId: instance.id, executable: java.path, args, cwd: instance.gameDirectory,
    displayCommand: commandPreview(java.path, args), warnings: [], kind: instance.kind };
}

/** Only call after the user explicitly presses Launch. */
export async function launchInstance(instance: LauncherInstance, settings: LauncherSettings, installedJava: JavaInstallation[], identity?: GameIdentity, windowSize?: GameWindowSize): Promise<ChildProcess> {
  assertGameIdentity(identity);
  validateMemory(settings.memoryMb);
  const java = await selectJava(instance, settings, installedJava);
  if (instance.kind === 'server') {
    await pruneInstanceLogArchives(instance.gameDirectory);
    const args = await serverArguments(instance, settings);
    await requireOnlineServer(instance);
    assertGameIdentity(identity);
    return spawn(java.path, args, { cwd: instance.gameDirectory, env: cleanJavaEnvironment(), windowsHide: true, shell: false, stdio: 'pipe' });
  }
  const { launch } = await import('@xmcl/core');
  const options = await clientOptions(instance, settings, java, identity, windowSize);
  await prepareGameWindow(instance.gameDirectory);
  await pruneInstanceLogArchives(instance.gameDirectory);
  return launch({ ...options, spawn: (executable, args, execOptions) => {
    assertGameIdentity(identity);
    if (!args) throw new Error('无法读取游戏启动参数。');
    verifyLaunchArguments(args, identity);
    return spawn(executable, args, execOptions ?? {});
  } });
}
