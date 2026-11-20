import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createElectronDownloadFetch } from '../arcane-launcher/src/main/services/electron-download-fetch';

class FakeRequest extends EventEmitter {
  aborted = false;
  followed = false;
  constructor(readonly begin: (request: FakeRequest) => void) { super(); }
  end() { queueMicrotask(() => this.begin(this)); }
  abort() { this.aborted = true; this.emit('error', new Error('Redirect was cancelled')); this.emit('close'); }
  followRedirect() { this.followed = true; }
}

function message(body: Readable, statusCode = 200, headers: Record<string, string | string[]> = {}) {
  return Object.assign(body, { statusCode, statusMessage: statusCode === 200 ? 'OK' : 'No Content', headers });
}

function fakeNet(begin: (request: FakeRequest) => void) {
  const requests: FakeRequest[] = [];
  const options: unknown[] = [];
  let delegated = 0;
  const net = {
    request(value: unknown) { options.push(value); const request = new FakeRequest(begin); requests.push(request); return request; },
    fetch: async () => { delegated++; return new Response('delegated'); },
  } as unknown as Parameters<typeof createElectronDownloadFetch>[0];
  return { net, requests, options, get delegated() { return delegated; } };
}

test('manual Chromium redirects become a 3xx Response without following their Location', async () => {
  const fixture = fakeNet(request => request.emit('redirect', 302, 'GET', 'https://mirror.example.test/artifact', { location: ['https://mirror.example.test/artifact'], 'content-type': ['text/plain'] }));
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://mirror.example.test/artifact');
  assert.equal(response.url, 'https://origin.example.test/artifact');
  assert.equal(fixture.requests[0].aborted, true);
  assert.equal(fixture.requests[0].followed, false);
});

test('nonmanual requests retain Electron net.fetch behavior', async () => {
  const fixture = fakeNet(() => { throw new Error('net.request must not run'); });
  assert.equal(await (await createElectronDownloadFetch(fixture.net)('https://example.test/account')).text(), 'delegated');
  assert.equal(fixture.delegated, 1); assert.equal(fixture.requests.length, 0);
});

test('binary GET responses preserve bytes and request headers', async () => {
  const fixture = fakeNet(request => request.emit('response', message(Readable.from([Buffer.from([0, 1, 255]), Buffer.from([2, 3])]), 200, { 'content-length': '5' })));
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual', headers: { 'user-agent': 'shenBCL' } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 1, 255, 2, 3]));
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal((fixture.options[0] as { headers: Record<string, string> }).headers['user-agent'], 'shenBCL');
});

test('a native request close before response headers does not reject a valid incoming response', async () => {
  const fixture = fakeNet(request => {
    request.emit('close');
    request.emit('response', message(Readable.from([Buffer.from('after-close')])));
  });
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual' });
  assert.equal(await response.text(), 'after-close');
});

test('HEAD responses have no body and same-origin credentials carry an explicit origin', async () => {
  const fixture = fakeNet(request => request.emit('response', message(Readable.from([]), 200, { 'content-length': '1000' })));
  const response = await createElectronDownloadFetch(fixture.net)(new Request('https://origin.example.test/artifact', { method: 'HEAD', redirect: 'manual' }));
  assert.equal(response.body, null); assert.equal(response.headers.get('content-length'), '1000');
  assert.equal((fixture.options[0] as { origin?: string }).origin, 'https://origin.example.test');
});

test('pre-cancelled requests never reach Electron and streaming cancellation aborts the native request', async () => {
  const controller = new AbortController(); controller.abort();
  const fixture = fakeNet(() => { throw new Error('Network must not run'); });
  await assert.rejects(createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual', signal: controller.signal }), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(fixture.requests.length, 0);
  const stream = new Readable({ read() {} });
  const active = fakeNet(request => request.emit('response', message(stream)));
  const activeController = new AbortController();
  const response = await createElectronDownloadFetch(active.net)('https://origin.example.test/artifact', { redirect: 'manual', signal: activeController.signal });
  const reader = response.body!.getReader();
  stream.push(Buffer.from('partial'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
  activeController.abort();
  await assert.rejects(reader.read(), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(active.requests[0].aborted, true); assert.equal(stream.destroyed, true);
});

test('consumer body cancellation stops the native transfer and late error events remain handled', async () => {
  const stream = new Readable({ read() {} });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual' });
  await response.body!.cancel();
  assert.equal(fixture.requests[0].aborted, true);
  fixture.requests[0].emit('error', new Error('late native cancellation'));
});

test('a slow consumer applies bounded pressure to the native Readable and resumes for remaining bytes', async () => {
  let cursor = 0;
  let delivered = 0;
  const chunkSize = 64 * 1024;
  const stream = new Readable({ highWaterMark: chunkSize, read() {
    if (cursor < 16) { cursor++; this.push(Buffer.alloc(chunkSize, cursor)); }
    else this.push(null);
  } });
  stream.on('data', () => { delivered++; });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stream.isPaused(), true);
  assert.ok(delivered <= 4, `unexpected queued chunks: ${delivered}`);
  assert.equal((await response.arrayBuffer()).byteLength, chunkSize * 16);
});

test('native response stream failures reach the reader instead of causing an unhandled error', async () => {
  const stream = new Readable({ read() {} });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net)('https://origin.example.test/artifact', { redirect: 'manual' });
  stream.emit('error', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
  await assert.rejects(response.arrayBuffer(), /socket reset/);
});

test('a response with no further bytes times out and aborts its native transfer', async () => {
  const stream = new Readable({ read() {} });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net, { bodyIdleTimeoutMs: 30 })('https://origin.example.test/artifact', { redirect: 'manual' });
  const body = response.arrayBuffer();
  stream.push(Buffer.from('partial'));
  await assert.rejects(body, error => error instanceof Error && error.name === 'TimeoutError');
  assert.equal(fixture.requests[0].aborted, true);
  assert.equal(stream.destroyed, true);
});

test('receiving chunks renews the body idle deadline', async () => {
  const stream = new Readable({ read() {} });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net, { bodyIdleTimeoutMs: 100 })('https://origin.example.test/artifact', { redirect: 'manual' });
  const body = response.text();
  for (const value of ['one', 'two', 'three', 'four']) {
    stream.push(Buffer.from(value));
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  stream.push(null);
  assert.equal(await body, 'onetwothreefour');
  assert.equal(fixture.requests[0].aborted, false);
});

test('consumer backpressure suspends idle timeout until reading resumes', async () => {
  let count = 0;
  const stream = new Readable({ highWaterMark: 64 * 1024, read() {
    if (count < 16) { count++; this.push(Buffer.alloc(64 * 1024, count)); }
    else this.push(null);
  } });
  const fixture = fakeNet(request => request.emit('response', message(stream)));
  const response = await createElectronDownloadFetch(fixture.net, { bodyIdleTimeoutMs: 30 })('https://origin.example.test/artifact', { redirect: 'manual' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(stream.isPaused(), true);
  assert.equal(fixture.requests[0].aborted, false);
  assert.equal((await response.arrayBuffer()).byteLength, 16 * 64 * 1024);
});
