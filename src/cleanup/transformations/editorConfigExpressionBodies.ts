import { splitOptionSeverity } from '../editorconfig';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { hasComment } from './editorConfigStatementPreferences';
import { describeIssue, hasModifier, hasParseErrors, lineIndentAt, newlineOf } from './editorConfigSupport';
import { storedDelegateType } from './typeFacts';

/**
 * `csharp_style_expression_bodied_*` (IDE0021 - IDE0027, IDE0061): members whose body is a single
 * `return`, expression or `throw` statement get an expression body (`true`, or
 * `when_on_single_line` for one-line expressions) and expression bodies get a block body (`false`,
 * or `when_on_single_line` for multi-line expressions). Lambdas only lose `{ return ...; }`: which
 * delegate type a lambda converts to can depend on its body.
 */

type Preference = 'expression' | 'block' | 'single-line';

const PREFERENCES: Record<string, Preference> = {
  true: 'expression',
  when_possible: 'expression',
  false: 'block',
  never: 'block',
  when_on_single_line: 'single-line',
};

const TASK_TYPE = /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)$/;

function accessorKeyword(accessor: Node): string | undefined {
  return accessor.children.find((child) => !child.isNamed && /^(?:get|set|init|add|remove)$/.test(child.type))?.type;
}

/** How a body statement of `member` is written: `return x;`, `x;` (no value) or either (`throw`). */
function bodyKind(member: Node): 'value' | 'statement' | undefined {
  switch (member.type) {
    case 'method_declaration':
    case 'local_function_statement': {
      const type = member.childForFieldName('type')?.text.replace(/\s+/g, '');
      if (!type) {
        return undefined;
      }

      return type === 'void' || (hasModifier(member, 'async') && TASK_TYPE.test(type)) ? 'statement' : 'value';
    }
    case 'constructor_declaration':
      return 'statement';
    case 'operator_declaration':
    case 'conversion_operator_declaration':
      return 'value';
    case 'accessor_declaration':
      return accessorKeyword(member) === 'get' ? 'value' : accessorKeyword(member) ? 'statement' : undefined;
    default:
      return undefined;
  }
}

/** The expression of a block holding a single `return x;`, `x;` or `throw x;` that fits `kind`. */
function singleExpression(source: string, block: Node, kind: 'value' | 'statement'): string | undefined {
  const statement = block.namedChildCount === 1 ? block.namedChildren[0] : undefined;
  if (!statement || hasComment(source, block.startIndex, block.endIndex) || hasParseErrors(block)) {
    return undefined;
  }

  const expression = statement.namedChildCount === 1 ? statement.namedChildren[0] : undefined;
  if (!expression) {
    return undefined;
  }

  if (statement.type === 'throw_statement') {
    return `throw ${expression.text}`;
  }

  return (statement.type === 'return_statement' && kind === 'value') || (statement.type === 'expression_statement' && kind === 'statement')
    ? expression.text
    : undefined;
}

/** The statement a block body holds for expression body `expression` of a member of `kind`. */
function statementFor(expression: Node, kind: 'value' | 'statement'): string {
  return expression.type === 'throw_expression' || kind === 'statement' ? `${expression.text};` : `return ${expression.text};`;
}

function wants(preference: Preference, form: 'expression' | 'block', text: string): boolean {
  return preference === 'single-line' ? (form === 'expression') === !text.includes('\n') : preference === form;
}

/** Methods, constructors, operators, local functions and accessors. */
function convertBodies(source: string, root: Node, types: readonly string[], preference: Preference, context: RuleContext): TextEdit[] {
  const edits: TextEdit[] = [];
  const newline = newlineOf(source);
  const bracesOnNewLine = (effectiveEditorConfigValue(context.props, 'csharp_new_line_before_open_brace') ?? 'all') !== 'none';

  for (const member of findAll(root, types)) {
    const kind = bodyKind(member);
    const body = member.childForFieldName('body');
    const before = body ? member.children[member.children.indexOf(body) - 1] : undefined;
    if (!kind || !body || !before || hasParseErrors(member)) {
      continue;
    }

    if (body.type === 'block') {
      const expression = singleExpression(source, body, kind);
      if (expression !== undefined && wants(preference, 'expression', expression)) {
        edits.push({ start: before.endIndex, end: member.endIndex, text: ` => ${expression};` });
      }

      continue;
    }

    const expression = body.type === 'arrow_expression_clause' ? body.namedChildren[0] : undefined;
    if (!expression || !wants(preference, 'block', expression.text) || hasComment(source, body.startIndex, member.endIndex)) {
      continue;
    }

    const statement = statementFor(expression, kind);
    if (member.type === 'accessor_declaration') {
      edits.push({ start: before.endIndex, end: member.endIndex, text: ` { ${statement} }` });
    } else {
      const indent = lineIndentAt(source, member.startIndex);
      const open = bracesOnNewLine ? `${newline}${indent}{` : ' {';
      edits.push({ start: before.endIndex, end: member.endIndex, text: `${open}${newline}${indent}${context.indent}${statement}${newline}${indent}}` });
    }
  }

  return edits;
}

/** Properties and indexers: `P { get { return x; } }` and `P => x;`. */
function convertPropertyBodies(source: string, root: Node, type: string, preference: Preference, context: RuleContext): TextEdit[] {
  const edits: TextEdit[] = [];
  const accessorPreference = PREFERENCES[splitOptionSeverity(context.props.get('csharp_style_expression_bodied_accessors') ?? 'true').value.toLowerCase()];

  for (const property of findAll(root, type)) {
    const accessors = property.childForFieldName('accessors');
    const arrow = type === 'property_declaration' ? property.childForFieldName('value') : property.children.find((child) => child.type === 'arrow_expression_clause');
    const before = accessors ?? arrow ? property.children[property.children.indexOf((accessors ?? arrow)!) - 1] : undefined;
    if (!before || hasParseErrors(property)) {
      continue;
    }

    if (accessors) {
      const getter = accessors.namedChildCount === 1 ? accessors.namedChildren[0] : undefined;
      const body = getter?.childForFieldName('body');
      const onlyKeyword = getter?.namedChildren.every((child) => child === body);
      const expression =
        getter && accessorKeyword(getter) === 'get' && onlyKeyword && body
          ? body.type === 'block'
            ? singleExpression(source, body, 'value')
            : body.type === 'arrow_expression_clause' && !hasComment(source, accessors.startIndex, accessors.endIndex)
              ? body.namedChildren[0]?.text
              : undefined
          : undefined;
      if (expression !== undefined && wants(preference, 'expression', expression)) {
        edits.push({ start: before.endIndex, end: property.endIndex, text: ` => ${expression};` });
      }

      continue;
    }

    const expression = arrow?.type === 'arrow_expression_clause' ? arrow.namedChildren[0] : undefined;
    if (!expression || !wants(preference, 'block', expression.text) || hasComment(source, arrow!.startIndex, property.endIndex)) {
      continue;
    }

    const getter = wants(accessorPreference ?? 'expression', 'expression', expression.text) ? `get => ${expression.text};` : `get { ${statementFor(expression, 'value')} }`;
    edits.push({ start: before.endIndex, end: property.endIndex, text: ` { ${getter} }` });
  }

  return edits;
}

interface BodyOption {
  readonly option: string;
  readonly types: readonly string[];
}

const BODY_OPTIONS: readonly BodyOption[] = [
  { option: 'csharp_style_expression_bodied_properties', types: ['property_declaration'] },
  { option: 'csharp_style_expression_bodied_indexers', types: ['indexer_declaration'] },
  { option: 'csharp_style_expression_bodied_accessors', types: ['accessor_declaration'] },
  { option: 'csharp_style_expression_bodied_methods', types: ['method_declaration'] },
  { option: 'csharp_style_expression_bodied_constructors', types: ['constructor_declaration'] },
  { option: 'csharp_style_expression_bodied_operators', types: ['operator_declaration', 'conversion_operator_declaration'] },
  { option: 'csharp_style_expression_bodied_local_functions', types: ['local_function_statement'] },
];

const LAMBDA_OPTION = 'csharp_style_expression_bodied_lambdas';

/**
 * IDE0053: `x => { return e; }` becomes `x => e`. The other conversions can change which delegate
 * type the lambda converts to (`() => { F(); }` is an `Action`, `() => F()` can be a `Func<T>`),
 * so those lambdas are reported instead.
 */
function lambdaBodies(source: string, root: Node, preference: Preference, context: RuleContext): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const lambda of findAll(root, 'lambda_expression')) {
    const body = lambda.childForFieldName('body');
    if (!body || hasParseErrors(lambda)) {
      continue;
    }

    if (body.type === 'block') {
      const statement = body.namedChildCount === 1 ? body.namedChildren[0] : undefined;
      const value = statement?.type === 'return_statement' && statement.namedChildCount === 1 ? statement.namedChildren[0] : undefined;
      const expressionForm = value ? wants(preference, 'expression', value.text) : statement?.type === 'expression_statement' && wants(preference, 'expression', statement.text);
      if (!expressionForm || hasComment(source, body.startIndex, body.endIndex)) {
        continue;
      }

      // A block lambda cannot become an expression tree; an expression lambda passed to a method
      // can make an `Expression<T>` overload (IQueryable) applicable. Only lambdas stored in a
      // variable of a written delegate type are safe
      // (https://learn.microsoft.com/dotnet/csharp/language-reference/operators/lambda-expressions#expression-lambdas).
      if (value && storedDelegateType(lambda)) {
        edits.push({ start: body.startIndex, end: body.endIndex, text: value.text });
      } else {
        context.report(describeIssue('IDE0053', LAMBDA_OPTION, source, lambda.startIndex, 'the lambda body was not changed: without the delegate type, an expression body could change the overload it binds to.'));
      }
    } else if (wants(preference, 'block', body.text)) {
      context.report(describeIssue('IDE0053', LAMBDA_OPTION, source, lambda.startIndex, 'the lambda body was not changed: without the delegate type, it is unknown whether the block must return the value.'));
    }
  }

  return edits;
}

export const EXPRESSION_BODY_RULES: readonly Rule[] = [
  {
    option: LAMBDA_OPTION,
    apply: (source, context) => {
      const preference = PREFERENCES[effectiveEditorConfigValue(context.props, LAMBDA_OPTION) ?? ''];
      if (!preference) {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        return applyEdits(source, lambdaBodies(source, tree.rootNode, preference, context));
      } finally {
        tree.delete();
      }
    },
  },
  ...BODY_OPTIONS.map(
  ({ option, types }): Rule => ({
    option,
    apply: (source, context) => {
      const preference = PREFERENCES[effectiveEditorConfigValue(context.props, option) ?? ''];
      if (!preference) {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        const edits =
          types[0] === 'property_declaration' || types[0] === 'indexer_declaration'
            ? convertPropertyBodies(source, tree.rootNode, types[0], preference, context)
            : convertBodies(source, tree.rootNode, types, preference, context);

        return applyEdits(source, edits);
      } finally {
        tree.delete();
      }
    },
  })
  ),
];
