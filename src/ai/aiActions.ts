/**
 * Prompts for the AI actions, ported verbatim from the Visual Studio extension's
 * AiExplainLogic / AiCodeReviewLogic / AiCleanRefactorLogic / AiTestGeneratorLogic.
 */

export const EXPLAIN_SYSTEM_PROMPT =
  'You are an expert C# software architect and clean code mentor. Provide clear, well-structured, constructive explanations that help both junior and senior developers understand code functionality, risks, and clean decomposition opportunities.';

export const REVIEW_SYSTEM_PROMPT =
  'You are a senior .NET code reviewer and security auditor. Inspect the code thoroughly for bugs, async-await deadlocks (.Result/.Wait()), resource leaks, exception safety, thread-safety, and clean code principles. Provide actionable, concise, and constructive feedback.';

export const REFACTOR_SYSTEM_PROMPT =
  'You are a master C# refactoring expert adhering to Clean Code, SOLID principles, and modern C# idioms. Your goal is to simplify nested logic using Guard Clauses, simplify LINQ, improve readability, and preserve exact semantics. Provide your response with a concise bullet list of improvements, followed by the complete refactored C# code inside a ```csharp ``` block.';

export const COVERAGE_REPORT_SYSTEM_PROMPT =
  'You are a senior .NET test engineer. Analyze code coverage reports pragmatically, identify the highest-risk gaps, and recommend focused tests that would improve confidence without chasing meaningless percentage gains.';

export function testsSystemPrompt(testFramework: string, mockingLibrary: string): string {
  return (
    `You are an expert C# unit testing specialist using ${testFramework} and ${mockingLibrary}. ` +
    'Generate complete, high quality, production-ready unit test classes with exhaustive edge-case coverage and clean naming conventions (MethodName_Scenario_ExpectedResult). ' +
    'Output ONLY the test code inside a markdown csharp code block, without conversational filler.'
  );
}

export function buildExplainPrompt(memberName: string, codeSnippet: string): string {
  return `Analyze the following C# code for member '${memberName}':

\`\`\`csharp
${codeSnippet}
\`\`\`

Please structure your response in clear markdown format using the following sections:

### 1. What This Code Does
A concise summary explaining the business purpose, inputs, and outputs in plain language.

### 2. Complexity & Risk Assessment
- Cyclomatic complexity and branching depth analysis.
- Potential edge case vulnerabilities or hidden risks (e.g. nulls, unhandled exceptions, async traps).

### 3. Step-by-step Refactoring & Decomposition
- Concrete recommendations on how to simplify and decompose this code (e.g. Extract Method, Guard Clauses, Pattern Matching).
- A clean, modern C# code example demonstrating the decomposed/refactored version.
`;
}

export function buildReviewPrompt(targetName: string, codeSnippet: string): string {
  return `Perform a comprehensive, professional code review on the following C# code for '${targetName}':

\`\`\`csharp
${codeSnippet}
\`\`\`

Please structure your review as follows:

### Summary
A 1-2 sentence overall verdict on code health and quality.

### Critical Issues & Bugs (if any)
- Potential runtime exceptions, null dereferences, or race conditions.
- Async/await anti-patterns (e.g. sync-over-async, unobserved Task faults, blocking on \`.Result\`).

### Warnings & Improvements
- Resource management (IDisposable / using statements).
- Performance & memory efficiency (unnecessary allocations, inefficient collections/LINQ).
- Security considerations (input validation, SQL/command execution).

### Clean Code & Maintainability Tips
- Naming, method decomposition, and modern C# idioms.
- Concrete fix recommendations.
`;
}

export function buildRefactorPrompt(memberName: string, codeSnippet: string): string {
  return `Refactor the following C# code for '${memberName}' to follow modern Clean Code standards:

\`\`\`csharp
${codeSnippet}
\`\`\`

Refactoring Goals:
1. Flatten deep nesting using Guard Clauses (early returns / inverted \`if\` checks).
2. Simplify complex boolean conditions and LINQ queries.
3. Apply modern C# pattern matching, null checks, and idiomatic constructs.
4. Keep exact business semantics and error handling intact.
5. Provide a summary of key changes made, followed by the complete refactored C# method.`;
}

export function buildTestsPrompt(
  memberOrClassName: string,
  codeSnippet: string,
  testFramework: string,
  mockingLibrary: string
): string {
  return `Generate a comprehensive suite of unit tests for the following C# code ('${memberOrClassName}') using ${testFramework} and ${mockingLibrary}:

\`\`\`csharp
${codeSnippet}
\`\`\`

Requirements:
1. Target Framework: ${testFramework}
2. Mocking Library (if needed): ${mockingLibrary}
3. Include test methods for:
   - Happy paths with expected valid outputs
   - Null or empty argument validations (asserting ArgumentNullException / ArgumentException)
   - Boundary/edge conditions and special values
   - Asynchronous execution / exception throwing paths if applicable
4. Use clean Arrange-Act-Assert structure and readable method names following: \`MethodName_Condition_ExpectedResult\`.
5. Return the complete test class file with necessary using statements.`;
}

export function buildCoverageReportPrompt(fileName: string, coverageReport: string): string {
  return `Analyze this .NET code coverage report from '${fileName}':

\`\`\`
${coverageReport}
\`\`\`

Please produce a concise markdown report with these sections:

### Summary
- Overall coverage health and the most important risk in 2-3 bullets.

### Highest-risk Coverage Gaps
- Prioritize uncovered or weakly covered production code that is likely to hide bugs.
- Mention classes, methods, files, or line ranges when the report includes them.

### Tests To Add First
- Recommend concrete unit or integration test cases in priority order.
- Include edge cases, failure paths, async behavior, and boundary conditions when visible from the report.

### Cleanup Opportunities
- Note test suites that look noisy, low-value, or overly focused on trivial code.

Avoid generic advice. If the report format lacks detail, say exactly what is missing and what coverage format would make the analysis stronger.`;
}

export function buildCoverageGapTestsPrompt(
  sourceName: string,
  codeSnippet: string,
  coverageFileName: string,
  coverageReport: string,
  testFramework: string,
  mockingLibrary: string
): string {
  return `Generate unit tests for '${sourceName}' using ${testFramework} and ${mockingLibrary}, focusing specifically on the gaps shown in '${coverageFileName}'.

Source code:

\`\`\`csharp
${codeSnippet}
\`\`\`

Coverage report excerpt:

\`\`\`
${coverageReport}
\`\`\`

Requirements:
1. Prioritize uncovered branches, exception paths, guard clauses, edge cases, and async failure paths visible from the coverage data.
2. Do not generate tests for trivial getters/setters unless they are part of meaningful behavior.
3. Use clean Arrange-Act-Assert structure and readable method names following: \`MethodName_Condition_ExpectedResult\`.
4. Include necessary using statements and mocks for collaborators when appropriate.
5. Return ONLY the complete test class file inside a markdown csharp code block.`;
}

/** Pulls the code out of a fenced block, falling back to the whole response. */
export function extractCodeSnippet(aiResponse: string): string {
  if (!aiResponse || !aiResponse.trim()) {
    return '';
  }

  const fenced = /```csharp\s*\r?\n([\s\S]*?)```/i.exec(aiResponse) ?? /```[a-zA-Z]*\s*\r?\n([\s\S]*?)```/.exec(aiResponse);

  return (fenced ? fenced[1] : aiResponse).trim();
}
