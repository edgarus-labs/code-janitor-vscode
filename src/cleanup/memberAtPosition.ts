import { Node, findAll, parseCSharp } from './parser';

const MEMBER_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'property_declaration',
  'indexer_declaration',
  'event_declaration',
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
  'enum_declaration',
];

export interface EnclosingMember {
  name: string;
  text: string;
}

/**
 * Finds the innermost member declaration containing the offset, which is what the Visual Studio
 * extension got from its code model when running an AI action on the caret position.
 */
export function findEnclosingMember(source: string, offset: number): EnclosingMember | undefined {
  if (!source || !source.trim()) {
    return undefined;
  }

  const tree = parseCSharp(source);

  try {
    let best: Node | undefined;

    for (const node of findAll(tree.rootNode, MEMBER_TYPES)) {
      if (node.startIndex > offset || node.endIndex < offset) {
        continue;
      }

      if (!best || node.startIndex >= best.startIndex) {
        best = node;
      }
    }

    return best ? { name: best.childForFieldName('name')?.text ?? 'member', text: best.text } : undefined;
  } finally {
    tree.delete();
  }
}
