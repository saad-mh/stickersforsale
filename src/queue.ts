// Runs one job at a time. A job that fails or hangs never blocks the ones behind it.
export function createQueue(maxWaiting = 5, timeoutMs = 8 * 60_000) {
  let last: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  return function enqueue(job: () => Promise<void>): Promise<void> {
    if (waiting >= maxWaiting) return Promise.reject(new Error('Too many stickers waiting. Try again shortly.'));
    waiting++;
    const result = last.then(() => {
      let timer: NodeJS.Timeout;
      // shortcut: a timed-out job is abandoned, not killed; every step inside has its own limit too.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('That took too long and was given up on.')), timeoutMs);
      });
      return Promise.race([job(), timeout]).finally(() => clearTimeout(timer));
    }).finally(() => waiting--);
    last = result.catch(() => {});
    return result;
  };
}
