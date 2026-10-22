namespace CodeJanitor.Engine.Tests.Testbed;

internal static class TestbedHelp
{
    /// <summary>What a test that needs the testbed says when it is not there.</summary>
    public const string Missing =
        "The testbed was not found. Download it (it is public): git clone https://github.com/edgarus-labs/code-janitor-testbed .testbed " +
        "in the repository root, or set CODE_JANITOR_TESTBED to a clone of it.";
}
