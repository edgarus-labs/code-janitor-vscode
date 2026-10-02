// The namespaces and types the files of Outward/ and Inward/ use. Names repeat on purpose: a global
// Services next to Company.App.Services, a Foo in Company and in Company.App.Models, and so on.
using System;
using System.Collections.Generic;

namespace Services
{
    public class Svc
    {
        public string GlobalOnly => "global";
    }
}

namespace Data
{
    public class Repo
    {
        public string GlobalRepo => "global";
    }
}

namespace Company
{
    public class Foo
    {
        public string CompanyFoo => "company";
    }

    public static class OuterExt
    {
        public static int Shout(this object value) => 1;
    }
}

namespace Company.Shared
{
    public class Util
    {
    }
}

namespace Company.App.Services
{
    public class Svc
    {
        public string AppOnly => "app";
    }

    public class OnlyApp
    {
    }
}

namespace Company.App.Data
{
    public class Repo
    {
        public string AppRepo => "app";
    }
}

namespace Company.App.Models
{
    public class Foo
    {
        public string ModelsFoo => "models";
    }

    public class Bar
    {
    }

    public static class ModelHelpers
    {
        public static int Twice(int x) => x * 2;
    }

    public static class Holder
    {
        public class Inner
        {
        }
    }
}

namespace Company.App.Text
{
    public static class StringExt
    {
        public static string Shout(this string value) => "string";

        public static string Whisper(this string value) => value;
    }
}

namespace Company.App.Ext
{
    public static class NumberExt
    {
        public static int Doubled(this int value) => value * 2;
    }
}

namespace Company.App.Extra
{
    public static class MoreLinq
    {
        public static IEnumerable<int> Where(this IEnumerable<int> source, Func<int, bool> predicate) => source;
    }
}

namespace Company.App.Clocks
{
    public class Timer
    {
    }
}

namespace Alpha
{
    public class T
    {
    }
}

namespace Beta
{
    public class T
    {
    }
}

namespace AliasRival
{
    public class X
    {
        public int Only;
    }
}

namespace Archive
{
    public class Entry
    {
        public string GlobalEntry => "global";
    }
}

namespace Company
{
    public class Result
    {
        public string CompanyResult => "company";
    }
}

namespace Company.App
{
    public class Result<T>
    {
    }

    public class Helpers<T>
    {
    }
}

namespace Vendor
{
    public static class Helpers
    {
        public static int Twice(int x) => x * 2;
    }
}
