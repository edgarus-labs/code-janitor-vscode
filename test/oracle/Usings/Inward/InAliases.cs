using Repo = Data.Repo;
using static Data.Repo;
using Str = System.String;
using List = System.Collections.Generic.List<Data.Repo>;

namespace Company.App
{
    internal class InAliases
    {
        public string Who() => new Repo().GlobalRepo;

        public List Make() => new();

        public Str Name() => "x";
    }
}
