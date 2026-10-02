// Two types named Gauge for Inward/InNestedCapture.cs: one in the global namespace, one in Probes.
namespace Probes
{
    public static class Gauge
    {
        public static string Read() => "probes";
    }
}

public static class Gauge
{
    public static int Read() => 1;
}
