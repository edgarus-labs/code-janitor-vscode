import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODE, STRING, classifyCSharp } from '../csharpScanner';
import { loadEditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import {
  describeNamingViolation,
  findNamingViolations,
  isWorkspaceRenameCandidate,
  NamingViolation,
} from '../transformations/editorConfigNaming';
import { hasParseErrors, lineNumberAt } from '../transformations/editorConfigSupport';
import { parseNamingRules } from './namingRules';
import { invalidNewName } from './renamer';
import {
  baseTypeNames,
  buildSourceModel,
  CONTEXTUAL_KEYWORDS,
  DeclaredSymbol,
  describeReceiver,
  identifierName,
  Occurrence,
  Receiver,
  SourceModel,
  spans,
  typeAt,
  TypeInfo,
} from './sourceModel';
import { dependencyClosure, projectOf, referencingClosure, WorkspaceProject } from './workspaceScope';

/**
 * Renames non-private symbols that violate the `.editorconfig` naming rules (IDE1006) in every file
 * that may use them: the files of the declaring project and of the projects referencing it. Like the
 * in-file renamer it is syntactic, so it only renames when every use of the old name is understood:
 * the old name is declared by the renamed symbols alone (or by locals and parameters whose scope is
 * known), neither name is declared by the projects these depend on, the old name does not appear as
 * text (strings, XAML, Razor, JSON), the new name is not used yet, every changed file is UTF-8, and
 * no code outside the workspace can depend on the symbol. Everything else is reported, not renamed.
 */

export interface WorkspaceRenameRequest {
  readonly projects: readonly WorkspaceProject[];
  /** Files whose declarations may be renamed (full paths). */
  readonly targets: readonly string[];
  /** Current text of one of the {@link workspaceRenameInputs}: the open editor's, else the file's on disk. */
  readonly read: (filePath: string) => SourceText;
}

export interface SourceText {
  readonly text: string;
  /** False when the bytes on disk are not UTF-8: `text` is a lossy decoding, and the file is never rewritten. */
  readonly utf8: boolean;
}

export interface SymbolRename {
  readonly oldName: string;
  readonly newName: string;
  /** `field`, `method`, `class`, ... of the first declaration. */
  readonly kind: string;
  /** Every declaration renamed (overloads, members of several types), the first one first. */
  readonly declarations: readonly { readonly filePath: string; readonly line: number }[];
  /** Files the rename changes. */
  readonly files: readonly string[];
}

export interface WorkspaceRenameIssue {
  readonly filePath: string;
  readonly detail: string;
  /** The name of the symbol left in place. */
  readonly symbol: string;
}

export interface WorkspaceRenamePlan {
  readonly renames: readonly SymbolRename[];
  /** Violations left in place, with the reason. */
  readonly issues: readonly WorkspaceRenameIssue[];
  /** New content of every changed file. */
  readonly contents: ReadonlyMap<string, string>;
}

/**
 * The C# files a plan for `targets` may read: the targets, the files of the projects a rename they
 * declare is searched in or depends on, and the files of the projects whose references cannot all be
 * resolved (see {@link WorkspacePlanner.checkUnresolvedReferences}).
 */
export function workspaceRenameInputs(projects: readonly WorkspaceProject[], targets: readonly string[]): string[] {
  const needed = new Set(projects.filter((project) => project.unresolvedReferences.length > 0));
  for (const project of new Set(targets.flatMap((target) => projectOf(projects, target) ?? []))) {
    const scope = referencingClosure(projects, project);
    for (const member of [...scope, ...dependencyClosure(projects, scope)]) {
      needed.add(member);
    }
  }

  return [...new Set([...targets.map((target) => path.resolve(target)), ...[...needed].flatMap((project) => project.csharpFiles)])];
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
  private wordsCache: Set<string> | undefined;
  private declarationsCache: { types: DeclaredType[]; qualifiers: string[] } | undefined;
  readonly bom: boolean;
  readonly text: string;
  readonly utf8: boolean;

  constructor(
    readonly path: string,
    source: SourceText
  ) {
    this.bom = source.text.startsWith('\uFEFF');
    this.text = this.bom ? source.text.slice(1) : source.text;
    this.utf8 = source.utf8;
  }

  /** Whether `name` appears as a whole word ({@link wordPattern}), from the file's words read once. */
  mentions(name: string): boolean {
    if (!/^[\p{L}\p{Nd}_]+$/u.test(name)) {
      return wordPattern(name).test(this.text);
    }

    this.wordsCache ??= new Set(this.text.match(/[\p{L}\p{Nd}_]+/gu));

    return this.wordsCache.has(name);
  }

  get model(): SourceModel {
    return (this.modelCache ??= buildSourceModel(this.text));
  }

  get kinds(): Uint8Array {
    return (this.kindsCache ??= classifyCSharp(this.text));
  }

  line(offset: number): number {
    return lineNumberAt(this.text, offset);
  }

  /**
   * Types the file declares, with the simple names of their base types; and the names that may start a
   * namespace or type qualifier: namespace segments, names and aliases of using directives, type names.
   */
  get declarations(): { types: DeclaredType[]; qualifiers: string[] } {
    if (!this.declarationsCache) {
      const tree = parseCSharp(this.text);
      try {
        const types = findAll(tree.rootNode, [...TYPE_DECLARATIONS]).map((node) => ({
          name: node.childForFieldName('name')?.text.replace(/^@/, '') ?? '',
          kind: node.type,
          bases: baseTypeNames(node),
        }));
        const namespaceNames = findAll(tree.rootNode, ['namespace_declaration', 'file_scoped_namespace_declaration']).flatMap((node) => node.childForFieldName('name') ?? []);
        const qualifiers = [...namespaceNames, ...findAll(tree.rootNode, 'using_directive')]
          .flatMap((node) => findAll(node, 'identifier'))
          .map((identifier) => identifierName(identifier.text));
        this.declarationsCache = { types, qualifiers: [...qualifiers, ...types.map((type) => type.name)] };
      } finally {
        tree.delete();
      }
    }

    return this.declarationsCache;
  }
}

function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{Nd}_])@?${name}(?![\\p{L}\\p{Nd}_])`, 'u');
}

/** A type a file declares: its simple name, declaration node type (`class_declaration`...) and simple base type names. */
interface DeclaredType {
  readonly name: string;
  readonly kind: string;
  readonly bases: readonly string[];
}

/** A declaration that is renamed: the symbol, its file and its naming violation. */
interface Renamed {
  readonly file: SourceFile;
  readonly violation: NamingViolation;
}

/** The projects a rename is searched in (a declaring project and the projects referencing it), read once per plan. */
class Scope {
  private basesCache: Map<string, string[]> | undefined;
  private qualifiersCache: Set<string> | undefined;

  constructor(
    readonly projects: readonly WorkspaceProject[],
    /** Their C# files. */
    readonly sources: readonly SourceFile[],
    /** The C# files of the projects they depend on, outside the scope: their symbols are visible in it. */
    readonly dependencies: readonly SourceFile[]
  ) {}

  /** Base type names of every type declared in the scope, by simple name. */
  get bases(): ReadonlyMap<string, readonly string[]> {
    if (!this.basesCache) {
      this.basesCache = new Map();
      for (const source of this.sources) {
        for (const declaredType of source.declarations.types) {
          this.basesCache.set(declaredType.name, [...(this.basesCache.get(declaredType.name) ?? []), ...declaredType.bases]);
        }
      }
    }

    return this.basesCache;
  }

  /** Names that may start a namespace or type qualifier in the scope (see {@link SourceFile.declarations}). */
  get qualifiers(): ReadonlySet<string> {
    return (this.qualifiersCache ??= new Set(this.sources.flatMap((source) => source.declarations.qualifiers)));
  }
}

/** Members every class, struct and enum inherits: a member taking one of these names hides or changes what calls bind to. */
const OBJECT_MEMBERS = new Set(['Equals', 'GetHashCode', 'GetType', 'ToString', 'MemberwiseClone', 'Finalize', 'ReferenceEquals']);
const ENUM_MEMBERS = new Set(['HasFlag', 'CompareTo', 'GetTypeCode']);
/** Members records generate and `Nullable<T>` declares, which the workspace does not declare. */
const RECORD_MEMBERS = new Set(['Deconstruct', 'PrintMembers', 'EqualityContract']);
const NULLABLE_MEMBERS = new Set(['HasValue', 'Value', 'GetValueOrDefault']);

export function planWorkspaceRenames(request: WorkspaceRenameRequest): WorkspaceRenamePlan {
  return new WorkspacePlanner(request).plan();
}

class WorkspacePlanner {
  private readonly files = new Map<string, SourceFile>();
  private readonly scopes = new Map<string, Scope>();
  private readonly textFiles = new Map<string, string>();
  private readonly internalsVisible = new Map<WorkspaceProject, boolean>();
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
      const candidates = findNamingViolations(file.model, parseNamingRules(props), props).filter(isWorkspaceRenameCandidate);
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
    this.issues.push({ filePath: file.path, detail: describeNamingViolation(violation, reason, OUTCOME), symbol: violation.symbol.name });
  }

  /** The scope made of `projects` (a declaring project and the projects referencing it), built once per plan. */
  private scope(projects: readonly WorkspaceProject[]): Scope {
    const key = projects.map((member) => member.projectFile).join('|');
    let scope = this.scopes.get(key);
    if (!scope) {
      const read = (members: readonly WorkspaceProject[]) => members.flatMap((member) => member.csharpFiles).map((filePath) => this.file(filePath));
      scope = new Scope(projects, read(projects), read(dependencyClosure(this.request.projects, projects)));
      this.scopes.set(key, scope);
    }

    return scope;
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

      // `value` in an accessor, `await` in an async method...: the new name would bind to something else.
      if (CONTEXTUAL_KEYWORDS.has(newName)) {
        refuse(`'${newName}' is a C# contextual keyword`);
      }

      const projects = referencingClosure(this.request.projects, project);
      const problem = projects.find((member) => member.problem)?.problem;
      if (problem) {
        refuse(problem);
      }

      const scope = this.scope(projects);
      this.checkUnresolvedReferences(scope.projects, oldName);

      const shadows = this.collectDeclarations(project, scope.sources, first, renamed);
      for (const declaration of renamed) {
        this.checkDeclaration(project, scope, declaration);
      }

      this.checkDependencies(scope, oldName, `'${oldName}' is also declared`);
      this.checkDependencies(scope, newName, `'${newName}' is already declared`);
      this.checkText(scope, oldName);
      this.checkNewName(scope, renamed, newName, oldName);
      this.checkExtendedTypes(scope, renamed, newName);
      if (this.touchedNames.has(oldName) || this.touchedNames.has(newName)) {
        refuse(`another rename in this cleanup uses '${oldName}' or '${newName}'; run cleanup again`);
      }

      const edits = this.collectEdits(scope, renamed, shadows, oldName, newName);
      const undecodable = [...edits.keys()].find((filePath) => !this.file(filePath).utf8);
      if (undecodable) {
        refuse(`${undecodable} is not UTF-8 text, which the rename cannot rewrite safely`);
      }

      this.touchedNames.add(oldName);
      this.touchedNames.add(newName);
      for (const [filePath, fileEdits] of edits) {
        this.edits.set(filePath, [...(this.edits.get(filePath) ?? []), ...fileEdits]);
      }

      this.renames.push({
        oldName,
        newName,
        kind: first.violation.symbol.kind.replace('_', ' '),
        declarations: renamed.map((declaration) => ({ filePath: declaration.file.path, line: declaration.file.line(declaration.violation.symbol.nameNode.startIndex) })),
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

  /** A project whose references cannot all be resolved may reference the scope: it must not use the name. */
  private checkUnresolvedReferences(scope: readonly WorkspaceProject[], name: string): void {
    for (const project of this.request.projects) {
      if (!scope.includes(project) && project.unresolvedReferences.length > 0 && project.csharpFiles.some((filePath) => this.file(filePath).mentions(name))) {
        refuse(`${project.projectFile} references ${project.unresolvedReferences.join(', ')}, which cleanup cannot resolve, and its files use '${name}'`);
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
      const named = file.model.symbolsByName.get(name) ?? [];
      for (const symbol of named) {
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
          !isWorkspaceRenameCandidate(violation)
        ) {
          const count = named.length + (file === first.file ? 0 : 1);
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

  private checkDeclaration(project: WorkspaceProject, scope: Scope, declaration: Renamed): void {
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
      this.checkMember(scope, symbol, node);
    }

    const external = [node, ...containingTypes(node)].every((container) => isExternallyVisible(container));
    if (external && project.packable) {
      refuse('the project builds a NuGet package, whose public API code outside the workspace may use');
    }

    let internalsVisible = this.internalsVisible.get(project);
    if (internalsVisible === undefined) {
      internalsVisible = project.internalsVisibleTo || project.csharpFiles.some((filePath) => this.file(filePath).text.includes('InternalsVisibleTo'));
      this.internalsVisible.set(project, internalsVisible);
    }

    if (!external && internalsVisible) {
      refuse('the assembly exposes its internals (InternalsVisibleTo)');
    }
  }

  private checkMember(scope: Scope, symbol: DeclaredSymbol, node: Node): void {
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
    const declared = scope.bases;
    const pending = baseTypeNames(type.node);
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

  /**
   * The projects the scope depends on are compiled with it: a type, namespace or non-private member
   * they declare under the name is visible in the scope, where cleanup would not tell it apart.
   */
  private checkDependencies(scope: Scope, name: string, declared: string): void {
    for (const file of scope.dependencies.filter((source) => source.mentions(name))) {
      const symbol = (file.model.symbolsByName.get(name) ?? []).find(
        (candidate) => candidate.category === 'type' || candidate.category === 'namespace' || (candidate.category === 'member' && candidate.accessibility !== 'private')
      );
      if (symbol) {
        refuse(`${declared} in ${file.path} line ${file.line(symbol.nameNode.startIndex)}, in a project the searched projects reference`);
      }
    }
  }

  /** The old name must not appear as text: strings, preprocessor symbols, XAML, Razor, JSON. */
  private checkText(scope: Scope, name: string): void {
    const pattern = new RegExp(wordPattern(name).source, 'gu');
    for (const file of scope.sources.filter((source) => source.mentions(name))) {
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

    for (const textFile of scope.projects.flatMap((project) => project.textFiles)) {
      let text = this.textFiles.get(textFile);
      if (text === undefined) {
        try {
          text = fs.readFileSync(textFile, 'utf8');
        } catch (error) {
          refuse(`${textFile} could not be read (${(error as Error).message})`);
        }

        this.textFiles.set(textFile, text);
      }

      if (wordPattern(name).test(text)) {
        refuse(`the name appears in ${textFile}`);
      }
    }
  }

  /**
   * The new name must be neither declared nor used as a simple name anywhere in the scope. A member
   * may also not take the name of a member every type inherits (`ToString`), nor one already accessed
   * (`o.NewName`) on a receiver that may be of a declaring type: the access would bind to it instead.
   */
  private checkNewName(scope: Scope, renamed: readonly Renamed[], newName: string, oldName: string): void {
    const isType = renamed[0].violation.symbol.category === 'type';
    if (!isType && OBJECT_MEMBERS.has(newName)) {
      refuse(`'${newName}' is a member every type inherits from System.Object`);
    }

    if (!isType && ENUM_MEMBERS.has(newName) && renamed.some((declaration) => declaration.violation.symbol.type?.kind === 'enum')) {
      refuse(`'${newName}' is a member every enum inherits from System.Enum`);
    }

    const context = isType ? undefined : accessContext(scope, renamed);
    for (const file of scope.sources.filter((source) => source.mentions(newName))) {
      const declaration = file.model.symbolsByName.get(newName)?.[0];
      if (declaration) {
        refuse(`'${newName}' is already declared in ${file.path} line ${file.line(declaration.nameNode.startIndex)}`);
      }

      const use = (file.model.occurrencesByName.get(newName) ?? []).find(
        (occurrence) =>
          occurrence.role.kind === 'reference' ||
          occurrence.role.kind === 'type' ||
          (occurrence.role.kind === 'member' && context !== undefined && mayAccessDeclaringType(file.model, occurrence, occurrence.role.receiver, context))
      );
      if (use) {
        refuse(`'${newName}' is already used in ${file.path} line ${file.line(use.start)}`);
      }
    }

    if (newName === oldName) {
      refuse('no compliant name can be derived');
    }
  }

  /**
   * An instance member takes precedence over an extension method: once renamed, `x.NewName()` binds to
   * a member `NewName` of x's type if it has one, and may still compile. Only workspace members are
   * known (`checkNewName` refuses those named `NewName`), so every type such a call may be made on must
   * be declared in the workspace with all its bases: the extended type, the types deriving from it, and
   * no type parameter constrained to one of them (its other constraints may declare the name). Enums,
   * records and nullable values also inherit or generate members the workspace does not declare.
   */
  private checkExtendedTypes(scope: Scope, renamed: readonly Renamed[], newName: string): void {
    const methods = renamed.map((declaration) => declarationNode(declaration.violation.symbol.nameNode));
    if (!methods.every(isExtensionMethod)) {
      return;
    }

    const files = [...scope.sources, ...scope.dependencies];
    const types = new Map<string, DeclaredType[]>();
    for (const declaredType of files.flatMap((file) => file.declarations.types)) {
      types.set(declaredType.name, [...(types.get(declaredType.name) ?? []), declaredType]);
    }

    // The extended types, then every workspace type deriving from one of them.
    const extended = new Set<string>();
    for (const method of methods) {
      let type = method?.namedChildren.find((child) => child.type === 'parameter_list')?.namedChildren[0]?.childForFieldName('type') ?? null;
      if (type?.type === 'nullable_type') {
        if (NULLABLE_MEMBERS.has(newName)) {
          refuse(`'${newName}' is a member of System.Nullable<T>`);
        }

        type = type.namedChildren[0] ?? null;
      }

      const name = typeName(type);
      if (name === undefined) {
        refuse(`it extends ${type?.text ?? 'a type'}, which cannot be resolved syntactically`);
      }

      if (!types.has(name)) {
        refuse(`it extends ${name}, which is declared outside the workspace`);
      }

      extended.add(name);
    }

    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, declared] of types) {
        if (!extended.has(name) && declared.some((declaredType) => declaredType.bases.some((base) => extended.has(base)))) {
          extended.add(name);
          grew = true;
        }
      }
    }

    const seen = new Set<string>();
    const pending = [...extended];
    while (pending.length > 0) {
      const name = pending.pop() as string;
      if (seen.has(name)) {
        continue;
      }

      seen.add(name);
      for (const declaredType of types.get(name) ?? []) {
        if (declaredType.kind === 'delegate_declaration') {
          refuse(`calls may be made on ${name}, a delegate type`);
        }

        if (declaredType.kind === 'enum_declaration' && ENUM_MEMBERS.has(newName)) {
          refuse(`'${newName}' is a member every enum inherits from System.Enum`);
        }

        if (declaredType.kind === 'record_declaration' && RECORD_MEMBERS.has(newName)) {
          refuse(`'${newName}' is a member records generate`);
        }

        for (const base of declaredType.bases) {
          if (!types.has(base)) {
            refuse(`${name} derives from or implements ${base}, which is declared outside the workspace`);
          }

          pending.push(base);
        }
      }
    }

    for (const file of files.filter((source) => source.mentions('where'))) {
      for (const clause of file.text.matchAll(/(?<![\p{L}\p{Nd}_])where\s+@?[\p{L}_][\p{L}\p{Nd}_]*\s*:([^{;]*)/gu)) {
        const constraint = [...extended].find((name) => wordPattern(name).test(clause[1]));
        if (constraint !== undefined) {
          refuse(`a type parameter constrained to ${constraint} in ${file.path} line ${file.line(clause.index ?? 0)} may have other members named '${newName}'`);
        }
      }
    }
  }

  private collectEdits(
    scope: Scope,
    renamed: readonly Renamed[],
    shadows: ReadonlyMap<SourceFile, readonly DeclaredSymbol[]>,
    oldName: string,
    newName: string
  ): Map<string, TextEdit[]> {
    const isType = renamed[0].violation.symbol.category === 'type';
    const declarations = new Set(renamed.map((declaration) => declaration.violation.symbol.nameNode));
    const context = accessContext(scope, renamed);
    const edits = new Map<string, TextEdit[]>();
    for (const file of scope.sources.filter((source) => source.mentions(oldName))) {
      const fileShadows = shadows.get(file) ?? [];
      const shadowNames = new Set(fileShadows.map((shadow) => shadow.nameNode));
      const fileEdits: TextEdit[] = [];
      const edit = (occurrence: Occurrence) => {
        const text = file.text.slice(occurrence.start, occurrence.end);
        fileEdits.push({ start: occurrence.start, end: occurrence.end, text: text.startsWith('@') ? `@${newName}` : newName });
      };

      // A mention in code the parser could not structure has no occurrence: it would be left stale.
      const occurrences = file.model.occurrencesByName.get(oldName) ?? [];
      const starts = new Set(occurrences.map((occurrence) => occurrence.start));
      for (const match of file.text.matchAll(new RegExp(wordPattern(oldName).source, 'gu'))) {
        const start = match.index ?? 0;
        const lineStart = file.text.lastIndexOf('\n', start) + 1;
        // Preprocessor lines (`#region` text and the like) are not code; `checkText` refuses `#if` symbols.
        if (file.kinds[start] === CODE && !starts.has(start) && !/^\s*#/.test(file.text.slice(lineStart, start))) {
          refuse(`${file.path} line ${file.line(start)} could not be fully parsed`);
        }
      }


      for (const occurrence of occurrences) {
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
            checkMemberAccess(file.model, occurrence, role.receiver, context, `'${oldName}' is accessed in ${where}`);
            edit(occurrence);
            break;
          case 'initializerMember':
            if (!role.creation) {
              refuse(`'${oldName}' is set in ${where} in a nested object initializer`);
            }

            // The property of an anonymous type keeps its name, whatever the renamed symbol.
            if (role.creation.type === 'anonymous_object_creation_expression') {
              break;
            }

            if (isType) {
              refuse(`'${oldName}' is set as a member in ${where}`);
            }

            if (role.creation.type === 'with_expression') {
              // `value with { Name = ... }` sets a member of the value's type, like `value.Name`.
              const receiver = role.creation.namedChildren[0];
              if (!receiver) {
                refuse(`'${oldName}' is set in ${where} by a 'with' expression cleanup does not follow`);
              }

              checkMemberAccess(file.model, occurrence, describeReceiver(receiver), { ...context, extension: false }, `'${oldName}' is set in ${where} by a 'with' expression`);
              edit(occurrence);
              break;
            }

            if (role.creation.type !== 'object_creation_expression') {
              refuse(`'${oldName}' is set in ${where} in a target-typed object initializer`);
            }

            if (!context.declaringTypes?.has(typeName(role.creation.childForFieldName('type')) ?? '')) {
              refuse(`'${oldName}' is set in ${where} in an initializer of a type that does not declare it`);
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

      fileEdits.push(...crefEdits(file, oldName, newName, context.declaringTypes));
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

/** What a member access must be checked against, for the symbols renamed together. */
interface AccessContext {
  /** Members: the types declaring them; types: `undefined`. */
  readonly declaringTypes: ReadonlySet<string> | undefined;
  /** Names that may start a namespace or type qualifier in the scope (see {@link SourceFile.declarations}). */
  readonly qualifiers: ReadonlySet<string>;
  /** Base type names of every type declared in the scope, by simple name. */
  readonly bases: ReadonlyMap<string, readonly string[]>;
  /** Every renamed symbol is an extension method. */
  readonly extension: boolean;
  /** Names declared in the scope with a type mentioning `dynamic` (see {@link dynamicNames}). */
  readonly dynamicNames: ReadonlySet<string>;
}

/** The access context of the symbols `renamed` together, in `scope`. */
function accessContext(scope: Scope, renamed: readonly Renamed[]): AccessContext {
  const isType = renamed[0].violation.symbol.category === 'type';
  const extension = !isType && renamed.every((declaration) => isExtensionMethod(declarationNode(declaration.violation.symbol.nameNode)));

  return {
    // Members: the types declaring them. A member access or initializer naming another type is not ours.
    declaringTypes: isType ? undefined : new Set(renamed.flatMap((declaration) => declaration.violation.symbol.type?.name ?? [])),
    qualifiers: scope.qualifiers,
    bases: scope.bases,
    extension,
    dynamicNames: extension ? dynamicNames(scope.sources) : new Set(),
  };
}

/**
 * Names declared with a type mentioning `dynamic` in `sources` (fields, properties, methods, parameters,
 * locals, pattern variables: `dynamic x`, `dynamic[] x`, `List<dynamic> x`), read from the text.
 */
function dynamicNames(sources: readonly SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources.filter((candidate) => candidate.mentions('dynamic'))) {
    for (const match of source.text.matchAll(/(?<![\p{L}\p{Nd}_])dynamic(?![\p{L}\p{Nd}_])[\s?[\],<>]*@?([\p{L}_][\p{L}\p{Nd}_]*)/gu)) {
      names.add(match[1]);
    }
  }

  return names;
}

/** A static method of a static class whose first parameter has the `this` modifier. */
function isExtensionMethod(node: Node | undefined): boolean {
  const firstParameter = node?.namedChildren.find((child) => child.type === 'parameter_list')?.namedChildren[0];
  const type = node?.parent?.parent;

  return (
    node?.type === 'method_declaration' &&
    modifierTexts(node).has('static') &&
    type?.type === 'class_declaration' &&
    modifierTexts(type).has('static') &&
    firstParameter?.type === 'parameter' &&
    /^(?:\[[^\]]*\]\s*)*(?:(?:ref|in|scoped|readonly)\s+)*this\b/.test(firstParameter.text)
  );
}

/**
 * Refuses unless `receiver.Name` names the renamed symbol. Extension methods: any receiver but `base`
 * and a dynamic one (whose calls bind at run time to the object's own members); `checkExtendedTypes`
 * refuses the renames where an instance member named like the new name could capture such a call.
 * Other members: a receiver typed with, or naming, a type declaring it. Types: a namespace or type
 * qualifier, not a value.
 */
function checkMemberAccess(model: SourceModel, occurrence: Occurrence, receiver: Receiver, context: AccessContext, access: string): void {
  const { declaringTypes } = context;
  const declares = (name: string | undefined) => declaringTypes !== undefined && name !== undefined && declaringTypes.has(name);
  if (context.extension && receiver.kind !== 'base') {
    if (mayBeDynamic(model, occurrence, context.dynamicNames)) {
      refuse(`${access} through a dynamic receiver`);
    }

    return;
  }

  switch (receiver.kind) {
    case 'this': {
      const type = typeAt(model, occurrence.start);
      if (!type || !derivesFrom(type.name, baseTypeNames(type.node), context.bases, declares)) {
        refuse(`${access} through this in a type that does not declare or inherit it`);
      }

      return;
    }
    case 'base':
      refuse(`${access} through base, whose members are not followed`);
    case 'conditional':
      refuse(`${access} through a conditional access whose target cannot be resolved`);
    case 'expression': {
      let resolved: boolean;
      const receiverNode = receiverOf(occurrence);
      if (receiver.name !== undefined) {
        const value = valueDeclaration(model, occurrence, receiver.name);
        // Not a value in scope: a type (static access) or a namespace qualifier.
        resolved = value ? declares(declaredTypeName(value)) : declaringTypes === undefined ? context.qualifiers.has(receiver.name) : declares(receiver.name);
      } else if (receiverNode?.type === 'member_access_expression' && receiverNode.childForFieldName('expression')?.type === 'this_expression') {
        // `this.field.Name`: the field's declared type, in the innermost type.
        const type = typeAt(model, occurrence.start);
        const field = (receiver.qualifiedName !== undefined ? model.symbolsByName.get(receiver.qualifiedName) ?? [] : []).find((symbol) => symbol.category === 'member' && symbol.type === type);
        resolved = field !== undefined && declares(declaredTypeName(field));
      } else if (receiver.qualifiedName !== undefined) {
        // `A.B.Name`: only a namespace or type chain names a type, or a type declaring the member.
        resolved = hasQualifierRoot(model, occurrence, context.qualifiers) && (declaringTypes === undefined || declares(receiver.qualifiedName));
      } else {
        let expression = receiverNode;
        while (expression?.type === 'parenthesized_expression') {
          expression = expression.namedChildren[0] ?? null;
        }

        resolved = expression?.type === 'object_creation_expression' && declares(typeName(expression.childForFieldName('type')));
      }

      if (!resolved) {
        refuse(`${access} through an expression whose type cannot be resolved syntactically`);
      }
    }
  }
}

/**
 * Whether `receiver.Name` may be a member access on a value or type of a declaring type (or one
 * deriving from it), so that a member renamed to `Name` would capture it. Only a receiver of a known
 * other type, or a namespace or type qualifier naming another type, may not.
 */
function mayAccessDeclaringType(model: SourceModel, occurrence: Occurrence, receiver: Receiver, context: AccessContext): boolean {
  const declares = (name: string) => context.declaringTypes?.has(name) ?? false;
  const derives = (name: string | undefined) => name === undefined || derivesFrom(name, context.bases.get(name) ?? [], context.bases, declares);
  if (context.extension) {
    return true;
  }

  switch (receiver.kind) {
    case 'this': {
      const type = typeAt(model, occurrence.start);

      return !type || derivesFrom(type.name, baseTypeNames(type.node), context.bases, declares);
    }
    case 'base':
    case 'conditional':
      return true;
    case 'expression': {
      if (receiver.name !== undefined) {
        const value = valueDeclaration(model, occurrence, receiver.name);

        return derives(value ? declaredTypeName(value) : receiver.name);
      }

      let expression = receiverOf(occurrence);
      while (expression?.type === 'parenthesized_expression') {
        expression = expression.namedChildren[0] ?? null;
      }

      if (expression?.type === 'object_creation_expression') {
        return derives(typeName(expression.childForFieldName('type')));
      }

      return receiver.qualifiedName === undefined || !hasQualifierRoot(model, occurrence, context.qualifiers) || derives(receiver.qualifiedName);
    }
  }
}

/** Whether `type` (with base names `bases`) is, or derives from, a type `declares` accepts, through the types declared in the scope. */
function derivesFrom(type: string, bases: readonly string[], declared: ReadonlyMap<string, readonly string[]>, declares: (name: string) => boolean): boolean {
  const pending = [type, ...bases];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (declares(name)) {
      return true;
    }

    if (!seen.has(name)) {
      seen.add(name);
      pending.push(...(name === type ? [] : declared.get(name) ?? []));
    }
  }

  return false;
}

/** The receiver expression of the member access (or conditional access) at `occurrence`. */
function receiverOf(occurrence: Occurrence): Node | null {
  const name = occurrence.node?.parent?.type === 'generic_name' ? occurrence.node.parent : occurrence.node;

  return name?.parent?.childForFieldName('expression') ?? null;
}

/**
 * Whether the receiver at `occurrence` may be `dynamic`: it mentions `dynamic` (a cast), or one of its
 * names is declared with a dynamic type in the scope, or is a `var` local initialized from such an
 * expression. Without a receiver node (an interpolation hole), it may.
 */
function mayBeDynamic(model: SourceModel, occurrence: Occurrence, dynamic: ReadonlySet<string>): boolean {
  const receiver = receiverOf(occurrence);
  if (!receiver) {
    return true;
  }

  const pending = [receiver];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const expression = pending.pop() as Node;
    if (/(?<![\p{L}\p{Nd}_])dynamic(?![\p{L}\p{Nd}_])/u.test(expression.text)) {
      return true;
    }

    for (const identifier of findAll(expression, 'identifier')) {
      const name = identifierName(identifier.text);
      if (dynamic.has(name)) {
        return true;
      }

      if (seen.has(name)) {
        continue;
      }

      seen.add(name);
      const value = valueDeclaration(model, occurrence, name);
      const declarator = value?.nameNode.parent;
      if (value?.declaredType?.trim() === 'var' && declarator) {
        // `var x = initializer`, or `foreach (var x in collection)`: the collection follows the declaration.
        const statement = declarator.parent?.parent;
        const initializer =
          declarator.namedChildren.find((child) => child.type === 'equals_value_clause') ??
          (statement?.type === 'for_each_statement' ? statement.namedChildren[statement.namedChildren.findIndex((child) => child.type === 'variable_declaration') + 1] : undefined);
        if (!initializer) {
          return true;
        }

        pending.push(initializer);
      }
    }
  }

  return false;
}

/**
 * Whether the qualified receiver of a member access at `occurrence` starts from a namespace or type:
 * `global::`, a predefined or generic type, or a name the scope declares or imports as a namespace,
 * alias or type and that no local, parameter or member in scope shadows. Without a syntax node (an
 * interpolation hole, whose names `checkText` refuses anyway), it does not.
 */
function hasQualifierRoot(model: SourceModel, occurrence: Occurrence, qualifiers: ReadonlySet<string>): boolean {
  let root = receiverOf(occurrence) ?? (occurrence.node?.parent?.type === 'generic_name' ? occurrence.node.parent : occurrence.node)?.parent?.childForFieldName('qualifier') ?? null;
  while (root?.type === 'member_access_expression' || root?.type === 'qualified_name') {
    root = root.childForFieldName(root.type === 'member_access_expression' ? 'expression' : 'qualifier');
  }

  switch (root?.type) {
    case 'alias_qualified_name':
    case 'predefined_type':
    case 'generic_name':
      return true;
    case 'identifier': {
      const name = identifierName(root.text);

      return qualifiers.has(name) && valueDeclaration(model, occurrence, name) === undefined;
    }
    default:
      return false;
  }
}

/** The local, parameter or member of an enclosing type of the file that `name` designates at `occurrence`. */
function valueDeclaration(model: SourceModel, occurrence: Occurrence, name: string): DeclaredSymbol | undefined {
  const named = model.symbolsByName.get(name) ?? [];
  const local = named
    .filter(
      (symbol) =>
        (symbol.category === 'local' || symbol.category === 'parameter' || symbol.category === 'range') &&
        symbol.region &&
        spans(symbol.region, occurrence.start, occurrence.end)
    )
    .sort((a, b) => (b.region?.startIndex ?? 0) - (a.region?.startIndex ?? 0))[0];
  if (local) {
    return local;
  }

  for (let type = typeAt(model, occurrence.start); type; type = type.parent) {
    const member = named.find((symbol) => symbol.category === 'member' && symbol.type === type);
    if (member) {
      return member;
    }
  }

  return undefined;
}

/** Simple name of a value's declared type, without type arguments (`Ns.Box<Ns.Item>?` gives `Box`); for `var x = new T(...)`, `T`. */
function declaredTypeName(symbol: DeclaredSymbol): string | undefined {
  let declared = symbol.declaredType?.trim().replace(/\?$/, '').trim();
  if (declared === 'var') {
    const value = symbol.nameNode.parent?.namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0];

    return value?.type === 'object_creation_expression' ? typeName(value.childForFieldName('type')) : undefined;
  }

  // Innermost type argument lists first, so nested ones (`Box<List<int>>`) go too.
  while (declared !== undefined && /<[^<>]*>/.test(declared)) {
    declared = declared.replace(/<[^<>]*>/g, '');
  }

  return declared?.split(/\s*(?:\.|::)\s*/).pop();
}

/** Name of a (possibly generic or qualified) type syntax, without type arguments. */
function typeName(node: Node | null): string | undefined {
  switch (node?.type) {
    case 'identifier':
      return identifierName(node.text);
    case 'generic_name':
      return typeName(node.namedChildren[0] ?? null);
    case 'qualified_name':
      return typeName(node.childForFieldName('name'));
    default:
      return undefined;
  }
}

/**
 * The `cref` values of the XML documentation comments naming the renamed symbol, in either quote
 * style. A type: every segment naming it. A member (`declaringTypes` given): the member segment, when
 * unqualified or qualified by a type declaring it.
 */
function crefEdits(file: SourceFile, oldName: string, newName: string, declaringTypes: ReadonlySet<string> | undefined): TextEdit[] {
  const edits: TextEdit[] = [];
  const word = new RegExp(wordPattern(oldName).source, 'gu');
  // An optional `X:` documentation ID prefix and `global::` (or alias) qualifier, then the dotted qualifier.
  const member = new RegExp(`^((?:[A-Z]:)?(?:[\\p{L}_][\\p{L}\\p{N}_]*::)?)((?:[\\p{L}_][\\p{L}\\p{N}_]*(?:\\{[^}]*\\})?\\.)*)@?${oldName}(?![\\p{L}\\p{N}_])`, 'u');
  for (const comment of file.model.docComments) {
    for (const match of comment.text.matchAll(/\bcref\s*=\s*(["'])(.*?)\1/g)) {
      const valueStart = comment.startIndex + (match.index ?? 0) + match[0].indexOf(match[1]) + 1;
      const value = match[2];
      if (!declaringTypes) {
        for (const name of value.matchAll(word)) {
          const start = valueStart + (name.index ?? 0);
          edits.push({ start, end: start + name[0].length, text: newName });
        }

        continue;
      }

      const head = member.exec(value);
      const qualifier = head?.[2].slice(0, -1).split('.').pop()?.replace(/\{.*$/, '');
      if (head && (qualifier === undefined || qualifier === '' || declaringTypes.has(qualifier))) {
        const start = valueStart + head[1].length + head[2].length;
        edits.push({ start, end: valueStart + head[0].length, text: newName });
      }
    }
  }

  return edits;
}
