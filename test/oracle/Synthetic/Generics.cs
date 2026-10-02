using System.Collections.ObjectModel;

namespace Oracle.Generics
{
    public class Repository<TEntity, TKey>
        where TEntity : class, new()
        where TKey : notnull
    {
        private readonly Dictionary<TKey, TEntity> items = new Dictionary<TKey, TEntity>();

        public TEntity GetOrCreate(TKey key)
        {
            if (!items.TryGetValue(key, out TEntity? entity))
            {
                entity = new TEntity();
                items[key] = entity;
            }

            return entity;
        }

        public static TEntity? Default() => default(TEntity);

        public string Name() => nameof(Dictionary<TKey, TEntity>);

        public ReadOnlyCollection<TEntity> All() => new ReadOnlyCollection<TEntity>(new List<TEntity>(items.Values));

        public T Echo<T>(T value) => value;
    }

    public interface IFactory<out T>
    {
        T Create();
    }

    public sealed class Box<T>(T value)
    {
        public T Value { get; } = value;
    }
}
