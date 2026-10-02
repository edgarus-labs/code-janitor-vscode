using System;
using System.Collections.Generic;

namespace Oracle.Reorganize
{
    /// <summary>A class with every kind of member, in the order nobody would choose.</summary>
    [Serializable]
    public partial class Kitchen : IKitchenItem, IDisposable
    {
        public void Zebra() { }

        // The last resort.
        private int Hidden() => _count;

        public static Kitchen operator +(Kitchen a, Kitchen b) => new Kitchen { Name = a.Name + b.Name };

        public static implicit operator string(Kitchen kitchen) => kitchen.Name;

        ~Kitchen() { }

        public delegate void Notify(string message);

        public event Notify? Notified;
        public event EventHandler? Closed { add { } remove { } }

        private readonly int _readOnly = 3;
        private static readonly string Separator = "-";
        public const int MaxItems = 10;
        public static int Instances;
        private int _count;
        protected internal string Tag = "tag";
        internal int InternalField;
        private protected int PrivateProtectedField;
        public readonly List<string> Shelves = new List<string>();

        static Kitchen() { Instances = 1; }
        public Kitchen() { _count = 1; }
        protected Kitchen(int count) { _count = count; }

        public string Name { get; set; } = "kitchen";
        protected int Level { get; private set; }
        public int this[int index] { get => index + _count; }
        string IKitchenItem.Describe() => Name + Separator + _readOnly;

        void IDisposable.Dispose() { }

        public enum Mode { Off, On }

        public interface IHelper { void Help(); }

        public struct Point
        {
            public int Y;
            public int X;
        }

        public class Helper : IHelper
        {
            public void Help() { }
            private int _x = 1;
            public Helper() { }
        }

        private class Secret { public int Value = 7; }

        /// <summary>
        /// Cooks with the given mode.
        /// </summary>
        /// <param name="mode">The mode.</param>
        [Obsolete("Use Static1.")]
        public void Alpha(Mode mode = Mode.On)
        {
            if (mode == Mode.On)
            {
                _count++;
            }
        }

        public static void Static1() { }

        protected virtual void Beta() { }

        internal void Gamma() { }
    }

    public interface IKitchenItem
    {
        string Describe();

        string Name { get; }
    }
}
