import { EditorConfigProperties } from '../editorconfig';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { targetsAtLeast } from '../projectInfo';
import { EditorConfigIssueReporter, describeIssue, hasParseErrors } from './editorConfigSupport';

const INSTANCE_TYPES = ['class_declaration', 'struct_declaration'];
const OBJECT_TYPES: Record<string, true> = { object: true, Object: true, 'System.Object': true };
const LOCK_OPTION = 'csharp_prefer_system_threading_lock';
const PRIMARY_CONSTRUCTOR_OPTION = 'csharp_style_prefer_primary_constructors';

function hasModifier(node: Node, name: string): boolean {
  return node.namedChildren.some((child) => child.type === 'modifier' && child.text === name);
}

// ---------------------------------------------------------------------------------------------
// IDE0330 csharp_prefer_system_threading_lock
// ---------------------------------------------------------------------------------------------

/**
 * `private readonly object _gate = new object();` becomes `private readonly Lock _gate = new();`
 * when the field is used only as the target of `lock` statements in its (non-partial) type and the
 * project targets .NET 9 or later, where `lock` on a `System.Threading.Lock` uses its scope API.
 */
export function applySystemThreadingLock(
  source: string,
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter,
  targetFrameworks: readonly string[] | undefined
): string {
  if (effectiveEditorConfigValue(props, LOCK_OPTION) !== 'true') {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const root = tree.rootNode;
    const importsThreading = root.namedChildren.some(
      (child) => child.type === 'using_directive' && /^using\s+System\.Threading\s*;$/.test(child.text)
    );
    const edits: TextEdit[] = [];

    for (const type of findAll(root, [...INSTANCE_TYPES, 'record_declaration'])) {
      for (const field of lockFields(type)) {
        const reason = !targetsAtLeast(targetFrameworks, 9)
          ? 'the project does not provably target .NET 9 or later'
          : hasModifier(type, 'partial')
            ? 'the type is partial, other parts may use the field'
            : !isOnlyLocked(type, field.name)
              ? `'${field.name}' is used for more than lock statements`
              : undefined;
        if (reason) {
          report(describeIssue('IDE0330', LOCK_OPTION, source, field.node.startIndex, `'${field.name}' was not changed to System.Threading.Lock: ${reason}.`));
          continue;
        }

        edits.push({ start: field.type.startIndex, end: field.type.endIndex, text: importsThreading ? 'Lock' : 'System.Threading.Lock' });
        edits.push({ start: field.value.startIndex, end: field.value.endIndex, text: 'new()' });
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

interface LockField {
  readonly node: Node;
  readonly name: string;
  readonly type: Node;
  readonly value: Node;
}

/** Private readonly `object` fields initialized with a new `object`, declared directly in `type`. */
function lockFields(type: Node): LockField[] {
  const fields: LockField[] = [];

  for (const field of type.childForFieldName('body')?.namedChildren ?? []) {
    if (field.type !== 'field_declaration' || !hasModifier(field, 'readonly') || hasParseErrors(field)) {
      continue;
    }

    if (['public', 'protected', 'internal'].some((modifier) => hasModifier(field, modifier))) {
      continue;
    }

    const declaration = field.namedChildren.find((child) => child.type === 'variable_declaration');
    const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
    const fieldType = declaration?.childForFieldName('type');
    const value = declarators[0]?.namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0];
    const name = declarators[0]?.childForFieldName('name')?.text;
    const createsObject =
      (value?.type === 'object_creation_expression' &&
        OBJECT_TYPES[value.childForFieldName('type')?.text ?? ''] === true &&
        value.childForFieldName('arguments')?.namedChildCount === 0 &&
        !value.childForFieldName('initializer')) ||
      (value?.type === 'implicit_object_creation_expression' && value.text.replace(/\s+/g, '') === 'new()');

    if (declarators.length === 1 && fieldType && OBJECT_TYPES[fieldType.text] === true && value && name && createsObject) {
      fields.push({ node: field, name, type: fieldType, value });
    }
  }

  return fields;
}

/** True when every reference to the field in its type is the expression of a `lock` statement. */
function isOnlyLocked(type: Node, name: string): boolean {
  const uses = type.descendantsOfType('identifier').filter((node) => node.text === name);

  return uses.every((use) => {
    const parent = use.parent;
    if (parent?.type === 'variable_declarator') {
      return parent.childForFieldName('name') === use;
    }

    const target =
      parent?.type === 'member_access_expression' &&
      parent.childForFieldName('name') === use &&
      parent.childForFieldName('expression')?.type === 'this_expression'
        ? parent
        : use;

    return target.parent?.type === 'lock_statement' && target.parent.namedChildren[0] === target;
  });
}

// ---------------------------------------------------------------------------------------------
// IDE0290 csharp_style_prefer_primary_constructors
// ---------------------------------------------------------------------------------------------

/**
 * Converting to or from a primary constructor changes how parameters are captured and which
 * members exist, which cannot be proven safe from one file. Types that do not follow the option
 * are reported: for `true`, classes and structs whose only constructor just assigns its
 * parameters to fields; for `false`, classes and structs declared with a primary constructor.
 */
export function reportPrimaryConstructors(source: string, props: EditorConfigProperties, report: EditorConfigIssueReporter): string {
  const preference = effectiveEditorConfigValue(props, PRIMARY_CONSTRUCTOR_OPTION);
  if (preference !== 'true' && preference !== 'false') {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    for (const type of findAll(tree.rootNode, INSTANCE_TYPES)) {
      const name = type.childForFieldName('name')?.text ?? '';
      const hasPrimary = type.childForFieldName('parameters') !== null;

      if (preference === 'false' && hasPrimary) {
        report(
          describeIssue('IDE0290', PRIMARY_CONSTRUCTOR_OPTION, source, type.startIndex, `'${name}' keeps its primary constructor: converting it to a regular constructor is not done automatically.`)
        );
      } else if (preference === 'true' && !hasPrimary && isPrimaryConstructorCandidate(type)) {
        report(
          describeIssue('IDE0290', PRIMARY_CONSTRUCTOR_OPTION, source, type.startIndex, `'${name}' could use a primary constructor; it was not converted automatically.`)
        );
      }
    }

    return source;
  } finally {
    tree.delete();
  }
}

function isPrimaryConstructorCandidate(type: Node): boolean {
  const constructors = (type.childForFieldName('body')?.namedChildren ?? []).filter(
    (member) => member.type === 'constructor_declaration' && !hasModifier(member, 'static')
  );
  const constructor = constructors.length === 1 ? constructors[0] : undefined;
  const parameters = constructor?.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
  const statements = constructor?.childForFieldName('body')?.namedChildren ?? [];
  if (!constructor || parameters.length === 0 || statements.length !== parameters.length) {
    return false;
  }

  const names = parameters.map((parameter) => parameter.childForFieldName('name')?.text);

  return statements.every((statement) => {
    const assignment = statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
    const right = assignment?.type === 'assignment_expression' ? assignment.childForFieldName('right') : undefined;

    return right?.type === 'identifier' && names.includes(right.text);
  });
}
