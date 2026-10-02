import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as editorconfig from '../src/cleanup/editorconfig';
import { planWorkspaceRenames, WorkspaceRenamePlan } from '../src/cleanup/naming/workspaceRenamer';
import { discoverProjects } from '../src/cleanup/naming/workspaceScope';
import { renameSymbolsAcrossWorkspace } from '../src/commands/workspaceRename';
import { resetMock, state, Uri, window as vscodeWindow, workspace as vscodeWorkspace, WorkspaceEdit } from './helpers/vscodeMock';

vi.mock('../src/cleanup/editorconfig', async (importOriginal) => {
  const actual = await importOriginal<typeof editorconfig>();

  return { ...actual, loadEditorConfigProperties: vi.fn(actual.loadEditorConfigProperties) };
});
const loadEditorConfigProperties = vi.mocked(editorconfig.loadEditorConfigProperties);

/** Public members and types PascalCase, as the generated .editorconfig requires. */
const EDITORCONFIG = [
  'root = true',
  '[*.cs]',
  'dotnet_naming_rule.types.symbols = types',
  'dotnet_naming_rule.types.style = pascal',
  'dotnet_naming_rule.types.severity = warning',
  'dotnet_naming_symbols.types.applicable_kinds = class, struct, enum, delegate, interface',
  'dotnet_naming_symbols.types.applicable_accessibilities = *',
  'dotnet_naming_rule.members.symbols = members',
  'dotnet_naming_rule.members.style = pascal',
  'dotnet_naming_rule.members.severity = warning',
  'dotnet_naming_symbols.members.applicable_kinds = property, method, field, event',
  'dotnet_naming_symbols.members.applicable_accessibilities = public, internal, protected, protected_internal',
  'dotnet_naming_style.pascal.capitalization = pascal_case',
  '',
].join('\n');

const LIBRARY = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
const APP = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A workspace folder with the given files (paths relative to it) and the naming .editorconfig. */
function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-workspace-rename-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }

  return root;
}

function plan(root: string, targets: string[] = ['Lib/Order.cs']): WorkspaceRenamePlan {
  return planWorkspaceRenames({
    projects: discoverProjects([root]),
    targets: targets.map((target) => path.join(root, target)),
    read: (file) => ({ text: fs.readFileSync(file, 'utf8'), utf8: true }),
  });
}

function output(root: string, result: WorkspaceRenamePlan, file: string): string | undefined {
  return result.contents.get(path.join(root, file));
}

function issues(result: WorkspaceRenamePlan): string[] {
  return result.issues.map((issue) => issue.detail);
}

describe('workspace-wide rename of non-private symbols (IDE1006)', () => {
  it('renames a public member in every file of its project and of the projects referencing it', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    /// <summary>See <see cref="getTotal"/>.</summary>',
        '    public int totalCount;',
        '',
        '    public int getTotal() => totalCount * 2;',
        '}',
        '',
      ].join('\n'),
      'Lib/Report.cs': 'namespace Lib;\n\ninternal static class Report\n{\n    public static int Sum(Order order) => order.getTotal() + order.totalCount;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'internal static class Program\n{\n    private static int Main() => new Lib.Order { totalCount = 2 }.getTotal();\n}\n',
      'Other/Other.csproj': LIBRARY,
      'Other/Unrelated.cs': 'namespace Other;\n\npublic class Unrelated\n{\n    public int Use(dynamic order) => order.getTotal();\n}\n',
    });

    const result = plan(root);

    expect(result.renames.map((rename) => `${rename.oldName} -> ${rename.newName}`).sort()).toEqual([
      'getTotal -> GetTotal',
      'totalCount -> TotalCount',
    ]);
    expect(output(root, result, 'Lib/Order.cs')).toContain('<see cref="GetTotal"/>');
    expect(output(root, result, 'Lib/Order.cs')).toContain('    public int GetTotal() => TotalCount * 2;');
    expect(output(root, result, 'Lib/Report.cs')).toContain('order.GetTotal() + order.TotalCount');
    expect(output(root, result, 'App/Program.cs')).toBe('internal static class Program\n{\n    private static int Main() => new Lib.Order { TotalCount = 2 }.GetTotal();\n}\n');
    // A project that does not reference Lib cannot use its symbols: it is not searched or changed.
    expect(output(root, result, 'Other/Unrelated.cs')).toBeUndefined();
    expect(issues(result)).toEqual([]);
  });

  it('keeps locals and parameters that share the old name', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    public int count;',
        '',
        '    public Order(int count) { this.count = count; }',
        '',
        '    public int Twice() { var count = this.count; return count * 2; }',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(output(root, result, 'Lib/Order.cs')).toBe(
      [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    public int Count;',
        '',
        '    public Order(int count) { this.Count = count; }',
        '',
        '    public int Twice() { var count = this.Count; return count * 2; }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('renames a public type, with its constructors and every use', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class orderLine\n{\n    public orderLine() { }\n    public static orderLine Create() => new orderLine();\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'using Lib;\n\ninternal static class Program\n{\n    private static string Main() => orderLine.Create() + nameof(orderLine) + typeof(Lib.orderLine);\n}\n',
    });

    const result = plan(root);

    expect(output(root, result, 'Lib/Order.cs')).toBe(
      'namespace Lib;\n\npublic class OrderLine\n{\n    public OrderLine() { }\n    public static OrderLine Create() => new OrderLine();\n}\n'
    );
    expect(output(root, result, 'App/Program.cs')).toBe(
      'using Lib;\n\ninternal static class Program\n{\n    private static string Main() => OrderLine.Create() + nameof(OrderLine) + typeof(Lib.OrderLine);\n}\n'
    );
  });

  it('renames a type named through a namespace qualifier, but refuses one accessed as a member of a value', () => {
    const qualified = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class orderLine\n{\n    public static orderLine Create() => new orderLine();\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'internal static class Program\n{\n    private static object Main() => Lib.orderLine.Create();\n}\n',
    });
    const value = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class orderLine\n{\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'internal static class Program\n{\n    private static object Read(dynamic d) => d.orderLine;\n}\n',
    });

    expect(output(qualified, plan(qualified), 'App/Program.cs')).toContain('Lib.OrderLine.Create()');
    expect(issues(plan(value))).toEqual([expect.stringMatching(/'orderLine' is accessed in .*Program\.cs line 3 through an expression whose type cannot be resolved syntactically/)]);
  });

  it('refuses a type or member accessed through a value chain, but follows a namespace and type chain', () => {
    const typeThroughValue = (body: string) =>
      workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Order.cs': 'namespace Lib;\n\npublic class orderLine\n{\n}\n',
        'App/App.csproj': APP,
        'App/Program.cs': `internal class Program\n{\n    public object Settings = new object();\n    public static Program GetX() => new Program();\n    ${body}\n}\n`,
      });
    const memberThroughValue = (body: string) =>
      workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public static int count;\n}\n',
        'App/App.csproj': APP,
        'App/Program.cs': `internal static class Program\n{\n    ${body}\n}\n`,
      });
    const refusal = /through an expression whose type cannot be resolved syntactically/;

    for (const body of [
      'public static object R(dynamic d) => d.Inner.orderLine;',
      'public object R() => this.Settings.orderLine;',
      'public object R() => GetX().Settings.orderLine;',
    ]) {
      expect(issues(plan(typeThroughValue(body))), body).toEqual([expect.stringMatching(refusal)]);
    }

    expect(issues(plan(memberThroughValue('public static object R(dynamic d) => d.Order.count;')))).toEqual([expect.stringMatching(refusal)]);

    const qualified = memberThroughValue('public static int R() => Lib.Order.count;');
    const result = plan(qualified);
    expect(issues(result)).toEqual([]);
    expect(output(qualified, result, 'App/Program.cs')).toContain('Lib.Order.Count;');
  });

  it('refuses a type accessed through a receiver root that is not shown to name a namespace or type', () => {
    const typeThrough = (files: Record<string, string>) =>
      workspace({ 'Lib/Lib.csproj': LIBRARY, 'Lib/Order.cs': 'namespace Lib;\n\npublic class orderLine\n{\n    public static int Create() => 1;\n}\n', 'App/App.csproj': APP, ...files });
    const refusal = /'orderLine' is accessed in .* through an expression whose type cannot be resolved syntactically/;
    const refused = [
      typeThrough({
        'App/B.cs': 'internal partial class P\n{\n    private dynamic data = null!;\n}\n',
        'App/P.cs': 'internal partial class P\n{\n    public object M() => data.orderLine;\n}\n',
      }),
      typeThrough({
        'App/B.cs': 'internal class B\n{\n    protected dynamic data = null!;\n}\n',
        'App/P.cs': 'internal class P : B\n{\n    public object M() => data.Inner.orderLine;\n}\n',
      }),
      typeThrough({ 'App/P.cs': 'internal class P\n{\n    public void M(object o)\n    {\n        if (o is dynamic x) { _ = x.orderLine; }\n    }\n}\n' }),
      typeThrough({ 'App/P.cs': 'internal class P\n{\n    public void M(object o)\n    {\n        switch (o) { case dynamic x: _ = x.orderLine; break; }\n    }\n}\n' }),
    ];
    for (const root of refused) {
      const result = plan(root);
      expect(result.renames).toEqual([]);
      expect(issues(result)).toEqual([expect.stringMatching(refusal)]);
    }

    const aliased = typeThrough({ 'App/P.cs': 'using L = Lib;\n\ninternal class P\n{\n    public int M() => L.orderLine.Create() + global::Lib.orderLine.Create();\n}\n' });
    const result = plan(aliased);
    expect(issues(result)).toEqual([]);
    expect(output(aliased, result, 'App/P.cs')).toContain('L.OrderLine.Create() + global::Lib.OrderLine.Create()');
  });

  it('renames an extension method of a workspace type called with extension syntax, but refuses a call on a dynamic receiver', () => {
    const extension = (use: string) =>
      workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Order.cs': [
          'namespace Lib;',
          '',
          'public sealed class Text\n{\n    public int Length;\n}',
          '',
          'public static class TextExt\n{\n    public static bool isBlank(this Text s) => s.Length == 0;\n}',
          '',
        ].join('\n'),
        'App/App.csproj': APP,
        'App/Program.cs': `using Lib;\n\ninternal static class Program\n{\n    public static Text Get() => new Text();\n    ${use}\n}\n`,
      });
    const root = extension('public static bool M(Text name) => name.isBlank() && Get().isBlank() && TextExt.isBlank(name);');
    const result = plan(root);
    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'App/Program.cs')).toContain('name.IsBlank() && Get().IsBlank() && TextExt.IsBlank(name);');

    for (const use of ['public static bool M(dynamic d) => d.isBlank();', 'public static bool M(object o) => ((dynamic)o).isBlank();']) {
      expect(issues(plan(extension(use))), use).toEqual([expect.stringMatching(/'isBlank' is accessed in .* through a dynamic receiver/)]);
    }
  });

  it.each([
    // `list.Contains(1)` would bind to List<int>.Contains, an instance method, and still compile.
    ['a type declared outside the workspace', 'public static bool contains(this System.Collections.Generic.List<int> list, int value) => false;', '', /extends List, which is declared outside the workspace/],
    ['a type parameter', 'public static bool contains<T>(this T item, int value) => false;', '', /extends T, which is declared outside the workspace/],
    [
      'a workspace type that a workspace type extends together with an outside type',
      'public static bool contains(this IBag bag, int value) => false;',
      'public interface IBag { }\n\npublic class Bag : System.Collections.Generic.List<int>, IBag { }',
      /Bag derives from or implements List, which is declared outside the workspace/,
    ],
    [
      'a workspace type constraining a type parameter',
      'public static bool contains(this IBag bag, int value) => false;',
      'public interface IBag { }\n\npublic static class Use\n{\n    public static bool Has<T>(T bag) where T : IBag, System.Collections.Generic.ICollection<int> { return bag.contains(1); }\n}',
      /a type parameter constrained to IBag in .*Order\.cs line \d+ may have other members/,
    ],
    ['an enum, with a name System.Enum declares', 'public static bool hasFlag(this Color color, Color flag) => false;', 'public enum Color { Red }', /'HasFlag' is a member every enum inherits from System\.Enum/],
  ])('refuses an extension method of %s, whose calls may bind to an instance member with the new name', (_label, method, types, reason) => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': `namespace Lib;\n\n${types}\n\npublic static class Ext\n{\n    ${method}\n}\n`,
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([expect.stringMatching(reason)]);
  });

  it('renames a member accessed through this.field, and through this in a type deriving from its declaring type', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    public int count;',
        '}',
        '',
        'public class Special : Order',
        '{',
        '    public int M() => this.count + count;',
        '}',
        '',
        'public class Holder',
        '{',
        '    private readonly Order order = new Order();',
        '    public int M() => this.order.count;',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    const text = output(root, result, 'Lib/Order.cs');
    expect(text).toContain('this.Count + Count;');
    expect(text).toContain('this.order.Count;');
  });

  it('evaluates packability in MSBuild order: a project opting out overrides its Directory.Build.props', () => {
    const optedOut = workspace({
      'Directory.Build.props': '<Project><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup></Project>',
      'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>',
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });
    const commented = workspace({
      'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><!-- <PackageId>Contoso.Lib</PackageId> --></Project>',
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });
    const conditional = workspace({
      'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup Condition="\'$(Configuration)\' == \'Release\'"><GeneratePackageOnBuild>true</GeneratePackageOnBuild></PropertyGroup></Project>',
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });

    expect(issues(plan(optedOut))).toEqual([]);
    expect(issues(plan(commented))).toEqual([]);
    expect(issues(plan(conditional))).toEqual([expect.stringMatching(/because the project builds a NuGet package/)]);
  });

  it('refuses a rename when a file names the symbol in code the parser could not structure', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public static int count;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'internal static class Program\n{\n    public static int R() => Lib.Order..count;\n}\n',
    });

    expect(issues(plan(root))).toEqual([expect.stringMatching(/field 'count' .* because .*Program\.cs line 3 could not be fully parsed/)]);
  });

  it('renames a member of a generic type accessed through a typed parameter or field', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Box<T>\n{\n    public int total;\n}\n\npublic class Item\n{\n}\n',
      'Lib/Use.cs': [
        'namespace Lib;',
        '',
        'internal class Use',
        '{',
        '    private Lib.Box<Lib.Item>? held = new();',
        '    public int M(Box<int> b) => b.total + held.total;',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'Lib/Use.cs')).toContain('b.Total + held.Total');
  });

  it('renames a member cref qualified with global::', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    /// <see cref="global::Lib.Order.count"/> <see cref="Lib.Order.count"/>\n    public int count;\n}\n',
    });

    const result = plan(root);

    expect(output(root, result, 'Lib/Order.cs')).toContain('<see cref="global::Lib.Order.Count"/> <see cref="Lib.Order.Count"/>');
  });

  it('follows project references declared in a Directory.Build.props', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int total;\n}\n',
      'tests/Directory.Build.props': '<Project><ItemGroup><ProjectReference Include="$(MSBuildThisFileDirectory)../Lib/Lib.csproj" /></ItemGroup></Project>',
      'tests/T/T.csproj': LIBRARY,
      'tests/T/Use.cs': 'internal static class Use\n{\n    public static int M(Lib.Order o) => o.total;\n}\n',
    });

    const result = plan(root);

    expect(discoverProjects([root]).find((project) => project.projectFile.endsWith('T.csproj'))?.references).toEqual([path.join(root, 'Lib', 'Lib.csproj')]);
    expect(output(root, result, 'tests/T/Use.cs')).toContain('o.Total');
  });

  it('renames members of several types sharing a name when they all get the same new name', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int id;\n}\n\npublic class Customer\n{\n    public int id;\n}\n',
      'Lib/Use.cs': 'namespace Lib;\n\ninternal static class Use\n{\n    public static int Both(Order o, Customer c) => o.id + c.id;\n}\n',
    });

    const result = plan(root);

    expect(output(root, result, 'Lib/Use.cs')).toContain('o.Id + c.Id');
    expect(output(root, result, 'Lib/Order.cs')).toBe('namespace Lib;\n\npublic class Order\n{\n    public int Id;\n}\n\npublic class Customer\n{\n    public int Id;\n}\n');
  });

  it('refuses names that appear as text: in strings, and in XAML, Razor or JSON files of the project', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    public int getTotal() => 1;',
        '    public string displayName = "";',
        '    public object Find() => typeof(Order).GetMethod("getTotal");',
        '}',
        '',
      ].join('\n'),
      'Lib/settings.json': '{ "displayName": "x" }',
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([
      expect.stringMatching(/^IDE1006 .*method 'getTotal' should be named 'GetTotal'; not renamed across the workspace because the name appears in a string in .*Order\.cs line 7/),
      expect.stringMatching(/field 'displayName' should be named 'DisplayName'; not renamed across the workspace because the name appears in .*settings\.json/),
    ]);
  });

  it('refuses the public API of a NuGet package, but renames its internal symbols', () => {
    const root = workspace({
      'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><PackageId>Contoso.Lib</PackageId></PropertyGroup></Project>',
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int getTotal() => 1;\n    internal int getCount() => getTotal();\n}\n',
    });

    const result = plan(root);

    expect(output(root, result, 'Lib/Order.cs')).toBe('namespace Lib;\n\npublic class Order\n{\n    public int getTotal() => 1;\n    internal int GetCount() => getTotal();\n}\n');
    expect(issues(result)).toEqual([expect.stringMatching(/method 'getTotal' .* because the project builds a NuGet package, whose public API code outside the workspace may use/)]);
  });

  it('refuses internal symbols of an assembly with InternalsVisibleTo', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': '[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Tests")]\nnamespace Lib;\n\ninternal class Order\n{\n    internal int getCount() => 1;\n}\n',
    });

    expect(issues(plan(root))).toEqual([expect.stringMatching(/method 'getCount' .* because the assembly exposes its internals \(InternalsVisibleTo\)/)]);
  });

  it('renames overloads together, and refuses virtual members and members of types with bases declared elsewhere', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        '    public int calc() => 1;',
        '    public int calc(int x) => x;',
        '    public virtual int size() => 1;',
        '}',
        '',
        'public class Items : System.Collections.Generic.List<int>',
        '{',
        '    public int first() => this[0];',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);
    const refused = issues(result);

    expect(output(root, result, 'Lib/Order.cs')).toContain('    public int Calc() => 1;\n    public int Calc(int x) => x;');
    expect(refused).toEqual([
      expect.stringMatching(/method 'size' .* because it is virtual/),
      expect.stringMatching(/method 'first' .* because Items derives from or implements List, which is declared outside the workspace/),
    ]);
  });

  it('refuses a new name already used in the searched projects', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int total;\n}\n',
      'Lib/Other.cs': 'namespace Lib;\n\npublic class Other\n{\n    public int Total { get; set; }\n}\n',
    });

    expect(issues(plan(root))).toEqual([expect.stringMatching(/field 'total' .* because 'Total' is already declared in .*Other\.cs/)]);
  });

  it('refuses old and new names declared in the projects the searched projects depend on', () => {
    const root = workspace({
      'Core/Core.csproj': LIBRARY,
      'Core/Order.cs': 'namespace Core;\n\npublic class Order\n{\n    public int count;\n}\n\npublic class Base\n{\n    protected int size;\n}\n\npublic class OrderLine\n{\n}\n',
      'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Core/Core.csproj" /></ItemGroup></Project>',
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n    public int size;\n}\n\npublic class orderLine\n{\n}\n',
      'Lib/Widget.cs': 'namespace Lib;\n\ninternal class Widget : Core.Base\n{\n    public int Get() => size;\n}\n',
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Core/Core.csproj" /><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>',
      'App/Program.cs': 'using Core;\nusing Lib;\n\ninternal static class Program\n{\n    private static int Main() => new Core.Order().count + new Lib.Order().count;\n}\n',
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([
      expect.stringMatching(/field 'count' .* because 'count' is also declared in .*Core.Order\.cs line 5, in a project the searched projects reference/),
      expect.stringMatching(/field 'size' .* because 'size' is also declared in .*Core.Order\.cs line 10, in a project the searched projects reference/),
      expect.stringMatching(/class 'orderLine' .* because 'OrderLine' is already declared in .*Core.Order\.cs line 13, in a project the searched projects reference/),
    ]);
  });

  it('refuses a new name that members of object or accesses on the declaring type already use, but not accesses on other types', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public string toString() => "custom";\n    public int total;\n    public int count;\n}\n',
      'Lib/Use.cs': [
        'namespace Lib;',
        '',
        'internal static class Use',
        '{',
        '    public static string Show(Order o) => o.ToString() + o.toString();',
        '    public static int Sum(Order o) => o.total + o.Total();',
        '    public static int Size(System.Collections.Generic.List<int> list, Order o) => list.Count + o.count;',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(result.renames.map((rename) => rename.newName)).toEqual(['Count']);
    expect(output(root, result, 'Lib/Use.cs')).toContain('list.Count + o.Count;');
    expect(issues(result)).toEqual([
      expect.stringMatching(/method 'toString' .* because 'ToString' is a member every type inherits from System\.Object/),
      expect.stringMatching(/field 'total' .* because 'Total' is already used in .*Use\.cs line 6/),
    ]);
  });

  it('only renames what the target files declare', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int Get() => new Other().total;\n}\n',
      'Lib/Other.cs': 'namespace Lib;\n\npublic class Other\n{\n    public int total;\n}\n',
    });

    expect(plan(root).renames).toEqual([]);
    expect(plan(root, ['Lib/Other.cs']).renames.map((rename) => rename.newName)).toEqual(['Total']);
  });

  it('keeps the members of anonymous types, and renames accesses through receivers typed with the declaring type', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': [
        'internal sealed class Program',
        '{',
        '    private readonly Lib.Order _order = new Lib.Order();',
        '',
        '    public object Project(Lib.Order o) => new { count = o.count, other = _order.count };',
        '',
        '    public Lib.Order Copy(Lib.Order o) => o with { count = 2 };',
        '',
        '    public int Local() { var made = new Lib.Order(); return made.count; }',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'App/Program.cs')).toContain('new { count = o.Count, other = _order.Count }');
    expect(output(root, result, 'App/Program.cs')).toContain('return made.Count;');
    expect(output(root, result, 'App/Program.cs')).toContain('o with { Count = 2 }');
  });

  it.each([
    ['a dynamic receiver', 'public static int Read(dynamic d) => d.count;', /'count' is accessed in .*Program\.cs line 3 through an expression whose type cannot be resolved syntactically/],
    ['a method call receiver', 'public static int Read() => Make().count;\n    private static Lib.Order Make() => new Lib.Order();', /'count' is accessed in .*Program\.cs line 3 through an expression whose type cannot be resolved syntactically/],
    ['a conditional access', 'public static int? Read(Lib.Order o) => o?.count;', /'count' is accessed in .*Program\.cs line 3 through a conditional access whose target cannot be resolved/],
    ['a target-typed initializer', 'public static Lib.Order Make() => new() { count = 1 };', /'count' is set in .*Program\.cs line 3 in a target-typed object initializer/],
    [
      'a with expression on a method call',
      'public static Lib.Order Copy() => Make() with { count = 1 };\n    private static Lib.Order Make() => new Lib.Order();',
      /'count' is set in .*Program\.cs line 3 by a 'with' expression through an expression whose type cannot be resolved syntactically/,
    ],
    [
      'a with expression on an anonymous value',
      'public static object Copy(Lib.Order o) { var a = new { count = o.count }; return a with { count = 2 }; }',
      /'count' is set in .*Program\.cs line 3 by a 'with' expression through an expression whose type cannot be resolved syntactically/,
    ],
  ])('refuses a member renamed through %s', (_label, member, reason) => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': `internal static class Program\n{\n    ${member}\n}\n`,
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([expect.stringMatching(reason)]);
  });

  it('refuses a new name that is a contextual keyword, such as the implicit setter parameter value', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int Value;\n    public int Size { get => Value; set { Value = 0; } }\n}\n',
    });
    fs.writeFileSync(
      path.join(root, '.editorconfig'),
      [
        'root = true',
        '[*.cs]',
        'dotnet_naming_rule.fields.symbols = fields',
        'dotnet_naming_rule.fields.style = camel',
        'dotnet_naming_rule.fields.severity = warning',
        'dotnet_naming_symbols.fields.applicable_kinds = field',
        'dotnet_naming_symbols.fields.applicable_accessibilities = public',
        'dotnet_naming_style.camel.capitalization = camel_case',
        '',
      ].join('\n')
    );

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([expect.stringMatching(/field 'Value' should be named 'value'; not renamed across the workspace because 'value' is a C# contextual keyword/)]);
  });

  it('follows project references written with single quotes or MSBuild directory properties', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include=\'$(MSBuildThisFileDirectory)..\\Lib\\Lib.csproj\' /></ItemGroup></Project>',
      'App/Program.cs': 'internal static class Program\n{\n    public static int Use(Lib.Order o) => o.count;\n}\n',
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'App/Program.cs')).toContain('o.Count');
  });

  it('refuses when a project whose reference cannot be resolved uses the old name', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="$(LibRoot)\\Lib.csproj" /></ItemGroup></Project>',
      'App/Program.cs': 'internal static class Program\n{\n    public static int Use(Lib.Order o) => o.count;\n}\n',
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([
      expect.stringMatching(/field 'count' .* because .*App\.csproj references \$\(LibRoot\)\\Lib\.csproj, which cleanup cannot resolve, and its files use 'count'/),
    ]);
  });

  it('reads packability and InternalsVisibleTo from Directory.Build.props and Directory.Build.targets', () => {
    const packable = workspace({
      'Directory.Build.props': '<Project><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup></Project>',
      'src/Lib/Lib.csproj': LIBRARY,
      'src/Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });
    const internals = workspace({
      'src/Directory.Build.targets': '<Project><ItemGroup><InternalsVisibleTo Include="Lib.Tests" /></ItemGroup></Project>',
      'src/Lib/Lib.csproj': LIBRARY,
      'src/Lib/Order.cs': 'namespace Lib;\n\ninternal class Order\n{\n    internal int count;\n}\n',
    });

    expect(issues(plan(packable, ['src/Lib/Order.cs']))).toEqual([expect.stringMatching(/field 'count' .* because the project builds a NuGet package/)]);
    expect(issues(plan(internals, ['src/Lib/Order.cs']))).toEqual([expect.stringMatching(/field 'count' .* because the assembly exposes its internals \(InternalsVisibleTo\)/)]);
  });

  it('refuses a project whose Directory.Build.props adds C# files from elsewhere', () => {
    const root = workspace({
      'Directory.Build.props': '<Project><ItemGroup><Compile Include="../Shared/*.cs" /></ItemGroup></Project>',
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });

    expect(issues(plan(root))).toEqual([expect.stringMatching(/field 'count' .* because .*Directory\.Build\.props adds C# files from outside the project folder/)]);
  });

  it('refuses a rename when an F# or Visual Basic project references the declaring project', () => {
    for (const [project, file] of [['Fs/Fs.fsproj', 'Fs/Program.fs'], ['Vb/Vb.vbproj', 'Vb/Program.vb']]) {
      const root = workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
        [project]: APP,
        [file]: 'let read (o: Lib.Order) = o.count\n',
      });

      const result = plan(root);

      expect(result.renames).toEqual([]);
      expect(issues(result)).toEqual([expect.stringMatching(new RegExp(`field 'count' .* because .*${path.basename(project).replace('.', '\\.')} is not a C# project, whose uses of C# symbols cleanup cannot follow`))]);
    }
  });

  it('refuses a rename in a project holding symbolic links to C# files or folders', () => {
    for (const link of ['folder', 'file']) {
      const root = workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
        'Shared/Use.cs': 'namespace Lib;\n\ninternal static class Use\n{\n    public static int M(Order o) => o.count;\n}\n',
      });
      const target = link === 'folder' ? path.join(root, 'Shared') : path.join(root, 'Shared', 'Use.cs');
      fs.symlinkSync(target, path.join(root, 'Lib', link === 'folder' ? 'Shared' : 'Use.cs'), link === 'folder' ? 'dir' : 'file');

      const result = plan(root);

      expect(result.renames).toEqual([]);
      expect(issues(result)).toEqual([expect.stringMatching(/field 'count' .* because .* is a symbolic link, which cleanup does not follow/)]);
    }
  });

  it('only rewrites crefs that may name a renamed declaration, in either quote style', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': [
        'namespace Lib;',
        '',
        'public class Order',
        '{',
        "    /// <summary>Like <see cref='Order.count'/>, <see cref=\"count\"/> and <see cref=\"T:Lib.Order\"/>, not <see cref=\"External.count\"/>.</summary>",
        '    public int count;',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'Lib/Order.cs')).toContain(
      "    /// <summary>Like <see cref='Order.Count'/>, <see cref=\"Count\"/> and <see cref=\"T:Lib.Order\"/>, not <see cref=\"External.count\"/>.</summary>"
    );
  });

  it('refuses a simple name inside a type whose bases outside the workspace may declare it', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public bool enabled;\n}\n',
      'Lib/Comp.cs': 'namespace Lib;\n\npublic class Comp : UnityEngine.MonoBehaviour\n{\n    private void Start() { enabled = false; }\n}\n',
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(output(root, result, 'Lib/Comp.cs')).toBeUndefined();
    expect(issues(result)).toEqual([expect.stringMatching(/field 'enabled' should be named 'Enabled'; not renamed across the workspace because .*Comp\.cs line 5 is in Comp, whose base MonoBehaviour is declared outside the workspace and may declare 'enabled'/)]);
  });

  it('refuses an unqualified cref or a type name inside a type whose bases outside the workspace may declare it', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public bool enabled;\n}\n\npublic class line { }\n',
      'Lib/Comp.cs': [
        'namespace Lib;',
        '',
        'public class Comp : External.Base',
        '{',
        '    /// <summary>See <see cref="enabled"/>.</summary>',
        '    public int Value;',
        '    public object Make() => new line();',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([
      expect.stringMatching(/field 'enabled' should be named 'Enabled'; .*Comp\.cs line 5 is in Comp, whose base Base is declared outside the workspace/),
      expect.stringMatching(/class 'line' should be named 'Line'; .*Comp\.cs line 7 is in Comp, whose base Base is declared outside the workspace/),
    ]);
  });

  it('still renames a simple name in a type deriving from the declaring type or with every base in the workspace', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order : Entity\n{\n    public bool enabled;\n}\n\npublic class Entity { }\n',
      'Lib/Special.cs': 'namespace Lib;\n\npublic class Special : Order\n{\n    public void Off() { enabled = false; }\n    private sealed class Inner : Entity { private bool On() => new Order().enabled; }\n}\n',
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'Lib/Special.cs')).toContain('public void Off() { Enabled = false; }');
  });

  it('renames a simple name a using static of the declaring type imports, but refuses one outside any type declaring or inheriting it', () => {
    const files = (directive: string) =>
      workspace({
        'Lib/Lib.csproj': LIBRARY,
        'Lib/Defaults.cs': 'namespace Lib;\n\npublic static class Defaults\n{\n    public const int timeout = 30;\n}\n',
        'App/App.csproj': APP,
        'App/Client.cs': `${directive}\n\ninternal class Client\n{\n    public int T() => timeout;\n}\n`,
      });

    const imported = files('using static Lib.Defaults;');
    const importedResult = plan(imported, ['Lib/Defaults.cs']);
    expect(issues(importedResult)).toEqual([]);
    expect(output(imported, importedResult, 'App/Client.cs')).toContain('public int T() => Timeout;');

    const vendor = files('using static Vendor.Consts;');
    const vendorResult = plan(vendor, ['Lib/Defaults.cs']);
    expect(vendorResult.renames).toEqual([]);
    expect(issues(vendorResult)).toEqual([expect.stringMatching(/field 'timeout' should be named 'Timeout'; .*Client\.cs line 5 is in Client, which neither declares nor inherits 'timeout'/)]);
  });

  it.each([
    ['an anonymous-type property', 'public static int M() { var a = new { count = 1 }; return a.count; }'],
    ['a tuple element', 'public static int M() { var t = (count: 1, size: 2); return t.count; }'],
    ['a member of a type outside the workspace', 'public static int M(Vendor.Basket basket) => basket.count();'],
  ])('refuses an extension method rename where a member access may be %s', (_label, use) => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic sealed class Order { }\n\npublic static class OrderExt\n{\n    public static int count(this Order o) => 0;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': `using Lib;\n\ninternal static class Program\n{\n    ${use}\n}\n`,
    });

    const result = plan(root);

    expect(result.renames).toEqual([]);
    expect(issues(result)).toEqual([expect.stringMatching(/method 'count' should be named 'Count'; not renamed across the workspace because .*Program\.cs line 5/)]);
  });

  it('loads the naming rules and violations of each file once per plan, whatever the number of renames', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int alpha;\n    public int beta;\n    public int gamma;\n}\n',
      'Lib/Use.cs': 'namespace Lib;\n\ninternal static class Use\n{\n    public static int Sum(Order o) => o.alpha + o.beta + o.gamma;\n}\n',
    });
    loadEditorConfigProperties.mockClear();

    const result = plan(root);

    expect(result.renames).toHaveLength(3);
    const loaded = loadEditorConfigProperties.mock.calls.map(([filePath]) => path.relative(root, filePath));
    expect(loaded.sort()).toEqual([path.join('Lib', 'Order.cs'), path.join('Lib', 'Use.cs')]);
  });
});

describe('renameSymbolsAcrossWorkspace (command)', () => {
  beforeEach(() => {
    resetMock();
  });

  /** Mirrors the workspace's files into the mocked `workspace.fs` and runs the command on `targets`. */
  async function run(root: string, targets: string[], cancel = false) {
    for (const [name, text] of Object.entries(walk(root))) {
      state.files.set(name, text);
    }

    state.workspaceFolders = [{ uri: Uri.file(root), name: 'w' }];
    state.modalChoice = cancel ? undefined : 'Rename';
    const applied: WorkspaceEdit[] = [];
    const applyEdit = vscodeWorkspace.applyEdit.bind(vscodeWorkspace);
    vi.spyOn(vscodeWorkspace, 'applyEdit').mockImplementation((edit: WorkspaceEdit) => {
      applied.push(edit);

      return applyEdit(edit);
    });
    const reported: string[] = [];
    await renameSymbolsAcrossWorkspace(
      targets.map((target) => Uri.file(path.join(root, target))) as never,
      (issue) => reported.push(issue.detail),
      new Map()
    );
    vi.restoreAllMocks();

    return { applied, reported };
  }

  function walk(directory: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        Object.assign(result, walk(full));
      } else {
        result[full] = fs.readFileSync(full, 'utf8');
      }
    }

    return result;
  }

  it('reports the violations of a target outside every project and still renames the others', async () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'Scripts/app.cs': 'public class Tool\n{\n    public int size;\n}\n',
    });

    const { reported } = await run(root, ['Lib/Order.cs', 'Scripts/app.cs']);

    expect(reported).toEqual([expect.stringMatching(/field 'size' should be named 'Size'; not renamed across the workspace because the file is not in a C# project of the workspace/)]);
    expect(state.files.get(path.join(root, 'Lib/Order.cs'))).toContain('public int Count;');
  });

  it('does not insert a byte order mark into the text of a closed file it edits', async () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': '\uFEFFnamespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });

    const { applied } = await run(root, ['Lib/Order.cs']);
    const texts = applied.flatMap((edit) => [...edit.edits.values()].flat().map((recorded) => recorded.text));

    expect(texts).toEqual(['namespace Lib;\n\npublic class Order\n{\n    public int Count;\n}\n']);
  });

  it('refuses a rename that would rewrite a file that is not UTF-8 text', async () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
    });
    const legacy = path.join(root, 'Lib', 'Legacy.cs');
    // Windows-1252: `ö` is the single byte 0xF6, which is not valid UTF-8.
    const bytes = Buffer.concat([Buffer.from('namespace Lib;\n\n// Gr'), Buffer.from([0xf6]), Buffer.from('\u00dfe\ninternal static class Legacy\n{\n    public static int M(Order o) => o.count;\n}\n', 'latin1')]);
    fs.writeFileSync(legacy, bytes);
    // VS Code reads the bytes as they are on disk.
    vi.spyOn(vscodeWorkspace.fs, 'readFile').mockImplementation((uri: Uri) => Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath))));

    const { applied, reported } = await run(root, ['Lib/Order.cs']);

    expect(applied).toEqual([]);
    expect(reported).toEqual([expect.stringMatching(/field 'count' should be named 'Count'; not renamed across the workspace because .*Legacy\.cs is not UTF-8 text, which the rename cannot rewrite safely/)]);
    expect(fs.readFileSync(legacy)).toEqual(bytes);
  });

  it('applies nothing when a file it rewrites changed while the confirmation was open', async () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int count;\n}\n',
      'Lib/Report.cs': 'namespace Lib;\n\ninternal static class Report\n{\n    public static int Sum(Order o) => o.count;\n}\n',
    });
    const report = path.join(root, 'Lib', 'Report.cs');
    const changed = 'namespace Lib;\n\ninternal static class Report\n{\n    public static int Sum(Order o) => o.count + 1;\n}\n';
    // Another tool rewrites a closed file on disk while the modal dialog is open.
    vi.spyOn(vscodeWindow, 'showWarningMessage').mockImplementation(() => {
      state.files.set(report, changed);

      return Promise.resolve('Rename' as never);
    });

    const { applied, reported } = await run(root, ['Lib/Order.cs']);

    expect(applied).toEqual([]);
    expect(state.files.get(report)).toBe(changed);
    expect(reported).toEqual([expect.stringMatching(/line 5: field 'count' should be named 'Count'; not renamed because .*Report\.cs changed since the rename was planned; run cleanup again\./)]);
  });

  it('reports every declaration of a rename group when the rename is cancelled', async () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public int calc() => 1;\n    public int calc(int x) => x;\n}\n',
    });

    const { applied, reported } = await run(root, ['Lib/Order.cs'], true);

    expect(applied).toEqual([]);
    expect(reported).toEqual([
      expect.stringMatching(/line 5: method 'calc' should be named 'Calc'; the workspace-wide rename was cancelled/),
      expect.stringMatching(/line 6: method 'calc' should be named 'Calc'; the workspace-wide rename was cancelled/),
    ]);
  });
});
