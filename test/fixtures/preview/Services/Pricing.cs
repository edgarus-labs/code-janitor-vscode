namespace Shop.Services
{
    public static class Pricing
    {
        public static decimal Discount(decimal total)
        {
            return total > 100 ? total * 0.9m : total;
        }
    }
}
