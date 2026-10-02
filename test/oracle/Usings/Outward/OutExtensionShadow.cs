namespace Company.App
{
    using Text;

    internal class OutExtensionShadow
    {
        // Inside Company.App this calls Text.StringExt.Shout(string); at file level Company.OuterExt.Shout(object) would win.
        public string Run() => "x".Shout();
    }
}
