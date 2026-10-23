using System.Collections.Immutable;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>
/// One piece of the members of a container (a type body, a namespace body or a file) as the reorganizer moves them:
/// whole lines of the source - a member with the comments directly above it and the comment after it, a <c>#if</c>
/// block, a <c>#region</c> block or something that must stay where it is.
/// </summary>
internal abstract class Entry
{
    /// <summary>The source text of the entry, from the start of its first line (so with its indentation) to its end.</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>Blank lines between the previous entry and this one.</summary>
    public int Blank { get; set; }

    /// <summary>The blank lines a member brings along when it moves: those of its gap to a previous member.</summary>
    public int MoveBlank { get; set; }

    /// <summary>Blank lines between this entry and the next one.</summary>
    public int BlankAfter { get; set; }

    /// <summary>The level the entry was found in; two entries still next to each other keep the blank lines between them.</summary>
    public int Level { get; set; }

    public int Index { get; set; }

    public Entry Clone() => (Entry)MemberwiseClone();
}

internal sealed class MemberEntry : Entry
{
    public required MemberInfo Info { get; init; }
}

internal enum RegionMarker
{
    None,
    RegionStart,
    RegionEnd,
}

/// <summary>Text that stays where it is: a comment not attached to a member, or a directive members must not move across.</summary>
internal sealed class FixedEntry : Entry
{
    /// <summary>Members never move across a barrier (<c>#pragma</c>, <c>using</c>, ...).</summary>
    public bool Barrier { get; init; }

    /// <summary>Set on the <c>#region</c> / <c>#endregion</c> lines of a region that was dissolved for sorting.</summary>
    public RegionMarker Marker { get; init; }
}

internal sealed class RegionEntry : Entry
{
    public required string Name { get; init; }

    public required string StartText { get; init; }

    public required string EndText { get; init; }

    public List<Entry> Children { get; set; } = [];

    /// <summary>Blank lines between the <c>#region</c> line and the first child.</summary>
    public int HeadBlank { get; set; }

    /// <summary>Blank lines between the last child and <c>#endregion</c>.</summary>
    public int TailBlank { get; set; }
}

/// <summary>The kinds of item found directly in a container, from the syntax tree and its trivia.</summary>
internal enum AtomType
{
    Member,
    Comment,
    DocComment,
    Region,
    EndRegion,
    If,
    Elif,
    Else,
    EndIf,
    Directive,
    DisabledText,
}

/// <summary>One item directly in a container: a declaration node, a comment, a directive or inactive code.</summary>
internal sealed record Atom(AtomType Type, int Start, int End, SyntaxNode? Node, string Text)
{
    public bool IsConditional => Type is AtomType.If or AtomType.Elif or AtomType.Else or AtomType.EndIf;

    public bool IsDirective => Type is AtomType.Region or AtomType.EndRegion or AtomType.Directive || IsConditional;
}

/// <summary>What the reorganizer makes of an atom.</summary>
internal abstract record Description
{
    public sealed record Member(MemberInfo Info) : Description;

    public sealed record Barrier : Description;
}

/// <summary>A container the reorganizer cannot rewrite, and why.</summary>
internal class StructureException(string message) : Exception(message);

/// <summary>Entries that share a line with another entry or with a brace: they cannot be moved as lines.</summary>
internal sealed class SharedLineException() : StructureException("more than one member on a line");

internal sealed record BuiltEntries(List<Entry> Entries, int Start, int End);

internal interface IBuildEnvironment
{
    string Source { get; }

    /// <summary>The source text of a span with the rewrites of the containers nested in it applied.</summary>
    string SpanText(int start, int end);

    /// <summary>Null for an atom the reorganizer does not understand (the container is then left alone).</summary>
    Description? Describe(Atom atom);

    /// <summary>The members of a stretch of inactive code, or null when it holds something else.</summary>
    IReadOnlyList<MemberInfo>? DescribeDisabled(Atom atom);
}

/// <summary>Builds the entries of a container from its atoms, or throws a <see cref="StructureException"/> saying why it cannot.</summary>
internal sealed partial class EntryBuilder
{
    private readonly IReadOnlyList<Atom> _atoms;
    private readonly IBuildEnvironment _env;
    private readonly Dictionary<Entry, Span> _positions = new(ReferenceEqualityComparer.Instance);
    private int _pos;
    private int _levels;

    public EntryBuilder(IReadOnlyList<Atom> atoms, IBuildEnvironment env)
    {
        _atoms = atoms;
        _env = env;
    }

    public static BuiltEntries Build(IReadOnlyList<Atom> atoms, IBuildEnvironment env)
    {
        var builder = new EntryBuilder(atoms, env);
        var (entries, closer, start, end) = builder.BuildLevel(false);
        if (closer is not null)
        {
            throw new StructureException("an #endregion without a #region");
        }

        return new BuiltEntries(entries, start, end);
    }

    /// <summary>`#region Fields` -> `Fields` (Visual Studio <c>RegionHelper.GetRegionName</c>).</summary>
    public static string RegionName(string directive) => RegionKeyword().Replace(directive.Trim(), string.Empty, 1).Trim();

    public static int CountNewlines(string text, int start, int end)
    {
        var count = 0;
        for (var i = start; i < end; i++)
        {
            if (text[i] == '\n')
            {
                count++;
            }
        }

        return count;
    }

    private (List<Entry> Entries, Atom? Closer, int Start, int End) BuildLevel(bool inRegion)
    {
        var level = _levels++;
        var entries = new List<Entry>();
        var spans = new List<Span>();
        var pending = new List<Atom>();
        Atom? closer = null;

        void Add(Entry entry, int start, int end)
        {
            var span = new Span(start, end);
            entries.Add(entry);
            spans.Add(span);
            _positions[entry] = span;
        }

        void FlushPending()
        {
            if (pending.Count > 0)
            {
                var start = pending[0].Start;
                var end = pending[^1].End;
                Add(Fixed(start, end, false, level), start, end);
                pending.Clear();
            }
        }

        int TakePending(Atom next)
        {
            // XML documentation belongs to the next member even across blank lines.
            var attached = pending.Count > 0 && (NewlinesBetween(pending[^1].End, next.Start) == 1 || pending.Any(atom => atom.Type == AtomType.DocComment));
            if (!attached)
            {
                FlushPending();
            }

            var start = attached ? pending[0].Start : next.Start;
            pending.Clear();

            return start;
        }

        while (_pos < _atoms.Count)
        {
            var atom = _atoms[_pos];

            if (atom.Type == AtomType.EndRegion)
            {
                if (!inRegion)
                {
                    throw new StructureException("an #endregion without a #region");
                }

                _pos++;
                closer = atom;
                break;
            }

            if (atom.Type is AtomType.Comment or AtomType.DocComment)
            {
                _pos++;
                var last = spans.Count > 0 ? spans[^1] : null;

                if (pending.Count == 0 && last is not null && NewlinesBetween(last.End, atom.Start) == 0)
                {
                    // A comment at the end of the line of the previous entry belongs to that entry.
                    last.End = atom.End;
                    Extend(entries[^1], last.Start, last.End);
                }
                else if (pending.Count == 0 && entries.Count == 0 && !StartsLine(atom.Start))
                {
                    // A comment on the line of the opening brace stays with it.
                }
                else if (pending.Count > 0 && pending[^1].Type != AtomType.DocComment && NewlinesBetween(pending[^1].End, atom.Start) > 1)
                {
                    FlushPending();
                    pending.Add(atom);
                }
                else
                {
                    pending.Add(atom);
                }

                continue;
            }

            if (atom.Type == AtomType.Region)
            {
                FlushPending();
                _pos++;
                var inner = BuildLevel(true);
                if (inner.Closer is null)
                {
                    throw new StructureException("a #region without an #endregion");
                }

                Add(Region(atom, inner.Closer, inner.Entries, level), atom.Start, inner.Closer.End);
                continue;
            }

            if (atom.Type == AtomType.If)
            {
                var close = MatchingEndIf();
                var inner = _atoms.Skip(_pos + 1).Take(close - _pos - 1).ToList();
                var start = TakePending(atom);
                var end = _atoms[close].End;
                Add(Conditional(start, end, inner, level), start, end);
                _pos = close + 1;
                continue;
            }

            if (atom.Type is AtomType.Elif or AtomType.Else or AtomType.EndIf or AtomType.DisabledText)
            {
                throw new StructureException("an unbalanced #if directive");
            }

            if (atom.Type == AtomType.Directive)
            {
                FlushPending();
                _pos++;
                Add(Fixed(atom.Start, atom.End, true, level), atom.Start, atom.End);
                continue;
            }

            var description = _env.Describe(atom) ?? throw new StructureException($"unsupported syntax ({atom.Node?.Kind().ToString() ?? atom.Type.ToString()})");
            _pos++;
            var memberStart = TakePending(atom);
            if (description is Description.Member member)
            {
                Add(Member(memberStart, atom.End, member.Info, level), memberStart, atom.End);
            }
            else
            {
                Add(Fixed(memberStart, atom.End, true, level), memberStart, atom.End);
            }
        }

        FlushPending();
        MeasureGaps(entries, spans);

        return (entries, closer, spans.Count > 0 ? spans[0].Start : 0, spans.Count > 0 ? spans[^1].End : 0);
    }

    /// <summary>Sets the blank lines from the whitespace between the entries and checks every entry is on lines of its own.</summary>
    private void MeasureGaps(List<Entry> entries, List<Span> spans)
    {
        var source = _env.Source;
        for (var i = 0; i < entries.Count; i++)
        {
            entries[i].Index = i;

            if (!StartsLine(spans[i].Start))
            {
                throw new SharedLineException();
            }

            if (i == 0)
            {
                continue;
            }

            var gapStart = spans[i - 1].End;
            var gapEnd = spans[i].Start;
            var newlines = CountNewlines(source, gapStart, gapEnd);
            if (!IsWhitespace(source, gapStart, gapEnd) || newlines == 0)
            {
                throw new SharedLineException();
            }

            entries[i].Blank = newlines - 1;
            entries[i].MoveBlank = entries[i - 1] is MemberEntry ? newlines - 1 : 0;
            entries[i - 1].BlankAfter = newlines - 1;
        }
    }

    private int MatchingEndIf()
    {
        var depth = 0;
        for (var i = _pos; i < _atoms.Count; i++)
        {
            if (_atoms[i].Type == AtomType.If)
            {
                depth++;
            }
            else if (_atoms[i].Type == AtomType.EndIf && --depth == 0)
            {
                return i;
            }
        }

        throw new StructureException("an #if without an #endif");
    }

    private Entry Conditional(int start, int end, List<Atom> inner, int level)
    {
        var members = new List<MemberInfo>();
        var hasBarrier = false;
        var regionDepth = 0;

        foreach (var atom in inner)
        {
            if (atom.Type == AtomType.Region)
            {
                regionDepth++;
            }
            else if (atom.Type == AtomType.EndRegion)
            {
                regionDepth--;
            }
            else if (atom.Type is AtomType.Comment or AtomType.DocComment || atom.IsConditional)
            {
                continue;
            }
            else if (atom.Type == AtomType.Directive)
            {
                // `#nullable`, `#pragma` and the like change the context of the members after them, as at the top level.
                hasBarrier = true;
            }
            else if (atom.Type == AtomType.DisabledText)
            {
                var disabled = _env.DescribeDisabled(atom);
                if (disabled is null)
                {
                    hasBarrier = true;
                }
                else
                {
                    members.AddRange(disabled);
                }
            }
            else
            {
                var description = _env.Describe(atom) ?? throw new StructureException($"unsupported syntax ({atom.Node?.Kind().ToString() ?? atom.Type.ToString()})");
                if (description is Description.Member member)
                {
                    members.Add(member.Info);
                }
                else
                {
                    hasBarrier = true;
                }
            }

            if (regionDepth < 0)
            {
                throw new StructureException("a #region that crosses an #if directive");
            }
        }

        if (regionDepth != 0)
        {
            throw new StructureException("a #region that crosses an #if directive");
        }

        if (hasBarrier || members.Count == 0)
        {
            return Fixed(start, end, true, level);
        }

        // The block sorts as its first member and takes the order constraints of all of them.
        var info = members[0] with
        {
            IsLayoutField = members.Any(member => member.IsLayoutField),
            Init = InitInfo.Merge(members.Select(member => member.Init)),
            PartialTypes = members.SelectMany(member => member.PartialTypes).ToImmutableHashSet(),
        };

        return Member(start, end, info, level);
    }

    private RegionEntry Region(Atom startAtom, Atom endAtom, List<Entry> children, int level)
    {
        var source = _env.Source;
        var headStart = startAtom.End;
        var headEnd = children.Count > 0 ? _positions[children[0]].Start : endAtom.Start;
        var tailStart = children.Count > 0 ? _positions[children[^1]].End : startAtom.End;
        var tailEnd = endAtom.Start;
        var headNewlines = CountNewlines(source, headStart, headEnd);
        var tailNewlines = CountNewlines(source, tailStart, tailEnd);

        if (!IsWhitespace(source, headStart, headEnd) || !IsWhitespace(source, tailStart, tailEnd) || headNewlines == 0 || (children.Count > 0 && tailNewlines == 0))
        {
            throw new StructureException("a #region directive that shares its line");
        }

        return new RegionEntry
        {
            Name = RegionName(startAtom.Text),
            StartText = _env.SpanText(LineStart(startAtom.Start), startAtom.End),
            EndText = _env.SpanText(LineStart(endAtom.Start), endAtom.End),
            Children = children,
            HeadBlank = children.Count > 0 ? headNewlines - 1 : 0,
            TailBlank = children.Count > 0 ? tailNewlines - 1 : 0,
            Level = level,
        };
    }

    private MemberEntry Member(int start, int end, MemberInfo info, int level) =>
        new() { Info = info, Text = TextOf(start, end), Level = level };

    private FixedEntry Fixed(int start, int end, bool barrier, int level) =>
        new() { Barrier = barrier, Text = TextOf(start, end), Level = level };

    private void Extend(Entry entry, int start, int end)
    {
        if (entry is not RegionEntry)
        {
            entry.Text = TextOf(start, end);
        }
    }

    private string TextOf(int start, int end) => _env.SpanText(LineStart(start), end);

    private int LineStart(int index) => index == 0 ? 0 : _env.Source.LastIndexOf('\n', index - 1) + 1;

    private bool StartsLine(int index)
    {
        var source = _env.Source;
        for (var i = LineStart(index); i < index; i++)
        {
            if (source[i] is not (' ' or '\t' or '\f' or '\v'))
            {
                return false;
            }
        }

        return true;
    }

    private int NewlinesBetween(int start, int end) => CountNewlines(_env.Source, start, end);

    private static bool IsWhitespace(string text, int start, int end)
    {
        for (var i = start; i < end; i++)
        {
            if (!char.IsWhiteSpace(text[i]))
            {
                return false;
            }
        }

        return true;
    }

    [GeneratedRegex(@"^#\s*region")]
    private static partial Regex RegionKeyword();

    private sealed class Span(int start, int end)
    {
        public int Start { get; } = start;

        public int End { get; set; } = end;
    }
}
