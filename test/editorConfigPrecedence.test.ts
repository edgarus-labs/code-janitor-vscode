import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { EditorConfigIssue, runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

describe('.editorconfig precedence over the cleanup settings', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-precedence-'));
    filePath = path.join(root, 'Sample.cs');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function clean(
    source: string,
    editorConfig: string | undefined,
    overrides: Partial<CleanupSettings> = {}
  ): { output: string; issues: EditorConfigIssue[] } {
    if (editorConfig !== undefined) {
      fs.writeFileSync(path.join(root, '.editorconfig'), `root = true\n\n[*.cs]\n${editorConfig}\n`);
    }

    const issues: EditorConfigIssue[] = [];
    const output = runCleanup(source, filePath, { ...createDefaultSettings(), ...overrides }, undefined, (issue) =>
      issues.push(issue)
    );

    return { output, issues };
  }

  it('applies .editorconfig rules without any setting', () => {
    const source = lines('internal class Sample', '{', '    private void M(int x)', '    {', '        if (x > 0) return;', '    }', '}');

    expect(clean(source, 'csharp_prefer_braces = true:warning').output).toBe(
      lines('internal class Sample', '{', '    private void M(int x)', '    {', '        if (x > 0)', '        {', '            return;', '        }', '    }', '}')
    );
  });

  it('keeps the settings-only behavior when no .editorconfig applies', () => {
    const source = lines('class Sample   ', '{', '    void M(int x)', '    {', '        if (x > 0) return;', '    }', '}');

    expect(clean(source, undefined)).toEqual({
      output: lines('internal class Sample', '{', '    private void M(int x)', '    {', '        if (x > 0) return;', '    }', '}'),
      issues: [],
    });
  });

  it('keeps usings inside the namespace for inside_namespace, although moving them out is on by default', () => {
    const source = lines('namespace Demo', '{', '    using System;', '', '    internal class Sample { }', '}');

    expect(clean(source, 'csharp_using_directive_placement = inside_namespace:warning').output).toBe(source);
  });

  it('removes default access modifiers for omit_if_default instead of adding them', () => {
    const source = lines('class Sample', '{', '    private int count;', '', '    void M() { }', '}');

    expect(clean(source, 'dotnet_style_require_accessibility_modifiers = omit_if_default:warning').output).toBe(
      lines('class Sample', '{', '    int count;', '', '    void M() { }', '}')
    );
  });

  it('keeps block-scoped namespaces although file-scoped conversion is on', () => {
    const source = lines('namespace Demo', '{', '    internal class Sample { }', '}');

    expect(
      clean(source, 'csharp_style_namespace_declarations = block_scoped:warning', { convertToFileScopedNamespace: true }).output
    ).toBe(source);
  });

  it('keeps explicit types although var conversion is on', () => {
    const body = ['internal class Sample', '{', '    private void M()', '    {', '        Foo foo = new Foo();', '    }', '}'];

    expect(
      clean(lines(...body), 'csharp_style_var_when_type_is_apparent = false:warning', { convertToVarWhenApparent: true }).output
    ).toBe(lines(...body));
  });

  it('does not make fields readonly for dotnet_style_readonly_field = false', () => {
    const source = lines('internal class Sample', '{', '    private int count;', '', '    public Sample() { count = 1; }', '}');

    expect(clean(source, 'dotnet_style_readonly_field = false:warning', { makeFieldsReadonlyWhenSafe: true }).output).toBe(source);
  });

  it('does not inline out variables for csharp_style_inlined_variable_declaration = false', () => {
    const source = lines(
      'internal class Sample',
      '{',
      '    private void M(string text)',
      '    {',
      '        int value;',
      '        int.TryParse(text, out value);',
      '    }',
      '}'
    );

    expect(clean(source, 'csharp_style_inlined_variable_declaration = false:warning').output).toBe(source);
  });

  it('keeps the declared type when inlining out variables while explicit types are preferred', () => {
    const source = lines(
      'internal class Sample',
      '{',
      '    private void M(string text)',
      '    {',
      '        int value;',
      '        int.TryParse(text, out value);',
      '    }',
      '}'
    );

    expect(clean(source, 'csharp_style_var_for_built_in_types = false:warning').output).toBe(
      lines('internal class Sample', '{', '    private void M(string text)', '    {', '        int.TryParse(text, out int value);', '    }', '}')
    );
  });

  it('uses file_header_template instead of the configured header', () => {
    const source = lines('internal class Sample { }');
    const editorConfig = 'file_header_template = From editorconfig\ndotnet_diagnostic.IDE0073.severity = warning';

    expect(clean(source, editorConfig, { fileHeaderCSharp: '// From settings' }).output).toBe(
      lines('// From editorconfig', '', 'internal class Sample { }')
    );
  });

  it('keeps trailing whitespace for trim_trailing_whitespace = false', () => {
    const source = lines('internal class Sample   ', '{', '}');

    expect(clean(source, 'trim_trailing_whitespace = false').output).toBe(source);
  });

  it('does not add a final newline for insert_final_newline = false', () => {
    expect(clean('internal class Sample { }', 'insert_final_newline = false').output).toBe('internal class Sample { }');
  });

  it('keeps the byte order mark for charset = utf-8-bom', () => {
    const source = '\uFEFFinternal class Sample { }\n';

    expect(clean(source, 'charset = utf-8-bom').output).toBe(source);
    expect(clean(source, 'charset = utf-8', { removeByteOrderMark: false }).output).toBe('internal class Sample { }\n');
  });

  it('sorts usings alphabetically for dotnet_sort_system_directives_first = false', () => {
    const source = lines('using Zeta;', 'using System;', 'using Alpha;', '', 'internal class Sample { }');

    expect(clean(source, 'dotnet_sort_system_directives_first = false', { organizeUsings: true }).output).toBe(
      lines('using Alpha;', 'using System;', 'using Zeta;', '', 'internal class Sample { }')
    );
  });

  it('sorts usings for dotnet_sort_system_directives_first = false even while sorting is off', () => {
    const source = lines('using Zeta;', 'using System;', '', 'internal class Sample { }');

    expect(clean(source, 'dotnet_sort_system_directives_first = false').output).toBe(
      lines('using System;', 'using Zeta;', '', 'internal class Sample { }')
    );
  });

  it('follows dotnet_sort_system_directives_first while the sort usings setting is on', () => {
    const source = lines('using Zeta;', 'using Alpha;', 'using System;', '', 'internal class Sample { }');

    expect(clean(source, 'dotnet_sort_system_directives_first = false', { organizeUsings: true }).output).toBe(
      lines('using Alpha;', 'using System;', 'using Zeta;', '', 'internal class Sample { }')
    );
    expect(clean(source, 'dotnet_sort_system_directives_first = true', { organizeUsings: true }).output).toBe(
      lines('using System;', 'using Alpha;', 'using Zeta;', '', 'internal class Sample { }')
    );
  });

  it('sorts System usings first for dotnet_sort_system_directives_first = true without IDE0055', () => {
    const source = lines('using Zeta;', 'using System;', '', 'internal class Sample { }');

    expect(clean(source, 'dotnet_sort_system_directives_first = true').output).toBe(
      lines('using System;', 'using Zeta;', '', 'internal class Sample { }')
    );
  });

  it('expands tabs with the indent_style of the .editorconfig', () => {
    const source = lines('internal class Sample', '{', '\tprivate int x;', '}');

    expect(clean(source, 'indent_style = space\nindent_size = 2').output).toBe(
      lines('internal class Sample', '{', '  private int x;', '}')
    );
  });

  it('does not convert to collection expressions when they are not preferred', () => {
    const source = lines('internal class Sample', '{', '    private List<int> items = new List<int>();', '}');

    expect(
      clean(source, 'dotnet_style_prefer_collection_expression = never:warning', { convertToCollectionExpressions: true }).output
    ).toBe(source);
  });

  it('does not simplify lambdas when block bodies are preferred', () => {
    const source = lines('internal class Sample', '{', '    private Func<int> f = () => { return 1; };', '}');

    expect(
      clean(source, 'csharp_style_expression_bodied_lambdas = false:warning', { simplifySingleStatementLambdas: true }).output
    ).toBe(source);
  });

  it('reports unsupported settings once each and separately from violations', () => {
    const source = lines('internal class Sample', '{', '    private Widget widget = Create();', '}');
    const editorConfig = [
      'csharp_prefer_static_anonymous_function = true:warning',
      'max_line_length = 120',
      'dotnet_diagnostic.CA1062.severity = warning',
      'dotnet_diagnostic.RCS1079.severity = error',
      'csharp_style_expression_bodied_properties = true',
      'dotnet_diagnostic.CA2007.severity = none',
      'csharp_prefer_braces = true:warning',
    ].join('\n');

    const { issues } = clean(source, editorConfig);

    expect(issues).toEqual([
      { kind: 'unsupported', message: `${filePath}: "csharp_prefer_static_anonymous_function = true:warning" is not supported and was not applied.` },
      { kind: 'unsupported', message: `${filePath}: "max_line_length = 120" is not supported and was not applied.` },
      { kind: 'unsupported', message: `${filePath}: "dotnet_diagnostic.ca1062.severity = warning" is not supported and was not applied.` },
      {
        kind: 'unsupported',
        message: `${filePath}: "dotnet_diagnostic.rcs1079.severity = error" belongs to a third-party analyzer (RCS1079); cleanup only applies .NET SDK rules, so it was not applied.`,
      },
    ]);
  });
});

describe('unsupportedEditorConfigSettings', () => {
  function unsupported(editorConfig: string): string[] {
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${editorConfig}\n` }], '/repo/A.cs');

    return unsupportedEditorConfigSettings(props);
  }

  it('accepts every supported option, naming rule part and severity of a supported rule', () => {
    expect(
      unsupported(
        [
          'indent_style = space',
          'indent_size = 4',
          'end_of_line = lf',
          'charset = utf-8',
          'csharp_style_namespace_declarations = file_scoped:warning',
          'csharp_style_var_elsewhere = false:suggestion',
          'dotnet_diagnostic.IDE0055.severity = warning',
          'dotnet_diagnostic.IDE1006.severity = warning',
          'csharp_new_line_before_open_brace = methods, types',
          'dotnet_naming_rule.types.symbols = types',
          'dotnet_naming_rule.types.style = pascal',
          'dotnet_naming_rule.types.severity = warning',
          'dotnet_naming_symbols.types.applicable_kinds = class',
          'dotnet_naming_style.pascal.capitalization = pascal_case',
          'dotnet_analyzer_diagnostic.category-Style.severity = suggestion',
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('reports values a supported option does not know', () => {
    expect(unsupported('csharp_style_namespace_declarations = file_scope:warning\ncharset = latin1')).toEqual([
      '"csharp_style_namespace_declarations = file_scope:warning" has an unsupported value and was not applied.',
      '"charset = latin1" has an unsupported value and was not applied.',
    ]);
  });

  it('reports unsupported formatting options only while IDE0055 is enforced', () => {
    expect(unsupported('csharp_space_around_unknown = true')).toEqual([]);
    expect(unsupported('csharp_space_around_unknown = true\ndotnet_diagnostic.IDE0055.severity = warning')).toEqual([
      '"csharp_space_around_unknown = true" is not supported and was not applied.',
    ]);
  });

  it('treats the Style category severity as enforcing unsupported code-style options', () => {
    expect(
      unsupported('csharp_prefer_static_anonymous_function = true\ndotnet_analyzer_diagnostic.category-Style.severity = warning')
    ).toEqual(['"csharp_prefer_static_anonymous_function = true" is not supported and was not applied.']);
  });
});
