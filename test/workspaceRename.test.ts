import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planWorkspaceRenames, WorkspaceRenamePlan } from '../src/cleanup/naming/workspaceRenamer';
import { discoverProjects } from '../src/cleanup/naming/workspaceScope';
import { renameSymbolsAcrossWorkspace } from '../src/commands/workspaceRename';
import { resetMock, state, Uri, workspace as vscodeWorkspace, WorkspaceEdit } from './helpers/vscodeMock';

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
    read: (file) => fs.readFileSync(file, 'utf8'),
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

  it('refuses a rename when a file names the symbol in code the parser could not structure', () => {
    const root = workspace({
      'Lib/Lib.csproj': LIBRARY,
      'Lib/Order.cs': 'namespace Lib;\n\npublic class Order\n{\n    public static int count;\n}\n',
      'App/App.csproj': APP,
      'App/Program.cs': 'internal static class Program\n{\n    public static int R() => global::Lib.Order.count + Lib.Order.count;\n}\n',
    });

    expect(issues(plan(root))).toEqual([expect.stringMatching(/Program\.cs line 3 could not be fully parsed/)]);
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
        '    public int Local() { var made = new Lib.Order(); return made.count; }',
        '}',
        '',
      ].join('\n'),
    });

    const result = plan(root);

    expect(issues(result)).toEqual([]);
    expect(output(root, result, 'App/Program.cs')).toContain('new { count = o.Count, other = _order.Count }');
    expect(output(root, result, 'App/Program.cs')).toContain('return made.Count;');
  });

  it.each([
    ['a dynamic receiver', 'public static int Read(dynamic d) => d.count;', /'count' is accessed in .*Program\.cs line 3 through an expression whose type cannot be resolved syntactically/],
    ['a method call receiver', 'public static int Read() => Make().count;\n    private static Lib.Order Make() => new Lib.Order();', /'count' is accessed in .*Program\.cs line 3 through an expression whose type cannot be resolved syntactically/],
    ['a conditional access', 'public static int? Read(Lib.Order o) => o?.count;', /'count' is accessed in .*Program\.cs line 3 through a conditional access whose target cannot be resolved/],
    ['a target-typed initializer', 'public static Lib.Order Make() => new() { count = 1 };', /'count' is set in .*Program\.cs line 3 in a target-typed object initializer/],
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
});

describe('renameSymbolsAcrossWorkspace (command)', () => {
  beforeEach(() => {
    resetMock();
  });

  /** Mirrors the workspace's files into the mocked `workspace.fs` and runs the command on `targets`. */
  async function run(root: string, targets: string[]) {
    for (const [name, text] of Object.entries(walk(root))) {
      state.files.set(name, text);
    }

    state.workspaceFolders = [{ uri: Uri.file(root), name: 'w' }];
    state.modalChoice = 'Rename';
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
});
