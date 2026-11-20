import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeInstallManifest, ProgressTrackerMultiple, type InstallFile } from '@xmcl/installer';
import { createVanillaRuntime, withNetworkRetry } from '../arcane-launcher/src/main/services/vanilla-runtime';
import { resolveDownloadSources } from '../arcane-launcher/src/main/services/download-sources';

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-vanilla-runtime-'));
  try { await run(await realpath(directory)); }
  finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('shenbcl-vanilla-runtime-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const sha1 = (data: string) => createHash('sha1').update(data).digest('hex');
function file(root: string, name: string, data: string): InstallFile {
  return { path: path.join(root, name), urls: [`https://resources.download.minecraft.net/fixture/${name}`], size: Buffer.byteLength(data), checksum: { algorithm: 'sha1', value: sha1(data) } };
}

test('injected request downloads in bounded parallelism and reports verified file progress', async () => {
  await temporary(async root => {
    const tracker = new ProgressTrackerMultiple();
    const files = Array.from({ length: 5 }, (_, index) => file(root, `${index}.dat`, `content-${index}`));
    let active = 0;
    let maximum = 0;
    const runtime = createVanillaRuntime({ tracker, maxConcurrency: 2 }, async (input, init) => {
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal);
      const name = new URL(String(input)).pathname.split('/').at(-1)!;
      const data = `content-${name[0]}`;
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return new Response(data);
    });
    await runtime.download(files);
    assert.equal(maximum, 2);
    assert.equal(tracker.trackers.filter(item => item.done).length, 5);
    assert.equal(tracker.progress, files.reduce((sum, entry) => sum + entry.size!, 0));
    for (let index = 0; index < files.length; index++) assert.equal(await readFile(files[index].path, 'utf8'), `content-${index}`);
    assert.ok((await readdir(root)).every(name => !name.endsWith('.download')));
  });
});

test('a verified file is reused while same-size corrupt content is downloaded again', async () => {
  await temporary(async root => {
    const correct = file(root, 'correct.dat', 'good');
    const corrupt = file(root, 'corrupt.dat', 'good');
    await writeFile(correct.path, 'good');
    await writeFile(corrupt.path, 'evil');
    const requests: string[] = [];
    const transfers: Array<{ transferredBytes: number; currentFile: string }> = [];
    const runtime = createVanillaRuntime({}, async input => { requests.push(String(input)); return new Response('good'); }, {}, value => transfers.push(value));
    await runtime.download([correct, corrupt]);
    assert.deepEqual(requests, corrupt.urls);
    assert.equal(await readFile(corrupt.path, 'utf8'), 'good');
    assert.equal(transfers.at(-1)?.transferredBytes, 4, 'real transfers must exclude the reused four-byte file');
    assert.equal(transfers.at(-1)?.currentFile, corrupt.path);
  });
});

test('hash failures preserve existing files and remove temporary downloads', async () => {
  await temporary(async root => {
    const target = file(root, 'asset.dat', 'good');
    await writeFile(target.path, 'old!');
    let requests = 0;
    const runtime = createVanillaRuntime({}, async () => { requests++; return new Response('evil'); });
    await assert.rejects(runtime.download([target]), AggregateError);
    await assert.rejects(runtime.download([target]), AggregateError);
    assert.equal(requests, 2, 'each official/mirror source is tried only once after an integrity error');
    assert.equal(await readFile(target.path, 'utf8'), 'old!');
    assert.deepEqual(await readdir(root), ['asset.dat']);
  });
});

test('temporary HTTP statuses retry at most three times and honor a bounded Retry-After', async () => {
  for (const status of [408, 429, 500, 503]) {
    await temporary(async root => {
      let requests = 0;
      const delays: number[] = [];
      const runtime = createVanillaRuntime({}, async () => {
        requests++;
        return requests < 3 ? new Response('temporary', { status, headers: { 'retry-after': '60' } }) : new Response('good');
      }, { wait: async milliseconds => { delays.push(milliseconds); } });
      const target = file(root, 'asset.dat', 'good');
      await runtime.download([target]);
      assert.equal(requests, 3);
      assert.deepEqual(delays, [5000]);
      assert.equal(await readFile(target.path, 'utf8'), 'good');
    });
  }
});

test('transport and interrupted body failures retry without leaving partial files', async () => {
  await temporary(async root => {
    let requests = 0;
    const runtime = createVanillaRuntime({}, async () => {
      requests++;
      if (requests === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
      if (requests === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }));
      return new Response('good');
    }, { wait: async () => {} });
    await runtime.download([file(root, 'asset.dat', 'good')]);
    assert.equal(requests, 3);
    assert.deepEqual(await readdir(root), ['asset.dat']);
  });
});

test('Chromium truncated-body errors and body idle timeouts use the bounded retry path', async () => {
  for (const error of [new Error('net::ERR_CONTENT_LENGTH_MISMATCH'), new Error('net::ERR_INCOMPLETE_CHUNKED_ENCODING'), new DOMException('idle body', 'TimeoutError')]) {
    let attempts = 0;
    const result = await withNetworkRetry(async () => {
      attempts++;
      if (attempts < 3) throw error;
      return 'recovered';
    }, { wait: async () => {} });
    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  }
});

test('SDK retries do not multiply exhausted network budgets or retry permanent and integrity failures', async () => {
  for (const scenario of [
    { name: 'server', response: () => new Response('temporary', { status: 502 }), expected: 3 },
    { name: 'missing', response: () => new Response('missing', { status: 404 }), expected: 1 },
    { name: 'hash', response: () => new Response('evil'), expected: 1 },
    { name: 'size', response: () => new Response('larger'), expected: 1 },
  ]) {
    await temporary(async root => {
      let requests = 0;
      const runtime = createVanillaRuntime({}, async () => { requests++; return scenario.response(); }, { wait: async () => {} });
      await assert.rejects(executeInstallManifest({ schemaVersion: 1, tasks: [{ id: scenario.name, type: 'files', files: [file(root, 'asset.dat', 'good')] }] }, runtime, { attempts: 3, retryBaseDelay: 0, wait: async () => {} }));
      assert.equal(requests, scenario.expected * 2, `${scenario.name}: separate official and mirror budgets`);
      assert.deepEqual(await readdir(root), []);
    });
  }
});

test('cancellation during retry delay stops before making another request', async () => {
  await temporary(async root => {
    const controller = new AbortController();
    let requests = 0;
    const runtime = createVanillaRuntime({ signal: controller.signal }, async () => { requests++; return new Response('temporary', { status: 503 }); }, { wait: async (_delay, signal) => { assert.equal(signal, controller.signal); controller.abort(); } });
    await assert.rejects(runtime.download([file(root, 'asset.dat', 'good')]), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(requests, 2, 'official and mirror stop before the retry delay completes');
    assert.deepEqual(await readdir(root), []);
  });
});

test('cache checks share a bounded filesystem operation queue', async () => {
  await temporary(async root => {
    const target = file(root, 'asset.dat', 'good');
    await writeFile(target.path, 'good');
    let active = 0;
    let maximum = 0;
    const runtime = createVanillaRuntime({ maxConcurrency: 2, checksum: async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return target.checksum!.value;
    } }, async () => { throw new Error('Network must not run'); });
    await Promise.all(Array.from({ length: 30 }, () => runtime.checksum(target.path, 'sha1')));
    assert.equal(maximum, 2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const serial = createVanillaRuntime({ maxConcurrency: 1, checksum: async () => { started(); await gate; return target.checksum!.value; } }, async () => { throw new Error('Network must not run'); });
    const checksum = serial.checksum(target.path, 'sha1');
    await running;
    let statCompleted = false;
    const stat = serial.stat(target.path).then(result => { statCompleted = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(statCompleted, false, 'stat and checksum use the same queue');
    release();
    await Promise.all([checksum, stat]);
  });
});

test('cancellation after the request preserves existing content without publishing a partial file', async () => {
  await temporary(async root => {
    const target = file(root, 'asset.dat', 'good');
    await writeFile(target.path, 'old!');
    const controller = new AbortController();
    let requests = 0;
    const runtime = createVanillaRuntime({ signal: controller.signal }, async () => {
      requests++;
      const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('go')); controller.abort(); stream.close(); } });
      return new Response(body);
    });
    await assert.rejects(runtime.download([target]), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(requests, 1);
    assert.equal(await readFile(target.path, 'utf8'), 'old!');
    assert.deepEqual(await readdir(root), ['asset.dat']);
  });
});

test('redirects cannot send requests outside official Minecraft hosts', async () => {
  await temporary(async root => {
    const target = file(root, 'asset.dat', 'good');
    const requests: string[] = [];
    const runtime = createVanillaRuntime({}, async input => { requests.push(String(input)); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/private' } }); });
    await assert.rejects(runtime.download([target]), AggregateError);
    assert.deepEqual(requests, resolveDownloadSources(target.urls[0], 'asset'));
    assert.deepEqual(await readdir(root), []);
  });
});

test('file size and JSON validators are checked before replacing an existing file', async () => {
  await temporary(async root => {
    const target = file(root, 'metadata.json', 'true');
    target.checksum = undefined;
    target.validator = 'json';
    await writeFile(target.path, 'null');
    const runtime = createVanillaRuntime({}, async () => new Response('bad!'));
    await assert.rejects(runtime.download([target]), AggregateError);
    assert.equal(await readFile(target.path, 'utf8'), 'null');
    const short = createVanillaRuntime({}, async () => new Response('x'));
    await assert.rejects(short.download([target]), AggregateError);
    assert.equal(await readFile(target.path, 'utf8'), 'null');
  });
});

test('downloads and cached reads reject directory junctions and symbolic links', async () => {
  await temporary(async root => {
    const outside = path.join(root, 'outside'); await mkdir(outside);
    const link = path.join(root, 'link'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const runtime = createVanillaRuntime({}, async () => { throw new Error('Network must not run'); });
    const target = file(link, 'asset.dat', 'good');
    await assert.rejects(runtime.stat(target.path), /符号链接|目录联接/);
    await assert.rejects(runtime.download([target]), AggregateError);
    assert.deepEqual(await readdir(outside), []);
  });
});
