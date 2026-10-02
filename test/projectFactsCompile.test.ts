import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newCompilerErrors } from '../scripts/compileOracle';
import { runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';
import { buildProject, dotnetAvailable, formatErrors, writeProject } from './helpers/dotnetBuild';

/**
 * CA1852 (seal) and CA1822 (make static) change a declaration other files may depend on. They may
 * only do so when the other files of the project, read from disk, do not need the old declaration;
 * the real compiler checks that the project still builds.
 */
const EDITORCONFIG = `root = true

[*.cs]
dotnet_diagnostic.CA1852.severity = warning
dotnet_diagnostic.CA1822.severity = warning
`;

const files: Record<string, string> = {
  '.editorconfig': EDITORCONFIG,
  'Base.cs': 'internal class Base { public int Id => 1; }\n',
  'Derived.cs': 'internal sealed class Derived : Base { public int Twice() => Id * 2; }\n',
  'Generic.cs': 'internal class Constraint { }\ninternal class Holder<T> where T : Constraint { public T? Value { get; set; } }\n',
  'Alone.cs': 'internal class Alone { public int Value => 3; }\n',
  'Util.cs': 'internal class Util { internal int Twice(int x) => x * 2; internal int Unused(int x) => x + 1; }\n',
  'User.cs': 'internal static class User { public static int Use() { var u = new Util(); return u.Twice(3) + new Alone().Value + new Derived().Twice() + new Holder<Constraint>().GetHashCode(); } }\n',
  'Helper.cs': 'internal class Helper { public string Format() => "x"; }\n',
  'UseHelper.cs': 'internal static class UseHelper { public static string M(Helper h) => $"{h.Format()}"; }\n',
  'Shape.cs': 'internal class Shape { public string Kind => "square"; }\n',
  'UseShape.cs': 'internal static class UseShape { public static bool M(object o) => o is Shape { Kind: "square" }; }\n',
  'Named.cs': 'internal class NamedBase { public string Name() => "x"; }\ninternal interface INamed { string Name(); }\ninternal sealed class NamedImpl : NamedBase, INamed { }\n',
  'Bag.cs': [
    'using System.Collections.Generic;',
    'internal static class UseBag',
    '{',
    '    private sealed class Bag',
    '    {',
    '        public IEnumerator<int> GetEnumerator() { yield return 1; }',
    '        internal void Deconstruct(out int a, out int b) { a = 1; b = 2; }',
    '    }',
    '    public static int M() { var s = 0; foreach (var x in new Bag()) { s += x; } var (a, b) = new Bag(); return s + a + b; }',
    '}',
    '',
  ].join('\n'),
  'Query.cs': 'using System;\ninternal sealed class Query { private Query Select(Func<int, int> f) => null!; public object M() => from x in this select x * 2; }\n',
  'IndexBase.cs': 'internal class IndexBase { public int this[int i] => i; }\n',
  'Indexed.cs': 'internal sealed class Indexed : IndexBase { private int Length => 3; public int Last() => this[^1]; }\n',
  'LengthBase.cs': 'internal class LengthBase { protected int Length => 3; }\n',
  'LengthDerived.cs': 'internal sealed class LengthDerived : LengthBase { public int this[int i] => i; public int Last() => this[^1]; }\n',
  'Sliced.cs': 'internal sealed class Sliced { public int[] Slice(int a, int b) => new int[b]; private int Length => 3; public int[] Middle() => this[1..^1]; }\n',
  'AddBase.cs': 'internal class AddBase { internal void Add(int x) { } }\n',
  'AddDerived.cs': 'using System.Collections;\ninternal sealed class AddDerived : AddBase, IEnumerable { public IEnumerator GetEnumerator() => null!; public static AddDerived Make() => new AddDerived { 1 }; }\n',
  'Handler.cs': [
    'using System.Runtime.CompilerServices;',
    '[InterpolatedStringHandler]',
    'internal ref struct NoOpHandler',
    '{',
    '    public NoOpHandler(int literalLength, int formattedCount) { }',
    '    public bool AppendLiteral(string s) => true;',
    '    public bool AppendFormatted<T>(T value) => true;',
    '}',
    'internal static class UseHandler { public static void Write(NoOpHandler handler) { } public static void M(int x) => Write($"x={x}"); }',
    '',
  ].join('\n'),
  'Builder.cs': [
    'using System;',
    'using System.Runtime.CompilerServices;',
    'internal struct WorkBuilder',
    '{',
    '    public static WorkBuilder Create() => default;',
    '    public Work Task => default;',
    '    public void Start<TStateMachine>(ref TStateMachine stateMachine) where TStateMachine : IAsyncStateMachine => stateMachine.MoveNext();',
    '    public void SetStateMachine(IAsyncStateMachine stateMachine) { }',
    '    public void SetResult() { }',
    '    public void SetException(Exception exception) { }',
    '    public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine) where TAwaiter : INotifyCompletion where TStateMachine : IAsyncStateMachine { }',
    '    public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine) where TAwaiter : ICriticalNotifyCompletion where TStateMachine : IAsyncStateMachine { }',
    '}',
    '[AsyncMethodBuilder(typeof(WorkBuilder))]',
    'internal struct Work { }',
    'internal static class UseWork { public static async Work M() { await System.Threading.Tasks.Task.Yield(); } }',
    '',
  ].join('\n'),
};

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

function cleanProject(): { folder: string; text: (name: string) => string } {
  const folder = writeProject(files);
  folders.push(folder);

  return { folder, text: (name) => fs.readFileSync(path.join(folder, name), 'utf8') };
}

describe.skipIf(!dotnetAvailable)('cross-file facts of seal / make static against the compiler', () => {
  const { folder, text } = cleanProject();
  const before = buildProject(folder);

  it('builds before cleanup', () => {
    expect(before.errors, formatErrors(before)).toEqual([]);
  }, 120_000);

  it('cleans every file, keeps what other files need and still builds', () => {
    for (const name of Object.keys(files).filter((file) => file.endsWith('.cs'))) {
      const file = path.join(folder, name);
      fs.writeFileSync(file, runCleanup(fs.readFileSync(file, 'utf8'), file, createDefaultSettings()));
    }

    expect(text('Base.cs'), 'a base type of another file is never sealed').not.toMatch(/sealed class Base/);
    expect(text('Generic.cs'), 'a type used as a generic constraint is never sealed').not.toMatch(/sealed class Constraint/);
    expect(text('Util.cs'), 'a member another file calls is never made static').toMatch(/int Twice\(int x\)/);
    expect(text('Util.cs')).not.toMatch(/static int Twice/);

    expect(text('Alone.cs'), 'a type nothing derives from is sealed').toMatch(/sealed class Alone/);
    expect(text('Util.cs'), 'a member nothing calls is made static').toMatch(/static int Unused/);

    expect(text('Helper.cs'), 'a member another file uses in an interpolated string is never made static').not.toMatch(/static string Format/);
    expect(text('Shape.cs'), 'a property another file reads through a property pattern is never made static').not.toMatch(/static string Kind/);
    expect(text('Named.cs'), 'a base member a derived type implements an interface with is never made static').not.toMatch(/static string Name/);
    expect(text('Bag.cs'), 'members foreach and deconstruction bind to are never made static').not.toMatch(/static (?:IEnumerator<int> GetEnumerator|void Deconstruct)/);
    expect(text('Query.cs'), 'a member a query expression binds to is never made static').not.toMatch(/static Query Select/);
    expect(text('Indexed.cs'), 'Length of a type inheriting an indexer is never made static').not.toMatch(/static int Length/);
    expect(text('LengthBase.cs'), 'Length a derived type of another file indexes through is never made static').not.toMatch(/static int Length/);
    expect(text('Sliced.cs'), 'Length of a type with Slice is never made static').not.toMatch(/static int Length/);
    expect(text('AddBase.cs'), 'Add a derived collection type of another file initializes through is never made static').not.toMatch(/static void Add/);
    expect(text('Handler.cs'), 'members of an interpolated string handler are never made static').not.toMatch(/static bool Append/);
    expect(text('Builder.cs'), 'members of an async method builder are never made static').not.toMatch(/static (?:Work Task|void Set|void Await)/);

    const after = buildProject(folder);
    expect(newCompilerErrors(before.errors, after.errors), formatErrors(after)).toEqual([]);
  }, 120_000);
});
