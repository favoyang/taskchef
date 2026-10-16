import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage } from '../src/usage-analytics.js';
const sample=(time,costUsd=1,tokens=100)=>({time:Date.parse(time),costUsd,tokens:{total_tokens:tokens,input_tokens:80,cached_input_tokens:20,output_tokens:20},samples:1,partial:false,costPartial:false});
const family=(id,timeline,partial=false)=>({project:{id,name:id,path:'/repo'},usage:{timeline,analyticsPartial:partial,total:{partial,costPartial:partial}}});
test('month to date uses the view timezone and excludes future and out-of-range calls',()=>{
 const result=aggregateUsage([family('a',[sample('2026-09-30T16:00:00Z'),sample('2026-09-30T15:59:59Z'),sample('2026-10-15T01:00:00Z'),sample('2026-10-15T03:00:00Z')])],{range:'mtd',timeZone:'Asia/Singapore',now:Date.parse('2026-10-15T02:00:00Z')});
 assert.equal(result.start,'2026-10-01');assert.equal(result.days.length,15);assert.equal(result.totals.costUsd,2);assert.equal(result.days[0].tokens,100);assert.equal(result.days[14].tokens,100);
});
test('rolling calendar days survive DST and a year boundary',()=>{
 const result=aggregateUsage([],{range:'7d',timeZone:'America/New_York',now:Date.parse('2027-01-02T01:00:00Z')});
 assert.equal(result.end,'2027-01-01');assert.equal(result.start,'2026-12-26');assert.equal(result.days.length,7);
 const dst=aggregateUsage([family('a',[sample('2026-11-01T05:30:00Z'),sample('2026-11-01T06:30:00Z')])],{range:'7d',timeZone:'America/New_York',now:Date.parse('2026-11-02T12:00:00Z')});
 assert.equal(dst.days.length,7);assert.equal(dst.days.find(day=>day.date==='2026-11-01').costUsd,2);
});
test('projects use stable identity, combine unassigned folders, rank costs, and retain coverage warnings',()=>{
 const result=aggregateUsage([family('a',[sample('2026-10-15T00:00:00Z',2)]),family('b',[sample('2026-10-15T00:00:00Z',4)]),family('a',[sample('2026-10-15T00:00:00Z',3)]),family('projectless',[sample('2026-10-15T00:00:00Z')]),family('projectless',[sample('2026-10-15T00:00:00Z')]),family('missing',[],true)],{range:'30d',timeZone:'UTC',now:Date.parse('2026-10-15T12:00:00Z')});
 assert.equal(result.days.length,30);assert.equal(result.totals.costUsd,11);assert.equal(result.samples,5);assert.equal(result.incomplete,true);
 assert.deepEqual(result.projects.map(item=>[item.id,item.costUsd]),[['a',5],['b',4],['unassigned',2]]);
 assert.equal(result.projects[2].name,'Unassigned');assert.equal(result.days.at(-1).projects.a,5);
});

test('source timestamp failures are visible even with valid priced samples',()=>{
 const item=family('a',[sample('2026-10-15T00:00:00Z')]);item.usage.analyticsPartial=true;
 const result=aggregateUsage([item],{range:'mtd',timeZone:'UTC',now:Date.parse('2026-10-15T12:00:00Z')});assert.equal(result.incomplete,true);assert.equal(result.samples,1);
});

test('old dated price gaps do not mark a complete selected range partial',()=>{
 const old={...sample('2025-01-01T00:00:00Z',0),costPartial:true};
 const item=family('a',[old,sample('2026-10-15T00:00:00Z')]);item.usage.total.costPartial=true;
 const result=aggregateUsage([item],{range:'7d',timeZone:'UTC',now:Date.parse('2026-10-15T12:00:00Z')});assert.equal(result.incomplete,false);assert.equal(result.totals.costUsd,1);
 const within=aggregateUsage([item],{range:'7d',timeZone:'UTC',now:Date.parse('2025-01-02T12:00:00Z')});assert.equal(within.incomplete,true);
});

test('Last month selects the full previous local calendar month across a year boundary and leap year',()=>{
 const jan=aggregateUsage([],{range:'last-month',timeZone:'America/New_York',now:Date.parse('2027-01-15T12:00:00Z')});
 assert.equal(jan.start,'2026-12-01');assert.equal(jan.end,'2026-12-31');assert.equal(jan.days.length,31);
 const march=aggregateUsage([family('a',[sample('2024-02-29T15:59:59Z'),sample('2024-02-29T16:00:00Z')])],{range:'last-month',timeZone:'Asia/Singapore',now:Date.parse('2024-03-15T00:00:00Z')});
 assert.equal(march.start,'2024-02-01');assert.equal(march.end,'2024-02-29');assert.equal(march.days.length,29);assert.equal(march.samples,1);
});

test('project token stacks keep exact daily totals independent of estimated cost',()=>{
 const result=aggregateUsage([family('a',[sample('2026-10-15T00:00:00Z',0,150)]),family('b',[sample('2026-10-15T01:00:00Z',10,25)]),family('a',[sample('2026-10-15T02:00:00Z',2,50)])],{range:'7d',timeZone:'UTC',now:Date.parse('2026-10-15T12:00:00Z')});
 assert.deepEqual(result.days.at(-1).projectTokens,{a:200,b:25});
 assert.equal(Object.values(result.days.at(-1).projectTokens).reduce((a,b)=>a+b,0),result.totals.tokens);
});
test('weekly readings use latest local-day observations per bucket without summing chats',()=>{
 const a=family('a',[]),b=family('b',[]);
 const reading=(time,remainingPercent,id='codex')=>({id,name:null,time:Date.parse(time),remainingPercent,resetsAt:Date.parse('2026-10-20T00:00:00Z')});
 a.usage.weeklyLimits=[reading('2026-10-14T16:00:00Z',80),reading('2026-10-15T01:00:00Z',70),reading('2026-10-15T03:00:00Z',60),reading('2026-09-01T00:00:00Z',95)];
 b.usage.weeklyLimits=[reading('2026-10-15T01:00:00Z',70),reading('2026-10-15T00:00:00Z',90,'other'),reading('2026-10-15T01:00:00Z',NaN)];
 const result=aggregateUsage([a,b],{range:'7d',timeZone:'Asia/Singapore',now:Date.parse('2026-10-15T02:00:00Z')});
 assert.deepEqual(result.weeklyLimits.map(row=>[row.id,row.date,row.remainingPercent]),[['codex','2026-10-15',70]]);
});

 test('current Codex allowance is independent of historical range, excludes model buckets and expires at reset',()=>{
  const a=family('a',[]), now=Date.parse('2026-10-17T00:00:00Z');
  const reading={id:'codex',name:null,time:now-1000,remainingPercent:89,resetsAt:now+86400000};
  a.usage.weeklyLimits=[reading,{...reading,id:'gpt-5.3',time:now-500,remainingPercent:10}];
  const result=aggregateUsage([a],{range:'last-month',timeZone:'Asia/Singapore',now});
  assert.deepEqual(result.weeklyLimits,[]);assert.deepEqual(result.currentWeeklyLimit,reading);
  assert.equal(aggregateUsage([a],{range:'7d',timeZone:'UTC',now:reading.resetsAt}).currentWeeklyLimit,null);
 });
