import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectiveCleanupSettings, resolveEffectiveCleanupSettings } from '../src/cleanup/effectiveSettings';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../src/cleanup/repositoryOverrides';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

/**
 * Behavioral tests for `resolveEffectiveCleanupSettings`, ported from `EffectiveCleanupSettingsTests.cs` and
 * `CodeStyleSeverityPrecedenceTests.cs` of the Visual Studio extension: `.editorconfig` wins for every mapped
 * key, the repository policy (`.codejanitor`) wins otherwise, and the user's settings apply last. The steps of
 * Visual Studio's own formatter (`indent_*`, `insert_final_newline`, IDE0005, IDE0055) have no setting here.
 */

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
] as const;

let tempDirectory: string;
let filePath: string;

function writeRootEditorConfig(...csharpOptions: (string | undefined)[]): void {
  const lines = ['root = true', '', '[*.cs]', ...csharpOptions.filter((option): option is string => option !== undefined), ''];
  fs.writeFileSync(path.join(tempDirectory, '.editorconfig'), lines.join('\r\n'));
}

function writePolicy(cleanupEntries: string): void {
  fs.writeFileSync(path.join(tempDirectory, '.codejanitor'), `{ "cleanup": { ${cleanupEntries} } }`);
}

/** The effective settings of `Sample.cs`: the repository policy over the user's settings, then `.editorconfig`. */
function resolve(user: Partial<CleanupSettings> = {}, target: string = filePath): EffectiveCleanupSettings {
  const merged = applyRepositoryPolicy({ ...createDefaultSettings(), ...user }, readRepositoryPolicy(path.dirname(target)));

  return resolveEffectiveCleanupSettings(target, merged);
}

function keyOf(effective: EffectiveCleanupSettings, setting: string): string | undefined {
  return effective.editorConfigKeys.get(setting);
}

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-effective-'));
  filePath = path.join(tempDirectory, 'Sample.cs');
  // Isolates every test from configuration files above the temp directory: an empty root .editorconfig and an
  // empty repository policy (the nearest policy file wins).
  writeRootEditorConfig();
  writePolicy('');
});

afterEach(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('precedence: .editorconfig, then .codejanitor, then user settings', () => {
  it('lets an enforced .editorconfig value beat the repository policy and the user setting', () => {
    writePolicy('"convertToVarWhenApparent": true');
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = false:warning');

    expect(resolve({ convertToVarWhenApparent: true }).settings.convertToVarWhenApparent).toBe(false);
  });

  it('uses the repository policy over the user setting when .editorconfig is silent on the key', () => {
    writePolicy('"makeFieldsReadonlyWhenSafe": true');
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = true');

    expect(resolve({ makeFieldsReadonlyWhenSafe: false }).settings.makeFieldsReadonlyWhenSafe).toBe(true);
  });

  it('uses the user setting when neither file defines the key', () => {
    writePolicy('"convertToVarWhenApparent": false');
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = true');

    expect(resolve({ makeFieldsReadonlyWhenSafe: true }).settings.makeFieldsReadonlyWhenSafe).toBe(true);
  });

  it('lets a key in .codejanitor win over the user setting, in both directions', () => {
    writePolicy('"removeRegions": false, "organizeUsings": true');

    const settings = resolve({ removeRegions: true, organizeUsings: false }).settings;

    expect(settings.removeRegions).toBe(false);
    expect(settings.organizeUsings).toBe(true);
  });

  it('uses the user settings only for a blank path', () => {
    const user = { convertToVarWhenApparent: true, convertToFileScopedNamespace: true, moveUsingsOutsideNamespace: false };

    const effective = resolveEffectiveCleanupSettings('', { ...createDefaultSettings(), ...user });

    expect(effective.settings.convertToVarWhenApparent).toBe(true);
    expect(effective.namespaceDeclarations).toBe('fileScoped');
    expect(effective.usingDirectivePlacement).toBe('unchanged');
    expect(effective.settings.removeRegions).toBe(true);
    expect(effective.settings.organizeUsings).toBe(false);
    expect(effective.editorConfigKeys.size).toBe(0);
  });
});

describe('namespace declarations', () => {
  it('lets file_scoped in .editorconfig override a disabled user setting', () => {
    writeRootEditorConfig('csharp_style_namespace_declarations = file_scoped:suggestion');

    const effective = resolve({ convertToFileScopedNamespace: false });

    expect(effective.namespaceDeclarations).toBe('fileScoped');
    expect(effective.settings.convertToFileScopedNamespace).toBe(true);
  });

  it('lets block_scoped in .editorconfig beat the repository policy and the user setting', () => {
    writePolicy('"convertToFileScopedNamespace": true');
    writeRootEditorConfig('csharp_style_namespace_declarations = block_scoped:warning');

    const effective = resolve({ convertToFileScopedNamespace: true });

    expect(effective.namespaceDeclarations).toBe('blockScoped');
    expect(effective.settings.convertToFileScopedNamespace).toBe(false);
  });

  it.each([
    [true, false, 'fileScoped'],
    [false, true, 'unchanged'],
  ] as const)('lets the repository policy (%s) beat the user setting (%s) when .editorconfig is silent', (policy, userSetting, expected) => {
    writePolicy(`"convertToFileScopedNamespace": ${policy}`);

    expect(resolve({ convertToFileScopedNamespace: userSetting }).namespaceDeclarations).toBe(expected);
  });

  it('enforces a silent option through the diagnostic severity', () => {
    writeRootEditorConfig('csharp_style_namespace_declarations = file_scoped:silent', 'dotnet_diagnostic.IDE0161.severity = warning');

    const effective = resolve({ convertToFileScopedNamespace: false });

    expect(effective.namespaceDeclarations).toBe('fileScoped');
    expect(effective.settings.convertToFileScopedNamespace).toBe(true);
    expect(keyOf(effective, 'convertToFileScopedNamespace')).toBe('csharp_style_namespace_declarations');
  });

  it.each(['sometimes', 'block_scoped:loud', 'block_scoped:none:warning'])('ignores the unrecognized option %s and falls back to the repository policy', (option) => {
    writePolicy('"convertToFileScopedNamespace": true');
    writeRootEditorConfig(`csharp_style_namespace_declarations = ${option}`);

    const effective = resolve({ convertToFileScopedNamespace: false });

    expect(effective.namespaceDeclarations).toBe('fileScoped');
    expect(effective.settings.convertToFileScopedNamespace).toBe(true);
  });
});

describe('using directive placement', () => {
  it.each([
    ['inside_namespace', true, 'insideNamespace', false],
    ['outside_namespace:suggestion', false, 'outsideNamespace', true],
  ] as const)('lets %s beat the user setting', (option, userSetting, expected, expectedMoveOutside) => {
    writeRootEditorConfig(`csharp_using_directive_placement = ${option}`);

    const effective = resolve({ moveUsingsOutsideNamespace: userSetting });

    expect(effective.usingDirectivePlacement).toBe(expected);
    expect(effective.settings.moveUsingsOutsideNamespace).toBe(expectedMoveOutside);
  });

  it.each([
    [undefined, true, 'outsideNamespace'],
    [undefined, false, 'unchanged'],
    [false, true, 'unchanged'],
    [true, false, 'outsideNamespace'],
  ] as const)('lets the repository policy (%s) beat the user setting (%s) when .editorconfig is silent', (policy, userSetting, expected) => {
    if (policy !== undefined) {
      writePolicy(`"moveUsingsOutsideNamespace": ${policy}`);
    }

    expect(resolve({ moveUsingsOutsideNamespace: userSetting }).usingDirectivePlacement).toBe(expected);
  });

  it.each([
    ['csharp_using_directive_placement = inside_namespace:warning', 'dotnet_diagnostic.IDE0065.severity = none', 'outsideNamespace', false],
    ['csharp_using_directive_placement = inside_namespace:silent', 'dotnet_diagnostic.IDE0065.severity = warning', 'insideNamespace', true],
    [undefined, 'dotnet_diagnostic.IDE0065.severity = warning', 'outsideNamespace', true],
  ] as const)('resolves %s with the diagnostic severity %s', (option, severity, expected, locked) => {
    writeRootEditorConfig(option, severity);

    const effective = resolve({ moveUsingsOutsideNamespace: true });

    expect(effective.usingDirectivePlacement).toBe(expected);
    expect(effective.editorConfigKeys.has('moveUsingsOutsideNamespace')).toBe(locked);
  });
});

describe('plain options', () => {
  it.each([
    ['false', true, false],
    ['true', false, true],
  ])('lets trim_trailing_whitespace = %s beat the user setting', (option, userSetting, expected) => {
    writeRootEditorConfig(`trim_trailing_whitespace = ${option}`);

    expect(resolve({ removeEndOfLineWhitespace: userSetting }).settings.removeEndOfLineWhitespace).toBe(expected);
  });

  it.each([
    ['true', 'false', undefined, true, 'System first, groups not separated'],
    ['true', undefined, false, true, 'System first beats policy opt-out'],
    ['true', 'true', true, false, 'separated groups beat policy'],
    ['false', undefined, true, false, 'System not first beats policy'],
    ['true:none', 'true:none', true, true, 'none is ignored, policy decides'],
    [undefined, 'false', true, true, 'sort order undefined falls back to policy'],
    [undefined, undefined, true, true, 'editorconfig silent uses policy'],
    [undefined, undefined, undefined, false, 'nothing configured'],
    ['true:none', undefined, undefined, false, 'System first ignored by none, no policy'],
    ['true:none', undefined, false, false, 'System first ignored by none, policy opt-out'],
  ] as const)('decides organizing usings from the sort order %s, separated groups %s and policy %s: %s', (sortSystemFirst, separateGroups, policy, expected, _reason) => {
    writeRootEditorConfig(
      sortSystemFirst === undefined ? undefined : `dotnet_sort_system_directives_first = ${sortSystemFirst}`,
      separateGroups === undefined ? undefined : `dotnet_separate_import_directive_groups = ${separateGroups}`
    );
    if (policy !== undefined) {
      writePolicy(`"organizeUsings": ${policy}`);
    }

    expect(resolve().settings.organizeUsings).toBe(expected);
  });
});

describe('linked options', () => {
  it.each([
    ['csharp_style_var_when_type_is_apparent = true:suggestion', 'convertToVarWhenApparent', true],
    ['csharp_style_var_when_type_is_apparent = false', 'convertToVarWhenApparent', false],
    ['csharp_style_inlined_variable_declaration = false:warning', 'inlineOutVariableDeclarations', false],
    ['csharp_style_inlined_variable_declaration = true', 'inlineOutVariableDeclarations', true],
    ['dotnet_style_readonly_field = true:warning', 'makeFieldsReadonlyWhenSafe', true],
    ['dotnet_style_readonly_field = false', 'makeFieldsReadonlyWhenSafe', false],
    ['dotnet_style_prefer_collection_expression = true', 'convertToCollectionExpressions', true],
    ['dotnet_style_prefer_collection_expression = when_types_exactly_match', 'convertToCollectionExpressions', true],
    ['dotnet_style_prefer_collection_expression = when_types_loosely_match:suggestion', 'convertToCollectionExpressions', true],
    ['dotnet_style_prefer_collection_expression = false', 'convertToCollectionExpressions', false],
    ['dotnet_style_prefer_collection_expression = never', 'convertToCollectionExpressions', false],
  ] as const)('maps %s onto %s = %s over the policy and the user setting', (option, setting, expected) => {
    writePolicy(`"${setting}": ${!expected}`);
    writeRootEditorConfig(option);

    expect(resolve({ [setting]: !expected }).settings[setting]).toBe(expected);
  });

  it.each([
    ['always', true],
    ['for_non_interface_members:warning', true],
    ['never', false],
    ['omit_if_default:suggestion', false],
  ])('drives every explicit access modifier setting from dotnet_style_require_accessibility_modifiers = %s', (option, expected) => {
    writeRootEditorConfig(`dotnet_style_require_accessibility_modifiers = ${option}`);

    const settings = resolve(Object.fromEntries(EXPLICIT_ACCESS_MODIFIER_SETTINGS.map((setting) => [setting, !expected]))).settings;

    for (const setting of EXPLICIT_ACCESS_MODIFIER_SETTINGS) {
      expect(settings[setting], setting).toBe(expected);
    }
  });

  it.each([
    ['csharp_style_expression_bodied_lambdas = false:warning', 'simplifySingleStatementLambdas', false, 'csharp_style_expression_bodied_lambdas'],
    ['csharp_style_expression_bodied_lambdas = when_on_single_line:suggestion', 'simplifySingleStatementLambdas', true, 'csharp_style_expression_bodied_lambdas'],
    ['dotnet_diagnostic.IDE0053.severity = warning', 'simplifySingleStatementLambdas', true, 'dotnet_diagnostic.ide0053.severity'],
    ['csharp_style_prefer_null_check_over_type_check = false:warning', 'convertToPatternMatchingNullChecks', false, 'csharp_style_prefer_null_check_over_type_check'],
    [
      'dotnet_style_prefer_is_null_check_over_reference_equality_method = true:error',
      'convertToPatternMatchingNullChecks',
      true,
      'dotnet_style_prefer_is_null_check_over_reference_equality_method',
    ],
    ['dotnet_diagnostic.CA1852.severity = warning', 'sealClassesWhenSafe', true, 'dotnet_diagnostic.ca1852.severity'],
    ['dotnet_diagnostic.CA1507.severity = suggestion', 'convertToStringNameOf', true, 'dotnet_diagnostic.ca1507.severity'],
    ['dotnet_diagnostic.CA1869.severity = error', 'reuseJsonSerializerOptionsForCA1869', true, 'dotnet_diagnostic.ca1869.severity'],
    [
      'dotnet_style_allow_multiple_blank_lines_experimental = false:warning',
      'removeMultipleConsecutiveBlankLines',
      true,
      'dotnet_style_allow_multiple_blank_lines_experimental',
    ],
    [
      'dotnet_style_allow_multiple_blank_lines_experimental = true:warning',
      'removeMultipleConsecutiveBlankLines',
      false,
      'dotnet_style_allow_multiple_blank_lines_experimental',
    ],
    ['dotnet_diagnostic.IDE2000.severity = warning', 'removeMultipleConsecutiveBlankLines', false, 'dotnet_diagnostic.ide2000.severity'],
    [
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:warning',
      'removeBlankLinesAfterOpeningBrace',
      true,
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental',
    ],
    [
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:warning',
      'removeBlankLinesBeforeClosingBrace',
      true,
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental',
    ],
    [
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental = true:error',
      'removeBlankLinesBeforeClosingBrace',
      false,
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental',
    ],
  ] as const)('%s decides %s = %s through %s, beating the policy and the user setting', (option, setting, expected, expectedKey) => {
    writePolicy(`"${setting}": ${!expected}`);
    writeRootEditorConfig(option);

    const effective = resolve({ [setting]: !expected });

    expect(effective.settings[setting]).toBe(expected);
    expect(keyOf(effective, setting)).toBe(expectedKey);
  });

  it.each(['dotnet_diagnostic.CA1852.severity = silent', 'dotnet_diagnostic.CA1852.severity = none', undefined])(
    'uses the policy when .editorconfig does not enforce CA1852 (%s)',
    (option) => {
      writePolicy('"sealClassesWhenSafe": true');
      writeRootEditorConfig(option);

      const effective = resolve({ sealClassesWhenSafe: false });

      expect(effective.settings.sealClassesWhenSafe).toBe(true);
      expect(effective.editorConfigKeys.has('sealClassesWhenSafe')).toBe(false);
    }
  );

  it('lets the diagnostic severity none beat the option suffix', () => {
    writeRootEditorConfig('csharp_style_expression_bodied_lambdas = false:warning', 'dotnet_diagnostic.IDE0053.severity = none');

    expect(resolve({ simplifySingleStatementLambdas: true }).settings.simplifySingleStatementLambdas).toBe(true);
  });

  it('converts null checks only when every enforced key allows it', () => {
    writeRootEditorConfig(
      'csharp_style_prefer_null_check_over_type_check = true:warning',
      'dotnet_style_prefer_is_null_check_over_reference_equality_method = false:warning'
    );

    const effective = resolve({ convertToPatternMatchingNullChecks: true });

    expect(effective.settings.convertToPatternMatchingNullChecks).toBe(false);
    expect(keyOf(effective, 'convertToPatternMatchingNullChecks')).toBe('dotnet_style_prefer_is_null_check_over_reference_equality_method');
  });

  it.each([
    ['csharp_style_var_when_type_is_apparent = true:silent', 'dotnet_diagnostic.IDE0007.severity = warning', 'convertToVarWhenApparent', true, 'csharp_style_var_when_type_is_apparent'],
    [undefined, 'dotnet_diagnostic.IDE0008.severity = warning', 'convertToVarWhenApparent', false, 'dotnet_diagnostic.ide0008.severity'],
    ['csharp_style_inlined_variable_declaration = false:warning', 'dotnet_diagnostic.IDE0018.severity = none', 'inlineOutVariableDeclarations', true, undefined],
    [undefined, 'dotnet_diagnostic.IDE0018.severity = warning', 'inlineOutVariableDeclarations', true, 'dotnet_diagnostic.ide0018.severity'],
    [undefined, 'dotnet_diagnostic.IDE0044.severity = error', 'makeFieldsReadonlyWhenSafe', true, 'dotnet_diagnostic.ide0044.severity'],
    ['dotnet_style_readonly_field = true:warning', 'dotnet_diagnostic.IDE0044.severity = silent', 'makeFieldsReadonlyWhenSafe', false, undefined],
    [undefined, 'dotnet_diagnostic.IDE0040.severity = warning', 'insertExplicitAccessModifiersOnClasses', true, 'dotnet_diagnostic.ide0040.severity'],
    [
      'dotnet_style_prefer_collection_expression = never:silent',
      'dotnet_diagnostic.IDE0305.severity = warning',
      'convertToCollectionExpressions',
      false,
      'dotnet_style_prefer_collection_expression',
    ],
    [undefined, 'dotnet_diagnostic.IDE0300.severity = suggestion', 'convertToCollectionExpressions', true, 'dotnet_diagnostic.ide0300.severity'],
  ] as const)('resolves %s with %s per diagnostic (%s = %s, decided by %s)', (option, severity, setting, expected, expectedKey) => {
    // A locked setting must beat the opposite user setting; an unlocked one must keep the user setting.
    writeRootEditorConfig(option, severity);

    const effective = resolve({ [setting]: expectedKey === undefined ? expected : !expected });

    expect(effective.settings[setting]).toBe(expected);
    expect(keyOf(effective, setting)).toBe(expectedKey);
  });

  it.each([
    ['csharp_style_inlined_variable_declaration = false', 'inlineOutVariableDeclarations', true, false],
    ['csharp_style_inlined_variable_declaration = false:warning', 'inlineOutVariableDeclarations', true, false],
    ['csharp_style_inlined_variable_declaration = false:suggestion', 'inlineOutVariableDeclarations', true, false],
    ['csharp_style_inlined_variable_declaration = false:error', 'inlineOutVariableDeclarations', true, false],
    ['csharp_style_inlined_variable_declaration = false : Warning', 'inlineOutVariableDeclarations', true, false],
    ['csharp_style_inlined_variable_declaration = false:none', 'inlineOutVariableDeclarations', true, true],
    ['csharp_style_inlined_variable_declaration = false:silent', 'inlineOutVariableDeclarations', true, true],
    ['csharp_style_inlined_variable_declaration = false:refactoring', 'inlineOutVariableDeclarations', true, true],
    ['csharp_style_inlined_variable_declaration = false : Silent', 'inlineOutVariableDeclarations', true, true],
  ] as const)('applies the severity of %s: value %s = %s for a %s user setting', (option, setting, userSetting, expected) => {
    writeRootEditorConfig(option);

    const effective = resolve({ [setting]: userSetting });

    expect(effective.settings[setting]).toBe(expected);
    expect(effective.editorConfigKeys.has(setting)).toBe(!expected);
  });

  it('ignores an unrecognized boolean value and falls back to the user setting', () => {
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = maybe:warning');

    expect(resolve({ convertToVarWhenApparent: true }).settings.convertToVarWhenApparent).toBe(true);
  });

  it('ignores options with the none suffix, so the policy and then the user settings decide', () => {
    writePolicy('"convertToFileScopedNamespace": false, "convertToVarWhenApparent": false');
    writeRootEditorConfig(
      'csharp_style_namespace_declarations = file_scoped:none',
      'csharp_using_directive_placement = inside_namespace:none',
      'csharp_style_var_when_type_is_apparent = true:none'
    );

    const effective = resolve({ convertToFileScopedNamespace: true, moveUsingsOutsideNamespace: true, convertToVarWhenApparent: true });

    expect(effective.namespaceDeclarations).toBe('unchanged');
    expect(effective.settings.convertToFileScopedNamespace).toBe(false);
    expect(effective.settings.convertToVarWhenApparent).toBe(false);
    expect(effective.usingDirectivePlacement).toBe('outsideNamespace');
  });
});

describe('file header template', () => {
  it('builds a comment header from \\n escapes and {fileName}', () => {
    writePolicy('"fileHeaderCSharp": "// Policy header"');
    writeRootEditorConfig('file_header_template = Copyright: Contoso Ltd.\\n\\n{fileName} is licensed under MIT.');

    const effective = resolve({ fileHeaderCSharp: '// User header' });

    expect(effective.settings.fileHeaderCSharp).toBe(['// Copyright: Contoso Ltd.', '//', '// Sample.cs is licensed under MIT.'].join('\n'));
    expect(keyOf(effective, 'fileHeaderCSharp')).toBe('file_header_template');
  });

  it('clears the repository and user header for unset', () => {
    writePolicy('"fileHeaderCSharp": "// Policy header"');
    writeRootEditorConfig('file_header_template = unset');

    const effective = resolve({ fileHeaderCSharp: '// User header' });

    expect(effective.settings.fileHeaderCSharp).toBe('');
    expect(keyOf(effective, 'fileHeaderCSharp')).toBe('file_header_template');
  });

  it('defines the header whatever the severity of IDE0073', () => {
    writeRootEditorConfig('file_header_template = Header', 'dotnet_diagnostic.IDE0073.severity = none');

    expect(resolve().settings.fileHeaderCSharp).toBe('// Header');
  });

  it('keeps the policy header without a template', () => {
    writePolicy('"fileHeaderCSharp": "// Policy header"');

    expect(resolve({ fileHeaderCSharp: '// User header' }).settings.fileHeaderCSharp).toBe('// Policy header');
  });
});

describe('bulk severities', () => {
  it.each([
    ['dotnet_analyzer_diagnostic.category-Style.severity = warning', 'dotnet_analyzer_diagnostic.category-style.severity'],
    ['dotnet_analyzer_diagnostic.severity = suggestion', 'dotnet_analyzer_diagnostic.severity'],
  ])('enforces Code Style rules and IDE-backed steps with Roslyn defaults through %s', (option, expectedKey) => {
    writeRootEditorConfig(option);

    const effective = resolve({ codeStyleRules: { csharp_prefer_braces: 'when_multiline' }, makeFieldsReadonlyWhenSafe: false, convertToFileScopedNamespace: true });

    expect(effective.codeStyleEditorConfigKeys.get('csharp_prefer_braces')).toBe(expectedKey);
    expect(effective.codeStyleValues.size).toBe(0);
    expect(effective.analyzerConfigOverrides.size).toBe(0);
    expect(effective.settings.makeFieldsReadonlyWhenSafe).toBe(true);
    expect(effective.namespaceDeclarations).toBe('blockScoped');
    expect(effective.settings.convertToFileScopedNamespace).toBe(false);
  });

  it('applies a category severity only to the enabled-by-default diagnostics of that category', () => {
    writeRootEditorConfig('dotnet_analyzer_diagnostic.category-Performance.severity = warning');

    const effective = resolve({
      codeStyleRules: {},
      sealClassesWhenSafe: false,
      reuseJsonSerializerOptionsForCA1869: false,
      convertToStringNameOf: false,
    });

    expect(effective.settings.reuseJsonSerializerOptionsForCA1869, 'CA1869 is an enabled Performance rule').toBe(true);
    expect(effective.settings.sealClassesWhenSafe, 'CA1852 is disabled by default, so bulk severities do not enable it').toBe(false);
    expect(effective.editorConfigKeys.has('sealClassesWhenSafe')).toBe(false);
    expect(effective.settings.convertToStringNameOf, 'CA1507 is a Maintainability rule').toBe(false);
    expect(effective.codeStyleEditorConfigKeys.has('csharp_prefer_braces')).toBe(false);
  });

  it('enables CA1852 only through its own diagnostic severity, whatever the bulk severity says', () => {
    writeRootEditorConfig('dotnet_analyzer_diagnostic.severity = error', 'dotnet_diagnostic.CA1852.severity = none');

    expect(resolve({ sealClassesWhenSafe: true }).editorConfigKeys.has('sealClassesWhenSafe')).toBe(false);
  });

  it.each([
    [undefined, 'category none only'],
    ['csharp_prefer_braces = false:warning', 'category none beats an enforcing suffix'],
    ['csharp_prefer_braces = false', 'category none beats an option without suffix'],
  ])('does not enforce under a category severity none (%s: %s), so the user setting decides', (option, _reason) => {
    writeRootEditorConfig('dotnet_analyzer_diagnostic.category-Style.severity = none', option);

    const effective = resolve({ codeStyleRules: { csharp_prefer_braces: 'true' } });

    expect(effective.codeStyleValues.get('csharp_prefer_braces')).toBe('true');
    expect(effective.codeStyleEditorConfigKeys.has('csharp_prefer_braces')).toBe(false);
  });

  it.each(['dotnet_diagnostic.IDE0011.severity = warning', 'dotnet_analyzer_diagnostic.category-Style.severity = warning'])(
    'stops the rule with the none suffix whatever severity is configured (%s)',
    (severity) => {
      writeRootEditorConfig('csharp_prefer_braces = true:none', severity);

      expect(resolve({ codeStyleRules: { csharp_prefer_braces: 'when_multiline' } }).codeStyleValues.get('csharp_prefer_braces')).toBe('when_multiline');
    }
  );
});

describe('option values and locations', () => {
  it('reads a nested .editorconfig over its parent and inherits the other keys', () => {
    writeRootEditorConfig('trim_trailing_whitespace = true', 'csharp_style_var_when_type_is_apparent = true');
    const nested = path.join(tempDirectory, 'src', 'App');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tempDirectory, 'src', '.editorconfig'), '[*.cs]\r\ntrim_trailing_whitespace = false\r\n');

    const effective = resolve({}, path.join(nested, 'Sample.cs'));

    expect(effective.settings.removeEndOfLineWhitespace).toBe(false);
    expect(effective.settings.convertToVarWhenApparent).toBe(true);
  });

  it('hides the .editorconfig files above a root one', () => {
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = true');
    const nested = path.join(tempDirectory, 'src');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, '.editorconfig'), 'root = true\r\n\r\n[*.cs]\r\ntrim_trailing_whitespace = false\r\n');

    const effective = resolve({ convertToVarWhenApparent: false }, path.join(nested, 'Sample.cs'));

    expect(effective.settings.convertToVarWhenApparent, 'the parent .editorconfig must not apply below a root .editorconfig').toBe(false);
    expect(effective.settings.removeEndOfLineWhitespace).toBe(false);
  });

  it('matches section globs against paths relative to the .editorconfig directory', () => {
    fs.writeFileSync(
      path.join(tempDirectory, '.editorconfig'),
      ['root = true', '[*.cs]', 'trim_trailing_whitespace = false', '[src/**.cs]', 'csharp_style_var_when_type_is_apparent = true', '[*.vb]', 'dotnet_style_readonly_field = true', ''].join('\r\n')
    );
    const source = path.join(tempDirectory, 'src', 'App');
    const tests = path.join(tempDirectory, 'tests');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(tests);
    const user = { convertToVarWhenApparent: false, makeFieldsReadonlyWhenSafe: false };

    const inSource = resolve(user, path.join(source, 'Sample.cs'));
    const inTests = resolve(user, path.join(tests, 'Sample.cs'));

    expect(inSource.settings.removeEndOfLineWhitespace).toBe(false);
    expect(inSource.settings.convertToVarWhenApparent).toBe(true);
    expect(inSource.settings.makeFieldsReadonlyWhenSafe, 'a [*.vb] section must not apply to C# files').toBe(false);
    expect(inTests.settings.removeEndOfLineWhitespace).toBe(false);
    expect(inTests.settings.convertToVarWhenApparent, '[src/**.cs] must not match files outside src').toBe(false);
  });

  it('reads an edited .editorconfig again', () => {
    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = true');
    expect(resolve().settings.convertToVarWhenApparent).toBe(true);

    writeRootEditorConfig('csharp_style_var_when_type_is_apparent = false:warning');

    expect(resolve().settings.convertToVarWhenApparent).toBe(false);
  });
});

describe('Code Style rules', () => {
  it.each([
    [undefined, true],
    ['csharp_prefer_braces = false:none', true],
    ['csharp_prefer_braces = false:silent', true],
    ['csharp_prefer_braces = false:suggestion', false],
    ['csharp_prefer_braces = false:warning', false],
    ['csharp_prefer_braces = false:error', false],
    ['csharp_prefer_braces = false', false],
    ['dotnet_diagnostic.IDE0011.severity = warning', false],
    ['dotnet_diagnostic.IDE0011.severity = silent', true],
  ])('applies the Code Style rule only when .editorconfig does not enforce it (%s)', (option, applied) => {
    writeRootEditorConfig(option);

    const effective = resolve({ codeStyleRules: { csharp_prefer_braces: 'when_multiline' } });

    expect(effective.codeStyleValues.has('csharp_prefer_braces')).toBe(applied);
    expect(effective.codeStyleEditorConfigKeys.has('csharp_prefer_braces')).toBe(!applied);
    expect(effective.analyzerConfigOverrides.get('csharp_prefer_braces')).toBe(applied ? 'when_multiline:suggestion' : undefined);
  });

  it('applies a rule whose diagnostic severity is none, although the option suffix enforces it', () => {
    writeRootEditorConfig('csharp_prefer_braces = false:warning', 'dotnet_diagnostic.IDE0011.severity = none');

    const effective = resolve({ codeStyleRules: { csharp_prefer_braces: 'true' } });

    expect(effective.codeStyleValues.get('csharp_prefer_braces')).toBe('true');
    expect(effective.analyzerConfigOverrides.get('dotnet_diagnostic.IDE0011.severity')).toBe('suggestion');
  });

  it('names the severity key when .editorconfig enforces a rule through the diagnostic severity only', () => {
    writeRootEditorConfig('dotnet_diagnostic.IDE0011.severity = error');

    expect(resolve({ codeStyleRules: { csharp_prefer_braces: 'true' } }).codeStyleEditorConfigKeys.get('csharp_prefer_braces')).toBe(
      'dotnet_diagnostic.ide0011.severity'
    );
  });

  it('lets the other diagnostic of a rule follow the option suffix when one diagnostic is none', () => {
    writeRootEditorConfig('dotnet_style_qualification_for_field = false:warning', 'dotnet_diagnostic.IDE0009.severity = none');

    const effective = resolve({ codeStyleRules: { dotnet_style_qualification_for_field: 'true' } });

    expect(effective.codeStyleEditorConfigKeys.get('dotnet_style_qualification_for_field')).toBe('dotnet_style_qualification_for_field');
    expect(effective.codeStyleValues.has('dotnet_style_qualification_for_field')).toBe(false);
  });

  it('lets the repository policy beat the user setting, null disabling the rule', () => {
    writePolicy(
      '"codeStyle": { "csharp_prefer_braces": "when_multiline", "dotnet_style_null_propagation": null, "csharp_style_throw_expression": "false" }'
    );

    const effective = resolve({
      codeStyleRules: { csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true', csharp_prefer_simple_using_statement: 'true' },
    });

    expect(Object.fromEntries(effective.codeStyleValues)).toEqual({
      csharp_prefer_braces: 'when_multiline',
      csharp_style_throw_expression: 'false',
      csharp_prefer_simple_using_statement: 'true',
    });
  });

  it('silences the other rules of a raised diagnostic that Code Janitor does not apply', () => {
    writeRootEditorConfig('dotnet_style_qualification_for_method = true:silent', 'dotnet_style_qualification_for_event = false:warning');

    const effective = resolve({ codeStyleRules: { dotnet_style_qualification_for_field: 'true' } });

    expect(Object.fromEntries(effective.analyzerConfigOverrides)).toEqual({
      dotnet_style_qualification_for_field: 'true:suggestion',
      'dotnet_diagnostic.IDE0003.severity': 'suggestion',
      'dotnet_diagnostic.IDE0009.severity': 'suggestion',
      dotnet_style_qualification_for_property: 'false:none',
      dotnet_style_qualification_for_method: 'true:none',
    });
  });

  it('ignores invalid rule values in the setting and the policy', () => {
    writePolicy('"codeStyle": { "dotnet_style_null_propagation": true }');

    const settings = applyRepositoryPolicy(
      { ...createDefaultSettings(), codeStyleRules: { csharp_prefer_braces: 'sometimes', unknown_key: 'true', csharp_preferred_modifier_order: 'public,loud' } },
      readRepositoryPolicy(tempDirectory)
    );

    expect(resolveEffectiveCleanupSettings(filePath, settings).codeStyleValues.size).toBe(0);
  });

  it('adds the enabled rules on top of the .editorconfig properties, for analysis only', () => {
    writeRootEditorConfig('csharp_prefer_braces = false:silent', 'dotnet_diagnostic.IDE0011.severity = none');

    const effective = resolve({ codeStyleRules: { csharp_prefer_braces: 'true' } });

    expect(effective.properties.get('csharp_prefer_braces')).toBe('true:suggestion');
    expect(effective.properties.get('dotnet_diagnostic.IDE0011.severity')).toBe('suggestion');
    expect(fs.readFileSync(path.join(tempDirectory, '.editorconfig'), 'utf8')).toContain('csharp_prefer_braces = false:silent');
  });
});
