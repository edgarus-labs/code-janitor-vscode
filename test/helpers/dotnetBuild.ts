import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompilerError, compilerErrors } from '../../scripts/compileOracle';

/**
 * Real-compiler verification for tests: writes C# files into a temporary project, runs
 * `dotnet build` and returns the compiler errors (CSxxxx). The extension itself never runs .NET;
 * this only proves that rewritten code still compiles. Tests using it must be wrapped in
 * `describe.skipIf(!dotnetAvailable)`.
 */
export const dotnetAvailable = spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status === 0;

// CI sets this in the jobs that run the compiler tests: there a missing SDK must fail them instead of skipping them.
if (!dotnetAvailable && process.env.CODE_JANITOR_REQUIRE_DOTNET === '1') {
  throw new Error('CODE_JANITOR_REQUIRE_DOTNET=1, but `dotnet --version` failed: install the .NET SDK.');
}

export const DEFAULT_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>
`;

export interface BuildResult {
  readonly ok: boolean;
  readonly errors: CompilerError[];
  readonly output: string;
}

/** Files by path relative to the project folder (forward slashes), content as text. */
export type ProjectFiles = Readonly<Record<string, string>>;

export function writeProject(files: ProjectFiles, csproj: string = DEFAULT_CSPROJ, projectName = 'Test.csproj'): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-dotnet-'));
  fs.writeFileSync(path.join(folder, projectName), csproj);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(folder, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  return folder;
}

export function buildProject(folder: string, projectName = 'Test.csproj'): BuildResult {
  const result = spawnSync(
    'dotnet',
    [
      'build',
      path.join(folder, projectName),
      '-nologo',
      '-v:q',
      '-clp:NoSummary',
      '-p:RunAnalyzers=false',
      '-p:EnforceCodeStyleInBuild=false',
      '-p:TreatWarningsAsErrors=false',
      '-p:WarningsAsErrors=',
    ],
    { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  return { ok: result.status === 0, errors: compilerErrors(output, folder), output };
}

/** Builds the files as a project in a temporary folder, removes the folder and returns the result. */
export function buildFiles(files: ProjectFiles, csproj: string = DEFAULT_CSPROJ): BuildResult {
  const folder = writeProject(files, csproj);
  try {
    return buildProject(folder);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

export function formatErrors(result: BuildResult): string {
  return result.errors.map((error) => `${error.file}(${error.line}): ${error.code} ${error.message}`).join('\n') || result.output;
}
