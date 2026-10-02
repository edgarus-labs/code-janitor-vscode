// Declarations that exist only in builds defining LEGACY, which this corpus never does.
namespace Company.App
{
#if LEGACY
    namespace Archive
    {
        public class Entry
        {
            public string LegacyEntry => "legacy";
        }
    }
#endif
}
