import { parseCSharp } from '../parser';
import { memoizeBySource } from '../sourceCache';
import { lex } from '../syntax/lexer';
import { Node } from '../syntax/node';
import { NamingAccessibility, NamingModifier, NamingSymbolKind, NamingSymbolTraits } from './namingRules';

/**
 * A syntactic model of one C# file for naming cleanup: declared symbols with the traits naming
 * rules match on, their scopes, and every identifier occurrence classified by the role it plays.
 * It is deliberately conservative: an identifier whose role cannot be told from syntax alone is
 * classified `unknown`, and members whose body the tolerant parser could not fully structure are
 * flagged opaque, so a rename touching either is refused rather than guessed.
 */

export interface TypeInfo {
  readonly node: Node;
  readonly name: string;
  readonly kind: NamingSymbolKind;
  readonly parent: TypeInfo | undefined;
  readonly isPartial: boolean;
  readonly hasBaseList: boolean;
  /** Names of members and nested types declared directly in the type. */
  readonly memberNames: ReadonlySet<string>;
}

export type SymbolCategory = 'namespace' | 'type' | 'member' | 'local' | 'parameter' | 'typeParameter' | 'range';

export interface DeclaredSymbol extends NamingSymbolTraits {
  readonly category: SymbolCategory;
  /** Name without a verbatim `@`. */
  readonly name: string;
  readonly nameNode: Node;
  /** Innermost type containing the declaration (for types: the enclosing type, if nested). */
  readonly type: TypeInfo | undefined;
  /** Parameters and type parameters: the declaration owning them. */
  readonly owner?: Node;
  /** Local-ish symbols: the node spanning the scope in which the name is visible. */
  readonly region?: Node;
  /** False when the scope could only be approximated (out variables, pattern designations). */
  readonly regionPrecise: boolean;
  /** Source text of the declared type, when there is one. */
  readonly declaredType?: string;
  /** Whether Roslyn's naming analyzer would inspect the symbol at all. */
  readonly analyzable: boolean;
  /** Why the symbol can never be renamed by an in-file syntactic rename. */
  readonly blocker?: string;
}

export type Receiver =
  | { readonly kind: 'this' }
  | { readonly kind: 'base' }
  | { readonly kind: 'conditional' }
  | { readonly kind: 'expression'; readonly name?: string; readonly qualifiedName?: string };

export type OccurrenceRole =
  | { readonly kind: 'declaration' }
  | { readonly kind: 'reference' }
  | { readonly kind: 'tupleElement' }
  | { readonly kind: 'type' }
  | { readonly kind: 'member'; readonly receiver: Receiver }
  | { readonly kind: 'namedArgument'; readonly call: Node }
  | { readonly kind: 'initializerMember'; readonly creation: Node | undefined }
  | { readonly kind: 'skip' }
  | { readonly kind: 'projection' }
  | { readonly kind: 'unknown' };

export interface Occurrence {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** The identifier node; absent for identifiers inside interpolated-string holes. */
  readonly node?: Node;
  readonly role: OccurrenceRole;
  /** Top-level member (or type header) containing the occurrence. */
  readonly memberRoot: Node | undefined;
}

export interface SourceModel {
  readonly source: string;
  readonly root: Node;
  readonly types: readonly TypeInfo[];
  readonly symbols: readonly DeclaredSymbol[];
  readonly symbolByNameNode: ReadonlyMap<Node, DeclaredSymbol>;
  readonly occurrencesByName: ReadonlyMap<string, readonly Occurrence[]>;
  /** Members containing constructs the parser could not structure reliably. */
  readonly opaqueRoots: ReadonlySet<Node>;
  /** `///` and `/** *\/` comments. */
  readonly docComments: readonly Node[];
}

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'struct_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

const MEMBER_CONTAINERS = new Set([
  'declaration_list',
  'enum_member_declaration_list',
  'compilation_unit',
  'file_scoped_namespace_declaration',
]);

/** Contextual keywords the parser represents as identifiers; symbols so named are never renamed. */
export const CONTEXTUAL_KEYWORDS = new Set([
  'add', 'alias', 'allows', 'and', 'ascending', 'async', 'await', 'by', 'descending', 'dynamic',
  'equals', 'field', 'file', 'from', 'get', 'global', 'group', 'init', 'into', 'join', 'let', 'managed',
  'nameof', 'nint', 'not', 'notnull', 'nuint', 'on', 'or', 'orderby', 'partial', 'record', 'remove',
  'required', 'scoped', 'select', 'set', 'unmanaged', 'value', 'var', 'when', 'where', 'with', 'yield',
]);

/** Expression kinds C# accepts as an expression statement; anything else is a misparse. */
const STATEMENT_EXPRESSIONS = new Set([
  'invocation_expression',
  'assignment_expression',
  'prefix_unary_expression',
  'postfix_unary_expression',
  'await_expression',
  'object_creation_expression',
  'implicit_object_creation_expression',
  'conditional_access_expression',
]);

/** Everything a well-formed `where T : ...` clause consists of. */
const CONSTRAINT_CLAUSE_PARTS = new Set([
  'identifier',
  'generic_name',
  'qualified_name',
  'alias_qualified_name',
  'predefined_type',
  'nullable_type',
  'array_type',
  'type_argument_list',
  'comment',
  ':',
  ',',
  '(',
  ')',
  '<',
  '>',
  '?',
  'new',
  'class',
  'struct',
  'default',
]);

/** Parents under which a bare identifier child is an ordinary expression operand. */
const EXPRESSION_PARENTS = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'for_each_statement',
  'switch_statement',
  'switch_expression',
  'lock_statement',
  'using_statement',
  'return_statement',
  'throw_statement',
  'throw_expression',
  'yield_statement',
  'arrow_expression_clause',
  'equals_value_clause',
  'parenthesized_expression',
  'conditional_expression',
  'prefix_unary_expression',
  'postfix_unary_expression',
  'await_expression',
  'ref_expression',
  'checked_expression',
  'unchecked_expression',
  'array_rank_specifier',
  'collection_expression',
  'enum_member_declaration',
  'parameter',
  'assignment_expression',
]);

const TYPE_PARENTS = new Set([
  'type_argument_list',
  'base_list',
  'explicit_interface_specifier',
  'typeof_expression',
  'sizeof_expression',
  'default_expression',
  'nullable_type',
  'array_type',
  'tuple_type',
  'implicit_type',
  'type_parameter_constraints_clause',
]);

const DECLARATION_ROLE: OccurrenceRole = { kind: 'declaration' };
const REFERENCE_ROLE: OccurrenceRole = { kind: 'reference' };
const TYPE_ROLE: OccurrenceRole = { kind: 'type' };
const SKIP_ROLE: OccurrenceRole = { kind: 'skip' };
const UNKNOWN_ROLE: OccurrenceRole = { kind: 'unknown' };

/** The model of `source`. Shared for the same text (see `sourceCache.ts`): callers must not modify it. */
export const buildSourceModel: (source: string) => SourceModel = memoizeBySource((source) => {
  const root = parseCSharp(source).rootNode;
  const builder = new ModelBuilder(source);
  builder.visit(root);

  return builder.finish(root);
});

/** Identifier text without the verbatim `@`. */
export function identifierName(text: string): string {
  return text.startsWith('@') ? text.slice(1) : text;
}

/** The innermost type whose declaration spans `offset`. */
export function typeAt(model: SourceModel, offset: number): TypeInfo | undefined {
  let best: TypeInfo | undefined;
  for (const type of model.types) {
    if (type.node.startIndex <= offset && offset < type.node.endIndex) {
      if (!best || type.node.endIndex - type.node.startIndex < best.node.endIndex - best.node.startIndex) {
        best = type;
      }
    }
  }

  return best;
}

export function spans(outer: Node, start: number, end: number): boolean {
  return outer.startIndex <= start && end <= outer.endIndex;
}

class ModelBuilder {
  private readonly types: TypeInfo[] = [];
  private readonly typeByNode = new Map<Node, TypeInfo>();
  private readonly symbols: DeclaredSymbol[] = [];
  private readonly declarationNames = new Map<Node, DeclaredSymbol>();
  private readonly opaqueRoots = new Set<Node>();
  private readonly seen = new Set<Node>();
  private readonly identifiers: Node[] = [];
  private readonly interpolations: Node[] = [];
  private readonly docComments: Node[] = [];

  constructor(private readonly source: string) {}

  visit(node: Node): void {
    // The parser can share one type node between a declaration and its variable_declaration.
    if (this.seen.has(node)) {
      return;
    }

    this.seen.add(node);
    this.declare(node);
    this.detectMisparse(node);

    if (node.type === 'identifier') {
      this.identifiers.push(node);
    } else if (node.type === 'interpolated_string_expression') {
      this.interpolations.push(node);
    } else if (node.type === 'comment' && /^\/(?:\/\/|\*\*)/.test(node.text)) {
      this.docComments.push(node);
    }

    for (const child of node.children) {
      this.visit(child);
    }
  }

  finish(root: Node): SourceModel {
    const occurrencesByName = new Map<string, Occurrence[]>();
    const add = (occurrence: Occurrence) => {
      const list = occurrencesByName.get(occurrence.name);
      if (list) {
        list.push(occurrence);
      } else {
        occurrencesByName.set(occurrence.name, [occurrence]);
      }
    };

    for (const identifier of this.identifiers) {
      add({
        name: identifierName(identifier.text),
        start: identifier.startIndex,
        end: identifier.endIndex,
        node: identifier,
        role: this.declarationNames.has(identifier) ? DECLARATION_ROLE : classify(identifier),
        memberRoot: memberRoot(identifier),
      });
    }

    for (const literal of this.interpolations) {
      for (const occurrence of interpolationOccurrences(this.source, literal.startIndex, literal.endIndex)) {
        add({ ...occurrence, memberRoot: memberRoot(literal) });
      }
    }

    return {
      source: this.source,
      root,
      types: this.types,
      symbols: this.symbols,
      symbolByNameNode: this.declarationNames,
      occurrencesByName,
      opaqueRoots: this.opaqueRoots,
      docComments: this.docComments,
    };
  }

  private declare(node: Node): void {
    switch (node.type) {
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration':
        this.declareNamespace(node);
        break;
      case 'class_declaration':
      case 'struct_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration':
        this.declareType(node);
        break;
      case 'delegate_declaration':
        this.declareDelegate(node);
        break;
      case 'field_declaration':
      case 'event_field_declaration':
        this.declareFields(node);
        break;
      case 'property_declaration':
      case 'event_declaration':
        this.declarePropertyOrEvent(node);
        break;
      case 'method_declaration':
        this.declareMethod(node);
        break;
      case 'constructor_declaration':
      case 'indexer_declaration':
      case 'operator_declaration':
      case 'conversion_operator_declaration':
        this.declareOtherMember(node);
        break;
      case 'enum_member_declaration':
        this.declareEnumMember(node);
        break;
      case 'local_function_statement':
        this.declareLocalFunction(node);
        break;
      case 'lambda_expression':
      case 'anonymous_method_expression':
        this.declareAnonymousFunction(node);
        break;
      case 'local_declaration_statement':
        this.declareLocals(node);
        break;
      case 'for_statement':
      case 'for_each_statement':
      case 'using_statement':
      case 'fixed_statement':
      case 'catch_clause':
        this.declareStatementVariables(node);
        break;
      case 'declaration_expression':
        this.declareExpressionVariable(node);
        break;
      case 'from_clause':
        this.declareRangeVariable(node);
        break;
    }
  }

  private add(symbol: DeclaredSymbol): void {
    // Tolerant parses can reach one declaration through two parents (e.g. `async (x) => ...`).
    if (this.declarationNames.has(symbol.nameNode)) {
      return;
    }

    this.symbols.push(symbol);
    this.declarationNames.set(symbol.nameNode, symbol);
  }

  private declareNamespace(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const parts = name.type === 'identifier' ? [name] : name.descendantsOfType('identifier');
    for (const part of parts) {
      this.add({
        category: 'namespace',
        kind: 'namespace',
        name: identifierName(part.text),
        nameNode: part,
        accessibility: 'public',
        modifiers: new Set(),
        type: undefined,
        regionPrecise: false,
        analyzable: true,
        blocker: 'namespace names are not renamed',
      });
    }
  }

  private declareType(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const parent = this.containingType(node);
    const modifiers = modifierTexts(node);
    const kind: NamingSymbolKind =
      node.type === 'record_declaration'
        ? node.children.some((child) => child.type === 'struct')
          ? 'struct'
          : 'class'
        : (node.type.replace('_declaration', '') as NamingSymbolKind);
    const accessibility = declaredAccessibility(modifiers, parent ? 'private' : 'internal');
    const body = node.childForFieldName('body');
    const memberNames = new Set<string>();
    for (const member of body?.namedChildren ?? []) {
      for (const memberName of declaredMemberNames(member)) {
        memberNames.add(memberName);
      }
    }

    const type: TypeInfo = {
      node,
      name: identifierName(name.text),
      kind,
      parent,
      isPartial: modifiers.has('partial'),
      hasBaseList: node.children.some((child) => child.type === 'base_list'),
      memberNames,
    };
    this.types.push(type);
    this.typeByNode.set(node, type);

    const symbolModifiers = new Set<NamingModifier>();
    if (modifiers.has('static')) {
      symbolModifiers.add('static');
    }

    if (modifiers.has('abstract') || kind === 'interface') {
      symbolModifiers.add('abstract');
    }

    this.add({
      category: 'type',
      kind,
      name: type.name,
      nameNode: name,
      accessibility,
      modifiers: symbolModifiers,
      type: parent,
      regionPrecise: false,
      analyzable: true,
      blocker: 'type names are not renamed',
    });

    this.declareTypeParameters(node, accessibility, type, type.isPartial ? 'it is declared in a partial type' : undefined);

    const primaryParameters = node.childForFieldName('parameters');
    if (primaryParameters) {
      // Roslyn ignores positional record parameters: they also declare properties.
      const isRecord = node.type === 'record_declaration';
      this.declareParameters(primaryParameters, {
        accessibility: 'public',
        owner: node,
        type,
        analyzable: !isRecord,
        blocker: 'primary constructor parameters may be referenced by named arguments in other files',
        // Members of the type shadow primary constructor parameters, so their scope is not exact.
        regionPrecise: false,
      });
    }
  }

  private declareDelegate(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const parent = this.containingType(node);
    const accessibility = declaredAccessibility(modifierTexts(node), parent ? 'private' : 'internal');
    this.add({
      category: 'type',
      kind: 'delegate',
      name: identifierName(name.text),
      nameNode: name,
      accessibility,
      modifiers: new Set(),
      type: parent,
      regionPrecise: false,
      analyzable: true,
      blocker: 'type names are not renamed',
    });
    this.declareTypeParameters(node, accessibility, parent, undefined);

    const parameters = node.childForFieldName('parameters');
    if (parameters) {
      // Delegate parameters belong to the public `Invoke` method.
      this.declareParameters(parameters, {
        accessibility: 'public',
        owner: node,
        type: parent,
        analyzable: true,
        blocker: 'delegate parameters may be referenced by named arguments in other files',
      });
    }
  }

  private declareFields(node: Node): void {
    const type = this.containingType(node);
    const modifiers = modifierTexts(node);
    const accessibility = declaredAccessibility(modifiers, defaultMemberAccessibility(type));
    const symbolModifiers = new Set<NamingModifier>();
    if (modifiers.has('const')) {
      symbolModifiers.add('const').add('static');
    }

    if (modifiers.has('static')) {
      symbolModifiers.add('static');
    }

    if (modifiers.has('readonly')) {
      symbolModifiers.add('readonly');
    }

    if (node.type === 'event_field_declaration' && isInterfaceMemberAbstract(type, modifiers, false)) {
      symbolModifiers.add('abstract');
    }

    const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration');
    const declaredType = declaration?.childForFieldName('type')?.text;
    for (const declarator of declaration?.namedChildren ?? []) {
      const name = declarator.type === 'variable_declarator' ? declarator.childForFieldName('name') : null;
      if (!name) {
        continue;
      }

      this.add({
        category: 'member',
        kind: node.type === 'event_field_declaration' ? 'event' : 'field',
        name: identifierName(name.text),
        nameNode: name,
        accessibility,
        modifiers: symbolModifiers,
        type,
        regionPrecise: false,
        declaredType,
        analyzable: true,
        blocker: memberBlocker(type, accessibility, modifiers),
      });
    }
  }

  private declarePropertyOrEvent(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const type = this.containingType(node);
    const modifiers = modifierTexts(node);
    const accessibility = declaredAccessibility(modifiers, defaultMemberAccessibility(type));
    const explicit = node.children.some((child) => child.type === 'explicit_interface_specifier');
    const symbolModifiers = new Set<NamingModifier>();
    if (modifiers.has('static')) {
      symbolModifiers.add('static');
    }

    if (isInterfaceMemberAbstract(type, modifiers, hasAccessorBodies(node))) {
      symbolModifiers.add('abstract');
    }

    this.add({
      category: 'member',
      kind: node.type === 'event_declaration' ? 'event' : 'property',
      name: identifierName(name.text),
      nameNode: name,
      accessibility,
      modifiers: symbolModifiers,
      type,
      regionPrecise: false,
      declaredType: node.childForFieldName('type')?.text,
      analyzable: !explicit && !modifiers.has('override') && !modifiers.has('extern'),
      blocker: memberBlocker(type, accessibility, modifiers),
    });
  }

  private declareMethod(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const type = this.containingType(node);
    const modifiers = modifierTexts(node);
    const accessibility = declaredAccessibility(modifiers, defaultMemberAccessibility(type));
    const explicit = node.children.some((child) => child.type === 'explicit_interface_specifier');
    const hasBody = Boolean(node.childForFieldName('body'));
    const methodName = identifierName(name.text);
    const symbolModifiers = new Set<NamingModifier>();
    if (modifiers.has('static')) {
      symbolModifiers.add('static');
    }

    if (modifiers.has('async')) {
      symbolModifiers.add('async');
    }

    if (isInterfaceMemberAbstract(type, modifiers, hasBody)) {
      symbolModifiers.add('abstract');
    }

    const isEntryPoint = methodName === 'Main' && modifiers.has('static');
    let blocker = memberBlocker(type, accessibility, modifiers);
    if (!blocker && modifiers.has('partial')) {
      blocker = 'it is a partial method';
    }

    this.add({
      category: 'member',
      kind: 'method',
      name: methodName,
      nameNode: name,
      accessibility,
      modifiers: symbolModifiers,
      type,
      regionPrecise: false,
      declaredType: node.childForFieldName('type')?.text,
      analyzable: !explicit && !modifiers.has('override') && !modifiers.has('extern') && !isEntryPoint,
      blocker,
    });

    let parameterBlocker: string | undefined;
    if (explicit) {
      parameterBlocker = 'it is a parameter of an explicit interface implementation';
    } else if (modifiers.has('extern')) {
      parameterBlocker = 'it is a parameter of an extern method';
    } else if (accessibility !== 'private') {
      parameterBlocker = 'parameters of non-private methods may be referenced by named arguments in other files';
    } else {
      parameterBlocker = blocker;
    }

    this.declareTypeParameters(node, accessibility, type, type?.isPartial || modifiers.has('partial') ? blocker : undefined);
    const parameters = node.childForFieldName('parameters');
    if (parameters) {
      this.declareParameters(parameters, { accessibility, owner: node, type, analyzable: true, blocker: parameterBlocker });
    }
  }

  private declareOtherMember(node: Node): void {
    const type = this.containingType(node);
    const modifiers = modifierTexts(node);
    const accessibility =
      node.type === 'operator_declaration' || node.type === 'conversion_operator_declaration'
        ? 'public'
        : declaredAccessibility(modifiers, defaultMemberAccessibility(type));
    const parameters = node.childForFieldName('parameters');
    if (!parameters) {
      return;
    }

    let blocker: string | undefined;
    if (node.type !== 'constructor_declaration') {
      blocker = 'parameters of indexers and operators are not renamed';
    } else if (accessibility !== 'private') {
      blocker = 'parameters of non-private constructors may be referenced by named arguments in other files';
    } else if (type?.isPartial) {
      blocker = 'it is declared in a partial type';
    }

    this.declareParameters(parameters, { accessibility, owner: node, type, analyzable: true, blocker });
  }

  private declareEnumMember(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    this.add({
      category: 'member',
      kind: 'field',
      name: identifierName(name.text),
      nameNode: name,
      accessibility: 'public',
      modifiers: new Set<NamingModifier>(['const', 'static']),
      type: this.containingType(node),
      regionPrecise: false,
      analyzable: true,
      blocker: 'enum members are public and may be referenced from other files',
    });
  }

  private declareLocalFunction(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name) {
      return;
    }

    const modifiers = modifierTexts(node);
    const symbolModifiers = new Set<NamingModifier>();
    if (modifiers.has('static')) {
      symbolModifiers.add('static');
    }

    if (modifiers.has('async')) {
      symbolModifiers.add('async');
    }

    const type = this.containingType(node);
    const region = statementScope(node);
    this.add({
      category: 'local',
      kind: 'local_function',
      name: identifierName(name.text),
      nameNode: name,
      accessibility: 'local',
      modifiers: symbolModifiers,
      type,
      region,
      regionPrecise: Boolean(region),
      declaredType: node.childForFieldName('type')?.text,
      analyzable: true,
      blocker: region ? undefined : 'local functions in top-level statements are not renamed',
    });

    this.declareTypeParameters(node, 'local', type, undefined);
    const parameters = node.childForFieldName('parameters');
    if (parameters) {
      this.declareParameters(parameters, { accessibility: 'local', owner: node, type, analyzable: true });
    }
  }

  private declareAnonymousFunction(node: Node): void {
    const parameters = node.childForFieldName('parameters');
    if (!parameters) {
      return;
    }

    const type = this.containingType(node);
    if (parameters.type === 'identifier') {
      this.addParameter(parameters, undefined, { accessibility: 'local', owner: node, type, analyzable: true });
    } else {
      this.declareParameters(parameters, { accessibility: 'local', owner: node, type, analyzable: true });
    }
  }

  private declareLocals(node: Node): void {
    const modifiers = modifierTexts(node);
    const region = statementScope(node);
    const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration');
    if (declaration) {
      this.declareVariables(declaration, {
        region,
        modifiers: new Set<NamingModifier>(modifiers.has('const') ? ['const'] : []),
        blocker: region ? undefined : 'locals of top-level statements are not renamed',
      });
    }
  }

  private declareStatementVariables(node: Node): void {
    const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration');
    if (declaration) {
      this.declareVariables(declaration, { region: node, modifiers: new Set() });
    }
  }

  private declareVariables(
    declaration: Node,
    options: { region: Node | undefined; modifiers: ReadonlySet<NamingModifier>; blocker?: string }
  ): void {
    const declaredType = declaration.childForFieldName('type')?.text;
    for (const declarator of declaration.namedChildren) {
      const name = declarator.type === 'variable_declarator' ? declarator.childForFieldName('name') : null;
      if (!name) {
        continue;
      }

      this.add({
        category: 'local',
        kind: 'local',
        name: identifierName(name.text),
        nameNode: name,
        accessibility: 'local',
        modifiers: options.modifiers,
        type: this.containingType(declaration),
        region: options.region,
        regionPrecise: Boolean(options.region),
        declaredType,
        analyzable: true,
        blocker: options.blocker,
      });
    }
  }

  private declareExpressionVariable(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name || name.type !== 'identifier') {
      return;
    }

    this.add({
      category: 'local',
      kind: 'local',
      name: identifierName(name.text),
      nameNode: name,
      accessibility: 'local',
      modifiers: new Set(),
      type: this.containingType(node),
      region: enclosingBlock(node),
      regionPrecise: false,
      declaredType: node.childForFieldName('type')?.text,
      analyzable: true,
      blocker: 'variables declared inside an expression have a scope the cleanup cannot determine syntactically',
    });
  }

  private declareRangeVariable(node: Node): void {
    const name = node.childForFieldName('name');
    if (!name || name.type !== 'identifier' || !node.parent) {
      return;
    }

    this.add({
      category: 'range',
      kind: 'local',
      name: identifierName(name.text),
      nameNode: name,
      accessibility: 'local',
      modifiers: new Set(),
      type: this.containingType(node),
      region: node.parent,
      regionPrecise: true,
      analyzable: false,
    });
  }

  private declareTypeParameters(
    owner: Node,
    accessibility: NamingAccessibility,
    type: TypeInfo | undefined,
    blocker: string | undefined
  ): void {
    const list = owner.namedChildren.find((child) => child.type === 'type_parameter_list');
    for (const parameter of list?.namedChildren ?? []) {
      if (parameter.type !== 'identifier') {
        continue;
      }

      this.add({
        category: 'typeParameter',
        kind: 'type_parameter',
        name: identifierName(parameter.text),
        nameNode: parameter,
        accessibility,
        modifiers: new Set(),
        type,
        owner,
        region: owner,
        regionPrecise: true,
        analyzable: true,
        blocker,
      });
    }
  }

  private declareParameters(list: Node, options: ParameterOptions): void {
    for (const parameter of list.namedChildren) {
      if (parameter.type !== 'parameter') {
        continue;
      }

      const name = parameter.childForFieldName('name');
      if (name) {
        this.addParameter(name, parameter.childForFieldName('type')?.text, options);
      }
    }
  }

  private addParameter(name: Node, declaredType: string | undefined, options: ParameterOptions): void {
    this.add({
      category: 'parameter',
      kind: 'parameter',
      name: identifierName(name.text),
      nameNode: name,
      accessibility: options.accessibility,
      modifiers: new Set(),
      type: options.type,
      owner: options.owner,
      region: options.owner,
      regionPrecise: options.regionPrecise ?? true,
      declaredType,
      analyzable: options.analyzable,
      blocker: options.blocker,
    });
  }

  private containingType(node: Node): TypeInfo | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (TYPE_DECLARATIONS.has(current.type)) {
        return this.typeByNode.get(current);
      }
    }

    return undefined;
  }

  /** Marks the enclosing member opaque when the parser evidently misread part of it. */
  private detectMisparse(node: Node): void {
    if (isMisparse(node)) {
      const rootNode = memberRoot(node);
      if (rootNode) {
        this.opaqueRoots.add(rootNode);
      }
    }
  }
}

interface ParameterOptions {
  readonly accessibility: NamingAccessibility;
  readonly owner: Node;
  readonly type: TypeInfo | undefined;
  readonly analyzable: boolean;
  readonly blocker?: string;
  readonly regionPrecise?: boolean;
}

function isMisparse(node: Node): boolean {
  switch (node.type) {
    case 'expression_statement': {
      const named = node.namedChildren.filter((child) => child.type !== 'comment');
      return named.length !== 1 || !STATEMENT_EXPRESSIONS.has(named[0].type);
    }
    case 'invocation_expression': {
      // `var (a, b) = ...` deconstruction reads as a call to `var`.
      const callee = node.childForFieldName('function');
      return callee?.type === 'identifier' && callee.text === 'var';
    }
    case 'tuple_expression':
      // `(int a, var b) = ...` deconstruction reads as a tuple of types and names.
      return node.namedChildren.some(
        (child) =>
          child.type === 'predefined_type' ||
          child.type === 'declaration_expression' ||
          (child.type === 'identifier' && child.text === 'var')
      );
    case 'fixed_statement':
      return !node.namedChildren.some((child) => child.type === 'variable_declaration');
    case 'argument':
      // `M((double)x.Y / z)` can come out as an empty argument next to a bogus declaration.
      return node.namedChildren.every((child) => child.type === 'comment');
    case 'tuple_type':
      return node.namedChildren.filter((child) => child.type !== 'comment').length < 2;
    case 'type_parameter_constraints_clause':
      // A constraint clause can swallow a following `=> expression` body as a flat token run.
      return node.children.some((child) => !CONSTRAINT_CLAUSE_PARTS.has(child.type));
    case 'labeled_statement':
    case 'goto_statement':
    case 'incomplete_declaration':
      return true;
    default:
      return false;
  }
}

function modifierTexts(node: Node): Set<string> {
  return new Set(node.namedChildren.filter((child) => child.type === 'modifier').map((child) => child.text.trim()));
}

function declaredAccessibility(modifiers: ReadonlySet<string>, fallback: NamingAccessibility): NamingAccessibility {
  const isPrivate = modifiers.has('private');
  const isProtected = modifiers.has('protected');
  const isInternal = modifiers.has('internal') || modifiers.has('file');

  if (modifiers.has('public')) {
    return 'public';
  }

  if (isProtected && isInternal) {
    return 'protected_internal';
  }

  if (isPrivate && isProtected) {
    return 'private_protected';
  }

  if (isProtected) {
    return 'protected';
  }

  if (isInternal) {
    return 'internal';
  }

  return isPrivate ? 'private' : fallback;
}

function defaultMemberAccessibility(type: TypeInfo | undefined): NamingAccessibility {
  return type?.kind === 'interface' ? 'public' : 'private';
}

/** Interface members without a body (and not static) are implicitly abstract. */
function isInterfaceMemberAbstract(type: TypeInfo | undefined, modifiers: ReadonlySet<string>, hasBody: boolean): boolean {
  if (modifiers.has('abstract')) {
    return true;
  }

  return type?.kind === 'interface' && !hasBody && !modifiers.has('static');
}

function hasAccessorBodies(node: Node): boolean {
  if (node.childForFieldName('value')?.type === 'arrow_expression_clause') {
    return true;
  }

  const accessors = node.childForFieldName('accessors');

  return (accessors?.namedChildren ?? []).some((accessor) => Boolean(accessor.childForFieldName('body')));
}

function memberBlocker(
  type: TypeInfo | undefined,
  accessibility: NamingAccessibility,
  modifiers: ReadonlySet<string>
): string | undefined {
  if (!type) {
    return 'it is not declared in a type';
  }

  if (accessibility !== 'private') {
    return 'it is not private and may be referenced from other files';
  }

  if (type.isPartial) {
    return 'it is declared in a partial type';
  }

  if (modifiers.has('extern')) {
    return 'it is extern';
  }

  return undefined;
}

function declaredMemberNames(member: Node): string[] {
  if (member.type === 'field_declaration' || member.type === 'event_field_declaration') {
    const declaration = member.namedChildren.find((child) => child.type === 'variable_declaration');
    return (declaration?.namedChildren ?? [])
      .map((declarator) => declarator.childForFieldName('name')?.text)
      .filter((name): name is string => Boolean(name))
      .map(identifierName);
  }

  const name = member.childForFieldName('name');

  return name && name.type === 'identifier' && member.type !== 'constructor_declaration' && member.type !== 'destructor_declaration'
    ? [identifierName(name.text)]
    : [];
}

/** Scope of a local declared by a statement: the enclosing block or switch section list. */
function statementScope(node: Node): Node | undefined {
  const parent = node.parent;

  return parent && (parent.type === 'block' || parent.type === 'switch_body') ? parent : undefined;
}

function enclosingBlock(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'block' || current.type === 'switch_body') {
      return current;
    }

    if (MEMBER_CONTAINERS.has(current.parent?.type ?? '')) {
      return current;
    }
  }

  return undefined;
}

function memberRoot(node: Node): Node | undefined {
  let current: Node | null = node;
  while (current && current.parent && !MEMBER_CONTAINERS.has(current.parent.type)) {
    current = current.parent;
  }

  return current ?? undefined;
}

function fieldOf(parent: Node, child: Node): string | undefined {
  if (parent.fields) {
    for (const [name, value] of parent.fields) {
      if (value === child) {
        return name;
      }
    }
  }

  return undefined;
}

/** Role of an identifier (or generic name) that is not itself a recognized declaration name. */
function classify(node: Node): OccurrenceRole {
  const parent = node.parent;
  if (!parent) {
    return UNKNOWN_ROLE;
  }

  const field = fieldOf(parent, node);
  if (field === 'type') {
    return TYPE_ROLE;
  }

  switch (parent.type) {
    case 'generic_name':
      return parent.namedChildren[0] === node ? classify(parent) : UNKNOWN_ROLE;
    case 'member_access_expression':
      return field === 'name' ? memberRole(parent) : field === 'expression' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'conditional_access_expression':
      return field === 'name'
        ? { kind: 'member', receiver: { kind: 'conditional' } }
        : field === 'expression'
          ? REFERENCE_ROLE
          : UNKNOWN_ROLE;
    case 'invocation_expression':
      return field === 'function' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'argument':
      return field === 'name' ? namedArgumentRole(parent) : REFERENCE_ROLE;
    case 'assignment_expression':
      return field === 'left' ? assignmentTargetRole(parent) : REFERENCE_ROLE;
    case 'binary_expression':
      if (field === 'right' && parent.children.some((child) => child.type === 'as')) {
        return TYPE_ROLE;
      }

      return field === 'left' || field === 'right' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'cast_expression':
      return field === 'value' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'is_pattern_expression':
      return field === 'expression' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'element_access_expression':
      return field === 'expression' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'lambda_expression':
      return field === 'body' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'property_declaration':
      return field === 'value' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'from_clause':
      return field === 'source' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'query_where_clause':
      return field === 'condition' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'select_clause':
      return field === 'expression' ? REFERENCE_ROLE : UNKNOWN_ROLE;
    case 'initializer_expression':
      return parent.parent?.type === 'anonymous_object_creation_expression' ? { kind: 'projection' } : REFERENCE_ROLE;
    case 'tuple_expression':
      return { kind: 'tupleElement' };
    case 'attribute':
      return field === 'name' ? TYPE_ROLE : UNKNOWN_ROLE;
    case 'qualified_name':
      return field === 'qualifier' ? TYPE_ROLE : SKIP_ROLE;
    case 'alias_qualified_name':
    case 'using_directive':
      return SKIP_ROLE;
    case 'constructor_declaration':
    case 'destructor_declaration':
      return field === 'name' ? SKIP_ROLE : UNKNOWN_ROLE;
  }

  if (TYPE_PARENTS.has(parent.type)) {
    return TYPE_ROLE;
  }

  if (field === undefined && EXPRESSION_PARENTS.has(parent.type)) {
    return REFERENCE_ROLE;
  }

  return UNKNOWN_ROLE;
}

function memberRole(access: Node): OccurrenceRole {
  const initializer = access.parent;
  if (initializer?.type === 'initializer_expression' && initializer.parent?.type === 'anonymous_object_creation_expression') {
    return { kind: 'projection' };
  }

  const receiver = access.childForFieldName('expression');
  if (!receiver) {
    return UNKNOWN_ROLE;
  }

  if (receiver.type === 'this_expression') {
    return { kind: 'member', receiver: { kind: 'this' } };
  }

  if (receiver.type === 'base_expression') {
    return { kind: 'member', receiver: { kind: 'base' } };
  }

  return { kind: 'member', receiver: expressionReceiver(receiver) };
}

function expressionReceiver(receiver: Node): Receiver {
  if (receiver.type === 'identifier') {
    return { kind: 'expression', name: identifierName(receiver.text) };
  }

  if (receiver.type === 'generic_name' || receiver.type === 'qualified_name' || receiver.type === 'member_access_expression') {
    const last = receiver.type === 'generic_name' ? receiver.namedChildren[0] : receiver.childForFieldName('name');
    const lastName = last?.type === 'generic_name' ? last.namedChildren[0] : last;
    if (lastName?.type === 'identifier') {
      return { kind: 'expression', qualifiedName: identifierName(lastName.text) };
    }
  }

  return { kind: 'expression' };
}

function namedArgumentRole(argument: Node): OccurrenceRole {
  const list = argument.parent;
  const call = list?.parent;

  return list && call && (list.type === 'argument_list' || list.type === 'bracketed_argument_list')
    ? { kind: 'namedArgument', call }
    : UNKNOWN_ROLE;
}

function assignmentTargetRole(assignment: Node): OccurrenceRole {
  const container = assignment.parent;
  if (container?.type === 'initializer_expression') {
    const creation = container.parent;
    if (
      creation?.type === 'object_creation_expression' ||
      creation?.type === 'implicit_object_creation_expression' ||
      creation?.type === 'anonymous_object_creation_expression'
    ) {
      return { kind: 'initializerMember', creation };
    }

    if (creation?.type === 'assignment_expression') {
      return { kind: 'initializerMember', creation: undefined };
    }

    return REFERENCE_ROLE;
  }

  // `[Attribute(Name = value)]` names an attribute property.
  if (container?.type === 'argument' && container.parent?.parent?.type === 'attribute') {
    return SKIP_ROLE;
  }

  return REFERENCE_ROLE;
}

type HoleOccurrence = Omit<Occurrence, 'memberRoot'>;

/** Tokens inside an interpolation hole that make a token-level reading unreliable. */
const RISKY_HOLE_TOKENS = new Set([
  '=>', 'new', 'is', 'as', 'typeof', 'sizeof', 'default', 'switch', 'stackalloc', 'delegate', 'out', 'ref',
  'in', '{', '}', 'checked', 'unchecked', 'base',
]);

/**
 * Identifiers inside the holes of an interpolated string, classified from their neighbouring tokens.
 * Holes using anything beyond simple expressions (lambdas, patterns, casts, generics, object creation)
 * classify their identifiers as `unknown`.
 */
function interpolationOccurrences(source: string, start: number, end: number): HoleOccurrence[] {
  const occurrences: HoleOccurrence[] = [];

  for (const hole of interpolationHoles(source, start, end)) {
    const text = source.slice(hole.start, hole.end);
    const tokens = lex(text).tokens.filter((token) => token.type !== 'end');
    const risky =
      tokens.some(
        (token) =>
          RISKY_HOLE_TOKENS.has(token.type) ||
          (token.type === 'identifier' &&
            text.slice(token.start, token.end) !== 'nameof' &&
            CONTEXTUAL_KEYWORDS.has(text.slice(token.start, token.end)))
      ) ||
      (tokens.some((token) => token.type === '<') && tokens.some((token) => token.type === '>'));

    tokens.forEach((token, index) => {
      if (token.type === 'interpolated_string_expression') {
        occurrences.push(...interpolationOccurrences(source, hole.start + token.start, hole.start + token.end));
        return;
      }

      if (token.type !== 'identifier') {
        return;
      }

      occurrences.push({
        name: identifierName(text.slice(token.start, token.end)),
        start: hole.start + token.start,
        end: hole.start + token.end,
        role: risky ? UNKNOWN_ROLE : holeRole(tokens, index, text),
      });
    });
  }

  return occurrences;
}

function holeRole(tokens: readonly { type: string; start: number; end: number }[], index: number, text: string): OccurrenceRole {
  const previous = tokens[index - 1]?.type;
  const next = tokens[index + 1]?.type;

  if (previous === '.' || previous === '?.' || previous === '->' || previous === '::') {
    if (previous !== '.') {
      return { kind: 'member', receiver: { kind: 'conditional' } };
    }

    const receiver = tokens[index - 2];
    if (receiver?.type === 'this') {
      return { kind: 'member', receiver: { kind: 'this' } };
    }

    if (receiver?.type === 'identifier') {
      const receiverName = identifierName(text.slice(receiver.start, receiver.end));
      const beforeReceiver = tokens[index - 3]?.type;
      return {
        kind: 'member',
        receiver:
          beforeReceiver === '.' || beforeReceiver === '?.'
            ? { kind: 'expression', qualifiedName: receiverName }
            : { kind: 'expression', name: receiverName },
      };
    }

    return { kind: 'member', receiver: { kind: 'expression' } };
  }

  if (next === 'identifier' || next === 'predefined_type') {
    return UNKNOWN_ROLE;
  }

  // `(Name)value` may be a cast.
  if (previous === '(' && next === ')') {
    const after = tokens[index + 2]?.type;
    if (after && (after === 'identifier' || after === '(' || /literal|string/.test(after))) {
      return UNKNOWN_ROLE;
    }
  }

  return REFERENCE_ROLE;
}

interface Hole {
  readonly start: number;
  readonly end: number;
}

/** Expression spans (without alignment/format) of an interpolated string literal's holes. */
function interpolationHoles(source: string, start: number, end: number): Hole[] {
  let index = start;
  let dollars = 0;
  let verbatim = false;
  while (index < end && (source[index] === '$' || source[index] === '@')) {
    if (source[index] === '$') {
      dollars++;
    } else {
      verbatim = true;
    }

    index++;
  }

  let quotes = 0;
  while (source[index + quotes] === '"') {
    quotes++;
  }

  const raw = quotes >= 3;
  const contentStart = index + (raw ? quotes : 1);
  const contentEnd = Math.max(contentStart, end - (raw ? quotes : 1));
  const openRun = raw ? dollars : 1;
  const holes: Hole[] = [];

  let i = contentStart;
  while (i < contentEnd) {
    const ch = source[i];
    if (!raw && !verbatim && ch === '\\') {
      i += 2;
      continue;
    }

    if (ch !== '{') {
      i++;
      continue;
    }

    let run = 0;
    while (source[i + run] === '{') {
      run++;
    }

    if (!raw) {
      if (run % 2 === 0) {
        i += run;
        continue;
      }

      // `{{{x}` is an escaped brace followed by a hole.
      i += run - 1;
    } else if (run < openRun) {
      i += run;
      continue;
    } else {
      i += run - openRun;
    }

    const holeStart = i + (raw ? openRun : 1);
    const holeEnd = scanHoleExpression(source, holeStart, contentEnd);
    holes.push({ start: holeStart, end: holeEnd.expressionEnd });
    i = holeEnd.closeIndex + 1;
  }

  return holes;
}

/** Finds the end of a hole's expression (before `,` alignment or `:` format) and its closing `}`. */
function scanHoleExpression(source: string, from: number, limit: number): { expressionEnd: number; closeIndex: number } {
  let depth = 0;
  let expressionEnd = -1;
  let i = from;

  while (i < limit) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, limit);
      continue;
    }

    if (ch === '@' && source[i + 1] === '"') {
      i = skipVerbatim(source, i + 1, limit);
      continue;
    }

    if (ch === '$' && (source[i + 1] === '"' || source[i + 1] === '@' || source[i + 1] === '$')) {
      let j = i;
      while (source[j] === '$' || source[j] === '@') {
        j++;
      }

      i = source[i + 1] === '@' || source[j - 1] === '@' ? skipVerbatim(source, j, limit) : skipQuoted(source, j, limit);
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (ch === '}') {
      if (depth === 0) {
        return { expressionEnd: expressionEnd < 0 ? i : expressionEnd, closeIndex: i };
      }

      depth--;
    } else if (depth === 0 && expressionEnd < 0) {
      if (ch === ',') {
        expressionEnd = i;
      } else if (ch === ':' && source[i + 1] !== ':' && source[i - 1] !== ':') {
        expressionEnd = i;
      }
    }

    i++;
  }

  return { expressionEnd: expressionEnd < 0 ? limit : expressionEnd, closeIndex: limit };
}

function skipQuoted(source: string, quoteIndex: number, limit: number): number {
  const quote = source[quoteIndex];
  let i = quoteIndex + 1;
  while (i < limit && source[i] !== quote) {
    i += source[i] === '\\' ? 2 : 1;
  }

  return i + 1;
}

function skipVerbatim(source: string, quoteIndex: number, limit: number): number {
  let i = quoteIndex + 1;
  while (i < limit) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }

      return i + 1;
    }

    i++;
  }

  return limit;
}
