import { MemberTypeKey, MemberTypeSetting } from '../cleanup/reorganizeSettings';

/**
 * The model of the Spade view (the Visual Studio Spade tool window): the C# engine's `structure` query turned into
 * the tree Spade shows, in file order with the regions (`CodeTreeBuilder.OrganizeCodeItemsByFileSortOrder`), by type
 * in pseudo-groups (`CodeItemTypeComparer`, `RecursivelyGroupByType`) or alphabetically (`CodeItemNameComparer`),
 * filtered by name (`RecursivelyFilter`), and the text each item shows (`NameParametersToTextBlockConverter`,
 * `CodeItemToMetadataStringConverter`).
 */

/** The `structure` query's result (`server/src/CodeJanitor.Engine/Queries/StructureQuery.cs`); lines are 0-based. */
export interface Structure {
  readonly items: readonly StructureItem[];
  readonly regions: readonly StructureRegion[];
}

export interface StructureItem {
  readonly kind: string;
  readonly name: string;
  readonly access: string | null;
  readonly modifiers: readonly string[];
  readonly returnType: string | null;
  readonly parameters: readonly { readonly name: string; readonly type: string }[];
  readonly typeParameters: readonly string[];
  readonly baseTypes: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly complexity: number | null;
  readonly accessors: readonly { readonly kind: string; readonly startLine: number; readonly endLine: number; readonly complexity: number }[];
  readonly children: readonly StructureItem[];
}

export interface StructureRegion {
  readonly name: string;
  readonly startLine: number;
  /** Null for a region without `#endregion`. */
  readonly endLine: number | null;
  readonly children: readonly StructureRegion[];
}

export type SpadeSortOrder = 'file' | 'type' | 'alphabetical';

/** What the view's menus test: `group` is a pseudo-group of the type sort order, which no command acts on. */
export type SpadeContextValue = 'namespace' | 'type' | 'member' | 'region' | 'group';

export interface SpadeNode {
  /** Stable across refreshes while the item keeps its name and place: the path of kinds and names. */
  readonly id: string;
  readonly contextValue: SpadeContextValue;
  /** The structure kind, `region` or `group`. */
  readonly kind: string;
  readonly name: string;
  readonly item: StructureItem | undefined;
  readonly startLine: number;
  readonly endLine: number;
  readonly parent: SpadeNode | undefined;
  readonly children: readonly SpadeNode[];
}

export interface SpadeTreeOptions {
  sortOrder: SpadeSortOrder;
  secondarySortTypeByName: boolean;
  memberTypes: Readonly<Record<MemberTypeKey, MemberTypeSetting>>;
  primaryOrderByAccessLevel: boolean;
  reverseOrderByAccessLevel: boolean;
  /** Keeps the items whose name holds it, ignoring case, and their parents; empty keeps everything. */
  filter: string;
}

export interface SpadeDisplayOptions {
  showItemMetadata: boolean;
  showItemTypes: boolean;
  showMethodParameters: boolean;
  showItemComplexity: boolean;
  complexityWarningThreshold: number;
  complexityAlertThreshold: number;
}

export interface SpadeNodeDisplay {
  label: string;
  description: string;
  tooltip: string;
  /** A codicon id. */
  icon: string;
  complexity: 'none' | 'warning' | 'alert';
}

/** The arguments of the engine's `moveMember` command. */
export interface DropPlan {
  line: number;
  name: string;
  targetLine: number;
  targetName: string;
  position: 'before' | 'after';
}

interface MutableNode extends SpadeNode {
  id: string;
  parent: MutableNode | undefined;
  children: MutableNode[];
}

const PARENT_KINDS: Readonly<Record<string, true>> = { namespace: true, class: true, struct: true, record: true, interface: true, enum: true };
const TYPE_KINDS: Readonly<Record<string, true>> = { class: true, struct: true, record: true, interface: true, enum: true, delegate: true };
const ACCESS_ORDER = ['public', 'internal', 'protected internal', 'protected', 'private protected', 'private'];
// Maps and sets: the kind `constructor` would read `Object.prototype.constructor` from an object.
const MEMBER_TYPE_OF = new Map<string, MemberTypeKey>([
  ['class', 'classes'],
  ['record', 'classes'],
  ['struct', 'structs'],
  ['interface', 'interfaces'],
  ['enum', 'enums'],
  ['delegate', 'delegates'],
  ['field', 'fields'],
  ['constant', 'fields'],
  ['event', 'events'],
  ['property', 'properties'],
  ['indexer', 'indexers'],
  ['method', 'methods'],
  ['operator', 'methods'],
  ['conversion', 'methods'],
  ['constructor', 'constructors'],
  ['destructor', 'destructors'],
]);
const ICONS = new Map<string, string>([
  ['namespace', 'symbol-namespace'],
  ['class', 'symbol-class'],
  ['record', 'symbol-class'],
  ['struct', 'symbol-struct'],
  ['interface', 'symbol-interface'],
  ['enum', 'symbol-enum'],
  ['enumMember', 'symbol-enum-member'],
  ['delegate', 'symbol-method'],
  ['field', 'symbol-field'],
  ['constant', 'symbol-constant'],
  ['event', 'symbol-event'],
  ['property', 'symbol-property'],
  ['indexer', 'symbol-property'],
  ['method', 'symbol-method'],
  ['constructor', 'symbol-method'],
  ['destructor', 'symbol-method'],
  ['operator', 'symbol-operator'],
  ['conversion', 'symbol-operator'],
  ['region', 'folder'],
  ['group', 'list-tree'],
]);
const PARAMETERIZED_KINDS = new Set(['method', 'constructor', 'destructor', 'operator', 'conversion', 'delegate', 'indexer']);
const NAME_COLLATOR = new Intl.Collator('en-US');

export function buildSpadeTree(structure: Structure, options: SpadeTreeOptions): SpadeNode[] {
  const roots = fileOrder(structure.items, options.sortOrder === 'file' ? flattenRegions(structure.regions) : [], Number.MAX_SAFE_INTEGER);
  if (options.sortOrder !== 'file') {
    sortRecursively(roots, options.sortOrder === 'alphabetical' ? compareByName : typeComparer(options));
  }

  assignIds(roots, undefined);
  if (options.sortOrder === 'type') {
    roots.forEach((root) => groupByType(root, options));
  }

  return options.filter ? filterNodes(roots, options.filter.toLowerCase()) : roots;
}

function flattenRegions(regions: readonly StructureRegion[]): StructureRegion[] {
  return regions.flatMap((region) => [region, ...flattenRegions(region.children)]);
}

/**
 * The nodes of `items` (siblings in a parent ending on `parentEnd`) with the `regions` lying among them: a region goes
 * into the namespace or type holding it, is dropped inside any other member, and holds the items and regions between
 * its directives; one without `#endregion` closes with its parent. Ids and parents are assigned afterwards.
 */
function fileOrder(items: readonly StructureItem[], regions: readonly StructureRegion[], parentEnd: number): MutableNode[] {
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  const within = (item: StructureItem, region: StructureRegion) => item.startLine < region.startLine && region.startLine <= item.endLine;
  const entries = [
    ...items.map((item) => ({ startLine: item.startLine, item, region: undefined })),
    ...regions.filter((region) => !items.some((item) => within(item, region))).map((region) => ({ startLine: region.startLine, item: undefined, region })),
  ].sort((a, b) => a.startLine - b.startLine);

  for (const { startLine, item, region } of entries) {
    const endLine = item ? item.endLine : (region!.endLine ?? parentEnd);
    while (stack.length > 0 && !(startLine > stack[stack.length - 1].startLine && endLine < stack[stack.length - 1].endLine)) {
      stack.pop();
    }

    const node: MutableNode = item
      ? {
          ...emptyNode(item.kind === 'namespace' ? 'namespace' : TYPE_KINDS[item.kind] === true ? 'type' : 'member', item.kind, item.name, startLine, endLine),
          item,
          children: fileOrder(item.children, PARENT_KINDS[item.kind] === true ? regions.filter((candidate) => within(item, candidate)) : [], item.endLine),
        }
      : emptyNode('region', 'region', region!.name, startLine, endLine);
    (stack.length > 0 ? stack[stack.length - 1].children : roots).push(node);
    if (!item) {
      stack.push(node);
    }
  }

  return roots;
}

function emptyNode(contextValue: SpadeContextValue, kind: string, name: string, startLine: number, endLine: number): MutableNode {
  return { id: '', contextValue, kind, name, item: undefined, startLine, endLine, parent: undefined, children: [] };
}

/** Ids from the parent's and the kind and name, numbered among siblings of the same kind and name. */
function assignIds(nodes: readonly MutableNode[], parent: MutableNode | undefined): void {
  const seen = new Map<string, number>();
  for (const node of nodes) {
    const key = `${node.kind}:${node.name}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    node.id = `${parent?.id ?? ''}/${key}${count > 0 ? `~${count}` : ''}`;
    for (const child of node.children) {
      child.parent = node;
    }

    assignIds(node.children, node);
  }
}

function sortRecursively(nodes: MutableNode[], compare: (a: MutableNode, b: MutableNode) => number): void {
  nodes.sort(compare);
  nodes.forEach((node) => sortRecursively(node.children, compare));
}

function compareByName(a: SpadeNode, b: SpadeNode): number {
  return NAME_COLLATOR.compare(a.name, b.name) || a.startLine - b.startLine;
}

/** `CodeItemTypeComparer`: member type and access level (whichever is primary), then constant, static and read-only. */
function typeComparer(options: SpadeTreeOptions): (a: SpadeNode, b: SpadeNode) => number {
  const rank = (node: SpadeNode): number => {
    const item = node.item!;
    const typeOffset = typeOrder(node, options);
    const accessIndex = item.access === null ? -1 : ACCESS_ORDER.indexOf(item.access);
    const accessOffset = accessIndex < 0 ? 0 : (options.reverseOrderByAccessLevel ? ACCESS_ORDER.length - 1 - accessIndex : accessIndex) + 1;
    const isField = item.kind === 'field' || item.kind === 'constant';
    const constantOffset = isField && item.kind !== 'constant' ? 1 : 0;
    const staticOffset = item.access !== null && !item.modifiers.includes('static') ? 1 : 0;
    const readOnlyOffset = isField && !item.modifiers.includes('readonly') ? 1 : 0;
    const [primary, secondary] = options.primaryOrderByAccessLevel ? [accessOffset, typeOffset] : [typeOffset, accessOffset];

    return primary * 100000 + secondary * 10000 + constantOffset * 100 + staticOffset * 10 + readOnlyOffset;
  };

  return (a, b) => rank(a) - rank(b) || (options.secondarySortTypeByName ? NAME_COLLATOR.compare(a.name, b.name) : 0) || a.startLine - b.startLine;
}

function typeOrder(node: SpadeNode, options: SpadeTreeOptions): number {
  const key = MEMBER_TYPE_OF.get(node.kind);

  return key ? options.memberTypes[key].order : 0;
}

/** `RecursivelyGroupByType`: the children of each parent in pseudo-groups, one per run of the same member type order. */
function groupByType(node: MutableNode, options: SpadeTreeOptions): void {
  if (node.children.length === 0 || node.children.some((child) => !MEMBER_TYPE_OF.has(child.kind))) {
    node.children.forEach((child) => groupByType(child, options));

    return;
  }

  const groups: MutableNode[] = [];
  for (const child of node.children) {
    const order = typeOrder(child, options);
    let group = groups[groups.length - 1];
    if (!group || typeOrder(group.children[0], options) !== order) {
      group = emptyNode('group', 'group', options.memberTypes[MEMBER_TYPE_OF.get(child.kind)!].name, child.startLine, child.endLine);
      group.parent = node;
      groups.push(group);
    }

    group.children.push(child);
    child.parent = group;
    groupByType(child, options);
  }

  node.children = groups;
  assignIds(groups, node);
}

function filterNodes(nodes: readonly MutableNode[], filter: string): MutableNode[] {
  return nodes.filter((node) => {
    node.children = filterNodes(node.children, filter);

    return node.children.length > 0 || node.name.toLowerCase().includes(filter);
  });
}

/** The label, description, tooltip, icon and complexity level of a node. */
export function describeSpadeNode(node: SpadeNode, options: SpadeDisplayOptions): SpadeNodeDisplay {
  const item = node.item;
  if (!item) {
    return {
      label: node.name,
      description: '',
      tooltip: node.contextValue === 'region' ? `#region ${node.name}` : node.name,
      icon: ICONS.get(node.kind)!,
      complexity: 'none',
    };
  }

  const parameters = parameterList(item);
  const typeText = TYPE_KINDS[item.kind] === true && item.kind !== 'delegate' ? item.baseTypes.join(', ') : (item.returnType ?? '');
  const label =
    (item.kind === 'indexer' ? 'this' : item.name) +
    (options.showMethodParameters && parameters !== undefined ? parameters : item.kind === 'indexer' ? '[]' : '') +
    (options.showItemTypes && typeText ? ` : ${typeText}` : '');
  const metadata = metadataOf(item);
  const showComplexity = options.showItemComplexity && item.complexity !== null;
  const complexity =
    !showComplexity || item.complexity! < options.complexityWarningThreshold
      ? 'none'
      : item.complexity! >= options.complexityAlertThreshold
        ? 'alert'
        : 'warning';
  const signature = [
    ...item.modifiers,
    item.returnType ?? (TYPE_KINDS[item.kind] === true || item.kind === 'namespace' ? item.kind : ''),
    `${item.kind === 'indexer' ? 'this' : item.name}${parameters ?? ''}`,
  ]
    .filter(Boolean)
    .join(' ');
  const tooltip = [
    signature + (TYPE_KINDS[item.kind] === true && item.baseTypes.length > 0 ? ` : ${item.baseTypes.join(', ')}` : ''),
    `Lines ${item.startLine + 1}-${item.endLine + 1}`,
    ...(item.complexity !== null ? [`Complexity: ${item.complexity}`] : []),
  ].join('\n');

  return {
    label,
    description: [options.showItemMetadata ? metadata : '', showComplexity ? String(item.complexity) : ''].filter(Boolean).join('  '),
    tooltip,
    icon: ICONS.get(item.kind) ?? 'symbol-misc',
    complexity,
  };
}

/** `(int x, int y)`, `[int index]` for an indexer; undefined for the kinds without parameters. */
function parameterList(item: StructureItem): string | undefined {
  if (!PARAMETERIZED_KINDS.has(item.kind)) {
    return undefined;
  }

  const list = item.parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ');

  return item.kind === 'indexer' ? `[${list}]` : `(${list})`;
}

/** `CodeItemToMetadataStringConverter`: s(tatic), ro (read-only field), a(bstract), v(irtual), o(verride), n(ew); none for constants. */
function metadataOf(item: StructureItem): string {
  if (item.kind === 'constant') {
    return '';
  }

  const flags: [string, string][] = [
    ['static', 's'],
    ...(item.kind === 'field' ? ([['readonly', 'ro']] as [string, string][]) : []),
    ...(['method', 'constructor', 'destructor', 'property', 'indexer'].includes(item.kind)
      ? ([
          ['abstract', 'a'],
          ['virtual', 'v'],
          ['override', 'o'],
          ['new', 'n'],
        ] as [string, string][])
      : []),
  ];

  return flags
    .filter(([modifier]) => item.modifiers.includes(modifier))
    .map(([, short]) => short)
    .join(', ');
}

/** The innermost node whose lines hold `line`; pseudo-groups (lines of their first member only) are looked into, never returned. */
export function spadeNodeAtLine(nodes: readonly SpadeNode[], line: number): SpadeNode | undefined {
  const holder = nodes
    .flatMap((node) => (node.contextValue === 'group' ? node.children : [node]))
    .find((node) => node.startLine <= line && line <= node.endLine);

  return holder ? (spadeNodeAtLine(holder.children, line) ?? holder) : undefined;
}

/** The namespace or type a node is a member of, past regions and pseudo-groups. */
export function memberParent(node: SpadeNode): SpadeNode | undefined {
  let parent = node.parent;
  while (parent && !parent.item) {
    parent = parent.parent;
  }

  return parent;
}

/**
 * Where dropping `source` on `target` moves it: after a target below it, before one above it. A message when the
 * drop is not a move among the members of one parent; undefined for a drop on itself.
 */
export function dropPlan(source: SpadeNode, target: SpadeNode): DropPlan | string | undefined {
  if (source === target || source.id === target.id) {
    return undefined;
  }

  if (!source.item || !target.item) {
    return `'${source.name}' can only be dropped on a member.`;
  }

  const parent = memberParent(source);
  if (parent !== memberParent(target)) {
    return `'${source.name}' can only be moved among the members of '${parent?.name ?? 'the file'}'.`;
  }

  return {
    line: source.startLine,
    name: source.name,
    targetLine: target.startLine,
    targetName: target.name,
    position: source.startLine < target.startLine ? 'after' : 'before',
  };
}
