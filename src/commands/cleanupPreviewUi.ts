import * as vscode from 'vscode';
import { logInfo } from '../logging';
import {
  ApplyOutcome,
  CleanupPreviewPlan,
  PREVIEW_SCHEME,
  PreviewContentProvider,
  PreviewFile,
  PreviewRule,
  applyCleanupPreviewPlan,
  buildCleanupPreviewPlan,
} from './cleanupPreview';

/** What a preview command previews: the files of a scope, and how the plan treats them. */
export interface PreviewRequest {
  /** The files of the scope. */
  readonly uris: readonly vscode.Uri[];
  /** Shown when the scope has no files. */
  readonly emptyMessage: string;
  /** Cleanup Changed Files: with `codeJanitor.cleanup.onlyChangedLines`, only the lines changed since HEAD. */
  readonly honorOnlyChangedLines?: boolean;
}

const providers = new WeakMap<vscode.ExtensionContext, PreviewContentProvider>();

/** The virtual-document provider of the diffs, registered the first time a preview needs it. */
function contentProvider(context: vscode.ExtensionContext): PreviewContentProvider {
  let provider = providers.get(context);
  if (!provider) {
    provider = new PreviewContentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider));
    providers.set(context, provider);
  }

  return provider;
}

/**
 * The multi-file cleanup preview: builds the plan of the scope, lets the user review it - a native
 * diff per file, the files to include, the rules to apply to each - and applies the approval to the
 * editors. Nothing is saved, no AI is called and no file is written by the preview itself.
 */
export async function runCleanupPreview(context: vscode.ExtensionContext, request: PreviewRequest): Promise<void> {
  const { uris } = request;
  if (uris.length === 0) {
    void vscode.window.showInformationMessage(request.emptyMessage);

    return;
  }

  let cancelled = false;
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code Janitor: preparing the cleanup preview...', cancellable: true },
    (progress, token) =>
      buildCleanupPreviewPlan(uris, {
        honorOnlyChangedLines: request.honorOnlyChangedLines,
        isCancelled: () => (cancelled = token.isCancellationRequested),
        onProgress: (done, total) => progress.report({ message: `${done}/${total}`, increment: 100 / total }),
      })
  );

  if (cancelled) {
    void vscode.window.showInformationMessage('Code Janitor: the cleanup preview was cancelled; nothing was changed.');

    return;
  }

  for (const file of plan.files) {
    logInfo(`Cleanup preview: ${file.label} - ${file.message}${file.notes.length > 0 ? ` (${file.notes.join(' ')})` : ''}`);
  }

  const changing = plan.files.filter((file) => file.canApply).length;
  if (changing === 0) {
    void vscode.window.showInformationMessage(`Code Janitor: nothing to apply - ${summarize(plan)} (see the Code Janitor output).`);

    return;
  }

  const provider = contentProvider(context);
  try {
    if (!(await review(plan, provider))) {
      return;
    }

    if (plan.selected.length === 0) {
      void vscode.window.showInformationMessage('Code Janitor: no file was selected; nothing was changed.');

      return;
    }

    report(await applyCleanupPreviewPlan(plan));
  } finally {
    await closeDiffs();
    provider.release(plan);
  }
}

function summarize(plan: CleanupPreviewPlan): string {
  const parts = [
    `${plan.count('changes')} with changes`,
    `${plan.count('unchanged')} already clean`,
    `${plan.count('skipped')} skipped`,
    `${plan.count('error')} failed`,
  ];

  return parts.join(', ');
}

function report(outcome: ApplyOutcome): void {
  const { applied, stale, failed } = outcome;
  if (stale.length === 0 && failed.length === 0) {
    void vscode.window.showInformationMessage(
      `Code Janitor: cleanup preview applied to ${applied.length} file(s). No files were saved; undo reverts the whole operation.`
    );

    return;
  }

  const problems = [
    ...(stale.length > 0
      ? [`${stale.length} file(s) changed since the preview and were left as they are (preview again): ${stale.map((file) => file.label).join(', ')}`]
      : []),
    ...failed.map(({ file, reason }) => `${file.label}: ${reason}`),
  ];
  void vscode.window.showWarningMessage(
    `Code Janitor: cleanup preview applied to ${applied.length} file(s), not to ${stale.length + failed.length}. ${problems.join('; ')}.`
  );
}

// ---------------------------------------------------------------- review

interface FileItem extends vscode.QuickPickItem {
  readonly file: PreviewFile;
}

type Review = { readonly kind: 'apply' } | { readonly kind: 'cancel' } | { readonly kind: 'rules'; readonly file: PreviewFile };

const DIFF_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Show Diff' };
const RULES_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('checklist'), tooltip: 'Choose Rules...' };

const STATUS_ICON = { changes: 'diff', unchanged: 'check', skipped: 'circle-slash', error: 'error' } as const;

/** Alternates the file list and the rule choice of one file until the user applies or cancels. */
async function review(plan: CleanupPreviewPlan, provider: PreviewContentProvider): Promise<boolean> {
  for (;;) {
    const result = await pickFiles(plan, provider);
    if (result.kind === 'rules') {
      await chooseRules(plan, result.file, provider);
    } else {
      return result.kind === 'apply';
    }
  }
}

function ruleSummary(file: PreviewFile): string {
  const changed = file.rules.filter((rule) => rule.outcome === 'Changed').map((rule) => rule.name);
  const shown = changed.slice(0, 4).join(', ');

  return changed.length > 4 ? `${shown} and ${changed.length - 4} more` : shown;
}

function fileItem(file: PreviewFile): FileItem {
  const detail = [
    ruleSummary(file),
    file.unresolved > 0 ? `${file.unresolved} .editorconfig violation(s) not fixed` : '',
    ...file.notes,
  ].filter((part) => part.length > 0);

  return {
    label: `$(${STATUS_ICON[file.status]}) ${file.label}`,
    description: file.message,
    detail: detail.length > 0 ? detail.join(' - ') : undefined,
    buttons: file.canApply ? [DIFF_BUTTON, RULES_BUTTON] : [],
    file,
  };
}

/** Files with changes first, then clean files, then the skipped and failed ones. */
function orderedFiles(plan: CleanupPreviewPlan): PreviewFile[] {
  const rank = { changes: 0, unchanged: 1, skipped: 2, error: 3 } as const;

  return [...plan.files].sort((a, b) => rank[a.status] - rank[b.status]);
}

function pickFiles(plan: CleanupPreviewPlan, provider: PreviewContentProvider): Promise<Review> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<FileItem>();
    const items = orderedFiles(plan).map(fileItem);
    const updateTitle = () => {
      picker.title = `Code Janitor: Cleanup Preview - ${plan.selected.length} of ${plan.count('changes')} file(s) selected (${summarize(plan)})`;
    };

    picker.canSelectMany = true;
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.placeholder = 'Check the files to clean up and press Enter; the buttons show the diff or choose the rules of a file';
    picker.items = items;
    picker.selectedItems = items.filter((item) => item.file.include && item.file.canApply);
    updateTitle();

    let settled = false;
    const finish = (result: Review) => {
      if (!settled) {
        settled = true;
        resolve(result);
        picker.hide();
      }
    };

    picker.onDidChangeSelection((selection) => {
      const chosen = new Set(selection);
      let rejected = false;
      for (const item of items) {
        if (item.file.canApply) {
          item.file.include = chosen.has(item);
        } else if (chosen.has(item)) {
          rejected = true;
        }
      }

      if (rejected) {
        picker.selectedItems = items.filter((item) => item.file.include);
      }

      updateTitle();
    });

    picker.onDidChangeActive((active) => {
      const file = active[0]?.file;
      if (file?.canApply) {
        void showDiff(plan, file, provider);
      }
    });

    picker.onDidTriggerItemButton((event) => {
      if (event.button === RULES_BUTTON) {
        finish({ kind: 'rules', file: event.item.file });
      } else {
        void showDiff(plan, event.item.file, provider);
      }
    });

    picker.onDidAccept(() => {
      if (plan.selected.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: check at least one file, or press Escape to cancel.');

        return;
      }

      finish({ kind: 'apply' });
    });

    picker.onDidHide(() => {
      finish({ kind: 'cancel' });
      picker.dispose();
    });

    picker.show();
  });
}

function outcomeText(rule: PreviewRule): string {
  return rule.outcome === 'Changed' ? `Changed (${rule.changes} ${rule.changes === 1 ? 'change' : 'changes'})` : rule.outcome;
}

/** The rules of one file; the result is recomputed from the file's original text. */
async function chooseRules(plan: CleanupPreviewPlan, file: PreviewFile, provider: PreviewContentProvider): Promise<void> {
  const choices = file.rules.map((rule) => ({
    label: rule.name,
    description: rule.group ? `${rule.group} - ${outcomeText(rule)}` : outcomeText(rule),
    picked: rule.include,
    key: rule.key,
  }));
  const picked = await vscode.window.showQuickPick(choices, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `Code Janitor: rules for ${file.label}`,
    placeHolder: 'Clear the rules you do not want applied to this file',
  });
  if (picked) {
    file.setIncludedRules(new Set(picked.map((choice) => choice.key)));
    if (file.canApply) {
      await showDiff(plan, file, provider);
    }
  }
}

async function showDiff(plan: CleanupPreviewPlan, file: PreviewFile, provider: PreviewContentProvider): Promise<void> {
  const { before, after } = provider.publish(plan, file);
  try {
    await vscode.commands.executeCommand('vscode.diff', before, after, `Code Janitor: Cleanup Preview (${file.label})`, {
      preview: true,
      preserveFocus: true,
    });
  } catch (err) {
    logInfo(`Cleanup preview: the diff of ${file.label} could not be opened (${(err as Error).message}).`);
  }
}

/** The diff tabs of the preview show virtual documents that are about to disappear. */
async function closeDiffs(): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      const input = tab.input as { modified?: vscode.Uri } | undefined;

      return input?.modified?.scheme === PREVIEW_SCHEME;
    });
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs);
  }
}
