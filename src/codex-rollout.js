import { open, stat } from "node:fs/promises";
import * as zlib from "node:zlib";

export function plainRolloutPath(path) { return path.replace(/\.jsonl\.zst$/, ".jsonl"); }

// Codex can replace either representation while readers are resolving a path.
async function resolve(path, inspect) {
  const plain = plainRolloutPath(path);
  for (let attempt = 0; ; attempt++) {
    for (const candidate of [plain, `${plain}.zst`]) {
      try { return { path: candidate, ...await inspect(candidate) }; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (attempt === 3) { const error = new Error("Rollout is missing."); error.code = "ENOENT"; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function rolloutMetadata(path) { return resolve(path, async path => ({ info: await stat(path) })); }
export function openRollout(path) {
  return resolve(path, async path => {
    const handle = await open(path, "r");
    try { return { handle, info: await handle.stat() }; }
    catch (error) { await handle.close(); throw error; }
  });
}

export async function* rolloutChunks({ path, handle }, options = {}) {
  const compressed = path.endsWith(".jsonl.zst");
  if (compressed && typeof zlib.createZstdDecompress !== "function") throw new Error("This runtime cannot decode compressed rollouts.");
  const input = handle.createReadStream({ ...options, autoClose: false });
  const stream = compressed ? zlib.createZstdDecompress() : input;
  if (compressed) { input.on("error", error => stream.destroy(error)); input.pipe(stream); }
  try { for await (const chunk of stream) yield chunk; }
  finally { input.destroy(); if (compressed) stream.destroy(); }
}
