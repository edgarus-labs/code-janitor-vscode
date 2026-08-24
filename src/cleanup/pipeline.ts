import { SourceTransformation } from './types';

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
    if (!source) {
      return source;
    }

    let current = source;
    for (const transformation of this.transformations) {
      current = transformation.apply(current) ?? current;
    }

    return current;
  }
}

/** Wraps a plain function as a named transformation. */
export function delegateTransformation(name: string, transform: (source: string) => string): SourceTransformation {
  return { name, apply: transform };
}
