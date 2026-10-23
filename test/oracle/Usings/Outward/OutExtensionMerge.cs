using System.Collections.Generic;
using System.Linq;

namespace Company.App
{
    using Extra;

    internal class OutExtensionMerge
    {
        // Extra.MoreLinq.Where is found first inside the namespace; merged with System.Linq the two compete. Only the one in
        // Extra returns an ExtraSequence, so the file builds only while `Where` still binds to it.
        public ExtraSequence Run(List<int> numbers) => numbers.Where(n => n > 1);
    }
}
