import type { ClientRequest, IncomingMessage, Net } from 'electron';
import type { Readable } from 'node:stream';

type ElectronDownloadNet = Pick<Net, 'fetch' | 'request'>;

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  return headers;
}

function responseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/**
 * Electron net.fetch rejects manual redirects instead of exposing their 3xx
 * response. Use net.request's redirect event for download hops while retaining
 * Chromium's system proxy, TLS verification and session networking stack.
 */
export function createElectronDownloadFetch(electronNet: ElectronDownloadNet, options: { bodyIdleTimeoutMs?: number } = {}): typeof fetch {
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? 30_000;
  if (!Number.isFinite(bodyIdleTimeoutMs) || bodyIdleTimeoutMs <= 0) throw new TypeError('下载流空闲超时必须为正数。');
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    // Files already have a verified disk cache; avoid a second Chromium copy.
    if ((init?.redirect ?? original?.redirect) !== 'manual') return electronNet.fetch(input instanceof URL ? input.href : input, { ...init, cache: 'no-store' });
    const url = original?.url ?? String(input);
    const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method) || init?.body != null) throw new TypeError('手动重定向下载适配器只接受 GET / HEAD。');
    const signal = init?.signal ?? original?.signal;
    signal?.throwIfAborted();
    const headers = new Headers(original?.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const outgoingHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { outgoingHeaders[name] = value; });

    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest;
      let incoming: (IncomingMessage & Readable) | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false;
      let ended = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let backpressured = false;
      const clearIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
      const cleanup = () => { clearIdle(); signal?.removeEventListener('abort', abort); };
      const fail = (error: unknown) => {
        if (ended) return;
        ended = true; cleanup();
        if (!settled) { settled = true; reject(error); }
        else controller?.error(error);
      };
      const abort = () => {
        const reason = signal?.reason ?? new DOMException('下载已取消。', 'AbortError');
        fail(reason);
        request?.abort(); incoming?.destroy();
      };
      const armIdle = () => {
        clearIdle();
        if (ended || backpressured) return;
        idleTimer = setTimeout(() => {
          fail(new DOMException('下载连接长时间未收到数据，请重试或切换下载源。', 'TimeoutError'));
          request?.abort(); incoming?.destroy();
        }, bodyIdleTimeoutMs);
      };
      try {
        const credentials = init?.credentials ?? original?.credentials ?? 'omit';
        request = electronNet.request({ url, method, headers: outgoingHeaders, redirect: 'manual', cache: 'no-store', credentials, ...(credentials === 'same-origin' ? { origin: new URL(url).origin } : {}), useSessionCookies: false });
        request.on('error', fail);
        request.on('redirect', (statusCode, _method, location, redirectHeaders) => {
          if (settled || ended) return;
          try {
            const headers = responseHeaders(redirectHeaders);
            headers.set('location', location);
            const response = responseUrl(new Response(null, { status: statusCode, headers }), url);
            settled = true; ended = true; cleanup(); resolve(response);
          } catch (error) { fail(error); }
          // Never follow here: download-sources validates each Location before
          // issuing a separate request. The expected cancellation error is handled.
          request.abort();
        });
        request.on('response', response => {
          // Electron's implementation extends Node Readable; its public typings
          // omit that inheritance. pause/resume propagate pressure to Chromium.
          incoming = response as IncomingMessage & Readable;
          if (ended || settled) { incoming.destroy(); return; }
          incoming.pause();
          const status = response.statusCode;
          const noBody = method === 'HEAD' || [204, 205, 304].includes(status);
          const body = noBody ? null : new ReadableStream<Uint8Array>({
            start(stream) { controller = stream; },
            pull() { backpressured = false; armIdle(); incoming?.resume(); },
            cancel() { ended = true; cleanup(); request.abort(); incoming?.destroy(); },
          }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
          response.on('end', () => { if (ended) return; ended = true; cleanup(); controller?.close(); });
          response.on('error', fail);
          response.on('aborted', () => fail(Object.assign(new Error('Electron 下载响应流被中断。'), { code: 'ECONNRESET' })));
          response.on('data', chunk => {
            if (ended || noBody) return;
            controller!.enqueue(new Uint8Array(chunk));
            backpressured = (controller!.desiredSize ?? 0) <= 0;
            if (backpressured) { clearIdle(); incoming?.pause(); }
            else armIdle();
          });
          try {
            const result = responseUrl(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders(response.headers) }), url);
            settled = true; resolve(result);
            armIdle();
            if (noBody) incoming.resume();
          } catch (error) { fail(error); request.abort(); incoming.destroy(); }
        });
        // ClientRequest's close event can precede the incoming response in real
        // Chromium event ordering. Only error/abort and response lifecycle events
        // determine failure; the caller's signal bounds missing responses.
        request.on('abort', () => { if (!settled && !ended) fail(Object.assign(new Error('Electron 下载请求被中断。'), { code: 'ECONNRESET' })); });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else request.end();
      } catch (error) { fail(error); request!?.abort(); }
    });
  };
}
