namespace Oracle.Native
{
    public unsafe class Pointers
    {
        public int Sum(int[] values)
        {
            int total = 0;
            fixed (int* p = values)
            {
                for (int i = 0; i < values.Length; i++)
                {
                    total += p[i];
                }
            }

            return total;
        }

        public int Stack()
        {
            Span<int> buffer = stackalloc int[4];
            buffer[0] = 1;
            return buffer[0];
        }
    }
}
