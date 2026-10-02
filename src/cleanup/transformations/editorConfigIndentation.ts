import { CODE, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, parseCSharp } from '../parser';
import { EditorConfigIssueReporter, describeIssue, isRecoveredNode, optionValue, positiveInt, tabWidth } from './editorConfigSupport';

/**
 * Re-indents C# code the way Roslyn's formatter does for the `csharp_indent_*` options and
 * `indent_size`. Only the leading whitespace of lines changes.
 *
 * Lines that start a construct the formatter places - a member, a statement, a brace, a `case`
 * label, `else`/`catch`/`finally` - get their column from the structure. Every other code line
 * (wrapped arguments, method chains, query clauses, anything the parser only partially
 * understood) is moved by the same amount as the line starting the innermost construct around it,
 * so its alignment relative to that line is kept. Comment and `#region` lines take the column of
 * the code that follows them. Lines starting inside a string literal or a block comment, and other
 * preprocessor directives, are never changed.
 */

/**
 * Containers whose items the formatter indents, plus object initializers (see `isStructured`). Like
 * Roslyn, collection initializers, collection expressions and switch expressions are not
 * re-indented: they move with their statement.
 */
const BRACE_CONTAINERS: Record<string, true> = {
  block: true,
  declaration_list: true,
  accessor_list: true,
  enum_member_declaration_list: true,
  switch_body: true,
  initializer_expression: true,
};

/** Statements whose embedded statement (when not a block) is indented one level. */
const EMBEDDING_STATEMENTS: Record<string, true> = {
  if_statement: true,
  while_statement: true,
  for_statement: true,
  for_each_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  do_statement: true,
};

type Rule =
  | { readonly kind: 'item'; readonly container: Node; readonly node: Node }
  | { readonly kind: 'caseContent'; readonly container: Node; readonly node: Node; readonly block: boolean }
  | { readonly kind: 'label'; readonly container: Node; readonly node: Node }
  | { readonly kind: 'switchLabel'; readonly container: Node; readonly node: Node }
  | { readonly kind: 'open'; readonly container: Node }
  | { readonly kind: 'close'; readonly container: Node }
  | { readonly kind: 'embedded'; readonly anchor: number; readonly node: Node }
  | { readonly kind: 'align'; readonly anchor: number; readonly node: Node }
  | { readonly kind: 'follow'; readonly anchor: number; readonly node: Node }
  | { readonly kind: 'top'; readonly node: Node };

interface Options {
  readonly unit: number;
  readonly tabWidth: number;
  readonly blockContents: boolean;
  readonly braces: boolean;
  readonly switchLabels: boolean;
  readonly caseContents: boolean;
  readonly caseContentsWhenBlock: boolean;
  readonly labels: string;
  readonly style: string | undefined;
}

interface Line {
  readonly start: number;
  /** Index of the first non-blank character, or the line end for a blank line. */
  readonly first: number;
  readonly column: number;
  readonly indentation: string;
  /** Leading whitespace belongs to a string, a block comment or a preprocessor directive. */
  readonly fixed: boolean;
  readonly blank: boolean;
  /** Starts with a comment or `#region`/`#endregion`: indented like the code after it. */
  readonly trivia: boolean;
}

function readOptions(props: EditorConfigProperties): Options {
  const width = tabWidth(props);
  const size = optionValue(props, 'indent_size');

  return {
    unit: size === 'tab' ? width : (positiveInt(size) ?? 4),
    tabWidth: width,
    blockContents: optionValue(props, 'csharp_indent_block_contents') !== 'false',
    braces: optionValue(props, 'csharp_indent_braces') === 'true',
    switchLabels: optionValue(props, 'csharp_indent_switch_labels') !== 'false',
    caseContents: optionValue(props, 'csharp_indent_case_contents') !== 'false',
    caseContentsWhenBlock: optionValue(props, 'csharp_indent_case_contents_when_block') !== 'false',
    labels: optionValue(props, 'csharp_indent_labels') ?? 'one_less_than_current',
    style: optionValue(props, 'indent_style'),
  };
}

export function applyIndentation(source: string, props: EditorConfigProperties, report: EditorConfigIssueReporter): string {
  const options = readOptions(props);
  const tree = parseCSharp(source);

  try {
    return new Indenter(source, tree.rootNode, options, report).run();
  } finally {
    tree.delete();
  }
}

/** True when a container child ends a complete item: a separator, or a node ending in `;` or `}`. */
function isComplete(node: Node): boolean {
  if (!node.isNamed) {
    return node.type === ',' || node.type === ';' || node.type === '{';
  }

  let last: Node | undefined = node;
  while (last && last.children.length > 0) {
    last = [...last.children].reverse().find((child) => child.type !== 'comment');
  }

  return !isRecoveredNode(node) && (last?.type === ';' || last?.type === '}' || node.type === 'labeled_statement');
}

class Indenter {
  private readonly kinds: Uint8Array;
  private readonly lines: Line[] = [];
  private readonly rules = new Map<number, Rule>();
  /** Nodes whose start line anchors the continuation lines inside them, in document order. */
  private readonly anchors: Node[] = [];
  private readonly tokenStarts: number[] = [];
  private readonly memo = new Map<number, number>();
  private readonly computing = new Set<number>();
  private readonly containers = new Map<Node, { open: number; content: number; close: number }>();

  constructor(
    private readonly source: string,
    private readonly root: Node,
    private readonly options: Options,
    private readonly report: EditorConfigIssueReporter
  ) {
    this.kinds = classifyCSharp(source);
  }

  run(): string {
    this.readLines();
    this.keepLinesAfterUnbalancedConditional();
    this.collect(this.root);
    this.collectTokens(this.root);
    this.tokenStarts.sort((a, b) => a - b);
    this.anchors.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);

    const edits: TextEdit[] = [];
    this.lines.forEach((line, index) => {
      if (line.blank || line.fixed) {
        return;
      }

      const column = this.newColumn(index);
      if (column !== line.column) {
        edits.push({ start: line.start, end: line.first, text: this.indentation(column, line.indentation) });
      }
    });

    return applyEdits(this.source, edits);
  }

  private indentation(column: number, original: string): string {
    const useTabs = this.options.style === 'tab' || (this.options.style === undefined && original.includes('\t'));

    return useTabs
      ? '\t'.repeat(Math.floor(column / this.options.tabWidth)) + ' '.repeat(column % this.options.tabWidth)
      : ' '.repeat(column);
  }

  private readLines(): void {
    const source = this.source;
    for (let start = 0; start <= source.length; ) {
      let first = start;
      while (source[first] === ' ' || source[first] === '\t') {
        first++;
      }

      const newline = source.indexOf('\n', start);
      const end = newline < 0 ? source.length : newline;
      const text = source.slice(first, end).replace(/\r$/, '');
      // The line break before the line belongs to a string or block comment the line continues.
      const continues = start > 0 && this.kinds[start - 1] !== CODE;
      const blank = text.length === 0;
      const directive = !blank && !continues && text.startsWith('#');
      const region = directive && /^#\s*(?:region|endregion)\b/.test(text);
      const commentStart = !blank && !continues && (text.startsWith('//') || text.startsWith('/*'));
      const indentation = source.slice(start, first);
      let column = 0;
      for (const ch of indentation) {
        column = ch === '\t' ? column + this.options.tabWidth - (column % this.options.tabWidth) : column + 1;
      }

      this.lines.push({
        start,
        first,
        column,
        indentation,
        blank,
        fixed: continues || (directive && !region),
        trivia: region || commentStart,
      });

      if (newline < 0) {
        break;
      }

      start = newline + 1;
    }
  }

  /**
   * The parser reads every branch of `#if`/`#elif`/`#else`, while the compiler (and Roslyn's
   * formatter) sees one. When a branch leaves a brace or parenthesis open or closes one it did not
   * open (each branch opening its own `foreach (...) {`), the parsed nesting is off from there to
   * the end of the file, so those lines keep their indentation and the group is reported.
   */
  private keepLinesAfterUnbalancedConditional(): void {
    const source = this.source;
    // Per open `#if`: its first line and the brace and parenthesis depth of its current branch.
    const groups: { line: number; braces: number; parens: number }[] = [];
    let unbalancedFrom = -1;

    this.lines.forEach((line, index) => {
      const end = index + 1 < this.lines.length ? this.lines[index + 1].start : source.length;
      const isDirective = line.fixed && source[line.first] === '#' && this.kinds[line.first] === CODE;
      const directive = isDirective ? /^#\s*(if|elif|else|endif)\b/.exec(source.slice(line.first, end))?.[1] : undefined;
      if (directive !== undefined) {
        const group = groups[groups.length - 1];
        if (directive === 'if') {
          groups.push({ line: index, braces: 0, parens: 0 });
        } else if (group) {
          if (group.braces !== 0 || group.parens !== 0) {
            unbalancedFrom = unbalancedFrom < 0 ? group.line : Math.min(unbalancedFrom, group.line);
          }

          group.braces = 0;
          group.parens = 0;
          if (directive === 'endif') {
            groups.pop();
          }
        }

        return;
      }

      for (let i = line.start; i < end && groups.length > 0; i++) {
        if (this.kinds[i] !== CODE) {
          continue;
        }

        const braces = source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0;
        const parens = source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0;
        for (const group of braces !== 0 || parens !== 0 ? groups : []) {
          group.braces += braces;
          group.parens += parens;
        }
      }
    });

    if (unbalancedFrom < 0) {
      return;
    }

    this.report(
      describeIssue('IDE0055', 'indentation', source, this.lines[unbalancedFrom].first, 'the lines from here to the end of the file keep their indentation: a branch of this #if group leaves a brace or parenthesis unbalanced.')
    );
    for (let index = unbalancedFrom; index < this.lines.length; index++) {
      this.lines[index] = { ...this.lines[index], fixed: true };
    }
  }

  private lineOf(position: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lines[middle].start <= position) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return low;
  }

  private firstOnLine(position: number): boolean {
    return this.lines[this.lineOf(position)].first === position;
  }

  private set(position: number, rule: Rule): void {
    if (!this.rules.has(position)) {
      this.rules.set(position, rule);
    }

    if ('node' in rule) {
      this.anchors.push(rule.node);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Structure
  // ------------------------------------------------------------------------------------------

  private collect(node: Node): void {
    if (isRecoveredNode(node)) {
      // The parser only partially understood this code: its lines move with its first line. A
      // statement whose header it could not read (`while ((x = Next()) is not null)`) still has
      // a well-formed body block, which is indented as usual.
      this.anchors.push(node);
      for (const child of node.namedChildren) {
        if (child.type === 'block' && EMBEDDING_STATEMENTS[node.type] === true) {
          this.collect(child);
        }
      }

      return;
    }

    if (node.type === 'compilation_unit' || node.type === 'file_scoped_namespace_declaration') {
      const name = node.childForFieldName('name');
      for (const child of node.namedChildren) {
        if (child !== name && child.type !== 'comment' && !child.type.startsWith('preproc')) {
          this.set(child.startIndex, { kind: 'top', node: child });
        }
      }
    }

    if (BRACE_CONTAINERS[node.type] === true && this.isStructured(node)) {
      this.collectContainer(node);
    }

    if (EMBEDDING_STATEMENTS[node.type] === true) {
      this.collectEmbedded(node);
    }

    if (node.type === 'try_statement') {
      for (const clause of node.namedChildren.filter((child) => child.type === 'catch_clause' || child.type === 'finally_clause')) {
        this.set(clause.startIndex, { kind: 'align', anchor: node.startIndex, node: clause });
      }
    }

    for (const child of node.namedChildren) {
      this.collect(child);
    }
  }

  private isStructured(container: Node): boolean {
    const open = container.children[0];
    const close = container.children[container.children.length - 1];
    if (open?.type !== '{' || close?.type !== '}') {
      return false;
    }

    if (container.type === 'switch_body') {
      return container.parent?.type === 'switch_statement';
    }

    if (container.type !== 'initializer_expression') {
      return true;
    }

    // Object initializers (`new T { A = 1 }`, `{ ["key"] = v }`) and anonymous objects only.
    const items = container.namedChildren.filter((child) => child.type !== 'comment');
    const owner = container.parent?.type;

    return (
      (owner === 'object_creation_expression' || owner === 'implicit_object_creation_expression' || owner === 'anonymous_object_creation_expression') &&
      items.length > 0 &&
      (owner === 'anonymous_object_creation_expression' || items.every((item) => item.type === 'assignment_expression'))
    );
  }

  private collectContainer(container: Node): void {
    const open = container.children[0];
    const close = container.children[container.children.length - 1];
    this.set(open.startIndex, { kind: 'open', container });
    this.set(close.startIndex, { kind: 'close', container });

    if (container.type === 'switch_body') {
      this.collectSwitchSections(container);
      return;
    }

    let previous: Node | undefined;
    let lastReliable: Node | undefined;
    let reported = false;
    for (const child of container.children.slice(1, -1)) {
      if (child.type === 'comment' || child.type.startsWith('preproc')) {
        continue;
      }

      if (!child.isNamed) {
        previous = child;
        continue;
      }

      // An item only starts cleanly after a complete one: fragments of code the parser could not
      // read (and the recovered item itself) follow the last clean item instead.
      const clean = !isRecoveredNode(child) && (!previous || isComplete(previous));
      previous = child;
      if (!clean) {
        if (!reported) {
          reported = true;
          this.report(describeIssue('IDE0055', 'indentation', this.source, child.startIndex, 'some lines keep their relative indentation, the code could not be fully parsed.'));
        }

        this.set(child.startIndex, { kind: 'follow', anchor: (lastReliable ?? container).startIndex, node: child });
        continue;
      }

      lastReliable = child;
      this.set(child.startIndex, child.type === 'labeled_statement' ? { kind: 'label', container, node: child } : { kind: 'item', container, node: child });
      this.alignAttributes(child);
    }
  }

  /** Attribute lines and the declaration after them line up with the start of the member. */
  private alignAttributes(member: Node): void {
    const attributes = member.children.filter((child) => child.type === 'attribute_list');
    if (attributes.length === 0) {
      return;
    }

    for (const attribute of attributes.slice(1)) {
      this.set(attribute.startIndex, { kind: 'align', anchor: member.startIndex, node: attribute });
    }

    const last = attributes[attributes.length - 1];
    const declaration = member.children.find((child) => child.startIndex >= last.endIndex && child.type !== 'comment');
    if (declaration) {
      this.set(declaration.startIndex, { kind: 'align', anchor: member.startIndex, node: declaration });
    }
  }

  private collectSwitchSections(body: Node): void {
    let inLabel = false;
    for (const child of body.children) {
      if (child.type === 'case' || child.type === 'default') {
        inLabel = true;
        this.set(child.startIndex, { kind: 'switchLabel', container: body, node: child });
        continue;
      }

      if (inLabel) {
        inLabel = child.type !== ':';
        continue;
      }

      if (child.isNamed && child.type !== 'comment' && !child.type.startsWith('preproc')) {
        this.set(child.startIndex, { kind: 'caseContent', container: body, node: child, block: child.type === 'block' });
      }
    }
  }

  private collectEmbedded(statement: Node): void {
    const children = statement.children;
    const bodyAfter = (index: number): Node | undefined => {
      const body = children.slice(index).find((child) => child.isNamed && child.type !== 'comment');

      return body && body.type !== 'block' ? body : undefined;
    };

    if (statement.type === 'do_statement') {
      const body = bodyAfter(1);
      if (body) {
        this.set(body.startIndex, { kind: 'embedded', anchor: statement.startIndex, node: body });
      }

      const whileKeyword = children.find((child) => child.type === 'while');
      if (whileKeyword) {
        this.set(whileKeyword.startIndex, { kind: 'align', anchor: statement.startIndex, node: whileKeyword });
      }

      return;
    }

    const close = children.findIndex((child) => child.type === ')');
    const elseIndex = children.findIndex((child) => child.type === 'else');
    const consequence = close >= 0 ? bodyAfter(close + 1) : undefined;
    if (consequence && (elseIndex < 0 || consequence.startIndex < children[elseIndex].startIndex)) {
      // Stacked `using (a)` / `using (b)` statements keep one indentation, as in Roslyn.
      const stacked = statement.type === 'using_statement' && consequence.type === 'using_statement';
      this.set(consequence.startIndex, { kind: stacked ? 'align' : 'embedded', anchor: statement.startIndex, node: consequence });
    }

    if (elseIndex >= 0) {
      const elseKeyword = children[elseIndex];
      this.set(elseKeyword.startIndex, { kind: 'align', anchor: statement.startIndex, node: elseKeyword });
      const alternative = bodyAfter(elseIndex + 1);
      if (alternative) {
        this.set(alternative.startIndex, { kind: 'embedded', anchor: elseKeyword.startIndex, node: alternative });
      }
    }
  }

  private collectTokens(node: Node): void {
    if (node.children.length === 0) {
      if (node.type !== 'comment' && !node.type.startsWith('preproc')) {
        this.tokenStarts.push(node.startIndex);
      }

      return;
    }

    for (const child of node.children) {
      this.collectTokens(child);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Columns
  // ------------------------------------------------------------------------------------------

  private newColumn(lineIndex: number): number {
    const cached = this.memo.get(lineIndex);
    if (cached !== undefined) {
      return cached;
    }

    const line = this.lines[lineIndex];
    if (line.blank || line.fixed || this.computing.has(lineIndex)) {
      return line.column;
    }

    this.computing.add(lineIndex);
    let column: number;
    if (line.trivia) {
      column = this.triviaColumn(lineIndex);
    } else {
      const rule = this.rules.get(line.first);
      column = rule ? this.ruleColumn(rule) : this.continuationColumn(lineIndex);
    }

    this.computing.delete(lineIndex);
    column = Math.max(0, column);
    this.memo.set(lineIndex, column);

    return column;
  }

  private delta(lineIndex: number): number {
    return this.newColumn(lineIndex) - this.lines[lineIndex].column;
  }

  private columnOfLineAt(position: number): number {
    return this.newColumn(this.lineOf(position));
  }

  private ruleColumn(rule: Rule): number {
    const { unit, labels, switchLabels, caseContents, caseContentsWhenBlock } = this.options;
    switch (rule.kind) {
      case 'top':
        return 0;
      case 'item':
        return this.container(rule.container).content;
      case 'open':
        return this.container(rule.container).open;
      case 'close':
        return this.container(rule.container).close;
      case 'embedded':
        return this.columnOfLineAt(rule.anchor) + unit;
      case 'align':
        return this.columnOfLineAt(rule.anchor);
      case 'follow': {
        const anchorLine = this.lineOf(rule.anchor);

        return this.lines[this.lineOf(rule.node.startIndex)].column + this.delta(anchorLine);
      }
      case 'switchLabel':
        return this.container(rule.container).content - unit + (switchLabels ? unit : 0);
      case 'caseContent': {
        const label = this.container(rule.container).content - unit + (switchLabels ? unit : 0);

        return label + ((rule.block ? caseContentsWhenBlock : caseContents) ? unit : 0);
      }
      case 'label': {
        if (labels === 'flush_left') {
          return 0;
        }

        const content = this.container(rule.container).content;

        return labels === 'no_change' ? this.lines[this.lineOf(rule.node.startIndex)].column : Math.max(0, content - unit);
      }
    }
  }

  /** Columns of a container's braces and items: relative to the line owning its opening brace. */
  private container(container: Node): { open: number; content: number; close: number } {
    const known = this.containers.get(container);
    if (known) {
      return known;
    }

    const { unit, braces, blockContents } = this.options;
    const open = container.children[0];
    // Roslyn's `csharp_indent_braces` leaves the braces of lambdas and anonymous methods alone.
    const ownerType = container.parent?.type;
    const braceOffset = braces && ownerType !== 'lambda_expression' && ownerType !== 'anonymous_method_expression' ? unit : 0;
    let owner: number;
    let openColumn: number;
    const ownRule = this.rules.get(open.startIndex);
    if (!this.firstOnLine(open.startIndex)) {
      owner = this.columnOfLineAt(open.startIndex);
      openColumn = owner;
    } else if (ownRule && ownRule.kind !== 'open') {
      // The brace starts an item of its own (a nested block or initializer): it is the owner.
      owner = this.ruleColumn(ownRule);
      openColumn = owner;
    } else {
      const ownerStart = container.parent && this.lineOf(container.parent.startIndex) < this.lineOf(open.startIndex) ? container.parent.startIndex : open.startIndex;
      owner = ownerStart === open.startIndex ? this.lines[this.lineOf(open.startIndex)].column : this.columnOfLineAt(ownerStart);
      openColumn = owner + braceOffset;
    }

    // As in Roslyn, `csharp_indent_block_contents` concerns statement blocks only: type bodies,
    // accessor lists, initializers and `switch` sections are always indented one level.
    const content = owner + (container.type !== 'block' || blockContents ? unit : 0);
    const result = { open: openColumn, content, close: owner + (ownRule && ownRule.kind !== 'open' ? 0 : braceOffset) };
    this.containers.set(container, result);

    return result;
  }

  /** A line inside a construct keeps its offset from the line where the construct starts. */
  private continuationColumn(lineIndex: number): number {
    const line = this.lines[lineIndex];
    const anchor = this.innermostAnchor(line.first, lineIndex);

    return anchor === undefined ? line.column : line.column + this.delta(anchor);
  }

  private innermostAnchor(position: number, lineIndex: number): number | undefined {
    let best: Node | undefined;
    for (const node of this.anchors) {
      if (node.startIndex >= position) {
        break;
      }

      if (node.endIndex > position && this.lineOf(node.startIndex) < lineIndex) {
        if (!best || node.startIndex >= best.startIndex) {
          best = node;
        }
      }
    }

    return best ? this.lineOf(best.startIndex) : undefined;
  }

  /** A comment or `#region` line takes the column of the code after it. */
  private triviaColumn(lineIndex: number): number {
    const line = this.lines[lineIndex];
    const next = this.nextToken(line.first);
    const rule = next === undefined ? undefined : this.rules.get(next);
    if (rule?.kind === 'close') {
      return this.container(rule.container).content;
    }

    if (rule && next !== undefined && this.firstOnLine(next)) {
      return this.ruleColumn(rule);
    }

    return this.continuationColumn(lineIndex);
  }

  private nextToken(position: number): number | undefined {
    let low = 0;
    let high = this.tokenStarts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.tokenStarts[middle] < position) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    return this.tokenStarts[low];
  }
}
