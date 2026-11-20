import type { ModpackProgress, ModpackProgressStep } from '../../shared/contracts';

export interface MeasuredInstallProgress {
  phasePercent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  completedFiles?: number;
  totalFiles?: number;
  transferredBytes?: number;
  currentFile?: string;
}

const STEP_TITLES: Array<[string, string]> = [
  ['vanilla-metadata', '游戏版本信息'], ['vanilla-client', 'Minecraft 游戏本体'],
  ['vanilla-libraries', '游戏依赖库'], ['vanilla-assets-index', '游戏资源索引'], ['vanilla-assets', '游戏资源文件'],
  ['loader-installer', 'NeoForge 安装器'], ['loader-materialize', '加载器配置'],
  ['loader-libraries', '加载器安装依赖'], ['loader-processors', '生成加载器文件'], ['loader-runtime-libraries', '加载器运行依赖'],
  ['pack-downloads', '模组与整合包文件'], ['pack-overrides', '整合包配置与附带文件'], ['verify', '校验客户端'],
];

const nonnegative = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? value : undefined;

/** Counts real completed work per step. Transfer sampling never includes reused or extracted bytes. */
export class InstallProgressTracker {
  private readonly startedAt: number;
  private readonly sources = new Map<string, number>();
  private readonly samples: Array<{ at: number; bytes: number }>;
  readonly progress: ModpackProgress;

  constructor(loader: string, stages: { vanilla: boolean; loader: boolean; files: boolean }, private readonly now = () => Date.now(), complete = false) {
    this.startedAt = now();
    this.samples = [{ at: this.startedAt, bytes: 0 }];
    this.progress = { steps: STEP_TITLES.map(([id, title]) => {
      const skipped = id.startsWith('loader-') && loader === 'vanilla';
      const done = complete || (id.startsWith('vanilla-') && stages.vanilla) || (id.startsWith('loader-') && stages.loader) || (id.startsWith('pack-') && stages.files);
      return { id, title, status: skipped ? 'skipped' : done ? 'complete' : 'pending', ...(done && !skipped ? { percent: 100 } : {}) };
    }), transferredBytes: 0, elapsedMs: 0 };
  }

  update(id: string, measurement: MeasuredInstallProgress = {}, transferSource = id): void {
    const step = this.progress.steps.find(item => item.id === id);
    if (!step || step.status === 'skipped') return;
    if (this.progress.activeStep !== id) {
      this.progress.completedFiles = undefined; this.progress.totalFiles = undefined;
      this.progress.completedBytes = undefined; this.progress.totalBytes = undefined;
      this.progress.currentFile = undefined;
    }
    this.progress.activeStep = id;
    step.status = 'running';
    const percent = nonnegative(measurement.phasePercent);
    step.percent = percent === undefined ? undefined : Math.min(100, percent);
    if (step.percent === 100) step.status = 'complete';
    step.completedFiles = this.progress.completedFiles = nonnegative(measurement.completedFiles);
    step.totalFiles = this.progress.totalFiles = nonnegative(measurement.totalFiles);
    step.completedBytes = this.progress.completedBytes = nonnegative(measurement.downloadedBytes);
    step.totalBytes = this.progress.totalBytes = nonnegative(measurement.totalBytes);
    this.progress.currentFile = measurement.currentFile?.slice(0, 1024);
    const received = nonnegative(measurement.transferredBytes);
    if (received !== undefined) {
      const previous = this.sources.get(transferSource) ?? 0;
      // A source counter is cumulative; a reset is a new runtime batch, not negative traffic.
      const delta = received >= previous ? received - previous : received;
      this.progress.transferredBytes += delta;
      this.sources.set(transferSource, received);
      if (delta > 0) {
        const at = this.now();
        const last = this.samples[this.samples.length - 1];
        const sample = { at, bytes: this.progress.transferredBytes };
        if (this.samples.length > 1 && at - last.at < 100) this.samples[this.samples.length - 1] = sample;
        else this.samples.push(sample);
      }
    }
    this.tick();
  }

  finishPrefix(prefix: string): void {
    for (const step of this.progress.steps) if (step.id.startsWith(prefix) && step.status !== 'skipped') { step.status = 'complete'; step.percent = 100; }
    this.tick();
  }

  stop(status: 'error' | 'cancelled' | 'complete'): void {
    if (status === 'complete') {
      for (const step of this.progress.steps) if (step.status !== 'skipped') { step.status = 'complete'; step.percent = 100; }
    }
    else {
      const active = this.progress.steps.find(step => step.id === this.progress.activeStep);
      if (active) active.status = status;
    }
    this.tick(); this.progress.bytesPerSecond = undefined; this.progress.currentFile = undefined;
  }

  /** Old completed/total fields now describe completed checklist steps, not guessed download weight. */
  checklistPercent(): number {
    const steps = this.progress.steps.filter(step => step.status !== 'skipped');
    return Math.round(100 * steps.filter(step => step.status === 'complete').length / Math.max(1, steps.length));
  }

  tick(): void {
    const now = this.now();
    this.progress.elapsedMs = Math.max(0, now - this.startedAt);
    while (this.samples.length > 1 && this.samples[1].at <= now - 3000) this.samples.shift();
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    this.progress.bytesPerSecond = now - last.at >= 3000 ? 0 : now - first.at >= 200
      ? Math.max(0, (this.progress.transferredBytes - first.bytes) * 1000 / (now - first.at)) : undefined;
  }
}

export function cloneInstallProgress(progress: ModpackProgress): ModpackProgress {
  return { ...progress, steps: progress.steps.map(step => ({ ...step })) };
}
