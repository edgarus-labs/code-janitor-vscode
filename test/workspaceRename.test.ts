import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planWorkspaceRenames, WorkspaceRenamePlan } from '../src/cleanup/naming/workspaceRenamer';
import { discoverProjects } from '../src/cleanup/naming/workspaceScope';

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
});
