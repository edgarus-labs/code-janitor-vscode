import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function codeStyle(source: string, rules: string, fileName = 'Sample.cs'): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties(
    [{ directory: '/repo', text: `root = true\n\n[*.cs]\n${rules}\n` }],
    `/repo/src/${fileName}`
  );
  const issues: string[] = [];
  // A project on the latest C# version, so that no rule is held back by the language version.
  const project = { directory: '/repo', languageVersion: 99 };
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { fileName, project }).apply(source);

  return { output, issues };
}

describe('editorconfig code style: severity gating', () => {
  const source = lines('namespace Demo', '{', '    class Sample', '    {', '    }', '}');

  it('does nothing without code-style options', () => {
    expect(codeStyle(source, 'indent_style = space')).toEqual({ output: source, issues: [] });
  });

  it.each(['file_scoped', 'file_scoped:silent', 'file_scoped:none', 'file_scoped:refactoring'])(
    'leaves `%s` (not suggestion/warning/error) untouched',
    (value) => {
      expect(codeStyle(source, `csharp_style_namespace_declarations = ${value}`).output).toBe(source);
    }
  );

  it('applies an option whose diagnostic is enforced through dotnet_diagnostic', () => {
    const { output } = codeStyle(
      source,
      'csharp_style_namespace_declarations = file_scoped\ndotnet_diagnostic.IDE0161.severity = warning'
    );

    expect(output).toBe(lines('namespace Demo;', '', 'class Sample', '{', '}'));
  });

  it('lets dotnet_diagnostic silence an option-level severity', () => {
    const { output } = codeStyle(
      source,
      'csharp_style_namespace_declarations = file_scoped:error\ndotnet_diagnostic.IDE0161.severity = none'
    );

    expect(output).toBe(source);
  });

  it('applies options enforced through the Style category severity', () => {
    const { output } = codeStyle(
      source,
      'csharp_style_namespace_declarations = file_scoped\ndotnet_analyzer_diagnostic.category-Style.severity = suggestion'
    );

    expect(output).toBe(lines('namespace Demo;', '', 'class Sample', '{', '}'));
  });
});

describe('line endings', () => {
  it('keeps CRLF line endings in the code it creates', () => {
    const source = lines('namespace Demo', '{', '    class Sample', '    {', '        void M(int x)', '        {', '            if (x > 0) return;', '        }', '    }', '}').replace(/\n/g, '\r\n');
    const { output } = codeStyle(source, 'csharp_style_namespace_declarations = file_scoped:warning\ncsharp_prefer_braces = true:warning');

    expect(output).toBe(
      lines('namespace Demo;', '', 'class Sample', '{', '    void M(int x)', '    {', '        if (x > 0)', '        {', '            return;', '        }', '    }', '}').replace(/\n/g, '\r\n')
    );
  });
});

describe('csharp_style_namespace_declarations', () => {
  it('converts the only block-scoped namespace to file-scoped and keeps usings inside it', () => {
    const source = lines(
      '// Header',
      'namespace Demo',
      '{',
      '    using System;',
      '',
      '    /// <summary>Doc.</summary>',
      '    public class Sample',
      '    {',
      '        string Text => "a  b";',
      '    }',
      '}'
    );

    expect(codeStyle(source, 'csharp_style_namespace_declarations = file_scoped:warning').output).toBe(
      lines(
        '// Header',
        'namespace Demo;',
        '',
        'using System;',
        '',
        '/// <summary>Doc.</summary>',
        'public class Sample',
        '{',
        '    string Text => "a  b";',
        '}'
      )
    );
  });

  it('converts a namespace with a multi-line verbatim string and leaves the string as it is', () => {
    const source = lines('namespace Demo', '{', '    class Sample', '    {', '        string Text = @"a', '    b";', '    }', '}');
    const { output, issues } = codeStyle(source, 'csharp_style_namespace_declarations = file_scoped:warning');

    expect(output).toBe(lines('namespace Demo;', '', 'class Sample', '{', '    string Text = @"a', '    b";', '}'));
    expect(issues).toEqual([]);
  });

  it('keeps a file-scoped namespace block-scoped when the project C# version is unknown or older than 10', () => {
    const source = lines('namespace Demo', '{', '    class Sample', '    {', '    }', '}');
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n\n[*.cs]\ncsharp_style_namespace_declarations = file_scoped:warning\n' }], '/repo/src/Sample.cs');

    for (const [project, reason] of [
      [undefined, /version is unknown/],
      [{ directory: '/repo' }, /version of its project is unknown/],
      [{ directory: '/repo', languageVersion: 9 }, /C# 9 and file-scoped namespaces need C# 10/],
    ] as const) {
      const issues: string[] = [];
      const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { fileName: 'Sample.cs', project }).apply(source);

      expect(output).toBe(source);
      expect(issues).toEqual([expect.stringMatching(reason)]);
    }
  });

  it('reports the unknown or older C# version only for a file with a block-scoped namespace to convert', () => {
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n\n[*.cs]\ncsharp_style_namespace_declarations = file_scoped:warning\n' }], '/repo/src/Sample.cs');

    for (const project of [undefined, { directory: '/repo' }, { directory: '/repo', languageVersion: 9 }]) {
      for (const source of [lines('namespace Demo;', '', 'class C { }'), lines('class C { }')]) {
        const issues: string[] = [];
        const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { fileName: 'Sample.cs', project }).apply(source);

        expect({ output, issues }).toEqual({ output: source, issues: [] });
      }
    }
  });

  it('converts a namespace that follows global attributes', () => {
    const source = lines('using System;', '[assembly: System.CLSCompliant(true)]', '', 'namespace Demo', '{', '    class C { }', '}');

    expect(codeStyle(source, 'csharp_style_namespace_declarations = file_scoped:warning')).toEqual({
      output: lines('using System;', '[assembly: System.CLSCompliant(true)]', '', 'namespace Demo;', '', 'class C { }'),
      issues: [],
    });
  });

  it('does not treat files with several namespaces as candidates', () => {
    const source = lines('namespace A', '{', '}', 'namespace B', '{', '}');

    expect(codeStyle(source, 'csharp_style_namespace_declarations = file_scoped:warning')).toEqual({ output: source, issues: [] });
  });

  it('converts a file-scoped namespace to block-scoped with one more indentation level', () => {
    const source = lines('using System;', '', 'namespace Demo;', '', 'public class Sample', '{', '    void M() { }', '}');

    expect(codeStyle(source, 'csharp_style_namespace_declarations = block_scoped:suggestion\nindent_size = 2').output).toBe(
      lines('using System;', '', 'namespace Demo', '{', '  public class Sample', '  {', '      void M() { }', '  }', '}')
    );
  });
});

describe('dotnet_style_require_accessibility_modifiers', () => {
  const source = lines(
    'class Sample',
    '{',
    '    int count;',
    '    void Run() { }',
    '    int this[int i] => i;',
    '    class Nested { }',
    '}',
    'interface IService',
    '{',
    '    void Run();',
    '}'
  );

  it('adds the default access modifier for for_non_interface_members', () => {
    const { output, issues } = codeStyle(source, 'dotnet_style_require_accessibility_modifiers = for_non_interface_members:warning');

    expect(output).toBe(
      lines(
        'internal class Sample',
        '{',
        '    private int count;',
        '    private void Run() { }',
        '    private int this[int i] => i;',
        '    private class Nested { }',
        '}',
        'internal interface IService',
        '{',
        '    void Run();',
        '}'
      )
    );
    expect(issues).toEqual([]);
  });

  it('reports interface members for always', () => {
    const { issues } = codeStyle(source, 'dotnet_style_require_accessibility_modifiers = always:warning');

    expect(issues).toEqual([expect.stringMatching(/^IDE0040 .* line 10: no access modifier added: interface members/)]);
  });

  it('reports partial types, whose accessibility may come from another part', () => {
    const { output, issues } = codeStyle(
      lines('partial class Sample', '{', '}'),
      'dotnet_style_require_accessibility_modifiers = for_non_interface_members:warning'
    );

    expect(output).toBe(lines('partial class Sample', '{', '}'));
    expect(issues).toEqual([expect.stringMatching(/partial type/)]);
  });

  it('removes default modifiers for omit_if_default', () => {
    const input = lines(
      'internal class Sample',
      '{',
      '    private int count;',
      '    private protected int shared;',
      '    public void Run() { }',
      '    private static void Helper() { }',
      '    private class Nested { }',
      '}',
      'public interface IService',
      '{',
      '    public void Run();',
      '}'
    );

    expect(codeStyle(input, 'dotnet_style_require_accessibility_modifiers = omit_if_default:suggestion').output).toBe(
      lines(
        'class Sample',
        '{',
        '    int count;',
        '    private protected int shared;',
        '    public void Run() { }',
        '    static void Helper() { }',
        '    class Nested { }',
        '}',
        'public interface IService',
        '{',
        '    public void Run();',
        '}'
      )
    );
  });

  it('never changes anything for never', () => {
    expect(codeStyle(source, 'dotnet_style_require_accessibility_modifiers = never:warning').output).toBe(source);
  });
});

describe('csharp_style_var_*', () => {
  function method(...body: string[]): string {
    return lines('class Sample', '{', '    void M(object o)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
  }

  it('uses var where the type is apparent, but never changes the declared type', () => {
    const source = method('List<int> list = new List<int>();', 'IFoo foo = new Foo();', 'Foo cast = (Foo)o;', 'Foo maybe = o as Foo;');

    expect(codeStyle(source, 'csharp_style_var_when_type_is_apparent = true:warning')).toEqual({
      output: method('var list = new List<int>();', 'IFoo foo = new Foo();', 'var cast = (Foo)o;', 'var maybe = o as Foo;'),
      issues: [],
    });
  });

  it('uses var for built-in types only when the literal has exactly that type', () => {
    const source = method('int n = 5;', 'long big = 5;', 'string s = "a";', 'double d = 1.5;', 'float f = 1.5f;', 'int m = Compute();');
    const { output, issues } = codeStyle(source, 'csharp_style_var_for_built_in_types = true:warning');

    expect(output).toBe(method('var n = 5;', 'long big = 5;', 'var s = "a";', 'var d = 1.5;', 'var f = 1.5f;', 'int m = Compute();'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0007 \(csharp_style_var_for_built_in_types\) line 10: 'int m'/)]);
  });

  it('reports var elsewhere, where the initializer type cannot be known', () => {
    const source = method('Foo foo = Create();');
    const { output, issues } = codeStyle(source, 'csharp_style_var_elsewhere = true:suggestion');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0007 \(csharp_style_var_elsewhere\)/)]);
  });

  it('writes explicit types that follow from the initializer', () => {
    const source = method(
      'var n = 5;',
      'var big = 5L;',
      'var s = @"a";',
      'var list = new List<int>();',
      'var cast = (Foo)o;',
      'var items = new int[3];',
      'var anonymous = new { A = 1 };',
      'var unknown = Create();'
    );
    const { output, issues } = codeStyle(
      source,
      'csharp_style_var_for_built_in_types = false:warning\ncsharp_style_var_when_type_is_apparent = false:warning'
    );

    expect(output).toBe(
      method(
        'int n = 5;',
        'long big = 5L;',
        'string s = @"a";',
        'List<int> list = new List<int>();',
        'Foo cast = (Foo)o;',
        'int[] items = new int[3];',
        'var anonymous = new { A = 1 };',
        'var unknown = Create();'
      )
    );
    expect(issues).toEqual([
      "IDE0008 (csharp_style_var_for_built_in_types/csharp_style_var_when_type_is_apparent): 1 local kept as 'var' (line 12): its type is not known without a compiler.",
    ]);
  });

  it('reports the locals whose type is not known once per file', () => {
    const source = method('var a = Create();', 'var b = Load(a);', 'var n = 5;', 'var c = a.Next;');
    const { output, issues } = codeStyle(source, 'csharp_style_var_elsewhere = false:warning\ncsharp_style_var_for_built_in_types = false:warning');

    expect(output).toBe(method('var a = Create();', 'var b = Load(a);', 'int n = 5;', 'var c = a.Next;'));
    expect(issues).toEqual([
      "IDE0008 (csharp_style_var_for_built_in_types/csharp_style_var_elsewhere): 3 locals kept as 'var' (lines 5, 6, 8): their type is not known without a compiler.",
    ]);
  });

  it('does not take the operand of ?? after `as` for the type', () => {
    const source = method('var items = o as IList ?? new List<object>();');
    const { output, issues } = codeStyle(source, 'csharp_style_var_when_type_is_apparent = false:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0008 .*1 local kept as 'var' \(line 5\)/)]);
  });

  it('keeps var when only the elsewhere preference is set and the type is built-in', () => {
    const source = method('var n = 5;');

    expect(codeStyle(source, 'csharp_style_var_elsewhere = false:warning').output).toBe(source);
  });

  it('ignores preferences that are not enforced', () => {
    const source = method('var n = 5;', 'List<int> list = new List<int>();');

    expect(
      codeStyle(source, 'csharp_style_var_for_built_in_types = false:silent\ncsharp_style_var_when_type_is_apparent = true')
    ).toEqual({ output: source, issues: [] });
  });
});

describe('csharp_prefer_braces', () => {
  function method(...body: string[]): string {
    return lines('class Sample', '{', '    void M(int x)', '    {', ...body.map((line) => (line ? `        ${line}` : '')), '    }', '}');
  }

  it('wraps embedded statements in braces, keeping else-if chains and trailing comments', () => {
    const source = method(
      'if (x > 0) return;',
      'else if (x < 0) x = 1;',
      'else x = 2;',
      'for (int i = 0; i < x; i++)',
      '    Console.WriteLine(i);',
      'while (x > 0) x--; // countdown',
      'do x++; while (x < 3);'
    );

    expect(codeStyle(source, 'csharp_prefer_braces = true:warning')).toEqual({
      output: method(
        'if (x > 0)',
        '{',
        '    return;',
        '}',
        'else if (x < 0)',
        '{',
        '    x = 1;',
        '}',
        'else',
        '{',
        '    x = 2;',
        '}',
        'for (int i = 0; i < x; i++)',
        '{',
        '    Console.WriteLine(i);',
        '}',
        'while (x > 0)',
        '{',
        '    x--; // countdown',
        '}',
        'do',
        '{',
        '    x++;',
        '} while (x < 3);'
      ),
      issues: [],
    });
  });

  it('braces nested embedded statements from the outside in', () => {
    const source = method('if (x > 0)', '    if (x > 1) x = 0;');

    expect(codeStyle(source, 'csharp_prefer_braces = true:warning').output).toBe(
      method('if (x > 0)', '{', '    if (x > 1)', '    {', '        x = 0;', '    }', '}')
    );
  });

  it('only braces multi-line statements for when_multiline', () => {
    const source = method('if (x > 0) return;', 'if (x < 0) Call(x,', '    x);');

    expect(codeStyle(source, 'csharp_prefer_braces = when_multiline:suggestion').output).toBe(
      method('if (x > 0) return;', 'if (x < 0)', '{', '    Call(x,', '        x);', '}')
    );
  });

  it('never removes braces for false', () => {
    const source = method('if (x > 0) { return; }');

    expect(codeStyle(source, 'csharp_prefer_braces = false:warning').output).toBe(source);
  });

  it('reports instead of bracing a statement the parser cannot read', () => {
    const source = method('if (x > 0) y = z');
    const { output, issues } = codeStyle(source, 'csharp_prefer_braces = true:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0011 .* line 5: braces were not added: the statement could not be fully parsed/)]);
  });

  it('does not add braces when the preference is silent', () => {
    const source = method('if (x > 0) return;');

    expect(codeStyle(source, 'csharp_prefer_braces = true:silent').output).toBe(source);
  });
});

describe('dotnet_style_qualification_for_*', () => {
  it('removes this. unless a local or parameter shadows the member, and reports undeclared members', () => {
    const source = lines(
      'class Sample : Base',
      '{',
      '    private int count;',
      '    void Set(int value) { this.count = value; }',
      '    void Reset(int count) { this.count = count; }',
      '    void Inherited() { this.baseField = 1; }',
      '}'
    );
    const { output, issues } = codeStyle(source, 'dotnet_style_qualification_for_field = false:warning');

    expect(output).toBe(
      lines(
        'class Sample : Base',
        '{',
        '    private int count;',
        '    void Set(int value) { count = value; }',
        '    void Reset(int count) { this.count = count; }',
        '    void Inherited() { this.baseField = 1; }',
        '}'
      )
    );
    expect(issues).toEqual([expect.stringMatching(/^IDE0003 .* line 6: 'this.baseField' was not simplified/)]);
  });

  it('adds this. to unshadowed instance members declared in the type', () => {
    const source = lines(
      'class Sample',
      '{',
      '    private int count;',
      '    private static int total;',
      '    public string Name { get; set; }',
      '    public event EventHandler Changed;',
      '    int Next => count + 1;',
      '    void Run(int value)',
      '    {',
      '        count = value;',
      '        total = value;',
      '        Name = nameof(count);',
      '        Changed?.Invoke(this, EventArgs.Empty);',
      '        Helper(count);',
      '        var other = new Sample { Name = Name };',
      '        foreach (var count2 in Items()) { }',
      '    }',
      '    void Shadow(int count) { count++; }',
      '    void Helper(int x) { }',
      '    System.Collections.Generic.List<int> Items() => null;',
      '    static void Static() { total++; }',
      '}'
    );
    const { output } = codeStyle(
      source,
      [
        'dotnet_style_qualification_for_field = true:warning',
        'dotnet_style_qualification_for_property = true:warning',
        'dotnet_style_qualification_for_method = true:warning',
        'dotnet_style_qualification_for_event = true:warning',
      ].join('\n')
    );

    expect(output).toBe(
      lines(
        'class Sample',
        '{',
        '    private int count;',
        '    private static int total;',
        '    public string Name { get; set; }',
        '    public event EventHandler Changed;',
        '    int Next => this.count + 1;',
        '    void Run(int value)',
        '    {',
        '        this.count = value;',
        '        total = value;',
        '        this.Name = nameof(count);',
        '        this.Changed?.Invoke(this, EventArgs.Empty);',
        '        this.Helper(this.count);',
        '        var other = new Sample { Name = this.Name };',
        '        foreach (var count2 in this.Items()) { }',
        '    }',
        '    void Shadow(int count) { count++; }',
        '    void Helper(int x) { }',
        '    System.Collections.Generic.List<int> Items() => null;',
        '    static void Static() { total++; }',
        '}'
      )
    );
  });

  it('qualifies a member used right after a block', () => {
    const source = lines('class Sample', '{', '    int count;', '    void Run(bool flag)', '    {', '        if (flag)', '        {', '        }', '        count = 1;', '    }', '}');

    expect(codeStyle(source, 'dotnet_style_qualification_for_field = true:warning').output).toBe(
      lines('class Sample', '{', '    int count;', '    void Run(bool flag)', '    {', '        if (flag)', '        {', '        }', '        this.count = 1;', '    }', '}')
    );
  });

  it('does not qualify tuple element names', () => {
    const source = lines('class Sample', '{', '    int x;', '    object Pair() => (x: 1, y: x);', '}');

    expect(codeStyle(source, 'dotnet_style_qualification_for_field = true:warning').output).toBe(
      lines('class Sample', '{', '    int x;', '    object Pair() => (x: 1, y: this.x);', '}')
    );
  });

  it('only applies the option of the member kind', () => {
    const source = lines('class Sample', '{', '    int count;', '    void Run() { count = 1; Run(); }', '}');

    expect(codeStyle(source, 'dotnet_style_qualification_for_method = true:warning').output).toBe(
      lines('class Sample', '{', '    int count;', '    void Run() { count = 1; this.Run(); }', '}')
    );
  });

  it('leaves members the parser could not fully read untouched', () => {
    const source = lines('record Sample', '{', '    int count;', '    Sample Copy() { var copy = this; count = 1 return copy; }', '}');

    expect(codeStyle(source, 'dotnet_style_qualification_for_field = true:warning').output).toBe(source);
  });
});

describe('csharp_style_inlined_variable_declaration', () => {
  it('inlines the declaration keeping its type when the scope stays the same', () => {
    const source = lines(
      'class Sample',
      '{',
      '    void M(string text)',
      '    {',
      '        int value;',
      '        if (int.TryParse(text, out value)) { }',
      '        int loop;',
      '        while (int.TryParse(text, out loop)) { }',
      '    }',
      '}'
    );

    expect(codeStyle(source, 'csharp_style_inlined_variable_declaration = true:warning').output).toBe(
      lines(
        'class Sample',
        '{',
        '    void M(string text)',
        '    {',
        '        if (int.TryParse(text, out int value)) { }',
        '        int loop;',
        '        while (int.TryParse(text, out loop)) { }',
        '    }',
        '}'
      )
    );
  });
});

describe('file_header_template', () => {
  const rules = 'file_header_template = {fileName}\\nCopyright (c) Contoso.\ndotnet_diagnostic.IDE0073.severity = warning';

  it('inserts the header, expanding {fileName}', () => {
    expect(codeStyle(lines('using System;'), rules, 'Widget.cs').output).toBe(
      lines('// Widget.cs', '// Copyright (c) Contoso.', '', 'using System;')
    );
  });

  it('replaces a different header and keeps a matching one', () => {
    expect(codeStyle(lines('// Old header', '', 'using System;'), rules, 'Widget.cs').output).toBe(
      lines('// Widget.cs', '// Copyright (c) Contoso.', '', 'using System;')
    );

    const current = lines('// Widget.cs', '// Copyright (c) Contoso.', '', 'using System;');
    expect(codeStyle(current, rules, 'Widget.cs').output).toBe(current);
  });

  it('does nothing while IDE0073 is not enforced', () => {
    const source = lines('using System;');

    expect(codeStyle(source, 'file_header_template = Copyright').output).toBe(source);
  });
});

describe('dotnet_style_readonly_field', () => {
  it('makes fields readonly when only constructors assign them', () => {
    const source = lines('class Sample', '{', '    private int count;', '    public Sample() { count = 1; }', '}');

    expect(codeStyle(source, 'dotnet_style_readonly_field = true:warning').output).toBe(
      lines('class Sample', '{', '    private readonly int count;', '    public Sample() { count = 1; }', '}')
    );
  });
});

describe('csharp_prefer_simple_using_statement', () => {
  it('converts a using statement that ends its block', () => {
    const source = lines(
      'class Sample',
      '{',
      '    void M()',
      '    {',
      '        Prepare();',
      '        using (var stream = Open())',
      '        {',
      '            stream.Flush();',
      '',
      '            stream.Close();',
      '        }',
      '    }',
      '}'
    );

    expect(codeStyle(source, 'csharp_prefer_simple_using_statement = true:warning').output).toBe(
      lines(
        'class Sample',
        '{',
        '    void M()',
        '    {',
        '        Prepare();',
        '        using var stream = Open();',
        '        stream.Flush();',
        '',
        '        stream.Close();',
        '    }',
        '}'
      )
    );
  });

  it('keeps using statements followed by other statements', () => {
    const source = lines(
      'class Sample',
      '{',
      '    void M()',
      '    {',
      '        using (var stream = Open())',
      '        {',
      '            stream.Flush();',
      '        }',
      '        Done();',
      '    }',
      '}'
    );

    expect(codeStyle(source, 'csharp_prefer_simple_using_statement = true:warning')).toEqual({ output: source, issues: [] });
  });

  it('reports a using statement whose names are used elsewhere in the block', () => {
    const source = lines(
      'class Sample',
      '{',
      '    void M()',
      '    {',
      '        { var stream = 1; }',
      '        using (var stream = Open())',
      '        {',
      '            stream.Flush();',
      '        }',
      '    }',
      '}'
    );
    const { output, issues } = codeStyle(source, 'csharp_prefer_simple_using_statement = true:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0063 .* line 6: .*'stream'/)]);
  });

  it('reports a using statement whose pattern designations or labels are declared elsewhere in the block', () => {
    const block = (...body: string[]) => lines('class Sample', '{', '    void M(object o, IDisposable d)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
    const cases = [
      block('{ var t = ""; Use(t); }', 'using (var r = d)', '{', '    var ok = o is string t && t.Length > 0;', '}'),
      block('{ var t = 1; }', 'using (var r = d)', '{', '    var ok = o is { } t;', '}'),
      block('{ var a = 1; }', 'using (var r = d)', '{', '    var ok = o is var (a, b);', '}'),
      block('{ L: ; }', 'using (var r = d)', '{', '    L: r.Dispose();', '}'),
    ];

    for (const source of cases) {
      const { output, issues } = codeStyle(source, 'csharp_prefer_simple_using_statement = true:warning');

      expect(output).toBe(source);
      expect(issues).toEqual([expect.stringMatching(/^IDE0063 .* line 6: .*'(t|a|L)' is also used/)]);
    }
  });

  it('converts a using statement whose pattern names nothing declared elsewhere', () => {
    const source = lines('class Sample', '{', '    void M(object o, IDisposable d)', '    {', '        Use(typeof(Uri));', '        using (var r = d)', '        {', '            var ok = o is string t || o is Exception or Uri;', '        }', '    }', '}');

    expect(codeStyle(source, 'csharp_prefer_simple_using_statement = true:warning').output).toBe(
      lines('class Sample', '{', '    void M(object o, IDisposable d)', '    {', '        Use(typeof(Uri));', '        using var r = d;', '        var ok = o is string t || o is Exception or Uri;', '    }', '}')
    );
  });
});
