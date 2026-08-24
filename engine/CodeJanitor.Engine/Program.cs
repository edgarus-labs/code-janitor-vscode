using CodeJanitor.Helpers;
using CodeJanitor.Logic.Cleaning;
using CodeJanitor.Logic.Transformations;
using CodeJanitor.Properties;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CodeJanitor;

/// <summary>
/// CLI entry point for the CodeJanitor headless C# cleanup engine. Reads a single JSON request
/// from stdin (or a file passed as the first argument), runs the same Roslyn-based pipeline the
/// Visual Studio extension runs headlessly (CodeCleanupManager.ApplyHeadlessCSharpTransformations),
/// and writes a JSON response to stdout. The VS Code extension (TypeScript) shells this process
/// out per cleanup request; nothing here talks to Visual Studio / EnvDTE.
/// </summary>
internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static int Main(string[] args)
    {
        try
        {
            var requestJson = args.Length > 0 && File.Exists(args[0])
                ? File.ReadAllText(args[0], Encoding.UTF8)
                : Console.In.ReadToEnd();

            var request = JsonSerializer.Deserialize<EngineRequest>(requestJson, JsonOptions);
            if (request is null)
            {
                Console.Error.WriteLine("Empty or invalid request.");

                return 1;
            }

            ApplySettingsOverrides(request.Settings);

            var response = new EngineResponse { Results = new List<EngineFileResult>() };
            foreach (var file in request.Files ?? new List<EngineFile>())
            {
                response.Results.Add(RunOne(file));
            }

            Console.Out.Write(JsonSerializer.Serialize(response, JsonOptions));
            Console.Out.Flush();

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());

            return 1;
        }
    }

    private static EngineFileResult RunOne(EngineFile file)
    {
        try
        {
            var output = ApplyHeadlessCSharpTransformations(file.Content ?? string.Empty, file.Path ?? string.Empty);

            return new EngineFileResult
            {
                Path = file.Path,
                Output = output,
                Changed = !string.Equals(output, file.Content, StringComparison.Ordinal),
            };
        }
        catch (Exception ex)
        {
            return new EngineFileResult { Path = file.Path, Output = file.Content, Changed = false, Error = ex.Message };
        }
    }

    /// <summary>
    /// Mirrors CodeJanitorShared/Logic/Cleaning/CodeCleanupManager.ApplyHeadlessCSharpTransformations
    /// (Visual Studio extension) - same converters, same conditional gating, same order.
    /// </summary>
    private static string ApplyHeadlessCSharpTransformations(string source, string filePath)
    {
        var editorConfig = EditorConfigHelper.LoadCSharpOptions(filePath);
        var settings = Settings.Default;
        var transformations = new List<ISourceTransformation>
        {
            // Region directives are policy-only structure and are always removed.
            new RegionDirectiveRemover(),
        };

        if (settings.Cleaning_RemoveByteOrderMark)
        {
            transformations.Add(new ByteOrderMarkConverter());
        }

        if (settings.Cleaning_MoveUsingsOutsideNamespace)
        {
            transformations.Add(new MoveUsingsOutsideNamespaceConverter());
        }

        if (settings.Cleaning_ConvertToFileScopedNamespace)
        {
            var fileScopedConverter = new FileScopedNamespaceConverter();
            if (!fileScopedConverter.HasMultipleNamespaces(source))
            {
                transformations.Add(fileScopedConverter);
            }
        }

        if (settings.Cleaning_ConvertToVarWhenApparent)
        {
            transformations.Add(new VarWhenApparentConverter());
        }

        if (settings.Cleaning_MakeFieldsReadonlyWhenSafe)
        {
            transformations.Add(new ReadonlyFieldConverter());
        }

        if (settings.Cleaning_SealClassesWhenSafe)
        {
            transformations.Add(new SealedClassConverter());
        }

        if (settings.Cleaning_InsertBlankLineBeforeReturnAndThrowStatements)
        {
            transformations.Add(new ReturnThrowBlankLinePaddingConverter());
        }

        if (settings.Cleaning_ConvertToCollectionExpressions)
        {
            transformations.Add(new CollectionExpressionConverter());
        }

        if (settings.Cleaning_ReuseJsonSerializerOptionsForCA1869)
        {
            transformations.Add(new JsonSerializerOptionsReuseConverter());
        }

        if (settings.Cleaning_SimplifySingleStatementLambdas)
        {
            transformations.Add(new SingleStatementLambdaConverter());
        }

        if (settings.Cleaning_ConvertToPatternMatchingNullChecks)
        {
            transformations.Add(new NullCheckPatternMatchingConverter());
        }

        if (settings.Cleaning_ConvertStringFormatToInterpolation)
        {
            transformations.Add(new StringInterpolationConverter());
        }

        if (settings.Cleaning_ConvertToStringNameOf)
        {
            transformations.Add(new NameOfOperatorConverter());
        }

        if (settings.Cleaning_InlineOutVariableDeclarations)
        {
            transformations.Add(new OutVarInliningConverter());
        }

        if (settings.Cleaning_InsertExplicitAccessModifiersOnClasses ||
            settings.Cleaning_InsertExplicitAccessModifiersOnDelegates ||
            settings.Cleaning_InsertExplicitAccessModifiersOnEnumerations ||
            settings.Cleaning_InsertExplicitAccessModifiersOnEvents ||
            settings.Cleaning_InsertExplicitAccessModifiersOnFields ||
            settings.Cleaning_InsertExplicitAccessModifiersOnInterfaces ||
            settings.Cleaning_InsertExplicitAccessModifiersOnMethods ||
            settings.Cleaning_InsertExplicitAccessModifiersOnProperties ||
            settings.Cleaning_InsertExplicitAccessModifiersOnStructs)
        {
            transformations.Add(new ExplicitAccessModifierConverter());
        }

        if (AnyBlankLinePaddingSettingEnabled(settings))
        {
            transformations.Add(new BlankLinePaddingConverter());
        }

        if (settings.Cleaning_UpdateEndRegionDirectives)
        {
            transformations.Add(new UpdateEndRegionDirectivesConverter());
        }

        if (settings.Cleaning_UpdateSingleLineMethods)
        {
            transformations.Add(new UpdateSingleLineMethodsConverter());
        }

        if (settings.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine)
        {
            transformations.Add(new UpdateAccessorsToBothBeSingleLineOrMultiLineConverter());
        }

        if (settings.Formatting_CommentRunDuringCleanup)
        {
            transformations.Add(new CommentFormatConverter());
        }

        if (!string.IsNullOrWhiteSpace(settings.Cleaning_UpdateFileHeaderCSharp))
        {
            transformations.Add(new DelegateSourceTransformation(
                "Update C# file header", FileHeaderAndBlankLineTransforms.ApplyConfiguredCSharpFileHeader));
        }

        if (string.Equals(editorConfig.IndentStyle, "space", StringComparison.OrdinalIgnoreCase))
        {
            var tabSize = editorConfig.TabWidth ?? editorConfig.IndentSize ?? 4;
            transformations.Add(new TabToSpaceConverter(tabSize));
        }

        var wantOrganizeUsings = settings.Cleaning_OrganizeUsings ||
            (editorConfig.SortSystemDirectivesFirst == true && editorConfig.SeparateImportDirectiveGroups != true);

        if (wantOrganizeUsings)
        {
            transformations.Add(new UsingDirectiveOrganizer());
        }

        if (settings.Cleaning_RemoveEndOfLineWhitespace || editorConfig.TrimTrailingWhitespace == true)
        {
            transformations.Add(new RemoveTrailingWhitespaceConverter());
        }

        if (settings.Cleaning_RemoveBlankLinesAtTop)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines at top", FileHeaderAndBlankLineTransforms.RemoveBlankLinesAtTop));
        }

        if (settings.Cleaning_RemoveBlankLinesAtBottom)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines at bottom", FileHeaderAndBlankLineTransforms.RemoveBlankLinesAtBottom));
        }

        if (settings.Cleaning_RemoveBlankLinesAfterAttributes)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines after attributes", FileHeaderAndBlankLineTransforms.RemoveBlankLinesAfterAttributes));
        }

        if (settings.Cleaning_RemoveBlankLinesAfterOpeningBrace)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines after opening brace", FileHeaderAndBlankLineTransforms.RemoveBlankLinesAfterOpeningBrace));
        }

        if (settings.Cleaning_RemoveBlankLinesBeforeClosingBrace)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines before closing brace", FileHeaderAndBlankLineTransforms.RemoveBlankLinesBeforeClosingBrace));
        }

        if (settings.Cleaning_RemoveBlankLinesBetweenChainedStatements)
        {
            transformations.Add(new DelegateSourceTransformation("Remove blank lines between chained statements", FileHeaderAndBlankLineTransforms.RemoveBlankLinesBetweenChainedStatements));
        }

        if (settings.Cleaning_RemoveMultipleConsecutiveBlankLines)
        {
            transformations.Add(new NormalizeBlankLinesConverter());
        }

        if (editorConfig.InsertFinalNewline != false)
        {
            transformations.Add(new EnsureFinalNewlineConverter());
        }

        var pipeline = new SourceTransformationPipeline(transformations);

        return pipeline.Run(source);
    }

    private static bool AnyBlankLinePaddingSettingEnabled(Settings settings)
    {
        return settings.Cleaning_InsertBlankLinePaddingBeforeClasses ||
               settings.Cleaning_InsertBlankLinePaddingAfterClasses ||
               settings.Cleaning_InsertBlankLinePaddingBeforeDelegates ||
               settings.Cleaning_InsertBlankLinePaddingAfterDelegates ||
               settings.Cleaning_InsertBlankLinePaddingBeforeEnumerations ||
               settings.Cleaning_InsertBlankLinePaddingAfterEnumerations ||
               settings.Cleaning_InsertBlankLinePaddingBeforeEvents ||
               settings.Cleaning_InsertBlankLinePaddingAfterEvents ||
               settings.Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine ||
               settings.Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine ||
               settings.Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine ||
               settings.Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine ||
               settings.Cleaning_InsertBlankLinePaddingBeforeInterfaces ||
               settings.Cleaning_InsertBlankLinePaddingAfterInterfaces ||
               settings.Cleaning_InsertBlankLinePaddingBeforeMethods ||
               settings.Cleaning_InsertBlankLinePaddingAfterMethods ||
               settings.Cleaning_InsertBlankLinePaddingBeforeNamespaces ||
               settings.Cleaning_InsertBlankLinePaddingAfterNamespaces ||
               settings.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine ||
               settings.Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine ||
               settings.Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine ||
               settings.Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine ||
               settings.Cleaning_InsertBlankLinePaddingBeforeRegionTags ||
               settings.Cleaning_InsertBlankLinePaddingAfterRegionTags ||
               settings.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags ||
               settings.Cleaning_InsertBlankLinePaddingAfterEndRegionTags ||
               settings.Cleaning_InsertBlankLinePaddingBeforeStructs ||
               settings.Cleaning_InsertBlankLinePaddingAfterStructs ||
               settings.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks ||
               settings.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks ||
               settings.Cleaning_InsertBlankLinePaddingBeforeCaseStatements ||
               settings.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments;
    }

    /// <summary>
    /// Applies a flat "settingName": value JSON object onto the Settings.Default fields via
    /// reflection, so the VS Code extension only needs to send the flags it wants to override
    /// (everything else keeps the Settings shim's built-in defaults).
    /// </summary>
    private static void ApplySettingsOverrides(Dictionary<string, JsonElement> overrides)
    {
        if (overrides is null || overrides.Count == 0)
        {
            return;
        }

        var target = Settings.Default;
        var fields = typeof(Settings).GetFields(BindingFlags.Public | BindingFlags.Instance);

        foreach (var field in fields)
        {
            if (!overrides.TryGetValue(field.Name, out var value))
            {
                continue;
            }

            if (field.FieldType == typeof(bool) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                field.SetValue(target, value.GetBoolean());
            }
            else if (field.FieldType == typeof(int) && value.ValueKind == JsonValueKind.Number)
            {
                field.SetValue(target, value.GetInt32());
            }
            else if (field.FieldType == typeof(string))
            {
                field.SetValue(target, value.ValueKind == JsonValueKind.Null ? null : value.GetString());
            }
        }
    }
}

internal sealed class EngineRequest
{
    public Dictionary<string, JsonElement> Settings { get; set; }

    public List<EngineFile> Files { get; set; }
}

internal sealed class EngineFile
{
    public string Path { get; set; }

    public string Content { get; set; }
}

internal sealed class EngineResponse
{
    public List<EngineFileResult> Results { get; set; }
}

internal sealed class EngineFileResult
{
    public string Path { get; set; }

    public string Output { get; set; }

    public bool Changed { get; set; }

    public string Error { get; set; }
}
