<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { ArrowUpRight, ArrowRight, Plus, FolderOpen, Play, Cpu, MemoryStick, Check, ShieldCheck, Box, Server, RefreshCw, TriangleAlert, UserRound, Terminal, Image, Layers3, ScanLine, Square, LoaderCircle } from 'lucide-vue-next'
import type { AccountState, JavaInstallation, LauncherInstance, LauncherSnapshot, RuntimeInfo } from '../../shared/contracts'
import { accountPresentation } from '../../shared/account-presentation'

const PortalScene = defineAsyncComponent(() => import('./PortalScene.vue'))
const SkinPreview = defineAsyncComponent(() => import('./SkinPreview.vue'))
const props = defineProps<{ snapshot: LauncherSnapshot; selected?: LauncherInstance; runtime: RuntimeInfo; java?: JavaInstallation; account: AccountState; loading: boolean; busy: boolean; running: Set<string>; installing: boolean }>()
const emit = defineEmits<{ launch: []; check: []; folder: []; import: []; create: []; account: []; settings: []; instances: []; diagnostics: []; screenshots: []; backup: []; select: [instance: LauncherInstance]; refresh: []; stop: []; tasks: [] }>()

const name = computed(() => props.account.profile?.name ?? '未登录')
const identity = computed(() => accountPresentation(props.account))
const accountVerified = computed(() => identity.value.verified)
const accountLabel = computed(() => identity.value.label)
const accountSkinLabel = computed(() => props.account.profile
  ? props.account.profile.skinDataUrl ? accountVerified.value ? '账号皮肤预览' : '缓存皮肤预览' : '皮肤未获取 · 当前展示默认角色'
  : props.account.localSkin ? '本地皮肤 · 仅启动器预览' : '默认角色皮肤')
const requiredJava = computed(() => props.selected?.requiredJavaMajor ?? 17)
const javaFits = computed(() => !!props.java && props.java.major === requiredJava.value)
const isRunning = computed(() => props.selected && props.running.has(props.selected.id))
const worldCount = computed(() => props.selected?.kind === 'server' ? props.selected.worldDirectories?.length ?? 0 : props.selected?.stats.saves ?? 0)
const launchIssues = computed(() => {
  if (!props.selected) return []
  const issues = [...props.selected.issues]
  if (!props.java) issues.push(props.snapshot.settings.javaPath.trim() ? '指定的 Java 未通过检测，请在启动设置中重新选择。' : `未找到 Java ${requiredJava.value}，请在启动设置中配置。`)
  else if (!javaFits.value) issues.push(`当前 Java ${props.java.major}，此实例需要 Java ${requiredJava.value}。`)
  return [...new Set(issues)]
})
const needsCheck = computed(() => !!props.selected && (props.selected.status !== 'ready' || launchIssues.value.length > 0))
const loaderDetail = computed(() => {
  const instance = props.selected
  if (!instance) return ''
  if (instance.loader === '原版') return '原版 · Java 版'
  return `${instance.loader || '加载器未识别'}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}`
})

function chooseVersion(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  const item = props.snapshot.instances.find(instance => instance.id === id)
  if (item) emit('select', item)
}
const label = (item: LauncherInstance) => props.running.has(item.id) ? '运行中' : item.status === 'ready' ? '文件检查通过' : '需要检查'
</script>

<template>
  <div class="home-dashboard">
  <div class="dashboard-heading overview-heading">
    <div class="overview-title"><h1>游戏概览</h1><span>{{ snapshot.instances.length }} 个实例<template v-if="running.size"> · {{ running.size }} 个运行中</template></span></div>
    <button class="button button-subtle" @click="emit('import')"><FolderOpen :size="15" />导入游戏</button>
  </div>
  <div class="home-grid">
    <div class="home-main">
      <section class="world-hero" aria-label="当前实例概览">
        <div class="hero-stars"></div><PortalScene />
        <div v-if="selected" class="instance-overview">
          <div class="overview-kind"><span class="signal-dot"></span>{{ selected.kind === 'server' ? 'Minecraft 服务端' : 'Minecraft Java 版' }}</div>
          <h2 class="overview-version">{{ selected.minecraftVersion || '版本待识别' }}</h2>
          <div class="overview-loader"><Box :size="13" /><span>{{ loaderDetail }}</span></div>
          <dl class="overview-stats">
            <div><dt>模组文件</dt><dd>{{ selected.stats.mods }}<span>个</span></dd></div>
            <div><dt>{{ selected.kind === 'server' ? '服务端世界' : '游戏存档' }}</dt><dd>{{ worldCount }}<span>个</span></dd></div>
          </dl>
          <div v-if="selected.kind === 'client'" class="overview-resources">{{ selected.stats.resourcePacks }} 个资源包<span>·</span>{{ selected.stats.shaderPacks }} 个光影包</div>
          <div v-else class="overview-resources">运行要求<span>·</span>Java {{ requiredJava }}</div>
        </div>
        <div v-else class="instance-overview overview-empty">
          <div class="overview-kind"><Box :size="14" />本地游戏</div>
          <h2>未添加实例</h2>
          <p>安装 Minecraft，或导入本地游戏目录。</p>
          <button class="text-button" @click="emit('create')"><Plus :size="15" />安装游戏<ArrowRight :size="14" /></button>
        </div>
      </section>

      <section class="launch-dock">
        <div class="dock-instance">
          <span class="instance-art"><Server v-if="selected?.kind === 'server'" :size="24" /><Box v-else :size="24" /></span>
          <span><small>{{ selected?.kind === 'server' ? '当前服务端' : '当前游戏实例' }}</small><select v-if="snapshot.instances.length" :value="selected?.id" @change="chooseVersion" aria-label="选择当前游戏实例"><option v-for="instance in snapshot.instances" :key="instance.id" :value="instance.id">{{ instance.name }}</option></select><strong v-else>未选择实例</strong><span>{{ selected ? `${selected.minecraftVersion || '版本待识别'} · ${selected.loader || '本地实例'}` : '支持安装原版、导入整合包与服务端' }}</span></span>
        </div>
        <button v-if="selected" class="dock-folder icon-button" aria-label="打开当前实例目录" @click="emit('folder')"><FolderOpen :size="16" /></button>
        <button v-if="isRunning" class="button button-primary launch-button launch-button-stop" @click="emit('stop')"><Square :size="17" /><span>停止运行</span></button>
        <button v-else class="button button-primary launch-button" :disabled="loading || busy" @click="installing ? emit('tasks') : needsCheck ? emit('check') : emit('launch')"><LoaderCircle v-if="loading || busy || installing" :size="20" class="spin" /><Play v-else :size="20" fill="currentColor" /><span>{{ installing ? '查看安装进度' : selected ? !account.profile || account.status === 'reauthentication-required' ? '登录后启动' : needsCheck ? '检查并启动' : selected.kind === 'server' ? '启动服务器' : '启动游戏' : '安装游戏' }}</span><ArrowUpRight :size="18" /></button>
      </section>

      <div class="runtime-strip">
        <button @click="emit('settings')"><Cpu :size="17" /><span><small>运行环境</small><strong :class="{ 'warning-text': selected && !javaFits }">{{ java ? `Java ${java.major}` : '尚未配置' }}<i v-if="selected">{{ javaFits ? '版本匹配' : `需要 ${requiredJava}` }}</i></strong></span><ArrowUpRight :size="13" /></button>
        <button @click="emit('settings')"><MemoryStick :size="17" /><span><small>分配内存</small><strong>{{ (snapshot.settings.memoryMb / 1024).toFixed(1) }} GB<i>共 {{ (runtime.totalMemoryMb / 1024).toFixed(0) }} GB</i></strong></span><ArrowUpRight :size="13" /></button>
        <button @click="emit('check')"><ShieldCheck :size="17" /><span><small>启动检查</small><strong :class="{ 'warning-text': needsCheck }">{{ !selected ? '未选择实例' : needsCheck ? launchIssues.length ? `${launchIssues.length} 项待处理` : '需要检查' : '基础检查通过' }}</strong></span><ArrowUpRight :size="13" /></button>
      </div>

      <section class="recent-worlds panel">
        <div class="panel-heading"><h3>我的游戏<span class="subtle-count">{{ snapshot.instances.length }}</span></h3><div class="heading-actions"><button class="icon-button small" aria-label="重新扫描实例" @click="emit('refresh')"><RefreshCw :size="14" :class="{spin:busy}" /></button><button class="text-button" @click="emit('instances')">管理全部<ArrowRight :size="14" /></button></div></div>
        <div v-if="loading" class="loading-inline"><LoaderCircle :size="18" class="spin" />正在扫描本地游戏…</div>
        <div v-else-if="!snapshot.instances.length" class="empty-instance"><Box :size="28" /><strong>还没有游戏实例</strong><p>安装 Minecraft 或导入已有游戏目录。</p><button class="text-button" @click="emit('create')"><Plus :size="14" />添加游戏</button></div>
        <button v-for="instance in snapshot.instances.slice(0,3)" :key="instance.id" :class="['instance-row', {selected:selected?.id === instance.id}]" @click="emit('select',instance)"><span :class="['instance-art',instance.kind]"><Server v-if="instance.kind === 'server'" :size="21" /><Box v-else :size="21" /></span><span class="instance-row-info"><strong>{{ instance.name }}</strong><small>{{ instance.minecraftVersion || '版本待识别' }}<span>·</span>{{ instance.loader || '本地目录' }}<span>·</span>{{ instance.stats.mods }} 个模组文件</small></span><span :class="['status-pill',instance.status,{live:running.has(instance.id)}]"><span></span>{{ label(instance) }}</span><Check v-if="selected?.id === instance.id" :size="15" class="selected-check" /><ArrowUpRight v-else :size="15" /></button>
      </section>

      <div class="tool-cards">
        <button @click="emit('diagnostics')"><Terminal :size="20" /><span><strong>日志诊断</strong><small>查看运行日志</small></span><ArrowUpRight :size="15" /></button>
        <button :disabled="!selected" @click="emit('backup')"><Layers3 :size="20" /><span><strong>存档备份</strong><small>备份当前实例的存档</small></span><ArrowUpRight :size="15" /></button>
        <button @click="emit('screenshots')"><Image :size="20" /><span><strong>游戏截图</strong><small>浏览本地截图</small></span><ArrowUpRight :size="15" /></button>
      </div>
    </div>

    <aside class="home-aside">
      <section class="player-card panel">
        <div class="player-heading"><span>账号与皮肤</span></div>
        <button class="player-identity" @click="emit('account')"><span class="player-avatar"><UserRound :size="23" /></span><span><strong>{{ name }}</strong><small><span :class="['status-dot',{amber:!accountVerified}]"></span>{{ accountLabel }}</small></span><ArrowUpRight :size="16" /></button>
        <SkinPreview :skin="account.profile?.skinDataUrl ?? (!account.profile ? account.localSkin : undefined)" :cape="accountVerified ? account.profile?.capeDataUrl : undefined" :model="account.profile?.model" />
        <div class="skin-note"><span class="signal-dot"></span>{{ accountSkinLabel }}</div>
        <button class="account-connect" @click="emit('account')"><UserRound :size="15" />{{ accountVerified ? '管理账号与皮肤' : account.busy ? '查看登录进度' : account.profile ? '恢复 Microsoft 登录' : '连接 Microsoft 账号' }}<ArrowRight :size="15" /></button>
      </section>
      <section class="ready-card startup-check" :class="{attention:needsCheck}">
        <div class="startup-heading"><TriangleAlert v-if="needsCheck" :size="18" /><ScanLine v-else :size="18" /><h3>启动检查</h3><span v-if="launchIssues.length">{{ launchIssues.length }} 项</span></div>
        <ul v-if="launchIssues.length" class="startup-issues"><li v-for="issue in launchIssues.slice(0, 2)" :key="issue">{{ issue }}</li></ul>
        <p v-else>{{ !selected ? '添加实例后可检查游戏文件与 Java 环境。' : selected.status === 'ready' ? '游戏基础文件与 Java 版本检查通过。' : '实例信息尚不完整，请查看环境检查。' }}</p>
        <button class="text-button" @click="selected ? emit('check') : emit('create')">{{ selected ? launchIssues.length > 2 ? '查看全部问题' : '查看环境检查' : '添加游戏' }}<ArrowUpRight :size="14" /></button>
      </section>
      <button class="create-world" @click="emit('create')"><span><Plus :size="20" /></span><div><strong>添加游戏</strong><small>安装 Minecraft 原版</small></div><ArrowRight :size="16" /></button>
    </aside>
  </div>
  </div>
</template>

<style scoped>
.launch-button-stop{justify-content:center}.launch-button-stop>svg{margin-left:0!important;display:block!important;flex-shrink:0}.launch-button-stop>span{display:block;text-align:center}
.overview-heading{min-height:38px;margin-bottom:22px}
.overview-title{display:flex;align-items:center;gap:15px;min-width:0}
.overview-heading h1{font-size:22px;letter-spacing:0;font-weight:600}
.overview-title>span{font-size:11px;color:#72899d;padding-left:15px;border-left:1px solid #ffffff10}
.instance-overview{position:relative;z-index:2;width:53%;height:100%;padding:26px 28px;display:flex;flex-direction:column;align-items:flex-start;pointer-events:none}
.overview-kind{display:flex;gap:8px;align-items:center;color:#9db9c2;font-size:11px}
.instance-overview h2.overview-version{font-size:46px;font-weight:650;line-height:1.15;letter-spacing:-1.2px;margin:13px 0 9px;color:#edf9f8;font-variant-numeric:tabular-nums}
.overview-loader{display:flex;gap:7px;align-items:center;max-width:100%;color:#9ac8c1;font-size:12px;line-height:1.6}
.overview-loader>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.overview-stats{display:flex;gap:0;margin:25px 0 0;width:100%;max-width:300px}
.overview-stats>div{flex:1;min-width:0}
.overview-stats>div+div{border-left:1px solid #91b8bf22;padding-left:25px}
.overview-stats dt{font-size:10px;color:#7f9da9;margin-bottom:7px}
.overview-stats dd{margin:0;font-size:27px;line-height:1;font-weight:600;color:#dbeded;font-variant-numeric:tabular-nums}
.overview-stats dd>span{font-size:10px;font-weight:400;color:#738f9c;margin-left:7px}
.overview-resources{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:16px;color:#6f919e;font-size:10px;white-space:nowrap}
.overview-resources>span{color:#42616f}
.overview-empty{justify-content:center}
.overview-empty h2{font-size:30px;letter-spacing:0;margin-top:18px}
.overview-empty p{font-size:11px;color:#89a2ae;line-height:1.8;margin-top:14px}
.overview-empty .text-button{margin-top:22px;pointer-events:auto;color:#a0e0ce}
.startup-heading{display:flex;align-items:center;gap:9px;margin-bottom:13px;color:#75afa2}
.startup-heading h3{margin:0;color:#c4d5df;font-size:12px}
.startup-heading>span{margin-left:auto;color:#a88e65;font-size:9px}
.attention .startup-heading>svg{color:#d0ac70}
.startup-issues{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:11px}
.startup-issues li{font-size:10px;line-height:1.8;color:#95a6b4;overflow-wrap:anywhere;padding-left:11px;position:relative}
.startup-issues li:before{content:'';position:absolute;left:0;top:7px;width:3px;height:3px;border-radius:50%;background:#bda16e}
@media(min-width:1500px){.instance-overview{padding:32px 34px}.instance-overview h2.overview-version{font-size:54px;margin-top:19px}.overview-stats{margin-top:30px}.overview-stats dd{font-size:32px}.overview-resources{padding-top:22px}}
@media(max-width:1190px){.instance-overview{width:55%;padding:23px 22px}.instance-overview h2.overview-version{font-size:39px}.overview-kind{font-size:10px}.overview-loader{font-size:10px}.overview-stats{margin-top:24px}.overview-stats>div+div{padding-left:18px}.overview-stats dd{font-size:25px}.overview-stats dt,.overview-resources{font-size:9px}.overview-heading h1{font-size:21px}.instance-row-info small{flex-wrap:wrap}}

/* Give vertical space to the game and skin first; keep every action in normal flow. */
.home-dashboard .overview-heading{margin-bottom:14px}
.home-dashboard .world-hero{height:clamp(196px,calc(100vh - 600px),330px)}
.home-dashboard .instance-overview{padding:20px 26px}
.home-dashboard .instance-overview h2.overview-version{font-size:clamp(36px,5vh,48px);margin:10px 0 6px}
.home-dashboard .overview-stats{margin-top:clamp(14px,2vh,22px)}
.home-dashboard .overview-stats dt{margin-bottom:5px}
.home-dashboard .overview-stats dd{font-size:25px}
.home-dashboard .overview-resources{padding-top:10px}
.home-dashboard .launch-dock{padding:10px 16px;min-height:70px}
.home-dashboard .runtime-strip{margin:10px 0 12px;padding:9px 0}
.home-dashboard .recent-worlds .panel-heading{padding:10px 17px;min-height:46px}
.home-dashboard .recent-worlds .instance-row{padding:9px 17px;min-height:56px}
.home-dashboard .recent-worlds .instance-art{width:34px;height:34px}
.home-dashboard .tool-cards{margin-top:12px}
.home-dashboard .tool-cards>button{padding:11px 12px;min-height:56px}
.home-dashboard .player-card{padding:16px 17px 13px}
.home-dashboard .player-identity{margin-top:14px}
.home-dashboard :deep(.skin-stage){height:clamp(174px,calc(100vh - 572px),265px)}
.home-dashboard .skin-note{margin:6px 0 12px}
.home-dashboard .ready-card{margin-top:12px;padding:14px 17px}
.home-dashboard .startup-heading{margin-bottom:8px}
.home-dashboard .ready-card .text-button{margin-top:9px}
.home-dashboard .create-world{padding:11px 4px;margin-top:3px}
.home-dashboard .overview-empty h2{font-size:26px;margin-top:10px}
.home-dashboard .overview-empty p{margin-top:8px;line-height:1.6}
.home-dashboard .overview-empty .text-button{margin-top:12px}
@media(max-height:820px){
  .home-dashboard .overview-heading{margin-bottom:10px}
  .home-dashboard .instance-overview{padding:17px 22px}
  .home-dashboard .overview-kind{font-size:10px}
  .home-dashboard .instance-overview h2.overview-version{font-size:36px;margin:8px 0 5px}
  .home-dashboard .overview-loader{font-size:11px}
  .home-dashboard .overview-stats{margin-top:13px}
  .home-dashboard .overview-stats dd{font-size:24px}
  .home-dashboard .launch-dock{min-height:66px;padding:8px 14px}
  .home-dashboard .launch-button{min-height:44px;padding-top:9px;padding-bottom:9px}
  .home-dashboard .runtime-strip{margin:8px 0 10px;padding:8px 0}
  .home-dashboard .runtime-strip small{margin-bottom:4px}
  .home-dashboard .recent-worlds .instance-row{padding-top:8px;padding-bottom:8px;min-height:53px}
  .home-dashboard .tool-cards{margin-top:10px}
  .home-dashboard .tool-cards>button{padding-top:9px;padding-bottom:9px;min-height:52px}
}
</style>
