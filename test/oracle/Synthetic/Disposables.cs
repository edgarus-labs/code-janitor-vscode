using System.IO;

namespace Oracle.Resources
{
    public class Disposables
    {
        private readonly object gate = new object();

        public string Read(string path)
        {
            using (var reader = new StreamReader(path))
            {
                return reader.ReadToEnd();
            }
        }

        public int Nested(string path)
        {
            int length;
            using (var stream = File.OpenRead(path))
            {
                length = (int)stream.Length;
            }

            File.Delete(path);
            return length;
        }

        public void Locked(Action action)
        {
            lock (gate)
            {
                action();
            }
        }
    }
}
