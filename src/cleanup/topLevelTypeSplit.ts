import * as path from 'node:path';
import { Node, applyEdits, parseCSharp } from './parser';

/**
 * Mirrors the source extension's `TopLevelTypeSplitSkipReason`: the reason no split plan was
 * produced, so a caller can explain why a file was left untouched.
 */
export const enum TopLevelTypeSplitSkipReason {
  None = 'none',
  EmptySource = 'emptySource',
  UnsupportedStructure = 'unsupportedStructure',
  NotMultipleEligibleTypes = 'notMultipleEligibleTypes',
}

export interface PlannedFile {
  readonly filePath: string;
  readonly content: string;
}

export interface SplitPlan {
  readonly updatedSource: string;
  readonly newFiles: readonly PlannedFile[];
  readonly skipReason: TopLevelTypeSplitSkipReason;
  readonly hasChanges: boolean;
}

const NAMESPACE_TYPES = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);
const TYPE_DECL_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'enum_declaration',
  'delegate_declaration',
]);
/** Structs are intentionally excluded, matching the source extension's eligibility rule. */
const PARTIAL_CHECK_TYPES = new Set(['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration']);

interface MemberEntry {
  readonly member: Node;
  readonly start: number;
  readonly end: number;
}

/**
 * Plans a split of a C# file containing multiple top-level types into one file per type, keeping
 * the type whose generated file name matches the current file name (or the first eligible type)
 * in place. Pure and side-effect free: callers write the returned `newFiles` and `updatedSource`
 * themselves, supplying already-reserved sibling file names to avoid collisions.
 */
export function createTopLevelTypeSplitPlan(
  source: string,
  filePath: string,
  reservedFileNames: ReadonlySet<string> = new Set()
): SplitPlan {
  if (!source.trim() || !filePath.trim()) {
    return emptyPlan(source, TopLevelTypeSplitSkipReason.EmptySource);
  }

  if (hasUnsupportedTopLevelSyntax(source)) {
    return emptyPlan(source, TopLevelTypeSplitSkipReason.UnsupportedStructure);
  }

  const tree = parseCSharp(source);

  try {
    const resolved = resolveContainer(tree.rootNode);
    if (!resolved) {
      return emptyPlan(source, TopLevelTypeSplitSkipReason.UnsupportedStructure);
    }

    const entries = collectMemberEntries(resolved.orderedChildren, resolved.exclude);
    if (!entries) {
      return emptyPlan(source, TopLevelTypeSplitSkipReason.UnsupportedStructure);
    }

    const eligible = entries.filter((entry) => isEligibleTopLevelType(entry.member));
    if (eligible.length <= 1) {
      return emptyPlan(source, TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
    }

    const originalFileName = path.basename(filePath);
    const keep =
      eligible.find((entry) => buildTypeFileName(entry.member).toUpperCase() === originalFileName.toUpperCase()) ??
      eligible[0];
    const moved = eligible.filter((entry) => entry !== keep);

    if (moved.length === 0) {
      return emptyPlan(source, TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
    }

    const updatedSource = applyEdits(
      source,
      moved.map((entry) => ({ start: entry.start, end: entry.end, text: '' }))
    );

    const directoryPath = path.dirname(filePath);
    const reservedUpper = new Set([...reservedFileNames].map((name) => name.toUpperCase()));
    const newFiles: PlannedFile[] = [];

    for (const entry of moved) {
      const finalFileName = makeFileNameUnique(buildTypeFileName(entry.member), reservedUpper);
      reservedUpper.add(finalFileName.toUpperCase());

      const othersToRemove = entries.filter((other) => other !== entry);
      const content = applyEdits(
        source,
        othersToRemove.map((other) => ({ start: other.start, end: other.end, text: '' }))
      );

      newFiles.push({ filePath: path.join(directoryPath, finalFileName), content });
    }

    return { updatedSource, newFiles, skipReason: TopLevelTypeSplitSkipReason.None, hasChanges: true };
  } finally {
    tree.delete();
  }
}

function emptyPlan(source: string, skipReason: TopLevelTypeSplitSkipReason): SplitPlan {
  return { updatedSource: source, newFiles: [], skipReason, hasChanges: false };
}

/**
 * Textual pre-check for structures the source extension also refuses to split: assembly/module
 * level attributes and any preprocessor directive other than `#region`/`#endregion`. Checked on
 * raw text because the parser folds unrecognized top-level constructs into ordinary declaration
 * nodes rather than exposing dedicated syntax for them.
 */
function hasUnsupportedTopLevelSyntax(source: string): boolean {
  if (/^[ \t]*\[\s*(assembly|module)\s*:/m.test(source)) {
    return true;
  }

  for (const line of source.split(/\r\n|\r|\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') && !/^#\s*(region|endregion)\b/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves the node whose direct children are the candidate top-level types: the compilation unit
 * itself, or the sole namespace when the file declares exactly one and nothing else alongside it.
 */
function resolveContainer(root: Node): { orderedChildren: readonly Node[]; exclude?: Node } | undefined {
  const rootChildren = root.namedChildren;
  const namespaceChildren = rootChildren.filter((child) => NAMESPACE_TYPES.has(child.type));

  if (namespaceChildren.length > 1) {
    return undefined;
  }

  if (namespaceChildren.length === 0) {
    return { orderedChildren: rootChildren };
  }

  const nonIgnorableRootChildren = rootChildren.filter((child) => !isIgnorableAtRoot(child));
  if (nonIgnorableRootChildren.length !== 1) {
    return undefined;
  }

  const namespaceNode = namespaceChildren[0];

  if (namespaceNode.type === 'namespace_declaration') {
    const body = namespaceNode.childForFieldName('body');

    return body ? { orderedChildren: body.namedChildren } : undefined;
  }

  // File-scoped: its own named children mix the namespace name in with its members and trivia.
  const nameNode = namespaceNode.childForFieldName('name') ?? undefined;

  return { orderedChildren: namespaceNode.namedChildren, exclude: nameNode };
}

function isIgnorableAtRoot(node: Node): boolean {
  return (
    node.type === 'using_directive' ||
    node.type === 'attribute_list' ||
    node.type === 'comment' ||
    node.type.startsWith('preproc_')
  );
}

/**
 * Groups each top-level declaration with its immediately preceding run of comments/`#region`
 * trivia, so moving a type also moves the comment that documents it. Returns `undefined` when a
 * child is neither trivia, a using directive, nor a recognized type/delegate declaration - a
 * nested namespace or unparseable content, which the source extension also refuses to split.
 */
function collectMemberEntries(orderedChildren: readonly Node[], exclude?: Node): MemberEntry[] | undefined {
  const entries: MemberEntry[] = [];
  let pendingStart: number | undefined;

  for (const child of orderedChildren) {
    if (child === exclude) {
      continue;
    }

    if (child.type === 'comment' || child.type === 'preproc_region' || child.type === 'preproc_endregion') {
      pendingStart ??= child.startIndex;
      continue;
    }

    if (child.type === 'using_directive' || child.type === 'attribute_list') {
      pendingStart = undefined;
      continue;
    }

    if (!TYPE_DECL_TYPES.has(child.type)) {
      return undefined;
    }

    entries.push({ member: child, start: pendingStart ?? child.startIndex, end: child.endIndex });
    pendingStart = undefined;
  }

  return entries;
}

function isEligibleTopLevelType(member: Node): boolean {
  if (member.type === 'delegate_declaration') {
    return true;
  }

  return PARTIAL_CHECK_TYPES.has(member.type) && !hasPartialModifier(member);
}

function hasPartialModifier(member: Node): boolean {
  return member.children.some((child) => child.type === 'modifier' && child.text === 'partial');
}

function buildTypeFileName(member: Node): string {
  return buildTypeFileStem(member) + '.cs';
}

function buildTypeFileStem(member: Node): string {
  const identifier = member.childForFieldName('name')?.text ?? '';
  const typeParameters = getTypeParameterNames(member);

  return typeParameters.length === 0 ? identifier : `${identifier}{${typeParameters.join(',')}}`;
}

function getTypeParameterNames(member: Node): string[] {
  const list = member.children.find((child) => child.type === 'type_parameter_list');

  return list ? list.children.filter((child) => child.type === 'identifier').map((child) => child.text) : [];
}

function makeFileNameUnique(desiredFileName: string, reservedUpper: ReadonlySet<string>): string {
  if (!reservedUpper.has(desiredFileName.toUpperCase())) {
    return desiredFileName;
  }

  const lastDot = desiredFileName.lastIndexOf('.');
  const stem = lastDot >= 0 ? desiredFileName.slice(0, lastDot) : desiredFileName;
  const extension = lastDot >= 0 ? desiredFileName.slice(lastDot) : '';

  let suffix = 1;
  let candidate: string;
  do {
    candidate = `${stem}~${suffix}${extension}`;
    suffix++;
  } while (reservedUpper.has(candidate.toUpperCase()));

  return candidate;
}
