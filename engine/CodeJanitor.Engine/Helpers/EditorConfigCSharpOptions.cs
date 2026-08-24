using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace CodeJanitor.Helpers;

/// <summary>
/// Represents a set of configurable C# code formatting and style options that map to common .editorconfig settings.
/// </summary>
internal sealed class EditorConfigCSharpOptions
{
    /// <summary>
    /// Gets or sets the sort system directives first.
    /// </summary>
    internal bool? SortSystemDirectivesFirst { get; set; }

    /// <summary>
    /// Gets or sets the separate import directive groups.
    /// </summary>
    internal bool? SeparateImportDirectiveGroups { get; set; }

    /// <summary>
    /// Gets or sets the trim trailing whitespace.
    /// </summary>
    internal bool? TrimTrailingWhitespace { get; set; }

    /// <summary>
    /// Gets or sets the insert final newline.
    /// </summary>
    internal bool? InsertFinalNewline { get; set; }

    /// <summary>
    /// Gets or sets the indent style.
    /// </summary>
    internal string IndentStyle { get; set; }

    /// <summary>
    /// Gets or sets the indent size.
    /// </summary>
    internal int? IndentSize { get; set; }

    /// <summary>
    /// Gets or sets the tab width.
    /// </summary>
    internal int? TabWidth { get; set; }
}
