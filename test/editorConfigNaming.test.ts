import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { EditorConfigIssue, runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';
import { parseNamingRules } from '../src/cleanup/naming/namingRules';
import { NamingStyle } from '../src/cleanup/naming/namingStyle';
import { createEditorConfigNamingConverter } from '../src/cleanup/transformations/editorConfigNaming';

/** Microsoft's common template plus private-field / local / constant rules from dotnet/runtime. */
const template = `
root = true

[*.cs]
dotnet_naming_rule.interface_should_be_begins_with_i.severity = suggestion
dotnet_naming_rule.interface_should_be_begins_with_i.symbols = interface
dotnet_naming_rule.interface_should_be_begins_with_i.style = begins_with_i

dotnet_naming_rule.types_should_be_pascal_case.severity = suggestion
dotnet_naming_rule.types_should_be_pascal_case.symbols = types
dotnet_naming_rule.types_should_be_pascal_case.style = pascal_case

dotnet_naming_rule.non_field_members_should_be_pascal_case.severity = suggestion
dotnet_naming_rule.non_field_members_should_be_pascal_case.symbols = non_field_members
dotnet_naming_rule.non_field_members_should_be_pascal_case.style = pascal_case

dotnet_naming_rule.constant_fields_should_be_pascal_case.severity = warning
dotnet_naming_rule.constant_fields_should_be_pascal_case.symbols = constant_fields
dotnet_naming_rule.constant_fields_should_be_pascal_case.style = pascal_case

dotnet_naming_rule.private_fields_should_be_camel_case.severity = warning
dotnet_naming_rule.private_fields_should_be_camel_case.symbols = private_fields
dotnet_naming_rule.private_fields_should_be_camel_case.style = camel_case_underscore

dotnet_naming_rule.locals_should_be_camel_case.severity = warning
dotnet_naming_rule.locals_should_be_camel_case.symbols = locals_and_parameters
dotnet_naming_rule.locals_should_be_camel_case.style = camel_case

dotnet_naming_symbols.interface.applicable_kinds = interface
dotnet_naming_symbols.interface.applicable_accessibilities = public, internal, private, protected, protected_internal, private_protected
dotnet_naming_symbols.interface.required_modifiers =

dotnet_naming_symbols.types.applicable_kinds = class, struct, interface, enum
dotnet_naming_symbols.types.applicable_accessibilities = public, internal, private, protected, protected_internal, private_protected
dotnet_naming_symbols.types.required_modifiers =

dotnet_naming_symbols.non_field_members.applicable_kinds = property, event, method
dotnet_naming_symbols.non_field_members.applicable_accessibilities = public, internal, private, protected, protected_internal, private_protected
dotnet_naming_symbols.non_field_members.required_modifiers =

dotnet_naming_symbols.constant_fields.applicable_kinds = field
dotnet_naming_symbols.constant_fields.required_modifiers = const

dotnet_naming_symbols.private_fields.applicable_kinds = field
dotnet_naming_symbols.private_fields.applicable_accessibilities = private, protected, private_protected

dotnet_naming_symbols.locals_and_parameters.applicable_kinds = parameter, local, local_function
dotnet_naming_symbols.locals_and_parameters.applicable_accessibilities = *

dotnet_naming_style.begins_with_i.required_prefix = I
dotnet_naming_style.begins_with_i.required_suffix =
dotnet_naming_style.begins_with_i.word_separator =
dotnet_naming_style.begins_with_i.capitalization = pascal_case

dotnet_naming_style.pascal_case.required_prefix =
dotnet_naming_style.pascal_case.required_suffix =
dotnet_naming_style.pascal_case.word_separator =
dotnet_naming_style.pascal_case.capitalization = pascal_case

dotnet_naming_style.camel_case_underscore.required_prefix = _
dotnet_naming_style.camel_case_underscore.capitalization = camel_case

dotnet_naming_style.camel_case.capitalization = camel_case
`;

function props(editorConfig: string) {
  return resolveEditorConfigProperties([{ directory: '/repo', text: editorConfig }], '/repo/src/Sample.cs');
}

function clean(source: string, editorConfig = template): { output: string; issues: string[] } {
  const issues: string[] = [];
  const output = createEditorConfigNamingConverter(props(editorConfig), (issue) => issues.push(issue)).apply(source);

  return { output, issues };
}

describe('editorconfig naming cleanup', () => {
  it('renames private members, locals and private-method parameters and reports public violations', () => {
    const source = [
      'namespace Demo',
      '{',
      '    public interface repository { int Count { get; } }',
      '',
      '    public class Counter',
      '    {',
      '        private const int maxItems = 10;',
      '        private int m_Count;',
      '        private readonly string name;',
      '',
      '        public Counter(string name)',
      '        {',
      '            this.name = name;',
      '        }',
      '',
      '        public int Add(int Amount)',
      '        {',
      '            int Result = m_Count + Amount;',
      '            m_Count = Math.Min(Result, maxItems);',
      '            return calculateTotal(m_Count);',
      '        }',
      '',
      '        public int get_total() => calculateTotal(Value: m_Count);',
      '',
      '        private int calculateTotal(int Value)',
      '        {',
      '            var Doubled = Value * 2;',
      '            return Doubled + name.Length;',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');

    const { output, issues } = clean(source);

    expect(output).toBe(
      [
        'namespace Demo',
        '{',
        '    public interface repository { int Count { get; } }',
        '',
        '    public class Counter',
        '    {',
        '        private const int MaxItems = 10;',
        '        private int _count;',
        '        private readonly string _name;',
        '',
        '        public Counter(string name)',
        '        {',
        '            this._name = name;',
        '        }',
        '',
        '        public int Add(int Amount)',
        '        {',
        '            int result = _count + Amount;',
        '            _count = Math.Min(result, MaxItems);',
        '            return CalculateTotal(_count);',
        '        }',
        '',
        '        public int get_total() => CalculateTotal(value: _count);',
        '',
        '        private int CalculateTotal(int value)',
        '        {',
        '            var doubled = value * 2;',
        '            return doubled + _name.Length;',
        '        }',
        '    }',
        '}',
        '',
      ].join('\n')
    );
    expect(issues).toHaveLength(3);
    expect(issues).toContainEqual(expect.stringMatching(/line 3: interface 'repository' should be named 'IRepository'.*type names/));
    expect(issues).toContainEqual(expect.stringMatching(/line 16: parameter 'Amount' should be named 'amount'.*non-private/));
    expect(issues).toContainEqual(expect.stringMatching(/'non_field_members_should_be_pascal_case'.*line 23: method 'get_total' should be named 'Get_total'/));
  });

  it('leaves the source unchanged when naming rules are silent, none or suppressed by IDE1006', () => {
    const source = 'class C\n{\n    private int m_Count;\n    int Get() => m_Count;\n}\n';
    const silent = template.replaceAll('.severity = warning', '.severity = silent').replaceAll('.severity = suggestion', '.severity = none');

    expect(clean(source, silent)).toEqual({ output: source, issues: [] });
    expect(clean(source, `${template}\ndotnet_diagnostic.IDE1006.severity = none\n`)).toEqual({ output: source, issues: [] });
    expect(clean(source, '[*.cs]\nindent_style = space\n')).toEqual({ output: source, issues: [] });
  });

  it('applies a silent rule when dotnet_diagnostic.IDE1006.severity raises it', () => {
    const source = 'class C\n{\n    private int m_Count;\n}\n';
    const silent = template.replaceAll('.severity = warning', '.severity = silent');

    expect(clean(source, `${silent}\ndotnet_diagnostic.IDE1006.severity = warning\n`).output).toContain('private int _count;');
  });

  it('lets the first matching rule decide even when the name complies with it', () => {
    const editorConfig = `${template}
dotnet_naming_rule.static_fields.severity = warning
dotnet_naming_rule.static_fields.symbols = static_fields
dotnet_naming_rule.static_fields.style = s_prefix
dotnet_naming_symbols.static_fields.applicable_kinds = field
dotnet_naming_symbols.static_fields.required_modifiers = static
dotnet_naming_style.s_prefix.required_prefix = s_
dotnet_naming_style.s_prefix.capitalization = camel_case
`;
    const source = 'class C\n{\n    private static int s_cache;\n    private static int Other;\n    private const int Max = 1;\n}\n';

    expect(clean(source, editorConfig).output).toBe(
      'class C\n{\n    private static int s_cache;\n    private static int s_other;\n    private const int Max = 1;\n}\n'
    );
  });

  it('respects shadowing parameters, lambdas and nested scopes', () => {
    const source = [
      'class C',
      '{',
      '    private int count;',
      '    public C(int count) { this.count = count; }',
      '    int Next() => count + 1;',
      '    void Each(List<int> items)',
      '    {',
      '        items.ForEach(count => Use(count));',
      '        foreach (var Item in items) { Use(Item); }',
      '        foreach (var Item in items) { Use(Item + count); }',
      '    }',
      '}',
    ].join('\n');

    expect(clean(source).output).toBe(
      [
        'class C',
        '{',
        '    private int _count;',
        '    public C(int count) { this._count = count; }',
        '    int Next() => _count + 1;',
        '    void Each(List<int> items)',
        '    {',
        '        items.ForEach(count => Use(count));',
        '        foreach (var item in items) { Use(item); }',
        '        foreach (var item in items) { Use(item + _count); }',
        '    }',
        '}',
      ].join('\n')
    );
  });

  it('updates nameof, interpolations, same-type receivers and XML documentation but not strings or comments', () => {
    const source = [
      'class C',
      '{',
      '    /// <summary>Uses <see cref="m_Value"/> and <see cref="C.Compute(int)"/>.</summary>',
      '    private int m_Value;',
      '    public bool Same(C other) => other.m_Value == m_Value;',
      '    public string Show() => $"{m_Value,5:N0} {nameof(m_Value)} {{m_Value}}"; // m_Value',
      '    public string Raw() => "m_Value";',
      '    /// <param name="Input">The input.</param>',
      '    /// <returns><paramref name="Input"/> doubled.</returns>',
      '    private int Compute(int Input) => Input * 2;',
      '}',
    ].join('\n');

    expect(clean(source).output).toBe(
      [
        'class C',
        '{',
        '    /// <summary>Uses <see cref="_value"/> and <see cref="C.Compute(int)"/>.</summary>',
        '    private int _value;',
        '    public bool Same(C other) => other._value == _value;',
        '    public string Show() => $"{_value,5:N0} {nameof(_value)} {{m_Value}}"; // m_Value',
        '    public string Raw() => "m_Value";',
        '    /// <param name="input">The input.</param>',
        '    /// <returns><paramref name="input"/> doubled.</returns>',
        '    private int Compute(int input) => input * 2;',
        '}',
      ].join('\n')
    );
  });

  it('renames local functions, their parameters and their named arguments', () => {
    const source = [
      'class C',
      '{',
      '    int Run()',
      '    {',
      '        return Twice(Number: 2);',
      '        int Twice(int Number) => Number * 2;',
      '    }',
      '}',
    ].join('\n');

    expect(clean(source).output).toBe(
      [
        'class C',
        '{',
        '    int Run()',
        '    {',
        '        return twice(number: 2);',
        '        int twice(int number) => number * 2;',
        '    }',
        '}',
      ].join('\n')
    );
  });

  it('reports instead of renaming when the new name is taken or references cannot be resolved', () => {
    const source = [
      'class C',
      '{',
      '    private int m_Count;',
      '    private int count;',
      '    private int m_Size;',
      '    int Sum(object o) => m_Count + count + Other().m_Size;',
      '    C Other() => this;',
      '}',
    ].join('\n');

    const { output, issues } = clean(source);

    // Exactly one of the two fields can take `_count`; `m_Size` is read through an unresolvable receiver.
    expect(output).toContain('private int _count;');
    expect(output.match(/_count/g)).toHaveLength(2);
    expect(output).toContain('private int m_Size;');
    expect(output).toContain('Other().m_Size');
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual(expect.stringMatching(/should be named '_count'.*'_count' is already used in C/));
    expect(issues).toContainEqual(expect.stringMatching(/'m_Size' should be named '_size'.*another expression/));
  });

  it('does not rename members of partial types or code the parser cannot fully analyze', () => {
    const partial = 'partial class C\n{\n    private int m_Count;\n}\n';
    const switchUse = [
      'class C',
      '{',
      '    private const int max_value = 1;',
      '    int M(int v)',
      '    {',
      '        switch (v) { case max_value: return 1; }',
      '        return max_value;',
      '    }',
      '}',
    ].join('\n');

    const partialResult = clean(partial);
    expect(partialResult.output).toBe(partial);
    expect(partialResult.issues).toEqual([expect.stringMatching(/'m_Count'.*partial type/)]);

    const switchResult = clean(switchUse);
    expect(switchResult.output).toBe(switchUse);
    expect(switchResult.issues).toEqual([expect.stringMatching(/'max_value' should be named 'Max_value'.*line 6/)]);
  });

  it('renames every reference or none in constructs the parser reads loosely, keeping CRLF', () => {
    const source = [
      'class C',
      '{',
      '    int Ratio(List<int> items, int total)',
      '    {',
      '        var Covered = items.Count;',
      '        return (int)Math.Round((double)Covered / total * 100);',
      '    }',
      '',
      '    T Pick<T>(T First, T Second) where T : IComparable<T> => First.CompareTo(Second) > 0 ? First : Second;',
      '',
      '    async Task Watch(Func<Func<object[], Task>, Task> subscribe) => await subscribe(async (object[] Values) => { await Use(Values); });',
      '}',
      '',
    ].join('\r\n');

    const { output, issues } = clean(source);

    expect(output).toBe(source.replaceAll('Values', 'values').replaceAll('Covered', 'covered'));
    expect(issues.some((issue) => issue.includes("parameter 'First'"))).toBe(true);
    expect(issues.some((issue) => issue.includes("parameter 'Second'"))).toBe(true);
  });

  it('renames type parameters in every type position of their declaration', () => {
    const editorConfig = `[*.cs]
dotnet_naming_rule.type_parameters.severity = warning
dotnet_naming_rule.type_parameters.symbols = type_parameters
dotnet_naming_rule.type_parameters.style = t_prefix
dotnet_naming_symbols.type_parameters.applicable_kinds = type_parameter
dotnet_naming_style.t_prefix.required_prefix = T
dotnet_naming_style.t_prefix.capitalization = pascal_case
`;
    const source = [
      '/// <typeparam name="item">Item type.</typeparam>',
      'public class Box<item> where item : class',
      '{',
      '    private item _value;',
      '    /// <typeparam name="result">Result.</typeparam>',
      '    public result Map<result>(Func<item, result> map) => map(_value) ?? default(result);',
      '}',
    ].join('\n');

    expect(clean(source, editorConfig)).toEqual({
      output: [
        '/// <typeparam name="TItem">Item type.</typeparam>',
        'public class Box<TItem> where TItem : class',
        '{',
        '    private TItem _value;',
        '    /// <typeparam name="TResult">Result.</typeparam>',
        '    public TResult Map<TResult>(Func<TItem, TResult> map) => map(_value) ?? default(TResult);',
        '}',
      ].join('\n'),
      issues: [],
    });
  });

  it('refuses renames that would capture another symbol or rename an anonymous type member', () => {
    const collision = 'class C\n{\n    private int Total;\n    public int _total;\n    int Sum() => Total + _total;\n}\n';
    const projection = 'class C\n{\n    private int Size;\n    object P() => new { Size };\n}\n';

    const collisionResult = clean(collision);
    expect(collisionResult.output).toBe(collision);
    expect(collisionResult.issues).toEqual([expect.stringMatching(/'Total' should be named '_total'.*already used in C/)]);

    const projectionResult = clean(projection);
    expect(projectionResult.output).toBe(projection);
    expect(projectionResult.issues).toEqual([expect.stringMatching(/'Size' should be named '_size'.*anonymous type/)]);
  });
});

describe('code the parser misreads', () => {
  it('renames nothing a member split into pieces declares, like an explicit interface implementation', () => {
    const source = [
      'public abstract class Handler<T> : IHandler<T>',
      '{',
      '    Task IHandler<T>.Handle(T message)',
      '    {',
      '        return Task.CompletedTask;',
      '    }',
      '}',
      '',
    ].join('\n');

    expect(clean(source).output).toBe(source);
  });

  it('renames nothing next to a member the parser split into pieces, like a function pointer field', () => {
    const source = [
      'public unsafe class Native',
      '{',
      '    private delegate*<int, void> callback;',
      '    private int count;',
      '',
      '    public void Call() => callback(count);',
      '}',
      '',
    ].join('\n');

    expect(clean(source).output).toBe(source.replace(/\bcount\b/g, '_count'));
  });
});

describe('naming rules in the cleanup pipeline', () => {
  it('renames after the other cleanup steps, reporting with the file path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-naming-'));
    try {
      fs.writeFileSync(path.join(root, '.editorconfig'), template);
      const filePath = path.join(root, 'Sample.cs');
      const source = 'public class Sample\n{\n    int m_Count;\n    public int Get(int Offset) => m_Count + Offset;\n}\n';
      const issues: EditorConfigIssue[] = [];

      const output = runCleanup(source, filePath, createDefaultSettings(), undefined, (issue) => issues.push(issue));

      expect(output).toContain('    private int _count;\n');
      expect(output).toContain('public int Get(int Offset) => _count + Offset;');
      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe('unresolved');
      expect(issues[0].message.startsWith(`${filePath}: IDE1006 `)).toBe(true);
      expect(issues[0].message).toMatch(/parameter 'Offset' should be named 'offset'/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('naming rules', () => {
  it('orders rules by specificity, then by title', () => {
    const editorConfig = `[*.cs]
dotnet_naming_rule.a_all.symbols = all
dotnet_naming_rule.a_all.style = pascal
dotnet_naming_rule.a_all.severity = warning
dotnet_naming_rule.z_private_fields.symbols = private_fields
dotnet_naming_rule.z_private_fields.style = pascal
dotnet_naming_rule.z_private_fields.severity = warning
dotnet_naming_rule.m_const.symbols = consts
dotnet_naming_rule.m_const.style = pascal
dotnet_naming_rule.m_const.severity = warning
dotnet_naming_rule.incomplete.symbols = all
dotnet_naming_rule.incomplete.style = pascal
dotnet_naming_symbols.all.applicable_kinds = *
dotnet_naming_symbols.private_fields.applicable_kinds = field
dotnet_naming_symbols.private_fields.applicable_accessibilities = private
dotnet_naming_symbols.consts.applicable_kinds = field
dotnet_naming_symbols.consts.required_modifiers = const
dotnet_naming_style.pascal.capitalization = pascal_case
`;

    expect(parseNamingRules(props(editorConfig)).map((rule) => rule.title)).toEqual(['m_const', 'z_private_fields', 'a_all']);
  });
});

describe('naming style (Roslyn NamingStyle port)', () => {
  it('derives the name the Roslyn code fix offers', () => {
    const underscoreCamel = new NamingStyle('_', '', '', 'camel_case');
    const pascal = new NamingStyle('', '', '', 'pascal_case');
    const interfacePrefix = new NamingStyle('I', '', '', 'pascal_case');
    const upperSnake = new NamingStyle('', '', '_', 'all_upper');

    expect(underscoreCamel.makeCompliant('m_Count')).toBe('_count');
    expect(underscoreCamel.makeCompliant('Count')).toBe('_count');
    expect(underscoreCamel.makeCompliant('s_name')).toBe('_name');
    expect(pascal.makeCompliant('do_work')).toBe('Do_work');
    expect(pascal.makeCompliant('_value')).toBe('Value');
    expect(interfacePrefix.makeCompliant('repository')).toBe('IRepository');
    expect(interfacePrefix.makeCompliant('InputStream')).toBe('IInputStream');
    expect(upperSnake.makeCompliant('maxRetryCount')).toBe('MAX_RETRY_COUNT');
    expect(new NamingStyle('', 'Async', '', 'pascal_case').makeCompliant('loadAsy')).toBe('LoadAsync');
  });

  it('checks compliance like Roslyn', () => {
    const underscoreCamel = new NamingStyle('_', '', '', 'camel_case');
    const pascal = new NamingStyle('', '', '', 'pascal_case');

    expect(underscoreCamel.isCompliant('_count')).toBe(true);
    expect(underscoreCamel.isCompliant('_Count')).toBe(false);
    expect(underscoreCamel.isCompliant('_m_count')).toBe(false);
    expect(underscoreCamel.isCompliant('count')).toBe(false);
    expect(pascal.isCompliant('Do_work')).toBe(true);
    expect(pascal.isCompliant('doWork')).toBe(false);
    expect(new NamingStyle('', '', '_', 'all_upper').isCompliant('MAX_count')).toBe(false);
    expect(new NamingStyle('', '', '_', 'first_word_upper').isCompliant('Max_count')).toBe(true);
  });
});
