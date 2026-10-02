import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRepositoryPolicy, findRepositoryConfigFile, parseRepositoryPolicy, readRepositoryPolicy } from '../src/cleanup/repositoryOverrides';
import { HeaderPosition, HeaderUpdateMode, createDefaultSettings } from '../src/cleanup/types';

/** Ported from `RepositoryCleanupSettingsTests.cs` of the Visual Studio extension. */

describe('parseRepositoryPolicy', () => {
  it('maps camelCase keys onto the cleanup settings', () => {
    const { overrides } = parseRepositoryPolicy('{ "cleanup": { "convertToVarWhenApparent": true, "removeEndOfLineWhitespace": false } }');

    expect(overrides).toEqual({ convertToVarWhenApparent: true, removeEndOfLineWhitespace: false });
  });

  it('applies the group aliases and lets individual keys win', () => {
    const { overrides } = parseRepositoryPolicy(
      '{ "cleanup": { "insertBlankLinePadding": false, "insertBlankLinePaddingBeforeClasses": true, "insertExplicitAccessModifiers": false } }'
    );

    // The alias fans out to the group members.
    expect(overrides.insertBlankLinePaddingAfterMethods).toBe(false);
    expect(overrides.insertExplicitAccessModifiersOnMethods).toBe(false);
    // The individual key overrides the alias.
    expect(overrides.insertBlankLinePaddingBeforeClasses).toBe(true);
    // Keys outside the alias target list remain untouched.
    expect(overrides.insertBlankLinePaddingBeforeSingleLineComments).toBeUndefined();
  });

  it('ignores unknown keys, wrong types and invalid JSON', () => {
    expect(parseRepositoryPolicy('{ this is not json')).toEqual({ overrides: {}, codeStyle: {} });
    expect(parseRepositoryPolicy('{ "other": {} }')).toEqual({ overrides: {}, codeStyle: {} });
    expect(parseRepositoryPolicy('{ "cleanup": [] }')).toEqual({ overrides: {}, codeStyle: {} });

    const { overrides } = parseRepositoryPolicy('{ "cleanup": { "unknownKey": true, "convertToVarWhenApparent": "yes", "removeRegions": "no", "codeStyleRules": {} } }');

    expect(overrides).toEqual({});
  });

  it('maps the header enums and text', () => {
    const { overrides } = parseRepositoryPolicy(
      '{ "cleanup": { "fileHeaderCSharp": "// Copyright", "fileHeaderPosition": "afterUsings", "fileHeaderUpdateMode": "replace" } }'
    );

    expect(overrides).toEqual({
      fileHeaderCSharp: '// Copyright',
      fileHeaderPosition: HeaderPosition.AfterUsings,
      fileHeaderUpdateMode: HeaderUpdateMode.Replace,
    });
    expect(parseRepositoryPolicy('{ "cleanup": { "fileHeaderPosition": "middle" } }').overrides).toEqual({});
    expect(parseRepositoryPolicy('{ "cleanup": { "fileHeaderPosition": "replace", "fileHeaderUpdateMode": "afterUsings" } }').overrides).toEqual({});
    expect(parseRepositoryPolicy('{ "cleanup": { "fileHeaderPosition": "insert", "fileHeaderUpdateMode": "documentStart" } }').overrides).toEqual({});
  });

  it('accepts the VS Code alias for return and throw padding, and the long key', () => {
    expect(parseRepositoryPolicy('{ "cleanup": { "insertBlankLineBeforeReturnAndThrow": true } }').overrides).toEqual({
      insertBlankLineBeforeReturnAndThrowStatements: true,
    });
    expect(parseRepositoryPolicy('{ "cleanup": { "insertBlankLineBeforeReturnAndThrowStatements": false } }').overrides).toEqual({
      insertBlankLineBeforeReturnAndThrowStatements: false,
    });
  });

  it('reads the region and using organization policies', () => {
    expect(parseRepositoryPolicy('{ "cleanup": { "removeRegions": false, "organizeUsings": true } }').overrides).toEqual({
      removeRegions: false,
      organizeUsings: true,
    });
  });

  it('reports the Visual Studio-only keys as ignored', () => {
    const ignored: string[] = [];

    parseRepositoryPolicy('{ "cleanup": { "applyEditorConfigNaming": true, "applyAnalyzerCodeFixes": false } }', (key) => ignored.push(key));

    expect(ignored).toEqual(['applyEditorConfigNaming', 'applyAnalyzerCodeFixes']);
  });

  it('reads the codeStyle section: a valid value enables a rule ignoring case, null disables it', () => {
    const { codeStyle } = parseRepositoryPolicy(
      '{ "cleanup": { "codeStyle": { "csharp_prefer_braces": "True", "dotnet_style_null_propagation": "sometimes", "csharp_style_throw_expression": null, "unknown_rule": "true", "csharp_prefer_simple_using_statement": true } } }'
    );

    expect(codeStyle).toEqual({ csharp_prefer_braces: 'true', csharp_style_throw_expression: null });
  });

  it('ignores a codeStyle section that is not an object', () => {
    expect(parseRepositoryPolicy('{ "cleanup": { "codeStyle": ["csharp_prefer_braces"] } }').codeStyle).toEqual({});
    expect(parseRepositoryPolicy('{ "cleanup": { "codeStyle": "x" } }').codeStyle).toEqual({});
  });
});

describe('applyRepositoryPolicy', () => {
  it('lets a key in the policy win over the user setting', () => {
    const user = { ...createDefaultSettings(), convertToVarWhenApparent: false, removeRegions: true };
    const policy = parseRepositoryPolicy('{ "cleanup": { "convertToVarWhenApparent": true, "removeRegions": false } }');

    const merged = applyRepositoryPolicy(user, policy);

    expect(merged.convertToVarWhenApparent).toBe(true);
    expect(merged.removeRegions).toBe(false);
    expect(merged.organizeUsings).toBe(user.organizeUsings);
  });

  it('merges the Code Style rules: the policy enables, changes or disables, the rest follows the user', () => {
    const user = { ...createDefaultSettings(), codeStyleRules: { csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' } };
    const policy = parseRepositoryPolicy(
      '{ "cleanup": { "codeStyle": { "csharp_prefer_braces": "false", "dotnet_style_null_propagation": null, "csharp_style_throw_expression": "true", "unknown_rule": "true" } } }'
    );

    expect(applyRepositoryPolicy(user, policy).codeStyleRules).toEqual({ csharp_prefer_braces: 'false', csharp_style_throw_expression: 'true' });
  });
});

describe('readRepositoryPolicy', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-policy-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('walks up from the cleaned file directory to the nearest config', () => {
    fs.writeFileSync(path.join(root, '.codejanitor'), '{ "cleanup": { "convertToVarWhenApparent": true } }');
    const nested = path.join(root, 'src', 'App');
    fs.mkdirSync(nested, { recursive: true });

    const policy = readRepositoryPolicy(nested);

    expect(policy.overrides.convertToVarWhenApparent).toBe(true);
    expect(policy.configPath).toBe(path.join(root, '.codejanitor'));
  });

  it('prefers the nearest directory, and the alternate file name', () => {
    fs.writeFileSync(path.join(root, '.code-janitor.json'), '{ "cleanup": { "convertToVarWhenApparent": true, "organizeUsings": true } }');
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, '.code-janitor.json'), '{ "cleanup": { "convertToVarWhenApparent": false } }');

    const policy = readRepositoryPolicy(nested);

    // The nearest file wins as a whole: it is not merged with the parent's.
    expect(policy.overrides).toEqual({ convertToVarWhenApparent: false });
    expect(findRepositoryConfigFile(nested)).toBe(path.join(nested, '.code-janitor.json'));
  });

  it('prefers .codejanitor over .code-janitor.json in the same directory', () => {
    fs.writeFileSync(path.join(root, '.codejanitor'), '{ "cleanup": { "removeRegions": false } }');
    fs.writeFileSync(path.join(root, '.code-janitor.json'), '{ "cleanup": { "removeRegions": true } }');

    expect(readRepositoryPolicy(root).overrides.removeRegions).toBe(false);
  });

  it('gives different files different policies', () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, '.codejanitor'), '{ "cleanup": { "removeRegions": false } }');
    fs.writeFileSync(path.join(b, '.codejanitor'), '{ "cleanup": { "removeRegions": true, "organizeUsings": true } }');

    expect(readRepositoryPolicy(a).overrides).toEqual({ removeRegions: false });
    expect(readRepositoryPolicy(b).overrides).toEqual({ removeRegions: true, organizeUsings: true });
  });

  it('ignores a directory named like the config file', () => {
    fs.mkdirSync(path.join(root, '.codejanitor'));
    fs.writeFileSync(path.join(root, '.code-janitor.json'), '{ "cleanup": { "removeRegions": false } }');

    expect(readRepositoryPolicy(root).overrides.removeRegions).toBe(false);
  });

  it('is empty without a config, without a start directory and for invalid JSON', () => {
    const empty = { overrides: {}, codeStyle: {} };
    const isolated = path.join(root, 'isolated');
    fs.mkdirSync(isolated);
    fs.writeFileSync(path.join(isolated, '.codejanitor'), '{ not json');

    expect(readRepositoryPolicy(undefined)).toEqual(empty);
    expect(readRepositoryPolicy(isolated).overrides).toEqual({});
  });

  it('logs a Visual Studio-only key once per session and file', () => {
    fs.writeFileSync(path.join(root, '.codejanitor'), '{ "cleanup": { "applyEditorConfigCodeStyle": true } }');
    const messages: string[] = [];

    readRepositoryPolicy(root, (message) => messages.push(message));
    readRepositoryPolicy(root, (message) => messages.push(message));

    expect(messages).toEqual([expect.stringMatching(/'\.codejanitor' key applyEditorConfigCodeStyle is ignored by VS Code: \.editorconfig rules always apply\.$/)]);
  });
});
