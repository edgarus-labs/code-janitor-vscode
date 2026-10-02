import { SourceModel, baseTypeNames, buildSourceModel, typeAt } from '../naming/sourceModel';
import { Node, TextEdit, applyEdits, findAll, walk } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { hasModifier, hasParseErrors } from './editorConfigSupport';
import { ProjectFacts, collectConversionTargetNames, exposesInternals, loadProjectFacts, suppressionsOf } from './editorConfigQualityRulesProject';
import {
  DeclaredTypes,
  addModifierEdit,
  attributeSimpleName,
  attributesOf,
  describeDiagnostic,
  isRecordStruct,
  isRuleActive,
  readCodeQualityOption,
  resultantVisibility,
  simpleTypeName,
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

  const model = buildSourceModel(source);
  const root = model.root;
  const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
  const derived = new Set([...collectDisqualifiedTypeNames(root), ...(project?.others.derivedOrConstrainedNames ?? [])]);
  const conversionTargets = new Set([...collectConversionTargetNames(source, root), ...(project?.others.conversionTargetNames ?? [])]);
  const interfaceConversions = new InterfaceConversions(model, project);
  const ignoreInternalsVisibleTo = readCodeQualityOption(context.props, 'CA1852', 'ignore_internalsvisibleto') === 'true';
  const internalsVisibleTo = exposesInternals(project, source);
  const suppressions = suppressionsOf(source, context);
  const edits: TextEdit[] = [];
  for (const declaration of findAll(root, ['class_declaration', 'record_declaration'])) {
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

    if (internalsVisibleTo && !ignoreInternalsVisibleTo) {
      continue;
    }

    const reason =
      blockerOf(declaration, project === undefined, project?.incomplete, project?.markup, internalsVisibleTo) ??
      // The conversion's operand type is unknown syntactically: from an interface the class does not implement, it stops compiling.
      (conversionTargets.has(name) ? 'it is the target of a cast, as or type pattern, which no longer compiles from an interface it does not implement once it is sealed' : undefined) ??
      interfaceConversions.blocker(declaration, name);
    if (reason) {
      context.report(describeDiagnostic('CA1852', source, declaration.startIndex, `'${name}' is not visible outside the assembly and could be sealed, but ${reason}; it was left unsealed.`));
      continue;
    }

    edits.push(addModifierEdit(context.props, declaration, 'sealed', keyword));
  }

  return applyEdits(source, edits);
}

/** A name following the .NET convention for interfaces (`IDisposable`); the BCL's are not declared in the project. */
const INTERFACE_NAME = /^I\p{Lu}/u;

/** An explicit conversion: a cast, `as`, `is`, or the patterns of a switch statement or expression. */
interface Conversion {
  readonly operand: Node;
  /** Simple names in the target types (and, for patterns, every other name of the pattern). */
  readonly targets: readonly string[];
}

/**
 * Conversions to interfaces a class does not implement. Sealing removes the explicit conversion
 * from a class to such an interface (it exists only while the class is not sealed), so a cast,
 * `as` or type pattern converting a value of the class stops compiling (CS0030, CS0039, CS8121).
 * In this file a conversion counts unless its operand's declared type is another type; in the
 * project's other files, whose operand types are not known, any conversion to an interface counts.
 */
class InterfaceConversions {
  private readonly conversions: readonly Conversion[];
  private readonly types: DeclaredTypes;
  private readonly interfaceNames: ReadonlySet<string>;

  constructor(
    private readonly model: SourceModel,
    private readonly project: ProjectFacts | undefined
  ) {
    this.conversions = conversionsOf(model.root);
    this.types = new DeclaredTypes(model, project?.others.typeNames);
    this.interfaceNames = new Set([...model.types.filter((type) => type.kind === 'interface').map((type) => type.name), ...(project?.others.interfaceNames ?? [])]);
  }

  blocker(declaration: Node, name: string): string | undefined {
    const implemented = new Set(baseTypeNames(declaration));
    const unimplemented = (target: string): boolean => target !== name && !implemented.has(target) && (INTERFACE_NAME.test(target) || this.interfaceNames.has(target));
    for (const conversion of this.conversions) {
      const target = this.mayBeOf(conversion.operand, name) ? conversion.targets.find(unimplemented) : undefined;
      if (target) {
        return `code converts a value that may be a ${name} to ${target}, an interface it does not implement, which no longer compiles once it is sealed`;
      }
    }

    const elsewhere = [...(this.project?.others.conversionTargetNames ?? [])].find(unimplemented);

    return elsewhere
      ? `another file of the project converts a value of a type it does not know to ${elsewhere}, an interface ${name} does not implement, which no longer compiles once it is sealed if the value is a ${name}`
      : undefined;
  }

  /** Whether `operand` may have the static type `name`: its declared type is unknown or is that type. */
  private mayBeOf(operand: Node, name: string): boolean {
    const type = operand.type === 'this_expression' ? typeAt(this.model, operand.startIndex)?.name : this.types.typeOf(operand);

    return type === undefined || simpleTypeName(type) === name;
  }
}

function conversionsOf(root: Node): Conversion[] {
  const names = (nodes: readonly Node[]): string[] =>
    nodes.flatMap((node) => [node, ...node.descendantsOfType('identifier')]).filter((node) => node.type === 'identifier').map((node) => node.text.replace(/^@/, ''));
  const conversions: Conversion[] = [];
  for (const node of walk(root)) {
    const [first, ...rest] = node.namedChildren;
    switch (node.type) {
      case 'cast_expression': {
        const type = node.childForFieldName('type') ?? first;
        const value = node.childForFieldName('value') ?? rest[0];
        if (type && value) {
          conversions.push({ operand: value, targets: names([type]) });
        }

        break;
      }
      case 'binary_expression':
        if (first && rest.length > 0 && node.children.some((child) => child.type === 'as' || child.type === 'is')) {
          conversions.push({ operand: first, targets: names(rest) });
        }

        break;
      case 'is_pattern_expression':
      case 'switch_expression':
        if (first) {
          conversions.push({ operand: first, targets: names(rest) });
        }

        break;
      case 'switch_statement': {
        // The case labels, not the statements of the sections.
        const labels = rest.flatMap((body) => body.namedChildren).filter((child) => !/(?:_statement|^block)$/.test(child.type));
        if (first) {
          conversions.push({ operand: first, targets: names(labels) });
        }

        break;
      }
    }
  }

  return conversions;
}

function blockerOf(declaration: Node, noProject: boolean, incomplete: string | undefined, markup: string | undefined, internalsVisibleTo: boolean): string | undefined {
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

  // Markup cannot see a private type, unless a containing type is partial: Razor `@code` and XAML
  // `x:Code` are other parts of that type.
  if (markup && (resultantVisibility(declaration) !== 'private' || hasPartialContainer(declaration))) {
    return `markup of the project the cleanup does not read may derive from it (${markup})`;
  }

  if (internalsVisibleTo) {
    return 'InternalsVisibleTo exposes it to other assemblies that may derive from it';
  }

  return undefined;
}

function hasPartialContainer(declaration: Node): boolean {
  for (let current = declaration.parent; current; current = current.parent) {
    if (/^(?:class|struct|record|interface)_declaration$/.test(current.type) && hasModifier(current, 'partial')) {
      return true;
    }
  }

  return false;
}
