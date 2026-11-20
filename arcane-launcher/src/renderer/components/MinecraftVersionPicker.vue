<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Check, ChevronDown, Search, X } from 'lucide-vue-next'
import type { CatalogMinecraftVersion } from '../../shared/contracts'

const props = defineProps<{ modelValue: string; versions: CatalogMinecraftVersion[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const search = ref<HTMLInputElement>()
const open = ref(false)
const query = ref('')
const type = ref<'release' | 'all'>('release')
const active = ref(-1)
const matches = computed(() => props.versions.filter(version =>
  (type.value === 'all' || version.type === 'release') && version.id.toLowerCase().includes(query.value.trim().toLowerCase())))

async function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    query.value = ''
    active.value = -1
    type.value = props.versions.find(version => version.id === props.modelValue)?.type === 'snapshot' ? 'all' : 'release'
    await nextTick()
    search.value?.focus()
  }
}
function choose(value: string) {
  emit('update:modelValue', value)
  open.value = false
  trigger.value?.focus()
}
function closeOutside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
function closeBlur(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) open.value = false
}
async function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); open.value = false; trigger.value?.focus(); return }
  if (event.target !== search.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = Math.max(-1, Math.min(matches.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
    await nextTick()
    root.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (active.value < 0 && !query.value.trim()) choose('')
    else if (matches.value[Math.max(0, active.value)]) choose(matches.value[Math.max(0, active.value)]!.id)
  }
}
onMounted(() => document.addEventListener('pointerdown', closeOutside))
onUnmounted(() => document.removeEventListener('pointerdown', closeOutside))
</script>

<template>
  <div ref="root" class="mc-picker" @focusout="closeBlur">
    <button ref="trigger" type="button" class="mc-picker-trigger" :disabled="disabled" :aria-expanded="open" aria-haspopup="dialog" aria-label="筛选 Minecraft 版本" @click="toggle">
      <span>{{ modelValue || '所有 MC 版本' }}</span><ChevronDown :size="13" />
    </button>
    <div v-if="open" class="mc-picker-panel" role="dialog" aria-label="选择 Minecraft 版本" @keydown="navigate">
      <div class="mc-picker-search"><Search :size="14" /><input ref="search" v-model="query" placeholder="搜索版本，如 1.20.1" aria-label="搜索完整 Minecraft 版本列表" @input="active = 0" /><button v-if="query" type="button" aria-label="清空版本搜索" @click="query = ''; active = -1; search?.focus()"><X :size="13" /></button></div>
      <div class="mc-picker-types"><button type="button" :class="{active:type === 'release'}" @click="type = 'release'; active = -1">正式版</button><button type="button" :class="{active:type === 'all'}" @click="type = 'all'; active = -1">含快照 / 历史版</button><span>{{ matches.length }}</span></div>
      <div class="mc-picker-list" role="listbox" aria-label="Minecraft 版本">
        <button type="button" role="option" :aria-selected="!modelValue" :data-active="active === -1" @click="choose('')"><span>所有 MC 版本</span><Check v-if="!modelValue" :size="13" /></button>
        <button v-for="(version,index) in matches" :key="version.id" type="button" role="option" :aria-selected="modelValue === version.id" :data-active="active === index" @click="choose(version.id)"><span>{{ version.id }}</span><small v-if="version.type !== 'release'">{{ version.type === 'snapshot' ? '快照' : '历史版' }}</small><Check v-if="modelValue === version.id" :size="13" /></button>
        <p v-if="!matches.length">{{ versions.length ? '没有匹配版本' : '版本列表尚未加载，可稍后重试' }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mc-picker{position:relative;width:165px;flex-shrink:0}.mc-picker-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:38px;padding:10px 12px;background:#101b25;border:1px solid #ffffff10;border-radius:7px;color:#a8c3d1;font-size:11px;text-align:left}.mc-picker-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-picker-trigger[aria-expanded=true]{border-color:#79dfc65c}.mc-picker-panel{position:absolute;right:0;top:calc(100% + 7px);width:290px;z-index:30;background:#14212c;border:1px solid #5a827052;border-radius:10px;box-shadow:0 14px 38px #0008;overflow:hidden}.mc-picker-search{display:flex;align-items:center;gap:8px;margin:10px;padding:9px;border:1px solid #ffffff14;border-radius:6px;color:#7396a5}.mc-picker-search input{width:100%;min-width:0;background:none;border:0;outline:0;color:#c7dce6;font-size:11px}.mc-picker-search>button{display:flex;color:#819aa5}.mc-picker-types{display:flex;align-items:center;gap:5px;padding:0 10px 9px;border-bottom:1px solid #ffffff0b}.mc-picker-types>button{font-size:10px;padding:6px 9px;color:#7e9aaa;border-radius:4px}.mc-picker-types>button.active{background:#78ddc415;color:#9be6d1}.mc-picker-types>span{margin-left:auto;font-size:10px;color:#607f92}.mc-picker-list{max-height:294px;overflow:auto;padding:5px;scrollbar-width:thin;scrollbar-color:#355465 transparent}.mc-picker-list>button{width:100%;padding:10px 11px;display:flex;align-items:center;gap:9px;text-align:left;border-radius:5px;color:#afc7d2;font-size:11px}.mc-picker-list>button:hover,.mc-picker-list>button[data-active=true]{background:#ffffff07}.mc-picker-list>button[aria-selected=true]{color:#90e9d0;background:#73e3bc10}.mc-picker-list>button>span{flex:1}.mc-picker-list small{font-size:9px;color:#748b98}.mc-picker-list>p{padding:15px;color:#7d97a5;font-size:11px;line-height:1.8}.mc-picker-trigger:focus-visible,.mc-picker-list>button:focus-visible{outline:2px solid #75dfc7;outline-offset:-2px}
</style>
