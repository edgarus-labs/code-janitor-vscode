import { EditorConfigProperties } from '../editorconfig';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { Token, lex } from '../syntax/lexer';
import { isRecoveredNode, optionValue } from './editorConfigSupport';

/**
 * The `csharp_space_*` formatting options. Every rule only changes the horizontal whitespace
 * between two tokens on the same line: a gap holding a line break, a comment or a directive is
 * left alone, and string literals are single tokens, so their text never changes.
 */

/** `' '` for `true`, `''` for `false`, `undefined` when unset or anything else. */
function booleanSpace(props: EditorConfigProperties, key: string): string | undefined {
  const value = optionValue(props, key);

  return value === 'true' ? ' ' : value === 'false' ? '' : undefined;
}

const CONTROL_FLOW_KEYWORDS: Record<string, true> = {
  if: true,
  for: true,
  foreach: true,
  while: true,
  switch: true,
  catch: true,
  using: true,
  lock: true,
  fixed: true,
};

const CONTROL_FLOW_STATEMENTS = [
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'using_statement',
  'lock_statement',
  'fixed_statement',
];

const METHOD_DECLARATIONS = [
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'local_function_statement',
  'operator_declaration',
  'conversion_operator_declaration',
  'delegate_declaration',
];

/** Symbolic binary operators `csharp_space_around_binary_operators` spaces (keywords always keep theirs). */
const SYMBOLIC_BINARY = /^(?:\|\||&&|\||\^|&|==|!=|<|>|<=|>=|<<|\+|-|\*|\/|%|\?\?|=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|\?\?=)$/;

/**
 * Character pairs that lex as one token when written without a gap: the first two characters of
 * every multi-character C# token, plus the comment openers.
 */
const FUSING_PAIRS: Record<string, true> = {
  '++': true, '--': true, '&&': true, '||': true, '??': true, '?.': true, '->': true, '==': true, '!=': true,
  '<=': true, '>=': true, '<<': true, '>>': true, '+=': true, '-=': true, '*=': true, '/=': true, '%=': true,
  '&=': true, '|=': true, '^=': true, '=>': true, '::': true, '..': true, '//': true, '/*': true,
};

/** Tokens that, following a `>`, make it close a type argument list (C# spec, grammar ambiguities). */
const GENERIC_FOLLOWERS: Record<string, true> = {
  '(': true, ')': true, ']': true, '}': true, ':': true, ';': true, ',': true, '.': true, '?': true,
  '==': true, '!=': true, '|': true, '^': true, '&&': true, '||': true, '&': true, '[': true,
};

/**
 * Starts of the `>` tokens the parser reads as closing a type argument or type parameter list;
 * a `>` it reads any other way (a shift misread as two comparisons) is left out.
 */
function typeListClosers(root: Node): Set<number> {
  const closers = new Set<number>();
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as Node;
    if (node.type === '>' && (node.parent?.type === 'type_argument_list' || node.parent?.type === 'type_parameter_list')) {
      closers.add(node.startIndex);
    }

    pending.push(...node.children);
  }

  return closers;
}

/**
 * Runs of adjacent tokens that form one source token the lexer split (`>>=` lexes as `>` `>=`, so
 * the parser misreads `x >>= 2` as `(x >) >= 2`): where each run starts and where it ends. A run of
 * `>` is nested generics instead when the parser reads its last `>` as closing type arguments and a
 * token that closes type arguments follows it (`F<List<int>>()`, but not the shift `a >> (b)`).
 */
function splitTokenRuns(
  source: string,
  tokens: readonly Token[],
  closers: ReadonlySet<number>
): { starts: Set<number>; ends: Set<number> } {
  const starts = new Set<number>();
  const ends = new Set<number>();
  let first = 0;
  for (let index = 1; index <= tokens.length; index++) {
    const left = tokens[index - 1];
    const right = tokens[index] as Token | undefined;
    if (right && left.end === right.start && FUSING_PAIRS[source[left.end - 1] + source[right.start]] === true) {
      continue;
    }

    const closesGenerics =
      left.type === '>' && closers.has(left.start) && right !== undefined && GENERIC_FOLLOWERS[right.type] === true;
    if (index - 1 > first && !closesGenerics) {
      starts.add(tokens[first].start);
      ends.add(left.end);
    }

    first = index;
  }

  return { starts, ends };
}

class Gaps {
  private readonly edits = new Map<number, TextEdit>();

  constructor(
    private readonly source: string,
    /** Spans Roslyn's formatter leaves alone (multi-line collection initializers and enum lists). */
    private readonly frozen: readonly [number, number][],
    private readonly splitRuns: { starts: Set<number>; ends: Set<number> }
  ) {}

  /**
   * Sets the whitespace between `start` and `end` unless it spans a line or holds anything but spaces.
   * A gap is never emptied where its neighbours would lex as one token (`a - --b` must not become
   * `a---b`, nor `a / *p` a comment); it keeps a single space instead. Conversely, a lexer-split
   * token is never cut, and the gaps around it keep their source text: the rule asking for a change
   * comes from a misread parse (`x >>= 2` must not become `x > >= 2`, `x>>=2` must not become
   * `x>>= 2`, nor `x >>= b` become `x >>=b`).
   */
  set(start: number, end: number, text: string): void {
    if (end < start || this.edits.has(start) || this.frozen.some(([from, to]) => start >= from && start < to)) {
      return;
    }

    // The first rule deciding a gap wins, even when it keeps the gap as it is.
    if (/^[ \t]*$/.test(this.source.slice(start, end))) {
      const left = this.source[start - 1] ?? '';
      const right = this.source[end] ?? '';
      const fusingPair = FUSING_PAIRS[left + right] === true;
      const insideSplitToken = start === end && fusingPair;
      const besideSplitToken = this.splitRuns.ends.has(start) || this.splitRuns.starts.has(end);
      if (insideSplitToken || besideSplitToken) {
        this.edits.set(start, { start, end, text: this.source.slice(start, end) });
        return;
      }

      // Two word characters (identifiers, keywords, numbers) would also merge into one token.
      const fuses = text === '' && end > start && (fusingPair || (/[\w@]/.test(left) && /[\w@]/.test(right)));
      this.edits.set(start, { start, end, text: fuses ? ' ' : text });
    }
  }

  apply(): string {
    return applyEdits(
      this.source,
      [...this.edits.values()].filter((edit) => this.source.slice(edit.start, edit.end) !== edit.text)
    );
  }
}

export function applySpacing(source: string, props: EditorConfigProperties): string {
  const tree = parseCSharp(source);

  try {
    const tokens = lex(source).tokens.filter((token) => token.type !== 'end');
    const indexOf = new Map(tokens.map((token, index) => [token.start, index]));
    const gaps = new Gaps(
      source,
      frozenSpans(tree.rootNode, source),
      splitTokenRuns(source, tokens, typeListClosers(tree.rootNode))
    );
    const before = (token: Token | Node): number => {
      const index = indexOf.get('start' in token ? token.start : token.startIndex) ?? 0;

      return index > 0 ? tokens[index - 1].end : -1;
    };
    const after = (token: Token | Node): number => {
      const index = indexOf.get('start' in token ? token.start : token.startIndex);

      return index !== undefined && index + 1 < tokens.length ? tokens[index + 1].start : -1;
    };
    const endOf = (token: Token | Node): number => ('end' in token ? token.end : token.endIndex);
    const startOf = (token: Token | Node): number => ('start' in token ? token.start : token.startIndex);
    const setBefore = (token: Token | Node, text: string | undefined) => {
      const start = before(token);
      if (text !== undefined && start >= 0) {
        gaps.set(start, startOf(token), text);
      }
    };
    const setAfter = (token: Token | Node, text: string | undefined) => {
      const end = after(token);
      if (text !== undefined && end >= 0) {
        gaps.set(endOf(token), end, text);
      }
    };
    const tokenAfter = (token: Token | Node): Token | undefined => {
      const index = indexOf.get(startOf(token));

      return index === undefined ? undefined : tokens[index + 1];
    };
    const tokenBefore = (token: Token | Node): Token | undefined => {
      const index = indexOf.get(startOf(token));

      return index === undefined || index === 0 ? undefined : tokens[index - 1];
    };
    const childTokens = (node: Node, type: string) => node.children.filter((child) => child.type === type);

    // csharp_space_after/before_semicolon_in_for_statement
    const afterSemicolon = booleanSpace(props, 'csharp_space_after_semicolon_in_for_statement');
    const beforeSemicolon = booleanSpace(props, 'csharp_space_before_semicolon_in_for_statement');
    for (const statement of findAll(tree.rootNode, 'for_statement')) {
      for (const semicolon of childTokens(statement, ';')) {
        // As in Roslyn, empty parts get the spaces too: `for (; ; )`.
        const previous = tokenBefore(semicolon)?.type;
        setAfter(semicolon, afterSemicolon);
        setBefore(semicolon, previous === '(' ? '' : beforeSemicolon);
      }
    }

    // Parentheses: specific options first, so the general ones below do not override them.
    applyParentheses(tree.rootNode, props, setBefore, setAfter, tokenAfter);

    // csharp_space_after_cast
    const castSpace = booleanSpace(props, 'csharp_space_after_cast');
    if (castSpace !== undefined) {
      for (const cast of findAll(tree.rootNode, 'cast_expression')) {
        const close = childTokens(cast, ')')[0];
        const value = cast.childForFieldName('value');
        if (close && value) {
          gaps.set(close.endIndex, value.startIndex, castSpace);
        }
      }
    }

    // csharp_space_after_keywords_in_control_flow_statements
    const keywordSpace = booleanSpace(props, 'csharp_space_after_keywords_in_control_flow_statements');
    if (keywordSpace !== undefined) {
      for (const statement of findAll(tree.rootNode, CONTROL_FLOW_STATEMENTS)) {
        const children = statement.children;
        for (let i = 0; i < children.length - 1; i++) {
          if (CONTROL_FLOW_KEYWORDS[children[i].type] === true && children[i + 1].type === '(') {
            gaps.set(children[i].endIndex, children[i + 1].startIndex, keywordSpace);
          }
        }
      }
    }

    // csharp_space_before/after_colon_in_inheritance_clause (base lists, constraints, constructor initializers)
    const beforeColon = booleanSpace(props, 'csharp_space_before_colon_in_inheritance_clause');
    const afterColon = booleanSpace(props, 'csharp_space_after_colon_in_inheritance_clause');
    if (beforeColon !== undefined || afterColon !== undefined) {
      const colons = [
        ...findAll(tree.rootNode, ['base_list', 'type_parameter_constraints_clause']).flatMap((node) => childTokens(node, ':').slice(0, 1)),
        ...findAll(tree.rootNode, ['constructor_declaration', 'constructor_initializer']).flatMap((node) =>
          childTokens(node, ':').filter((colon) => ['this', 'base'].includes(tokenAfter(colon)?.type ?? ''))
        ),
      ];
      for (const colon of colons) {
        setBefore(colon, beforeColon);
        setAfter(colon, afterColon);
      }
    }

    // csharp_space_around_binary_operators
    const binary = optionValue(props, 'csharp_space_around_binary_operators');
    if (binary === 'before_and_after' || binary === 'none') {
      const space = binary === 'none' ? '' : ' ';
      // Assignments count as binary operators in Roslyn (`x += 2`); declarator `=` does not.
      const attributeArguments = findAll(tree.rootNode, 'attribute');
      for (const expression of findAll(tree.rootNode, ['binary_expression', 'assignment_expression'])) {
        // Named attribute arguments (`[A(Name = 1)]`) keep their spacing, as in Roslyn.
        if (expression.type === 'assignment_expression' && attributeArguments.some((attribute) => expression.startIndex > attribute.startIndex && expression.endIndex <= attribute.endIndex)) {
          continue;
        }

        const left = expression.childForFieldName('left');
        const right = expression.childForFieldName('right');
        const operators = expression.children.filter(
          (child) => !child.isNamed && left && right && child.startIndex >= left.endIndex && child.endIndex <= right.startIndex
        );
        if (left && right && operators.length === 1 && SYMBOLIC_BINARY.test(operators[0].type)) {
          gaps.set(left.endIndex, operators[0].startIndex, space);
          gaps.set(operators[0].endIndex, right.startIndex, space);
        }
      }
    }

    // Square brackets of element access, array ranks and collection expressions (attributes and
    // indexer declarations excluded).
    const beforeBracket = booleanSpace(props, 'csharp_space_before_open_square_brackets');
    const emptyBrackets = booleanSpace(props, 'csharp_space_between_empty_square_brackets');
    const withinBrackets = booleanSpace(props, 'csharp_space_between_square_brackets');
    for (const list of findAll(tree.rootNode, ['bracketed_argument_list', 'array_rank_specifier', 'collection_expression'])) {
      if (list.type === 'bracketed_argument_list' && list.parent?.type !== 'element_access_expression') {
        continue;
      }

      const open = list.children[0];
      const close = list.children[list.children.length - 1];
      if (open?.type !== '[' || close?.type !== ']') {
        continue;
      }

      const previous = tokenBefore(open)?.type;
      if (list.type !== 'collection_expression' && previous !== '?') {
        setBefore(open, beforeBracket);
      }

      const isEmpty = list.namedChildren.filter((child) => child.type !== 'comment').length === 0;
      if (isEmpty) {
        for (const token of list.children.slice(0, -1)) {
          setAfter(token, emptyBrackets);
        }
      } else {
        setAfter(open, withinBrackets);
        setBefore(close, withinBrackets);
      }
    }

    // csharp_space_before/after_comma (empty rank specifiers `[,]` and unbound generics `<,>` excluded)
    const beforeComma = booleanSpace(props, 'csharp_space_before_comma');
    const afterComma = booleanSpace(props, 'csharp_space_after_comma');
    if (beforeComma !== undefined || afterComma !== undefined) {
      // Roslyn leaves the commas of multi-line enum member lists, base lists, tuples,
      // deconstructions (`var (a, b)`, read as a call to `var`), `orderby` clauses and switch
      // expression arms as they are.
      const enumLists = findAll(tree.rootNode, 'enum_member_declaration_list').filter((list) => list.text.includes('\n'));
      const deconstructions = findAll(tree.rootNode, 'invocation_expression')
        .filter((call) => call.childForFieldName('function')?.text === 'var')
        .flatMap((call) => call.childForFieldName('arguments') ?? []);
      const untouched = new Set(
        [...findAll(tree.rootNode, ['base_list', 'tuple_type', 'tuple_expression', 'orderby_clause', 'switch_body']), ...deconstructions]
          .filter((node) => node.type !== 'switch_body' || node.parent?.type === 'switch_expression')
          .flatMap((node) => childTokens(node, ',').map((comma) => comma.startIndex))
      );
      tokens.forEach((token, index) => {
        if (token.type !== ',') {
          return;
        }

        const previous = tokens[index - 1]?.type;
        const next = tokens[index + 1]?.type;
        if (['[', ',', '<'].includes(previous ?? '') && [',', ']', '>'].includes(next ?? '')) {
          return;
        }

        if (untouched.has(token.start) || enumLists.some((list) => token.start > list.startIndex && token.start < list.endIndex)) {
          return;
        }

        setBefore(token, beforeComma);
        setAfter(token, afterComma);
      });
    }

    // csharp_space_before/after_dot
    const beforeDot = booleanSpace(props, 'csharp_space_before_dot');
    const afterDot = booleanSpace(props, 'csharp_space_after_dot');
    if (beforeDot !== undefined || afterDot !== undefined) {
      for (const token of tokens) {
        if (token.type === '.') {
          setBefore(token, beforeDot);
          setAfter(token, afterDot);
        }
      }
    }

    // csharp_space_around_declaration_statements = false: single spaces inside declarations.
    if (optionValue(props, 'csharp_space_around_declaration_statements') === 'false') {
      for (const declaration of findAll(tree.rootNode, ['local_declaration_statement', 'field_declaration'])) {
        const end = declarationHeadEnd(declaration);
        for (let index = indexOf.get(declaration.startIndex) ?? -1; index >= 0 && index + 1 < tokens.length; index++) {
          const next = tokens[index + 1];
          if (next.start > end) {
            break;
          }

          const gap = source.slice(tokens[index].end, next.start);
          if (gap.length > 1 && /^[ \t]+$/.test(gap)) {
            gaps.set(tokens[index].end, next.start, ' ');
          }
        }
      }
    }

    return gaps.apply();
  } finally {
    tree.delete();
  }
}

/**
 * Spans whose spacing is left alone: as in Roslyn, the contents of multi-line collection
 * expressions and of multi-line collection and array initializers (anything but object and
 * anonymous-object initializers); and, for safety, the lines of code the parser misread.
 */
function frozenSpans(root: Node, source: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const node of findAll(root, ['initializer_expression', 'collection_expression'])) {
    const open = node.children[0];
    const close = node.children[node.children.length - 1];
    if (!['{', '['].includes(open?.type ?? '') || !['}', ']'].includes(close?.type ?? '') || !source.slice(open.endIndex, close.startIndex).includes('\n')) {
      continue;
    }

    const owner = node.parent?.type;
    const items = node.namedChildren.filter((child) => child.type !== 'comment');
    const objectInitializer =
      owner === 'anonymous_object_creation_expression' ||
      ((owner === 'object_creation_expression' || owner === 'implicit_object_creation_expression') &&
        items.length > 0 &&
        items.every((item) => item.type === 'assignment_expression'));
    if (!objectInitializer) {
      spans.push([open.endIndex, close.startIndex]);
    }
  }

  const lines = (start: number, end: number) => {
    const lineEnd = source.indexOf('\n', end);
    spans.push([source.lastIndexOf('\n', start - 1) + 1, lineEnd < 0 ? source.length : lineEnd]);
  };

  for (const node of walk(root)) {
    if (isRecoveredNode(node)) {
      // Only the header of a statement whose body the parser still understood.
      const body = node.children.find((child) => child.type === 'block' || child.type === 'switch_body');
      lines(node.startIndex, body ? body.startIndex : node.endIndex);
    } else if (node.type === 'pattern' && node.children.some((child) => child.type === '<') && !node.children.some((child) => child.type === '>')) {
      // A generic type in a pattern read as comparisons: `o is Dictionary<string, object> d`.
      lines(node.startIndex, node.endIndex);
    } else if (node.type === 'tuple_expression' && hasAdjacentOperands(node)) {
      // A tuple type read as an expression: `new List<(string Id, int Count)>()`.
      let expression = node;
      while (expression.parent?.type === 'binary_expression') {
        expression = expression.parent;
      }

      lines(expression.startIndex, expression.endIndex);
    }
  }

  return spans;
}

/** True when two operands follow each other with no token between them, which no expression allows. */
function hasAdjacentOperands(node: Node): boolean {
  return node.children.some((child, index) => index > 0 && child.isNamed && node.children[index - 1].isNamed && child.type !== 'comment' && node.children[index - 1].type !== 'comment');
}

/** End of the part of a declaration before its first initializer value (type, names and `=`). */
function declarationHeadEnd(declaration: Node): number {
  const clause = declaration.descendantsOfType('equals_value_clause')[0];
  const value = clause?.namedChildren[0];

  return value ? value.startIndex : declaration.endIndex;
}

type SetGap = (token: Token | Node, text: string | undefined) => void;

/**
 * Method call and declaration parentheses, and `csharp_space_between_parentheses`
 * (`control_flow_statements`, `expressions`, `type_casts`).
 */
function applyParentheses(
  root: Node,
  props: EditorConfigProperties,
  setBefore: SetGap,
  setAfter: SetGap,
  tokenAfter: (token: Token | Node) => Token | undefined
): void {
  const inside = (open: Node, close: Node, empty: string | undefined, filled: string | undefined) => {
    if (tokenAfter(open)?.start === close.startIndex) {
      setAfter(open, empty);
    } else {
      setAfter(open, filled);
      setBefore(close, filled);
    }
  };
  const parens = (node: Node): [Node, Node] | undefined => {
    const open = node.children.find((child) => child.type === '(');
    const close = [...node.children].reverse().find((child) => child.type === ')');

    return open && close ? [open, close] : undefined;
  };

  const callName = booleanSpace(props, 'csharp_space_between_method_call_name_and_opening_parenthesis');
  const callEmpty = booleanSpace(props, 'csharp_space_between_method_call_empty_parameter_list_parentheses');
  const callFilled = booleanSpace(props, 'csharp_space_between_method_call_parameter_list_parentheses');
  // Object creation, constructor initializer and attribute arguments, and `typeof(T)`, count as
  // method calls in Roslyn: `new Foo( 1 )`, `: base( a )`, `typeof( T )`.
  const calls = findAll(root, ['invocation_expression', 'object_creation_expression', 'attribute', 'constructor_initializer', 'typeof_expression', 'sizeof_expression', 'default_expression']);
  for (const call of calls) {
    // `var (a, b) = t` is a deconstruction the parser reads as a call to `var`.
    const callee = call.type === 'invocation_expression' ? call.childForFieldName('function') : null;
    if (callee?.type === 'identifier' && callee.text === 'var') {
      continue;
    }

    const list =
      call.type === 'invocation_expression' || call.type === 'object_creation_expression'
        ? call.childForFieldName('arguments')
        : call.type === 'attribute' || call.type === 'constructor_initializer'
          ? call.namedChildren.find((child) => child.type === 'argument_list')
          : call;
    const found = list && (list.type === 'argument_list' || list === call) ? parens(list) : undefined;
    if (found) {
      if (list !== call) {
        setBefore(found[0], callName);
      }

      inside(found[0], found[1], callEmpty, callFilled);
    }
  }

  const declarationName = booleanSpace(props, 'csharp_space_between_method_declaration_name_and_open_parenthesis');
  const declarationEmpty = booleanSpace(props, 'csharp_space_between_method_declaration_empty_parameter_list_parentheses');
  const declarationFilled = booleanSpace(props, 'csharp_space_between_method_declaration_parameter_list_parentheses');
  for (const declaration of findAll(root, METHOD_DECLARATIONS)) {
    const list = declaration.childForFieldName('parameters');
    const found = list?.type === 'parameter_list' ? parens(list) : undefined;
    if (found) {
      setBefore(found[0], declarationName);
      inside(found[0], found[1], declarationEmpty, declarationFilled);
    }
  }

  // An unsupported value (a misspelled kind) is reported as such and applies nothing.
  const between = effectiveEditorConfigValue(props, 'csharp_space_between_parentheses');
  if (between === undefined) {
    return;
  }

  const kinds = new Set(between === 'false' ? [] : between.split(',').map((kind) => kind.trim()));
  const apply = (nodes: Node[], kind: string) => {
    const space = kinds.has(kind) ? ' ' : '';
    for (const node of nodes) {
      // A catch clause has two pairs: `catch (Exception e) when (filter)`.
      const pairs: [Node, Node][] = [];
      if (node.type === 'catch_clause') {
        const opens = node.children.filter((child) => child.type === '(');
        const closes = node.children.filter((child) => child.type === ')');
        opens.forEach((open, index) => closes[index] && pairs.push([open, closes[index]]));
      } else {
        const found = parens(node);
        if (found) {
          pairs.push(found);
        }
      }

      for (const [open, close] of pairs) {
        if (tokenAfter(open)?.start !== close.startIndex) {
          setAfter(open, space);
          setBefore(close, space);
        }
      }
    }
  };

  apply(findAll(root, CONTROL_FLOW_STATEMENTS), 'control_flow_statements');
  apply(findAll(root, 'parenthesized_expression'), 'expressions');
  apply(findAll(root, 'cast_expression'), 'type_casts');
}
