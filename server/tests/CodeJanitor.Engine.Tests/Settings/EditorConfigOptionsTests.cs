#nullable disable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using CodeJanitor.Engine.Settings;
using Xunit;

namespace CodeJanitor.Engine.Tests.Settings;

/// <summary>
/// Behavioral tests for <see cref="EditorConfigOptions" />: the options that apply to a file on disk, resolved the way
/// Roslyn resolves them (nearest file wins, <c>root = true</c>, section globs), and the file that defines an option.
/// </summary>
[Collection("EditorConfigCache")]
public sealed class EditorConfigOptionsTests : IDisposable
{
    private string _tempDirectory;

    public EditorConfigOptionsTests()
    {
        _tempDirectory = Path.Combine(Path.GetTempPath(), "CodeJanitor.UnitTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDirectory);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, true);
        }
    }

    [Fact]
    public void LoadOptions_NearestFileWins_AndInheritsTheParentKeys()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_style = space", "indent_size = 4");
        string nested = CreateDirectory("src", "App");
        WriteConfig(Path.Combine(_tempDirectory, "src"), "[*.cs]", "indent_size = 2");

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(nested, "Program.cs"));

        Assert.Equal("2", options["indent_size"]);
        Assert.Equal("space", options["indent_style"]);
    }

    [Fact]
    public void LoadOptions_RootFile_HidesTheFilesAboveIt()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_style = tab", "tab_width = 8");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "root = true", "[*.cs]", "indent_size = 2");

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(nested, "Sample.cs"));

        Assert.Equivalent(new Dictionary<string, string> { ["indent_size"] = "2" }, options.ToDictionary(entry => entry.Key, entry => entry.Value));
    }

    [Theory]
    [InlineData("[*.{cs,csx}]", "Sample.cs", true)]
    [InlineData("[*.{cs,csx}]", "Script.csx", true)]
    [InlineData("[*.{cs,csx}]", "Module.vb", false)]
    [InlineData("[{Program,Startup}.cs]", "Program.cs", true)]
    [InlineData("[{Program,Startup}.cs]", "Sample.cs", false)]
    [InlineData("[*]", "Sample.cs", true)]
    [InlineData("[*.cs]", "Sample.CS", false)]
    [InlineData("[*.vb]", "Sample.cs", false)]
    [InlineData("[Sample.cs]", "Sample.cs", true)]
    [InlineData("[src/**.cs]", "Sample.cs", false)]
    public void LoadOptions_AppliesOnlyTheSectionsWhoseGlobMatchesTheFile(string section, string fileName, bool applies)
    {
        WriteConfig(_tempDirectory, "root = true", section, "indent_style = tab");

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(_tempDirectory, fileName));

        Assert.Equal(applies, options.ContainsKey("indent_style"));
    }

    [Fact]
    public void LoadOptions_LaterSectionOfTheSameFile_WinsOverAnEarlierOne()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2", "[*]", "indent_size = 8", "[Program.cs]", "indent_size = 3");

        Assert.Equal("3", EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Program.cs"))["indent_size"]);
        Assert.Equal("8", EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Sample.cs"))["indent_size"]);
    }

    [Fact]
    public void LoadOptions_LowerCasesKeys_AndKeepsTheSeveritySuffixOfValues()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "CSharp_Prefer_Braces = when_multiline:warning", "file_header_template = Copyright {fileName}");

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Sample.cs"));

        Assert.Equal("when_multiline:warning", options["csharp_prefer_braces"]);
        Assert.Equal("Copyright {fileName}", options["file_header_template"]);
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void LoadOptions_IgnoresCommentsAndWhitespace_WithAnyLineEnding(string newLine)
    {
        File.WriteAllText(Path.Combine(_tempDirectory, ".editorconfig"), string.Join(newLine,
            "# top comment",
            "root = true",
            "; another comment",
            string.Empty,
            "[*.cs]",
            "\tindent_style\t=\ttab\t",
            "  # indent_size = 8",
            "  tab_width   =   6  ",
            string.Empty), new UTF8Encoding(true));

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Sample.cs"));

        Assert.Equivalent(new Dictionary<string, string> { ["indent_style"] = "tab", ["tab_width"] = "6" }, options.ToDictionary(entry => entry.Key, entry => entry.Value));
    }

    [Theory]
    [InlineData("none", "none")]
    [InlineData("silent", "silent")]
    [InlineData("refactoring", "silent")]
    [InlineData("suggestion", "suggestion")]
    [InlineData("warning", "warning")]
    [InlineData("error", "error")]
    [InlineData("WARNING", "warning")]
    public void LoadOptions_ReportsDiagnosticSeverities_UnderTheLowerCasedIdKey(string configured, string expected)
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "dotnet_diagnostic.IDE0011.severity = " + configured);

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Sample.cs"));

        Assert.Equal(expected, options[EditorConfigOptions.DiagnosticSeverityKey("IDE0011")]);
        Assert.Equal("dotnet_diagnostic.ide0011.severity", EditorConfigOptions.DiagnosticSeverityKey("IDE0011"));
    }

    [Theory]
    [InlineData("default")]
    [InlineData("loud")]
    public void LoadOptions_DefaultOrInvalidDiagnosticSeverity_IsNotReported(string configured)
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "dotnet_diagnostic.IDE0011.severity = " + configured, "indent_size = 2");

        IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(Path.Combine(_tempDirectory, "Sample.cs"));

        Assert.False(options.ContainsKey(EditorConfigOptions.DiagnosticSeverityKey("IDE0011")));
        Assert.Equal("2", options["indent_size"]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("Sample\0.cs")]
    public void BlankOrInvalidPath_YieldsNoOptions_AndNoDefiningFile(string filePath)
    {
        Assert.Empty(EditorConfigOptions.Load(filePath));
        Assert.Null(EditorConfigOptions.FindDefiningConfigPath(filePath, "indent_size"));
    }

    [Fact]
    public void LoadOptions_DeletedEditorConfig_NoLongerApplies()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "[*.cs]", "indent_size = 3");
        string filePath = Path.Combine(nested, "Sample.cs");
        Assert.Equal("3", EditorConfigOptions.Load(filePath)["indent_size"]);

        File.Delete(Path.Combine(nested, ".editorconfig"));

        Assert.Equal("2", EditorConfigOptions.Load(filePath)["indent_size"]);
    }

    [Fact]
    public void LoadOptions_EditedEditorConfigOfTheSameLength_IsReadAgain()
    {
        string configPath = Path.Combine(_tempDirectory, ".editorconfig");
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string filePath = Path.Combine(_tempDirectory, "Sample.cs");
        Assert.Equal("2", EditorConfigOptions.Load(filePath)["indent_size"]);

        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 3");
        File.SetLastWriteTimeUtc(configPath, File.GetLastWriteTimeUtc(configPath).AddSeconds(5));

        Assert.Equal("3", EditorConfigOptions.Load(filePath)["indent_size"]);
    }

    [Fact]
    public void LoadOptions_EditorConfigLockedByAnotherWriter_IsSkipped_AndTheOthersStillApply()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2", "indent_style = space");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "[*.cs]", "indent_size = 3");
        string filePath = Path.Combine(nested, "Sample.cs");

        using (new FileStream(Path.Combine(nested, ".editorconfig"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            IReadOnlyDictionary<string, string> options = EditorConfigOptions.Load(filePath);

            Assert.Equal("2", options["indent_size"]);
            Assert.Equal("space", options["indent_style"]);
        }
    }

    [Fact]
    public void FindDefiningConfigPath_ReturnsTheNearestFileDefiningTheOption()
    {
        string parentConfig = WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2", "indent_style = space");
        string nested = CreateDirectory("src", "App");
        string childConfig = WriteConfig(Path.Combine(_tempDirectory, "src"), "[*.cs]", "indent_size = 3");
        string filePath = Path.Combine(nested, "Program.cs");

        Assert.Equal(childConfig, EditorConfigOptions.FindDefiningConfigPath(filePath, "indent_size"));
        Assert.Equal(parentConfig, EditorConfigOptions.FindDefiningConfigPath(filePath, "indent_style"));
        Assert.Null(EditorConfigOptions.FindDefiningConfigPath(filePath, "tab_width"));
    }

    [Fact]
    public void FindDefiningConfigPath_IgnoresSectionsThatDoNotMatchTheFile()
    {
        string parentConfig = WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "[*.vb]", "indent_size = 3", "[{Program,Startup}.cs]", "indent_size = 5");

        Assert.Equal(parentConfig, EditorConfigOptions.FindDefiningConfigPath(Path.Combine(nested, "Sample.cs"), "indent_size"));
        Assert.Equal(Path.Combine(nested, ".editorconfig"), EditorConfigOptions.FindDefiningConfigPath(Path.Combine(nested, "Program.cs"), "indent_size"));
    }

    [Fact]
    public void FindDefiningConfigPath_OptionOnlyAboveARootFile_IsNotApplied()
    {
        WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "root = true", "[*.cs]", "indent_style = tab");

        Assert.Null(EditorConfigOptions.FindDefiningConfigPath(Path.Combine(nested, "Sample.cs"), "indent_size"));
    }

    [Fact]
    public void FindDefiningConfigPath_FindsTheFileConfiguringADiagnosticSeverity()
    {
        string parentConfig = WriteConfig(_tempDirectory, "root = true", "[*.cs]", "dotnet_diagnostic.IDE0011.severity = warning");
        string nested = CreateDirectory("src");
        WriteConfig(nested, "[*.cs]", "dotnet_diagnostic.IDE0040.severity = none");

        Assert.Equal(parentConfig, EditorConfigOptions.FindDefiningConfigPath(Path.Combine(nested, "Sample.cs"), EditorConfigOptions.DiagnosticSeverityKey("IDE0011")));
    }

    [Fact]
    public void Forget_DropsTheCachedParseOfAConfig_AndTheNextLoadReadsItAgain()
    {
        string config = WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string file = Path.Combine(_tempDirectory, "Sample.cs");
        EditorConfigOptions.Load(file);
        Assert.True(EditorConfigOptions.IsCached(config));

        EditorConfigOptions.Forget(config);

        Assert.False(EditorConfigOptions.IsCached(config));
        Assert.Equal("2", EditorConfigOptions.Load(file)["indent_size"]);
        Assert.True(EditorConfigOptions.IsCached(config));
    }

    [Fact]
    public void Load_ADeletedConfig_IsNoLongerCached()
    {
        string config = WriteConfig(_tempDirectory, "root = true", "[*.cs]", "indent_size = 2");
        string file = Path.Combine(_tempDirectory, "Sample.cs");
        EditorConfigOptions.Load(file);
        File.Delete(config);

        Assert.Empty(EditorConfigOptions.Load(file));
        Assert.False(EditorConfigOptions.IsCached(config));
    }

    [Fact]
    public void Load_KeepsTheNumberOfCachedConfigsBounded()
    {
        var configs = new List<string>();
        for (int i = 0; i < EditorConfigOptions.MaxCachedConfigs + 20; i++)
        {
            string directory = CreateDirectory("bounded", i.ToString());
            configs.Add(WriteConfig(directory, "root = true", "[*.cs]", "indent_size = 2"));
            EditorConfigOptions.Load(Path.Combine(directory, "Sample.cs"));
        }

        Assert.True(EditorConfigOptions.CachedConfigCount <= EditorConfigOptions.MaxCachedConfigs);
        Assert.Equal("2", EditorConfigOptions.Load(Path.Combine(_tempDirectory, "bounded", "0", "Sample.cs"))["indent_size"]);
        Assert.True(EditorConfigOptions.IsCached(configs[0]));
    }

    /// <summary>
    /// Writes an .editorconfig with the specified lines (CRLF) into the specified directory.
    /// </summary>
    /// <returns>The full path of the written file.</returns>
    private static string WriteConfig(string directory, params string[] lines)
    {
        string path = Path.Combine(directory, ".editorconfig");
        File.WriteAllText(path, string.Join("\r\n", lines) + "\r\n");

        return path;
    }

    private string CreateDirectory(params string[] segments) => Directory.CreateDirectory(Path.Combine(new[] { _tempDirectory }.Concat(segments).ToArray())).FullName;
}
