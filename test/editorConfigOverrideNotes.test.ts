import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDefiningEditorConfigPath } from '../src/cleanup/editorconfig';
import { editorConfigOverrideNotes } from '../src/cleanup/overrideNotes';
import { createDefaultSettings } from '../src/cleanup/types';

/** Ported from `EditorConfigOverrideNotesTests.cs` of the Visual Studio extension. */

const EXPLICIT_ACCESS_MODIFIER_SETTINGS = [
  'insertExplicitAccessModifiersOnClasses',
  'insertExplicitAccessModifiersOnDelegates',
  'insertExplicitAccessModifiersOnEnumerations',
  'insertExplicitAccessModifiersOnEvents',
  'insertExplicitAccessModifiersOnFields',
  'insertExplicitAccessModifiersOnInterfaces',
  'insertExplicitAccessModifiersOnMethods',
  'insertExplicitAccessModifiersOnProperties',
  'insertExplicitAccessModifiersOnStructs',
];

let tempDirectory: string;
let workspace: string;

function writeEditorConfig(directory: string, isRoot: boolean, ...csharpOptions: string[]): string {
  const lines = [...(isRoot ? ['root = true', ''] : []), '[*.cs]', ...csharpOptions, ''];
  const configPath = path.join(directory, '.editorconfig');
  fs.writeFileSync(configPath, lines.join('\r\n'));

  return configPath;
}

function notesOf(root: string | undefined = workspace): ReadonlyMap<string, string> {
  return editorConfigOverrideNotes(root, createDefaultSettings());
}

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-notes-'));
  workspace = path.join(tempDirectory, 'repo');
  fs.mkdirSync(workspace);
  // An empty root .editorconfig above the workspace isolates every test from configuration files on the machine.
  writeEditorConfig(tempDirectory, true);
});

afterEach(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('override notes', () => {
  it.each([
    ['trim_trailing_whitespace = true', 'removeEndOfLineWhitespace', 'trim_trailing_whitespace'],
    ['csharp_style_var_when_type_is_apparent = false:warning', 'convertToVarWhenApparent', 'csharp_style_var_when_type_is_apparent'],
    ['csharp_style_inlined_variable_declaration = true:suggestion', 'inlineOutVariableDeclarations', 'csharp_style_inlined_variable_declaration'],
    ['dotnet_style_prefer_collection_expression = when_types_loosely_match', 'convertToCollectionExpressions', 'dotnet_style_prefer_collection_expression'],
    ['dotnet_style_readonly_field = true:suggestion', 'makeFieldsReadonlyWhenSafe', 'dotnet_style_readonly_field'],
    ['csharp_style_namespace_declarations = file_scoped:warning', 'convertToFileScopedNamespace', 'csharp_style_namespace_declarations'],
    ['csharp_using_directive_placement = inside_namespace', 'moveUsingsOutsideNamespace', 'csharp_using_directive_placement'],
    ['file_header_template = Copyright (c) Contoso', 'fileHeaderCSharp', 'file_header_template'],
    ['csharp_style_expression_bodied_lambdas = false:warning', 'simplifySingleStatementLambdas', 'csharp_style_expression_bodied_lambdas'],
    ['dotnet_diagnostic.CA1852.severity = warning', 'sealClassesWhenSafe', 'dotnet_diagnostic.ca1852.severity'],
    ['dotnet_style_allow_multiple_blank_lines_experimental = false', 'removeMultipleConsecutiveBlankLines', 'dotnet_style_allow_multiple_blank_lines_experimental'],
    ['csharp_prefer_braces = when_multiline:warning', 'csharp_prefer_braces', 'csharp_prefer_braces'],
    ['dotnet_diagnostic.IDE0003.severity = error', 'dotnet_style_qualification_for_event', 'dotnet_diagnostic.ide0003.severity'],
    ['dotnet_sort_system_directives_first = true', 'organizeUsings', 'dotnet_sort_system_directives_first'],
    ['dotnet_separate_import_directive_groups = true', 'organizeUsings', 'dotnet_separate_import_directive_groups'],
  ])('names the key and the defining file for %s', (option, settingName, key) => {
    const configPath = writeEditorConfig(workspace, false, option);

    expect(notesOf().get(settingName)).toBe(`Overridden by .editorconfig: ${key} in ${configPath}`);
  });

  it('annotates every explicit access modifier setting for the accessibility modifiers key', () => {
    writeEditorConfig(workspace, false, 'dotnet_style_require_accessibility_modifiers = always:warning');

    const notes = notesOf();

    for (const setting of EXPLICIT_ACCESS_MODIFIER_SETTINGS) {
      expect(notes.get(setting), setting).toContain('dotnet_style_require_accessibility_modifiers');
    }
  });

  it('annotates exactly the mapped settings when every mapped key is defined', () => {
    writeEditorConfig(
      workspace,
      false,
      'trim_trailing_whitespace = true',
      'insert_final_newline = true',
      'file_header_template = Header',
      'csharp_style_var_when_type_is_apparent = true',
      'csharp_style_inlined_variable_declaration = true',
      'dotnet_style_prefer_collection_expression = true',
      'dotnet_style_readonly_field = true',
      'dotnet_style_require_accessibility_modifiers = always',
      'csharp_style_namespace_declarations = file_scoped',
      'csharp_using_directive_placement = outside_namespace',
      'indent_style = space',
      'dotnet_sort_system_directives_first = true'
    );

    expect([...notesOf().keys()].sort()).toEqual(
      [
        ...EXPLICIT_ACCESS_MODIFIER_SETTINGS,
        'convertToCollectionExpressions',
        'convertToFileScopedNamespace',
        'convertToVarWhenApparent',
        'fileHeaderCSharp',
        'inlineOutVariableDeclarations',
        'makeFieldsReadonlyWhenSafe',
        'moveUsingsOutsideNamespace',
        'organizeUsings',
        'removeEndOfLineWhitespace',
      ].sort()
    );
  });

  it.each([
    ['csharp_style_var_when_type_is_apparent = true:none', 'severity none'],
    ['csharp_style_var_when_type_is_apparent = true:silent', 'severity silent'],
    ['csharp_style_var_when_type_is_apparent = maybe', 'unrecognized value'],
    ['csharp_style_var_when_type_is_apparent = true:loud', 'unrecognized severity'],
  ])('has no note for a key that is not enforced: %s (%s)', (option) => {
    writeEditorConfig(workspace, false, option);

    expect(notesOf().has('convertToVarWhenApparent')).toBe(false);
  });

  it('has no note for a setting without an .editorconfig key', () => {
    writeEditorConfig(workspace, false, 'csharp_style_var_when_type_is_apparent = true');

    expect(notesOf().has('sealClassesWhenSafe')).toBe(false);
  });

  it('names the parent file for a key only the parent config defines', () => {
    writeEditorConfig(workspace, false, 'dotnet_style_readonly_field = true');
    const parentPath = writeEditorConfig(tempDirectory, true, 'csharp_style_var_when_type_is_apparent = true');

    expect(notesOf().get('convertToVarWhenApparent')).toBe(`Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in ${parentPath}`);
  });

  it('names the nearest file for a key in the workspace and its parent', () => {
    writeEditorConfig(tempDirectory, true, 'csharp_style_var_when_type_is_apparent = true');
    const nearestPath = writeEditorConfig(workspace, false, 'csharp_style_var_when_type_is_apparent = false');

    expect(notesOf().get('convertToVarWhenApparent')).toBe(`Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in ${nearestPath}`);
  });

  it('has no note for a key above a root config', () => {
    const outer = path.join(tempDirectory, 'outer');
    const inner = path.join(outer, 'repo');
    fs.mkdirSync(inner, { recursive: true });
    writeEditorConfig(outer, false, 'csharp_style_var_when_type_is_apparent = true');
    writeEditorConfig(inner, true, 'dotnet_style_readonly_field = true');

    expect(notesOf(inner).has('convertToVarWhenApparent')).toBe(false);
  });

  it('ignores a key only in a nested project config', () => {
    const project = path.join(workspace, 'src');
    fs.mkdirSync(project);
    writeEditorConfig(project, false, 'csharp_style_var_when_type_is_apparent = true');

    expect(notesOf().has('convertToVarWhenApparent')).toBe(false);
  });

  it('ignores a key in a non-C# section', () => {
    fs.writeFileSync(path.join(workspace, '.editorconfig'), '[*.vb]\r\ndotnet_style_readonly_field = true\r\n');

    expect(notesOf().has('makeFieldsReadonlyWhenSafe')).toBe(false);
  });

  it.each([undefined, '', '   '])('has no notes without a usable workspace (%j)', (root) => {
    writeEditorConfig(workspace, false, 'csharp_style_var_when_type_is_apparent = true');

    expect(editorConfigOverrideNotes(root, createDefaultSettings()).size).toBe(0);
  });

  it('resolves the defining file once per key, however many settings it decides', () => {
    writeEditorConfig(workspace, false, 'dotnet_style_require_accessibility_modifiers = always', 'trim_trailing_whitespace = true');
    const lookups: string[] = [];

    editorConfigOverrideNotes(workspace, createDefaultSettings(), (_probe, key) => {
      lookups.push(key);

      return 'defining.editorconfig';
    });

    expect(lookups.sort()).toEqual(['dotnet_style_require_accessibility_modifiers', 'trim_trailing_whitespace']);
  });

  it('names only the key when the defining file is unresolved', () => {
    writeEditorConfig(workspace, false, 'csharp_style_var_when_type_is_apparent = true');

    const notes = editorConfigOverrideNotes(workspace, createDefaultSettings(), () => undefined);

    expect(notes.get('convertToVarWhenApparent')).toBe('Overridden by .editorconfig: csharp_style_var_when_type_is_apparent');
  });

  it('notes a Code Style rule enforced by .editorconfig, but not one it leaves alone', () => {
    const configPath = writeEditorConfig(workspace, false, 'csharp_prefer_braces = true:warning', 'dotnet_style_null_propagation = true:silent');

    const notes = editorConfigOverrideNotes(workspace, { ...createDefaultSettings(), codeStyleRules: { csharp_prefer_braces: 'false', dotnet_style_null_propagation: 'true' } });

    expect(notes.get('csharp_prefer_braces')).toBe(`Overridden by .editorconfig: csharp_prefer_braces in ${configPath}`);
    expect(notes.has('dotnet_style_null_propagation')).toBe(false);
  });

  it('attributes a rule enforced by the project rule set to the project, without an .editorconfig lookup', () => {
    fs.writeFileSync(
      path.join(workspace, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AnalysisMode>All</AnalysisMode></PropertyGroup></Project>'
    );
    writeEditorConfig(workspace, false, 'indent_style = space');
    const lookups: string[] = [];

    const notes = editorConfigOverrideNotes(workspace, createDefaultSettings(), (_file, key) => {
      lookups.push(key);
      return undefined;
    });

    expect(notes.get('sealClassesWhenSafe')).toBe("Overridden by the project's AnalysisLevel/AnalysisMode");
    expect(lookups).not.toContain('AnalysisLevel/AnalysisMode');
  });
});

describe('findDefiningEditorConfigPath', () => {
  it('returns nothing for a key no file applies, or for a blank path', () => {
    writeEditorConfig(workspace, false, 'dotnet_style_readonly_field = true');

    expect(findDefiningEditorConfigPath(path.join(workspace, 'Sample.cs'), 'csharp_prefer_braces')).toBeUndefined();
    expect(findDefiningEditorConfigPath('', 'dotnet_style_readonly_field')).toBeUndefined();
  });
});
