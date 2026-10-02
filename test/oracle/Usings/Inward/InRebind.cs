using Company.App.Models;

namespace Company.App
{
    internal class InRebind
    {
        // At file level `Foo` is Company.Foo (the enclosing namespace is searched first); inside Company.App it
        // would silently become Company.App.Models.Foo.
        public object Make() => new Foo();

        public string Name() => new Foo().CompanyFoo;
    }
}
