import { Node } from '../cleanup/parser';
import { MemberInfo } from './memberInfo';
import { mergeInitInfo } from './initializers';

/**
 * The members of one container (a type body, a namespace body or a file) as the reorganizer moves
 * them: each entry is whole lines of the source - a member with the comments directly above it and
 * the comment after it, a `#if` block, a `#region` block or something that must stay where it is.
 */

interface EntryBase {
  /** The source text of the entry, from the start of its first line (so it includes the indentation) to its end. */
  text: string;
  /** Blank lines between the previous entry and this one. */
  blank: number;
  /** The blank lines a member brings along when it moves: those of its gap to a previous member (a gap to a comment or region belongs to that one). */
  moveBlank: number;
  /** Blank lines between this entry and the next one. */
  blankAfter: number;
  /** The level (container or region) the entry was found in, and its position there: two entries that are still next to each other keep the blank lines between them. */
  level: number;
  index: number;
}

export interface MemberEntry extends EntryBase {
  kind: 'member';
  info: MemberInfo;
}

/** Text that stays where it is: a comment not attached to a member, or a directive members must not move across. */
export interface FixedEntry extends EntryBase {
  kind: 'fixed';
  /** Members never move across a barrier (`#pragma`, `using`, ...). */
  barrier: boolean;
  /** Set on the `#region` / `#endregion` lines of a region that was dissolved for sorting. */
  marker?: 'regionStart' | 'regionEnd';
}

export interface RegionEntry extends EntryBase {
  kind: 'region';
  name: string;
  startText: string;
  endText: string;
  children: Entry[];
  /** Blank lines between the `#region` line and the first child, and between the last child and `#endregion`. */
  headBlank: number;
  tailBlank: number;
}

export type Entry = MemberEntry | FixedEntry | RegionEntry;

/** The kinds of node found directly in a container and how the reorganizer treats them. */
export type Description = { kind: 'member'; info: MemberInfo } | { kind: 'barrier' };

export interface BuildEnvironment {
  source: string;
  /** The source text of a span with the rewrites of the containers nested in it applied. */
  spanText(start: number, end: number): string;
  /** `undefined` for a node the reorganizer does not understand (the container is then left alone). */
  describe(node: Node): Description | undefined;
}

export class StructureError extends Error {}

/** Entries that share a line with another entry or with a brace: they cannot be moved as lines. */
export class SharedLineError extends StructureError {
  constructor() {
    super('more than one member on a line');
  }
}

/** The entries of a container and the source span they cover (empty when there are none). */
export interface BuiltEntries {
  entries: Entry[];
  start: number;
  end: number;
}

/** Builds the entries of a container from its direct children, or throws a {@link StructureError} saying why it cannot. */
export function buildEntries(atoms: readonly Node[], environment: BuildEnvironment): BuiltEntries {
  return new EntryBuilder(atoms, environment).build();
}

class EntryBuilder {
  private pos = 0;
  private levels = 0;
  private readonly positions = new Map<Entry, { start: number; end: number }>();

  constructor(
    private readonly atoms: readonly Node[],
    private readonly env: BuildEnvironment
  ) {}

  build(): BuiltEntries {
    const { entries, closer, start, end } = this.level(false);
    if (closer) {
      throw new StructureError('an #endregion without a #region');
    }

    return { entries, start, end };
  }

  private level(inRegion: boolean): { entries: Entry[]; closer?: Node; start: number; end: number } {
    const level = this.levels++;
    const entries: Entry[] = [];
    const spans: { start: number; end: number }[] = [];
    let pending: Node[] = [];
    let closer: Node | undefined;

    const add = (entry: Entry, start: number, end: number): void => {
      const span = { start, end };
      entries.push(entry);
      spans.push(span);
      this.positions.set(entry, span);
    };
    const flushPending = (): void => {
      if (pending.length > 0) {
        const start = pending[0].startIndex;
        const end = this.endOf(pending[pending.length - 1]);
        add(this.fixed(start, end, false, level), start, end);
        pending = [];
      }
    };
    const takePending = (next: Node): number => {
      const attached = pending.length > 0 && this.newlinesBetween(this.endOf(pending[pending.length - 1]), next.startIndex) === 1;
      if (!attached) {
        flushPending();
      }
      const start = attached ? pending[0].startIndex : next.startIndex;
      pending = [];

      return start;
    };

    while (this.pos < this.atoms.length) {
      const atom = this.atoms[this.pos];

      if (atom.type === 'preproc_endregion') {
        if (!inRegion) {
          throw new StructureError('an #endregion without a #region');
        }
        this.pos++;
        closer = atom;
        break;
      }

      if (atom.type === 'comment') {
        this.pos++;
        const last = spans[spans.length - 1];

        if (pending.length === 0 && last && this.newlinesBetween(last.end, atom.startIndex) === 0) {
          // A comment at the end of the line of the previous entry belongs to that entry.
          last.end = this.endOf(atom);
          this.extend(entries[entries.length - 1], last.start, last.end);
        } else if (pending.length === 0 && entries.length === 0 && !this.startsLine(atom.startIndex)) {
          // A comment on the line of the opening brace stays with it.
        } else if (pending.length > 0 && this.newlinesBetween(this.endOf(pending[pending.length - 1]), atom.startIndex) > 1) {
          flushPending();
          pending.push(atom);
        } else {
          pending.push(atom);
        }
        continue;
      }

      if (isSemicolon(atom)) {
        this.pos++;
        const last = spans[spans.length - 1];
        if (pending.length === 0 && last && this.newlinesBetween(last.end, atom.startIndex) === 0) {
          last.end = this.endOf(atom);
          this.extend(entries[entries.length - 1], last.start, last.end);
          continue;
        }
        throw new StructureError('a stray semicolon');
      }

      if (atom.type === 'preproc_region') {
        flushPending();
        this.pos++;
        const inner = this.level(true);
        if (!inner.closer) {
          throw new StructureError('a #region without an #endregion');
        }
        add(this.region(atom, inner.closer, inner.entries, level), atom.startIndex, this.endOf(inner.closer));
        continue;
      }

      if (atom.type === 'preproc_if') {
        const close = this.matchingEndif();
        const inner = this.atoms.slice(this.pos + 1, close);
        const start = takePending(atom);
        const end = this.endOf(this.atoms[close]);
        add(this.conditional(start, end, inner, level), start, end);
        this.pos = close + 1;
        continue;
      }

      if (atom.type === 'preproc_else' || atom.type === 'preproc_elif' || atom.type === 'preproc_endif') {
        throw new StructureError('an unbalanced #if directive');
      }

      if (atom.type.startsWith('preproc_')) {
        flushPending();
        this.pos++;
        add(this.fixed(atom.startIndex, this.endOf(atom), true, level), atom.startIndex, this.endOf(atom));
        continue;
      }

      const description = this.env.describe(atom);
      if (!description) {
        throw new StructureError(`unsupported syntax (${atom.type})`);
      }

      this.pos++;
      const start = takePending(atom);
      if (description.kind === 'member') {
        add(this.member(start, this.endOf(atom), description.info, level), start, this.endOf(atom));
      } else {
        add(this.fixed(start, this.endOf(atom), true, level), start, this.endOf(atom));
      }
    }

    flushPending();
    this.measureGaps(entries, spans);

    return { entries, closer, start: spans[0]?.start ?? 0, end: spans[spans.length - 1]?.end ?? 0 };
  }

  /** Sets `blank`/`blankAfter` from the whitespace between the entries and checks every entry is on lines of its own. */
  private measureGaps(entries: Entry[], spans: { start: number; end: number }[]): void {
    for (let i = 0; i < entries.length; i++) {
      entries[i].index = i;

      if (!this.startsLine(spans[i].start)) {
        throw new SharedLineError();
      }

      if (i === 0) {
        continue;
      }

      const gap = this.env.source.slice(spans[i - 1].end, spans[i].start);
      const newlines = countNewlines(gap);
      if (!/^\s*$/.test(gap) || newlines === 0) {
        throw new SharedLineError();
      }

      entries[i].blank = newlines - 1;
      entries[i].moveBlank = entries[i - 1].kind === 'member' ? newlines - 1 : 0;
      entries[i - 1].blankAfter = newlines - 1;
    }
  }

  private matchingEndif(): number {
    let depth = 0;
    for (let i = this.pos; i < this.atoms.length; i++) {
      if (this.atoms[i].type === 'preproc_if') {
        depth++;
      } else if (this.atoms[i].type === 'preproc_endif' && --depth === 0) {
        return i;
      }
    }

    throw new StructureError('an #if without an #endif');
  }

  private conditional(start: number, end: number, inner: readonly Node[], level: number): Entry {
    const members: MemberInfo[] = [];
    let hasBarrier = false;
    let regionDepth = 0;

    for (const atom of inner) {
      if (atom.type === 'preproc_region') {
        regionDepth++;
      } else if (atom.type === 'preproc_endregion') {
        regionDepth--;
      } else if (atom.type === 'comment' || isSemicolon(atom) || atom.type.startsWith('preproc_')) {
        continue;
      } else {
        const description = this.env.describe(atom);
        if (!description) {
          throw new StructureError(`unsupported syntax (${atom.type})`);
        }
        if (description.kind === 'member') {
          members.push(description.info);
        } else {
          hasBarrier = true;
        }
      }

      if (regionDepth < 0) {
        throw new StructureError('a #region that crosses an #if directive');
      }
    }

    if (regionDepth !== 0) {
      throw new StructureError('a #region that crosses an #if directive');
    }

    if (hasBarrier || members.length === 0) {
      return this.fixed(start, end, true, level);
    }

    // The block sorts as its first member and takes the initialization constraints of all of them.
    const info: MemberInfo = { ...members[0], init: mergeInitInfo(members.map((member) => member.init)) };

    return this.member(start, end, info, level);
  }

  private region(startAtom: Node, endAtom: Node, children: Entry[], level: number): RegionEntry {
    const source = this.env.source;
    const first = this.firstStart(children);
    const headGap = source.slice(this.endOf(startAtom), first ?? endAtom.startIndex);
    const last = this.lastEnd(children);
    const tailGap = source.slice(last ?? this.endOf(startAtom), endAtom.startIndex);

    if (!/^\s*$/.test(headGap) || !/^\s*$/.test(tailGap) || countNewlines(headGap) === 0 || (children.length > 0 && countNewlines(tailGap) === 0)) {
      throw new StructureError('a #region directive that shares its line');
    }

    return {
      kind: 'region',
      name: regionName(startAtom.text),
      text: '',
      startText: this.env.spanText(this.lineStart(startAtom.startIndex), this.endOf(startAtom)),
      endText: this.env.spanText(this.lineStart(endAtom.startIndex), this.endOf(endAtom)),
      children,
      headBlank: children.length > 0 ? countNewlines(headGap) - 1 : 0,
      tailBlank: children.length > 0 ? countNewlines(tailGap) - 1 : 0,
      blank: 0,
      moveBlank: 0,
      blankAfter: 0,
      level,
      index: 0,
    };
  }

  private member(start: number, end: number, info: MemberInfo, level: number): MemberEntry {
    return { kind: 'member', info, text: this.textOf(start, end), blank: 0, moveBlank: 0, blankAfter: 0, level, index: 0 };
  }

  private fixed(start: number, end: number, barrier: boolean, level: number): FixedEntry {
    return { kind: 'fixed', barrier, text: this.textOf(start, end), blank: 0, moveBlank: 0, blankAfter: 0, level, index: 0 };
  }

  private extend(entry: Entry, start: number, end: number): void {
    if (entry.kind !== 'region') {
      entry.text = this.textOf(start, end);
    }
  }

  private textOf(start: number, end: number): string {
    return this.env.spanText(this.lineStart(start), end);
  }

  // The source span of every entry, for measuring the whitespace around a region's children.
  private firstStart(children: readonly Entry[]): number | undefined {
    return children.length > 0 ? this.positionOf(children[0], 'start') : undefined;
  }

  private lastEnd(children: readonly Entry[]): number | undefined {
    return children.length > 0 ? this.positionOf(children[children.length - 1], 'end') : undefined;
  }

  private positionOf(entry: Entry, which: 'start' | 'end'): number {
    return this.positions.get(entry)![which];
  }

  /** The end of an atom; the lexer ends a comment or directive at the `\n`, so with CRLF line endings the `\r` is cut off. */
  private endOf(atom: Node): number {
    const isLine = atom.type === 'comment' || atom.type.startsWith('preproc_');

    return isLine && this.env.source[atom.endIndex - 1] === '\r' ? atom.endIndex - 1 : atom.endIndex;
  }

  private lineStart(index: number): number {
    return this.env.source.lastIndexOf('\n', index - 1) + 1;
  }

  private startsLine(index: number): boolean {
    return /^[ \t\f\v\uFEFF]*$/.test(this.env.source.slice(this.lineStart(index), index));
  }

  private newlinesBetween(start: number, end: number): number {
    return countNewlines(this.env.source.slice(start, end));
  }
}

/** The parser reports a semicolon after a member (`void M() { };`) as an incomplete declaration. */
export function isSemicolon(node: Node): boolean {
  return node.type === ';' || (node.type === 'incomplete_declaration' && node.text === ';');
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    count++;
  }

  return count;
}

/** `#region Fields` -> `Fields` (VS `RegionHelper.GetRegionName`). */
export function regionName(directive: string): string {
  return directive.trim().replace(/^#\s*region/, '').trim();
}
