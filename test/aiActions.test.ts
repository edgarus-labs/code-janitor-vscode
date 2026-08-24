import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildExplainPrompt,
  buildRefactorPrompt,
  buildReviewPrompt,
  buildTestsPrompt,
  extractCodeSnippet,
  testsSystemPrompt,
} from '../src/ai/aiActions';
import { findEnclosingMember } from '../src/cleanup/memberAtPosition';
import { initCSharpParser } from '../src/cleanup/parser';

beforeAll(async () => {
  await initCSharpParser();
});

describe('AI action prompts', () => {
  it('embeds the member name and code in the explain prompt', () => {
    const prompt = buildExplainPrompt('Add', 'int Add(int a) => a;');

    expect(prompt).toContain("member 'Add'");
    expect(prompt).toContain('int Add(int a) => a;');
    expect(prompt).toContain('### 1. What This Code Does');
  });

  it('embeds the target name in the review prompt', () => {
    expect(buildReviewPrompt('Sample', 'class Sample { }')).toContain("for 'Sample'");
  });

  it('lists the refactoring goals', () => {
    const prompt = buildRefactorPrompt('Add', 'int Add(int a) => a;');

    expect(prompt).toContain('Guard Clauses');
    expect(prompt).toContain('Keep exact business semantics');
  });

  it('passes the framework and mocking library through the test prompts', () => {
    expect(buildTestsPrompt('Add', 'code', 'xUnit', 'NSubstitute')).toContain('using xUnit and NSubstitute');
    expect(testsSystemPrompt('xUnit', 'NSubstitute')).toContain('using xUnit and NSubstitute');
  });
});

describe('extractCodeSnippet', () => {
  it('extracts a csharp fenced block', () => {
    expect(extractCodeSnippet('Summary\n\n```csharp\nvar x = 1;\n```\n')).toBe('var x = 1;');
  });

  it('extracts a generic fenced block', () => {
    expect(extractCodeSnippet('```\nvar x = 1;\n```')).toBe('var x = 1;');
  });

  it('falls back to the whole response', () => {
    expect(extractCodeSnippet('  var x = 1;  ')).toBe('var x = 1;');
  });

  it('handles an empty response', () => {
    expect(extractCodeSnippet('')).toBe('');
  });
});

describe('findEnclosingMember', () => {
  const source = 'namespace N\n{\n    class C\n    {\n        void M()\n        {\n            var x = 1;\n        }\n    }\n}\n';

  it('finds the innermost member at an offset', () => {
    const member = findEnclosingMember(source, source.indexOf('var x'));

    expect(member?.name).toBe('M');
    expect(member?.text.startsWith('void M()')).toBe(true);
  });

  it('falls back to the enclosing type outside any method', () => {
    expect(findEnclosingMember(source, source.indexOf('class C'))?.name).toBe('C');
  });

  it('returns undefined outside any member', () => {
    expect(findEnclosingMember(source, 0)).toBeUndefined();
  });

  it('handles an empty source', () => {
    expect(findEnclosingMember('', 0)).toBeUndefined();
  });
});
