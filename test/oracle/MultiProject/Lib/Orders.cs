using System;
using System.Collections.Generic;

namespace Lib
{
    public enum orderState
    {
        open,
        closed,
    }

    public class orderLine
    {
        public orderLine(string product, int quantity)
        {
            this.product = product;
            this.quantity = quantity;
        }

        public string product;

        public int quantity;

        public static orderLine Create(string product) => new orderLine(product, 1);
    }

    /// <summary>An order; see <see cref="getTotal"/>.</summary>
    public class Order
    {
        public const string defaultName = "order";

        private readonly List<orderLine> lines = new List<orderLine>();

        public int maxItems = 10;

        public event EventHandler? changed;

        public orderState state { get; set; } = orderState.open;

        public string displayName { get; set; } = defaultName;

        public void add(orderLine line)
        {
            if (lines.Count >= maxItems)
            {
                throw new InvalidOperationException(nameof(maxItems));
            }

            lines.Add(line);
            changed?.Invoke(this, EventArgs.Empty);
        }

        public int getTotal()
        {
            int total = 0;
            foreach (orderLine line in lines)
            {
                total += line.quantity;
            }

            return total;
        }

        public int calc() => getTotal();

        public int calc(int factor) => getTotal() * factor;

        public virtual int size() => lines.Count;

        public string getLegacy() => "legacy";

        public object? findLegacy() => typeof(Order).GetMethod("getLegacy");

        public class innerThing
        {
            public int id;
        }
    }

    public class Customer
    {
        public int id;

        public string name = "";

        public Customer(int id) { this.id = id; }
    }

    public static class orderExtensions
    {
        public static int doubleIt(this int value) => value * 2;
    }

    public class boxOf<T>
    {
        public T? content;
    }

    internal static class internalHelper
    {
        internal static int twice(int x) => x * 2;
    }
}
