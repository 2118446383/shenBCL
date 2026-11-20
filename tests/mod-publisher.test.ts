import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishMods, type DownloadedMod } from '../arcane-launcher/src/main/services/mod-publisher';

async function setup(run: (root: string, mod: DownloadedMod) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-publish-'));
  try {
    const content = Buffer.from('verified fixture jar');
    const source = path.join(root, 'cache.jar');
    await writeFile(source, content);
    await mkdir(path.join(root, 'game'));
    await run(root, { filename: 'example.jar', source, size: content.length, sha512: createHash('sha512').update(content).digest('hex') });
  } finally {
    assert.ok(path.basename(root).startsWith('shenbcl-publish-') && path.dirname(root) === os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
}

test('publishes verified mods and dependencies as independent copies and reuses identical files', async () => {
  await setup(async (root, mod) => {
    const game = path.join(root, 'game');
    assert.deepEqual(await publishMods(game, [mod, { ...mod, filename: 'dependency.jar' }]), { added: 2, reused: 0 });
    assert.deepEqual(await publishMods(game, [mod]), { added: 0, reused: 1 });
    await writeFile(mod.source, 'changed cache');
    assert.equal(await readFile(path.join(game, 'mods', mod.filename), 'utf8'), 'verified fixture jar');
    assert.deepEqual((await readdir(path.join(game, 'mods'))).sort(), ['dependency.jar', 'example.jar']);
  });
});
test('a conflict rejects the entire group before publishing any new dependency', async () => {
  await setup(async (root, mod) => {
    const game = path.join(root, 'game');
    await mkdir(path.join(game, 'mods'));
    await writeFile(path.join(game, 'mods', 'example.jar'), 'player-modified');
    await assert.rejects(publishMods(game, [{ ...mod, filename: 'dependency.jar' }, mod]), /同名模组/);
    assert.deepEqual(await readdir(path.join(game, 'mods')), ['example.jar']);
    assert.equal(await readFile(path.join(game, 'mods', 'example.jar'), 'utf8'), 'player-modified');
  });
});
test('unsafe names, corrupt caches and pre-cancelled operations never publish', async () => {
  await setup(async (root, mod) => {
    const game = path.join(root, 'game');
    await assert.rejects(publishMods(game, [{ ...mod, filename: '../escape.jar' }]), /文件名/);
    await assert.rejects(publishMods(game, [{ ...mod, sha512: '0'.repeat(128) }]), /缓存校验/);
    const controller = new AbortController(); controller.abort(new Error('cancelled fixture'));
    await assert.rejects(publishMods(game, [mod], controller.signal), /cancelled fixture/);
    assert.deepEqual(await readdir(game), []);
  });
});
test('a mods junction cannot publish files into another directory', async () => {
  await setup(async (root, mod) => {
    const outside = path.join(root, 'outside'); await mkdir(outside);
    const game = path.join(root, 'game');
    await symlink(outside, path.join(game, 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(publishMods(game, [mod]), /目录联接/);
    assert.deepEqual(await readdir(outside), []);
  });
});
