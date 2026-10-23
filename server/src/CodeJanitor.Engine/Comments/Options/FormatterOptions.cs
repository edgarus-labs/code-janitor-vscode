#nullable disable
using System;

namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// Document wide options for the comment formatter.
/// </summary>
internal sealed class FormatterOptions
{
    /// <summary>
    /// The list of comment prefix tokens to ignore while formatting the comment.
    /// </summary>
    public string[] IgnoreTokens { get; set; }

    /// <summary>
    /// Do not wrap to a newline for only a single word.
    /// </summary>
    public bool SkipWrapOnLastWord { get; set; }

    /// <summary>
    /// Gets or sets the tab size.
    /// </summary>
    public int TabSize { get; set; } = 4;

    /// <summary>
    /// Gets or sets the wrap column.
    /// </summary>
    public int WrapColumn { get; set; }

    /// <summary>
    /// Gets or sets the xml.
    /// </summary>
    public FormatterOptionsXml Xml { get; set; }

    /// <summary>
    /// Creates the formatter options from the <c>commentFormat</c> settings.
    /// </summary>
    /// <param name="settings">The settings.</param>
    /// <returns>A FormatterOptions value produced by this method.</returns>
    internal static FormatterOptions FromSettings(CommentFormatSettings settings) => new FormatterOptions
    {
        WrapColumn = settings.WrapColumn,
        SkipWrapOnLastWord = settings.SkipWrapOnLastWord,
        IgnoreTokens = settings.IgnoreLinesStartingWith.ToArray(),
        Xml = FormatterOptionsXml.FromSettings(settings)
    };

    /// <summary>
    /// Invokes the provided action on the current instance if non-null, mutating it, then returns the same instance for fluent chaining, with no-op behavior when the action is null and no thrown exceptions.
    /// </summary>
    /// <param name="action">The action.</param>
    /// <returns>A FormatterOptions value produced by this method.</returns>
    internal FormatterOptions Set(Action<FormatterOptions> action)
    {
        action?.Invoke(this);

        return this;
    }
}
