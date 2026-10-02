using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace Oracle.Reorganize
{
    /// <summary>
    /// Prints the value of every static field of every type and the instance fields of every type that can be
    /// created without arguments, so that the behaviour of the initializers can be compared after reorganizing.
    /// </summary>
    internal static class Program
    {
        private const BindingFlags All = BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

        private static void Main()
        {
            var output = new StringBuilder();
            var types = typeof(Program).Assembly.GetTypes()
                .Where(type => type != typeof(Program) && !type.IsGenericTypeDefinition && !type.Name.StartsWith("<", StringComparison.Ordinal))
                .OrderBy(type => type.FullName, StringComparer.Ordinal);

            foreach (var type in types)
            {
                RuntimeHelpers.RunClassConstructor(type.TypeHandle);

                foreach (var field in type.GetFields(All).Where(field => field.IsStatic && !field.IsLiteral).OrderBy(field => field.Name, StringComparer.Ordinal))
                {
                    output.AppendLine($"{type.FullName}.{field.Name} = {Format(field.GetValue(null))}");
                }

                if (type.IsAbstract || type.IsInterface || typeof(Delegate).IsAssignableFrom(type) || (type.IsClass && type.GetConstructor(Type.EmptyTypes) == null))
                {
                    continue;
                }

                var instance = Activator.CreateInstance(type)!;
                foreach (var field in type.GetFields(All).Where(field => !field.IsStatic).OrderBy(field => field.Name, StringComparer.Ordinal))
                {
                    output.AppendLine($"{type.FullName}#{field.Name} = {Format(field.GetValue(instance))}");
                }
            }

            Console.Write(output);
        }

        private static string Format(object? value)
        {
            return value switch
            {
                null => "null",
                string text => "\"" + text + "\"",
                IEnumerable sequence => "[" + string.Join(", ", sequence.Cast<object?>().Select(Format)) + "]",
                _ when value.GetType().IsValueType && !value.GetType().IsPrimitive && !value.GetType().IsEnum && value.ToString() == value.GetType().ToString() => FormatFields(value),
                _ => value.ToString() ?? "?",
            };
        }

        private static string FormatFields(object value)
        {
            var fields = value.GetType().GetFields(All).Where(field => !field.IsStatic).OrderBy(field => field.Name, StringComparer.Ordinal);

            return "{" + string.Join(", ", fields.Select(field => field.Name + "=" + Format(field.GetValue(value)))) + "}";
        }
    }
}
