using System.Threading;
using System.Threading.Tasks;

namespace Oracle.Regressions
{
    // Constructs from GuardClauses and MediatR that cleanup once broke.
    public interface IHandler<TMessage>
    {
        Task Handle(TMessage message, CancellationToken cancellationToken);
    }

    public abstract class Handler<TMessage> : IHandler<TMessage>
    {
        Task IHandler<TMessage>.Handle(TMessage message, CancellationToken cancellationToken)
        {
            Handle(message);
            return Task.CompletedTask;
        }

        protected abstract void Handle(TMessage message);

        public static async Task<T> CheckAsync<T>(Func<T, Task<bool>> func, T input)
        {
            if (await func(input))
            {
                throw new ArgumentException("rejected");
            }

            return input;
        }

        private IEnumerable<(Type ExceptionType, object Action)> ActionsFor(Type exceptionType)
        {
            yield return (exceptionType, this);
        }

        public int CountActions(Type exceptionType)
        {
            int count = 0;
            foreach (var action in ActionsFor(exceptionType))
            {
                count++;
            }

            return count;
        }
    }
}
