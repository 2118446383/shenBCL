import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { InstanceScanResult, InstanceStats, LauncherInstance } from '../../shared/contracts';
import { countEntries, directories, exists, readJson, readText, safeChild, safeVersionId, stableId } from './filesystem';

interface LibraryMetadata {
  name?: string;
  rules?: { action: string; os?: { name?: string; arch?: string } }[];
  downloads?: { artifact?: { path?: string }; classifiers?: Record<string, { path?: string }> };
  natives?: Record<string, string>;
}

export interface VersionMetadata {
  id?: string;
  inheritsFrom?: string;
  jar?: string;
  mainClass?: string;
  javaVersion?: { majorVersion?: number };
  libraries?: LibraryMetadata[];
  assetIndex?: { id?: string };
  assets?: string;
  downloads?: { client?: { sha1?: string } };
  releaseTime?: string;
  arguments?: { game?: unknown[] };
}

/** Recent NeoForge installs declare their version in FML arguments rather than a neoforge library. */
export function neoForgeMetadataVersions(data: VersionMetadata): { loaderVersion: string; minecraftVersion: string } | undefined {
  const args = data.arguments?.game;
  if (!Array.isArray(args) || data.mainClass !== 'cpw.mods.bootstraplauncher.BootstrapLauncher') return undefined;
  const argument = (name: string): string | undefined => {
    const indexes = args.flatMap((value, index) => value === name ? [index] : []);
    const value = indexes.length === 1 ? args[indexes[0] + 1] : undefined;
    return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
  };
  const loaderVersion = argument('--fml.neoForgeVersion');
  const minecraftVersion = argument('--fml.mcVersion');
  const fmlVersion = argument('--fml.fmlVersion');
  if (!/^\d{2}\.\d{1,2}\.\d{1,5}(?:-beta)?$/.test(loaderVersion ?? '') || !/^1\.\d+(?:\.\d+)?$/.test(minecraftVersion ?? '') || !fmlVersion || !['forgeclient', 'neoforgeclient'].includes(argument('--launchTarget') ?? '')) return undefined;
  if (!data.libraries?.some(library => library.name === `net.neoforged.fancymodloader:loader:${fmlVersion}`)) return undefined;
  return { loaderVersion: loaderVersion!, minecraftVersion: minecraftVersion! };
}

export async function readVersionChain(root: string, versionId: string): Promise<{ id: string; data: VersionMetadata }[]> {
  const chain: { id: string; data: VersionMetadata }[] = [];
  const visited = new Set<string>();
  let current: string | undefined = versionId;
  while (current) {
    if (!safeVersionId(current)) throw new Error('游戏版本名称包含无效路径。');
    if (visited.has(current) || chain.length >= 16) throw new Error('游戏版本继承关系循环或过深。');
    visited.add(current);
    const data: VersionMetadata = await readJson<VersionMetadata>(safeChild(root, path.join('versions', current, `${current}.json`)));
    chain.push({ id: current, data });
    current = data.inheritsFrom;
  }
  return chain;
}

function platformName(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function allowed(library: LibraryMetadata): boolean {
  if (!library.rules) return true;
  let result = false;
  for (const rule of library.rules) {
    if (rule.os?.name && rule.os.name !== platformName()) continue;
    if (rule.os?.arch) {
      try {
        if (!new RegExp(rule.os.arch).test(process.arch === 'ia32' ? 'x86' : process.arch)) continue;
      } catch { continue; }
    }
    result = rule.action === 'allow';
  }
  return result;
}

function mavenPath(name: string): string | undefined {
  const [coordinate, extension = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coordinate.split(':');
  if (!group || !artifact || !version) return undefined;
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
}

export async function inspectClientResources(root: string, versionId: string): Promise<string[]> {
  const chain = await readVersionChain(root, versionId);
  const issues: string[] = [];
  const installationMarker = path.join(root, '.arcane-installation.json');
  if (await exists(installationMarker)) {
    const marker = await readJson<{ versionId?: string; state?: string }>(installationMarker).catch(() => undefined);
    if (!marker) {
      issues.push('安装记录损坏，请重新安装到新目录');
    } else if (marker.versionId === versionId && marker.state !== 'complete') {
      const state = marker.state === 'installing' ? '尚未完成' : marker.state === 'cancelled' ? '已取消' : '未成功完成';
      issues.push(`这个实例的安装${state}，请重新安装到新目录后启动`);
    }
  }
  const jarId = chain.find(entry => entry.data.jar)?.data.jar || chain.at(-1)!.id;
  if (!safeVersionId(jarId)) throw new Error('版本 JAR 指向无效路径。');
  if (!await exists(safeChild(root, path.join('versions', jarId, `${jarId}.jar`)))) {
    issues.push(`缺少游戏主文件：${jarId}.jar`);
  }
  const libraries = new Map<string, LibraryMetadata>();
  for (const entry of [...chain].reverse()) {
    for (const library of entry.data.libraries || []) {
      const parts = (library.name || '').split(':');
      libraries.set(`${parts[0]}:${parts[1]}:${parts[3] || ''}`, library);
    }
  }
  let missingLibraries = 0;
  for (const library of libraries.values()) {
    if (!allowed(library)) continue;
    const relative = library.downloads?.artifact?.path || (library.name ? mavenPath(library.name) : undefined);
    if (relative && !await exists(safeChild(path.join(root, 'libraries'), relative))) missingLibraries++;
    const nativeName = library.natives?.[platformName()]?.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
    const native = nativeName && library.downloads?.classifiers?.[nativeName]?.path;
    if (native && !await exists(safeChild(path.join(root, 'libraries'), native))) missingLibraries++;
  }
  if (missingLibraries) issues.push(`缺少 ${missingLibraries} 个运行依赖文件`);
  const assets = chain.find(entry => entry.data.assetIndex?.id || entry.data.assets)?.data;
  const indexId = assets?.assetIndex?.id || assets?.assets;
  if (indexId && safeVersionId(indexId) && !await exists(path.join(root, 'assets', 'indexes', `${indexId}.json`))) {
    issues.push('缺少游戏资源索引，请先在原启动器补全资源');
  }
  return issues;
}

export async function collectInstanceStats(gameDirectory: string): Promise<InstanceStats> {
  const [mods, saves, screenshots, resourcePacks, shaderPacks] = await Promise.all([
    countEntries(path.join(gameDirectory, 'mods'), (name, directory) => !directory && /\.jar$/i.test(name)),
    countEntries(path.join(gameDirectory, 'saves'), (_name, directory) => directory),
    countEntries(path.join(gameDirectory, 'screenshots'), (name, directory) => !directory && /\.(png|jpe?g|webp)$/i.test(name)),
    countEntries(path.join(gameDirectory, 'resourcepacks'), (name, directory) => directory || /\.zip$/i.test(name)),
    countEntries(path.join(gameDirectory, 'shaderpacks'), (name, directory) => directory || /\.zip$/i.test(name)),
  ]);
  return { mods, saves, screenshots, resourcePacks, shaderPacks };
}

function detectLoader(chain: { id: string; data: VersionMetadata }[]): { loader: string; loaderVersion: string } {
  for (const entry of chain) {
    const modern = neoForgeMetadataVersions(entry.data);
    if (modern && modern.minecraftVersion === chain.at(-1)?.id) return { loader: 'NeoForge', loaderVersion: modern.loaderVersion };
  }
  const libraries = chain.flatMap(entry => entry.data.libraries || []);
  const candidates = [
    { prefix: 'net.neoforged:neoforge:', loader: 'NeoForge' },
    { prefix: 'net.minecraftforge:forge:', loader: 'Forge' },
    { prefix: 'net.fabricmc:fabric-loader:', loader: 'Fabric' },
    { prefix: 'org.quiltmc:quilt-loader:', loader: 'Quilt' },
    { prefix: 'optifine:OptiFine:', loader: 'OptiFine' },
  ];
  for (const candidate of candidates) {
    const coordinate = libraries.find(library => library.name?.startsWith(candidate.prefix))?.name;
    if (coordinate) return { loader: candidate.loader, loaderVersion: coordinate.slice(candidate.prefix.length).split(':')[0] };
  }
  const id = chain[0]?.id || '';
  if (/neoforge/i.test(id)) return { loader: 'NeoForge', loaderVersion: '' };
  if (/forge/i.test(id)) return { loader: 'Forge', loaderVersion: '' };
  if (/fabric/i.test(id)) return { loader: 'Fabric', loaderVersion: '' };
  return { loader: '原版', loaderVersion: '' };
}

export function javaRequirement(minecraftVersion: string, declared?: number): number {
  if (declared && Number.isFinite(declared)) return declared;
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(minecraftVersion);
  if (!match) return 17;
  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

async function versionInstance(root: string, versionId: string, name?: string, source: LauncherInstance['source'] = 'minecraft'): Promise<LauncherInstance> {
  let gameDirectory = root;
  const isolated = path.join(root, 'versions', versionId);
  for (const marker of ['mods', 'saves', 'config']) {
    if ((await stat(path.join(isolated, marker)).catch(() => undefined))?.isDirectory()) {
      gameDirectory = isolated;
      break;
    }
  }
  const base: LauncherInstance = {
    id: stableId(`${root}|${versionId}`), name: name || versionId, path: root, gameDirectory,
    minecraftVersion: versionId, loader: '未知', loaderVersion: '', kind: 'client', status: 'incomplete',
    issues: [], stats: await collectInstanceStats(gameDirectory), versionId, source,
  };
  try {
    const chain = await readVersionChain(root, versionId);
    base.minecraftVersion = chain.at(-1)!.id;
    Object.assign(base, detectLoader(chain));
    base.requiredJavaMajor = javaRequirement(base.minecraftVersion, chain.find(entry => entry.data.javaVersion)?.data.javaVersion?.majorVersion);
    base.issues = await inspectClientResources(root, versionId);
    base.status = base.issues.length ? 'incomplete' : 'ready';
  } catch (error) {
    base.issues.push(error instanceof Error && /继承|无效|大小异常/.test(error.message) ? error.message : '版本配置缺失或损坏，无法解析启动依赖');
  }
  const log = await stat(path.join(gameDirectory, 'logs', 'latest.log')).catch(() => undefined);
  if (log) base.lastPlayed = log.mtime.toISOString();
  return base;
}

async function prismInstance(directory: string): Promise<LauncherInstance | undefined> {
  if (!await exists(path.join(directory, 'mmc-pack.json'))) return undefined;
  const gameDirectory = await exists(path.join(directory, '.minecraft')) ? path.join(directory, '.minecraft') : path.join(directory, 'minecraft');
  const configuration = await readText(path.join(directory, 'instance.cfg')).catch(() => '');
  const name = /^name=(.+)$/m.exec(configuration)?.[1]?.trim() || path.basename(directory);
  const metadata = await readJson<{ components?: { uid: string; version: string }[] }>(path.join(directory, 'mmc-pack.json')).catch(() => ({} as { components?: { uid: string; version: string }[] }));
  const components = metadata.components || [];
  const minecraftVersion = components.find(component => component.uid === 'net.minecraft')?.version || '未知版本';
  const loader = components.find(component => /forge|fabric|quilt/i.test(component.uid));
  return {
    id: stableId(`${directory}|prism`), name, path: directory, gameDirectory,
    minecraftVersion, loader: loader ? /neoforge/i.test(loader.uid) ? 'NeoForge' : /forge/i.test(loader.uid) ? 'Forge' : /fabric/i.test(loader.uid) ? 'Fabric' : 'Quilt' : '原版',
    loaderVersion: loader?.version || '', kind: 'client', status: 'incomplete',
    issues: ['已识别 Prism 实例。首版需导入含 versions、libraries 和 assets 的 Minecraft 目录后启动。'],
    stats: await collectInstanceStats(gameDirectory), source: 'prism', requiredJavaMajor: javaRequirement(minecraftVersion),
  };
}

async function serverInstance(directory: string): Promise<LauncherInstance | undefined> {
  const scriptPath = await exists(path.join(directory, 'run.bat')) ? path.join(directory, 'run.bat') : path.join(directory, 'run.sh');
  const hasProperties = await exists(path.join(directory, 'server.properties'));
  if (!hasProperties || !await exists(scriptPath)) return undefined;
  const script = await readText(scriptPath, 256 * 1024).catch(() => '');
  const argumentsRelative = /@(?:"|')?(libraries[\\/]net[\\/]minecraftforge[\\/]forge[\\/][^\s"']+[\\/](?:win|unix)_args\.txt)/i.exec(script)?.[1]?.replace(/[\\/]/g, path.sep);
  const forge = argumentsRelative && /(?:^|[\\/])forge[\\/]([^\\/]+)/i.exec(argumentsRelative)?.[1];
  const minecraftVersion = forge?.split('-')[0] || '未知版本';
  const issues: string[] = [];
  let serverArgumentsFile: string | undefined;
  if (argumentsRelative) {
    const filename = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    serverArgumentsFile = safeChild(directory, path.join(path.dirname(argumentsRelative), filename));
    if (!await exists(serverArgumentsFile)) {
      issues.push('缺少 Forge 服务端运行依赖（libraries），请导入完整服务端包');
    } else {
      const argumentsText = await readText(serverArgumentsFile).catch(() => '');
      const referenced = [...new Set(argumentsText.match(/libraries[\\/][^\s;"']+\.jar/gi) || [])];
      let missing = 0;
      for (const library of referenced) {
        if (!await exists(safeChild(directory, library.replace(/[\\/]/g, path.sep)))) missing++;
      }
      if (missing) issues.push(`服务端缺少 ${missing} 个运行依赖文件`);
      if (!referenced.length) issues.push('服务端参数文件不完整，未找到运行依赖');
    }
  } else {
    issues.push('未识别标准 Forge 参数文件，首版暂不执行自定义启动脚本');
  }
  const eula = await readText(path.join(directory, 'eula.txt'), 128 * 1024).catch(() => '');
  if (!/^\s*eula\s*=\s*true\s*$/im.test(eula)) issues.push('服务端 EULA 尚未同意，请阅读后在服务端目录自行确认');
  const stats = await collectInstanceStats(directory);
  // Only use the world's configured name; never expose RCON or other server credentials.
  const properties = await readText(path.join(directory, 'server.properties'), 256 * 1024).catch(() => '');
  const levelName = /^level-name\s*=\s*(.+)$/m.exec(properties)?.[1]?.trim() || 'world';
  const worldDirectories: string[] = [];
  try {
    const worldDirectory = safeChild(directory, levelName);
    if (await exists(path.join(worldDirectory, 'level.dat'))) {
      stats.saves = Math.max(stats.saves, 1);
      worldDirectories.push(worldDirectory);
    }
  } catch { /* Do not follow world names outside the imported server directory. */ }
  return {
    id: stableId(`${directory}|server`), name: `${path.basename(directory)} · 服务端`, path: directory, gameDirectory: directory,
    minecraftVersion, loader: forge ? 'Forge' : '未知', loaderVersion: forge?.slice(minecraftVersion.length + 1) || '',
    kind: 'server', status: issues.length ? 'incomplete' : 'ready', issues,
    stats, source: 'server', serverArgumentsFile, worldDirectories,
    requiredJavaMajor: javaRequirement(minecraftVersion),
  };
}

/** Read known game metadata only; never reads launcher account/configuration token files. */
export async function scanInstances(roots: string[]): Promise<InstanceScanResult> {
  const instances = new Map<string, LauncherInstance>();
  const warnings: string[] = [];
  const visited = new Set<string>();
  async function inspect(directory: string, depth: number): Promise<void> {
    const absolute = path.resolve(directory);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (visited.has(key) || depth > 3) return;
    visited.add(key);
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isDirectory()) return;
    const modpackMarkerPath = path.join(absolute, '.arcane-modpack.json');
    const modpack = await exists(modpackMarkerPath)
      ? await readJson<{ schemaVersion?: number; state?: string; versionId?: string; name?: string }>(modpackMarkerPath).catch(() => null)
      : undefined;
    const prism = modpack === undefined ? await prismInstance(absolute) : undefined;
    if (prism) instances.set(prism.id, prism);
    const server = modpack === undefined ? await serverInstance(absolute) : undefined;
    if (server) instances.set(server.id, server);
    const versions = await directories(path.join(absolute, 'versions'));
    for (const versionId of versions.slice(0, 200)) {
      if (modpack !== undefined && (!modpack || modpack.schemaVersion !== 1 || modpack.state !== 'complete' || versionId !== modpack.versionId)) continue;
      if (!safeVersionId(versionId) || !await exists(path.join(absolute, 'versions', versionId, `${versionId}.json`))) continue;
      const instance = await versionInstance(absolute, versionId, modpack?.name);
      instances.set(instance.id, instance);
    }
    // A managed pack is one independent client, including while incomplete.
    // Bundled launcher layouts must not expose child instances around its marker.
    if (modpack !== undefined) return;
    for (const child of ['.minecraft', 'minecraft', 'instances', '游戏', 'Games']) {
      if (!await exists(path.join(absolute, child))) continue;
      if (child === 'instances' || child === '游戏' || child === 'Games') {
        for (const name of (await directories(path.join(absolute, child))).slice(0, 100)) await inspect(path.join(absolute, child, name), depth + 1);
      } else {
        await inspect(path.join(absolute, child), depth + 1);
      }
    }
    // A selected parent directory may contain named portable launcher instances.
    if (depth === 0 && versions.length === 0 && !prism) {
      for (const name of (await directories(absolute)).slice(0, 80)) {
        if (['PCL', 'logs', 'libraries', 'assets', 'mods', 'saves', 'node_modules', 'arcane-launcher'].includes(name)) continue;
        const child = path.join(absolute, name);
        if (await exists(path.join(child, '.minecraft')) || await exists(path.join(child, 'versions')) || await exists(path.join(child, 'mmc-pack.json'))) {
          await inspect(child, depth + 1);
        }
      }
    }
  }
  for (const root of [...new Set(roots)].slice(0, 30)) {
    try {
      if (!await exists(root)) { warnings.push(`扫描目录不存在：${root}`); continue; }
      await inspect(root, 0);
    } catch {
      warnings.push(`无法完整读取目录：${root}`);
    }
  }
  return { instances: [...instances.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-CN')), warnings };
}
