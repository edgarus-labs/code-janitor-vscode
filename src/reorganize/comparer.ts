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

/** `CodeItemTypeComparer`: the order of two code items. */
export function createMemberComparer(settings: ReorganizeSettings): (a: SortableMember, b: SortableMember) => number {
  return (a, b) => {
    const first = calculateNumericRepresentation(a, settings);
    const second = calculateNumericRepresentation(b, settings);

    if (first === second) {
      if (settings.alphabetizeMembersOfTheSameGroup) {
        const byName = nameCollator.compare(normalizeName(a), normalizeName(b));
        if (byName !== 0) {
          return byName;
        }
      }

      return a.offset - b.offset;
    }

    return first - second;
  };
}

/**
 * The weighted sort key: type and access level (whichever is primary), then explicit interface
 * implementation, constant, static and read-only fields, in the VS weights.
 */
export function calculateNumericRepresentation(member: SortableMember, settings: ReorganizeSettings): number {
  const typeOffset = calculateTypeOffset(member, settings);
  const accessOffset = calculateAccessOffset(member, settings);
  const explicitOffset = settings.explicitMembersAtEnd && member.isExplicitInterface ? 1 : 0;
  const constantOffset = member.kind === 'field' && !member.isConstant ? 1 : 0;
  const staticOffset = member.isStatic ? 0 : 1;
  const readOnlyOffset = member.kind === 'field' && !member.isReadOnly ? 1 : 0;

  const primary = settings.primaryOrderByAccessLevel ? accessOffset * 100000 + typeOffset * 10000 : typeOffset * 100000 + accessOffset * 10000;

  return primary + explicitOffset * 1000 + constantOffset * 100 + staticOffset * 10 + readOnlyOffset;
}

function calculateTypeOffset(member: SortableMember, settings: ReorganizeSettings): number {
  const key = memberTypeKey(member.kind);

  return key ? settings.memberTypes[key].order : 0;
}

function calculateAccessOffset(member: SortableMember, settings: ReorganizeSettings): number {
  const order = settings.reverseOrderByAccessLevel ? [...ACCESS_ORDER].reverse() : ACCESS_ORDER;

  return order.indexOf(member.access) + 1;
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
