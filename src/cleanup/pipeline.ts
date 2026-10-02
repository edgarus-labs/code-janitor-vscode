import { countChangedRegions } from './lineDiff';
import { RuleChange, SourceTransformation } from './types';

export interface PreviewStep {
  readonly index: number;
  readonly name: string;
  readonly included: boolean;
  readonly changed: boolean;
  /** The number of separate places the step changed. */
  readonly changes: number;
  /** For a step made of several rules, what each rule did. */
  readonly rules?: readonly RuleChange[];
}

export class PreviewResult {
  constructor(
    readonly originalSource: string,
    readonly updatedSource: string,
    readonly steps: readonly PreviewStep[]
  ) {}

  get hasChanges(): boolean {
    return this.originalSource !== this.updatedSource;
  }

  tryApply(currentSource: string, replaceSource: (updated: string) => void): boolean {
    if (this.originalSource !== currentSource) {
      return false;
    }

    if (this.hasChanges) {
      replaceSource(this.updatedSource);
    }

    return true;
  }
}

/**
 * Runs an ordered sequence of transformations over a piece of C# source text. Each block receives
 * the output of the previous one; a block that does not apply returns its input unchanged, so the
 * pipeline is safe to run with any subset or ordering of blocks.
 */
export class SourceTransformationPipeline {
  readonly transformations: readonly SourceTransformation[];

  constructor(transformations: readonly (SourceTransformation | null | undefined)[]) {
    this.transformations = transformations.filter((t): t is SourceTransformation => Boolean(t));
  }

  run(source: string): string {
    return this.execute(source);
  }

  /**
   * Runs the pipeline without the steps at `excludedTransformations` and without the rules whose
   * id is in `excludedRules` (for steps made of rules), telling what each step changed.
   */
  preview(source: string, excludedTransformations?: ReadonlySet<number>, excludedRules: ReadonlySet<string> = new Set()): PreviewResult {
    const steps: PreviewStep[] = [];
    const updatedSource = this.execute(source, excludedTransformations, { steps, excludedRules });

    return new PreviewResult(source, updatedSource, steps);
  }

  private execute(
    source: string,
    excludedTransformations?: ReadonlySet<number>,
    preview?: { steps: PreviewStep[]; excludedRules: ReadonlySet<string> }
  ): string {
    if (!source) {
      return source;
    }

    let current = source;
    for (let index = 0; index < this.transformations.length; index++) {
      const transformation = this.transformations[index];
      const included = excludedTransformations?.has(index) !== true;
      if (!preview) {
        current = included ? transformation.apply(current) ?? current : current;
        continue;
      }

      const ruled = included && transformation.applyRules ? transformation.applyRules(current, preview.excludedRules) : undefined;
      const updated = ruled ? ruled.output : included ? transformation.apply(current) ?? current : current;
      preview.steps.push({
        index,
        name: transformation.name,
        included,
        changed: current !== updated,
        changes: countChangedRegions(current, updated),
        ...(ruled ? { rules: ruled.rules } : {}),
      });
      current = updated;
    }

    return current;
  }
}

/** Wraps a plain function as a named transformation. */
export function delegateTransformation(name: string, transform: (source: string) => string): SourceTransformation {
  return { name, apply: transform };
}
