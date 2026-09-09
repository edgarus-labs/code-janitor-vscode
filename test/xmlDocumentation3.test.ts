import { describe, expect, it } from 'vitest';
import { parseCSharp } from '../src/cleanup/parser';
import { buildFallbackSummary } from '../src/cleanup/xmlDocumentation';

describe('buildFallbackSummary', () => {
  function parseMember(source: string, type: string) {
    const tree = parseCSharp(source);
    const members = tree.rootNode.descendantsOfType(type);
    tree.delete();

    return members[0];
  }

  it('builds class summary', () => {
    const member = parseMember('class MyClass { }', 'class_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents my class.');
  });

  it('builds interface summary', () => {
    const member = parseMember('interface IMyService { }', 'interface_declaration');

    // splitIdentifier splits "IMyService" as "imy service" (leading I is kept)
    expect(buildFallbackSummary(member)).toBe('Defines a contract for imy service.');
  });

  it('builds command summary', () => {
    const member = parseMember('class CreateOrderCommand { }', 'class_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents a command to create order.');
  });

  it('builds query summary', () => {
    const member = parseMember('class GetUserQuery { }', 'class_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents a query to retrieve get user.');
  });

  it('builds dto summary', () => {
    const member = parseMember('class UserDto { }', 'class_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents the data structure for user dto.');
  });

  it('builds response summary', () => {
    const member = parseMember('class ApiResponse { }', 'class_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents the data structure for api response.');
  });

  it('builds property summary', () => {
    const member = parseMember('class C { string Name { get; set; } }', 'property_declaration');

    expect(buildFallbackSummary(member)).toBe('Gets or sets the name.');
  });

  it('builds bool property summary', () => {
    const member = parseMember('class C { bool IsActive { get; set; } }', 'property_declaration');

    expect(buildFallbackSummary(member)).toBe('Gets or sets a value indicating whether is active.');
  });

  it('builds collection property summary', () => {
    const member = parseMember('class C { List<string> Items { get; set; } }', 'property_declaration');

    expect(buildFallbackSummary(member)).toBe('Gets or sets the collection of items.');
  });

  it('builds field summary', () => {
    const member = parseMember('class C { private int _count; }', 'field_declaration');

    expect(buildFallbackSummary(member)).toBe('The count.');
  });

  it('builds indexer summary', () => {
    const member = parseMember('class C { int this[int i] { get => 0; } }', 'indexer_declaration');

    expect(buildFallbackSummary(member)).toBe('Gets or sets the element at the specified index.');
  });

  it('builds event summary', () => {
    const member = parseMember('class C { event EventHandler Changed; }', 'event_field_declaration');

    expect(buildFallbackSummary(member)).toBe('Occurs when changed.');
  });

  it('builds method summary', () => {
    const member = parseMember('class C { void DoWork() { } }', 'method_declaration');

    expect(buildFallbackSummary(member)).toBe('Executes do work.');
  });

  it('builds enum summary', () => {
    const member = parseMember('enum Color { Red, Green }', 'enum_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents color.');
  });

  it('builds struct summary', () => {
    const member = parseMember('struct Point { }', 'struct_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents point.');
  });

  it('builds record summary', () => {
    const member = parseMember('record Person(string Name);', 'record_declaration');

    expect(buildFallbackSummary(member)).toBe('Represents person.');
  });
});
