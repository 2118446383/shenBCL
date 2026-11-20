import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installVanilla, INSTALLATION_MARKER, OFFICIAL_VERSION_MANIFEST } from '../arcane-launcher/src/main/services/installer';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arcane-resume-test-'));
  try { await run(await realpath(directory)); }
  finally {
    const target = path.resolve(directory);
    const relative = path.relative(path.resolve(os.tmpdir()), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith('arcane-resume-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

async function marker(destination: string, changes: Record<string, unknown> = {}): Promise<void> {
  await writeFile(path.join(destination, INSTALLATION_MARKER), JSON.stringify({
    schemaVersion: 1, versionId: '1.20.1', state: 'failed', ...changes,
  }));
}

test('resume rejects unowned directories and mismatched records before requesting downloads', async () => {
  await withDirectory(async directory => {
    const destination = path.join(directory, 'instance');
    await mkdir(destination);
    await writeFile(path.join(destination, 'options.txt'), 'personal settings');
    let requests = 0;
    const resume = () => installVanilla({ destination, instancesRoot: directory, resume: true }, {
      fetch: async () => { requests++; throw new Error('Unexpected network request'); },
    });
    await assert.rejects(resume(), { code: 'INVALID_DESTINATION' });
    for (const changes of [{ versionId: '1.21.1' }, { schemaVersion: 2 }, { state: 'unowned' }]) {
      await marker(destination, changes);
      await assert.rejects(resume(), { code: 'INVALID_DESTINATION' });
    }
    assert.equal(requests, 0);
    assert.equal(await readFile(path.join(destination, 'options.txt'), 'utf8'), 'personal settings');
  });
});

test('resume rejects outside roots, junction destinations and nested directory links', async () => {
  await withDirectory(async directory => {
    const instancesRoot = path.join(directory, 'instances');
    const outside = path.join(directory, 'outside');
    await mkdir(instancesRoot);
    await mkdir(outside);
    await marker(outside);
    const dependencies = { fetch: (async () => { throw new Error('Unexpected network request'); }) as typeof fetch };
    await assert.rejects(installVanilla({ destination: outside, instancesRoot, resume: true }, dependencies), { code: 'DESTINATION_OUTSIDE_ROOT' });
    const link = path.join(instancesRoot, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installVanilla({ destination: link, instancesRoot, resume: true }, dependencies), { code: 'DESTINATION_OUTSIDE_ROOT' });
    const destination = path.join(instancesRoot, 'ordinary');
    await mkdir(destination);
    await marker(destination);
    await symlink(outside, path.join(destination, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installVanilla({ destination, instancesRoot, resume: true }, dependencies), { code: 'INVALID_DESTINATION' });
    assert.equal(JSON.parse(await readFile(path.join(outside, INSTALLATION_MARKER), 'utf8')).state, 'failed');
  });
});

function sha1(value: Buffer | string): string { return createHash('sha1').update(value).digest('hex'); }

function fixtureJar(): Buffer {
  const name = Buffer.from('fixture.txt');
  const body = Buffer.from('fixture');
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  const entry = Buffer.concat([local, name, body]);
  const directory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, end]);
}

test('resume repairs a same-size corrupted client, preserves user files and reuses verified downloads', async () => {
  await withDirectory(async directory => {
    const destination = path.join(directory, 'instance');
    const versionDirectory = path.join(destination, 'versions', '1.20.1');
    await mkdir(versionDirectory, { recursive: true });
    await marker(destination);
    await writeFile(path.join(destination, 'options.txt'), 'keep my controls');
    const jar = fixtureJar();
    const clientUrl = 'https://piston-data.mojang.com/v1/objects/resume/client.jar';
    const versionUrl = 'https://piston-meta.mojang.com/v1/packages/resume/1.20.1.json';
    const indexUrl = 'https://piston-meta.mojang.com/v1/packages/resume/assets.json';
    const index = JSON.stringify({ objects: {} });
    const releaseTime = '2023-06-12T13:25:51+00:00';
    const version = JSON.stringify({
      id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
      time: releaseTime, releaseTime, minimumLauncherVersion: 21,
      javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
      arguments: { game: [], jvm: [] }, libraries: [], assets: 'resume',
      downloads: { client: { url: clientUrl, sha1: sha1(jar), size: jar.length } },
      assetIndex: { id: 'resume', url: indexUrl, sha1: sha1(index), size: Buffer.byteLength(index) },
    });
    await writeFile(path.join(versionDirectory, '1.20.1.json'), version);
    await writeFile(path.join(versionDirectory, '1.20.1.jar'), Buffer.alloc(jar.length, 1));
    const payloads = new Map([
      [versionUrl, Buffer.from(version)], [clientUrl, jar], [indexUrl, Buffer.from(index)],
    ]);
    const requests: string[] = [];
    const fixtureFetch: typeof fetch = async input => {
      const url = String(input);
      requests.push(url);
      if (url === OFFICIAL_VERSION_MANIFEST) return Response.json({
        latest: { release: '1.20.1', snapshot: '1.20.1' },
        versions: [{ id: '1.20.1', type: 'release', time: releaseTime, releaseTime, url: versionUrl, sha1: sha1(version) }],
      });
      const content = payloads.get(url);
      assert.ok(content, `Unexpected request: ${url}`);
      return new Response(new Uint8Array(content), { headers: { 'content-length': String(content.length) } });
    };
    const options = { destination, instancesRoot: directory, resume: true };
    const installed = await installVanilla(options, { fetch: fixtureFetch });
    assert.equal(installed.versionId, '1.20.1');
    assert.deepEqual(await readFile(path.join(versionDirectory, '1.20.1.jar')), jar);
    assert.equal(requests.filter(url => url === clientUrl).length, 1);
    assert.equal(requests.filter(url => url === versionUrl).length, 1, 'official version metadata is refreshed');
    assert.equal(JSON.parse(await readFile(path.join(destination, INSTALLATION_MARKER), 'utf8')).state, 'complete');
    requests.length = 0;
    await installVanilla(options, { fetch: fixtureFetch });
    assert.deepEqual(requests, [OFFICIAL_VERSION_MANIFEST, versionUrl], 'verified game and resource files must not be downloaded again');
    assert.equal(await readFile(path.join(destination, 'options.txt'), 'utf8'), 'keep my controls');
  });
});
