import * as fs from 'node:fs';
import * as path from 'node:path';
import { STRING, classifyCSharp } from '../csharpScanner';
import { loadEditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { describeNamingViolation, findNamingViolations, NamingViolation } from '../transformations/editorConfigNaming';
import { hasParseErrors, lineNumberAt } from '../transformations/editorConfigSupport';
import { parseNamingRules } from './namingRules';
import { invalidNewName } from './renamer';
import { buildSourceModel, DeclaredSymbol, Occurrence, SourceModel, spans, TypeInfo } from './sourceModel';
import { projectOf, referencingClosure, WorkspaceProject } from './workspaceScope';

/**
 * Renames non-private symbols that violate the `.editorconfig` naming rules (IDE1006) in every file
 * that may use them: the files of the declaring project and of the projects referencing it. Like the
 * in-file renamer it is syntactic, so it only renames when every use of the old name is understood:
 * the old name is declared by the renamed symbols alone (or by locals and parameters whose scope is
 * known), it does not appear as text (strings, XAML, Razor, JSON), the new name is not used yet, and
 * no code outside the workspace can depend on the symbol. Everything else is reported, not renamed.
 */

export interface WorkspaceRenameRequest {
  readonly projects: readonly WorkspaceProject[];
  /** Files whose declarations may be renamed (full paths). */
  readonly targets: readonly string[];
  /** Current text of a C# file: the open editor's, else the file's on disk. */
  readonly read: (filePath: string) => string;
}

export interface SymbolRename {
  readonly oldName: string;
  readonly newName: string;
  /** `field`, `method`, `class`, ... of the first declaration. */
  readonly kind: string;
  readonly declaredIn: string;
  readonly line: number;
  /** Files the rename changes. */
  readonly files: readonly string[];
}

export interface WorkspaceRenameIssue {
  readonly filePath: string;
  readonly detail: string;
}

export interface WorkspaceRenamePlan {
  readonly renames: readonly SymbolRename[];
  /** Violations left in place, with the reason. */
  readonly issues: readonly WorkspaceRenameIssue[];
  /** New content of every changed file. */
  readonly contents: ReadonlyMap<string, string>;
}

const OUTCOME = 'not renamed across the workspace';
const SERIALIZATION_ATTRIBUTES = new Set([
  'Serializable', 'DataContract', 'DataMember', 'JsonSerializable', 'JsonProperty', 'JsonPropertyName', 'JsonObject',
  'XmlRoot', 'XmlType', 'XmlElement', 'XmlAttribute', 'ProtoContract', 'ProtoMember', 'MessagePackObject', 'Table', 'Column',
]);
const MEMBER_DECLARATIONS = new Set([
  'field_declaration', 'event_field_declaration', 'property_declaration', 'event_declaration', 'method_declaration', 'enum_member_declaration',
]);
const TYPE_DECLARATIONS = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'delegate_declaration']);
const REFUSED_MODIFIERS = ['virtual', 'override', 'abstract', 'new', 'extern', 'partial'];

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

/** A file of the workspace, read and modelled on demand. */
class SourceFile {
  private modelCache: SourceModel | undefined;
  private kindsCache: Uint8Array | undefined;
  private typesCache: { name: string; bases: string[] }[] | undefined;
  readonly bom: boolean;
  readonly text: string;

  constructor(
    readonly path: string,
    raw: string
  ) {
    this.bom = raw.startsWith('\uFEFF');
    this.text = this.bom ? raw.slice(1) : raw;
  }

  mentions(name: string): boolean {
    return wordPattern(name).test(this.text);
  }

  get model(): SourceModel {
    return (this.modelCache ??= buildSourceModel(this.text));
  }

  get kinds(): Uint8Array {
    return (this.kindsCache ??= classifyCSharp(this.text));
  }

  /** Types the file declares, with the simple names of their base types. */
  get types(): { name: string; bases: string[] }[] {
    if (!this.typesCache) {
      const tree = parseCSharp(this.text);
      try {
        this.typesCache = findAll(tree.rootNode, [...TYPE_DECLARATIONS]).map((node) => ({
          name: node.childForFieldName('name')?.text.replace(/^@/, '') ?? '',
          bases: baseNames(node),
        }));
      } finally {
        tree.delete();
      }
    }

    return this.typesCache;
  }

  line(offset: number): number {
    return lineNumberAt(this.text, offset);
  }
}

function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{Nd}_])@?${name}(?![\\p{L}\\p{Nd}_])`, 'u');
}

/** A declaration that is renamed: the symbol, its file and its naming violation. */
interface Renamed {
  readonly file: SourceFile;
  readonly violation: NamingViolation;
}

export function planWorkspaceRenames(request: WorkspaceRenameRequest): WorkspaceRenamePlan {
  return new WorkspacePlanner(request).plan();
}

class WorkspacePlanner {
  private readonly files = new Map<string, SourceFile>();
  private readonly targets: ReadonlySet<string>;
  private readonly issues: WorkspaceRenameIssue[] = [];
  private readonly renames: SymbolRename[] = [];
  private readonly edits = new Map<string, TextEdit[]>();
  /** Old and new names of the accepted renames: two renames touching the same name are not combined. */
  private readonly touchedNames = new Set<string>();
  private readonly handled = new Set<string>();

  constructor(private readonly request: WorkspaceRenameRequest) {
    this.targets = new Set(request.targets.map((target) => path.resolve(target)));
  }

  plan(): WorkspaceRenamePlan {
    for (const target of this.targets) {
      const project = projectOf(this.request.projects, target);
      const file = this.file(target);
      const props = loadEditorConfigProperties(target);
      const candidates = findNamingViolations(file.model, parseNamingRules(props), props).filter(isCandidate);
      for (const violation of candidates) {
        if (!project) {
          this.report(file, violation, 'the file is not in a C# project of the workspace');
          continue;
        }

        const key = `${project.projectFile}|${violation.symbol.category}|${violation.symbol.name}`;
        if (!this.handled.has(key)) {
          this.handled.add(key);
          this.planGroup(project, { file, violation });
        }
      }
    }

    const contents = new Map<string, string>();
    for (const [filePath, edits] of this.edits) {
      const file = this.file(filePath);
      contents.set(filePath, (file.bom ? '\uFEFF' : '') + applyEdits(file.text, edits));
    }

    this.issues.sort((a, b) => a.filePath.localeCompare(b.filePath) || lineOf(a.detail) - lineOf(b.detail));

    return { renames: this.renames, issues: this.issues, contents };
  }

  private file(filePath: string): SourceFile {
    let file = this.files.get(filePath);
    if (!file) {
      file = new SourceFile(filePath, this.request.read(filePath));
      this.files.set(filePath, file);
    }

    return file;
  }

  private report(file: SourceFile, violation: NamingViolation, reason: string): void {
    this.issues.push({ filePath: file.path, detail: describeNamingViolation(violation, reason, OUTCOME) });
  }

  /** Renames every declaration named like `first` in the scope, or reports why not. */
  private planGroup(project: WorkspaceProject, first: Renamed): void {
    const oldName = first.violation.symbol.name;
    const newName = first.violation.newName;
    const renamed: Renamed[] = [first];
    try {
      const invalid = invalidNewName(oldName, newName);
      if (invalid) {
        refuse(invalid);
      }

      const scope = referencingClosure(this.request.projects, project);
      const problem = scope.find((member) => member.problem)?.problem;
      if (problem) {
        refuse(problem);
      }

      const sources = scope.flatMap((member) => member.csharpFiles).map((filePath) => this.file(filePath));
      const shadows = this.collectDeclarations(project, sources, first, renamed);
      for (const declaration of renamed) {
        this.checkDeclaration(project, sources, declaration);
      }

      this.checkText(scope, sources, oldName);
      this.checkNewName(sources, newName, oldName);
      if (this.touchedNames.has(oldName) || this.touchedNames.has(newName)) {
        refuse(`another rename in this cleanup uses '${oldName}' or '${newName}'; run cleanup again`);
      }

      const edits = this.collectEdits(sources, renamed, shadows, oldName, newName);
      this.touchedNames.add(oldName);
      this.touchedNames.add(newName);
      for (const [filePath, fileEdits] of edits) {
        this.edits.set(filePath, [...(this.edits.get(filePath) ?? []), ...fileEdits]);
      }

      const symbol = first.violation.symbol;
      this.renames.push({
        oldName,
        newName,
        kind: symbol.kind.replace('_', ' '),
        declaredIn: first.file.path,
        line: first.file.line(symbol.nameNode.startIndex),
        files: [...edits.keys()],
      });
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }

      for (const declaration of renamed.filter((candidate) => this.targets.has(candidate.file.path))) {
        this.report(declaration.file, declaration.violation, error.message);
      }
    }
  }

  /**
   * Sorts every declaration named `oldName` in the scope: the ones renamed with `first` (added to
   * `renamed`) and the locals and parameters that keep the name (returned). Anything else refuses.
   */
  private collectDeclarations(project: WorkspaceProject, sources: readonly SourceFile[], first: Renamed, renamed: Renamed[]): Map<SourceFile, DeclaredSymbol[]> {
    const { name } = first.violation.symbol;
    const shadows = new Map<SourceFile, DeclaredSymbol[]>();
    for (const file of sources.filter((source) => source.mentions(name))) {
      const props = loadEditorConfigProperties(file.path);
      const violations = findNamingViolations(file.model, parseNamingRules(props), props);
      for (const symbol of file.model.symbols.filter((candidate) => candidate.name === name)) {
        if (file === first.file && symbol === first.violation.symbol) {
          continue;
        }

        const where = `${file.path} line ${file.line(symbol.nameNode.startIndex)}`;
        if (symbol.category === 'local' || symbol.category === 'parameter' || symbol.category === 'range') {
          if (!symbol.region || !symbol.regionPrecise) {
            refuse(`the scope of the ${symbol.kind.replace('_', ' ')} '${name}' in ${where} cannot be determined`);
          }

          shadows.set(file, [...(shadows.get(file) ?? []), symbol]);
          continue;
        }

        const violation = violations.find((candidate) => candidate.symbol === symbol);
        if (
          !violation ||
          violation.newName !== first.violation.newName ||
          symbol.category !== first.violation.symbol.category ||
          !isCandidate(violation)
        ) {
          const count = file.model.symbols.filter((candidate) => candidate.name === name).length + (file === first.file ? 0 : 1);
          refuse(`${count} declarations are named '${name}' (overloads or other symbols), including ${where}`);
        }

        if (!project.csharpFiles.includes(file.path)) {
          refuse(`'${name}' is also declared in ${where}, in another project`);
        }

        if (!this.targets.has(file.path)) {
          refuse(`'${name}' is also declared in ${where}, which is not being cleaned`);
        }

        renamed.push({ file, violation });
      }
    }

    return shadows;
  }

  private checkDeclaration(project: WorkspaceProject, sources: readonly SourceFile[], declaration: Renamed): void {
    const symbol = declaration.violation.symbol;
    const node = declarationNode(symbol.nameNode);
    if (!node) {
      refuse('its declaration could not be found');
    }

    if (hasParseErrors(node)) {
      refuse('its declaration could not be fully parsed');
    }

    const modifiers = modifierTexts(node);
    const refusedModifier = REFUSED_MODIFIERS.find((modifier) => modifiers.has(modifier));
    if (refusedModifier) {
      refuse(`it is ${refusedModifier}`);
    }

    for (const container of [node, ...containingTypes(node)]) {
      const attribute = attributeNames(container).find((name) => SERIALIZATION_ATTRIBUTES.has(name));
      if (attribute) {
        refuse(`[${attribute}] makes the name part of a serialized format`);
      }
    }

    if (symbol.category === 'type') {
      if (symbol.name.endsWith('Attribute')) {
        refuse('it is an attribute class, used without the Attribute suffix');
      }
    } else {
      this.checkMember(sources, symbol, node);
    }

    const external = [node, ...containingTypes(node)].every((container) => isExternallyVisible(container));
    if (external && project.packable) {
      refuse('the project builds a NuGet package, whose public API code outside the workspace may use');
    }

    const internalsVisible = project.internalsVisibleTo || project.csharpFiles.some((filePath) => this.file(filePath).text.includes('InternalsVisibleTo'));
    if (!external && internalsVisible) {
      refuse('the assembly exposes its internals (InternalsVisibleTo)');
    }
  }

  private checkMember(sources: readonly SourceFile[], symbol: DeclaredSymbol, node: Node): void {
    const type: TypeInfo | undefined = symbol.type;
    if (!type) {
      refuse('it is not declared in a type');
    }

    if (type.isPartial) {
      refuse('it is declared in a partial type');
    }

    if (type.kind === 'interface') {
      refuse('it is an interface member');
    }

    if (node.namedChildren.some((child) => child.type === 'attribute_list')) {
      refuse('it has attributes, which may depend on its name');
    }

    // A base declared outside the workspace may declare the old or the new name.
    const declared = new Map<string, string[]>();
    for (const source of sources) {
      for (const declaredType of source.types) {
        declared.set(declaredType.name, [...(declared.get(declaredType.name) ?? []), ...declaredType.bases]);
      }
    }

    const pending = baseNames(type.node);
    const seen = new Set<string>();
    while (pending.length > 0) {
      const base = pending.pop() as string;
      if (seen.has(base)) {
        continue;
      }

      seen.add(base);
      const bases = declared.get(base);
      if (!bases) {
        refuse(`${type.name} derives from or implements ${base}, which is declared outside the workspace`);
      }

      pending.push(...bases);
    }
  }

  /** The old name must not appear as text: strings, preprocessor symbols, XAML, Razor, JSON. */
  private checkText(scope: readonly WorkspaceProject[], sources: readonly SourceFile[], name: string): void {
    const pattern = new RegExp(wordPattern(name).source, 'gu');
    for (const file of sources.filter((source) => source.mentions(name))) {
      for (const match of file.text.matchAll(pattern)) {
        if (file.kinds[match.index ?? 0] === STRING) {
          refuse(`the name appears in a string in ${file.path} line ${file.line(match.index ?? 0)}`);
        }
      }

      for (const line of file.text.split('\n')) {
        if (/^\s*#\s*(?:if|elif|define|undef)\b/.test(line) && wordPattern(name).test(line)) {
          refuse(`the name is a preprocessor symbol in ${file.path}`);
        }
      }
    }

    for (const textFile of scope.flatMap((project) => project.textFiles)) {
      let text: string;
      try {
        text = fs.readFileSync(textFile, 'utf8');
      } catch (error) {
        refuse(`${textFile} could not be read (${(error as Error).message})`);
      }

      if (wordPattern(name).test(text)) {
        refuse(`the name appears in ${textFile}`);
      }
    }
  }

  /** The new name must be neither declared nor used as a simple name anywhere in the scope. */
  private checkNewName(sources: readonly SourceFile[], newName: string, oldName: string): void {
    for (const file of sources.filter((source) => source.mentions(newName))) {
      const declaration = file.model.symbols.find((symbol) => symbol.name === newName);
      if (declaration) {
        refuse(`'${newName}' is already declared in ${file.path} line ${file.line(declaration.nameNode.startIndex)}`);
      }

      const use = (file.model.occurrencesByName.get(newName) ?? []).find((occurrence) => occurrence.role.kind === 'reference' || occurrence.role.kind === 'type');
      if (use) {
        refuse(`'${newName}' is already used in ${file.path} line ${file.line(use.start)}`);
      }
    }

    if (newName === oldName) {
      refuse('no compliant name can be derived');
    }
  }

  private collectEdits(
    sources: readonly SourceFile[],
    renamed: readonly Renamed[],
    shadows: ReadonlyMap<SourceFile, readonly DeclaredSymbol[]>,
    oldName: string,
    newName: string
  ): Map<string, TextEdit[]> {
    const isType = renamed[0].violation.symbol.category === 'type';
    const declarations = new Set(renamed.map((declaration) => declaration.violation.symbol.nameNode));
    const edits = new Map<string, TextEdit[]>();
    for (const file of sources.filter((source) => source.mentions(oldName))) {
      const fileShadows = shadows.get(file) ?? [];
      const shadowNames = new Set(fileShadows.map((shadow) => shadow.nameNode));
      const fileEdits: TextEdit[] = [];
      const edit = (occurrence: Occurrence) => {
        const text = file.text.slice(occurrence.start, occurrence.end);
        fileEdits.push({ start: occurrence.start, end: occurrence.end, text: text.startsWith('@') ? `@${newName}` : newName });
      };

      for (const occurrence of file.model.occurrencesByName.get(oldName) ?? []) {
        const where = `${file.path} line ${file.line(occurrence.start)}`;
        if (occurrence.memberRoot && (file.model.opaqueRoots.has(occurrence.memberRoot) || hasParseErrors(occurrence.memberRoot))) {
          refuse(`${where} could not be fully parsed`);
        }

        const role = occurrence.role;
        const shadowed = fileShadows.some((shadow) => shadow.region && spans(shadow.region, occurrence.start, occurrence.end));
        switch (role.kind) {
          case 'declaration':
            if (occurrence.node && declarations.has(occurrence.node)) {
              edit(occurrence);
            } else if (!occurrence.node || !shadowNames.has(occurrence.node)) {
              refuse(`'${oldName}' is declared in ${where} in a way cleanup does not follow`);
            }

            break;
          case 'reference':
            if (!shadowed) {
              edit(occurrence);
            }

            break;
          case 'member':
            edit(occurrence);
            break;
          case 'initializerMember':
            if (isType) {
              refuse(`'${oldName}' is set as a member in ${where}`);
            }

            edit(occurrence);
            break;
          case 'namedArgument':
            // Names a parameter, never the renamed member or type.
            break;
          case 'type':
            if (!isType) {
              refuse(`a type named '${oldName}' is used in ${where}`);
            }

            if (!shadowed) {
              edit(occurrence);
            }

            break;
          case 'skip':
            if (!isType || !this.typeNameInSkippedPosition(occurrence)) {
              refuse(`'${oldName}' is used in ${where} in a way cleanup does not follow`);
            }

            edit(occurrence);
            break;
          default:
            refuse(`'${oldName}' is used in ${where} in a way cleanup does not follow (${role.kind})`);
        }
      }

      fileEdits.push(...crefEdits(file, oldName, newName));
      if (fileEdits.length > 0) {
        edits.set(file.path, fileEdits);
      }
    }

    return edits;
  }

  /** Constructor and destructor names, `A.Name` qualified names, and `using static`/alias directives. */
  private typeNameInSkippedPosition(occurrence: Occurrence): boolean {
    const node = occurrence.node;
    const parent = node?.parent;
    if (!node || !parent) {
      return false;
    }

    if (parent.type === 'constructor_declaration' || parent.type === 'destructor_declaration' || parent.type === 'qualified_name') {
      return !ancestors(node).some((ancestor) => ancestor.type === 'using_directive' && !/\bstatic\b|=/.test(ancestor.text));
    }

    return false;
  }
}

/** Violations the in-file renamer leaves to this one: types and non-private members. */
function isCandidate(violation: NamingViolation): boolean {
  const symbol = violation.symbol;

  return symbol.category === 'type' || (symbol.category === 'member' && symbol.accessibility !== 'private');
}

function lineOf(detail: string): number {
  return Number(/ line (\d+):/.exec(detail)?.[1] ?? 0);
}

function ancestors(node: Node): Node[] {
  const result: Node[] = [];
  for (let current = node.parent; current; current = current.parent) {
    result.push(current);
  }

  return result;
}

function declarationNode(nameNode: Node): Node | undefined {
  return [nameNode, ...ancestors(nameNode)].find((node) => MEMBER_DECLARATIONS.has(node.type) || TYPE_DECLARATIONS.has(node.type));
}

function containingTypes(node: Node): Node[] {
  return ancestors(node).filter((ancestor) => TYPE_DECLARATIONS.has(ancestor.type));
}

function modifierTexts(node: Node): Set<string> {
  return new Set(node.namedChildren.filter((child) => child.type === 'modifier').map((child) => child.text.trim()));
}

function attributeNames(node: Node): string[] {
  return node.namedChildren
    .filter((child) => child.type === 'attribute_list')
    .flatMap((list) => findAll(list, 'attribute'))
    .map((attribute) => {
      const name = attribute.childForFieldName('name')?.text ?? attribute.namedChildren[0]?.text ?? '';
      const simple = name.split('.').pop() ?? name;

      return simple.endsWith('Attribute') ? simple.slice(0, -'Attribute'.length) : simple;
    });
}

/** Declared or default accessibility of a type or member, visible outside the assembly? */
function isExternallyVisible(node: Node): boolean {
  const modifiers = modifierTexts(node);
  if (node.type === 'enum_member_declaration') {
    return true;
  }

  if (modifiers.has('private') || modifiers.has('file')) {
    return false;
  }

  if (modifiers.has('public') || modifiers.has('protected')) {
    return !modifiers.has('private');
  }

  // No modifier: interface members are public, everything else internal or private.
  return !modifiers.has('internal') && node.parent?.parent?.type === 'interface_declaration';
}

/** Simple names of the base types in a type's base list (`List<int>` gives `List`). */
function baseNames(typeNode: Node): string[] {
  const list = typeNode.namedChildren.find((child) => child.type === 'base_list');
  if (!list) {
    return [];
  }

  return list.namedChildren.flatMap((base) => {
    const named = base.type === 'primary_constructor_base_type' ? base.namedChildren[0] : base;
    if (!named) {
      return [];
    }

    const last = named.type === 'qualified_name' ? named.childForFieldName('name') ?? named : named;
    const identifier = last.type === 'generic_name' ? last.namedChildren[0] : last;

    return identifier?.type === 'identifier' ? [identifier.text.replace(/^@/, '')] : [named.text];
  });
}

/** `cref="..."` values of the XML documentation comments naming the old name. */
function crefEdits(file: SourceFile, oldName: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const pattern = new RegExp(wordPattern(oldName).source, 'gu');
  for (const comment of file.model.docComments) {
    for (const match of comment.text.matchAll(/\bcref\s*=\s*"([^"]*)"/g)) {
      const valueStart = comment.startIndex + (match.index ?? 0) + match[0].indexOf('"') + 1;
      for (const name of match[1].matchAll(pattern)) {
        const start = valueStart + (name.index ?? 0);
        edits.push({ start, end: start + name[0].length, text: newName });
      }
    }
  }

  return edits;
}
