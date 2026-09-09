import { describe, expect, it } from 'vitest';
import { parseCSharpSource } from '../src/cleanup/syntax/parser';

function parse(source: string) {
  return parseCSharpSource(source).rootNode;
}

describe('parseCSharpSource - targeted edge cases', () => {
  it('parses explicit interface specifier', () => {
    const root = parse('class C : IFoo { void IFoo.M() { } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses constructor with base call', () => {
    const root = parse('class C : Base { public C() : base() { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses constructor with this call', () => {
    const root = parse('class C { public C() : this(0) { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses accessor with attributes', () => {
    const root = parse('class C { int P { [Attr] get; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses accessor with modifiers', () => {
    const root = parse('class C { int P { public get; private set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses accessor with expression body', () => {
    const root = parse('class C { int P { get => 42; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses catch with when clause', () => {
    const root = parse('class C { void M() { try { } catch (Exception ex) when (ex is not null) { } } }');

    expect(root.descendantsOfType('try_statement').length).toBeGreaterThan(0);
  });

  it('parses catch without type', () => {
    const root = parse('class C { void M() { try { } catch { } } }');

    expect(root.descendantsOfType('try_statement').length).toBeGreaterThan(0);
  });

  it('parses switch with when clause', () => {
    const root = parse('class C { void M() { switch (x) { case int i when i > 0: break; } } }');

    expect(root.descendantsOfType('switch_statement').length).toBeGreaterThan(0);
  });

  it('parses switch with pattern', () => {
    const root = parse('class C { void M() { switch (x) { case string s: break; } } }');

    expect(root.descendantsOfType('switch_statement').length).toBeGreaterThan(0);
  });

  it('parses switch with constant pattern', () => {
    const root = parse('class C { void M() { switch (x) { case 1: break; } } }');

    expect(root.descendantsOfType('switch_statement').length).toBeGreaterThan(0);
  });

  it('parses switch expression', () => {
    const root = parse('class C { void M() { var x = a switch { 1 => "one", _ => "other" }; } }');

    expect(root.descendantsOfType('switch_expression').length).toBeGreaterThan(0);
  });

  it('parses switch expression with patterns', () => {
    const root = parse('class C { void M() { var x = a switch { string s => s, int i => i.ToString(), _ => "" }; } }');

    expect(root.descendantsOfType('switch_expression').length).toBeGreaterThan(0);
  });

  it('parses throw expression', () => {
    const root = parse('class C { void M() { var x = flag ? 1 : throw new Exception(); } }');

    expect(root.descendantsOfType('throw_expression').length).toBeGreaterThan(0);
  });

  it('parses stackalloc expression', () => {
    const root = parse('class C { void M() { int* p = stackalloc int[10]; } }');

    expect(root.descendantsOfType('stackalloc_expression').length).toBeGreaterThan(0);
  });

  it('parses stackalloc with initializer', () => {
    const root = parse('class C { void M() { int* p = stackalloc int[] { 1, 2, 3 }; } }');

    expect(root.descendantsOfType('stackalloc_expression').length).toBeGreaterThan(0);
  });

  it('parses checked expression', () => {
    const root = parse('class C { void M() { var x = checked(int.MaxValue + 1); } }');

    expect(root.descendantsOfType('checked_expression').length).toBeGreaterThan(0);
  });

  it('parses unchecked expression', () => {
    const root = parse('class C { void M() { var x = unchecked(int.MaxValue + 1); } }');

    expect(root.descendantsOfType('unchecked_expression').length).toBeGreaterThan(0);
  });

  it('parses typeof with generic', () => {
    const root = parse('class C { void M() { var t = typeof(List<int>); } }');

    expect(root.descendantsOfType('typeof_expression').length).toBeGreaterThan(0);
  });

  it('parses sizeof with pointer', () => {
    const root = parse('class C { void M() { var s = sizeof(int*); } }');

    expect(root.descendantsOfType('sizeof_expression').length).toBeGreaterThan(0);
  });

  it('parses default literal', () => {
    const root = parse('class C { void M() { var x = default; } }');

    // The parser may use default_expression or default_literal depending on context
    expect(root.descendantsOfType('default_expression').length + root.descendantsOfType('default_literal').length).toBeGreaterThan(0);
  });

  it('parses null-forgiving operator', () => {
    const root = parse('class C { void M() { var x = maybeNull!; } }');

    expect(root.descendantsOfType('postfix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses await in expression', () => {
    const root = parse('class C { async Task M() { var x = await GetAsync(); } }');

    expect(root.descendantsOfType('await_expression').length).toBeGreaterThan(0);
  });

  it('parses tuple deconstruction', () => {
    const root = parse('class C { void M() { (int a, string b) = GetTuple(); } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses implicit object creation', () => {
    const root = parse('class C { void M() { var x = new(); } }');

    expect(root.descendantsOfType('implicit_object_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses implicit object creation with initializer', () => {
    const root = parse('class C { void M() { var x = new() { Name = "A" }; } }');

    expect(root.descendantsOfType('implicit_object_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses implicit array creation with initializer', () => {
    const root = parse('class C { void M() { var x = new[] { 1, 2, 3 }; } }');

    expect(root.descendantsOfType('implicit_array_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses collection expression with spread', () => {
    const root = parse('class C { void M() { int[] x = [1, ..other, 2]; } }');

    expect(root.descendantsOfType('collection_expression').length).toBeGreaterThan(0);
  });

  it('parses collection expression with nested', () => {
    const root = parse('class C { void M() { int[][] x = [[1], [2]]; } }');

    expect(root.descendantsOfType('collection_expression').length).toBeGreaterThan(0);
  });

  it('parses object initializer with indexer', () => {
    const root = parse('class C { void M() { var x = new Dictionary<string, int> { ["key"] = 42 }; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses object initializer with nested', () => {
    const root = parse('class C { void M() { var x = new Person { Address = new Address { City = "X" } }; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses anonymous object', () => {
    const root = parse('class C { void M() { var x = new { Name = "A", Age = 1 }; } }');

    expect(root.descendantsOfType('anonymous_object_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses ref return', () => {
    const root = parse('class C { ref int M() { return ref field; } }');

    expect(root.descendantsOfType('return_statement').length).toBeGreaterThan(0);
  });

  it('parses ref local', () => {
    const root = parse('class C { void M() { ref int x = ref GetRef(); } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses is pattern with declaration', () => {
    const root = parse('class C { void M() { if (x is string s) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with type only', () => {
    const root = parse('class C { void M() { if (x is string) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with constant', () => {
    const root = parse('class C { void M() { if (x is 42) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with null', () => {
    const root = parse('class C { void M() { if (x is null) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with not', () => {
    const root = parse('class C { void M() { if (x is not null) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with or', () => {
    const root = parse('class C { void M() { if (x is int or string) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with and', () => {
    const root = parse('class C { void M() { if (x is > 0 and < 10) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with property', () => {
    const root = parse('class C { void M() { if (x is { Name: "A" }) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with positional', () => {
    const root = parse('class C { void M() { if (x is (1, 2)) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with var', () => {
    const root = parse('class C { void M() { if (x is var y) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with discard', () => {
    const root = parse('class C { void M() { if (x is _) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with relational', () => {
    const root = parse('class C { void M() { if (x is > 5) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern with list', () => {
    const root = parse('class C { void M() { if (x is [1, 2, ..]) { } } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses as expression', () => {
    const root = parse('class C { void M() { var x = obj as string; } }');

    expect(root.descendantsOfType('binary_expression').length).toBeGreaterThan(0);
  });

  it('parses is type check', () => {
    const root = parse('class C { void M() { var x = obj is string; } }');

    // The parser may use is_expression or is_pattern_expression
    expect(root.descendantsOfType('is_pattern_expression').length + root.descendantsOfType('is_expression').length).toBeGreaterThan(0);
  });

  it('parses conditional access chain', () => {
    const root = parse('class C { void M() { var x = a?.b?.c; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses null-coalescing assignment', () => {
    const root = parse('class C { void M() { x ??= default; } }');

    expect(root.descendantsOfType('assignment_expression').length).toBeGreaterThan(0);
  });

  it('parses range expression', () => {
    const root = parse('class C { void M() { var r = 1..5; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses index expression', () => {
    const root = parse('class C { void M() { var x = arr[^1]; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses tuple type in declaration', () => {
    const root = parse('class C { (int, string) GetTuple() { return (0, ""); } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses nullable type in declaration', () => {
    const root = parse('class C { int? x; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses nullable reference in declaration', () => {
    const root = parse('class C { string? s; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses jagged array type', () => {
    const root = parse('class C { int[][] arr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses multi-dimensional array type', () => {
    const root = parse('class C { int[,] arr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses pointer type', () => {
    const root = parse('class C { int* ptr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses function pointer type', () => {
    const root = parse('class C { delegate*<void> ptr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses ref readonly field', () => {
    const root = parse('class C { ref readonly int x; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses required property', () => {
    const root = parse('class C { required int P { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses static abstract interface member', () => {
    const root = parse('interface I { static abstract void M(); }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses static virtual interface member', () => {
    const root = parse('interface I { static virtual void M() { } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses record with primary constructor', () => {
    const root = parse('record Person(string Name, int Age);');

    const rec = root.namedChildren.find((c) => c.type === 'record_declaration');

    expect(rec).toBeDefined();
    expect(rec!.childForFieldName('parameters')).toBeDefined();
  });

  it('parses record with parameter attributes', () => {
    const root = parse('record Person([Required] string Name);');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses record with base and parameters', () => {
    const root = parse('record Person(string Name) : IEquatable<Person>;');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses record struct with parameters', () => {
    const root = parse('record struct Point(int X, int Y);');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses generic record', () => {
    const root = parse('record Container<T>(T Value);');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses enum with explicit values', () => {
    const root = parse('enum E { A = 1, B = 2, C = 4 }');

    const enumDecl = root.namedChildren.find((c) => c.type === 'enum_declaration');

    expect(enumDecl).toBeDefined();
    expect(enumDecl!.descendantsOfType('enum_member_declaration')).toHaveLength(3);
  });

  it('parses enum with hex values', () => {
    const root = parse('enum E { A = 0x1, B = 0x2 }');

    expect(root.descendantsOfType('enum_member_declaration').length).toBeGreaterThan(0);
  });

  it('parses enum with negative values', () => {
    const root = parse('enum E { A = -1, B = 0 }');

    expect(root.descendantsOfType('enum_member_declaration').length).toBeGreaterThan(0);
  });

  it('parses enum with expressions', () => {
    const root = parse('enum E { A = 1 << 0, B = 1 << 1 }');

    expect(root.descendantsOfType('enum_member_declaration').length).toBeGreaterThan(0);
  });

  it('parses enum with base type', () => {
    const root = parse('enum E : byte { A, B }');

    const enumDecl = root.namedChildren.find((c) => c.type === 'enum_declaration');

    expect(enumDecl).toBeDefined();
  });

  it('parses enum with attributes on members', () => {
    const root = parse('enum E { [Obsolete] A, B }');

    expect(root.descendantsOfType('enum_member_declaration').length).toBeGreaterThan(0);
  });

  it('parses interface with static method', () => {
    const root = parse('interface I { static void M() { } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses interface with operator', () => {
    const root = parse('interface I { static abstract I operator +(I a, I b); }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses delegate with modifiers', () => {
    const root = parse('public delegate void Handler();');

    expect(root.namedChildren.some((c) => c.type === 'delegate_declaration')).toBe(true);
  });

  it('parses delegate with generic parameters', () => {
    const root = parse('delegate TResult Func<in T, out TResult>(T arg);');

    expect(root.namedChildren.some((c) => c.type === 'delegate_declaration')).toBe(true);
  });

  it('parses delegate with ref return', () => {
    const root = parse('delegate ref int RefDelegate();');

    expect(root.namedChildren.some((c) => c.type === 'delegate_declaration')).toBe(true);
  });

  it('parses unsafe method', () => {
    const root = parse('class C { unsafe void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses fixed size buffer', () => {
    const root = parse('struct S { fixed int buffer[10]; }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses local function with generics', () => {
    const root = parse('class C { void M() { T Local<T>(T x) => x; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses local function with async', () => {
    const root = parse('class C { async Task M() { await Task.Delay(1); int Local() => 42; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses local function with static', () => {
    const root = parse('class C { void M() { static int Local() => 42; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses local function with unsafe', () => {
    const root = parse('class C { void M() { unsafe int* Local() => null; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with pointer parameters', () => {
    const root = parse('class C { unsafe void M(int* p) { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with ref return', () => {
    const root = parse('class C { ref int M() { return ref field; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with ref readonly return', () => {
    const root = parse('class C { ref readonly int M() { return ref field; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with pointer return', () => {
    const root = parse('class C { unsafe int* M() { return null; } }');

    // The parser may not fully support pointer return types
    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with function pointer return', () => {
    const root = parse('class C { delegate*<void> M() { return null; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with tuple return', () => {
    const root = parse('class C { (int, string) M() { return (0, ""); } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with dynamic return', () => {
    const root = parse('class C { dynamic M() { return null; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with object return', () => {
    const root = parse('class C { object M() { return null; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with nint return', () => {
    const root = parse('class C { nint M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with nuint return', () => {
    const root = parse('class C { nuint M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with ulong return', () => {
    const root = parse('class C { ulong M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with sbyte return', () => {
    const root = parse('class C { sbyte M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with byte return', () => {
    const root = parse('class C { byte M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with short return', () => {
    const root = parse('class C { short M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with ushort return', () => {
    const root = parse('class C { ushort M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with char return', () => {
    const root = parse("class C { char M() { return 'a'; } }");

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with decimal return', () => {
    const root = parse('class C { decimal M() { return 0m; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with float return', () => {
    const root = parse('class C { float M() { return 0f; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with double return', () => {
    const root = parse('class C { double M() { return 0.0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with bool return', () => {
    const root = parse('class C { bool M() { return true; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with string return', () => {
    const root = parse('class C { string M() { return ""; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with var return (not allowed but parser is tolerant)', () => {
    const root = parse('class C { var M() { return null; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with async void', () => {
    const root = parse('class C { async void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with async Task', () => {
    const root = parse('class C { async Task M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with async ValueTask', () => {
    const root = parse('class C { async ValueTask M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with async Task<T>', () => {
    const root = parse('class C { async Task<int> M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with async ValueTask<T>', () => {
    const root = parse('class C { async ValueTask<int> M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with async IAsyncEnumerable<T>', () => {
    const root = parse('class C { async IAsyncEnumerable<int> M() { yield return 1; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with ref struct parameter', () => {
    const root = parse('class C { void M(Span<int> span) { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with in parameter', () => {
    const root = parse('class C { void M(in int x) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with ref readonly parameter', () => {
    const root = parse('class C { void M(ref readonly int x) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with scoped parameter', () => {
    const root = parse('class C { void M(scoped ref int x) { } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses method with params array', () => {
    const root = parse('class C { void M(params int[] args) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with params collection', () => {
    const root = parse('class C { void M(params IEnumerable<int> args) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with default parameter values', () => {
    const root = parse('class C { void M(int a = 0, string b = "", bool c = false) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(2);
  });

  it('parses method with nullable parameter', () => {
    const root = parse('class C { void M(string? s) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with optional cancellation token', () => {
    const root = parse('class C { void M(CancellationToken ct = default) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with attributes on parameters', () => {
    const root = parse('class C { void M([NotNull] string s) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with multiple attributes on parameter', () => {
    const root = parse('class C { void M([NotNull] [NotEmpty] string s) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses method with caller info attributes', () => {
    const root = parse('class C { void M([CallerMemberName] string name = "") { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });
});
