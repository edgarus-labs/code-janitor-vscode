using Microsoft.Build.Locator;

namespace CodeJanitor.Server;

/// <summary>Registers the .NET SDK's MSBuild once, before any MSBuild type loads.</summary>
internal static class MSBuildSupport
{
    private static readonly object Gate = new();
    private static bool? available;

    /// <summary>True when a .NET SDK was found and its MSBuild registered; false with only a .NET runtime.</summary>
    public static bool EnsureRegistered(Action<string> log)
    {
        lock (Gate)
        {
            if (available is { } known)
            {
                return known;
            }

            try
            {
                if (!MSBuildLocator.IsRegistered)
                {
                    if (!MSBuildLocator.QueryVisualStudioInstances().Any())
                    {
                        log("No .NET SDK found: MSBuild is unavailable.");
                        available = false;

                        return false;
                    }

                    var instance = MSBuildLocator.RegisterDefaults();
                    log($"MSBuild {instance.Version} from {instance.MSBuildPath}");
                }

                available = true;
            }
            catch (Exception exception) when (exception is InvalidOperationException or IOException or UnauthorizedAccessException)
            {
                log($"MSBuild could not be registered: {exception.Message}");
                available = false;
            }

            return available.Value;
        }
    }
}
