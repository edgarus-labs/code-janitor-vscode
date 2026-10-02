namespace Oracle.Tuples
{
    public class Tuples
    {
        public (int Min, int Max) Range(int[] values)
        {
            int min = int.MaxValue;
            int max = int.MinValue;
            foreach (int v in values)
            {
                min = Math.Min(min, v);
                max = Math.Max(max, v);
            }

            return (min, max);
        }

        public int Width(int[] values)
        {
            var range = Range(values);
            return range.Item2 - range.Item1;
        }

        public void Swap(ref int a, ref int b)
        {
            int tmp = a;
            a = b;
            b = tmp;
        }

        public string Describe()
        {
            int count = 1;
            string label = "x";
            var pair = (count: count, label: label);
            var anon = new { count = count, label = label };
            return pair.label + anon.count;
        }
    }
}
