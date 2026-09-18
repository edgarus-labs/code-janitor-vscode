/**
 * Native C# parser. Recursive descent over the token stream produced by {@link lex}, emitting a
 * syntax tree whose node names, field names and named/anonymous split match what the cleanup
 * transformations consume.
 *
 * The parser is deliberately tolerant: it is used on files that are being edited, so anything it
 * cannot classify is kept as-is rather than aborting. Every token ends up in the tree exactly once,
 * which is what keeps node offsets usable as text-edit ranges.
 */

import { Node, SyntaxDocument, Tree, linkTree } from './node';
import { Token, lex } from './lexer';

const MODIFIER_KEYWORDS = new Set([
  'abstract', 'const', 'extern', 'fixed', 'internal', 'new', 'override', 'private', 'protected',
  'public', 'readonly', 'ref', 'sealed', 'static', 'unsafe', 'virtual', 'volatile',
]);

const CONTEXTUAL_MODIFIERS = new Set(['async', 'partial', 'required']);

const TYPE_KEYWORDS = new Set(['class', 'struct', 'interface', 'enum']);

const ACCESSOR_NAMES = new Set(['get', 'set', 'init', 'add', 'remove']);

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '??=']);

/** Binary operator precedence, lowest binding first. */
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>=', 'as'],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

const LITERAL_TYPES = new Set([
  'string_literal',
  'verbatim_string_literal',
  'raw_string_literal',
  'interpolated_string_expression',
  'character_literal',
  'integer_literal',
  'real_literal',
  'boolean_literal',
  'null_literal',
]);

/** Tokens that may appear inside a type argument list; anything else rules out generics. */
const TYPE_ARGUMENT_TOKENS = new Set([
  'identifier', 'predefined_type', ',', '.', '[', ']', '?', '::', '*', 'in', 'out',
]);

const AFTER_TYPE_ARGUMENTS = new Set([
  '(', ')', ']', '}', ',', ';', '.', ':', '?', '=>', '{', '>', '==', '!=', 'identifier',
  'predefined_type', 'end', '[', '::',
]);

/** Tokens that terminate an `is` pattern at nesting depth zero. */
const PATTERN_TERMINATORS = new Set([
  ';', ')', ',', ']', '}', '&&', '||', '?', ':', '=>', 'end', '==', '!=',
]);

export function parseCSharpSource(source: string): Tree {
  const document = new SyntaxDocument(source);
  const { tokens, trivia } = lex(source);
  const root = new CSharpParser(document, tokens).parseCompilationUnit();

  attachTrivia(document, root, trivia);
  linkTree(root);

  return new Tree(root);
}

class CSharpParser {
  private pos = 0;

  constructor(
    private readonly document: SyntaxDocument,
    private readonly tokens: readonly Token[]
  ) {}

  // ---------------------------------------------------------------- token helpers

  private get current(): Token {
    return this.tokens[this.pos];
  }

  private peek(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private is(type: string): boolean {
    return this.current.type === type;
  }

  private textOf(token: Token): string {
    return this.document.source.slice(token.start, token.end);
  }

  private isContextual(word: string, offset = 0): boolean {
    const token = this.peek(offset);

    return token.type === 'identifier' && this.textOf(token) === word;
  }

  private leaf(): Node {
    const token = this.tokens[this.pos];
    if (token.type !== 'end') {
      this.pos++;
    }

    return new Node(this.document, token.type, token.isNamed, token.start, token.end);
  }

  private take(children: Node[]): Node {
    const node = this.leaf();
    children.push(node);

    return node;
  }

  /**
   * Consumes a contextual keyword (`record`, `get`, `set`, ...) that the lexer produced as an
   * identifier, re-typing it to the keyword so that it is addressable as such in the tree.
   */
  private takeKeyword(type: string, children: Node[]): Node {
    const token = this.tokens[this.pos];

    if (token.type !== 'end') {
      this.pos++;
    }

    const node = new Node(this.document, type, false, token.start, token.end);
    children.push(node);

    return node;
  }

  private eat(type: string, children: Node[]): Node | undefined {
    return this.is(type) ? this.take(children) : undefined;
  }

  private expect(type: string, children: Node[]): Node | undefined {
    return this.eat(type, children);
  }

  private makeNode(
    type: string,
    isNamed: boolean,
    start: number,
    end: number,
    children: Node[],
    fields?: Map<string, Node>
  ): Node {
    return new Node(this.document, type, isNamed, start, end, children, fields);
  }

  private finish(
    type: string,
    isNamed: boolean,
    startToken: number,
    children: Node[],
    fields?: Map<string, Node>
  ): Node {
    const start = this.tokens[startToken].start;
    const end = this.pos > startToken ? this.tokens[this.pos - 1].end : start;

    return this.makeNode(type, isNamed, start, end, children, fields);
  }

  // ---------------------------------------------------------------- compilation unit

  parseCompilationUnit(): Node {
    const children: Node[] = [];

    while (!this.is('end')) {
      const before = this.pos;
      const member = this.parseNamespaceMember();

      if (member) {
        children.push(member);
      }

      if (this.pos === before) {
        children.push(this.leaf());
      }
    }

    const end = this.document.source.length;

    return this.makeNode('compilation_unit', true, 0, end, children);
  }

  private parseNamespaceMember(): Node | undefined {
    if (this.is('using') || (this.isContextual('global') && this.peek(1).type === 'using')) {
      return this.parseUsingDirective();
    }

    return this.parseDeclaration();
  }

  private parseUsingDirective(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    if (this.isContextual('global')) {
      this.take(children);
    }

    this.expect('using', children);
    this.eat('static', children);
    this.eat('unsafe', children);

    // `using Alias = Some.Type;`
    if (this.is('identifier') && this.peek(1).type === '=') {
      this.take(children);
      this.take(children);
    }

    const name = this.parseType();
    if (name) {
      children.push(name);
    }

    this.eat(';', children);

    return this.finish('using_directive', true, startToken, children);
  }

  // ---------------------------------------------------------------- declarations

  private parseDeclaration(): Node | undefined {
    const startToken = this.pos;
    const children: Node[] = [];

    while (this.is('[')) {
      children.push(this.parseAttributeList());
    }

    while (this.isModifierStart()) {
      children.push(this.parseModifier());
    }

    if (this.is('namespace')) {
      return this.parseNamespaceDeclaration(startToken, children);
    }

    if (TYPE_KEYWORDS.has(this.current.type) || this.isRecordDeclaration()) {
      return this.parseTypeDeclaration(startToken, children);
    }

    if (this.is('delegate')) {
      return this.parseDelegateDeclaration(startToken, children);
    }

    if (this.is('event')) {
      return this.parseEventDeclaration(startToken, children);
    }

    if (this.is('~')) {
      return this.parseDestructor(startToken, children);
    }

    if (this.is('implicit') || this.is('explicit')) {
      return this.parseConversionOperator(startToken, children);
    }

    if (this.is('operator')) {
      return this.parseOperatorDeclaration(startToken, children, undefined);
    }

    if (this.is('end') || this.is('}')) {
      return children.length > 0 ? this.finish('incomplete_declaration', true, startToken, children) : undefined;
    }

    return this.parseMemberWithType(startToken, children);
  }

  private isModifierStart(): boolean {
    const token = this.current;

    if (token.type === 'identifier') {
      return CONTEXTUAL_MODIFIERS.has(this.textOf(token)) && this.peek(1).type !== '=';
    }

    return MODIFIER_KEYWORDS.has(token.type);
  }

  private parseModifier(): Node {
    const startToken = this.pos;
    const children = [this.leaf()];

    return this.finish('modifier', true, startToken, children);
  }

  private isRecordDeclaration(): boolean {
    if (!this.isContextual('record')) {
      return false;
    }

    const next = this.peek(1);

    return next.type === 'identifier' || next.type === 'class' || next.type === 'struct';
  }

  private parseAttributeList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('[', children);

    // Attribute target such as `assembly:` or `return:`.
    if ((this.is('identifier') || this.is('return')) && this.peek(1).type === ':') {
      this.take(children);
      this.take(children);
    }

    while (!this.is(']') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      children.push(this.parseAttribute());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(']', children);

    return this.finish('attribute_list', true, startToken, children);
  }

  private parseAttribute(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    const name = this.parseType();
    if (name) {
      children.push(name);
      fields.set('name', name);
    }

    if (this.is('(')) {
      children.push(this.parseArgumentList());
    }

    return this.finish('attribute', true, startToken, children, fields);
  }

  private parseNamespaceDeclaration(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    this.expect('namespace', children);

    const name = this.parseType();
    if (name) {
      children.push(name);
      fields.set('name', name);
    }

    if (this.is(';')) {
      this.take(children);

      // A file-scoped namespace owns every declaration that follows it, with no body node.
      while (!this.is('end') && !this.is('}')) {
        const before = this.pos;
        const member = this.parseNamespaceMember();

        if (member) {
          children.push(member);
        }

        if (this.pos === before) {
          this.take(children);
        }
      }

      return this.finish('file_scoped_namespace_declaration', true, startToken, children, fields);
    }

    const body = this.parseDeclarationList();
    children.push(body);
    fields.set('body', body);

    this.eat(';', children);

    return this.finish('namespace_declaration', true, startToken, children, fields);
  }

  private parseDeclarationList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('{', children);

    while (!this.is('}') && !this.is('end')) {
      const before = this.pos;
      const member = this.parseNamespaceMember();

      if (member) {
        children.push(member);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('}', children);

    return this.finish('declaration_list', true, startToken, children);
  }

  private parseTypeDeclaration(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();
    const isRecord = this.isContextual('record');
    const keywordToken = isRecord ? 'record' : this.current.type;

    if (isRecord) {
      this.takeKeyword('record', children);
    } else {
      this.take(children);
    }

    if (isRecord && (this.is('class') || this.is('struct'))) {
      this.take(children);
    }

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    }

    if (this.is('<')) {
      children.push(this.parseTypeParameterList());
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    if (this.is(':')) {
      children.push(this.parseBaseList());
    }

    this.parseConstraintClauses(children);

    const isEnum = keywordToken === 'enum';

    if (this.is('{')) {
      const body = isEnum ? this.parseEnumMemberList() : this.parseDeclarationList();
      children.push(body);
      fields.set('body', body);
    }

    this.eat(';', children);

    const type = isRecord ? 'record_declaration' : `${keywordToken}_declaration`;

    return this.finish(type, true, startToken, children, fields);
  }

  private parseBaseList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect(':', children);

    for (;;) {
      const type = this.parseType();
      if (!type) {
        break;
      }

      children.push(type);

      // Primary-constructor base invocation: `: Base(arg)`.
      if (this.is('(')) {
        children.push(this.parseArgumentList());
      }

      if (!this.eat(',', children)) {
        break;
      }
    }

    return this.finish('base_list', true, startToken, children);
  }

  private parseConstraintClauses(children: Node[]): void {
    while (this.isContextual('where')) {
      const startToken = this.pos;
      const clauseChildren: Node[] = [];

      this.take(clauseChildren);

      while (!this.is('{') && !this.is(';') && !this.is('end') && !this.isContextual('where')) {
        this.take(clauseChildren);
      }

      children.push(this.finish('type_parameter_constraints_clause', true, startToken, clauseChildren));
    }
  }

  private parseEnumMemberList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('{', children);

    while (!this.is('}') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      children.push(this.parseEnumMember());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('}', children);

    return this.finish('enum_member_declaration_list', true, startToken, children);
  }

  private parseEnumMember(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    while (this.is('[')) {
      children.push(this.parseAttributeList());
    }

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    }

    if (this.is('=')) {
      this.take(children);
      const value = this.parseExpression();
      if (value) {
        children.push(value);
      }
    }

    return this.finish('enum_member_declaration', true, startToken, children, fields);
  }

  private parseDelegateDeclaration(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    this.expect('delegate', children);

    const type = this.parseType();
    if (type) {
      children.push(type);
      fields.set('type', type);
    }

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    }

    if (this.is('<')) {
      children.push(this.parseTypeParameterList());
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    this.parseConstraintClauses(children);
    this.eat(';', children);

    return this.finish('delegate_declaration', true, startToken, children, fields);
  }

  private parseEventDeclaration(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    this.expect('event', children);

    const typeStart = this.pos;
    const type = this.parseType();

    if (this.is('{') || (this.is('identifier') && this.peek(1).type === '{')) {
      if (type) {
        children.push(type);
        fields.set('type', type);
      }

      const name = this.eat('identifier', children);
      if (name) {
        fields.set('name', name);
      }

      if (this.is('{')) {
        const accessors = this.parseAccessorList();
        children.push(accessors);
        fields.set('accessors', accessors);
      }

      return this.finish('event_declaration', true, startToken, children, fields);
    }

    const declaration = this.parseVariableDeclaration(typeStart, type);
    if (declaration) {
      children.push(declaration);
    }

    this.eat(';', children);

    return this.finish('event_field_declaration', true, startToken, children, fields);
  }

  private parseDestructor(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    this.expect('~', children);

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    this.parseMethodBody(children, fields);

    return this.finish('destructor_declaration', true, startToken, children, fields);
  }

  private parseConversionOperator(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    this.take(children);
    this.eat('operator', children);

    const type = this.parseType();
    if (type) {
      children.push(type);
      fields.set('type', type);
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    this.parseMethodBody(children, fields);

    return this.finish('conversion_operator_declaration', true, startToken, children, fields);
  }

  private parseOperatorDeclaration(startToken: number, children: Node[], type: Node | undefined): Node {
    const fields = new Map<string, Node>();

    if (type) {
      children.push(type);
      fields.set('type', type);
    }

    this.expect('operator', children);

    // The operator token itself, e.g. `+`, `==` or `true`.
    if (!this.is('(')) {
      this.take(children);
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    this.parseMethodBody(children, fields);

    return this.finish('operator_declaration', true, startToken, children, fields);
  }

  /** Fields, methods, properties, indexers and constructors all start with a type or a name. */
  private parseMemberWithType(startToken: number, children: Node[]): Node {
    const fields = new Map<string, Node>();

    // `Name(` with no return type in front is a constructor.
    if (this.is('identifier') && this.peek(1).type === '(') {
      const name = this.take(children);
      fields.set('name', name);

      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);

      if (this.is(':')) {
        children.push(this.parseConstructorInitializer());
      }

      this.parseMethodBody(children, fields);

      return this.finish('constructor_declaration', true, startToken, children, fields);
    }

    const typeStart = this.pos;
    const type = this.parseType();

    if (!type) {
      this.take(children);

      return this.finish('incomplete_declaration', true, startToken, children, fields);
    }

    if (this.is('operator')) {
      return this.parseOperatorDeclaration(startToken, children, type);
    }

    children.push(type);
    fields.set('type', type);

    if (this.is('this')) {
      this.take(children);

      if (this.is('[')) {
        const parameters = this.parseBracketedParameterList();
        children.push(parameters);
        fields.set('parameters', parameters);
      }

      this.parseAccessorsOrArrow(children, fields);

      return this.finish('indexer_declaration', true, startToken, children, fields);
    }

    // `void IFoo.Bar()` - everything up to the final dot is the explicit interface specifier.
    if (this.is('identifier') && this.isExplicitInterfaceSpecifier()) {
      children.push(this.parseExplicitInterfaceSpecifier());
    }

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    }

    if (this.is('<') && this.typeArgumentListEnd() >= 0) {
      children.push(this.parseTypeParameterList());
    }

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);

      this.parseConstraintClauses(children);
      this.parseMethodBody(children, fields);

      return this.finish('method_declaration', true, startToken, children, fields);
    }

    if (this.is('{') || this.is('=>')) {
      this.parseAccessorsOrArrow(children, fields);

      if (this.is('=')) {
        this.take(children);
        const value = this.parseExpression();
        if (value) {
          children.push(value);
          if (!fields.has('value')) {
            fields.set('value', value);
          }
        }

        this.eat(';', children);
      }

      return this.finish('property_declaration', true, startToken, children, fields);
    }

    // Nothing else matched, so this is a field: rebuild the type into a variable_declaration.
    children.pop();
    fields.delete('type');

    const declaration = this.parseVariableDeclaration(typeStart, type, name);
    if (declaration) {
      children.push(declaration);
    }

    this.eat(';', children);

    return this.finish('field_declaration', true, startToken, children, fields);
  }

  private isExplicitInterfaceSpecifier(): boolean {
    let offset = 0;

    while (this.peek(offset).type === 'identifier') {
      const next = this.peek(offset + 1);

      if (next.type === '.') {
        return true;
      }

      if (next.type === '<') {
        offset += 1;
        continue;
      }

      return false;
    }

    return false;
  }

  private parseExplicitInterfaceSpecifier(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    for (;;) {
      const name = this.eat('identifier', children);
      if (!name) {
        break;
      }

      if (this.is('<') && this.typeArgumentListEnd() >= 0) {
        children.push(this.parseTypeArgumentList());
      }

      if (!this.eat('.', children)) {
        break;
      }

      if (this.peek(1).type !== '.' && this.peek(1).type !== '<') {
        // The identifier after this dot is the member name, so the specifier ends here.
        break;
      }
    }

    return this.finish('explicit_interface_specifier', true, startToken, children);
  }

  private parseConstructorInitializer(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect(':', children);

    if (this.is('base') || this.is('this')) {
      this.take(children);
    }

    if (this.is('(')) {
      children.push(this.parseArgumentList());
    }

    return this.finish('constructor_initializer', true, startToken, children);
  }

  private parseAccessorsOrArrow(children: Node[], fields: Map<string, Node>): void {
    if (this.is('{')) {
      const accessors = this.parseAccessorList();
      children.push(accessors);
      fields.set('accessors', accessors);

      return;
    }

    if (this.is('=>')) {
      const arrow = this.parseArrowExpressionClause();
      children.push(arrow);
      fields.set('value', arrow);
      this.eat(';', children);
    }
  }

  private parseArrowExpressionClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('=>', children);

    const expression = this.parseExpression();
    if (expression) {
      children.push(expression);
    }

    return this.finish('arrow_expression_clause', true, startToken, children);
  }

  private parseAccessorList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('{', children);

    while (!this.is('}') && !this.is('end')) {
      const before = this.pos;
      children.push(this.parseAccessorDeclaration());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('}', children);

    return this.finish('accessor_list', true, startToken, children);
  }

  private parseAccessorDeclaration(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    while (this.is('[')) {
      children.push(this.parseAttributeList());
    }

    while (this.isModifierStart()) {
      children.push(this.parseModifier());
    }

    if (this.is('identifier') && ACCESSOR_NAMES.has(this.textOf(this.current))) {
      this.takeKeyword(this.textOf(this.current), children);
    }

    if (this.is('{')) {
      const body = this.parseBlock();
      children.push(body);
      fields.set('body', body);
    } else if (this.is('=>')) {
      const arrow = this.parseArrowExpressionClause();
      children.push(arrow);
      fields.set('body', arrow);
      this.eat(';', children);
    } else {
      this.eat(';', children);
    }

    return this.finish('accessor_declaration', true, startToken, children, fields);
  }

  private parseMethodBody(children: Node[], fields: Map<string, Node>): void {
    if (this.is('{')) {
      const body = this.parseBlock();
      children.push(body);
      fields.set('body', body);

      return;
    }

    if (this.is('=>')) {
      const arrow = this.parseArrowExpressionClause();
      children.push(arrow);
      fields.set('body', arrow);
    }

    this.eat(';', children);
  }

  // ---------------------------------------------------------------- parameters

  private parseParameterList(): Node {
    return this.parseParameters('(', ')', 'parameter_list');
  }

  private parseBracketedParameterList(): Node {
    return this.parseParameters('[', ']', 'bracketed_parameter_list');
  }

  private parseParameters(open: string, close: string, type: string): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect(open, children);

    while (!this.is(close) && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      children.push(this.parseParameter());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(close, children);

    return this.finish(type, true, startToken, children);
  }

  private parseParameter(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    while (this.is('[')) {
      children.push(this.parseAttributeList());
    }

    while (
      this.is('ref') ||
      this.is('out') ||
      this.is('in') ||
      this.is('this') ||
      this.is('params') ||
      this.is('readonly') ||
      this.isContextual('scoped')
    ) {
      this.take(children);
    }

    const type = this.parseType();
    if (type) {
      children.push(type);
      fields.set('type', type);
    }

    const name = this.eat('identifier', children);
    if (name) {
      fields.set('name', name);
    } else if (type && type.type === 'identifier') {
      // A lambda parameter without a type: what was read as the type is really the name.
      fields.delete('type');
      fields.set('name', type);
    }

    if (this.is('=')) {
      this.take(children);
      const value = this.parseExpression();
      if (value) {
        children.push(value);
      }
    }

    return this.finish('parameter', true, startToken, children, fields);
  }

  // ---------------------------------------------------------------- types

  private canStartType(): boolean {
    return this.is('identifier') || this.is('predefined_type') || this.is('(');
  }

  private parseType(): Node | undefined {
    if (!this.canStartType()) {
      return undefined;
    }

    let node = this.parseTypeBase();
    if (!node) {
      return undefined;
    }

    for (;;) {
      if (this.is('?') && this.canContinueNullableType()) {
        const children = [node, this.leaf()];
        node = this.makeNode('nullable_type', true, node.startIndex, this.tokens[this.pos - 1].end, children);
        continue;
      }

      if (this.is('[') && this.isArrayRankSpecifier()) {
        const rank = this.parseArrayRankSpecifier();
        const fields = new Map<string, Node>([
          ['type', node],
          ['rank', rank],
        ]);

        node = this.makeNode('array_type', true, node.startIndex, rank.endIndex, [node, rank], fields);
        continue;
      }

      break;
    }

    return node;
  }

  private parseTypeBase(): Node | undefined {
    if (this.is('(')) {
      return this.parseTupleType();
    }

    if (this.is('predefined_type')) {
      return this.leaf();
    }

    if (!this.is('identifier')) {
      return undefined;
    }

    if (this.textOf(this.current) === 'var' && this.peek(1).type !== '.' && this.peek(1).type !== '<') {
      const startToken = this.pos;
      const children = [this.leaf()];

      return this.finish('implicit_type', true, startToken, children);
    }

    let node: Node = this.leaf();

    if (this.is('<') && this.typeArgumentListEnd() >= 0) {
      const args = this.parseTypeArgumentList();
      node = this.makeNode('generic_name', true, node.startIndex, args.endIndex, [node, args]);
    }

    if (this.is('::')) {
      const separator = this.leaf();
      const right = this.parseTypeBase();
      if (right) {
        const fields = new Map<string, Node>([['name', right]]);
        node = this.makeNode(
          'alias_qualified_name',
          true,
          node.startIndex,
          right.endIndex,
          [node, separator, right],
          fields
        );
      } else {
        node = this.makeNode('alias_qualified_name', true, node.startIndex, separator.endIndex, [node, separator]);
      }
    }

    while (this.is('.') && this.peek(1).type === 'identifier') {
      const dot = this.leaf();
      let right: Node = this.leaf();

      if (this.is('<') && this.typeArgumentListEnd() >= 0) {
        const args = this.parseTypeArgumentList();
        right = this.makeNode('generic_name', true, right.startIndex, args.endIndex, [right, args]);
      }

      const fields = new Map<string, Node>([
        ['qualifier', node],
        ['name', right],
      ]);

      node = this.makeNode('qualified_name', true, node.startIndex, right.endIndex, [node, dot, right], fields);
    }

    return node;
  }

  private parseTupleType(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('(', children);

    while (!this.is(')') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      const element = this.parseType();

      if (element) {
        children.push(element);
        this.eat('identifier', children);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(')', children);

    return this.finish('tuple_type', true, startToken, children);
  }

  /** `?` continues a type unless it is really the start of a conditional expression. */
  private canContinueNullableType(): boolean {
    const next = this.peek(1);

    return next.type !== '.' && next.type !== '?.';
  }

  private isArrayRankSpecifier(): boolean {
    // `[` starts a rank specifier only when it is empty or holds nothing but commas/expressions
    // that end at the matching `]` - which is always true in a type position.
    return this.is('[');
  }

  private parseArrayRankSpecifier(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('[', children);

    while (!this.is(']') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      const size = this.parseExpression();

      if (size) {
        children.push(size);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(']', children);

    return this.finish('array_rank_specifier', true, startToken, children);
  }

  private parseTypeParameterList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    let depth = 0;

    do {
      if (this.is('<')) {
        depth++;
      } else if (this.is('>')) {
        depth--;
      }

      this.take(children);
    } while (depth > 0 && !this.is('end'));

    return this.finish('type_parameter_list', true, startToken, children);
  }

  private parseTypeArgumentList(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('<', children);

    while (!this.is('>') && !this.is('end')) {
      if (this.is(',') || this.is('in') || this.is('out')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      const argument = this.parseType();

      if (argument) {
        children.push(argument);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('>', children);

    return this.finish('type_argument_list', true, startToken, children);
  }

  /**
   * Index of the `>` closing a type argument list that starts at the current `<`, or -1 when the
   * `<` is a comparison operator instead.
   */
  private typeArgumentListEnd(): number {
    let depth = 0;
    let i = this.pos;

    for (; i < this.tokens.length; i++) {
      const type = this.tokens[i].type;

      if (type === '<') {
        depth++;
        continue;
      }

      if (type === '>') {
        depth--;
        if (depth === 0) {
          break;
        }

        continue;
      }

      if (!TYPE_ARGUMENT_TOKENS.has(type)) {
        return -1;
      }
    }

    if (depth !== 0 || i >= this.tokens.length) {
      return -1;
    }

    return AFTER_TYPE_ARGUMENTS.has(this.tokens[i + 1]?.type ?? 'end') ? i : -1;
  }

  // ---------------------------------------------------------------- statements

  private parseBlock(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('{', children);

    while (!this.is('}') && !this.is('end')) {
      const before = this.pos;
      children.push(this.parseStatement());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('}', children);

    return this.finish('block', true, startToken, children);
  }

  private parseStatement(): Node {
    const startToken = this.pos;

    switch (this.current.type) {
      case '{':
        return this.parseBlock();

      case ';': {
        const children = [this.leaf()];

        return this.finish('empty_statement', true, startToken, children);
      }

      case 'if':
        return this.parseIfStatement();

      case 'while':
      case 'lock':
      case 'fixed':
        return this.parseHeaderStatement(`${this.current.type}_statement`);

      case 'switch':
        return this.parseSwitchStatement();

      case 'for':
        return this.parseForStatement();

      case 'foreach':
        return this.parseHeaderStatement('for_each_statement');

      case 'do':
        return this.parseDoStatement();

      case 'try':
        return this.parseTryStatement();

      case 'using':
        if (this.peek(1).type === '(') {
          return this.parseHeaderStatement('using_statement');
        }

        break;

      case 'unsafe':
      case 'checked':
      case 'unchecked':
        if (this.peek(1).type === '{') {
          const children = [this.leaf(), this.parseBlock()];

          return this.finish(`${this.tokens[startToken].type}_statement`, true, startToken, children);
        }

        break;

      case 'return':
      case 'throw':
        return this.parseReturnLike(`${this.current.type}_statement`);

      case 'break':
      case 'continue': {
        const children = [this.leaf()];
        this.eat(';', children);

        return this.finish(`${this.tokens[startToken].type}_statement`, true, startToken, children);
      }

      case 'goto': {
        const children: Node[] = [];
        while (!this.is(';') && !this.is('end')) {
          this.take(children);
        }

        this.eat(';', children);

        return this.finish('goto_statement', true, startToken, children);
      }

      default:
        break;
    }

    if (this.isContextual('yield')) {
      const children: Node[] = [];
      while (!this.is(';') && !this.is('end')) {
        this.take(children);
      }

      this.eat(';', children);

      return this.finish('yield_statement', true, startToken, children);
    }

    // A label such as `Retry:` is not a declaration and not an expression statement.
    if (this.is('identifier') && this.peek(1).type === ':') {
      const children = [this.leaf(), this.leaf()];

      return this.finish('labeled_statement', true, startToken, children);
    }

    const localFunction = this.tryParseLocalFunction();
    if (localFunction) {
      return localFunction;
    }

    const declaration = this.tryParseLocalDeclaration();
    if (declaration) {
      return declaration;
    }

    return this.parseExpressionStatement();
  }

  private parseIfStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('if', children);
    this.parseParenthesizedCondition(children);
    children.push(this.parseStatement());

    if (this.is('else')) {
      this.take(children);
      children.push(this.parseStatement());
    }

    return this.finish('if_statement', true, startToken, children);
  }

  private parseHeaderStatement(type: string): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.take(children);
    this.parseParenthesizedCondition(children);
    children.push(this.parseStatement());

    return this.finish(type, true, startToken, children);
  }

  private parseForStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('for', children);
    this.parseParenthesizedCondition(children);
    children.push(this.parseStatement());

    return this.finish('for_statement', true, startToken, children);
  }

  private parseDoStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('do', children);
    children.push(this.parseStatement());
    this.eat('while', children);
    this.parseParenthesizedCondition(children);
    this.eat(';', children);

    return this.finish('do_statement', true, startToken, children);
  }

  private parseTryStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('try', children);

    if (this.is('{')) {
      children.push(this.parseBlock());
    }

    while (this.is('catch')) {
      const catchStart = this.pos;
      const catchChildren: Node[] = [];

      this.take(catchChildren);

      if (this.is('(')) {
        this.parseParenthesizedCondition(catchChildren);
      }

      if (this.isContextual('when') && this.peek(1).type === '(') {
        this.take(catchChildren);
        this.parseParenthesizedCondition(catchChildren);
      }

      if (this.is('{')) {
        catchChildren.push(this.parseBlock());
      }

      children.push(this.finish('catch_clause', true, catchStart, catchChildren));
    }

    if (this.is('finally')) {
      const finallyStart = this.pos;
      const finallyChildren: Node[] = [this.leaf()];

      if (this.is('{')) {
        finallyChildren.push(this.parseBlock());
      }

      children.push(this.finish('finally_clause', true, finallyStart, finallyChildren));
    }

    return this.finish('try_statement', true, startToken, children);
  }

  private parseSwitchStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('switch', children);
    this.parseParenthesizedCondition(children);

    if (this.is('{')) {
      const bodyStart = this.pos;
      const bodyChildren: Node[] = [];

      this.expect('{', bodyChildren);

      while (!this.is('}') && !this.is('end')) {
        const before = this.pos;

        if (this.is('case') || this.is('default')) {
          while (!this.is(':') && !this.is('end') && !this.is('}')) {
            this.take(bodyChildren);
          }

          this.eat(':', bodyChildren);
        } else {
          bodyChildren.push(this.parseStatement());
        }

        if (this.pos === before) {
          this.take(bodyChildren);
        }
      }

      this.eat('}', bodyChildren);
      children.push(this.finish('switch_body', true, bodyStart, bodyChildren));
    }

    return this.finish('switch_statement', true, startToken, children);
  }

  /** Consumes `( ... )` keeping every token, whatever the header contains. */
  private parseParenthesizedCondition(children: Node[]): void {
    if (!this.is('(')) {
      return;
    }

    let depth = 0;

    do {
      if (this.is('(')) {
        depth++;
      } else if (this.is(')')) {
        depth--;
      }

      if (depth === 1 && !this.is('(')) {
        const before = this.pos;
        const inner = this.parseHeaderContent();

        if (inner) {
          children.push(inner);
          continue;
        }

        if (this.pos !== before) {
          continue;
        }
      }

      this.take(children);
    } while (depth > 0 && !this.is('end'));
  }

  /**
   * The interesting part of a statement header: a declaration (`var x = ...`, `Type x in ...`) or
   * an expression. Returns `undefined` for separators, which the caller then consumes verbatim.
   */
  private parseHeaderContent(): Node | undefined {
    if (this.is(')') || this.is(';') || this.is(',') || this.is('in') || this.is('end')) {
      return undefined;
    }

    const save = this.pos;
    const declaration = this.tryParseVariableDeclaration();
    if (declaration) {
      return declaration;
    }

    this.pos = save;

    return this.parseExpression();
  }

  private parseReturnLike(type: string): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.take(children);

    if (!this.is(';')) {
      const expression = this.parseExpression();
      if (expression) {
        children.push(expression);
      }
    }

    this.eat(';', children);

    return this.finish(type, true, startToken, children);
  }

  private parseExpressionStatement(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const expression = this.parseExpression();

    if (expression) {
      children.push(expression);
    } else if (!this.is(';')) {
      this.take(children);
    }

    this.eat(';', children);

    return this.finish('expression_statement', true, startToken, children);
  }

  private tryParseLocalFunction(): Node | undefined {
    const save = this.pos;
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    while (
      this.is('static') ||
      this.is('extern') ||
      this.is('unsafe') ||
      this.isContextual('async') ||
      this.is('ref')
    ) {
      children.push(this.parseModifier());
    }

    const type = this.parseType();
    if (!type || !this.is('identifier')) {
      this.pos = save;

      return undefined;
    }

    children.push(type);
    fields.set('type', type);

    const name = this.take(children);
    fields.set('name', name);

    if (this.is('<') && this.typeArgumentListEnd() >= 0) {
      children.push(this.parseTypeParameterList());
    }

    if (!this.is('(')) {
      this.pos = save;

      return undefined;
    }

    const closing = this.matchingIndex('(', ')');
    const after = closing >= 0 ? this.tokens[closing + 1]?.type : undefined;
    if (after !== '{' && after !== '=>' && after !== 'where') {
      this.pos = save;

      return undefined;
    }

    const parameters = this.parseParameterList();
    children.push(parameters);
    fields.set('parameters', parameters);

    this.parseConstraintClauses(children);
    this.parseMethodBody(children, fields);

    return this.finish('local_function_statement', true, startToken, children, fields);
  }

  private tryParseLocalDeclaration(): Node | undefined {
    const save = this.pos;
    const startToken = this.pos;
    const children: Node[] = [];

    while (this.is('const') || this.is('ref') || this.is('readonly') || this.is('using') || this.isContextual('await')) {
      children.push(this.parseModifier());
    }

    const declaration = this.tryParseVariableDeclaration();
    if (!declaration || !this.is(';')) {
      this.pos = save;

      return undefined;
    }

    children.push(declaration);
    this.take(children);

    return this.finish('local_declaration_statement', true, startToken, children);
  }

  private tryParseVariableDeclaration(): Node | undefined {
    const save = this.pos;
    const typeStart = this.pos;
    const type = this.parseType();

    if (!type || !this.is('identifier')) {
      this.pos = save;

      return undefined;
    }

    const declaration = this.parseVariableDeclaration(typeStart, type);
    if (!declaration) {
      this.pos = save;
    }

    return declaration;
  }

  /**
   * Builds a `variable_declaration` around an already-parsed type. `firstName` is the identifier
   * the caller consumed while deciding what kind of declaration this is.
   */
  private parseVariableDeclaration(typeStart: number, type: Node | undefined, firstName?: Node): Node | undefined {
    if (!type) {
      return undefined;
    }

    const children: Node[] = [type];
    const fields = new Map<string, Node>([['type', type]]);

    let pending = firstName;

    for (;;) {
      const declarator = this.parseVariableDeclarator(pending);
      pending = undefined;

      if (!declarator) {
        break;
      }

      children.push(declarator);

      if (!this.is(',')) {
        break;
      }

      children.push(this.leaf());
    }

    if (children.length < 2) {
      return undefined;
    }

    const start = this.tokens[typeStart].start;
    const end = children[children.length - 1].endIndex;

    return this.makeNode('variable_declaration', true, start, end, children, fields);
  }

  private parseVariableDeclarator(pending?: Node): Node | undefined {
    const name = pending ?? (this.is('identifier') ? this.leaf() : undefined);
    if (!name) {
      return undefined;
    }

    const children: Node[] = [name];
    const fields = new Map<string, Node>([['name', name]]);

    // `int x[]` style rank specifiers are not valid C#, but `fixed int buffer[8]` is.
    if (this.is('[')) {
      children.push(this.parseArrayRankSpecifier());
    }

    if (this.is('=')) {
      const clauseStart = this.pos;
      const clauseChildren = [this.leaf()];
      const value = this.is('{') ? this.parseInitializerExpression() : this.parseExpression();

      if (value) {
        clauseChildren.push(value);
      }

      children.push(this.finish('equals_value_clause', true, clauseStart, clauseChildren));
    }

    const end = children[children.length - 1].endIndex;

    return this.makeNode('variable_declarator', true, name.startIndex, end, children, fields);
  }

  // ---------------------------------------------------------------- expressions

  private parseExpression(): Node | undefined {
    return this.parseAssignment();
  }

  private parseAssignment(): Node | undefined {
    const left = this.parseConditional();
    if (!left) {
      return undefined;
    }

    if (!ASSIGNMENT_OPERATORS.has(this.current.type)) {
      return left;
    }

    const operator = this.leaf();
    const right = this.is('{') ? this.parseInitializerExpression() : this.parseAssignment();
    const children = [left, operator];

    if (right) {
      children.push(right);
    }

    const fields = new Map<string, Node>([['left', left]]);
    if (right) {
      fields.set('right', right);
    }

    const end = children[children.length - 1].endIndex;

    return this.makeNode('assignment_expression', true, left.startIndex, end, children, fields);
  }

  private parseConditional(): Node | undefined {
    const condition = this.parseBinary(0);
    if (!condition) {
      return undefined;
    }

    if (!this.is('?')) {
      return condition;
    }

    const children = [condition, this.leaf()];
    const consequence = this.parseAssignment();
    if (consequence) {
      children.push(consequence);
    }

    if (this.is(':')) {
      children.push(this.leaf());
      const alternative = this.parseAssignment();
      if (alternative) {
        children.push(alternative);
      }
    }

    const fields = new Map<string, Node>([['condition', condition]]);
    const end = children[children.length - 1].endIndex;

    return this.makeNode('conditional_expression', true, condition.startIndex, end, children, fields);
  }

  private parseBinary(level: number): Node | undefined {
    if (level >= BINARY_LEVELS.length) {
      return this.parseCoalesce();
    }

    let left = this.parseBinary(level + 1);
    if (!left) {
      return undefined;
    }

    for (;;) {
      const operators = BINARY_LEVELS[level];
      const operatorTokens = this.matchBinaryOperator(operators);
      if (!operatorTokens) {
        break;
      }

      const children: Node[] = [left, ...operatorTokens];
      const right = this.parseBinary(level + 1);
      if (right) {
        children.push(right);
      }

      const fields = new Map<string, Node>([['left', left]]);
      if (right) {
        fields.set('right', right);
      }

      const end = children[children.length - 1].endIndex;
      left = this.makeNode('binary_expression', true, left.startIndex, end, children, fields);
    }

    return left;
  }

  /**
   * Consumes a binary operator of the given level. `>>` is matched as two adjacent `>` tokens,
   * because the lexer keeps them apart so that nested generics can close.
   */
  private matchBinaryOperator(operators: readonly string[]): Node[] | undefined {
    if (operators.includes('>>') && this.is('>') && this.peek(1).type === '>' && this.current.end === this.peek(1).start) {
      return [this.leaf(), this.leaf()];
    }

    if (this.is('>') && this.peek(1).type === '>' && this.current.end === this.peek(1).start) {
      // Leave `>>` for the shift level rather than treating the first `>` as a comparison.
      return undefined;
    }

    if (this.is('<') && this.typeArgumentListEnd() >= 0) {
      return undefined;
    }

    return operators.includes(this.current.type) ? [this.leaf()] : undefined;
  }

  private parseCoalesce(): Node | undefined {
    const left = this.parseIsExpression();
    if (!left) {
      return undefined;
    }

    if (!this.is('??')) {
      return left;
    }

    const children = [left, this.leaf()];
    const right = this.parseCoalesce();
    if (right) {
      children.push(right);
    }

    const fields = new Map<string, Node>([['left', left]]);
    if (right) {
      fields.set('right', right);
    }

    const end = children[children.length - 1].endIndex;

    return this.makeNode('binary_expression', true, left.startIndex, end, children, fields);
  }

  private parseIsExpression(): Node | undefined {
    let expression = this.parseUnary();
    if (!expression) {
      return undefined;
    }

    while (this.is('is')) {
      const children = [expression, this.leaf()];
      const pattern = this.parsePattern();

      if (pattern) {
        children.push(pattern);
      }

      const fields = new Map<string, Node>([['expression', expression]]);
      if (pattern) {
        fields.set('pattern', pattern);
      }

      const end = children[children.length - 1].endIndex;
      expression = this.makeNode('is_pattern_expression', true, expression.startIndex, end, children, fields);
    }

    return expression;
  }

  /**
   * Patterns have their own grammar (`not`, `and`, `or`, property and list patterns) that no
   * cleanup rule inspects, so the tokens are kept verbatim in a single node instead.
   */
  private parsePattern(): Node | undefined {
    const startToken = this.pos;
    const children: Node[] = [];
    let depth = 0;

    while (!this.is('end')) {
      const type = this.current.type;

      if (depth === 0 && PATTERN_TERMINATORS.has(type)) {
        break;
      }

      if (type === '(' || type === '[' || type === '{') {
        depth++;
      } else if (type === ')' || type === ']' || type === '}') {
        depth--;
      }

      this.take(children);
    }

    return children.length > 0 ? this.finish('pattern', true, startToken, children) : undefined;
  }

  private parseUnary(): Node | undefined {
    const type = this.current.type;

    if (type === '!' || type === '~' || type === '-' || type === '+' || type === '++' || type === '--' || type === '^') {
      const startToken = this.pos;
      const children = [this.leaf()];
      const operand = this.parseUnary();

      if (operand) {
        children.push(operand);
      }

      return this.finish('prefix_unary_expression', true, startToken, children);
    }

    if (type === 'ref') {
      const startToken = this.pos;
      const children = [this.leaf()];
      const operand = this.parseUnary();

      if (operand) {
        children.push(operand);
      }

      return this.finish('ref_expression', true, startToken, children);
    }

    if (this.isContextual('await')) {
      const startToken = this.pos;
      const children = [this.leaf()];
      const operand = this.parseUnary();

      if (operand) {
        children.push(operand);
      }

      return this.finish('await_expression', true, startToken, children);
    }

    if (type === '&' || type === '*') {
      const startToken = this.pos;
      const children = [this.leaf()];
      const operand = this.parseUnary();

      if (operand) {
        children.push(operand);
      }

      return this.finish('prefix_unary_expression', true, startToken, children);
    }

    return this.parsePostfix();
  }

  private parsePostfix(): Node | undefined {
    let expression = this.parsePrimary();
    if (!expression) {
      return undefined;
    }

    for (;;) {
      const type = this.current.type;

      if (type === '.' || type === '->') {
        const separator = this.leaf();
        const name = this.parseMemberName();
        const children = [expression, separator];

        if (name) {
          children.push(name);
        }

        const fields = new Map<string, Node>([['expression', expression]]);
        if (name) {
          fields.set('name', name);
        }

        const end = children[children.length - 1].endIndex;
        expression = this.makeNode('member_access_expression', true, expression.startIndex, end, children, fields);
        continue;
      }

      if (type === '?.') {
        const separator = this.leaf();
        const name = this.parseMemberName();
        const children = [expression, separator];

        if (name) {
          children.push(name);
        }

        const fields = new Map<string, Node>([['expression', expression]]);
        if (name) {
          fields.set('name', name);
        }

        const end = children[children.length - 1].endIndex;
        expression = this.makeNode('conditional_access_expression', true, expression.startIndex, end, children, fields);
        continue;
      }

      if (type === '(') {
        const args = this.parseArgumentList();
        const fields = new Map<string, Node>([
          ['function', expression],
          ['arguments', args],
        ]);

        expression = this.makeNode(
          'invocation_expression',
          true,
          expression.startIndex,
          args.endIndex,
          [expression, args],
          fields
        );
        continue;
      }

      if (type === '[') {
        const args = this.parseBracketedArgumentList();
        const fields = new Map<string, Node>([
          ['expression', expression],
          ['subscript', args],
        ]);

        expression = this.makeNode(
          'element_access_expression',
          true,
          expression.startIndex,
          args.endIndex,
          [expression, args],
          fields
        );
        continue;
      }

      if (type === '++' || type === '--') {
        const operator = this.leaf();
        expression = this.makeNode(
          'postfix_unary_expression',
          true,
          expression.startIndex,
          operator.endIndex,
          [expression, operator]
        );
        continue;
      }

      // Null-forgiving `x!`; `!=` is a single token so this is never a comparison.
      if (type === '!') {
        const operator = this.leaf();
        expression = this.makeNode(
          'postfix_unary_expression',
          true,
          expression.startIndex,
          operator.endIndex,
          [expression, operator]
        );
        continue;
      }

      if (type === '<' && this.typeArgumentListEnd() >= 0) {
        const args = this.parseTypeArgumentList();
        expression = this.makeNode(
          'generic_name',
          true,
          expression.startIndex,
          args.endIndex,
          [expression, args]
        );
        continue;
      }

      if (type === 'switch' && this.peek(1).type === '{') {
        const startIndex = expression.startIndex;
        const children = [expression, this.leaf()];
        children.push(this.parseBraceRun('switch_body'));
        expression = this.makeNode(
          'switch_expression',
          true,
          startIndex,
          children[children.length - 1].endIndex,
          children
        );
        continue;
      }

      break;
    }

    return expression;
  }

  private parseMemberName(): Node | undefined {
    if (this.is('identifier') || this.is('predefined_type')) {
      const name = this.leaf();

      if (this.is('<') && this.typeArgumentListEnd() >= 0 && this.tokens[this.typeArgumentListEnd() + 1]?.type === '(') {
        const args = this.parseTypeArgumentList();

        return this.makeNode('generic_name', true, name.startIndex, args.endIndex, [name, args]);
      }

      return name;
    }

    if (this.is('this') || this.is('base')) {
      return this.leaf();
    }

    return undefined;
  }

  private parsePrimary(): Node | undefined {
    const type = this.current.type;

    if (LITERAL_TYPES.has(type)) {
      return this.leaf();
    }

    if (type === 'new') {
      return this.parseObjectCreation();
    }

    if (type === '(') {
      return this.parseParenthesizedOrCastOrLambda();
    }

    if (type === '{') {
      return this.parseInitializerExpression();
    }

    if (type === '[') {
      return this.parseCollectionExpression();
    }

    if (type === 'delegate') {
      return this.parseAnonymousMethod();
    }

    if (type === 'this' || type === 'base') {
      const startToken = this.pos;
      const children = [this.leaf()];

      return this.finish(type === 'this' ? 'this_expression' : 'base_expression', true, startToken, children);
    }

    if (type === 'typeof' || type === 'sizeof' || type === 'default' || type === 'checked' || type === 'unchecked') {
      const startToken = this.pos;
      const children = [this.leaf()];

      if (this.is('(')) {
        const save = this.pos;
        this.take(children);

        const inner = this.parseType();
        if (inner && this.is(')')) {
          children.push(inner);
          this.take(children);
        } else {
          this.pos = save;
          children.length = 1;
          children.push(this.parseArgumentList());
        }
      }

      return this.finish(`${type}_expression`, true, startToken, children);
    }

    if (type === 'throw') {
      const startToken = this.pos;
      const children = [this.leaf()];
      const value = this.parseExpression();

      if (value) {
        children.push(value);
      }

      return this.finish('throw_expression', true, startToken, children);
    }

    if (type === 'stackalloc') {
      const startToken = this.pos;
      const children = [this.leaf()];
      const inner = this.parseType();

      if (inner) {
        children.push(inner);
      }

      if (this.is('{')) {
        children.push(this.parseInitializerExpression());
      }

      return this.finish('stackalloc_expression', true, startToken, children);
    }

    if (type === 'predefined_type') {
      return this.leaf();
    }

    if (type === 'identifier') {
      return this.parseIdentifierExpression();
    }

    return undefined;
  }

  private parseIdentifierExpression(): Node | undefined {
    const text = this.textOf(this.current);

    // A query expression can only start where an expression is expected, and only once a lookahead
    // confirms the range-variable/`in` shape actually follows - an ordinary variable or method
    // literally named `from` must keep parsing as a plain identifier.
    if (text === 'from') {
      const query = this.tryParseQueryExpression();
      if (query) {
        return query;
      }
    }

    // `async x => ...` and `async (a, b) => ...`
    if (text === 'async' && (this.peek(1).type === '(' || this.peek(1).type === 'identifier' || this.peek(1).type === 'delegate')) {
      const save = this.pos;
      const startToken = this.pos;
      const asyncToken = this.leaf();
      const inner = this.parsePrimary();

      if (inner && (inner.type === 'lambda_expression' || inner.type === 'anonymous_method_expression')) {
        const children = [asyncToken, inner];

        return this.finish(inner.type, true, startToken, children, inner.fields as Map<string, Node> | undefined);
      }

      this.pos = save;
    }

    if (this.peek(1).type === '=>') {
      const startToken = this.pos;
      const parameter = this.leaf();
      const children = [parameter, this.leaf()];
      const fields = new Map<string, Node>([['parameters', parameter]]);
      const body = this.is('{') ? this.parseBlock() : this.parseExpression();

      if (body) {
        children.push(body);
        fields.set('body', body);
      }

      return this.finish('lambda_expression', true, startToken, children, fields);
    }

    // `var` outside a declaration is just an identifier, so no implicit_type node here.
    return this.leaf();
  }

  // ---------------------------------------------------------------- query expressions

  /**
   * `from_clause query_body`. Attempts the clause and rewinds cleanly on any shape mismatch, so an
   * ordinary identifier or method literally named `from` still parses as itself - see the call site
   * in {@link parseIdentifierExpression}.
   */
  private tryParseQueryExpression(): Node | undefined {
    const save = this.pos;
    const startToken = this.pos;
    const from = this.tryParseFromClause();

    if (!from) {
      return undefined;
    }

    const children = [from];

    if (!this.parseQueryBody(children)) {
      this.pos = save;

      return undefined;
    }

    return this.finish('query_expression', true, startToken, children);
  }

  /** `from Type? identifier in expression`. Rewinds and returns `undefined` on a shape mismatch. */
  private tryParseFromClause(): Node | undefined {
    const save = this.pos;
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    const typeOrName = this.parseType();
    if (!typeOrName) {
      this.pos = save;

      return undefined;
    }

    let name = typeOrName;
    children.push(typeOrName);

    if (this.is('identifier')) {
      fields.set('type', typeOrName);
      name = this.take(children);
    }

    fields.set('name', name);

    if (!this.is('in')) {
      this.pos = save;

      return undefined;
    }

    this.take(children);

    const source = this.parseExpression();
    if (source) {
      children.push(source);
      fields.set('source', source);
    }

    return this.finish('from_clause', true, startToken, children, fields);
  }

  /** `query_body_clause* select_or_group_clause query_continuation?`, appended onto `children`. */
  private parseQueryBody(children: Node[]): boolean {
    for (;;) {
      const clause = this.tryParseQueryBodyClause();
      if (!clause) {
        break;
      }

      children.push(clause);
    }

    const finalClause = this.tryParseSelectOrGroupClause();
    if (!finalClause) {
      return false;
    }

    children.push(finalClause);

    const continuation = this.tryParseQueryContinuation();
    if (continuation) {
      children.push(continuation);
    }

    return true;
  }

  /** `from_clause | let_clause | query_where_clause | join_clause | join_into_clause | orderby_clause`. */
  private tryParseQueryBodyClause(): Node | undefined {
    if (this.isContextual('from')) {
      return this.tryParseFromClause();
    }

    if (this.isContextual('let')) {
      return this.parseLetClause();
    }

    if (this.isContextual('where')) {
      return this.parseQueryWhereClause();
    }

    if (this.isContextual('join')) {
      return this.parseJoinClause();
    }

    if (this.isContextual('orderby')) {
      return this.parseOrderByClause();
    }

    return undefined;
  }

  /** `let identifier = expression`, binding a new range variable computed from the current one. */
  private parseLetClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    if (this.is('identifier')) {
      fields.set('name', this.take(children));
    }

    this.eat('=', children);

    const value = this.parseExpression();
    if (value) {
      children.push(value);
      fields.set('value', value);
    }

    return this.finish('let_clause', true, startToken, children, fields);
  }

  /**
   * `where expression`. Named `query_where_clause`, not `where_clause`, so it never collides with
   * `type_parameter_constraints_clause`, which already owns the plain `where` keyword there.
   */
  private parseQueryWhereClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    const condition = this.parseExpression();
    if (condition) {
      children.push(condition);
      fields.set('condition', condition);
    }

    return this.finish('query_where_clause', true, startToken, children, fields);
  }

  /** `join Type? identifier in expression on expression equals expression (into identifier)?`. */
  private parseJoinClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    const typeOrName = this.parseType();
    if (typeOrName) {
      let name = typeOrName;
      children.push(typeOrName);

      if (this.is('identifier')) {
        fields.set('type', typeOrName);
        name = this.take(children);
      }

      fields.set('name', name);
    }

    this.eat('in', children);

    const inExpression = this.parseExpression();
    if (inExpression) {
      children.push(inExpression);
      fields.set('inExpression', inExpression);
    }

    if (this.isContextual('on')) {
      this.take(children);
    }

    const onExpression = this.parseExpression();
    if (onExpression) {
      children.push(onExpression);
      fields.set('onExpression', onExpression);
    }

    if (this.isContextual('equals')) {
      this.take(children);
    }

    const equalsExpression = this.parseExpression();
    if (equalsExpression) {
      children.push(equalsExpression);
      fields.set('equalsExpression', equalsExpression);
    }

    const join = this.finish('join_clause', true, startToken, children, fields);

    return this.isContextual('into') ? this.parseJoinIntoClause(startToken, join) : join;
  }

  /** `join_clause into identifier`. */
  private parseJoinIntoClause(startToken: number, join: Node): Node {
    const children: Node[] = [join, this.leaf()];
    const fields = new Map<string, Node>([['join', join]]);

    if (this.is('identifier')) {
      fields.set('name', this.take(children));
    }

    return this.finish('join_into_clause', true, startToken, children, fields);
  }

  /** `orderby ordering (',' ordering)*`. */
  private parseOrderByClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];

    children.push(this.parseOrdering());

    while (this.is(',')) {
      this.take(children);
      children.push(this.parseOrdering());
    }

    return this.finish('orderby_clause', true, startToken, children);
  }

  /** `expression ('ascending' | 'descending')?`. */
  private parseOrdering(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    const expression = this.parseExpression();
    if (expression) {
      children.push(expression);
      fields.set('expression', expression);
    }

    if (this.isContextual('ascending') || this.isContextual('descending')) {
      this.take(children);
    }

    return this.finish('ordering', true, startToken, children, fields);
  }

  /** `select_clause | group_clause`. */
  private tryParseSelectOrGroupClause(): Node | undefined {
    if (this.isContextual('select')) {
      return this.parseSelectClause();
    }

    if (this.isContextual('group')) {
      return this.parseGroupClause();
    }

    return undefined;
  }

  /** `select expression`. */
  private parseSelectClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    const expression = this.parseExpression();
    if (expression) {
      children.push(expression);
      fields.set('expression', expression);
    }

    return this.finish('select_clause', true, startToken, children, fields);
  }

  /** `group expression by expression`. */
  private parseGroupClause(): Node {
    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    const element = this.parseExpression();
    if (element) {
      children.push(element);
      fields.set('element', element);
    }

    if (this.isContextual('by')) {
      this.take(children);
    }

    const key = this.parseExpression();
    if (key) {
      children.push(key);
      fields.set('key', key);
    }

    return this.finish('group_clause', true, startToken, children, fields);
  }

  /** `into identifier query_body`, continuing the query after a `select`/`group` clause. */
  private tryParseQueryContinuation(): Node | undefined {
    if (!this.isContextual('into')) {
      return undefined;
    }

    const startToken = this.pos;
    const children: Node[] = [this.leaf()];
    const fields = new Map<string, Node>();

    if (this.is('identifier')) {
      fields.set('name', this.take(children));
    }

    this.parseQueryBody(children);

    return this.finish('query_continuation', true, startToken, children, fields);
  }

  private parseAnonymousMethod(): Node {
    const startToken = this.pos;
    const children = [this.leaf()];
    const fields = new Map<string, Node>();

    if (this.is('(')) {
      const parameters = this.parseParameterList();
      children.push(parameters);
      fields.set('parameters', parameters);
    }

    if (this.is('{')) {
      const body = this.parseBlock();
      children.push(body);
      fields.set('body', body);
    }

    return this.finish('anonymous_method_expression', true, startToken, children, fields);
  }

  private parseParenthesizedOrCastOrLambda(): Node | undefined {
    const closing = this.matchingIndex('(', ')');

    if (closing >= 0 && this.tokens[closing + 1]?.type === '=>') {
      const startToken = this.pos;
      const parameters = this.parseParameterList();
      const children = [parameters, this.leaf()];
      const fields = new Map<string, Node>([['parameters', parameters]]);
      const body = this.is('{') ? this.parseBlock() : this.parseExpression();

      if (body) {
        children.push(body);
        fields.set('body', body);
      }

      return this.finish('lambda_expression', true, startToken, children, fields);
    }

    if (this.looksLikeCast(closing)) {
      const startToken = this.pos;
      const children = [this.leaf()];
      const fields = new Map<string, Node>();
      const castType = this.parseType();

      if (castType) {
        children.push(castType);
        fields.set('type', castType);
      }

      this.eat(')', children);

      const value = this.parseUnary();
      if (value) {
        children.push(value);
        fields.set('value', value);
      }

      return this.finish('cast_expression', true, startToken, children, fields);
    }

    const startToken = this.pos;
    const children = [this.leaf()];
    let isTuple = false;

    while (!this.is(')') && !this.is('end')) {
      if (this.is(',')) {
        isTuple = true;
        this.take(children);
        continue;
      }

      const before = this.pos;
      const inner = this.parseExpression();

      if (inner) {
        children.push(inner);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(')', children);

    return this.finish(isTuple ? 'tuple_expression' : 'parenthesized_expression', true, startToken, children);
  }

  private looksLikeCast(closing: number): boolean {
    if (closing < 0 || closing === this.pos + 1) {
      return false;
    }

    for (let i = this.pos + 1; i < closing; i++) {
      const type = this.tokens[i].type;
      if (!TYPE_ARGUMENT_TOKENS.has(type) && type !== '<' && type !== '>') {
        return false;
      }

      // No real type name ever has two bare name-shaped tokens back to back with nothing
      // connecting them (`Foo.Bar`, `Foo<Bar>` - always via `.`/`<`/`::`; never `Foo Bar`).
      // A query expression's clause keywords (`from`, `select`, `where`, ...) lex as plain
      // identifiers, so `(from x in y select x)` would otherwise satisfy every check above.
      if (
        i > this.pos + 1 &&
        (type === 'identifier' || type === 'predefined_type') &&
        (this.tokens[i - 1].type === 'identifier' || this.tokens[i - 1].type === 'predefined_type')
      ) {
        return false;
      }
    }

    const after = this.tokens[closing + 1];
    if (!after) {
      return false;
    }

    // A single predefined type can only be a cast: `(int)x`.
    if (closing === this.pos + 2 && this.tokens[this.pos + 1].type === 'predefined_type') {
      return true;
    }

    return (
      after.type === 'identifier' ||
      after.type === 'predefined_type' ||
      after.type === '(' ||
      after.type === 'this' ||
      after.type === 'base' ||
      after.type === 'new' ||
      after.type === '~' ||
      LITERAL_TYPES.has(after.type)
    );
  }

  private parseObjectCreation(): Node {
    const startToken = this.pos;
    const children = [this.leaf()];
    const fields = new Map<string, Node>();

    if (this.is('(')) {
      const args = this.parseArgumentList();
      children.push(args);
      fields.set('arguments', args);

      if (this.is('{')) {
        const initializer = this.parseInitializerExpression();
        children.push(initializer);
        fields.set('initializer', initializer);
      }

      return this.finish('implicit_object_creation_expression', true, startToken, children, fields);
    }

    if (this.is('[')) {
      children.push(this.parseArrayRankSpecifier());

      if (this.is('{')) {
        children.push(this.parseInitializerExpression());
      }

      return this.finish('implicit_array_creation_expression', true, startToken, children, fields);
    }

    if (this.is('{')) {
      children.push(this.parseInitializerExpression());

      return this.finish('anonymous_object_creation_expression', true, startToken, children, fields);
    }

    const baseType = this.parseTypeBase();
    if (!baseType) {
      return this.finish('object_creation_expression', true, startToken, children, fields);
    }

    if (this.is('[')) {
      let arrayType = baseType;

      while (this.is('[')) {
        const rank = this.parseArrayRankSpecifier();
        const arrayFields = new Map<string, Node>([
          ['type', arrayType],
          ['rank', rank],
        ]);

        arrayType = this.makeNode(
          'array_type',
          true,
          arrayType.startIndex,
          rank.endIndex,
          [arrayType, rank],
          arrayFields
        );
      }

      children.push(arrayType);

      if (this.is('{')) {
        children.push(this.parseInitializerExpression());
      }

      return this.finish('array_creation_expression', true, startToken, children, fields);
    }

    const createdType = this.applyTypeSuffixes(baseType);
    children.push(createdType);
    fields.set('type', createdType);

    if (this.is('(')) {
      const args = this.parseArgumentList();
      children.push(args);
      fields.set('arguments', args);
    }

    if (this.is('{')) {
      const initializer = this.parseInitializerExpression();
      children.push(initializer);
      fields.set('initializer', initializer);
    }

    return this.finish('object_creation_expression', true, startToken, children, fields);
  }

  private applyTypeSuffixes(node: Node): Node {
    let result = node;

    while (this.is('?') && this.canContinueNullableType()) {
      const question = this.leaf();
      result = this.makeNode('nullable_type', true, result.startIndex, question.endIndex, [result, question]);
    }

    return result;
  }

  private parseInitializerExpression(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('{', children);

    while (!this.is('}') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      const element = this.is('{') ? this.parseInitializerExpression() : this.parseInitializerElement();

      if (element) {
        children.push(element);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat('}', children);

    return this.finish('initializer_expression', true, startToken, children);
  }

  /** `{ [key] = value }` and `{ Name = value }` both appear inside object initializers. */
  private parseInitializerElement(): Node | undefined {
    if (this.is('[')) {
      const startToken = this.pos;
      const children = [this.parseBracketedArgumentList()];

      if (this.is('=')) {
        this.take(children);
        const value = this.is('{') ? this.parseInitializerExpression() : this.parseExpression();

        if (value) {
          children.push(value);
        }
      }

      return this.finish('assignment_expression', true, startToken, children);
    }

    return this.parseExpression();
  }

  private parseCollectionExpression(): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect('[', children);

    while (!this.is(']') && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      const element = this.parseExpression();

      if (element) {
        children.push(element);
      }

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(']', children);

    return this.finish('collection_expression', true, startToken, children);
  }

  private parseArgumentList(): Node {
    return this.parseArguments('(', ')', 'argument_list');
  }

  private parseBracketedArgumentList(): Node {
    return this.parseArguments('[', ']', 'bracketed_argument_list');
  }

  private parseArguments(open: string, close: string, type: string): Node {
    const startToken = this.pos;
    const children: Node[] = [];

    this.expect(open, children);

    while (!this.is(close) && !this.is('end')) {
      if (this.is(',')) {
        this.take(children);
        continue;
      }

      const before = this.pos;
      children.push(this.parseArgument());

      if (this.pos === before) {
        this.take(children);
      }
    }

    this.eat(close, children);

    return this.finish(type, true, startToken, children);
  }

  private parseArgument(): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    const fields = new Map<string, Node>();

    if (this.is('identifier') && this.peek(1).type === ':' && this.peek(2).type !== ':') {
      const name = this.take(children);
      fields.set('name', name);
      this.take(children);
    }

    if (this.is('out') || this.is('ref') || this.is('in')) {
      this.take(children);
    }

    // `out var result` / `out int result` declare the variable in place.
    const save = this.pos;
    const declaration = this.tryParseDeclarationExpression();

    if (declaration) {
      children.push(declaration);
    } else {
      this.pos = save;
      const expression = this.parseExpression();

      if (expression) {
        children.push(expression);
      } else if (!this.is(')') && !this.is(']') && !this.is(',') && !this.is('end')) {
        this.take(children);
      }
    }

    return this.finish('argument', true, startToken, children, fields);
  }

  private tryParseDeclarationExpression(): Node | undefined {
    const save = this.pos;
    const type = this.parseType();

    if (!type || !this.is('identifier')) {
      this.pos = save;

      return undefined;
    }

    const name = this.leaf();
    const fields = new Map<string, Node>([
      ['type', type],
      ['name', name],
    ]);

    return this.makeNode('declaration_expression', true, type.startIndex, name.endIndex, [type, name], fields);
  }

  /** Consumes a balanced `{ ... }` run as a single opaque node. */
  private parseBraceRun(type: string): Node {
    const startToken = this.pos;
    const children: Node[] = [];
    let depth = 0;

    do {
      if (this.is('{')) {
        depth++;
      } else if (this.is('}')) {
        depth--;
      }

      this.take(children);
    } while (depth > 0 && !this.is('end'));

    return this.finish(type, true, startToken, children);
  }

  /** Index of the token closing the bracket at the current position, or -1. */
  private matchingIndex(open: string, close: string): number {
    let depth = 0;

    for (let i = this.pos; i < this.tokens.length; i++) {
      const type = this.tokens[i].type;

      if (type === open) {
        depth++;
      } else if (type === close) {
        depth--;

        if (depth === 0) {
          return i;
        }
      } else if (type === 'end') {
        return -1;
      }
    }

    return -1;
  }
}

/**
 * Re-attaches comments and preprocessor directives, which the parser skips, to the deepest node
 * that spans them. Doc comments therefore end up as siblings of the member they document, which is
 * what the blank-line and documentation rules navigate to.
 */
function attachTrivia(document: SyntaxDocument, root: Node, trivia: readonly Token[]): void {
  for (const token of trivia) {
    const node = new Node(document, token.type, token.isNamed, token.start, token.end);
    const host = deepestContaining(root, token.start, token.end);
    const children = host.children as Node[];

    let index = children.length;
    for (let i = 0; i < children.length; i++) {
      if (children[i].startIndex > token.start) {
        index = i;
        break;
      }
    }

    children.splice(index, 0, node);
  }
}

function deepestContaining(root: Node, start: number, end: number): Node {
  let host = root;

  for (;;) {
    // Token leaves never span trivia, so a childless match means the current host is the deepest.
    const child = host.children.find((candidate) => candidate.startIndex <= start && candidate.endIndex >= end);

    if (!child || child.children.length === 0) {
      return host;
    }

    host = child;
  }
}
