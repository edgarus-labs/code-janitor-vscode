import { describe, expect, it } from 'vitest';
import { findAll, parseCSharp } from '../src/cleanup/parser';

// The reorganizer moves members as whole syntax nodes, so every member form must parse as one node.
describe('explicit interface implementations parse as single members', () => {
  const source = [
    'class C : I',
    '{',
    '    int I.this[int i] { get => 0; }',
    '    event System.Action I.E { add { } remove { } }',
    '    int I.P { get; set; }',
    '    void I.M() { }',
    '}',
    '',
  ].join('\n');

  it('parses an explicit indexer and an explicit event accessor form without recovery', () => {
    const tree = parseCSharp(source);
    const members = findAll(tree.rootNode, 'declaration_list')[0].namedChildren.map((node) => node.type);

    expect(members).toEqual(['indexer_declaration', 'event_declaration', 'property_declaration', 'method_declaration']);
    expect(findAll(tree.rootNode, 'incomplete_declaration')).toEqual([]);
  });

  it('keeps the explicit interface specifier on the indexer and the event', () => {
    const tree = parseCSharp(source);
    const [indexer, event] = findAll(tree.rootNode, 'declaration_list')[0].namedChildren;

    expect(indexer.namedChildren.some((child) => child.type === 'explicit_interface_specifier')).toBe(true);
    expect(event.namedChildren.some((child) => child.type === 'explicit_interface_specifier')).toBe(true);
    expect(event.childForFieldName('name')?.text).toBe('E');
  });
});
