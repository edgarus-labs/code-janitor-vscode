using System.Collections;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps.Support;

/// <summary>
/// The MSTest assertions the Visual Studio extension's tests use, on top of xunit; messages are ignored.
/// </summary>
internal static class MsAssert
{
    public static void AreEqual<T>(T expected, T actual, string? message = null) => Assert.Equal(expected, actual);

    public static void AreNotEqual<T>(T notExpected, T actual, string? message = null) => Assert.NotEqual(notExpected, actual);

    public static void AreSame(object? expected, object? actual, string? message = null) => Assert.Same(expected, actual);

    public static void AreNotSame(object? notExpected, object? actual, string? message = null) => Assert.NotSame(notExpected, actual);

    public static void AreSequenceEqual<T>(IEnumerable<T> expected, IEnumerable<T> actual, string? message = null) => Assert.Equal(expected, actual);

    public static void AreSequenceEqual<T>(IEnumerable<T> expected, IEnumerable<T> actual, SequenceOrder order) =>
        Assert.Equal(
            order == SequenceOrder.InAnyOrder ? expected.OrderBy(item => item?.ToString(), StringComparer.Ordinal) : expected,
            order == SequenceOrder.InAnyOrder ? actual.OrderBy(item => item?.ToString(), StringComparer.Ordinal) : actual);

    public static void IsTrue(bool condition, string? message = null) => Assert.True(condition, message);

    public static void IsFalse(bool condition, string? message = null) => Assert.False(condition, message);

    public static void IsNull(object? value, string? message = null) => Assert.Null(value);

    public static void IsNotNull(object? value, string? message = null) => Assert.NotNull(value);

    public static void IsEmpty(IEnumerable collection, string? message = null) => Assert.Empty(collection);

    public static void HasCount(int expected, IEnumerable collection, string? message = null) => Assert.Equal(expected, collection.Cast<object?>().Count());

    public static void Contains(string substring, string value, string? message = null) => Assert.Contains(substring, value, StringComparison.Ordinal);

    public static void Contains<T>(T expected, IEnumerable<T> collection, string? message = null) => Assert.Contains(expected, collection);

    public static void DoesNotContain(string substring, string value, string? message = null) => Assert.DoesNotContain(substring, value, StringComparison.Ordinal);

    public static void DoesNotContain<T>(T expected, IEnumerable<T> collection, string? message = null) => Assert.DoesNotContain(expected, collection);

    public static void StartsWith(string prefix, string value, string? message = null) => Assert.StartsWith(prefix, value, StringComparison.Ordinal);

    public static void EndsWith(string suffix, string value, string? message = null) => Assert.EndsWith(suffix, value, StringComparison.Ordinal);

    public static void Fail(string? message = null) => Assert.Fail(message ?? "Failed.");

    public static T Throws<T>(Action action, string? message = null) where T : Exception => Assert.ThrowsAny<T>(action);

    public static T ThrowsExactly<T>(Action action, string? message = null) where T : Exception => Assert.Throws<T>(action);

    public static Task<T> ThrowsAsync<T>(Func<Task> action, string? message = null) where T : Exception => Assert.ThrowsAnyAsync<T>(action);

    public static Task<T> ThrowsExactlyAsync<T>(Func<Task> action, string? message = null) where T : Exception => Assert.ThrowsAsync<T>(action);
}

/// <summary>How <see cref="MsAssert.AreSequenceEqual{T}(IEnumerable{T}, IEnumerable{T}, SequenceOrder)" /> compares.</summary>
internal enum SequenceOrder
{
    InOrder,
    InAnyOrder,
}
