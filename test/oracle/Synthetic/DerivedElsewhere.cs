namespace Oracle.Shapes
{
    // Derives from a type declared in another file: InternalLeaf must not be sealed.
    internal class InternalLeaf : InternalDerived
    {
        public override int Value() => 3;
    }

    internal class Leaf2 : Oracle.Members.Counter
    {
    }
}
