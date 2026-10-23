#nullable disable
namespace CodeJanitor.Engine.Commands;

/// <summary>
/// ines reasons for skipping a top-level type splitting operation, including cases with no content, unsupported source structures, or absence of multiple eligible types to split.
/// </summary>
internal enum TopLevelTypeSplitSkipReason
{
    None,
    EmptySource,
    UnsupportedStructure,
    NotMultipleEligibleTypes,
    FileNameCollision
}
