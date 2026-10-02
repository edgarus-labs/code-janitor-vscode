using System;
using System.Collections.Generic;

namespace Oracle.Reorganize
{
    public interface IRepository<T>
    {
        void Add(T item);

        event EventHandler Changed;

        T this[int index] { get; }

        IEnumerable<T> All();

        int Count { get; }
    }

    public class Repository : IRepository<string>
    {
        void IRepository<string>.Add(string item) { _items.Add(item); }

        public int Count => _items.Count;

        string IRepository<string>.this[int index] => _items[index];

        event EventHandler IRepository<string>.Changed { add { } remove { } }

        private readonly List<string> _items = new List<string>();

        IEnumerable<string> IRepository<string>.All() => _items;

        public void Clear() => _items.Clear();

        int IRepository<string>.Count => _items.Count;

        public string Name { get; set; } = "repo";
    }
}
