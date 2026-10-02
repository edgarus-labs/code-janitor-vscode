import { AccessLevel, MemberKind, memberTypeKey } from './comparer';
import { MEMBER_TYPE_KEYS, MemberTypeKey, ReorganizeSettings } from './settings';
import { Entry } from './structure';
import { MemberInfo } from './memberInfo';

/**
 * Region names the way `GenerateRegionLogic` composes them. Regions are compared by name
 * (`RegionComparerByName`): two regions are the same when their names are equal.
 */

/** The access levels of the regions that are kept when empty (`GenerateRegionLogic.AccessModifiers`). */
const ALL_POSSIBLE_ACCESS: readonly AccessLevel[] = ['public', 'internal', 'protected internal', 'protected', 'private'];

/** Constructors and destructors are methods of the code model, so "methods only" covers them. */
const METHOD_KINDS: ReadonlySet<MemberKind> = new Set<MemberKind>(['method', 'constructor', 'destructor']);

export function titleCase(access: AccessLevel): string {
  return access.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export class RegionNamer {
  constructor(private readonly settings: ReorganizeSettings) {}

  /** The region a member belongs in, or `undefined` when its kind has none (namespaces). */
  nameOf(info: Pick<MemberInfo, 'kind' | 'access'>): string | undefined {
    const key = memberTypeKey(info.kind);
    if (!key) {
      return undefined;
    }

    const name = this.groupName(key);
    if (this.settings.regionsIncludeAccessLevel && (!this.settings.regionsIncludeAccessLevelForMethodsOnly || METHOD_KINDS.has(info.kind))) {
      return `${titleCase(info.access)} ${name}`;
    }

    return name;
  }

  /**
   * The names of a set of entries: those of their members, plus those of existing regions that
   * hold a member of that very name (`ComposePresentTypesRegionsList`); every possible name when
   * empty regions are kept (`ComposeAllPossibleRegionsList`).
   */
  composedNames(entries: readonly Entry[]): Set<string> {
    if (this.settings.regionsInsertKeepEvenIfEmpty) {
      return new Set(this.allPossibleNames());
    }

    return this.presentNames(entries);
  }

  /** All names in the order their regions appear in a sorted class. */
  allPossibleNames(): string[] {
    const groups = this.groups();
    const names: string[] = [];
    const add = (name: string): void => {
      if (!names.includes(name)) {
        names.push(name);
      }
    };

    const variants = (group: MemberTypeKey[], access: AccessLevel): string => {
      const methodLike = group.some((key) => isMethodKey(key));
      const name = this.groupName(group[0]);

      return this.settings.regionsIncludeAccessLevel && (!this.settings.regionsIncludeAccessLevelForMethodsOnly || methodLike) ? `${titleCase(access)} ${name}` : name;
    };

    const accessLevels = this.settings.reverseOrderByAccessLevel ? [...ALL_POSSIBLE_ACCESS].reverse() : ALL_POSSIBLE_ACCESS;

    if (this.settings.primaryOrderByAccessLevel) {
      for (const access of accessLevels) {
        for (const group of groups) {
          add(variants(group, access));
        }
      }
    } else {
      for (const group of groups) {
        for (const access of accessLevels) {
          add(variants(group, access));
        }
      }
    }

    return names;
  }

  private presentNames(entries: readonly Entry[]): Set<string> {
    const names = new Set<string>();

    for (const entry of entries) {
      if (entry.kind === 'member') {
        const name = this.nameOf(entry.info);
        if (name !== undefined) {
          names.add(name);
        }
      } else if (entry.kind === 'region' && this.presentNames(entry.children).has(entry.name)) {
        names.add(entry.name);
      }
    }

    return names;
  }

  /** The member types that share one order: sorted together and held by one region. */
  private groups(): MemberTypeKey[][] {
    const byOrder = new Map<number, MemberTypeKey[]>();
    for (const key of MEMBER_TYPE_KEYS) {
      const order = this.settings.memberTypes[key].order;
      byOrder.set(order, [...(byOrder.get(order) ?? []), key]);
    }

    return [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, keys]) => keys);
  }

  /** A group's region is named after the first member type of the group, as in the VS options dialog. */
  private groupName(key: MemberTypeKey): string {
    const order = this.settings.memberTypes[key].order;
    const first = MEMBER_TYPE_KEYS.find((candidate) => this.settings.memberTypes[candidate].order === order) ?? key;

    return this.settings.memberTypes[first].name;
  }
}

function isMethodKey(key: MemberTypeKey): boolean {
  return key === 'methods' || key === 'constructors' || key === 'destructors';
}
