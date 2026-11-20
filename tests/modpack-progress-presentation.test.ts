import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModpackJob } from '../arcane-launcher/src/shared/contracts';
import { importNetworkSpeed, importOverallPercent, importProgressSteps, importRemainingFiles } from '../arcane-launcher/src/shared/modpack-progress-presentation';

const job: ModpackJob = { id:'old-job', name:'Saved pack', status:'cancelled', phase:'files', message:'Cancelled', completed:68, total:100, minecraftVersion:'1.20.1', loader:'neoforge', updatedAt:'2026-11-16T00:00:00Z' };

test('saved jobs without telemetry remain resumable without invented percentages or transfer counts', () => {
  const steps = importProgressSteps(job);
  assert.deepEqual(steps.map(step => step.status), ['complete','complete','cancelled','pending']);
  assert.ok(steps.every(step => step.percent === undefined));
  assert.equal(importOverallPercent(job), 68);
  assert.equal(importNetworkSpeed(job), undefined);
  assert.equal(importRemainingFiles(job), undefined);
  assert.deepEqual(importProgressSteps().map(step => step.status), ['pending','pending','pending','pending']);
});

test('measured telemetry retains granular error stages, file counts and only live network speed', () => {
  const progress = {
    steps: [{ id:'game-assets', title:'游戏资源', status:'complete' as const, percent:100 }, { id:'pack-mods', title:'模组下载', status:'error' as const, percent:27 }],
    activeStep:'pack-mods', transferredBytes:1048576, bytesPerSecond:262144, completedFiles:3, totalFiles:11, elapsedMs:4000,
  };
  const running: ModpackJob = { ...job, status:'running', progress };
  assert.deepEqual(importProgressSteps(running), progress.steps);
  assert.equal(importRemainingFiles(running), 8);
  assert.equal(importNetworkSpeed(running), 262144);
  for (const status of ['cancelled','error','complete'] as const) assert.equal(importNetworkSpeed({ ...running, status }), undefined, `a stopped ${status} task must not display stale live speed`);
  assert.equal(importRemainingFiles({ ...running, progress:{ ...progress, totalFiles:undefined } }), undefined);
});

test('overall progress reaches 100 only on completed jobs and preview steps remain pending', () => {
  assert.equal(importOverallPercent({ ...job, status:'running', completed:99.999 }), 99);
  assert.equal(importOverallPercent({ ...job, status:'complete', completed:99.999 }), 100);
  assert.equal(importOverallPercent({ ...job, status:'running', total:0 }), 0);
  const pending = importProgressSteps(undefined, { loader:'vanilla' });
  assert.equal(pending[1].status, 'skipped');
  assert.ok(pending.every(step => step.percent === undefined));
});
