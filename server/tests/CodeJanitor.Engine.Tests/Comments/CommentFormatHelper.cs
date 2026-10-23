#nullable disable
using System;
using CodeJanitor.Engine.Comments;
using CodeJanitor.Engine.Comments.Options;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// CommentFormatHelper is a utility class that provides methods to assert equality of strings after applying comment formatting transformations.
/// </summary>
internal sealed class CommentFormatHelper
{
    /// <summary>
    /// This convenience overload delegates to the four-parameter AssertEqualAfterFormat overload, passing null for the two missing arguments and forwarding the optional FormatterOptions, so its behavior and any side effects are entirely determined by that underlying method.
    /// </summary>
    /// <param name="text">The text.</param>
    /// <param name="options">The options.</param>
    /// <returns>A string value produced by this method.</returns>
    public static string AssertEqualAfterFormat(
             string text,
             Action<FormatterOptions> options = null) => AssertEqualAfterFormat(text, null, null, options);

    /// <summary>
    /// This convenience overload delegates to the four-argument Assert.
    /// </summary>
    /// <param name="text">The text.</param>
    /// <param name="expected">The expected.</param>
    /// <param name="options">The options.</param>
    /// <returns>A string value produced by this method.</returns>
    public static string AssertEqualAfterFormat(
                  string text,
            string expected,
                  Action<FormatterOptions> options = null) => AssertEqualAfterFormat(text, expected, null, options);

    /// <summary>
    /// Formats the given text via CodeComment.Format, applies optional FormatterOptions from default settings via the options callback, asserts the result equals expected (or the original text if expected is null), and returns the formatted result.
    /// </summary>
    /// <param name="text">The text.</param>
    /// <param name="expected">The expected.</param>
    /// <param name="prefix">The prefix.</param>
    /// <param name="options">The options.</param>
    /// <returns>A string value produced by this method.</returns>
    public static string AssertEqualAfterFormat(
            string text,
            string expected,
            string prefix,
            Action<FormatterOptions> options = null)
    {
        string result = CodeComment.Format(text, prefix, options, VsSettings.Default.CommentFormat);
        FormatterOptions fOptions = FormatterOptions.FromSettings(VsSettings.Default.CommentFormat);
        options?.Invoke(fOptions);
        Assert.AreEqual(expected ?? text, result);

        return result;
    }
}
