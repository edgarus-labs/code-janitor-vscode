using Company.App.Text;

namespace Company.App
{
    internal class InExtension
    {
        // At file level Company.OuterExt.Shout(object) is found first; inside the namespace Text.StringExt.Shout(string) would be.
        public int Run() => "x".Shout();
    }
}
