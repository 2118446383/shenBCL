<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Archive, Activity, ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen, Box, Boxes, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Command, Compass, Copy, Cpu, Download, Ellipsis, ExternalLink, FileArchive, FileText, Folder, FolderOpen, Gamepad2, HardDrive, Image, Info, Layers3, Leaf, LoaderCircle, Maximize2, MemoryStick, Minus, Package, Play, Plus, RefreshCw, Search, Server, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2, TriangleAlert, UserRound, WandSparkles, X } from 'lucide-vue-next'
import type { AccountState, FolderTarget, InstanceLog, InstanceRemovalPreview, LaunchEvent, LauncherInstance, LauncherSettings, LauncherSnapshot, LaunchPlan, ResourceEntry, ResourceKind, RuntimeInfo, TaskProgress } from '../shared/contracts'
import HomeDashboard from './components/HomeDashboard.vue'
import InstanceDeleteDialog from './components/InstanceDeleteDialog.vue'
const AccountDialog = defineAsyncComponent(() => import('./components/AccountDialog.vue'))
const ModpackImportDialog = defineAsyncComponent(() => import('./components/ModpackImportDialog.vue'))
const DownloadCenter = defineAsyncComponent(() => import('./components/DownloadCenter.vue'))
import appIcon from './assets/shenbcl-mark.svg'
import { toSettingsPayload } from './settings-payload'
import { accountPresentation } from '../shared/account-presentation'

type View = 'home' | 'instances' | 'downloads' | 'resources' | 'diagnostics' | 'settings'
type Modal = 'import' | 'check' | 'about' | 'commands' | 'account' | 'remove' | null
const api = window.arcane
const account = ref<AccountState>({ configured: false, clientId: '', profile: null, busy: false })
const view = ref<View>('home')
const downloadsVisited = ref(false)
const selectedDownloadTask = ref<TaskProgress>()
const downloadDetailRequest = ref(0)
const importTaskId = ref('')
const downloadedPacks = new Map<string, import('../shared/contracts').ModpackPreview>()
const modal = ref<Modal>(null)
const dialogPanel = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
const busy = ref(false)
const loading = ref(true)
const showNotifications = ref(false)
const cancellingTasks = reactive(new Set<string>())
const removingId = ref('')
const removalTarget = ref<LauncherInstance>()
const removalPreview = ref<InstanceRemovalPreview>()
const removalError = ref('')
const confirmingRemoval = ref(false)
const search = ref('')
const commandQuery = ref('')
const selectedId = ref(localStorage.getItem('arcane.selected') ?? '')
const snapshot = ref<LauncherSnapshot>({ instances: [], java: [], settings: { roots: [], javaPath: '', memoryMb: 4096, playerName: 'Traveler', closeOnLaunch: false }, scannedAt: '' })
const runtime = ref<RuntimeInfo>({ appVersion: '0.3.6', platform: 'win32', totalMemoryMb: 16384, workspaceRoot: '' })
const settings = reactive<LauncherSettings>({ ...snapshot.value.settings })
const resourceKind = ref<ResourceKind>('mods')
const resources = ref<ResourceEntry[]>([])
const resourceLoading = ref(false)
const log = ref<InstanceLog | null>(null)
const logLoading = ref(false)
const logFilter = ref('')
const events = ref<LaunchEvent[]>([])
const running = reactive(new Set<string>())
const tasks = ref<TaskProgress[]>([])
const toast = ref<{ message: string; error: boolean } | null>(null)
const droppedPreview = ref<import('../shared/contracts').ModpackPreview>()
const draggingFiles = ref(false)
const inspectingDrop = ref(false)
let dragDepth = 0
const checkError = ref('')
const plan = ref<LaunchPlan | null>(null)
const checking = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let resourceRequest = 0
let logRequest = 0
const disposers: Array<() => void> = []

const navItems = [
  { id: 'home' as View, label: '启动台', icon: Compass },
  { id: 'instances' as View, label: '游戏实例', icon: Boxes },
  { id: 'downloads' as View, label: '下载中心', icon: Download },
  { id: 'resources' as View, label: '资源管理', icon: Package },
  { id: 'diagnostics' as View, label: '诊断中心', icon: Activity },
]
const titles: Record<View, string> = { home: '启动台', instances: '游戏实例', downloads: '下载中心', resources: '资源管理', diagnostics: '诊断中心', settings: '启动设置' }
const resourceTabs: Array<{ id: ResourceKind; label: string; icon: typeof Box }> = [
  { id: 'mods', label: '模组', icon: Box }, { id: 'saves', label: '存档', icon: Layers3 }, { id: 'screenshots', label: '截图', icon: Image }, { id: 'resourcepacks', label: '资源包', icon: FileArchive }, { id: 'shaderpacks', label: '光影', icon: Sparkles },
]
const selected = computed(() => snapshot.value.instances.find((item) => item.id === selectedId.value) ?? snapshot.value.instances.find(item => item.kind === 'client'))
const filteredInstances = computed(() => snapshot.value.instances.filter((item) => `${item.name} ${item.minecraftVersion} ${item.loader}`.toLowerCase().includes(search.value.toLowerCase())))
const activeJava = computed(() => {
  const configured = snapshot.value.settings.javaPath.trim()
  if (configured) {
    const normalize = (path: string) => runtime.value.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path
    return snapshot.value.java.find((item) => normalize(item.path) === normalize(configured))
  }
  return snapshot.value.java.find((item) => item.major === (selected.value?.requiredJavaMajor ?? 17)) ?? snapshot.value.java[0]
})
const activeTask = computed(() => tasks.value.find((item) => item.status === 'running'))
const activeDownloadTask = computed(() => tasks.value.find(item => item.status === 'running' && (item.id === 'install' || item.id.startsWith('catalog-') || item.id.startsWith('modpack-'))))
const downloadDetailTask = computed(() => tasks.value.find(task => task.id === selectedDownloadTask.value?.id) ?? selectedDownloadTask.value)
const accountIdentity = computed(() => accountPresentation(account.value))
const accountLabel = computed(() => accountIdentity.value.label)
const logText = computed(() => {
  const live = events.value.filter((item) => item.instanceId === selected.value?.id).map((item) => `[${new Date(item.timestamp).toLocaleTimeString('zh-CN')}] ${item.message}`).join('\n')
  const text = [log.value?.found ? log.value.content : '', live].filter(Boolean).join('\n')
  if (!logFilter.value) return text
  return text.split('\n').filter((line) => line.toLowerCase().includes(logFilter.value.toLowerCase())).join('\n')
})
const filteredResources = computed(() => resources.value.filter((item) => item.name.toLowerCase().includes(search.value.toLowerCase())))
const commands = computed(() => [
  ...navItems.map((item) => ({ label: item.label, detail: '前往页面', icon: item.icon, action: () => navigate(item.id) })),
  { label: '启动设置', detail: '内存、Java 与玩家身份', icon: Settings2, action: () => navigate('settings') },
  { label: '导入整合包或游戏目录', detail: '选择 ZIP / MRPACK 文件或已有目录', icon: Archive, action: openImport },
  { label: '安装原版游戏', detail: '浏览完整 Minecraft 版本清单', icon: Plus, action: openDownloads },
  { label: '重新扫描环境', detail: '刷新实例与 Java', icon: RefreshCw, action: refresh },
].filter((item) => item.label.includes(commandQuery.value)))

function notify(message: string, error = false) {
  toast.value = { message, error }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, error ? 8000 : 4000)
}
async function cancelTask(task: TaskProgress) {
  if (!api || cancellingTasks.has(task.id)) return
  cancellingTasks.add(task.id)
  try { await perform(() => api.cancelTask(task.id)) }
  finally { cancellingTasks.delete(task.id) }
}
async function perform<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (!api) { notify('这是浏览器预览。请打开桌面版使用本地功能。', true); return }
  try { return await operation() } catch (error) { notify(error instanceof Error ? error.message : String(error), true) }
}
function applySnapshot(next: LauncherSnapshot, preserveDraft = false) {
  const draft = preserveDraft ? { ...settings, roots: [...settings.roots] } : null
  snapshot.value = next
  Object.assign(settings, next.settings)
  if (draft) Object.assign(settings, draft)
  if (!next.instances.some((item) => item.id === selectedId.value)) selectedId.value = next.instances.find(item => item.kind === 'client')?.id ?? ''
}
async function refresh() {
  if (busy.value) return
  busy.value = true
  try { const next = await perform(() => api!.snapshot()); if (next) applySnapshot(next, view.value === 'settings') } finally { busy.value = false; loading.value = false }
}
function navigate(next: View) { if (next === 'downloads') downloadsVisited.value = true; view.value = next; search.value = ''; showNotifications.value = false }
function openDownloads() { modal.value = null; navigate('downloads') }
function choose(instance: LauncherInstance) { selectedId.value = instance.id; localStorage.setItem('arcane.selected', instance.id) }
async function importDirectory() {
  const next = await perform(() => api!.importDirectory())
  if (next) { applySnapshot(next); navigate('instances'); notify('目录已添加，已完成实例扫描。') }
}
async function removeInstance(instance: LauncherInstance) {
  if (!api || removingId.value || busy.value || running.has(instance.id)) return
  removalTarget.value = instance
  removalPreview.value = undefined
  removalError.value = ''
  modal.value = 'remove'
  removingId.value = instance.id
  try {
    const preview = await api.prepareInstanceRemoval(instance.id)
    if (removalTarget.value?.id === instance.id) removalPreview.value = preview
  } catch (error) {
    removalError.value = error instanceof Error ? error.message : String(error)
  } finally { removingId.value = '' }
}
async function confirmRemoval() {
  if (!api || !removalPreview.value || removalPreview.value.blocked || confirmingRemoval.value) return
  confirmingRemoval.value = true; removalError.value = ''
  try {
    const action = removalPreview.value.action
    applySnapshot(await api.confirmInstanceRemoval(removalPreview.value.token))
    modal.value = null
    notify(action === 'delete' ? '客户端及其文件已删除。' : '实例已从游戏库移除，文件保留。')
  } catch (error) { removalError.value = error instanceof Error ? error.message : String(error) }
  finally { confirmingRemoval.value = false }
}
function closeModal() { if (modal.value !== 'remove' || !confirmingRemoval.value) modal.value = null }
function openImport() { if (confirmingRemoval.value) return; importTaskId.value = ''; droppedPreview.value = undefined; modal.value = 'import' }
function showPackPreview(preview: import('../shared/contracts').ModpackPreview, sourceTaskId?: string) {
  if (sourceTaskId) downloadedPacks.set(sourceTaskId, preview)
  droppedPreview.value = preview
  if (modal.value === 'remove') { notify('整合包已下载，可从任务详情继续安装。'); return }
  importTaskId.value = ''
  modal.value = 'import'
}
async function openTaskDetails(task?: TaskProgress) {
  if (!task || confirmingRemoval.value) return
  showNotifications.value = false
  if (task.id.startsWith('modpack-')) {
    importTaskId.value = task.id.slice('modpack-'.length)
    droppedPreview.value = undefined
    modal.value = 'import'
  } else if (task.id.startsWith('catalog-pack-') && downloadedPacks.has(task.id)) {
    importTaskId.value = ''
    droppedPreview.value = downloadedPacks.get(task.id)
    modal.value = 'import'
  } else {
    modal.value = null
    selectedDownloadTask.value = task
    downloadDetailRequest.value++
    navigate('downloads')
  }
}
function fileDrag(event: DragEvent) { return Array.from(event.dataTransfer?.types ?? []).includes('Files') }
function dragEnter(event: DragEvent) {
  if (!fileDrag(event)) return
  event.preventDefault()
  dragDepth++
  draggingFiles.value = true
}
function dragOver(event: DragEvent) {
  if (!fileDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function dragLeave(event: DragEvent) {
  if (!fileDrag(event) && !draggingFiles.value) return
  event.preventDefault()
  if (--dragDepth <= 0) { dragDepth = 0; draggingFiles.value = false }
}
async function dropArchive(event: DragEvent) {
  if (!fileDrag(event)) return
  event.preventDefault()
  dragDepth = 0; draggingFiles.value = false
  if (inspectingDrop.value || modal.value === 'remove') return
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length !== 1 || !/\.(zip|mrpack)$/i.test(files[0]?.name ?? '')) {
    notify('请一次拖入一个 ZIP 或 MRPACK 整合包文件。', true)
    return
  }
  if (!api) return notify('拖入安装请使用桌面版启动器。', true)
  inspectingDrop.value = true
  try { showPackPreview(await api.inspectDroppedModpack(files[0])) }
  catch (cause) { notify(cause instanceof Error ? cause.message : String(cause), true) }
  finally { inspectingDrop.value = false }
}
function modpackInstalled(result: import('../shared/contracts').ModpackInstallResult) {
  if (selectedId.value === result.instanceId && snapshot.value.scannedAt === result.snapshot.scannedAt) return
  applySnapshot(result.snapshot)
  selectedId.value = result.instanceId
  localStorage.setItem('arcane.selected', result.instanceId)
  if (modal.value === 'import') { modal.value = null; navigate('home') }
  notify('整合包已导入，已选中客户端实例。')
}
async function openFolder(target: FolderTarget = 'root') {
  if (!selected.value) return notify('请先导入或安装一个实例。', true)
  await perform(() => api!.openFolder(selected.value!.id, target))
}
async function readLog() {
  const request = ++logRequest
  const instance = selected.value
  log.value = null
  if (!instance) { logLoading.value = false; return }
  logLoading.value = true
  try {
    const next = await perform(() => api!.readLog(instance.id))
    if (request === logRequest) log.value = next ?? null
  } finally { if (request === logRequest) logLoading.value = false }
}
async function readResources() {
  const request = ++resourceRequest
  const instance = selected.value
  const kind = resourceKind.value
  resources.value = []
  if (!instance) { resourceLoading.value = false; return }
  resourceLoading.value = true
  try {
    const next = await perform(() => api!.resources(instance.id, kind))
    if (request === resourceRequest) resources.value = next ?? []
  } finally { if (request === resourceRequest) resourceLoading.value = false }
}
async function openCheck() {
  if (!selected.value) { openDownloads(); return }
  modal.value = 'check'; checkError.value = ''; plan.value = null; checking.value = true
  try { plan.value = await api?.prepareLaunch(selected.value.id) ?? null } catch (error) { checkError.value = error instanceof Error ? error.message : String(error) } finally { checking.value = false }
}
async function launchSelected() {
  if (!selected.value) { openDownloads(); return }
  if (selected.value.status !== 'ready') { await openCheck(); return }
  busy.value = true
  try {
    const result = await perform(() => api!.launch(selected.value!.id))
    if (result) { running.add(selected.value.id); notify(selected.value.kind === 'server' ? '服务器进程已启动。' : '游戏进程已启动，祝你旅途愉快。') }
  } finally { busy.value = false }
}
async function stopSelected() {
  if (selected.value) await perform(() => api!.stop(selected.value!.id))
}
async function saveSettings() {
  const next = await perform(() => api!.saveSettings(toSettingsPayload(settings)))
  if (next) { applySnapshot(next); notify('启动设置已保存。') }
}
async function chooseJava() { const path = await perform(() => api!.chooseJava()); if (path) settings.javaPath = path }
async function exportReport() {
  if (!selected.value) return
  const path = await perform(() => api!.exportDiagnostics(selected.value!.id))
  if (path) notify(`诊断报告已保存：${path}`)
}
async function backup() {
  if (!selected.value) return notify('请先选择一个有存档的游戏实例。', true)
  const path = await perform(() => api!.backup(selected.value!.id))
  if (path) notify(`存档备份已保存：${path}`)
}
async function copyLog() {
  try { await navigator.clipboard.writeText(logText.value); notify('日志已复制。') } catch { notify('无法访问剪贴板，请使用导出报告。', true) }
}
function resourceCount(kind: ResourceKind) {
  if (!selected.value) return 0
  return kind === 'resourcepacks' ? selected.value.stats.resourcePacks : kind === 'shaderpacks' ? selected.value.stats.shaderPacks : selected.value.stats[kind]
}
function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB` }
function statusLabel(instance: LauncherInstance) { return running.has(instance.id) ? '运行中' : instance.status === 'ready' ? '就绪' : instance.status === 'incomplete' ? '需要完善' : '待检查' }
function handleKey(event: KeyboardEvent) {
  if (modal.value === 'remove' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); return }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); commandQuery.value = ''; modal.value = modal.value === 'commands' ? null : 'commands' }
  if (event.key === 'Escape') { closeModal(); showNotifications.value = false }
  if (event.key === 'Tab' && modal.value && dialogPanel.value) {
    const controls = Array.from(dialogPanel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(element => element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}

watch(modal, async (value, old) => {
  if (value) {
    if (!old) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    dialogPanel.value?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)')?.focus()
  } else { await nextTick(); previousFocus?.focus() }
})

watch([view, selectedId], () => { if (view.value === 'diagnostics') void readLog(); if (view.value === 'resources') void readResources() })
watch(resourceKind, () => { if (view.value === 'resources') void readResources() })
watch(selectedId, (id) => { if (id) localStorage.setItem('arcane.selected', id) })
onMounted(async () => {
  document.addEventListener('keydown', handleKey)
  document.addEventListener('dragenter', dragEnter)
  document.addEventListener('dragover', dragOver)
  document.addEventListener('dragleave', dragLeave)
  document.addEventListener('drop', dropArchive)
  if (api) {
    disposers.push(api.onModpackInstalled(modpackInstalled))
    disposers.push(api.onModpackJobRemoved(id => { tasks.value = tasks.value.filter(item => item.id !== `modpack-${id}`) }))
    disposers.push(api.onLaunchEvent((event) => {
      events.value = [...events.value, event].slice(-400)
      if (event.type === 'started') running.add(event.instanceId)
      if (event.type === 'exit' || event.type === 'error') running.delete(event.instanceId)
    }))
    disposers.push(api.onTaskProgress((event) => {
      tasks.value = [event, ...tasks.value.filter((item) => item.id !== event.id)].slice(0, 12)
      if (event.status === 'error') notify(event.message, true)
    }))
    disposers.push(api.onAccountChanged((state) => { account.value = state }))
    const restoredJobs = await perform(() => api.listModpackJobs())
    if (restoredJobs) for (const job of restoredJobs) {
      const id = `modpack-${job.id}`
      if (!tasks.value.some(task => task.id === id)) tasks.value.push({ id, label: `导入 ${job.name}`, status: job.status, message: job.message, completed: job.completed, total: job.total })
    }
    const identity = await perform(() => api.account()); if (identity) account.value = identity
    const info = await perform(() => api.runtime()); if (info) runtime.value = info
    await refresh()
  } else loading.value = false
})
onUnmounted(() => {
  disposers.forEach((dispose) => dispose())
  document.removeEventListener('keydown', handleKey)
  document.removeEventListener('dragenter', dragEnter)
  document.removeEventListener('dragover', dragOver)
  document.removeEventListener('dragleave', dragLeave)
  document.removeEventListener('drop', dropArchive)
  clearTimeout(toastTimer)
})
</script>

<template>
  <div class="launcher-shell">
    <aside class="sidebar" :inert="!!modal">
      <a class="brand" href="#" @click.prevent="navigate('home')"><img :src="appIcon" alt="" /><span>shen<span class="brand-bcl">BCL</span></span><span class="brand-dot"></span></a>
      <nav class="main-nav" aria-label="主要导航">
        <button v-for="item in navItems" :key="item.id" :class="['nav-item', { active: view === item.id }]" @click="navigate(item.id)"><component :is="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'instances'" class="nav-count">{{ snapshot.instances.length }}</span><ChevronRight v-if="view === item.id" :size="14" class="nav-arrow" /></button>
      </nav>
      <div class="sidebar-divider"></div>
      <div class="sidebar-label section-label">个性与偏好</div>
      <button class="nav-item" @click="modal = 'account'"><UserRound :size="19" /><span>账号与皮肤</span></button>
      <button :class="['nav-item', { active: view === 'settings' }]" @click="navigate('settings')"><Settings2 :size="19" /><span>启动设置</span></button>
      <div class="sidebar-spacer"></div>
      <button class="sidebar-note" @click="openDownloads()"><Plus :size="19" /><strong>添加游戏</strong><small>安装或导入实例</small><span class="note-grid"></span></button>
      <button class="profile-card" @click="modal = 'account'"><span class="avatar"><UserRound :size="20" /></span><span class="profile-info"><strong>{{ account.profile?.name ?? snapshot.settings.playerName }}</strong><small><span :class="['status-dot', { amber: !accountIdentity.verified }]"></span>{{ accountLabel }}</small></span><Settings2 :size="16" /></button>
      <div class="sidebar-footer"><button @click="modal = 'about'">shenBCL</button><span>v{{ runtime.appVersion }} <span class="alpha-label">ALPHA</span></span></div>
    </aside>

    <main class="main-shell" :inert="!!modal">
      <header class="titlebar"><div class="breadcrumb"><span>shenBCL</span><ChevronRight :size="13" /><strong>{{ titles[view] }}</strong></div><div class="titlebar-actions"><button class="search-trigger" @click="commandQuery = ''; modal = 'commands'"><Search :size="15" /><span>搜索与快捷操作</span><kbd>Ctrl K</kbd></button><div class="topbar-separator"></div><button class="icon-button" aria-label="通知" @click="showNotifications = !showNotifications"><Bell :size="17" /><span v-if="events.length || tasks.length" class="notification-dot"></span></button><button class="icon-button" aria-label="帮助与关于" @click="modal = 'about'"><CircleHelp :size="17" /></button><div class="window-controls"><button aria-label="最小化" @click="api?.windowAction('minimize')"><Minus :size="15" /></button><button aria-label="最大化" @click="api?.windowAction('maximize')"><Maximize2 :size="13" /></button><button class="close-window" aria-label="关闭" @click="api?.windowAction('close')"><X :size="17" /></button></div></div></header>

      <div v-if="!api" class="preview-banner"><Info :size="14" />浏览器界面预览 · 本地功能请在桌面版中使用</div>

      <div class="page-content" :class="{ 'home-page': view === 'home' }">
        <div v-if="downloadsVisited" v-show="view === 'downloads'"><DownloadCenter :detail-task="downloadDetailTask" :detail-request="downloadDetailRequest" :snapshot="snapshot" :selected="selected" :busy="busy || !!activeTask" @installed="applySnapshot($event)" @pack="showPackPreview" @notify="notify" /></div>
        <HomeDashboard v-if="view === 'home'" :snapshot="snapshot" :selected="selected" :runtime="runtime" :java="activeJava" :account="account" :loading="loading" :busy="busy" :running="running" :installing="!!activeDownloadTask" @launch="launchSelected" @check="openCheck" @folder="openFolder()" @import="openImport" @create="openDownloads()" @account="modal = 'account'" @settings="navigate('settings')" @instances="navigate('instances')" @diagnostics="navigate('diagnostics')" @screenshots="navigate('resources'); resourceKind = 'screenshots'" @backup="backup" @select="choose" @refresh="refresh" @stop="stopSelected" @tasks="openTaskDetails(activeDownloadTask)" />

        <template v-else-if="view === 'instances'">
          <section class="page-heading"><div><div class="eyebrow">YOUR WORLDS, TOGETHER</div><h1>游戏库</h1><p>管理游戏版本与整合包，为不同的冒险保留独立空间。</p></div><button class="button button-gold" @click="openDownloads()"><Plus :size="17" />新建实例</button></section>
          <div class="toolbar"><div class="filter-chips"><span class="filter-chip active">全部实例 <b>{{ snapshot.instances.length }}</b></span><span class="toolbar-hint">本地目录自动识别</span></div><label class="inline-search"><Search :size="15" /><input v-model="search" placeholder="搜索名称、版本或加载器" /></label><button class="button button-subtle" :disabled="busy" @click="refresh"><RefreshCw :size="15" :class="{ spin: busy }" />重新扫描</button><button class="button button-subtle" @click="importDirectory"><FolderOpen :size="15" />导入目录</button></div>
          <div v-if="!filteredInstances.length" class="large-empty"><Boxes :size="42" /><h3>{{ search ? '没有匹配的实例' : '新的旅程，从一个实例开始' }}</h3><p>{{ search ? '换个关键词试试。' : '支持识别标准 .minecraft、PCL 版本目录、Prism 实例和常见服务端。' }}</p><button v-if="!search" class="button button-gold" @click="openDownloads">添加游戏</button></div>
          <div class="instance-grid"><article v-for="instance in filteredInstances" :key="instance.id" :class="['instance-card', { chosen: selected?.id === instance.id }]"><div :class="['instance-card-cover', instance.kind]"><span class="cover-grid"></span><Server v-if="instance.kind === 'server'" :size="52" :stroke-width="1.1" /><Box v-else :size="56" :stroke-width="1.1" /><span class="cover-tag">{{ instance.kind === 'server' ? 'LOCAL SERVER' : 'MINECRAFT JAVA' }}</span><span v-if="selected?.id === instance.id" class="selected-badge"><Check :size="13" />当前实例</span></div><div class="instance-card-body"><div class="instance-card-title"><h3>{{ instance.name }}</h3><span :class="['status-pill', instance.status]"><span></span>{{ statusLabel(instance) }}</span></div><p>{{ instance.minecraftVersion || '版本待识别' }}<span>·</span>{{ instance.loader }} {{ instance.loaderVersion }}</p><div class="instance-card-meta"><span><Box :size="13" />{{ instance.stats.mods }} 模组</span><span><Layers3 :size="13" />{{ instance.stats.saves }} 存档</span></div><div v-if="instance.issues.length" class="instance-issue"><TriangleAlert :size="13" /><span>{{ instance.issues[0] }}</span></div><div class="instance-card-actions"><button class="button instance-remove-button" :aria-label="`删除或移除 ${instance.name}`" :title="running.has(instance.id) ? '请先关闭游戏' : '删除或移除实例'" :disabled="busy || !!removingId || running.has(instance.id)" @click="removeInstance(instance)"><LoaderCircle v-if="removingId === instance.id" :size="15" class="spin" /><Trash2 v-else :size="15" /></button><button class="button button-subtle" @click="choose(instance); openFolder()"><Folder :size="15" />目录</button><button class="button button-primary" @click="choose(instance); instance.status === 'ready' ? launchSelected() : openCheck()"><Play v-if="instance.status === 'ready'" :size="15" /><Activity v-else :size="15" />{{ instance.status === 'ready' ? '启动' : '检查环境' }}</button></div></div></article><button class="new-instance-card" @click="openDownloads()"><span><Plus :size="25" /></span><strong>让下一个世界住进来</strong><small>安装游戏，或导入现有实例</small></button></div>
        </template>

        <template v-else-if="view === 'resources'">
          <section class="page-heading"><div><div class="eyebrow">EVERYTHING IN ITS PLACE</div><h1>资源管理</h1><p>在一个地方，找到模组、世界，以及那些值得留住的瞬间。</p></div><button class="button button-subtle" @click="openFolder(resourceKind)"><FolderOpen :size="16" />在文件夹中打开</button></section>
          <div class="instance-selector"><Box :size="18" /><span>当前实例</span><select v-model="selectedId"><option v-if="!snapshot.instances.length" value="">请先添加实例</option><option v-for="instance in snapshot.instances" :key="instance.id" :value="instance.id">{{ instance.name }}</option></select><span class="path-label">{{ selected?.gameDirectory }}</span></div>
          <section class="panel resource-panel"><div class="resource-tabs"><button v-for="tab in resourceTabs" :key="tab.id" :class="{ active: resourceKind === tab.id }" @click="resourceKind = tab.id"><component :is="tab.icon" :size="16" />{{ tab.label }}<span>{{ resourceCount(tab.id) }}</span></button><label class="inline-search"><Search :size="15" /><input v-model="search" placeholder="搜索文件" /></label></div><div v-if="resourceLoading" class="large-empty"><LoaderCircle :size="30" class="spin" /><p>正在整理你的行囊…</p></div><div v-else-if="!filteredResources.length" class="large-empty"><component :is="resourceTabs.find((tab) => tab.id === resourceKind)?.icon ?? Package" :size="38" /><h3>{{ search ? '没有找到匹配的文件' : '这里还空着，故事才刚开始。' }}</h3><p>{{ resourceKind === 'screenshots' ? '在游戏中按 F2 截图，精彩瞬间会出现在这里。' : '选择一个包含对应资源的游戏实例，内容会自动显示。' }}</p></div><div v-else-if="resourceKind === 'screenshots'" class="screenshot-grid"><article v-for="entry in filteredResources" :key="entry.name"><img v-if="entry.previewUrl" :src="entry.previewUrl" :alt="entry.name" loading="lazy" /><span v-else class="image-placeholder"><Image :size="32" /></span><strong>{{ entry.name }}</strong><small>{{ new Date(entry.modifiedAt).toLocaleDateString('zh-CN') }}</small></article></div><div v-else class="file-list"><div class="file-table-heading"><span>名称</span><span>大小</span><span>修改时间</span></div><div v-for="entry in filteredResources" :key="entry.name" class="file-row"><span><component :is="entry.directory ? Folder : resourceKind === 'mods' ? Box : FileArchive" :size="17" /><strong>{{ entry.name }}</strong></span><span>{{ entry.directory ? '文件夹' : formatSize(entry.size) }}</span><span>{{ new Date(entry.modifiedAt).toLocaleDateString('zh-CN') }}</span></div></div></section>
        </template>

        <template v-else-if="view === 'diagnostics'">
          <section class="page-heading"><div><div class="eyebrow">A CLEARER WAY FORWARD</div><h1>日志与诊断</h1><p>检查启动环境，查看本地日志，让下一次出发更顺利。</p></div><button class="button button-subtle" :disabled="!selected" @click="exportReport"><Download :size="16" />导出诊断报告</button></section>
          <div class="diagnostics-grid"><section class="panel diagnostic-summary"><div class="panel-heading"><h3><ShieldCheck :size="17" />环境概览</h3><button class="text-button" @click="openCheck">完整检查<ArrowUpRight :size="14" /></button></div><div class="checklist-row"><span :class="['check-circle', { warn: !selected }]"><Check v-if="selected" :size="14" /><Minus v-else :size="14" /></span><div><strong>游戏实例</strong><small>{{ selected?.name ?? '尚未选择实例' }}</small></div></div><div class="checklist-row"><span :class="['check-circle', { warn: !activeJava }]"><Check v-if="activeJava" :size="14" /><TriangleAlert v-else :size="14" /></span><div><strong>Java 运行环境</strong><small>{{ activeJava ? `Java ${activeJava.major} · ${activeJava.vendor}` : '请在设置中指定 Java' }}</small></div></div><div class="checklist-row"><span :class="['check-circle', { warn: selected?.status !== 'ready' }]"><Check v-if="selected?.status === 'ready'" :size="14" /><TriangleAlert v-else :size="14" /></span><div><strong>游戏文件</strong><small>{{ selected?.status === 'ready' ? '基础文件已识别，启动前将继续校验' : selected?.issues[0] ?? '等待添加完整实例' }}</small></div></div></section><section class="panel diagnostic-tips"><Sparkles :size="22" /><h3>从第一条错误开始。</h3><p>日志中的第一条 ERROR 或异常通常最接近问题原因。先检查 Java 版本，再检查缺失模组与依赖。</p><span><ShieldCheck :size="13" />导出报告会隐藏常见凭据字段</span></section></div>
          <section class="panel console-panel"><div class="panel-heading"><h3><Terminal :size="17" />{{ selected?.kind === 'server' ? '服务端控制台' : '运行日志' }}<span v-if="selected" class="console-instance">{{ selected.name }}</span></h3><div class="console-actions"><button class="icon-button small" aria-label="刷新日志" @click="readLog"><RefreshCw :size="14" :class="{ spin: logLoading }" /></button><button class="icon-button small" aria-label="复制日志" :disabled="!logText" @click="copyLog"><Copy :size="14" /></button></div></div><div class="console-toolbar"><label><Search :size="14" /><input v-model="logFilter" placeholder="筛选日志关键字…" /></label><span v-if="log?.found">{{ log.truncated ? '最近部分日志' : '本地日志' }}<span class="status-dot"></span></span><span v-else>等待日志</span></div><pre v-if="logText" class="console-output">{{ logText }}</pre><div v-else class="console-empty"><Terminal :size="30" /><strong>{{ logLoading ? '正在读取日志…' : logFilter ? '没有匹配的日志行' : '控制台在这里等你出发。' }}</strong><p>{{ log?.found ? '调整筛选条件后重试。' : '启动游戏后，输出会实时显示。已有实例会自动读取 logs/latest.log。' }}</p></div><div class="console-footer"><span>{{ log?.updatedAt ? `更新于 ${new Date(log.updatedAt).toLocaleTimeString('zh-CN')}` : 'UTF-8 · 本地读取' }}</span><button v-if="selected && running.has(selected.id)" class="text-button danger-text" @click="stopSelected"><Square :size="12" />{{ selected.kind === 'server' ? '正常关闭服务端' : '结束游戏进程' }}</button><span v-else>仅保留最近的进程输出</span></div><p class="log-retention-note"><ShieldCheck :size="13" />每次启动前自动清理标准历史日志归档：最多 10 份、14 天、合计 100 MB。当前日志、崩溃报告和其他模组日志保留。</p></section>
        </template>

        <template v-else-if="view === 'settings'">
          <section class="page-heading"><div><div class="eyebrow">MAKE YOURSELF AT HOME</div><h1>启动设置</h1><p>为你的设备和游玩习惯，准备一套合适的启动设置。</p></div><button class="button button-gold" @click="saveSettings"><Check :size="17" />保存设置</button></section>
          <div class="settings-layout"><div class="settings-main"><section class="panel settings-panel"><div class="panel-heading"><h3><MemoryStick :size="18" />运行内存</h3><span class="setting-value">{{ (settings.memoryMb / 1024).toFixed(1) }} GB</span></div><p class="setting-description">为 Minecraft 分配的最大内存。大型整合包通常需要 6–8 GB，请为系统留出余量。</p><input v-model.number="settings.memoryMb" class="memory-slider" type="range" min="1024" :max="Math.max(1024, Math.min(32768, runtime.totalMemoryMb - 1536))" step="512" aria-label="游戏内存" /><div class="slider-labels"><span>1 GB</span><span>系统总内存 {{ Math.round(runtime.totalMemoryMb / 1024) }} GB</span><span>{{ Math.min(32, Math.floor((runtime.totalMemoryMb - 1536) / 1024)) }} GB</span></div></section><section class="panel settings-panel"><div class="panel-heading"><h3><Cpu :size="18" />Java 运行环境</h3><button class="text-button" :disabled="busy" @click="refresh"><RefreshCw :size="13" :class="{ spin: busy }" />重新检测</button></div><p class="setting-description">自动选择匹配游戏版本的 Java，也可以指定自己的运行环境。</p><select v-model="settings.javaPath" class="field-select"><option value="">自动选择推荐版本</option><option v-for="java in snapshot.java" :key="java.id" :value="java.path">Java {{ java.major }} · {{ java.vendor }} · {{ java.path }}</option><option v-if="settings.javaPath && !snapshot.java.some((item) => item.path === settings.javaPath)" :value="settings.javaPath">{{ settings.javaPath }}</option></select><button class="button button-subtle field-bottom" @click="chooseJava"><FolderOpen :size="15" />手动选择 java.exe</button><div v-if="snapshot.java.length" class="detected-label"><CheckCheck :size="14" />检测到 {{ snapshot.java.length }} 个可用的 Java 运行环境</div></section><section class="panel settings-panel"><div class="panel-heading"><h3><UserRound :size="18" />本地游玩身份</h3><span class="tag-outline">本地模式</span></div><p class="setting-description">用于已有本地资源的游玩身份。正版服务器需要正版账号；可在“账号与皮肤”中连接 Microsoft 账号。</p><label class="field-label">玩家名称<input v-model="settings.playerName" class="field-input" maxlength="16" placeholder="Traveler" /></label><small class="field-help">3–16 位英文字母、数字或下划线</small></section><section class="panel settings-panel"><div class="panel-heading"><h3><Maximize2 :size="18" />游戏启动窗口</h3><span class="setting-value">1280 × 720</span></div><p class="setting-description">每次以固定大小的窗口启动；屏幕较小时自动缩小，预留标题栏和任务栏空间。进入游戏后可拖动窗口边缘、最大化或按 F11 调整。</p></section><section class="panel settings-panel"><div class="setting-toggle-row"><div><strong>启动后最小化</strong><p>把屏幕留给游戏，后台继续记录运行日志。</p></div><button :class="['toggle', { checked: settings.closeOnLaunch }]" role="switch" :aria-checked="settings.closeOnLaunch" aria-label="启动后最小化" @click="settings.closeOnLaunch = !settings.closeOnLaunch"><span></span></button></div></section></div><aside class="settings-aside"><div class="settings-aside-icon"><HardDrive :size="25" /></div><h3>你的世界，留在本地。</h3><p>设置和新安装的实例保存在启动器的数据目录。导入的整合包继续使用原有位置。</p><div class="settings-directory-list"><span>已添加的扫描目录</span><p v-for="root in snapshot.settings.roots" :key="root">{{ root }}</p></div><button class="button button-subtle" @click="importDirectory"><Plus :size="14" />添加实例目录</button></aside></div>
        </template>
      </div>

    </main>

    <Transition name="toast"><div v-if="toast" :class="['toast-message', { error: toast.error }]" role="status"><TriangleAlert v-if="toast.error" :size="19" /><Check v-else :size="19" /><span>{{ toast.message }}</span><button aria-label="关闭提示" @click="toast = null"><X :size="16" /></button></div></Transition>

    <div v-if="showNotifications" class="notification-panel"><div class="panel-heading"><h3>任务与通知</h3><button class="icon-button small" aria-label="关闭通知" @click="showNotifications = false"><X :size="15" /></button></div><div v-if="!tasks.length && !events.length" class="notification-empty"><Bell :size="26" /><p>一切安静，适合出发。</p></div><div v-for="task in tasks" :key="task.id" class="notification-item"><LoaderCircle v-if="task.status === 'running'" :size="16" class="spin" /><TriangleAlert v-else-if="task.status === 'error'" :size="16" /><Check v-else :size="16" /><div><strong>{{ task.label }}</strong><p>{{ task.message }}</p><button v-if="task.id === 'install' || task.id.startsWith('catalog-') || task.id.startsWith('modpack-')" class="text-button notification-task-details" @click="openTaskDetails(task)">查看详情<ArrowUpRight :size="12" /></button><button v-if="task.status === 'running' && (task.id === 'install' || task.id.startsWith('catalog-') || task.id.startsWith('modpack-'))" class="text-button" :disabled="cancellingTasks.has(task.id)" @click="cancelTask(task)">{{ cancellingTasks.has(task.id) ? '正在取消…' : '取消任务' }}</button></div></div><div v-for="event in events.filter((item) => !['stdout', 'stderr'].includes(item.type)).slice(-6).reverse()" :key="event.timestamp" class="notification-item"><Activity :size="16" /><div><strong>{{ event.type === 'error' ? '启动遇到问题' : '运行状态' }}</strong><p>{{ event.message }}</p></div></div></div>

    <div v-if="modal" class="modal-backdrop" @click.self="closeModal"><section ref="dialogPanel" :class="['modal', { 'command-modal': modal === 'commands', 'check-modal': modal === 'check', 'account-modal': modal === 'account', 'import-modal': modal === 'import', 'remove-modal': modal === 'remove' }]" role="dialog" aria-modal="true" :aria-label="modal === 'import' ? '导入游戏' : modal === 'check' ? '启动环境检查' : modal === 'commands' ? '快捷操作' : modal === 'account' ? '账号与皮肤' : modal === 'remove' ? '删除客户端确认' : '关于 shenBCL 启动器'"><button class="modal-close icon-button" aria-label="关闭对话框" :disabled="confirmingRemoval" @click="closeModal"><X :size="19" /></button>
      <ModpackImportDialog v-if="modal === 'import'" :preview="droppedPreview" :job-id="importTaskId" @installed="modpackInstalled" @folder="modal = null; importDirectory()" @notify="notify" />
      <InstanceDeleteDialog v-else-if="modal === 'remove'" :name="removalTarget?.name || ''" :preview="removalPreview" :preparing="!!removingId" :confirming="confirmingRemoval" :error="removalError" @cancel="closeModal" @confirm="confirmRemoval" @retry="removalTarget && removeInstance(removalTarget)" />
      <AccountDialog v-else-if="modal === 'account'" :account="account" :player-name="snapshot.settings.playerName" @update="account = $event" @notify="notify" />
      <template v-else-if="modal === 'check'"><span :class="['modal-symbol', { warning: checkError }]"><LoaderCircle v-if="checking" :size="26" class="spin" /><TriangleAlert v-else-if="checkError" :size="26" /><ShieldCheck v-else :size="26" /></span><div class="eyebrow">READY WHEN YOU ARE</div><h2>{{ checking ? '正在检查出发前的准备…' : checkError ? '还有几项准备需要完成。' : '准备就绪，可以出发。' }}</h2><p class="modal-description">{{ selected?.name }} · {{ selected?.minecraftVersion }} · {{ selected?.loader }}</p><div class="check-results"><div><Cpu :size="17" /><span>Java 运行环境</span><strong>{{ activeJava ? `Java ${activeJava.major}` : '未找到' }}</strong></div><div><MemoryStick :size="17" /><span>分配内存</span><strong>{{ (snapshot.settings.memoryMb / 1024).toFixed(1) }} GB</strong></div><div><HardDrive :size="17" /><span>实例类型</span><strong>{{ selected?.kind === 'server' ? '本地服务端' : 'Minecraft 客户端' }}</strong></div></div><div v-if="checkError" class="check-error"><TriangleAlert :size="17" /><p>{{ checkError }}</p></div><div v-for="issue in selected?.issues ?? []" :key="issue" class="check-issue"><span>•</span>{{ issue }}</div><div v-if="plan" class="launch-plan"><span>启动命令预览</span><code>{{ plan.displayCommand }}</code><p v-for="warning in plan.warnings" :key="warning">{{ warning }}</p></div><div class="modal-buttons"><button class="button button-subtle" @click="modal = null; navigate('settings')">调整启动设置</button><button v-if="plan" class="button button-gold" @click="modal = null; launchSelected()"><Play :size="16" />{{ selected?.kind === 'server' ? '启动服务端' : '启动游戏' }}</button><button v-else class="button button-gold" @click="modal = null; importDirectory()"><FolderOpen :size="16" />导入完整实例</button></div></template>
      <template v-else-if="modal === 'about'"><img :src="appIcon" class="about-icon" alt="shenBCL 启动器图标" /><div class="eyebrow">BUILT FOR THE WORLDS YOU LOVE</div><h2>为你的下一次冒险而造。</h2><p class="modal-description">shenBCL 启动器 · v{{ runtime.appVersion }} Alpha<br />YOUR WORLD. YOUR RULES.</p><div class="about-feature"><Check :size="16" /><div><strong>现在就能使用</strong><p>本地实例识别、Java 检测、游戏安装与启动、资源浏览、日志诊断、存档备份、3D 皮肤预览与可配置的 Microsoft 账号接入。</p></div></div><div class="about-feature planned"><Sparkles :size="16" /><div><strong>接下来的旅程</strong><p>整合包更新、联机、地图工具、AI 辅助和游戏侧配套模组。</p></div></div><div class="about-credit"><Code2 :size="14" />Electron · Vue · Minecraft Launcher Core</div><p class="about-disclaimer">第三方 Minecraft Java 版启动器，与 Mojang 或 Microsoft 无关联。</p><button class="button button-gold full-width" @click="modal = null">继续探索<ArrowRight :size="16" /></button></template>
      <template v-else-if="modal === 'commands'"><div class="command-search"><Search :size="21" /><input v-model="commandQuery" autofocus placeholder="你想去哪里，或做些什么？" /><kbd>ESC</kbd></div><span class="command-label">快捷操作</span><button v-for="command in commands" :key="command.label" class="command-item" @click="modal = null; command.action()"><component :is="command.icon" :size="18" /><span><strong>{{ command.label }}</strong><small>{{ command.detail }}</small></span><ArrowUpRight :size="16" /></button><p v-if="!commands.length" class="command-no-results">没有找到对应操作，换个关键词试试。</p></template>
    </section></div>
    <div v-if="draggingFiles || inspectingDrop" class="archive-drop-overlay" role="status" aria-live="polite">
      <div><LoaderCircle v-if="inspectingDrop" class="spin" :size="38" /><Archive v-else :size="38" /><strong>{{ inspectingDrop ? '正在识别整合包' : '松开以导入整合包' }}</strong><span>ZIP / MRPACK · 自动识别版本与加载器</span></div>
    </div>
  </div>
</template>

<style scoped>
.notification-item .notification-task-details{font-size:10px;color:#92d5c3;display:inline-flex;margin:9px 14px 0 0;align-items:center;gap:5px}
.modal.import-modal{width:min(1040px,calc(100vw - 48px));height:min(650px,calc(100vh - 96px));max-height:calc(100vh - 96px);min-height:0;display:flex;padding:26px;overflow:hidden}.modal.remove-modal{width:510px;max-width:calc(100vw - 48px);padding:30px}.import-modal>.modal-close{top:13px;right:13px}.modal.remove-modal .modal-close{color:#9aabab}
.instance-card-actions .instance-remove-button{flex:0 0 34px;border:1px solid #ffffff12;color:#8aa2ae;background:#ffffff03}.instance-card-actions .instance-remove-button:hover:not(:disabled){color:#f0aaa0;border-color:#e89b8e44;background:#de867410}.log-retention-note{display:flex;align-items:flex-start;gap:7px;padding:12px 20px;border-top:1px solid #ffffff07;font-size:10px;line-height:1.8;color:#718c9d}.log-retention-note>svg{flex-shrink:0;margin-top:2px;color:#79b5a6}
.archive-drop-overlay{position:fixed;inset:12px;z-index:1000;background:#09151ee8;border:2px dashed #77dfc5;border-radius:15px;display:grid;place-items:center;pointer-events:none;backdrop-filter:blur(10px);-webkit-app-region:no-drag}.archive-drop-overlay>div{display:flex;align-items:center;flex-direction:column;gap:20px;color:#8ee8ce}.archive-drop-overlay strong{font-size:25px;font-weight:600;color:#e4f3f0}.archive-drop-overlay span{font-size:12px;color:#91aaa9}
</style>

