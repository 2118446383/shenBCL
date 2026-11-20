import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { createNodeInstallRuntime, type InstallManifest } from '@xmcl/installer';
import { assertSafeLoaderManifest, installNeoForge, neoForgeVersionId, parseNeoForgeInstallerModule, validateLoaderDownloadUrl, type LoaderInstallProgress } from '../arcane-launcher/src/main/services/loader-installer';

const { ZipFile } = createRequire(import.meta.url)('yazl') as { ZipFile: new () => { addBuffer(bytes: Buffer, name: string): void; end(): void; outputStream: Readable } };
const mc = '1.21.1';
const neo = '21.1.262';
const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neo}/neoforge-${neo}-installer.jar`;
const libraryRelative = `net/neoforged/neoforge/${neo}/neoforge-${neo}.jar`;

async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-loader-test-'));
  try { await run(await realpath(directory)); }
  finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('shenbcl-loader-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

async function zip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => { archive.outputStream.once('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.once('error', reject); });
  for (const [name, bytes] of Object.entries(entries)) archive.addBuffer(Buffer.from(bytes), name);
  archive.end();
  return done;
}

const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');

async function vanilla(root: string): Promise<void> {
  await mkdir(path.join(root, 'versions', mc), { recursive: true });
  await writeFile(path.join(root, 'versions', mc, `${mc}.json`), JSON.stringify({ id: mc, mainClass: 'net.minecraft.client.main.Main', libraries: [], javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }, arguments: { game: [], jvm: [] } }));
  await writeFile(path.join(root, 'versions', mc, `${mc}.jar`), await zip({ 'fixture.txt': 'fixture-not-executed' }));
}

function fakeJava(root: string, major = 21) {
  return { id: 'fixture-java', path: path.join(root, 'java.exe'), source: 'fixture', major, version: `${major}.0.1`, vendor: 'fixture', architecture: 'amd64' };
}

async function fixture(withProcessor = false, modern = false, modernLoaderVersion = neo) {
  const library = await zip({ 'fixture.txt': 'NeoForge fixture, not executed' });
  const runtimeName = modern ? 'net.neoforged.fancymodloader:loader:4.0.45' : `net.neoforged:neoforge:${neo}`;
  const runtimePath = modern ? 'net/neoforged/fancymodloader/loader/4.0.45/loader-4.0.45.jar' : libraryRelative;
  const processor = await zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nMain-Class: fixture.Processor\r\n\r\n' });
  const processorPath = 'net/neoforged/fixture/1.0/fixture-1.0.jar';
  const profile = { spec: 1, profile: 'NeoForge', version: 'neoforge-original-id', minecraft: mc, json: '/version.json', path: `net.neoforged:neoforge:${neo}`, processors: withProcessor ? [{ jar: 'net.neoforged:fixture:1.0', classpath: [], args: ['--output', '{ROOT}/libraries/generated/client.jar'], outputs: { '{ROOT}/libraries/generated/client.jar': sha1(library) } }] : [], libraries: withProcessor ? [{ name: 'net.neoforged:fixture:1.0', downloads: { artifact: { path: processorPath, url: `https://maven.neoforged.net/releases/${processorPath}`, sha1: sha1(processor), size: processor.length } } }] : [] };
  const installer = await zip({
    'install_profile.json': JSON.stringify(profile),
    'version.json': JSON.stringify({ id: 'neoforge-original-id', inheritsFrom: mc, mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: runtimeName, downloads: { artifact: { path: runtimePath, url: `https://maven.neoforged.net/releases/${runtimePath}`, sha1: sha1(library), size: library.length } } }], arguments: { game: modern ? ['--fml.neoForgeVersion', modernLoaderVersion, '--fml.fmlVersion', '4.0.45', '--fml.mcVersion', mc, '--launchTarget', 'forgeclient'] : [], jvm: [] } }),
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'manual');
    if (url === `${installerUrl}.sha1`) return new Response(sha1(installer));
    if (url === installerUrl && init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(installer.length) } });
    if (url === installerUrl) return new Response(new Uint8Array(installer));
    if (url === `https://maven.neoforged.net/releases/${runtimePath}`) return new Response(new Uint8Array(library));
    if (url === `https://maven.neoforged.net/releases/${processorPath}`) return new Response(new Uint8Array(processor));
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { fetch, library, installer };
}

test('NeoForge versions must match Minecraft and cannot carry paths', () => {
  assert.equal(neoForgeVersionId(mc, neo), '1.21.1-neoforge-21.1.262');
  assert.equal(neoForgeVersionId('1.21', '21.0.10-beta'), '1.21-neoforge-21.0.10-beta');
  for (const [minecraft, loader] of [['1.20.1', neo], [mc, '../21.1.262'], [mc, '21.1.262:stream'], ['../../escape', neo]]) assert.throws(() => neoForgeVersionId(minecraft, loader), { code: 'INVALID_VERSION' });
});

test('Gradle module checksum metadata must identify the exact NeoForge installer', () => {
  const metadata = { component: { group: 'net.neoforged', module: 'neoforge', version: neo }, variants: [{ name: 'installerJar', files: [{ name: `neoforge-${neo}-installer.jar`, url: `neoforge-${neo}-installer.jar`, size: 1234, sha1: 'a'.repeat(40) }] }] };
  assert.deepEqual(parseNeoForgeInstallerModule(metadata, neo), { sha1: 'a'.repeat(40), size: 1234 });
  assert.throws(() => parseNeoForgeInstallerModule(metadata, '21.1.261'), /坐标或版本/);
  assert.throws(() => parseNeoForgeInstallerModule({ ...metadata, component: { ...metadata.component, group: 'untrusted' } }, neo), /坐标或版本/);
  for (const replacement of [{ sha1: '' }, { size: -1 }, { url: '../another.jar' }, { name: 'another.jar' }]) {
    const changed = structuredClone(metadata); Object.assign(changed.variants[0].files[0], replacement);
    assert.throws(() => parseNeoForgeInstallerModule(changed, neo), /哈希或大小/);
  }
});

test('published Gradle module digests preserve checksum enforcement when mirrored sidecars are missing', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    const mirroredModule = `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neo}/neoforge-${neo}.module`;
    let moduleReads = 0;
    const result = await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input).endsWith('.sha1')) return new Response('not mirrored', { status: 404 });
        if (String(input).endsWith('.module')) {
          if (String(input) !== mirroredModule) return new Response('origin unreachable', { status: 503 });
          moduleReads++;
          return Response.json({ component: { group: 'net.neoforged', module: 'neoforge', version: neo }, variants: [{ name: 'installerJar', files: [{ name: `neoforge-${neo}-installer.jar`, url: `neoforge-${neo}-installer.jar`, size: data.installer.length, sha1: sha1(data.installer) }] }] });
        }
        return data.fetch(input, init);
      },
    });
    assert.equal(moduleReads, 1);
    assert.equal(result.versionId, neoForgeVersionId(mc, neo));
  });
});

test('loader URLs reject arbitrary and private destinations', () => {
  assert.equal(validateLoaderDownloadUrl(installerUrl), installerUrl);
  for (const url of ['http://maven.neoforged.net/file', 'https://127.0.0.1/a', 'https://maven.neoforged.net.evil.test/a', 'https://user:secret@maven.neoforged.net/a', 'https://maven.neoforged.net:8443/a']) assert.throws(() => validateLoaderDownloadUrl(url), { code: 'UNTRUSTED_DOWNLOAD' });
});

test('pre-cancelled loader installation creates no files or requests', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installNeoForge({ destination: 'unused', minecraftVersion: mc, loaderVersion: neo, javaPath: 'unused', signal: controller.signal }, { fetch: async () => { throw new Error('Network must not run'); } }), { code: 'CANCELLED' });
});

test('mismatched Java stops before requesting the NeoForge installer', async () => {
  await temporary(async root => {
    await vanilla(root);
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, { probeJava: async () => fakeJava(root, 17), fetch: async () => { throw new Error('Network must not run'); } }), { code: 'JAVA_REQUIRED' });
  });
});

test('SDK stages cannot write outside the instance, follow junctions, or launch other executables', async () => {
  await temporary(async root => {
    const id = neoForgeVersionId(mc, neo);
    const javaPath = path.join(root, 'java.exe');
    const invalid: InstallManifest = { schemaVersion: 1, tasks: [{ id: 'escape', type: 'materialize', operations: [{ type: 'write', path: path.join(root, '..', 'outside.txt'), content: 'no' }], outputs: [] }] };
    await assert.rejects(assertSafeLoaderManifest(invalid, root, javaPath, id, mc), { code: 'UNSAFE_INSTALL_PLAN' });
    const alienJava: InstallManifest = { schemaVersion: 1, tasks: [{ id: 'alien', type: 'java', strategies: [[{ executable: 'cmd.exe', args: ['/c', 'no'] }]], outputs: [] }] };
    await assert.rejects(assertSafeLoaderManifest(alienJava, root, javaPath, id, mc), { code: 'UNSAFE_INSTALL_PLAN' });
    const outside = path.join(root, 'outside'); await mkdir(outside);
    const link = path.join(root, 'link'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const redirect: InstallManifest = { schemaVersion: 1, tasks: [{ id: 'junction', type: 'files', files: [{ path: path.join(link, 'file.jar'), urls: [installerUrl] }] }] };
    await assert.rejects(assertSafeLoaderManifest(redirect, root, javaPath, id, mc), { code: 'UNSAFE_INSTALL_PLAN' });
  });
});

test('real XMCL NeoForge workflow downloads, materializes and validates a client fixture', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    const phases: string[] = [];
    const result = await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture', onProgress: value => phases.push(value.phase) }, { fetch: data.fetch, probeJava: async () => fakeJava(root) });
    assert.equal(result.versionId, neoForgeVersionId(mc, neo));
    const metadata = JSON.parse(await readFile(path.join(root, 'versions', result.versionId, `${result.versionId}.json`), 'utf8'));
    assert.equal(metadata.id, result.versionId);
    assert.equal(metadata.inheritsFrom, mc);
    assert.deepEqual(await readFile(path.join(root, 'libraries', libraryRelative)), data.library);
    assert.ok(phases.includes('materialize'));
    assert.ok(phases.includes('processors'));
    assert.equal(phases.at(-1), 'complete');
  });
});

test('modern NeoForge FML layout installs without a net.neoforged:neoforge runtime library', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture(false, true);
    const result = await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, { fetch: data.fetch, probeJava: async () => fakeJava(root) });
    assert.equal(result.loaderVersion, neo);
    const metadata = JSON.parse(await readFile(path.join(root, 'versions', result.versionId, `${result.versionId}.json`), 'utf8'));
    assert.ok(metadata.libraries.every((library: { name: string }) => !library.name.startsWith('net.neoforged:neoforge:')));
    assert.deepEqual(await readFile(path.join(root, 'libraries/net/neoforged/fancymodloader/loader/4.0.45/loader-4.0.45.jar')), data.library);
  });
});

test('a modern NeoForge client declaring a different loader version is rejected', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture(false, true, '21.1.261');
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, { fetch: data.fetch, probeJava: async () => fakeJava(root) }), { code: 'INVALID_VERSION' });
  });
});

test('official installer checksum is mandatory and failed validation is not published', async () => {
  await temporary(async root => {
    await vanilla(root);
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, { probeJava: async () => fakeJava(root), fetch: async () => new Response('unavailable', { status: 404 }) }), { code: 'UNTRUSTED_DOWNLOAD' });
    await assert.rejects(readFile(path.join(root, 'versions', neoForgeVersionId(mc, neo), `${neoForgeVersionId(mc, neo)}.json`)), { code: 'ENOENT' });
  });
});

test('real workflow resolves a client processor and checks its generated output', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture(true);
    let processors = 0;
    const progress: LoaderInstallProgress[] = [];
    await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture', onProgress: value => progress.push(value) }, {
      fetch: data.fetch,
      probeJava: async () => fakeJava(root),
      createRuntime: options => createNodeInstallRuntime({ ...options, runJava: async command => {
        processors++;
        assert.equal(command.executable, fakeJava(root).path);
        assert.equal(command.args[0], '-cp');
        assert.equal(command.args[2], 'fixture.Processor');
        const output = command.args[command.args.indexOf('--output') + 1];
        assert.equal(path.resolve(output), path.join(root, 'libraries', 'generated', 'client.jar'));
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, data.library);
      } }),
    });
    assert.equal(processors, 1);
    assert.ok(progress.some(item => item.stepId === 'processors' && item.phasePercent === 100 && item.completedTasks === item.totalTasks && item.completedTasks! > 0), 'processor progress comes from real completed SDK tasks');
    assert.ok(progress.some(item => item.stepId === 'runtime-libraries' && item.phasePercent === 100));
    assert.ok(Math.max(...progress.map(item => item.transferredBytes ?? 0)) > data.library.length, 'installer and processor libraries contribute actual received bytes');
    assert.deepEqual(await readFile(path.join(root, 'libraries', 'generated', 'client.jar')), data.library);
  });
});

test('cancelling an installer download leaves no published loader metadata', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    const controller = new AbortController();
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture', signal: controller.signal }, {
      probeJava: async () => fakeJava(root),
      fetch: async (input, init) => {
        if (String(input) === installerUrl && init?.method !== 'HEAD') {
          controller.abort();
          throw new DOMException('fixture cancellation', 'AbortError');
        }
        return data.fetch(input, init);
      },
    }), { code: 'CANCELLED' });
    const id = neoForgeVersionId(mc, neo);
    await assert.rejects(readFile(path.join(root, 'versions', id, `${id}.json`)), { code: 'ENOENT' });
  });
});

test('metadata redirects cannot escape the official host list', async () => {
  await temporary(async root => {
    await vanilla(root);
    const requests: string[] = [];
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, { probeJava: async () => fakeJava(root), fetch: async input => { requests.push(String(input)); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); } }), { code: 'UNTRUSTED_DOWNLOAD' });
    assert.ok(requests.length > 0);
    assert.ok(requests.every(url => url.startsWith('https://maven.neoforged.net/') || url.startsWith('https://bmclapi2.bangbang93.com/')));
  });
});

test('NeoForge checksum and HEAD metadata retry temporary failures within a three-attempt budget', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    let checksumRequests = 0;
    let headRequests = 0;
    await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input) === `${installerUrl}.sha1` && ++checksumRequests < 3) return new Response('temporary', { status: 503 });
        if (String(input) === installerUrl && init?.method === 'HEAD' && ++headRequests < 3) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        return data.fetch(input, init);
      },
    });
    assert.equal(checksumRequests, 3);
    assert.equal(headRequests, 3);
  });
});

test('an interrupted checksum body retries while a permanently unavailable checksum stops at its budget', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    let attempts = 0;
    await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input) === `${installerUrl}.sha1` && ++attempts === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }));
        return data.fetch(input, init);
      },
    });
    assert.equal(attempts, 2);
  });
  await temporary(async root => {
    await vanilla(root);
    let attempts = 0;
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async input => { if (String(input).endsWith('.sha1')) attempts++; return new Response('temporary', { status: 502 }); },
    }), error => {
      assert.equal((error as { code?: string }).code, 'UNTRUSTED_DOWNLOAD');
      assert.match((error as Error).message, /HTTP 502/);
      assert.match(((error as Error).cause as Error).message, /HTTP 502/);
      return true;
    });
    assert.equal(attempts, 6, 'official and mirror each have three attempts');
  });
});

test('cancelling NeoForge metadata retry remains cancellation after the SDK resolver catches fetch errors', async () => {
  await temporary(async root => {
    await vanilla(root);
    const controller = new AbortController();
    let checksumRequests = 0;
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture', signal: controller.signal }, {
      probeJava: async () => fakeJava(root),
      retryWait: async () => { controller.abort(); },
      fetch: async input => { if (String(input).endsWith('.sha1')) checksumRequests++; return new Response('temporary', { status: 503 }); },
    }), { code: 'CANCELLED' });
    assert.equal(checksumRequests, 2, 'official and mirror stop before their next attempt');
  });
});

test('NeoForge installer transfers retry temporary HTTP failures without multiplying SDK retry attempts', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    let downloads = 0;
    await installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input) === installerUrl && init?.method !== 'HEAD' && ++downloads < 3) return new Response('temporary', { status: 429 });
        return data.fetch(input, init);
      },
    });
    assert.equal(downloads, 3);
  });
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    let downloads = 0;
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input) === installerUrl && init?.method !== 'HEAD') { downloads++; return new Response('temporary', { status: 503 }); }
        return data.fetch(input, init);
      },
    }), { code: 'INSTALL_FAILED' });
    assert.equal(downloads, 3);
  });
});

test('NeoForge checksum mismatches do not repeat an identical corrupt download', async () => {
  await temporary(async root => {
    await vanilla(root);
    const data = await fixture();
    let downloads = 0;
    const corrupt = Buffer.from(data.installer); corrupt[0] ^= 1;
    await assert.rejects(installNeoForge({ destination: root, minecraftVersion: mc, loaderVersion: neo, javaPath: 'fixture' }, {
      probeJava: async () => fakeJava(root), retryWait: async () => {},
      fetch: async (input, init) => {
        if (String(input) === installerUrl && init?.method !== 'HEAD') { downloads++; return new Response(new Uint8Array(corrupt)); }
        return data.fetch(input, init);
      },
    }), { code: 'INSTALL_FAILED' });
    assert.equal(downloads, 1);
  });
});
