using Widget = System.Text.StringBuilder;

namespace Company.App.Conflict
{
    // Inside the namespace the alias would clash with this class (CS0576).
    internal class Widget
    {
    }

    internal class InAliasConflict
    {
        public object Make() => new Widget();
    }
}
