using System;
using System.Collections.Generic;

namespace Oracle.Reorganize
{
    public class Orders
    {
        #region Methods

        public decimal Total() => _lines.Count * Rate;

        public void Add(string line) { _lines.Add(line); }

        #endregion

        #region Fields

        private readonly List<string> _lines = new List<string>();
        private const decimal Rate = 2.5m;

        #endregion

        public string Customer { get; set; } = "anonymous";

        #region Helpers

        #region Formatting

        private string Format(string line) => line.Trim();

        public override string ToString() => Format(Customer);

        #endregion

        private static int Clamp(int value) => Math.Max(0, value);

        #endregion

        // A loose member after the regions.
        public Orders() { }
    }

    public struct Money
    {
        #region Operations
        public static Money operator +(Money a, Money b) => new Money(a.Amount + b.Amount);
        public override string ToString() => Amount.ToString();
        #endregion
        public Money(decimal amount) { Amount = amount; }
        public decimal Amount { get; }
    }
}
