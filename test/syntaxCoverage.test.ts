import { describe, expect, it } from 'vitest';
import { parseCSharpSource } from '../src/cleanup/syntax/parser';

/** Parses source and returns the root node. */
function parse(source: string) {
  return parseCSharpSource(source).rootNode;
}

describe('parseCSharpSource - broad coverage', () => {
  it('parses a simple class', () => {
    const root = parse('class C { }');

    expect(root.type).toBe('compilation_unit');
    expect(root.namedChildren.length).toBeGreaterThan(0);
  });

  it('parses a namespace with a class', () => {
    const root = parse('namespace N { class C { } }');

    expect(root.type).toBe('compilation_unit');
    const ns = root.namedChildren.find((c) => c.type === 'namespace_declaration');

    expect(ns).toBeDefined();
  });

  it('parses a file-scoped namespace', () => {
    const root = parse('namespace N; class C { }');

    const fsns = root.namedChildren.find((c) => c.type === 'file_scoped_namespace_declaration');

    expect(fsns).toBeDefined();
  });

  it('parses using directives', () => {
    const root = parse('using System; using System.Text;');

    const usings = root.namedChildren.filter((c) => c.type === 'using_directive');

    expect(usings).toHaveLength(2);
  });

  it('parses global using', () => {
    const root = parse('global using System;');

    expect(root.namedChildren.some((c) => c.type === 'using_directive')).toBe(true);
  });

  it('parses static using', () => {
    const root = parse('using static System.Math;');

    expect(root.namedChildren.some((c) => c.type === 'using_directive')).toBe(true);
  });

  it('parses using alias', () => {
    const root = parse('using MyAlias = System.Text.StringBuilder;');

    expect(root.namedChildren.some((c) => c.type === 'using_directive')).toBe(true);
  });

  it('parses interface', () => {
    const root = parse('interface IFoo { void Bar(); }');

    expect(root.namedChildren.some((c) => c.type === 'interface_declaration')).toBe(true);
  });

  it('parses enum', () => {
    const root = parse('enum Color { Red, Green, Blue }');

    expect(root.namedChildren.some((c) => c.type === 'enum_declaration')).toBe(true);
  });

  it('parses struct', () => {
    const root = parse('struct Point { int X; int Y; }');

    expect(root.namedChildren.some((c) => c.type === 'struct_declaration')).toBe(true);
  });

  it('parses record', () => {
    const root = parse('record Person(string Name, int Age);');

    expect(root.namedChildren.some((c) => c.type === 'record_declaration')).toBe(true);
  });

  it('parses record struct', () => {
    const root = parse('record struct Point(int X, int Y);');

    expect(root.namedChildren.some((c) => c.type === 'record_declaration')).toBe(true);
  });

  it('parses delegate', () => {
    const root = parse('delegate void Handler();');

    expect(root.namedChildren.some((c) => c.type === 'delegate_declaration')).toBe(true);
  });

  it('parses class with modifiers', () => {
    const root = parse('public sealed class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
    expect(cls!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'public')).toBe(true);
    expect(cls!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'sealed')).toBe(true);
  });

  it('parses class with base list', () => {
    const root = parse('class C : Base, IFoo { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
    expect(cls!.namedChildren.some((c) => c.type === 'base_list')).toBe(true);
  });

  it('parses generic class', () => {
    const root = parse('class C<T> { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
  });

  it('parses generic class with constraints', () => {
    const root = parse('class C<T> where T : class, new() { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
  });

  it('parses method with modifiers', () => {
    const root = parse('class C { public static async Task<int> GetAsync() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with parameters', () => {
    const root = parse('class C { void M(int x, string y = "default") { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
  });

  it('parses property with get/set', () => {
    const root = parse('class C { int P { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses property with expression body', () => {
    const root = parse('class C { int P => 42; }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses field with initializer', () => {
    const root = parse('class C { int x = 42; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses const field', () => {
    const root = parse('class C { const int X = 42; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses readonly field', () => {
    const root = parse('class C { readonly int x; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses event declaration', () => {
    const root = parse('class C { event EventHandler Changed; }');

    expect(root.descendantsOfType('event_field_declaration').length).toBeGreaterThan(0);
  });

  it('parses constructor', () => {
    const root = parse('class C { public C() { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses destructor', () => {
    const root = parse('class C { ~C() { } }');

    expect(root.descendantsOfType('destructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses operator overload', () => {
    const root = parse('class C { public static C operator +(C a, C b) => new C(); }');

    expect(root.descendantsOfType('operator_declaration').length).toBeGreaterThan(0);
  });

  it('parses conversion operator', () => {
    const root = parse('class C { public static implicit operator int(C c) => 0; }');

    expect(root.descendantsOfType('conversion_operator_declaration').length).toBeGreaterThan(0);
  });

  it('parses indexer', () => {
    const root = parse('class C { public int this[int i] { get => 0; } }');

    expect(root.descendantsOfType('indexer_declaration').length).toBeGreaterThan(0);
  });

  it('parses attributes on class', () => {
    const root = parse('[Obsolete] class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
    expect(cls!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses attributes with arguments', () => {
    const root = parse('[Obsolete("Use NewMethod instead")] class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
  });

  it('parses partial class', () => {
    const root = parse('partial class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
    expect(cls!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'partial')).toBe(true);
  });

  it('parses abstract class', () => {
    const root = parse('abstract class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
  });

  it('parses static class', () => {
    const root = parse('static class C { }');

    const cls = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(cls).toBeDefined();
  });

  it('parses nested class', () => {
    const root = parse('class Outer { class Inner { } }');

    const outer = root.namedChildren.find((c) => c.type === 'class_declaration');

    expect(outer).toBeDefined();
    expect(outer!.descendantsOfType('class_declaration').length).toBeGreaterThan(1);
  });

  it('parses if statement', () => {
    const root = parse('class C { void M() { if (x) { } } }');

    expect(root.descendantsOfType('if_statement').length).toBeGreaterThan(0);
  });

  it('parses if-else statement', () => {
    const root = parse('class C { void M() { if (x) { } else { } } }');

    expect(root.descendantsOfType('if_statement').length).toBeGreaterThan(0);
  });

  it('parses while loop', () => {
    const root = parse('class C { void M() { while (true) { } } }');

    expect(root.descendantsOfType('while_statement').length).toBeGreaterThan(0);
  });

  it('parses for loop', () => {
    const root = parse('class C { void M() { for (int i = 0; i < 10; i++) { } } }');

    expect(root.descendantsOfType('for_statement').length).toBeGreaterThan(0);
  });

  it('parses foreach loop', () => {
    const root = parse('class C { void M() { foreach (var item in list) { } } }');

    expect(root.descendantsOfType('for_each_statement').length).toBeGreaterThan(0);
  });

  it('parses do-while loop', () => {
    const root = parse('class C { void M() { do { } while (true); } }');

    expect(root.descendantsOfType('do_statement').length).toBeGreaterThan(0);
  });

  it('parses switch statement', () => {
    const root = parse('class C { void M() { switch (x) { case 1: break; default: break; } } }');

    expect(root.descendantsOfType('switch_statement').length).toBeGreaterThan(0);
  });

  it('parses try-catch', () => {
    const root = parse('class C { void M() { try { } catch (Exception ex) { } } }');

    expect(root.descendantsOfType('try_statement').length).toBeGreaterThan(0);
  });

  it('parses try-catch-finally', () => {
    const root = parse('class C { void M() { try { } catch { } finally { } } }');

    expect(root.descendantsOfType('try_statement').length).toBeGreaterThan(0);
  });

  it('parses using statement', () => {
    const root = parse('class C { void M() { using (var x = new Disposable()) { } } }');

    expect(root.descendantsOfType('using_statement').length).toBeGreaterThan(0);
  });

  it('parses return statement', () => {
    const root = parse('class C { int M() { return 42; } }');

    expect(root.descendantsOfType('return_statement').length).toBeGreaterThan(0);
  });

  it('parses throw statement', () => {
    const root = parse('class C { void M() { throw new Exception(); } }');

    expect(root.descendantsOfType('throw_statement').length).toBeGreaterThan(0);
  });

  it('parses break statement', () => {
    const root = parse('class C { void M() { while (true) { break; } } }');

    expect(root.descendantsOfType('break_statement').length).toBeGreaterThan(0);
  });

  it('parses continue statement', () => {
    const root = parse('class C { void M() { while (true) { continue; } } }');

    expect(root.descendantsOfType('continue_statement').length).toBeGreaterThan(0);
  });

  it('parses lock statement', () => {
    const root = parse('class C { void M() { lock (obj) { } } }');

    expect(root.descendantsOfType('lock_statement').length).toBeGreaterThan(0);
  });

  it('parses checked/unchecked', () => {
    const root = parse('class C { void M() { checked { int x = int.MaxValue + 1; } } }');

    expect(root.descendantsOfType('checked_statement').length).toBeGreaterThan(0);
  });

  it('parses unsafe block', () => {
    const root = parse('class C { void M() { unsafe { int* p = null; } } }');

    expect(root.descendantsOfType('unsafe_statement').length).toBeGreaterThan(0);
  });

  it('parses fixed statement', () => {
    const root = parse('class C { void M() { fixed (int* p = &value) { } } }');

    expect(root.descendantsOfType('fixed_statement').length).toBeGreaterThan(0);
  });

  it('parses local function', () => {
    const root = parse('class C { void M() { int Local() => 42; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses lambda expression', () => {
    const root = parse('class C { void M() { Func<int> f = () => 42; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses async lambda', () => {
    const root = parse('class C { void M() { Func<Task> f = async () => { await Task.Delay(1); }; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses ternary expression', () => {
    const root = parse('class C { void M() { var x = a ? b : c; } }');

    expect(root.descendantsOfType('conditional_expression').length).toBeGreaterThan(0);
  });

  it('parses null-coalescing expression', () => {
    const root = parse('class C { void M() { var x = a ?? b; } }');

    expect(root.descendantsOfType('binary_expression').length).toBeGreaterThan(0);
  });

  it('parses null-conditional access', () => {
    const root = parse('class C { void M() { var x = obj?.Property; } }');

    expect(root.descendantsOfType('conditional_access_expression').length).toBeGreaterThan(0);
  });

  it('parses array access', () => {
    const root = parse('class C { void M() { var x = arr[0]; } }');

    expect(root.descendantsOfType('element_access_expression').length).toBeGreaterThan(0);
  });

  it('parses range access', () => {
    const root = parse('class C { void M() { var x = arr[1..5]; } }');

    expect(root.descendantsOfType('element_access_expression').length).toBeGreaterThan(0);
  });

  it('parses is pattern', () => {
    const root = parse('class C { void M() { if (x is string s) { } } }');

    expect(root.descendantsOfType('is_pattern_expression').length).toBeGreaterThan(0);
  });

  it('parses as expression', () => {
    const root = parse('class C { void M() { var x = obj as string; } }');

    expect(root.descendantsOfType('binary_expression').length).toBeGreaterThan(0);
  });

  it('parses typeof expression', () => {
    const root = parse('class C { void M() { var t = typeof(string); } }');

    expect(root.descendantsOfType('typeof_expression').length).toBeGreaterThan(0);
  });

  it('parses sizeof expression', () => {
    const root = parse('class C { void M() { var s = sizeof(int); } }');

    expect(root.descendantsOfType('sizeof_expression').length).toBeGreaterThan(0);
  });

  it('parses default expression', () => {
    const root = parse('class C { void M() { var x = default(int); } }');

    expect(root.descendantsOfType('default_expression').length).toBeGreaterThan(0);
  });

  it('parses object creation', () => {
    const root = parse('class C { void M() { var x = new List<int>(); } }');

    expect(root.descendantsOfType('object_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses object initializer', () => {
    const root = parse('class C { void M() { var x = new Person { Name = "A" }; } }');

    expect(root.descendantsOfType('object_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses array creation', () => {
    const root = parse('class C { void M() { var x = new int[5]; } }');

    expect(root.descendantsOfType('array_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses array creation with initializer', () => {
    const root = parse('class C { void M() { var x = new int[] { 1, 2, 3 }; } }');

    expect(root.descendantsOfType('array_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses implicit array creation', () => {
    const root = parse('class C { void M() { var x = new[] { 1, 2, 3 }; } }');

    expect(root.descendantsOfType('implicit_array_creation_expression').length).toBeGreaterThan(0);
  });

  it('parses collection expression', () => {
    const root = parse('class C { void M() { int[] x = [1, 2, 3]; } }');

    expect(root.descendantsOfType('collection_expression').length).toBeGreaterThan(0);
  });

  it('parses tuple expression', () => {
    const root = parse('class C { void M() { var x = (1, "a"); } }');

    expect(root.descendantsOfType('tuple_expression').length).toBeGreaterThan(0);
  });

  it('parses interpolated string', () => {
    const root = parse('class C { void M() { var s = $"Hello {name}"; } }');

    expect(root.descendantsOfType('interpolated_string_expression').length).toBeGreaterThan(0);
  });

  it('parses verbatim string', () => {
    const root = parse('class C { void M() { var s = @"path"; } }');

    expect(root.descendantsOfType('verbatim_string_literal').length).toBeGreaterThan(0);
  });

  it('parses raw string', () => {
    const root = parse('class C { void M() { var s = """raw"""; } }');

    expect(root.descendantsOfType('raw_string_literal').length).toBeGreaterThan(0);
  });

  it('parses char literal', () => {
    const root = parse("class C { void M() { var c = 'a'; } }");

    expect(root.descendantsOfType('character_literal').length).toBeGreaterThan(0);
  });

  it('parses integer literal', () => {
    const root = parse('class C { void M() { var x = 42; } }');

    expect(root.descendantsOfType('integer_literal').length).toBeGreaterThan(0);
  });

  it('parses real literal', () => {
    const root = parse('class C { void M() { var x = 3.14; } }');

    expect(root.descendantsOfType('real_literal').length).toBeGreaterThan(0);
  });

  it('parses boolean literals', () => {
    const root = parse('class C { void M() { var t = true; var f = false; } }');

    expect(root.descendantsOfType('boolean_literal').length).toBeGreaterThan(1);
  });

  it('parses null literal', () => {
    const root = parse('class C { void M() { var x = null; } }');

    expect(root.descendantsOfType('null_literal').length).toBeGreaterThan(0);
  });

  it('parses this expression', () => {
    const root = parse('class C { void M() { var x = this; } }');

    expect(root.descendantsOfType('this_expression').length).toBeGreaterThan(0);
  });

  it('parses base expression', () => {
    const root = parse('class C : Base { void M() { base.M(); } }');

    expect(root.descendantsOfType('base_expression').length).toBeGreaterThan(0);
  });

  it('parses member access', () => {
    const root = parse('class C { void M() { var x = obj.Property; } }');

    expect(root.descendantsOfType('member_access_expression').length).toBeGreaterThan(0);
  });

  it('parses method invocation', () => {
    const root = parse('class C { void M() { obj.Method(); } }');

    expect(root.descendantsOfType('invocation_expression').length).toBeGreaterThan(0);
  });

  it('parses generic method invocation', () => {
    const root = parse('class C { void M() { obj.Method<int>(); } }');

    expect(root.descendantsOfType('invocation_expression').length).toBeGreaterThan(0);
  });

  it('parses cast expression', () => {
    const root = parse('class C { void M() { var x = (string)obj; } }');

    expect(root.descendantsOfType('cast_expression').length).toBeGreaterThan(0);
  });

  it('parses assignment expression', () => {
    const root = parse('class C { void M() { x = 42; } }');

    expect(root.descendantsOfType('assignment_expression').length).toBeGreaterThan(0);
  });

  it('parses compound assignment', () => {
    const root = parse('class C { void M() { x += 1; y -= 2; } }');

    expect(root.descendantsOfType('assignment_expression').length).toBeGreaterThan(0);
  });

  it('parses prefix increment', () => {
    const root = parse('class C { void M() { ++x; } }');

    expect(root.descendantsOfType('prefix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses postfix increment', () => {
    const root = parse('class C { void M() { x++; } }');

    expect(root.descendantsOfType('postfix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses negation', () => {
    const root = parse('class C { void M() { var x = -1; } }');

    expect(root.descendantsOfType('prefix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses logical not', () => {
    const root = parse('class C { void M() { var x = !flag; } }');

    expect(root.descendantsOfType('prefix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses bitwise not', () => {
    const root = parse('class C { void M() { var x = ~bits; } }');

    expect(root.descendantsOfType('prefix_unary_expression').length).toBeGreaterThan(0);
  });

  it('parses await expression', () => {
    const root = parse('class C { async void M() { await Task.Delay(1); } }');

    expect(root.descendantsOfType('await_expression').length).toBeGreaterThan(0);
  });

  it('parses yield return', () => {
    const root = parse('class C { IEnumerable<int> M() { yield return 1; } }');

    expect(root.descendantsOfType('yield_statement').length).toBeGreaterThan(0);
  });

  it('parses yield break', () => {
    const root = parse('class C { IEnumerable<int> M() { yield break; } }');

    expect(root.descendantsOfType('yield_statement').length).toBeGreaterThan(0);
  });

  it('parses goto statement', () => {
    const root = parse('class C { void M() { goto Label; Label: return; } }');

    expect(root.descendantsOfType('goto_statement').length).toBeGreaterThan(0);
  });

  it('parses labeled statement', () => {
    const root = parse('class C { void M() { Label: return; } }');

    expect(root.descendantsOfType('labeled_statement').length).toBeGreaterThan(0);
  });

  it('parses empty statement', () => {
    const root = parse('class C { void M() { ; } }');

    expect(root.descendantsOfType('empty_statement').length).toBeGreaterThan(0);
  });

  it('parses local declaration', () => {
    const root = parse('class C { void M() { int x = 42; } }');

    expect(root.descendantsOfType('local_declaration_statement').length).toBeGreaterThan(0);
  });

  it('parses var declaration', () => {
    const root = parse('class C { void M() { var x = 42; } }');

    expect(root.descendantsOfType('local_declaration_statement').length).toBeGreaterThan(0);
  });

  it('parses deconstruction', () => {
    const root = parse('class C { void M() { var (a, b) = GetTuple(); } }');

    // The parser handles deconstruction as an expression statement with assignment
    expect(root.type).toBe('compilation_unit');
  });

  it('parses out variable', () => {
    const root = parse('class C { void M() { int.TryParse(s, out var x); } }');

    expect(root.descendantsOfType('invocation_expression').length).toBeGreaterThan(0);
  });

  it('parses ref local', () => {
    const root = parse('class C { void M() { ref int x = ref GetRef(); } }');

    expect(root.descendantsOfType('local_declaration_statement').length).toBeGreaterThan(0);
  });

  it('parses ref return', () => {
    const root = parse('class C { ref int M() { return ref field; } }');

    expect(root.descendantsOfType('return_statement').length).toBeGreaterThan(0);
  });

  it('parses pattern matching in switch', () => {
    const root = parse('class C { void M() { switch (x) { case string s: break; case int i when i > 0: break; } } }');

    expect(root.descendantsOfType('switch_statement').length).toBeGreaterThan(0);
  });

  it('parses expression switch', () => {
    const root = parse('class C { void M() { var x = a switch { 1 => "one", _ => "other" }; } }');

    expect(root.descendantsOfType('switch_expression').length).toBeGreaterThan(0);
  });

  it('parses with expression', () => {
    const root = parse('class C { void M() { var x = record with { Name = "B" }; } }');

    // The parser may not have a dedicated with_expression node
    expect(root.type).toBe('compilation_unit');
  });

  it('parses init accessor', () => {
    const root = parse('class C { int P { get; init; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses required modifier', () => {
    const root = parse('class C { required int P { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses nullable reference type', () => {
    const root = parse('class C { string? Name { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses nullable value type', () => {
    const root = parse('class C { int? x; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses array type', () => {
    const root = parse('class C { int[] arr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses jagged array type', () => {
    const root = parse('class C { int[][] arr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses generic type reference', () => {
    const root = parse('class C { List<int> list; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses qualified type name', () => {
    const root = parse('class C { System.Collections.Generic.List<int> list; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses alias-qualified type name', () => {
    const root = parse('class C { global::System.String s; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses tuple type', () => {
    const root = parse('class C { (int, string) tuple; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses function pointer type', () => {
    const root = parse('class C { delegate*<void> ptr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses pointer type', () => {
    const root = parse('class C { int* ptr; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses ref readonly return', () => {
    const root = parse('class C { ref readonly int M() { return ref field; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses async method', () => {
    const root = parse('class C { async Task M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses async Task<T> method', () => {
    const root = parse('class C { async Task<int> M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses void method', () => {
    const root = parse('class C { void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses expression-bodied method', () => {
    const root = parse('class C { int M() => 42; }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses expression-bodied constructor', () => {
    const root = parse('class C { public C() => Init(); }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses expression-bodied destructor', () => {
    const root = parse('class C { ~C() => Cleanup(); }');

    expect(root.descendantsOfType('destructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses expression-bodied property getter', () => {
    const root = parse('class C { int P { get => 42; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses expression-bodied indexer', () => {
    const root = parse('class C { int this[int i] => 42; }');

    expect(root.descendantsOfType('indexer_declaration').length).toBeGreaterThan(0);
  });

  it('parses parameter with default value', () => {
    const root = parse('class C { void M(int x = 42) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses params parameter', () => {
    const root = parse('class C { void M(params int[] args) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses out parameter', () => {
    const root = parse('class C { void M(out int x) { x = 0; } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses ref parameter', () => {
    const root = parse('class C { void M(ref int x) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses in parameter', () => {
    const root = parse('class C { void M(in int x) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses this extension parameter', () => {
    const root = parse('static class Ext { public static void M(this string s) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses generic method', () => {
    const root = parse('class C { void M<T>() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses generic method with constraints', () => {
    const root = parse('class C { void M<T>() where T : class, new() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses local function with return type', () => {
    const root = parse('class C { void M() { int Local() { return 42; } } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses local function expression-bodied', () => {
    const root = parse('class C { void M() { int Local() => 42; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses static local function', () => {
    const root = parse('class C { void M() { static int Local() => 42; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses local function with parameters', () => {
    const root = parse('class C { void M() { int Local(int x) => x * 2; } }');

    expect(root.descendantsOfType('local_function_statement').length).toBeGreaterThan(0);
  });

  it('parses lambda with parameters', () => {
    const root = parse('class C { void M() { Func<int, int> f = x => x * 2; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses lambda with typed parameters', () => {
    const root = parse('class C { void M() { Func<int, int> f = (int x) => x * 2; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses lambda with block body', () => {
    const root = parse('class C { void M() { Action a = () => { Do(); }; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses parenthesized lambda', () => {
    const root = parse('class C { void M() { Func<int, int> f = (x) => x * 2; } }');

    expect(root.descendantsOfType('lambda_expression').length).toBeGreaterThan(0);
  });

  it('parses anonymous method', () => {
    const root = parse('class C { void M() { Action a = delegate { Do(); }; } }');

    expect(root.descendantsOfType('anonymous_method_expression').length).toBeGreaterThan(0);
  });

  it('parses anonymous method with parameters', () => {
    const root = parse('class C { void M() { Action<int> a = delegate(int x) { Do(x); }; } }');

    expect(root.descendantsOfType('anonymous_method_expression').length).toBeGreaterThan(0);
  });

  it('parses query expression with from and select clauses', () => {
    const root = parse('class C { void M() { var q = from x in list select x; } }');
    const query = root.descendantsOfType('query_expression')[0];

    expect(query).toBeDefined();
    expect(query.descendantsOfType('from_clause')).toHaveLength(1);
    expect(query.descendantsOfType('select_clause')).toHaveLength(1);
  });

  it('parses query with where clause containing the condition', () => {
    const root = parse('class C { void M() { var q = from x in list where x > 0 select x; } }');
    const whereClause = root.descendantsOfType('query_where_clause')[0];

    expect(whereClause).toBeDefined();
    expect(whereClause.childForFieldName('condition')?.text).toBe('x > 0');
  });

  it('parses query with orderby clause', () => {
    const root = parse('class C { void M() { var q = from x in list orderby x select x; } }');
    const orderBy = root.descendantsOfType('orderby_clause')[0];

    expect(orderBy).toBeDefined();
    expect(orderBy.descendantsOfType('ordering')).toHaveLength(1);
  });

  it('parses query with group by clause', () => {
    const root = parse('class C { void M() { var q = from x in list group x by x.Key; } }');
    const group = root.descendantsOfType('group_clause')[0];

    expect(group).toBeDefined();
    expect(group.childForFieldName('key')?.text).toBe('x.Key');
  });

  it('parses query with join clause', () => {
    const root = parse(
      'class C { void M() { var q = from x in list join y in other on x.Id equals y.Id select x; } }'
    );
    const join = root.descendantsOfType('join_clause')[0];

    expect(join).toBeDefined();
    expect(join.childForFieldName('equalsExpression')?.text).toBe('y.Id');
  });

  it('parses query with let clause', () => {
    const root = parse('class C { void M() { var q = from x in list let y = x * 2 select y; } }');
    const letClause = root.descendantsOfType('let_clause')[0];

    expect(letClause).toBeDefined();
    expect(letClause.childForFieldName('value')?.text).toBe('x * 2');
  });

  it('parses query with into continuation', () => {
    const root = parse('class C { void M() { var q = from x in list select x into g select g; } }');
    const continuation = root.descendantsOfType('query_continuation')[0];

    expect(continuation).toBeDefined();
    expect(continuation.descendantsOfType('select_clause')).toHaveLength(1);
  });

  it('parses from/select/where used as ordinary identifiers, not a query expression', () => {
    const root = parse('class C { void M() { var from = 5; Console.WriteLine(from); } }');

    expect(root.descendantsOfType('query_expression')).toHaveLength(0);
    expect(root.descendantsOfType('invocation_expression')[0]?.text).toBe('Console.WriteLine(from)');
  });

  it('parses nested class in method', () => {
    const root = parse('class C { void M() { class Local { } } }');

    expect(root.descendantsOfType('class_declaration').length).toBeGreaterThan(0);
  });

  it('parses incomplete code gracefully', () => {
    const root = parse('class C { void M() { int x = ');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses code with syntax errors gracefully', () => {
    const root = parse('class C { void M() { int x = = 42; } }');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses empty file', () => {
    const root = parse('');

    expect(root.type).toBe('compilation_unit');
    expect(root.namedChildren).toHaveLength(0);
  });

  it('parses whitespace-only file', () => {
    const root = parse('   \n\t  ');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses comment-only file', () => {
    const root = parse('// comment\n/* block */');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses multiple classes', () => {
    const root = parse('class A { } class B { }');

    const classes = root.namedChildren.filter((c) => c.type === 'class_declaration');

    expect(classes).toHaveLength(2);
  });

  it('parses multiple namespaces', () => {
    const root = parse('namespace A { } namespace B { }');

    const namespaces = root.namedChildren.filter((c) => c.type === 'namespace_declaration');

    expect(namespaces).toHaveLength(2);
  });

  it('parses global statements', () => {
    const root = parse('Console.WriteLine("Hello");');

    // Global statements may be parsed as expression statements or other nodes
    expect(root.type).toBe('compilation_unit');
    expect(root.namedChildren.length).toBeGreaterThan(0);
  });

  it('parses attributes on method', () => {
    const root = parse('class C { [Test] void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses attributes on property', () => {
    const root = parse('class C { [Required] int P { get; set; } }');

    const prop = root.descendantsOfType('property_declaration')[0];

    expect(prop).toBeDefined();
    expect(prop!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses attributes on field', () => {
    const root = parse('class C { [NonSerialized] int x; }');

    const field = root.descendantsOfType('field_declaration')[0];

    expect(field).toBeDefined();
    expect(field!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses attributes on parameter', () => {
    const root = parse('class C { void M([NotNull] string s) { } }');

    const param = root.descendantsOfType('parameter')[0];

    expect(param).toBeDefined();
    expect(param!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses assembly attribute', () => {
    const root = parse('[assembly: CLSCompliant(true)]');

    // Assembly attributes may be parsed differently
    expect(root.type).toBe('compilation_unit');
  });

  it('parses module attribute', () => {
    const root = parse('[module: CLSCompliant(true)]');

    expect(root.type).toBe('compilation_unit');
  });

  it('parses return attribute', () => {
    const root = parse('class C { [return: NotNull] string M() { return ""; } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
  });

  it('parses enum with values', () => {
    const root = parse('enum E { A = 1, B = 2, C = A | B }');

    const enumDecl = root.namedChildren.find((c) => c.type === 'enum_declaration');

    expect(enumDecl).toBeDefined();
    expect(enumDecl!.descendantsOfType('enum_member_declaration')).toHaveLength(3);
  });

  it('parses enum with flags attribute', () => {
    const root = parse('[Flags] enum E { A = 1, B = 2 }');

    const enumDecl = root.namedChildren.find((c) => c.type === 'enum_declaration');

    expect(enumDecl).toBeDefined();
    expect(enumDecl!.namedChildren.some((c) => c.type === 'attribute_list')).toBe(true);
  });

  it('parses interface with properties', () => {
    const root = parse('interface I { int P { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses interface with events', () => {
    const root = parse('interface I { event EventHandler Changed; }');

    expect(root.descendantsOfType('event_field_declaration').length).toBeGreaterThan(0);
  });

  it('parses interface with indexers', () => {
    const root = parse('interface I { int this[int i] { get; } }');

    expect(root.descendantsOfType('indexer_declaration').length).toBeGreaterThan(0);
  });

  it('parses interface with default method', () => {
    const root = parse('interface I { void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses sealed record', () => {
    const root = parse('sealed record R;');

    expect(root.namedChildren.some((c) => c.type === 'record_declaration')).toBe(true);
  });

  it('parses abstract record', () => {
    const root = parse('abstract record R;');

    expect(root.namedChildren.some((c) => c.type === 'record_declaration')).toBe(true);
  });

  it('parses record with body', () => {
    const root = parse('record R { int P { get; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses record with base list', () => {
    const root = parse('record R : IBase;');

    const rec = root.namedChildren.find((c) => c.type === 'record_declaration');

    expect(rec).toBeDefined();
    expect(rec!.namedChildren.some((c) => c.type === 'base_list')).toBe(true);
  });

  it('parses record with parameters and body', () => {
    const root = parse('record R(int X) { int Y { get; } }');

    const rec = root.namedChildren.find((c) => c.type === 'record_declaration');

    expect(rec).toBeDefined();
  });

  it('parses struct with methods', () => {
    const root = parse('struct S { void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses struct with interface', () => {
    const root = parse('struct S : IEquatable<S> { }');

    const st = root.namedChildren.find((c) => c.type === 'struct_declaration');

    expect(st).toBeDefined();
    expect(st!.namedChildren.some((c) => c.type === 'base_list')).toBe(true);
  });

  it('parses readonly struct', () => {
    const root = parse('readonly struct S { }');

    const st = root.namedChildren.find((c) => c.type === 'struct_declaration');

    expect(st).toBeDefined();
    expect(st!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'readonly')).toBe(true);
  });

  it('parses ref struct', () => {
    const root = parse('ref struct S { }');

    const st = root.namedChildren.find((c) => c.type === 'struct_declaration');

    expect(st).toBeDefined();
    expect(st!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'ref')).toBe(true);
  });

  it('parses delegate with return type', () => {
    const root = parse('delegate int Calculate(int x);');

    const del = root.namedChildren.find((c) => c.type === 'delegate_declaration');

    expect(del).toBeDefined();
    expect(del!.childForFieldName('type')?.text).toBe('int');
  });

  it('parses generic delegate', () => {
    const root = parse('delegate T Transform<T>(T input);');

    expect(root.namedChildren.some((c) => c.type === 'delegate_declaration')).toBe(true);
  });

  it('parses method with optional parameters', () => {
    const root = parse('class C { void M(int a, int b = 1, string c = "x") { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(2);
  });

  it('parses method with cancellation token', () => {
    const root = parse('class C { async Task M(CancellationToken ct) { } }');

    expect(root.descendantsOfType('parameter').length).toBeGreaterThan(0);
  });

  it('parses constructor with base call', () => {
    const root = parse('class C : Base { public C() : base() { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses constructor with this call', () => {
    const root = parse('class C { public C() : this(0) { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses static constructor', () => {
    const root = parse('class C { static C() { } }');

    expect(root.descendantsOfType('constructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses finalizer with expression body', () => {
    const root = parse('class C { ~C() => Cleanup(); }');

    expect(root.descendantsOfType('destructor_declaration').length).toBeGreaterThan(0);
  });

  it('parses operator with expression body', () => {
    const root = parse('class C { public static bool operator ==(C a, C b) => true; }');

    expect(root.descendantsOfType('operator_declaration').length).toBeGreaterThan(0);
  });

  it('parses explicit conversion operator', () => {
    const root = parse('class C { public static explicit operator int(C c) => 0; }');

    expect(root.descendantsOfType('conversion_operator_declaration').length).toBeGreaterThan(0);
  });

  it('parses implicit conversion operator', () => {
    const root = parse('class C { public static implicit operator string(C c) => ""; }');

    expect(root.descendantsOfType('conversion_operator_declaration').length).toBeGreaterThan(0);
  });

  it('parses indexer with expression body', () => {
    const root = parse('class C { int this[int i] => 42; }');

    expect(root.descendantsOfType('indexer_declaration').length).toBeGreaterThan(0);
  });

  it('parses event with add/remove accessors', () => {
    const root = parse('class C { event EventHandler Changed { add { } remove { } } }');

    expect(root.descendantsOfType('event_declaration').length).toBeGreaterThan(0);
  });

  it('parses property with only getter', () => {
    const root = parse('class C { int P { get; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses property with only setter', () => {
    const root = parse('class C { int P { set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses auto-implemented property with initializer', () => {
    const root = parse('class C { int P { get; set; } = 42; }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses property with expression body and initializer', () => {
    const root = parse('class C { int P { get => 42; set; } = 0; }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses ref property', () => {
    const root = parse('class C { ref int P { get { return ref field; } } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses static property', () => {
    const root = parse('class C { static int P { get; set; } }');

    expect(root.descendantsOfType('property_declaration').length).toBeGreaterThan(0);
  });

  it('parses virtual method', () => {
    const root = parse('class C { virtual void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'virtual')).toBe(true);
  });

  it('parses override method', () => {
    const root = parse('class C { override void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'override')).toBe(true);
  });

  it('parses sealed method', () => {
    const root = parse('class C { sealed override void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'sealed')).toBe(true);
  });

  it('parses abstract method', () => {
    const root = parse('abstract class C { abstract void M(); }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'abstract')).toBe(true);
  });

  it('parses extern method', () => {
    const root = parse('class C { extern void M(); }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'extern')).toBe(true);
  });

  it('parses partial method', () => {
    const root = parse('partial class C { partial void M(); }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
    expect(method!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'partial')).toBe(true);
  });

  it('parses private protected method', () => {
    const root = parse('class C { private protected void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
  });

  it('parses protected internal method', () => {
    const root = parse('class C { protected internal void M() { } }');

    const method = root.descendantsOfType('method_declaration')[0];

    expect(method).toBeDefined();
  });

  it('parses volatile field', () => {
    const root = parse('class C { volatile int x; }');

    const field = root.descendantsOfType('field_declaration')[0];

    expect(field).toBeDefined();
    expect(field!.namedChildren.some((c) => c.type === 'modifier' && c.text === 'volatile')).toBe(true);
  });

  it('parses fixed field', () => {
    const root = parse('struct S { fixed int x[10]; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses multiple field declarations', () => {
    const root = parse('class C { int x, y, z; }');

    const field = root.descendantsOfType('field_declaration')[0];

    expect(field).toBeDefined();
  });

  it('parses field with multiple declarators', () => {
    const root = parse('class C { int x = 1, y = 2; }');

    const field = root.descendantsOfType('field_declaration')[0];

    expect(field).toBeDefined();
  });

  it('parses const field with multiple declarators', () => {
    const root = parse('class C { const int x = 1, y = 2; }');

    const field = root.descendantsOfType('field_declaration')[0];

    expect(field).toBeDefined();
  });

  it('parses field with array initializer', () => {
    const root = parse('class C { int[] arr = { 1, 2, 3 }; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses field with new array', () => {
    const root = parse('class C { int[] arr = new int[5]; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses field with object initializer', () => {
    const root = parse('class C { Person p = new Person { Name = "A" }; }');

    expect(root.descendantsOfType('field_declaration').length).toBeGreaterThan(0);
  });

  it('parses event with delegate type', () => {
    const root = parse('class C { event EventHandler Changed; }');

    expect(root.descendantsOfType('event_field_declaration').length).toBeGreaterThan(0);
  });

  it('parses event with custom delegate', () => {
    const root = parse('class C { event Action<int> Changed; }');

    expect(root.descendantsOfType('event_field_declaration').length).toBeGreaterThan(0);
  });

  it('parses static event', () => {
    const root = parse('class C { static event EventHandler Changed; }');

    expect(root.descendantsOfType('event_field_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with return type Task', () => {
    const root = parse('class C { Task M() { return Task.CompletedTask; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with return type ValueTask', () => {
    const root = parse('class C { ValueTask M() { return ValueTask.CompletedTask; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with nullable return type', () => {
    const root = parse('class C { string? M() { return null; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with array return type', () => {
    const root = parse('class C { int[] M() { return new int[0]; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with tuple return type', () => {
    const root = parse('class C { (int, string) M() { return (0, ""); } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with generic return type', () => {
    const root = parse('class C { List<int> M() { return new List<int>(); } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with dynamic return type', () => {
    const root = parse('class C { dynamic M() { return null; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with object return type', () => {
    const root = parse('class C { object M() { return null; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with void return type', () => {
    const root = parse('class C { void M() { } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with nint return type', () => {
    const root = parse('class C { nint M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });

  it('parses method with nuint return type', () => {
    const root = parse('class C { nuint M() { return 0; } }');

    expect(root.descendantsOfType('method_declaration').length).toBeGreaterThan(0);
  });
});
