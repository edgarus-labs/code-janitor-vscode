import { describe, expect, it } from 'vitest';
import { SortableMember, calculateNumericRepresentation, createMemberComparer } from '../src/reorganize/comparer';
import { ReorganizeSettings, createDefaultReorganizeSettings } from '../src/reorganize/settings';

function member(overrides: Partial<SortableMember> & Pick<SortableMember, 'name' | 'offset'>): SortableMember {
  return {
    kind: 'field',
    access: 'private',
    isStatic: false,
    isConstant: false,
    isReadOnly: false,
    isExplicitInterface: false,
    ...overrides,
  };
}

function settings(overrides: Partial<ReorganizeSettings> = {}): ReorganizeSettings {
  return { ...createDefaultReorganizeSettings(), ...overrides };
}

function sorted(members: SortableMember[], overrides: Partial<ReorganizeSettings> = {}): string[] {
  return [...members].sort(createMemberComparer(settings(overrides))).map((m) => m.name);
}

// Ported from CodeItemTypeComparerTests.cs.
describe('member comparer (CodeItemTypeComparer)', () => {
  it('sorts items of the same type by name', () => {
    const b = member({ name: 'b', offset: 1 });
    const a = member({ name: 'a', offset: 2 });

    expect(createMemberComparer(settings())(a, b)).toBeLessThan(0);
  });

  it('sorts items of the same type by offset when not alphabetizing', () => {
    const b = member({ name: 'b', offset: 1 });
    const a = member({ name: 'a', offset: 2 });

    expect(createMemberComparer(settings({ alphabetizeMembersOfTheSameGroup: false }))(a, b)).toBeGreaterThan(0);
  });

  it('sorts by group type', () => {
    const method = member({ kind: 'method', name: 'a', offset: 1 });
    const field = member({ kind: 'field', name: 'z', offset: 2 });

    expect(createMemberComparer(settings())(field, method)).toBeLessThan(0);
  });

  it('sorts an explicit interface member by the member name after the interface', () => {
    const z = member({ kind: 'method', name: 'Interface.Z', offset: 1, isExplicitInterface: true });
    const x = member({ kind: 'method', name: 'X', offset: 2 });

    expect(createMemberComparer(settings({ explicitMembersAtEnd: false }))(x, z)).toBeLessThan(0);
  });

  it('places explicit interface members at the end of their group', () => {
    const a = member({ kind: 'method', name: 'Interface.A', offset: 1, isExplicitInterface: true });
    const b = member({ kind: 'method', name: 'B', offset: 2 });

    expect(createMemberComparer(settings({ explicitMembersAtEnd: true }))(b, a)).toBeLessThan(0);
  });
});

describe('member ordering within a group', () => {
  it('orders access levels public to private by default, private to public when reversed', () => {
    const items = [
      member({ kind: 'method', name: 'a', offset: 1, access: 'private' }),
      member({ kind: 'method', name: 'b', offset: 2, access: 'public' }),
      member({ kind: 'method', name: 'c', offset: 3, access: 'protected' }),
      member({ kind: 'method', name: 'd', offset: 4, access: 'internal' }),
      member({ kind: 'method', name: 'e', offset: 5, access: 'protected internal' }),
      member({ kind: 'method', name: 'f', offset: 6, access: 'private protected' }),
    ];

    expect(sorted(items)).toEqual(['b', 'd', 'e', 'c', 'f', 'a']);
    expect(sorted(items, { reverseOrderByAccessLevel: true })).toEqual(['a', 'f', 'c', 'e', 'd', 'b']);
  });

  it('orders by access first when the primary order is by access level', () => {
    const items = [
      member({ kind: 'method', name: 'privateMethod', offset: 1, access: 'private' }),
      member({ kind: 'field', name: 'privateField', offset: 2, access: 'private' }),
      member({ kind: 'method', name: 'publicMethod', offset: 3, access: 'public' }),
      member({ kind: 'field', name: 'publicField', offset: 4, access: 'public' }),
    ];

    expect(sorted(items)).toEqual(['publicField', 'privateField', 'publicMethod', 'privateMethod']);
    expect(sorted(items, { primaryOrderByAccessLevel: true })).toEqual(['publicField', 'publicMethod', 'privateField', 'privateMethod']);
  });

  it('orders fields: constants, static read-only, static, instance read-only, instance', () => {
    const items = [
      member({ name: 'instance', offset: 1 }),
      member({ name: 'instanceReadOnly', offset: 2, isReadOnly: true }),
      member({ name: 'staticField', offset: 3, isStatic: true }),
      member({ name: 'staticReadOnly', offset: 4, isStatic: true, isReadOnly: true }),
      member({ name: 'constant', offset: 5, isStatic: true, isConstant: true }),
    ];

    expect(sorted(items)).toEqual(['constant', 'staticReadOnly', 'staticField', 'instanceReadOnly', 'instance']);
  });

  it('orders static members before instance members of the same kind', () => {
    const items = [member({ kind: 'method', name: 'a', offset: 1 }), member({ kind: 'method', name: 'b', offset: 2, isStatic: true })];

    expect(sorted(items)).toEqual(['b', 'a']);
  });

  it('follows a configured member type order', () => {
    const custom = createDefaultReorganizeSettings().memberTypes;
    custom.methods = { order: 1, name: 'Methods' };
    const items = [member({ kind: 'field', name: 'f', offset: 1 }), member({ kind: 'method', name: 'm', offset: 2 })];

    expect(sorted(items, { memberTypes: custom })).toEqual(['m', 'f']);
  });

  it('computes the weighted key of the VS comparer', () => {
    const publicStaticMethod = member({ kind: 'method', name: 'm', offset: 1, access: 'public', isStatic: true });

    // method order 10 * 100000 + public (1) * 10000 + explicit 0 + constant 0 + static 0 + read-only 0
    expect(calculateNumericRepresentation(publicStaticMethod, settings())).toBe(10 * 100000 + 1 * 10000);
    expect(calculateNumericRepresentation(publicStaticMethod, settings({ primaryOrderByAccessLevel: true }))).toBe(1 * 100000 + 10 * 10000);
  });

  it('compares names like a culture-aware comparer', () => {
    const items = [member({ name: 'b', offset: 1 }), member({ name: 'B', offset: 2 }), member({ name: 'a', offset: 3 }), member({ name: '_c', offset: 4 })];

    expect(sorted(items)).toEqual(['_c', 'a', 'b', 'B']);
  });
});
