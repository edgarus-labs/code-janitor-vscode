import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCustomChatCompletion } from '../src/ai/customClient';

const ANSWER = JSON.stringify({ choices: [{ message: { content: 'the model answer' } }] });

describe('the custom AI client and a compressed answer', () => {
  let server: http.Server;
  let endpoint: string;
  let encoding: string | undefined;
  const asked: Array<string | undefined> = [];
  const reachedOtherPlace: Array<string | undefined> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/other')) {
        reachedOtherPlace.push(req.headers.authorization);
      }

      asked.push(req.headers['accept-encoding'] as string | undefined);
      req.resume();
      req.on('end', () => {
        if (req.url?.startsWith('/redirect')) {
          res.writeHead(302, { location: '/other/chat/completions' });
          res.end();

          return;
        }

        res.writeHead(200, encoding ? { 'content-type': 'application/json', 'content-encoding': encoding } : { 'content-type': 'application/json' });
        res.end(ANSWER);
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });

  it('reads an answer that is not compressed, and asks for one', async () => {
    encoding = undefined;
    asked.length = 0;

    await expect(getCustomChatCompletion('system', 'user', 100, { endpointUrl: endpoint })).resolves.toBe('the model answer');
    expect(asked.at(-1)).toBe('identity');
  });

  it.each(['br', 'gzip', 'deflate', 'zstd'])('refuses a chat completion answered with Content-Encoding %s, and asks only once', async (value) => {
    encoding = value;
    asked.length = 0;

    await expect(getCustomChatCompletion('system', 'user', 100, { endpointUrl: endpoint })).rejects.toThrow(/Content-Encoding/);
    expect(asked).toHaveLength(1);
  });

  it('does not follow a redirect, so the key never reaches the other place, and asks only once', async () => {
    encoding = undefined;
    asked.length = 0;
    reachedOtherPlace.length = 0;
    const redirected = endpoint.replace('/v1', '/redirect');

    await expect(getCustomChatCompletion('system', 'user', 100, { endpointUrl: redirected, apiKey: 'secret-key' })).rejects.toThrow(/redirect/i);
    expect(reachedOtherPlace).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
