import { CODE, classifyCSharp } from '../cleanup/csharpScanner';
import { resolveEditorConfigProperties } from '../cleanup/editorconfig';
import { Node, TextEdit, applyEdits, parseCSharp } from '../cleanup/parser';
import { lex } from '../cleanup/syntax/lexer';
import { createEditorConfigFormattingConverter } from '../cleanup/transformations/editorConfigFormatting';
import { SourceTransformation } from '../cleanup/types';
import { parseErrorCount } from '../cleanup/transformations/editorConfigSupport';
import { RazorLayout, indentUnitOf } from './razorOptions';

/**
 * Whitespace-only C# layout for the code of Razor blocks, the counterpart of Roslyn's
 * `NormalizeWhitespace` in the Visual Studio extension: the code is wrapped in a dummy class (members) or
 * method (statements), laid out with the extension's own C# formatting engine under fixed
 * Roslyn-default rules (Allman braces, one statement per line, single spaces around operators,
 * no `.editorconfig` of the user), and unwrapped again.
 *
 * A result is only used when it is provably the same code: the wrapped code must parse without
 * recovery, and the result must have exactly the tokens of the input, in order. Anything else
 * yields `undefined` and the caller leaves the code as authored.
 */

const WRAPPER_CLASS = 'class __CodeJanitorRazorDummy__\n{\n';

/** Lays out class members (`@code` / `@functions` bodies) and returns them relative to column 0. */
export function layoutMembers(content: string, options: RazorLayout): string | undefined {
  return layout(content, WRAPPER_CLASS, '\n}', 1, options);
}

/** Lays out statements (code inside a control block) and returns them relative to column 0. */
export function layoutStatements(content: string, options: RazorLayout): string | undefined {
  const unit = indentUnitOf(options);

  return layout(content, `${WRAPPER_CLASS}${unit}void __M()\n${unit}{\n`, `\n${unit}}\n}`, 2, options);
}

/** Lays out only a control-flow header such as `if(a&&b)`; `header` is the keyword and condition. */
export function layoutControlHeader(header: string, options: RazorLayout): string | undefined {
  const laid = layoutStatements(`${header}\n{\n}`, options);
  if (laid === undefined) {
    return undefined;
  }

  const brace = laid.lastIndexOf('\n{');

  return brace < 0 ? undefined : laid.slice(0, brace).trim();
}

function layout(content: string, prefix: string, suffix: string, depth: number, options: RazorLayout): string | undefined {
  if (content.trim().length === 0 || content.includes('\r')) {
    return undefined;
  }

  const wrapped = `${prefix}${content}${suffix}`;
  if (!isCleanCode(wrapped)) {
    return undefined;
  }

  const laidOut = collapseAutoProperties(engineFor(options).apply(prepare(wrapped)));
  if (!laidOut.startsWith(prefix) || !laidOut.endsWith(suffix)) {
    return undefined;
  }

  const inner = laidOut.slice(prefix.length, laidOut.length - suffix.length);
  const relative = dedent(inner, depth, options);
  if (relative === undefined || !sameTokens(wrapped, `${prefix}${relative}${suffix}`) || !isCleanCode(`${prefix}${relative}${suffix}`)) {
    return undefined;
  }

  return relative.replace(/^\n+|\s+$/g, '');
}

/** Code the parser read without recovering anywhere and whose brackets are balanced. */
function isCleanCode(source: string): boolean {
  if (parseErrorCount(source) > 0) {
    return false;
  }

  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const token of lex(source).tokens) {
    if (token.type === '(' || token.type === '[' || token.type === '{') {
      stack.push(token.type);
    } else if (token.type in pairs && stack.pop() !== pairs[token.type]) {
      return false;
    }
  }

  return stack.length === 0;
}

/** The tokens (kind and text) and comments of the source, in order; layout never changes them. */
function sameTokens(before: string, after: string): boolean {
  const flatten = (source: string): string[] => {
    const result = lex(source);

    return [...result.tokens, ...result.trivia]
      .sort((a, b) => a.start - b.start)
      .map((token) => `${token.type}\u0000${source.slice(token.start, token.end).replace(/[ \t]*\n[ \t]*/g, '\n')}`);
  };
  const left = flatten(before);
  const right = flatten(after);

  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Removes `depth` indent levels from every line whose leading whitespace is layout. A line that
 * starts inside a string literal or a block comment keeps its text: it is part of that token.
 */
function dedent(inner: string, depth: number, options: RazorLayout): string | undefined {
  const prefix = indentUnitOf(options).repeat(depth);
  const kinds = classifyCSharp(inner);
  const lines = inner.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indented = /^[ \t]/.test(line) && line.trim().length > 0;
    if (indented && kinds[offset] === CODE) {
      if (!line.startsWith(prefix)) {
        return undefined;
      }

      lines[i] = line.slice(prefix.length);
    }

    offset += line.length + 1;
  }

  return lines.join('\n');
}

const engines = new Map<string, SourceTransformation>();

function engineFor(options: RazorLayout): SourceTransformation {
  const key = `${options.indentStyle}${options.indentSize}`;
  let engine = engines.get(key);
  if (!engine) {
    const props = resolveEditorConfigProperties([{ directory: '/', text: ENGINE_RULES(options) }], '/razor.cs');
    engine = createEditorConfigFormattingConverter(props, () => undefined);
    engines.set(key, engine);
  }

  return engine;
}

const ENGINE_RULES = (options: RazorLayout): string => `root = true
[*.cs]
indent_style = ${options.indentStyle}
indent_size = ${options.indentSize}
tab_width = ${options.indentSize}
dotnet_diagnostic.IDE0055.severity = warning
csharp_new_line_before_open_brace = accessors, anonymous_methods, anonymous_types, control_blocks, events, indexers, lambdas, local_functions, methods, object_collection_array_initializers, properties, types
csharp_new_line_before_else = true
csharp_new_line_before_catch = true
csharp_new_line_before_finally = true
csharp_preserve_single_line_statements = false
csharp_preserve_single_line_blocks = true
csharp_indent_case_contents = true
csharp_indent_switch_labels = true
csharp_indent_block_contents = true
csharp_indent_braces = false
csharp_space_after_keywords_in_control_flow_statements = true
csharp_space_around_binary_operators = before_and_after
csharp_space_between_parentheses = false
csharp_space_after_comma = true
csharp_space_before_comma = false
csharp_space_after_cast = false
csharp_space_before_colon_in_inheritance_clause = true
csharp_space_after_colon_in_inheritance_clause = true
csharp_space_before_semicolon_in_for_statement = false
csharp_space_after_semicolon_in_for_statement = true
csharp_space_before_dot = false
csharp_space_after_dot = false
csharp_space_between_method_call_parameter_list_parentheses = false
csharp_space_between_method_declaration_parameter_list_parentheses = false
csharp_space_between_method_call_name_and_opening_parenthesis = false
csharp_space_between_method_declaration_name_and_open_parenthesis = false
`;

/** Operators of assignments and initializers that take a space on both sides. */
const ASSIGNMENT_OPERATOR = /^(?:[-+*/%&|^]|<<|>>>?|\?\?)?=$/;

/**
 * Layout the formatting engine does not do: spaces around `=`, `=>` and the `?:` operator, one member per line, one
 * enum member per line, and one switch label / statement per line.
 */
function prepare(source: string): string {
  const tree = parseCSharp(source);
  try {
    const edits = new Map<string, TextEdit>();
    const add = (list: readonly TextEdit[]): void => list.forEach((edit) => edits.set(`${edit.start}:${edit.end}`, edit));
    const visit = (node: Node): void => {
      const children = node.children;
      if (node.type === 'equals_value_clause' || node.type === 'property_declaration') {
        add(spaceAroundToken(source, children.find((child) => child.type === '=')));
      } else if (node.type === 'assignment_expression') {
        add(spaceAroundToken(source, children.find((child) => ASSIGNMENT_OPERATOR.test(child.type))));
      }

      add(spaceAroundToken(source, children.find((child) => child.type === '=>')));
      if (node.type === 'conditional_expression') {
        children.filter((child) => child.type === '?' || child.type === ':').forEach((token) => add(spaceAroundToken(source, token)));
      }

      if (node.type === 'switch_body' && node.parent?.type === 'switch_statement') {
        add(splitSwitchBody(source, children));
      } else if (node.type === 'declaration_list') {
        add(breakBetween(source, children.filter((child) => child.isNamed && child.type !== 'comment'), () => true));
      } else if (node.type === 'enum_member_declaration_list') {
        add(explodeEnumList(source, children));
      }

      if (expandsToLines(node)) {
        add(expandBraces(source, children));
      }

      children.forEach(visit);
    };
    visit(tree.rootNode);

    return outdentDirectives(applyEdits(source, [...edits.values()]));
  } finally {
    tree.delete();
  }
}

const BLOCK_OWNERS: Record<string, true> = {
  method_declaration: true,
  constructor_declaration: true,
  destructor_declaration: true,
  operator_declaration: true,
  conversion_operator_declaration: true,
  local_function_statement: true,
  anonymous_method_expression: true,
  block: true,
  if_statement: true,
  else_clause: true,
  while_statement: true,
  for_statement: true,
  for_each_statement: true,
  do_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  try_statement: true,
  checked_statement: true,
  unchecked_statement: true,
  unsafe_statement: true,
};

/** Braces Roslyn puts on lines of their own: bodies of members and statements, and of types. Lambda bodies, initializers and patterns stay as written. */
function expandsToLines(node: Node): boolean {
  const owner = node.parent;
  if (!owner) {
    return false;
  }

  switch (node.type) {
    case 'block':
      if (owner.type === 'catch_clause' || owner.type === 'finally_clause') {
        return node.namedChildren.some((child) => child.type !== 'comment');
      }

      return owner.type === 'accessor_declaration' ? owner.parent?.parent?.type !== 'event_declaration' : BLOCK_OWNERS[owner.type] === true;
    case 'declaration_list':
      return true;
    case 'switch_body':
      return owner.type === 'switch_statement';
    default:
      return false;
  }
}

/** A line break after the opening and before the closing brace of a container written on one line. */
function expandBraces(source: string, children: readonly Node[]): TextEdit[] {
  const edits: TextEdit[] = [];
  if (children[0]?.type !== '{' || children[children.length - 1]?.type !== '}') {
    return edits;
  }

  for (const i of [0, children.length - 2]) {
    const gap = source.slice(children[i].endIndex, children[i + 1].startIndex);
    if (/^[ \t]*$/.test(gap) && (i === 0 || children.length > 2)) {
      edits.push({ start: children[i].endIndex, end: children[i + 1].startIndex, text: '\n' });
    }
  }

  return edits;
}

function spaceAroundToken(source: string, token: Node | undefined): TextEdit[] {
  return token ? spaceAround(source, token.startIndex, token.endIndex) : [];
}

/** A line break between neighbours written on one line (`int a; int b;`). */
function breakBetween(source: string, nodes: readonly Node[], applies: (next: Node) => boolean): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const gap = source.slice(nodes[i - 1].endIndex, nodes[i].startIndex);
    if (applies(nodes[i]) && /^[ \t]*$/.test(gap)) {
      edits.push({ start: nodes[i - 1].endIndex, end: nodes[i].startIndex, text: '\n' });
    }
  }

  return edits;
}

/** An enum body with one member per line, braces on lines of their own. */
function explodeEnumList(source: string, children: readonly Node[]): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let i = 0; i + 1 < children.length; i++) {
    const gap = source.slice(children[i].endIndex, children[i + 1].startIndex);
    const breaks = children[i].type === '{' || children[i].type === ',' || children[i + 1].type === '}';
    if (breaks && /^[ \t]*$/.test(gap)) {
      edits.push({ start: children[i].endIndex, end: children[i + 1].startIndex, text: '\n' });
    }
  }

  return edits;
}

/** Auto-properties keep their accessors on the property's line: `{ get; set; }`. */
function collapseAutoProperties(source: string): string {
  const tree = parseCSharp(source);
  try {
    const edits: TextEdit[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'accessor_list' && node.parent?.type === 'property_declaration') {
        const accessors = node.children.filter((child) => child.type === 'accessor_declaration');
        const plain = accessors.length > 0 && accessors.every((accessor) => accessor.text.endsWith(';') && !accessor.text.includes('\n'));
        const holdsOnlyAccessors = node.children.length === accessors.length + 2;
        if (plain && holdsOnlyAccessors) {
          const before = endOfPreviousToken(source, node.startIndex);
          if (before >= 0) {
            edits.push({ start: before, end: node.endIndex, text: ` { ${accessors.map((accessor) => accessor.text).join(' ')} }` });
          }
        }
      }

      node.children.forEach(visit);
    };
    visit(tree.rootNode);

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** The end of the code before `index` when only whitespace lies between (and no comment could swallow the join); -1 otherwise. */
function endOfPreviousToken(source: string, index: number): number {
  let end = index;
  while (end > 0 && /\s/.test(source[end - 1])) {
    end--;
  }

  const lineStart = source.lastIndexOf('\n', end - 1) + 1;

  return end > 0 && !source.slice(lineStart, end).includes('//') && !source.slice(end - 2, end).includes('*/') ? end : -1;
}

/** Preprocessor directives always start in column 0, as Roslyn's normalizer puts them. */
function outdentDirectives(source: string): string {
  const kinds = classifyCSharp(source);

  return source.replace(/^[ \t]+(?=#)/gm, (match, offset: number) => (kinds[offset + match.length] === CODE ? '' : match));
}

function spaceAround(source: string, start: number, end: number): TextEdit[] {
  const edits: TextEdit[] = [];
  let before = start;
  while (before > 0 && (source[before - 1] === ' ' || source[before - 1] === '\t')) {
    before--;
  }

  if (before > 0 && source[before - 1] !== '\n' && source.slice(before, start) !== ' ') {
    edits.push({ start: before, end: start, text: ' ' });
  }

  let after = end;
  while (after < source.length && (source[after] === ' ' || source[after] === '\t')) {
    after++;
  }

  if (after < source.length && source[after] !== '\n' && source[after] !== '\r' && source.slice(end, after) !== ' ') {
    edits.push({ start: end, end: after, text: ' ' });
  }

  return edits;
}

/** Puts every `case`/`default` label and every statement of a switch body on a line of its own. */
function splitSwitchBody(source: string, children: readonly Node[]): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    const previous = children[i - 1];
    const gap = source.slice(previous.endIndex, child.startIndex);
    if (gap.includes('\n') || !/^[ \t]*$/.test(gap)) {
      continue;
    }

    const afterStatement = previous.type.endsWith('_statement') || previous.type === 'block';
    if (child.type === 'case' || child.type === 'default' || child.type === '}' || previous.type === '{' || previous.type === ':' || afterStatement) {
      edits.push({ start: previous.endIndex, end: child.startIndex, text: '\n' });
    }
  }

  return edits;
}
