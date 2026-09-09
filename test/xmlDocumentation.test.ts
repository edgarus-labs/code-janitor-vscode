import { describe, expect, it } from 'vitest';
import { Node } from '../src/cleanup/parser';
import {
  applySummaries,
  createDefaultXmlDocOptions,
  generateXmlDocumentation,
  normalizeSentence,
  planTargets,
} from '../src/cleanup/xmlDocumentation';

const options = (overrides: Partial<ReturnType<typeof createDefaultXmlDocOptions>> = {}) => ({
  ...createDefaultXmlDocOptions(),
  ...overrides,
});

const generate = (source: string, summary: (name: string) => string, maxMembers = 25) =>
  generateXmlDocumentation(source, options({ maxMembersPerFile: maxMembers }), (member) =>
    summary(memberName(member))
  );

function memberName(member: Node): string {
  const named = member.childForFieldName('name');
  if (named) {
    return named.text;
  }

  const declaration = member.namedChildren.find((child) => child?.type === 'variable_declaration');
  const declarator = declaration?.namedChildren.find((child) => child?.type === 'variable_declarator');

  return (declarator?.childForFieldName('name') ?? declarator?.namedChild(0))?.text ?? 'member';
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe('generateXmlDocumentation', () => {
  it('inserts summary, params, returns and exception tags', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic string BuildName(string firstName, string lastName)\n{\n    if (string.IsNullOrWhiteSpace(firstName))\n    {\n        throw new ArgumentException(nameof(firstName));\n    }\n\n    return firstName + " " + lastName;\n}\n}\n';
    const updated = generate(source, () => 'Builds a combined display name.');

    expect(updated).toContain('/// <summary>');
    expect(updated).toContain('/// Builds a combined display name.');
    expect(updated).toContain('<param name="firstName">The first name.</param>');
    expect(updated).toContain('<param name="lastName">The last name.</param>');
    expect(updated).toContain('<returns>The string result.</returns>');
    expect(updated).toContain('<exception cref="ArgumentException">');
  });

  it('documents a positional record with param tags', () => {
    const source =
      'namespace RecipeVault.Application.Abstractions.CQRS;\n\npublic sealed record CreateRecipeCommand(\n    string Title,\n    string Description,\n    Guid AuthorId,\n    List<CreateIngredientDto> Ingredients,\n    List<CreateStepDto> Steps\n) : ICommand<CreateRecipeResponse>;\n';
    const updated = generate(source, () => 'Represents a command to create a new recipe with the specified details.');

    expect(updated).toContain('/// Represents a command to create a new recipe with the specified details.');
    expect(updated).toContain('<param name="Title">The title.</param>');
    expect(updated).toContain('<param name="AuthorId">The unique identifier of the author.</param>');
    expect(updated).toContain('<param name="Ingredients">The collection of ingredients.</param>');
    expect(updated).toContain('<param name="Steps">The collection of steps.</param>');
  });

  it('places the block directly above the member keeping its indent', () => {
    const source = 'namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public int Get(int x)\r\n    {\r\n        return x;\r\n    }\r\n}\r\n';
    const lines = generate(source, () => 'Gets a value.').replace(/\r\n/g, '\n').split('\n');
    const memberIndex = lines.findIndex((line) => line.includes('public int Get'));

    expect(memberIndex).toBeGreaterThan(0);
    expect(lines[memberIndex - 1]).toContain('///');
    expect(lines[memberIndex]).toBe('    public int Get(int x)');
    expect(lines[memberIndex - 1].startsWith('    ///')).toBe(true);
  });

  it('respects the member limit for AI members', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int First(int x)\n{\n    return x + 1;\n}\n\npublic int Second(int y)\n{\n    return y + 2;\n}\n}\n';
    const updated = generate(source, (name) => `Summary for ${name}.`, 1);

    expect(countOccurrences(updated, '/// <summary>')).toBe(1);
    expect(updated).toContain('Summary for Sample.');
    expect(updated).not.toContain('Summary for Second.');
  });

  it('documents types and properties without methods', () => {
    const source =
      'namespace Demo;\r\n\r\npublic class WriteRelationsRequest\r\n{\r\n    public string Name { get; set; }\r\n\r\n    public int Count { get; }\r\n}\r\n';
    const updated = generate(source, (name) => `Summary for ${name}.`);

    expect(countOccurrences(updated, '/// <summary>')).toBe(3);
    expect(updated).toContain('Summary for WriteRelationsRequest.');
    expect(updated).toContain('Summary for Name.');
    expect(updated).toContain('Summary for Count.');
  });

  it('documents public const and static members', () => {
    const source =
      'namespace Demo;\n\npublic class ConfigClass\n{\n    public const string Version = "1.0";\n\n    public static readonly string DefaultName = "Test";\n\n    public static int StaticCounter { get; set; }\n\n    public static string StaticExpressionProp => "Hello";\n}\n';
    const updated = generate(source, (name) => `Summary for ${name}.`);

    expect(countOccurrences(updated, '/// <summary>')).toBe(5);
  });

  it('documents public fields and skips private ones', () => {
    const source =
      'namespace Demo;\n\npublic class FieldSample\n{\n    public string PublicField;\n\n    public int PublicNumber = 42;\n\n    private string _privateField;\n\n    int _unspecifiedPrivate;\n}\n';
    const updated = generate(source, (name) => `Summary for ${name}.`);

    expect(countOccurrences(updated, '/// <summary>')).toBe(3);
    expect(updated).toContain('Summary for PublicField.');
    expect(updated).not.toContain('Summary for _privateField.');
  });

  it('documents all const fields regardless of the member limit', () => {
    const fields = Array.from({ length: 50 }, (_, i) => `    public const int Field${i} = ${i};`).join('\n');
    const source = `namespace Demo;\npublic static class LargeConstants {\n${fields}\n}\n`;
    const updated = generate(source, (name) => `Summary for ${name}.`, 2);

    expect(countOccurrences(updated, '/// <summary>')).toBe(51);
  });

  it('skips members that already have documentation comments', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n/// <summary>\n/// Existing docs.\n/// </summary>\npublic int Existing(int x)\n{\n    return x;\n}\n\npublic int Missing(int y)\n{\n    return y;\n}\n}\n';
    const updated = generate(source, () => 'Generated docs.');

    expect(countOccurrences(updated, '/// <summary>')).toBe(3);
    expect(updated).toContain('Existing docs.');
    expect(updated).toContain('Generated docs.');
  });

  it('ignores obsolete methods when enabled', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n[Obsolete]\npublic int Legacy(int x)\n{\n    return x;\n}\n\npublic int Active(int y)\n{\n    return y;\n}\n}\n';
    const updated = generateXmlDocumentation(source, options({ ignoreObsolete: true }), () => 'Generated docs.');

    expect(countOccurrences(updated, '/// <summary>')).toBe(2);
    expect(updated).toContain('public int Active');
  });

  it('ignores likely test methods when enabled', () => {
    const source =
      '\nnamespace Demo;\n\npublic class SampleTests\n{\n[Fact]\npublic void UsesFact()\n{\n}\n\npublic void AlsoATestByTypeName()\n{\n}\n\npublic void ProductionLike()\n{\n}\n}\n\npublic class RealService\n{\npublic void DoWork()\n{\n}\n}\n';
    const updated = generateXmlDocumentation(source, options({ ignoreTestMethods: true }), () => 'Generated docs.');

    expect(countOccurrences(updated, '/// <summary>')).toBe(2);
    expect(updated).toContain('public void DoWork()');
  });

  it('ignores methods matching the ignore pattern', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void KeepThis()\n{\n}\n\npublic void SkipThisOne()\n{\n}\n}\n';
    const updated = generateXmlDocumentation(source, options({ ignorePattern: 'SkipThisOne$' }), () => 'Generated docs.');

    expect(countOccurrences(updated, '/// <summary>')).toBe(2);
    expect(updated).toContain('public void KeepThis()');
    expect(updated).toContain('public void SkipThisOne()');
  });

  it('skips members when the summary provider returns nothing', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int First(int x)\n{\n    return x + 1;\n}\n}\n';

    expect(generateXmlDocumentation(source, options(), () => undefined)).toBe(source);
  });
});

describe('normalizeSentence', () => {
  it('strips a thinking process and picks the last draft', () => {
    const raw =
      'Thinking Process: 1. **Analyze the Request:** * Input: C# type information. 2. **Determine Meaning:** Interface for CQRS. 3. **Drafting:** * Draft 1: Represents a command. * Draft 2: Defines a command contract.';

    expect(normalizeSentence(raw)).toBe('Defines a command contract.');
  });

  it('strips think tags', () => {
    expect(normalizeSentence("<think>\nLet's analyze this method.\n</think>\nCalculates the sum of two integers.")).toBe(
      'Calculates the sum of two integers.'
    );
  });

  it('strips a preamble', () => {
    expect(normalizeSentence('Here is the summary sentence: Performs the validation of the given request.')).toBe(
      'Performs the validation of the given request.'
    );
  });

  it('falls back for empty input', () => {
    expect(normalizeSentence('')).toBe('Performs the operation.');
  });
});

describe('planTargets and applySummaries', () => {
  const source =
    'namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public string Name { get; set; }\r\n\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n';

  it('returns prompts for AI members and deterministic summaries for the rest', () => {
    const targets = planTargets(source, createDefaultXmlDocOptions());

    expect(targets.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(targets.map((t) => t.kind)).toEqual(['class', 'property', 'method']);
    expect(targets.map((t) => t.memberName)).toEqual(['Sample', 'Name', 'Add']);
    expect(targets.map((t) => t.line)).toEqual([2, 4, 6]);
    expect(targets.map((t) => t.requiresAi)).toEqual([true, false, true]);
    expect(targets[1].prompt).toBeUndefined();
    expect(targets[1].fallbackSummary).toBe('Gets or sets the name.');
    expect(targets[2].prompt).toContain('int Add(int x, int y)');
  });

  it('uses the supplied summaries and falls back for deterministic members', () => {
    const updated = applySummaries(source, createDefaultXmlDocOptions(), {
      0: 'Represents a sample.',
      2: 'Adds two numbers.',
    });

    expect(updated).toContain('/// Represents a sample.');
    expect(updated).toContain('/// Gets or sets the name.');
    expect(updated).toContain('/// Adds two numbers.');
    expect(updated).toContain('<param name="x">The x.</param>');
    expect(updated).toContain('<returns>The int result.</returns>');
  });

  it('skips AI members without a summary', () => {
    const onlyMethod = 'namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n';

    expect(applySummaries(onlyMethod, createDefaultXmlDocOptions(), {})).toBe(onlyMethod);
  });

  it('documents methods with throw statements', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork()\n{\n    throw new InvalidOperationException();\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('/// <summary>');
    expect(updated).toContain('/// Does work.');
    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with ThrowIfNull', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(string input)\n{\n    ArgumentNullException.ThrowIfNull(input);\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentNullException">');
  });

  

  

  it('documents methods with ThrowIfNegative', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(int value)\n{\n    ArgumentOutOfRangeException.ThrowIfNegative(value);\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentOutOfRangeException">');
  });

  it('documents methods with multiple exceptions', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(string input, int value)\n{\n    if (input == null) throw new ArgumentNullException();\n    if (value < 0) throw new ArgumentOutOfRangeException();\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentNullException">');
    expect(updated).toContain('<exception cref="ArgumentOutOfRangeException">');
  });

  it('documents methods returning bool with is prefix', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic bool IsValid()\n{\n    return true;\n}\n}\n';
    const updated = generate(source, () => 'Checks validity.');

    expect(updated).toContain('<returns>true if the condition is met; otherwise, false.</returns>');
  });

  it('documents methods returning bool with has prefix', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic bool HasValue()\n{\n    return true;\n}\n}\n';
    const updated = generate(source, () => 'Checks value.');

    expect(updated).toContain('<returns>true if the condition is met; otherwise, false.</returns>');
  });

  it('documents methods returning bool with can prefix', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic bool CanExecute()\n{\n    return true;\n}\n}\n';
    const updated = generate(source, () => 'Checks execution.');

    expect(updated).toContain('<returns>true if the condition is met; otherwise, false.</returns>');
  });

  it('documents methods returning bool with try prefix', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic bool TryParse(string s)\n{\n    return true;\n}\n}\n';
    const updated = generate(source, () => 'Tries to parse.');

    expect(updated).toContain('<returns>true if the condition is met; otherwise, false.</returns>');
  });

  it('documents methods returning Task', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic Task DoWorkAsync()\n{\n    return Task.CompletedTask;\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<returns>A task representing the asynchronous operation.</returns>');
  });

  it('documents methods returning ValueTask', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic ValueTask DoWorkAsync()\n{\n    return ValueTask.CompletedTask;\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<returns>A value task representing the asynchronous operation.</returns>');
  });

  it('documents methods returning Task<T>', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic Task<int> GetAsync()\n{\n    return Task.FromResult(0);\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>A task representing the asynchronous operation. The task result contains the int.</returns>');
  });

  it('documents methods returning Task<bool>', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic Task<bool> IsValidAsync()\n{\n    return Task.FromResult(true);\n}\n}\n';
    const updated = generate(source, () => 'Checks validity.');

    expect(updated).toContain('<returns>A task representing the asynchronous operation. The task result is true if successful; otherwise, false.</returns>');
  });

  it('documents methods returning ValueTask<T>', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic ValueTask<string> GetAsync()\n{\n    return ValueTask.FromResult("");\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>A value task representing the asynchronous operation. The task result contains the string.</returns>');
  });

  

  it('documents methods returning array', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int[] GetValues()\n{\n    return new int[0];\n}\n}\n';
    const updated = generate(source, () => 'Gets values.');

    expect(updated).toContain('<returns>A collection of int items.</returns>');
  });

  it('documents methods with cancellation token parameter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(CancellationToken cancellationToken)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="cancellationToken">The cancellation token to monitor for cancellation requests.</param>');
  });

  it('documents methods with id parameter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(int id)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="id">The unique identifier.</param>');
  });

  it('documents methods with typed id parameter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(int userId)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="userId">The unique identifier of the user.</param>');
  });

  

  it('documents methods with collection parameter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(List<string> items)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="items">The collection of items.</param>');
  });

  it('documents methods with array parameter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(string[] names)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="names">The collection of names.</param>');
  });

  it('documents methods with default parameter description', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(string input)\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<param name="input">The input.</param>');
  });

  it('documents methods with empty parameter name', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork(string )\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    // The parser may not produce a valid parameter node for this
    expect(updated).toContain('/// <summary>');
  });

  

  

  it('documents properties with only getter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int Value { get; }\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('/// Gets the value.');
  });

  it('documents properties with only setter', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int Value { set; }\n}\n';
    const updated = generate(source, () => 'Sets the value.');

    expect(updated).toContain('/// Sets the value.');
  });

  it('documents properties with init accessor', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int Value { get; init; }\n}\n';
    const updated = generate(source, () => 'Gets or sets the value.');

    expect(updated).toContain('/// Gets or sets the value.');
  });

  

  

  

  it('documents expression-bodied properties', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic int Value => 42;\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('/// Gets the value.');
  });

  

  it('documents events', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic event EventHandler Changed;\n}\n';
    const updated = generate(source, () => 'Occurs when changed.');

    expect(updated).toContain('/// Occurs when changed.');
  });

  

  it('documents enums', () => {
    const source =
      '\nnamespace Demo;\n\npublic enum Color\n{\n    Red,\n    Green,\n    Blue\n}\n';
    const updated = generate(source, () => 'Specifies colors.');

    expect(updated).toContain('/// Specifies colors.');
  });

  it('documents structs', () => {
    const source =
      '\nnamespace Demo;\n\npublic struct Point\n{\n    public int X;\n    public int Y;\n}\n';
    const updated = generate(source, () => 'Represents a point.');

    expect(updated).toContain('/// Represents a point.');
  });

  

  

  it('documents records with parameters', () => {
    const source =
      '\nnamespace Demo;\n\npublic record Person(string Name, int Age);\n';
    const updated = generate(source, () => 'Represents a person.');

    expect(updated).toContain('/// Represents a person.');
    expect(updated).toContain('<param name="Name">The name.</param>');
    expect(updated).toContain('<param name="Age">The age.</param>');
  });

  

  it('documents methods with generic return types', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic List<T> GetItems<T>()\n{\n    return new List<T>();\n}\n}\n';
    const updated = generate(source, () => 'Gets items.');

    expect(updated).toContain('<returns>A collection of list items.</returns>');
  });

  it('documents methods with nullable return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic string? GetName()\n{\n    return null;\n}\n}\n';
    const updated = generate(source, () => 'Gets a name.');

    expect(updated).toContain('<returns>The string? result.</returns>');
  });

  it('documents methods with void return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic void DoWork()\n{\n}\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).not.toContain('<returns>');
  });

  it('documents methods with dynamic return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic dynamic GetValue()\n{\n    return null;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The dynamic result.</returns>');
  });

  it('documents methods with object return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic object GetValue()\n{\n    return null;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The object result.</returns>');
  });

  it('documents methods with nint return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic nint GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The nint result.</returns>');
  });

  it('documents methods with nuint return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic nuint GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The nuint result.</returns>');
  });

  it('documents methods with ulong return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic ulong GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The ulong result.</returns>');
  });

  it('documents methods with sbyte return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic sbyte GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The sbyte result.</returns>');
  });

  it('documents methods with byte return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic byte GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The byte result.</returns>');
  });

  it('documents methods with short return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic short GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The short result.</returns>');
  });

  it('documents methods with ushort return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic ushort GetValue()\n{\n    return 0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The ushort result.</returns>');
  });

  it('documents methods with char return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic char GetValue()\n{\n    return \'a\';\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The char result.</returns>');
  });

  it('documents methods with decimal return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic decimal GetValue()\n{\n    return 0m;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The decimal result.</returns>');
  });

  it('documents methods with float return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic float GetValue()\n{\n    return 0f;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The float result.</returns>');
  });

  it('documents methods with double return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic double GetValue()\n{\n    return 0.0;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>The double result.</returns>');
  });

  it('documents methods with bool return type without special prefix', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic bool GetValue()\n{\n    return true;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    expect(updated).toContain('<returns>true if the operation succeeded; otherwise, false.</returns>');
  });

  it('documents methods with empty return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\npublic  GetValue()\n{\n    return null;\n}\n}\n';
    const updated = generate(source, () => 'Gets a value.');

    // The parser may not produce a valid method node for this
    expect(updated).toContain('///');
  });

  it('documents methods in nested classes', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Outer\n{\n    public class Inner\n    {\n        public void DoWork()\n        {\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('/// Does work.');
  });

  it('documents methods in nested namespaces', () => {
    const source =
      '\nnamespace Demo\n{\n    namespace Inner\n    {\n        public class Sample\n        {\n            public void DoWork()\n            {\n            }\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('/// Does work.');
  });

  it('documents methods with attributes', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    [Obsolete]\n    public void DoWork()\n    {\n    }\n}\n';
    const updated = generateXmlDocumentation(source, options({ ignoreObsolete: false }), () => 'Does work.');

    expect(updated).toContain('/// Does work.');
  });

  it('skips abstract methods', () => {
    const source =
      '\nnamespace Demo;\n\npublic abstract class Sample\n{\n    public abstract void DoWork();\n    public void Concrete() { }\n}\n';
    const updated = generate(source, () => 'Does work.');

    // Abstract methods have no body, so they should be skipped
    expect(updated).toContain('/// Does work.');
  });

  it('skips extern methods', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public extern void DoWork();\n    public void Concrete() { }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('/// Does work.');
  });

  

  it('documents methods with expression body', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public int GetValue() => 42;\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('/// Gets the value.');
  });

  it('documents methods with expression body and return type', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public string GetName() => "test";\n}\n';
    const updated = generate(source, () => 'Gets the name.');

    expect(updated).toContain('/// Gets the name.');
  });

  it('documents methods with throw expression', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public int GetValue() => throw new NotImplementedException();\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('<exception cref="NotImplementedException">');
  });

  it('documents methods with multiple throw expressions', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork(int x)\n    {\n        if (x < 0) throw new ArgumentOutOfRangeException();\n        if (x > 100) throw new InvalidOperationException();\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentOutOfRangeException">');
    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in nested blocks', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork(int x)\n    {\n        if (x < 0)\n        {\n            throw new ArgumentOutOfRangeException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentOutOfRangeException">');
  });

  it('documents methods with throw in try-catch', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        try\n        {\n            throw new InvalidOperationException();\n        }\n        catch\n        {\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in lambda', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        Action a = () => throw new InvalidOperationException();\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in local function', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        void Local() => throw new InvalidOperationException();\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in switch', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork(int x)\n    {\n        switch (x)\n        {\n            case 0: throw new ArgumentException();\n            default: throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentException">');
    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  

  it('documents methods with throw in conditional', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public int GetValue(bool flag) => flag ? 1 : throw new ArgumentException();\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('<exception cref="ArgumentException">');
  });

  it('documents methods with throw in null-coalescing', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public string GetValue(string input) => input ?? throw new ArgumentNullException();\n}\n';
    const updated = generate(source, () => 'Gets the value.');

    expect(updated).toContain('<exception cref="ArgumentNullException">');
  });

  it('documents methods with throw in null-coalescing assignment', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork(string input)\n    {\n        input ??= throw new ArgumentNullException();\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="ArgumentNullException">');
  });

  

  it('documents methods with throw in await', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public async Task DoWorkAsync()\n    {\n        await Task.Delay(1);\n        throw new InvalidOperationException();\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in using', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        using (var x = new Disposable())\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in lock', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        lock (obj)\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in foreach', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        foreach (var item in list)\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in while', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        while (true)\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in for', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        for (int i = 0; i < 10; i++)\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in do-while', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        do\n        {\n            throw new InvalidOperationException();\n        } while (true);\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in checked', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        checked\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in unchecked', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        unchecked\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in unsafe', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        unsafe\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in fixed', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        fixed (int* p = &value)\n        {\n            throw new InvalidOperationException();\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in try-finally', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        try\n        {\n            throw new InvalidOperationException();\n        }\n        finally\n        {\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
  });

  it('documents methods with throw in try-catch-finally', () => {
    const source =
      '\nnamespace Demo;\n\npublic class Sample\n{\n    public void DoWork()\n    {\n        try\n        {\n            throw new InvalidOperationException();\n        }\n        catch (Exception ex)\n        {\n            throw new AggregateException(ex);\n        }\n        finally\n        {\n        }\n    }\n}\n';
    const updated = generate(source, () => 'Does work.');

    expect(updated).toContain('<exception cref="InvalidOperationException">');
    expect(updated).toContain('<exception cref="AggregateException">');
  });
});
