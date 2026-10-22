using CodeJanitor.Engine.Reorganize;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>Reorganizing random files only moves lines, never breaks the syntax and is idempotent for any settings.</summary>
public sealed class ReorganizeFuzzTests
{
    /// <summary>The lines of a file, without blank lines and region directives: a reorganized file holds exactly these.</summary>
    private static List<string> ContentLines(string source) => source
        .Split('\n')
        .Select(line => line.TrimEnd('\r').Trim())
        .Where(line => line.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(line, @"^#\s*(end)?region\b"))
        .OrderBy(line => line, StringComparer.Ordinal)
        .ToList();

    private static int ParseErrors(string source) =>
        CSharpSyntaxTree.ParseText(source).GetDiagnostics().Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

    [Fact]
    public void OnlyMovesLinesNeverBreaksTheSyntaxAndIsIdempotentForAnySettings()
    {
        // The reorganizer returns the input unchanged when its own safety net fires, which would satisfy the checks
        // below: the seeds must also be reorganized without a container being skipped.
        var reorganized = 0;
        for (var seed = 1; seed <= 400; seed++)
        {
            var random = new FuzzRandom((uint)seed);
            var source = FuzzFile.Generate(random, allowDirectives: true);
            var settings = FuzzFile.RandomReorganizeSettings(random);
            var cleanup = FuzzFile.RandomCleanup(random);
            var first = Detailed(source, settings, cleanup);
            var context = $"seed {seed}\n--- source ---\n{source}\n--- output ---\n{first.Output}";

            Assert.True(first.Skipped.Count == 0, $"safety net fired: {string.Join("; ", first.Skipped)}\n{context}");
            Assert.False(first.BlockedByPreprocessor, context);
            if (first.Output != source)
            {
                reorganized++;
            }

            Assert.True(ContentLines(source).SequenceEqual(ContentLines(first.Output)), $"lines changed: {context}");
            Assert.True(ParseErrors(first.Output) <= ParseErrors(source), $"parse errors: {context}");
            Assert.True(Detailed(first.Output, settings, cleanup).Output == first.Output, $"not idempotent: {context}");
        }

        // Some generated files are already in order; most are not.
        Assert.True(reorganized >= 300, $"too few generated files were reorganized: {reorganized}");
    }
}

/// <summary>mulberry32: a small deterministic generator, so a failing case can be reproduced from its seed.</summary>
internal sealed class FuzzRandom(uint seed)
{
    private uint _state = seed;

    public double Next()
    {
        _state += 0x6d2b79f5;
        var t = _state;
        t = (t ^ (t >> 15)) * (t | 1);
        t ^= t + ((t ^ (t >> 7)) * (t | 61));

        return (t ^ (t >> 14)) / 4294967296.0;
    }

    public int Int(int max) => (int)Math.Floor(Next() * max);

    public bool Chance(double probability) => Next() < probability;

    public T Pick<T>(IReadOnlyList<T> items) => items[Int(items.Count)];
}

/// <summary>A class (or struct, interface, namespace) with a random mix of members, comments, blank lines, regions and directives.</summary>
internal static class FuzzFile
{
    private static readonly string[] Names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "_zeta", "_eta", "Theta", "Iota", "Kappa", "Lambda", "Mu"];
    private static readonly string[] Access = ["public", "private", "protected", "internal", "protected internal", "private protected", ""];

    public static string Generate(FuzzRandom random, bool allowDirectives)
    {
        var newline = random.Chance(0.3) ? "\r\n" : "\n";
        var indent = random.Chance(0.2) ? "\t" : "    ";
        var used = new HashSet<string>();
        var lines = new List<string>();

        string Name()
        {
            var name = random.Pick(Names);
            var candidate = name;
            for (var i = 2; used.Contains(candidate); i++)
            {
                candidate = $"{name}{i}";
            }

            used.Add(candidate);

            return candidate;
        }

        string Initializer() => random.Pick(["", "", " = 1", " = 2", " = Compute()", " = new System.Collections.Generic.List<int>()", $" = {random.Pick(Names)}X + 1"]);

        string Pad(int level) => string.Concat(Enumerable.Repeat(indent, level));

        List<string> Member(int level)
        {
            var pad = Pad(level);
            var access = random.Pick(Access);
            var prefix = access.Length > 0 ? access + " " : string.Empty;
            var isStatic = random.Chance(0.3) ? "static " : string.Empty;
            var member = new List<string>();

            if (random.Chance(0.25))
            {
                member.Add($"{pad}/// <summary>Documents it.</summary>");
            }

            if (random.Chance(0.1))
            {
                member.Add($"{pad}// a note");
            }

            if (random.Chance(0.1))
            {
                member.Add($"{pad}[System.Obsolete]");
            }

            var n = Name();
            switch (random.Int(9))
            {
                case 0:
                    member.Add($"{pad}{prefix}{isStatic}{(random.Chance(0.3) ? "readonly " : string.Empty)}int {n}X{Initializer()};");
                    break;
                case 1:
                    member.Add($"{pad}{prefix}{isStatic}void {n}() {{ }}");
                    break;
                case 2:
                    member.AddRange([$"{pad}{prefix}{isStatic}int {n}()", $"{pad}{{", $"{pad}{indent}return 1;", $"{pad}}}"]);
                    break;
                case 3:
                    member.Add($"{pad}{prefix}{isStatic}int {n} {{ get; set; }}{(random.Chance(0.2) ? " = 5;" : string.Empty)}");
                    break;
                case 4:
                    member.AddRange([$"{pad}{prefix}{isStatic}int {n}", $"{pad}{{", $"{pad}{indent}get {{ return 1; }}", $"{pad}}}"]);
                    break;
                case 5:
                    member.Add($"{pad}{prefix}{isStatic}event System.Action {n};");
                    break;
                case 6:
                    if (random.Chance(0.5) && level < 3)
                    {
                        member.AddRange([$"{pad}{prefix}{random.Pick(["class", "struct", "interface"])} {n}Nested", $"{pad}{{"]);
                        var saved = lines.Count;
                        Block(level + 1, 1);
                        member.AddRange(lines.Skip(saved));
                        lines.RemoveRange(saved, lines.Count - saved);
                        member.Add($"{pad}}}");
                    }
                    else
                    {
                        member.AddRange([$"{pad}{prefix}class {n}Nested", $"{pad}{{", $"{pad}{indent}void Z() {{ }}", $"{pad}{indent}int _a;", $"{pad}}}"]);
                    }

                    break;
                case 7:
                    member.Add($"{pad}{prefix}{isStatic}const int {n}K = 1;");
                    break;
                default:
                    member.Add($"{pad}{prefix}enum {n}E {{ B, A }}");
                    break;
            }

            if (random.Chance(0.15))
            {
                member[^1] += " // trailing";
            }

            return member;
        }

        void Blank()
        {
            var count = random.Pick([0, 0, 0, 1, 1, 2]);
            for (var i = 0; i < count; i++)
            {
                lines.Add(string.Empty);
            }
        }

        void Block(int level, int depth)
        {
            var count = 1 + random.Int(6);
            for (var i = 0; i < count; i++)
            {
                Blank();
                var roll = random.Next();
                if (roll < 0.12 && depth < 2)
                {
                    var pad = Pad(level);
                    lines.Add($"{pad}#region {random.Pick(["Fields", "Methods", "Helpers", "Stuff", "Private Methods"])}");
                    Block(level, depth + 1);
                    lines.Add($"{pad}#endregion{(random.Chance(0.5) ? " X" : string.Empty)}");
                }
                else if (roll < 0.2 && allowDirectives)
                {
                    lines.Add("#if FLAG");
                    lines.AddRange(Member(level));
                    if (random.Chance(0.3))
                    {
                        lines.Add("#else");
                        lines.AddRange(Member(level));
                    }

                    lines.Add("#endif");
                }
                else if (roll < 0.25 && allowDirectives)
                {
                    lines.Add($"{Pad(level)}#pragma warning disable CS0169");
                    lines.AddRange(Member(level));
                }
                else if (roll < 0.3)
                {
                    lines.AddRange([$"{Pad(level)}// ---- a floating comment ----", string.Empty]);
                }
                else
                {
                    lines.AddRange(Member(level));
                }
            }
        }

        void TypeAt(int level)
        {
            var pad = Pad(level);
            if (random.Chance(0.15))
            {
                lines.AddRange([string.Empty, $"{pad}public delegate void {Name()}D();"]);
            }
            else if (random.Chance(0.15))
            {
                lines.AddRange([string.Empty, $"{pad}public enum {Name()}E {{ B, A }}"]);
            }
            else
            {
                lines.AddRange([string.Empty, $"{pad}{random.Pick(["public ", "internal ", ""])}{random.Pick(["class", "class", "struct", "interface"])} {Name()}T", $"{pad}{{"]);
                Block(level + 1, 0);
                lines.Add($"{pad}}}");
            }
        }

        var shape = random.Pick(["type", "type", "namespace", "fileScoped"]);
        if (shape == "type")
        {
            lines.AddRange([$"{random.Pick(["class", "class", "struct"])} C", "{"]);
            Block(1, 0);
            lines.Add("}");
        }
        else if (shape == "namespace")
        {
            lines.AddRange(["namespace N", "{"]);
            for (int i = 0, count = 1 + random.Int(4); i < count; i++)
            {
                TypeAt(1);
            }

            lines.Add("}");
        }
        else
        {
            lines.Add("namespace N;");
            for (int i = 0, count = 1 + random.Int(4); i < count; i++)
            {
                TypeAt(0);
            }
        }

        return string.Join(newline, lines) + newline;
    }

    public static ReorganizeSettings RandomReorganizeSettings(FuzzRandom random)
    {
        var settings = new ReorganizeSettings
        {
            AlphabetizeMembersOfTheSameGroup = random.Chance(0.7),
            ExplicitMembersAtEnd = random.Chance(0.3),
            KeepMembersWithinRegions = random.Chance(0.6),
            PrimaryOrderByAccessLevel = random.Chance(0.3),
            ReverseOrderByAccessLevel = random.Chance(0.3),
            RegionsIncludeAccessLevel = random.Chance(0.3),
            RegionsIncludeAccessLevelForMethodsOnly = random.Chance(0.3),
            RegionsInsertKeepEvenIfEmpty = random.Chance(0.2),
            RegionsInsertNewRegions = random.Chance(0.4),
            RegionsRemoveExistingRegions = random.Chance(0.4),
            PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes,
        };

        if (random.Chance(0.5))
        {
            var keys = ReorganizeSettings.AllMemberTypes;
            var orders = Enumerable.Range(1, keys.Count).ToArray();
            for (var i = orders.Length - 1; i > 0; i--)
            {
                var j = random.Int(i + 1);
                (orders[i], orders[j]) = (orders[j], orders[i]);
            }

            var memberTypes = ReorganizeSettings.DefaultMemberTypes();
            for (var index = 0; index < keys.Count; index++)
            {
                // Sometimes two member types share an order (they then form one group).
                memberTypes[keys[index]] = memberTypes[keys[index]] with { Order = random.Chance(0.1) ? 1 : orders[index] };
            }

            settings = settings with { MemberTypes = memberTypes };
        }

        return settings;
    }

    public static ReorganizeCleanup RandomCleanup(FuzzRandom random)
    {
        var padding = random.Chance(0.5) ? ReorganizeCleanup.Default : ReorganizeCleanup.WithoutPadding;
        var updateEndRegion = random.Chance(0.5);

        return new ReorganizeCleanup(key => key == "updateEndRegionDirectives" ? updateEndRegion : padding.Flag(key));
    }
}
