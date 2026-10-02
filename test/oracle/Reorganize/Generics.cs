using System;
using System.Collections.Generic;

namespace Oracle.Reorganize
{
    public class Box<T> where T : class, new()
    {
        public T Value { get; set; } = new T();

        public TOther Convert<TOther>(Func<T, TOther> map) where TOther : notnull => map(Value);

        private readonly List<T> _history = new List<T>();

        public static Box<T> Empty { get; } = new Box<T>();

        public void Push(T value) { _history.Add(value); Value = value; }

        public static implicit operator T(Box<T> box) => box.Value;
    }

    public static class Extensions
    {
        public static string Twice(this string text) => text + text;

        public static int Sum(this IEnumerable<int> numbers)
        {
            var sum = 0;
            foreach (var number in numbers)
            {
                sum += number;
            }

            return sum;
        }

        private static readonly char Pad = '*';

        public static string Padded(this string text) => Pad + text + Pad;
    }
}
