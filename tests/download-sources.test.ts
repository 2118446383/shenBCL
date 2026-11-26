import assert from 'node:assert/strict';
import test from 'node:test';
import { BMCLAPI_ORIGIN, fetchFromSources, getDownloadSource, MCIM_ORIGIN, resolveDownloadSources, validateDownloadUrl } from '../arcane-launcher/src/main/services/download-sources';

test('documented source mappings preserve exact artifact paths and catalog queries', () => {
  for (const [url, purpose, mirror] of [
    ['https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.262/neoforge-21.1.262.module', 'neoforge', `${BMCLAPI_ORIGIN}/maven/net/neoforged/neoforge/21.1.262/neoforge-21.1.262.module`],
    ['https://cdn.modrinth.com/data/project/versions/version/mod.jar', 'modpack', `${MCIM_ORIGIN}/data/project/versions/version/mod.jar`],
    ['https://mediafilez.forgecdn.net/files/1234/567/mod.jar', 'modpack', `${MCIM_ORIGIN}/files/1234/567/mod.jar`],
    ['https://api.modrinth.com/v2/search?query=create&facets=%5B%5D', 'catalog', `${MCIM_ORIGIN}/modrinth/v2/search?query=create&facets=%5B%5D`],
  ] as const) assert.deepEqual(resolveDownloadSources(url, purpose), [url, mirror]);
});

test('initial addresses reject unsafe schemes, arbitrary hosts, credentials and unrelated mirror paths', () => {
  for (const url of ['http://cdn.modrinth.com/data/p/versions/v/a.jar', 'https://127.0.0.1/a', 'https://user:secret@cdn.modrinth.com/data/a', 'https://cdn.modrinth.com:8443/a', `${BMCLAPI_ORIGIN}/account`, 'https://bmclapi2.bangbang93.com.evil.test/maven/a']) assert.throws(() => validateDownloadUrl(url, 'modpack'));
  assert.throws(() => validateDownloadUrl(`${MCIM_ORIGIN}/modrinth/v2/auth/login`, 'catalog'));
});

test('a slow origin starts its mirror after a bounded delay and aborts the losing connection', async () => {
  const original = 'https://cdn.modrinth.com/data/p/versions/v/a.jar';
  const requests: string[] = [];
  let originAborted = false;
  const response = await fetchFromSources(original, { purpose: 'modpack', hedgeDelayMs: 5, request: async (input, init) => {
    requests.push(String(input));
    if (String(input) === original) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => { originAborted = true; reject(init.signal?.reason); }, { once: true }));
    return new Response('verified later by consumer');
  } });
  assert.equal(await response.text(), 'verified later by consumer');
  assert.deepEqual(requests, resolveDownloadSources(original, 'modpack'));
  assert.equal(originAborted, true);
  assert.equal(getDownloadSource(response), MCIM_ORIGIN + '/data/p/versions/v/a.jar');
});

test('Minecraft vanilla metadata, game files, assets and libraries only use Mojang origins', () => {
  for (const [url, purpose, mirror] of [
    ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'vanilla-metadata', '/mc/game/version_manifest_v2.json'],
    ['https://piston-data.mojang.com/v1/objects/fixture/client.jar', 'vanilla-metadata', '/v1/objects/fixture/client.jar'],
    ['https://libraries.minecraft.net/org/example/library/1/library-1.jar', 'library', '/maven/org/example/library/1/library-1.jar'],
    ['https://resources.download.minecraft.net/ab/abcdef', 'asset', '/assets/ab/abcdef'],
  ] as const) {
    assert.deepEqual(resolveDownloadSources(url, purpose), [url]);
    assert.throws(() => validateDownloadUrl(BMCLAPI_ORIGIN + mirror, purpose));
  }
});

test('an HTTP failure starts the next source immediately and retains diagnostics when all fail', async () => {
  const original = 'https://api.modrinth.com/v2/project/create/version';
  const requests: string[] = [];
  const response = await fetchFromSources(original, { purpose: 'catalog', hedgeDelayMs: 10_000, request: async input => {
    requests.push(String(input));
    return String(input) === original ? new Response('unavailable', { status: 503 }) : Response.json([]);
  } });
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(requests, resolveDownloadSources(original, 'catalog'));
  await assert.rejects(fetchFromSources(original, { purpose: 'catalog', request: async () => new Response('limited', { status: 429 }) }), /HTTP 429/);
});

test('metadata races require valid JSON before selecting a source and preserve exact metadata bytes', async () => {
  const original = 'https://api.modrinth.com/v2/search';
  const bytes = '{ "hits": [] }\n';
  const requests: string[] = [];
  const response = await fetchFromSources(original, { purpose: 'catalog', request: async input => {
    requests.push(String(input));
    return new Response(String(input) === original ? '<html>temporary upstream error</html>' : bytes);
  } });
  assert.equal(await response.text(), bytes);
  assert.equal(requests.length, 2);
  assert.equal(getDownloadSource(response), `${MCIM_ORIGIN}/modrinth/v2/search`);
});

test('unsafe redirects are rejected for every source without requesting their destination', async () => {
  const requests: string[] = [];
  await assert.rejects(fetchFromSources('https://libraries.minecraft.net/fixture.jar', { purpose: 'library', request: async input => {
    requests.push(String(input)); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  } }), /不安全|受信任/);
  assert.equal(requests.length, 1);
  assert.ok(requests.every(url => !url.includes('127.0.0.1')));
});

test('BMCLAPI may delegate documented education mirrors and signed public download nodes', async () => {
  for (const target of ['https://mirror.nyist.edu.cn/bmclapi/net/example.jar', `https://node.example.net:8443/download/${'a'.repeat(40)}?s=signature&e=expiry`]) {
    let redirected = false;
    const response = await fetchFromSources(`${BMCLAPI_ORIGIN}/maven/net/neoforged/a.jar`, { purpose: 'neoforge', request: async input => {
      if (String(input) === target) { redirected = true; return new Response('artifact'); }
      return new Response(null, { status: 302, headers: { location: target } });
    } });
    assert.equal(await response.text(), 'artifact');
    assert.equal(redirected, true);
  }
  await assert.rejects(fetchFromSources(`${BMCLAPI_ORIGIN}/maven/net/neoforged/a.jar`, { purpose: 'neoforge', request: async () => new Response(null, { status: 302, headers: { location: 'https://node.example.net/arbitrary' } }) }), /受信任/);
});

test('caller cancellation aborts every active source and no response is published', async () => {
  const controller = new AbortController();
  let requests = 0;
  const result = fetchFromSources('https://cdn.modrinth.com/data/p/versions/v/a.jar', { purpose: 'modpack', signal: controller.signal, hedgeDelayMs: 0, request: async (_input, init) => {
    requests++;
    if (requests === 2) queueMicrotask(() => controller.abort());
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
  } });
  await assert.rejects(result, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(requests, 2);
});

test('a source rejected by a checksum consumer can be excluded from the next attempt', async () => {
  const original = 'https://cdn.modrinth.com/data/p/versions/v/a.jar';
  const requests: string[] = [];
  const response = await fetchFromSources(original, { purpose: 'modpack', exclude: new Set([original]), request: async input => { requests.push(String(input)); return new Response('good'); } });
  assert.deepEqual(requests, [`${MCIM_ORIGIN}/data/p/versions/v/a.jar`]);
  assert.equal(getDownloadSource(response), requests[0]);
});

test('RequestInit cancellation is honored and credentials are stripped when switching origins', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchFromSources('https://api.modrinth.com/v2/search', { purpose: 'catalog', init: { signal: controller.signal }, request: async () => { throw new Error('Network must not run'); } }), error => error instanceof Error && error.name === 'AbortError');
  let mirrorChecked = false;
  await fetchFromSources('https://api.modrinth.com/v2/search', { purpose: 'catalog', init: { credentials: 'include', headers: { authorization: 'fixture-secret', cookie: 'fixture-cookie', 'user-agent': 'shenBCL' } }, request: async (input, init) => {
    const headers = new Headers(init?.headers);
    if (String(input).includes('api.modrinth.com')) {
      assert.equal(headers.get('authorization'), 'fixture-secret');
      return new Response('unavailable', { status: 503 });
    }
    mirrorChecked = true;
    assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false);
    assert.equal(headers.get('user-agent'), 'shenBCL'); assert.equal(init?.credentials, 'omit');
    return Response.json([]);
  } });
  assert.equal(mirrorChecked, true);
});
