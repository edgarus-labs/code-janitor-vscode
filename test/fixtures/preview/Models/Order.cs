using System.Collections.Generic;

namespace Shop.Models
{
    public class Order
    {
        private readonly List<decimal> _lines = new List<decimal>();
        public int Id { get; set; }   


        public void Add(decimal price)
        {
            if (price < 0)
                throw new System.ArgumentOutOfRangeException(nameof(price));
            _lines.Add(price);
        }

        public decimal Total()
        {
            decimal total = 0;
            foreach (var line in _lines)
                total += line;
            return total;
        }
    }
}
