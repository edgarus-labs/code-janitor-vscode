import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { targetsAtLeast } from '../projectInfo';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { returnType } from './editorConfigStatementPreferences';
import { describeIssue, hasParseErrors, readCodeStyleOption } from './editorConfigSupport';

/**
 * `dotnet_style_prefer_collection_expression` (IDE0300 - IDE0306): collection creations become
 * collection expressions (`[1, 2]`, `[]`, `[.. xs]`), but only where the type written for the
 * target (declaration, property, return type) is exactly the type created: a collection expression
 * converted to another type (`IEnumerable<T>`, `object[]` for `new[] { "a" }`) can create a
 * different runtime type. `var` and arguments (whose overload could change) are left alone.
 * https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0300
 * https://learn.microsoft.com/dotnet/csharp/language-reference/operators/collection-expressions
 */

export const COLLECTION_EXPRESSION_OPTION = 'dotnet_style_prefer_collection_expression';
const APPLYING_VALUES: Record<string, true> = { true: true, when_types_exactly_match: true, when_types_loosely_match: true };

const normalize = (text: string): string => text.replace(/\s+/g, '').replace(/^System\.Collections\.Generic\./, '');

/** The type written for the value `expression` initializes or returns, without spaces. */
function targetTypeOf(expression: Node): string | undefined {
  const parent = expression.parent;
  if (parent?.type === 'equals_value_clause') {
    const declaration = parent.parent?.parent;
    const type = declaration?.type === 'variable_declaration' ? declaration.childForFieldName('type') : undefined;

    return type && type.type !== 'implicit_type' ? normalize(type.text) : undefined;
  }

  if (parent?.type === 'property_declaration' && parent.childForFieldName('value') === expression) {
    return normalize(parent.childForFieldName('type')?.text ?? '') || undefined;
  }

  const member = parent?.type === 'arrow_expression_clause' ? parent.parent : undefined;
  if (member && (member.type === 'method_declaration' || member.type === 'local_function_statement' || member.type === 'property_declaration')) {
    const isAsync = member.namedChildren.some((child) => child.type === 'modifier' && child.text === 'async');

    return isAsync ? undefined : normalize(member.childForFieldName('type')?.text ?? '') || undefined;
  }

  if (parent?.type === 'return_statement') {
    const type = returnType(parent);

    return type ? normalize(type) : undefined;
  }

  return undefined;
}

/** `[elements]` for a `{ ... }` initializer, keeping the elements as written. */
function fromInitializer(initializer: Node): string {
  const inner = initializer.text.slice(1, -1);

  return inner.includes('\n') ? `[${inner}]` : `[${inner.trim()}]`;
}

/** An initializer whose elements are plain expressions (not `{ key, value }` element initializers). */
function hasPlainElements(initializer: Node): boolean {
  return initializer.namedChildren.every((element) => element.type !== 'initializer_expression' && element.type !== 'assignment_expression');
}

const LITERAL_ELEMENT_TYPES: Record<string, string> = {
  integer_literal: 'int',
  string_literal: 'string',
  verbatim_string_literal: 'string',
  character_literal: 'char',
  boolean_literal: 'bool',
};

/** Collection types with a parameterless constructor and `Add` that collection expressions fill the same way. */
const ADDABLE_COLLECTIONS = /^(?:List|HashSet|SortedSet|Collection|ObservableCollection)<.+>$/;
const IMMUTABLE_CREATE = /^(ImmutableArray|ImmutableList)\.Create(?:<.+>)?$/;

/** The element type of a collection created in place: `new T[] { ... }`, `new[] { literals }`, `new C<T>(...)`. */
function elementTypeOf(creation: Node): string | undefined {
  const initializer = creation.namedChildren.find((child) => child.type === 'initializer_expression');
  switch (creation.type) {
    case 'array_creation_expression': {
      const type = creation.namedChildren.find((child) => child.type === 'array_type');

      return type && !/,/.test(type.text) ? normalize(type.text).replace(/\[[^\]]*\]$/, '') : undefined;
    }
    case 'implicit_array_creation_expression': {
      const types = new Set(initializer?.namedChildren.map((element) => LITERAL_ELEMENT_TYPES[element.type]));

      return types.size === 1 ? [...types][0] : undefined;
    }
    case 'object_creation_expression':
      return /^[\w.]+<([^<>,]+)>$/.exec(normalize(creation.childForFieldName('type')?.text ?? ''))?.[1];
    default:
      return undefined;
  }
}

interface Candidate {
  readonly id: string;
  readonly node: Node;
  readonly text: string;
}

function candidates(root: Node, report: (id: string, node: Node, message: string) => void, frameworksAllowImmutable: boolean): Candidate[] {
  const found: Candidate[] = [];
  const add = (id: string, node: Node, text: string): void => {
    found.push({ id, node, text });
  };

  for (const node of findAll(root, ['array_creation_expression', 'implicit_array_creation_expression', 'initializer_expression', 'stackalloc_expression', 'invocation_expression', 'object_creation_expression'])) {
    const target = targetTypeOf(node);
    if (!target || hasParseErrors(node)) {
      continue;
    }

    const initializer = node.type === 'initializer_expression' ? node : node.namedChildren.find((child) => child.type === 'initializer_expression');
    switch (node.type) {
      case 'initializer_expression':
        // `int[] a = { 1 };` - only arrays take a bare initializer in a declaration.
        if (/^[^[\],]+(?:\[\])+$/.test(target) && hasPlainElements(node)) {
          add(node.namedChildCount === 0 ? 'IDE0301' : 'IDE0300', node, fromInitializer(node));
        }
        break;
      case 'array_creation_expression': {
        const type = node.namedChildren.find((child) => child.type === 'array_type');
        const size = type?.namedChildren.find((child) => child.type === 'array_rank_specifier')?.namedChildren ?? [];
        if (!type || normalize(type.text.replace(/\[[^\]]*\]$/, '[]')) !== target || /,/.test(type.text)) {
          break;
        }

        if (initializer && size.length === 0 && hasPlainElements(initializer)) {
          add(initializer.namedChildCount === 0 ? 'IDE0301' : 'IDE0300', node, fromInitializer(initializer));
        } else if (!initializer && size.length === 1 && size[0].text === '0') {
          add('IDE0301', node, '[]');
        }
        break;
      }
      case 'implicit_array_creation_expression': {
        // `new[] { ... }` has the type of its elements: only literals of the target's element type prove it.
        const elementType = target.endsWith('[]') ? target.slice(0, -2) : undefined;
        if (initializer && elementType && initializer.namedChildCount > 0 && initializer.namedChildren.every((element) => LITERAL_ELEMENT_TYPES[element.type] === elementType)) {
          add('IDE0300', node, fromInitializer(initializer));
        }
        break;
      }
      case 'stackalloc_expression': {
        const type = node.namedChildren.find((child) => child.type === 'array_type');
        const element = type?.namedChildren[0]?.text;
        if (initializer && element && hasPlainElements(initializer) && initializer.namedChildCount > 0 && /^(?:System\.)?(?:ReadOnly)?Span<(.+)>$/.exec(target)?.[1] === normalize(element)) {
          add('IDE0302', node, fromInitializer(initializer));
        }
        break;
      }
      case 'object_creation_expression': {
        const type = node.childForFieldName('type');
        const args = node.namedChildren.find((child) => child.type === 'argument_list');
        const created = type ? normalize(type.text) : '';
        if (created === target && ADDABLE_COLLECTIONS.test(created) && (!args || args.namedChildCount === 0) && (!initializer || hasPlainElements(initializer))) {
          add('IDE0306', node, initializer ? fromInitializer(initializer) : '[]');
        }
        break;
      }
      case 'invocation_expression': {
        const callee = node.childForFieldName('function');
        const args = node.namedChildren.find((child) => child.type === 'argument_list')?.namedChildren ?? [];
        const calleeText = callee ? normalize(callee.text) : '';
        const element = /^(?:Immutable(?:Array|List))<(.+)>$/.exec(target)?.[1] ?? /^(.+)\[\]$/.exec(target)?.[1];
        if (/^(?:System\.)?Array\.Empty<(.+)>$/.exec(calleeText)?.[1] === element && target.endsWith('[]') && args.length === 0) {
          add('IDE0301', node, '[]');
        } else if (IMMUTABLE_CREATE.test(calleeText) && target.startsWith(`${IMMUTABLE_CREATE.exec(calleeText)![1]}<`) && frameworksAllowImmutable) {
          const single = args.length === 1 && !/_literal$/.test(args[0].namedChildren[0]?.type ?? '');
          // `Create(items, start, length)` copies a range of an array: three arguments are elements
          // only when all are literals of the element type.
          const range = args.length === 3 && !args.every((arg) => LITERAL_ELEMENT_TYPES[arg.namedChildren[0]?.type ?? ''] === element);
          if (!single && !range && args.every((arg) => arg.namedChildCount === 1 && !/^(?:ref|out|in)\b/.test(arg.text))) {
            add('IDE0303', node, `[${args.map((arg) => arg.text).join(', ')}]`);
          }
        } else if (callee?.type === 'member_access_expression' && args.length === 0) {
          const method = callee.childForFieldName('name')?.text;
          const receiver = callee.childForFieldName('expression');
          const targetElement = method === 'ToList' ? /^List<(.+)>$/.exec(target)?.[1] : method === 'ToArray' ? /^(.+)\[\]$/.exec(target)?.[1] : undefined;
          // `[.. xs]` creates the target's type: `object[] a = new[] { "a" }.ToArray()` holds a `string[]`.
          const createdHere = receiver !== null && ['array_creation_expression', 'implicit_array_creation_expression', 'object_creation_expression'].includes(receiver.type);
          if (!targetElement || !receiver || (createdHere && elementTypeOf(receiver) !== targetElement)) {
            break;
          }

          // `xs.ToList()` throws ArgumentNullException for null, `[.. xs]` NullReferenceException.
          const receiverInitializer =
            receiver.type === 'implicit_array_creation_expression' || receiver.type === 'array_creation_expression'
              ? receiver.namedChildren.find((child) => child.type === 'initializer_expression')
              : undefined;
          if (receiverInitializer && hasPlainElements(receiverInitializer)) {
            add('IDE0305', node, fromInitializer(receiverInitializer));
          } else if (receiver.type === 'object_creation_expression' || receiver.type === 'array_creation_expression') {
            add('IDE0305', node, `[.. ${receiver.text}]`);
          } else {
            report('IDE0305', node, `'${node.text}' was not changed to a collection expression: '${receiver.text}' may be null, and '[.. ${receiver.text}]' would throw a different exception.`);
          }
        }
        break;
      }
    }
  }

  return found;
}

/** IDE0304: `CreateBuilder` ... `ToImmutable()` spans statements; it is only reported. */
function reportBuilders(source: string, root: Node, report: (id: string, node: Node, message: string) => void): void {
  for (const invocation of findAll(root, 'invocation_expression')) {
    if (/\.CreateBuilder(?:<[^>]*>)?$/.test(invocation.childForFieldName('function')?.text ?? '') && /\.ToImmutable\(\)/.test(source.slice(invocation.endIndex))) {
      report('IDE0304', invocation, 'the builder was not replaced by a collection expression: the elements are added in separate statements.');
    }
  }
}

function applyCollectionExpressions(source: string, context: RuleContext): string {
  const enabled = (id: string): boolean => {
    const option = readCodeStyleOption(context.props, COLLECTION_EXPRESSION_OPTION, id);

    return option?.enforced === true && APPLYING_VALUES[option.value] === true;
  };
  if (!['IDE0300', 'IDE0301', 'IDE0302', 'IDE0303', 'IDE0304', 'IDE0305', 'IDE0306'].some(enabled)) {
    return source;
  }

  const tree = parseCSharp(source);
  try {
    const report = (id: string, node: Node, message: string): void => {
      if (enabled(id)) {
        context.report(describeIssue(id, COLLECTION_EXPRESSION_OPTION, source, node.startIndex, message));
      }
    };
    // ImmutableArray/ImmutableList take collection expressions from System.Collections.Immutable 8.
    const frameworks = context.project?.targetFrameworks;
    const immutableAllowed = frameworks !== undefined && targetsAtLeast(frameworks, 8);
    const found = candidates(tree.rootNode, report, immutableAllowed).filter((candidate) => enabled(candidate.id));
    // Nested candidates (a creation inside another) are rewritten on the next pass.
    const outermost = found.filter((candidate) => !found.some((other) => other !== candidate && other.node.startIndex <= candidate.node.startIndex && other.node.endIndex >= candidate.node.endIndex));
    reportBuilders(source, tree.rootNode, report);
    const edits: TextEdit[] = outermost.map((candidate) => ({ start: candidate.node.startIndex, end: candidate.node.endIndex, text: candidate.text }));

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

export const COLLECTION_EXPRESSION_RULES: readonly Rule[] = [{ option: COLLECTION_EXPRESSION_OPTION, apply: applyCollectionExpressions }];
