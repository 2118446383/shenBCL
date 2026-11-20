import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneInstallProgress, InstallProgressTracker } from '../arcane-launcher/src/main/services/install-progress';

const fresh = { vanilla: false, loader: false, files: false };

test('download counters count network transfers only while cached work retains its measured completion', () => {
  let time = 0;
  const tracker = new InstallProgressTracker('neoforge', fresh, () => time);
  tracker.update('vanilla-assets', { phasePercent: 90, downloadedBytes: 900_000, totalBytes: 1_000_000, completedFiles: 9, totalFiles: 10, transferredBytes: 0 });
  assert.equal(tracker.progress.transferredBytes, 0, 'satisfied cache bytes are not network traffic');
  assert.equal(tracker.progress.completedBytes, 900_000);
  assert.equal(tracker.progress.bytesPerSecond, undefined, 'do not invent a speed before a measurable time interval');
  time = 500;
  tracker.update('vanilla-assets', { phasePercent: 95, transferredBytes: 10_000 });
  assert.equal(tracker.progress.transferredBytes, 10_000);
  assert.equal(tracker.progress.bytesPerSecond, 20_000);
  time = 1000;
  tracker.update('vanilla-assets', { phasePercent: 96, transferredBytes: 12_000 });
  assert.equal(tracker.progress.transferredBytes, 12_000);
  assert.equal(tracker.progress.bytesPerSecond, 12_000);
  time = 5000; tracker.tick();
  assert.equal(tracker.progress.bytesPerSecond, 0, 'stalled or stopped transfers must not retain a stale speed');
});

test('independent stage counters aggregate real transfers, including retries, without using copied bytes', () => {
  const tracker = new InstallProgressTracker('neoforge', fresh);
  tracker.update('vanilla-client', { transferredBytes: 100, phasePercent: 100, totalFiles: 1, completedFiles: 1 });
  tracker.update('loader-installer', { transferredBytes: 25 }, 'loader');
  tracker.update('loader-libraries', { transferredBytes: 75 }, 'loader');
  tracker.update('pack-downloads', { transferredBytes: 10 }, 'pack');
  tracker.update('pack-downloads', { transferredBytes: 30 }, 'pack');
  tracker.update('pack-overrides', { transferredBytes: 30, downloadedBytes: 500_000, totalBytes: 500_000, phasePercent: 100 }, 'pack');
  assert.equal(tracker.progress.transferredBytes, 205);
  assert.equal(tracker.progress.completedBytes, 500_000);
  assert.equal(tracker.progress.completedFiles, undefined, 'step switches cannot show an unrelated previous file counter');
  assert.equal(tracker.progress.totalFiles, undefined);
});

test('unknown phases have no made-up percentage and frozen emitted snapshots remain independent', () => {
  const tracker = new InstallProgressTracker('vanilla', fresh);
  tracker.update('vanilla-metadata');
  const before = cloneInstallProgress(tracker.progress);
  assert.equal(before.steps.find(step => step.id === 'vanilla-metadata')?.percent, undefined);
  tracker.finishPrefix('vanilla-');
  assert.equal(before.steps.find(step => step.id === 'vanilla-metadata')?.status, 'running');
  assert.ok(tracker.progress.steps.filter(step => step.id.startsWith('loader-')).every(step => step.status === 'skipped'));
  tracker.update('pack-downloads', { phasePercent: Number.NaN });
  assert.equal(tracker.progress.steps.find(step => step.id === 'pack-downloads')?.percent, undefined);
  tracker.stop('cancelled');
  assert.equal(tracker.progress.steps.find(step => step.id === 'pack-downloads')?.status, 'cancelled');
  assert.equal(tracker.progress.bytesPerSecond, undefined);
});

test('restored verified boundaries yield complete or skipped steps and a fresh run clock', () => {
  const tracker = new InstallProgressTracker('neoforge', { vanilla: true, loader: true, files: false }, () => 100_000);
  assert.equal(tracker.progress.transferredBytes, 0);
  assert.equal(tracker.progress.elapsedMs, 0);
  assert.equal(tracker.progress.currentFile, undefined);
  assert.ok(tracker.progress.steps.filter(step => /^(vanilla|loader)-/.test(step.id)).every(step => step.status === 'complete'));
  assert.ok(tracker.progress.steps.filter(step => /^pack-/.test(step.id)).every(step => step.status === 'pending'));
  assert.ok(tracker.checklistPercent() < 100);
  tracker.update('verify'); tracker.stop('complete');
  assert.equal(tracker.checklistPercent(), 100);
});
