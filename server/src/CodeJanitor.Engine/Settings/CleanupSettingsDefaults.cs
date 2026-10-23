using System.Text.Json.Nodes;

namespace CodeJanitor.Engine.Settings;

/// <summary>
/// The default cleanup settings of the extension, with the
/// header enums as their protocol strings. Used for the <c>check</c> CLI and for keys a request leaves out.
/// </summary>
public static class CleanupSettingsDefaults
{
    private const string Json = """
        {
          "insertBlankLinePaddingBeforeClasses": true,
          "insertBlankLinePaddingAfterClasses": true,
          "insertBlankLinePaddingBeforeDelegates": true,
          "insertBlankLinePaddingAfterDelegates": true,
          "insertBlankLinePaddingBeforeEnumerations": true,
          "insertBlankLinePaddingAfterEnumerations": true,
          "insertBlankLinePaddingBeforeEvents": true,
          "insertBlankLinePaddingAfterEvents": true,
          "insertBlankLinePaddingBeforeFieldsMultiLine": true,
          "insertBlankLinePaddingAfterFieldsMultiLine": true,
          "insertBlankLinePaddingBeforeFieldsSingleLine": false,
          "insertBlankLinePaddingAfterFieldsSingleLine": false,
          "insertBlankLinePaddingBeforeInterfaces": true,
          "insertBlankLinePaddingAfterInterfaces": true,
          "insertBlankLinePaddingBeforeMethods": true,
          "insertBlankLinePaddingAfterMethods": true,
          "insertBlankLinePaddingBeforeNamespaces": true,
          "insertBlankLinePaddingAfterNamespaces": true,
          "insertBlankLinePaddingBeforePropertiesMultiLine": true,
          "insertBlankLinePaddingAfterPropertiesMultiLine": true,
          "insertBlankLinePaddingBeforePropertiesSingleLine": false,
          "insertBlankLinePaddingAfterPropertiesSingleLine": false,
          "insertBlankLinePaddingBeforeStructs": true,
          "insertBlankLinePaddingAfterStructs": true,
          "insertBlankLinePaddingBeforeRegionTags": true,
          "insertBlankLinePaddingAfterRegionTags": true,
          "insertBlankLinePaddingBeforeEndRegionTags": true,
          "insertBlankLinePaddingAfterEndRegionTags": true,
          "insertBlankLinePaddingBeforeUsingStatementBlocks": true,
          "insertBlankLinePaddingAfterUsingStatementBlocks": true,
          "insertBlankLinePaddingBeforeCaseStatements": true,
          "insertBlankLinePaddingBeforeSingleLineComments": false,
          "insertBlankLinePaddingBetweenPropertiesMultiLineAccessors": false,
          "insertExplicitAccessModifiersOnClasses": true,
          "insertExplicitAccessModifiersOnDelegates": true,
          "insertExplicitAccessModifiersOnEnumerations": true,
          "insertExplicitAccessModifiersOnEvents": true,
          "insertExplicitAccessModifiersOnFields": true,
          "insertExplicitAccessModifiersOnInterfaces": true,
          "insertExplicitAccessModifiersOnMethods": true,
          "insertExplicitAccessModifiersOnProperties": true,
          "insertExplicitAccessModifiersOnStructs": true,
          "convertToFileScopedNamespace": false,
          "convertToVarWhenApparent": false,
          "makeFieldsReadonlyWhenSafe": false,
          "sealClassesWhenSafe": false,
          "renamePublicSymbolsAcrossWorkspace": false,
          "onlyChangedLines": false,
          "insertBlankLineBeforeReturnAndThrowStatements": false,
          "convertToCollectionExpressions": false,
          "reuseJsonSerializerOptionsForCA1869": false,
          "simplifySingleStatementLambdas": false,
          "convertToPatternMatchingNullChecks": true,
          "convertStringFormatToInterpolation": true,
          "convertToStringNameOf": true,
          "inlineOutVariableDeclarations": true,
          "moveUsingsOutsideNamespace": true,
          "organizeUsings": false,
          "usingStatementsToReinsertWhenRemoved": [],
          "updateEndRegionDirectives": true,
          "updateSingleLineMethods": true,
          "updateAccessorsToBothBeSingleLineOrMultiLine": false,
          "formatComments": false,
          "commentFormat": {
            "wrapColumn": 100,
            "skipWrapOnLastWord": true,
            "ignoreLinesStartingWith": [
              "ReSharper disable ",
              "ReSharper enable "
            ],
            "xmlAlignParamTags": false,
            "xmlKeepTagsTogether": false,
            "xmlSpaceSingleTags": false,
            "xmlSpaceTags": false,
            "xmlSplitAllTags": false,
            "xmlSplitSummaryTagToMultipleLines": true,
            "xmlTagsToLowerCase": false,
            "xmlValueIndent": 0
          },
          "reorganize": {
            "alphabetizeMembersOfTheSameGroup": true,
            "explicitMembersAtEnd": false,
            "keepMembersWithinRegions": true,
            "performWhenPreprocessorConditionals": "ask",
            "primaryOrderByAccessLevel": false,
            "reverseOrderByAccessLevel": false,
            "runAtStartOfCleanup": false,
            "regionsIncludeAccessLevel": false,
            "regionsIncludeAccessLevelForMethodsOnly": false,
            "regionsInsertKeepEvenIfEmpty": false,
            "regionsInsertNewRegions": false,
            "regionsRemoveExistingRegions": false,
            "memberTypes": {
              "classes": {
                "order": 12,
                "name": "Classes"
              },
              "constructors": {
                "order": 2,
                "name": "Constructors"
              },
              "delegates": {
                "order": 4,
                "name": "Delegates"
              },
              "destructors": {
                "order": 3,
                "name": "Destructors"
              },
              "enums": {
                "order": 6,
                "name": "Enums"
              },
              "events": {
                "order": 5,
                "name": "Events"
              },
              "fields": {
                "order": 1,
                "name": "Fields"
              },
              "indexers": {
                "order": 9,
                "name": "Indexers"
              },
              "interfaces": {
                "order": 7,
                "name": "Interfaces"
              },
              "methods": {
                "order": 10,
                "name": "Methods"
              },
              "properties": {
                "order": 8,
                "name": "Properties"
              },
              "structs": {
                "order": 11,
                "name": "Structs"
              }
            }
          },
          "removeRegions": true,
          "removeByteOrderMark": true,
          "removeEndOfLineWhitespace": true,
          "removeBlankLinesAtTop": true,
          "removeBlankLinesAtBottom": true,
          "removeBlankLinesAfterAttributes": true,
          "removeBlankLinesAfterOpeningBrace": true,
          "removeBlankLinesBeforeClosingBrace": true,
          "removeBlankLinesBetweenChainedStatements": true,
          "removeMultipleConsecutiveBlankLines": true,
          "removeBlankLinesBeforeClosingTags": true,
          "removeBlankSpacesBeforeClosingAngleBrackets": true,
          "insertBlankSpaceBeforeSelfClosingAngleBrackets": true,
          "fileHeaderCSharp": "",
          "fileHeaderVB": "",
          "fileHeaderFSharp": "",
          "fileHeaderCPlusPlus": "",
          "fileHeaderCSS": "",
          "fileHeaderLESS": "",
          "fileHeaderSCSS": "",
          "fileHeaderJavaScript": "",
          "fileHeaderTypeScript": "",
          "fileHeaderJSON": "",
          "fileHeaderHTML": "",
          "fileHeaderXAML": "",
          "fileHeaderXML": "",
          "fileHeaderPHP": "",
          "fileHeaderPowerShell": "",
          "fileHeaderR": "",
          "fileHeaderPosition": "documentStart",
          "fileHeaderUpdateMode": "insert",
          "codeStyleRules": {}
        }
        """;

    private static readonly JsonObject Defaults = Parse();

    /// <summary>A new copy of the default settings.</summary>
    public static JsonObject Create() => (JsonObject)Defaults.DeepClone();

    /// <summary>The default value of one setting, or null when the key is unknown.</summary>
    internal static JsonNode? Get(string key) => Defaults[key];

    private static JsonObject Parse()
    {
        var defaults = (JsonObject)JsonNode.Parse(Json)!;

        // JsonObject builds its dictionary lazily; building it here makes concurrent reads safe.
        _ = defaults.DeepClone();

        return defaults;
    }
}
