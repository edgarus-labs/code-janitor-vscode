using System;
using Shop.Models;

namespace Shop
{
    internal static class Program
    {
        private static void Main()
        {
            Order order = new Order();
            order.Add(12.5m);
            Console.WriteLine(order.Total());

            var customer = new Customer("Ann");
            Console.WriteLine(customer.HasTag("vip"));
        }
    }
}
