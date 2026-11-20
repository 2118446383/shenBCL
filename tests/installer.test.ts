import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNodeInstallRuntime } from '@xmcl/installer';
import {
  assertFreshInstallDestination,
  installVanilla,
  INSTALLATION_MARKER,
  OFFICIAL_VERSION_MANIFEST,
  resolveOfficialVanillaVersion,
  validateVanillaVersionId,
  VanillaInstallError,
  type VanillaInstallProgress,
} from '../arcane-launcher/src/main/services/installer';

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arcane-install-test-'));
  try {
    await run(await realpath(directory));
  } finally {
    const target = path.resolve(directory);
    const relative = path.relative(path.resolve(os.tmpdir()), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith('arcane-install-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

function sha1(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex');
}

function fixtureFetch(versions: object[]): typeof globalThis.fetch {
  return async (url) => {
    assert.equal(String(url), OFFICIAL_VERSION_MANIFEST);
    return new Response(JSON.stringify({
      latest: { release: '1.20.1', snapshot: '26.1-snapshot-1' },
      versions,
    }), { headers: { 'Content-Type': 'application/json' } });
  };
}

const officialVersion = {
  id: '1.20.1',
  type: 'release',
  time: '2023-06-12T13:25:51+00:00',
  releaseTime: '2023-06-12T13:25:51+00:00',
  url: 'https://piston-meta.mojang.com/v1/packages/fixture/1.20.1.json',
};

test('version IDs reject traversal, Windows device names, streams and control characters', () => {
  for (const id of ['', '../1.20.1', '..\\1.20.1', 'C:\\Minecraft', '1.20.1:payload', 'CON', 'LPT1.json', '1.20.1 ', '1.20.1\0']) {
    assert.throws(() => validateVanillaVersionId(id), { code: 'INVALID_VERSION' });
  }
  for (const id of ['1.20.1', '24w14a', '1.21-pre1', '20w14∞', '3D Shareware v1.34']) {
    assert.equal(validateVanillaVersionId(id), id);
  }
});

test('only an exact version in the official manifest can be installed', async () => {
  const fetch = fixtureFetch([officialVersion]);
  assert.equal((await resolveOfficialVanillaVersion('1.20.1', { fetch })).id, '1.20.1');
  await assert.rejects(resolveOfficialVanillaVersion('1.20.1-forge-47.3.7', { fetch }), { code: 'UNKNOWN_VERSION' });
  await assert.rejects(resolveOfficialVanillaVersion('1.20.1', {
    fetch: fixtureFetch([{ ...officialVersion, url: 'https://example.com/client.json' }]),
  }), { code: 'UNTRUSTED_DOWNLOAD' });
});

test('existing directories, files and junction destinations are never overwritten', async () => {
  await withTemporaryDirectory(async directory => {
    const existing = path.join(directory, 'existing');
    await mkdir(existing);
    const saved = path.join(existing, 'player-settings.txt');
    await writeFile(saved, 'preserve me');
    await assert.rejects(assertFreshInstallDestination(existing, directory), { code: 'DESTINATION_EXISTS' });
    await assert.rejects(assertFreshInstallDestination(saved, directory), { code: 'DESTINATION_EXISTS' });
    assert.equal(await readFile(saved, 'utf8'), 'preserve me');
    assert.equal(await assertFreshInstallDestination(path.join(directory, 'new-instance'), directory), path.join(directory, 'new-instance'));

    const link = path.join(directory, 'existing-link');
    await symlink(existing, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertFreshInstallDestination(link, directory), { code: 'DESTINATION_EXISTS' });
  });
});

test('a junction parent cannot redirect installation outside the allowed instances root', async () => {
  await withTemporaryDirectory(async directory => {
    const root = path.join(directory, 'instances');
    const outside = path.join(directory, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const junction = path.join(root, 'redirect');
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertFreshInstallDestination(path.join(junction, 'new-instance'), root), {
      code: 'DESTINATION_OUTSIDE_ROOT',
    });
    await assert.rejects(assertFreshInstallDestination('relative-instance', root), { code: 'INVALID_DESTINATION' });
  });
});

test('cancellation before installation performs no network requests and creates no directory', async () => {
  await withTemporaryDirectory(async directory => {
    const controller = new AbortController();
    controller.abort();
    const destination = path.join(directory, 'cancelled');
    let errorCallback = false;
    await assert.rejects(installVanilla({
      destination,
      instancesRoot: directory,
      signal: controller.signal,
      onError: error => { errorCallback = error.code === 'CANCELLED'; },
    }, {
      fetch: async () => { throw new Error('Network must not be called'); },
    }), { code: 'CANCELLED' });
    assert.equal(errorCallback, true);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  });
});

test('unknown versions leave the proposed destination untouched', async () => {
  await withTemporaryDirectory(async directory => {
    const destination = path.join(directory, 'unknown');
    await assert.rejects(installVanilla({
      versionId: '1.20.1-forge',
      destination,
      instancesRoot: directory,
    }, { fetch: fixtureFetch([officialVersion]) }), { code: 'UNKNOWN_VERSION' });
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  });
});

test('cancellation during a download marks the fresh instance as cancelled', async () => {
  await withTemporaryDirectory(async directory => {
    const destination = path.join(directory, 'cancelled-download');
    const controller = new AbortController();
    await assert.rejects(installVanilla({
      destination,
      instancesRoot: directory,
      signal: controller.signal,
    }, {
      fetch: fixtureFetch([officialVersion]),
      createRuntime: options => createNodeInstallRuntime({
        ...options,
        download: async () => {
          controller.abort();
          throw new DOMException('Cancelled fixture download', 'AbortError');
        },
      }),
    }), { code: 'CANCELLED' });
    assert.equal(JSON.parse(await readFile(path.join(destination, INSTALLATION_MARKER), 'utf8')).state, 'cancelled');
  });
});

function tinyZip(): Buffer {
  const name = Buffer.from('fixture.txt');
  const body = Buffer.from('fixture');
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const file = Buffer.concat([local, name, body]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(file.length, 16);
  return Buffer.concat([file, directory, end]);
}

test('the real XMCL resolver and executor install a complete fixture including libraries and assets', async () => {
  await withTemporaryDirectory(async directory => {
    const destination = path.join(directory, '原版-1.20.1-fixture');
    const jar = tinyZip();
    const resource = Buffer.from('one resource');
    const resourceHash = sha1(resource);
    const indexUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/assets.json';
    const jarUrl = 'https://piston-data.mojang.com/v1/objects/fixture/client.jar';
    const libraryUrl = 'https://libraries.minecraft.net/com/example/fixture/1.0/fixture-1.0.jar';
    const resourceUrl = `https://resources.download.minecraft.net/${resourceHash.slice(0, 2)}/${resourceHash}`;
    const assetIndex = JSON.stringify({ objects: { 'fixture.txt': { hash: resourceHash, size: resource.length } } });
    const versionJson = JSON.stringify({
      id: '1.20.1',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      time: officialVersion.time,
      releaseTime: officialVersion.releaseTime,
      minimumLauncherVersion: 21,
      javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
      arguments: { game: [], jvm: [] },
      downloads: { client: { url: jarUrl, sha1: sha1(jar), size: jar.length } },
      assets: 'fixture',
      assetIndex: { id: 'fixture', url: indexUrl, sha1: sha1(assetIndex), size: Buffer.byteLength(assetIndex) },
      libraries: [{
        name: 'com.example:fixture:1.0',
        downloads: { artifact: {
          path: 'com/example/fixture/1.0/fixture-1.0.jar',
          url: libraryUrl,
          sha1: sha1(jar),
          size: jar.length,
        } },
      }],
    });
    const fixtures = new Map<string, Buffer>([
      [officialVersion.url, Buffer.from(versionJson)],
      [jarUrl, jar],
      [libraryUrl, jar],
      [indexUrl, Buffer.from(assetIndex)],
      [resourceUrl, resource],
    ]);
    const events: VanillaInstallProgress[] = [];
    const result = await installVanilla({
      destination,
      instancesRoot: directory,
      onProgress: event => { events.push(event); },
    }, {
      fetch: fixtureFetch([{ ...officialVersion, sha1: sha1(versionJson) }]),
      createRuntime: options => createNodeInstallRuntime({
        ...options,
        download: async files => {
          for (const file of files) {
            const content = fixtures.get(file.urls[0]);
            assert.ok(content, `Unexpected download URL: ${file.urls[0]}`);
            await mkdir(path.dirname(file.path), { recursive: true });
            await writeFile(file.path, content);
          }
        },
      }),
    });
    assert.equal(result.versionId, '1.20.1');
    assert.equal(result.requiredJavaMajor, 17);
    assert.equal(result.assetCount, 1);
    assert.equal(result.libraryCount, 1);
    assert.equal(await readFile(path.join(destination, 'assets', 'objects', resourceHash.slice(0, 2), resourceHash), 'utf8'), 'one resource');
    assert.equal(JSON.parse(await readFile(path.join(destination, INSTALLATION_MARKER), 'utf8')).state, 'complete');
    assert.ok(events.some(event => event.phase === 'libraries'));
    assert.ok(events.some(event => event.phase === 'client' && event.phasePercent === 100 && event.completedFiles === 1 && event.totalFiles === 1));
    assert.ok(events.some(event => event.phase === 'libraries' && event.phasePercent === 100 && event.completedFiles === 1 && event.totalFiles === 1));
    assert.ok(events.some(event => event.phase === 'assets'));
    assert.equal(events.at(-1)?.percent, 100);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].percent >= events[i - 1].percent);
  });
});

test('a failed download is reported and marked incomplete without removing the new instance', async () => {
  await withTemporaryDirectory(async directory => {
    const destination = path.join(directory, 'failed-fixture');
    let reported: VanillaInstallError | undefined;
    await assert.rejects(installVanilla({
      destination,
      instancesRoot: directory,
      onError: error => { reported = error; },
    }, {
      fetch: fixtureFetch([officialVersion]),
      createRuntime: options => createNodeInstallRuntime({
        ...options,
        download: async () => { throw new Error('fixture network unavailable'); },
      }),
    }), { code: 'INSTALL_FAILED' });
    assert.equal(reported?.code, 'INSTALL_FAILED');
    assert.equal(JSON.parse(await readFile(path.join(destination, INSTALLATION_MARKER), 'utf8')).state, 'failed');
    assert.equal((await lstat(destination)).isDirectory(), true);
  });
});

