import { SourceTransformation } from './types';

export interface PreviewStep {
  readonly index: number;
  readonly name: string;
  readonly included: boolean;
  readonly changed: boolean;
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

  preview(source: string, excludedTransformations?: ReadonlySet<number>): PreviewResult {
    const steps: PreviewStep[] = [];
    const updatedSource = this.execute(source, excludedTransformations, steps);

    return new PreviewResult(source, updatedSource, steps);
  }

  private execute(
    source: string,
    excludedTransformations?: ReadonlySet<number>,
    steps?: PreviewStep[]
  ): string {
    if (!source) {
      return source;
    }

    let current = source;
    for (let index = 0; index < this.transformations.length; index++) {
      const transformation = this.transformations[index];
      const included = excludedTransformations?.has(index) !== true;
      const updated = included ? transformation.apply(current) ?? current : current;
      steps?.push({
        index,
        name: transformation.name,
        included,
        changed: current !== updated,
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
