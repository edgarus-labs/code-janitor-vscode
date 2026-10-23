import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch } from '../src/ai/safeFetch';

interface Seen {
  method?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('safeFetch', () => {
  let server: http.Server;
  let base: string;
  let seen: Seen;
  let requestArrived = Promise.withResolvers<void>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        const url = new URL(req.url ?? '/', 'http://localhost');
        const encoding = url.searchParams.get('encoding');
        const status = Number(url.searchParams.get('status') ?? 200);
        const headers: http.OutgoingHttpHeaders = { 'content-type': 'text/plain' };
        if (encoding) {
          headers['content-encoding'] = encoding;
        }

        if (url.searchParams.get('location')) {
          headers.location = url.searchParams.get('location') as string;
        }

        if (url.searchParams.get('retryAfter')) {
          headers['retry-after'] = url.searchParams.get('retryAfter') as string;
        }

        if (url.searchParams.get('hang')) {
          requestArrived.resolve();

          return;
        }

        res.writeHead(status, 'Custom Reason', headers);
        res.end(status === 204 ? undefined : 'plain text answer');
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });

  it.each(['br', 'gzip', 'deflate', 'zstd', 'compress', 'BR', 'gzip, br'])(
    'refuses an answer with Content-Encoding %s without reading it',
    async (encoding) => {
      await expect(safeFetch(`${base}/?encoding=${encodeURIComponent(encoding)}`, { method: 'GET' })).rejects.toThrow(/Content-Encoding/);
    }
  );

  it.each(['identity', 'Identity'])('reads an answer with Content-Encoding %s', async (encoding) => {
    const response = await safeFetch(`${base}/?encoding=${encoding}`, { method: 'GET' });

    expect(await response.text()).toBe('plain text answer');
  });

  it('reads an answer without Content-Encoding and keeps the status, the reason and the headers', async () => {
    const response = await safeFetch(`${base}/?status=429&retryAfter=7`, { method: 'GET' });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(response.statusText).toBe('Custom Reason');
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(await response.text()).toBe('plain text answer');
  });

  it('answers 204 without a body', async () => {
    const response = await safeFetch(`${base}/?status=204`, { method: 'GET' });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('asks for an uncompressed answer and sends the method, headers and body', async () => {
    await safeFetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' }, body: '{"a":1}' });

    expect(seen.method).toBe('POST');
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.headers['content-type']).toBe('application/json');
    expect(seen.headers.authorization).toBe('Bearer k');
    expect(seen.body).toBe('{"a":1}');
  });

  it('does not let the caller ask for a compressed answer', async () => {
    await safeFetch(`${base}/`, { method: 'GET', headers: { 'accept-encoding': 'br' } });

    expect(seen.headers['accept-encoding']).toBe('identity');
  });

  it.each([301, 302, 307, 308])('does not follow a %i redirect and reports it', async (status) => {
    await expect(safeFetch(`${base}/?status=${status}&location=${encodeURIComponent('http://127.0.0.1:1/')}`, { method: 'GET' })).rejects.toThrow(/redirect/i);
  });

  it('ends with an AbortError when the signal aborts while waiting for the answer', async () => {
    const controller = new AbortController();
    requestArrived = Promise.withResolvers<void>();
    const pending = safeFetch(`${base}/?hang=1`, { method: 'GET', signal: controller.signal });
    await requestArrived.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ends with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(safeFetch(`${base}/`, { method: 'GET', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a URL that is not http or https', async () => {
    await expect(safeFetch('file:///etc/passwd', { method: 'GET' })).rejects.toThrow(/http/i);
  });
});
