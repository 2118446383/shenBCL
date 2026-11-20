import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeModpack, installModpackFiles, validateModpackDownload, validateModpackPath, type ModpackFileProgress } from '../arcane-launcher/src/main/services/modpack';

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
interface ZipFixtureEntry { name: string | Buffer; content: string | Buffer; mode?: number; badCrc?: boolean; utf8?: boolean }
function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  let offset = 0;
  const locals: Buffer[] = []; const centrals: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const crc = entry.badCrc ? crc32(content) ^ 1 : crc32(content);
    const flags = entry.utf8 === false ? 0 : 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    const bytes = Buffer.concat([local, name, content]); locals.push(bytes); centrals.push(central, name); offset += bytes.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function index(files: unknown[] = [], extra: object = {}): string {
  return JSON.stringify({ formatVersion: 1, game: 'minecraft', name: '测试整合包', versionId: '3.3.6', dependencies: { minecraft: '1.21.1', neoforge: '21.1.262' }, files, ...extra });
}
function downloadFile(target = 'mods/example.jar', body: string | Buffer = 'verified-mod', downloads = ['https://cdn.modrinth.com/data/example/mod.jar']): object {
  return { path: target, hashes: { sha512: createHash('sha512').update(body).digest('hex') }, fileSize: Buffer.byteLength(body), downloads };
}
async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shenbcl-modpack-test-')));
  try { await run(directory); }
  finally {
    const relative = path.relative(await realpath(os.tmpdir()), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('shenbcl-modpack-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}
async function archive(directory: string, manifest: string, entries: ZipFixtureEntry[] = []): Promise<string> {
  const filename = path.join(directory, 'pack.zip');
  await writeFile(filename, zipFixture([{ name: 'modrinth.index.json', content: manifest }, ...entries]));
  return filename;
}

test('Modrinth preview reads real dependencies, client environments and override precedence', async () => {
  await temporary(async directory => {
    const filename = await archive(directory, index([
      downloadFile(),
      { ...downloadFile('mods/optional.jar'), env: { client: 'optional', server: 'unsupported' } },
      { ...downloadFile('mods/server.jar'), env: { client: 'unsupported', server: 'required' } },
    ]), [
      { name: 'overrides/config/example.toml', content: 'common' },
      { name: 'client-overrides/config/example.toml', content: 'client' },
      { name: 'server-overrides/config/server.toml', content: 'server-only' },
      { name: 'overrides/PCL/Setup.ini', content: 'not imported' },
      { name: 'overrides/mods/附带.jar', content: 'bundled' },
    ]);
    const result = await analyzeModpack(filename);
    assert.equal(result.name, '测试整合包'); assert.equal(result.minecraftVersion, '1.21.1');
    assert.equal(result.loader, 'neoforge'); assert.equal(result.loaderVersion, '21.1.262'); assert.equal(result.requiredJavaMajor, 21);
    assert.equal(result.fileCount, 2); assert.equal(result.overrideCount, 2); assert.equal(result.modCount, 3);
    assert.ok(result.warnings.some(text => text.includes('其他启动器'))); assert.ok(result.warnings.some(text => text.includes('可选')));
  });
});

test('legacy GBK ZIP names are decoded without losing Chinese filenames', async () => {
  await temporary(async directory => {
    const name = Buffer.concat([Buffer.from('overrides/mods/'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('.jar')]);
    const filename = await archive(directory, index(), [{ name, utf8: false, content: 'legacy' }]);
    const destination = path.join(directory, 'instance'); await mkdir(destination);
    await installModpackFiles({ archivePath: filename, destination });
    assert.equal(await readFile(path.join(destination, 'mods', '中文.jar'), 'utf8'), 'legacy');
  });
});

test('paths and ZIP entries reject traversal, device files, links and case collisions', async () => {
  for (const value of ['../evil', 'mods/../../evil', '/absolute', 'C:\\evil', 'mods/NUL.jar', 'mods/foo:bar', 'mods/a.', 'mods/a ', 'mods//a', 'mods/./a']) assert.throws(() => validateModpackPath(value), { code: 'INVALID_PACK' });
  assert.equal(validateModpackPath('mods/ leading-space.jar'), 'mods/ leading-space.jar');
  await temporary(async directory => {
    for (const entries of [
      [{ name: 'overrides/../outside.txt', content: 'bad' }],
      [{ name: 'overrides/mods/link.jar', content: 'outside', mode: 0xa1ff }],
      [{ name: 'overrides/mods/A.jar', content: 'a' }, { name: 'overrides/mods/a.jar', content: 'b' }],
      [{ name: 'overrides/versions/1.21.1/1.21.1.json', content: '{}' }],
      [{ name: 'overrides/.arcane-installation.json', content: '{}' }],
    ]) {
      const filename = await archive(directory, index(), entries);
      await assert.rejects(analyzeModpack(filename), { code: 'INVALID_PACK' });
    }
  });
});

test('manifest validation rejects bad hashes, untrusted URLs and overlapping file/directory paths', async () => {
  for (const value of ['http://cdn.modrinth.com/mod.jar', 'https://localhost/mod.jar', 'https://127.0.0.1/mod.jar', 'https://cdn.modrinth.com.evil.test/mod.jar', 'https://user:password@cdn.modrinth.com/mod.jar']) assert.throws(() => validateModpackDownload(value), { code: 'UNTRUSTED_DOWNLOAD' });
  await temporary(async directory => {
    for (const files of [
      [{ ...downloadFile(), hashes: { sha512: 'bad' } }],
      [{ ...downloadFile(), downloads: ['https://example.com/mod.jar'] }],
      [downloadFile('mods/a'), downloadFile('mods/a/b.jar')],
      [{ ...downloadFile(), fileSize: -1 }],
      [downloadFile(), downloadFile()],
    ]) {
      const filename = await archive(directory, index(files));
      await assert.rejects(analyzeModpack(filename));
    }
  });
});

test('downloads fall back to another source, publish only verified files, and reuse whole valid files', async () => {
  await temporary(async directory => {
    const content = 'verified-mod';
    const filename = await archive(directory, index([downloadFile('mods/example.jar', content, ['https://mediafilez.forgecdn.net/files/1/example.jar', 'https://cdn.modrinth.com/data/example/mod.jar'])]), [
      { name: 'overrides/config/example.toml', content: 'common' },
      { name: 'client-overrides/config/example.toml', content: 'client' },
      { name: 'server-overrides/config/server.toml', content: 'server' },
    ]);
    const destination = path.join(directory, 'instance'); await mkdir(destination);
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async url => { calls.push(String(url)); return new Response(calls.length === 1 ? 'wrong-content' : content); };
    const progress: ModpackFileProgress[] = [];
    const first = await installModpackFiles({ archivePath: filename, destination, fetch, onProgress: value => progress.push(value) });
    assert.equal(calls.length, 2); assert.equal(first.downloadedFiles, 1); assert.equal(first.overrideFiles, 1);
    assert.equal(await readFile(path.join(destination, 'mods/example.jar'), 'utf8'), content);
    assert.equal(await readFile(path.join(destination, 'config/example.toml'), 'utf8'), 'client');
    await assert.rejects(readFile(path.join(destination, 'config/server.toml')), { code: 'ENOENT' });
    assert.equal(progress.at(-1)?.transferredBytes, Buffer.byteLength('wrong-content') + Buffer.byteLength(content), 'received bytes include a failed body but exclude local override extraction');
    assert.ok(progress.some(item => item.phase === 'downloading' && item.phasePercent === 100 && item.phaseCompletedFiles === 1 && item.phaseTotalFiles === 1));
    assert.ok(progress.some(item => item.phase === 'extracting' && item.phasePercent === 100 && item.phaseCompletedBytes === 6 && item.phaseTotalBytes === 6));
    const reusedProgress: ModpackFileProgress[] = [];
    const second = await installModpackFiles({ archivePath: filename, destination, onProgress: value => reusedProgress.push(value), fetch: async () => { throw new Error('must not redownload'); } });
    assert.equal(second.reusedFiles, 1); assert.equal(second.downloadedFiles, 0);
    assert.equal(reusedProgress.at(-1)?.transferredBytes, 0, 'validated existing files are not newly downloaded bytes');
  });
});

test('redirects cannot reach local or untrusted hosts and failed hashes preserve the previous file', async () => {
  await temporary(async directory => {
    const filename = await archive(directory, index([downloadFile()]));
    const destination = path.join(directory, 'instance'); await mkdir(path.join(destination, 'mods'), { recursive: true });
    await writeFile(path.join(destination, 'mods/example.jar'), 'original');
    let calls = 0;
    await assert.rejects(installModpackFiles({ archivePath: filename, destination, fetch: async (_url, init) => {
      assert.equal(init?.redirect, 'manual'); calls++;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    } }), { code: 'DOWNLOAD_FAILED' });
    assert.equal(calls, 6, 'three bounded attempts across official and MCIM sources');
    assert.equal(await readFile(path.join(destination, 'mods/example.jar'), 'utf8'), 'original');
    await assert.rejects(installModpackFiles({ archivePath: filename, destination, fetch: async () => new Response('wrong-hash!!') }), { code: 'DOWNLOAD_FAILED' });
    assert.equal(await readFile(path.join(destination, 'mods/example.jar'), 'utf8'), 'original');
    assert.deepEqual(await readdir(path.join(destination, 'mods')), ['example.jar']);
  });
});

test('destination junctions and symbolic-link subdirectories never write outside the instance', async () => {
  await temporary(async directory => {
    const filename = await archive(directory, index(), [{ name: 'overrides/config/unsafe.txt', content: 'no' }]);
    const outside = path.join(directory, 'outside'); const destination = path.join(directory, 'instance');
    await mkdir(outside); await mkdir(destination);
    await symlink(outside, path.join(destination, 'config'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installModpackFiles({ archivePath: filename, destination }), { code: 'INVALID_PACK' });
    assert.deepEqual(await readdir(outside), []);
    const linked = path.join(directory, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installModpackFiles({ archivePath: filename, destination: linked }), { code: 'INVALID_PACK' });
  });
});

test('cancelled streaming downloads publish no partial target and remove temporary files', async () => {
  await temporary(async directory => {
    const filename = await archive(directory, index([downloadFile('mods/example.jar', 'partial-more')]));
    const destination = path.join(directory, 'instance'); await mkdir(destination);
    const controller = new AbortController();
    await assert.rejects(installModpackFiles({ archivePath: filename, destination, signal: controller.signal, fetch: async () => {
      const body = new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('partial')); setTimeout(() => controller.abort(), 20); } });
      return new Response(body);
    } }), { code: 'CANCELLED' });
    assert.deepEqual(await readdir(path.join(destination, 'mods')), []);
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(analyzeModpack(filename, { signal: preAborted.signal }), { code: 'CANCELLED' });
  });
});

test('ZIP CRC corruption never replaces an existing override file', async () => {
  await temporary(async directory => {
    const filename = await archive(directory, index(), [{ name: 'overrides/config/example.toml', content: 'damaged', badCrc: true }]);
    const destination = path.join(directory, 'instance'); await mkdir(path.join(destination, 'config'), { recursive: true });
    await writeFile(path.join(destination, 'config/example.toml'), 'original');
    await assert.rejects(installModpackFiles({ archivePath: filename, destination }), { code: 'HASH_MISMATCH' });
    assert.equal(await readFile(path.join(destination, 'config/example.toml'), 'utf8'), 'original');
    assert.deepEqual(await readdir(path.join(destination, 'config')), ['example.toml']);
  });
});
