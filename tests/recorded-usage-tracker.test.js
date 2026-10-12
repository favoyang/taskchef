import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordedUsageTracker } from '../src/recorded-usage-tracker.js';
import { readUsageStore, writeUsageStore } from '../src/usage.js';
const bucket = (total, partial = false) => ({tokens:{input_tokens:total-10,cached_input_tokens:20,output_tokens:10,reasoning_output_tokens:3,total_tokens:total},samples:1,partial,costPartial:partial,costUsd:0.2});
const task = {id:'example',threadId:'0199aabb-ccdd-7eef-8abc-0123456789ab',latestTurn:{turnRef:'native-turn',result:{status:'completed'}},turns:[{}]};
async function setup(t, read) {
  const workspace=await mkdtemp(join(tmpdir(),'taskchef-recorded-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const tracker=createRecordedUsageTracker({workspace,scanner:{recordedUsage:read,close(){}}});
  t.after(()=>tracker.close()); return {workspace,tracker};
}
test('native turn accounting includes child totals and persists incomplete flags',async t=>{
  const {workspace,tracker}=await setup(t,async(id,turn)=>{assert.equal(id,task.threadId);assert.equal(turn,'native-turn');return {matchedTurn:true,latest:bucket(100,true),total:bucket(500,true),subagents:2};});
  await tracker.get(task); const record=(await readUsageStore(workspace)).tasks.example;
  assert.equal(record.task.totalTokens,500);assert.equal(record.task.provenance.provider,'taskchef');assert.equal(record.task.provenance.sessionCount,3);
  assert.equal(record.turns['native-turn'].totalTokens,100);assert.equal(record.turns['native-turn'].partial,true);assert.equal(record.task.costPartial,true);
});
test('unmatched native turn retains chat total without inventing turn usage',async t=>{
  const {tracker}=await setup(t,async()=>({matchedTurn:false,latest:bucket(100),total:bucket(500),subagents:0}));
  const record=await tracker.get(task);assert.equal(record.task.totalTokens,500);assert.equal(record.turns['native-turn'].status,'unavailable');
});
test('a transient read failure retains the known chat subtotal as incomplete',async t=>{
  let fail=false;const {tracker}=await setup(t,async()=>{if(fail)throw Error('missing');return {matchedTurn:true,latest:bucket(100),total:bucket(500),subagents:0};});
  await tracker.get(task);fail=true;const record=await tracker.get(task);
  assert.equal(record.task.totalTokens,500);assert.equal(record.task.partial,true);assert.equal(record.task.costPartial,true);assert.equal(record.turns['native-turn'].status,'available');assert.equal(record.turns['native-turn'].totalTokens,100);assert.equal(record.turns['native-turn'].partial,true);
  const changed=await tracker.get({...task,turns:[{},{}],latestTurn:{turnRef:'other-turn'}});assert.equal(changed.turns['other-turn'].status,'unavailable');
});
test('historical preload stays lazy and simultaneous views share one read',async t=>{
  let calls=0,finish;const {tracker}=await setup(t,()=>{calls++;return new Promise(resolve=>finish=resolve);});
  await tracker.preload([task]);assert.equal(calls,0);
  const first=tracker.get(task),second=tracker.get(task);assert.equal(first,second);assert.equal(calls,1);
  finish({matchedTurn:true,latest:bucket(100),total:bucket(500),subagents:0});await first;
});
test('manual dashboard actions do not query Codex usage',async t=>{
  const {tracker}=await setup(t,()=>{throw Error('must not query');});
  const result=await tracker.get({...task,latestTurn:{...task.latestTurn,provenance:{kind:'dashboard_manual'}}});
  assert.equal(result.turns['native-turn'].status,'unavailable');
});

test('a partial native scan preserves a larger historical projection until a complete scan supersedes it',async t=>{
  let current={matchedTurn:true,latest:bucket(100),total:bucket(500),subagents:0};
  const {workspace,tracker}=await setup(t,async()=>current);
  await tracker.get(task);
  const saved=await readUsageStore(workspace);
  saved.tasks.example.task.provenance={provider:'ccusage',version:'20.0.24',pricingMode:'offline',sessionCount:1};
  await writeUsageStore(workspace,saved);
  current={...current,total:bucket(100,true)};
  const partial=await tracker.get(task);
  assert.equal(partial.task.totalTokens,500);assert.equal(partial.task.partial,true);
  assert.equal(partial.task.estimatedCostUsd,saved.tasks.example.task.estimatedCostUsd);
  assert.equal(partial.task.provenance.provider,'ccusage');
  current={...current,total:bucket(700)};
  const complete=await tracker.get(task);
  assert.equal(complete.task.totalTokens,700);assert.equal(complete.task.partial,false);assert.equal(complete.task.provenance.provider,'taskchef');
});

test('a new unpriced subtotal retains the known historical cost while token totals grow',async t=>{
  let current={matchedTurn:true,latest:bucket(100),total:bucket(500),subagents:0};
  const {tracker}=await setup(t,async()=>current);await tracker.get(task);
  current={...current,total:{...bucket(700),costPartial:true,costUsd:0}};
  const result=await tracker.get(task);assert.equal(result.task.totalTokens,700);
  assert.equal(result.task.estimatedCostUsd,0.2);assert.equal(result.task.costPartial,true);
});


test('same-turn partial rescans retain known tokens and cost; complete corrections may reduce them',async t=>{
 let current={matchedTurn:true,latest:bucket(100),total:bucket(500),subagents:0};
 const {tracker}=await setup(t,async()=>current);await tracker.get(task);
 current={...current,latest:{...bucket(50,true),costUsd:0.1}};
 const partial=await tracker.get(task);assert.equal(partial.turns['native-turn'].totalTokens,100);assert.equal(partial.turns['native-turn'].estimatedCostUsd,0.2);assert.equal(partial.turns['native-turn'].partial,true);
 current={...current,latest:{...bucket(50),costUsd:0.1}};
 const corrected=await tracker.get(task);assert.equal(corrected.turns['native-turn'].totalTokens,50);assert.equal(corrected.turns['native-turn'].estimatedCostUsd,0.1);assert.equal(corrected.turns['native-turn'].partial,false);
});
