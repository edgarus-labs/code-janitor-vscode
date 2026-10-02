import { TextEdit } from '../parser';
import { Node } from '../syntax/node';
import {
  CONTEXTUAL_KEYWORDS,
  DeclaredSymbol,
  Occurrence,
  Receiver,
  SourceModel,
  TypeInfo,
  identifierName,
  namePath,
  spans,
  typeAt,
} from './sourceModel';

/**
 * Plans an in-file, syntactic rename of one symbol (together with the declarations that must be
 * renamed with it: overloads, or a parameter across overloads). A plan is only produced when every
 * occurrence of the old name in the symbol's scope is understood; otherwise the reason is returned.
 */

export type RenamePlan =
  | {
      readonly ok: true;
      readonly edits: readonly TextEdit[];
      /** Nodes spanning every place the plan inspected or edited. */
      readonly scopes: readonly Node[];
    }
  | { readonly ok: false; readonly reason: string };

/** Target name computed for a symbol by its naming rule, if it violates one. */
export type TargetNameLookup = (symbol: DeclaredSymbol) => string | undefined;

const RESERVED_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const',
  'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern',
  'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface',
  'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override',
  'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*$/u;

class RenameRefused extends Error {}

export function planRename(model: SourceModel, symbol: DeclaredSymbol, newName: string, targetName: TargetNameLookup): RenamePlan {
  try {
    if (symbol.blocker) {
      refuse(symbol.blocker);
    }

    checkNewName(symbol, newName);
    const planner = new Planner(model, symbol.name, newName);
    switch (symbol.category) {
      case 'member':
        planner.renameMember(symbol, targetName);
        break;
      case 'local':
        planner.renameLocal(symbol);
        break;
      case 'parameter':
        planner.renameParameter(symbol, targetName);
        break;
      case 'typeParameter':
        planner.renameTypeParameter(symbol);
        break;
      default:
        refuse('this kind of symbol is not renamed');
    }

    return { ok: true, edits: planner.edits(), scopes: planner.scopes };
  } catch (error) {
    if (error instanceof RenameRefused) {
      return { ok: false, reason: error.message };
    }

    throw error;
  }
}

function refuse(reason: string): never {
  throw new RenameRefused(reason);
}

/** Why `oldName` cannot become `newName` whatever the symbol is, if so. */
export function invalidNewName(oldName: string, newName: string): string | undefined {
  if (CONTEXTUAL_KEYWORDS.has(oldName)) {
    return `'${oldName}' is a contextual keyword`;
  }

  if (!newName || newName === oldName) {
    return 'no compliant name can be derived';
  }

  if (!IDENTIFIER.test(newName)) {
    return `'${newName}' is not a valid C# identifier`;
  }

  if (RESERVED_KEYWORDS.has(newName)) {
    return `'${newName}' is a C# keyword`;
  }

  return undefined;
}

function checkNewName(symbol: DeclaredSymbol, newName: string): void {
  const invalid = invalidNewName(symbol.name, newName);
  if (invalid) {
    refuse(invalid);
  }

  // `value` is only special inside accessors, where it names the implicit parameter.
  const valueIsSafe = newName === 'value' && symbol.category !== 'member' && !isInsideAccessor(symbol.region);
  if (CONTEXTUAL_KEYWORDS.has(newName) && !valueIsSafe) {
    refuse(`'${newName}' is a C# contextual keyword`);
  }
}

function isInsideAccessor(node: Node | undefined): boolean {
  for (let current = node ?? null; current; current = current.parent) {
    if (current.type === 'accessor_declaration') {
      return true;
    }
  }

  return false;
}

class Planner {
  readonly scopes: Node[] = [];
  private readonly editsByStart = new Map<number, TextEdit>();
  private usedAsTupleElement = false;

  constructor(
    private readonly model: SourceModel,
    private readonly oldName: string,
    private readonly newName: string
  ) {}

  edits(): TextEdit[] {
    if (this.usedAsTupleElement && this.occurrences(this.oldName).some((o) => o.role.kind === 'member')) {
      refuse(`'${this.oldName}' is used as a tuple element whose inferred name may be read elsewhere`);
    }

    return [...this.editsByStart.values()];
  }

  renameMember(symbol: DeclaredSymbol, targetName: TargetNameLookup): void {
    const type = symbol.type;
    if (!type) {
      refuse('it is not declared in a type');
    }

    const declarations = this.symbolsNamed(symbol.name).filter((other) => other.category === 'member' && other.type === type);
    for (const declaration of declarations) {
      if (declaration.blocker) {
        refuse(`another member named '${symbol.name}' cannot be renamed (${declaration.blocker})`);
      }

      if (declaration !== symbol && targetName(declaration) !== this.newName) {
        refuse(`members named '${symbol.name}' would get different names`);
      }

      this.refuseColorColor(declaration);
    }

    if (this.newName === type.name) {
      refuse(`'${this.newName}' is the name of the containing type`);
    }

    this.scopes.push(type.node);
    this.refuseCollisions(type.node, `'${this.newName}' is already used in ${type.name}`);

    const body = type.node.childForFieldName('body');
    const declarationNodes = new Set(declarations.map((declaration) => declaration.nameNode));
    for (const occurrence of this.occurrencesIn(type.node, this.oldName)) {
      const role = occurrence.role;
      if (role.kind === 'declaration' && occurrence.node && declarationNodes.has(occurrence.node)) {
        this.edit(occurrence);
        continue;
      }

      this.refuseOpaque(occurrence);
      if (role.kind === 'declaration') {
        this.refuseImpreciseDeclaration(occurrence);
        continue;
      }

      const inBody = body ? spans(body, occurrence.start, occurrence.end) : false;
      switch (role.kind) {
        case 'reference':
        case 'tupleElement':
          if (!inBody) {
            refuse(`'${this.oldName}' is used outside the body of ${type.name}`);
          }

          this.usedAsTupleElement ||= role.kind === 'tupleElement';
          if (this.resolvesToMember(occurrence, type)) {
            this.edit(occurrence);
          }

          break;
        case 'member':
          if (this.memberAccessTargets(occurrence, role.receiver, type)) {
            this.edit(occurrence);
          }

          break;
        case 'initializerMember':
          if (!role.creation) {
            refuse(`'${this.oldName}' is set in a nested object initializer`);
          }

          if (role.creation.type === 'implicit_object_creation_expression') {
            refuse(`'${this.oldName}' is set in a target-typed object initializer`);
          }

          if (role.creation.type === 'with_expression' ? this.withTargets(occurrence, role.creation, type) : this.createsType(role.creation, type)) {
            this.edit(occurrence);
          }

          break;
        case 'namedArgument':
        case 'type':
        case 'skip':
          break;
        default:
          this.refuseUnknown(occurrence);
      }
    }

    this.renameCrefs(type);
  }

  renameLocal(symbol: DeclaredSymbol): void {
    const region = symbol.region;
    if (!region || !symbol.regionPrecise) {
      refuse('its scope cannot be determined syntactically');
    }

    this.refuseColorColor(symbol);
    this.refuseCollisions(region, `'${this.newName}' is already used in the scope of '${symbol.name}'`);
    this.refuseEnclosingDeclarations(region);
    this.scopes.push(region);
    this.renameInScope(symbol, region, false);
  }

  renameParameter(symbol: DeclaredSymbol, targetName: TargetNameLookup): void {
    const owner = symbol.owner;
    const type = symbol.type;
    if (!owner) {
      refuse('its declaring method cannot be determined');
    }

    const group = this.parameterGroup(symbol, owner, type);
    for (const parameter of group) {
      if (parameter.blocker) {
        refuse(`a parameter '${symbol.name}' of an overload cannot be renamed (${parameter.blocker})`);
      }

      if (parameter !== symbol && targetName(parameter) !== this.newName) {
        refuse(`parameters named '${symbol.name}' of the overloads would get different names`);
      }

      const region = parameter.region;
      if (!region || !parameter.regionPrecise) {
        refuse('its scope cannot be determined syntactically');
      }

      this.refuseColorColor(parameter);
      this.refuseCollisions(region, `'${this.newName}' is already used in the scope of '${symbol.name}'`);
      this.refuseEnclosingDeclarations(region);
      this.scopes.push(region);
      this.renameInScope(parameter, region, false);
      this.renameDocNames(parameter.owner ?? region, ['param', 'paramref']);
    }

    this.renameNamedArguments(owner, type);
  }

  renameTypeParameter(symbol: DeclaredSymbol): void {
    const region = symbol.region;
    if (!region) {
      refuse('its scope cannot be determined syntactically');
    }

    const ownerName = region.childForFieldName('name');
    if (ownerName && identifierName(ownerName.text) === this.newName) {
      refuse(`'${this.newName}' is the name of the declaring type or method`);
    }

    this.refuseCollisions(region, `'${this.newName}' is already used in the scope of '${symbol.name}'`);
    this.refuseEnclosingDeclarations(region);
    this.scopes.push(region);
    this.renameInScope(symbol, region, true);
    this.renameDocNames(region, ['typeparam', 'typeparamref']);
    for (const comment of this.model.docComments) {
      if (spans(region, comment.startIndex, comment.endIndex)) {
        this.renameDocNamesInText(comment.startIndex, comment.text, ['typeparamref']);
      }
    }
  }

  /** Renames the declaration and every reference to it within `region`. */
  private renameInScope(symbol: DeclaredSymbol, region: Node, typePositionsAreReferences: boolean): void {
    for (const occurrence of this.occurrencesIn(region, this.oldName)) {
      if (occurrence.node === symbol.nameNode) {
        this.edit(occurrence);
        continue;
      }

      this.refuseOpaque(occurrence);
      const role = occurrence.role;
      switch (role.kind) {
        case 'declaration': {
          const other = this.refuseImpreciseDeclaration(occurrence);
          if (symbol.category === 'typeParameter' || other?.region === region) {
            refuse(`'${this.oldName}' is declared again inside its scope`);
          }

          break;
        }
        case 'reference':
        case 'tupleElement':
        case 'type':
          if (role.kind === 'type' && !typePositionsAreReferences) {
            break;
          }

          this.usedAsTupleElement ||= role.kind === 'tupleElement';
          if (!this.shadowedWithin(occurrence, symbol, region)) {
            this.edit(occurrence);
          }

          break;
        case 'member':
        case 'namedArgument':
        case 'initializerMember':
        case 'skip':
          break;
        default:
          this.refuseUnknown(occurrence);
      }
    }
  }

  /** Parameters that must be renamed together: the same parameter in every overload of the method. */
  private parameterGroup(symbol: DeclaredSymbol, owner: Node, type: TypeInfo | undefined): DeclaredSymbol[] {
    if (owner.type !== 'method_declaration' && owner.type !== 'constructor_declaration') {
      return [symbol];
    }

    const ownerName = owner.type === 'method_declaration' ? owner.childForFieldName('name')?.text : undefined;
    const owners = this.symbolsNamed(symbol.name).filter(
      (other) =>
        other.category === 'parameter' &&
        other.type === type &&
        other.owner?.type === owner.type &&
        (owner.type === 'constructor_declaration' || other.owner.childForFieldName('name')?.text === ownerName)
    );

    return owners.length > 0 ? owners : [symbol];
  }

  /** Named arguments `old: value` at call sites of the method, constructor or local function. */
  private renameNamedArguments(owner: Node, type: TypeInfo | undefined): void {
    const isConstructor = owner.type === 'constructor_declaration';
    const isLocalFunction = owner.type === 'local_function_statement';
    if (!isConstructor && !isLocalFunction && owner.type !== 'method_declaration') {
      return;
    }

    const calleeName = isConstructor ? undefined : identifierName(owner.childForFieldName('name')?.text ?? '');
    const scope = isLocalFunction ? owner.parent : type?.node;
    if (!scope) {
      return;
    }

    this.scopes.push(scope);
    for (const occurrence of this.occurrencesIn(scope, this.oldName)) {
      if (occurrence.role.kind !== 'namedArgument') {
        continue;
      }

      const call = occurrence.role.call;
      const targets = isConstructor
        ? this.callTargetsConstructor(call, occurrence, type)
        : this.callTargetsMethod(call, occurrence, calleeName ?? '', owner, type);
      if (targets) {
        this.refuseOpaque(occurrence);
        this.edit(occurrence);
      }
    }
  }

  private callTargetsConstructor(call: Node, occurrence: Occurrence, type: TypeInfo | undefined): boolean {
    switch (call.type) {
      case 'object_creation_expression':
        return type !== undefined && this.createsType(call, type);
      case 'implicit_object_creation_expression':
        refuse(`named argument '${this.oldName}:' is passed to a target-typed 'new'`);
        break;
      case 'constructor_initializer': {
        const inner = typeAt(this.model, occurrence.start);
        if (call.children.some((child) => child.type === 'base')) {
          this.refuseBaseInNestedType(inner, type, `named argument '${this.oldName}:' is passed to base(...)`);
          return false;
        }

        return call.children.some((child) => child.type === 'this') && inner === type;
      }
    }

    return false;
  }

  private callTargetsMethod(
    call: Node,
    occurrence: Occurrence,
    calleeName: string,
    owner: Node,
    type: TypeInfo | undefined
  ): boolean {
    if (call.type !== 'invocation_expression') {
      return false;
    }

    const callee = call.childForFieldName('function');
    let name: Node | null | undefined = callee;
    let receiver: Node | null = null;
    if (callee?.type === 'member_access_expression') {
      name = callee.childForFieldName('name');
      receiver = callee.childForFieldName('expression');
    } else if (callee?.type === 'conditional_access_expression') {
      if (identifierName(callee.childForFieldName('name')?.text ?? '') === calleeName) {
        refuse(`named argument '${this.oldName}:' is passed to a '${calleeName}' call that cannot be resolved`);
      }

      name = undefined;
    } else if (callee?.type !== 'identifier' && callee?.type !== 'generic_name') {
      name = undefined;
    }

    const nameNode = name?.type === 'generic_name' ? name.namedChildren[0] : name;
    if (!nameNode || nameNode.type !== 'identifier' || identifierName(nameNode.text) !== calleeName) {
      return false;
    }

    if (receiver) {
      if (receiver.type === 'base_expression') {
        this.refuseBaseInNestedType(typeAt(this.model, occurrence.start), type, `named argument '${this.oldName}:' is passed to a base.${calleeName} call`);
        return false;
      }

      const isThis = receiver.type === 'this_expression';
      const isType = receiver.type === 'identifier' && identifierName(receiver.text) === type?.name;
      if (!isThis && !isType) {
        refuse(`named argument '${this.oldName}:' is passed to a '${calleeName}' call that cannot be resolved`);
      }
    }

    // Innermost local function named like the callee, if the call is inside its scope.
    const localFunction = this.symbolsNamed(calleeName)
      .filter((other) => other.kind === 'local_function' && other.region && spans(other.region, occurrence.start, occurrence.end))
      .sort((a, b) => (b.region?.startIndex ?? 0) - (a.region?.startIndex ?? 0))[0];

    if (owner.type === 'local_function_statement') {
      return !receiver && localFunction?.nameNode.parent === owner;
    }

    if (localFunction && !receiver) {
      return false;
    }

    return type !== undefined && this.innermostTypeResolvesTo(occurrence, calleeName, type);
  }

  /** A simple-name reference inside the type resolves to the type's member unless shadowed. */
  private resolvesToMember(occurrence: Occurrence, type: TypeInfo): boolean {
    for (const declaration of this.symbolsNamed(this.oldName)) {
      if (
        declaration.category !== 'member' &&
        declaration.region &&
        spans(declaration.region, occurrence.start, occurrence.end) &&
        spans(type.node, declaration.region.startIndex, declaration.region.endIndex)
      ) {
        if (!declaration.regionPrecise) {
          refuse(`'${this.oldName}' is also declared by a construct whose scope cannot be determined`);
        }

        return false;
      }
    }

    return this.innermostTypeResolvesTo(occurrence, this.oldName, type);
  }

  /** Walks nested types from the occurrence up to `type`; a nested declaration of the name shadows it. */
  private innermostTypeResolvesTo(occurrence: Occurrence, name: string, type: TypeInfo): boolean {
    for (let current = typeAt(this.model, occurrence.start); current && current !== type; current = current.parent) {
      if (current.memberNames.has(name)) {
        return false;
      }

      if (current.hasBaseList) {
        refuse(`'${name}' is used inside nested type ${current.name}, which may inherit a member with that name`);
      }
    }

    return true;
  }

  private memberAccessTargets(occurrence: Occurrence, receiver: Receiver, type: TypeInfo): boolean {
    switch (receiver.kind) {
      case 'this':
        return typeAt(this.model, occurrence.start) === type;
      case 'base':
        this.refuseBaseInNestedType(typeAt(this.model, occurrence.start), type, `'${this.oldName}' is accessed through base`);
        return false;
      case 'conditional':
        refuse(`'${this.oldName}' is accessed through a conditional access whose target cannot be resolved`);
        break;
      case 'expression':
        if (receiver.name !== undefined && (receiver.name === type.name || this.receiverIsDeclaredAs(occurrence, receiver.name, type.name))) {
          return true;
        }

        if (receiver.qualifiedName === type.name) {
          if (receiver.path && designatesType(receiver.path, type)) {
            return true;
          }

          this.refuseQualified(type);
        }

        refuse(`'${this.oldName}' is accessed through another expression whose type cannot be resolved syntactically`);
    }

    return false;
  }

  /** `value with { Name = ... }` sets the member of the value's type: ours on `this` or a value declared with the type. */
  private withTargets(occurrence: Occurrence, withExpression: Node, type: TypeInfo): boolean {
    const receiver = withExpression.namedChildren[0];
    if (receiver?.type === 'this_expression' && typeAt(this.model, occurrence.start) === type) {
      return true;
    }

    if (receiver?.type === 'identifier' && this.receiverIsDeclaredAs(occurrence, identifierName(receiver.text), type.name)) {
      return true;
    }

    refuse(`'${this.oldName}' is set in a 'with' expression on a value whose type cannot be resolved syntactically`);
  }

  /**
   * `new T(...)` or `new T { ... }` creates the type when `T` names it: a simple name, or a qualified
   * name ending with the names of its containing types and namespaces. Another qualified `T` refuses.
   */
  private createsType(creation: Node, type: TypeInfo): boolean {
    if (creation.type !== 'object_creation_expression') {
      return false;
    }

    const typeSyntax = creation.childForFieldName('type');
    if (typeName(typeSyntax) !== type.name) {
      return false;
    }

    const path = namePath(typeSyntax);
    if (path && designatesType(path, type)) {
      return true;
    }

    this.refuseQualified(type);
  }

  private refuseQualified(type: TypeInfo): never {
    refuse(`'${this.oldName}' is used through a qualified name that may designate another type named ${type.name}`);
  }

  /** A type nested in `type` that derives from it reaches its private members and constructors through `base`. */
  private refuseBaseInNestedType(inner: TypeInfo | undefined, type: TypeInfo | undefined, use: string): void {
    if (inner !== type) {
      refuse(`${use} in nested type ${inner?.name}, which may derive from ${type?.name}`);
    }
  }

  /** The receiver is a local or parameter explicitly declared with the containing type. */
  private receiverIsDeclaredAs(occurrence: Occurrence, receiverName: string, typeName: string): boolean {
    const declaration = this.symbolsNamed(receiverName)
      .filter(
        (symbol) =>
          (symbol.category === 'local' || symbol.category === 'parameter') &&
          symbol.regionPrecise &&
          symbol.region &&
          spans(symbol.region, occurrence.start, occurrence.end)
      )
      .sort((a, b) => (b.region?.startIndex ?? 0) - (a.region?.startIndex ?? 0))[0];
    const declaredType = declaration?.declaredType?.replace(/\?$/, '').trim();

    return declaredType === typeName;
  }

  /** An inner declaration of the same name (lambda parameter, nested local) hides the symbol. */
  private shadowedWithin(occurrence: Occurrence, symbol: DeclaredSymbol, region: Node): boolean {
    for (const declaration of this.symbolsNamed(this.oldName)) {
      if (
        declaration !== symbol &&
        declaration.category !== 'member' &&
        declaration.region &&
        declaration.region !== region &&
        spans(region, declaration.region.startIndex, declaration.region.endIndex) &&
        spans(declaration.region, occurrence.start, occurrence.end)
      ) {
        if (!declaration.regionPrecise) {
          refuse(`'${this.oldName}' is declared again by a construct whose scope cannot be determined`);
        }

        return true;
      }
    }

    if (symbol.category !== 'typeParameter') {
      return false;
    }

    // A nested type declaring a member of the same name hides a type parameter too.
    for (let current = typeAt(this.model, occurrence.start); current && current.node !== region; current = current.parent) {
      if (current.memberNames.has(this.oldName)) {
        refuse(`'${this.oldName}' is declared again inside its scope`);
      }
    }

    return false;
  }

  /** The new name must not already appear anywhere the renamed references could be captured. */
  private refuseCollisions(region: Node, reason: string): void {
    if (this.occurrencesIn(region, this.newName).length > 0) {
      refuse(reason);
    }
  }

  /** A local may not take the name of a local, parameter or type parameter of an enclosing scope. */
  private refuseEnclosingDeclarations(region: Node): void {
    for (const declaration of this.symbolsNamed(this.newName)) {
      if (
        declaration.category !== 'member' &&
        declaration.region &&
        spans(declaration.region, region.startIndex, region.endIndex)
      ) {
        refuse(`'${this.newName}' is already declared in an enclosing scope`);
      }
    }
  }

  /** `Color Color`: a symbol named like its own type makes `Name.Member` ambiguous. */
  private refuseColorColor(symbol: DeclaredSymbol): void {
    const declaredType = symbol.declaredType?.replace(/\?$/, '').trim();
    if (declaredType === symbol.name) {
      refuse(`'${symbol.name}' has the same name as its type`);
    }
  }

  /** Another declaration of the old name whose scope is unknown hides which references are ours. */
  private refuseImpreciseDeclaration(occurrence: Occurrence): DeclaredSymbol | undefined {
    const other = occurrence.node ? this.model.symbolByNameNode.get(occurrence.node) : undefined;
    if (other && other.category !== 'member' && other.category !== 'type' && !other.regionPrecise) {
      refuse(`'${this.oldName}' is also declared by a construct whose scope cannot be determined`);
    }

    return other;
  }

  private refuseOpaque(occurrence: Occurrence): void {
    if (occurrence.memberRoot && this.model.opaqueRoots.has(occurrence.memberRoot)) {
      refuse(`'${this.oldName}' is used in code the cleanup parser cannot fully analyze`);
    }
  }

  private refuseUnknown(occurrence: Occurrence): never {
    if (occurrence.role.kind === 'projection') {
      refuse(`'${this.oldName}' names a member of an anonymous type`);
    }

    const line = this.model.source.slice(0, occurrence.start).split('\n').length;
    refuse(`'${this.oldName}' is used on line ${line} in a construct the cleanup cannot resolve syntactically`);
  }

  /** `<see cref="Name"/>` and `cref="Type.Name(...)"` in doc comments of the type. */
  private renameCrefs(type: TypeInfo): void {
    const comments = [...this.model.docComments.filter((comment) => spans(type.node, comment.startIndex, comment.endIndex))];
    for (const block of precedingDocBlocks(this.model.source, type.node.startIndex)) {
      this.renameCrefsInText(block.start, block.text, type);
    }

    for (const comment of comments) {
      const inner = typeAt(this.model, comment.startIndex);
      let shadowed = false;
      for (let current = inner; current && current !== type; current = current.parent) {
        shadowed ||= current.memberNames.has(this.oldName);
      }

      if (!shadowed) {
        this.renameCrefsInText(comment.startIndex, comment.text, type);
      }
    }
  }

  private renameCrefsInText(offset: number, text: string, type: TypeInfo): void {
    const pattern = new RegExp(
      `(\\bcref\\s*=\\s*["'])((?:[\\p{L}_][\\p{L}\\p{N}_]*(?:\\{[^}"']*\\})?\\.)*)@?(${escapeRegExp(this.oldName)})(?=["'({\\[<])`,
      'gu'
    );
    for (const match of text.matchAll(pattern)) {
      const qualifier = match[2];
      // A qualified cref names a member of our type only when its qualifier designates the type.
      const path = qualifier.slice(0, -1).split('.').map((segment) => segment.replace(/\{.*$/, ''));
      if (qualifier && (path[path.length - 1] !== type.name || !designatesType(path, type))) {
        continue;
      }

      const start = offset + (match.index ?? 0) + match[1].length + qualifier.length;
      const end = offset + (match.index ?? 0) + match[0].length;
      this.editsByStart.set(start, { start, end, text: this.newName });
    }
  }

  /** `<param name="old">` style references in the doc comment above `owner`. */
  private renameDocNames(owner: Node, tags: readonly string[]): void {
    for (const block of precedingDocBlocks(this.model.source, owner.startIndex)) {
      this.renameDocNamesInText(block.start, block.text, tags);
    }
  }

  private renameDocNamesInText(offset: number, text: string, tags: readonly string[]): void {
    const pattern = new RegExp(
      `(<(?:${tags.join('|')})\\b[^>]*?\\bname\\s*=\\s*["'])(${escapeRegExp(this.oldName)})(?=["'])`,
      'g'
    );
    for (const match of text.matchAll(pattern)) {
      const start = offset + (match.index ?? 0) + match[1].length;
      this.editsByStart.set(start, { start, end: start + this.oldName.length, text: this.newName });
    }
  }

  private occurrences(name: string): readonly Occurrence[] {
    return this.model.occurrencesByName.get(name) ?? [];
  }

  private symbolsNamed(name: string): readonly DeclaredSymbol[] {
    return this.model.symbolsByName.get(name) ?? [];
  }

  private occurrencesIn(region: Node, name: string): Occurrence[] {
    return this.occurrences(name).filter((occurrence) => spans(region, occurrence.start, occurrence.end));
  }

  private edit(occurrence: Occurrence): void {
    this.editsByStart.set(occurrence.start, { start: occurrence.start, end: occurrence.end, text: this.newName });
  }
}

/** Name of a (possibly generic or qualified) type syntax, without type arguments. */
function typeName(node: Node | null): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'identifier') {
    return identifierName(node.text);
  }

  if (node.type === 'generic_name') {
    return typeName(node.namedChildren[0] ?? null);
  }

  if (node.type === 'qualified_name' || node.type === 'alias_qualified_name') {
    return typeName(node.childForFieldName('name'));
  }

  return undefined;
}

/**
 * Whether the names `path` (`A.B.C`) may designate `type`: they end the chain of the namespaces and
 * types declaring it (`App.Settings` and `Settings` for `namespace App { class Settings }`).
 */
function designatesType(path: readonly string[], type: TypeInfo): boolean {
  const chain: string[] = [];
  for (let current: TypeInfo | undefined = type; current; current = current.parent) {
    chain.unshift(current.name);
  }

  for (let node = type.node.parent; node; node = node.parent) {
    if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
      chain.unshift(...(namePath(node.childForFieldName('name')) ?? ['']));
    }
  }

  const offset = chain.length - path.length;

  return offset >= 0 && path.every((name, index) => name === chain[offset + index]);
}

/** `///` lines directly above `offset` (a declaration start). */
function precedingDocBlocks(source: string, offset: number): { start: number; text: string }[] {
  const blocks: { start: number; text: string }[] = [];
  let lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  if (source.slice(lineStart, offset).trim()) {
    return blocks;
  }

  while (lineStart > 0) {
    const previousEnd = lineStart - 1;
    const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1;
    const line = source.slice(previousStart, previousEnd);
    const trimmed = line.trim();
    if (!trimmed.startsWith('///')) {
      break;
    }

    blocks.push({ start: previousStart, text: line });
    lineStart = previousStart;
  }

  return blocks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
