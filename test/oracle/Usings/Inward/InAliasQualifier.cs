using Txt = System.Text;

namespace Company.App
{
    // `Txt::` names the file-level alias; next to it in one scope the alias would not be found (CS0432).
    using Builder = Txt::StringBuilder;

    internal class InAliasQualifier
    {
        public Builder Make() => new Builder();
    }
}
