import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const BLOCKING_MODIFIERS: Record<string, true> = { sealed: true, abstract: true, static: true, partial: true };
const NAMESPACE_TYPES: Record<string, true> = {
  namespace_declaration: true,
  file_scoped_namespace_declaration: true,
};

/** Member kinds that can carry a `virtual` modifier a derived type might still be overriding. */
const OVERRIDABLE_MEMBER_TYPES: Record<string, true> = {
  method_declaration: true,
  property_declaration: true,
  indexer_declaration: true,
  event_declaration: true,
  event_field_declaration: true,
};

/** Constraint-clause identifiers that name a special constraint rather than a type. */
const SPECIAL_CONSTRAINT_IDENTIFIERS: Record<string, true> = { notnull: true, unmanaged: true };

/**
 * Adds the `sealed` modifier to classes only when provably safe.
 *
 * Sealing changes the public API surface (CA1852) and can break compilation outright (CS0509,
 * CS0549) if a class is still relied on as a base type or generic constraint, or still declares
 * an overridable member, so this is deliberately conservative: only top-level classes and records
 * are considered, only when they declare no `virtual` member, only when nothing in the same file
 * derives from or constrains against them, and - when the caller supplies names discovered from
 * other files via {@link discoverDisqualifiedTypeNames} - only when nothing outside the file needs
 * them unsealed either. Nested and partial types are left untouched.
 */
export function createSealedClassConverter(
  externalDisqualifiedTypeNames?: ReadonlySet<string>
): SourceTransformation {
  return {
    name: 'Sealed Class',
    apply(source: string): string {
      if (!source) {
        return source;
      }

      const tree = parseCSharp(source);

      try {
        const disqualifiedTypeNames = collectDisqualifiedTypeNames(tree.rootNode);
        if (externalDisqualifiedTypeNames) {
          for (const name of externalDisqualifiedTypeNames) {
            disqualifiedTypeNames.add(name);
          }
        }

        const edits: TextEdit[] = [];

        for (const declaration of findAll(tree.rootNode, ['class_declaration', 'record_declaration'])) {
          if (!isEligibleForSealing(declaration) || !isTopLevel(declaration)) {
            continue;
          }

          if (!isSafeToSeal(declaration, disqualifiedTypeNames)) {
            continue;
          }

          const keyword = typeKeyword(declaration);
          if (keyword) {
            edits.push({ start: keyword.startIndex, end: keyword.startIndex, text: 'sealed ' });
          }
        }

        return applyEdits(source, edits);
      } finally {
        tree.delete();
      }
    },
  };
}

/** Single-file behavior, with no cross-file context - used wherever only one file is in play. */
export const sealedClassConverter: SourceTransformation = createSealedClassConverter();

/**
 * Parses every given source and unions the type names each one disqualifies from sealing (base
 * types and generic constraint targets), so the result can be passed to
 * {@link createSealedClassConverter} to make one file's sealing decisions aware of other files. A
 * source that fails to parse is skipped rather than failing discovery for every other source.
 */
export function discoverDisqualifiedTypeNames(sources: Iterable<string>): Set<string> {
  const names = new Set<string>();

  for (const source of sources) {
    if (!source) {
      continue;
    }

    try {
      const tree = parseCSharp(source);
      try {
        for (const name of collectDisqualifiedTypeNames(tree.rootNode)) {
          names.add(name);
        }
      } finally {
        tree.delete();
      }
    } catch {
      // A single malformed/partial source must not block the safety net for every other source.
    }
  }

  return names;
}

/** Every type name a single syntax tree disqualifies from sealing: base types and generic constraint targets. */
function collectDisqualifiedTypeNames(root: Node): Set<string> {
  const names = new Set<string>();

  for (const baseList of findAll(root, 'base_list')) {
    for (const baseType of baseList.namedChildren) {
      if (baseType) {
        names.add(simpleName(baseType));
      }
    }
  }

  for (const clause of findAll(root, 'type_parameter_constraints_clause')) {
    for (const name of constraintTypeNames(clause)) {
      names.add(name);
    }
  }

  return names;
}

function isEligibleForSealing(declaration: Node): boolean {
  if (declaration.type === 'class_declaration') {
    return true;
  }

  return !declaration.children.some((child) => child?.type === 'struct');
}

function isTopLevel(declaration: Node): boolean {
  const parent = declaration.parent;
  if (!parent) {
    return false;
  }

  // A file-scoped namespace holds its members directly; a block-scoped one wraps them in a body.
  if (parent.type === 'compilation_unit' || NAMESPACE_TYPES[parent.type] === true) {
    return true;
  }

  return parent.type === 'declaration_list' && parent.parent !== null && NAMESPACE_TYPES[parent.parent.type] === true;
}

function isSafeToSeal(declaration: Node, disqualifiedTypeNames: ReadonlySet<string>): boolean {
  const hasBlockingModifier = declaration.namedChildren.some(
    (child) => child?.type === 'modifier' && BLOCKING_MODIFIERS[child.text] === true
  );

  if (hasBlockingModifier || hasOverridableMember(declaration)) {
    return false;
  }

  const name = declaration.childForFieldName('name')?.text;

  return name !== undefined && !disqualifiedTypeNames.has(name);
}

/** True when the type directly declares a `virtual` method, property, indexer, event or event field (CS0549 once sealed). */
function hasOverridableMember(declaration: Node): boolean {
  const body = declaration.childForFieldName('body');

  return (body?.namedChildren ?? []).some(
    (member) =>
      OVERRIDABLE_MEMBER_TYPES[member.type] === true &&
      member.namedChildren.some((child) => child?.type === 'modifier' && child.text === 'virtual')
  );
}

function typeKeyword(declaration: Node): Node | undefined {
  const keyword = declaration.type === 'class_declaration' ? 'class' : 'record';

  return declaration.children.find((child): child is Node => child?.type === keyword) ?? undefined;
}

/** Recursively extracts the rightmost simple identifier of a (possibly qualified) type name. */
function simpleName(type: Node): string {
  switch (type.type) {
    case 'identifier':
      return type.text;

    case 'generic_name':
      return type.namedChild(0)?.text ?? type.text;

    case 'qualified_name':
    case 'alias_qualified_name': {
      const right = type.childForFieldName('name') ?? type.namedChild(type.namedChildCount - 1);

      return right ? simpleName(right) : type.text;
    }

    default: {
      const first = type.namedChild(0);

      return first && first.type !== type.type ? simpleName(first) : type.text;
    }
  }
}

/**
 * Extracts the type names a single `where` constraint clause disqualifies from sealing.
 *
 * `parseConstraintClauses` (see `syntax/parser.ts`) captures a clause as a flat token list rather
 * than a structured type list, so this walks that list directly instead of the named-child tree
 * that {@link simpleName} relies on for base-list types.
 */
function constraintTypeNames(clause: Node): string[] {
  const tokens = clause.children;
  const names: string[] = [];
  let segment: Node[] = [];
  let depth = 0;

  for (let i = skipConstraintClauseHeader(tokens); i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === '<') {
      depth++;
    } else if (token.type === '>') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.type === ',') {
      appendConstraintSegmentName(names, segment);
      segment = [];
      continue;
    } else if (depth === 0 && (token.type === '{' || token.type === ';' || (token.type === 'identifier' && token.text === 'where'))) {
      break;
    }

    segment.push(token);
  }

  appendConstraintSegmentName(names, segment);

  return names;
}

/** Appends one comma-separated constraint segment's type name to `names`, if it names a real type. */
function appendConstraintSegmentName(names: string[], segment: readonly Node[]): void {
  const name = constraintSegmentTypeName(segment);
  if (name) {
    names.push(name);
  }
}

/** Skips a clause's leading `where <identifier> :` tokens, returning the index of the first constraint token. */
function skipConstraintClauseHeader(tokens: readonly Node[]): number {
  let i = 0;

  if (tokens[i]?.type === 'identifier' && tokens[i].text === 'where') {
    i++;
  }
  if (tokens[i]?.type === 'identifier') {
    i++;
  }
  if (tokens[i]?.type === ':') {
    i++;
  }

  return i;
}

/** The type name one comma-separated constraint segment names, or `undefined` for a non-type constraint. */
function constraintSegmentTypeName(segment: readonly Node[]): string | undefined {
  const [first, second, third] = segment;
  if (!first) {
    return undefined;
  }

  if (first.type === 'class' || first.type === 'struct' || first.type === 'default') {
    return undefined;
  }

  if (first.type === 'new' && second?.type === '(' && third?.type === ')') {
    return undefined;
  }

  if (first.type === 'identifier' && SPECIAL_CONSTRAINT_IDENTIFIERS[first.text] === true) {
    return undefined;
  }

  return simpleNameFromTokens(segment);
}

/**
 * Token-list counterpart of {@link simpleName}: takes the rightmost top-level identifier of a
 * dotted, possibly-generic, possibly-nullable type reference (`System.Collections.Generic.IList`,
 * `IEnumerable<Result>`, `Result?`), since a constraint clause's tokens are a flat list rather
 * than a structured type node.
 */
function simpleNameFromTokens(tokens: readonly Node[]): string | undefined {
  let depth = 0;
  let last: string | undefined;

  for (const token of tokens) {
    if (token.type === '<') {
      depth++;
    } else if (token.type === '>') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.type === 'identifier') {
      last = token.text;
    }
  }

  return last;
}
