using System.Diagnostics;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Diagnostics;
using CodeJanitor.Engine.Settings;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace CodeJanitor.Server;

/// <summary>A document to clean, in its solution with the request's unsaved texts, the notes its loading produced and what failed while loading it.</summary>
internal sealed record HostDocument(Document Document, IReadOnlyList<string> Issues)
{
    /// <summary>Why files are not cleaned in their projects at all (the .NET SDK is missing): a warning for the user rather than a note.</summary>
    public IReadOnlyList<string> Warnings { get; init; } = [];

    /// <summary>What the loading could not do (a project that failed to load): a failure of the loading rather than a note.</summary>
    public IReadOnlyList<string> Failures { get; init; } = [];

    /// <summary>The notes, the warnings and the failures, for the channels that do not tell them apart.</summary>
    public IEnumerable<string> Messages => Issues.Concat(Warnings).Concat(Failures);
}

/// <summary>
/// The solutions the server cleans files in: one <see cref="MSBuildWorkspace"/> per workspace folder, loading lazily the
/// solution (or else the nearest project) of each requested file, kept up to date by <see cref="FileChanged"/>. A file in no
/// loadable project, or every file when MSBuild is unavailable, gets a <see cref="FallbackProject"/>.
/// </summary>
internal sealed partial class WorkspaceHost : IDisposable
{
    private readonly Action<string> _log;
    private readonly bool _msbuildAvailable;
    private readonly object _gate = new();
    private readonly List<string> _folders = [];
    private readonly List<LoadedWorkspace> _workspaces = [];
    private readonly HashSet<string> _reported = new(StringComparer.Ordinal);
    private readonly AdhocWorkspace _fallbackWorkspace = new(HostAnalyzers.HostServices);

    public WorkspaceHost(Action<string> log)
        : this(log, MSBuildSupport.EnsureRegistered(log))
    {
    }

    internal WorkspaceHost(Action<string> log, bool msbuildAvailable)
    {
        _log = log;
        _msbuildAvailable = msbuildAvailable;
    }

    /// <summary>Sets the workspace folders; each gets its own workspace, loaded on its first request.</summary>
    public void Initialize(IEnumerable<string> workspaceFolders)
    {
        lock (_gate)
        {
            _folders.Clear();
            _folders.AddRange(workspaceFolders.Select(folder => Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder))));
        }
    }

    /// <summary>
    /// The document of <paramref name="filePath"/>, with <paramref name="text"/> (when given) and <paramref name="unsavedDocuments"/>
    /// over the disk texts of this request's solution only.
    /// </summary>
    public async Task<HostDocument> OpenAsync(string filePath, string? text, IReadOnlyList<UnsavedDocument>? unsavedDocuments, CancellationToken cancellationToken)
    {
        filePath = Path.GetFullPath(filePath);
        var issues = new List<string>();
        var warnings = new List<string>();
        var failures = new List<string>();
        (Solution Solution, DocumentId Id)? found = null;
        if (_msbuildAvailable)
        {
            found = await FindInProjectsAsync(filePath, failures, cancellationToken).ConfigureAwait(false);
            if (found is null)
            {
                ReportOnce(
                    "loose:" + filePath,
                    $"{filePath} is not part of a loadable C# project, so it is cleaned in a fallback project with the .NET runtime's assemblies and its .editorconfig.",
                    issues);
            }
        }
        else
        {
            ReportOnce(
                "no-sdk",
                "The .NET SDK was not found (MSBuild is unavailable), so C# files are cleaned in a fallback project with the .NET runtime's assemblies and their .editorconfig, without their projects' settings and references.",
                warnings);
        }

        var (solution, id) = found ?? FallbackProject.Create(_fallbackWorkspace.CurrentSolution, filePath, message => ReportOnce(message, message, issues));
        if (text is not null)
        {
            solution = Overlay(solution, filePath, text);
        }

        foreach (var unsaved in unsavedDocuments ?? [])
        {
            var path = Path.GetFullPath(unsaved.Path);
            if (!PathComparer.Instance.Equals(path, filePath))
            {
                solution = Overlay(solution, path, unsaved.Text);
            }
        }

        return new HostDocument(solution.GetDocument(id)!, issues) { Warnings = warnings, Failures = failures };
    }

    /// <summary>
    /// A file changed on disk: a project, <c>.props</c>, <c>.targets</c> or solution reloads the workspaces it affects (not one
    /// under <c>bin</c> or <c>obj</c>, which a build writes); a source file or analyzer config is read again (added to or removed
    /// from its project when it was created or deleted). A failure to apply the change to one workspace does not stop the others.
    /// </summary>
    public void FileChanged(string path)
    {
        path = Path.GetFullPath(path);
        var extension = Path.GetExtension(path).ToLowerInvariant();
        if (extension == ".editorconfig")
        {
            EditorConfigOptions.Forget(path);
        }

        lock (_gate)
        {
            foreach (var workspace in _workspaces.ToList())
            {
                try
                {
                    ApplyFileChange(workspace, path, extension);
                }
                catch (Exception exception) when (exception is not OutOfMemoryException)
                {
                    _log($"fileChanged {path} failed for the workspace of {workspace.Root}: {exception}");
                }
            }
        }
    }

    private void ApplyFileChange(LoadedWorkspace workspace, string path, string extension)
    {
        switch (extension)
        {
            case ".csproj":
                if (PathComparer.IsUnder(path, workspace.Root) || workspace.Solution.Projects.Any(project => PathComparer.Instance.Equals(project.FilePath, path)))
                {
                    Reset(workspace);
                }

                break;
            case ".props" or ".targets":
                if (MayBeImportedBy(workspace, path))
                {
                    Reset(workspace);
                }

                break;
            case ".sln" or ".slnx":
                if (PathComparer.IsUnder(path, workspace.Root) || workspace.Loads.ContainsKey(path))
                {
                    Reset(workspace);
                }

                break;
            case ".cs":
                workspace.ChangedFiles.Add(path);
                workspace.Solution = ApplySourceChange(workspace.Solution, path);
                break;
            case ".editorconfig" or ".globalconfig":
                if (!workspace.Solution.Projects.SelectMany(project => project.AnalyzerConfigDocuments).Any(document => PathComparer.Instance.Equals(document.FilePath, path))
                    && File.Exists(path)
                    && workspace.Solution.Projects.Any(project => project.FilePath is { } projectPath && AppliesTo(path, projectPath)))
                {
                    Reset(workspace);
                }
                else
                {
                    workspace.ChangedFiles.Add(path);
                    workspace.Solution = ApplyAnalyzerConfigChange(workspace.Solution, path);
                }

                break;
        }
    }

    /// <summary>
    /// Whether a new analyzer config file applies to the project of <paramref name="projectPath"/>: it lies in the project's
    /// folder or above, or it is an <c>.editorconfig</c> in a folder inside the project's (the SDK passes the
    /// <c>.editorconfig</c> of every folder above each compiled file) other than <c>bin</c> or <c>obj</c>.
    /// </summary>
    private static bool AppliesTo(string configPath, string projectPath)
    {
        var configFolder = Path.GetDirectoryName(configPath)!;
        var projectFolder = Path.GetDirectoryName(projectPath)!;
        if (PathComparer.IsUnder(projectFolder, configFolder))
        {
            return true;
        }

        if (!Path.GetFileName(configPath).Equals(".editorconfig", StringComparison.OrdinalIgnoreCase) || !PathComparer.IsUnder(configFolder, projectFolder))
        {
            return false;
        }

        var firstFolder = Path.GetRelativePath(projectFolder, configFolder).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];

        return !firstFolder.Equals("bin", StringComparison.OrdinalIgnoreCase) && !firstFolder.Equals("obj", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Whether a <c>.props</c> or <c>.targets</c> file can be imported by a project of the workspace: it lies under the
    /// workspace folder or in a folder above one of its projects (<c>Directory.Build.props</c>), and is not a build output.
    /// </summary>
    private static bool MayBeImportedBy(LoadedWorkspace workspace, string path)
    {
        var underRoot = PathComparer.IsUnder(path, workspace.Root);
        var folders = (underRoot ? Path.GetRelativePath(workspace.Root, path) : path).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).SkipLast(1);
        if (folders.Any(folder => folder.Equals("bin", StringComparison.OrdinalIgnoreCase) || folder.Equals("obj", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        return underRoot || workspace.Solution.Projects.Any(project => project.FilePath is { } projectPath && PathComparer.IsUnder(projectPath, Path.GetDirectoryName(path)!));
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var workspace in _workspaces)
            {
                workspace.Workspace.Dispose();
            }

            _workspaces.Clear();
        }

        _fallbackWorkspace.Dispose();
    }

    private static Solution Overlay(Solution solution, string path, string text)
    {
        var sourceText = TextConventions.ToSourceText(text);
        foreach (var id in solution.GetDocumentIdsWithFilePath(path))
        {
            solution = solution.WithDocumentText(id, sourceText, PreservationMode.PreserveIdentity);
        }

        return solution;
    }

    private static Solution ApplySourceChange(Solution solution, string path)
    {
        var ids = solution.GetDocumentIdsWithFilePath(path);
        if (!File.Exists(path))
        {
            return solution.RemoveDocuments(ids);
        }

        if (!ids.IsEmpty)
        {
            foreach (var id in ids)
            {
                solution = solution.WithDocumentTextLoader(id, new FileTextLoader(path, defaultEncoding: null), PreservationMode.PreserveValue);
            }

            return solution;
        }

        var owners = solution.Projects
            .Where(project => project.Language == LanguageNames.CSharp && project.FilePath is { } projectPath && PathComparer.IsUnder(path, Path.GetDirectoryName(projectPath)!))
            .GroupBy(project => Path.GetDirectoryName(project.FilePath)!.Length)
            .OrderByDescending(group => group.Key)
            .FirstOrDefault();
        foreach (var project in owners ?? Enumerable.Empty<Project>())
        {
            var folders = Path.GetRelativePath(Path.GetDirectoryName(project.FilePath)!, Path.GetDirectoryName(path)!)
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
                .Where(folder => folder != ".")
                .ToArray();
            if (folders.Length > 0 && (folders[0].Equals("bin", StringComparison.OrdinalIgnoreCase) || folders[0].Equals("obj", StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            solution = solution.AddDocument(DocumentInfo.Create(
                DocumentId.CreateNewId(project.Id, path),
                Path.GetFileName(path),
                folders,
                loader: new FileTextLoader(path, defaultEncoding: null),
                filePath: path));
        }

        return solution;
    }

    private static Solution ApplyAnalyzerConfigChange(Solution solution, string path)
    {
        var ids = solution.Projects
            .SelectMany(project => project.AnalyzerConfigDocuments)
            .Where(document => PathComparer.Instance.Equals(document.FilePath, path))
            .Select(document => document.Id)
            .ToList();
        if (!File.Exists(path))
        {
            return solution.RemoveAnalyzerConfigDocuments([.. ids]);
        }

        foreach (var id in ids)
        {
            solution = solution.WithAnalyzerConfigDocumentTextLoader(id, new FileTextLoader(path, defaultEncoding: null), PreservationMode.PreserveValue);
        }

        return solution;
    }

    /// <summary>The document of <paramref name="filePath"/> when a project of its solution (or nearest project) compiles it.</summary>
    private async Task<(Solution Solution, DocumentId Id)?> FindInProjectsAsync(string filePath, List<string> failures, CancellationToken cancellationToken)
    {
        string? folder;
        lock (_gate)
        {
            folder = _folders.Where(candidate => PathComparer.IsUnder(filePath, candidate)).MaxBy(candidate => candidate.Length);
        }

        var target = folder is null ? LoadTarget.Find(filePath) : null;
        var root = folder ?? (target is null ? null : Path.GetDirectoryName(target.Path));
        if (root is null)
        {
            return null;
        }

        LoadedWorkspace? workspace;
        lock (_gate)
        {
            workspace = _workspaces.FirstOrDefault(candidate => PathComparer.Instance.Equals(candidate.Root, root));
            if (workspace is null)
            {
                workspace = new LoadedWorkspace(root, CreateWorkspace());
                _workspaces.Add(workspace);
            }

            if (Resolve(workspace.Solution, filePath) is { } loaded)
            {
                failures.AddRange(workspace.TakeFailures());

                return loaded;
            }

            if (workspace.LooseFiles.Contains(filePath))
            {
                failures.AddRange(workspace.TakeFailures());

                return null;
            }
        }

        target ??= LoadTarget.Find(filePath);
        if (target is null)
        {
            return null;
        }

        if (!target.IsSolution)
        {
            target = target.WithDependentsUnder(workspace.Root);
        }

        await LoadAsync(workspace, target).WaitAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            failures.AddRange(workspace.TakeFailures());
            if (!workspace.Stale)
            {
                var resolved = Resolve(workspace.Solution, filePath);
                if (resolved is null)
                {
                    workspace.LooseFiles.Add(filePath);
                }

                return resolved;
            }
        }

        return await FindInProjectsAsync(filePath, failures, cancellationToken).ConfigureAwait(false);
    }

    private Task LoadAsync(LoadedWorkspace workspace, LoadTarget target)
    {
        lock (_gate)
        {
            if (!workspace.Loads.TryGetValue(target.Path, out var load))
            {
                load = Task.Run(() => LoadCoreAsync(workspace, target));
                workspace.Loads[target.Path] = load;
            }

            return load;
        }
    }

    private async Task LoadCoreAsync(LoadedWorkspace workspace, LoadTarget target)
    {
        await workspace.LoadLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (workspace.Stale)
            {
                return;
            }

            var stopwatch = Stopwatch.StartNew();
            try
            {
                if (target.IsSolution && workspace.Workspace.CurrentSolution.ProjectIds.Count == 0)
                {
                    workspace.SkipProjects(LoadTarget.ListedNonCSharpProjects(target.Path));
                    await workspace.Workspace.OpenSolutionAsync(target.Path).ConfigureAwait(false);
                }
                else
                {
                    foreach (var project in target.Projects)
                    {
                        if (!workspace.Workspace.CurrentSolution.Projects.Any(loaded => PathComparer.Instance.Equals(loaded.FilePath, project)))
                        {
                            await workspace.Workspace.OpenProjectAsync(project).ConfigureAwait(false);
                        }
                    }
                }

                _log($"Loaded {target.Path} in {stopwatch.ElapsedMilliseconds} ms.");
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                _log($"Loading {target.Path} failed: {exception}");
                workspace.AddFailure($"Could not load {target.Path}: {exception.Message}");
            }

            lock (_gate)
            {
                var solution = workspace.Workspace.CurrentSolution;
                foreach (var path in workspace.ChangedFiles)
                {
                    solution = Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase)
                        ? ApplySourceChange(solution, path)
                        : ApplyAnalyzerConfigChange(solution, path);
                }

                workspace.Solution = solution;
            }
        }
        finally
        {
            workspace.LoadLock.Release();
        }
    }

    private MSBuildWorkspace CreateWorkspace()
    {
        var workspace = MSBuildWorkspace.Create(HostAnalyzers.HostServices);
        workspace.LoadMetadataForReferencedProjects = false;
        workspace.SkipUnrecognizedProjects = true;

        return workspace;
    }

    /// <summary>Forgets a workspace: the next request loads its files again.</summary>
    private void Reset(LoadedWorkspace workspace)
    {
        _log($"Reloading the workspace of {workspace.Root}.");
        _workspaces.Remove(workspace);
        workspace.Stale = true;
        _ = DisposeWhenIdleAsync(workspace);
    }

    private async Task DisposeWhenIdleAsync(LoadedWorkspace workspace)
    {
        try
        {
            await workspace.LoadLock.WaitAsync().ConfigureAwait(false);
            try
            {
                workspace.Workspace.Dispose();
            }
            finally
            {
                workspace.LoadLock.Release();
            }
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            _log($"Disposing the workspace of {workspace.Root} failed: {exception}");
        }
    }

    /// <summary>
    /// The document of <paramref name="filePath"/>: of the project whose folder contains the file (the deepest one), else of
    /// the first project by path and name (target frameworks of one project).
    /// </summary>
    private static (Solution Solution, DocumentId Id)? Resolve(Solution solution, string filePath)
    {
        var ids = solution.GetDocumentIdsWithFilePath(filePath);
        if (ids.IsEmpty)
        {
            return null;
        }

        var chosen = ids
            .Select(id => solution.GetDocument(id)!)
            .OrderByDescending(document => document.Project.FilePath is { } projectPath && PathComparer.IsUnder(filePath, Path.GetDirectoryName(projectPath)!)
                ? Path.GetDirectoryName(projectPath)!.Length
                : -1)
            .ThenBy(document => document.Project.FilePath, StringComparer.Ordinal)
            .ThenBy(document => document.Project.Name, StringComparer.Ordinal)
            .First();

        return (solution, chosen.Id);
    }

    private void ReportOnce(string key, string message, List<string> issues)
    {
        lock (_gate)
        {
            if (_reported.Add(key))
            {
                _log(message);
                issues.Add(message);
            }
        }
    }

    private sealed class LoadedWorkspace
    {
        private readonly List<string> _failures = [];
        private readonly HashSet<string> _skippedProjects = new(PathComparer.Instance);

        public LoadedWorkspace(string root, MSBuildWorkspace workspace)
        {
            Root = root;
            Workspace = workspace;
            Solution = workspace.CurrentSolution;
            workspace.RegisterWorkspaceFailedHandler(args =>
            {
                if (args.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure && !NamesSkippedProject(args.Diagnostic.Message))
                {
                    AddFailure(args.Diagnostic.Message);
                }
            });
        }

        public string Root { get; }

        public MSBuildWorkspace Workspace { get; }

        /// <summary>The workspace's solution with the file changes since it loaded; guarded by the host's lock.</summary>
        public Solution Solution { get; set; }

        public Dictionary<string, Task> Loads { get; } = new(PathComparer.Instance);

        public SemaphoreSlim LoadLock { get; } = new(1, 1);

        public HashSet<string> ChangedFiles { get; } = new(PathComparer.Instance);

        /// <summary>The files no project of the loaded solution compiles once their load finished; guarded by the host's lock.</summary>
        public HashSet<string> LooseFiles { get; } = new(PathComparer.Instance);

        public bool Stale { get; set; }

        public void AddFailure(string failure)
        {
            lock (_failures)
            {
                _failures.Add(failure);
            }
        }

        /// <summary>
        /// Projects of the solution the server does not clean (not C#): what the workspace reports about them, such as
        /// skipping a project of a language it has no services for, is not a failure of the loading.
        /// </summary>
        public void SkipProjects(IEnumerable<string> projects)
        {
            lock (_failures)
            {
                _skippedProjects.UnionWith(projects);
            }
        }

        public List<string> TakeFailures()
        {
            lock (_failures)
            {
                var taken = _failures.ToList();
                _failures.Clear();

                return taken;
            }
        }

        private bool NamesSkippedProject(string message)
        {
            lock (_failures)
            {
                return _skippedProjects.Any(project => message.Contains(project, PathComparer.Comparison));
            }
        }
    }

    /// <summary>What to load for a file: the solution listing its nearest project, else that project.</summary>
    private sealed partial record LoadTarget(string Path, bool IsSolution, IReadOnlyList<string> Projects)
    {
        public static LoadTarget? Find(string filePath)
        {
            string[]? projects = null;
            for (var directory = System.IO.Path.GetDirectoryName(filePath); directory is not null; directory = System.IO.Path.GetDirectoryName(directory))
            {
                projects ??= FilesIn(directory, "*.csproj") is { Length: > 0 } found ? found : null;
                if (projects is null)
                {
                    continue;
                }

                foreach (var solution in FilesIn(directory, "*.sln").Concat(FilesIn(directory, "*.slnx")).Order(StringComparer.Ordinal))
                {
                    if (Lists(solution, projects))
                    {
                        return new LoadTarget(solution, true, projects);
                    }
                }
            }

            return projects is null ? null : new LoadTarget(projects[0], false, projects);
        }

        /// <summary>
        /// The target plus every project under <paramref name="root"/> that references one of its projects, directly or
        /// through other projects: without a solution these are the projects a rename of a public symbol must also change.
        /// </summary>
        public LoadTarget WithDependentsUnder(string root)
        {
            var references = ProjectFilesUnder(root).ToDictionary(project => project, ReferencedProjects, PathComparer.Instance);
            var wanted = new HashSet<string>(Projects, PathComparer.Instance);
            bool added;
            do
            {
                added = false;
                foreach (var (project, referenced) in references)
                {
                    if (!wanted.Contains(project) && referenced.Any(wanted.Contains))
                    {
                        added = wanted.Add(project) || added;
                    }
                }
            }
            while (added);

            return this with { Projects = [.. Projects, .. wanted.Except(Projects, PathComparer.Instance).Order(StringComparer.Ordinal)] };
        }

        private static IEnumerable<string> ProjectFilesUnder(string root)
        {
            var pending = new Stack<string>([root]);
            while (pending.Count > 0)
            {
                var directory = pending.Pop();
                foreach (var project in FilesIn(directory, "*.csproj"))
                {
                    yield return project;
                }

                IEnumerable<string> children;
                try
                {
                    children = Directory.EnumerateDirectories(directory).ToList();
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    continue;
                }

                foreach (var child in children)
                {
                    var name = System.IO.Path.GetFileName(child);
                    if (!name.StartsWith('.') && name is not ("bin" or "obj" or "node_modules") && new DirectoryInfo(child).LinkTarget is null)
                    {
                        pending.Push(child);
                    }
                }
            }
        }

        private static IReadOnlyList<string> ReferencedProjects(string project)
        {
            string text;
            try
            {
                text = File.ReadAllText(project);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return [];
            }

            var directory = System.IO.Path.GetDirectoryName(project)!;

            return [.. ProjectReference().Matches(text)
                .Select(match => System.IO.Path.GetFullPath(System.IO.Path.Combine(directory, match.Groups[1].Value.Replace('\\', System.IO.Path.DirectorySeparatorChar))))];
        }

        private static string[] FilesIn(string directory, string pattern)
        {
            try
            {
                return [.. Directory.EnumerateFiles(directory, pattern, SearchOption.TopDirectoryOnly)
                    .Where(path => path.EndsWith(pattern[1..], StringComparison.OrdinalIgnoreCase))
                    .Order(StringComparer.Ordinal)];
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return [];
            }
        }

        /// <summary>True when the <c>.sln</c> or <c>.slnx</c> file lists one of <paramref name="projects"/>.</summary>
        private static bool Lists(string solution, IReadOnlyList<string> projects) =>
            ListedProjects(solution).Any(listed => projects.Contains(listed, PathComparer.Instance));

        /// <summary>The projects the <c>.sln</c> or <c>.slnx</c> file lists that are not C# projects (<c>.vbproj</c>, <c>.dcproj</c>, <c>.sqlproj</c>…).</summary>
        public static IReadOnlyList<string> ListedNonCSharpProjects(string solution) =>
            [.. ListedProjects(solution).Where(project => !project.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))];

        /// <summary>The full paths of the project files the <c>.sln</c> or <c>.slnx</c> file lists; none when it cannot be read.</summary>
        private static IEnumerable<string> ListedProjects(string solution)
        {
            string text;
            try
            {
                text = File.ReadAllText(solution);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return [];
            }

            var directory = System.IO.Path.GetDirectoryName(solution)!;

            return ProjectPath().Matches(text)
                .Select(match => System.IO.Path.GetFullPath(System.IO.Path.Combine(directory, match.Groups[1].Value.Replace('\\', System.IO.Path.DirectorySeparatorChar).Replace('/', System.IO.Path.DirectorySeparatorChar))));
        }

        [GeneratedRegex("\"([^\"]+\\.[A-Za-z0-9]*proj)\"", RegexOptions.IgnoreCase)]
        private static partial Regex ProjectPath();

        [GeneratedRegex("<ProjectReference\\s+Include\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase)]
        private static partial Regex ProjectReference();
    }
}
