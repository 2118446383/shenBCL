<template>
  <div class="portal-scene" aria-hidden="true">
    <div class="reactor-glow"></div>
    <div class="reactor">
      <div class="reactor-orbit"></div>
      <div class="reactor-ring"></div>
      <div class="reactor-core"></div>
    </div>
  </div>
</template>

<style scoped>
.portal-scene{display:grid;place-items:center;pointer-events:none;overflow:hidden}
.reactor-glow{position:absolute;width:100%;height:100%;background:radial-gradient(ellipse at 54% 48%,#8d66f42c,transparent 57%)}
.reactor{position:relative;width:min(52%,220px);aspect-ratio:1;transform:rotateX(22deg) rotateY(-23deg) rotateZ(-22deg);transform-style:preserve-3d}
.reactor-orbit,.reactor-ring,.reactor-core{position:absolute;border-radius:50%}
.reactor-orbit{inset:-10%;border:1px solid #8568d881;box-shadow:inset 0 0 22px #967bf012,0 0 34px #8663ca49}
.reactor-ring{inset:2%;background:conic-gradient(#a58aedcc 0 13%,transparent 13% 16%,#465487 16% 47%,transparent 47% 49%,#7462b6 49% 75%,transparent 75% 77%,#526996 77%);mask:radial-gradient(transparent 58%,#000 59% 69%,transparent 70%);animation:rotate-ring 32s linear infinite}
.reactor-core{inset:20%;border:1px solid #c4a8ff4d;background:radial-gradient(circle at 38% 40%,#f0e9ff 0%,#b896f1 7%,#735eab 20%,#413371 38%,#151230 72%);box-shadow:0 0 38px #a579f861,inset 0 0 24px #a88af357}
@keyframes rotate-ring{to{transform:rotate(1turn)}}
@media(prefers-reduced-motion:reduce){.reactor-ring{animation:none}}
</style>
