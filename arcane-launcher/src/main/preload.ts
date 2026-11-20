import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AccountState, AppBridge, LaunchEvent, ModpackInstallResult, ModpackJob, TaskProgress } from '../shared/contracts'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(`arcane:${channel}`, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.data as T
}

const bridge: AppBridge = {
  inspectModpack: () => invoke('inspect-modpack'),
  inspectDroppedModpack: (file) => invoke('inspect-dropped-modpack', webUtils.getPathForFile(file)),
  installModpack: (previewId, name) => invoke('install-modpack', previewId, name),
  listModpackJobs: () => invoke('modpack-jobs'),
  resumeModpack: (jobId) => invoke('resume-modpack', jobId),
  cancelModpack: (jobId) => invoke('cancel-modpack', jobId),
  dismissModpack: (jobId) => invoke('dismiss-modpack', jobId),
  cancelTask: (taskId) => invoke('cancel-task', taskId),
  onModpackJobRemoved(callback) {
    const handler = (_event: unknown, id: string) => callback(id)
    ipcRenderer.on('arcane:modpack-job-removed', handler)
    return () => ipcRenderer.removeListener('arcane:modpack-job-removed', handler)
  },
  catalogMinecraftVersions: () => invoke('catalog-minecraft-versions'),
  searchCatalog: (query) => invoke('catalog-search', query),
  catalogVersions: (projectId, filter) => invoke('catalog-versions', projectId, filter),
  saveCatalogFile: (ticket) => invoke('catalog-save-file', ticket),
  downloadCatalogPack: (ticket) => invoke('catalog-download-pack', ticket),
  installCatalogMod: (ticket, instanceId) => invoke('catalog-install-mod', ticket, instanceId),
  onModpackJob(callback) {
    const handler = (_event: unknown, value: ModpackJob) => callback(value)
    ipcRenderer.on('arcane:modpack-job', handler)
    return () => ipcRenderer.removeListener('arcane:modpack-job', handler)
  },
  onModpackInstalled(callback) {
    const handler = (_event: unknown, value: ModpackInstallResult) => callback(value)
    ipcRenderer.on('arcane:modpack-installed', handler)
    return () => ipcRenderer.removeListener('arcane:modpack-installed', handler)
  },
  account: () => invoke('account'),
  configureAccount: (clientId) => invoke('configure-account', clientId),
  beginMicrosoftLogin: () => invoke('begin-login'),
  cancelMicrosoftLogin: () => invoke('cancel-login'),
  openMicrosoftLogin: () => invoke('open-login'),
  refreshAccount: () => invoke('refresh-account'),
  logoutAccount: () => invoke('logout-account'),
  importPreviewSkin: () => invoke('import-preview-skin'),
  onAccountChanged(callback) {
    const handler = (_event: unknown, value: AccountState) => callback(value)
    ipcRenderer.on('arcane:account-changed', handler)
    return () => ipcRenderer.removeListener('arcane:account-changed', handler)
  },
  snapshot: () => invoke('snapshot'),
  runtime: () => invoke('runtime'),
  importDirectory: () => invoke('import-directory'),
  prepareInstanceRemoval: (id) => invoke('prepare-instance-removal', id),
  confirmInstanceRemoval: (token) => invoke('confirm-instance-removal', token),
  saveSettings: (patch) => invoke('save-settings', patch),
  chooseJava: () => invoke('choose-java'),
  readLog: (id) => invoke('read-log', id),
  prepareLaunch: (id) => invoke('prepare-launch', id),
  launch: (id) => invoke('launch', id),
  stop: (id) => invoke('stop', id),
  openFolder: (id, target) => invoke('open-folder', id, target),
  resources: (id, kind) => invoke('resources', id, kind),
  exportDiagnostics: (id) => invoke('export-diagnostics', id),
  backup: (id) => invoke('backup', id),
  installVanilla: (version, name) => invoke('install-vanilla', version, name),
  windowAction: (action) => invoke('window-action', action),
  onLaunchEvent(callback) {
    const handler = (_event: unknown, value: LaunchEvent) => callback(value)
    ipcRenderer.on('arcane:launch-event', handler)
    return () => ipcRenderer.removeListener('arcane:launch-event', handler)
  },
  onTaskProgress(callback) {
    const handler = (_event: unknown, value: TaskProgress) => callback(value)
    ipcRenderer.on('arcane:task-progress', handler)
    return () => ipcRenderer.removeListener('arcane:task-progress', handler)
  },
}

contextBridge.exposeInMainWorld('arcane', bridge)
