import * as http from 'node:http';
import * as https from 'node:https';

export interface SafeFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

export class RefusedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedResponseError';
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';

  return error;
}

export function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    reject(new Error(`Only http and https URLs are supported, not ${target.protocol}`));

    return promise;
  }

  if (init.signal?.aborted) {
    reject(abortError());

    return promise;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (name.toLowerCase() !== 'accept-encoding') {
      headers[name] = value;
    }
  }

  headers['Accept-Encoding'] = 'identity';
  if (init.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(init.body));
  }

  const request = (target.protocol === 'https:' ? https : http).request(target, { method: init.method ?? 'GET', headers }, (incoming) => {
    const status = incoming.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      incoming.destroy();
      reject(new RefusedResponseError(`The AI endpoint answered with the redirect ${status}; redirects are not followed.`));

      return;
    }

    const encoding = incoming.headers['content-encoding'];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
      incoming.destroy();
      reject(new RefusedResponseError(`The AI endpoint answered with Content-Encoding '${encoding}', which is refused: the answer is not decoded.`));

      return;
    }

    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('error', reject);
    incoming.on('end', () => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      resolve(
        new Response(NO_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
          status,
          statusText: incoming.statusMessage ?? '',
          headers: responseHeaders,
        })
      );
    });
  });

  const onAbort = (): void => {
    request.destroy();
    reject(abortError());
  };
  init.signal?.addEventListener('abort', onAbort, { once: true });
  request.on('error', reject);
  request.on('close', () => init.signal?.removeEventListener('abort', onAbort));
  request.end(init.body);

  return promise;
}

export const network: { fetch: (url: string, init?: SafeFetchInit) => Promise<Response> } = { fetch: safeFetch };
