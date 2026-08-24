import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface XmlDocTarget {
  index: number;
  kind: string;
  memberName: string;
  line: number;
  requiresAi: boolean;
  prompt?: string;
  fallbackSummary: string;
}

export interface EngineFile {
  path: string;
  content: string;
  /** Summaries keyed by the target index returned from a preceding 'xmlDocPlan' call. */
  summaries?: Record<number, string>;
}

export interface EngineFileResult {
  path: string;
  output: string;
  changed: boolean;
  error?: string;
  targets?: XmlDocTarget[];
}

export type EngineCommand = 'cleanup' | 'xmlDocPlan' | 'xmlDocApply';

export interface EngineRequest {
  command?: EngineCommand;
  settings: Record<string, boolean | number | string | null>;
  files: EngineFile[];
}

export interface EngineResponse {
  results: EngineFileResult[];
  /** Only present for the xmlDoc commands: the system prompt ported from the source extension. */
  systemPrompt?: string;
}

/**
 * Locates the published CodeJanitor.Engine.dll: prefers the packaged `engine-dist` folder
 * (production install), falls back to the local dev build under `engine/CodeJanitor.Engine/bin`.
 */
export function resolveEngineDll(extensionUri: vscode.Uri): string {
  const extensionPath = extensionUri.fsPath;

  const packaged = path.join(extensionPath, 'engine-dist', 'CodeJanitor.Engine.dll');
  if (fs.existsSync(packaged)) {
    return packaged;
  }

  const devConfigs = ['Debug', 'Release'];
  for (const config of devConfigs) {
    const devPath = path.join(extensionPath, 'engine', 'CodeJanitor.Engine', 'bin', config, 'net8.0', 'CodeJanitor.Engine.dll');
    if (fs.existsSync(devPath)) {
      return devPath;
    }
  }

  throw new Error(
    'CodeJanitor cleanup engine not found. Run "npm run build:engine" (dev) or reinstall the extension.'
  );
}

/**
 * Runs the CodeJanitor.Engine CLI once for the given request and returns its parsed response.
 * The whole request/response is passed as a single JSON document over stdin/stdout.
 */
export function runEngine(dotnetPath: string, engineDll: string, request: EngineRequest): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(dotnetPath, [engineDll], { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start CodeJanitor engine ('${dotnetPath}'): ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CodeJanitor engine exited with code ${code}: ${stderr || '(no output)'}`));

        return;
      }

      try {
        const parsed = JSON.parse(stdout) as EngineResponse;
        resolve({ results: parsed.results ?? [], systemPrompt: parsed.systemPrompt });
      } catch (err) {
        reject(new Error(`Failed to parse CodeJanitor engine response: ${(err as Error).message}\n${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(request), 'utf8');
    child.stdin.end();
  });
}
