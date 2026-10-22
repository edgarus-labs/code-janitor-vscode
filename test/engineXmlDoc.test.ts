import { describe, expect, it } from 'vitest';
import { XmlDocTargetResult } from '../src/engine/protocol';
import { insertXmlDocumentation, normalizeSentence, planXmlDocumentation, sanitizeAiCompletion } from '../src/engine/xmlDoc';

const SOURCE = [
  'namespace Shop;',
  '',
  'public class OrderService',
  '{',
  '    public OrderService(IStore store) { }',
  '',
  '    public bool IsOpen { get; set; }',
  '',
  '    public async Task<Order> GetOrderAsync(int orderId, CancellationToken cancellationToken)',
  '    {',
  '        ArgumentOutOfRangeException.ThrowIfNegative(orderId);',
  '        return await store.Find(orderId);',
  '    }',
  '}',
  '',
].join('\n');

const NONE = {
  parameters: [],
  typeParameters: [],
  returnType: null,
  containingType: null,
  exceptions: [],
  accessors: null,
  baseTypes: [],
  members: [],
  modifiers: [],
  body: '',
};

const TARGETS: XmlDocTargetResult[] = [
  {
    ...NONE,
    name: 'OrderService',
    kind: 'class',
    text: 'public class OrderService',
    insertionLine: 2,
    indent: '',
    signature: 'public class OrderService',
    members: ['OrderService()', 'IsOpen (bool)', 'GetOrderAsync()'],
    modifiers: ['public'],
  },
  {
    ...NONE,
    name: 'OrderService',
    kind: 'constructor',
    text: 'public OrderService(IStore store) { }',
    insertionLine: 4,
    indent: '    ',
    signature: 'public OrderService(IStore store)',
    parameters: [{ name: 'store', type: 'IStore' }],
    containingType: { name: 'OrderService', kind: 'class' },
  },
  {
    ...NONE,
    name: 'IsOpen',
    kind: 'property',
    text: 'public bool IsOpen { get; set; }',
    insertionLine: 6,
    indent: '    ',
    signature: 'public bool IsOpen',
    accessors: { get: true, set: true },
    containingType: { name: 'OrderService', kind: 'class' },
  },
  {
    ...NONE,
    name: 'GetOrderAsync',
    kind: 'method',
    text: 'public async Task<Order> GetOrderAsync(...)',
    insertionLine: 8,
    indent: '    ',
    signature: 'public async Task<Order> GetOrderAsync(int orderId, CancellationToken cancellationToken)',
    body: '{ ArgumentOutOfRangeException.ThrowIfNegative(orderId); return await store.Find(orderId); }',
    parameters: [
      { name: 'orderId', type: 'int' },
      { name: 'cancellationToken', type: 'CancellationToken' },
    ],
    returnType: 'Task<Order>',
    exceptions: ['ArgumentOutOfRangeException'],
    containingType: { name: 'OrderService', kind: 'class' },
  },
];

const OPTIONS = { maxInputCharsPerMember: 2500 };

describe('planXmlDocumentation', () => {
  it('asks the model about types, constructors and methods only, and words the others deterministically', () => {
    const plan = planXmlDocumentation(TARGETS, OPTIONS);

    expect(plan.map((item) => [item.index, item.kind, item.memberName, item.requiresAi])).toEqual([
      [0, 'class', 'OrderService', true],
      [1, 'constructor', 'OrderService', true],
      [2, 'property', 'IsOpen', false],
      [3, 'method', 'GetOrderAsync', true],
    ]);
    expect(plan[2].prompt).toBeUndefined();
    expect(plan.map((item) => item.fallbackSummary)).toEqual([
      'Represents order service.',
      'Initializes a new instance of the OrderService class with the specified parameters.',
      'Gets or sets a value indicating whether is open.',
      'Executes get order async.',
    ]);
  });

  it('builds the prompts from the signature, the body and the thrown exceptions', () => {
    const [type, constructor, , method] = planXmlDocumentation(TARGETS, OPTIONS);

    expect(method.prompt).toContain('Signature: public async Task<Order> GetOrderAsync(int orderId, CancellationToken cancellationToken)\n');
    expect(method.prompt).toContain('Detected thrown exceptions: ArgumentOutOfRangeException\n');
    expect(constructor.prompt).toContain("constructor of class 'OrderService'");
    expect(type.prompt).toContain('Parameters / Properties / Members: OrderService(), IsOpen (bool), GetOrderAsync()\n');
    expect(type.prompt).toContain('Declaration: public class OrderService\n');
  });

  it('truncates long bodies to maxInputCharsPerMember', () => {
    const [, , , method] = planXmlDocumentation(TARGETS, { maxInputCharsPerMember: 10 });

    expect(method.prompt).toContain('Method body:\n{ Argument...\n');
  });
});

describe('insertXmlDocumentation', () => {
  it('inserts each block above its member with param, returns and exception tags, keeping deterministic summaries and skipping AI members without one', () => {
    const output = insertXmlDocumentation(SOURCE, TARGETS, { 3: 'Retrieves the order with the given identifier' });

    expect(output).toBe(
      [
        'namespace Shop;',
        '',
        'public class OrderService',
        '{',
        '    public OrderService(IStore store) { }',
        '',
        '    /// <summary>',
        '    /// Gets or sets a value indicating whether is open.',
        '    /// </summary>',
        '    public bool IsOpen { get; set; }',
        '',
        '    /// <summary>',
        '    /// Retrieves the order with the given identifier.',
        '    /// </summary>',
        '    /// <param name="orderId">The unique identifier of the order.</param>',
        '    /// <param name="cancellationToken">The cancellation token to monitor for cancellation requests.</param>',
        '    /// <returns>A task representing the asynchronous operation. The task result contains the order.</returns>',
        '    /// <exception cref="ArgumentOutOfRangeException">Thrown when an error occurs during execution.</exception>',
        '    public async Task<Order> GetOrderAsync(int orderId, CancellationToken cancellationToken)',
        '    {',
        '        ArgumentOutOfRangeException.ThrowIfNegative(orderId);',
        '        return await store.Find(orderId);',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('keeps the line endings of the file', () => {
    const output = insertXmlDocumentation(SOURCE.replace(/\n/g, '\r\n'), [TARGETS[2]], {});

    expect(output).toContain(
      '\r\n    /// <summary>\r\n    /// Gets or sets a value indicating whether is open.\r\n    /// </summary>\r\n    public bool IsOpen'
    );
  });
});

describe('sanitizeAiCompletion', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['<think>reasoning</think>Retrieves the order.', 'Retrieves the order.'],
    ['<thought>x</thought><reasoning>y</reasoning>Validates input.', 'Validates input.'],
    ['<think>never closed Retrieves', ''],
    ['```text\nRetrieves the order.\n```', 'Retrieves the order.'],
    ['Here is the summary sentence: Retrieves the order.', 'Retrieves the order.'],
    ['Summary: Retrieves the order.', 'Retrieves the order.'],
    ['Description: Retrieves the order.', 'Retrieves the order.'],
    ['/// <summary> Retrieves the order. /// </summary>', 'Retrieves the order.'],
    ['Thinking Process:\nDraft 1: Gets it.\nFinal Draft: Retrieves the order.', 'Retrieves the order.'],
    ['**Thinking Process**: nothing usable', ''],
  ])('cleans %j', (input, expected) => {
    expect(sanitizeAiCompletion(input)).toBe(expected);
  });
});

describe('normalizeSentence', () => {
  it.each([
    ['  Retrieves   the\n order  ', 'Retrieves the order.'],
    ['"Retrieves the order"', 'Retrieves the order.'],
    ['Retrieves the order!', 'Retrieves the order!'],
    ['Is it open?', 'Is it open?'],
    ['', 'Performs the operation.'],
    ['<think>only thoughts</think>', 'Performs the operation.'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeSentence(input)).toBe(expected);
  });
});

describe('fallback summaries', () => {
  const summaryOf = (target: Partial<XmlDocTargetResult>) =>
    planXmlDocumentation([{ ...NONE, name: 'Thing', kind: 'class', text: '', insertionLine: 0, indent: '', signature: '', ...target }], OPTIONS)[0]
      .fallbackSummary;

  it.each([
    [{ kind: 'interface', name: 'IStore' }, 'Defines a contract for istore.'],
    [{ kind: 'class', name: 'CreateOrderCommand' }, 'Represents a command to create order.'],
    [{ kind: 'class', name: 'FindOrderQuery' }, 'Represents a query to retrieve find order.'],
    [{ kind: 'class', name: 'OrderDto' }, 'Represents the data structure for order dto.'],
    [{ kind: 'record', name: 'OrderCreatedResponse' }, 'Represents the data structure for order created response.'],
    [{ kind: 'struct', name: 'Point' }, 'Represents point.'],
    [{ kind: 'field', name: 'maxItems' }, 'The max items.'],
    [{ kind: 'indexer', name: 'this' }, 'Gets or sets the element at the specified index.'],
    [{ kind: 'event', name: 'OrderChanged' }, 'Occurs when order changed.'],
    [{ kind: 'method', name: 'Run' }, 'Executes run.'],
    [{ kind: 'property', name: 'Total', signature: 'public int Total', accessors: { get: true, set: false } }, 'Gets the total.'],
    [{ kind: 'property', name: 'Total', signature: 'public int Total', accessors: { get: false, set: true } }, 'Sets the total.'],
    [{ kind: 'property', name: 'Items', signature: 'public List<Item> Items', accessors: { get: true, set: true } }, 'Gets or sets the collection of items.'],
    [{ kind: 'property', name: 'IsOpen', signature: 'public bool IsOpen', accessors: { get: true, set: false } }, 'Gets a value indicating whether is open.'],
    [{ kind: 'property', name: 'IsOpen', signature: 'public bool IsOpen', accessors: { get: false, set: true } }, 'Sets a value indicating whether is open.'],
    [{ kind: 'constructor', name: 'Thing', containingType: { name: 'Thing', kind: 'struct' } }, 'Initializes a new instance of the Thing struct.'],
    [{ kind: 'constructor', name: 'Thing' }, 'Initializes a new instance of the Unknown type.'],
  ] as [Partial<XmlDocTargetResult>, string][])('words %j', (target, expected) => {
    expect(summaryOf(target)).toBe(expected);
  });
});

describe('insertXmlDocumentation branches', () => {
  const at = (target: Partial<XmlDocTargetResult>): XmlDocTargetResult => ({
    ...NONE,
    name: 'M',
    kind: 'method',
    text: '',
    insertionLine: 0,
    indent: '',
    signature: 'void M()',
    ...target,
  });

  it('uses the supplied summary for a member that needs AI and skips it when none is supplied', () => {
    const target = at({});

    expect(insertXmlDocumentation('void M() { }', [target], { 0: ' Runs it ' })).toBe('/// <summary>\n/// Runs it.\n/// </summary>\nvoid M() { }');
    expect(insertXmlDocumentation('void M() { }', [target], {})).toBe('void M() { }');
    expect(insertXmlDocumentation('void M() { }', [target], { 0: '   ' })).toBe('void M() { }');
  });

  it('escapes XML in the summary, the parameter names are kept, and void methods get no returns tag', () => {
    const target = at({
      parameters: [
        { name: 'id', type: 'int' },
        { name: 'items', type: 'List<int>' },
        { name: 'createRequest', type: 'X' },
      ],
    });

    const output = insertXmlDocumentation('void M(int id) { }', [target], { 0: 'Adds <a> & "b" now' });

    expect(output).toContain('/// Adds &lt;a&gt; &amp; &quot;b&quot; now.');
    expect(output).toContain('<param name="id">The unique identifier.</param>');
    expect(output).toContain('<param name="items">The collection of items.</param>');
    expect(output).toContain('<param name="createRequest">The create request containing the operation data.</param>');
    expect(output).not.toContain('<returns>');
  });

  it.each([
    ['bool', 'IsReady', 'true if the condition is met; otherwise, false.'],
    ['bool', 'Save', 'true if the operation succeeded; otherwise, false.'],
    ['Task', 'Run', 'A task representing the asynchronous operation.'],
    ['ValueTask', 'Run', 'A value task representing the asynchronous operation.'],
    ['Task<bool>', 'Run', 'A task representing the asynchronous operation. The task result is true if successful; otherwise, false.'],
    ['ValueTask<Order>', 'Run', 'A value task representing the asynchronous operation. The task result contains the order.'],
    ['List<Order>', 'Run', 'A collection of list items.'],
    ['Order[]', 'Run', 'A collection of order items.'],
    ['Order', 'Run', 'The order result.'],
  ])('describes the returns of %s %s', (returnType, name, expected) => {
    const output = insertXmlDocumentation('x', [at({ name, returnType })], { 0: 'Runs' });

    expect(output).toContain(`<returns>${expected}</returns>`);
  });

  it('writes the exceptions sorted and indents the block like the member', () => {
    const target = at({ indent: '  ', exceptions: ['ZException', 'AException'] });

    const lines = insertXmlDocumentation('  void M() { }', [target], { 0: 'Runs' }).split('\n');

    expect(lines.filter((line) => line.includes('<exception')).map((line) => /cref="(\w+)"/.exec(line)?.[1])).toEqual(['AException', 'ZException']);
    expect(lines.every((line) => line.startsWith('  '))).toBe(true);
  });

  it('documents a type, a constructor and a property without a returns tag, and ignores an insertion line outside the file', () => {
    const type = at({ kind: 'class', name: 'Order', parameters: [{ name: 'x', type: 'int' }], returnType: 'int', exceptions: ['E'] });
    const outside = at({ kind: 'property', name: 'Late', insertionLine: 99, signature: 'public int Late' });

    const output = insertXmlDocumentation('class Order { }', [type, outside], { 0: 'Holds orders' });

    expect(output).toBe('/// <summary>\n/// Holds orders.\n/// </summary>\nclass Order { }');
  });

  it('inserts several blocks bottom-up without shifting the lines still to be documented', () => {
    const first = at({ kind: 'property', name: 'A', insertionLine: 0, signature: 'public int A', accessors: { get: true, set: false } });
    const second = at({ kind: 'property', name: 'B', insertionLine: 1, signature: 'public int B', accessors: { get: true, set: false } });

    const output = insertXmlDocumentation('public int A;\npublic int B;', [first, second], {});

    expect(output.split('\n').filter((line) => line.startsWith('public'))).toEqual(['public int A;', 'public int B;']);
    expect(output.indexOf('Gets the a.')).toBeLessThan(output.indexOf('public int A;'));
    expect(output.indexOf('Gets the b.')).toBeGreaterThan(output.indexOf('public int A;'));
    expect(output.indexOf('Gets the b.')).toBeLessThan(output.indexOf('public int B;'));
  });
});
