<script setup lang="ts">
import { Folder, LoaderCircle, ShieldAlert, Trash2, TriangleAlert } from 'lucide-vue-next'
import type { InstanceRemovalPreview } from '../../shared/contracts'

defineProps<{ name: string; preview?: InstanceRemovalPreview; preparing: boolean; confirming: boolean; error: string }>()
defineEmits<{ cancel: []; confirm: []; retry: [] }>()
</script>

<template>
  <div class="instance-delete">
    <div class="delete-heading"><span><Trash2 :size="23" /></span><div><h2>{{ preview?.action === 'remove' ? '移除游戏实例' : '删除客户端' }}</h2><p>{{ preview?.action === 'remove' ? '确认从游戏库中移除' : '确认删除这个客户端及其文件' }}</p></div></div>
    <div class="delete-instance"><strong>{{ preview?.name || name }}</strong><span>当前选择的游戏实例</span></div>
    <div v-if="preparing" class="delete-loading" role="status"><LoaderCircle :size="17" class="spin" />正在检查实例文件和运行状态…</div>
    <template v-else-if="preview">
      <p class="delete-description">{{ preview.warning }}</p>
      <div v-if="preview.action === 'delete'" class="delete-scope"><span>游戏版本与配置</span><span>模组与资源包</span><span>存档与截图</span></div>
      <div class="delete-location"><Folder :size="14" /><span :title="preview.path">{{ preview.path }}</span></div>
      <div v-if="preview.blocked" class="delete-blocked"><ShieldAlert :size="17" /><div><p>{{ preview.reason }}</p><button class="text-button" :disabled="confirming" @click="$emit('retry')">重新检查</button></div></div>
    </template>
    <p v-if="error" class="delete-error" role="alert"><TriangleAlert :size="15" /><span>{{ error }}</span></p>
    <div class="delete-actions"><button class="button button-subtle" :disabled="confirming" @click="$emit('cancel')">取消</button><button class="button delete-confirm" :disabled="preparing || confirming || !preview || preview.blocked || !!error" @click="$emit('confirm')"><LoaderCircle v-if="confirming" :size="15" class="spin" /><Trash2 v-else :size="15" />{{ confirming ? '正在处理…' : preview?.action === 'remove' ? '确认移除' : '确认删除' }}</button></div>
    <button v-if="error && !preparing" class="text-button delete-retry" :disabled="confirming" @click="$emit('retry')">重新检查实例</button>
  </div>
</template>

<style scoped>
.delete-heading{display:flex;align-items:center;gap:14px;margin-bottom:24px}.delete-heading>span{display:grid;place-items:center;width:48px;height:48px;border-radius:12px;color:#efa498;background:#da7b6d10;border:1px solid #da7b6d2b}.delete-heading h2{font-size:22px!important;font-weight:600!important;letter-spacing:0!important}.delete-heading p{font-size:11px;color:#8199a9;margin-top:5px}.delete-instance{padding:15px 16px;border:1px solid #ffffff0c;background:#0e1923;border-radius:8px;display:flex;flex-direction:column;gap:7px}.delete-instance>strong{color:#d4e4e9;font-size:14px;font-weight:550;overflow-wrap:anywhere}.delete-instance>span{font-size:10px;color:#6f889b}.delete-description{font-size:12px;line-height:1.9;color:#b0c2cd;margin:20px 0 14px}.delete-scope{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:17px}.delete-scope>span{font-size:10px;color:#bc9f97;background:#d78a7709;border:1px solid #d78a7718;border-radius:4px;padding:5px 8px}.delete-location{display:flex;align-items:flex-start;gap:8px;font-size:10px;line-height:1.7;color:#648397}.delete-location>svg{flex-shrink:0;margin-top:2px}.delete-location>span{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.delete-loading{display:flex;gap:10px;align-items:center;font-size:11px;color:#86aaa9;margin:24px 0}.delete-blocked{display:flex;gap:10px;padding:12px;background:#d2ab6a0b;border:1px solid #d2ab6a25;border-radius:7px;margin-top:18px;color:#c7ad81;font-size:11px;line-height:1.8}.delete-blocked>svg{flex-shrink:0;margin-top:2px}.delete-blocked .text-button{font-size:10px;margin-top:5px;color:#9ad9c8}.delete-actions{display:flex;justify-content:flex-end;gap:11px;margin-top:27px;padding-top:21px;border-top:1px solid #ffffff09}.delete-actions>.button{min-width:104px;font-size:12px}.delete-confirm{background:#db897b;color:#201c1c;border:1px solid #ecaa9a44}.delete-confirm:hover:not(:disabled){background:#eda18f}.delete-error{display:flex;align-items:flex-start;gap:8px;color:#d7a49b;font-size:11px;line-height:1.8;margin-top:17px}.delete-error>svg{flex-shrink:0;margin-top:2px}.delete-retry{display:flex;margin:13px 0 0 auto;font-size:10px;color:#8ac4b6}
</style>
