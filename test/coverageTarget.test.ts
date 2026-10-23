import { describe, expect, it } from 'vitest';
import {
  BranchCoverage,
  CodeBranch,
  CoverageCancelledError,
  CoverageProgress,
  CoverageRun,
  generateTestsToTargetCoverage,
  mergeTestCode,
  normalizeCoverageOptions,
} from '../src/ai/coverage/coverageTarget';

const BRANCHES: CodeBranch[] = [
  { id: 'B1', type: 'guardClause', description: 'Guard Clause: If (x == null) early exit/throw', condition: 'x == null', line: 4 },
  { id: 'B2', type: 'ifBranch', description: 'If branch: (x > 0) is true', condition: 'x > 0', line: 5 },
  { id: 'B3', type: 'elseBranch', description: 'Else branch: (x > 0) is false', condition: '!(x > 0)', line: 7 },
  { id: 'B4', type: 'throwException', description: 'Explicit error path: new ArgumentNullException()', condition: 'new ArgumentNullException()', line: 4 },
];

function coverage(covered: string[]): BranchCoverage {
  return {
    totalBranches: BRANCHES.length,
    coveredBranches: covered.length,
    percentage: Math.round((covered.length / BRANCHES.length) * 100),
    covered,
    uncovered: BRANCHES.map((branch) => branch.id).filter((id) => !covered.includes(id)),
    scenarios: [],
  };
}

/** A fake AI client answering `responses` in order, and an evaluator answering `coverages` in order. */
function fakeRun(responses: string[], coverages: BranchCoverage[], overrides: Partial<CoverageRun> = {}) {
  const prompts: { system: string; user: string }[] = [];
  const evaluated: string[] = [];
  const progress: CoverageProgress[] = [];
  const run: CoverageRun = {
    targetName: 'Check',
    code: 'public int Check(object x) { ... }',
    branches: BRANCHES,
    options: { targetCoveragePercentage: 90, maxIterations: 3, testFramework: 'xUnit', mockingLibrary: 'Moq' },
    complete: (system, user) => {
      prompts.push({ system, user });

      return Promise.resolve(responses[prompts.length - 1] ?? '');
    },
    evaluate: (testCode) => {
      evaluated.push(testCode);

      return Promise.resolve(coverages[evaluated.length - 1]);
    },
    progress: (report) => progress.push(report),
    ...overrides,
  };

  return { run, prompts, evaluated, progress };
}

const FIRST = '```csharp\npublic class CheckTests\n{\n    [Fact]\n    public void Check_Valid_ReturnsTrue() { }\n}\n```';
const SECOND =
  'Here you go:\n```csharp\npublic class CheckTests\n{\n    [Fact]\n    public void Check_Valid_ReturnsTrue() { }\n\n    [Fact]\n    public void Check_WhenNull_Throws() { }\n}\n```';

describe('generateTestsToTargetCoverage', () => {
  it('generates tests until the evaluated branch coverage reaches the target', async () => {
    const { run, prompts, evaluated } = fakeRun([FIRST, SECOND], [coverage(['B2']), coverage(['B1', 'B2', 'B3', 'B4'])]);

    const result = await generateTestsToTargetCoverage(run);

    expect(result).toMatchObject({ targetMet: true, achievedCoveragePercentage: 100, targetCoveragePercentage: 90, iterationsUsed: 2 });
    expect(result.testCode).toBe(evaluated[1]);
    expect(evaluated[1]).toContain('Check_WhenNull_Throws');
    expect(prompts[0].system).toContain('targeting 100% branch and line coverage using xUnit and Moq');
    expect(prompts[0].user).toContain("Generate a comprehensive xUnit unit test suite with Moq for the following C# code ('Check')");
    expect(prompts[0].user).toContain('public int Check(object x)');
    expect(prompts[1].user).toContain('Currently uncovered decision paths:');
    expect(prompts[1].user).toContain('- Guard Clause: If (x == null) early exit/throw (Condition: `x == null`)');
    expect(prompts[1].user).not.toContain('If branch: (x > 0) is true (Condition');
    expect(prompts[1].user).toContain(`Existing Test Suite:\n\`\`\`csharp\n${evaluated[0]}\n\`\`\``);
    expect(result.report).toContain('# Code Coverage Test Report: Check');
    expect(result.report).toContain('- **Covered Branches:** 4 / 4');
    expect(result.report).toContain('- **Status:** Target Reached');
    expect(result.report).toContain('- [x] **Else branch: (x > 0) is false** (Line 8)');
  });

  it('stops after the maximum iterations, reporting the target as not met', async () => {
    const { run, prompts } = fakeRun([FIRST, FIRST], [coverage(['B2']), coverage(['B2'])], {
      options: { targetCoveragePercentage: 90, maxIterations: 2, testFramework: 'NUnit', mockingLibrary: 'NSubstitute' },
    });

    const result = await generateTestsToTargetCoverage(run);

    expect(prompts).toHaveLength(2);
    expect(prompts[0].system).toContain('using NUnit and NSubstitute');
    expect(result).toMatchObject({ targetMet: false, achievedCoveragePercentage: 25, iterationsUsed: 2 });
    expect(result.report).toContain('- **Status:** Max Iterations Reached');
    expect(result.report).toContain('- **Iterations Used:** 2 / 2');
    expect(result.report).toContain('- [ ] **Guard Clause: If (x == null) early exit/throw** (Line 5)');
  });

  it('reports its progress as the Visual Studio progress dialog does', async () => {
    const { run, progress } = fakeRun([FIRST, SECOND], [coverage(['B2']), coverage(['B1', 'B2', 'B3', 'B4'])]);

    await generateTestsToTargetCoverage(run);

    expect(progress.map((report) => report.message)).toEqual([
      'Discovered 4 decision points/branches. Starting test generation...',
      'Iteration 1/3: Generating base test suite (Happy paths & primary flows)...',
      'Iteration 1/3 complete. Current estimated coverage: 25% (Target: 90%)',
      'Iteration 2/3: Generating targeted tests for remaining 3 uncovered branches...',
      'Iteration 2/3 complete. Current estimated coverage: 100% (Target: 90%)',
    ]);
    expect(progress.at(-1)).toMatchObject({ iteration: 2, maxIterations: 3, coveragePercentage: 100, coveredBranches: 4, totalBranches: 4 });
  });

  it('stops when cancelled', async () => {
    let cancelled = false;
    const { run, prompts } = fakeRun([FIRST, SECOND], [coverage(['B2']), coverage(['B2'])], { isCancelled: () => cancelled });
    run.evaluate = (testCode) => {
      cancelled = true;

      return Promise.resolve(coverage(testCode ? ['B2'] : []));
    };

    await expect(generateTestsToTargetCoverage(run)).rejects.toBeInstanceOf(CoverageCancelledError);
    expect(prompts).toHaveLength(1);
  });

  it('turns a failed AI request into the error of its iteration', async () => {
    const { run } = fakeRun([], [], { complete: () => Promise.reject(new Error('The model is unavailable.')) });

    await expect(generateTestsToTargetCoverage(run)).rejects.toThrow('Error during iteration 1: The model is unavailable.');
  });

  it('refuses empty code', async () => {
    const { run } = fakeRun([], [], { code: '  ' });

    await expect(generateTestsToTargetCoverage(run)).rejects.toThrow('No code provided for test generation.');
  });
});

describe('normalizeCoverageOptions', () => {
  it('keeps the target within 10-100%, the iterations within 1-10, and defaults the framework and mocking library', () => {
    expect(normalizeCoverageOptions({ targetCoveragePercentage: 5, maxIterations: 40, testFramework: ' ', mockingLibrary: '' })).toEqual({
      targetCoveragePercentage: 10,
      maxIterations: 10,
      testFramework: 'xUnit',
      mockingLibrary: 'Moq',
    });
    expect(normalizeCoverageOptions({ targetCoveragePercentage: 150, maxIterations: 0, testFramework: 'MSTest', mockingLibrary: 'FakeItEasy' })).toEqual({
      targetCoveragePercentage: 100,
      maxIterations: 1,
      testFramework: 'MSTest',
      mockingLibrary: 'FakeItEasy',
    });
  });
});

describe('mergeTestCode', () => {
  it('takes a complete test class over the previous tests and appends a partial answer', () => {
    expect(mergeTestCode('class Old { }', 'public class New { [Fact] public void A() { } }')).toBe('public class New { [Fact] public void A() { } }');
    expect(mergeTestCode('class Old { }', '[Test] public void A() { }')).toBe('[Test] public void A() { }');
    expect(mergeTestCode('class Old { }', 'public void A() { }')).toBe('class Old { }\n\n// Additional coverage tests:\npublic void A() { }');
    expect(mergeTestCode('class Old { }', ' ')).toBe('class Old { }');
    expect(mergeTestCode('', 'public void A() { }')).toBe('public void A() { }');
  });
});
