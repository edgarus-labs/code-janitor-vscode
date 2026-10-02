using System;
using System.Runtime.InteropServices;

namespace Oracle.Reorganize
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Packed
    {
        public byte A;
        public int B;
        public short C;
        public void Reset() { A = 0; }
    }

    [Flags]
    public enum Permissions
    {
        Write = 2,
        Read = 1,
        Execute = 4,
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct Overlay
    {
        [FieldOffset(4)] public int High;
        [FieldOffset(0)] public int Low;
        [FieldOffset(0)] public long Both;
    }
}
