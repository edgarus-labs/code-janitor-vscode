using Probes;

namespace Company.App
{
    namespace Nested
    {
        // `Gauge` is the global Gauge, found before the file-level `using Probes;`. Once that directive is in
        // Company.App, it is searched before the global namespace and `Gauge` becomes Probes.Gauge.
        using static Gauge;

        internal class InNestedCapture
        {
            public int Value() => Read();
        }
    }
}
