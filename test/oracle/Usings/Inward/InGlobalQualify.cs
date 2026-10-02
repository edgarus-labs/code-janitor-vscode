using Services;

namespace Company.App
{
    internal class InGlobalQualify
    {
        // `using Services;` at file level is the global Services: only its Svc has GlobalOnly. Inside Company.App it
        // would mean Company.App.Services unless written global::Services.
        public string Who() => new Svc().GlobalOnly;
    }
}
