import { Node, TextEdit, applyEdits, parseCSharp, walk } from '../parser';
import { CleanupSettings, SourceTransformation } from '../types';

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
  'enum_declaration',
]);

const ACCESS_MODIFIERS = ['public', 'internal', 'protected', 'private'];

type AccessSettings = Pick<
  CleanupSettings,
  | 'insertExplicitAccessModifiersOnClasses'
  | 'insertExplicitAccessModifiersOnDelegates'
  | 'insertExplicitAccessModifiersOnEnumerations'
  | 'insertExplicitAccessModifiersOnEvents'
  | 'insertExplicitAccessModifiersOnFields'
  | 'insertExplicitAccessModifiersOnInterfaces'
  | 'insertExplicitAccessModifiersOnMethods'
  | 'insertExplicitAccessModifiersOnProperties'
  | 'insertExplicitAccessModifiersOnStructs'
>;

/**
 * Inserts the default access modifier on declarations that omit it, governed per kind by the
 * corresponding settings.
 */
export function createExplicitAccessModifierConverter(settings: AccessSettings): SourceTransformation {
  return {
    name: 'Explicit Access Modifiers',
    apply(source: string): string {
      if (!source) {
        return source;
      }

      const tree = parseCSharp(source);

      try {
        const edits: TextEdit[] = [];

        for (const node of walk(tree.rootNode)) {
          const insertion = accessModifierFor(node, settings);
          if (!insertion) {
            continue;
          }

          const anchor = declarationAnchor(node);
          if (anchor) {
            edits.push({ start: anchor.startIndex, end: anchor.startIndex, text: `${insertion} ` });
          }
        }

        return applyEdits(source, edits);
      } finally {
        tree.delete();
      }
    },
  };
}

function accessModifierFor(node: Node, settings: AccessSettings): string | undefined {
  if (hasAnyModifier(node, ACCESS_MODIFIERS)) {
    return undefined;
  }

  switch (node.type) {
    case 'class_declaration':
    case 'record_declaration':
      return settings.insertExplicitAccessModifiersOnClasses && !hasAnyModifier(node, ['partial'])
        ? defaultAccessFor(node)
        : undefined;

    case 'struct_declaration':
      return settings.insertExplicitAccessModifiersOnStructs && !hasAnyModifier(node, ['partial'])
        ? defaultAccessFor(node)
        : undefined;

    case 'interface_declaration':
      return settings.insertExplicitAccessModifiersOnInterfaces && !hasAnyModifier(node, ['partial'])
        ? defaultAccessFor(node)
        : undefined;

    case 'enum_declaration':
      return settings.insertExplicitAccessModifiersOnEnumerations ? defaultAccessFor(node) : undefined;

    case 'delegate_declaration':
      return settings.insertExplicitAccessModifiersOnDelegates ? defaultAccessFor(node) : undefined;

    case 'field_declaration':
      return settings.insertExplicitAccessModifiersOnFields &&
        declaringType(node) !== undefined &&
        !hasAnyModifier(node, ['fixed'])
        ? 'private'
        : undefined;

    case 'method_declaration':
      return settings.insertExplicitAccessModifiersOnMethods &&
        isInNonInterfaceType(node) &&
        !hasAnyModifier(node, ['partial']) &&
        !hasExplicitInterfaceSpecifier(node)
        ? 'private'
        : undefined;

    case 'constructor_declaration':
      return settings.insertExplicitAccessModifiersOnMethods &&
        declaringType(node) !== undefined &&
        !hasAnyModifier(node, ['static'])
        ? 'private'
        : undefined;

    case 'property_declaration':
      return settings.insertExplicitAccessModifiersOnProperties &&
        isInNonInterfaceType(node) &&
        !hasExplicitInterfaceSpecifier(node)
        ? 'private'
        : undefined;

    case 'event_declaration':
      return settings.insertExplicitAccessModifiersOnEvents &&
        isInNonInterfaceType(node) &&
        !hasExplicitInterfaceSpecifier(node)
        ? 'private'
        : undefined;

    case 'event_field_declaration':
      return settings.insertExplicitAccessModifiersOnEvents && isInNonInterfaceType(node) ? 'private' : undefined;

    default:
      return undefined;
  }
}

/** The token the modifier goes in front of - after any attribute list. */
function declarationAnchor(node: Node): Node | undefined {
  const firstModifier = node.namedChildren.find((child) => child?.type === 'modifier');
  if (firstModifier) {
    return firstModifier;
  }

  switch (node.type) {
    case 'class_declaration':
      return keyword(node, 'class');

    case 'struct_declaration':
      return keyword(node, 'struct');

    case 'interface_declaration':
      return keyword(node, 'interface');

    case 'record_declaration':
      return keyword(node, 'record');

    case 'enum_declaration':
      return keyword(node, 'enum');

    case 'delegate_declaration':
      return keyword(node, 'delegate');

    case 'event_declaration':
    case 'event_field_declaration':
      return keyword(node, 'event');

    case 'field_declaration': {
      const declaration = node.namedChildren.find((child) => child?.type === 'variable_declaration');

      return declaration?.childForFieldName('type') ?? undefined;
    }

    case 'method_declaration':
    case 'property_declaration':
      return node.childForFieldName('type') ?? undefined;

    case 'constructor_declaration':
      return node.childForFieldName('name') ?? undefined;

    default:
      return undefined;
  }
}

function keyword(node: Node, type: string): Node | undefined {
  return node.children.find((child): child is Node => child?.type === type) ?? undefined;
}

function hasAnyModifier(node: Node, names: readonly string[]): boolean {
  return node.namedChildren.some((child) => child?.type === 'modifier' && names.includes(child.text));
}

function hasExplicitInterfaceSpecifier(node: Node): boolean {
  return node.namedChildren.some((child) => child?.type === 'explicit_interface_specifier');
}

/** The type declaration a member belongs to, going through the `declaration_list` body. */
function declaringType(node: Node): Node | undefined {
  const container = node.parent;
  if (container?.type !== 'declaration_list') {
    return undefined;
  }

  const owner = container.parent;

  return owner && TYPE_DECLARATIONS.has(owner.type) ? owner : undefined;
}

function isInNonInterfaceType(node: Node): boolean {
  const owner = declaringType(node);

  return owner !== undefined && owner.type !== 'interface_declaration';
}

function defaultAccessFor(node: Node): string {
  return declaringType(node) !== undefined ? 'private' : 'internal';
}
