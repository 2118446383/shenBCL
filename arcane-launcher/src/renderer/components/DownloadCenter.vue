<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Archive, ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, Download, LoaderCircle, Search, Square, TriangleAlert, X } from 'lucide-vue-next'
import ProjectIcon from './ProjectIcon.vue'
import MinecraftVersionPicker from './MinecraftVersionPicker.vue'
import minecraftIcon from '../assets/release.svg'
import snapshotIcon from '../assets/snapshot.svg'
import type { CatalogMinecraftVersion, CatalogProject, CatalogSearchResult, CatalogVersion, LauncherInstance, LauncherSnapshot, ModpackPreview, TaskProgress } from '../../shared/contracts'

const props = defineProps<{ snapshot: LauncherSnapshot; selected?: LauncherInstance; busy: boolean; detailTask?: TaskProgress; detailRequest?: number }>()
const emit = defineEmits<{ installed: [snapshot: LauncherSnapshot]; pack: [preview: ModpackPreview, sourceTaskId?: string]; notify: [message: string, error?: boolean] }>()
const api = window.arcane
const tab = ref<'minecraft' | 'mod' | 'modpack'>('minecraft')
const vanilla = ref<CatalogMinecraftVersion[]>([])
const vanillaLoading = ref(false)
const vanillaError = ref('')
const vanillaType = ref<'release' | 'snapshot' | 'all'>('release')
const vanillaQuery = ref('')
const vanillaLimit = ref(40)
const selectedMinecraft = ref('')
const instanceName = ref('')
const query = ref('')
const minecraftFilter = ref('')
const loaderFilter = ref('')
const targetId = ref(props.selected?.kind === 'client' ? props.selected.id : props.snapshot.instances.find(item => item.kind === 'client')?.id ?? '')
const projects = ref<CatalogSearchResult>({ hits: [], total: 0, offset: 0, limit: 20 })
const project = ref<CatalogProject>()
const versions = ref<CatalogVersion[]>([])
const versionId = ref('')
const fileTicket = ref('')
const includePreviews = ref(false)
const loading = ref(false)
const versionLoading = ref(false)
const working = ref(false)
const workKind = ref<'install' | 'save'>('install')
const cancelling = ref(false)
const taskId = ref('')
const error = ref('')
const versionError = ref('')
const progress = ref<TaskProgress>()
const progressElement = ref<HTMLElement>()
const detailElement = ref<HTMLElement>()
const detailVisible = ref(false)
const detailCancellingId = ref('')
const detailProgressKnown = computed(() => !!props.detailTask && Number.isFinite(props.detailTask.completed) && Number.isFinite(props.detailTask.total) && props.detailTask.total! > 0)
const detailPercent = computed(() => detailProgressKnown.value ? Math.max(0, Math.min(100, Math.round(props.detailTask!.completed! / props.detailTask!.total! * 100))) : undefined)
const detailStatus = computed(() => props.detailTask?.status === 'running' ? '正在进行' : props.detailTask?.status === 'complete' ? '已完成' : props.detailTask?.status === 'cancelled' ? '已取消' : '未完成')
watch([() => props.detailRequest, () => props.detailTask?.id], async () => {
  detailVisible.value = !!props.detailTask
  if (!detailVisible.value) return
  await nextTick()
  detailElement.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}, { immediate: true, flush: 'post' })
async function cancelDetailTask() {
  const task = props.detailTask
  if (!api || !task || task.status !== 'running' || detailCancellingId.value) return
  detailCancellingId.value = task.id
  try { await api.cancelTask(task.id) }
  catch (cause) { emit('notify', cause instanceof Error ? cause.message : String(cause), true) }
  finally { detailCancellingId.value = '' }
}
async function revealTask(id: string) {
  if (id !== taskId.value) return
  await nextTick()
  progressElement.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
defineExpose({ revealTask })
let requestNumber = 0
let manifestRequestNumber = 0
let versionRequestNumber = 0
let dispose: (() => void) | undefined

const clients = computed(() => props.snapshot.instances.filter(item => item.kind === 'client'))
const target = computed(() => clients.value.find(item => item.id === targetId.value))
const supportedLoader = (item?: LauncherInstance) => {
  const value = item?.loader.toLowerCase() ?? ''
  return ['forge','neoforge','fabric','quilt'].includes(value) ? value : ''
}
const vanillaResults = computed(() => vanilla.value.filter(item => (vanillaType.value === 'all' || item.type === vanillaType.value) && item.id.toLowerCase().includes(vanillaQuery.value.trim().toLowerCase())))
const listedVersions = computed(() => includePreviews.value ? versions.value : versions.value.filter(item => item.versionType === 'release'))
const selectedVersion = computed(() => listedVersions.value.find(item => item.id === versionId.value))
const selectedFile = computed(() => selectedVersion.value?.files.find(item => item.ticket === fileTicket.value))
const modCompatible = computed(() => target.value?.status === 'ready' && !!selectedVersion.value && selectedVersion.value.minecraftVersions.includes(target.value.minecraftVersion) && selectedVersion.value.loaders.includes(supportedLoader(target.value)))
const taskPercent = computed(() => progress.value?.total ? Math.min(100, Math.round((progress.value.completed ?? 0) / progress.value.total * 100)) : 0)
const busy = computed(() => props.busy || working.value)
const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
const formatDownloads = (count: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(count)
const date = (value: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : '日期未知'
const releaseLabel = (value: string) => value === 'release' ? '正式版' : value === 'beta' ? 'Beta' : value === 'alpha' ? 'Alpha' : value === 'snapshot' ? '快照' : '历史版本'

function selectMinecraft(id: string) { selectedMinecraft.value = id; instanceName.value = `Minecraft ${id}` }
function matchTarget() {
  if (!target.value) return
  minecraftFilter.value = target.value.minecraftVersion
  loaderFilter.value = supportedLoader(target.value)
  void searchProjects()
}
function setMinecraftFilter(value: string) {
  minecraftFilter.value = value
  void searchProjects()
}
function clearFilters() {
  minecraftFilter.value = ''; loaderFilter.value = ''
  void searchProjects()
}
async function loadMinecraft() {
  if (!api) { error.value = '请打开桌面版使用在线下载。'; return }
  const current = ++manifestRequestNumber
  vanillaLoading.value = true; vanillaError.value = ''
  if (tab.value === 'minecraft') error.value = ''
  try {
    const result = await api.catalogMinecraftVersions()
    if (current !== manifestRequestNumber) return
    vanilla.value = result
    if (!selectedMinecraft.value) selectMinecraft(vanilla.value.find(item => item.type === 'release')?.id ?? vanilla.value[0]?.id ?? '')
  } catch (cause) {
    if (current === manifestRequestNumber) {
      vanillaError.value = cause instanceof Error ? cause.message : String(cause)
      if (tab.value === 'minecraft') error.value = vanillaError.value
    }
  }
  finally { if (current === manifestRequestNumber) vanillaLoading.value = false }
}
async function searchProjects(offset = 0) {
  if (!api || tab.value === 'minecraft') return
  const current = ++requestNumber
  loading.value = true; error.value = ''; project.value = undefined; versions.value = []; versionError.value = ''; versionLoading.value = false; versionRequestNumber++
  try {
    const result = await api.searchCatalog({ type: tab.value, query: query.value, minecraftVersion: minecraftFilter.value || undefined, loader: loaderFilter.value || undefined, offset })
    if (current !== requestNumber) return
    projects.value = result
    if (result.hits[0]) void chooseProject(result.hits[0])
  } catch (cause) { if (current === requestNumber) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (current === requestNumber) loading.value = false }
}
async function chooseProject(item: CatalogProject) {
  if (!api) return
  const current = ++versionRequestNumber
  project.value = item; versions.value = []; versionId.value = ''; fileTicket.value = ''; versionError.value = ''; versionLoading.value = true
  try {
    const result = await api.catalogVersions(item.id, { type: item.type, minecraftVersion: minecraftFilter.value || undefined, loader: loaderFilter.value || undefined })
    if (current !== versionRequestNumber) return
    versions.value = result
    if (!result.some(version => version.versionType === 'release') && result.length) includePreviews.value = true
    versionId.value = listedVersions.value[0]?.id ?? ''
  } catch (cause) { if (current === versionRequestNumber) versionError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (current === versionRequestNumber) versionLoading.value = false }
}
async function installMinecraft() {
  if (!api || busy.value || !selectedMinecraft.value || !instanceName.value.trim()) return
  const version = selectedMinecraft.value
  const name = instanceName.value.trim()
  workKind.value = 'install'; working.value = true; error.value = ''; progress.value = undefined
  taskId.value = 'install'
  try { emit('installed', await api.installVanilla(version, name)); emit('notify', `Minecraft ${version} 已安装。`) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { working.value = false }
}
async function downloadSelected() {
  if (!api || busy.value || !selectedFile.value || !project.value) return
  if (project.value.type === 'mod' && (!target.value || !modCompatible.value)) return
  workKind.value = 'install'; working.value = true; error.value = ''; progress.value = undefined
  taskId.value = `catalog-${project.value.type === 'mod' ? 'mod' : 'pack'}-${selectedFile.value.ticket}`
  try {
    if (project.value.type === 'modpack') emit('pack', await api.downloadCatalogPack(selectedFile.value.ticket), taskId.value)
    else { emit('installed', await api.installCatalogMod(selectedFile.value.ticket, target.value!.id)); emit('notify', '模组及必需依赖已安装，重新启动游戏后生效。') }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { working.value = false }
}
async function saveSelected() {
  if (!api || busy.value || !selectedFile.value) return
  const ticket = selectedFile.value.ticket
  workKind.value = 'save'; working.value = true; error.value = ''; progress.value = undefined
  taskId.value = `catalog-save-${ticket}`
  try {
    const saved = await api.saveCatalogFile(ticket)
    if (saved) emit('notify', `文件已保存到：${saved}`)
    else progress.value = undefined
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { working.value = false }
}
async function cancelDownload() {
  if (!api || !working.value || cancelling.value || !taskId.value) return
  cancelling.value = true
  try { await api.cancelTask(taskId.value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { cancelling.value = false }
}

watch(tab, value => {
  requestNumber++; versionRequestNumber++
  loading.value = false; versionLoading.value = false; error.value = ''
  if (!working.value) progress.value = undefined
  if (value !== 'minecraft') void searchProjects()
  else {
    error.value = vanillaError.value
    if (!vanilla.value.length && !vanillaLoading.value) void loadMinecraft()
  }
})
watch([vanillaType, vanillaQuery], () => { vanillaLimit.value = 40; if (!vanillaResults.value.some(item => item.id === selectedMinecraft.value)) selectMinecraft(vanillaResults.value[0]?.id ?? '') })
watch([versionId, includePreviews], () => {
  if (!listedVersions.value.some(item => item.id === versionId.value)) versionId.value = listedVersions.value[0]?.id ?? ''
  const selected = listedVersions.value.find(item => item.id === versionId.value)
  fileTicket.value = selected?.files.find(item => item.primary)?.ticket ?? selected?.files[0]?.ticket ?? ''
})
watch(() => props.snapshot.instances, () => { if (!clients.value.some(item => item.id === targetId.value)) targetId.value = clients.value[0]?.id ?? '' })
onMounted(() => {
  void loadMinecraft()
  if (api) dispose = api.onTaskProgress(item => { if (working.value && item.id === taskId.value) progress.value = item })
})
onUnmounted(() => { requestNumber++; manifestRequestNumber++; versionRequestNumber++; dispose?.() })
</script>

<template>
  <section class="page-heading catalog-heading"><div><h1>下载中心</h1><p>安装 Minecraft，下载兼容的模组与整合包。</p></div><span class="catalog-source">{{ tab === 'minecraft' ? 'Mojang 官方版本' : 'Modrinth' }}</span></section>
  <section v-if="detailVisible && detailTask" ref="detailElement" :class="['catalog-task-detail', detailTask.status]" aria-label="所选下载任务详情">
    <div class="task-detail-heading"><LoaderCircle v-if="detailTask.status === 'running'" :size="17" class="spin" /><Check v-else-if="detailTask.status === 'complete'" :size="17" /><Square v-else-if="detailTask.status === 'cancelled'" :size="15" /><TriangleAlert v-else :size="17" /><strong>{{ detailTask.label }}</strong><span>{{ detailStatus }}</span><button class="icon-button small" aria-label="收起任务详情" @click="detailVisible = false"><X :size="15" /></button></div>
    <div class="task-detail-body"><p>{{ detailTask.message }}</p><strong v-if="detailPercent !== undefined">{{ detailPercent }}%</strong><button v-if="detailTask.status === 'running'" class="button button-subtle" :disabled="!!detailCancellingId" @click="cancelDetailTask"><LoaderCircle v-if="detailCancellingId === detailTask.id" :size="13" class="spin" /><Square v-else :size="12" />{{ detailCancellingId === detailTask.id ? '正在取消…' : '取消此任务' }}</button></div>
    <template v-if="detailProgressKnown"><div class="catalog-track" role="progressbar" :aria-label="`${detailTask.label}进度`" :aria-valuenow="detailTask.completed" :aria-valuemax="detailTask.total"><span :style="{width:`${detailPercent}%`}"></span></div><small class="task-detail-count">已完成 {{ detailTask.completed?.toLocaleString('zh-CN') }} / {{ detailTask.total?.toLocaleString('zh-CN') }}</small></template>
  </section>
  <div class="catalog-tabs" role="tablist" aria-label="下载内容类型">
    <button role="tab" :aria-selected="tab === 'minecraft'" :class="{active:tab === 'minecraft'}" @click="tab = 'minecraft'"><img class="minecraft-tab-icon" :src="minecraftIcon" alt="" />Minecraft</button>
    <button role="tab" :aria-selected="tab === 'mod'" :class="{active:tab === 'mod'}" @click="tab = 'mod'"><Box :size="17" />模组</button>
    <button role="tab" :aria-selected="tab === 'modpack'" :class="{active:tab === 'modpack'}" @click="tab = 'modpack'"><Archive :size="17" />整合包</button>
  </div>

  <div v-if="error" class="catalog-error" role="alert"><TriangleAlert :size="16" /><span>{{ error }}</span><button v-if="!working" class="text-button" @click="tab === 'minecraft' ? loadMinecraft() : searchProjects()">重试</button></div>
  <div v-if="(working || progress) && !(detailVisible && detailTask?.id === taskId)" ref="progressElement" class="catalog-progress" role="status"><div><LoaderCircle v-if="working" :size="16" class="spin" /><Check v-else-if="progress?.status === 'complete'" :size="16" /><TriangleAlert v-else :size="16" /><span>{{ progress?.message || '正在下载并校验文件…' }}</span><strong v-if="progress?.total">{{ taskPercent }}%</strong><button v-if="working" class="text-button" :disabled="cancelling" @click="cancelDownload">{{ cancelling ? '正在取消…' : '取消下载 / 安装' }}</button></div><div v-if="progress?.total" class="catalog-track"><span :style="{width:`${taskPercent}%`}"></span></div></div>

  <template v-if="tab === 'minecraft'">
    <div class="catalog-toolbar"><div class="catalog-version-types"><button :class="{active:vanillaType === 'release'}" @click="vanillaType = 'release'">正式版</button><button :class="{active:vanillaType === 'snapshot'}" @click="vanillaType = 'snapshot'">快照</button><button :class="{active:vanillaType === 'all'}" @click="vanillaType = 'all'">全部版本</button></div><label class="catalog-search"><Search :size="15" /><input v-model="vanillaQuery" placeholder="搜索版本号" aria-label="搜索 Minecraft 版本号" /></label></div>
    <div class="catalog-layout">
      <section class="panel catalog-results">
        <div class="catalog-list-heading"><strong>版本列表</strong><span>{{ vanillaResults.length }} 个版本</span></div>
        <div v-if="vanillaLoading" class="catalog-empty"><LoaderCircle :size="24" class="spin" /><p>正在读取官方版本清单…</p></div>
        <div v-else-if="!vanillaResults.length" class="catalog-empty"><img class="minecraft-empty-icon" :src="minecraftIcon" alt="" /><p>{{ error ? '版本列表暂不可用' : '没有匹配的版本' }}</p></div>
        <button v-for="version in vanillaResults.slice(0, vanillaLimit)" :key="version.id" class="catalog-version-row" :class="{selected:selectedMinecraft === version.id}" @click="selectMinecraft(version.id)"><span class="version-block"><img :src="version.type === 'release' ? minecraftIcon : snapshotIcon" alt="" /></span><span><strong>{{ version.id }}</strong><small>{{ date(version.releaseTime) }}</small></span><span class="catalog-tag" :class="{preview:version.type !== 'release'}">{{ releaseLabel(version.type) }}</span><Check v-if="selectedMinecraft === version.id" :size="15" /><ChevronDown v-else class="version-arrow" :size="15" /></button>
        <button v-if="vanillaResults.length > vanillaLimit" class="catalog-more" @click="vanillaLimit += 40">显示更多版本<ChevronDown :size="14" /></button>
      </section>
      <aside class="panel catalog-details">
        <div class="detail-icon"><img :src="vanilla.find(item => item.id === selectedMinecraft)?.type === 'release' ? minecraftIcon : snapshotIcon" alt="" /></div><span class="detail-source">Minecraft Java 版</span><h2>{{ selectedMinecraft || '选择版本' }}</h2>
        <p>从官方清单获取游戏本体、运行库与资源，并创建独立客户端实例。</p>
        <label class="field-label">实例名称<input v-model="instanceName" class="field-input" maxlength="60" :disabled="busy" placeholder="填写实例名称" /></label>
        <p v-if="vanilla.find(item => item.id === selectedMinecraft)?.type !== 'release' && selectedMinecraft" class="detail-warning"><TriangleAlert :size="14" />测试及历史版本可能与现有模组、存档不兼容，请使用独立存档。</p>
        <button class="button button-primary full-width" :disabled="!api || busy || vanillaLoading || !selectedMinecraft || !instanceName.trim()" @click="installMinecraft"><LoaderCircle v-if="working" :size="16" class="spin" /><ArrowDownToLine v-else :size="16" />{{ working ? '正在安装' : '下载并安装' }}</button>
        <small class="catalog-footnote">Java 版本在安装后的启动检查中匹配。</small>
      </aside>
    </div>
  </template>

  <template v-else>
    <form class="catalog-filterbar" @submit.prevent="searchProjects()"><label class="catalog-search"><Search :size="16" /><input v-model="query" :placeholder="tab === 'mod' ? '搜索模组，例如 Sodium' : '搜索整合包'" :aria-label="tab === 'mod' ? '搜索模组' : '搜索整合包'" /></label><MinecraftVersionPicker :model-value="minecraftFilter" :versions="vanilla" :disabled="busy" @update:model-value="setMinecraftFilter" /><select v-model="loaderFilter" aria-label="筛选加载器" :disabled="busy" @change="searchProjects()"><option value="">所有加载器</option><option value="neoforge">NeoForge</option><option value="forge">Forge</option><option value="fabric">Fabric</option><option value="quilt">Quilt</option><option value="liteloader">LiteLoader</option></select><button class="button button-subtle" :disabled="loading || busy"><LoaderCircle v-if="loading" :size="15" class="spin" /><Search v-else :size="15" />搜索</button></form>
    <div class="catalog-filter-summary"><span>{{ minecraftFilter || '所有 Minecraft 版本' }} · {{ loaderFilter || '所有加载器' }}</span><button v-if="minecraftFilter || loaderFilter" class="text-button" type="button" :disabled="busy" @click="clearFilters"><X :size="12" />清除筛选</button><span v-else>可直接下载文件，也可选择实例安装</span></div>
    <div v-if="tab === 'mod'" class="catalog-target"><Box :size="15" /><label for="catalog-target-instance">安装到</label><select id="catalog-target-instance" v-model="targetId" :disabled="busy"><option v-if="!clients.length" value="">尚未添加客户端实例</option><option v-for="instance in clients" :key="instance.id" :value="instance.id">{{ instance.name }}</option></select><span v-if="target">{{ target.minecraftVersion }} · {{ target.loader }}</span><button v-if="target" class="text-button" type="button" @click="matchTarget">匹配实例<ArrowRight :size="13" /></button></div>
    <div class="catalog-layout">
      <section class="panel catalog-results">
        <div class="catalog-list-heading"><strong>{{ tab === 'mod' ? '模组' : '整合包' }}</strong><span>{{ projects.total.toLocaleString('zh-CN') }} 个结果</span></div>
        <div v-if="loading" class="catalog-empty"><LoaderCircle :size="24" class="spin" /><p>正在查询 Modrinth…</p></div>
        <div v-else-if="!projects.hits.length" class="catalog-empty"><Search :size="30" /><p>{{ error ? '项目列表暂不可用' : '没有匹配的项目，请调整版本或加载器筛选。' }}</p></div>
        <button v-for="item in projects.hits" v-else :key="item.id" class="catalog-project" :class="{selected:project?.id === item.id}" @click="chooseProject(item)"><ProjectIcon class="project-icon" :url="item.iconUrl" :project-id="item.id" :kind="item.type" /><span class="project-copy"><strong>{{ item.title }}</strong><span>{{ item.description }}</span><small>{{ item.author }}<i>·</i><Download :size="10" />{{ formatDownloads(item.downloads) }}</small></span><ArrowRight :size="14" /></button>
        <div v-if="projects.total > projects.limit" class="catalog-pagination"><button class="text-button" :disabled="loading || projects.offset === 0" @click="searchProjects(Math.max(0, projects.offset-projects.limit))">上一页</button><span>{{ Math.floor(projects.offset / projects.limit) + 1 }} / {{ Math.ceil(projects.total / projects.limit) }}</span><button class="text-button" :disabled="loading || projects.offset + projects.limit >= projects.total" @click="searchProjects(projects.offset + projects.limit)">下一页</button></div>
      </section>
      <aside class="panel catalog-details">
        <template v-if="project">
          <div class="project-detail-heading"><ProjectIcon class="project-icon detail-project-icon" :url="project.iconUrl" :project-id="project.id" :kind="project.type" /><div><span class="detail-source">Modrinth · {{ project.author }}</span><h2 class="project-detail-title">{{ project.title }}</h2></div></div><p>{{ project.description }}</p>
          <div v-if="versionLoading" class="catalog-empty compact"><LoaderCircle :size="22" class="spin" /><p>正在筛选兼容版本…</p></div>
          <div v-else-if="versionError" class="detail-warning"><TriangleAlert :size="14" /><span>{{ versionError }}<button class="text-button" @click="chooseProject(project)">重试</button></span></div>
          <template v-else>
            <label class="catalog-preview-toggle"><input v-model="includePreviews" type="checkbox" />显示 Beta / Alpha</label>
            <p v-if="!listedVersions.length" class="detail-warning"><TriangleAlert :size="14" />没有符合当前筛选的版本，请调整筛选条件。</p>
            <label v-else class="field-label">项目版本<select v-model="versionId" class="field-select" :disabled="busy"><option v-for="version in listedVersions" :key="version.id" :value="version.id">{{ version.versionNumber || version.name }} · {{ releaseLabel(version.versionType) }}</option></select></label>
            <template v-if="selectedVersion">
              <div class="detail-meta"><span>发布日期<strong>{{ date(selectedVersion.publishedAt) }}</strong></span><span>兼容加载器<strong>{{ selectedVersion.loaders.join(' / ') }}</strong></span></div>
              <label class="field-label">下载文件<select v-model="fileTicket" class="field-select file-select" :disabled="busy"><option v-for="file in selectedVersion.files" :key="file.ticket" :value="file.ticket">{{ file.filename }} · {{ formatBytes(file.size) }}</option></select></label>
              <p v-if="selectedVersion.requiredDependencies && tab === 'mod'" class="catalog-footnote">含 {{ selectedVersion.requiredDependencies }} 项直接必需依赖，安装时自动解析并补齐。</p>
              <button class="button button-primary full-width catalog-save" :disabled="!api || busy || !selectedFile" @click="saveSelected"><LoaderCircle v-if="working && workKind === 'save'" :size="16" class="spin" /><ArrowDownToLine v-else :size="16" />{{ working && workKind === 'save' ? '正在保存' : '另存为文件' }}</button>
              <small class="catalog-footnote">选择保存位置，只下载当前文件，不写入游戏实例{{ tab === 'mod' ? '，不自动下载依赖' : '' }}。</small>
              <div class="catalog-install-section"><span>{{ tab === 'mod' ? '安装到游戏' : '创建游戏实例' }}</span>
                <p v-if="tab === 'mod' && !modCompatible" class="detail-warning"><TriangleAlert :size="14" />{{ !target ? '安装需要客户端实例；单独下载无需实例。' : target.status !== 'ready' ? '当前实例尚未安装完整，请先完成安装或修复。' : !supportedLoader(target) ? '当前实例没有受支持的模组加载器。' : '与所选实例不兼容，可点击“匹配实例”筛选，或直接另存文件。' }}</p>
                <button class="button button-subtle full-width" :disabled="!api || busy || !selectedFile || (tab === 'mod' && !modCompatible)" @click="downloadSelected"><LoaderCircle v-if="working && workKind === 'install'" :size="16" class="spin" /><Box v-else :size="16" />{{ working && workKind === 'install' ? '正在安装' : tab === 'mod' ? '安装到所选实例' : '下载并安装整合包' }}</button>
                <small class="catalog-footnote">{{ tab === 'mod' ? '安装会检查兼容性并补齐必需依赖，已有文件不会被直接覆盖。' : '下载校验完成后，继续预览并创建独立客户端。' }}</small>
              </div>
            </template>
          </template>
        </template>
        <div v-else class="catalog-empty"><Box v-if="tab === 'mod'" :size="32" /><Archive v-else :size="32" /><p>选择项目查看可下载版本。</p></div>
      </aside>
    </div>
  </template>
  <p class="catalog-acceleration">下载加速：BMCLAPI（bangbang93） · MCIM</p>
</template>

<style scoped>
.catalog-task-detail{padding:16px 18px;margin-bottom:21px;border:1px solid #66c9ad30;border-radius:9px;background:#11252b;scroll-margin-top:16px}.task-detail-heading{display:flex;align-items:center;gap:10px;color:#87c4b3;min-width:0}.task-detail-heading>strong{font-size:12px;font-weight:550;color:#b8d8dc;min-width:0;overflow-wrap:anywhere;flex:1}.task-detail-heading>span{font-size:9px;color:#7fa99f;white-space:nowrap}.task-detail-heading>.icon-button{margin-left:5px}.task-detail-body{display:flex;align-items:center;gap:15px;margin-top:10px;min-width:0}.task-detail-body>p{font-size:10px;line-height:1.8;color:#769aa9;overflow-wrap:anywhere;flex:1;max-height:54px;overflow:auto}.task-detail-body>strong{font-size:13px;font-weight:500;color:#a6d8c7;font-variant-numeric:tabular-nums;white-space:nowrap}.task-detail-body>.button{font-size:10px;padding:8px 11px;min-height:32px;white-space:nowrap}.task-detail-count{display:block;font-size:9px;color:#638b9c;margin-top:8px;font-variant-numeric:tabular-nums}.catalog-task-detail.error{border-color:#bf8b6735;background:#241f20}.catalog-task-detail.error .task-detail-heading{color:#c59c82}.catalog-task-detail.cancelled{border-color:#86919428;background:#18242a}.catalog-task-detail .catalog-track{margin-top:13px}
.minecraft-tab-icon{width:19px;height:19px;object-fit:contain}.version-block{background:none!important;border:0!important}.version-block>img{width:32px;height:32px;object-fit:contain}.detail-icon>img{width:48px;height:48px;object-fit:contain}.detail-icon{background:none!important;border:0!important}.minecraft-empty-icon{width:40px;height:40px}.catalog-filter-summary{display:flex;align-items:center;gap:12px;justify-content:space-between;color:#718d9e;font-size:10px;margin:-5px 1px 16px;min-height:20px}.catalog-filter-summary .text-button{font-size:10px;color:#9bc5bc}.catalog-install-section{border-top:1px solid #ffffff0d;margin-top:20px;padding-top:16px}.catalog-install-section>span{font-size:10px;color:#91adba}.catalog-install-section>.button{margin-top:13px;font-size:11px;min-height:38px}.catalog-details .catalog-save{margin-top:18px}
.catalog-heading{margin-bottom:20px}.catalog-heading h1{font-size:25px}.catalog-source{font-size:10px;color:#72938f;border:1px solid #75b4a523;padding:7px 10px;border-radius:6px;white-space:nowrap}.catalog-tabs{display:flex;gap:24px;border-bottom:1px solid #ffffff0c;margin-bottom:20px}.catalog-tabs>button{display:flex;align-items:center;gap:9px;font-size:12px;color:#7c94a7;padding:0 3px 15px;border-bottom:2px solid transparent}.catalog-tabs>button.active{color:#8de8cc;border-color:#72efd2}.catalog-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;align-items:start}.catalog-results{min-width:0}.catalog-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:17px}.catalog-version-types{display:flex;gap:5px}.catalog-version-types>button{padding:7px 12px;border:1px solid transparent;border-radius:6px;font-size:11px;color:#7c96a7}.catalog-version-types>button.active{border-color:#72efd22d;background:#72efd20b;color:#9bdcca}.catalog-search{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid #ffffff10;border-radius:7px;color:#648396;background:#101b25;min-width:0}.catalog-search input{width:100%;min-width:0;background:none;border:0;color:#b8d0dc;font-size:11px;outline:0}.catalog-search input::placeholder{color:#57748a}.catalog-toolbar>.catalog-search{width:195px}.catalog-list-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:16px 19px;border-bottom:1px solid #ffffff08}.catalog-list-heading strong{font-size:12px;font-weight:550;color:#b9d0da}.catalog-list-heading>span{font-size:10px;color:#617e91}.catalog-version-row{width:100%;display:flex;align-items:center;gap:13px;padding:14px 18px;text-align:left;border-bottom:1px solid #ffffff06;color:#81a095}.version-block{width:35px;height:35px;display:grid;place-items:center;border-radius:8px;background:#66c3a50d;border:1px solid #64c7a414;color:#7ebda9}.catalog-version-row>span:nth-child(2){flex:1;min-width:0}.catalog-version-row strong{display:block;font-size:12px;font-weight:550;color:#bdd3de}.catalog-version-row small{font-size:9px;color:#5f7e92;display:block;margin-top:6px}.catalog-version-row.selected,.catalog-project.selected{background:linear-gradient(90deg,#65c4a70c,transparent)}.catalog-version-row:hover,.catalog-project:hover{background-color:#ffffff03}.catalog-tag{font-size:8px;border:1px solid #6cb69d22;background:#6cb69d09;border-radius:4px;padding:4px 6px;color:#79b6a0;white-space:nowrap}.catalog-tag.preview{color:#bea878;border-color:#bea87822;background:#bea87808}.version-arrow{transform:rotate(-90deg);color:#3b6076}.catalog-more{padding:15px;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;color:#789eac;font-size:11px}.catalog-details{padding:23px;position:sticky;top:0;min-width:0}.detail-icon{width:53px;height:53px;display:grid;place-items:center;background:#62d4b70c;border:1px solid #62d4b720;border-radius:11px;color:#80cdb6;margin-bottom:23px}.detail-source{display:block;font-size:9px;color:#69939c;line-height:1.7;margin-bottom:8px;overflow-wrap:anywhere}.catalog-details h2{font-size:28px;letter-spacing:-.5px;color:#d1e9eb;overflow-wrap:anywhere}.catalog-details h2.project-detail-title{font-size:20px;line-height:1.45;letter-spacing:0}.catalog-details>p{font-size:10px;line-height:1.9;color:#7d98aa;margin:14px 0 20px}.catalog-details .field-label{font-size:10px}.catalog-details .field-input,.catalog-details .field-select{font-size:11px;padding:10px}.catalog-details .button-primary{margin-top:20px;font-size:11px}.catalog-footnote{font-size:9px;color:#648295;line-height:1.9;display:block;margin-top:13px}.detail-warning{display:flex;align-items:flex-start;gap:7px;color:#c0a778!important;font-size:10px!important;line-height:1.8;margin:15px 0}.detail-warning>svg{margin-top:2px}.detail-warning .text-button{display:block;margin-top:7px;color:#a5c7c2}.catalog-empty{padding:45px 20px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:15px;color:#4f7c8d;text-align:center}.catalog-empty p{font-size:11px;line-height:1.8;color:#6c899c}.catalog-empty.compact{padding:25px 5px}.catalog-filterbar{display:flex;gap:9px;align-items:center;margin-bottom:16px}.catalog-filterbar>.catalog-search{flex:1}.catalog-filter{display:flex;gap:7px;align-items:center;border:1px solid #ffffff10;background:#101b25;border-radius:7px;padding:10px;color:#638497;width:145px}.catalog-filter input{background:none;border:0;outline:0;color:#a8c3d1;font-size:10px;min-width:0;width:100%}.catalog-filter input::placeholder{color:#668597}.catalog-filterbar>select{width:135px;background:#101b25;border:1px solid #ffffff10;border-radius:7px;font-size:10px;padding:10px;color:#9bb7c8;min-height:37px}.catalog-filterbar .button{font-size:11px;min-height:37px}.catalog-target{display:flex;align-items:center;gap:10px;padding:12px 15px;background:#111f28;border:1px solid #ffffff09;border-radius:8px;margin-bottom:18px;color:#79a2a7;font-size:10px;min-width:0}.catalog-target label{color:#6e8a9c;white-space:nowrap}.catalog-target>select{min-width:0;max-width:240px;flex:1;background:#132530;border:0;color:#b6cdd9;padding:5px;border-radius:4px;font-size:11px}.catalog-target>span{font-size:9px;color:#698a9e;white-space:nowrap}.catalog-target>.text-button{margin-left:auto;font-size:10px;white-space:nowrap}.catalog-project{width:100%;display:flex;align-items:flex-start;gap:13px;padding:19px 18px;text-align:left;border-bottom:1px solid #ffffff07;min-width:0}.project-icon{display:grid;place-items:center;width:43px;height:43px;border:1px solid #4f9f9b1a;background:linear-gradient(145deg,#23515133,#17384422);border-radius:9px;color:#78b3b2;flex-shrink:0}.project-copy{flex:1;min-width:0}.project-copy>strong{display:block;color:#c0d8e0;font-size:13px;font-weight:550;overflow-wrap:anywhere;line-height:1.6}.project-copy>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:10px;line-height:1.8;color:#7893a6;margin-top:6px}.project-copy>small{display:flex;gap:7px;align-items:center;color:#547b8e;font-size:9px;margin-top:10px}.project-copy i{font-style:normal;color:#36586b}.catalog-project>svg:last-child{color:#416b7b;margin-top:5px}.catalog-pagination{display:flex;justify-content:space-between;align-items:center;padding:17px 19px;gap:12px}.catalog-pagination>span{color:#5b7c90;font-size:10px}.catalog-pagination .text-button{font-size:10px}.catalog-preview-toggle{display:flex;align-items:center;gap:7px;font-size:10px;color:#7f9eae;margin-top:20px}.catalog-preview-toggle input{accent-color:#72efd2}.detail-meta{display:flex;flex-direction:column;gap:10px;margin:17px 0}.detail-meta>span{display:flex;justify-content:space-between;gap:10px;font-size:9px;color:#5d8196}.detail-meta strong{font-size:9px;font-weight:400;color:#8eacbb;overflow-wrap:anywhere;text-align:right}.file-select{max-width:100%;text-overflow:ellipsis}.catalog-error{display:flex;align-items:flex-start;gap:9px;border:1px solid #be9a6230;background:#be9a6209;border-radius:8px;padding:13px 15px;margin-bottom:17px;color:#c4aa80;font-size:11px;line-height:1.8}.catalog-error>svg{margin-top:2px}.catalog-error>span{flex:1;overflow-wrap:anywhere}.catalog-error>.text-button{color:#aac9c0;font-size:10px}.catalog-progress{margin-bottom:17px;padding:13px 15px;border:1px solid #64ccb326;border-radius:8px;background:#64ccb308}.catalog-progress>div:first-child{display:flex;align-items:center;gap:10px;color:#8bc6b5;font-size:11px;line-height:1.8}.catalog-progress>div>span{flex:1;overflow-wrap:anywhere}.catalog-progress strong{font-size:10px;font-weight:400}.catalog-track{height:3px;background:#27443f;border-radius:3px;margin-top:12px;overflow:hidden}.catalog-track>span{display:block;height:100%;background:#72efd2;transition:width .2s}
.project-detail-heading{display:flex;align-items:center;gap:13px}.project-detail-heading>div{min-width:0}.detail-project-icon{width:56px;height:56px;border-radius:11px}.project-detail-heading .detail-source{margin-bottom:5px}.catalog-acceleration{font-size:9px;color:#587889;margin:20px 0 4px;line-height:1.8}.catalog-progress .text-button{font-size:10px;white-space:nowrap;color:#a2c4bb}
@media(max-width:1190px){.catalog-layout{grid-template-columns:minmax(0,1fr) 265px;gap:15px}.catalog-details{padding:19px}.catalog-filterbar{gap:7px}.catalog-filterbar>select{width:116px}.catalog-filter{width:125px}.catalog-filterbar .button{padding:9px 11px}.catalog-target>span{display:none}.catalog-project{padding:17px 14px;gap:10px}.catalog-project>svg:last-child{display:none}.catalog-toolbar>.catalog-search{width:160px}}
</style>
