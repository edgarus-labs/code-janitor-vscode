import * as path from 'node:path';
import { CleanupSettings } from '../src/cleanup/types';

/**
 * Pure helpers of the compile oracle (`scripts/compile-oracle.ts`): reading compiler errors from
 * `dotnet build` output, comparing builds, and narrowing an `.editorconfig` or the cleanup settings
 * to a single rule when looking for the one that broke the build.
 */

export interface CompilerError {
  readonly code: string;
  /** Relative to the copied tree, `/`-separated; empty for errors without a file. */
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const ERROR_LINE = /^(?:(.+?)\((\d+),\d+\)|[^:]+?)\s*:\s*error (CS\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?$/;

/** The C# compiler errors (`CSxxxx`) of a build, each once; warnings and analyzer diagnostics are not errors here. */
export function compilerErrors(output: string, root: string): CompilerError[] {
  const seen = new Set<string>();
  const errors: CompilerError[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line.trim());
    if (!match || seen.has(line.trim())) {
      continue;
    }

    seen.add(line.trim());
    const file = match[1] ? path.relative(root, match[1]).split(path.sep).join('/') : '';
    errors.push({ code: match[3], file, line: match[2] ? Number(match[2]) : 0, message: match[4] });
  }

  return errors;
}

const errorKey = (error: CompilerError): string => `${error.code}|${error.file}|${error.message}`;

/** The errors of `after` that `before` does not have, compared without line numbers (cleanup moves lines). */
export function newCompilerErrors(before: readonly CompilerError[], after: readonly CompilerError[]): CompilerError[] {
  const remaining = new Map<string, number>();
  for (const error of before) {
    remaining.set(errorKey(error), (remaining.get(errorKey(error)) ?? 0) + 1);
  }

  return after.filter((error) => {
    const count = remaining.get(errorKey(error)) ?? 0;
    remaining.set(errorKey(error), count - 1);

    return count <= 0;
  });
}

/**
 * The `.editorconfig` with every rule-ID severity and naming rule severity set to `none` except
 * `diagnosticId` (`IDE1006` keeps the naming rules); `undefined` turns every rule off. Option
 * values stay, so the rule under test applies with the same options.
 */
export function editorConfigVariant(text: string, diagnosticId: string | undefined): string {
  const only = diagnosticId?.toUpperCase();

  return text
    .replace(/^(dotnet_diagnostic\.([^.\s]+)\.severity\s*=\s*)\S+/gim, (line, prefix: string, id: string) =>
      id.toUpperCase() === only ? line : `${prefix}none`
    )
    .replace(/^(dotnet_naming_rule\.[^.\s]+\.severity\s*=\s*)\S+/gim, (line, prefix: string) => (only === 'IDE1006' ? line : `${prefix}none`));
}

/** The settings with every boolean setting off except `only`. */
export function settingsVariant(settings: CleanupSettings, only: keyof CleanupSettings | undefined): CleanupSettings {
  const variant: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      variant[key] = key === only;
    }
  }

  return variant as unknown as CleanupSettings;
}
