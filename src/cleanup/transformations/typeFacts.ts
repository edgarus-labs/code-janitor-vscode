import { Node, findAll } from '../parser';
import { subjectTypeText } from './editorConfigExpressionPreferences';

/**
 * What the file tells about a type, for rewrites whose meaning depends on it. A type declared in
 * another file or assembly is unknown, and rewrites that depend on it are skipped.
 */

const PLAIN_REFERENCE_TYPES: Record<string, true> = {
  string: true,
  String: true,
  'System.String': true,
  object: true,
  Object: true,
  'System.Object': true,
};

/**
 * True when `x == null` on a value of `type` is a plain reference comparison: `string`, `object`,
 * arrays, and interfaces or base-less classes declared in the file without `operator ==`.
 */
export function isPlainReferenceType(type: string | undefined, root: Node): boolean {
  const bare = type?.replace(/\?$/, '');
  if (!bare) {
    return false;
  }

  if (PLAIN_REFERENCE_TYPES[bare] === true || bare.endsWith(']')) {
    return true;
  }

  const name = bare.replace(/<.*>$/, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return false;
  }

  const declarations = findAll(root, ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration', 'delegate_declaration']).filter(
    (declaration) => declaration.childForFieldName('name')?.text === name
  );

  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        !declaration.namedChildren.some((child) => child.type === 'modifier' && child.text === 'partial') &&
        (declaration.type === 'interface_declaration' ||
          (declaration.type === 'class_declaration' &&
            !declaration.namedChildren.some((child) => child.type === 'base_list') &&
            !declaration.descendantsOfType('operator_declaration').some((operator) => /operator\s*(?:==|!=)/.test(operator.text))))
    )
  );
}

export const NULLABLE_VALUE_TYPE = /^(?:bool|byte|sbyte|char|decimal|double|float|short|ushort|int|uint|long|ulong|nint|nuint|DateTime|DateTimeOffset|TimeSpan|Guid)\?$/;

const VALUE_TYPES =
  /^(?:bool|byte|sbyte|char|decimal|double|float|short|ushort|int|uint|long|ulong|nint|nuint|Boolean|Byte|SByte|Char|Decimal|Double|Single|Int16|UInt16|Int32|UInt32|Int64|UInt64|IntPtr|UIntPtr|DateTime|DateTimeOffset|TimeSpan|Guid)$/;

/** True when `type` is a value type that cannot be `null`: a built-in one, or a struct or enum of the file. */
export function isNonNullableValueType(type: string | undefined, root: Node): boolean {
  if (!type || type.endsWith('?')) {
    return false;
  }

  return (
    VALUE_TYPES.test(type) ||
    findAll(root, ['struct_declaration', 'enum_declaration']).some((declaration) => declaration.childForFieldName('name')?.text === type.replace(/<.*>$/, ''))
  );
}

/**
 * True when `subject == null` is a plain null check, the same as `subject is null`: its declared
 * type cannot have a user-defined `==` (see {@link isPlainReferenceType}) or is a nullable value
 * type (https://learn.microsoft.com/dotnet/csharp/language-reference/operators/type-testing-and-cast#type-testing-with-pattern-matching).
 */
export function isPlainNullComparison(subject: Node, root: Node): boolean {
  const type = subjectTypeText(subject);

  return type !== undefined && (isPlainReferenceType(type, root) || NULLABLE_VALUE_TYPE.test(type));
}

/**
 * True when `target` (`x` or `this.x`) is a local, parameter or field the file declares, not a
 * property whose accessors could run code.
 */
export function isVariable(target: Node): boolean {
  const name = target.type === 'identifier' ? target.text : target.type === 'member_access_expression' && target.childForFieldName('expression')?.type === 'this_expression' ? target.childForFieldName('name')?.text : undefined;
  if (!name) {
    return false;
  }

  for (let current = target.parent; current; current = current.parent) {
    if (target.type === 'identifier' && /_declaration$|^local_function_statement$|^lambda_expression$/.test(current.type) && current.type !== 'variable_declaration') {
      const local = current.descendantsOfType(['variable_declarator', 'parameter']).some((node) => node.childForFieldName('name')?.text === name);
      if (local && !/^(?:class|struct|record|interface)_declaration$/.test(current.type)) {
        return true;
      }
    }

    if (current.type === 'declaration_list') {
      return current.namedChildren.some(
        (member) =>
          member.type === 'field_declaration' &&
          member.namedChildren.find((child) => child.type === 'variable_declaration')?.namedChildren.some((d) => d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name)
      );
    }
  }

  return false;
}

/**
 * The written delegate type of the variable a lambda or anonymous method initializes; undefined for
 * `var`, `dynamic`, `Expression<T>` and arguments, whose target type the file cannot tell.
 */
export function storedDelegateType(lambda: Node): Node | undefined {
  const clause = lambda.parent?.type === 'equals_value_clause' ? lambda.parent : undefined;
  const type = clause?.parent?.parent?.type === 'variable_declaration' ? clause.parent.parent.childForFieldName('type') : undefined;

  return type && type.type !== 'implicit_type' && !/(?:^|\.)Expression</.test(type.text) && type.text !== 'dynamic' ? type : undefined;
}
