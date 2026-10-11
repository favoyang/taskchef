import type { Task } from "./types";

// Covers and Details reuse the same request. Bound retained image data per board.
export function cachedImageLoader(load: (task: Task, url?: string) => Promise<string | null>) {
  const cache = new Map<string, { promise: Promise<string | null>; bytes: number }>();
  let bytes = 0;
  return (task: Task, url?: string): Promise<string | null> => {
    const key = JSON.stringify([task.id, task.turnId, url]);
    const existing = cache.get(key);
    if (existing) { cache.delete(key); cache.set(key, existing); return existing.promise; }
    const entry = { bytes: 0, promise: Promise.resolve(null) as Promise<string | null> };
    entry.promise = load(task, url).then(source => {
      if (!source) { if (cache.get(key) === entry) cache.delete(key); return null; }
      if (cache.get(key) === entry) {
        entry.bytes = source.length * 2;
        bytes += entry.bytes;
        while (cache.size > 64 || bytes > 32 * 1024 * 1024) {
          const oldest = cache.keys().next().value!;
          bytes -= cache.get(oldest)!.bytes;
          cache.delete(oldest);
        }
      }
      return source;
    }, error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
    cache.set(key, entry);
    while (cache.size > 64) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    return entry.promise;
  };
}
