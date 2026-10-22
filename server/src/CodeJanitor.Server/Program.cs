using CodeJanitor.Engine;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Server;

AnalyzerDependencyUnification.Register();

// MSBuild is registered first, before any type that may load it.
if (args.Length > 0 && args[0] == "check")
{
    var quiet = (string _) => { };
    using var checkHost = new WorkspaceHost(quiet, MSBuildSupport.EnsureRegistered(quiet));

    return await CheckCommand.RunAsync(args[1..], Console.Out, Console.Error, checkHost, new CleanupEngine(Console.Error.WriteLine), CleanupSettingsDefaults.Create, Environment.CurrentDirectory);
}

var log = (string line) => Console.Error.WriteLine(line);
var msbuildAvailable = MSBuildSupport.EnsureRegistered(log);
var output = Console.OpenStandardOutput();
var input = Console.OpenStandardInput();

// stdout carries the protocol only: anything else written to the console goes to stderr.
Console.SetOut(Console.Error);
using var host = new WorkspaceHost(log, msbuildAvailable);

try
{
    await RpcServer.RunAsync(output, input, host, new CleanupEngine(log), log);
}
catch (Exception exception) when (exception is not OutOfMemoryException)
{
    log($"The connection failed: {exception}");

    return 1;
}

return 0;
