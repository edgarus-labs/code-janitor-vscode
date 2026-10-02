using System;
using System.ComponentModel;
using System.Diagnostics.CodeAnalysis;

namespace Oracle.Reorganize
{
    [AttributeUsage(AttributeTargets.All)]
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(string name) { Name = name; }

        public string Name { get; }
    }

    [Marker("type")]
    public class Widget
    {
        /// <summary>
        /// The size.
        /// </summary>
        [Marker("size"), DefaultValue(3)]
        [Description("Size of the widget")]
        public int Size { get; set; } = 3;

        [Marker("run")]
        // A comment between the attribute and the member is part of the member.
        public void Run() { }

        /* A block comment above. */
        [Obsolete]
        public void Old() { }

        [field: NonSerialized]
        public event Action? Changed;

        [SuppressMessage("Usage", "CA1801")]
        public int Compute(int unused) => 1; // trailing

        [Marker("ctor")]
        public Widget() { }

        [Marker("const")]
        public const string Name = "widget";
    }
}
