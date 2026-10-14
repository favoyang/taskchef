import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRollout, rolloutMetadata, rolloutChunks } from '../src/codex-rollout.js';
import * as zlib from 'node:zlib';

test('rollout resolution retries a missing representation during publication', async t => {
  if (!zlib.zstdCompressSync) { t.skip('zstd is unavailable'); return; }
  const home = await mkdtemp(join(tmpdir(), 'taskchef-rollout-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'selected.jsonl');
  const opening = openRollout(path);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(path + '.zst', zlib.zstdCompressSync('one\ntwo\n'));
  const source = await opening;
  try {
    assert.equal(source.path, path + '.zst');
    const chunks = [];
    for await (const chunk of rolloutChunks(source)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'one\ntwo\n');
  } finally { await source.handle.close(); }
  await writeFile(path, 'restored\n');
  assert.equal((await rolloutMetadata(path + '.zst')).path, path);
});
