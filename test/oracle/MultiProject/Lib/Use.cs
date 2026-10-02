namespace Lib
{
    internal static class Use
    {
        public static int Run(Order order, Customer customer)
        {
            var thing = new Order.innerThing { id = customer.id };
            return order.calc(2) + thing.id + internalHelper.twice(order.maxItems) + order.size();
        }
    }
}
