import type { ModpackJob, ModpackPreview, ModpackProgressStep } from './contracts';

const legacyPhases = [
  { id: 'vanilla', title: '游戏本体、运行库与资源' },
  { id: 'loader', title: '安装模组加载器' },
  { id: 'files', title: '模组下载与配置导入' },
  { id: 'complete', title: '检查客户端文件' },
];

/** Old saved jobs know only the broad phase; never invent a per-phase percentage for them. */
export function importProgressSteps(job?: ModpackJob, preview?: Pick<ModpackPreview, 'loader'>): ModpackProgressStep[] {
  if (job?.progress?.steps?.length) return job.progress.steps;
  if (!job) return legacyPhases.map(phase => ({ ...phase, status: phase.id === 'loader' && preview?.loader === 'vanilla' ? 'skipped' : 'pending' }));
  const current = legacyPhases.findIndex(phase => phase.id === job.phase);
  return legacyPhases.map((phase, index) => ({
    ...phase,
    status: job.status === 'complete' || index < current ? 'complete' : index > current ? 'pending' : job.status === 'running' ? 'running' : job.status === 'cancelled' ? 'cancelled' : 'error',
  }));
}

export function importOverallPercent(job?: ModpackJob): number {
  if (!job) return 0;
  if (job.status === 'complete') return 100;
  if (!Number.isFinite(job.completed) || !Number.isFinite(job.total) || job.total <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor(job.completed / job.total * 100)));
}

/** Counts refer to the backend's current stage, not the entire remaining installation. */
export function importRemainingFiles(job?: ModpackJob): number | undefined {
  const done = job?.progress?.completedFiles, total = job?.progress?.totalFiles;
  if (done === undefined || total === undefined || !Number.isSafeInteger(done) || !Number.isSafeInteger(total) || done < 0 || total < 0) return undefined;
  return Math.max(0, total - done);
}

export function importNetworkSpeed(job?: ModpackJob): number | undefined {
  const speed = job?.progress?.bytesPerSecond;
  return job?.status === 'running' && speed !== undefined && Number.isFinite(speed) && speed >= 0 ? speed : undefined;
}
