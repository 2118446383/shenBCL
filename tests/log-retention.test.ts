import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, rmdir, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isStandardLogArchive, LOG_ARCHIVE_RETENTION, pruneInstanceLogArchives } from '../arcane-launcher/src/main/services/log-retention';

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 16, 12);

async function fixture(run: (root: string, logs: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-log-retention-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  try { await run(root, logs); }
  finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shenbcl-log-retention-'));
    await rm(root, { recursive: true, force: true });
  }
}

async function archive(logs: string, name: string, ageDays: number, bytes = 5) {
  const file = path.join(logs, name);
  const handle = await open(file, 'w');
  try { await handle.truncate(bytes); } finally { await handle.close(); }
  const modified = new Date(now - ageDays * day);
  await utimes(file, modified, modified);
  return file;
}

test('recognizes only dated standard compressed log archives with real calendar dates', () => {
  for (const name of ['2026-11-16-1.log.gz', '2013-01-02_3.log.gz', 'debug-2026-11-16-2.log.gz', '2024-02-29-1.log.gz']) assert.equal(isStandardLogArchive(name), true, name);
  for (const name of ['latest.log', 'debug.log', 'debug-1.log.gz', 'custom.log.gz', '2026-11-16-1.log', 'crash-2026-11-16_1.txt', '2026-02-29-1.log.gz', '2026-13-01-1.log.gz', '2026-01-00-1.log.gz', '../2026-11-16-1.log.gz']) assert.equal(isStandardLogArchive(name), false, name);
});

test('keeps the ten newest standard archives without touching current logs, mod logs or crashes', async () => {
  await fixture(async (root, logs) => {
    for (let index = 1; index <= 12; index++) await archive(logs, `2026-11-16-${index}.log.gz`, index / 100);
    await writeFile(path.join(logs, 'latest.log'), 'current game log');
    await writeFile(path.join(logs, 'debug.log'), 'current debug log');
    await writeFile(path.join(logs, 'custom-mod.log.gz'), 'mod log');
    await mkdir(path.join(root, 'crash-reports'));
    await writeFile(path.join(root, 'crash-reports', 'crash-2020-01-01_1.txt'), 'crash');
    const result = await pruneInstanceLogArchives(root, now);
    assert.deepEqual(result, { removedFiles: 2, removedBytes: 10, retainedFiles: 10, retainedBytes: 50 });
    assert.equal(await readFile(path.join(logs, 'latest.log'), 'utf8'), 'current game log');
    assert.equal(await readFile(path.join(logs, 'debug.log'), 'utf8'), 'current debug log');
    assert.equal(await readFile(path.join(logs, 'custom-mod.log.gz'), 'utf8'), 'mod log');
    assert.equal(await readFile(path.join(root, 'crash-reports', 'crash-2020-01-01_1.txt'), 'utf8'), 'crash');
    assert.equal((await readdir(logs)).includes('2026-11-16-12.log.gz'), false);
    assert.equal((await readdir(logs)).includes('2026-11-16-1.log.gz'), true);
  });
});

test('expires historical archives older than fourteen days even below the count limit', async () => {
  await fixture(async (root, logs) => {
    await archive(logs, '2026-11-01-1.log.gz', 15);
    await archive(logs, '2026-11-02-1.log.gz', 14);
    const result = await pruneInstanceLogArchives(root, now);
    assert.equal(result.removedFiles, 1);
    assert.deepEqual(await readdir(logs), ['2026-11-02-1.log.gz']);
  });
});

test('caps total historical archive bytes while preserving the newest archives that fit', async () => {
  await fixture(async (root, logs) => {
    const bytes = 60 * 1024 * 1024;
    await archive(logs, '2026-11-16-1.log.gz', 1, bytes);
    await archive(logs, '2026-11-15-1.log.gz', 2, bytes);
    await archive(logs, '2026-11-14-1.log.gz', 3, 1024);
    const result = await pruneInstanceLogArchives(root, now);
    assert.equal(result.removedFiles, 1);
    assert.equal(result.removedBytes, bytes);
    assert.equal(result.retainedBytes, bytes + 1024);
    assert.ok(result.retainedBytes <= LOG_ARCHIVE_RETENTION.maximumBytes);
    assert.deepEqual((await readdir(logs)).sort(), ['2026-11-14-1.log.gz', '2026-11-16-1.log.gz']);
  });
});

test('leaves a linked logs directory and its external archives untouched', async () => {
  await fixture(async (root, logs) => {
    const external = path.join(root, 'other-logs');
    await mkdir(external);
    await archive(external, '2020-01-01-1.log.gz', 365);
    await rmdir(logs);
    await symlink(external, logs, 'junction');
    assert.equal((await pruneInstanceLogArchives(root, now)).removedFiles, 0);
    assert.deepEqual(await readdir(external), ['2020-01-01-1.log.gz']);
  });
});

test('does not follow a linked instance directory or ancestor', async () => {
  await fixture(async (root, logs) => {
    const nested = path.join(root, 'actual');
    await mkdir(path.join(nested, 'instance', 'logs'), { recursive: true });
    await archive(path.join(nested, 'instance', 'logs'), '2020-01-01-1.log.gz', 365);
    const linked = path.join(root, 'linked');
    await symlink(nested, linked, 'junction');
    assert.equal((await pruneInstanceLogArchives(path.join(linked, 'instance'), now)).removedFiles, 0);
    assert.deepEqual(await readdir(path.join(nested, 'instance', 'logs')), ['2020-01-01-1.log.gz']);
  });
});

test('ignores archive-shaped directories and absent log folders', async () => {
  await fixture(async (root, logs) => {
    await mkdir(path.join(logs, '2020-01-01-1.log.gz'));
    assert.equal((await pruneInstanceLogArchives(root, now)).removedFiles, 0);
    assert.equal((await lstat(path.join(logs, '2020-01-01-1.log.gz'))).isDirectory(), true);
    assert.deepEqual(await pruneInstanceLogArchives(path.join(root, 'missing'), now), { removedFiles: 0, removedBytes: 0, retainedFiles: 0, retainedBytes: 0 });
    assert.equal((await pruneInstanceLogArchives(root, Number.NaN)).removedFiles, 0);
  });
});
