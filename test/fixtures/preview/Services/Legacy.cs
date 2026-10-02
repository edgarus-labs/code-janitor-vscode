using System;

namespace Shop.Services
{
    public class Legacy
    {
        public void Run()   
        {
            var items = new System.Collections.Generic.List<int>();
            if (items.Count == 0) return;
            Console.WriteLine(items.Count);
        }
    }
}
