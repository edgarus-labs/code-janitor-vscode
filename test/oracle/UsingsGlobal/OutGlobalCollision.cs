namespace Company.App
{
    using Beta;

    internal class OutGlobalCollision
    {
        // Inside the namespace Beta.T wins over the global using of Alpha; at file level they would be ambiguous.
        private T value;
    }
}
