import * as vscode from 'vscode';
import type { CollectedFile } from '../commands/cleanupCore';
import { readXmlDocOptions } from '../commands/settings';
import type { XmlDocTargetResult } from '../engine/protocol';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { XML_DOC_SYSTEM_PROMPT, XmlDocPlanItem, XmlDocRunOptions, insertXmlDocumentation, planXmlDocumentation } from '../engine/xmlDoc';
import { logError } from '../logging';

/**
 * AI XML documentation during cleanup (`codeJanitor.ai.xmlDoc.runDuringCleanup`), with the budget of Visual Studio's
 * `AiXmlDocumentationLogic`: at most `maxRequestsPerCleanup` AI requests and `maxEstimatedTokensPerCleanup`
 * estimated tokens for the whole run, nothing started after `globalTimeoutSeconds`, and `maxParallelFiles` files
 * documented at the same time. Members past the budget are left undocumented and counted.
 */

/** One AI completion: the documentation system prompt, a member's prompt and the token cap of the answer. */
export type XmlDocCompletion = (systemPrompt: string, prompt: string, maxTokens: number) => Promise<string>;

export interface XmlDocCleanupLimits {
  readonly maxRequests: number;
  readonly maxEstimatedTokens: number;
  readonly timeoutMs: number;
  readonly maxParallelFiles: number;
  readonly maxTokensPerRequest: number;
  readonly allowFallback: boolean;
  /** The `xmlDocTargets` filters. */
  readonly options: XmlDocRunOptions;
}

/** How the run reads and writes files and asks the model; `now` and `sleep` default to the real clock. */
export interface XmlDocCleanupIo {
  /** The file's current text, or `undefined` when it can no longer be read. */
  read(uri: vscode.Uri): Promise<CollectedFile | undefined>;
  write(file: CollectedFile, text: string): Promise<void>;
  complete: XmlDocCompletion;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface XmlDocCleanupSummary {
  documentedFiles: number;
  documentedMembers: number;
  /** Members left undocumented by the request, token or time budget. */
  skippedByBudget: number;
  /** Files not started because the time was up. */
  skippedFiles: number;
  /** AI requests that failed or answered nothing. */
  failedRequests: number;
  /** Failed requests whose member got the deterministic summary instead. */
  fallbacks: number;
  /** Files that could not be read, queried or written. */
  failedFiles: number;
}

/** The members of a document the engine finds without documentation, with their plan. */
export async function findXmlDocTargets(
  uri: vscode.Uri,
  content: string,
  options: XmlDocRunOptions
): Promise<{ found: XmlDocTargetResult[]; plan: XmlDocPlanItem[] }> {
  const found = await engine().query<XmlDocTargetResult[]>({ ...documentParams(uri, content), query: 'xmlDocTargets', arguments: { ...options } });

  return { found, plan: planXmlDocumentation(found, options) };
}

/** The budget settings; a value that is not positive falls back to its default, as in Visual Studio. */
export function readXmlDocCleanupLimits(): XmlDocCleanupLimits {
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const positive = (key: string, fallback: number): number => {
    const value = config.get<number>(key, fallback);

    return value > 0 ? value : fallback;
  };

  return {
    maxRequests: positive('ai.xmlDoc.maxRequestsPerCleanup', 25),
    maxEstimatedTokens: positive('ai.xmlDoc.maxEstimatedTokensPerCleanup', 8000),
    timeoutMs: positive('ai.xmlDoc.globalTimeoutSeconds', 10) * 1000,
    maxParallelFiles: positive('ai.xmlDoc.maxParallelFiles', 4),
    maxTokensPerRequest: positive('ai.xmlDoc.maxTokensPerRequest', 256),
    allowFallback: config.get<boolean>('ai.xmlDoc.allowDeterministicFallback', true),
    options: readXmlDocOptions(),
  };
}

/** Visual Studio's estimate of a request: a token per four characters of the prompt, plus the most the answer may take. */
function estimatedTokens(prompt: string, maxTokensPerRequest: number): number {
  return (prompt.trim() ? Math.floor(prompt.length / 4) + 1 : 0) + maxTokensPerRequest;
}

const TIMED_OUT = Symbol('timed out');

/** Documents the members of `uris` that lack XML documentation, within the budget of `limits`. */
export async function documentDuringCleanup(
  uris: readonly vscode.Uri[],
  io: XmlDocCleanupIo,
  limits: XmlDocCleanupLimits = readXmlDocCleanupLimits()
): Promise<XmlDocCleanupSummary> {
  const now = io.now ?? Date.now;
  const deadline = now() + limits.timeoutMs;
  const summary: XmlDocCleanupSummary = {
    documentedFiles: 0,
    documentedMembers: 0,
    skippedByBudget: 0,
    skippedFiles: 0,
    failedRequests: 0,
    fallbacks: 0,
    failedFiles: 0,
  };
  const sleep =
    io.sleep ??
    // The extension's `lib` predates `Promise.withResolvers`. The timer is unreferenced: an answer that arrives
    // first must not keep the extension host waiting for the deadline.
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  let requests = 0;
  let tokens = 0;

  /** The AI summary of one member; `undefined` when the budget leaves it undocumented or the request failed without fallback. */
  const summarize = async (item: XmlDocPlanItem): Promise<string | undefined> => {
    const prompt = item.prompt ?? '';
    const cost = estimatedTokens(prompt, limits.maxTokensPerRequest);
    const remaining = deadline - now();
    if (remaining <= 0 || requests >= limits.maxRequests || tokens + cost > limits.maxEstimatedTokens) {
      summary.skippedByBudget++;

      return undefined;
    }

    requests++;
    tokens += cost;
    let answer: string | typeof TIMED_OUT;
    try {
      answer = await Promise.race([
        io.complete(XML_DOC_SYSTEM_PROMPT, prompt, limits.maxTokensPerRequest),
        sleep(remaining).then((): typeof TIMED_OUT => TIMED_OUT),
      ]);
    } catch (err) {
      logError(`AI XML documentation of ${item.kind} ${item.memberName}`, err);
      answer = '';
    }

    if (answer === TIMED_OUT) {
      summary.skippedByBudget++;

      return undefined;
    }

    if (answer.trim()) {
      return answer;
    }

    summary.failedRequests++;
    if (!limits.allowFallback) {
      return undefined;
    }

    summary.fallbacks++;

    return item.fallbackSummary;
  };

  const documentFile = async (uri: vscode.Uri): Promise<void> => {
    if (now() > deadline) {
      summary.skippedFiles++;

      return;
    }

    try {
      const file = await io.read(uri);
      if (!file) {
        return;
      }

      const { found, plan } = await findXmlDocTargets(file.uri, file.content, limits.options);
      const summaries: Record<number, string> = {};
      let documented = 0;
      for (const item of plan) {
        const text = item.requiresAi ? await summarize(item) : item.fallbackSummary;
        if (text !== undefined) {
          summaries[item.index] = text;
          documented++;
        }
      }

      const output = insertXmlDocumentation(file.content, found, summaries);
      if (output !== file.content) {
        await io.write(file, output);
        summary.documentedFiles++;
        summary.documentedMembers += documented;
      }
    } catch (err) {
      summary.failedFiles++;
      if (!reportEngineUnavailable(err)) {
        logError(`AI XML documentation of ${uri.fsPath}`, err);
      }
    }
  };

  const queue = [...uris];
  const worker = async (): Promise<void> => {
    for (let uri = queue.shift(); uri; uri = queue.shift()) {
      await documentFile(uri);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.maxParallelFiles, queue.length) }, worker));

  return summary;
}

export function formatXmlDocCleanupSummary(summary: XmlDocCleanupSummary): string {
  return (
    `AI XML documentation during cleanup: ${summary.documentedMembers} member(s) documented in ${summary.documentedFiles} file(s); ` +
    `${summary.skippedByBudget} member(s) and ${summary.skippedFiles} file(s) skipped by the budget; ` +
    `${summary.failedRequests} AI request(s) failed (${summary.fallbacks} replaced by the deterministic summary); ${summary.failedFiles} file(s) failed.`
  );
}
