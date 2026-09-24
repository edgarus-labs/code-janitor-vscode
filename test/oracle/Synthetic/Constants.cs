namespace Oracle.Consts
{
    public class Constants
    {
        private const int maxRetries = 3;
        public const string DefaultName = "default";
        private static readonly string cacheKey = "key";
        internal static int sharedCounter;
        private int @class = 1;
        protected int protectedField = 2;
        public int PublicField = 3;

        public int Retries(int requested) => Math.Min(requested, maxRetries);

        public string Key() => cacheKey + @class + protectedField + PublicField + sharedCounter;

        public string FieldName() => nameof(protectedField);

        public int LocalConst()
        {
            const int localLimit = 10;
            return localLimit;
        }
    }
}
