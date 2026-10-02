namespace Company.App
{
    // `Result` passes over Company.App.Result<T>, which takes a type argument, and binds Company.Result.
    using R = Result;

    internal class OutGenericArity
    {
        private readonly R result = new();

        public string Describe() => result.CompanyResult;
    }
}
