/**
 * Reorganize settings: the `Reorganizing_*` settings of the Visual Studio extension with the same
 * defaults (Properties/Settings.settings), keyed the way the `codeJanitor.reorganize.*` VS Code
 * settings are named.
 */

/** The member types the order can be configured for, one per `Reorganizing_MemberType*` setting. */
export const MEMBER_TYPE_KEYS = [
  'classes',
  'constructors',
  'delegates',
  'destructors',
  'enums',
  'events',
  'fields',
  'indexers',
  'interfaces',
  'methods',
  'properties',
  'structs',
] as const;

export type MemberTypeKey = (typeof MEMBER_TYPE_KEYS)[number];

/**
 * Where a member type goes and what its region is called. Member types sharing an `order` form one
 * group: they are sorted together and share a region (named after the first of the group).
 */
export interface MemberTypeSetting {
  order: number;
  name: string;
}

/** `Reorganizing_PerformWhenPreprocessorConditionals`: VS `AskYesNo` (Ask = 0, Yes = 1, No = 2). */
export type PreprocessorPolicy = 'ask' | 'yes' | 'no';

export interface ReorganizeSettings {
  alphabetizeMembersOfTheSameGroup: boolean;
  explicitMembersAtEnd: boolean;
  keepMembersWithinRegions: boolean;
  performWhenPreprocessorConditionals: PreprocessorPolicy;
  primaryOrderByAccessLevel: boolean;
  reverseOrderByAccessLevel: boolean;
  runAtStartOfCleanup: boolean;
  regionsIncludeAccessLevel: boolean;
  regionsIncludeAccessLevelForMethodsOnly: boolean;
  regionsInsertKeepEvenIfEmpty: boolean;
  regionsInsertNewRegions: boolean;
  regionsRemoveExistingRegions: boolean;
  memberTypes: Record<MemberTypeKey, MemberTypeSetting>;
}

/** The default name of a member type (`DefaultName` of the VS `MemberTypeSetting`). */
export function defaultMemberTypeName(key: MemberTypeKey): string {
  return key[0].toUpperCase() + key.slice(1);
}

const DEFAULT_ORDER: Record<MemberTypeKey, number> = {
  fields: 1,
  constructors: 2,
  destructors: 3,
  delegates: 4,
  events: 5,
  enums: 6,
  interfaces: 7,
  properties: 8,
  indexers: 9,
  methods: 10,
  structs: 11,
  classes: 12,
};

export function createDefaultMemberTypes(): Record<MemberTypeKey, MemberTypeSetting> {
  const memberTypes = {} as Record<MemberTypeKey, MemberTypeSetting>;
  for (const key of MEMBER_TYPE_KEYS) {
    memberTypes[key] = { order: DEFAULT_ORDER[key], name: defaultMemberTypeName(key) };
  }

  return memberTypes;
}

export function createDefaultReorganizeSettings(): ReorganizeSettings {
  return {
    alphabetizeMembersOfTheSameGroup: true,
    explicitMembersAtEnd: false,
    keepMembersWithinRegions: true,
    performWhenPreprocessorConditionals: 'ask',
    primaryOrderByAccessLevel: false,
    reverseOrderByAccessLevel: false,
    runAtStartOfCleanup: false,
    regionsIncludeAccessLevel: false,
    regionsIncludeAccessLevelForMethodsOnly: false,
    regionsInsertKeepEvenIfEmpty: false,
    regionsInsertNewRegions: false,
    regionsRemoveExistingRegions: false,
    memberTypes: createDefaultMemberTypes(),
  };
}

/** `Fields||1||Member Variables` (the VS serialization of one member type setting). */
export function serializeMemberTypeSetting(defaultName: string, setting: MemberTypeSetting): string {
  return `${defaultName}||${setting.order}||${setting.name}`;
}

export function parseMemberTypeSetting(text: string): { defaultName: string; order: number; effectiveName: string } | undefined {
  const match = /^(\w+)\|\|(\d+)\|\|(.*)$/.exec(text);

  return match ? { defaultName: match[1], order: Number(match[2]), effectiveName: match[3] } : undefined;
}

const FLAG_KEYS = [
  'alphabetizeMembersOfTheSameGroup',
  'explicitMembersAtEnd',
  'keepMembersWithinRegions',
  'primaryOrderByAccessLevel',
  'reverseOrderByAccessLevel',
  'runAtStartOfCleanup',
  'regionsIncludeAccessLevel',
  'regionsIncludeAccessLevelForMethodsOnly',
  'regionsInsertKeepEvenIfEmpty',
  'regionsInsertNewRegions',
  'regionsRemoveExistingRegions',
] as const;

/**
 * Reads the settings through `get` (a `WorkspaceConfiguration.get` of the `codeJanitor.reorganize`
 * section, in the tests a map lookup). A value of the wrong type falls back to the default. Each
 * member type has two settings, `<type>Order` and `<type>Name` (`fieldsOrder`, `fieldsName`).
 */
export function parseReorganizeSettings(get: (key: string) => unknown): ReorganizeSettings {
  const settings = createDefaultReorganizeSettings();

  for (const key of FLAG_KEYS) {
    const value = get(key);
    if (typeof value === 'boolean') {
      settings[key] = value;
    }
  }

  const policy = get('performWhenPreprocessorConditionals');
  if (policy === 'ask' || policy === 'yes' || policy === 'no') {
    settings.performWhenPreprocessorConditionals = policy;
  }

  for (const key of MEMBER_TYPE_KEYS) {
    const order = get(`${key}Order`);
    if (typeof order === 'number' && Number.isInteger(order) && order >= 0) {
      settings.memberTypes[key].order = order;
    }

    const name = get(`${key}Name`);
    if (typeof name === 'string' && name.trim() !== '') {
      settings.memberTypes[key].name = name.trim();
    }
  }

  return settings;
}
