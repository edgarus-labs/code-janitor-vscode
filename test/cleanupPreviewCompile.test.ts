import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { newCompilerErrors } from '../scripts/compileOracle';
import { registerCleanupCommands } from '../src/commands/cleanupCommands';
import { runCleanupOnUris } from '../src/commands/cleanupCore';
import { BuildResult, DEFAULT_CSPROJ, buildProject, dotnetAvailable, formatErrors } from './helpers/dotnetBuild';
import { FakeQuickPick, assertScriptsPassed, installPreviewMock, previewState } from './helpers/previewMock';
import { PreviewProject, csharpFiles, previewProject, removeTempDirectories, restoreOriginals } from './helpers/previewFixtures';
import { TextDocument, createContext, resetMock, state } from './helpers/vscodeMock';

/**
 * Real-compiler proof of the multi-file cleanup preview: the fixture project (several C# files with
 * mixed rules) is built, previewed and applied in each scope, and built again. The applied text
 * must equal what the ordinary cleanup makes of the same files, and must not add compiler errors.
 */
describe.skipIf(!dotnetAvailable)('cleanup preview against the real C# compiler', () => {
  let before: BuildResult;

  /** Writes the fixture project with a csproj to disk and keeps the mock file system in sync. */
  function project(): PreviewProject {
    const created = previewProject();
    fs.writeFileSync(path.join(created.root, 'Test.csproj'), DEFAULT_CSPROJ);

    return created;
  }

  beforeAll(() => {
    const first = project();
    before = buildProject(first.root);
    removeTempDirectories();
  }, 180_000);

  beforeEach(() => {
    resetMock();
    installPreviewMock();
    registerCleanupCommands(createContext());
  });

  afterEach(() => {
    removeTempDirectories();
    assertScriptsPassed();
  });

  const accept = (picker: FakeQuickPick) => picker.accept();

  /** The text each file has in the editors after the preview - what the user would save. */
  function editorTexts(created: PreviewProject, files: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      files.map((file) => {
        const document = state.documents.find((candidate) => candidate.uri.fsPath === created.file(file));

        return [file, document ? document.getText() : state.files.get(created.file(file))!];
      })
    );
  }

  /** The ordinary (non-preview) cleanup of the original text; open editors get their original text back first and after. */
  async function ordinaryCleanup(created: PreviewProject, files: readonly string[]): Promise<Record<string, string>> {
    const current = new Map(state.files);
    const editors = state.documents.map((document) => [document, document.getText()] as const);
    restoreOriginals(created);
    editors.forEach(([document]) => document.setText(created.originals.get(document.uri.fsPath)!));
    try {
      await runCleanupOnUris(createContext(), files.map((file) => created.uri(file)));

      return editorTexts(created, files);
    } finally {
      state.files = current;
      editors.forEach(([document, text]) => document.setText(text));
    }
  }

  /** Saves the approved texts, builds and checks that cleanup added no compiler error. */
  function expectStillCompiles(created: PreviewProject, texts: Record<string, string>): void {
    for (const [file, text] of Object.entries(texts)) {
      fs.writeFileSync(created.file(file), text);
    }

    const after = buildProject(created.root);
    expect(newCompilerErrors(before.errors, after.errors), formatErrors(after)).toEqual([]);
    expect(after.ok, formatErrors(after)).toBe(true);
  }

  it('builds the fixture project before the preview', () => {
    expect(before.errors, formatErrors(before)).toEqual([]);
    expect(before.ok, before.output).toBe(true);
  });

  it('selected files and folders: applied text equals the ordinary cleanup and compiles', async () => {
    const created = project();
    const files = csharpFiles(created);
    state.directories.add(created.file('Models'));
    state.foundFiles = [created.uri('Models/Customer.cs'), created.uri('Models/Order.cs')];
    user(accept);

    await run('codeJanitor.previewCleanupSelectedFiles', created.uri('Models'), [
      created.uri('Models'),
      created.uri('Services/Legacy.cs'),
      created.uri('Services/Pricing.cs'),
      created.uri('Program.cs'),
      created.uri('Notes.txt'),
    ]);

    const texts = editorTexts(created, files);
    expect(texts).toEqual(await ordinaryCleanup(created, files));
    expect(texts['Models/Customer.cs']).not.toBe(created.originals.get(created.file('Models/Customer.cs')));
    expectStillCompiles(created, texts);
  }, 180_000);

  it('open files: applied text equals the ordinary cleanup and compiles', async () => {
    const created = project();
    const files = csharpFiles(created);
    for (const file of files) {
      state.documents.push(new TextDocument(created.uri(file), created.originals.get(created.file(file))!, 'csharp'));
    }

    user(accept);

    await run('codeJanitor.previewCleanupOpenFiles');

    const texts = editorTexts(created, files);
    expect(texts).toEqual(await ordinaryCleanup(created, files));
    expect(texts['Program.cs']).toContain('= new();');
    // Nothing was saved: the disk still has the original text.
    expect(fs.readFileSync(created.file('Program.cs'), 'utf8')).toBe(created.originals.get(created.file('Program.cs')));
    expectStillCompiles(created, texts);
  }, 180_000);

  it('changed files: applied text equals the ordinary cleanup and compiles', async () => {
    const created = project();
    const files = ['Models/Order.cs', 'Program.cs', 'Services/Legacy.cs'];
    state.extensions.set('vscode.git', {
      activate: () =>
        Promise.resolve({
          getAPI: () => ({
            repositories: [{ state: { workingTreeChanges: files.map((file) => ({ uri: created.uri(file) })), indexChanges: [], mergeChanges: [] } }],
          }),
        }),
    });
    user(accept);

    await run('codeJanitor.previewCleanupChangedFiles');

    const texts = editorTexts(created, files);
    expect(texts).toEqual(await ordinaryCleanup(created, files));
    expectStillCompiles(created, texts);
  }, 180_000);

  it('workspace: applied text equals the ordinary cleanup and compiles, with rules left out per file', async () => {
    const created = project();
    const files = csharpFiles(created);
    state.foundFiles = files.map((file) => created.uri(file));
    // Order.cs without its brace rule: the approved text is the cleanup minus that rule, and still compiles.
    user(
      (picker) => picker.clickButton('Order.cs', 'Choose Rules...'),
      accept
    );
    state.quickPickSelections = [['Remove trailing whitespace', 'Normalize blank lines', 'IDE0090']];

    await run('codeJanitor.previewCleanupWorkspace');

    const texts = editorTexts(created, files);
    const ordinary = await ordinaryCleanup(created, files);
    expect({ ...texts, 'Models/Order.cs': '' }).toEqual({ ...ordinary, 'Models/Order.cs': '' });
    expect(texts['Models/Order.cs']).toContain('if (price < 0)\n                throw');
    expect(texts['Models/Order.cs']).not.toBe(ordinary['Models/Order.cs']);
    expectStillCompiles(created, texts);
  }, 180_000);

  it('refuses the file edited after the plan and the rest still compiles', async () => {
    const created = project();
    const files = csharpFiles(created);
    state.foundFiles = files.map((file) => created.uri(file));
    const edited = `${created.originals.get(created.file('Program.cs'))}// edited after the plan\n`;
    user((picker) => {
      state.files.set(created.file('Program.cs'), edited);
      picker.accept();
    });

    await run('codeJanitor.previewCleanupWorkspace');

    const texts = editorTexts(created, files);
    expect(texts['Program.cs']).toBe(edited);
    expect(state.warningMessages.at(-1)).toContain('changed since the preview');
    expect(texts['Models/Customer.cs']).not.toBe(created.originals.get(created.file('Models/Customer.cs')));
    expectStillCompiles(created, texts);
  }, 180_000);

  function user(...steps: ((picker: FakeQuickPick) => void | Promise<void>)[]): void {
    previewState.pickerScripts.push(...steps);
  }

  async function run(command: string, ...args: unknown[]): Promise<void> {
    await state.commands.get(command)!(...args);
    assertScriptsPassed();
  }
});
