import { MemberTypeKey, ReorganizeSettings } from './settings';

/** The kinds of code item the reorganizer orders (`KindCodeItem` of the VS extension). */
export type MemberKind =
  | 'class'
  | 'constructor'
  | 'delegate'
  | 'destructor'
  | 'enum'
  | 'event'
  | 'field'
  | 'indexer'
  | 'interface'
  | 'method'
  | 'property'
  | 'struct'
  | 'namespace';

/**
 * Access levels in the VS `vsCMAccess` order (public, internal, protected internal, protected,
 * private). `private protected` has no entry in VS; here it sits between protected and private.
 */
export type AccessLevel = 'public' | 'internal' | 'protected internal' | 'protected' | 'private protected' | 'private';

const ACCESS_ORDER: readonly AccessLevel[] = ['public', 'internal', 'protected internal', 'protected', 'private protected', 'private'];

/** What the comparer needs to know about one code item. */
export interface SortableMember {
  kind: MemberKind;
  name: string;
  access: AccessLevel;
  isStatic: boolean;
  /** A `const` field. */
  isConstant: boolean;
  /** A `readonly` field. */
  isReadOnly: boolean;
  isExplicitInterface: boolean;
  /** Position in the file, the final tie-breaker. */
  offset: number;
}

/** The member type setting a kind is ordered by; a namespace sorts before every member type. */
export function memberTypeKey(kind: MemberKind): MemberTypeKey | undefined {
  switch (kind) {
    case 'class':
      return 'classes';
    case 'constructor':
      return 'constructors';
    case 'delegate':
      return 'delegates';
    case 'destructor':
      return 'destructors';
    case 'enum':
      return 'enums';
    case 'event':
      return 'events';
    case 'field':
      return 'fields';
    case 'indexer':
      return 'indexers';
    case 'interface':
      return 'interfaces';
    case 'method':
      return 'methods';
    case 'property':
      return 'properties';
    case 'struct':
      return 'structs';
    default:
      return undefined;
  }
}

const nameCollator = new Intl.Collator('en-US');

/**
 * `CodeItemTypeComparer`: the order of two code items. Type and access level (whichever is primary)
 * are compared term by term rather than in the VS weighted key, where a member type order of 10 or
 * more outweighs one access step when the access level is primary.
 */
export function createMemberComparer(settings: ReorganizeSettings): (a: SortableMember, b: SortableMember) => number {
  const accessOrder = settings.reverseOrderByAccessLevel ? [...ACCESS_ORDER].reverse() : ACCESS_ORDER;
  const typeOrder = (member: SortableMember): number => {
    const key = memberTypeKey(member.kind);

    return key ? settings.memberTypes[key].order : 0;
  };
  const accessRank = (member: SortableMember): number => accessOrder.indexOf(member.access);
  const [primary, secondary] = settings.primaryOrderByAccessLevel ? [accessRank, typeOrder] : [typeOrder, accessRank];

  return (a, b) => {
    const difference = primary(a) - primary(b) || secondary(a) - secondary(b) || minorWeight(a, settings) - minorWeight(b, settings);
    if (difference !== 0) {
      return difference;
    }

    if (settings.alphabetizeMembersOfTheSameGroup) {
      const byName = nameCollator.compare(normalizeName(a), normalizeName(b));
      if (byName !== 0) {
        return byName;
      }
    }

    return a.offset - b.offset;
  };
}

/** The VS weights below type and access level: explicit interface implementation, then constant, static and read-only fields. */
function minorWeight(member: SortableMember, settings: ReorganizeSettings): number {
  const explicitOffset = settings.explicitMembersAtEnd && member.isExplicitInterface ? 1 : 0;
  const constantOffset = member.kind === 'field' && !member.isConstant ? 1 : 0;
  const staticOffset = member.isStatic ? 0 : 1;
  const readOnlyOffset = member.kind === 'field' && !member.isReadOnly ? 1 : 0;

  return explicitOffset * 1000 + constantOffset * 100 + staticOffset * 10 + readOnlyOffset;
}

/** The member name after the last dot for an explicit interface implementation. */
function normalizeName(member: SortableMember): string {
  if (member.isExplicitInterface) {
    const dot = member.name.lastIndexOf('.') + 1;
    if (dot > 0 && dot < member.name.length) {
      return member.name.slice(dot);
    }
  }

  return member.name;
}
