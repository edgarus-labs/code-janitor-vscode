namespace Oracle.Many
{
    public class Primary
    {
        public Secondary Make() => new Secondary();

        internal int UseFileLocal() => FileHelper.Value;
    }

    public class Secondary
    {
        public Mode Current { get; set; } = Mode.On;
    }

    public enum Mode
    {
        On,
        Off,
    }

    public interface IMany
    {
        void Do();
    }

    file static class FileHelper
    {
        public static int Value => 7;
    }
}
