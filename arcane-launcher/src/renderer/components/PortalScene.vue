<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import * as T from 'three'
import obsidianUrl from '../assets/minecraft/obsidian.png'
import portalUrl from '../assets/minecraft/nether_portal.png'

const host = ref<HTMLDivElement>()
const failed = ref(false)
let renderer: T.WebGLRenderer | undefined
let observer: ResizeObserver | undefined
let intersection: IntersectionObserver | undefined
let frame = 0
let visible = true
let disposed = false
let draw: (() => void) | undefined
let resume: (() => void) | undefined
const geometries = new Set<T.BufferGeometry>()
const materials = new Set<T.Material>()
const textures = new Set<T.Texture>()

function pixelTexture(kind: 'grass' | 'side' | 'dirt' | 'stone') {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 16
  const context = canvas.getContext('2d')!
  const dirt = ['#76533b', '#6c4b36', '#896247', '#593f30', '#7d5940']
  const grass = ['#658847', '#6b8d4b', '#597b3d', '#73934e', '#5e8041']
  const stone = ['#747570', '#686b65', '#80817a', '#60645f', '#777a71']
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const seed = ((x * 37 + y * 71 + x * y * 13) ^ (x * 11 + y * 23)) >>> 0
    const palette = kind === 'grass' || (kind === 'side' && (y < 3 || (y < 5 && seed % 4 === 0))) ? grass : kind === 'stone' ? stone : dirt
    context.fillStyle = palette[seed % palette.length]
    context.fillRect(x, y, 1, 1)
  }
  const texture = new T.CanvasTexture(canvas)
  texture.magFilter = texture.minFilter = T.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = T.SRGBColorSpace
  textures.add(texture)
  return texture
}

onMounted(() => {
  try {
    renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = T.SRGBColorSpace
    renderer.toneMapping = T.NoToneMapping
    host.value!.append(renderer.domElement)
    const scene = new T.Scene()
    const camera = new T.PerspectiveCamera(35, 1, 0.1, 100)
    camera.position.set(10.2, 8.1, 17.8)
    camera.lookAt(0, 1.45, 0)
    scene.add(new T.HemisphereLight(0xe1e6ef, 0x45474f, 1.35))
    const sunlight = new T.DirectionalLight(0xffefd8, 1.65)
    sunlight.position.set(-5, 11, 8)
    scene.add(sunlight)
    const rim = new T.DirectionalLight(0xb6bdf0, 0.5)
    rim.position.set(3, 5, -6)
    scene.add(rim)
    const world = new T.Group()
    world.rotation.y = -0.08
    scene.add(world)
    const block = new T.BoxGeometry(1, 1, 1)
    geometries.add(block)
    const material = (map: T.Texture, color = 0xffffff) => {
      const value = new T.MeshLambertMaterial({ map, color })
      materials.add(value)
      return value
    }
    const dirt = material(pixelTexture('dirt'))
    const stone = material(pixelTexture('stone'))
    const grassTop = material(pixelTexture('grass'))
    const grassSide = material(pixelTexture('side'))
    const grassBlock = [grassSide, grassSide, grassTop, dirt, grassSide, grassSide]
    const cube = (x: number, y: number, z: number, surface: T.Material | T.Material[]) => {
      const mesh = new T.Mesh(block, surface)
      mesh.position.set(x, y, z)
      world.add(mesh)
      return mesh
    }
    // Normal grass, dirt and stone preserve the floating-island composition.
    for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) {
      if ((Math.abs(x) === 3 && Math.abs(z) === 2) || (x === -3 && z === 1)) continue
      cube(x, -0.5, z, grassBlock)
      const depth = 1 + Math.max(0, 2 - Math.floor(Math.sqrt(x * x + z * z))) + ((x * 7 + z * 3) & 1)
      for (let layer = 1; layer <= depth; layer++) cube(x, -0.5 - layer, z, layer === 1 && Math.abs(x) + Math.abs(z) < 4 ? dirt : stone)
    }
    draw = () => {
      if (!disposed && renderer && !document.hidden && visible) renderer.render(scene, camera)
    }
    const loader = new T.TextureLoader()
    const configureTexture = (texture: T.Texture) => {
      texture.magFilter = texture.minFilter = T.NearestFilter
      texture.generateMipmaps = false
      texture.colorSpace = T.SRGBColorSpace
      textures.add(texture)
      return texture
    }
    const textureError = () => { if (!disposed) failed.value = true }
    const obsidian = configureTexture(loader.load(obsidianUrl, () => draw?.(), undefined, textureError))
    const obsidianMaterial = material(obsidian)
    // Vanilla minimum: a full four-by-five obsidian frame with a two-by-three opening.
    for (let row = 0; row < 5; row++) for (let column = 0; column < 4; column++) {
      if (row === 0 || row === 4 || column === 0 || column === 3) cube(column - 1.5, row + 0.5, -0.35, obsidianMaterial)
    }
    let frameCount = 32
    const portalTexture = configureTexture(loader.load(portalUrl, texture => {
      if (disposed) return
      const image = texture.image as HTMLImageElement
      frameCount = Math.max(1, Math.floor(image.height / image.width))
      portalMaterial.uniforms.frameCount.value = frameCount
      draw?.()
    }, undefined, textureError))
    portalTexture.flipY = false
    const portalMaterial = new T.ShaderMaterial({
      uniforms: { sheet: { value: portalTexture }, frameIndex: { value: 0 }, frameCount: { value: frameCount } },
      transparent: true, depthWrite: false, side: T.DoubleSide,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D sheet;
        uniform float frameIndex;
        uniform float frameCount;
        varying vec2 vUv;
        void main() {
          vec2 blockUv = fract(vUv * vec2(2.0, 3.0));
          blockUv.y = 1.0 - blockUv.y;
          vec2 sheetUv = vec2(blockUv.x, (frameIndex + blockUv.y) / frameCount);
          gl_FragColor = texture2D(sheet, sheetUv);
          gl_FragColor.a *= 0.88;
          #include <colorspace_fragment>
        }
      `,
    })
    materials.add(portalMaterial)
    const openingGeometry = new T.PlaneGeometry(2, 3)
    geometries.add(openingGeometry)
    const portal = new T.Mesh(openingGeometry, portalMaterial)
    portal.position.set(0, 2.5, -0.22)
    world.add(portal)
    const portalLight = new T.PointLight(0x9d40ff, 3.3, 7, 2)
    portalLight.position.set(0, 2.1, 0.7)
    world.add(portalLight)
    const particleCount = 28
    const positions = new Float32Array(particleCount * 3)
    const particleGeometry = new T.BufferGeometry()
    geometries.add(particleGeometry)
    const positionAttribute = new T.BufferAttribute(positions, 3)
    positionAttribute.setUsage(T.DynamicDrawUsage)
    particleGeometry.setAttribute('position', positionAttribute)
    const particleMaterial = new T.PointsMaterial({ color: 0xc67bff, size: 0.065, transparent: true, opacity: 0.68, depthWrite: false })
    materials.add(particleMaterial)
    world.add(new T.Points(particleGeometry, particleMaterial))
    const moveParticles = (seconds: number) => {
      for (let index = 0; index < particleCount; index++) {
        const seed = index * 2.39996
        const life = (seconds * (0.12 + (index % 4) * 0.02) + index * 0.137) % 1
        const direction = index % 2 === 0 ? -1 : 1
        positions[index * 3] = Math.sin(seed) * 1.1 + direction * life * 1.9
        positions[index * 3 + 1] = 1.05 + ((index * 0.419) % 3) + Math.sin(life * Math.PI) * 0.4
        positions[index * 3 + 2] = -0.1 + Math.cos(seed) * 0.25 + life * 1.1
      }
      positionAttribute.needsUpdate = true
    }
    moveParticles(0)
    const resize = () => {
      if (!host.value || !renderer || disposed) return
      const { width, height } = host.value.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      draw?.()
    }
    observer = new ResizeObserver(resize)
    observer.observe(host.value!)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let last = -Infinity
    const start = performance.now()
    const render = (now: number) => {
      frame = 0
      if (disposed || document.hidden || !visible) return
      if (now - last >= 50) {
        last = now
        const seconds = (now - start) / 1000
        // The original sprite advances every game tick (50 ms), without interpolation.
        portalMaterial.uniforms.frameIndex.value = Math.floor(seconds * 20) % frameCount
        moveParticles(seconds)
        draw?.()
      }
      frame = requestAnimationFrame(render)
    }
    resume = () => {
      if (disposed || !visible || document.hidden) {
        cancelAnimationFrame(frame)
        frame = 0
        return
      }
      if (reduced) draw?.()
      else if (!frame) frame = requestAnimationFrame(render)
    }
    document.addEventListener('visibilitychange', resume)
    intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; resume?.() })
    intersection.observe(host.value!)
    resize()
    resume()
  } catch {
    failed.value = true
  }
})

onUnmounted(() => {
  disposed = true
  cancelAnimationFrame(frame)
  observer?.disconnect()
  intersection?.disconnect()
  if (resume) document.removeEventListener('visibilitychange', resume)
  geometries.forEach(geometry => geometry.dispose())
  materials.forEach(material => material.dispose())
  textures.forEach(texture => texture.dispose())
  renderer?.dispose()
  renderer?.forceContextLoss()
  renderer?.domElement.remove()
})
</script>

<template>
  <div class="portal-scene" ref="host" aria-hidden="true">
    <div v-if="failed" class="portal-fallback">
      <span v-for="cell in 20" :key="cell" :class="{ 'portal-fallback-opening': cell > 4 && cell < 17 && cell % 4 !== 0 && cell % 4 !== 1 }"></span>
    </div>
  </div>
</template>

<style scoped>
.portal-fallback{position:absolute;inset:50% auto auto 50%;width:128px;height:160px;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(5,1fr);transform:translate(-50%,-50%) perspective(400px) rotateY(-18deg);border:0;box-shadow:8px 5px 0 #130f1b;background:none}
.portal-fallback>span{background:#211829 url('../assets/minecraft/obsidian.png') center/100% 100%;image-rendering:pixelated}
.portal-fallback>.portal-fallback-opening{background:#7b22b5 url('../assets/minecraft/nether_portal.png') 0 0/100% 3200%;animation:vanilla-portal-frames 1.6s steps(32) infinite;box-shadow:0 0 16px #ac37df33}
@keyframes vanilla-portal-frames{to{background-position:0 103.225806%}}
@media(prefers-reduced-motion:reduce){.portal-fallback>.portal-fallback-opening{animation:none}}
</style>
