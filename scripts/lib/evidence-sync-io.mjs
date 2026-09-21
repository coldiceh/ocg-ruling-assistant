/** Run independent cache I/O concurrently, draining in-flight work before throwing. */
export async function mapCacheIo(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let cursor = 0, failure = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await fn(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
