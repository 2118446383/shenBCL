import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BACKUP_MANIFEST, backupDirectories } from '../arcane-launcher/src/main/services/backup';

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arcane-backup-test-'));
  try { await run(directory); } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-backup-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

async function put(root: string, relative: string, value: string): Promise<void> {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, value, 'utf8');
}

async function exists(filename: string): Promise<boolean> {
  return lstat(filename).then(() => true, () => false);
}

test('backup copies independent file content and publishes a complete integrity manifest', async () => fixture(async root => {
  const saves = path.join(root, 'instance', 'saves');
  const destination = path.join(root, 'backups', 'first');
  await put(saves, 'World/level.dat', 'world state');
  await put(saves, 'World/region/r.0.0.mca', 'region data');
  const result = await backupDirectories({ sources: [{ path: saves, name: 'saves' }], destination });
  assert.equal(result, destination);
  assert.equal(await readFile(path.join(destination, 'saves', 'World', 'region', 'r.0.0.mca'), 'utf8'), 'region data');
  const manifest = JSON.parse(await readFile(path.join(destination, BACKUP_MANIFEST), 'utf8'));
  assert.equal(manifest.state, 'complete');
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256)));
  await writeFile(path.join(saves, 'World', 'level.dat'), 'changed original');
  assert.equal(await readFile(path.join(destination, 'saves', 'World', 'level.dat'), 'utf8'), 'world state');
  await writeFile(path.join(destination, 'saves', 'World', 'region', 'r.0.0.mca'), 'changed backup');
  assert.equal(await readFile(path.join(saves, 'World', 'region', 'r.0.0.mca'), 'utf8'), 'region data');
  assert.deepEqual((await readdir(path.join(root, 'backups'))).sort(), ['first']);
}));

test('backup never overwrites an existing destination directory or file', async () => fixture(async root => {
  const source = path.join(root, 'source');
  await put(source, 'level.dat', 'original');
  const destination = path.join(root, 'existing');
  await put(destination, 'keep.txt', 'existing data');
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }], destination }), /目标已经存在/);
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'existing data');
  const existingFile = path.join(root, 'keep-file.txt');
  await writeFile(existingFile, 'file data');
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }], destination: existingFile }), /目标已经存在/);
  assert.equal(await readFile(existingFile, 'utf8'), 'file data');
}));

for (const internal of [true, false]) {
  test(`backup rejects ${internal ? 'internal' : 'external'} directory links before creating a destination`, async () => fixture(async root => {
    const source = path.join(root, 'source');
    const linked = internal ? path.join(source, 'real-region') : path.join(root, 'external-region');
    await put(source, 'level.dat', 'original');
    await put(linked, 'r.0.0.mca', 'region');
    const link = path.join(source, 'region-link');
    await symlink(linked, link, process.platform === 'win32' ? 'junction' : 'dir');
    const destination = path.join(root, 'backups', 'rejected');
    await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }], destination }), /符号链接或目录联接/);
    assert.equal(await exists(destination), false);
    assert.equal(await exists(path.join(root, 'backups')), false);
    assert.equal(await readFile(path.join(linked, 'r.0.0.mca'), 'utf8'), 'region');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  }));
}

test('backup rejects a source directory that is itself a junction', async () => fixture(async root => {
  const actual = path.join(root, 'actual-world');
  await put(actual, 'level.dat', 'original');
  const link = path.join(root, 'world');
  await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(backupDirectories({ sources: [{ path: link, name: 'world' }], destination: path.join(root, 'backup') }), /符号链接或目录联接/);
  assert.equal(await exists(path.join(root, 'backup')), false);
}));

test('backup rejects nested destinations, including an ancestor junction into the source', async () => fixture(async root => {
  const source = path.join(root, 'source');
  await put(source, 'level.dat', 'original');
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }], destination: path.join(source, 'backups', 'nested') }), /不能位于原存档目录内部/);
  assert.equal(await exists(path.join(source, 'backups')), false);
  const parentLink = path.join(root, 'alias');
  await symlink(source, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }], destination: path.join(parentLink, 'nested') }), /不能位于原存档目录内部/);
  assert.equal(await exists(path.join(source, 'nested')), false);
}));

test('backup names cannot escape staging or collide with another source', async () => fixture(async root => {
  const source = path.join(root, 'source');
  await put(source, 'level.dat', 'original');
  const destination = path.join(root, 'backup');
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: '../outside' }], destination }), /单个有效目录名/);
  await assert.rejects(backupDirectories({ sources: [{ path: source, name: 'world' }, { path: source, name: 'WORLD' }], destination }), /不能重复/);
  assert.equal(await exists(destination), false);
  assert.equal(await exists(path.join(root, 'outside')), false);
}));
