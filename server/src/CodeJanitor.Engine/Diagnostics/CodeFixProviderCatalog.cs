using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Diagnostics;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Supplies the existing <see cref="CodeFixProvider" />s available to a project: the providers supplied by the host
/// plus every <see cref="ExportCodeFixProviderAttribute" />-annotated provider found
/// in the assemblies behind the project's and the solution's analyzer references (NuGet analyzers) and of the host references.
/// </summary>
/// <remarks>
/// Scanned assemblies are cached, so the provider instances of an assembly are created once per catalog. The order
/// is deterministic: by provider type assembly-qualified name (ordinal). Providers of the same type (full name) are
/// collapsed; a host-supplied instance wins over a scanned one because it may carry imports that a reflection-created
/// instance lacks. Providers whose type cannot be created without dependency injection are only available when the
/// host supplies them; <see cref="GetLoadFailures" /> names what could not be loaded or created.
/// </remarks>
public sealed class CodeFixProviderCatalog
{
    private readonly ImmutableArray<ProviderEntry> _hostProviders;
    private readonly ImmutableArray<AnalyzerReference> _hostReferences;

    private readonly ConcurrentDictionary<Assembly, AssemblyScan> _scannedAssemblies =
        new ConcurrentDictionary<Assembly, AssemblyScan>();

    /// <summary>
    /// Initializes a new instance of the <see cref="CodeFixProviderCatalog" /> class.
    /// </summary>
    /// <param name="additionalProviders">Providers supplied by the host.</param>
    /// <param name="hostReferences">Analyzer references scanned for every project on top of its own (e.g. <see cref="HostAnalyzers.References" />).</param>
    public CodeFixProviderCatalog(IEnumerable<CodeFixProvider>? additionalProviders = null, IEnumerable<AnalyzerReference>? hostReferences = null)
    {
        _hostReferences = hostReferences?.ToImmutableArray() ?? [];
        _hostProviders = additionalProviders is null
            ? ImmutableArray<ProviderEntry>.Empty
            : additionalProviders
                .Where(provider => provider != null)
                .Select(provider => new ProviderEntry(provider, GetExportedLanguages(provider.GetType())))
                .ToImmutableArray();
    }

    /// <summary>
    /// Gets the code fix providers for the language of <paramref name="project" />, in deterministic order.
    /// </summary>
    /// <param name="project">The project whose analyzer references are scanned.</param>
    /// <returns>The providers, ordered by type assembly-qualified name, one per provider type.</returns>
    public ImmutableArray<CodeFixProvider> GetProviders(Project project)
    {
        ArgumentNullException.ThrowIfNull(project);

        var language = project.Language;
        var hostProviders = _hostProviders
            .Where(host => host.Languages.Length == 0 || host.Languages.Contains(language, StringComparer.Ordinal))
            .Select(host => host.Provider);
        var scannedProviders = project.AnalyzerReferences
            .Concat(project.Solution.AnalyzerReferences)
            .Concat(_hostReferences)
            .Select(reference => TryGetAssembly(reference, out _))
            .OfType<Assembly>()
            .Distinct()
            .SelectMany(assembly => _scannedAssemblies.GetOrAdd(assembly, ScanAssembly).Providers)
            .Where(scanned => scanned.Languages.Contains(language, StringComparer.Ordinal))
            .Select(scanned => scanned.Provider)
            .OrderBy(GetSortKey, StringComparer.Ordinal);

        return hostProviders
            .Concat(scannedProviders)
            .GroupBy(provider => provider.GetType().FullName, StringComparer.Ordinal)
            .Select(sameType => sameType.First())
            .OrderBy(GetSortKey, StringComparer.Ordinal)
            .ToImmutableArray();
    }

    /// <summary>
    /// The analyzer references of <paramref name="project" /> whose assembly could not be loaded, the types of a scanned
    /// assembly that could not be loaded and the exported providers that could not be created, one message each: their
    /// fixes are missing from <see cref="GetProviders" />, so their diagnostics look as if no fix existed.
    /// </summary>
    /// <param name="project">The project whose analyzer references are scanned.</param>
    /// <returns>The failures, without duplicates.</returns>
    public ImmutableArray<string> GetLoadFailures(Project project)
    {
        ArgumentNullException.ThrowIfNull(project);

        var failures = new List<string>();
        foreach (var reference in project.AnalyzerReferences.Concat(project.Solution.AnalyzerReferences).Concat(_hostReferences))
        {
            var assembly = TryGetAssembly(reference, out var failure);
            if (failure is not null)
            {
                failures.Add(failure);
            }
            else if (assembly is not null)
            {
                failures.AddRange(_scannedAssemblies.GetOrAdd(assembly, ScanAssembly).Failures);
            }
        }

        return [.. failures.Distinct(StringComparer.Ordinal)];
    }

    private static string GetSortKey(CodeFixProvider provider) => provider.GetType().AssemblyQualifiedName ?? provider.GetType().Name;

    /// <summary>
    /// Only file references expose the assembly behind them; fixers for analyzers passed as instances must be
    /// supplied by the host. A reference whose assembly cannot be loaded contributes no analyzers either, which
    /// <paramref name="failure" /> then names.
    /// </summary>
    private static Assembly? TryGetAssembly(AnalyzerReference reference, out string? failure)
    {
        failure = null;
        if (reference is not AnalyzerFileReference fileReference)
        {
            return null;
        }

        try
        {
            return fileReference.GetAssembly();
        }
        catch (Exception exception) when (exception is IOException or BadImageFormatException or UnauthorizedAccessException)
        {
            failure = $"{reference.FullPath} could not be loaded: {exception.GetType().Name}: {exception.Message}";

            return null;
        }
    }

    private static AssemblyScan ScanAssembly(Assembly assembly)
    {
        var providers = ImmutableArray.CreateBuilder<ProviderEntry>();
        var failures = ImmutableArray.CreateBuilder<string>();

        foreach (var type in GetLoadableTypes(assembly, failures))
        {
            if (type.IsAbstract || type.ContainsGenericParameters || !typeof(CodeFixProvider).IsAssignableFrom(type))
            {
                continue;
            }

            var languages = GetExportedLanguages(type);
            if (languages.Length == 0)
            {
                continue;
            }

            var provider = TryCreateProvider(type, out var failure);
            if (provider is not null)
            {
                providers.Add(new ProviderEntry(provider, languages));
            }
            else if (failure is not null)
            {
                failures.Add(failure);
            }
        }

        return new AssemblyScan(providers.ToImmutable(), failures.ToImmutable());
    }

    private static IEnumerable<Type> GetLoadableTypes(Assembly assembly, ImmutableArray<string>.Builder failures)
    {
        try
        {
            return assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException exception)
        {
            var first = exception.LoaderExceptions.OfType<Exception>().FirstOrDefault();
            failures.Add($"{assembly.GetName().Name}: {exception.LoaderExceptions.Length} type(s) could not be loaded{(first is null ? string.Empty : $": {first.Message}")}");

            return exception.Types.OfType<Type>();
        }
    }

    private static string[] GetExportedLanguages(Type providerType) =>
        providerType.GetCustomAttributes<ExportCodeFixProviderAttribute>(inherit: false)
            .SelectMany(export => export.Languages ?? [])
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    /// <summary>
    /// Creates a provider through its parameterless (MEF importing) constructor. Providers that need injected
    /// dependencies, or whose dependencies cannot be loaded, are skipped and named by <paramref name="failure" />: their
    /// diagnostics are then reported as having no code fix provider unless the host supplies an instance.
    /// </summary>
    private static CodeFixProvider? TryCreateProvider(Type type, out string? failure)
    {
        failure = null;
        try
        {
            return (CodeFixProvider?)Activator.CreateInstance(type, nonPublic: true);
        }
        catch (Exception exception) when (exception is MemberAccessException or TargetInvocationException or TypeLoadException or IOException or BadImageFormatException or NotSupportedException)
        {
            var cause = exception is TargetInvocationException { InnerException: { } inner } ? inner : exception;
            failure = $"{type.Name} could not be created: {cause.GetType().Name}: {cause.Message}";

            return null;
        }
    }

    /// <summary>The providers of one assembly, and what could not be loaded or created.</summary>
    private sealed record AssemblyScan(ImmutableArray<ProviderEntry> Providers, ImmutableArray<string> Failures);

    /// <summary>
    /// A provider with the languages it is exported for (empty: not exported, i.e. any language).
    /// </summary>
    private sealed class ProviderEntry
    {
        public ProviderEntry(CodeFixProvider provider, string[] languages)
        {
            Provider = provider;
            Languages = languages;
        }

        public CodeFixProvider Provider { get; }

        public string[] Languages { get; }
    }
}
