import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell, safeStorage, nativeImage } from 'electron'
import { mkdir, readFile, writeFile, rename, readdir, stat, access, realpath, cp, rm, open } from 'node:fs/promises'
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { FolderTarget, LauncherInstance, LauncherSettings, LauncherSnapshot, LaunchEvent, ModpackInstallResult, ModpackJob, ResourceEntry, ResourceKind, TaskProgress } from '../shared/contracts'
import { scanInstances, detectJava, readInstanceLog, prepareLaunch, launchInstance, redactSensitiveText } from './services/index'
import { backupDirectories } from './services/backup'
import { AccountService, validateSkinPng, type StoredAccount } from './services/account'
import { ModpackInstallManager } from './services/modpack-manager'
import { CatalogService } from './services/catalog'
import { exportCatalogFile } from './services/catalog-export'
import { publishMods, type DownloadedMod } from './services/mod-publisher'
import { validateVanillaVersionId } from './services/installer'
import { createElectronDownloadFetch } from './services/electron-download-fetch'
import { gameWindowSize } from './services/game-window'
import { HiddenInstanceRegistry, InstanceRemovalTickets, planInstanceRemoval, deleteOwnedInstance } from './services/instance-removal'
import { probeGameDirectoryUsage } from './services/game-process-probe'
import { MICROSOFT_APPLICATION } from '../shared/microsoft-app'
import { sanitizeAccountPreferences } from './services/account-preferences'

const currentDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDir, '../..')
const workspaceArgumentIndex = process.argv.indexOf('--workspace')
const workspaceArgument = workspaceArgumentIndex >= 0 ? process.argv[workspaceArgumentIndex + 1] : undefined
const workspaceRoot = workspaceArgument && isAbsolute(workspaceArgument)
  ? resolve(workspaceArgument)
  : app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe')) : resolve(projectRoot, '..')
const rendererFile = resolve(currentDir, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ARCANE_DEV_URL : undefined
const processes = new Map<string, ChildProcess>()
const startingInstances = new Set<string>()
const backingUpInstances = new Set<string>()
const removingInstances = new Set<string>()
const instanceRemovalTickets = new InstanceRemovalTickets()
let window: BrowserWindow | null = null
let currentSnapshot: LauncherSnapshot | null = null
let discoveredInstances: LauncherInstance[] = []
let hiddenInstances: HiddenInstanceRegistry
let scanning: Promise<LauncherSnapshot> | null = null
let installing = false
let settings: LauncherSettings
let accounts: AccountService
let modpacks: ModpackInstallManager
let catalog: CatalogService
const downloadControllers = new Map<string, AbortController>()
const appFetch = createElectronDownloadFetch(net)
let accountPreferences: { clientId: string; localSkin?: string } = { clientId: '' }

async function writeAccountFile(name: string, content: string | Buffer) {
  const root = app.getPath('userData')
  await mkdir(root, { recursive: true })
  const temp = join(root, `${name}.${randomUUID()}.tmp`)
  await writeFile(temp, content)
  await rename(temp, join(root, name))
}
async function readAccountFile(name: string, maximumBytes: number): Promise<Buffer> {
  const file = await open(join(app.getPath('userData'), name), 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maximumBytes) throw new Error('本地账号文件无效或过大，请重新登录。')
    const buffer = Buffer.alloc(Math.min(info.size + 1, maximumBytes + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maximumBytes) throw new Error('本地账号文件超过允许大小。')
    return buffer.subarray(0, length)
  } finally { await file.close() }
}
async function loadAccount() {
  try { accountPreferences = sanitizeAccountPreferences(JSON.parse((await readAccountFile('account-preferences.json', 2 * 1024 * 1024)).toString('utf8'))) } catch { /* Missing or corrupt preferences use the bundled application identity. */ }
  const clientId = process.env.SHENBCL_MICROSOFT_CLIENT_ID || accountPreferences.clientId || MICROSOFT_APPLICATION.clientId
  let saved: StoredAccount | null = null
  try {
    if (await safeStorage.isAsyncEncryptionAvailable()) saved = JSON.parse((await safeStorage.decryptStringAsync(await readAccountFile('account.encrypted', 4 * 1024 * 1024))).result)
  } catch { /* Corrupt or unavailable credentials require signing in again. */ }
  accounts = new AccountService(clientId, saved, {
    fetch: appFetch,
    persist: async (record) => {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows 凭据加密暂不可用，账号未保存，请稍后重试。')
      await writeAccountFile('account.encrypted', await safeStorage.encryptStringAsync(JSON.stringify(record)))
    },
    changed: (state) => window?.webContents.send('arcane:account-changed', state),
  })
  if (accountPreferences.localSkin?.startsWith('data:image/png;base64,')) accounts.setLocalSkin(accountPreferences.localSkin)
}

protocol.registerSchemesAsPrivileged([{ scheme: 'arcane-image', privileges: { secure: true, standard: true, supportFetchAPI: true } }])

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const defaultSettings = (): LauncherSettings => ({ roots: [workspaceRoot], javaPath: '', memoryMb: Math.min(6144, Math.floor(totalmem() / 1024 ** 2 / 3 / 512) * 512), playerName: 'Traveler', closeOnLaunch: false })
async function exists(path: string) { try { await access(path); return true } catch { return false } }
function safeWithin(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return !rel.startsWith('..') && !isAbsolute(rel)
}

async function loadSettings() {
  settings = defaultSettings()
  try { const saved = JSON.parse(await readFile(settingsFile(), 'utf8')); settings = sanitizeSettings(saved) } catch { /* First launch. */ }
  settings = sanitizeSettings({ roots: [join(app.getPath('userData'), 'instances'), ...settings.roots] })
}

function sanitizeSettings(patch: Partial<LauncherSettings>): LauncherSettings {
  const base = settings ?? defaultSettings()
  const memory = Number(patch.memoryMb ?? base.memoryMb)
  const playerName = String(patch.playerName ?? base.playerName).trim()
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(playerName)) throw new Error('玩家名请使用 3–16 位英文字母、数字或下划线。')
  if (!Number.isInteger(memory) || memory < 1024 || memory > Math.max(1024, Math.floor(totalmem() / 1024 ** 2) - 1536)) throw new Error('内存应至少为 1024 MB，并为系统保留至少 1.5 GB。')
  const roots = patch.roots ?? base.roots
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || !isAbsolute(root))) throw new Error('实例目录必须是有效的绝对路径。')
  const javaPath = String(patch.javaPath ?? base.javaPath)
  if (javaPath && !isAbsolute(javaPath)) throw new Error('Java 路径必须是绝对路径。')
  return { roots: [...new Set(roots.map((root) => resolve(root)))].slice(0, 30), javaPath, memoryMb: memory, playerName, closeOnLaunch: Boolean(patch.closeOnLaunch ?? base.closeOnLaunch) }
}

async function persistSettings(next: LauncherSettings) {
  await mkdir(dirname(settingsFile()), { recursive: true })
  const temp = `${settingsFile()}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
  await rename(temp, settingsFile())
  settings = next
}

async function snapshot(): Promise<LauncherSnapshot> {
  if (scanning) return scanning
  scanning = (async () => {
    const [scan, java] = await Promise.all([scanInstances(settings.roots), detectJava(settings.javaPath ? [settings.javaPath] : [])])
    discoveredInstances = scan.instances
    currentSnapshot = { instances: scan.instances.filter(instance => !hiddenInstances.isHidden(instance.id)), java, settings: { ...settings }, scannedAt: new Date().toISOString(), warnings: scan.warnings }
    return currentSnapshot
  })()
  try { return await scanning } finally { scanning = null }
}

async function instanceById(id: string): Promise<LauncherInstance> {
  if (typeof id !== 'string') throw new Error('无效的实例。')
  if (!currentSnapshot) await snapshot()
  const instance = currentSnapshot?.instances.find((item) => item.id === id)
  if (!instance) throw new Error('找不到此实例，请重新扫描。')
  return instance
}

function sendLaunch(event: Omit<LaunchEvent, 'timestamp'>) {
  window?.webContents.send('arcane:launch-event', { ...event, message: redactSensitiveText(event.message), timestamp: new Date().toISOString() })
}
function sendTask(event: TaskProgress) { window?.webContents.send('arcane:task-progress', event) }
function clientWindowSize() {
  const primary = screen.getPrimaryDisplay().workAreaSize
  const current = window ? screen.getDisplayMatching(window.getBounds()).workAreaSize : primary
  // GLFW may initially create the game on the primary display even if the launcher is elsewhere.
  return gameWindowSize({ width: Math.min(primary.width, current.width), height: Math.min(primary.height, current.height) })
}

function trustedFrame(url: string) {
  if (devUrl) { try { return new URL(url).origin === new URL(devUrl).origin } catch { return false } }
  try { return fileURLToPath(url.split('#')[0]) === rendererFile } catch { return false }
}
function handle(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(`arcane:${name}`, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || !trustedFrame(event.senderFrame?.url ?? '')) return { ok: false, error: '此页面无权访问本地功能。' }
    try { return { ok: true, data: await callback(...args) } } catch (error) { return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) } }
  })
}

const resourceFolders: ResourceKind[] = ['mods', 'saves', 'screenshots', 'resourcepacks', 'shaderpacks']
function folderFor(instance: LauncherInstance, target: FolderTarget) {
  if (target === 'root') return instance.gameDirectory
  if (target === 'saves' && instance.kind === 'server') return instance.worldDirectories?.length === 1 ? instance.worldDirectories[0] : instance.gameDirectory
  if (![...resourceFolders, 'logs'].includes(target)) throw new Error('不支持的资源类型。')
  return join(instance.gameDirectory, target)
}

function registerHandlers() {
  handle('inspect-modpack', async () => {
    const chosen = await dialog.showOpenDialog(window!, { title: '选择整合包文件', properties: ['openFile'], filters: [{ name: 'Minecraft 整合包', extensions: ['zip', 'mrpack'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return modpacks.inspect(chosen.filePaths[0])
  })
  handle('inspect-dropped-modpack', async (archivePath) => {
    if (typeof archivePath !== 'string' || !isAbsolute(archivePath) || !/\.(zip|mrpack)$/i.test(archivePath)) throw new Error('请拖入本机的 ZIP 或 MRPACK 整合包文件。')
    return modpacks.inspect(archivePath)
  })
  const finishModpack = async (run: () => Promise<{destination: string; versionId: string}>): Promise<ModpackInstallResult> => {
    if (installing || removingInstances.size) throw new Error('已有安装或移除任务正在进行，请等待完成或取消。')
    installing = true
    try {
      const result = await run()
      await persistSettings(sanitizeSettings({ roots: [...settings.roots, result.destination] }))
      if (scanning) await scanning
      const next = await snapshot()
      const instance = next.instances.find(item => item.path === result.destination && item.versionId === result.versionId)
      if (!instance) throw new Error('整合包安装完成，但实例扫描失败，请重新扫描。')
      const installed = { snapshot: next, instanceId: instance.id }
      window?.webContents.send('arcane:modpack-installed', installed)
      return installed
    } finally { installing = false }
  }
  handle('install-modpack', (id, name) => finishModpack(() => modpacks.start(id, name)))
  handle('resume-modpack', (id) => finishModpack(() => modpacks.resume(id)))
  handle('modpack-jobs', () => modpacks.list())
  handle('cancel-modpack', (id) => modpacks.cancel(id))
  handle('dismiss-modpack', async (id) => {
    await modpacks.dismiss(id)
    window?.webContents.send('arcane:modpack-job-removed', id)
  })
  handle('cancel-task', async (id) => {
    if (typeof id !== 'string') throw new Error('无效的下载任务。')
    if (id.startsWith('modpack-')) return modpacks.cancel(id.slice('modpack-'.length))
    const controller = downloadControllers.get(id)
    if (!controller) throw new Error('该任务已经结束。')
    controller.abort(new Error('任务已取消。'))
  })
  handle('catalog-minecraft-versions', () => catalog.minecraftVersions())
  handle('catalog-search', (query) => catalog.search(query))
  handle('catalog-versions', (projectId, filter) => catalog.versions(projectId, filter))
  handle('catalog-save-file', async (ticket) => {
    const metadata = catalog.ticket(ticket)
    const id = `catalog-save-${ticket}`
    if (downloadControllers.has(id)) throw new Error('该文件已经在下载。')
    const controller = new AbortController(); downloadControllers.set(id, controller)
    const label = metadata.type === 'mod' ? '下载模组文件' : '下载整合包文件'
    try {
      const chosen = await dialog.showSaveDialog(window!, {
        title: label,
        defaultPath: join(app.getPath('downloads'), metadata.filename),
        filters: [{ name: metadata.type === 'mod' ? 'Minecraft 模组' : 'Modrinth 整合包', extensions: [metadata.type === 'mod' ? 'jar' : 'mrpack'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (chosen.canceled || !chosen.filePath) return null
      controller.signal.throwIfAborted()
      sendTask({ id, label, status: 'running', message: '正在下载并校验文件' })
      const file = await catalog.download(ticket, join(app.getPath('userData'), 'download-cache'), {
        signal: controller.signal,
        onProgress: (completed, total) => sendTask({ id, label, status: 'running', message: '正在下载并校验文件', completed, total }),
      })
      controller.signal.throwIfAborted()
      sendTask({ id, label, status: 'running', message: '正在保存到所选位置' })
      const saved = await exportCatalogFile(file.path, chosen.filePath, metadata, { signal: controller.signal })
      sendTask({ id, label, status: 'complete', message: `文件已保存：${metadata.filename}` })
      return saved
    } catch (error) {
      const cancelled = controller.signal.aborted
      sendTask({ id, label, status: cancelled ? 'cancelled' : 'error', message: cancelled ? '文件下载已取消。' : error instanceof Error ? error.message : String(error) })
      if (cancelled) throw new Error('文件下载已取消。')
      throw error
    } finally { downloadControllers.delete(id) }
  })
  handle('catalog-download-pack', async (ticket) => {
    if (catalog.ticket(ticket).type !== 'modpack') throw new Error('请选择整合包文件。')
    const id = `catalog-pack-${ticket}`
    if (downloadControllers.has(id)) throw new Error('该整合包已经在下载。')
    const controller = new AbortController(); downloadControllers.set(id, controller)
    try {
      const file = await catalog.download(ticket, join(app.getPath('userData'), 'download-cache'), { signal: controller.signal, onProgress: (completed, total) => sendTask({ id, label: '下载整合包', status: 'running', message: '正在下载并校验整合包文件', completed, total }) })
      controller.signal.throwIfAborted()
      const preview = await modpacks.inspect(file.path)
      controller.signal.throwIfAborted()
      sendTask({ id, label: '下载整合包', status: 'complete', message: '整合包已下载，请确认安装名称。' })
      return preview
    } catch (error) {
      const cancelled = controller.signal.aborted
      sendTask({ id, label: '下载整合包', status: cancelled ? 'cancelled' : 'error', message: cancelled ? '整合包下载已取消。' : error instanceof Error ? error.message : String(error) })
      if (cancelled) throw new Error('整合包下载已取消。')
      throw error
    } finally { downloadControllers.delete(id) }
  })
  handle('catalog-install-mod', async (ticket, instanceId) => {
    if (installing || removingInstances.size) throw new Error('已有安装或移除任务正在进行。')
    if (catalog.ticket(ticket).type !== 'mod') throw new Error('请选择模组文件。')
    const id = `catalog-mod-${ticket}`
    const controller = new AbortController(); downloadControllers.set(id, controller)
    installing = true
    try {
      const instance = await instanceById(instanceId)
      controller.signal.throwIfAborted()
      if (instance.kind !== 'client' || instance.status !== 'ready') throw new Error('请选择安装完整的客户端实例。')
      if (processes.has(instance.id) || startingInstances.has(instance.id)) throw new Error('请先关闭该实例，再安装模组。')
      const loader = instance.loader.toLowerCase()
      if (!['forge', 'neoforge', 'fabric', 'quilt'].includes(loader)) throw new Error('此客户端尚未安装模组加载器。')
      sendTask({ id, label: '安装模组', status: 'running', message: '正在解析兼容版本与必需依赖' })
      const plan = await catalog.resolveModDependencies(ticket, { minecraftVersion: instance.minecraftVersion, loader }, { signal: controller.signal })
      controller.signal.throwIfAborted()
      const files: DownloadedMod[] = []
      for (let index = 0; index < plan.length; index++) {
        const item = plan[index]
        const file = await catalog.download(item.id, join(app.getPath('userData'), 'download-cache'), { signal: controller.signal, onProgress: (completed, total) => sendTask({ id, label: '安装模组', status: 'running', message: `下载并校验 ${index + 1}/${plan.length} · ${item.filename}`, completed, total }) })
        files.push({ filename: file.filename, source: file.path, size: item.size, sha512: item.sha512, sha1: item.sha1 })
      }
      controller.signal.throwIfAborted()
      if (processes.has(instance.id) || startingInstances.has(instance.id)) throw new Error('该实例已启动，请关闭后再安装模组。')
      const result = await publishMods(instance.gameDirectory, files, controller.signal)
      sendTask({ id, label: '安装模组', status: 'complete', message: `已安装 ${result.added} 个模组文件，复用 ${result.reused} 个已有文件。` })
      if (scanning) await scanning
      return snapshot()
    } catch (error) {
      const cancelled = controller.signal.aborted
      sendTask({ id, label: '安装模组', status: cancelled ? 'cancelled' : 'error', message: cancelled ? '模组安装已取消。' : error instanceof Error ? error.message : String(error) })
      if (cancelled) throw new Error('模组安装已取消。')
      throw error
    } finally { installing = false; downloadControllers.delete(id) }
  })
  handle('account', () => accounts.state())
  handle('configure-account', async (clientId) => {
    const next = await accounts.configure(clientId)
    accountPreferences.clientId = next.clientId
    await writeAccountFile('account-preferences.json', JSON.stringify(accountPreferences))
    return next
  })
  handle('begin-login', async () => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows 凭据加密暂不可用，请稍后再登录。')
    return accounts.begin()
  })
  handle('cancel-login', () => accounts.cancel())
  handle('open-login', async () => {
    const device = accounts.state().device
    if (!device || device.expiresAt <= Date.now()) throw new Error('请先获取有效的登录代码。')
    await shell.openExternal('https://www.microsoft.com/link')
  })
  handle('refresh-account', async () => { await accounts.identity(true); return accounts.state() })
  handle('logout-account', () => accounts.logout())
  handle('import-preview-skin', async () => {
    const chosen = await dialog.showOpenDialog(window!, { title: '选择本地预览皮肤（不会修改游戏内皮肤）', properties: ['openFile'], filters: [{ name: 'Minecraft PNG 皮肤', extensions: ['png'] }] })
    if (chosen.canceled) return null
    const path = chosen.filePaths[0]
    if ((await stat(path)).size > 1024 * 1024) throw new Error('皮肤文件不能超过 1 MB。')
    const bytes = await readFile(path)
    validateSkinPng(bytes)
    if (nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('无法解码这张 PNG 皮肤。')
    accountPreferences.localSkin = `data:image/png;base64,${bytes.toString('base64')}`
    await writeAccountFile('account-preferences.json', JSON.stringify(accountPreferences))
    return accounts.setLocalSkin(accountPreferences.localSkin)
  })
  handle('snapshot', snapshot)
  handle('runtime', () => ({ appVersion: app.getVersion(), platform: process.platform, totalMemoryMb: Math.floor(totalmem() / 1024 ** 2), workspaceRoot }))
  handle('import-directory', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: '选择游戏或整合包目录', properties: ['openDirectory'], defaultPath: workspaceRoot })
    if (selected.canceled) return null
    if (removingInstances.size) throw new Error('正在移除实例，请稍后再导入。')
    const restored = await scanInstances(selected.filePaths)
    await hiddenInstances.restore(restored.instances.map(instance => instance.id))
    await persistSettings(sanitizeSettings({ roots: [...settings.roots, ...selected.filePaths] }))
    return snapshot()
  })
  handle('prepare-instance-removal', async (id) => {
    if (typeof id !== 'string') throw new Error('无效的实例。')
    if (installing || removingInstances.size) throw new Error('已有安装或移除任务正在进行，请稍后再试。')
    if (backingUpInstances.has(id)) throw new Error('存档正在备份，完成后再移除实例。')
    removingInstances.add(id)
    try {
      if (scanning) await scanning
      await snapshot()
      const instance = await instanceById(id)
      const managedRoot = join(app.getPath('userData'), 'instances')
      const plan = await planInstanceRemoval(instance, discoveredInstances, managedRoot)
      const usage = processes.has(id) || startingInstances.has(id) ? 'running'
        : plan.ownedPath ? await probeGameDirectoryUsage([instance.path, instance.gameDirectory]) : 'clear'
      return instanceRemovalTickets.prepare(instance, plan, usage)
    } finally { removingInstances.delete(id) }
  })
  handle('confirm-instance-removal', async (token) => {
    const authorization = instanceRemovalTickets.consume(token)
    const id = authorization.instanceId
    if (installing || removingInstances.size) throw new Error('已有安装或移除任务正在进行，请重新打开确认窗口。')
    if (processes.has(id) || startingInstances.has(id)) throw new Error('请先关闭此游戏或服务器，再删除实例。')
    if (backingUpInstances.has(id)) throw new Error('存档正在备份，完成后再删除实例。')
    removingInstances.add(id)
    try {
      if (scanning) await scanning
      await snapshot()
      const instance = await instanceById(id)
      if (resolve(instance.path).toLowerCase() !== resolve(authorization.instancePath).toLowerCase()) throw new Error('实例位置已经变化，请重新打开确认窗口。')
      if (authorization.action === 'delete') {
        const managedRoot = join(app.getPath('userData'), 'instances')
        await deleteOwnedInstance(authorization.plan, instance, discoveredInstances, managedRoot, directory => rm(directory, { recursive: true, force: false }), async () => {
          const usage = await probeGameDirectoryUsage([instance.path, instance.gameDirectory])
          if (usage === 'running') throw new Error('此实例的游戏已经启动，未删除任何文件。请先退出游戏。')
          if (usage !== 'clear') throw new Error('暂时无法确认游戏进程已退出，未删除任何文件。请关闭游戏和相关 Java 程序后重试。')
        })
        await persistSettings(sanitizeSettings({ roots: settings.roots.filter(root => resolve(root).toLowerCase() !== resolve(authorization.plan.ownedPath!).toLowerCase()) }))
        if (authorization.plan.jobId) {
          await modpacks.dismiss(authorization.plan.jobId).then(() => window?.webContents.send('arcane:modpack-job-removed', authorization.plan.jobId)).catch(() => {})
        }
      }
      await hiddenInstances.hide(id)
      if (scanning) await scanning
      return snapshot()
    } finally { removingInstances.delete(id) }
  })
  handle('save-settings', async (patch) => { await persistSettings(sanitizeSettings(patch)); return snapshot() })
  handle('choose-java', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: '选择 java.exe', properties: ['openFile'], filters: [{ name: 'Java runtime', extensions: ['exe'] }] })
    return selected.canceled ? null : selected.filePaths[0]
  })
  handle('read-log', async (id) => readInstanceLog(await instanceById(id)))
  handle('prepare-launch', async (id) => {
    const instance = await instanceById(id)
    return prepareLaunch(instance, settings, currentSnapshot!.java, instance.kind === 'client' ? await accounts.identity() : undefined, clientWindowSize())
  })
  handle('launch', async (id) => {
    if (installing) throw new Error('正在安装游戏或模组，请等待完成或取消后再启动。')
    if (typeof id !== 'string') throw new Error('无效的实例。')
    if (removingInstances.has(id)) throw new Error('正在移除此实例，请稍后再试。')
    if (processes.has(id) || startingInstances.has(id)) throw new Error('这个实例已经在运行或准备启动。')
    if (backingUpInstances.has(id)) throw new Error('存档正在备份，完成后再启动。')
    startingInstances.add(id)
    try {
      const instance = await instanceById(id)
      sendLaunch({ instanceId: id, type: 'starting', message: '正在检查运行环境与游戏文件…' })
      const identity = instance.kind === 'client' ? await accounts.identity() : undefined
      const child = await launchInstance(instance, settings, currentSnapshot!.java, identity, clientWindowSize())
      processes.set(id, child)
      child.stdout?.on('data', (data) => sendLaunch({ instanceId: id, type: 'stdout', message: data.toString('utf8') }))
      child.stderr?.on('data', (data) => sendLaunch({ instanceId: id, type: 'stderr', message: data.toString('utf8') }))
      child.on('error', (error) => { processes.delete(id); sendLaunch({ instanceId: id, type: 'error', message: error.message }) })
      child.on('exit', (code) => { processes.delete(id); sendLaunch({ instanceId: id, type: 'exit', message: code === 0 ? '游戏已正常退出。' : `进程已退出，退出码 ${code ?? '未知'}。`, exitCode: code }) })
      sendLaunch({ instanceId: id, type: 'started', message: `${instance.kind === 'server' ? '服务器' : '游戏'}进程已启动。`, pid: child.pid })
      if (settings.closeOnLaunch) window?.minimize()
      return { pid: child.pid }
    } catch (error) { sendLaunch({ instanceId: id, type: 'error', message: error instanceof Error ? error.message : String(error) }); throw error } finally { startingInstances.delete(id) }
  })
  handle('stop', async (id) => {
    const child = processes.get(id)
    if (!child) throw new Error('此实例没有正在运行的进程。')
    const instance = await instanceById(id)
    if (instance.kind === 'server' && child.stdin?.writable) child.stdin.write('stop\n')
    else child.kill()
  })
  handle('open-folder', async (id, target) => {
    const folder = folderFor(await instanceById(id), target)
    if (!await exists(folder)) throw new Error('这个目录尚未生成，运行游戏后再试。')
    const error = await shell.openPath(folder)
    if (error) throw new Error(error)
  })
  handle('resources', async (id, kind): Promise<ResourceEntry[]> => {
    const instance = await instanceById(id)
    if (!resourceFolders.includes(kind)) throw new Error('不支持的资源类型。')
    if (kind === 'saves' && instance.kind === 'server') {
      return Promise.all((instance.worldDirectories ?? []).map(async (directory) => {
        const info = await stat(directory)
        return { name: basename(directory), size: 0, directory: true, modifiedAt: info.mtime.toISOString() }
      }))
    }
    const folder = folderFor(instance, kind)
    if (!await exists(folder)) return []
    const entries = await readdir(folder, { withFileTypes: true })
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink() && !entry.name.startsWith('.')).slice(0, 1000).map(async (entry) => {
      const info = await stat(join(folder, entry.name))
      return { name: entry.name, size: info.size, directory: entry.isDirectory(), modifiedAt: info.mtime.toISOString(), previewUrl: kind === 'screenshots' && /\.(png|jpe?g|webp)$/i.test(entry.name) ? `arcane-image://${id}/${encodeURIComponent(entry.name)}` : undefined }
    }))
    return result.sort((a, b) => kind === 'screenshots' ? b.modifiedAt.localeCompare(a.modifiedAt) : a.name.localeCompare(b.name))
  })
  handle('export-diagnostics', async (id) => {
    const instance = await instanceById(id)
    const log = await readInstanceLog(instance)
    const report = redactSensitiveText(JSON.stringify({ exportedAt: new Date().toISOString(), instance, java: currentSnapshot?.java, memoryMb: settings.memoryMb, log: log.content }, null, 2))
    const save = await dialog.showSaveDialog(window!, { title: '保存诊断报告', defaultPath: `shenBCL-diagnostics-${instance.minecraftVersion}.txt`, filters: [{ name: '诊断报告', extensions: ['txt'] }] })
    if (save.canceled || !save.filePath) return null
    await writeFile(save.filePath, report, 'utf8')
    return save.filePath
  })
  handle('backup', async (id) => {
    if (typeof id !== 'string') throw new Error('无效的实例。')
    if (removingInstances.has(id)) throw new Error('正在移除此实例，请稍后再试。')
    if (backingUpInstances.has(id)) throw new Error('这个实例的存档正在备份。')
    if (processes.has(id) || startingInstances.has(id)) throw new Error('请先关闭此游戏或服务器，再创建一致的存档备份。')
    backingUpInstances.add(id)
    try {
      const instance = await instanceById(id)
      const source = join(instance.gameDirectory, 'saves')
      const sources = instance.kind === 'server'
        ? (instance.worldDirectories ?? []).map((path) => ({ path, name: basename(path) }))
        : [{ path: source, name: 'saves' }]
      if (!sources.length || !await exists(sources[0].path)) throw new Error('此实例尚未发现存档目录，暂时没有可以备份的世界。')
      if (instance.kind === 'client' && !(await readdir(source)).length) throw new Error('存档目录为空，暂时没有需要备份的世界。')
      const target = join(app.getPath('userData'), 'backups', id, new Date().toISOString().replace(/[:.]/g, '-'))
      sendTask({ id: 'backup', label: '存档备份', status: 'running', message: '正在复制世界文件，请保持游戏关闭…' })
      await backupDirectories({ sources, destination: target })
      sendTask({ id: 'backup', label: '存档备份', status: 'complete', message: '存档已备份。' })
      return target
    } catch (error) { sendTask({ id: 'backup', label: '存档备份', status: 'error', message: error instanceof Error ? error.message : '备份未完成，请重试。' }); throw error }
    finally { backingUpInstances.delete(id) }
  })
  handle('install-vanilla', async (versionId: string, name: string) => {
    if (installing || removingInstances.size) throw new Error('已有安装或移除任务正在进行。')
    validateVanillaVersionId(versionId)
    const cleanName = String(name).trim()
    if (!cleanName || cleanName.length > 60 || /[<>:"/\\|?*\x00-\x1f]/.test(cleanName)) throw new Error('请填写有效的实例名称。')
    installing = true
    const controller = new AbortController(); downloadControllers.set('install', controller)
    const instancesRoot = join(app.getPath('userData'), 'instances')
    const destination = join(instancesRoot, `${cleanName}-${randomUUID().slice(0, 8)}`)
    sendTask({ id: 'install', label: `安装 Minecraft ${versionId}`, status: 'running', message: '正在获取官方版本信息…' })
    try {
      const { installVanilla } = await import('./services/installer')
      await mkdir(instancesRoot, { recursive: true })
      await installVanilla({ versionId, destination, instancesRoot, signal: controller.signal, onProgress: (progress) => sendTask({ id: 'install', label: `安装 Minecraft ${versionId}`, status: 'running', message: progress.message, completed: progress.percent, total: 100 }) }, { fetch: appFetch })
      await persistSettings(sanitizeSettings({ roots: [...settings.roots, destination] }))
      sendTask({ id: 'install', label: `安装 Minecraft ${versionId}`, status: 'complete', message: '游戏文件安装完成。' })
      return snapshot()
    } catch (error) { sendTask({ id: 'install', label: `安装 Minecraft ${versionId}`, status: controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) }); throw error } finally { installing = false; downloadControllers.delete('install') }
  })
  handle('window-action', (action) => {
    if (action === 'minimize') window?.minimize()
    else if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize()
    else if (action === 'close') window?.close()
    else throw new Error('不支持的窗口操作。')
  })
}

function createWindow() {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const launcherWidth = Math.min(1336, workArea.width)
  const launcherHeight = Math.min(880, workArea.height)
  window = new BrowserWindow({
    width: launcherWidth, height: launcherHeight,
    minWidth: Math.min(1060, workArea.width), minHeight: Math.min(740, workArea.height),
    x: workArea.x + Math.round((workArea.width - launcherWidth) / 2),
    y: workArea.y + Math.round((workArea.height - launcherHeight) / 2),
    backgroundColor: '#0b1017', frame: false, show: false,
    icon: join(projectRoot, 'build/icon.png'),
    title: 'shenBCL 启动器',
    webPreferences: { preload: join(currentDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const mayWriteClipboard = (contents: Electron.WebContents | null, permission: string) => permission === 'clipboard-sanitized-write' && contents === window?.webContents && trustedFrame(contents.getURL())
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(mayWriteClipboard(contents, permission)))
  window.webContents.session.setPermissionCheckHandler((contents, permission) => mayWriteClipboard(contents, permission))
  window.webContents.on('will-navigate', (event, url) => { if (!trustedFrame(url)) event.preventDefault() })
  window.on('close', (event) => {
    if (removingInstances.size) { event.preventDefault(); return }
    if (!processes.size && !installing && !downloadControllers.size) return
    const answer = dialog.showMessageBoxSync(window!, { type: 'question', buttons: ['返回启动器', '关闭启动器'], defaultId: 0, cancelId: 0, title: '仍有任务在运行', message: installing || downloadControllers.size ? '退出会中断当前下载或安装。整合包任务可在重启后继续，已校验文件会保留。' : '游戏或服务器正在运行。关闭启动器后进程将继续运行，控制台会断开。' })
    if (answer === 0) event.preventDefault()
  })
  window.on('closed', () => { window = null })
  window.once('ready-to-show', () => window?.show())
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(rendererFile)
}

app.setName('shenBCL Launcher')
app.commandLine.appendSwitch('disk-cache-size', String(32 * 1024 * 1024))
// Keep the established data directory so the rename retains settings, instances and backups.
app.setPath('userData', join(app.getPath('appData'), 'Arcane Launcher'))
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
app.whenReady().then(async () => {
  await loadSettings()
  hiddenInstances = new HiddenInstanceRegistry(join(app.getPath('userData'), 'hidden-instances.json'))
  await hiddenInstances.load()
  await loadAccount()
  catalog = new CatalogService({ fetch: appFetch })
  modpacks = new ModpackInstallManager({
    instancesRoot: join(app.getPath('userData'), 'instances'),
    jobsRoot: join(app.getPath('userData'), 'modpack-jobs'),
    fetch: appFetch,
    findJava: async (major) => (await detectJava(settings.javaPath ? [settings.javaPath] : [])).find(java => java.major === major)?.path,
    onChange: (job: ModpackJob) => {
      window?.webContents.send('arcane:modpack-job', job)
      sendTask({ id: `modpack-${job.id}`, label: `导入 ${job.name}`, status: job.status === 'running' ? 'running' : job.status === 'complete' ? 'complete' : job.status === 'cancelled' ? 'cancelled' : 'error', message: job.message, completed: job.completed, total: job.total })
    },
  })
  await modpacks.list()
  protocol.handle('arcane-image', async (request) => {
    try {
      const url = new URL(request.url)
      const instance = await instanceById(url.hostname)
      const name = decodeURIComponent(url.pathname.slice(1))
      if (name !== basename(name) || !/\.(png|jpe?g|webp)$/i.test(name)) return new Response('Invalid image', { status: 400 })
      const root = await realpath(join(instance.gameDirectory, 'screenshots'))
      const path = await realpath(join(root, name))
      if (!safeWithin(root, path)) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(path).href)
    } catch { return new Response('Not found', { status: 404 }) }
  })
  registerHandlers()
  createWindow()
  void accounts.restore()
}).catch((error) => { console.error(error); dialog.showErrorBox('启动器未能打开', error instanceof Error ? error.message : String(error)); app.quit() })
app.on('window-all-closed', () => app.quit())
