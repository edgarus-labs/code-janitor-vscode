using System.Collections.Generic;
using System.Linq;

namespace Company.App
{
    using Extra;

    internal class OutExtensionMerge
    {
        // Extra.MoreLinq.Where is found first inside the namespace; merged with System.Linq the two compete.
        public IEnumerable<int> Run(List<int> numbers) => numbers.Where(n => n > 1);
    }
}
