import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newCompilerErrors } from '../scripts/compileOracle';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigNamingConverter } from '../src/cleanup/transformations/editorConfigNaming';
import { buildProject, dotnetAvailable, formatErrors, writeProject } from './helpers/dotnetBuild';

/**
 * Renamer scenarios on real C# files. Each scenario has one naming violation and, usually, a trap
 * that makes the rename unsafe. The rename must be all or nothing, a refusal must be reported, and
 * the compiled program must print the same value before and after cleanup (a rename that still
 * compiles but changes behavior, for example through `nameof`, fails here).
 */
type Expectation = 'renamed' | 'kept' | 'either';

interface Scenario {
  readonly name: string;
  readonly cls: string;
  readonly code: string;
  /** Old name and the name the naming rule gives it. */
  readonly pairs: readonly (readonly [string, string])[];
  readonly expect: Expectation;
  readonly config?: 'camel' | 'pascal';
  readonly mustContain?: readonly string[];
  /** Text the reported reason must contain. */
  readonly mustIssue?: string;
}

const RULES = (localStyle: string): string => `
root = true

[*.cs]
dotnet_naming_rule.private_fields.severity = warning
dotnet_naming_rule.private_fields.symbols = private_fields
dotnet_naming_rule.private_fields.style = camel_case_underscore

dotnet_naming_rule.private_members.severity = warning
dotnet_naming_rule.private_members.symbols = private_members
dotnet_naming_rule.private_members.style = pascal_case

dotnet_naming_rule.type_parameters.severity = warning
dotnet_naming_rule.type_parameters.symbols = type_parameters
dotnet_naming_rule.type_parameters.style = begins_with_t

dotnet_naming_rule.locals.severity = warning
dotnet_naming_rule.locals.symbols = locals_and_parameters
dotnet_naming_rule.locals.style = ${localStyle}

dotnet_naming_symbols.private_fields.applicable_kinds = field
dotnet_naming_symbols.private_fields.applicable_accessibilities = private, protected, private_protected

dotnet_naming_symbols.private_members.applicable_kinds = property, event, method
dotnet_naming_symbols.private_members.applicable_accessibilities = private

dotnet_naming_symbols.locals_and_parameters.applicable_kinds = parameter, local, local_function
dotnet_naming_symbols.locals_and_parameters.applicable_accessibilities = *

dotnet_naming_symbols.type_parameters.applicable_kinds = type_parameter
dotnet_naming_symbols.type_parameters.applicable_accessibilities = *

dotnet_naming_style.begins_with_t.required_prefix = T
dotnet_naming_style.begins_with_t.capitalization = pascal_case

dotnet_naming_style.camel_case_underscore.required_prefix = _
dotnet_naming_style.camel_case_underscore.capitalization = camel_case

dotnet_naming_style.pascal_case.capitalization = pascal_case

dotnet_naming_style.camel_case.capitalization = camel_case
`;

const CONFIGS = { camel: RULES('camel_case'), pascal: RULES('pascal_case') };

const scenarios: Scenario[] = [
  {
    name: 'a private field used with this., plainly and in an interpolation',
    cls: 'S1',
    code: 'public class S1 { private int Count; public static int Run() { S1 s = new S1(); s.Inc(); s.Inc(); return s.Get() + $"{s.Count}".Length; } private void Inc() { this.Count++; Count += 1; } private int Get() => Count; }',
    pairs: [['Count', '_count']],
    expect: 'renamed',
  },
  {
    name: 'a field read through a var whose type is not written is not renamed, and says why',
    cls: 'S1b',
    code: 'public class S1b { private int Count = 2; public static int Run() { var s = new S1b(); return s.Count; } }',
    pairs: [['Count', '_count']],
    expect: 'kept',
    mustIssue: 'cannot be resolved syntactically',
  },
  {
    name: 'a local captured by a closure',
    cls: 'S2',
    code: 'public class S2 { public static int Run() { int Total = 0; System.Action add = () => Total += 2; add(); add(); return Total; } }',
    pairs: [['Total', 'total']],
    expect: 'renamed',
  },
  {
    name: 'a parameter whose name is used as a named argument of a resolvable call',
    cls: 'S3',
    code: 'public class S3 { public static int Run() => Calc(Value: 4, other: 1); private static int Calc(int Value, int other) => Value * 2 + other; }',
    pairs: [['Value', 'value']],
    expect: 'renamed',
  },
  {
    name: 'overloads are renamed together',
    cls: 'S4',
    code: 'public class S4 { public static int Run() => doIt(1) + doIt("ab"); private static int doIt(int a) => a; private static int doIt(string s) => s.Length; }',
    pairs: [['doIt', 'DoIt']],
    expect: 'renamed',
  },
  {
    name: 'a field whose new name is already taken',
    cls: 'S6',
    code: 'public class S6 { private int Count = 1; private int _count = 2; public static int Run() { var s = new S6(); return s.Count * 10 + s._count; } }',
    pairs: [['Count', '_count']],
    expect: 'kept',
  },
  {
    name: 'a nested local whose new name is declared in the enclosing scope',
    cls: 'S7',
    code: 'public class S7 { public static int Run() { int value = 1; { int Value = 2; value += Value; } return value; } }',
    pairs: [['Value', 'value']],
    expect: 'kept',
  },
  {
    name: 'a private field read by a nested type',
    cls: 'S8',
    code: 'public class S8 { private int Count = 3; private class Inner { public int Read(S8 o) => o.Count; } public static int Run() => new Inner().Read(new S8()); }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a field assigned through an object initializer and a member access',
    cls: 'S9',
    code: 'public class S9 { public int Box { get; set; } private int Count; public static int Run() { var x = new S9 { Box = 2 }; x.Count = 5; return x.Box + x.Count; } }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a local whose name is also an inferred tuple element name',
    cls: 'S10',
    code: 'public class S10 { public static int Run() { int Total = 2; var t = (Total, 3); return t.Total + Total + t.Item2; } }',
    pairs: [['Total', 'total']],
    expect: 'kept',
  },
  {
    name: 'a constructor parameter named in a target-typed new',
    cls: 'S11',
    code: 'public class S11 { private readonly int _v; private S11(int Value) { _v = Value; } public static int Run() { S11 s = new(Value: 4); return s._v; } }',
    pairs: [['Value', 'value']],
    expect: 'kept',
  },
  {
    name: 'a field reached through a conditional access',
    cls: 'S12',
    code: 'public class S12 { private string Name = "ab"; public static int Run() { S12? s = new S12(); return s?.Name.Length ?? 0; } }',
    pairs: [['Name', '_name']],
    expect: 'either',
  },
  {
    name: 'pattern, out, foreach, for, catch and deconstruction variables',
    cls: 'S13',
    code:
      'public class S13 { public static int Run() { object o = 5; int sum = 0; if (o is int Num) sum += Num; int.TryParse("7", out var Parsed); sum += Parsed; ' +
      'foreach (var Item in new[] { 1, 2 }) sum += Item; for (int Idx = 0; Idx < 2; Idx++) sum += Idx; ' +
      'try { throw new System.Exception("x"); } catch (System.Exception Ex) { sum += Ex.Message.Length; } var (First, Second) = (1, 2); sum += First + Second; return sum; } }',
    pairs: [['Num', 'num'], ['Parsed', 'parsed'], ['Item', 'item'], ['Idx', 'idx'], ['Ex', 'ex'], ['First', 'first'], ['Second', 'second']],
    expect: 'either',
  },
  {
    name: 'lambda parameters and a local function',
    cls: 'S14',
    code: 'public class S14 { public static int Run() { System.Func<int, int> f = X => X * 2; int Local(int Y) => Y + 1; return f(2) + Local(3); } }',
    pairs: [['X', 'x'], ['Y', 'y'], ['Local', 'local']],
    expect: 'either',
  },
  {
    name: 'a constructor parameter that shadows the assigned field',
    cls: 'S15',
    code: 'public class S15 { private int _x; private S15(int X) { _x = X; } public static int Run() => new S15(3)._x; }',
    pairs: [['X', 'x']],
    expect: 'renamed',
  },
  {
    name: 'a static field accessed through its type and plainly',
    cls: 'S24',
    code: 'public class S24 { private static int Count = 2; public static int Run() => S24.Count + Count; }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a field read through another instance',
    cls: 'S25',
    code: 'public class S25 { private int Count = 1; private bool Same(S25 o) => o.Count == Count; public static int Run() => new S25().Same(new S25()) ? 1 : 0; }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a protected field read by a derived type',
    cls: 'S26',
    code: 'public class S26 { protected int Count = 2; public static int Run() => new D().Get(); private class D : S26 { public int Get() => Count; } }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a method renamed to the name of its containing type',
    cls: 'DoIt',
    code: 'public class DoIt { public static int Run() => doIt(); private static int doIt() => 1; }',
    pairs: [['doIt', 'DoIt']],
    expect: 'kept',
  },
  {
    name: 'a using declaration local',
    cls: 'S30',
    code: 'public class S30 { public static int Run() { using var Sw = new System.IO.StringWriter(); Sw.Write("abc"); return Sw.ToString().Length; } }',
    pairs: [['Sw', 'sw']],
    expect: 'renamed',
  },
  {
    name: 'a private property',
    cls: 'S32',
    code: 'public class S32 { private int total { get; set; } public static int Run() { var s = new S32(); s.total = 2; s.total++; return s.Add(); } private int Add() { this.total += 3; return total; } }',
    pairs: [['total', 'Total']],
    expect: 'either',
  },
  {
    name: 'a private event',
    cls: 'S33',
    code: 'public class S33 { private event System.Action? fired; private int _n; public static int Run() { var s = new S33(); s.fired += () => s._n++; s.fired?.Invoke(); s.fired?.Invoke(); return s._n; } }',
    pairs: [['fired', 'Fired']],
    expect: 'either',
  },
  {
    name: 'a field of a struct',
    cls: 'S37',
    code: 'public struct S37 { private int Count; public S37(int c) { Count = c; } public int Get() => Count; public static int Run() => new S37(4).Get(); }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'the same local name in sibling scopes',
    cls: 'S38',
    code: 'public class S38 { public static int Run() { int sum = 0; { int Tmp = 1; sum += Tmp; } { int Tmp = 2; sum += Tmp; } return sum; } }',
    pairs: [['Tmp', 'tmp']],
    expect: 'either',
  },
  {
    name: 'a local used inside a lambda and outside it',
    cls: 'S39',
    code: 'public class S39 { public static int Run() { int Val = 1; System.Func<int, int> f = a => a + Val; return f(1) + Val; } }',
    pairs: [['Val', 'val']],
    expect: 'renamed',
  },
  {
    name: 'a local used in a query expression',
    cls: 'S40',
    code: 'using System.Linq; public class S40 { public static int Run() { var Src = new[] { 1, 2, 3 }; var q = from n in Src where n > 1 select n; return q.Count(); } }',
    pairs: [['Src', 'src']],
    expect: 'either',
  },
  {
    name: 'two locals declared in one statement and passed by ref',
    cls: 'S42',
    code: 'public class S42 { public static int Run() { int A = 1, B = 2; Swap(ref A, ref B); return A * 10 + B; } private static void Swap(ref int x, ref int y) { var t = x; x = y; y = t; } }',
    pairs: [['A', 'a'], ['B', 'b']],
    expect: 'either',
  },
  {
    name: 'a pattern variable in a switch expression',
    cls: 'S43',
    code: 'public class S43 { public static int Run() { object o = 5; return o switch { int Big when Big > 3 => Big, _ => 0 }; } }',
    pairs: [['Big', 'big']],
    expect: 'either',
  },
  {
    name: 'a parameter of a generic method',
    cls: 'S46',
    code: 'public class S46 { public static int Run() => Id<int>(5); private static T Id<T>(T Item) => Item; }',
    pairs: [['Item', 'item']],
    expect: 'renamed',
  },
  {
    name: 'a field used in nameof, whose text is observable',
    cls: 'S21',
    code: 'public class S21 { private int Count = 1; public static int Run() => nameof(Count).Length + new S21().Count; }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a named argument of another type with the same name as a renamed parameter',
    cls: 'S47',
    code: 'public class S47 { public static int Run() => G(2) + Other.F(Value: 2); private static int G(int Value) => Value; } public class Other { public static int F(int Value) => Value; }',
    pairs: [],
    expect: 'either',
    mustContain: ['G(int value)', 'Other.F(Value: 2)', 'F(int Value) => Value'],
  },
  {
    name: 'a local passed as a named argument to a call that cannot be resolved',
    cls: 'S48',
    code: 'public class S48 { public static int Run() { int value = 2; var kv = new System.Collections.Generic.KeyValuePair<int, int>(key: 1, value: value); return kv.Value; } }',
    pairs: [['value', 'Value']],
    expect: 'either',
    config: 'pascal',
  },
  {
    name: 'a partial class that declares the field in two parts',
    cls: 'S19',
    code: 'public partial class S19 { private int Count = 1; } public partial class S19 { public static int Run() => new S19().Count; }',
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a local declared again in a nested lambda scope',
    cls: 'S49',
    code: 'public class S49 { public static int Run() { int Acc = 1; System.Func<int> f = () => { int Inner = 2; return Inner + Acc; }; return f(); } }',
    pairs: [['Acc', 'acc'], ['Inner', 'inner']],
    expect: 'renamed',
  },

  {
    name: 'a method type parameter that must start with T',
    cls: 'T1',
    code: 'public class T1 { public static int Run() => Id<int>(4); private static Item Id<Item>(Item x) => x; }',
    pairs: [['Item', 'TItem']],
    expect: 'renamed',
  },
  {
    name: 'a type parameter whose new name is a type used in the method',
    cls: 'T2',
    code: 'public class T2 { public static int Run() => Id<int>(4); private static Item Id<Item>(Item x) { var o = new TItem(); return x; } private class TItem { } }',
    pairs: [['Item', 'TItem']],
    expect: 'kept',
  },
  {
    name: 'a parameter and a type parameter renamed in their XML documentation',
    cls: 'T3',
    code: ['public class T3 {', '    /// <summary>Doubles <paramref name="Val"/> of <typeparamref name="Item"/>.</summary>', '    /// <param name="Val">The value.</param>', '    /// <typeparam name="Item">The type.</typeparam>', '    private static int Dbl<Item>(int Val, Item o) => Val * 2;', '    public static int Run() => Dbl(2, "x");', '}'].join('\n'),
    pairs: [['Val', 'val'], ['Item', 'TItem']],
    expect: 'renamed',
    mustContain: ['name="val"', 'name="TItem"'],
  },
  {
    name: 'a field named in a cref of its documentation',
    cls: 'T4',
    code: ['public class T4 {', '    private int Count = 2;', '    /// <summary>Returns <see cref="Count"/>.</summary>', '    private int Get() => Count;', '    public static int Run() => new T4().Get();', '}'].join('\n'),
    pairs: [['Count', '_count']],
    expect: 'either',
  },
  {
    name: 'a field set in a nested object initializer',
    cls: 'T5',
    code: 'public class T5 { private int Count = 1; public class Holder { public Part P { get; } = new Part(); } public class Part { public int Count; } public static int Run() { var h = new Holder { P = { Count = 3 } }; return h.P.Count + new T5().Count; } }',
    pairs: [['Count', '_count']],
    expect: 'kept',
    mustIssue: 'nested object initializer',
  },
  {
    name: 'a field with the name of a member set in a target-typed object initializer',
    cls: 'T6',
    code: 'public class T6 { private int Count = 1; public class Holder { public int Count; } public static int Run() { Holder h = new() { Count = 3 }; return h.Count + new T6().Count; } }',
    pairs: [['Count', '_count']],
    expect: 'kept',
    mustIssue: 'target-typed object initializer',
  },
  {
    name: 'a field set in an object initializer of its own type',
    cls: 'T7',
    code: 'public class T7 { private int Count; public static int Run() { T7 x = new T7 { Count = 5 }; return x.Count; } }',
    pairs: [['Count', '_count']],
    expect: 'renamed',
  },
  {
    name: 'a local with the same name as its type (Color Color)',
    cls: 'T8',
    code: 'public class Color { public static int Shade() => 7; public int Tint() => 3; } public class T8 { public static int Run() { Color Color = new Color(); return Color.Shade() + Color.Tint(); } }',
    pairs: [['Color', 'color']],
    expect: 'kept',
  },
  {
    name: 'a local that would be renamed to value inside an accessor',
    cls: 'T9',
    code: 'public class T9 { private int _total; public int Total { get => _total; set { int Value = value; _total = Value; } } public static int Run() { var t = new T9(); t.Total = 4; return t.Total; } }',
    pairs: [['Value', 'value']],
    expect: 'kept',
  },
  {
    name: 'locals that would be renamed to contextual keywords',
    cls: 'T10',
    code: 'public class T10 { public static int Run() { int Var = 2; int Async = 3; int Record = 4; return Var + Async + Record; } }',
    pairs: [['Var', 'var'], ['Async', 'async'], ['Record', 'record']],
    expect: 'kept',
  },
  {
    name: 'a parameter that would be renamed to a reserved keyword',
    cls: 'T11',
    code: 'public class T11 { public static int Run() => F(2) + G(3); private static int F(int Params) => Params; private static int G(int Class) => Class; }',
    pairs: [['Params', 'params'], ['Class', 'class']],
    expect: 'kept',
    mustIssue: 'keyword',
  },
  {
    name: 'a parameter shared by overloads',
    cls: 'T12',
    code: 'public class T12 { public static int Run() => F(2) + F("a", 3); private static int F(int Val) => Val; private static int F(string s, int Val) => Val + s.Length; }',
    pairs: [['Val', 'val']],
    expect: 'renamed',
  },
  {
    name: 'a local function parameter',
    cls: 'T14',
    code: 'public class T14 { public static int Run() { int Loc(int Pv) => Pv * 2; return Loc(4); } }',
    pairs: [['Pv', 'pv']],
    expect: 'renamed',
  },
  {
    name: 'constructor parameters chained with this(...)',
    cls: 'T15',
    code: 'public class T15 { private readonly int _a; private readonly int _b; private T15(int Value) : this(Value, 1) { } private T15(int a, int b) { _a = a; _b = b; } public static int Run() { var t = new T15(4); return t._a * 10 + t._b; } }',
    pairs: [['Value', 'value']],
    expect: 'either',
  },
  {
    name: 'a parameter whose new name is a local of the method',
    cls: 'T16',
    code: 'public class T16 { public static int Run() => F(3); private static int F(int Val) { int val = 1; return Val + val; } }',
    pairs: [['Val', 'val']],
    expect: 'kept',
  },
  {
    name: 'the same lambda parameter name in two lambdas',
    cls: 'T19',
    code: 'public class T19 { public static int Run() { System.Func<int, int> a = X => X; System.Func<int, int> b = X => X + 1; return a(1) + b(2); } }',
    pairs: [['X', 'x']],
    expect: 'renamed',
  },
  {
    name: 'a local with the name of a member it reads',
    cls: 'T20',
    code: 'public class T20 { public static int Run() { string s = "abc"; int Length = s.Length; return Length; } }',
    pairs: [],
    expect: 'either',
    mustContain: ['s.Length', 'return length;'],
  },
  {
    name: 'a constructor parameter and the field it initializes',
    cls: 'T22',
    code: 'public class T22 { private int Count; private T22(int Count) { this.Count = Count; } public static int Run() => new T22(6).Count; }',
    pairs: [],
    expect: 'either',
  },
  {
    name: 'an overload that is public keeps the private one from being renamed alone',
    cls: 'T23',
    code: 'public class T23 { public static int Run() => doIt(1) + doIt("ab"); private static int doIt(int a) => a; public static int doIt(string s) => s.Length; }',
    pairs: [['doIt', 'DoIt']],
    expect: 'kept',
  },
  {
    name: 'a local is renamed in code disabled by a preprocessor directive too',
    cls: 'U1',
    code: ['public class U1 { public static int Run() { int Val = 1;', '#if NEVER', '    Val = 99;', '#endif', '    return Val; } }'].join('\n'),
    pairs: [['Val', 'val']],
    expect: 'renamed',
    mustContain: ['    val = 99;'],
  },
  {
    name: 'a field named like a member set by a with expression on another record type',
    cls: 'W1',
    code: 'public record W1Other(int Count); public class W1 { private int Count = 1; public static int Run() { W1 w = new W1(); return (w.M(new W1Other(5)) == new W1Other(7) ? 10 : 20) + w.Count; } private W1Other M(W1Other o) => o with { Count = 7 }; }',
    pairs: [['Count', '_count']],
    expect: 'kept',
    mustIssue: "'with' expression",
  },
  {
    name: 'a field set by with expressions on values of its own record type',
    cls: 'W2',
    code: 'public record W2 { private int Count = 3; public static int Run() { W2 a = new W2(); W2 b = a.Bump(a); return b.Count * 10 + a.Count; } private W2 Bump(W2 other) => this with { Count = other.Count + 1 }; }',
    pairs: [['Count', '_count']],
    expect: 'renamed',
  },
  {
    name: 'a field reached through a qualified name of another type with the same simple name',
    cls: 'W3',
    code: 'namespace W3Lib { public class Settings { public static int Level = 1; } } namespace W3App { public class Settings { private static int Level = 2; public static int Get() => W3Lib.Settings.Level + Level; } } public class W3 { public static int Run() => W3App.Settings.Get(); }',
    pairs: [['Level', '_level']],
    expect: 'kept',
    mustIssue: 'qualified name',
  },
  {
    name: 'a field and a constructor parameter reached through base from a nested derived type',
    cls: 'W4',
    code: 'public class W4 { private int Count = 4; private readonly int _seed; private W4(int Seed) { _seed = Seed; } private W4() : this(1) { } public static int Run() => new D().M(); private class D : W4 { public D() : base(Seed: 3) { } public int M() => base.Count + _seed; } }',
    pairs: [['Count', '_count'], ['Seed', 'seed']],
    expect: 'kept',
    mustIssue: 'base',
  },
];

const occurrences = (text: string, name: string): number => (text.match(new RegExp(`(?<![\\w@])${name}(?!\\w)`, 'g')) ?? []).length;

function convert(scenario: Scenario): { output: string; issues: string[] } {
  const issues: string[] = [];
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: CONFIGS[scenario.config ?? 'camel'] }], '/repo/src/Sample.cs');
  const output = createEditorConfigNamingConverter(props, (issue) => issues.push(issue)).apply(`${scenario.code}\n`);

  return { output, issues };
}

describe('renamer scenarios', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', (_name, scenario) => {
    const input = `${scenario.code}\n`;
    const { output, issues } = convert(scenario);

    for (const [oldName, newName] of scenario.pairs) {
      const renamedAll = occurrences(output, oldName) === 0 && occurrences(output, newName) >= occurrences(input, oldName);
      const keptAll = occurrences(output, oldName) === occurrences(input, oldName);

      expect(renamedAll || keptAll, `'${oldName}' must be renamed everywhere or nowhere:\n${output}`).toBe(true);
      if (scenario.expect === 'renamed') {
        expect(renamedAll, `'${oldName}' should be renamed:\n${output}\n${issues.join('\n')}`).toBe(true);
      } else if (scenario.expect === 'kept') {
        expect(keptAll, `'${oldName}' should be kept:\n${output}`).toBe(true);
        expect(issues.length, 'a rename that is refused must be reported').toBeGreaterThan(0);
      }
    }

    for (const text of scenario.mustContain ?? []) {
      expect(output).toContain(text);
    }

    if (scenario.mustIssue) {
      expect(issues.join('\n')).toContain(scenario.mustIssue);
    }
  });

  it('is idempotent on every scenario', () => {
    for (const scenario of scenarios) {
      const once = convert(scenario).output;
      const props = resolveEditorConfigProperties([{ directory: '/repo', text: CONFIGS[scenario.config ?? 'camel'] }], '/repo/src/Sample.cs');

      expect(createEditorConfigNamingConverter(props, () => undefined).apply(once), scenario.name).toBe(once);
    }
  });
});

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

const EXE_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <NoWarn>CS0169;CS0219;CS0649;CS0414;CS8618</NoWarn>
  </PropertyGroup>
</Project>
`;

function runProgram(folder: string): string {
  const result = spawnSync('dotnet', [path.join(folder, 'bin', 'Debug', 'net10.0', 'Test.dll')], { encoding: 'utf8' });

  return `${result.stdout}${result.stderr}`;
}

describe.skipIf(!dotnetAvailable)('renamer scenarios against the compiler', () => {
  // The camel-cased and the pascal-cased scenarios use different rules: two projects.
  for (const config of ['camel', 'pascal'] as const) {
    it(`compiles, runs and prints the same values after the rename (${config} locals)`, () => {
      const group = scenarios.filter((scenario) => (scenario.config ?? 'camel') === config);
      const program = `public static class Program { public static void Main() { ${group.map((s) => `System.Console.WriteLine("${s.cls}=" + ${s.cls}.Run());`).join(' ')} } }`;
      const originals: Record<string, string> = Object.fromEntries(group.map((s) => [`${s.cls}.cs`, `${s.code}\n`]));
      const folder = writeProject({ ...originals, 'Program.cs': program }, EXE_CSPROJ);
      folders.push(folder);

      const before = buildProject(folder);
      expect(before.errors, formatErrors(before)).toEqual([]);
      const expected = runProgram(folder);
      expect(expected.split('\n').filter(Boolean)).toHaveLength(group.length);

      for (const scenario of group) {
        fs.writeFileSync(path.join(folder, `${scenario.cls}.cs`), convert(scenario).output);
      }

      const after = buildProject(folder);
      expect(newCompilerErrors(before.errors, after.errors), formatErrors(after)).toEqual([]);
      expect(runProgram(folder)).toBe(expected);
    }, 240_000);
  }
});
