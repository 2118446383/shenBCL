<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowUpRight, Check, Copy, FolderOpen, KeyRound, LoaderCircle, LogOut, RefreshCw, ShieldCheck, TriangleAlert, UserRound } from 'lucide-vue-next'
import type { AccountState } from '../../shared/contracts'
import { accountPresentation } from '../../shared/account-presentation'

const SkinPreview = defineAsyncComponent(() => import('./SkinPreview.vue'))
const api = window.arcane
const props = defineProps<{ account: AccountState; playerName: string }>()
const emit = defineEmits<{ update: [state: AccountState]; notify: [text: string, error?: boolean] }>()
const clientId = ref(props.account.clientId)
const working = ref(false)
const openingLogin = ref(false)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval>
const remaining = computed(() => Math.max(0, Math.ceil(((props.account.device?.expiresAt ?? now.value) - now.value) / 1000)))
const expiry = computed(() => `${Math.floor(remaining.value / 60)}:${String(remaining.value % 60).padStart(2, '0')}`)
const identity = computed(() => accountPresentation(props.account))
const connected = computed(() => identity.value.verified)
const needsLogin = computed(() => props.account.status === 'reauthentication-required')
const waitingForBrowser = computed(() => !props.account.stage || props.account.stage === '等待 Microsoft 授权')
const statusLabel = computed(() => identity.value.label)
const profileSummary = computed(() => identity.value.description)
const skinLabel = computed(() => props.account.profile
  ? props.account.profile.skinDataUrl ? connected.value ? '账号皮肤预览' : '缓存皮肤预览' : '皮肤未获取 · 默认角色'
  : props.account.localSkin ? '本地皮肤预览' : '默认角色皮肤')

watch(() => props.account.clientId, value => { clientId.value = value })
async function act(operation: () => Promise<AccountState | null>) {
  if (!window.arcane) return emit('notify', '请打开桌面版使用账号功能。', true)
  if (working.value) return
  working.value = true
  try { const next = await operation(); if (next) emit('update', next) }
  catch (error) { emit('notify', error instanceof Error ? error.message : String(error), true) }
  finally { working.value = false }
}
async function login() { await act(() => api!.beginMicrosoftLogin()) }
async function openLogin() {
  if (openingLogin.value || !props.account.device || !remaining.value) return
  if (!window.arcane) return emit('notify', '请打开桌面版使用账号功能。', true)
  const code = props.account.device.code
  openingLogin.value = true
  let copied = false
  try {
    try { await navigator.clipboard.writeText(code); copied = true }
    catch { /* The visible code remains available for manual entry. */ }
    if (props.account.device?.code !== code || !remaining.value) return
    await window.arcane.openMicrosoftLogin()
    emit('notify', copied ? '登录代码已复制，请在微软网页粘贴并授权。' : '请在微软网页手动输入界面上显示的登录代码。')
  } catch (error) { emit('notify', error instanceof Error ? error.message : String(error), true) }
  finally { openingLogin.value = false }
}
async function copyCode() {
  if (!props.account.device || !remaining.value) return
  try { await navigator.clipboard.writeText(props.account.device.code); emit('notify', '登录代码已复制。') }
  catch { emit('notify', '无法复制，请手动输入代码。', true) }
}
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="account-dialog">
    <div class="account-display">
      <h2>皮肤预览</h2>
      <SkinPreview large :skin="account.profile?.skinDataUrl ?? (!account.profile ? account.localSkin : undefined)" :cape="account.profile?.capeDataUrl" :model="account.profile?.model" />
      <strong>{{ account.profile?.name ?? playerName }}</strong>
      <span>{{ skinLabel }}</span>
      <div class="account-display-status" :class="{ verified: connected }"><span :class="['status-dot', { amber: !connected }]"></span>{{ statusLabel }}</div>
    </div>

    <div class="account-details">
      <h2>登录身份</h2>
      <p class="modal-description">正版账号与离线身份会自动识别，皮肤预览随当前角色同步。</p>

      <template v-if="account.device">
        <div v-if="waitingForBrowser" class="login-instructions"><span class="step-number">01</span><p>打开微软官方页面，输入登录代码。</p></div>
        <button v-if="waitingForBrowser" class="device-code" :disabled="!remaining" @click="copyCode" aria-label="复制微软登录代码">{{ account.device.code }}<Copy :size="17" /></button>
        <div class="account-progress" role="status"><LoaderCircle :size="15" class="spin" /><span>{{ account.stage || '等待 Microsoft 授权' }}</span></div>
        <div v-if="waitingForBrowser" class="device-expiry">代码有效期<span>{{ expiry }}</span></div>
        <button v-if="waitingForBrowser" class="button button-primary full-width" :disabled="!remaining || openingLogin" @click="openLogin">复制代码并打开 Microsoft 登录<ArrowUpRight :size="16" /></button>
        <p class="account-privacy"><ShieldCheck :size="14" />请核对微软页面中的应用名称。密码仅在微软官网填写。</p>
        <button class="text-button" :disabled="working || account.stage === '保存加密凭据'" @click="act(() => api!.cancelMicrosoftLogin())">取消登录</button>
      </template>

      <template v-else-if="account.profile">
        <div class="connected-account" :class="{ 'cached-account': !connected }">
          <ShieldCheck v-if="connected" :size="22" /><TriangleAlert v-else :size="22" />
          <div><strong>{{ account.profile.name }}</strong><span>{{ statusLabel }}</span></div>
          <Check v-if="connected" :size="17" />
        </div>
        <p class="account-summary">{{ profileSummary }}</p>
        <div v-if="account.busy" class="account-progress" role="status"><LoaderCircle :size="15" class="spin" /><span>{{ account.stage || '正在验证登录状态' }}</span></div>
        <label class="field-label">游戏角色 UUID<code class="profile-uuid">{{ account.profile.id }}</code></label>
        <dl class="account-appearance">
          <div><dt>皮肤模型</dt><dd>{{ account.profile.model === 'slim' ? '纤细手臂' : '标准手臂' }}</dd></div>
          <div><dt>皮肤</dt><dd>{{ account.profile.skinDataUrl ? '已载入' : '未获取，使用默认角色' }}</dd></div>
          <div><dt>披风</dt><dd>{{ account.profile.capeDataUrl ? '已载入' : '未设置或未获取' }}</dd></div>
        </dl>
        <button v-if="!needsLogin" class="button button-primary full-width" :disabled="account.busy || working" @click="act(() => api!.refreshAccount())"><RefreshCw :size="16" :class="{ spin: account.busy }" />{{ connected ? '刷新账号与皮肤' : '重试在线验证' }}</button>
        <button v-if="!connected" class="button full-width" :class="needsLogin ? 'button-primary' : 'button-subtle reconnect-button'" :disabled="!account.configured || account.busy || working" @click="login"><UserRound :size="16" />重新连接 Microsoft 账号</button>
        <button class="text-button logout-button" :disabled="account.busy || working" @click="act(() => api!.logoutAccount())"><LogOut :size="14" />退出此账号</button>
      </template>

      <template v-else>
        <div class="offline-account"><UserRound :size="20" /><div><strong>{{ playerName }}</strong><span>离线账号</span></div></div>
        <p class="account-summary">{{ profileSummary }}</p>
        <div class="account-login-intro"><span class="microsoft-logo"><i></i><i></i><i></i><i></i></span><div><strong>Microsoft 正版账号</strong><p>使用拥有 Minecraft Java 版的账号登录。</p></div></div>
        <button class="button button-primary full-width" :disabled="!account.configured || account.busy || working" @click="login"><LoaderCircle v-if="account.busy || working" :size="16" class="spin" /><UserRound v-else :size="17" />{{ account.busy ? account.stage || '正在连接…' : '连接 Microsoft 账号' }}<ArrowUpRight :size="16" /></button>
        <p v-if="!account.configured" class="configuration-notice">此构建尚未完成微软应用接入，请联系发布者。普通玩家无需注册应用或填写应用标识。</p>
        <p class="account-privacy"><ShieldCheck :size="14" />登录凭据由 Windows 加密保存在本机。</p>
      </template>

      <div v-if="account.notice" class="account-notice" role="status">{{ account.notice }}</div>
      <div v-if="!account.profile && !account.device" class="local-skin-section">
        <h3>本地皮肤预览</h3>
        <p>导入 PNG 查看 3D 效果；仅用于启动器预览，不修改游戏内或微软账号的皮肤。</p>
        <button class="button button-subtle" :disabled="working || account.busy" @click="act(() => api!.importPreviewSkin())"><FolderOpen :size="15" />导入本地皮肤</button>
      </div>
      <details v-if="!account.profile && !account.device" class="account-configuration">
        <summary><KeyRound :size="13" />开发者接入设置</summary>
        <p>由启动器发布者配置。正式构建应内置 shenBCL 自己获准接入的公共应用身份，普通玩家无需填写此项。</p>
        <label class="field-label">Microsoft 应用 Client ID<input class="field-input" v-model="clientId" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label>
        <p>应用须支持个人 Microsoft 账号和设备代码流，并具备所需服务接入资格。此处不接受 Client Secret。</p>
        <button class="button button-subtle" :disabled="account.busy || working || !clientId.trim()" @click="act(() => api!.configureAccount(clientId.trim()))">保存开发配置</button>
      </details>
    </div>
  </div>
</template>

<style scoped>
.account-display>h2{font-size:17px;font-weight:600;margin-top:6px;letter-spacing:0;color:#b8d0d9}
.account-display>span{display:block;font-size:10px;color:#64889b;margin-top:8px}
.account-display-status{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:17px;font-size:10px;color:#a89a7b;line-height:1.8}
.account-display-status.verified{color:#7fbda8}
.account-summary{font-size:11px;color:#7f98aa;line-height:1.8;margin-bottom:16px}
.offline-account{display:flex;align-items:center;gap:12px;border:1px solid #7899af24;border-radius:8px;padding:14px;margin-bottom:13px;color:#7899af;background:#7899af07}.offline-account>div{display:flex;flex-direction:column;gap:5px}.offline-account strong{font-size:12px;color:#c1d2dd}.offline-account span{font-size:10px;color:#91a1b2}
.cached-account{background:#b79b6508;border-color:#c9ac7130;color:#c7a978}
.cached-account strong{color:#d2cfbe}
.cached-account span{color:#a79b80}
.account-progress{display:flex;align-items:center;gap:9px;border:1px solid #68d6bb1c;background:#65cdb708;border-radius:6px;padding:12px;margin:14px 0;color:#8fbdae;font-size:11px;line-height:1.7}
.account-appearance{margin:0 0 20px;display:flex;flex-direction:column;gap:11px}
.account-appearance>div{display:flex;justify-content:space-between;gap:15px;font-size:10px}
.account-appearance dt{color:#6c8a9b}
.account-appearance dd{margin:0;color:#9fb5c2;text-align:right}
.reconnect-button{margin-top:10px}
.device-expiry{margin-top:10px}
</style>
