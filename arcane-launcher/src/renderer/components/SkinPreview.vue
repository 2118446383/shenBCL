<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { SkinViewer, IdleAnimation, WalkingAnimation } from 'skinview3d'
import { LinearSRGBColorSpace } from 'three'
import { RotateCw, Footprints, Scan, UserRound } from 'lucide-vue-next'
const props = defineProps<{ skin?: string; cape?: string; model?: 'default' | 'slim'; large?: boolean }>()
const host = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const failed = ref(false)
const rotating = ref(false)
const walking = ref(false)
let viewer: SkinViewer | undefined
let observer: ResizeObserver | undefined
let visibility: IntersectionObserver | undefined
let visible = true
let disposed = false
let update = 0
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

function defaultSkin() {
  const skin = document.createElement('canvas'); skin.width = skin.height = 64
  const c = skin.getContext('2d')!
  const fill = (color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(x, y, w, h) }
  fill('#b9d5df', 0, 0, 32, 16)
  fill('#e5bfa5', 8, 10, 8, 6)
  fill('#e9eeee', 8, 8, 8, 2); fill('#e9eeee', 8, 10, 2, 1); fill('#879fb7', 15, 9, 1, 3)
  fill('#204055', 9, 12, 2, 1); fill('#204055', 13, 12, 2, 1)
  fill('#63f0d0', 10, 12, 1, 1); fill('#63f0d0', 13, 12, 1, 1); fill('#a87e70', 11, 15, 2, 1)
  fill('#172c3c', 16, 16, 24, 16)
  fill('#28465c', 20, 20, 8, 12); fill('#0e1d2b', 23, 20, 2, 12)
  fill('#50e4cd', 20, 21, 3, 2); fill('#50e4cd', 26, 21, 2, 2); fill('#b1f7e6', 23, 21, 1, 2)
  fill('#17222f', 0, 16, 16, 16); fill('#17222f', 16, 48, 16, 16)
  fill('#354c65', 4, 20, 4, 9); fill('#354c65', 20, 52, 4, 9)
  fill('#50e4cd', 4, 28, 4, 1); fill('#50e4cd', 20, 60, 4, 1)
  fill('#101b28', 0, 29, 16, 3); fill('#101b28', 16, 61, 16, 3)
  for (const [x, y] of [[40, 16], [32, 48]]) {
    fill('#28465c', x, y, 16, 16); fill('#172c3c', x + 8, y + 4, 4, 12)
    fill('#50e4cd', x, y + 11, 16, 2); fill('#e5bfa5', x, y + 13, 16, 3)
  }
  return skin
}
async function load() {
  const version = ++update
  const current = viewer
  if (!current) return
  try {
    await current.loadSkin(props.skin || defaultSkin(), { model: props.skin ? props.model ?? 'auto-detect' : 'default' })
    if (disposed || version !== update) return
    if (props.cape) await current.loadCape(props.cape)
    else current.loadCape(null)
    failed.value = false
    if (!document.hidden && visible) current.render()
  } catch {
    if (disposed || version !== update) return
    failed.value = true
  }
}
function reset() { if (viewer) { viewer.camera.position.set(20, 7, 55); viewer.controls.target.set(0, 0, 0); viewer.controls.update(); viewer.zoom = 0.82 } }
function rotate() { rotating.value = !rotating.value; if (viewer) viewer.autoRotate = rotating.value }
function walk() { walking.value = !walking.value; if (viewer) viewer.animation = walking.value ? new WalkingAnimation() : new IdleAnimation() }
function pause() { if (viewer) { viewer.renderPaused = document.hidden || !visible; if (!viewer.renderPaused) viewer.render() } }
watch(() => [props.skin, props.cape, props.model], load)
onMounted(() => {
  try {
    viewer = new SkinViewer({ canvas: canvas.value, width: 260, height: 280, zoom: 0.82, pixelRatio: Math.min(devicePixelRatio, 1.5) })
    // Use the public direct renderer so remounting does not depend on the FXAA compositor.
    const current = viewer
    current.renderer.outputColorSpace = LinearSRGBColorSpace
    current.render = () => { current.renderer.setRenderTarget(null); current.renderer.render(current.scene, current.camera) }
    viewer.controls.enablePan = false; viewer.controls.minDistance = 35; viewer.controls.maxDistance = 95
    viewer.globalLight.intensity = 2.2; viewer.cameraLight.intensity = 0.6
    viewer.animation = reduced ? null : new IdleAnimation()
    reset(); void load()
    observer = new ResizeObserver(([entry]) => { if (viewer && entry.contentRect.width > 0 && entry.contentRect.height > 0) { viewer.setSize(entry.contentRect.width, entry.contentRect.height); if (!document.hidden && visible) viewer.render() } })
    observer.observe(host.value!)
    visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; pause() })
    visibility.observe(host.value!)
    document.addEventListener('visibilitychange', pause)
  } catch { failed.value = true }
})
onUnmounted(() => { disposed = true; observer?.disconnect(); visibility?.disconnect(); document.removeEventListener('visibilitychange', pause); viewer?.composer.dispose(); viewer?.fxaaPass.material.dispose(); viewer?.dispose() })
</script>
<template>
  <div :class="['skin-preview', { large }]">
    <div class="skin-stage" ref="host">
      <span class="stage-cross top-left">+</span><span class="stage-cross bottom-right">+</span>
      <div class="skin-halo"></div><div class="skin-platform"></div>
      <canvas ref="canvas" aria-label="可拖动旋转、滚轮缩放的 Minecraft 3D 皮肤预览"></canvas>
      <div v-if="failed" class="skin-fallback"><UserRound :size="40" /><span>3D 预览暂不可用</span><small>请检查图形支持或重新加载皮肤</small></div>
    </div>
    <div class="skin-controls"><span>拖动旋转 · 滚轮缩放</span><button :class="{active:rotating}" @click="rotate" aria-label="自动旋转皮肤" :aria-pressed="rotating"><RotateCw :size="14" /></button><button :class="{active:walking}" @click="walk" aria-label="切换行走动作" :aria-pressed="walking"><Footprints :size="14" /></button><button @click="reset" aria-label="重置皮肤视角"><Scan :size="14" /></button></div>
  </div>
</template>
