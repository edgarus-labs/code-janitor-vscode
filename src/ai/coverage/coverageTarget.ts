import { extractCodeSnippet } from '../aiActions';

/**
 * Generate Tests to Target Coverage: the Visual Studio extension's `AiCoverageTargetLogic`. The C# engine's `branches`
 * query finds the decision points of the code (`RoslynCodeBranchAnalyzer`) and estimates which ones the tests cover
 * (`BranchCoverageEvaluator`); each iteration asks the AI for tests aimed at the uncovered ones until the estimate
 * reaches the target or the iterations run out.
 */

export type CodeBranchType = 'ifBranch' | 'elseBranch' | 'switchCase' | 'ternary' | 'nullCoalescing' | 'catchBlock' | 'throwException' | 'guardClause';

/** A decision point, as the `branches` query reports it; `line` is 0-based. */
export interface CodeBranch {
  readonly id: string;
  readonly type: CodeBranchType;
  readonly description: string;
  readonly condition: string;
  readonly line: number;
}

/** The `branches` query's estimate of what a test suite covers (branch ids and test method names). */
export interface BranchCoverage {
  readonly totalBranches: number;
  readonly coveredBranches: number;
  readonly percentage: number;
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
  readonly scenarios: readonly string[];
}

/** The `branches` query's result; `target` is the member at the position, or the whole file (`kind` `file`). */
export interface BranchesResult {
  readonly target: { readonly name: string; readonly kind: string; readonly startLine: number; readonly endLine: number; readonly text: string } | null;
  readonly branches: readonly CodeBranch[];
  readonly coverage: BranchCoverage | null;
}

export interface CoverageOptions {
  targetCoveragePercentage: number;
  maxIterations: number;
  testFramework: string;
  mockingLibrary: string;
}

export interface CoverageProgress {
  readonly iteration: number;
  readonly maxIterations: number;
  readonly targetCoveragePercentage: number;
  readonly coveragePercentage: number;
  readonly totalBranches: number;
  readonly coveredBranches: number;
  readonly message: string;
}

export interface CoverageRun {
  readonly targetName: string;
  readonly code: string;
  readonly branches: readonly CodeBranch[];
  readonly options: CoverageOptions;
  /** The AI chat completion. */
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
  /** The coverage of a test suite. */
  evaluate(testCode: string): Promise<BranchCoverage>;
  progress?(report: CoverageProgress): void;
  isCancelled?(): boolean;
}

export interface CoverageResult {
  readonly targetMet: boolean;
  readonly achievedCoveragePercentage: number;
  readonly targetCoveragePercentage: number;
  readonly iterationsUsed: number;
  readonly testCode: string;
  /** Markdown: the targets, the outcome and each branch, covered or not. */
  readonly report: string;
}

export class CoverageCancelledError extends Error {
  constructor() {
    super('Generating tests to the target coverage was cancelled.');
  }
}

/** The options within the Visual Studio dialog's bounds: a 10-100% target, 1-10 iterations, xUnit and Moq by default. */
export function normalizeCoverageOptions(options: CoverageOptions): CoverageOptions {
  return {
    targetCoveragePercentage: Math.max(10, Math.min(100, Math.round(options.targetCoveragePercentage))),
    maxIterations: Math.max(1, Math.min(10, Math.round(options.maxIterations))),
    testFramework: options.testFramework.trim() || 'xUnit',
    mockingLibrary: options.mockingLibrary.trim() || 'Moq',
  };
}

export async function generateTestsToTargetCoverage(run: CoverageRun): Promise<CoverageResult> {
  if (!run.code.trim()) {
    throw new Error('No code provided for test generation.');
  }

  const options = normalizeCoverageOptions(run.options);
  const target = options.targetCoveragePercentage;
  const max = options.maxIterations;
  const total = run.branches.length;
  let coverage: BranchCoverage = { totalBranches: total, coveredBranches: 0, percentage: 0, covered: [], uncovered: run.branches.map((branch) => branch.id), scenarios: [] };
  const report = (iteration: number, message: string) =>
    run.progress?.({ iteration, maxIterations: max, targetCoveragePercentage: target, coveragePercentage: coverage.percentage, totalBranches: total, coveredBranches: coverage.coveredBranches, message });
  const systemPrompt = `You are an expert C# unit testing specialist targeting 100% branch and line coverage using ${options.testFramework} and ${options.mockingLibrary}. Provide complete, compiling C# test code with Arrange-Act-Assert. Output ONLY the test code inside a \`\`\`csharp \`\`\` block.`;

  report(0, `Discovered ${total} decision points/branches. Starting test generation...`);
  let testCode = '';
  let iteration = 0;
  while (iteration < max && coverage.percentage < target) {
    if (run.isCancelled?.()) {
      throw new CoverageCancelledError();
    }

    iteration++;
    report(
      iteration,
      iteration === 1
        ? `Iteration ${iteration}/${max}: Generating base test suite (Happy paths & primary flows)...`
        : `Iteration ${iteration}/${max}: Generating targeted tests for remaining ${coverage.uncovered.length} uncovered branches...`
    );
    const uncovered = run.branches.filter((branch) => coverage.uncovered.includes(branch.id));
    let response: string;
    try {
      response = await run.complete(systemPrompt, buildCoveragePrompt(run.targetName, run.code, options, iteration, testCode, uncovered));
    } catch (err) {
      throw new Error(`Error during iteration ${iteration}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    if (run.isCancelled?.()) {
      throw new CoverageCancelledError();
    }

    const generated = extractCodeSnippet(response);
    testCode = iteration === 1 ? generated : mergeTestCode(testCode, generated);
    coverage = await run.evaluate(testCode);
    report(iteration, `Iteration ${iteration}/${max} complete. Current estimated coverage: ${coverage.percentage}% (Target: ${target}%)`);
  }

  return {
    targetMet: coverage.percentage >= target,
    achievedCoveragePercentage: coverage.percentage,
    targetCoveragePercentage: target,
    iterationsUsed: iteration,
    testCode,
    report: coverageReport(run.targetName, target, coverage, iteration, max, run.branches),
  };
}

/** The first iteration asks for a whole suite; the next ones for tests of the uncovered branches, with the suite so far. */
function buildCoveragePrompt(
  targetName: string,
  code: string,
  options: CoverageOptions,
  iteration: number,
  existingTests: string,
  uncovered: readonly CodeBranch[]
): string {
  const { testFramework: framework, mockingLibrary: mocking } = options;
  if (iteration === 1 || !existingTests.trim()) {
    return `Generate a comprehensive ${framework} unit test suite with ${mocking} for the following C# code ('${targetName}'):

\`\`\`csharp
${code}
\`\`\`

Requirements:
- Target maximum branch and line coverage.
- Include happy path tests, null input handling, and boundary assertions.
- Use naming convention: \`MethodName_Condition_ExpectedResult\`.
- Return the full test class enclosed in \`\`\`csharp ... \`\`\`.`;
  }

  return `We need additional test methods to achieve our target Code Coverage for '${targetName}'.

Target Code:
\`\`\`csharp
${code}
\`\`\`

Currently uncovered decision paths:
${uncovered.map((branch) => `- ${branch.description} (Condition: \`${branch.condition}\`)`).join('\n')}

Existing Test Suite:
\`\`\`csharp
${existingTests}
\`\`\`

Please generate the additional unit test methods (using ${framework} and ${mocking}) specifically targeting these uncovered paths. Return the complete updated test class.`;
}

/** A complete test class replaces the suite so far; a partial answer is appended to it. */
export function mergeTestCode(original: string, added: string): string {
  if (!original.trim()) {
    return added;
  }

  if (!added.trim()) {
    return original;
  }

  if ((added.includes('public class') && added.includes('[Fact]')) || added.includes('[Test]')) {
    return added;
  }

  return `${original}\n\n// Additional coverage tests:\n${added}`;
}

function coverageReport(
  targetName: string,
  target: number,
  coverage: BranchCoverage,
  iterations: number,
  max: number,
  branches: readonly CodeBranch[]
): string {
  return [
    `# Code Coverage Test Report: ${targetName}`,
    '',
    `- **Target Coverage:** ${target}%`,
    `- **Achieved Coverage:** ${coverage.percentage}%`,
    `- **Covered Branches:** ${coverage.coveredBranches} / ${coverage.totalBranches}`,
    `- **Iterations Used:** ${iterations} / ${max}`,
    `- **Status:** ${coverage.percentage >= target ? 'Target Reached' : 'Max Iterations Reached'}`,
    '',
    '### Branch Analysis Breakdown',
    ...branches.map((branch) => `- [${coverage.covered.includes(branch.id) ? 'x' : ' '}] **${branch.description}** (Line ${branch.line + 1})`),
    '',
  ].join('\n');
}
