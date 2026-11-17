/** Runs async work one call at a time, in order. A failure does not block the calls behind it. */
export function createExclusive(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };
}
