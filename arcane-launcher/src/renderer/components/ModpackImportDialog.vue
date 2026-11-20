<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Archive, ArrowRight, Box, Check, Cpu, Download, FolderOpen, LoaderCircle, RotateCcw, Square, Trash2, TriangleAlert } from 'lucide-vue-next'
import type { ModpackInstallResult, ModpackJob, ModpackPreview, ModpackProgressStep } from '../../shared/contracts'
import { importNetworkSpeed, importOverallPercent, importProgressSteps, importRemainingFiles } from '../../shared/modpack-progress-presentation'

const props = defineProps<{ preview?: ModpackPreview; jobId?: string }>()
const emit = defineEmits<{ installed: [result: ModpackInstallResult]; folder: []; notify: [message: string, error?: boolean] }>()
const api = window.arcane
const preview = ref<ModpackPreview>()
const name = ref('')
const jobs = ref<ModpackJob[]>([])
const selecting = ref(false)
const working = ref(false)
const error = ref('')
const selectedJob = ref('')
const changingJobs = ref<string[]>([])
const removedJobs = new Set<string>()
const disposers: (() => void)[] = []
watch(() => props.preview, value => { if (value) showPreview(value) }, { immediate: true })
watch(() => props.jobId, value => { if (value) selectedJob.value = value }, { immediate: true })
const current = computed(() => jobs.value.find(job => job.id === selectedJob.value) ?? jobs.value.find(job => job.status === 'running') ?? (preview.value ? jobs.value.find(job => job.id === preview.value?.existingJobId) : jobs.value[0]))
const active = computed(() => jobs.value.some(job => job.status === 'running'))
const supported = computed(() => preview.value && ['vanilla','neoforge'].includes(preview.value.loader))
const existingJob = computed(() => jobs.value.find(job => job.id === preview.value?.existingJobId))
const steps = computed(() => importProgressSteps(current.value, preview.value))
const overall = computed(() => importOverallPercent(current.value))
const remaining = computed(() => importRemainingFiles(current.value))
const speed = computed(() => importNetworkSpeed(current.value))
const currentFilename = computed(() => current.value?.progress?.currentFile)
const statusLabel = (job?: ModpackJob) => !job ? '等待开始' : job.status === 'running' ? '正在安装' : job.status === 'complete' ? '安装完成' : job.status === 'cancelled' ? '已取消' : '安装失败'
const stepLabel = (step: ModpackProgressStep) => ({ pending:'等待中', running:'进行中', complete:'已完成', error:'失败', cancelled:'已取消', skipped:'无需安装' })[step.status]
const stepPercent = (step: ModpackProgressStep) => step.status === 'complete' ? 100 : typeof step.percent === 'number' && Number.isFinite(step.percent) ? Math.max(0, Math.min(100, Math.floor(step.percent))) : undefined
function showPreview(value: ModpackPreview) {
  preview.value = value; name.value = value.name; error.value = ''
  selectedJob.value = value.existingJobId ?? ''
}
function size(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes)} B`
}
function stepDetail(step: ModpackProgressStep) {
  const parts: string[] = []
  if (step.completedFiles !== undefined && step.totalFiles !== undefined) parts.push(`${step.completedFiles} / ${step.totalFiles} 个文件`)
  if (step.completedBytes !== undefined && step.totalBytes !== undefined) parts.push(`${size(step.completedBytes)} / ${size(step.totalBytes)}`)
  return parts.join(' · ')
}
function update(job: ModpackJob) {
  if (!removedJobs.has(job.id)) {
    jobs.value = [job, ...jobs.value.filter(item => item.id !== job.id)].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
    if (job.status === 'running' && (!selectedJob.value || working.value)) selectedJob.value = job.id
  }
}
function removeJob(jobId: string) {
  removedJobs.add(jobId)
  jobs.value = jobs.value.filter(job => job.id !== jobId)
  if (selectedJob.value === jobId) selectedJob.value = ''
  if (preview.value?.existingJobId === jobId) preview.value = { ...preview.value, existingJobId: undefined }
}
async function refreshJobs() { if (api) jobs.value = (await api.listModpackJobs().catch(() => jobs.value)).filter(job => !removedJobs.has(job.id)) }
async function selectFile() {
  if (!api) { error.value = '请在桌面版中选择整合包文件。'; return }
  if (selecting.value || working.value || active.value) return
  selecting.value = true; error.value = ''
  try { const result = await api.inspectModpack(); if (result) showPreview(result) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { selecting.value = false }
}
async function install(job?: ModpackJob, createNew = false) {
  if (!api || working.value || active.value || (!job && !preview.value)) return
  working.value = true; error.value = ''
  try {
    const existingId = job?.id ?? (!createNew ? preview.value?.existingJobId : undefined)
    const result = existingId ? await api.resumeModpack(existingId) : await api.installModpack(preview.value!.id, name.value.trim())
    preview.value = undefined
    emit('installed', result)
  } catch (cause) { if (current.value?.status !== 'cancelled') error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { working.value = false; await refreshJobs() }
}
async function cancel(job: ModpackJob) {
  if (!api || changingJobs.value.includes(job.id)) return
  changingJobs.value.push(job.id); error.value = ''
  try { await api.cancelModpack(job.id); await refreshJobs() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { changingJobs.value = changingJobs.value.filter(id => id !== job.id) }
}
async function dismiss(job: ModpackJob) {
  if (!api || working.value || changingJobs.value.includes(job.id)) return
  changingJobs.value.push(job.id); error.value = ''
  try { await api.dismissModpack(job.id); removeJob(job.id); emit('notify', '已移除安装记录，已下载文件和原整合包均保留。') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { changingJobs.value = changingJobs.value.filter(id => id !== job.id) }
}
onMounted(async () => {
  if (!api) return
  disposers.push(api.onModpackJob(update), api.onModpackJobRemoved(removeJob))
  await refreshJobs()
})
onUnmounted(() => disposers.forEach(dispose => dispose()))
</script>

<template>
  <div class="pack-import">
    <header class="pack-title"><span class="pack-title-symbol"><Archive :size="22" /></span><div><h2>导入游戏</h2><p>选择整合包，检查安装信息与下载进度。</p></div><span class="pack-format">ZIP / MRPACK</span></header>
    <div class="pack-columns">
      <section class="pack-source-panel" aria-label="整合包安装信息">
        <div class="pack-panel-heading"><strong>安装信息</strong><button v-if="preview" class="text-button" :disabled="selecting || working || active" @click="selectFile"><FolderOpen :size="13" />更换文件</button></div>
        <div class="pack-source-scroll">
          <div v-if="!preview" class="import-options">
            <template v-if="current">
              <div class="pack-file" :title="current.archiveName || current.name"><Archive :size="18" /><div><small>{{ current.archiveName ? '整合包文件' : '已恢复的安装记录' }}</small><strong>{{ current.archiveName || current.name }}</strong></div></div>
              <div class="pack-restored"><Box :size="19" /><strong>{{ current.name }}</strong><span>客户端实例</span></div>
              <dl class="pack-facts pack-restored-facts"><div><dt>Minecraft</dt><dd>{{ current.minecraftVersion }}</dd></div><div><dt>加载器</dt><dd>{{ current.loader === 'vanilla' ? '原版' : current.loader }} {{ current.loaderVersion }}</dd></div><div v-if="current.requiredJavaMajor"><dt>Java 要求</dt><dd>Java {{ current.requiredJavaMajor }}</dd></div><div><dt>安装状态</dt><dd>{{ statusLabel(current) }}</dd></div></dl>
              <p class="pack-description">右侧显示已保存的安装状态。继续安装会重新检查环境并复用已校验文件。</p>
              <span class="pack-other-source-label">其他导入方式</span>
            </template>
            <button :disabled="selecting || working || active" @click="selectFile"><Archive :size="22" /><span><strong>{{ selecting ? '正在解析整合包…' : '选择整合包文件' }}</strong><small>ZIP / MRPACK</small></span><LoaderCircle v-if="selecting" class="spin" :size="17" /><ArrowRight v-else :size="17" /></button>
            <button :disabled="working || active" @click="emit('folder')"><FolderOpen :size="22" /><span><strong>添加已有游戏目录</strong><small>识别本地 Minecraft 客户端</small></span><ArrowRight :size="17" /></button>
            <p v-if="!current" class="pack-description">也可以将整合包文件拖入启动器。导入会创建独立客户端，原压缩包保留。</p>
          </div>
          <template v-else>
            <div class="pack-file" :title="preview.archiveName"><Archive :size="18" /><div><small>整合包文件</small><strong>{{ preview.archiveName }}</strong></div></div>
            <label class="field-label">{{ preview.existingJobId ? '新实例名称（仅新建时使用）' : '实例名称' }}<input v-model="name" class="field-input" maxlength="60" :disabled="working || active" /></label>
            <dl class="pack-facts">
              <div><dt>Minecraft</dt><dd>{{ preview.minecraftVersion }}</dd></div>
              <div><dt>加载器</dt><dd>{{ preview.loader === 'vanilla' ? '原版' : preview.loader }} {{ preview.loaderVersion }}</dd></div>
              <div><dt>模组文件</dt><dd>{{ preview.modCount }} 个</dd></div>
              <div><dt>整合包清单下载</dt><dd>{{ size(preview.downloadBytes) }}</dd></div>
              <div><dt>配置文件</dt><dd>{{ size(preview.overrideBytes) }}</dd></div>
              <div><dt>Java 要求</dt><dd>Java {{ preview.requiredJavaMajor }}</dd></div>
            </dl>
            <div class="pack-environment" :class="{warning:!preview.javaAvailable}"><Cpu :size="16" /><span>{{ preview.javaAvailable ? `已检测到 Java ${preview.requiredJavaMajor}` : `请在启动设置中配置 Java ${preview.requiredJavaMajor}` }}</span><Check v-if="preview.javaAvailable" :size="14" /></div>
            <p v-if="preview.existingJobId" class="pack-description">找到未完成的安装{{ existingJob ? `「${existingJob.name}」` : '' }}。继续安装会校验并复用已下载文件。</p>
            <p v-else class="pack-description">游戏本体与加载器的下载量另计；已经通过校验的缓存会自动复用。</p>
            <div v-if="preview.warnings.length || !supported" class="pack-warnings">
              <p v-for="warning in preview.warnings" :key="warning" class="pack-warning"><TriangleAlert :size="13" /><span>{{ warning }}</span></p>
              <p v-if="!supported" class="pack-warning"><TriangleAlert :size="13" /><span>暂不支持 {{ preview.loader }} 的自动安装。</span></p>
            </div>
          </template>
        </div>
        <div v-if="preview" class="pack-source-actions">
          <button class="button button-primary full-width" :disabled="working || active || !supported || !preview.javaAvailable || (!preview.existingJobId && !name.trim())" @click="install()"><LoaderCircle v-if="working || active" class="spin" :size="16" /><RotateCcw v-else-if="preview.existingJobId" :size="16" /><Download v-else :size="16" />{{ working || active ? '正在安装' : preview.existingJobId ? '继续现有安装' : '下载并导入' }}</button>
          <button v-if="preview.existingJobId" class="text-button pack-create-new" :disabled="working || active || !supported || !preview.javaAvailable || !name.trim()" @click="install(undefined, true)"><Box :size="13" />创建独立副本</button>
        </div>
      </section>

      <section class="pack-progress-panel" aria-label="安装任务与详细进度">
        <div class="pack-panel-heading"><strong>安装进度</strong><span :class="['pack-status', current?.status]">{{ statusLabel(current) }}</span></div>
        <label v-if="jobs.length > 1 || (jobs.length && preview && !preview.existingJobId)" class="pack-job-select"><span>安装记录</span><select :value="current?.id || ''" :disabled="active || working" aria-label="选择安装记录" @change="selectedJob = ($event.target as HTMLSelectElement).value"><option v-if="preview && !preview.existingJobId" value="">新整合包（尚未开始）</option><option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.name }} · {{ statusLabel(job) }}</option></select></label>
        <div class="pack-summary">
          <div class="pack-overall"><div><strong :title="current?.name || preview?.name">{{ current?.name || preview?.name || '尚未开始安装' }}</strong><span>{{ current ? '安装步骤完成度' : '安装步骤将在开始后实时更新' }}</span></div><span class="pack-overall-percent">{{ current ? overall : '—' }}<small v-if="current">%</small></span></div>
          <div class="pack-progress" role="progressbar" :aria-valuenow="current ? overall : undefined" :aria-valuemax="100" aria-label="整合包安装步骤完成度"><span :style="{width:`${overall}%`}"></span></div>
          <div class="pack-metrics">
            <div><span>本次下载</span><strong>{{ current?.progress ? size(current.progress.transferredBytes) : '—' }}</strong></div>
            <div><span>下载速度</span><strong>{{ speed === undefined ? '—' : `${size(speed)}/s` }}</strong></div>
            <div><span>当前阶段剩余</span><strong>{{ remaining === undefined ? '—' : `${remaining} 个文件` }}</strong></div>
          </div>
          <div class="pack-current-file" :title="currentFilename || current?.message || '开始安装后显示当前处理文件'"><LoaderCircle v-if="current?.status === 'running'" :size="13" class="spin" /><Check v-else-if="current?.status === 'complete'" :size="13" /><Archive v-else :size="13" /><span>{{ currentFilename || current?.message || '等待选择整合包' }}</span></div>
        </div>
        <ol class="pack-step-list" aria-label="详细安装步骤">
          <li v-for="(step,index) in steps" :key="step.id" :class="['pack-step',step.status]">
            <span class="pack-step-symbol"><Check v-if="step.status === 'complete'" :size="15" /><LoaderCircle v-else-if="step.status === 'running'" :size="15" class="spin" /><TriangleAlert v-else-if="step.status === 'error'" :size="15" /><Square v-else-if="step.status === 'cancelled'" :size="12" /><span v-else>{{ String(index + 1).padStart(2,'0') }}</span></span>
            <div class="pack-step-copy"><div><strong>{{ step.title }}</strong><span>{{ stepPercent(step) === undefined ? stepLabel(step) : `${stepPercent(step)}%` }}</span></div><p v-if="stepDetail(step)">{{ stepDetail(step) }}</p><div v-if="step.status === 'running' || step.status === 'error' || step.status === 'cancelled'" :class="['pack-step-track',{'indeterminate':step.status === 'running' && stepPercent(step) === undefined}]" role="progressbar" :aria-label="step.title" :aria-valuenow="stepPercent(step)" :aria-valuemax="100"><span :style="stepPercent(step) !== undefined ? {width:`${stepPercent(step)}%`} : undefined"></span></div></div>
          </li>
        </ol>
        <footer class="pack-task-footer">
          <div v-if="error" class="pack-error" role="alert"><TriangleAlert :size="14" /><span>{{ error }}</span></div>
          <template v-if="current && current.status !== 'complete'">
            <div class="pack-job-actions">
              <button v-if="current.status === 'running'" class="button button-subtle" :disabled="changingJobs.includes(current.id)" @click="cancel(current)"><LoaderCircle v-if="changingJobs.includes(current.id)" class="spin" :size="13" /><Square v-else :size="13" />{{ changingJobs.includes(current.id) ? '正在取消…' : '取消安装' }}</button>
              <template v-else><button class="button button-primary" :disabled="working || active || changingJobs.includes(current.id)" @click="install(current)"><LoaderCircle v-if="working" class="spin" :size="14" /><RotateCcw v-else :size="14" />{{ working ? '正在停止上一任务…' : '继续安装' }}</button><button v-if="current.status === 'error'" class="text-button" :disabled="changingJobs.includes(current.id)" @click="cancel(current)"><Square :size="12" />取消任务</button><button class="text-button" :disabled="working || active || changingJobs.includes(current.id)" @click="dismiss(current)"><Trash2 :size="13" />移除记录</button></template>
            </div>
            <p class="pack-reuse">已校验文件会保留，继续安装时自动复用。</p>
          </template>
          <p v-else-if="current?.status === 'complete'" class="pack-reuse completed"><Check :size="13" />客户端已安装完成。</p>
          <p v-else class="pack-reuse">速度来自实际网络传输；缓存复用和本地解包不计入下载量。</p>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pack-import{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;overflow:hidden}.pack-title{display:flex;align-items:center;gap:13px;flex-shrink:0;padding:0 35px 20px 0}.pack-title-symbol{display:grid;place-items:center;width:43px;height:43px;border-radius:10px;color:#8de0c8;background:#65ddbc0c;border:1px solid #65ddbc22}.pack-title>div{min-width:0;flex:1}.pack-title h2{font-size:21px;line-height:1.3;margin:0}.pack-title p{font-size:11px;color:#7c97a8;margin-top:7px}.pack-format{font-size:10px;letter-spacing:.5px;color:#638493;white-space:nowrap}.pack-columns{display:grid;grid-template-columns:minmax(280px,.85fr) minmax(0,1.15fr);gap:20px;flex:1;min-height:0;min-width:0}.pack-source-panel,.pack-progress-panel{border:1px solid #ffffff0c;border-radius:10px;min-width:0;min-height:0;background:#101b25;display:flex;flex-direction:column;overflow:hidden}.pack-progress-panel{background:#0d1822}.pack-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid #ffffff08;flex-shrink:0}.pack-panel-heading>strong{font-size:11px;font-weight:550;letter-spacing:.2px;color:#b3cbd5}.pack-panel-heading>.text-button{font-size:10px;color:#79aaad;gap:5px}.pack-status{font-size:9px;color:#7e96a8}.pack-status.running,.pack-status.complete{color:#87d4bd}.pack-status.error{color:#d6a28c}.pack-status.cancelled{color:#b8a17f}.pack-source-scroll{overflow:auto;min-height:0;flex:1;padding:18px;scrollbar-width:thin;scrollbar-color:#355364 transparent}.pack-file{display:flex;align-items:center;gap:12px;padding:13px;background:#13232e;border:1px solid #ffffff08;border-radius:7px;color:#7fb9b2}.pack-file>div{min-width:0}.pack-file small{display:block;font-size:9px;color:#66899c;margin-bottom:7px}.pack-file strong{display:block;overflow-wrap:anywhere;font-size:11px;color:#bfd3dc;line-height:1.6;font-weight:500}.pack-file>svg{flex-shrink:0}.pack-source-scroll .field-label{font-size:10px;margin-top:20px}.pack-source-scroll .field-input{font-size:11px;padding:10px 11px;background:#0c1721}.pack-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:17px 12px;margin:22px 0}.pack-facts dt{font-size:9px;color:#64879b;margin-bottom:7px}.pack-facts dd{margin:0;font-size:12px;font-weight:500;color:#b7d0db;overflow-wrap:anywhere;line-height:1.6}.pack-environment{display:flex;align-items:center;gap:9px;padding:11px;font-size:10px;line-height:1.7;border-radius:6px;background:#65d9b708;color:#92cbb9}.pack-environment>span{flex:1}.pack-environment>svg{flex-shrink:0}.pack-environment.warning{background:#d0ac700b;color:#d0ac70}.pack-description{font-size:10px;line-height:1.9;color:#6e8d9f;margin:15px 0 0}.pack-warnings{margin-top:14px}.pack-warning{font-size:10px;line-height:1.8;color:#c6ac7d;display:flex;gap:7px;align-items:flex-start;margin:8px 0}.pack-warning svg{margin-top:3px;flex-shrink:0}.pack-warning>span{overflow-wrap:anywhere}.pack-source-actions{flex-shrink:0;border-top:1px solid #ffffff08;padding:16px 18px;background:#101e28}.pack-source-actions>.button{font-size:11px;min-height:41px;justify-content:center}.pack-create-new{display:flex;justify-content:center;margin:11px auto 0;font-size:10px;color:#86aaa9}.import-options{display:flex;flex-direction:column;gap:12px}.import-options>button{display:flex;align-items:center;text-align:left;gap:13px;padding:20px 14px;background:#13232e;border:1px solid #ffffff0d;border-radius:8px;color:#83b6b2}.import-options>button:hover{border-color:#72efd23a}.import-options>button>span{flex:1;min-width:0}.import-options>button>svg{flex-shrink:0}.import-options strong{font-size:12px;line-height:1.6;color:#c5d9e0;display:block;font-weight:500}.import-options small{display:block;font-size:9px;color:#6a8b9e;margin-top:7px;line-height:1.7}.pack-restored{display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px 8px;padding:19px 0;border-top:1px solid #ffffff08;margin-top:12px;color:#76a7a4}.pack-restored>strong{font-size:12px;color:#b0c8d4;line-height:1.6;overflow-wrap:anywhere}.pack-restored>span,.pack-restored>p{grid-column:2;font-size:10px;color:#66899d;line-height:1.9}.pack-job-select{display:flex;align-items:center;gap:10px;padding:11px 18px 0;font-size:9px;color:#648698;flex-shrink:0}.pack-job-select>span{white-space:nowrap}.pack-job-select>select{min-width:0;width:100%;background:#101e29;color:#9ebdca;border:1px solid #ffffff0b;border-radius:5px;font-size:10px;padding:7px;overflow:hidden;text-overflow:ellipsis}.pack-summary{padding:20px 19px 15px;flex-shrink:0;border-bottom:1px solid #ffffff08}.pack-overall{display:flex;align-items:center;gap:20px;justify-content:space-between;margin-bottom:17px}.pack-overall>div{min-width:0}.pack-overall strong{display:block;font-size:12px;line-height:1.7;color:#bdd2dc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}.pack-overall>div>span{display:block;margin-top:6px;font-size:9px;color:#648296}.pack-overall-percent{font-size:32px;line-height:1;letter-spacing:-1px;white-space:nowrap;color:#9be3cc;font-variant-numeric:tabular-nums}.pack-overall-percent>small{font-size:12px;color:#729f9e;margin-left:4px;letter-spacing:0}.pack-progress{height:4px;border-radius:4px;background:#ffffff08;overflow:hidden}.pack-progress>span{display:block;height:100%;background:#72efd2;transition:width .2s}.pack-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:18px 0 16px}.pack-metrics>div{min-width:0}.pack-metrics span{display:block;color:#5f8195;font-size:9px;margin-bottom:7px}.pack-metrics strong{font-size:11px;font-weight:500;color:#a5c2ce;font-variant-numeric:tabular-nums;white-space:nowrap}.pack-current-file{display:flex;align-items:center;gap:7px;color:#7296a5;font-size:9px;min-width:0;line-height:1.8}.pack-current-file>svg{flex-shrink:0;color:#6aa997}.pack-current-file>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pack-step-list{list-style:none;margin:0;padding:4px 19px 8px;min-height:0;flex:1;overflow:auto;scrollbar-width:thin;scrollbar-color:#355364 transparent}.pack-step{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #ffffff05;min-width:0}.pack-step:last-child{border-bottom:0}.pack-step-symbol{width:23px;height:23px;display:grid;place-items:center;color:#496b7e;flex-shrink:0;border:1px solid #496b7e33;border-radius:50%;font-size:8px;font-variant-numeric:tabular-nums}.pack-step.running .pack-step-symbol{color:#85dfc1;border-color:#68ccaa44;background:#68ccaa0b}.pack-step.complete .pack-step-symbol{color:#78c4a9;border-color:transparent;background:#68ccaa0c}.pack-step.error .pack-step-symbol{color:#cc9d7e;border-color:#cc9d7e40}.pack-step.cancelled .pack-step-symbol{color:#ac9b7c;border-color:#ac9b7c30}.pack-step.skipped .pack-step-symbol{opacity:.4}.pack-step-copy{min-width:0;flex:1;padding-top:3px}.pack-step-copy>div:first-child{display:flex;gap:12px;justify-content:space-between;align-items:center}.pack-step-copy strong{font-size:10px;font-weight:500;color:#68889c;line-height:1.7;overflow-wrap:anywhere}.pack-step-copy>div>span{font-size:9px;color:#4f7387;white-space:nowrap;font-variant-numeric:tabular-nums}.pack-step.running strong,.pack-step.complete strong{color:#b2cbd5}.pack-step.running .pack-step-copy>div>span,.pack-step.complete .pack-step-copy>div>span{color:#83bca8}.pack-step.error strong,.pack-step.error .pack-step-copy>div>span{color:#c5a17e}.pack-step-copy>p{font-size:9px;color:#5e8296;line-height:1.7;margin-top:6px;font-variant-numeric:tabular-nums}.pack-step-track{height:3px;border-radius:3px;background:#ffffff06;margin-top:10px;overflow:hidden}.pack-step-track>span{display:block;height:100%;width:0;background:#70c9af;transition:width .2s}.pack-step.error .pack-step-track>span{background:#bd9974}.pack-step-track.indeterminate>span{width:25%;animation:pack-indeterminate 1.5s ease-in-out infinite}.pack-task-footer{flex-shrink:0;padding:13px 18px 14px;border-top:1px solid #ffffff08;background:#0f1b25}.pack-job-actions{display:flex;align-items:center;gap:15px;flex-wrap:wrap}.pack-job-actions>.button{font-size:10px;min-height:33px;padding:8px 13px;justify-content:center}.pack-job-actions>.text-button{font-size:9px;color:#87a5b1}.pack-reuse{font-size:9px;color:#547b8e;margin:10px 0 0;line-height:1.8}.pack-reuse.completed{display:flex;gap:7px;align-items:center;color:#87baa8;margin-top:0}.pack-error{display:flex;align-items:flex-start;gap:7px;padding:9px 10px;background:#d479790a;border:1px solid #d4797922;color:#d29d9d;font-size:10px;line-height:1.7;border-radius:6px;margin-bottom:11px;max-height:62px;overflow:auto}.pack-error svg{margin-top:2px;flex-shrink:0}.pack-error>span{overflow-wrap:anywhere}.pack-task-footer>.pack-reuse:first-child{margin-top:0}@keyframes pack-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(420%)}}@media(max-width:1000px){.pack-columns{grid-template-columns:minmax(265px,.85fr) minmax(0,1.15fr);gap:14px}.pack-source-scroll{padding:15px}.pack-panel-heading{padding:14px 15px}.pack-summary{padding:17px 15px 13px}.pack-step-list{padding-left:15px;padding-right:15px}.pack-format{display:none}.pack-metrics strong{font-size:10px}.pack-title{padding-bottom:17px}.pack-title h2{font-size:20px}}@media(prefers-reduced-motion:reduce){.pack-step-track.indeterminate>span{animation:none}.pack-progress>span,.pack-step-track>span{transition:none}}
</style>
<style scoped>
.pack-restored-facts{margin:0 0 4px}.pack-restored{padding:8px 0 3px;margin-top:1px;border:0}.pack-other-source-label{display:block;font-size:9px;color:#577d91;border-top:1px solid #ffffff08;padding-top:19px;margin-top:5px}.import-options>.pack-description{margin-top:0}
</style>
