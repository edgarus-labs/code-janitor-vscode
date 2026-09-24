import { EditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import {
  CodeStyleOption,
  EditorConfigIssueReporter,
  describeIssue,
  hasParseErrors,
  readCodeStyleOption,
} from './editorConfigSupport';
import { isTypeApparent } from './varWhenApparent';

type Category = 'builtIn' | 'apparent' | 'elsewhere';

const OPTION_BY_CATEGORY: Record<Category, string> = {
  builtIn: 'csharp_style_var_for_built_in_types',
  apparent: 'csharp_style_var_when_type_is_apparent',
  elsewhere: 'csharp_style_var_elsewhere',
};

const INT_MAX = 2147483647n;
const UINT_MAX = 4294967295n;

/** Initializers that have no type of their own, so `var` can never replace the declared type. */
const NOT_VAR_COMPATIBLE: Record<string, true> = {
  null_literal: true,
  lambda_expression: true,
  anonymous_method_expression: true,
  initializer_expression: true,
  collection_expression: true,
  implicit_object_creation_expression: true,
  implicit_array_creation_expression: true,
  stackalloc_expression: true,
};

/** Nodes that are type syntax (the parser also accepts expressions after `as`). */
const TYPE_SYNTAX: Record<string, true> = {
  identifier: true,
  generic_name: true,
  qualified_name: true,
  alias_qualified_name: true,
  predefined_type: true,
  nullable_type: true,
  array_type: true,
  tuple_type: true,
};

/** An initializer whose type is known from syntax alone. */
interface KnownType {
  readonly text: string;
  readonly category: Category;
}

/**
 * Applies `csharp_style_var_for_built_in_types`, `csharp_style_var_when_type_is_apparent` and
 * `csharp_style_var_elsewhere` (IDE0007 use `var`, IDE0008 use an explicit type) to local
 * declaration statements. A type is only ever written or dropped when it is certain from the
 * initializer's syntax (a literal, `new T(...)`, `(T)x`, `x as T`, `default(T)`, `new T[n]`);
 * other declarations that break an enforced preference are reported.
 */
export function applyVarPreferences(source: string, props: EditorConfigProperties, report: EditorConfigIssueReporter): string {
  const options: Partial<Record<Category, CodeStyleOption>> = {};
  for (const category of Object.keys(OPTION_BY_CATEGORY) as Category[]) {
    const option = readCodeStyleOption(props, OPTION_BY_CATEGORY[category], (value) => (value === 'true' ? 'IDE0007' : 'IDE0008'));
    if (option?.enforced && (option.value === 'true' || option.value === 'false')) {
      options[category] = option;
    }
  }

  if (Object.keys(options).length === 0) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];

    for (const statement of findAll(tree.rootNode, 'local_declaration_statement')) {
      const declaration = statement.namedChildren.find((child) => child.type === 'variable_declaration');
      const type = declaration?.childForFieldName('type');
      const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
      const initializer = declarators.length === 1 ? initializerValue(declarators[0]) : undefined;
      // `const`, `ref` and `scoped` locals cannot use `var` the same way; `using`/`await using` can.
      const hasUnsupportedModifier = statement.namedChildren.some(
        (child) => child.type === 'modifier' && child.text !== 'using' && child.text !== 'await'
      );
      if (!type || !initializer || hasParseErrors(statement) || hasUnsupportedModifier) {
        continue;
      }

      const name = declarators[0].childForFieldName('name')?.text ?? '';
      if (type.type === 'implicit_type') {
        toExplicitType(source, type, initializer, name, options, report, edits);
      } else {
        toVar(source, type, initializer, name, options, report, edits);
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function toVar(
  source: string,
  type: Node,
  initializer: Node,
  name: string,
  options: Partial<Record<Category, CodeStyleOption>>,
  report: EditorConfigIssueReporter,
  edits: TextEdit[]
): void {
  // `T x = default;` has no type of its own either.
  const isDefaultLiteral = initializer.type === 'default_expression' && initializer.namedChildCount === 0;
  if (type.text === 'dynamic' || isDefaultLiteral || NOT_VAR_COMPATIBLE[initializer.type] === true) {
    return;
  }

  const category: Category =
    type.type === 'predefined_type' ? 'builtIn' : isApparent(type, initializer) ? 'apparent' : 'elsewhere';
  const option = options[category];
  if (option?.value !== 'true') {
    return;
  }

  const known = knownType(initializer);
  if (known?.text === type.text || (category === 'apparent' && isApparent(type, initializer))) {
    edits.push({ start: type.startIndex, end: type.endIndex, text: 'var' });

    return;
  }

  if (known) {
    // `long x = 5;` - `var` would change the type to `int`; the rule does not apply.
    return;
  }

  report(
    describeIssue(
      option.diagnosticId,
      OPTION_BY_CATEGORY[category],
      source,
      type.startIndex,
      `'${type.text} ${name}' was not changed to 'var': the initializer's type cannot be determined syntactically.`
    )
  );
}

function toExplicitType(
  source: string,
  type: Node,
  initializer: Node,
  name: string,
  options: Partial<Record<Category, CodeStyleOption>>,
  report: EditorConfigIssueReporter,
  edits: TextEdit[]
): void {
  if (initializer.type === 'anonymous_object_creation_expression') {
    return;
  }

  const known = knownType(initializer);
  if (known) {
    if (options[known.category]?.value === 'false') {
      edits.push({ start: type.startIndex, end: type.endIndex, text: known.text });
    }

    return;
  }

  const violated = (Object.keys(options) as Category[]).filter((category) => options[category]?.value === 'false');
  if (violated.length > 0) {
    report(
      describeIssue(
        'IDE0008',
        violated.map((category) => OPTION_BY_CATEGORY[category]).join('/'),
        source,
        type.startIndex,
        `'var ${name}' was not changed to an explicit type: the initializer's type cannot be determined syntactically.`
      )
    );
  }
}

function isApparent(type: Node, initializer: Node): boolean {
  if (isTypeApparent(type, initializer)) {
    return true;
  }

  if (initializer.type === 'default_expression') {
    return initializer.namedChild(0)?.text === type.text;
  }

  const target = isAsExpression(initializer) ? initializer.childForFieldName('right') : undefined;

  return target !== undefined && target !== null && TYPE_SYNTAX[target.type] === true && target.text === type.text;
}

function isAsExpression(node: Node): boolean {
  return node.type === 'binary_expression' && node.child(1)?.type === 'as';
}

/** The exact type of `initializer` when syntax alone determines it. */
function knownType(initializer: Node): KnownType | undefined {
  switch (initializer.type) {
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'raw_string_literal':
    case 'interpolated_string_expression':
      // `"abc"u8` is a `ReadOnlySpan<byte>`.
      return /u8$/i.test(initializer.text) ? undefined : { text: 'string', category: 'builtIn' };

    case 'character_literal':
      return { text: 'char', category: 'builtIn' };

    case 'boolean_literal':
      return { text: 'bool', category: 'builtIn' };

    case 'integer_literal': {
      const text = integerLiteralType(initializer.text);

      return text ? { text, category: 'builtIn' } : undefined;
    }

    case 'real_literal':
      return { text: realLiteralType(initializer.text), category: 'builtIn' };

    case 'object_creation_expression':
    case 'cast_expression':
      return typedExpression(initializer.childForFieldName('type'));

    case 'default_expression':
      return typedExpression(initializer.namedChild(0));

    case 'binary_expression':
      return isAsExpression(initializer) ? typedExpression(initializer.childForFieldName('right')) : undefined;

    case 'array_creation_expression': {
      const arrayType = initializer.namedChildren.find((child) => child.type === 'array_type');
      const text = arrayType?.text.replace(/\[[^[\]]*\]/g, (rank) => `[${','.repeat((rank.match(/,/g) ?? []).length)}]`);

      // An element type without brackets followed by rank specifiers only (`int[,][]`).
      return text && /^[\w.<>,\s?]+(\[,*\])+$/.test(text) ? { text, category: 'apparent' } : undefined;
    }

    default:
      return undefined;
  }
}

function typedExpression(type: Node | null): KnownType | undefined {
  if (!type || TYPE_SYNTAX[type.type] !== true) {
    return undefined;
  }

  return { text: type.text, category: type.type === 'predefined_type' ? 'builtIn' : 'apparent' };
}

function integerLiteralType(literal: string): string | undefined {
  const text = literal.replace(/_/g, '');
  const suffix = /[uUlL]*$/.exec(text)?.[0].toLowerCase() ?? '';
  const digits = text.slice(0, text.length - suffix.length);

  let value: bigint;
  try {
    value = BigInt(/^0[bB]/.test(digits) || /^0[xX]/.test(digits) ? digits : digits.replace(/^0+(?=\d)/, ''));
  } catch {
    return undefined;
  }

  switch (suffix) {
    case '':
      return value <= INT_MAX ? 'int' : undefined;
    case 'u':
      return value <= UINT_MAX ? 'uint' : undefined;
    case 'l':
      return 'long';
    case 'ul':
    case 'lu':
      return 'ulong';
    default:
      return undefined;
  }
}

function realLiteralType(literal: string): string {
  switch (literal[literal.length - 1].toLowerCase()) {
    case 'f':
      return 'float';
    case 'm':
      return 'decimal';
    default:
      return 'double';
  }
}

function initializerValue(declarator: Node): Node | undefined {
  const clause = declarator.namedChildren.find((child) => child.type === 'equals_value_clause');

  return clause?.namedChildren[0];
}
