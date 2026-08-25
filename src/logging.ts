import * as vscode from 'vscode';

/**
 * A single shared "Code Janitor" output channel, so problems (a failed AI request, a cleanup that
 * skipped a file, an exception in a command) are visible somewhere other than a single toast
 * notification. `vscode.window.createOutputChannel` is only called once, from `activate`; every
 * other call site just logs through the functions below, which are no-ops before that happens
 * (e.g. in unit tests that register commands without going through `activate`).
 */

let channel: vscode.OutputChannel | undefined;

export function createOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel('Code Janitor');
  context.subscriptions.push(channel);

  return channel;
}

export function logInfo(message: string): void {
  channel?.appendLine(`[${timestamp()}] ${message}`);
}

export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  channel?.appendLine(`[${timestamp()}] ERROR - ${context}: ${detail}`);
}

export function showOutputChannel(): void {
  channel?.show(true);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
