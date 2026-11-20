import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LauncherInstance } from '../arcane-launcher/src/shared/contracts';
import { HiddenInstanceRegistry, planInstanceRemoval, deleteOwnedInstance, InstanceRemovalTickets, INSTANCE_REMOVAL_TTL } from '../arcane-launcher/src/main/services/instance-removal';
import { stableId } from '../arcane-launcher/src/main/services/filesystem';

async function fixture(run: (root: string, managed: string, instance: LauncherInstance) => Promise<void>) {
  const created = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-removal-'));
  const root = await realpath(created);
  try {
    const managed = path.join(root, 'instances');
    const directory = path.join(managed, 'fixture');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.arcane-installation.json'), JSON.stringify({ schemaVersion: 1, versionId: '1.20.1', state: 'complete' }));
    await writeFile(path.join(directory, 'save-sentinel.dat'), 'player world fixture');
    const instance: LauncherInstance = {
      id: stableId(`${directory}|1.20.1`), name: 'Fixture', path: directory, gameDirectory: directory,
      minecraftVersion: '1.20.1', versionId: '1.20.1', loader: '原版', loaderVersion: '', kind: 'client',
      status: 'ready', issues: [], stats: { mods: 0, saves: 0, screenshots: 0, resourcePacks: 0, shaderPacks: 0 }, source: 'minecraft',
    };
    await run(root, managed, instance);
  } finally {
    assert.ok(path.basename(created).startsWith('shenbcl-removal-') && path.dirname(created) === os.tmpdir());
    await rm(created, { recursive: true, force: true });
  }
}

test('permanent deletion removes only the validated independent instance and preserves shared files', async () => {
  await fixture(async (root, managed, instance) => {
    const shared = path.join(root, 'shared-libraries'); await mkdir(shared);
    await writeFile(path.join(shared, 'library.jar'), 'shared fixture');
    const plan = await planInstanceRemoval(instance, [instance], managed);
    assert.equal(plan.ownedPath, instance.path);
    let calls = 0;
    await deleteOwnedInstance(plan, instance, [instance], managed, async directory => {
      calls++; assert.equal(directory, instance.path); await rm(directory, { recursive: true, force: false });
    });
    assert.equal(calls, 1);
    assert.equal(await lstat(instance.path).catch(() => undefined), undefined);
    assert.equal(await readFile(path.join(shared, 'library.jar'), 'utf8'), 'shared fixture');
  });
});

test('external roots, shared version roots and unmanaged folders can only leave the library', async () => {
  await fixture(async (root, managed, instance) => {
    assert.equal((await planInstanceRemoval({ ...instance, path: root, gameDirectory: root }, [instance], managed)).ownedPath, undefined);
    assert.equal((await planInstanceRemoval(instance, [instance, { ...instance, id: 'another-version', versionId: '1.19.4' }], managed)).ownedPath, undefined);
    const sharedUser = { ...instance, id: 'shared-user', path: path.join(root, 'other'), gameDirectory: instance.gameDirectory };
    assert.equal((await planInstanceRemoval(instance, [instance, sharedUser], managed)).ownedPath, undefined);
    await rm(path.join(instance.path, '.arcane-installation.json'));
    assert.equal((await planInstanceRemoval(instance, [instance], managed)).ownedPath, undefined);
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});

test('a directory or ownership change during confirmation refuses permanent deletion', async () => {
  await fixture(async (_root, managed, instance) => {
    const plan = await planInstanceRemoval(instance, [instance], managed);
    await rename(instance.path, `${instance.path}-original`);
    await mkdir(instance.path);
    await writeFile(path.join(instance.path, '.arcane-installation.json'), JSON.stringify({ schemaVersion: 1, versionId: '1.20.1', state: 'complete' }));
    let calls = 0;
    await assert.rejects(deleteOwnedInstance(plan, instance, [instance], managed, async () => { calls++; }), /已经变化/);
    assert.equal(calls, 0);
    assert.ok((await lstat(instance.path)).isDirectory());
    assert.equal(await readFile(path.join(`${instance.path}-original`, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});

test('directory links and a corrupt pack marker never inherit vanilla deletion authority', async () => {
  await fixture(async (root, managed, instance) => {
    await writeFile(path.join(instance.path, '.arcane-modpack.json'), 'broken marker');
    assert.equal((await planInstanceRemoval(instance, [instance], managed)).ownedPath, undefined);
    await rm(path.join(instance.path, '.arcane-modpack.json'));
    const alias = path.join(managed, 'alias');
    await symlink(instance.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await planInstanceRemoval({ ...instance, path: alias, gameDirectory: alias }, [], managed)).ownedPath, undefined);
    const aliasUser = { ...instance, id: 'another-linked-library-entry', path: alias, gameDirectory: alias };
    assert.equal((await planInstanceRemoval(instance, [instance, aliasUser], managed)).ownedPath, undefined);
    const rootAlias = path.join(root, 'instances-alias');
    await symlink(managed, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedPath = path.join(rootAlias, 'fixture');
    assert.equal((await planInstanceRemoval({ ...instance, path: aliasedPath, gameDirectory: aliasedPath }, [], rootAlias)).ownedPath, undefined);
  });
});

test('managed packs validate their installed version and expose only the owned job ID', async () => {
  await fixture(async (_root, managed, instance) => {
    const jobId = 'c694b6d4-4d92-4e7f-bbb7-779bcefe67d1';
    const pack = { schemaVersion: 1, versionId: '1.20.1', state: 'complete', jobId };
    await writeFile(path.join(instance.path, '.arcane-modpack.json'), JSON.stringify(pack));
    assert.equal((await planInstanceRemoval(instance, [instance], managed)).jobId, jobId);
    await writeFile(path.join(instance.path, '.arcane-modpack.json'), JSON.stringify({ ...pack, versionId: 'different' }));
    assert.equal((await planInstanceRemoval(instance, [instance], managed)).ownedPath, undefined);
  });
});

test('removing from the library persists across scans/restarts and explicit import restores it', async () => {
  await fixture(async (root, _managed, instance) => {
    const filename = path.join(root, 'preferences', 'hidden-instances.json');
    const registry = new HiddenInstanceRegistry(filename); await registry.load();
    const secondId = stableId('second fixture');
    await Promise.all([registry.hide(instance.id), registry.hide(secondId)]);
    const reopened = new HiddenInstanceRegistry(filename); await reopened.load();
    assert.equal(reopened.isHidden(instance.id), true);
    assert.equal(reopened.isHidden(secondId), true);
    await reopened.restore([instance.id]);
    const restored = new HiddenInstanceRegistry(filename); await restored.load();
    assert.equal(restored.isHidden(instance.id), false);
    assert.equal(restored.isHidden(secondId), true);
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
    await assert.rejects(registry.hide('../other'), /无效/);
  });
});

test('confirmation tokens expire, are consumed once, and stay bound to the prepared instance', async () => {
  await fixture(async (_root, managed, instance) => {
    let now = 10_000;
    const tickets = new InstanceRemovalTickets(() => now);
    const plan = await planInstanceRemoval(instance, [instance], managed);
    const preview = tickets.prepare(instance, plan, 'clear');
    assert.equal(preview.action, 'delete');
    assert.equal(preview.blocked, false);
    assert.match(preview.warning, /永久删除/);
    assert.match(preview.warning, /无法从回收站恢复/);
    assert.equal('identity' in preview, false);
    const ticket = tickets.consume(preview.token);
    assert.equal(ticket.instanceId, instance.id);
    assert.equal(ticket.plan.ownedPath, instance.path);
    assert.throws(() => tickets.consume(preview.token), /确认已失效/);
    const previous = tickets.prepare(instance, plan, 'clear');
    const newest = tickets.prepare(instance, plan, 'clear');
    assert.throws(() => tickets.consume(previous.token), /确认已失效/);
    now += INSTANCE_REMOVAL_TTL;
    assert.throws(() => tickets.consume(newest.token), /确认已失效/);
    assert.throws(() => tickets.consume('../arbitrary-path'), /确认已失效/);
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});

test('owned clients with uncertain or running processes remain explicit blocked deletion previews', async () => {
  await fixture(async (_root, managed, instance) => {
    const tickets = new InstanceRemovalTickets();
    const plan = await planInstanceRemoval(instance, [instance], managed);
    for (const usage of ['uncertain', 'running'] as const) {
      const preview = tickets.prepare(instance, plan, usage);
      assert.equal(preview.action, 'delete');
      assert.equal(preview.blocked, true);
      assert.ok(preview.reason);
      assert.throws(() => tickets.consume(preview.token), /重试/);
    }
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});

test('external/shared confirmation authorizes list removal and cannot become physical deletion', async () => {
  await fixture(async (_root, managed, instance) => {
    const tickets = new InstanceRemovalTickets();
    const shared = { ...instance, id: stableId('shared version fixture'), versionId: '1.19.4' };
    const plan = await planInstanceRemoval(instance, [instance, shared], managed);
    const preview = tickets.prepare(instance, plan, 'clear');
    assert.equal(preview.action, 'remove');
    assert.equal(preview.blocked, false);
    assert.match(preview.warning, /不会删除游戏文件/);
    const ticket = tickets.consume(preview.token);
    assert.equal(ticket.action, 'remove');
    let removed = false;
    await assert.rejects(deleteOwnedInstance(ticket.plan, instance, [instance], managed, async () => { removed = true; }), /已经变化/);
    assert.equal(removed, false);
  });
});

test('valid-looking ownership marker changes after preparation invalidate deletion', async () => {
  await fixture(async (_root, managed, instance) => {
    const plan = await planInstanceRemoval(instance, [instance], managed);
    await writeFile(path.join(instance.path, '.arcane-installation.json'), JSON.stringify({ schemaVersion: 1, versionId: '1.20.1', state: 'complete', updatedAt: 'changed after confirmation preview' }));
    let removed = false;
    await assert.rejects(deleteOwnedInstance(plan, instance, [instance], managed, async () => { removed = true; }), /已经变化/);
    assert.equal(removed, false);
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});

test('a failed final process check prevents deleting any file', async () => {
  await fixture(async (_root, managed, instance) => {
    const plan = await planInstanceRemoval(instance, [instance], managed);
    let removed = false;
    await assert.rejects(deleteOwnedInstance(plan, instance, [instance], managed, async () => { removed = true; }, async () => { throw new Error('game running fixture'); }), /game running fixture/);
    assert.equal(removed, false);
    assert.equal(await readFile(path.join(instance.path, 'save-sentinel.dat'), 'utf8'), 'player world fixture');
  });
});
