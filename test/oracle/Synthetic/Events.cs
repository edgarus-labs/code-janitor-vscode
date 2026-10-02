namespace Oracle.Events
{
    public delegate void Notify(string message);

    public class Publisher
    {
        private Notify? handlers;

        public event Notify Notified
        {
            add { handlers += value; }
            remove { handlers -= value; }
        }

        public event EventHandler<int>? Ticked;

        public void Raise(string message)
        {
            if (handlers != null)
            {
                handlers(message);
            }

            var ticked = Ticked;
            if (ticked != null)
            {
                ticked(this, 1);
            }
        }
    }
}
