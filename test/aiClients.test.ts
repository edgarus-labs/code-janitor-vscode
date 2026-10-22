import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, createMockChatModel, resetMock, state } from './helpers/vscodeMock';

// ---------------------------------------------------------------- aiService

const { storeCustomApiKey, getAiChatCompletion, testAiConnection } = await import('../src/ai/aiService');

describe('storeCustomApiKey', () => {
  beforeEach(() => resetMock());

  it('stores an API key', async () => {
    const context = createContext();
    await storeCustomApiKey(context, 'sk-test');

    expect(await context.secrets.get('codeJanitor.ai.customApiKey')).toBe('sk-test');
  });

  it('deletes an empty API key', async () => {
    const context = createContext();
    await storeCustomApiKey(context, 'sk-test');
    await storeCustomApiKey(context, '');

    expect(await context.secrets.get('codeJanitor.ai.customApiKey')).toBeUndefined();
  });
});

describe('getAiChatCompletion', () => {
  beforeEach(() => resetMock());

  it('uses Copilot when provider is copilot', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'copilot');
    state.copilotModels.push(createMockChatModel());
    const result = await getAiChatCompletion(createContext(), 'system', 'user');

    expect(result).toBe('Hello');
  });

  it('throws when no Copilot model is available and provider is copilot', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'copilot');
    state.copilotModels = [];

    await expect(getAiChatCompletion(createContext(), 'sys', 'usr')).rejects.toThrow('No GitHub Copilot');
  });

  it('routes to custom endpoint when provider is custom', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'custom');
    state.configuration.set('codeJanitor.ai.customEndpointUrl', 'https://api.example.com/v1');
    const context = createContext();
    await storeCustomApiKey(context, 'sk-key');

    // The custom client will try to fetch; without a mock fetch this will fail.
    // We test the routing decision instead.
    await expect(getAiChatCompletion(context, 'sys', 'usr')).rejects.toThrow();
  });
});

describe('testAiConnection', () => {
  beforeEach(() => resetMock());

  it('reports success when Copilot is available', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'copilot');
    state.copilotModels.push(createMockChatModel());

    const result = await testAiConnection(createContext());

    expect(result.succeeded).toBe(true);
    expect(result.message).toContain('GitHub Copilot');
  });

  it('reports failure when Copilot is not available', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'copilot');
    state.copilotModels = [];

    const result = await testAiConnection(createContext());

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('No GitHub Copilot');
  });

  it('reports failure for unconfigured custom endpoint', async () => {
    state.configuration.set('codeJanitor.ai.provider', 'custom');
    state.configuration.set('codeJanitor.ai.customEndpointUrl', '');

    const result = await testAiConnection(createContext());

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('not configured');
  });
});

// ---------------------------------------------------------------- copilotClient

const { listCopilotModels, describeCopilotModels, isCopilotAvailable, getCopilotChatCompletion } = await import('../src/ai/copilotClient');

describe('listCopilotModels', () => {
  beforeEach(() => resetMock());

  it('returns models from the LM API', async () => {
    state.copilotModels.push(createMockChatModel());

    const models = await listCopilotModels();

    expect(models).toHaveLength(1);
  });

  it('returns empty when LM API throws', async () => {
    state.copilotModels = [];
    // Override the lm module's behavior for this test.
    const originalLm = (await import('./helpers/vscodeMock')).lm;
    const originalSelect = originalLm.selectChatModels;
    originalLm.selectChatModels = () => Promise.reject(new Error('no models'));

    try {
      const models = await listCopilotModels();

      expect(models).toEqual([]);
    } finally {
      originalLm.selectChatModels = originalSelect;
    }
  });
});

describe('describeCopilotModels', () => {
  beforeEach(() => resetMock());

  it('maps model properties to info', async () => {
    state.copilotModels.push(createMockChatModel({ id: 'm1', family: 'fam', name: 'Model 1' }));

    const info = await describeCopilotModels();

    expect(info).toEqual([{ id: 'm1', family: 'fam', vendor: 'copilot', name: 'Model 1', maxInputTokens: 128000 }]);
  });

  it('returns empty for no models', async () => {
    state.copilotModels = [];

    expect(await describeCopilotModels()).toEqual([]);
  });
});

describe('isCopilotAvailable', () => {
  beforeEach(() => resetMock());

  it('returns true when models exist', async () => {
    state.copilotModels.push(createMockChatModel());

    expect(await isCopilotAvailable()).toBe(true);
  });

  it('returns false when no models', async () => {
    state.copilotModels = [];

    expect(await isCopilotAvailable()).toBe(false);
  });
});

describe('getCopilotChatCompletion', () => {
  beforeEach(() => resetMock());

  it('sends a request and returns concatenated text', async () => {
    state.copilotModels.push(createMockChatModel({}, ['Hello', ' world']));

    const result = await getCopilotChatCompletion('sys', 'usr');

    expect(result).toBe('Hello world');
  });

  it('trims the result', async () => {
    state.copilotModels.push(createMockChatModel({}, ['  padded  ']));

    const result = await getCopilotChatCompletion('sys', 'usr');

    expect(result).toBe('padded');
  });

  it('throws when no models available', async () => {
    state.copilotModels = [];

    await expect(getCopilotChatCompletion('sys', 'usr')).rejects.toThrow('No GitHub Copilot Chat model');
  });

  it('uses the first model when no preference is given', async () => {
    state.copilotModels.push(createMockChatModel({ id: 'first' }), createMockChatModel({ id: 'second' }));

    const result = await getCopilotChatCompletion('sys', 'usr');

    expect(result).toBe('Hello'); // uses first model which returns 'Hello'
  });

  it('prefers a model by family match', async () => {
    state.copilotModels.push(createMockChatModel({ id: 'a', family: 'alpha' }), createMockChatModel({ id: 'b', family: 'beta' }, ['beta-response']));

    const result = await getCopilotChatCompletion('sys', 'usr', 'beta');

    expect(result).toBe('beta-response');
  });

  it('throws when preferred model is not found', async () => {
    state.copilotModels.push(createMockChatModel({ family: 'alpha' }));

    await expect(getCopilotChatCompletion('sys', 'usr', 'gamma')).rejects.toThrow('no model matching "gamma"');
  });
});

// ---------------------------------------------------------------- customClient

const { isEndpointConfigured, getNormalizedEndpointUrl, getModelsEndpointUrl, parseModelIds, isLocalEndpoint, testCustomConnection, getCustomChatCompletion } =
  await import('../src/ai/customClient');

describe('isEndpointConfigured', () => {
  it('returns false for undefined', () => {
    expect(isEndpointConfigured(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isEndpointConfigured('')).toBe(false);
    expect(isEndpointConfigured('  ')).toBe(false);
  });

  it('returns true for http URL', () => {
    expect(isEndpointConfigured('http://localhost:8080')).toBe(true);
  });

  it('returns true for https URL', () => {
    expect(isEndpointConfigured('https://api.example.com')).toBe(true);
  });

  it('returns false for non-http protocol', () => {
    expect(isEndpointConfigured('ftp://example.com')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isEndpointConfigured('not-a-url')).toBe(false);
  });
});

describe('getNormalizedEndpointUrl', () => {
  it('returns a full chat/completions URL unchanged', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/chat/completions')).toBe('https://api.example.com/chat/completions');
  });

  it('returns a completions URL unchanged', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/completions')).toBe('https://api.example.com/completions');
  });

  it('returns a messages URL unchanged', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/messages')).toBe('https://api.example.com/messages');
  });

  it('returns a generate URL unchanged', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/generate')).toBe('https://api.example.com/generate');
  });

  it('appends /chat/completions to a base URL', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
  });

  it('strips trailing slashes before appending', () => {
    expect(getNormalizedEndpointUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions');
  });

  it('returns input unchanged for invalid URL', () => {
    expect(getNormalizedEndpointUrl('not-a-url')).toBe('not-a-url');
  });

  it('handles empty string', () => {
    expect(getNormalizedEndpointUrl('')).toBe('');
  });
});

describe('getModelsEndpointUrl', () => {
  it('strips /chat/completions and appends /models', () => {
    expect(getModelsEndpointUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models');
  });

  it('strips /completions and appends /models', () => {
    expect(getModelsEndpointUrl('https://api.example.com/v1/completions')).toBe('https://api.example.com/v1/models');
  });

  it('strips /messages and appends /models', () => {
    expect(getModelsEndpointUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/models');
  });

  it('strips /generate and appends /models', () => {
    expect(getModelsEndpointUrl('https://api.example.com/api/generate')).toBe('https://api.example.com/api/models');
  });

  it('appends /models to base URL', () => {
    expect(getModelsEndpointUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(getModelsEndpointUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models');
  });
});

describe('parseModelIds', () => {
  it('parses OpenAI format with data array', () => {
    const json = JSON.stringify({
      data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }],
    });
    expect(parseModelIds(json)).toEqual(['gpt-3.5-turbo', 'gpt-4o']);
  });

  it('parses Ollama format with models array', () => {
    const json = JSON.stringify({
      models: [{ name: 'llama3:latest' }, { model: 'mistral:latest' }, { id: 'phi3' }],
    });
    expect(parseModelIds(json)).toEqual(['llama3:latest', 'mistral:latest', 'phi3']);
  });

  it('deduplicates and sorts model IDs', () => {
    const json = JSON.stringify({
      data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }],
    });
    expect(parseModelIds(json)).toEqual(['a-model', 'b-model']);
  });

  it('returns empty array for invalid json or empty input', () => {
    expect(parseModelIds('')).toEqual([]);
    expect(parseModelIds('not-json')).toEqual([]);
    expect(parseModelIds('{}')).toEqual([]);
  });
});

describe('isLocalEndpoint', () => {
  it('returns true for localhost', () => {
    expect(isLocalEndpoint('http://localhost:8080')).toBe(true);
  });

  it('returns true for 127.0.0.1', () => {
    expect(isLocalEndpoint('http://127.0.0.1:8080')).toBe(true);
  });

  it('returns true for ::1 (bracketed form)', () => {
    expect(isLocalEndpoint('http://[::1]:8080')).toBe(true);
  });

  it('returns true for 10.x.x.x', () => {
    expect(isLocalEndpoint('http://10.0.0.1:8080')).toBe(true);
  });

  it('returns true for 172.16.x.x to 172.31.x.x', () => {
    expect(isLocalEndpoint('http://172.16.0.1')).toBe(true);
    expect(isLocalEndpoint('http://172.31.255.255')).toBe(true);
  });

  it('returns false for 172.15.x.x', () => {
    expect(isLocalEndpoint('http://172.15.0.1')).toBe(false);
  });

  it('returns true for 192.168.x.x', () => {
    expect(isLocalEndpoint('http://192.168.1.1')).toBe(true);
  });

  it('returns false for public IP', () => {
    expect(isLocalEndpoint('http://8.8.8.8')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isLocalEndpoint('not-a-url')).toBe(false);
  });
});

describe('testCustomConnection', () => {
  it('returns failure for unconfigured endpoint', async () => {
    const result = await testCustomConnection({ endpointUrl: '' });

    expect(result.succeeded).toBe(false);
    expect(result.errorMessage).toContain('not configured');
  });

  it('returns failure when fetch fails', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('network error'));

    try {
      const pending = testCustomConnection({ endpointUrl: 'https://api.example.com' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.succeeded).toBe(false);
      expect(result.errorMessage).toBe('network error');
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('returns success and models when GET /models responds', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/models')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve('{"data":[{"id":"gpt-4o"},{"id":"o3-mini"}]}'),
        } as Response);
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('not found'),
      } as Response);
    };

    try {
      const result = await testCustomConnection({ endpointUrl: 'https://api.example.com/v1' });

      expect(result.succeeded).toBe(true);
      expect(result.availableModels).toEqual(['gpt-4o', 'o3-mini']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns auth failure on 401 response from /models', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      } as Response);

    try {
      const result = await testCustomConnection({ endpointUrl: 'https://api.example.com/v1' });

      expect(result.succeeded).toBe(false);
      expect(result.errorMessage).toContain('401');
      expect(result.errorMessage).toContain('Invalid API key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to chat completions when /models returns 404', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/models')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: () => Promise.resolve('404 Not Found'),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"OK"}}]}'),
      } as Response);
    };

    try {
      const result = await testCustomConnection({ endpointUrl: 'https://api.example.com/v1' });

      expect(result.succeeded).toBe(true);
      expect(result.availableModels).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('getCustomChatCompletion', () => {
  it('throws for unconfigured endpoint', async () => {
    await expect(getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: '' })).rejects.toThrow('not configured');
  });

  it('throws for invalid JSON response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('not json'),
      } as Response);

    try {
      await expect(getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' })).rejects.toThrow('not valid JSON');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when response has no content', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{}'),
      } as Response);

    try {
      await expect(getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' })).rejects.toThrow('did not contain message content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts content from OpenAI chat shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"hello"}}]}'),
      } as Response);

    try {
      const result = await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });

      expect(result).toBe('hello');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts content from Anthropic shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"content":[{"type":"text","text":"anthropic response"}]}'),
      } as Response);

    try {
      const result = await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });

      expect(result).toBe('anthropic response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts content from plain message shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"message":{"content":"local response"}}'),
      } as Response);

    try {
      const result = await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });

      expect(result).toBe('local response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries on transient 500 status', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = () => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: new Headers(),
          text: () => Promise.resolve('error'),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"retry success"}}]}'),
      } as Response);
    };

    try {
      const pending = getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toBe('retry success');
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('does not retry a non-transient 400 or 401', async () => {
    const originalFetch = globalThis.fetch;
    for (const status of [400, 401]) {
      let callCount = 0;
      globalThis.fetch = () => {
        callCount++;

        return Promise.resolve({
          ok: false,
          status,
          statusText: 'Rejected',
          text: () => Promise.resolve('bad'),
        } as Response);
      };

      try {
        await expect(getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' })).rejects.toThrow(String(status));

        expect(callCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it('waits for Retry-After on 429 before the next attempt', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = () => {
      callCount++;

      return Promise.resolve(
        callCount === 1
          ? ({
              ok: false,
              status: 429,
              statusText: 'Too Many Requests',
              headers: new Headers({ 'Retry-After': '2' }),
              text: () => Promise.resolve('slow down'),
            } as Response)
          : ({
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: new Headers(),
              text: () => Promise.resolve('{"choices":[{"message":{"content":"done"}}]}'),
            } as Response)
      );
    };

    try {
      const pending = getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });
      await vi.advanceTimersByTimeAsync(1999);
      expect(callCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe('done');
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('backs off between attempts on transient 5xx without a Retry-After', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = () => {
      callCount++;

      return Promise.resolve({ ok: false, status: 503, statusText: 'Unavailable', headers: new Headers(), text: () => Promise.resolve('down') } as Response);
    };

    try {
      const pending = getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });
      const settled = expect(pending).rejects.toThrow('503');
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;

      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('refuses redirects so the key header never reaches another host', async () => {
    const originalFetch = globalThis.fetch;
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com', apiKey: 'k' });
      await testCustomConnection({ endpointUrl: 'https://api.example.com', apiKey: 'k' });

      expect(inits.length).toBeGreaterThanOrEqual(2);
      expect(inits.every((init) => init?.redirect === 'error')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes bearer token in Authorization header', async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, {
        endpointUrl: 'https://api.example.com',
        apiKey: 'sk-test',
      });

      expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses custom apiKeyHeader when provided', async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, {
        endpointUrl: 'https://api.example.com',
        apiKey: 'my-key',
        apiKeyHeader: 'X-Api-Key',
      });

      expect(capturedHeaders['X-Api-Key']).toBe('my-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe('plain-http transport', () => {
    const okResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
    } as Response;
    let originalFetch: typeof fetch;
    let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchCalls = [];
      globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), headers: init?.headers as Record<string, string> });

        return Promise.resolve(okResponse);
      };
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('rejects a chat completion to a remote http endpoint before any network call', async () => {
      await expect(getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'http://example.com/v1', apiKey: 'sk-secret' })).rejects.toThrow(/https/i);

      expect(fetchCalls).toHaveLength(0);
    });

    it('does not send the key to a remote http endpoint when testing the connection', async () => {
      const result = await testCustomConnection({ endpointUrl: 'http://example.com/v1', apiKey: 'sk-secret' });

      expect(result.succeeded).toBe(false);
      expect(result.errorMessage).toMatch(/https/i);
      expect(fetchCalls).toHaveLength(0);
    });

    it.each(['http://localhost:11434', 'http://127.0.0.1:8080', 'http://192.168.1.10:8080', 'http://10.0.0.5'])(
      'still sends the key over http to local endpoint %s',
      async (endpointUrl) => {
        await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl, apiKey: 'sk-local' });

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].headers.Authorization).toBe('Bearer sk-local');
      }
    );

    it('sends the key over https to a remote endpoint', async () => {
      await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://example.com/v1', apiKey: 'sk-remote' });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].headers.Authorization).toBe('Bearer sk-remote');
    });
  });

  it('skips auth header when no apiKey', async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, { endpointUrl: 'https://api.example.com' });

      expect(capturedHeaders.Authorization).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes model in request body when configured', async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string = '';
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, {
        endpointUrl: 'https://api.example.com',
        model: 'gpt-4',
      });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.model).toBe('gpt-4');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes num_ctx for local endpoints', async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string = '';
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, {
        endpointUrl: 'http://localhost:11434',
        contextWindowTokens: 4096,
      });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.num_ctx).toBe(4096);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('omits num_ctx for remote endpoints', async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string = '';
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;

      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"choices":[{"message":{"content":"ok"}}]}'),
      } as Response);
    };

    try {
      await getCustomChatCompletion('sys', 'usr', 100, {
        endpointUrl: 'https://api.example.com',
        contextWindowTokens: 4096,
      });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.num_ctx).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
