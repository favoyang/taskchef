import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Keep licensed source music local, outside the plugin package and Git history.
const directory = new URL('./public/', import.meta.url);
await mkdir(directory, { recursive: true });
await copyFile(new URL('../assets/taskchef-dark.svg', import.meta.url), new URL('taskchef-dark.svg', directory));
const target = new URL('tech-house-vibes.mp3', directory);
const expected = '95972c602ff0686e298792f45b384f0e15477f3cf983f05dd98fd5e5d965eed6';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let cached;
try { cached = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!cached || hash(cached) !== expected) {
  const response = await fetch('https://assets.mixkit.co/music/130/130.mp3', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Music download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw new Error('Music changed at its source. Review the asset before updating its checksum.');
  await writeFile(target, bytes);
}
