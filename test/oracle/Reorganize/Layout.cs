using System.Runtime.InteropServices;

namespace Oracle.Reorganize
{
    /// <summary>A struct is laid out in the order of its instance fields: the offsets are part of its behaviour.</summary>
    public struct Native
    {
        public void Reset() => Size = 0;
        public int Size;
        public byte Flags;
        public long Address;
    }

    public static class NativeLayout
    {
        public static readonly int AddressOffset = (int)Marshal.OffsetOf<Native>(nameof(Native.Address));
        public static readonly int FlagsOffset = (int)Marshal.OffsetOf<Native>(nameof(Native.Flags));
    }
}
