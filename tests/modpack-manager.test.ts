import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ModpackJob } from '../arcane-launcher/src/shared/contracts';
import { INSTALLATION_MARKER } from '../arcane-launcher/src/main/services/installer';
import { ModpackError, type ModpackAnalysis, type ModpackFileProgress } from '../arcane-launcher/src/main/services/modpack';
import { MODPACK_MARKER, ModpackInstallManager, type ModpackManagerDependencies } from '../arcane-launcher/src/main/services/modpack-manager';

async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shenbcl-modpack-manager-test-')));
  try { await run(directory); }
  finally {
    const relative = path.relative(await realpath(os.tmpdir()), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('shenbcl-modpack-manager-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}
async function fixture(directory: string) {
  const archivePath = path.join(directory, 'pack.zip'); await writeFile(archivePath, 'test archive');
  const instancesRoot = path.join(directory, 'instances'); const jobsRoot = path.join(directory, 'jobs');
  const calls = { vanilla: 0, loader: 0, files: 0, resume: false };
  const analysis = async (): Promise<ModpackAnalysis> => {
    const info = await stat(archivePath);
    return { format: 'modrinth', name: '测试包', versionId: '3.3.6', summary: '', minecraftVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.262', requiredJavaMajor: 21, fileCount: 1, downloadBytes: 10, overrideCount: 0, overrideBytes: 0, modCount: 1, warnings: [], files: [], archiveFingerprint: { size: info.size, mtimeMs: info.mtimeMs } };
  };
  const dependencies: ModpackManagerDependencies = {
    analyzeModpack: analysis,
    installVanilla: async options => {
      calls.vanilla++; calls.resume = !!options.resume;
      if (!options.resume) await mkdir(options.destination);
      await writeFile(path.join(options.destination, INSTALLATION_MARKER), JSON.stringify({ schemaVersion: 1, versionId: options.versionId, state: 'complete' }));
      options.onProgress?.({ destination: options.destination, versionId: options.versionId!, phase: 'complete', percent: 100, message: 'base complete' });
      return { destination: options.destination, versionId: options.versionId!, requiredJavaMajor: 21, libraryCount: 1, assetCount: 1, installedAt: new Date().toISOString() };
    },
    installNeoForge: async options => {
      calls.loader++;
      return { versionId: `${options.minecraftVersion}-neoforge-${options.loaderVersion}`, loader: 'NeoForge', loaderVersion: options.loaderVersion };
    },
    installModpackFiles: async () => { calls.files++; return { downloadedFiles: 1, reusedFiles: 0, overrideFiles: 0 }; },
    validateInstance: async () => [],
  };
  const options = { instancesRoot, jobsRoot, findJava: async (major: number) => major === 21 ? 'C:/trusted/java.exe' : undefined };
  return { archivePath, instancesRoot, jobsRoot, dependencies, options, calls, analysis };
}

test('public previews hide paths and completed jobs retain a final client version across restart', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); const updates: ModpackJob[] = [];
    const manager = new ModpackInstallManager({ ...item.options, onChange: job => updates.push(job) }, item.dependencies);
    const preview = await manager.inspect(item.archivePath);
    assert.equal(preview.javaAvailable, true); assert.equal(preview.archiveName, 'pack.zip'); assert.ok(!JSON.stringify(preview).includes(directory));
    const result = await manager.start(preview.id, '独立实例');
    assert.equal(path.dirname(result.destination), await realpath(item.instancesRoot));
    assert.equal(result.versionId, '1.21.1-neoforge-21.1.262');
    assert.deepEqual(item.calls, { vanilla: 1, loader: 1, files: 1, resume: false });
    const marker = JSON.parse(await readFile(path.join(result.destination, MODPACK_MARKER), 'utf8'));
    assert.equal(marker.name, '独立实例'); assert.equal(marker.state, 'complete'); assert.equal(marker.versionId, result.versionId);
    const jobs = await manager.list(); assert.equal(jobs[0].status, 'complete'); assert.equal(jobs[0].completed, 100);
    assert.ok(!JSON.stringify(jobs).includes(directory));
    assert.ok(updates.some(job => job.phase === 'loader')); assert.ok(updates.some(job => job.phase === 'files'));
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    assert.equal((await restored.list())[0].status, 'complete');
    assert.deepEqual(await restored.resume(jobs[0].id), result);
    assert.equal(item.calls.vanilla, 1);
  });
});

test('failed pack downloads resume after restart without repeating completed base and loader stages', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); let shouldFail = true;
    const effects: ModpackManagerDependencies = { ...item.dependencies, installModpackFiles: async () => {
      item.calls.files++;
      if (shouldFail) throw new ModpackError('DOWNLOAD_FAILED', 'temporary failure');
      return { downloadedFiles: 0, reusedFiles: 1, overrideFiles: 0 };
    } };
    const manager = new ModpackInstallManager(item.options, effects);
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '恢复测试'), { code: 'DOWNLOAD_FAILED' });
    const [failed] = await manager.list(); assert.equal(failed.status, 'error'); assert.equal(failed.phase, 'files');
    shouldFail = false;
    const restored = new ModpackInstallManager(item.options, effects);
    const result = await restored.resume(failed.id);
    assert.equal(result.versionId, '1.21.1-neoforge-21.1.262');
    assert.equal(item.calls.vanilla, 1); assert.equal(item.calls.loader, 1); assert.equal(item.calls.files, 2);
    assert.equal((await restored.list())[0].status, 'complete');
    assert.ok((await readdir(item.jobsRoot)).every(name => name.endsWith('.json')));
  });
});

test('interrupted running jobs become retryable after startup and reject archive mutation', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async () => { throw new Error('failed'); } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '中断测试'));
    const [job] = await manager.list(); const filename = path.join(item.jobsRoot, `${job.id}.json`);
    const record = JSON.parse(await readFile(filename, 'utf8')); record.job.status = 'running'; await writeFile(filename, JSON.stringify(record));
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    const [interrupted] = await restored.list(); assert.equal(interrupted.status, 'error'); assert.match(interrupted.message, /中断/);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).job.status, 'error');
    await writeFile(item.archivePath, 'different archive contents');
    await assert.rejects(restored.resume(job.id), { code: 'ARCHIVE_CHANGED' });
    assert.equal(item.calls.files, 0);
  });
});

test('cancellation persists a resumable state and disallows overlapping installs', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); let notifyFiles!: () => void;
    const inFiles = new Promise<void>(resolve => { notifyFiles = resolve; });
    const effects: ModpackManagerDependencies = { ...item.dependencies, installModpackFiles: async options => {
      item.calls.files++; notifyFiles();
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
      return { downloadedFiles: 0, reusedFiles: 0, overrideFiles: 0 };
    } };
    const manager = new ModpackInstallManager(item.options, effects);
    const preview = await manager.inspect(item.archivePath);
    const pending = manager.start(preview.id, '取消测试');
    // Observe the expected rejection before cancel() awaits independent disk persistence.
    const stopped = assert.rejects(pending, { code: 'CANCELLED' });
    await inFiles;
    const [job] = await manager.list(); assert.equal(job.status, 'running');
    await assert.rejects(manager.resume(job.id), { code: 'INSTALL_BUSY' });
    await manager.cancel(job.id);
    await stopped;
    assert.equal((await manager.list())[0].status, 'cancelled');
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    await restored.resume(job.id);
    assert.equal((await restored.list())[0].status, 'complete');
    assert.equal(item.calls.vanilla, 1); assert.equal(item.calls.loader, 1);
  });
});

test('missing Java, unsupported loaders and expired/unknown previews cannot create instances', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager({ ...item.options, findJava: async () => undefined }, item.dependencies);
    const preview = await manager.inspect(item.archivePath); assert.equal(preview.javaAvailable, false);
    await assert.rejects(manager.start(preview.id, '缺少Java'), { code: 'JAVA_REQUIRED' });
    assert.deepEqual(await manager.list(), []); assert.deepEqual(await readdir(item.instancesRoot), []);
    await assert.rejects(manager.start('unrecognized', '测试'), { code: 'PREVIEW_EXPIRED' });
    const unsupported = new ModpackInstallManager(item.options, { ...item.dependencies, analyzeModpack: async () => ({ ...await item.analysis(), loader: 'fabric' }) });
    const unsupportedPreview = await unsupported.inspect(item.archivePath);
    await assert.rejects(unsupported.start(unsupportedPreview.id, '不支持'), { code: 'UNSUPPORTED_LOADER' });
    assert.deepEqual(await readdir(item.instancesRoot), []);
  });
});

test('a partially installed base resumes only its owned directory and corrupt job paths are ignored', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); let failBase = true;
    const original = item.dependencies.installVanilla!;
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installVanilla: async (options, dependencies) => {
      if (failBase) {
        await mkdir(options.destination);
        await writeFile(path.join(options.destination, INSTALLATION_MARKER), JSON.stringify({ schemaVersion: 1, versionId: options.versionId, state: 'failed' }));
        throw new Error('download interrupted');
      }
      return original(options, dependencies);
    } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '原版恢复'));
    const [job] = await manager.list(); failBase = false;
    await manager.resume(job.id); assert.equal(item.calls.resume, true);
    const filename = path.join(item.jobsRoot, `${job.id}.json`);
    const record = JSON.parse(await readFile(filename, 'utf8')); record.destination = path.join(directory, 'outside');
    await writeFile(filename, JSON.stringify(record));
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    assert.deepEqual(await restored.list(), []);
    await assert.rejects(restored.resume(job.id), { code: 'UNKNOWN_JOB' });
  });
});

test('changing the ZIP while the base downloads cannot install files for a different pack', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); const original = item.dependencies.installVanilla!;
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installVanilla: async (options, dependencies) => {
      const result = await original(options, dependencies);
      await writeFile(item.archivePath, 'modified during the long base installation');
      return result;
    } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '变更测试'), { code: 'ARCHIVE_CHANGED' });
    assert.equal(item.calls.files, 0); assert.equal((await manager.list())[0].status, 'error');
  });
});

test('resuming cannot import pack files into an unrelated replacement of the old instance directory', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async () => { throw new Error('interrupted'); } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '目录保护'));
    const [job] = await manager.list();
    const record = JSON.parse(await readFile(path.join(item.jobsRoot, `${job.id}.json`), 'utf8'));
    assert.equal(path.dirname(record.destination), await realpath(item.instancesRoot));
    await rename(record.destination, `${record.destination}-moved`);
    await mkdir(record.destination);
    await writeFile(path.join(record.destination, 'options.txt'), 'unrelated user data');
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    await assert.rejects(restored.resume(job.id), { code: 'INVALID_DESTINATION' });
    assert.equal(await readFile(path.join(record.destination, 'options.txt'), 'utf8'), 'unrelated user data');
    await assert.rejects(lstat(path.join(record.destination, MODPACK_MARKER)), { code: 'ENOENT' });
    assert.equal(item.calls.files, 0);
    await writeFile(path.join(record.destination, MODPACK_MARKER), JSON.stringify({ schemaVersion: 1, jobId: 'another-job', minecraftVersion: '1.21.1' }));
    await assert.rejects(restored.resume(job.id), { code: 'INVALID_DESTINATION' });
    assert.equal(JSON.parse(await readFile(path.join(record.destination, MODPACK_MARKER), 'utf8')).jobId, 'another-job');
  });
});

test('failed tasks can be cancelled persistently and still resumed after restart', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async () => { throw new Error('offline'); } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '取消失败任务'));
    const [failed] = await manager.list();
    assert.equal(failed.status, 'error');
    const cancellation = manager.cancel(failed.id);
    await assert.rejects(manager.resume(failed.id), { code: 'INSTALL_BUSY' });
    await cancellation;
    const cancelled = (await manager.list())[0];
    assert.equal(cancelled.status, 'cancelled');
    const record = JSON.parse(await readFile(path.join(item.jobsRoot, `${failed.id}.json`), 'utf8'));
    assert.equal(record.job.status, 'cancelled');
    assert.equal(JSON.parse(await readFile(path.join(record.destination, MODPACK_MARKER), 'utf8')).state, 'cancelled');
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    assert.equal((await restored.list())[0].status, 'cancelled');
    await restored.resume(failed.id);
    assert.equal((await restored.list())[0].status, 'complete');
    await restored.cancel(failed.id);
    assert.equal((await restored.list())[0].status, 'complete', 'cancelling a completed task must not undo success');
    await assert.rejects(restored.cancel('missing-job'), { code: 'UNKNOWN_JOB' });
  });
});

test('active cancellation responds before download cleanup and ignores late progress across retries', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); const updates: ModpackJob[] = [];
    let notifyFiles!: () => void; let releaseFiles!: () => void;
    const entered = new Promise<void>(resolve => { notifyFiles = resolve; });
    const held = new Promise<void>(resolve => { releaseFiles = resolve; });
    let oldProgress: ((progress: ModpackFileProgress) => void) | undefined;
    let downloadSignal: AbortSignal | undefined; let attempts = 0;
    const progress = (message: string): ModpackFileProgress => ({ phase: 'downloading', completedFiles: 0, totalFiles: 1, downloadedBytes: 1, totalBytes: 10, reusedFiles: 0, message });
    const manager = new ModpackInstallManager({ ...item.options, onChange: job => updates.push(job) }, { ...item.dependencies, installModpackFiles: async options => {
      attempts++;
      if (attempts === 1) {
        oldProgress = options.onProgress; downloadSignal = options.signal; notifyFiles();
        await held; // Model a download whose cleanup does not complete immediately.
      } else oldProgress?.(progress('stale previous attempt'));
      return { downloadedFiles: 1, reusedFiles: 0, overrideFiles: 0 };
    } });
    const preview = await manager.inspect(item.archivePath);
    const pending = manager.start(preview.id, '立即取消');
    const stopped = assert.rejects(pending, { code: 'CANCELLED' });
    await entered;
    const [job] = await manager.list();
    const cancellation = manager.cancel(job.id);
    assert.equal(downloadSignal?.aborted, true, 'abort must happen before cancellation persistence awaits');
    await cancellation;
    oldProgress?.(progress('late cancelled progress'));
    assert.equal((await manager.list())[0].status, 'cancelled');
    assert.match((await manager.list())[0].message, /已取消/);
    assert.equal(JSON.parse(await readFile(path.join(item.jobsRoot, `${job.id}.json`), 'utf8')).job.status, 'cancelled');
    await assert.rejects(manager.dismiss(job.id), { code: 'INSTALL_BUSY' });
    await assert.rejects(manager.resume(job.id), { code: 'INSTALL_BUSY' });
    releaseFiles(); await stopped;
    await manager.resume(job.id);
    assert.equal((await manager.list())[0].status, 'complete');
    assert.equal(updates.some(update => /late cancelled progress|stale previous attempt/.test(update.message)), false);
  });
});

test('cancelling during resume preflight prevents the installation from restarting', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    let holdPreflight = false; let notifyPreflight!: () => void; let releasePreflight!: () => void;
    const entered = new Promise<void>(resolve => { notifyPreflight = resolve; });
    const held = new Promise<void>(resolve => { releasePreflight = resolve; });
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies,
      analyzeModpack: async () => { if (holdPreflight) { notifyPreflight(); await held; } return item.analysis(); },
      installModpackFiles: async () => { item.calls.files++; throw new Error('offline'); },
    });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '预检取消'));
    const [job] = await manager.list(); holdPreflight = true;
    const resuming = manager.resume(job.id);
    const stopped = assert.rejects(resuming, { code: 'CANCELLED' });
    await entered;
    await manager.cancel(job.id);
    await assert.rejects(manager.dismiss(job.id), { code: 'INSTALL_BUSY' });
    releasePreflight(); await stopped;
    assert.equal((await manager.list())[0].status, 'cancelled');
    assert.equal(item.calls.files, 1, 'cancelled preflight must not enter pack downloads again');
    await manager.dismiss(job.id);
    assert.deepEqual(await manager.list(), []);
  });
});

test('dismissing a stopped task removes only its durable record and cannot be revived by late progress', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); let lateProgress: ((progress: ModpackFileProgress) => void) | undefined;
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async options => {
      lateProgress = options.onProgress;
      await writeFile(path.join(options.destination, 'downloaded-file.jar'), 'keep downloaded content');
      throw new Error('offline');
    } });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '只移除记录'));
    const [job] = await manager.list();
    const filename = path.join(item.jobsRoot, `${job.id}.json`);
    const record = JSON.parse(await readFile(filename, 'utf8'));
    const removal = manager.dismiss(job.id);
    await assert.rejects(manager.resume(job.id), { code: 'INSTALL_BUSY' });
    await removal;
    lateProgress?.({ phase: 'downloading', completedFiles: 1, totalFiles: 1, downloadedBytes: 10, totalBytes: 10, reusedFiles: 0, message: 'late removed job' });
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(lstat(filename), { code: 'ENOENT' });
    assert.equal(await readFile(item.archivePath, 'utf8'), 'test archive');
    assert.equal(await readFile(path.join(record.destination, 'downloaded-file.jar'), 'utf8'), 'keep downloaded content');
    assert.equal(JSON.parse(await readFile(path.join(record.destination, MODPACK_MARKER), 'utf8')).jobId, job.id);
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    assert.deepEqual(await restored.list(), []);
    await assert.rejects(restored.resume(job.id), { code: 'UNKNOWN_JOB' });
    await assert.rejects(restored.dismiss(job.id), { code: 'UNKNOWN_JOB' });
  });
});

test('reopening the same pack previews its unfinished task and resumes the original instance after restart', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async () => { throw new Error('offline'); } });
    const first = await manager.inspect(item.archivePath);
    assert.equal(first.existingJobId, undefined);
    await assert.rejects(manager.start(first.id, '原有安装'));
    const [job] = await manager.list();
    const record = JSON.parse(await readFile(path.join(item.jobsRoot, `${job.id}.json`), 'utf8'));
    assert.equal((await manager.inspect(item.archivePath)).existingJobId, job.id);
    assert.equal((await manager.list()).length, 1, 'previewing a pack must not create a second task');
    await manager.cancel(job.id);
    assert.equal((await manager.inspect(item.archivePath)).existingJobId, job.id, 'cancelled tasks remain resumable');
    const restored = new ModpackInstallManager(item.options, item.dependencies);
    const repeated = await restored.inspect(item.archivePath);
    assert.equal(repeated.existingJobId, job.id);
    const result = await restored.resume(repeated.existingJobId!);
    assert.equal(result.destination, record.destination);
    assert.equal(item.calls.vanilla, 1); assert.equal(item.calls.loader, 1);
    assert.equal((await restored.list()).length, 1);
    assert.equal((await restored.inspect(item.archivePath)).existingJobId, undefined, 'completed jobs are not offered as unfinished installs');
  });
});

test('pack preview matching requires the original archive, fingerprint and dependencies and ignores dismissed jobs', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); let override: Partial<ModpackAnalysis> = {};
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies,
      analyzeModpack: async () => ({ ...await item.analysis(), ...override }),
      installModpackFiles: async () => { throw new Error('offline'); },
    });
    const first = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(first.id, '精确匹配'));
    const [job] = await manager.list();
    assert.equal((await manager.inspect(item.archivePath)).existingJobId, job.id);
    const anotherPath = path.join(directory, 'another-copy.zip');
    await writeFile(anotherPath, 'test archive');
    assert.equal((await manager.inspect(anotherPath)).existingJobId, undefined, 'an archive at another absolute path is a distinct input');
    const { archiveFingerprint } = await item.analysis();
    for (const difference of [
      { minecraftVersion: '1.21.2' },
      { loader: 'vanilla' as const, loaderVersion: undefined },
      { loaderVersion: '21.1.263' },
      { archiveFingerprint: { ...archiveFingerprint, size: archiveFingerprint.size + 1 } },
      { archiveFingerprint: { ...archiveFingerprint, mtimeMs: archiveFingerprint.mtimeMs + 1 } },
    ]) {
      override = difference;
      assert.equal((await manager.inspect(item.archivePath)).existingJobId, undefined);
    }
    override = {};
    assert.equal((await manager.inspect(item.archivePath)).existingJobId, job.id);
    await manager.dismiss(job.id);
    assert.equal((await manager.inspect(item.archivePath)).existingJobId, undefined);
  });
});

test('a matching preview retains an explicit option to install an independent new instance', async () => {
  await temporary(async directory => {
    const item = await fixture(directory);
    const manager = new ModpackInstallManager(item.options, { ...item.dependencies, installModpackFiles: async () => { throw new Error('offline'); } });
    const first = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(first.id, '第一个实例'));
    const [original] = await manager.list();
    const another = await manager.inspect(item.archivePath);
    assert.equal(another.existingJobId, original.id);
    await assert.rejects(manager.start(another.id, '明确新建的实例'));
    const jobs = await manager.list();
    assert.equal(jobs.length, 2);
    const records = await Promise.all(jobs.map(async job => JSON.parse(await readFile(path.join(item.jobsRoot, `${job.id}.json`), 'utf8'))));
    assert.notEqual(records[0].destination, records[1].destination);
  });
});

test('structured telemetry is measured per phase, throttled, immutable and reset rather than persisted across restart', async () => {
  await temporary(async directory => {
    const item = await fixture(directory); const updates: ModpackJob[] = [];
    const manager = new ModpackInstallManager({ ...item.options, onChange: job => updates.push(job) }, { ...item.dependencies,
      installModpackFiles: async options => {
        for (let count = 0; count < 1000; count++) options.onProgress?.({
          phase: 'downloading', message: 'measured download', phasePercent: 50,
          phaseCompletedFiles: 1, phaseTotalFiles: 2, phaseCompletedBytes: 5, phaseTotalBytes: 10,
          completedFiles: 1, totalFiles: 5, downloadedBytes: 5, totalBytes: 1000, reusedFiles: 1,
          transferredBytes: count, currentFile: 'mods/example.jar',
        });
        throw new ModpackError('DOWNLOAD_FAILED', 'telemetry fixture stopped');
      },
    });
    const preview = await manager.inspect(item.archivePath);
    await assert.rejects(manager.start(preview.id, '真实遥测'), { code: 'DOWNLOAD_FAILED' });
    const [job] = await manager.list();
    assert.ok(updates.length < 30, 'a thousand synchronous file events should not flood IPC');
    assert.equal(job.progress?.transferredBytes, 999);
    assert.equal(job.progress?.completedFiles, 1);
    assert.equal(job.progress?.totalFiles, 2, 'current-step totals must not be replaced by all ZIP files');
    assert.equal(job.progress?.completedBytes, 5);
    assert.equal(job.progress?.totalBytes, 10);
    assert.equal(job.progress?.steps.find(step => step.id === 'pack-downloads')?.status, 'error');
    assert.equal(job.progress?.steps.find(step => step.id === 'pack-downloads')?.percent, 50);
    assert.equal(job.progress?.bytesPerSecond, undefined, 'a stopped job cannot advertise a live speed');
    assert.equal(updates[0].progress?.steps.some(step => step.status === 'error'), false, 'old public snapshots must not change later');
    assert.equal(job.archiveName, 'pack.zip'); assert.equal(job.loaderVersion, '21.1.262'); assert.equal(job.requiredJavaMajor, 21);
    const stored = JSON.parse(await readFile(path.join(item.jobsRoot, `${job.id}.json`), 'utf8'));
    assert.equal(stored.job.progress, undefined, 'transient file/rate/byte telemetry is not durable installation truth');
    const [restored] = await new ModpackInstallManager(item.options, item.dependencies).list();
    assert.equal(restored.progress?.transferredBytes, 0);
    assert.equal(restored.progress?.elapsedMs, 0);
    assert.equal(restored.progress?.bytesPerSecond, undefined);
    assert.equal(restored.progress?.currentFile, undefined);
    assert.ok(restored.progress?.steps.filter(step => /^(vanilla|loader)-/.test(step.id)).every(step => step.status === 'complete'));
    assert.equal(JSON.stringify(restored).includes(directory), false);
  });
});
