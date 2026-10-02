namespace Company.App
{
    using Pair = (Services.Svc First, int Second);

    internal class OutTupleAlias
    {
        public Pair Make() => (new Services.Svc(), 1);
    }
}
