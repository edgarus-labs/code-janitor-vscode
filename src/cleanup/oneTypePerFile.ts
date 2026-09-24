import * as path from 'node:path';
import { EditorConfigProperties, EditorConfigSeverity, isEnforced, resolveDiagnosticSeverity } from './editorconfig';
import { FILE_ORGANIZATION_DIAGNOSTICS } from './editorConfigRegistry';
import {
  SplitPlan,
  TopLevelTypeInfo,
  TopLevelTypeKind,
  TopLevelTypeSplitSkipReason,
  createTopLevelTypeSplitPlan,
  listTopLevelTypes,
} from './topLevelTypeSplit';

/**
 * One type per file, driven by the analyzer rules a repository enforces in `.editorconfig`:
 *
 * - `SA1402` (StyleCop, a file may only contain a single type): extra classes move to their own
 *   files. As with StyleCop's default `topLevelTypes` (`class`), other kinds may stay.
 * - `MA0048` (Meziantou, file name must match type name): every type not named like the file
 *   moves to its own file, and a remaining type named differently from the file is reported.
 * - `SA1649` (StyleCop, file name must match first type name): the first type must be named like
 *   the file; this never splits, it is reported.
 *
 * Roslyn has no such rule, so there is nothing to apply unless a repository installs the analyzer
 * and sets `dotnet_diagnostic.<ID>.severity` explicitly: a bulk severity does not tell whether the
 * analyzer is installed. Files are never renamed or overwritten; what cannot be done is reported.
 */

const CLASS_ONLY: ReadonlySet<TopLevelTypeKind> = new Set(['class']);
const ALL_KINDS: ReadonlySet<TopLevelTypeKind> = new Set(['class', 'struct', 'interface', 'enum', 'delegate']);

export interface OneTypePerFileRules {
  /** Enforced rule IDs with their severity. */
  readonly severities: ReadonlyMap<string, EditorConfigSeverity>;
}

export interface OneTypePerFileOutcome {
  readonly plan: SplitPlan;
  /** Violations the split could not fix, one message per type and rule. */
  readonly issues: readonly string[];
}

/** The enforced one-type-per-file rules of a file's `.editorconfig`, or `undefined` when there are none. */
export function readOneTypePerFileRules(props: EditorConfigProperties): OneTypePerFileRules | undefined {
  const severities = new Map<string, EditorConfigSeverity>();
  for (const [id, category] of Object.entries(FILE_ORGANIZATION_DIAGNOSTICS)) {
    if (props.get(`dotnet_diagnostic.${id}.severity`) === undefined) {
      continue;
    }

    const severity = resolveDiagnosticSeverity(props, id, undefined, category);
    if (severity && isEnforced(severity)) {
      severities.set(id, severity);
    }
  }

  return severities.size > 0 ? { severities } : undefined;
}

/**
 * Plans the split the rules require (`reservedFileNames`: the `.cs` files already in the file's
 * directory, which are never overwritten) and lists the violations left afterwards. Without
 * `moveTypes` (cleanup on save, which cannot create files safely) nothing is moved: the types the
 * split would move are reported too.
 */
export function planOneTypePerFile(
  source: string,
  filePath: string,
  rules: OneTypePerFileRules,
  reservedFileNames: ReadonlySet<string>,
  moveTypes = true
): OneTypePerFileOutcome {
  const { severities } = rules;
  const movableKinds = severities.has('MA0048') ? ALL_KINDS : severities.has('SA1402') ? CLASS_ONLY : undefined;
  const plan = movableKinds
    ? createTopLevelTypeSplitPlan(source, filePath, reservedFileNames, { movableKinds, refuseFileNameCollisions: true })
    : createTopLevelTypeSplitPlan('', filePath);
  const remaining = listTopLevelTypes(plan.hasChanges && moveTypes ? plan.updatedSource : source);
  const movable = new Set(
    plan.hasChanges && !moveTypes ? plan.newFiles.map((planned) => path.basename(planned.filePath).toUpperCase()) : []
  );
  // Like both analyzers, compare with the name up to the first dot (`Form.Designer.cs`, `View.xaml.cs`).
  const fileStem = path.basename(filePath).split('.')[0];
  const issues: string[] = [];
  const describe = (id: string, type: TopLevelTypeInfo, message: string) =>
    issues.push(`${id} (${severities.get(id)}) line ${type.line}: ${message}`);
  const notMoved = (id: string, type: TopLevelTypeInfo) =>
    describe(
      id,
      type,
      `type '${type.name}' was not moved to its own file because ${
        movable.has(type.fileName.toUpperCase())
          ? 'cleanup on save does not create files (VS Code can drop the edits of a save, which would leave the type in two files); a cleanup command moves it'
          : whyNotMoved(type, plan)
      }.`
    );
  const nameMismatch = (id: string, type: TopLevelTypeInfo) =>
    describe(id, type, `the file name does not match type '${type.name}' (expected '${type.fileName}'); files are not renamed.`);

  if (severities.has('SA1402')) {
    const classes = remaining.filter((type) => type.kind === 'class');
    const kept = classes.find((type) => matchesFileName(type, fileStem)) ?? classes[0];
    classes.filter((type) => type !== kept).forEach((type) => notMoved('SA1402', type));
  }

  if (severities.has('MA0048')) {
    const kept = remaining.find((type) => matchesFileName(type, fileStem));
    for (const type of remaining.filter((other) => other !== kept && !matchesFileName(other, fileStem))) {
      if (remaining.length > 1) {
        notMoved('MA0048', type);
      } else {
        nameMismatch('MA0048', type);
      }
    }
  }

  if (severities.has('SA1649') && remaining.length > 0 && !matchesFileName(remaining[0], fileStem)) {
    nameMismatch('SA1649', remaining[0]);
  }

  return { plan: moveTypes ? plan : createTopLevelTypeSplitPlan('', filePath), issues };
}

/** `Box`, `Box{T}` (StyleCop) and ``Box`1`` (metadata) all name the generic type `Box<T>`. */
function matchesFileName(type: TopLevelTypeInfo, fileStem: string): boolean {
  const accepted = [type.name, path.basename(type.fileName, '.cs')];
  if (type.typeParameterCount > 0) {
    accepted.push(`${type.name}\`${type.typeParameterCount}`);
  }

  return accepted.some((name) => name.toUpperCase() === fileStem.toUpperCase());
}

function whyNotMoved(type: TopLevelTypeInfo, plan: SplitPlan): string {
  if (type.isPartial) {
    return 'it is partial';
  }

  if (type.kind === 'struct') {
    return 'structs are not split';
  }

  switch (plan.skipReason) {
    case TopLevelTypeSplitSkipReason.FileNameCollision:
      return plan.collidingFileNames?.includes(type.fileName)
        ? `'${type.fileName}' already exists`
        : `the files of other types already exist (${plan.collidingFileNames?.join(', ')})`;
    case TopLevelTypeSplitSkipReason.UnsupportedStructure:
      return 'the file uses preprocessor directives, assembly attributes or several namespaces';
    default:
      return 'the other types of the file cannot be moved, so it stays as the main type of the file';
  }
}
