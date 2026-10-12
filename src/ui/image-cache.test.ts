import { expect, test, vi } from "vitest";
import { cachedImageLoader } from "./image-cache";
import { fixtureTask } from "./fixtures";

test('covers and Details share in-flight and completed image requests, scoped to turn and chat', async () => {
  const load = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
  const cached = cachedImageLoader(load); const task = {...fixtureTask(), turnId:'turn-1'};
  const first = cached(task,'/image.png');
  expect(cached(task,'/image.png')).toBe(first);
  await first; await cached(task,'/image.png');
  expect(load).toHaveBeenCalledTimes(1);
  await cached({...task,turnId:'turn-2'},'/image.png');
  await cached({...task,id:'other-chat'},'/image.png');
  expect(load).toHaveBeenCalledTimes(3);
});
test('failed and missing images can be retried', async () => {
  const load = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline')).mockResolvedValue('data:image/png;base64,AAAA');
  const cached = cachedImageLoader(load); const task = fixtureTask();
  expect(await cached(task,'/image.png')).toBeNull();
  await expect(cached(task,'/image.png')).rejects.toThrow('offline');
  expect(await cached(task,'/image.png')).toContain('data:image/png');
  expect(load).toHaveBeenCalledTimes(3);
});
