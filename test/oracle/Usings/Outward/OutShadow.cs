namespace Company.App
{
    using Models;

    internal class OutShadow
    {
        // At file level `Foo` would be Company.Foo: the import is searched after the enclosing namespace.
        public Foo Make() => new Foo();

        public string Name(Foo foo) => foo.ModelsFoo;
    }
}
