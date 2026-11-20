import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogService } from '../arcane-launcher/src/main/services/catalog';

const bytes = Buffer.from('verified-jar-fixture');
const checksum = createHash('sha512').update(bytes).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const file = (extra: Record<string, unknown> = {}) => ({ filename: 'example-1.0.jar', url: 'https://cdn.modrinth.com/data/ProjectA/versions/VersionA/example.jar', size: bytes.length, hashes: { sha512: checksum }, primary: true, ...extra });
const version = (extra: Record<string, unknown> = {}) => ({ id: 'VersionA', project_id: 'ProjectA', name: 'Example 1.0', version_number: '1.0', version_type: 'release', date_published: '2026-01-02T00:00:00Z', game_versions: ['1.20.1'], loaders: ['fabric'], files: [file()], dependencies: [], ...extra });
const project = (id = 'ProjectA', type = 'mod') => ({ id, project_type: type, client_side: 'optional' });
const filters = { type: 'mod' as const, minecraftVersion: '1.20.1', loader: 'fabric' };

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenbcl-catalog-'));
  try { await run(root); }
  finally { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('shenbcl-catalog-')); await rm(root, { recursive: true, force: true }); }
}

function fixture(options: { versions?: unknown[]; download?: (init?: RequestInit, url?: string) => Response | Promise<Response>; type?: 'mod' | 'modpack' } = {}) {
  const calls: string[] = [];
  const service = new CatalogService({ fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push(url.href);
    assert.equal(init?.redirect, 'manual');
    assert.match(new Headers(init?.headers).get('User-Agent') ?? '', /shenBCL/);
    if (url.pathname === '/v2/project/ProjectA') return json(project('ProjectA', options.type));
    if (url.pathname === '/v2/project/ProjectA/version') return json(options.versions ?? [version()]);
    if (url.hostname === 'cdn.modrinth.com' || url.hostname === 'mod.mcimirror.top' && url.pathname.startsWith('/data/')) return options.download?.(init, url.href) ?? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
    throw new Error(`Unexpected request ${url}`);
  } });
  return { service, calls };
}

test('official Minecraft catalog includes releases and snapshots without exposing remote URLs', async () => {
  let requests = 0;
  const service = new CatalogService({ fetch: async input => {
    requests++;
    assert.equal(String(input), 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    return json({ versions: [
      { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T00:00:00Z', url: 'https://official/file' },
      { id: '24w14a', type: 'snapshot', releaseTime: '2024-04-03T00:00:00Z' },
      { id: '../escape', type: 'release', releaseTime: '2024-04-03T00:00:00Z' },
      { id: 'invalid', type: 'unexpected', releaseTime: 'yesterday' },
    ] });
  } });
  const first = await service.minecraftVersions();
  assert.deepEqual(first.map(item => item.id), ['1.21.1', '24w14a']);
  assert.equal(first[1].type, 'snapshot');
  assert.doesNotMatch(JSON.stringify(first), /https:|url/);
  first[0].id = 'changed-by-caller';
  assert.equal((await service.minecraftVersions())[0].id, '1.21.1');
  assert.equal(requests, 1);
});

test('Modrinth search sends explicit client, game, and loader facets and returns bounded public data', async () => {
  const service = new CatalogService({ fetch: async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.modrinth.com');
    assert.equal(url.pathname, '/v2/search');
    assert.equal(url.searchParams.get('query'), 'Sodium');
    assert.equal(url.searchParams.get('offset'), '20');
    const facets = JSON.parse(url.searchParams.get('facets')!);
    assert.ok(facets.some((row: string[]) => row.includes('versions:1.20.1')));
    assert.ok(facets.some((row: string[]) => row.includes('categories:fabric')));
    assert.ok(facets.some((row: string[]) => row.includes('client_side:optional')));
    return json({ total_hits: 45, hits: [
      { project_id: 'ProjectA', slug: 'example-mod', project_type: 'mod', title: 'Example', description: 'A useful mod', author: 'Author', downloads: 5000, url: 'https://untrusted.example/' },
      { project_id: '../escape', slug: 'bad', project_type: 'mod' },
      { project_id: 'WrongType', slug: 'pack', project_type: 'modpack' },
    ] });
  } });
  const result = await service.search({ ...filters, query: ' Sodium ', offset: 20 });
  assert.equal(result.hits.length, 1); assert.equal(result.total, 45); assert.equal(result.offset, 20);
  assert.equal(result.hits[0].title, 'Example');
  assert.doesNotMatch(JSON.stringify(result), /https:|url/);
  await assert.rejects(service.search({ ...filters, query: '', loader: 'unknown-loader' }), /加载器/);
});

test('only compatible versions with validated CDN, filename, size, and hashes receive opaque tickets', async () => {
  const f = fixture({ versions: [
    version({ files: [file(), file({ filename: '../evil.jar' }), file({ filename: 'CON.jar' }), file({ url: 'https://evil.test/secret.jar' }), file({ hashes: {} }), file({ size: 4 * 1024 ** 3 })] }),
    version({ id: 'ForgeVersion', loaders: ['forge'] }),
    version({ id: 'OtherProject', project_id: 'ProjectB' }),
  ] });
  const items = await f.service.versions('ProjectA', filters);
  assert.equal(items.length, 1); assert.equal(items[0].files.length, 1);
  assert.match(items[0].files[0].ticket, /^[a-f\d-]{36}$/);
  assert.doesNotMatch(JSON.stringify(items), /https:|sha512/);
  assert.equal(f.service.ticket(items[0].files[0].ticket).sha512, checksum);
  assert.throws(() => f.service.ticket('not-a-ticket'), /已过期/);
});

test('verified catalog download uses content-addressed cache and reuses only a matching hash', async () => {
  await temporary(async root => {
    const f = fixture();
    const [item] = await f.service.versions('ProjectA', filters);
    const ticket = item.files[0].ticket;
    const downloaded = await f.service.download(ticket, path.join(root, 'cache'));
    assert.deepEqual(await readFile(downloaded.path), bytes);
    assert.equal(downloaded.filename, 'example-1.0.jar');
    assert.equal(path.basename(downloaded.path), `${checksum}.jar`);
    const count = f.calls.length;
    const reused = await f.service.download(ticket, path.join(root, 'cache'));
    assert.equal(reused.path, downloaded.path); assert.equal(f.calls.length, count);
    await writeFile(downloaded.path, Buffer.alloc(bytes.length));
    await f.service.download(ticket, path.join(root, 'cache'));
    assert.equal(f.calls.length, count + 1);
    assert.deepEqual(await readFile(downloaded.path), bytes);
    assert.deepEqual(await readdir(path.join(root, 'cache')), [`${checksum}.jar`]);
  });
});

test('a mismatching file is never published and partial downloads are removed', async () => {
  await temporary(async root => {
    const f = fixture({ download: () => new Response(Buffer.alloc(bytes.length), { headers: { 'Content-Length': String(bytes.length) } }) });
    const [item] = await f.service.versions('ProjectA', filters);
    await assert.rejects(f.service.download(item.files[0].ticket, root), /校验失败/);
    assert.deepEqual(await readdir(root), []);
    assert.equal(f.calls.filter(url => new URL(url).pathname.startsWith('/data/')).length, 2, 'each corrupt source is excluded for the rest of this download');
    const wrongSize = fixture({ download: () => new Response(bytes, { headers: { 'Content-Length': String(bytes.length + 1) } }) });
    const [other] = await wrongSize.service.versions('ProjectA', filters);
    await assert.rejects(wrongSize.service.download(other.files[0].ticket, root), /大小/);
    assert.deepEqual(await readdir(root), []);
  });
});

test('download cancellation removes the partial file and cannot publish a completed result', async () => {
  await temporary(async root => {
    const controller = new AbortController();
    const f = fixture();
    const [item] = await f.service.versions('ProjectA', filters);
    await assert.rejects(f.service.download(item.files[0].ticket, root, { signal: controller.signal, onProgress: () => controller.abort() }), /取消/);
    assert.deepEqual(await readdir(root), []);
  });
});

test('cache destinations that are directories are refused without changing them', async () => {
  await temporary(async root => {
    await mkdir(path.join(root, `${checksum}.jar`));
    await writeFile(path.join(root, `${checksum}.jar`, 'keep.txt'), 'keep');
    const f = fixture(); const [item] = await f.service.versions('ProjectA', filters);
    await assert.rejects(f.service.download(item.files[0].ticket, root), /普通文件/);
    assert.equal(await readFile(path.join(root, `${checksum}.jar`, 'keep.txt'), 'utf8'), 'keep');
    assert.ok(!f.calls.some(url => url.startsWith('https://cdn.modrinth.com')));
  });
});

test('required dependency closure follows pinned versions and de-duplicates shared projects', async () => {
  const all = {
    MainVersion: version({ id: 'MainVersion', project_id: 'Main', dependencies: [{ dependency_type: 'required', project_id: 'Api', version_id: 'ApiVersion' }, { dependency_type: 'optional', project_id: 'Optional' }] }),
    ApiVersion: version({ id: 'ApiVersion', project_id: 'Api', dependencies: [{ dependency_type: 'required', project_id: 'Common' }] }),
    CommonVersion: version({ id: 'CommonVersion', project_id: 'Common', dependencies: [{ dependency_type: 'required', project_id: 'Api', version_id: 'ApiVersion' }] }),
  };
  const service = new CatalogService({ fetch: async input => {
    const parts = new URL(String(input)).pathname.split('/').filter(Boolean);
    if (parts[1] === 'version') return json(all[parts[2] as keyof typeof all]);
    if (parts.length === 3) return json(project(parts[2]));
    return json(Object.values(all).filter(item => item.project_id === parts[2]));
  } });
  const [main] = await service.versions('Main', filters);
  assert.equal(main.requiredDependencies, 1, 'optional dependencies are not automatic');
  const closure = await service.resolveModDependencies(main.files[0].ticket, { minecraftVersion: '1.20.1', loader: 'fabric' });
  assert.deepEqual(closure.map(item => item.projectId), ['Common', 'Api', 'Main']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.resolveModDependencies(main.files[0].ticket, { minecraftVersion: '1.20.1', loader: 'fabric' }, { signal: controller.signal }), /abort/i);
});

test('incompatible required dependencies stop installation instead of silently omitting them', async () => {
  const service = new CatalogService({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/project/ProjectA') return json(project());
    if (url.pathname === '/v2/project/ProjectA/version') return json([version({ dependencies: [{ dependency_type: 'required', project_id: 'Api', version_id: 'ApiVersion' }] })]);
    if (url.pathname === '/v2/project/Api') return json(project('Api'));
    if (url.pathname === '/v2/version/ApiVersion') return json(version({ id: 'ApiVersion', project_id: 'Api', game_versions: ['1.21.1'] }));
    throw new Error('unexpected request');
  } });
  const [main] = await service.versions('ProjectA', filters);
  await assert.rejects(service.resolveModDependencies(main.files[0].ticket, { minecraftVersion: '1.20.1', loader: 'fabric' }), /兼容/);
  await assert.rejects(service.resolveModDependencies(main.files[0].ticket, { minecraftVersion: '1.20.1', loader: 'forge' }), /不兼容/);
});

test('modpack catalog accepts MRPACK and rejects server-only projects', async () => {
  const f = fixture({ type: 'modpack', versions: [version({ files: [file({ filename: 'Example.mrpack' }), file({ filename: 'server.zip' })] })] });
  const [item] = await f.service.versions('ProjectA', { type: 'modpack' });
  assert.equal(item.files.length, 1); assert.equal(f.service.ticket(item.files[0].ticket).type, 'modpack');
  const unsupported = new CatalogService({ fetch: async input => String(input).includes('/version?') ? json([version()]) : json({ ...project(), client_side: 'unsupported' }) });
  await assert.rejects(unsupported.versions('ProjectA', filters), /不支持/);
});

test('rate-limited or excessively large metadata produces actionable errors', async () => {
  const limited = new CatalogService({ fetch: async () => json({}, 429) });
  await assert.rejects(limited.search({ type: 'mod', query: '' }), /过于频繁/);
  const huge = new CatalogService({ fetch: async () => new Response('{}', { headers: { 'Content-Length': String(10 * 1024 ** 2) } }) });
  await assert.rejects(huge.minecraftVersions(), /过大/);
});

test('an unmarked response cannot claim an arbitrary redirected metadata origin', async () => {
  const service = new CatalogService({ fetch: async () => {
    const response = json({ versions: [] });
    Object.defineProperty(response, 'url', { value: 'https://untrusted.example/metadata.json' });
    return response;
  } });
  await assert.rejects(service.minecraftVersions(), /重定向检查/);
});

test('catalog metadata uses one source-selection layer and fails over from invalid JSON', async () => {
  const calls: string[] = [];
  const service = new CatalogService({ fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return calls.length === 1 ? new Response('<html>upstream error</html>') : json({ hits: [], total_hits: 0 });
  } });
  assert.equal((await service.search({ type: 'mod', query: 'example' })).total, 0);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).origin, 'https://api.modrinth.com');
  assert.equal(new URL(calls[1]).origin, 'https://mod.mcimirror.top');
  assert.equal(new URL(calls[1]).pathname, '/modrinth/v2/search');
});

for (const kind of ['hash', 'short-body', 'oversized-body', 'wrong-length-header', 'disconnected-body'] as const) {
  test(`a ${kind} source is cleaned up and replaced by a verified mirror`, async () => {
    await temporary(async root => {
      const requests: string[] = [];
      const f = fixture({ download: async (_init, url) => {
        requests.push(url!);
        if (new URL(url!).hostname === 'mod.mcimirror.top') {
          assert.deepEqual(await readdir(root), [], 'failed attempt must be cleaned before changing sources');
          return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
        }
        if (kind === 'hash') return new Response(Buffer.alloc(bytes.length));
        if (kind === 'short-body') return new Response(bytes.subarray(0, 4));
        if (kind === 'oversized-body') return new Response(Buffer.concat([bytes, Buffer.from('x')]));
        if (kind === 'wrong-length-header') return new Response(bytes, { headers: { 'Content-Length': String(bytes.length + 1) } });
        let part = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!part++) controller.enqueue(bytes.subarray(0, 4));
            else controller.error(new Error('fixture connection reset'));
          },
        }, { highWaterMark: 0 }));
      } });
      const [item] = await f.service.versions('ProjectA', filters);
      const result = await f.service.download(item.files[0].ticket, root);
      assert.deepEqual(requests.map(url => new URL(url).hostname), ['cdn.modrinth.com', 'mod.mcimirror.top']);
      assert.deepEqual(await readFile(result.path), bytes);
      assert.deepEqual(await readdir(root), [`${checksum}.jar`]);
    });
  });
}

test('transport errors stop after bounded rounds without leaving cache files', async () => {
  await temporary(async root => {
    const f = fixture({ download: () => { throw new Error('fixture transport unavailable'); } });
    const [item] = await f.service.versions('ProjectA', filters);
    await assert.rejects(f.service.download(item.files[0].ticket, root), /重试后仍失败.*连接失败/);
    assert.equal(f.calls.filter(url => new URL(url).pathname.startsWith('/data/')).length, 6, 'three rounds with two sources per round');
    assert.deepEqual(await readdir(root), []);
  });
});

test('cancellation interrupts a stalled response body and never starts a mirror', { timeout: 2000 }, async () => {
  await temporary(async root => {
    const controller = new AbortController();
    let ready!: () => void;
    const reading = new Promise<void>(resolve => { ready = resolve; });
    let parts = 0, cancelled = false;
    const f = fixture({ download: () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (!parts++) { stream.enqueue(bytes.subarray(0, 4)); return; }
        ready();
        return new Promise<void>(() => {}); // Transport intentionally ignores the request signal.
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 })) });
    const [item] = await f.service.versions('ProjectA', filters);
    const downloading = f.service.download(item.files[0].ticket, root, { signal: controller.signal });
    await reading;
    controller.abort();
    await assert.rejects(downloading, /取消/);
    assert.equal(cancelled, true);
    assert.equal(f.calls.filter(url => new URL(url).pathname.startsWith('/data/')).length, 1);
    assert.deepEqual(await readdir(root), []);
  });
});

test('cancellation during retry backoff prevents the next source request', { timeout: 2000 }, async () => {
  await temporary(async root => {
    const controller = new AbortController();
    let scheduled = false;
    const f = fixture({ download: () => new Response(Buffer.alloc(bytes.length)) });
    const [item] = await f.service.versions('ProjectA', filters);
    await assert.rejects(f.service.download(item.files[0].ticket, root, {
      signal: controller.signal,
      onProgress: () => { if (!scheduled) { scheduled = true; setTimeout(() => controller.abort(), 30); } },
    }), /取消/);
    assert.equal(f.calls.filter(url => new URL(url).pathname.startsWith('/data/')).length, 1);
    assert.deepEqual(await readdir(root), []);
  });
});

test('a cancelled cache reuse cannot return a completed result or request the network', async () => {
  await temporary(async root => {
    const f = fixture();
    const [item] = await f.service.versions('ProjectA', filters);
    await writeFile(path.join(root, `${checksum}.jar`), bytes);
    const controller = new AbortController();
    await assert.rejects(f.service.download(item.files[0].ticket, root, { signal: controller.signal, onProgress: () => controller.abort() }), /取消/);
    assert.equal(f.calls.filter(url => new URL(url).pathname.startsWith('/data/')).length, 0);
    assert.deepEqual(await readFile(path.join(root, `${checksum}.jar`)), bytes);
  });
});
