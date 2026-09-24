using System.Linq;

namespace Oracle.Queries
{
    public class Queries
    {
        public int ListCount(List<int> list) => list.Count();

        public int ArrayCount(int[] array) => array.Count();

        public int EnumerableCount(IEnumerable<int> items) => items.Count();

        public bool ListAny(List<int> list) => list.Any();

        public bool HasItems(IEnumerable<int> items) => items.Count() > 0;

        public IEnumerable<int> Query(IEnumerable<int> items) =>
            from i in items
            where i > 1
            orderby i descending
            select i * 2;

        public int[] Empty() => new int[0];

        public int[] EmptyArray() => new int[] { };
    }
}
