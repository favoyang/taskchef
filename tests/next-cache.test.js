import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCache } from '../src/next-cache.js';
async function fixture(t) {const root=await mkdtemp(join(tmpdir(),'taskchef-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('concurrent migrations move a legacy cache once',async t=>{
  const root=await fixture(t),old=join(root,'pricing.json'),next=join(root,'cache','pricing.json');await writeFile(old,'legacy');
  await Promise.all([migrateCache(old,next),migrateCache(old,next)]);assert.equal(await readFile(next,'utf8'),'legacy');
  await assert.rejects(readFile(old),{code:'ENOENT'});
});
test('migration preserves a newer destination',async t=>{
  const root=await fixture(t),old=join(root,'old.json'),next=join(root,'cache','new.json');await mkdir(join(root,'cache'));await writeFile(old,'old');await writeFile(next,'new');
  await migrateCache(old,next);assert.equal(await readFile(next,'utf8'),'new');
});
test('usage directories migrate and absent legacy data is harmless',async t=>{
  const root=await fixture(t),old=join(root,'usage-cache'),next=join(root,'cache','usage');await mkdir(old);await writeFile(join(old,'chat.json'),'usage');
  await migrateCache(old,next);assert.equal(await readFile(join(next,'chat.json'),'utf8'),'usage');await migrateCache(join(root,'absent'),join(root,'cache','absent'));
});
