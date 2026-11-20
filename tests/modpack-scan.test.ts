import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanInstances } from '../arcane-launcher/src/main/services/instances';

const finalVersion = 'neoforge-21.1.262';

async function addForeignLauncherMetadata(root: string): Promise<void> {
  await Promise.all([
    writeFile(path.join(root, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }] })),
    writeFile(path.join(root, 'instance.cfg'), 'name=Foreign Prism instance'),
    writeFile(path.join(root, 'server.properties'), 'level-name=world'),
    writeFile(path.join(root, 'run.bat'), '@echo off\njava -jar server.jar nogui'),
    writeFile(path.join(root, 'eula.txt'), 'eula=true'),
  ]);
}

async function nestedClient(root: string, relative: string, versionId: string): Promise<void> {
  const directory = path.join(root, relative, 'versions', versionId);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, `${versionId}.json`), JSON.stringify({ id: versionId, libraries: [] })),
    writeFile(path.join(directory, `${versionId}.jar`), 'nested client fixture'),
  ]);
}

async function withPack(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'arcane-modpack-scan-'));
  const root = await realpath(temporary);
  try {
    const base = path.join(root, 'versions', '1.21.1');
    const loader = path.join(root, 'versions', finalVersion);
    const library = path.join(root, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.262');
    await Promise.all([mkdir(base, { recursive: true }), mkdir(loader, { recursive: true }), mkdir(library, { recursive: true }), mkdir(path.join(root, 'mods')), mkdir(path.join(root, 'saves', 'My World'), { recursive: true })]);
    await Promise.all([
      writeFile(path.join(base, '1.21.1.json'), JSON.stringify({ id: '1.21.1', mainClass: 'net.minecraft.client.main.Main', javaVersion: { majorVersion: 21 }, libraries: [] })),
      writeFile(path.join(base, '1.21.1.jar'), 'client fixture'),
      writeFile(path.join(loader, `${finalVersion}.json`), JSON.stringify({ id: finalVersion, inheritsFrom: '1.21.1', libraries: [{ name: 'net.neoforged:neoforge:21.1.262' }] })),
      writeFile(path.join(library, 'neoforge-21.1.262.jar'), 'loader fixture'),
      writeFile(path.join(root, 'mods', 'example.jar'), 'mod fixture'),
    ]);
    await run(root);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(root).startsWith('arcane-modpack-scan-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('unfinished, cancelled and malformed modpack markers hide partial game versions', async () => {
  await withPack(async root => {
    await addForeignLauncherMetadata(root);
    for (const state of ['installing', 'error', 'cancelled']) {
      await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 1, state, versionId: finalVersion }));
      assert.equal((await scanInstances([root])).instances.length, 0, state);
    }
    await writeFile(path.join(root, '.arcane-modpack.json'), '{invalid');
    assert.equal((await scanInstances([root])).instances.length, 0);
    await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 2, state: 'complete', versionId: finalVersion }));
    assert.equal((await scanInstances([root])).instances.length, 0);
  });
});

test('a completed modpack exposes only its final loader version with pack name and root contents', async () => {
  await withPack(async root => {
    await addForeignLauncherMetadata(root);
    await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 1, state: 'complete', versionId: finalVersion, name: 'Infinity Legacy II 私货版' }));
    const result = await scanInstances([root]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.instances.length, 1);
    const instance = result.instances[0];
    assert.equal(instance.versionId, finalVersion);
    assert.equal(instance.name, 'Infinity Legacy II 私货版');
    assert.equal(instance.minecraftVersion, '1.21.1');
    assert.equal(instance.loader, 'NeoForge');
    assert.equal(instance.loaderVersion, '21.1.262');
    assert.equal(instance.gameDirectory, root);
    assert.equal(instance.status, 'ready');
    assert.equal(instance.stats.mods, 1);
    assert.equal(instance.stats.saves, 1);
  });
});

test('ordinary unmarked game roots keep both base and loader versions discoverable', async () => {
  await withPack(async root => {
    const result = await scanInstances([root]);
    assert.deepEqual(result.instances.map(instance => instance.versionId).sort(), ['1.21.1', finalVersion].sort());
  });
});

test('marked independent packs do not discover nested Minecraft or launcher instance directories', async () => {
  await withPack(async root => {
    const nested = ['.minecraft', 'minecraft', 'instances/another-pack', '游戏/another-pack', 'Games/another-pack'];
    await Promise.all(nested.map((relative, index) => nestedClient(root, relative, `nested-${index}`)));
    const baseline = await scanInstances([root]);
    assert.equal(baseline.instances.length, 7, 'ordinary roots should discover supported nested layouts');
    for (const state of ['installing', 'error', 'cancelled']) {
      await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 1, state, versionId: finalVersion }));
      assert.deepEqual((await scanInstances([root])).instances, [], state);
    }
    await writeFile(path.join(root, '.arcane-modpack.json'), '{invalid');
    assert.deepEqual((await scanInstances([root])).instances, []);
    await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 1, state: 'complete', versionId: finalVersion }));
    const completed = await scanInstances([root]);
    assert.equal(completed.instances.length, 1);
    assert.equal(completed.instances[0].versionId, finalVersion);
    assert.equal(completed.instances[0].kind, 'client');
  });
});

test('an unfinished marked root without versions does not expose portable sibling layouts', async () => {
  await withPack(async root => {
    await rename(path.join(root, 'versions'), path.join(root, 'old-version-files'));
    await nestedClient(root, 'portable-client', 'portable-version');
    assert.equal((await scanInstances([root])).instances.length, 1, 'ordinary parent discovery recognizes the portable fixture');
    await writeFile(path.join(root, '.arcane-modpack.json'), JSON.stringify({ schemaVersion: 1, state: 'installing', versionId: finalVersion }));
    assert.deepEqual((await scanInstances([root])).instances, []);
  });
});
