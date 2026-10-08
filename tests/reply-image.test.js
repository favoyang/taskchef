import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replyImage, localReplyImage } from '../src/reply-image.js';

test('covers use actual Markdown images including references and spaced paths', () => {
  assert.deepEqual(replyImage('```\n![fake](/fake.png)\n```\n![Design](</local/design (2).png>)\n![Other](https://example.com/other.png)'), {url:'/local/design (2).png',alt:'Design'});
  assert.deepEqual(replyImage('![Chart][result]\n\n[result]: https://example.com/chart.png'),{url:'https://example.com/chart.png',alt:'Chart'});
  assert.equal(replyImage('<img src="/fake.png">\n![bad](javascript:alert)\n![relative](chart.png)\n![host](//host/a.png)'),null);
});

test('local covers are bounded raster files; paths and active content are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(),'taskchef-cover-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/kcAAAAASUVORK5CYII=','base64');
    const path=join(root,'cover.png');await writeFile(path,png);
    assert.equal(await localReplyImage(path),`data:image/png;base64,${png.toString('base64')}`);
    assert.equal(await localReplyImage('https://example.com/a.png'),null);
    assert.equal(await localReplyImage('relative.png'),null);
    await writeFile(path,'<svg><script>alert(1)</script></svg>');assert.equal(await localReplyImage(path),null);
    await writeFile(path,Buffer.alloc(4*1024*1024+1));assert.equal(await localReplyImage(path),null);
  } finally {await rm(root,{recursive:true,force:true});}
});
