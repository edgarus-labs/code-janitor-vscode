import { Node } from '../cleanup/parser';
import { AccessLevel, MemberKind } from './comparer';
import { InitContext, InitInfo, MemberNameClass, NO_INIT, analyzeInitializers } from './initializers';

/** What a container of members is: decides the default access of a member without a modifier. */
export type ContainerKind = 'unit' | 'namespace' | 'class' | 'struct' | 'interface';

/** What the reorganizer knows about one member (a declaration, or a `#if` block of declarations). */
export interface MemberInfo {
  kind: MemberKind;
  name: string;
  access: AccessLevel;
  isStatic: boolean;
  isConstant: boolean;
  isReadOnly: boolean;
  isExplicitInterface: boolean;
  isMultiLine: boolean;
  init: InitInfo;
  /** Names of the partial types declared: their parts run their initializers in declaration order. */
  partialTypes: ReadonlySet<string>;
}

const KIND_BY_NODE_TYPE: Readonly<Record<string, MemberKind | undefined>> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'delegate',
  constructor_declaration: 'constructor',
  destructor_declaration: 'destructor',
  method_declaration: 'method',
  operator_declaration: 'method',
  conversion_operator_declaration: 'method',
  property_declaration: 'property',
  indexer_declaration: 'indexer',
  event_declaration: 'event',
  event_field_declaration: 'event',
  field_declaration: 'field',
  namespace_declaration: 'namespace',
};

/** The kind of member a declaration node is, or `undefined` when the node is not a reorderable member. */
export function memberKindOf(node: Node): MemberKind | undefined {
  if (node.type === 'record_declaration') {
    return node.children.some((child) => child.type === 'struct') ? 'struct' : 'class';
  }

  return KIND_BY_NODE_TYPE[node.type];
}

export function modifierNames(node: Node): string[] {
  return node.namedChildren.filter((child) => child.type === 'modifier').map((child) => child.text);
}

/** The container kind of a type declaration node. */
export function containerKindOf(node: Node): ContainerKind {
  switch (memberKindOf(node)) {
    case 'struct':
      return 'struct';
    case 'interface':
      return 'interface';
    case 'namespace':
      return 'namespace';
    default:
      return 'class';
  }
}

export interface ContainerContext {
  kind: ContainerKind;
  init: InitContext;
}

/** Collects the member names of a container, for the initializer analysis. */
export function createContainerContext(kind: ContainerKind, typeName: string, declarations: readonly Node[]): ContainerContext {
  const names = new Map<string, MemberNameClass>();

  for (const declaration of declarations) {
    for (const [name, nameClass] of declaredNames(declaration)) {
      names.set(name, nameClass);
    }
  }

  return { kind, init: { typeName, names } };
}

function declaredNames(declaration: Node): [string, MemberNameClass][] {
  switch (declaration.type) {
    case 'field_declaration':
    case 'event_field_declaration': {
      const isConstant = modifierNames(declaration).includes('const');
      const variable = declaration.namedChildren.find((child) => child.type === 'variable_declaration');

      return (variable?.namedChildren ?? [])
        .filter((child) => child.type === 'variable_declarator')
        .map((declarator): [string, MemberNameClass] => [
          declarator.namedChildren.find((child) => child.type === 'identifier')?.text ?? '',
          isConstant ? 'constant' : declarator.namedChildren.some((child) => child.type === 'equals_value_clause') ? 'initialized' : 'plain',
        ]);
    }

    case 'property_declaration': {
      const name = declaration.childForFieldName('name')?.text ?? '';
      const hasInitializer = declaration.children.some((child) => child.type === '=');
      const runsCode = isComputedProperty(declaration);

      return [[name, runsCode ? 'computed' : hasInitializer ? 'initialized' : 'plain']];
    }

    case 'method_declaration':
      return [[declaration.childForFieldName('name')?.text ?? '', 'method']];

    default:
      return [];
  }
}

/** A property whose getter runs code: an expression body or an accessor with a body. */
function isComputedProperty(declaration: Node): boolean {
  if (declaration.namedChildren.some((child) => child.type === 'arrow_expression_clause')) {
    return true;
  }

  const accessors = declaration.namedChildren.find((child) => child.type === 'accessor_list');

  return (accessors?.namedChildren ?? []).some((accessor) => accessor.namedChildren.some((child) => child.type === 'block' || child.type === 'arrow_expression_clause'));
}

export function describeMember(node: Node, kind: MemberKind, context: ContainerContext): MemberInfo {
  const modifiers = modifierNames(node);
  const isExplicitInterface = node.namedChildren.some((child) => child.type === 'explicit_interface_specifier');
  const isConstant = kind === 'field' && modifiers.includes('const');
  const isStatic = modifiers.includes('static') || isConstant;
  const isInitializerHost = (kind === 'field' && !isConstant) || kind === 'property' || (kind === 'event' && node.type === 'event_field_declaration');
  const isPartialType = (kind === 'class' || kind === 'struct' || kind === 'interface') && modifiers.includes('partial');
  const name = nameOf(node, kind);

  return {
    kind,
    name,
    access: accessOf(modifiers, kind, isStatic, isExplicitInterface, context.kind),
    isStatic,
    isConstant,
    isReadOnly: kind === 'field' && modifiers.includes('readonly'),
    isExplicitInterface,
    isMultiLine: node.endPosition.row > node.startPosition.row,
    init: isInitializerHost ? analyzeInitializers(node, isStatic, context.init) : NO_INIT,
    partialTypes: isPartialType ? new Set([name]) : NO_PARTIAL_TYPES,
  };
}

const NO_PARTIAL_TYPES: ReadonlySet<string> = new Set();

function accessOf(modifiers: readonly string[], kind: MemberKind, isStatic: boolean, isExplicitInterface: boolean, container: ContainerKind): AccessLevel {
  // The Visual Studio code model reports explicit interface implementations and static constructors as public.
  if (isExplicitInterface || (kind === 'constructor' && isStatic)) {
    return 'public';
  }

  const has = (modifier: string): boolean => modifiers.includes(modifier);

  if (has('public')) {
    return 'public';
  }

  if (has('protected') && has('internal')) {
    return 'protected internal';
  }

  if (has('private') && has('protected')) {
    return 'private protected';
  }

  if (has('protected')) {
    return 'protected';
  }

  if (has('internal')) {
    return 'internal';
  }

  if (has('private')) {
    return 'private';
  }

  switch (container) {
    case 'interface':
      return 'public';
    case 'unit':
    case 'namespace':
      return 'internal';
    default:
      return 'private';
  }
}

function nameOf(node: Node, kind: MemberKind): string {
  switch (node.type) {
    case 'field_declaration':
    case 'event_field_declaration': {
      const variable = node.namedChildren.find((child) => child.type === 'variable_declaration');
      const declarator = variable?.namedChildren.find((child) => child.type === 'variable_declarator');

      return declarator?.namedChildren.find((child) => child.type === 'identifier')?.text ?? '';
    }

    case 'indexer_declaration':
      return withSpecifier(node, 'this');

    case 'operator_declaration': {
      const operator = node.children.find((child) => child.type === 'operator');
      const symbol = operator ? node.children[node.children.indexOf(operator) + 1] : undefined;

      return `operator ${symbol?.text ?? ''}`;
    }

    case 'conversion_operator_declaration': {
      const direction = node.children.find((child) => child.type === 'implicit' || child.type === 'explicit');
      const type = node.childForFieldName('type');

      return `${direction?.text ?? ''} operator ${type?.text ?? ''}`;
    }

    case 'destructor_declaration':
      return `~${node.childForFieldName('name')?.text ?? ''}`;

    default:
      return kind === 'namespace' ? (node.childForFieldName('name')?.text ?? '') : withSpecifier(node, node.childForFieldName('name')?.text ?? '');
  }
}

function withSpecifier(node: Node, name: string): string {
  const specifier = node.namedChildren.find((child) => child.type === 'explicit_interface_specifier');

  return specifier ? specifier.text.replace(/\s+/g, '') + name : name;
}
