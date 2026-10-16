import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeDurableAtomic } from "./state-store.js";

const nonnegative = z.number().finite().nonnegative();
const timestamp = nonnegative.max(8.64e15);
// Keep only fields needed by aggregateUsage, not message content or per-file records.
const family = z.object({
  project: z.object({ id: z.string().nullable().optional(), name: z.string(), path: z.string().optional() }),
  usage: z.object({
    analyticsPartial: z.boolean().optional(), partial: z.boolean().optional(),
    timeline: z.array(z.object({
      time: timestamp, costUsd: nonnegative, samples: nonnegative.int(),
      partial: z.boolean(), costPartial: z.boolean(),
      tokens: z.object({ total_tokens: nonnegative.int(), input_tokens: nonnegative.int(), cached_input_tokens: nonnegative.int(), output_tokens: nonnegative.int() }),
    })),
    weeklyLimits: z.array(z.object({
      id: z.string(), name: z.string().nullable(), time: timestamp,
      remainingPercent: nonnegative.max(100), resetsAt: timestamp,
    })).optional(),
  }),
});
const snapshot = z.object({ version: z.literal(1), scope: z.string(), savedAt: timestamp, families: z.array(family) });
const cachePath = (directory, scope) => join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);

export async function readUsageHistory(directory, scope) {
  try {
    const value = snapshot.parse(JSON.parse(await readFile(cachePath(directory, scope), "utf8")));
    return value.scope === scope && value.savedAt <= Date.now() ? value : null;
  } catch { return null; } // Missing, incompatible, or damaged caches rebuild from source.
}

export async function writeUsageHistory(directory, scope, families, savedAt) {
  const value = snapshot.parse({ version: 1, scope, savedAt, families });
  await writeDurableAtomic(cachePath(directory, scope), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
