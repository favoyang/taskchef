import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeRecords, CodexSessionUsage } from '../src/codex-session-usage.js';
import { parsePricing, estimateCallCost, CodexPricing } from '../src/codex-pricing.js';
const models = JSON.parse(await readFile(new URL('../src/data/codex-pricing.json',import.meta.url),'utf8')).models;
const tokens = (input, output=10) => ({input_tokens:input,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output});
const record = (time,turn,total,last,extra={})=>({kind:'usage',time,order:time,turn,model:'gpt-6.1-sol',total,last,...extra});

test('a missing middle call does not block later turn usage; chat total stays independent',()=>{
 const rows=[record(1,'a',tokens(100),tokens(100)), record(2,'b',tokens(400,30),tokens(100)), record(3,'c',tokens(500,40),tokens(100))];
 const b=summarizeRecords(rows,'b',models);assert.equal(b.latest.tokens.total_tokens,110);assert.equal(b.latest.partial,true);assert.equal(b.total.tokens.total_tokens,540);assert.equal(b.total.costPartial,true);
 const c=summarizeRecords(rows,'c',models);assert.equal(c.latest.tokens.total_tokens,110);assert.equal(c.latest.partial,false);
});
test('copied history, inherited counters and repeated notifications are counted once',()=>{
 const a=record(1,'a',tokens(100),tokens(100)); const b=record(2,'b',tokens(200,20),tokens(100));
 const s=summarizeRecords([a,a,b,{...b,time:3}],'b',models);assert.equal(s.total.tokens.total_tokens,220);assert.equal(s.latest.tokens.total_tokens,110);assert.equal(s.total.partial,false);
});
test('counter correction is partial locally and later calls still work',()=>{
 const s=summarizeRecords([record(1,'a',tokens(100),tokens(100)),record(2,'b',tokens(50),tokens(20)),record(3,'c',tokens(150,20),tokens(100))],'c',models);
 assert.equal(s.total.partial,true);assert.equal(s.latest.partial,false);assert.equal(s.latest.tokens.total_tokens,110);
});
test('subagents use root turn rather than their own turn',()=>{
 const s=summarizeRecords([record(1,'child',tokens(100),tokens(100),{root:'parent'})],'parent',models,true);
 assert.equal(s.latest.tokens.total_tokens,110);assert.equal(summarizeRecords([record(1,'child',tokens(100),tokens(100),{root:'older'})],'parent',models,true).latest.samples,0);
});
test('prices account for cache reads/writes and do not add reasoning output twice',()=>{
 const u={...tokens(1000000,1000000),cached_input_tokens:200000,cache_write_input_tokens:100000,reasoning_output_tokens:500000};
 assert.equal(estimateCallCost(u,'gpt-6.1-sol',models),18.34); // Long-context rates.
 assert.equal(estimateCallCost(u,'unknown-model',models),null);
 const s=summarizeRecords([record(1,'a',tokens(100),tokens(100),{model:'unknown-model'})],'a',models);assert.equal(s.total.costPartial,true);assert.equal(s.total.tokens.total_tokens,110);
});
test('pricing parser selects standard rates and rejects changed formats',()=>{
 const table='### Standard pricing data\n| gpt-6.1-sol | $2 | $0.1 | $2.5 | $10 | $4 | $0.2 | $5 | $15 |\n| gpt-6-luna | $0.1 | $0.01 | $0.125 | $0.5 | $0.2 | $0.02 | $0.25 | $0.75 |\nBatch\n| gpt-6.1-sol | $1 | $0 | $0 | $5 | $2 | $0 | $0 | $7.5 |';
 assert.equal(parsePricing(table)['gpt-6.1-sol'].short[0],2);assert.throws(()=>parsePricing('broken'));
});
test('offline pricing retains the bundled table and invalid live updates cannot replace it',async()=>{
 const p=new CodexPricing({fetchImpl:async()=>({ok:true,text:async()=> 'broken'})});
 assert.equal((await p.get()).models['gpt-6.1-sol'].short[0],2);await p.pending;
 assert.equal((await p.get()).models['gpt-6.1-sol'].short[0],2);
});
test('reader scans old rollouts once, appends incrementally, handles truncation and unfinished lines',async t=>{
 const home=await mkdtemp(join(tmpdir(),'taskchef-usage-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(join(home,'sessions'));
 const path=join(home,'sessions','rollout-date-parent.jsonl');
 let reads=0;const reader=new CodexSessionUsage({codexHome:home,pricing:{get:async()=>({date:'2026-10-10',models})}});
 const line=(type,payload)=>JSON.stringify({timestamp:'2026-10-10T00:00:00Z',type,payload})+'\n';
 const start=line('session_meta',{id:'parent'})+line('turn_context',{turn_id:'a',model:'gpt-6.1-sol'});
 const count=(total,last)=>line('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:last}});
 await writeFile(path,start+count(tokens(100),tokens(100))+line('event_msg',{type:'task_complete',turn_id:'a',duration_ms:1000}));
 const options={id:'parent',latestTurnId:'a',sessions:[{id:'parent',rollout_path:path}],savedDurations:[{turn_id:'db-only',duration_ms:2000}]};
 const first=await reader.read(options);assert.equal(first.total.tokens.total_tokens,110);assert.equal(first.durationMs,3000);
 const records=reader.files.get(path).records;await reader.read(options);assert.equal(reader.files.get(path).records,records);
 const next=count(tokens(200,20),tokens(100));await appendFile(path,next.slice(0,-3));assert.equal((await reader.read(options)).total.tokens.total_tokens,110);
 await appendFile(path,next.slice(-3));assert.equal((await reader.read(options)).total.tokens.total_tokens,220);
 await writeFile(path,start+count(tokens(10),tokens(10)));assert.equal((await reader.read(options)).total.tokens.total_tokens,20);
});

test('invalid records mark only their affected latest turn partial',()=>{
 const valid=record(1,'latest',tokens(100),tokens(100));
 const bad=record(2,'latest',tokens(200),null);
 const affected=summarizeRecords([valid,bad],'latest',models);
 assert.equal(affected.latest.partial,true);assert.equal(affected.latest.costPartial,true);
 const other=summarizeRecords([valid,{...bad,turn:'old'}],'latest',models);
 assert.equal(other.latest.partial,false);assert.equal(other.total.partial,true);
});
test('missing linked histories mark totals and current usage partial',async t=>{
 const home=await mkdtemp(join(tmpdir(),'taskchef-usage-missing-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const reader=new CodexSessionUsage({codexHome:home,pricing:{get:async()=>({date:'2026-10-10',models})}});
 const result=await reader.read({id:'parent',latestTurnId:'latest',sessions:[{id:'parent'},{id:'child'}]});
 assert.equal(result.latest.partial,true);assert.equal(result.total.partial,true);assert.equal(result.partial,true);
});
test('old malformed records do not poison later complete usage',()=>{
 const s=summarizeRecords([{kind:'issue',time:0,turn:'old'},record(1,'latest',tokens(100),tokens(100))],'latest',models);
 assert.equal(s.total.partial,true);assert.equal(s.latest.partial,false);
});
test('nested child usage and copied parent histories count once without adding child work time',async t=>{
 const home=await mkdtemp(join(tmpdir(),'taskchef-usage-family-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(join(home,'sessions'));
 const sessions=[];
 for (const [id,model] of [['parent','gpt-6.1-sol'],['child','gpt-6-sol'],['nested','gpt-6-luna']]) {
  const path=join(home,'sessions',`rollout-date-${id}.jsonl`);
  const lines=[{type:'session_meta',payload:{id}},{type:'turn_context',payload:{turn_id:id==='parent'?'latest':id,root_turn_id:'latest',model}},{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:tokens(100),last_token_usage:tokens(100)}}},{type:'event_msg',payload:{type:'task_complete',turn_id:id==='parent'?'latest':id,duration_ms:id==='parent'?1000:999999}}];
  const contents=lines.map(row=>JSON.stringify({timestamp:'2026-10-10T00:00:00Z',...row})+'\n').join('');
  await writeFile(path,contents);sessions.push({id,rollout_path:path});
  if(id==='parent')await writeFile(join(home,'sessions','rollout-copy-parent_old.jsonl'),contents);
 }
 const reader=new CodexSessionUsage({codexHome:home,pricing:{get:async()=>({date:'2026-10-10',models})}});
 const options={id:'parent',latestTurnId:'latest',sessions};const result=await reader.read(options);
 assert.equal(result.total.tokens.total_tokens,330);assert.equal(result.latest.tokens.total_tokens,330);assert.equal(result.subagents,2);assert.equal(result.durationMs,1000);assert.equal(result.total.partial,false);
 assert.equal(await reader.read(options),result);
});

test('valid cumulative boundaries survive a missing last-call counter',()=>{
 const rows=[record(1,'old',tokens(100),tokens(100)),record(2,'gap',tokens(200,20),null),record(3,'latest',tokens(300,30),tokens(100))];
 const s=summarizeRecords(rows,'latest',models);
 assert.equal(s.latest.tokens.total_tokens,110);assert.equal(s.latest.partial,false);assert.equal(s.latest.costPartial,false);assert.equal(s.total.tokens.total_tokens,330);assert.equal(s.total.costPartial,true);
});
test('compressed old rollouts are discovered, decoded, cached and joined with selected plain rollouts',async t=>{
 const zlib=await import('node:zlib');if(!zlib.zstdCompressSync){t.skip('zstd is unavailable in this Node runtime');return;}
 const home=await mkdtemp(join(tmpdir(),'taskchef-usage-zstd-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(join(home,'archived_sessions'));
 const row=(type,payload,time=1)=>JSON.stringify({type,timestamp:`2026-10-10T00:00:0${time}Z`,payload})+'\n';
 const contents=row('session_meta',{id:'parent'})+row('turn_context',{turn_id:'old',model:'gpt-6.1-sol'})+row('event_msg',{type:'token_count',info:{total_token_usage:tokens(100),last_token_usage:tokens(100)}})+row('event_msg',{type:'task_complete',turn_id:'old',duration_ms:1000});
 const path=join(home,'archived_sessions','rollout-old-parent.jsonl.zst');await writeFile(path,zlib.zstdCompressSync(contents));
 const selected=join(home,'selected.jsonl');await writeFile(selected,row('session_meta',{id:'parent'},2)+row('turn_context',{turn_id:'latest',model:'gpt-6.1-sol'},2)+row('event_msg',{type:'token_count',info:{total_token_usage:tokens(200,20),last_token_usage:tokens(100)}},2));
 const reader=new CodexSessionUsage({codexHome:home,pricing:{get:async()=>({date:'2026-10-10',models})}});
 const opts={id:'parent',latestTurnId:'latest',sessions:[{id:'parent',rollout_path:selected}]};
 const s=await reader.read(opts);assert.equal(s.total.tokens.total_tokens,220);assert.equal(s.latest.tokens.total_tokens,110);assert.equal(s.durationMs,1000);assert.equal(s.total.partial,false);
 assert.equal(await reader.read(opts),s);
});
