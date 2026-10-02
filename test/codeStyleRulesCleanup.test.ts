import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODE_STYLE_GROUPS, CODE_STYLE_RULES, CodeStyleRule } from '../src/cleanup/codeStyleRules';
import { analyzeCleanup, applyRuleOnly } from '../src/cleanup/analysis';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../src/cleanup/repositoryOverrides';
import { EditorConfigIssue, runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { buildProject, dotnetAvailable, writeProject } from './helpers/dotnetBuild';

/**
 * The Code Style rules opt-in layer end to end: every rule of the catalog applied to realistic C# files
 * (`test/oracle/CodeStyle`, also a project of `npm run verify:compile`) through the synthetic analyzer
 * configuration, below the real `.editorconfig` rules of the file, and proved against the real compiler.
 */

const FIXTURES = path.join(__dirname, 'oracle', 'CodeStyle');

/** The fixture file of each group of the Visual Studio Options page. */
const GROUP_FILES: Readonly<Record<string, string>> = {
  Modifiers: 'Modifiers.cs',
  Blocks: 'Blocks.cs',
  'Expression-bodied members': 'ExpressionBodies.cs',
  'Pattern matching': 'PatternMatching.cs',
  'Null checking': 'NullChecking.cs',
  'Modern expressions': 'ModernExpressions.cs',
  "'this.' qualification": 'Qualification.cs',
  'Language keywords vs. framework type names': 'PredefinedTypes.cs',
  Parentheses: 'Parentheses.cs',
};

/** What each rule does to its group's file with the value the catalog proposes; `reported` rules only report. */
const EXPECTED: Readonly<Record<string, { applied: string[] } | { reported: RegExp }>> = {
  csharp_preferred_modifier_order: { applied: ['public static int Counter;', 'private readonly int _seed = 1;'] },
  csharp_prefer_static_local_function: { applied: ['static int Local(int y)'] },
  csharp_prefer_static_anonymous_function: { applied: ['Func<int, int> twice = static y => y * 2;'] },
  csharp_style_prefer_readonly_struct: { applied: ['public readonly struct ImmutablePoint'] },
  csharp_style_prefer_readonly_struct_member: { applied: ['public readonly int Sum()', 'public readonly int Current()'] },
  csharp_prefer_braces: { applied: ['        if (open)\n        {\n            return 1;\n        }'] },
  csharp_prefer_simple_using_statement: { applied: ['using var stream = File.OpenRead(path);'] },
  csharp_style_prefer_method_group_conversion: { applied: ['Func<int, int> convert = Double;'] },
  csharp_style_expression_bodied_methods: { applied: ['public int Method()\n    {\n        return _value + 1;\n    }'] },
  csharp_style_expression_bodied_constructors: { applied: ['public Samples()\n    {\n        _value = 1;\n    }'] },
  csharp_style_expression_bodied_operators: { applied: ['public static Vector operator -(Vector left, Vector right)\n    {\n        return new Vector { X = left.X - right.X };'] },
  csharp_style_expression_bodied_properties: { applied: ['public int Property => _value;'] },
  csharp_style_expression_bodied_indexers: { applied: ['public int this[int index] => _value + index;'] },
  csharp_style_expression_bodied_accessors: { applied: ['get => _value;', 'set => _value = value;'] },
  csharp_style_expression_bodied_local_functions: { applied: ['int Local(int x)\n        {\n            return x * 2;\n        }'] },
  csharp_style_pattern_matching_over_is_with_cast_check: { applied: ['if (value is string text)'] },
  csharp_style_pattern_matching_over_as_with_null_check: { applied: ['if (value is string text)'] },
  csharp_style_prefer_pattern_matching: { applied: ['return value is 1 or 2 or 3;'] },
  csharp_style_prefer_not_pattern: { applied: ['return value is not string;'] },
  csharp_style_prefer_extended_property_pattern: { applied: ['return customer is { Address.Zip: 100 };'] },
  csharp_style_prefer_switch_expression: { applied: ['return value switch', '1 => "one",', '_ => "many",'] },
  dotnet_style_coalesce_expression: { applied: ['return value ?? "";'] },
  dotnet_style_null_propagation: { applied: ['return value?.ToUpperInvariant();'] },
  csharp_style_throw_expression: { applied: ['_name = name ?? throw new ArgumentNullException(nameof(name));'] },
  csharp_style_conditional_delegate_call: { applied: ['_callback?.Invoke();'] },
  csharp_style_prefer_primary_constructors: { reported: /IDE0290 .*'Service' could use a primary constructor; it was not converted automatically/ },
  csharp_style_implicit_object_creation_when_type_is_apparent: { applied: ['private readonly Dependency _other = new();'] },
  csharp_style_prefer_index_operator: { applied: ['return values[^1];'] },
  csharp_style_prefer_range_operator: { applied: ['return text[1..];'] },
  csharp_style_prefer_utf8_string_literals: { applied: ['return "hello"u8.ToArray();'] },
  csharp_style_prefer_tuple_swap: { applied: ['(a, b) = (b, a);'] },
  csharp_style_deconstructed_variable_declaration: { applied: ['var (x, y) = (1, 2);', 'return x + y;'] },
  csharp_style_unused_value_assignment_preference: { reported: /IDE0059 .*the value assigned to 'result' is never read/ },
  csharp_prefer_simple_default_expression: { applied: ['return default;'] },
  dotnet_style_prefer_auto_properties: { applied: ['public int Age { get; set; }'] },
  dotnet_style_prefer_compound_assignment: { applied: ['_count += step;'] },
  dotnet_style_prefer_simplified_boolean_expressions: { applied: ['return flag || (other && flag);'] },
  dotnet_style_prefer_simplified_interpolation: { applied: ['return $"{value} items";'] },
  dotnet_style_object_initializer: { applied: ['var person = new Person()\n        {\n            Name = "Ann",\n            Age = 30\n        };'] },
  dotnet_style_collection_initializer: { applied: ['var list = new List<int>()\n        {\n            1,\n            2\n        };'] },
  dotnet_style_explicit_tuple_names: { applied: ['return tuple.Left + tuple.Right;'] },
  dotnet_style_prefer_inferred_tuple_names: { applied: ['var tuple = (left, right);'] },
  dotnet_style_prefer_inferred_anonymous_type_member_names: { applied: ['new { Initialize().Name, Right = right }'] },
  dotnet_style_qualification_for_field: { applied: ['return _count + this.Size + this.Twice(_count);'] },
  dotnet_style_qualification_for_property: { applied: ['return this._count + Size + this.Twice(_count);'] },
  dotnet_style_qualification_for_method: { applied: ['return this._count + this.Size + Twice(_count);'] },
  dotnet_style_qualification_for_event: { applied: ['Changed?.Invoke(this, EventArgs.Empty);'] },
  dotnet_style_predefined_type_for_locals_parameters_members: { applied: ['public int Number(string text, bool flag)', 'int length = text.Length;'] },
  dotnet_style_predefined_type_for_member_access: { applied: ['return string.Join(",", parts) + int.MaxValue.ToString();'] },
  dotnet_style_parentheses_in_arithmetic_binary_operators: { applied: ['return a + (b * c);'] },
  dotnet_style_parentheses_in_relational_binary_operators: { applied: ['return (a < b) == (b < c);'] },
  dotnet_style_parentheses_in_other_binary_operators: { applied: ['return (a && b) || c;'] },
  dotnet_style_parentheses_in_other_operators: { applied: ['return a + b;'] },
};

/** Every setting that would change code off: only the opt-in rules, the `.editorconfig` and the policy apply. */
function onlyRules(codeStyleRules: Readonly<Record<string, string>>): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = false;
    }
  }

  return { ...(settings as unknown as CleanupSettings), codeStyleRules };
}

function fixture(file: string): string {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

let workDir: string;

// The group files belong to CodeStyle.csproj: rules that must know the project's other types (such as
// IDE0049 on bare framework names) only act on a file of a known project.
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-codestyle-'));
  fs.copyFileSync(path.join(FIXTURES, 'CodeStyle.csproj'), path.join(workDir, 'CodeStyle.csproj'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function clean(file: string, settings: CleanupSettings, source: string = fixture(file)): { output: string; issues: EditorConfigIssue[] } {
  const issues: EditorConfigIssue[] = [];
  const output = runCleanup(source, path.join(workDir, file), settings, undefined, (issue) => issues.push(issue));

  return { output, issues };
}

function defaults(rules: readonly CodeStyleRule[]): Record<string, string> {
  return Object.fromEntries(rules.map((rule) => [rule.key, rule.defaultValue]));
}

describe('Code Style rules applied through the opt-in layer', () => {
  it('covers every rule of the catalog', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(CODE_STYLE_RULES.map((rule) => rule.key).sort());
    expect(Object.keys(GROUP_FILES)).toEqual([...CODE_STYLE_GROUPS]);
  });

  it.each(CODE_STYLE_RULES.map((rule) => [rule.key, rule] as const))('%s changes its group file or reports why it did not', (key, rule) => {
    const file = GROUP_FILES[rule.group];
    const source = fixture(file);

    const { output, issues } = clean(file, onlyRules({ [key]: rule.defaultValue }));
    const expected = EXPECTED[key];

    if ('applied' in expected) {
      for (const fragment of expected.applied) {
        expect(output, fragment).toContain(fragment);
      }

      expect(output).not.toBe(source);
    } else {
      expect(issues.map((issue) => `${issue.kind}: ${issue.detail}`).join('\n')).toMatch(expected.reported);
      expect(issues.every((issue) => issue.kind === 'unresolved')).toBe(true);
    }
  });

  it('leaves the files untouched when no rule is enabled', () => {
    for (const file of Object.values(GROUP_FILES)) {
      expect(clean(file, onlyRules({})).output, file).toBe(fixture(file));
    }
  });

  it('shows an opt-in rule as a suggestion in the editor diagnostics and fixes it alone', () => {
    const file = path.join(workDir, 'Blocks.cs');
    const settings = onlyRules({ csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' });

    const { findings } = analyzeCleanup(fixture('Blocks.cs'), file, settings);

    expect(findings.filter((finding) => finding.rule === 'IDE0011').map((finding) => finding.severity)).toEqual(['suggestion']);
    expect(applyRuleOnly(fixture('Blocks.cs'), file, settings, 'IDE0011')).toContain('if (open)\n        {\n            return 1;');
  });

  it('reports a rule value the engine has no implementation for instead of ignoring it', () => {
    const { output, issues } = clean(
      'PredefinedTypes.cs',
      onlyRules({ dotnet_style_predefined_type_for_locals_parameters_members: 'false', dotnet_style_predefined_type_for_member_access: 'true' })
    );

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'note',
        detail: 'Code Style rule dotnet_style_predefined_type_for_locals_parameters_members = false (IDE0049) is not implemented by Code Janitor for VS Code, so it was not applied.',
      }),
    ]);
    expect(output).toContain('public Int32 Number(String text, Boolean flag)');
    // The other rule of the same diagnostic is implemented and applies.
    expect(output).toContain('return string.Join(",", parts) + int.MaxValue.ToString();');
  });

  it('applies a rule with the value it is given, not only the proposed one', () => {
    const source = 'class C\n{\n    int M(bool open)\n    {\n        if (open) return 1;\n        if (open)\n            return\n                2;\n        return 0;\n    }\n}\n';

    const whenMultiline = clean('C.cs', onlyRules({ csharp_prefer_braces: 'when_multiline' }), source).output;
    const always = clean('C.cs', onlyRules({ csharp_prefer_braces: 'true' }), source).output;

    expect(whenMultiline).toContain('if (open) return 1;');
    expect(whenMultiline).toContain('if (open)\n        {\n            return\n                2;\n        }');
    expect(always).not.toContain('if (open) return 1;');
  });

  it('enables only the listed qualification option, not the others that report the same diagnostic', () => {
    const { output } = clean('Qualification.cs', onlyRules({ dotnet_style_qualification_for_field: 'true' }));

    // Fields are qualified; properties, methods and events, which report the same diagnostics, are left as written.
    expect(output).toContain('return this._count + this.Size + this.Twice(this._count);');
    expect(output).toContain('return this._count + Size + Twice(Size);');
    expect(output).toContain('this.Changed?.Invoke(this, EventArgs.Empty);');
  });
});

describe('precedence of the Code Style rules', () => {
  const braces = 'class C\n{\n    int M(bool open)\n    {\n        if (open)\n            return 1;\n        return 0;\n    }\n}\n';
  const bracesAdded = 'if (open)\n        {\n            return 1;\n        }';

  function editorConfig(...options: string[]): void {
    fs.writeFileSync(path.join(workDir, '.editorconfig'), ['root = true', '', '[*.cs]', ...options, ''].join('\n'));
  }

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
  ])('lets an .editorconfig that enforces the rule keep its value over the opt-in rule (%s)', (option, bracesApplied) => {
    editorConfig(...(option === undefined ? [] : [option]));

    const { output } = clean('C.cs', onlyRules({ csharp_prefer_braces: 'true' }), braces);

    expect(output.includes(bracesAdded)).toBe(bracesApplied);
  });

  it('applies the .editorconfig value of an enabled rule whose option has no severity suffix', () => {
    editorConfig('csharp_prefer_braces = true');

    // `when_multiline` alone leaves the one-line statement below `if` braceless: the braces come from .editorconfig.
    const { output, issues } = clean('C.cs', onlyRules({ csharp_prefer_braces: 'when_multiline' }), braces);

    expect(output).toContain(bracesAdded);
    expect(issues).toEqual([]);
  });

  it('applies an opt-in rule over a silenced .editorconfig entry, and a rule .editorconfig enforces keeps applying next to it', () => {
    editorConfig('csharp_prefer_braces = false:silent', 'dotnet_diagnostic.IDE0011.severity = none', 'csharp_style_throw_expression = true:warning');
    const source = `${braces}\nclass D\n{\n    private readonly string _x;\n\n    D(string x)\n    {\n        if (x == null)\n        {\n            throw new System.ArgumentNullException(nameof(x));\n        }\n\n        _x = x;\n    }\n}\n`;

    const { output } = clean('C.cs', onlyRules({ csharp_prefer_braces: 'true' }), source);

    expect(output).toContain(bracesAdded);
    expect(output).toContain('_x = x ?? throw new System.ArgumentNullException(nameof(x));');
  });

  it('applies a rule enabled in .codejanitor over the user setting value, and null disables it', () => {
    fs.writeFileSync(path.join(workDir, '.codejanitor'), JSON.stringify({ cleanup: { codeStyle: { csharp_prefer_braces: 'when_multiline', dotnet_style_null_propagation: null } } }));
    const user = { ...onlyRules({ csharp_prefer_braces: 'true', dotnet_style_null_propagation: 'true' }) };
    const settings = applyRepositoryPolicy(user, readRepositoryPolicy(workDir));
    const source = `${braces}\nclass E\n{\n    string? M(string? v)\n    {\n        return v == null ? null : v.ToString();\n    }\n}\n`;

    const { output } = clean('C.cs', settings, source);

    expect(settings.codeStyleRules).toEqual({ csharp_prefer_braces: 'when_multiline' });
    // `when_multiline` leaves the one-line statement below `if` braceless; the disabled rule does not run.
    expect(output).not.toContain(bracesAdded);
    expect(output).toContain('return v == null ? null : v.ToString();');
  });

  it('never writes to disk: the .editorconfig and the folder are left as they were', () => {
    editorConfig('dotnet_style_qualification_for_method = true:silent');
    const before = fs.readFileSync(path.join(workDir, '.editorconfig'), 'utf8');

    clean('Qualification.cs', onlyRules({ dotnet_style_qualification_for_field: 'true' }));

    expect(fs.readFileSync(path.join(workDir, '.editorconfig'), 'utf8')).toBe(before);
    expect(fs.readdirSync(workDir).sort()).toEqual(['.editorconfig', 'CodeStyle.csproj']);
  });

  it('keeps the other qualification options of the .editorconfig as it configures them while one is enabled here', () => {
    editorConfig('dotnet_style_qualification_for_method = true:silent', 'dotnet_style_qualification_for_event = false:warning');

    const { output } = clean('Qualification.cs', onlyRules({ dotnet_style_qualification_for_field: 'true' }));

    // The field option is enabled here, the event option is enforced by .editorconfig (no `this.`) and the
    // method option is silent there, so it is not applied.
    expect(output).toContain('return this._count + this.Size + this.Twice(this._count);');
    expect(output).toContain('        Changed?.Invoke(this, EventArgs.Empty);');
    expect(output).toContain('return this._count + Size + Twice(Size);');
  });
});

describe.skipIf(!dotnetAvailable)('Code Style rules with the real compiler', () => {
  const csproj = fs.readFileSync(path.join(FIXTURES, 'CodeStyle.csproj'), 'utf8');

  /**
   * A project of only the files the test cleans: the group files are independent of each other, so a group
   * builds alone and an error points at the file the cleanup changed.
   */
  function project(names: readonly string[]): { folder: string; files: Record<string, string> } {
    const files = Object.fromEntries(names.map((name) => [name, fixture(name)]));

    return { folder: writeProject(files, csproj, 'CodeStyle.csproj'), files };
  }

  function cleanAndBuild(rulesByFile: Readonly<Record<string, Readonly<Record<string, string>>>>, policy?: string): string {
    const { folder, files } = project(Object.keys(rulesByFile));
    try {
      if (policy !== undefined) {
        fs.writeFileSync(path.join(folder, '.codejanitor'), policy);
      }

      for (const [file, rules] of Object.entries(rulesByFile)) {
        const settings = policy === undefined ? onlyRules(rules) : applyRepositoryPolicy(onlyRules({}), readRepositoryPolicy(folder));
        const output = runCleanup(files[file], path.join(folder, file), settings);
        expect(output, `${file} changed`).not.toBe(files[file]);
        fs.writeFileSync(path.join(folder, file), output);
      }

      // The fixtures compile untouched (the compile-oracle job builds them before cleanup), so every error is the cleanup's.
      const after = buildProject(folder, 'CodeStyle.csproj');

      expect(after.errors.map((error) => `${error.file}(${error.line}): ${error.code} ${error.message}`), 'compiler errors the cleanup added').toEqual([]);

      return folder;
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  it.each(CODE_STYLE_GROUPS.map((group) => [group] as const))('group "%s": every rule enabled through the setting adds no compiler error', (group) => {
    const rules = CODE_STYLE_RULES.filter((rule) => rule.group === group);

    cleanAndBuild({ [GROUP_FILES[group]]: defaults(rules) });
  }, 180_000);

  it('all groups enabled together add no compiler error', () => {
    cleanAndBuild(Object.fromEntries(Object.entries(GROUP_FILES).map(([group, file]) => [file, defaults(CODE_STYLE_RULES.filter((rule) => rule.group === group))])));
  }, 180_000);

  it('rules enabled through .codejanitor codeStyle, with values other than the proposed ones, add no compiler error', () => {
    const codeStyle: Record<string, string> = {
      csharp_prefer_braces: 'when_multiline',
      csharp_style_expression_bodied_methods: 'when_on_single_line',
      csharp_style_expression_bodied_properties: 'false',
      csharp_style_expression_bodied_accessors: 'false',
      csharp_style_expression_bodied_indexers: 'false',
      csharp_style_expression_bodied_constructors: 'true',
      csharp_style_expression_bodied_operators: 'true',
      csharp_style_expression_bodied_local_functions: 'true',
      dotnet_style_qualification_for_field: 'true',
      dotnet_style_qualification_for_property: 'true',
      dotnet_style_qualification_for_method: 'true',
      dotnet_style_qualification_for_event: 'true',
      dotnet_style_parentheses_in_arithmetic_binary_operators: 'never_if_unnecessary',
      dotnet_style_parentheses_in_other_operators: 'always_for_clarity',
      csharp_preferred_modifier_order: 'public,private,protected,internal,static,readonly,override,async',
    };
    const fileOf = (key: string): string => GROUP_FILES[CODE_STYLE_RULES.find((rule) => rule.key === key)!.group];
    const byFile: Record<string, Record<string, string>> = {};
    for (const [key, value] of Object.entries(codeStyle)) {
      (byFile[fileOf(key)] ??= {})[key] = value;
    }

    cleanAndBuild(byFile, JSON.stringify({ cleanup: { codeStyle } }));
  }, 180_000);
});
