using System;
using System.Collections.Generic;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Runs an ordered sequence of <see cref="ISourceTransformation" /> blocks over a piece of C#
/// source text - the composable "flow" of the headless-Roslyn cleanup path (BL-018). Each block
/// receives the output of the previous one; a block that does not apply returns its input
/// unchanged, so the pipeline is safe to run with any subset or ordering of blocks.
/// </summary>

public sealed class SourceTransformationPipeline
{
    private readonly IList<ISourceTransformation> _transformations;

    /// <summary>
    /// Initializes a new pipeline from the given transformations, in the order they should run.
    /// </summary>

    public SourceTransformationPipeline(params ISourceTransformation[] transformations)
        : this((IEnumerable<ISourceTransformation>)transformations)
    {
    }

    /// <summary>
    /// Initializes a new pipeline from the given transformations, in the order they should run.
    /// </summary>

    public SourceTransformationPipeline(IEnumerable<ISourceTransformation> transformations)
    {
        if (transformations is null)
        {
            throw new ArgumentNullException(nameof(transformations));
        }

        _transformations = transformations.Where(t => t is not null).ToList();
    }

    /// <summary>
    /// Gets the ordered transformations that make up this pipeline.
    /// </summary>
    public IReadOnlyList<ISourceTransformation> Transformations => (IReadOnlyList<ISourceTransformation>)_transformations;

    /// <summary>
    /// Runs every transformation in order and returns the final source text. Empty or null input
    /// is returned unchanged.
    /// </summary>

    public string Run(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var current = source;
        foreach (var transformation in _transformations)
        {
            current = transformation.Apply(current) ?? current;
        }

        return current;
    }
}
