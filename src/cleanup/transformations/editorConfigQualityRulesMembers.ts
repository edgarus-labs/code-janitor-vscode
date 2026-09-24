import { CONTEXTUAL_KEYWORDS, Occurrence, SourceModel, TypeInfo, buildSourceModel, identifierName, spans, typeAt } from '../naming/sourceModel';
import { Node, TextEdit, applyEdits, walk } from '../parser';
import { lex } from '../syntax/lexer';
import type { RuleContext } from './editorConfigCodeStyle';
import { hasParseErrors, lineNumberAt, parseErrorCount } from './editorConfigSupport';
import { ProjectFacts, loadProjectFacts } from './editorConfigQualityRulesProject';
import {
  DeclaredTypes,
  Suppressions,
  Visibility,
  addModifierEdit,
  attributeSimpleName,
  attributesOf,
  declaredVisibility,
  describeDiagnostic,
  hasBrokenMemberDeclarations,
  hasModifier,
  isOnObsoleteChain,
  isRecordStruct,
  isRuleActive,
  readCodeQualityOption,
  removeDeclarationEdit,
  resultantVisibility,
} from './editorConfigQualityRulesSupport';

/**
 * CA1822 (mark members as static), IDE0051 (remove unused private members) and IDE0052 (unread
 * private members). Each works from the syntax of the file (and, for non-private members, the
 * other files of the project), rewrites only what it can prove, and reports the rest.
 */

/** Rewrites that enable further ones (a member becoming static, a removed caller) are repeated this often at most. */
const MAX_ROUNDS = 10;

/**
 * Runs `once` until it changes nothing, so that every consequence of a fix is applied in one
 * cleanup; the reports of the last round (describing the final code) are kept. A round whose
 * result parses worse than its input is discarded.
 */
function untilStable(
  source: string,
  context: RuleContext,
  diagnosticId: string,
  once: (source: string, issues: string[]) => string
): string {
  let current = source;
  for (let round = 0; ; round++) {
    const issues: string[] = [];
    const updated = once(current, issues);
    if (updated !== current && parseErrorCount(updated) > parseErrorCount(current)) {
      context.report(`${diagnosticId}: changes discarded, the rewritten code could not be verified.`);
      return current;
    }

    if (updated === current || round === MAX_ROUNDS - 1) {
      issues.forEach((issue) => context.report(issue));
      return updated;
    }

    current = updated;
  }
}

// ---------------------------------------------------------------------------------------------
// CA1822 Mark members as static
// ---------------------------------------------------------------------------------------------

/** Instance members every class and struct has (`System.Object`). */
const OBJECT_INSTANCE_MEMBERS = ['ToString', 'GetHashCode', 'Equals', 'GetType', 'MemberwiseClone', 'Finalize'];

/** Members the compiler adds to records. */
const RECORD_INSTANCE_MEMBERS = ['EqualityContract', 'PrintMembers', 'Deconstruct'];

/** Test framework attributes (MSTest, xUnit, NUnit) whose methods CA1822 skips. */
const TEST_ATTRIBUTES: Record<string, true> = {
  TestInitialize: true,
  TestMethod: true,
  DataTestMethod: true,
  TestCleanup: true,
  Fact: true,
  Theory: true,
  SetUp: true,
  OneTimeSetUp: true,
  OneTimeTearDown: true,
  Test: true,
  TestCase: true,
  TestCaseSource: true,
  TearDown: true,
};

/** Attributes that do not tie a member to an instance. */
const NEUTRAL_ATTRIBUTES: Record<string, true> = {
  MethodImpl: true,
  DebuggerStepThrough: true,
  DebuggerHidden: true,
  DebuggerNonUserCode: true,
  ExcludeFromCodeCoverage: true,
  Pure: true,
  SuppressMessage: true,
  Conditional: true,
};

/** Interfaces of the .NET libraries: a type implementing only interfaces inherits no instance members. */
const WELL_KNOWN_INTERFACES: Record<string, true> = {
  IDisposable: true,
  IAsyncDisposable: true,
  IEquatable: true,
  IComparable: true,
  IComparer: true,
  IEqualityComparer: true,
  IEnumerable: true,
  IEnumerator: true,
  IAsyncEnumerable: true,
  IAsyncEnumerator: true,
  ICollection: true,
  IList: true,
  IDictionary: true,
  ISet: true,
  IReadOnlyCollection: true,
  IReadOnlyList: true,
  IReadOnlyDictionary: true,
  IReadOnlySet: true,
  IFormattable: true,
  ICloneable: true,
  IConvertible: true,
  IObservable: true,
  IObserver: true,
  IProgress: true,
  IServiceProvider: true,
  INotifyPropertyChanged: true,
  INotifyPropertyChanging: true,
  ISerializable: true,
  IStructuralEquatable: true,
  IStructuralComparable: true,
};

/** Members of the interfaces above, which a public member of a type implementing them may implement. */
const WELL_KNOWN_INTERFACE_MEMBERS: Record<string, true> = {
  Dispose: true,
  DisposeAsync: true,
  Equals: true,
  GetHashCode: true,
  CompareTo: true,
  Compare: true,
  GetEnumerator: true,
  GetAsyncEnumerator: true,
  MoveNext: true,
  MoveNextAsync: true,
  Reset: true,
  Current: true,
  Count: true,
  IsReadOnly: true,
  Add: true,
  Clear: true,
  Contains: true,
  CopyTo: true,
  Remove: true,
  IndexOf: true,
  Insert: true,
  RemoveAt: true,
  Keys: true,
  Values: true,
  ContainsKey: true,
  TryGetValue: true,
  ToString: true,
  Clone: true,
  GetService: true,
  OnNext: true,
  OnError: true,
  OnCompleted: true,
  Subscribe: true,
  Report: true,
  GetObjectData: true,
  GetTypeCode: true,
  IsSubsetOf: true,
  IsSupersetOf: true,
  Overlaps: true,
  SetEquals: true,
};

/** Static classes of the .NET libraries commonly used as a receiver (`Console.WriteLine`). */
const WELL_KNOWN_STATIC_TYPES: Record<string, true> = {
  Array: true,
  ArgumentException: true,
  ArgumentNullException: true,
  ArgumentOutOfRangeException: true,
  BitConverter: true,
  Buffer: true,
  Console: true,
  Convert: true,
  DateTime: true,
  DateTimeOffset: true,
  Debug: true,
  Directory: true,
  Encoding: true,
  Enum: true,
  Enumerable: true,
  Environment: true,
  File: true,
  GC: true,
  Guid: true,
  HashCode: true,
  Interlocked: true,
  Math: true,
  MathF: true,
  Nullable: true,
  ObjectDisposedException: true,
  Path: true,
  Regex: true,
  String: true,
  StringComparer: true,
  StringComparison: true,
  Task: true,
  Thread: true,
  TimeSpan: true,
  Trace: true,
  Tuple: true,
  ValueTuple: true,
  Volatile: true,
};

interface ApiSurface {
  readonly all: boolean;
  readonly groups: ReadonlySet<Visibility>;
}

/** `dotnet_code_quality.api_surface` for CA1822, whose default is every API. */
function apiSurface(context: RuleContext): ApiSurface {
  const value = readCodeQualityOption(context.props, 'CA1822', 'api_surface');
  const groups = new Set<Visibility>();
  let all = value === undefined;
  for (const part of value?.split(',').map((item) => item.trim()) ?? []) {
    if (part === 'all') {
      all = true;
    } else if (part === 'public' || part === 'private') {
      groups.add(part);
    } else if (part === 'internal' || part === 'friend') {
      groups.add('internal');
    }
  }

  return { all: all || groups.size === 0, groups };
}

export function applyMarkMembersAsStatic(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1822', source)) {
    return source;
  }

  const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
  const surface = apiSurface(context);

  return untilStable(source, context, 'CA1822', (current, issues) => new StaticMembers(current, context, project, surface, issues).apply());
}

type Analysis =
  /** The member uses the instance: not a violation. */
  | { readonly kind: 'instance' }
  /** Not a violation Roslyn reports (or suppressed). */
  | { readonly kind: 'skip' }
  | { readonly kind: 'report'; readonly reason: string }
  | { readonly kind: 'fix'; readonly edits: readonly TextEdit[] };

const INSTANCE: Analysis = { kind: 'instance' };
const SKIP: Analysis = { kind: 'skip' };
const report = (reason: string): Analysis => ({ kind: 'report', reason });

class StaticMembers {
  private readonly model: SourceModel;
  private readonly types: DeclaredTypes;
  private readonly suppressions: Suppressions;
  private readonly occurrences: Occurrence[];
  private readonly interfaceMemberNames: ReadonlySet<string>;

  constructor(
    private readonly source: string,
    private readonly context: RuleContext,
    private readonly project: ProjectFacts | undefined,
    private readonly surface: ApiSurface,
    private readonly issues: string[]
  ) {
    this.model = buildSourceModel(source);
    this.types = new DeclaredTypes(this.model, project?.others.typeNames);
    this.suppressions = new Suppressions(source);
    this.occurrences = [...this.model.occurrencesByName.values()].flat();
    const interfaces = this.model.symbols.filter((symbol) => symbol.category === 'member' && symbol.type?.kind === 'interface');
    this.interfaceMemberNames = new Set([...interfaces.map((symbol) => symbol.name), ...(project?.others.interfaceMemberNames ?? [])]);
  }

  apply(): string {
    const edits: TextEdit[] = [];
    for (const type of this.model.types) {
      if (type.node.type === 'interface_declaration' || type.node.type === 'enum_declaration') {
        continue;
      }

      for (const member of type.node.childForFieldName('body')?.namedChildren ?? []) {
        if (member.type !== 'method_declaration' && member.type !== 'property_declaration') {
          continue;
        }

        const analysis = this.analyze(type, member);
        const name = member.childForFieldName('name')?.text ?? '';
        if (analysis.kind === 'report') {
          this.issues.push(
            describeDiagnostic('CA1822', this.source, member.startIndex, `'${name}' does not use instance data and could be static, but ${analysis.reason}; it was left unchanged.`)
          );
        } else if (analysis.kind === 'fix') {
          edits.push(...analysis.edits);
        }
      }
    }

    return applyEdits(this.source, edits);
  }

  private analyze(type: TypeInfo, member: Node): Analysis {
    const nameNode = member.childForFieldName('name');
    if (!nameNode || !this.isCandidate(type, member)) {
      return SKIP;
    }

    const name = identifierName(nameNode.text);
    const use = this.instanceUse(type, member, name);
    if (use === INSTANCE) {
      return INSTANCE;
    }

    const references = this.references(type, member, name);
    if (references === SKIP) {
      return SKIP;
    }

    // A public member of a type with a base list may implicitly implement an interface member,
    // which Roslyn does not analyze.
    const baseList = type.node.namedChildren.find((child) => child.type === 'base_list');
    let unknownBases: string[] = [];
    if (baseList && hasModifier(member, 'public')) {
      if (this.interfaceMemberNames.has(name) || WELL_KNOWN_INTERFACE_MEMBERS[name] === true) {
        return SKIP;
      }

      unknownBases = baseList.namedChildren
        .filter((base) => base.type !== 'argument_list')
        .map((base) => base.text.replace(/<.*$/s, '').split('.').pop()?.trim() ?? '')
        .filter((base) => !this.types.declaresType(base) && WELL_KNOWN_INTERFACES[base] !== true);
    }

    // From here on the member is a violation Roslyn reports; anything unproven is reported.
    if (type.isPartial) {
      return report(`${type.name} is partial and its other parts were not analyzed`);
    }

    // A non-private member of a nested type is also reachable from the other parts of a partial containing type.
    let partialOuter = type.parent;
    while (partialOuter && !partialOuter.isPartial) {
      partialOuter = partialOuter.parent;
    }

    if (partialOuter && declaredVisibility(member) !== 'private') {
      return report(`it is reachable from the other parts of the partial type ${partialOuter.name}, which were not analyzed`);
    }

    if (this.model.opaqueRoots.has(member) || hasParseErrors(member)) {
      return report('the cleanup parser could not fully analyze it');
    }

    if (hasBrokenMemberDeclarations(type.node)) {
      return report(`the cleanup parser could not read every member declaration of ${type.name}`);
    }

    if (unknownBases.length > 0) {
      return report(`it is public and may implement a member of ${unknownBases.join(', ')}`);
    }

    if (use?.kind === 'report') {
      return use;
    }

    const attribute = attributesOf(member).find((node) => NEUTRAL_ATTRIBUTES[attributeSimpleName(node)] !== true);
    if (attribute) {
      return report(`it has the attribute [${attribute.text}], which may need an instance member`);
    }

    if (hasModifier(member, 'readonly')) {
      return report('it is readonly, which a static member cannot be');
    }

    const setter = member.childForFieldName('accessors')?.namedChildren.find((accessor) => /^(?:set|init)\b/.test(accessorKeyword(accessor)));
    if (setter) {
      return report(`it has a ${accessorKeyword(setter)} accessor, which object initializers or with-expressions may use`);
    }

    if (references.kind === 'report') {
      return references;
    }

    const visibility = this.visibilityBlocker(member, name);
    if (visibility) {
      return visibility;
    }

    const first = member.children.find((child) => child.type !== 'attribute_list' && child.type !== 'modifier' && child.type !== 'comment');
    if (!first || references.kind !== 'fix') {
      return SKIP;
    }

    return { kind: 'fix', edits: [addModifierEdit(this.context.props, member, 'static', first), ...references.edits] };
  }

  /** The members CA1822 analyzes (Roslyn's `ShouldAnalyze`), minus those suppressed or outside `api_surface`. */
  private isCandidate(type: TypeInfo, member: Node): boolean {
    const modifiers = ['static', 'abstract', 'virtual', 'override', 'extern', 'partial'];
    if (modifiers.some((modifier) => hasModifier(member, modifier)) || member.namedChildren.some((child) => child.type === 'explicit_interface_specifier')) {
      return false;
    }

    const name = member.childForFieldName('name')?.text ?? '';
    if (member.type === 'method_declaration') {
      const body = member.childForFieldName('body');
      const parameters = member.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
      const eventHandler =
        parameters.length === 2 &&
        /^object\??$/.test(parameters[0].childForFieldName('type')?.text ?? '') &&
        /EventArgs\??$/.test(parameters[1].childForFieldName('type')?.text ?? '');
      if (!body || isNotImplemented(body) || eventHandler || name === 'GetAwaiter' || name === 'GetResult') {
        return false;
      }
    } else {
      const accessors = member.childForFieldName('accessors')?.namedChildren ?? [];
      const value = member.childForFieldName('value');
      // Auto properties are meant to be instance members.
      const bodies = value?.type === 'arrow_expression_clause' ? [value] : accessors.map((accessor) => accessor.childForFieldName('body'));
      if (bodies.length === 0 || bodies.some((body) => !body || isNotImplemented(body)) || name === 'IsCompleted') {
        return false;
      }
    }

    if (attributesOf(member).some((attribute) => TEST_ATTRIBUTES[attributeSimpleName(attribute)] === true) || isOnObsoleteChain(member)) {
      return false;
    }

    if (this.suppressions.isSuppressed('CA1822', member)) {
      return false;
    }

    const visibility = resultantVisibility(member);
    if (visibility === 'public') {
      // Roslyn skips the public API of web projects and generic types (CA1000).
      const generic = type.node.namedChildren.some((child) => child.type === 'type_parameter_list');
      if (generic || this.project?.webProject) {
        return false;
      }
    }

    return this.surface.all || this.surface.groups.has(visibility);
  }

  /**
   * `INSTANCE` when the member uses `this`, `base` or an instance member of its type; otherwise the
   * names it uses that might be inherited instance members (reported), or `undefined`.
   */
  private instanceUse(type: TypeInfo, member: Node, name: string): Analysis | undefined {
    const selfOnly = this.model.symbols.filter((symbol) => symbol.category === 'member' && symbol.type === type && symbol.name === name).length === 1;
    for (const node of walk(member)) {
      if (node.type === 'this_expression' || node.type === 'base_expression') {
        const access = node.parent;
        const isSelfCall =
          selfOnly &&
          node.type === 'this_expression' &&
          access?.type === 'member_access_expression' &&
          access.childForFieldName('name')?.text === name &&
          access.parent?.type === 'invocation_expression';
        if (!isSelfCall) {
          return INSTANCE;
        }
      } else if (node.type === 'interpolated_string_expression' && /\b(?:this|base)\b/.test(node.text)) {
        return INSTANCE;
      }
    }

    const instanceNames = this.instanceNames(type);
    const inheritsUnknown = this.inheritsUnknownMembers(type);
    const unresolved = new Set<string>();
    const ambiguous = new Set<string>();
    for (const occurrence of this.occurrences) {
      if (occurrence.start < member.startIndex || occurrence.end > member.endIndex) {
        continue;
      }

      const role = occurrence.role.kind;
      if (role !== 'reference' && role !== 'unknown' && role !== 'tupleElement') {
        continue;
      }

      const used = occurrence.name;
      if (CONTEXTUAL_KEYWORDS.has(used)) {
        if (used === 'field' && isInside(occurrence, member, 'accessor_declaration')) {
          return INSTANCE;
        }

        continue;
      }

      const local = this.types.localDeclaration(used, occurrence.start);
      if (local || this.isTypeParameter(used, occurrence.start)) {
        continue;
      }

      if (local === null) {
        // A local of that name exists whose scope is not known precisely.
        if (instanceNames.has(used) || inheritsUnknown) {
          ambiguous.add(used);
        }

        continue;
      }

      if (typeAt(this.model, occurrence.start) !== type) {
        // Inside a type nested in the member (not possible) or a local type: nothing of ours.
        continue;
      }

      if (used === name && selfOnly && isInvoked(occurrence, this.source)) {
        continue;
      }

      if (instanceNames.has(used)) {
        return INSTANCE;
      }

      if (inheritsUnknown && !type.memberNames.has(used) && !this.isTypeName(used, occurrence)) {
        unresolved.add(used);
      }
    }

    if (unresolved.size > 0) {
      const names = [...unresolved].map((item) => `'${item}'`).join(', ');
      const origin = type.isPartial ? 'declared in another part of the partial type' : 'members inherited from a base type';

      return report(`it uses ${names}, which may be ${origin}`);
    }

    if (ambiguous.size > 0) {
      const names = [...ambiguous].map((item) => `'${item}'`).join(', ');

      return report(`the cleanup cannot tell whether ${names} refers to a local or to an instance member`);
    }

    return undefined;
  }

  private instanceNames(type: TypeInfo): Set<string> {
    const names = new Set(OBJECT_INSTANCE_MEMBERS);
    for (const symbol of this.model.symbols) {
      if (symbol.category === 'member' && symbol.type === type && !symbol.modifiers.has('static')) {
        names.add(symbol.name);
      }
    }

    // Primary constructor parameters are captured by the instance; records add members too.
    for (const parameter of type.node.childForFieldName('parameters')?.namedChildren ?? []) {
      const parameterName = parameter.childForFieldName('name');
      if (parameterName) {
        names.add(identifierName(parameterName.text));
      }
    }

    if (type.node.type === 'record_declaration') {
      RECORD_INSTANCE_MEMBERS.forEach((member) => names.add(member));
    }

    return names;
  }

  /** True when a class may inherit members this file does not show: a base class, or other parts of a partial type. */
  private inheritsUnknownMembers(type: TypeInfo): boolean {
    if (type.isPartial) {
      return true;
    }

    if (!type.hasBaseList || type.node.type === 'struct_declaration' || isRecordStruct(type.node)) {
      return false;
    }

    const baseList = type.node.namedChildren.find((child) => child.type === 'base_list');
    const interfaces = new Set([...this.project?.others.interfaceNames ?? [], ...this.model.types.filter((info) => info.kind === 'interface').map((info) => info.name)]);

    return (baseList?.namedChildren ?? []).some((base) => {
      if (base.type === 'argument_list') {
        return true;
      }

      const baseName = base.text.replace(/<.*$/s, '').split('.').pop()?.trim() ?? '';

      return !interfaces.has(baseName) && (this.types.declaresType(baseName) || WELL_KNOWN_INTERFACES[baseName] !== true);
    });
  }

  private isTypeParameter(name: string, offset: number): boolean {
    return this.model.symbols.some(
      (symbol) => symbol.category === 'typeParameter' && symbol.name === name && symbol.region !== undefined && spans(symbol.region, offset, offset)
    );
  }

  /** A name used as the receiver of a member access that names a known type (`Console.WriteLine`). */
  private isTypeName(name: string, occurrence: Occurrence): boolean {
    const node = occurrence.node;
    const receiver = node?.parent?.type === 'member_access_expression' && node.parent.childForFieldName('expression') === node;

    return receiver && (this.types.declaresType(name) || WELL_KNOWN_STATIC_TYPES[name] === true);
  }

  /**
   * How the rest of the file refers to the member: `SKIP` when it is used as a delegate (Roslyn
   * does not report those), a report when a reference would break once it is static, else the
   * edits removing `this.` from the references.
   */
  private references(type: TypeInfo, member: Node, name: string): Analysis {
    const edits: TextEdit[] = [];
    const isMethod = member.type === 'method_declaration';
    let blocker: string | undefined;
    for (const occurrence of this.model.occurrencesByName.get(name) ?? []) {
      if (spans(member, occurrence.start, occurrence.end) && occurrence.role.kind === 'declaration') {
        continue;
      }

      const node = occurrence.node;
      const line = lineNumberAt(this.source, occurrence.start);
      const inNameOf = node !== undefined && isInsideNameOf(node);
      const role = occurrence.role;
      if (isMethod && !inNameOf && (role.kind === 'reference' || role.kind === 'member') && !isInvoked(occurrence, this.source)) {
        return SKIP;
      }

      switch (role.kind) {
        case 'member':
          if (role.receiver.kind === 'this') {
            if (typeAt(this.model, occurrence.start) !== type) {
              break;
            }

            // `this.Name` or `this.Name<T>`; inside an interpolated string there is no node to edit.
            const target = node?.parent?.type === 'generic_name' ? node.parent : node;
            const access = target?.parent;
            const receiver = access?.type === 'member_access_expression' ? access.childForFieldName('expression') : null;
            const shadowed = this.types.localDeclaration(name, occurrence.start) !== undefined;
            if (shadowed || !receiver || !target) {
              blocker ??= `this.${name} on line ${line} cannot be simplified`;
            } else {
              edits.push({ start: receiver.startIndex, end: target.startIndex, text: '' });
            }
          } else if (!inNameOf && !this.isOtherTypeReceiver(node, type)) {
            blocker ??= `it is used through an expression on line ${line}`;
          }

          break;
        case 'initializerMember':
        case 'unknown':
          blocker ??= `it is used on line ${line} in a way that needs an instance member`;
          break;
        default:
          break;
      }
    }

    return blocker ? report(blocker) : { kind: 'fix', edits };
  }

  /** The receiver of `X.Name` is a type other than `type` (`string.Join`, `Math.Max`). */
  private isOtherTypeReceiver(name: Node | undefined, type: TypeInfo): boolean {
    const target = name?.parent?.type === 'generic_name' ? name.parent : name;
    const receiver = target?.parent?.type === 'member_access_expression' ? target.parent.childForFieldName('expression') : null;
    if (!receiver) {
      return false;
    }

    if (receiver.type === 'predefined_type') {
      return true;
    }

    const leftmost = receiver.type === 'identifier' ? receiver.text : receiver.type === 'generic_name' ? receiver.namedChild(0)?.text : undefined;
    if (!leftmost || leftmost === type.name || this.types.localDeclaration(leftmost, receiver.startIndex) !== undefined) {
      return false;
    }

    for (let current = typeAt(this.model, receiver.startIndex); current; current = current.parent) {
      if (current.memberNames.has(leftmost) && !this.model.types.some((info) => info.name === leftmost)) {
        return false;
      }
    }

    return this.types.declaresType(leftmost) || WELL_KNOWN_STATIC_TYPES[leftmost] === true;
  }

  /** Why the member's visibility keeps it from becoming static, if it does. */
  private visibilityBlocker(member: Node, name: string): Analysis | undefined {
    const visibility = resultantVisibility(member);
    if (visibility === 'private') {
      return undefined;
    }

    if (visibility === 'public') {
      return report('it is part of the public API, where making it static is a breaking change');
    }

    if (!this.project) {
      return report('it is visible to the whole project and no project file was found to check its other uses');
    }

    if (this.project.incomplete) {
      return report(`it is visible to the whole project, whose files could not all be checked (${this.project.incomplete})`);
    }

    if (this.project.internalsVisibleTo) {
      return report('InternalsVisibleTo exposes it to other assemblies');
    }

    if (this.project.others.memberAccessNames.has(name)) {
      return report(`a member named '${name}' is used through an expression in another file of the project`);
    }

    return undefined;
  }
}

function accessorKeyword(accessor: Node): string {
  return /(?:^|\s)(get|set|init|add|remove)\b/.exec(accessor.text.replace(/\[[^\]]*\]/g, ''))?.[1] ?? '';
}

/** A body consisting of `throw new NotImplementedException()` or `NotSupportedException` alone. */
function isNotImplemented(body: Node): boolean {
  return /^(?:\{\s*throw\s+new\s+(?:System\.)?Not(?:Implemented|Supported)Exception\s*\([^;]*\)\s*;\s*\}|=>\s*throw\s+new\s+(?:System\.)?Not(?:Implemented|Supported)Exception\s*\([^;]*\))$/.test(
    body.text.trim()
  );
}

function isInvoked(occurrence: Occurrence, source: string): boolean {
  const node = occurrence.node;
  if (!node) {
    // Inside an interpolated string: look at the text after the name.
    return /^\s*(?:<[^()]*>\s*)?\(/.test(source.slice(occurrence.end, occurrence.end + 200));
  }

  // `M(...)`, `M<T>(...)`, `x.M(...)`, `x.M<T>(...)`
  let target: Node = node;
  if (target.parent?.type === 'generic_name') {
    target = target.parent;
  }

  if (target.parent?.type === 'member_access_expression' && target.parent.childForFieldName('name') === target) {
    target = target.parent;
  }

  return target.parent?.type === 'invocation_expression' && target.parent.childForFieldName('function') === target;
}

function isInsideNameOf(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'invocation_expression' && current.childForFieldName('function')?.text === 'nameof') {
      return true;
    }
  }

  return false;
}

function isInside(occurrence: Occurrence, stop: Node, type: string): boolean {
  for (let current = occurrence.node?.parent ?? null; current && current !== stop; current = current.parent) {
    if (current.type === type) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// IDE0051 Remove unused private members / IDE0052 Remove unread private members
// ---------------------------------------------------------------------------------------------

/** Initializers that have no side effects, so a field declared with one can be removed. */
const PURE_INITIALIZER = /^(?:[-+]?[\d.]+[\w]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)+'|true|false|null|default(?:\([\w.<>, ?[\]]*\))?|nameof\([\w.]*\)|typeof\([\w.<>, ?[\]]*\)|new\s+object\s*\(\s*\)|(?:string|String)\.Empty|Array\.Empty<[\w.<>, ?[\]]*>\(\s*\))$/;

interface PrivateMember {
  readonly declaration: Node;
  /** The declarator, for fields and field-like events. */
  readonly declarator?: Node;
  readonly nameNode: Node;
  readonly name: string;
  readonly kind: 'field' | 'property' | 'method' | 'event';
}

/** Names as they appear in the file: identifier tokens outside declarations, and mentions in strings and comments. */
class NameUses {
  readonly identifiers = new Map<string, number[]>();
  readonly strings: string[] = [];
  readonly interpolations: string[] = [];
  readonly comments: string[] = [];

  constructor(source: string) {
    const { tokens, trivia } = lex(source);
    for (const token of tokens) {
      const text = source.slice(token.start, token.end);
      if (token.type === 'identifier') {
        const name = identifierName(text);
        const offsets = this.identifiers.get(name) ?? [];
        offsets.push(token.start);
        this.identifiers.set(name, offsets);
      } else if (token.type === 'interpolated_string_expression') {
        this.interpolations.push(text);
      } else if (/string_literal$/.test(token.type)) {
        this.strings.push(text);
      }
    }

    for (const comment of trivia) {
      if (comment.type === 'comment') {
        this.comments.push(source.slice(comment.start, comment.end));
      }
    }
  }

  mentioned(texts: readonly string[], name: string): boolean {
    const pattern = new RegExp(`(?<![\\w@])${name.replace(/[$]/g, '\\$&')}(?!\\w)`);

    return texts.some((text) => pattern.test(text));
  }
}

function privateMembers(type: Node): PrivateMember[] {
  const members: PrivateMember[] = [];
  for (const declaration of type.childForFieldName('body')?.namedChildren ?? []) {
    if (declaredVisibility(declaration) !== 'private') {
      continue;
    }

    if (declaration.type === 'field_declaration' || declaration.type === 'event_field_declaration') {
      const variable = declaration.namedChildren.find((child) => child.type === 'variable_declaration');
      for (const declarator of variable?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? []) {
        const nameNode = declarator.childForFieldName('name');
        if (nameNode) {
          const kind = declaration.type === 'field_declaration' ? 'field' : 'event';
          members.push({ declaration, declarator, nameNode, name: identifierName(nameNode.text), kind });
        }
      }

      continue;
    }

    const kind = { method_declaration: 'method', property_declaration: 'property', event_declaration: 'event' }[declaration.type] as PrivateMember['kind'] | undefined;
    const nameNode = declaration.childForFieldName('name');
    if (kind && nameNode && !declaration.namedChildren.some((child) => child.type === 'explicit_interface_specifier')) {
      members.push({ declaration, nameNode, name: identifierName(nameNode.text), kind });
    }
  }

  return members;
}

/** Private members IDE0051/IDE0052 never flag: entry points, designer and serialization hooks, members with a special modifier. */
function isExempt(member: PrivateMember): boolean {
  const modifiers = ['override', 'virtual', 'abstract', 'extern', 'partial'];

  return (
    modifiers.some((modifier) => hasModifier(member.declaration, modifier)) ||
    (member.kind === 'method' && (member.name === 'Main' || /^(?:ShouldSerialize|Reset)[A-Z]/.test(member.name)))
  );
}

function memberTypes(root: Node): Node[] {
  return [...walk(root)].filter(
    (node) => node.type === 'class_declaration' || node.type === 'struct_declaration' || node.type === 'record_declaration'
  );
}

export function applyRemoveUnusedPrivateMembers(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'IDE0051', source)) {
    return source;
  }

  return untilStable(source, context, 'IDE0051', (current, issues) => {
    const model = buildSourceModel(current);
    const uses = new NameUses(current);
    const suppressions = new Suppressions(current);
    const declarationNames = new Set(model.symbols.filter((symbol) => symbol.category === 'member' || symbol.category === 'type').map((symbol) => symbol.nameNode.startIndex));
    const edits: TextEdit[] = [];
    const issue = (member: PrivateMember, reason: string): void => {
      issues.push(describeDiagnostic('IDE0051', current, member.declaration.startIndex, `'${member.name}' is private and never used, but ${reason}; it was kept.`));
    };

    for (const type of memberTypes(model.root)) {
      const partial = hasModifier(type, 'partial');
      const struct = type.type === 'struct_declaration' || isRecordStruct(type);
      const serializable = attributesOf(type).some((attribute) => /^(?:Serializable|StructLayout|DataContract)$/.test(attributeSimpleName(attribute)));
      for (const member of privateMembers(type)) {
        const references = (uses.identifiers.get(member.name) ?? []).filter((offset) => !declarationNames.has(offset));
        if (references.length > 0 || uses.mentioned(uses.interpolations, member.name) || isExempt(member)) {
          continue;
        }

        if (suppressions.isSuppressed('IDE0051', member.declaration)) {
          continue;
        }

        const initializer = member.declarator?.namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0] ??
          (member.kind === 'property' ? member.declaration.childForFieldName('value') : null);
        const pureInitializer = !initializer || initializer.type === 'arrow_expression_clause' || PURE_INITIALIZER.test(initializer.text.trim());
        if (partial) {
          issue(member, `${type.childForFieldName('name')?.text} is partial and its other parts were not checked`);
        } else if (hasParseErrors(member.declaration) || model.opaqueRoots.has(member.declaration) || hasBrokenMemberDeclarations(type)) {
          issue(member, 'the cleanup parser could not fully analyze its type');
        } else if (attributesOf(member.declaration).length > 0) {
          issue(member, 'it has attributes that may use it (serialization, reflection or framework hooks)');
        } else if (uses.mentioned(uses.strings, member.name)) {
          issue(member, 'its name appears in a string literal, so it may be used through reflection or data binding');
        } else if (uses.mentioned(uses.comments, member.name)) {
          issue(member, 'a comment refers to it');
        } else if (member.kind === 'field' && (struct || serializable) && !hasModifier(member.declaration, 'static') && !hasModifier(member.declaration, 'const')) {
          issue(member, `removing a field of a ${struct ? 'struct' : 'serializable type'} changes its layout`);
        } else if (!pureInitializer) {
          issue(member, 'its initializer may have side effects');
        } else {
          const edit = removeMemberEdit(current, member);
          if (edit) {
            edits.push(edit);
          } else {
            issue(member, 'it shares its line with other code');
          }
        }
      }
    }

    return applyEdits(current, edits);
  });
}

/** Removes a whole member, or one declarator of a field declaring several. */
function removeMemberEdit(source: string, member: PrivateMember): TextEdit | undefined {
  const declarator = member.declarator;
  const siblings = declarator?.parent?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
  if (!declarator || siblings.length <= 1) {
    return removeDeclarationEdit(source, member.declaration);
  }

  const index = siblings.indexOf(declarator);

  return index < siblings.length - 1
    ? { start: declarator.startIndex, end: siblings[index + 1].startIndex, text: '' }
    : { start: siblings[index - 1].endIndex, end: declarator.endIndex, text: '' };
}

/** IDE0052: reports private fields and properties that are assigned but never read. */
export function reportUnreadPrivateMembers(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'IDE0052', source)) {
    return source;
  }

  const model = buildSourceModel(source);
  const uses = new NameUses(source);
  const suppressions = new Suppressions(source);
  for (const type of memberTypes(model.root)) {
    if (hasModifier(type, 'partial') || hasBrokenMemberDeclarations(type)) {
      continue;
    }

    for (const member of privateMembers(type)) {
      if ((member.kind !== 'field' && member.kind !== 'property') || isExempt(member) || attributesOf(member.declaration).length > 0) {
        continue;
      }

      if (uses.mentioned(uses.strings, member.name) || uses.mentioned(uses.interpolations, member.name)) {
        continue;
      }

      const references = (model.occurrencesByName.get(member.name) ?? []).filter((occurrence) => occurrence.node !== member.nameNode);
      const writeOnly = references.length > 0 && references.every((occurrence) => isPlainAssignmentTarget(occurrence));
      if (writeOnly && !suppressions.isSuppressed('IDE0052', member.declaration)) {
        context.report(describeDiagnostic('IDE0052', source, member.declaration.startIndex, `'${member.name}' is private and assigned but never read.`));
      }
    }
  }

  return source;
}

/** `name = value` or `this.name = value`: a write that reads nothing. */
function isPlainAssignmentTarget(occurrence: Occurrence): boolean {
  let target = occurrence.node;
  if (!target || (occurrence.role.kind !== 'reference' && !(occurrence.role.kind === 'member' && occurrence.role.receiver.kind === 'this'))) {
    return false;
  }

  if (target.parent?.type === 'member_access_expression') {
    target = target.parent;
  }

  const assignment = target.parent;

  return (
    assignment?.type === 'assignment_expression' &&
    assignment.childForFieldName('left') === target &&
    assignment.children.some((child) => !child.isNamed && child.type === '=')
  );
}
