using System;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Wraps a plain delegate as an <see cref="ISourceTransformation" /> - ported unchanged from
/// CodeCleanupManager's private nested class of the same shape (Visual Studio extension).
/// </summary>
public sealed class DelegateSourceTransformation : ISourceTransformation
{
    private readonly Func<string, string> _apply;

    public DelegateSourceTransformation(string name, Func<string, string> apply)
    {
        Name = name;
        _apply = apply;
    }

    public string Name { get; }

    public string Apply(string source)
    {
        return _apply(source) ?? source;
    }
}
