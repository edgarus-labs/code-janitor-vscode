/**
 * A small OpenAI/Claude-compatible chat completion client, ported from
 * CodeJanitorShared/Logic/Ai/OpenAiCompatibleClient.cs (Visual Studio extension) - same endpoint
 * normalization, local-endpoint detection, transient-status retry and response-content
 * extraction, rewritten against `fetch` instead of `HttpClient`.
 */

export interface CustomEndpointConfig {
  endpointUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  model?: string;
  timeoutSeconds?: number;
  contextWindowTokens?: number;
}

export interface ConnectionTestResult {
  succeeded: boolean;
  errorMessage?: string;
}

const MAX_ATTEMPTS = 3;

export function isEndpointConfigured(endpointUrl: string | undefined): boolean {
  if (!endpointUrl || endpointUrl.trim().length === 0) {
    return false;
  }

  try {
    const uri = new URL(endpointUrl.trim());

    return uri.protocol === 'http:' || uri.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getNormalizedEndpointUrl(endpointUrl: string): string {
  const url = endpointUrl.trim();
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return url;
  }

  const recognizedSuffixes = ['/chat/completions', '/completions', '/messages', '/generate'];
  if (recognizedSuffixes.some((suffix) => url.toLowerCase().endsWith(suffix))) {
    return url;
  }

  return url.replace(/\/+$/, '') + '/chat/completions';
}

export function isLocalEndpoint(endpointUrl: string): boolean {
  let uri: URL;
  try {
    uri = new URL(endpointUrl);
  } catch {
    return false;
  }

  const host = uri.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
}

function isTransientStatusCode(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function buildRequestBody(userPrompt: string, maxTokens: number, systemPrompt: string | undefined, config: CustomEndpointConfig): Record<string, unknown> {
  const effectiveSystemPrompt = systemPrompt?.trim() ? systemPrompt : 'You are a C# documentation assistant. Output concise and accurate technical text.';

  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: effectiveSystemPrompt },
      { role: 'user', content: userPrompt ?? '' },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  };

  if (config.model) {
    body.model = config.model;
  }

  // Best-effort context window hint for local OpenAI-compatible servers only (hosted APIs
  // commonly reject unrecognized fields) - mirrors OpenAiCompatibleClient.cs.
  if (config.contextWindowTokens && config.contextWindowTokens > 0 && isLocalEndpoint(config.endpointUrl)) {
    body.num_ctx = config.contextWindowTokens;
  }

  return body;
}

function extractContentFromResponse(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const anyPayload = payload as Record<string, unknown>;

  // OpenAI-compatible chat completions shape.
  const choices = anyPayload.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') {
      return message.content;
    }
    if (typeof first.text === 'string') {
      return first.text;
    }
  }

  // Anthropic Messages API shape: { content: [{ type: 'text', text: '...' }] }.
  const content = anyPayload.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string' ? (block as Record<string, unknown>).text : ''))
      .join('');
    if (text) {
      return text as string;
    }
  }

  // Plain { message: { content: '...' } } shape (e.g. some local servers).
  const message = anyPayload.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === 'string') {
    return message.content;
  }

  return undefined;
}

function applyAuthHeaders(headers: Record<string, string>, config: CustomEndpointConfig): void {
  const headerName = config.apiKeyHeader?.trim() || 'Authorization';
  const key = config.apiKey?.trim();
  if (!key) {
    return;
  }

  if (headerName.toLowerCase() === 'authorization') {
    headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
  } else {
    headers[headerName] = key;
  }
}

async function postChatCompletion(userPrompt: string, maxTokens: number, systemPrompt: string | undefined, config: CustomEndpointConfig): Promise<string> {
  if (!isEndpointConfigured(config.endpointUrl)) {
    throw new Error('AI endpoint is not configured.');
  }

  const url = getNormalizedEndpointUrl(config.endpointUrl);
  const timeoutSeconds = config.timeoutSeconds && config.timeoutSeconds > 0 ? config.timeoutSeconds : 30;
  const body = buildRequestBody(userPrompt, maxTokens, systemPrompt, config);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  applyAuthHeaders(headers, config);

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const responseText = await response.text();

      if (!response.ok) {
        lastError = `AI endpoint returned ${response.status} ${response.statusText}. ${responseText.slice(0, 512)}`;
        if (attempt < MAX_ATTEMPTS && isTransientStatusCode(response.status)) {
          continue;
        }

        throw new Error(lastError);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`AI endpoint response was not valid JSON. Response: ${responseText.slice(0, 512)}`);
      }

      const content = extractContentFromResponse(payload);
      if (!content || !content.trim()) {
        throw new Error(`AI endpoint response did not contain message content. Response: ${responseText.slice(0, 512)}`);
      }

      return content.trim();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`AI request timed out after ${timeoutSeconds} seconds.`);
      }

      if (attempt >= MAX_ATTEMPTS) {
        throw err;
      }

      lastError = (err as Error).message;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastError ?? 'Unknown AI endpoint error.');
}

export async function testCustomConnection(config: CustomEndpointConfig): Promise<ConnectionTestResult> {
  try {
    await postChatCompletion('Reply with exactly: OK', 16, undefined, config);

    return { succeeded: true };
  } catch (err) {
    return { succeeded: false, errorMessage: (err as Error).message };
  }
}

export async function getCustomChatCompletion(systemPrompt: string, userPrompt: string, maxTokens: number, config: CustomEndpointConfig): Promise<string> {
  return postChatCompletion(userPrompt, maxTokens, systemPrompt, config);
}
