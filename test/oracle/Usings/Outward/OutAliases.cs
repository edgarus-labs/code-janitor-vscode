namespace Company.App
{
    using Bar = Models.Bar;
    using Items = System.Collections.Generic.List<Models.Bar>;
    using static Models.ModelHelpers;
    using Str = System.String;

    internal class OutAliases
    {
        public Items Make() => new Items { new Bar() };

        public int Double() => Twice(2);

        public Str Name() => "x";
    }
}
