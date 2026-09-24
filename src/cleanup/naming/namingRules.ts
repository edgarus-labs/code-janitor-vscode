import { EditorConfigProperties, EditorConfigSeverity } from '../editorconfig';
import { Capitalization, NamingStyle } from './namingStyle';

/**
 * `.editorconfig` naming rules parsed and ordered exactly as Roslyn's
 * `EditorConfigNamingStyleParser` does, and matched against symbols as `SymbolSpecification.AppliesTo`.
 */

export type NamingSymbolKind =
  | 'namespace'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'property'
  | 'method'
  | 'local_function'
  | 'field'
  | 'event'
  | 'delegate'
  | 'parameter'
  | 'type_parameter'
  | 'local';

/** Roslyn accessibility as the naming rules name it; `local` is Roslyn's `NotApplicable`. */
export type NamingAccessibility =
  | 'local'
  | 'public'
  | 'internal'
  | 'private'
  | 'protected'
  | 'protected_internal'
  | 'private_protected';

export type NamingModifier = 'abstract' | 'async' | 'const' | 'readonly' | 'static';

/** What a naming rule needs to know about a declared symbol. */
export interface NamingSymbolTraits {
  readonly kind: NamingSymbolKind;
  readonly accessibility: NamingAccessibility;
  /** Modifiers as Roslyn's `ISymbol` reports them (a `const` field is also `static`). */
  readonly modifiers: ReadonlySet<NamingModifier>;
}

export interface NamingRule {
  readonly title: string;
  readonly kinds: readonly NamingSymbolKind[];
  readonly accessibilities: readonly NamingAccessibility[];
  readonly modifiers: readonly NamingModifier[];
  readonly style: NamingStyle;
  readonly severity: EditorConfigSeverity;
  readonly priority: number;
}

const allKinds: readonly NamingSymbolKind[] = [
  'namespace',
  'class',
  'struct',
  'interface',
  'enum',
  'property',
  'method',
  'local_function',
  'field',
  'event',
  'delegate',
  'parameter',
  'type_parameter',
  'local',
];

const allAccessibilities: readonly NamingAccessibility[] = [
  'local',
  'public',
  'internal',
  'private',
  'protected',
  'private_protected',
  'protected_internal',
];

const allModifiers: readonly NamingModifier[] = ['abstract', 'async', 'const', 'readonly', 'static'];

const kindByName: Record<string, NamingSymbolKind> = Object.fromEntries(allKinds.map((kind) => [kind, kind]));

const accessibilityByName: Record<string, NamingAccessibility> = {
  public: 'public',
  internal: 'internal',
  friend: 'internal',
  private: 'private',
  protected: 'protected',
  protected_internal: 'protected_internal',
  protected_friend: 'protected_internal',
  private_protected: 'private_protected',
  local: 'local',
};

const modifierByName: Record<string, NamingModifier> = {
  abstract: 'abstract',
  must_inherit: 'abstract',
  async: 'async',
  const: 'const',
  readonly: 'readonly',
  static: 'static',
  shared: 'static',
};

const capitalizations: readonly Capitalization[] = [
  'pascal_case',
  'camel_case',
  'first_word_upper',
  'all_upper',
  'all_lower',
];

// Roslyn's `ParseEnforcementLevel`: anything unrecognized is `silent` (hidden).
const ruleSeverityByName: Record<string, EditorConfigSeverity> = {
  none: 'none',
  refactoring: 'silent',
  silent: 'silent',
  suggestion: 'suggestion',
  warning: 'warning',
  error: 'error',
};

/**
 * Parses every complete `dotnet_naming_rule.<title>` (symbols, style with capitalization, severity)
 * and orders the rules by priority, then specificity (modifiers, accessibilities, kinds), then title.
 */
export function parseNamingRules(props: EditorConfigProperties): NamingRule[] {
  const titles = new Set<string>();
  for (const key of props.entries.keys()) {
    const parts = key.trim().split('.');
    if (key.trim().startsWith('dotnet_naming_rule.') && parts.length === 3) {
      titles.add(parts[1]);
    }
  }

  const rules: NamingRule[] = [];
  for (const title of titles) {
    const rule = parseRule(props, title);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules.sort(compareRules);
}

/** The first rule whose symbol specification applies decides, compliant or not (Roslyn semantics). */
export function findApplicableRule(rules: readonly NamingRule[], symbol: NamingSymbolTraits): NamingRule | undefined {
  return rules.find(
    (rule) =>
      rule.kinds.includes(symbol.kind) &&
      rule.accessibilities.includes(symbol.accessibility) &&
      rule.modifiers.every((modifier) => symbol.modifiers.has(modifier))
  );
}

function parseRule(props: EditorConfigProperties, title: string): NamingRule | undefined {
  const symbolsName = props.get(`dotnet_naming_rule.${title}.symbols`);
  const styleName = props.get(`dotnet_naming_rule.${title}.style`);
  const severityText = props.get(`dotnet_naming_rule.${title}.severity`);
  if (symbolsName === undefined || styleName === undefined || severityText === undefined) {
    return undefined;
  }

  const capitalization = props.get(`dotnet_naming_style.${styleName}.capitalization`);
  if (capitalization === undefined || !(capitalizations as readonly string[]).includes(capitalization)) {
    return undefined;
  }

  const symbolKey = (component: string) => props.get(`dotnet_naming_symbols.${symbolsName}.${component}`);
  const priority = Number.parseInt(props.get(`dotnet_naming_rule.${title}.priority`) ?? '', 10);

  return {
    title,
    kinds: parseList(symbolKey('applicable_kinds'), kindByName, allKinds),
    accessibilities: parseList(symbolKey('applicable_accessibilities'), accessibilityByName, allAccessibilities),
    modifiers: parseList(symbolKey('required_modifiers'), modifierByName, allModifiers, []),
    style: new NamingStyle(
      props.get(`dotnet_naming_style.${styleName}.required_prefix`) ?? '',
      props.get(`dotnet_naming_style.${styleName}.required_suffix`) ?? '',
      props.get(`dotnet_naming_style.${styleName}.word_separator`) ?? '',
      capitalization as Capitalization
    ),
    severity: Object.hasOwn(ruleSeverityByName, severityText) ? ruleSeverityByName[severityText] : 'silent',
    priority: Number.isNaN(priority) ? 0 : priority,
  };
}

/** Comma-separated list; `*` means all; a missing key defaults to `whenMissing`. */
function parseList<T>(
  raw: string | undefined,
  byName: Record<string, T>,
  all: readonly T[],
  whenMissing: readonly T[] = all
): T[] {
  if (raw === undefined) {
    return [...whenMissing];
  }

  if (raw.trim() === '*') {
    return [...all];
  }

  const values: T[] = [];
  for (const name of raw.split(',').map((part) => part.trim())) {
    if (Object.hasOwn(byName, name)) {
      values.push(byName[name]);
    }
  }

  return values;
}

function compareRules(x: NamingRule, y: NamingRule): number {
  return (
    x.priority - y.priority ||
    compareSubsets(x, y, modifiersAreSubset) ||
    compareSubsets(x, y, (a, b) => a.accessibilities.every((accessibility) => b.accessibilities.includes(accessibility))) ||
    compareSubsets(x, y, (a, b) => a.kinds.every((kind) => b.kinds.includes(kind))) ||
    compareOrdinal(x.title.toUpperCase(), y.title.toUpperCase()) ||
    compareOrdinal(x.title, y.title)
  );
}

/** Roslyn `NamingRuleSubsetComparer`: the rule matching a subset of the other's symbols sorts first. */
function compareSubsets(x: NamingRule, y: NamingRule, firstIsSubset: (a: NamingRule, b: NamingRule) => boolean): number {
  const xIsSubset = firstIsSubset(x, y);
  const yIsSubset = firstIsSubset(y, x);
  if (xIsSubset) {
    return yIsSubset ? 0 : -1;
  }

  return yIsSubset ? 1 : 0;
}

/** Modifiers are "match all", so `x` matches a subset when it requires a superset; `const` implies `static`/`readonly`. */
function modifiersAreSubset(x: NamingRule, y: NamingRule): boolean {
  return y.modifiers.every(
    (modifier) =>
      x.modifiers.includes(modifier) ||
      ((modifier === 'static' || modifier === 'readonly') && x.modifiers.includes('const'))
  );
}

function compareOrdinal(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
