using System;
using System.Text.Json;

namespace Oracle
{
    /// <summary>Plain <c>new JsonSerializerOptions()</c> arguments: a positional null would be ambiguous.</summary>
    internal sealed class JsonOptionsCalls
    {
        public string Serialize(object value) => JsonSerializer.Serialize(value, new JsonSerializerOptions());

        public string SerializeNamed(object value) => JsonSerializer.Serialize(value, options: new JsonSerializerOptions());

        public T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions());

        public object? DeserializeAs(string json, Type type) => JsonSerializer.Deserialize(json, type, new JsonSerializerOptions());

        public string Qualified(object value) => System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions());
    }
}
