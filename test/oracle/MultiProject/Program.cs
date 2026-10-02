using System;
using Lib;

namespace Shop
{
    public static class Program
    {
        public static int Main()
        {
            var order = new Order { maxItems = 3, displayName = Order.defaultName };
            order.changed += (sender, e) => Console.WriteLine("changed");
            order.add(orderLine.Create("apple"));
            order.add(new orderLine("pear", 2) { quantity = 3 });
            if (order.state == orderState.open)
            {
                Console.WriteLine(order.getTotal().doubleIt() + order.calc());
            }

            var customer = new Customer(7);
            var box = new boxOf<Customer> { content = customer };
            Order.innerThing thing = new Order.innerThing();
            Console.WriteLine(box.content?.id + thing.id + customer.name.Length);
            Console.WriteLine(nameof(orderLine) + typeof(boxOf<int>).Name + order.getLegacy());
            return orderExtensions.doubleIt(order.size());
        }
    }
}
