namespace Oracle.Control
{
    public class Switches
    {
        public string Name(int value)
        {
            switch (value)
            {
                case 1:
                    return "one";
                case 2:
                    return "two";
                default:
                    return "many";
            }
        }

        public int Jump(int value)
        {
            int result = 0;
            switch (value)
            {
                case 0:
                    result += 1;
                    goto case 1;
                case 1:
                    result += 2;
                    break;
                case int n when n > 10:
                    result = n;
                    break;
            }

            return result;
        }

        public int Loop(int[] values)
        {
            int sum = 0;
            for (int i = 0; i < values.Length; i++)
            {
                if (values[i] < 0) goto done;
                sum += values[i];
            }

        done:
            return sum;
        }

        public string Kind(object o)
        {
            if (o is string)
            {
                var s = (string)o;
                return s;
            }

            var list = o as List<int>;
            if (list != null)
            {
                return list.Count.ToString();
            }

            return o.GetType().Name;
        }
    }
}
