using System.Threading;
using System.Threading.Tasks;

namespace Oracle.Async
{
    public class Worker
    {
        private readonly SemaphoreSlim semaphore = new SemaphoreSlim(1);

        public async Task<int> RunAsync(CancellationToken token)
        {
            await semaphore.WaitAsync(token).ConfigureAwait(false);
            try
            {
                return await ComputeAsync().ConfigureAwait(false);
            }
            finally
            {
                semaphore.Release();
            }
        }

        private static async ValueTask<int> ComputeAsync()
        {
            await Task.Yield();
            return 1;
        }

        public async IAsyncEnumerable<int> StreamAsync()
        {
            for (int i = 0; i < 3; i++)
            {
                await Task.Delay(1);
                yield return i;
            }
        }

        public async Task ConsumeAsync()
        {
            await foreach (var item in StreamAsync())
            {
                Console.WriteLine(item);
            }
        }
    }
}
