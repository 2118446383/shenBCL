<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Archive, Box } from 'lucide-vue-next'
import { catalogIconUrl } from '../../shared/catalog-icon'

const props = defineProps<{ url?: string; projectId: string; kind: 'mod' | 'modpack' }>()
const failed = ref(false)
const source = computed(() => catalogIconUrl(props.url, props.projectId))
watch(source, () => { failed.value = false })
</script>

<template>
  <span class="catalog-project-icon" aria-hidden="true">
    <img v-if="source && !failed" :src="source" alt="" loading="lazy" decoding="async" crossorigin="anonymous" referrerpolicy="no-referrer" draggable="false" @error="failed = true" />
    <Archive v-else-if="kind === 'modpack'" :size="23" />
    <Box v-else :size="23" />
  </span>
</template>

<style scoped>
.catalog-project-icon{display:grid;place-items:center;overflow:hidden;flex-shrink:0}
.catalog-project-icon img{display:block;width:100%;height:100%;object-fit:contain}
</style>
