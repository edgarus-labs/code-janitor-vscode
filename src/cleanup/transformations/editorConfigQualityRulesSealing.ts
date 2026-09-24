import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { hasModifier, hasParseErrors } from './editorConfigSupport';
import { loadProjectFacts } from './editorConfigQualityRulesProject';
import {
  Suppressions,
  addModifierEdit,
  attributeSimpleName,
  attributesOf,
  describeDiagnostic,
  isRecordStruct,
  isRuleActive,
  readCodeQualityOption,
  resultantVisibility,
} from './editorConfigQualityRulesSupport';
import { collectDisqualifiedTypeNames, sealingBlocker } from './sealedClass';

/**
 * CA1852: seals classes and records that are not visible outside the assembly when no type of the
 * project derives from them (or uses them as a generic constraint). The project's other files are
 * read to prove it; without them, or when something else keeps a type from being sealed safely,
 * the violation is reported.
 */
export function applySealInternalTypes(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1852', source)) {
    return source;
  }

  const tree = parseCSharp(source);
  try {
    const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
    const derived = new Set([...collectDisqualifiedTypeNames(tree.rootNode), ...(project?.others.derivedOrConstrainedNames ?? [])]);
    const ignoreInternalsVisibleTo = readCodeQualityOption(context.props, 'CA1852', 'ignore_internalsvisibleto') === 'true';
    const suppressions = new Suppressions(source);
    const edits: TextEdit[] = [];
    for (const declaration of findAll(tree.rootNode, ['class_declaration', 'record_declaration'])) {
      const name = declaration.childForFieldName('name')?.text;
      const keyword = declaration.children.find((child) => child.type === 'class' || child.type === 'record');
      const blocked = ['abstract', 'static', 'sealed'].some((modifier) => hasModifier(declaration, modifier));
      if (!name || !keyword || blocked || isRecordStruct(declaration) || resultantVisibility(declaration) === 'public') {
        continue;
      }

      // Not violations: the type has subtypes, is a COM import, or the analyzer is suppressed or
      // (by default) off for an assembly exposing its internals.
      const comImport = attributesOf(declaration).some((attribute) => attributeSimpleName(attribute) === 'ComImport');
      if (derived.has(name) || comImport || suppressions.isSuppressed('CA1852', declaration)) {
        continue;
      }

      if (project?.internalsVisibleTo && !ignoreInternalsVisibleTo) {
        continue;
      }

      const reason = blockerOf(declaration, project === undefined, project?.incomplete, project?.internalsVisibleTo === true);
      if (reason) {
        context.report(describeDiagnostic('CA1852', source, declaration.startIndex, `'${name}' is not visible outside the assembly and could be sealed, but ${reason}; it was left unsealed.`));
        continue;
      }

      edits.push(addModifierEdit(context.props, declaration, 'sealed', keyword));
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function blockerOf(declaration: Node, noProject: boolean, incomplete: string | undefined, internalsVisibleTo: boolean): string | undefined {
  if (hasModifier(declaration, 'partial')) {
    return 'it is partial and its other parts were not analyzed';
  }

  if (hasParseErrors(declaration)) {
    return 'the cleanup parser could not fully analyze it';
  }

  const structural = sealingBlocker(declaration);
  if (structural) {
    return structural;
  }

  if (noProject) {
    return 'no project file was found to check that no other file derives from it';
  }

  if (incomplete) {
    return `the project's files could not all be checked (${incomplete})`;
  }

  if (internalsVisibleTo) {
    return 'InternalsVisibleTo exposes it to other assemblies that may derive from it';
  }

  return undefined;
}
