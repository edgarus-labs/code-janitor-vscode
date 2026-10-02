using System;
using System.Collections.Generic;
using System.Linq;

namespace Oracle
{
    internal sealed record Snapshot(int Count, string Names, int[] Items);

    /// <summary>Lambdas whose body is a <c>with</c> expression that reads locals, parameters and fields.</summary>
    internal sealed class WithExpressions
    {
        private readonly int _offset = 3;
        private Snapshot _state = new Snapshot(0, "", Array.Empty<int>());

        public Snapshot Update(int[] devices, int now)
        {
            var tracked = devices.Where(d => d > 0).ToArray();
            Apply(current => current with
            {
                Count = tracked.Any(item => item > 1) ? now : current.Count,
                Names = string.Join(",", devices.Select(item => item.ToString())),
                Items = tracked,
            });

            Apply(current => current with { Count = current.Count + _offset });

            return _state;
        }

        public Snapshot Chain(Snapshot first) => first with { Count = 1 } with { Names = "chained" };

        private void Apply(Func<Snapshot, Snapshot> change) => _state = change(_state);
    }
}
