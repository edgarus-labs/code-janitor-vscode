import * as path from 'node:path';
import * as vscode from 'vscode';
import { readUserCleanupSettings } from '../commands/settings';
import { CleanupSettings } from '../cleanup/types';
import { logInfo } from '../logging';
import { EngineClient, EngineUnavailableError, EngineUnavailableReason } from './client';
import { DocumentParams, DocumentText } from './protocol';
import { DOTNET_DOWNLOAD_URL, serverTransportFactory } from './serverProcess';
import { toEngineSettings } from './settings';

/** The files whose change on disk the server must hear about: sources, projects and the settings files. */
export const ENGINE_WATCH_GLOB = '**/{*.cs,*.csproj,*.props,*.targets,*.sln,*.slnx,.editorconfig,.globalconfig,*.globalconfig,.codejanitor}';

let client: EngineClient | undefined;
const reported = new Set<EngineUnavailableReason>();

/** Creates the client (the server starts on the first C# request) and forwards file changes to it. */
export function activateEngine(context: vscode.ExtensionContext): void {
  client = new EngineClient(
    serverTransportFactory({
      serverDll: path.join(context.extensionUri.fsPath, 'dist', 'server', 'CodeJanitor.Server.dll'),
      dotnetPath: () => vscode.workspace.getConfiguration('codeJanitor').get<string>('dotnetPath') || undefined,
      log: logInfo,
    }),
    {
      workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      log: logInfo,
    }
  );

  const watcher = vscode.workspace.createFileSystemWatcher(ENGINE_WATCH_GLOB);
  const changed = (uri: vscode.Uri) => client?.fileChanged(uri.fsPath);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(changed),
    watcher.onDidChange(changed),
    watcher.onDidDelete(changed),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void client?.restart()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeJanitor.dotnetPath')) {
        client?.reset();
        reported.clear();
      }
    })
  );
}

/** Shuts the server down; the extension's `deactivate` waits for it. */
export async function deactivateEngine(): Promise<void> {
  const stopping = client;
  client = undefined;
  await stopping?.shutdown();
}

/** The client of the C# engine. */
export function engine(): EngineClient {
  if (!client) {
    throw new EngineUnavailableError('The C# engine is not running: the extension is not active.', 'stopped');
  }

  return client;
}

/** Replaces the client, for tests; `undefined` removes it. */
export function setEngine(replacement: EngineClient | undefined): void {
  client = replacement;
  reported.clear();
}

/**
 * The parameters of a request about the C# document `uri` holding `text`: the user's settings (the server
 * applies `.codejanitor` and `.editorconfig` itself) and the unsaved text of the other open C# documents.
 */
export function documentParams(uri: vscode.Uri, text: string, overrides: Partial<CleanupSettings> = {}): DocumentParams {
  return {
    filePath: uri.fsPath,
    text,
    settings: toEngineSettings({ ...readUserCleanupSettings(), ...overrides }),
    unsavedDocuments: unsavedDocuments(uri),
  };
}

/** The user's settings in the server's shape, for requests that are not about one document. */
export function userEngineSettings(): DocumentParams['settings'] {
  return toEngineSettings(readUserCleanupSettings());
}

function unsavedDocuments(except: vscode.Uri): DocumentText[] {
  return vscode.workspace.textDocuments
    .filter(
      (document) =>
        !document.isClosed &&
        document.isDirty &&
        document.uri.scheme === 'file' &&
        document.uri.toString() !== except.toString() &&
        (document.languageId === 'csharp' || document.uri.fsPath.toLowerCase().endsWith('.cs'))
    )
    .map((document) => ({ path: document.uri.fsPath, text: document.getText() }));
}

/**
 * Shows why C# cleanup is unavailable, once per cause (until `codeJanitor.dotnetPath` changes), with a
 * link to install .NET when it is missing. Returns whether `err` was such a failure, which the caller
 * should then not report again per file.
 */
export function reportEngineUnavailable(err: unknown): boolean {
  if (!(err instanceof EngineUnavailableError)) {
    return false;
  }

  if (!reported.has(err.reason)) {
    reported.add(err.reason);
    logInfo(`C# cleanup is unavailable: ${err.message}`);
    const install = 'Install .NET';
    const actions = err.reason === 'dotnetMissing' ? [install, 'Open Settings'] : ['Show Output'];
    void vscode.window.showErrorMessage(`Code Janitor: ${err.message} C# cleanup is unavailable; other files are still cleaned.`, ...actions).then((choice) => {
      if (choice === install) {
        void vscode.env.openExternal(vscode.Uri.parse(DOTNET_DOWNLOAD_URL));
      } else if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'codeJanitor.dotnetPath');
      } else if (choice === 'Show Output') {
        void vscode.commands.executeCommand('codeJanitor.showOutputChannel');
      }
    });
  }

  return true;
}
