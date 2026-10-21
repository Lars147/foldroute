interface JobResult<T> {
  index: number;
  value?: T;
  error?: unknown;
}

/** Publish completed jobs individually; one service failure never cancels its siblings. */
export async function* pool<T>(
  jobs: ((signal: AbortSignal) => Promise<T>)[],
  signal: AbortSignal,
  canStart = () => true,
): AsyncGenerator<JobResult<T>> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const pending = new Map<number, Promise<JobResult<T>>>();
  let next = 0;
  function submit() {
    while (pending.size < 2 && next < jobs.length && canStart()) {
      const index = next++;
      pending.set(
        index,
        jobs[index](combined).then(
          (value) => ({ index, value }),
          (error) => ({ index, error }),
        ),
      );
    }
  }
  try {
    submit();
    while (pending.size) {
      signal.throwIfAborted();
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      yield result;
      signal.throwIfAborted();
      submit();
    }
  } finally {
    controller.abort();
  }
}
