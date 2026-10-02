namespace Company.App
{
    extern alias V1;
    using V1::Ext;

    internal class OutExternInside
    {
        private Thing thing = new();
    }
}
