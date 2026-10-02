namespace Fixtures
{
    public class Unbalanced
    {
        public void Zulu() { }
#if FLAG
        public int Alpha;
    }

    public class Other
    {
#endif
        public int Bravo;
    }
}
