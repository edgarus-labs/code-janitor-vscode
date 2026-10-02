import { Node, parseCSharp } from '../cleanup/parser';
import { parseErrorCount } from '../cleanup/transformations/editorConfigSupport';
import { CleanupSettings, SourceTransformation, createDefaultSettings } from '../cleanup/types';
import { SortableMember, createMemberComparer } from './comparer';
import { NO_INIT, mustKeepOrder } from './initializers';
import {
  ContainerContext,
  ContainerKind,
  MemberInfo,
  containerKindOf,
  createContainerContext,
  describeMember,
  memberKindOf,
} from './memberInfo';
import { RegionNamer } from './regions';
import { ReorganizeSettings } from './settings';
import { BuildEnvironment, BuiltEntries, Description, Entry, FixedEntry, MemberEntry, RegionEntry, SharedLineError, StructureError, buildEntries, isSemicolon, regionName } from './structure';

/** The cleanup settings reorganizing reads: the blank line padding it reapplies around moved members and the `#endregion` naming. */
export type ReorganizeCleanupSettings = Pick<
  CleanupSettings,
  { [K in keyof CleanupSettings]: K extends `insertBlankLinePadding${string}` | 'updateEndRegionDirectives' ? K : never }[keyof CleanupSettings]
>;

export interface ReorganizeResult {
  output: string;
  /** Containers left alone, with the reason; reported to the user, never silently dropped. */
  skipped: string[];
  /** The file has preprocessor conditionals and the policy does not allow reorganizing it without asking. */
  blockedByPreprocessor: boolean;
}

/** `CodeReorganizationAvailabilityLogic.HasPreprocessorConditionalCompilationDirectives`. */
export function hasPreprocessorConditionals(source: string): boolean {
  return /^[ \t]*#(if|else|elif|endif|pragma)/m.test(source);
}

/** Reorganizes the members of every type in `source`; a pure function of its arguments. */
export function reorganizeSource(source: string, settings: ReorganizeSettings, cleanup: ReorganizeCleanupSettings = createDefaultSettings()): string {
  return reorganizeSourceDetailed(source, settings, cleanup).output;
}

/**
 * The reorganizer as a cleanup pipeline step (`Reorganizing_RunAtStartOfCleanup` runs it first). A
 * step cannot ask the user, so a file with preprocessor conditionals is only reorganized when the
 * policy is yes.
 */
export function createReorganizeTransformation(settings: ReorganizeSettings, cleanup: ReorganizeCleanupSettings = createDefaultSettings()): SourceTransformation {
  return {
    name: 'Reorganize members',
    apply: (source) => reorganizeSource(source, settings, cleanup),
  };
}

export function reorganizeSourceDetailed(
  source: string,
  settings: ReorganizeSettings,
  cleanup: ReorganizeCleanupSettings = createDefaultSettings()
): ReorganizeResult {
  const unchanged = (skipped: string[] = [], blockedByPreprocessor = false): ReorganizeResult => ({ output: source, skipped, blockedByPreprocessor });

  if (!source) {
    return unchanged();
  }

  // The parser reads a byte order mark as an identifier: reorganize the text after it and keep the mark.
  if (source.startsWith('\uFEFF')) {
    const result = reorganizeSourceDetailed(source.slice(1), settings, cleanup);

    return { ...result, output: `\uFEFF${result.output}` };
  }

  // Preprocessor conditionals are only reorganized when the policy says yes; 'ask' needs a user to ask.
  if (settings.performWhenPreprocessorConditionals !== 'yes' && hasPreprocessorConditionals(source)) {
    return unchanged([], true);
  }

  const skipped: string[] = [];
  const session = new Session(source, settings, cleanup, skipped);
  const output = session.run();

  if (output === source) {
    return unchanged(skipped);
  }

  if (parseErrorCount(output) > parseErrorCount(source)) {
    return unchanged([...skipped, 'the reorganized file no longer parses cleanly, so it was left unchanged']);
  }

  return { output, skipped, blockedByPreprocessor: false };
}

interface Rewrite {
  start: number;
  end: number;
  text: string;
}

interface ContainerPlan {
  node: Node;
  kind: ContainerKind;
  typeName: string;
  /** The direct children that make up the body (without braces). */
  atoms: Node[];
  bodyStart: number;
  bodyEnd: number;
  /** The brace that closes the body, for the indentation of members added to an empty body. */
  closeBrace?: Node;
}

class Session {
  private readonly rewrites: Rewrite[] = [];
  private readonly eol: string;
  private readonly namer: RegionNamer;
  private readonly compare: (a: SortableMember, b: SortableMember) => number;

  constructor(
    private readonly source: string,
    private readonly settings: ReorganizeSettings,
    private readonly cleanup: ReorganizeCleanupSettings,
    private readonly skipped: string[]
  ) {
    this.eol = source.includes('\r\n') ? '\r\n' : '\n';
    this.namer = new RegionNamer(settings);
    this.compare = createMemberComparer(settings);
  }

  run(): string {
    const tree = parseCSharp(this.source);
    try {
      for (const plan of this.collectContainers(tree.rootNode)) {
        this.process(plan);
      }
    } finally {
      tree.delete();
    }

    return this.spanText(0, this.source.length);
  }

  // ------------------------------------------------------------------ containers

  /** The containers in an order that has every nested container before the one holding it. */
  private collectContainers(root: Node): ContainerPlan[] {
    const plans: ContainerPlan[] = [];
    const fileScoped = root.namedChildren.find((child) => child.type === 'file_scoped_namespace_declaration');

    if (fileScoped) {
      this.visitBody(fileScopedPlan(fileScoped, root, this.source.length), plans);
    } else {
      this.visitBody({ node: root, kind: 'unit', typeName: '', atoms: atomsOf(root.children), bodyStart: 0, bodyEnd: this.source.length }, plans);
    }

    return plans;
  }

  private visitBody(plan: ContainerPlan, plans: ContainerPlan[]): void {
    for (const atom of plan.atoms) {
      const kind = memberKindOf(atom);
      if (kind === 'namespace' || kind === 'class' || kind === 'struct' || kind === 'interface') {
        this.visitType(atom, plans);
      }
    }

    plans.push(plan);
  }

  private visitType(node: Node, plans: ContainerPlan[]): void {
    const body = node.childForFieldName('body');
    const open = body?.children[0];
    const close = body?.children[body.children.length - 1];

    // The children of a type whose member order is part of its meaning are not reorganized.
    if (!body || body.type !== 'declaration_list' || open?.type !== '{' || close?.type !== '}' || hasFixedLayout(node)) {
      return;
    }

    const kind = containerKindOf(node);
    this.visitBody(
      {
        node: body,
        kind,
        typeName: node.childForFieldName('name')?.text ?? '',
        atoms: atomsOf(body.children.slice(1, -1)),
        bodyStart: open.endIndex,
        bodyEnd: close.startIndex,
        closeBrace: close,
      },
      plans
    );
  }

  private process(plan: ContainerPlan): void {
    const label = `${plan.kind === 'unit' ? 'file' : plan.typeName || plan.kind} (line ${(plan.node.parent ?? plan.node).startPosition.row + 1})`;

    if (hasBrokenSyntax(plan.node)) {
      this.skip(label, 'syntax the parser does not understand');

      return;
    }

    try {
      const body = this.reorganizeBody(plan);
      if (body !== undefined) {
        this.rewrites.push({ start: plan.bodyStart, end: plan.bodyEnd, text: body });
      }
    } catch (error) {
      if (!(error instanceof StructureError)) {
        throw error;
      }

      // A one-line body holding one member (`class C { int F; }`) has nothing to order: not worth a report.
      const oneMember = error instanceof SharedLineError && plan.atoms.filter((atom) => memberKindOf(atom) !== undefined).length <= 1;
      // A file with top-level statements keeps its order of types; the statements say why.
      const topLevelStatements = plan.kind === 'unit' && error.message.startsWith('unsupported syntax');
      if (!oneMember && !topLevelStatements) {
        this.skip(label, error.message);
      }
    }
  }

  private skip(label: string, reason: string): void {
    this.skipped.push(`${label}: skipped because of ${reason}`);
  }

  private reorganizeBody(plan: ContainerPlan): string | undefined {
    if (!this.hasAnythingToDo(plan)) {
      return undefined;
    }

    const context = createContainerContext(
      plan.kind,
      plan.typeName,
      plan.atoms.filter((atom) => memberKindOf(atom) !== undefined)
    );
    const built = buildEntries(plan.atoms, this.environment(plan, context));
    const state = { mutated: false };

    const { keepMembersWithinRegions: keep, regionsRemoveExistingRegions: remove, regionsInsertNewRegions: insert } = this.settings;
    let entries = built.entries;

    // When inserting regions every existing one goes; otherwise which ones stay depends on the members they hold,
    // which when sorting across regions is only known after the sort.
    const removeAfterSort = remove && !keep && !insert;
    if (remove && !removeAfterSort) {
      entries = this.removeRegions(entries, state);
    }

    if (!keep) {
      entries = flattenRegions(entries);
    }

    entries = this.sortLevel(entries, state);

    if (removeAfterSort) {
      entries = this.removeRegions(unflattenRegions(entries), state);
    }

    if (this.settings.regionsInsertNewRegions && (plan.kind === 'class' || plan.kind === 'struct' || plan.kind === 'interface')) {
      entries = this.insertRegions(entries, state, plan);
    }

    if (!state.mutated) {
      return undefined;
    }

    const body = this.assemble(plan, built, entries);
    const original = this.source.slice(plan.bodyStart, plan.bodyEnd);
    if (!sameContent(original, body)) {
      throw new StructureError('a safety check: the rewritten body does not hold the same lines as the original');
    }

    if (!directivesStayBalanced(original, body)) {
      throw new StructureError('a safety check: moving its members would separate an #if or #region from its #endif or #endregion');
    }

    return body;
  }

  /** A body with at most one member and no region has nothing to order; regions may still be inserted into it. */
  private hasAnythingToDo(plan: ContainerPlan): boolean {
    const members = plan.atoms.filter((atom) => memberKindOf(atom) !== undefined).length;
    const holdsRegions = plan.atoms.some((atom) => atom.type === 'preproc_region');
    const mayInsertRegions = this.settings.regionsInsertNewRegions && (plan.kind === 'class' || plan.kind === 'struct' || plan.kind === 'interface');

    return members > 1 || holdsRegions || mayInsertRegions;
  }

  private environment(plan: ContainerPlan, context: ContainerContext): BuildEnvironment {
    return {
      source: this.source,
      spanText: (start, end) => this.spanText(start, end),
      describe: (node): Description | undefined => describeNode(node, plan.kind, context),
    };
  }

  /** The source between `start` and `end` with the rewrites of the containers inside applied. */
  private spanText(start: number, end: number): string {
    const inside = this.rewrites
      .filter((rewrite) => rewrite.start >= start && rewrite.end <= end)
      .sort((a, b) => a.start - b.start || b.end - a.end);

    let result = '';
    let cursor = start;
    for (const rewrite of inside) {
      if (rewrite.start < cursor) {
        continue;
      }
      result += this.source.slice(cursor, rewrite.start) + rewrite.text;
      cursor = rewrite.end;
    }

    return result + this.source.slice(cursor, end);
  }

  // ------------------------------------------------------------------ regions

  /** Removes the regions that do not stay (`RegionsRemoveExisting`), lifting their entries to the level of the region. */
  private removeRegions(entries: Entry[], state: { mutated: boolean }): Entry[] {
    let current = entries;

    for (;;) {
      const kept = this.settings.regionsInsertNewRegions ? new Set<string>() : this.namer.composedNames(current);
      const doomed = current.filter((entry): entry is RegionEntry => entry.kind === 'region' && !kept.has(entry.name));
      if (doomed.length === 0) {
        break;
      }

      state.mutated = true;
      current = current.flatMap((entry) => (entry.kind === 'region' && doomed.includes(entry) ? liftChildren(entry) : [entry]));
    }

    return current.map((entry) => (entry.kind === 'region' ? { ...entry, children: this.removeRegions(entry.children, state) } : entry));
  }

  /** `RegionsInsert`: puts a region around each run of members that belong to one. */
  private insertRegions(entries: Entry[], state: { mutated: boolean }, plan: ContainerPlan): Entry[] {
    const existing = new Set(entries.flatMap((entry) => (entry.kind === 'region' ? [entry.name] : entry.kind === 'fixed' && entry.marker === 'regionStart' ? [regionName(entry.text)] : [])));
    const indent = this.indentOf(entries, plan);
    const result: Entry[] = [];

    for (let i = 0; i < entries.length; ) {
      const entry = entries[i];
      const name = entry.kind === 'member' ? this.namer.nameOf(entry.info) : undefined;
      if (entry.kind !== 'member' || name === undefined) {
        result.push(entry);
        i++;
        continue;
      }

      let end = i;
      while (end < entries.length) {
        const next = entries[end];
        if (next.kind !== 'member' || this.namer.nameOf(next.info) !== name) {
          break;
        }
        end++;
      }

      const run = entries.slice(i, end) as MemberEntry[];
      if (existing.has(name)) {
        result.push(...run);
      } else {
        result.push(this.createRegion(name, run, indent(run[0])));
        state.mutated = true;
      }
      i = end;
    }

    if (this.settings.regionsInsertKeepEvenIfEmpty) {
      this.addEmptyRegions(result, state, indent());
    }

    return result;
  }

  /** Inserts the regions that are kept even when empty, each before the first entry of a later region. */
  private addEmptyRegions(entries: Entry[], state: { mutated: boolean }, indent: string): void {
    let pointer = 0;

    for (const name of this.namer.allPossibleNames()) {
      const found = entries.findIndex((entry, index) => index >= pointer && regionNameOfEntry(entry) === name);
      if (found >= 0) {
        pointer = found + 1;
        continue;
      }

      entries.splice(pointer, 0, this.createRegion(name, [], indent));
      pointer++;
      state.mutated = true;
    }
  }

  private createRegion(name: string, children: Entry[], indent: string): RegionEntry {
    const firstBlank = children[0]?.blank ?? 0;
    const lastBlankAfter = children[children.length - 1]?.blankAfter ?? 0;
    const wrapped = children.map((child, index) => (index === 0 ? { ...child, blank: 0, moveBlank: 0 } : child));

    return {
      kind: 'region',
      name,
      text: '',
      startText: `${indent}#region ${name}`,
      endText: `${indent}#endregion${this.cleanup.updateEndRegionDirectives ? ` ${name}` : ''}`,
      children: wrapped,
      headBlank: wrapped.length > 0 && this.cleanup.insertBlankLinePaddingAfterRegionTags ? 1 : 0,
      tailBlank: wrapped.length > 0 && this.cleanup.insertBlankLinePaddingBeforeEndRegionTags ? 1 : 0,
      blank: firstBlank,
      moveBlank: 0,
      blankAfter: lastBlankAfter,
      level: -1,
      index: -1,
    };
  }

  /** The indentation of the members of a container. */
  private indentOf(entries: readonly Entry[], plan: ContainerPlan): (entry?: Entry) => string {
    const fallback = this.memberIndent(plan);

    return (entry) => {
      const reference = entry ?? entries.find((candidate) => candidate.kind === 'member');
      const text = reference ? (reference.kind === 'region' ? reference.startText : reference.text) : '';

      return reference ? indentationOf(text) : fallback;
    };
  }

  /** One level deeper than the line of the type, for a body that has no member to copy the indentation from. */
  private memberIndent(plan: ContainerPlan): string {
    const outer = this.typeIndent(plan);

    return outer + (outer.includes('\t') ? '\t' : '    ');
  }

  /** The indentation of the line the type is declared on (of its attributes, for a type with some). */
  private typeIndent(plan: ContainerPlan): string {
    const header = this.source.lastIndexOf('\n', (plan.node.parent ?? plan.node).startIndex - 1) + 1;

    return /^[ \t]*/.exec(this.source.slice(header))![0];
  }

  // ------------------------------------------------------------------ sorting

  private sortLevel(entries: Entry[], state: { mutated: boolean }): Entry[] {
    const withRegions = entries.map((entry) => (entry.kind === 'region' ? { ...entry, children: this.sortLevel(entry.children, state) } : entry));
    const result: Entry[] = [];
    let run: Entry[] = [];

    const flush = (): void => {
      result.push(...this.sortRun(run, state));
      run = [];
    };

    for (const entry of withRegions) {
      if (entry.kind === 'fixed' && entry.barrier) {
        flush();
        result.push(entry);
      } else {
        run.push(entry);
      }
    }
    flush();

    return result;
  }

  /** Puts the members of a run in their order; everything else (regions, comments) stays in its slot. */
  private sortRun(run: Entry[], state: { mutated: boolean }): Entry[] {
    const slots = run.flatMap((entry, index) => (entry.kind === 'member' ? [index] : []));
    const members = slots.map((slot) => run[slot] as MemberEntry);
    const ordered = this.orderMembers(members);

    if (ordered.every((member, index) => member === members[index])) {
      return run;
    }

    state.mutated = true;
    const result = [...run];
    slots.forEach((slot, index) => {
      result[slot] = ordered[index];
    });

    return result;
  }

  /**
   * The members in the configured order, except that members whose initializers depend on the
   * declaration order keep their relative order: the wanted order is followed as far as those
   * constraints allow.
   */
  private orderMembers(members: MemberEntry[]): MemberEntry[] {
    const wanted = members
      .map((member, index) => ({ member, index, key: sortableOf(member.info, index) }))
      .sort((a, b) => this.compare(a.key, b.key))
      .map((item) => item.index);

    const predecessors = orderConstraints(members);
    const placed = new Set<number>();
    const remaining = [...wanted];
    const ordered: MemberEntry[] = [];

    while (remaining.length > 0) {
      const next = remaining.findIndex((candidate) => [...(predecessors.get(candidate) ?? [])].every((before) => placed.has(before)));
      const [index] = remaining.splice(next, 1);
      placed.add(index);
      ordered.push(members[index]);
    }

    return ordered;
  }

  // ------------------------------------------------------------------ output

  private assemble(plan: ContainerPlan, built: BuiltEntries, entries: Entry[]): string {
    if (built.entries.length === 0) {
      // A body without members that gets regions: they go on lines of their own between the braces.
      return this.eol + this.emit(entries) + this.eol + this.typeIndent(plan);
    }

    const lineStart = this.source.lastIndexOf('\n', built.start - 1) + 1;

    return this.source.slice(plan.bodyStart, lineStart) + this.emit(entries) + this.source.slice(built.end, plan.bodyEnd);
  }

  private emit(entries: readonly Entry[]): string {
    let result = '';

    entries.forEach((entry, index) => {
      if (index > 0) {
        result += this.eol.repeat(1 + this.gap(entries[index - 1], entry));
      }
      result += this.textOf(entry);
    });

    return result;
  }

  private textOf(entry: Entry): string {
    if (entry.kind !== 'region') {
      return entry.text;
    }

    if (entry.children.length === 0) {
      return entry.startText + this.eol + entry.endText;
    }

    return entry.startText + this.eol.repeat(1 + entry.headBlank) + this.emit(entry.children) + this.eol.repeat(1 + entry.tailBlank) + entry.endText;
  }

  /** Blank lines between two entries: kept where they were adjacent before, padded per the cleanup settings where they are new neighbours. */
  private gap(previous: Entry, current: Entry): number {
    if (previous.level === current.level && current.index === previous.index + 1) {
      return current.blank;
    }

    const inherited = current.kind !== 'member' ? current.blank : previous.kind !== 'member' ? previous.blankAfter : current.moveBlank;
    const padded = this.paddingAfter(previous) || this.paddingBefore(current);

    return Math.max(inherited, padded ? 1 : 0);
  }

  private paddingBefore(entry: Entry): boolean {
    const settings = this.cleanup;

    switch (entry.kind) {
      case 'member':
        return paddingOf(entry.info, settings).before;
      case 'region':
        return settings.insertBlankLinePaddingBeforeRegionTags;
      default:
        return entry.marker === 'regionStart'
          ? settings.insertBlankLinePaddingBeforeRegionTags
          : entry.marker === 'regionEnd'
            ? settings.insertBlankLinePaddingBeforeEndRegionTags
            : false;
    }
  }

  private paddingAfter(entry: Entry): boolean {
    const settings = this.cleanup;

    switch (entry.kind) {
      case 'member':
        return paddingOf(entry.info, settings).after;
      case 'region':
        return settings.insertBlankLinePaddingAfterEndRegionTags;
      default:
        return entry.marker === 'regionStart'
          ? settings.insertBlankLinePaddingAfterRegionTags
          : entry.marker === 'regionEnd'
            ? settings.insertBlankLinePaddingAfterEndRegionTags
            : false;
    }
  }
}

// ---------------------------------------------------------------------- helpers

/** The indentation of the first line of code of an entry (a `#if` block starts with a directive, which has none). */
function indentationOf(text: string): string {
  const line = text.split('\n').find((candidate) => !candidate.trimStart().startsWith('#'));

  return line ? /^[ \t]*/.exec(line)![0] : '';
}

/** Direct children that are declarations, comments, directives or stray semicolons. */
function atomsOf(children: readonly Node[]): Node[] {
  return children.filter((child) => child.isNamed || child.type === ';');
}

function fileScopedPlan(namespace: Node, root: Node, sourceLength: number): ContainerPlan {
  const semicolon = namespace.children.find((child) => child.type === ';');
  const afterSemicolon = semicolon ? namespace.children.slice(namespace.children.indexOf(semicolon) + 1) : [];
  // Comments and directives after the last member are siblings of the namespace in the tree.
  const trailing = root.children.slice(root.children.indexOf(namespace) + 1);

  return {
    node: namespace,
    kind: 'namespace',
    typeName: namespace.childForFieldName('name')?.text ?? '',
    atoms: atomsOf([...afterSemicolon, ...trailing]),
    bodyStart: semicolon?.endIndex ?? namespace.endIndex,
    bodyEnd: sourceLength,
  };
}

/**
 * `ShouldReorganizeChildren`: attributes that say the order of the members matters (layout of a
 * struct, vtable of a COM interface; the Visual Studio extension knows `StructLayout` and `ComImport`).
 */
function hasFixedLayout(node: Node): boolean {
  return node.namedChildren.some(
    (child) =>
      child.type === 'attribute_list' &&
      child.namedChildren.some((attribute) => /^(System\.Runtime\.InteropServices\.)?(StructLayout|ComImport|InterfaceType|GeneratedComInterface)(Attribute)?$/.test(attributeName(attribute)))
  );
}

/** `[global::System.Runtime.InteropServices.StructLayout(...)]` -> `System.Runtime.InteropServices.StructLayout`. */
function attributeName(attribute: Node): string {
  return attribute.text.replace(/\(.*$/s, '').trim().replace(/^global\s*::\s*/, '');
}

/** The parser reports a semicolon after a member and assembly attributes that no declaration follows as incomplete declarations. */
function hasBrokenSyntax(node: Node): boolean {
  return node.namedChildren.some((child) => (child.type === 'incomplete_declaration' && !isSemicolon(child) && !isGlobalAttributeOnly(child)) || hasBrokenSyntax(child));
}

function isGlobalAttributeOnly(node: Node): boolean {
  return node.namedChildren.length > 0 && node.namedChildren.every((child) => child.type === 'attribute_list') && hasGlobalAttribute(node);
}

const NAMESPACE_LEVEL_BARRIERS = new Set(['using_directive', 'extern_alias_directive', 'attribute_list', 'file_scoped_namespace_declaration']);

function describeNode(node: Node, container: ContainerKind, context: ContainerContext): Description | undefined {
  const kind = memberKindOf(node);

  if (container === 'unit' || container === 'namespace') {
    // The parser attaches `[assembly: ...]` to the declaration after it, but the attribute must stay in front of all declarations.
    if (hasGlobalAttribute(node)) {
      return { kind: 'barrier' };
    }

    if (kind === 'namespace' || kind === 'class' || kind === 'struct' || kind === 'interface' || kind === 'enum' || kind === 'delegate') {
      return { kind: 'member', info: describeMember(node, kind, context) };
    }

    // The parser reads `extern alias X;` as a field.
    const isExternAlias = node.type === 'field_declaration' && /^extern\s+alias\b/.test(node.text);

    return NAMESPACE_LEVEL_BARRIERS.has(node.type) || isExternAlias ? { kind: 'barrier' } : undefined;
  }

  return kind && kind !== 'namespace' ? { kind: 'member', info: describeMember(node, kind, context) } : undefined;
}

function hasGlobalAttribute(node: Node): boolean {
  return node.namedChildren.some((child) => child.type === 'attribute_list' && /^\[\s*(assembly|module)\s*:/.test(child.text));
}

function sortableOf(info: MemberInfo, offset: number): SortableMember {
  return {
    kind: info.kind,
    name: info.name,
    access: info.access,
    isStatic: info.isStatic,
    isConstant: info.isConstant,
    isReadOnly: info.isReadOnly,
    isExplicitInterface: info.isExplicitInterface,
    offset,
  };
}

/**
 * For each member, the members declared before it that must stay before it: initializers that depend on
 * declaration order, and parts of the same partial type (whose initializers run in the order of the parts).
 */
function orderConstraints(members: readonly MemberEntry[]): Map<number, number[]> {
  const constraints = new Map<number, number[]>();
  const bearing = members.flatMap((member, index) => (member.info.init !== NO_INIT || member.info.partialTypes.size > 0 ? [index] : []));

  bearing.forEach((second, position) => {
    for (const first of bearing.slice(0, position)) {
      const a = members[first].info;
      const b = members[second].info;
      if (mustKeepOrder(a.init, b.init) || [...b.partialTypes].some((name) => a.partialTypes.has(name))) {
        constraints.set(second, [...(constraints.get(second) ?? []), first]);
      }
    }
  });

  return constraints;
}

function regionNameOfEntry(entry: Entry): string | undefined {
  if (entry.kind === 'region') {
    return entry.name;
  }

  return entry.kind === 'fixed' && entry.marker === 'regionStart' ? regionName(entry.text) : undefined;
}

/** Replaces each region by its `#region` line, its entries and its `#endregion` line, so entries can be sorted across regions. */
function flattenRegions(entries: readonly Entry[]): Entry[] {
  return entries.flatMap((entry): Entry[] => {
    if (entry.kind !== 'region') {
      return [entry];
    }

    const start: FixedEntry = { kind: 'fixed', barrier: false, marker: 'regionStart', text: entry.startText, blank: entry.blank, moveBlank: 0, blankAfter: entry.headBlank, level: entry.level, index: entry.index };
    const end: FixedEntry = { kind: 'fixed', barrier: false, marker: 'regionEnd', text: entry.endText, blank: entry.tailBlank, moveBlank: 0, blankAfter: entry.blankAfter, level: entry.level, index: entry.index };
    const children = flattenRegions(entry.children).map((child, index) => (index === 0 ? { ...child, blank: entry.headBlank, moveBlank: 0 } : child));

    return [start, ...children, end];
  });
}

/** The inverse of {@link flattenRegions}: the entries between a pair of region markers become the children of a region again. */
function unflattenRegions(entries: readonly Entry[]): Entry[] {
  const root: Entry[] = [];
  const open: { start: FixedEntry; children: Entry[] }[] = [];

  for (const entry of entries) {
    const target = open.length > 0 ? open[open.length - 1].children : root;

    if (entry.kind === 'fixed' && entry.marker === 'regionStart') {
      open.push({ start: entry, children: [] });
    } else if (entry.kind === 'fixed' && entry.marker === 'regionEnd') {
      const { start, children } = open.pop()!;
      const parent = open.length > 0 ? open[open.length - 1].children : root;
      parent.push({
        kind: 'region',
        name: regionName(start.text),
        text: '',
        startText: start.text,
        endText: entry.text,
        children,
        headBlank: start.blankAfter,
        tailBlank: entry.blank,
        blank: start.blank,
        moveBlank: 0,
        blankAfter: entry.blankAfter,
        level: start.level,
        index: start.index,
      });
    } else {
      target.push(entry);
    }
  }

  return root;
}

/** The children of a region that goes away, in the place of the region. */
function liftChildren(region: RegionEntry): Entry[] {
  return region.children.map((child, index) => {
    const lifted = { ...child };
    if (index === 0) {
      lifted.blank = region.blank;
      lifted.moveBlank = region.blank;
    }
    if (index === region.children.length - 1) {
      lifted.blankAfter = region.blankAfter;
    }

    return lifted;
  });
}

interface Padding {
  before: boolean;
  after: boolean;
}

function paddingOf(info: MemberInfo, settings: ReorganizeCleanupSettings): Padding {
  switch (info.kind) {
    case 'class':
      return { before: settings.insertBlankLinePaddingBeforeClasses, after: settings.insertBlankLinePaddingAfterClasses };
    case 'delegate':
      return { before: settings.insertBlankLinePaddingBeforeDelegates, after: settings.insertBlankLinePaddingAfterDelegates };
    case 'enum':
      return { before: settings.insertBlankLinePaddingBeforeEnumerations, after: settings.insertBlankLinePaddingAfterEnumerations };
    case 'event':
      return { before: settings.insertBlankLinePaddingBeforeEvents, after: settings.insertBlankLinePaddingAfterEvents };
    case 'field':
      return info.isMultiLine
        ? { before: settings.insertBlankLinePaddingBeforeFieldsMultiLine, after: settings.insertBlankLinePaddingAfterFieldsMultiLine }
        : { before: settings.insertBlankLinePaddingBeforeFieldsSingleLine, after: settings.insertBlankLinePaddingAfterFieldsSingleLine };
    case 'interface':
      return { before: settings.insertBlankLinePaddingBeforeInterfaces, after: settings.insertBlankLinePaddingAfterInterfaces };
    case 'namespace':
      return { before: settings.insertBlankLinePaddingBeforeNamespaces, after: settings.insertBlankLinePaddingAfterNamespaces };
    case 'constructor':
    case 'destructor':
    case 'method':
      return { before: settings.insertBlankLinePaddingBeforeMethods, after: settings.insertBlankLinePaddingAfterMethods };
    case 'indexer':
    case 'property':
      return info.isMultiLine
        ? { before: settings.insertBlankLinePaddingBeforePropertiesMultiLine, after: settings.insertBlankLinePaddingAfterPropertiesMultiLine }
        : { before: settings.insertBlankLinePaddingBeforePropertiesSingleLine, after: settings.insertBlankLinePaddingAfterPropertiesSingleLine };
    case 'struct':
      return { before: settings.insertBlankLinePaddingBeforeStructs, after: settings.insertBlankLinePaddingAfterStructs };
  }
}

/**
 * The safety net: a reorganized body must hold exactly the lines of the original (moved, never
 * edited), apart from blank lines and region directives.
 */
function sameContent(before: string, after: string): boolean {
  const lines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^#\s*(end)?region\b/.test(line))
      .sort();
  const a = lines(before);
  const b = lines(after);

  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Conditional and region directives that were properly nested must stay so: a member that holds
 * the `#if` of a block closed in a later member must not move after it.
 */
function directivesStayBalanced(before: string, after: string): boolean {
  const pairs: [RegExp, RegExp][] = [
    [/^[ \t]*#\s*if\b/, /^[ \t]*#\s*endif\b/],
    [/^[ \t]*#\s*region\b/, /^[ \t]*#\s*endregion\b/],
  ];

  return pairs.every(([open, close]) => !isBalanced(before, open, close) || isBalanced(after, open, close));
}

function isBalanced(text: string, open: RegExp, close: RegExp): boolean {
  let depth = 0;
  for (const line of text.split('\n')) {
    if (open.test(line)) {
      depth++;
    } else if (close.test(line) && --depth < 0) {
      return false;
    }
  }

  return depth === 0;
}
