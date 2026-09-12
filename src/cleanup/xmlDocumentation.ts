import { Node, findAll, parseCSharp, walk } from './parser';

/**
 * Roslyn-free XML documentation generation. The engine decides *which* members need documentation,
 * *what* to ask the model about them, and *how* the resulting comment block is rendered and
 * inserted; the AI round-trip itself happens in the extension, which sends the summaries back
 * through {@link applySummaries}.
 */

export const XML_DOC_SYSTEM_PROMPT =
  'You are a principal .NET software architect and technical writer authoring official Microsoft-standard XML documentation comments (<summary>).\n' +
  'Your task is to write a single-sentence, professional, production-grade summary for the given C# code element.\n' +
  'Rules:\n' +
  '1. Output EXACTLY ONE concise, high-quality summary sentence in plain text. No XML tags, no markdown quotes, no preambles, no reasoning, no thinking steps.\n' +
  "2. Never output generic or vague filler like 'Performs the operation.', 'Represents the class.', 'Executes the method.', or 'Contains data.'.\n" +
  '3. Use standard .NET conventions:\n' +
  "   - Commands (e.g., CreateRecipeCommand): 'Represents a command to create a new recipe with the specified details.'\n" +
  "   - Queries (e.g., GetRecipeByIdQuery): 'Represents a query to retrieve recipe details by identifier.'\n" +
  "   - DTOs / Records / Models: 'Represents the data structure containing {domain} details.'\n" +
  "   - Interfaces: 'Defines a contract for {domain} operations.'\n" +
  "   - Methods: start with third-person singular present tense active verbs ('Creates...', 'Calculates...', 'Asynchronously processes...', 'Handles...').\n" +
  "   - Enums: 'Specifies the available {category} options.'\n" +
  '4. Pay close attention to the element name, base types, interfaces, parameters, and properties to deduce the exact business domain semantics.';

export interface XmlDocRunOptions {
  maxMembersPerFile: number;
  maxInputCharsPerMember: number;
  ignoreGeneratedCode: boolean;
  ignoreObsolete: boolean;
  ignoreTestMethods: boolean;
  ignorePattern: string;
}

export interface XmlDocTarget {
  index: number;
  kind: string;
  memberName: string;
  line: number;
  requiresAi: boolean;
  prompt?: string;
  fallbackSummary: string;
}

/** The permissive defaults the source repo used for its own helper entry point. */
export function createDefaultXmlDocOptions(maxMembersPerFile = 25): XmlDocRunOptions {
  return {
    maxMembersPerFile: maxMembersPerFile > 0 ? maxMembersPerFile : 25,
    maxInputCharsPerMember: 2500,
    ignoreGeneratedCode: false,
    ignoreObsolete: false,
    ignoreTestMethods: false,
    ignorePattern: '',
  };
}

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
  'enum_declaration',
]);

const DOCUMENTABLE = new Set([
  'method_declaration',
  'constructor_declaration',
  ...TYPE_DECLARATIONS,
  'property_declaration',
  'field_declaration',
  'indexer_declaration',
  'event_declaration',
  'event_field_declaration',
]);

const TEST_ATTRIBUTES = ['TestMethod', 'Fact', 'Theory', 'Test', 'TestCase', 'DataTestMethod'];

/**
 * Parses the source and returns the members that should be documented, in declaration order, with
 * the prompt to ask the model (AI members) or the deterministic summary that needs no request at
 * all (properties, fields, indexers, events).
 */
export function planTargets(source: string, options: XmlDocRunOptions): XmlDocTarget[] {
  if (!source || !source.trim()) {
    return [];
  }

  const tree = parseCSharp(source);

  try {
    return selectTargets(tree.rootNode, options).map((member, index) => {
      const requiresAi = requiresAiSummary(member);

      return {
        index,
        kind: describeKind(member),
        memberName: describeName(member),
        line: member.startPosition.row,
        requiresAi,
        prompt: requiresAi ? buildPrompt(member, options) : undefined,
        fallbackSummary: buildFallbackSummary(member),
      };
    });
  } finally {
    tree.delete();
  }
}

/**
 * Re-plans the same members and inserts a documentation block for each one, using the summary
 * supplied for its index. Members whose summary is missing keep their deterministic text when they
 * never needed AI, and are skipped otherwise.
 */
export function applySummaries(
  source: string,
  options: XmlDocRunOptions,
  summaries: Readonly<Record<number, string>>
): string {
  return generateXmlDocumentation(source, options, (member, index) => {
    const summary = summaries[index];
    if (summary && summary.trim()) {
      return summary;
    }

    return requiresAiSummary(member) ? undefined : buildFallbackSummary(member);
  });
}

/** Generates documentation using a caller-provided summary factory (used by the tests). */
export function generateXmlDocumentation(
  source: string,
  options: XmlDocRunOptions,
  summaryProvider: (member: Node, index: number) => string | undefined
): string {
  if (!source || !source.trim()) {
    return source;
  }

  const tree = parseCSharp(source);
  let builder = source;

  try {
    const targets = selectTargets(tree.rootNode, options);

    // Bottom-up, so earlier insertions never invalidate the offsets still to be used.
    for (let index = targets.length - 1; index >= 0; index--) {
      const member = targets[index];
      const rawSummary = summaryProvider(member, index);
      if (!rawSummary || !rawSummary.trim()) {
        continue;
      }

      const insertPosition = lineStart(builder, member.startIndex);
      const indent = lineIndent(builder, insertPosition);
      const exceptions =
        member.type === 'method_declaration' || member.type === 'constructor_declaration'
          ? detectThrownExceptions(member)
          : [];
      const block = buildXmlCommentBlock(indent, member, normalizeSentence(rawSummary), exceptions);

      builder = builder.slice(0, insertPosition) + block + builder.slice(insertPosition);
    }

    return builder;
  } finally {
    tree.delete();
  }
}

/**
 * Selects the documentable members in declaration order, applying the per-file budget only to the
 * members that need an AI request while deterministic members all pass in one go.
 */
function selectTargets(root: Node, options: XmlDocRunOptions): Node[] {
  const eligible = findAll(root, [...DOCUMENTABLE])
    .filter((member) => canDocumentMember(member, options))
    .sort((a, b) => a.startIndex - b.startIndex);

  if (eligible.length === 0) {
    return eligible;
  }

  const limit = options.maxMembersPerFile > 0 ? options.maxMembersPerFile : 25;
  const aiCandidates = eligible.filter(requiresAiSummary).slice(0, limit);
  const deterministic = eligible.filter((member) => !requiresAiSummary(member));

  return [...aiCandidates, ...deterministic].sort((a, b) => a.startIndex - b.startIndex);
}

/** Property, field, indexer and event wording is formulaic, so it never costs an AI request. */
function requiresAiSummary(member: Node): boolean {
  return (
    member.type === 'method_declaration' ||
    member.type === 'constructor_declaration' ||
    TYPE_DECLARATIONS.has(member.type)
  );
}

function canDocumentMember(member: Node, options: XmlDocRunOptions): boolean {
  if (member.type === 'method_declaration') {
    return canDocumentMethod(member, options);
  }

  if (member.type === 'constructor_declaration') {
    return canDocumentConstructor(member, options);
  }

  if (isInInterface(member) && member.type !== 'interface_declaration') {
    return false;
  }

  if (member.type === 'field_declaration') {
    const declarators = variableDeclarators(member);
    if (declarators.length === 0) {
      return false;
    }

    if (!hasAnyModifier(member, ['public', 'internal', 'protected', 'const'])) {
      return false;
    }
  }

  if (options.ignoreTestMethods && TYPE_DECLARATIONS.has(member.type)) {
    if (isLikelyTestType(member)) {
      return false;
    }
  }

  if (hasDocumentationComment(member)) {
    return false;
  }

  if (options.ignoreObsolete && hasAnyAttribute(member, ['Obsolete'])) {
    return false;
  }

  if (options.ignoreGeneratedCode && hasGeneratedCodeAttribute(member)) {
    return false;
  }

  return true;
}

function canDocumentConstructor(constructor: Node, options: XmlDocRunOptions): boolean {
  if (hasAnyModifier(constructor, ['static', 'extern'])) {
    return false;
  }

  const body = constructor.childForFieldName('body') ?? constructor.childForFieldName('expression_body');
  if (!body) {
    return false;
  }

  if (hasDocumentationComment(constructor)) {
    return false;
  }

  if (options.ignoreObsolete && hasAnyAttribute(constructor, ['Obsolete'])) {
    return false;
  }

  if (options.ignoreGeneratedCode && hasGeneratedCodeAttribute(constructor)) {
    return false;
  }

  const containingType = getContainingTypeNode(constructor);
  if (options.ignoreTestMethods && isLikelyTestType(containingType)) {
    return false;
  }

  return !(options.ignorePattern.trim() && matchesIgnorePattern(constructor, options.ignorePattern));
}

function canDocumentMethod(method: Node, options: XmlDocRunOptions): boolean {
  if (isInInterface(method)) {
    return false;
  }

  if (hasAnyModifier(method, ['abstract', 'extern'])) {
    return false;
  }

  const body = method.childForFieldName('body') ?? method.childForFieldName('expression_body');
  if (!body) {
    return false;
  }

  if (hasDocumentationComment(method)) {
    return false;
  }

  if (options.ignoreObsolete && hasAnyAttribute(method, ['Obsolete'])) {
    return false;
  }

  if (options.ignoreGeneratedCode && hasGeneratedCodeAttribute(method)) {
    return false;
  }

  if (options.ignoreTestMethods && isLikelyTestMethod(method)) {
    return false;
  }

  return !(options.ignorePattern.trim() && matchesIgnorePattern(method, options.ignorePattern));
}

function isInInterface(member: Node): boolean {
  const container = member.parent;

  return container?.type === 'declaration_list' && container.parent?.type === 'interface_declaration';
}

function getContainingTypeNode(member: Node): Node | undefined {
  return member.parent?.type === 'declaration_list' ? member.parent.parent ?? undefined : undefined;
}

function getContainingTypeInfo(member: Node): { containingTypeName: string; typeKind: string } {
  const typeNode = getContainingTypeNode(member);
  const containingTypeName = typeNode?.childForFieldName('name')?.text ?? 'instance';
  const typeKind =
    typeNode?.type === 'record_declaration'
      ? 'record'
      : typeNode?.type === 'struct_declaration'
      ? 'struct'
      : 'class';

  return { containingTypeName, typeKind };
}

function isLikelyTestType(typeNode?: Node): boolean {
  if (!typeNode) {
    return false;
  }

  const name = typeNode.childForFieldName('name')?.text ?? '';
  if (/tests?$/i.test(name)) {
    return true;
  }

  return hasAnyAttribute(typeNode, TEST_ATTRIBUTES);
}

function hasAnyModifier(node: Node, names: readonly string[]): boolean {
  return node.namedChildren.some((child) => child?.type === 'modifier' && names.includes(child.text));
}

function variableDeclarators(node: Node): Node[] {
  const declaration = node.namedChildren.find((child) => child?.type === 'variable_declaration');

  return (declaration?.namedChildren ?? []).filter((child): child is Node => child?.type === 'variable_declarator');
}

function hasAnyAttribute(node: Node, names: readonly string[]): boolean {
  const targets = names.map((name) => name.toLowerCase());

  for (const list of node.namedChildren) {
    if (list?.type !== 'attribute_list') {
      continue;
    }

    for (const attribute of list.namedChildren) {
      const raw = attribute?.childForFieldName('name')?.text ?? attribute?.text ?? '';
      const normalized = raw.split('.').pop()!.replace(/Attribute$/, '').toLowerCase();
      if (targets.includes(normalized)) {
        return true;
      }
    }
  }

  return false;
}

function hasGeneratedCodeAttribute(member: Node): boolean {
  const names = ['GeneratedCode', 'CompilerGenerated'];
  if (hasAnyAttribute(member, names)) {
    return true;
  }

  const owner = member.parent?.type === 'declaration_list' ? member.parent.parent : undefined;

  return owner !== undefined && owner !== null && hasAnyAttribute(owner, names);
}

function isLikelyTestMethod(method: Node): boolean {
  if (hasAnyAttribute(method, TEST_ATTRIBUTES)) {
    return true;
  }

  const owner = getContainingTypeNode(method);

  return isLikelyTestType(owner);
}

function matchesIgnorePattern(member: Node, ignorePattern: string): boolean {
  try {
    const owner = getContainingTypeNode(member);
    const typeName = owner?.childForFieldName('name')?.text ?? '';
    const namespaceName = enclosingNamespace(member);
    const memberName = member.childForFieldName('name')?.text ?? '';
    const fullName = namespaceName ? `${namespaceName}.${typeName}.${memberName}` : `${typeName}.${memberName}`;

    return new RegExp(ignorePattern, 'i').test(fullName);
  } catch {
    return false;
  }
}

function enclosingNamespace(node: Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'namespace_declaration' || current.type === 'file_scoped_namespace_declaration') {
      return current.childForFieldName('name')?.text ?? '';
    }
  }

  return '';
}

function hasDocumentationComment(member: Node): boolean {
  for (let sibling = member.previousNamedSibling; sibling?.type === 'comment'; sibling = sibling.previousNamedSibling) {
    if (sibling.text.startsWith('///') || sibling.text.startsWith('/**')) {
      return true;
    }
  }

  return false;
}

function describeKind(member: Node): string {
  switch (member.type) {
    case 'method_declaration':
      return 'method';
    case 'constructor_declaration':
      return 'constructor';
    case 'interface_declaration':
      return 'interface';
    case 'enum_declaration':
      return 'enum';
    case 'record_declaration':
      return 'record';
    case 'struct_declaration':
      return 'struct';
    case 'class_declaration':
      return 'class';
    case 'property_declaration':
      return 'property';
    case 'indexer_declaration':
      return 'indexer';
    case 'field_declaration':
      return 'field';
    default:
      return 'event';
  }
}

function describeName(member: Node): string {
  if (member.type === 'indexer_declaration') {
    return 'this[]';
  }

  if (member.type === 'field_declaration' || member.type === 'event_field_declaration') {
    const declarator = variableDeclarators(member)[0];

    return (declarator?.childForFieldName('name') ?? declarator?.namedChild(0))?.text ?? 'member';
  }

  return member.childForFieldName('name')?.text ?? 'member';
}

function buildPrompt(member: Node, options: XmlDocRunOptions): string {
  if (member.type === 'method_declaration') {
    return buildMethodPrompt(member, options);
  }

  if (member.type === 'constructor_declaration') {
    return buildConstructorPrompt(member, options);
  }

  return buildTypePrompt(member, options);
}

function buildConstructorPrompt(constructor: Node, options: XmlDocRunOptions): string {
  const body = constructor.childForFieldName('body') ?? constructor.childForFieldName('expression_body');
  const signature = constructor.text
    .slice(0, body ? body.startIndex - constructor.startIndex : undefined)
    .replace(/\s+/g, ' ')
    .trim();

  const bodyText = body ? body.text.trim() : '';
  const exceptions = detectThrownExceptions(constructor);
  const exceptionList = exceptions.length > 0 ? exceptions.join(', ') : 'none detected';
  const { containingTypeName, typeKind } = getContainingTypeInfo(constructor);

  return (
    `Generate a professional C# XML documentation <summary> sentence for the following C# constructor of ${typeKind} '${containingTypeName}':\n` +
    `Signature: ${signature}\n` +
    `Constructor body:\n${truncate(bodyText, options.maxInputCharsPerMember)}\n` +
    `Detected thrown exceptions: ${exceptionList}\n\n` +
    'Guidelines:\n' +
    `- Standard Microsoft style for constructors: 'Initializes a new instance of the ${containingTypeName} ${typeKind}.' or 'Initializes a new instance of the ${containingTypeName} ${typeKind} with the specified parameters.'\n` +
    '- Describe any validation or initialization done by the constructor.\n' +
    "- Do NOT output vague generic filler.\n" +
    '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
  );
}

function buildMethodPrompt(method: Node, options: XmlDocRunOptions): string {
  const body = method.childForFieldName('body');
  const signature = method.text
    .slice(0, body ? body.startIndex - method.startIndex : undefined)
    .replace(/\s+/g, ' ')
    .trim();

  const bodyText = body ? body.text.trim() : '';
  const exceptions = detectThrownExceptions(method);
  const exceptionList = exceptions.length > 0 ? exceptions.join(', ') : 'none detected';

  return (
    'Generate a professional C# XML documentation <summary> sentence for the following C# method:\n' +
    `Signature: ${signature}\n` +
    `Method body:\n${truncate(bodyText, options.maxInputCharsPerMember)}\n` +
    `Detected thrown exceptions: ${exceptionList}\n\n` +
    'Guidelines:\n' +
    "- Start with a third-person singular active verb (e.g., 'Asynchronously retrieves...', 'Executes the...', 'Validates and parses...').\n" +
    '- Describe what the method does and any important outcome or side effect.\n' +
    "- Do NOT output vague generic filler like 'Performs the operation.' or 'Executes the action.'\n" +
    '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
  );
}

function buildTypePrompt(type: Node, options: XmlDocRunOptions): string {
  const header = type.childForFieldName('name')?.text ?? '';
  const kind = describeKind(type);
  const memberNames: string[] = [];

  const parameters = type.childForFieldName('parameters');
  if (parameters) {
    for (const parameter of parameters.namedChildren) {
      if (parameter?.type === 'parameter') {
        const parameterType = parameter.childForFieldName('type')?.text ?? 'object';
        memberNames.push(`${parameter.childForFieldName('name')?.text ?? ''} (${parameterType})`);
      }
    }
  }

  const body = type.childForFieldName('body');
  for (const child of body?.namedChildren ?? []) {
    if (child?.type === 'property_declaration') {
      memberNames.push(`${child.childForFieldName('name')?.text} (${child.childForFieldName('type')?.text ?? 'property'})`);
    } else if (child?.type === 'method_declaration' || child?.type === 'constructor_declaration') {
      memberNames.push(`${child.childForFieldName('name')?.text}()`);
    } else if (child?.type === 'field_declaration') {
      for (const declarator of variableDeclarators(child)) {
        memberNames.push((declarator.childForFieldName('name') ?? declarator.namedChild(0))?.text ?? '');
      }
    } else if (child?.type === 'enum_member_declaration') {
      memberNames.push(child.childForFieldName('name')?.text ?? child.text);
    }
  }

  const baseList = type.namedChildren.find((child) => child?.type === 'base_list');
  const baseTypes = (baseList?.namedChildren ?? []).filter((child): child is Node => Boolean(child));
  const baseListText = baseTypes.length > 0 ? baseTypes.map((child) => child.text).join(', ') : 'none';
  const members = memberNames.length === 0 ? 'none' : memberNames.join(', ');

  const modifiers = type.namedChildren
    .filter((child) => child?.type === 'modifier')
    .map((child) => child!.text)
    .join(' ');

  let declarationSignature = `${modifiers} ${kind} ${header}`;
  if (parameters) {
    declarationSignature += parameters.text;
  }

  if (baseList) {
    declarationSignature += ` ${baseList.text}`;
  }

  return (
    `Generate a professional C# XML documentation <summary> sentence for the following C# ${kind}:\n` +
    `Declaration: ${declarationSignature}\n` +
    `Kind: ${kind}\n` +
    `Name: ${header}\n` +
    `Implemented interfaces / base types: ${baseListText}\n` +
    `Parameters / Properties / Members: ${truncate(members, options.maxInputCharsPerMember)}\n\n` +
    'Guidelines:\n' +
    "- If this is a Command (e.g. implements ICommand, IRequest, or ends with 'Command'): start with 'Represents a command to {action}...' or 'Defines the command for {action}...' describing what action will be initiated and what data it carries.\n" +
    "- If this is a Query (e.g. implements IQuery, IRequest, or ends with 'Query'): start with 'Represents a query to retrieve {noun}...'.\n" +
    "- If this is a DTO, response, or event (e.g. ends with 'Dto', 'Response', 'Event'): start with 'Represents {noun}...' describing the data it encapsulates.\n" +
    "- If this is an Interface: start with 'Defines a contract for...' or 'Provides an abstraction for...'.\n" +
    '- If this is a marker interface with no members: state that it serves as a marker/indicator contract for type checking or pipeline dispatch.\n' +
    "- If this is a Class/Struct/Record: start with 'Represents...' or 'Provides...' describing its primary responsibility.\n" +
    "- If this is an Enum: start with 'Specifies...' or 'Defines constants for...'.\n" +
    "- Do NOT output vague generic filler like 'Performs the operation.' or 'Represents the object.' Be specific to the domain name and properties.\n" +
    '- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).'
  );
}

function detectThrownExceptions(method: Node): string[] {
  const exceptions = new Set<string>();

  for (const node of walk(method)) {
    if (node.type === 'throw_statement' || node.type === 'throw_expression') {
      const creation = node.namedChild(0);
      if (creation?.type === 'object_creation_expression') {
        const type = creation.childForFieldName('type')?.text;
        if (type) {
          exceptions.add(type);
        }
      }

      continue;
    }

    if (node.type !== 'invocation_expression') {
      continue;
    }

    const name = node.childForFieldName('function')?.text ?? '';
    if (/ThrowIfNull/i.test(name)) {
      exceptions.add('ArgumentNullException');
    } else if (/ThrowIfNullOrEmpty|ThrowIfNullOrWhiteSpace/i.test(name)) {
      exceptions.add('ArgumentException');
    } else if (/ThrowIfNegative/i.test(name)) {
      exceptions.add('ArgumentOutOfRangeException');
    }
  }

  return [...exceptions];
}

function lineStart(text: string, index: number): number {
  const newlineIndex = text.lastIndexOf('\n', Math.max(0, Math.min(index, text.length) - 1));

  return newlineIndex < 0 ? 0 : newlineIndex + 1;
}

function lineIndent(source: string, position: number): string {
  let i = position;
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
    i++;
  }

  return source.slice(position, i);
}

function buildXmlCommentBlock(indent: string, member: Node, summary: string, exceptionTypes: readonly string[]): string {
  const newline = '\n';
  let block = `${indent}/// <summary>${newline}${indent}/// ${xmlEscape(summary)}${newline}${indent}/// </summary>${newline}`;

  const parameters = documentedParameters(member);
  for (const parameter of parameters) {
    const parameterName = parameter.childForFieldName('name')?.text;
    if (!parameterName) {
      continue;
    }

    const parameterType = parameter.childForFieldName('type')?.text;
    block += `${indent}/// <param name="${parameterName}">${xmlEscape(
      buildParameterDescription(parameterName, parameterType)
    )}</param>${newline}`;
  }

  if (member.type === 'method_declaration') {
    const returnType = member.childForFieldName('type')?.text;
    if (returnType && returnType.toLowerCase() !== 'void') {
      const methodName = member.childForFieldName('name')?.text;
      block += `${indent}/// <returns>${xmlEscape(buildReturnDescription(returnType, methodName))}</returns>${newline}`;
    }
  }

  for (const exceptionType of [...exceptionTypes].sort()) {
    block += `${indent}/// <exception cref="${xmlEscape(exceptionType)}">${xmlEscape(
      'Thrown when an error occurs during execution.'
    )}</exception>${newline}`;
  }

  return block;
}

function documentedParameters(member: Node): Node[] {
  if (
    member.type !== 'method_declaration' &&
    member.type !== 'constructor_declaration' &&
    member.type !== 'record_declaration'
  ) {
    return [];
  }

  const list = member.childForFieldName('parameters');

  return (list?.namedChildren ?? []).filter((child): child is Node => child?.type === 'parameter');
}

function buildParameterDescription(parameterName: string, parameterType?: string): string {
  if (!parameterName.trim()) {
    return 'The parameter value.';
  }

  if (parameterName.toLowerCase() === 'cancellationtoken' || parameterType?.toLowerCase() === 'cancellationtoken') {
    return 'The cancellation token to monitor for cancellation requests.';
  }

  if (parameterName.toLowerCase() === 'id') {
    return 'The unique identifier.';
  }

  if (/id$/i.test(parameterName) && parameterName.length > 2) {
    return `The unique identifier of the ${splitIdentifier(parameterName.slice(0, -2)).toLowerCase()}.`;
  }

  if (/(dto|request|command)$/i.test(parameterName)) {
    return `The ${splitIdentifier(parameterName).toLowerCase()} containing the operation data.`;
  }

  const split = splitIdentifier(parameterName).toLowerCase();
  if (parameterType && (/^(List|IList|IEnumerable|IReadOnlyList)</.test(parameterType) || parameterType.endsWith('[]'))) {
    return `The collection of ${split}.`;
  }

  return `The ${split}.`;
}

function buildReturnDescription(returnType: string, methodName?: string): string {
  if (!returnType.trim()) {
    return 'The result of the operation.';
  }

  if (/^(bool|Boolean)$/i.test(returnType)) {
    return methodName && /^(is|has|can|try)/i.test(methodName)
      ? 'true if the condition is met; otherwise, false.'
      : 'true if the operation succeeded; otherwise, false.';
  }

  if (/^task$/i.test(returnType)) {
    return 'A task representing the asynchronous operation.';
  }

  if (/^valuetask$/i.test(returnType)) {
    return 'A value task representing the asynchronous operation.';
  }

  if (/^task</i.test(returnType) && returnType.endsWith('>')) {
    const inner = returnType.slice(5, -1).trim();

    return /^bool$/i.test(inner)
      ? 'A task representing the asynchronous operation. The task result is true if successful; otherwise, false.'
      : `A task representing the asynchronous operation. The task result contains the ${cleanGenericTypeName(inner)}.`;
  }

  if (/^valuetask</i.test(returnType) && returnType.endsWith('>')) {
    const inner = returnType.slice(10, -1).trim();

    return `A value task representing the asynchronous operation. The task result contains the ${cleanGenericTypeName(inner)}.`;
  }

  if (/^(IEnumerable|IReadOnlyList|List)</.test(returnType) || returnType.endsWith('[]')) {
    return `A collection of ${cleanGenericTypeName(returnType)} items.`;
  }

  return `The ${cleanGenericTypeName(returnType)} result.`;
}

function cleanGenericTypeName(typeName: string): string {
  if (!typeName.trim()) {
    return 'result';
  }

  const index = typeName.indexOf('<');
  const baseName = (index > 0 ? typeName.slice(0, index) : typeName).replace(/\[\]/g, '');

  return splitIdentifier(baseName).toLowerCase();
}

function buildPropertySummary(property: Node): string {
  const accessorList = property.childForFieldName('accessors');
  const accessors = (accessorList?.namedChildren ?? []).filter(
    (child): child is Node => child?.type === 'accessor_declaration'
  );

  const accessorKinds = accessors.map((accessor) => accessor.children.find((child) => child?.type !== 'block')?.type);
  let hasGet = accessorKinds.includes('get');
  const hasSet = accessorKinds.includes('set') || accessorKinds.includes('init');

  const value = property.childForFieldName('value');
  if (accessors.length === 0 && value) {
    hasGet = true;
  }

  if (!hasGet && !hasSet && value) {
    hasGet = true;
  }

  const propertyType = property.childForFieldName('type')?.text ?? '';
  const split = splitIdentifier(property.childForFieldName('name')?.text ?? '').toLowerCase();

  if (/^(bool|Boolean)$/i.test(propertyType)) {
    if (hasGet && hasSet) {
      return `Gets or sets a value indicating whether ${split}.`;
    }

    return hasSet ? `Sets a value indicating whether ${split}.` : `Gets a value indicating whether ${split}.`;
  }

  const verb = hasGet && hasSet ? 'Gets or sets' : hasSet ? 'Sets' : 'Gets';

  if (/^(List|IList|IReadOnlyList|IEnumerable|ICollection)</.test(propertyType) || propertyType.endsWith('[]')) {
    return `${verb} the collection of ${split}.`;
  }

  return `${verb} the ${split}.`;
}

/** The deterministic summary used when no AI request is made, or when the model call failed. */
export function buildFallbackSummary(member: Node): string {
  if (TYPE_DECLARATIONS.has(member.type)) {
    const typeName = member.childForFieldName('name')?.text ?? '';

    if (member.type === 'interface_declaration') {
      return `Defines a contract for ${splitIdentifier(typeName).toLowerCase()}.`;
    }

    if (/command$/i.test(typeName)) {
      const split = splitIdentifier(typeName.slice(0, -'Command'.length)).toLowerCase();

      return `Represents a command to ${split || 'execute the operation'}.`;
    }

    if (/query$/i.test(typeName)) {
      const split = splitIdentifier(typeName.slice(0, -'Query'.length)).toLowerCase();

      return `Represents a query to retrieve ${split || 'the requested data'}.`;
    }

    if (/(dto|response|request)$/i.test(typeName)) {
      return `Represents the data structure for ${splitIdentifier(typeName).toLowerCase()}.`;
    }

    return `Represents ${splitIdentifier(typeName).toLowerCase()}.`;
  }

  if (member.type === 'property_declaration') {
    return buildPropertySummary(member);
  }

  if (member.type === 'field_declaration') {
    const declarator = variableDeclarators(member)[0];
    const name = (declarator?.childForFieldName('name') ?? declarator?.namedChild(0))?.text ?? 'value';

    return `The ${splitIdentifier(name).toLowerCase()}.`;
  }

  if (member.type === 'indexer_declaration') {
    return 'Gets or sets the element at the specified index.';
  }

  if (member.type === 'event_declaration' || member.type === 'event_field_declaration') {
    return `Occurs when ${splitIdentifier(describeName(member)).toLowerCase()}.`;
  }

  if (member.type === 'constructor_declaration') {
    const { containingTypeName, typeKind } = getContainingTypeInfo(member);
    const hasParams = documentedParameters(member).length > 0;

    return hasParams
      ? `Initializes a new instance of the ${containingTypeName} ${typeKind} with the specified parameters.`
      : `Initializes a new instance of the ${containingTypeName} ${typeKind}.`;
  }

  const methodName = member.childForFieldName('name')?.text ?? '';
  const splitMethod = splitIdentifier(methodName).toLowerCase();

  return `Executes ${splitMethod || 'the method'}.`;
}

function splitIdentifier(identifier: string): string {
  if (!identifier.trim()) {
    return 'the operation';
  }

  return identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

/**
 * Strips thinking process, chain-of-thought blocks, markdown fences and preambles from a model
 * completion.
 */
export function sanitizeAiCompletion(text: string): string {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();

  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');

  if (/^(?:\*{0,2})Thinking Process(?:\*{0,2})\s*:/i.test(cleaned)) {
    const drafts = [...cleaned.matchAll(/(?:Draft\s*\d+|Final Draft|Summary)\s*(?:\([^)]*\))?\s*:\s*\*?\*?([^\n\r*]+)/gi)];
    const candidate = drafts.length > 0 ? drafts[drafts.length - 1][1].trim() : '';
    cleaned = candidate.length > 5 ? candidate : '';
  }

  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '');
  cleaned = cleaned.replace(/\s*```$/, '');
  cleaned = cleaned.replace(/^(?:Here is (?:the|a) (?:concise )?summary(?:\s+sentence)?:\s*|Summary:\s*|Description:\s*)/i, '');
  cleaned = cleaned.replace(/^(?:\s*\/\/\/\s*(?:<summary>)?\s*)+/i, '');
  cleaned = cleaned.replace(/(?:\s*\/\/\/\s*<\/summary>\s*)+$/i, '');

  return cleaned.trim();
}

/** Collapses whitespace, trims quotes and guarantees terminating punctuation. */
export function normalizeSentence(text: string): string {
  const compact = sanitizeAiCompletion(text).replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Performs the operation.';
  }

  const trimmed = compact.replace(/^["'`*]+/, '').replace(/["'`*]+$/, '');

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function xmlEscape(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(text: string, maxLength: number): string {
  return !text || text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}
