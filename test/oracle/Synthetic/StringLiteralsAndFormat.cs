using System;

namespace Oracle
{
    /// <summary>Multi-line string literals keep their blank lines, and string.Format keeps its evaluation order.</summary>
    internal sealed class StringLiteralsAndFormat
    {
        private int _calls;

        private int Next() => ++_calls;

        public string Verbatim() => @"first   


   second
	tabbed";

        public string Raw() => """
            keep   


            this
            """;

        public string Interpolated(int n) => $@"a


{n}


b";

        public string Calls() => string.Format("{0}-{0}", Next()) + string.Format("{1}{0}", Next(), Next()) + string.Format("{0}", 1, Next());

        public string Conditional(bool flag) => string.Format("{0}", flag ? "a" : "b");
    }
}
