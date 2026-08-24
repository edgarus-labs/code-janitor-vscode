import { beforeAll, describe, expect, it } from 'vitest';
import { Node } from 'web-tree-sitter';
import { initCSharpParser } from '../src/cleanup/parser';
import {
  applySummaries,
  createDefaultXmlDocOptions,
  generateXmlDocumentation,
  normalizeSentence,
  planTargets,
} from '../src/cleanup/xmlDocumentation';

beforeAll(async () => {
  await initCSharpParser();
});

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
});
