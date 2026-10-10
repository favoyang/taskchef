import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextGitHub, pullRequestIdentity } from "../src/next-github.js";

const url = "https://github.com/example/repo/pull/12";
const client = "Iv1.test";
const task = (extra = {}) => ({ id: "chat", turnId: "turn", status: "needs_input", pullRequests: [{ url }], observed: { archive: false, source: "vscode", lastTurnEvent: "completed" }, ...extra });
const settings = { githubClientId: client, showCli: false, showExec: false };
async function setup(t, replies, initial = {}) {
  const dir = await mkdtemp(join(tmpdir(), "taskchef-github-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  let credential = initial;
  let time = 100_000;
  const requests = [];
  const ciRequests = [];
  let lastResponse;
  const credentials = { read: async () => structuredClone(credential), write: async (_, next) => { credential = structuredClone(next); }, remove: async () => { credential = {}; } };
  const github = new NextGitHub({ stateDir: dir, now: () => time, credentials, fetch: async (url, options) => {
    if (url.includes("/commits/")) {
      ciRequests.push({url,options});
      const rollup = lastResponse?.data?.p0?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const state=rollup?.state;
      const payload=url.includes("/check-runs") ? {total_count:rollup===null?0:1,check_runs:rollup===null?[]:[{status:["PENDING","EXPECTED"].includes(state)?"in_progress":"completed",conclusion:state==="SUCCESS"?"success":["ERROR","FAILURE"].includes(state)?"failure":"unrecognized"}]} : {total_count:0,state:"pending"};
      return {ok:true,status:200,json:async()=>payload};
    }
    requests.push({ url, options });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, `Unexpected request: ${url}`);
    lastResponse = next;
    return { ok: !next.httpError, status: next.httpError ?? 200, json: async () => next };
  } });
  return { github, requests, ciRequests, credentials, dir, read: () => credential, advance: (ms) => { time += ms; } };
}
const signedIn = { token: "private-token", login: "tester" };
const response = (merged = false, state = "OPEN", checks = "SUCCESS", extra = {}) => ({ data: { p0: { pullRequest: { merged, state, headRefOid:"a".repeat(40), isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] }, ...extra } } } });

test("only exact GitHub PR URLs become query identities", () => {
  assert.equal(pullRequestIdentity("https://evil.test/repo/pull/12"), null);
  assert.equal(pullRequestIdentity("https://github.com/example/repo/pull/12?token=x"), null);
  assert.equal(pullRequestIdentity("javascript:alert(1)"), null);
  assert.deepEqual(pullRequestIdentity(url), { owner: "example", repo: "repo", number: 12, url });
});
test("device sign-in keeps device/access/refresh secrets out of UI responses", async (t) => {
  const c = await setup(t, [{ device_code: "private-device", user_code: "ABCD-EFGH", expires_in: 900, interval: 5 }, { error: "authorization_pending" }, { access_token: "private-token", refresh_token: "private-refresh", expires_in: 28800 }, { login: "tester" }]);
  const started = await c.github.auth(client, "start");
  assert.equal(started.pending.userCode, "ABCD-EFGH");
  assert.ok(!JSON.stringify(started).includes("private-device"));
  await c.github.auth(client, "poll"); assert.equal(c.requests.length, 1);
  c.advance(5000); await c.github.auth(client, "poll");
  c.advance(5000); const approved = await c.github.auth(client, "poll");
  assert.deepEqual(approved, { configured: true, connected: true, login: "tester" });
  assert.ok(!JSON.stringify(approved).includes("private-token"));
  assert.equal(c.read().refreshToken, "private-refresh");
  assert.equal(c.requests[3].options.headers.Authorization, "Bearer private-token");
});
test("slow_down and expiry respect GitHub polling deadlines", async (t) => {
  const c = await setup(t, [{ device_code: "device", user_code: "ABCD-EFGH", expires_in: 20, interval: 5 }, { error: "slow_down" }]);
  await c.github.auth(client, "start"); c.advance(5000); await c.github.auth(client, "poll");
  c.advance(5000); await c.github.auth(client, "poll"); assert.equal(c.requests.length, 2);
  c.advance(11000); await assert.rejects(() => c.github.auth(client, "poll"), /expired/);
});
test("all merged means Done; caching avoids repeated network checks", async (t) => {
  const c = await setup(t, [response(false), response(true, "MERGED")], signedIn);
  const snapshot = { healthy: true, tasks: [task()] };
  const first = await c.github.enrich(snapshot, settings);
  assert.equal(first.snapshot.tasks[0].status, "needs_input");
  await c.github.enrich(snapshot, settings); assert.equal(c.requests.length, 1);
  c.advance(60_001);
  await c.github.enrich(snapshot, settings); assert.equal(c.requests.length, 1, "settled status has no short TTL");
  const updated = await c.github.enrich(snapshot, settings, { force: true });
  assert.equal(updated.snapshot.tasks[0].status, "completed");
  assert.equal(updated.snapshot.tasks[0].pullRequests[0].checks, "passed");
  assert.ok(!c.requests[0].options.body.includes('chat'));
  assert.equal(c.requests[0].options.redirect, "error");
});
test("draft, closed without merge, and unavailable PRs stay Waiting", async (t) => {
  for (const r of [response(false, "OPEN", null, { isDraft: true }), response(false, "CLOSED"), { data: { p0: null }, errors: [{ path: ["p0"] }] }, new Error("network-token-should-not-leak")]) {
    const c = await setup(t, [r], signedIn);
    const result = await c.github.enrich({ healthy: true, tasks: [task({ manualDone: true, status: "completed" })] }, settings);
    assert.equal(result.snapshot.tasks[0].status, "needs_input");
    assert.ok(!JSON.stringify(result).includes("network-token-should-not-leak"));
  }
});
test("Running and Archived win over merged PRs; no attachments never auto-Done", async (t) => {
  const c = await setup(t, [response(true, "MERGED")], signedIn);
  const result = await c.github.enrich({ healthy: true, tasks: [task({ status: "working", observed: { source: "vscode", lastTurnEvent: "inProgress" } }), task({ id: "archived", status: "archived", observed: { archive: true, source: "vscode", lastTurnEvent: "completed" } }), task({ id: "none", pullRequests: [] })] }, settings);
  assert.deepEqual(result.snapshot.tasks.map((x) => x.status), ["working", "archived", "needs_input"]);
});
test("refresh tokens use public client ID without a client secret", async (t) => {
  const c = await setup(t, [{ access_token: "new-token", refresh_token: "new-refresh", expires_in: 28800 }, response()], { ...signedIn, refreshToken: "old-refresh", expiresAt: 99_000 });
  await c.github.enrich({ healthy: true, tasks: [task()] }, settings);
  assert.equal(c.requests[0].options.body.get("grant_type"), "refresh_token");
  assert.equal(c.requests[0].options.body.get("client_secret"), null);
  assert.equal(c.read().token, "new-token");
});
test("disconnect clears local credentials and cached merged results", async (t) => {
  const c = await setup(t, [response(true, "MERGED")], signedIn);
  await c.github.enrich({ healthy: true, tasks: [task()] }, settings);
  await c.github.auth(client, "disconnect");
  const result = await c.github.enrich({ healthy: true, tasks: [task()] }, settings);
  assert.equal(result.snapshot.tasks[0].status, "needs_input");
  assert.equal(result.auth.connected, false);
});
test("credential store failures are explicit and never save a plaintext fallback", async (t) => {
  const c = await setup(t, []);
  c.credentials.read = async () => { throw Error("locked secret text"); };
  const result = await c.github.enrich({ healthy: true, tasks: [task()] }, settings);
  assert.match(result.auth.error, /credential store/);
  assert.ok(!JSON.stringify(result).includes("locked secret text"));
});

test("all attachments must be confirmed merged, including partial GraphQL errors", async (t) => {
  const r = response(true, "MERGED");
  r.data.p1 = null; r.errors = [{ path: ["p1"] }];
  const c = await setup(t, [r], signedIn);
  const result = await c.github.enrich({ healthy: true, tasks: [task({ pullRequests: [{ url }, { url: "https://github.com/example/repo/pull/13" }] })] }, settings);
  assert.equal(result.snapshot.tasks[0].status, "needs_input");
  assert.deepEqual(result.snapshot.tasks[0].pullRequests.map((pr) => pr.state), ["merged", "unknown"]);
});
test("rate limits suppress forced requests until the retry deadline", async (t) => {
  const c = await setup(t, [{ httpError: 429 }, response()], signedIn);
  const snapshot = { healthy: true, tasks: [task()] };
  await c.github.enrich(snapshot, settings);
  await c.github.enrich(snapshot, settings, { force: true });
  assert.equal(c.requests.length, 1);
  c.advance(60_001); await c.github.enrich(snapshot, settings);
  assert.equal(c.requests.length, 2);
});
test("unauthorized tokens are removed instead of retried every poll", async (t) => {
  const c = await setup(t, [{ httpError: 401 }], signedIn);
  const snapshot = { healthy: true, tasks: [task()] };
  const first = await c.github.enrich(snapshot, settings);
  assert.equal(first.auth.connected, false); assert.deepEqual(c.read(), {});
  await c.github.enrich(snapshot, settings); assert.equal(c.requests.length, 1);
});

test("active scheduled chats return to Scheduled after PR merge and ordinary chats become Done after pause", async (t) => {
  const c = await setup(t, [response(true, "MERGED"), response(false)], signedIn);
  const snapshot = { healthy: true, tasks: [task({ scheduled: true, inputSource: "ordinary" })] };
  let result = await c.github.enrich(snapshot, settings);
  assert.equal(result.snapshot.tasks[0].status, "scheduled");
  assert.equal(result.snapshot.tasks[0].statusLabel, "Scheduled");
  result = await c.github.enrich({ healthy: true, tasks: [task({ scheduled: false })] }, settings);
  assert.equal(result.snapshot.tasks[0].status, "completed");
  c.advance(60_001);
  result = await c.github.enrich(snapshot, settings);
  assert.equal(result.snapshot.tasks[0].status, "scheduled");
  assert.equal(c.requests.length, 1);
});


test("schedule rules use turn source; routine completions ignore PR state", async (t) => {
  for (const inputSource of ["scheduled", "ordinary", "unverified"]) {
    for (const prState of ["none", "merged", "open", "draft", "closed", "unknown"]) {
      await t.test(`${inputSource}: ${prState}`, async (t) => {
        const c = await setup(t, prState === "none" || prState === "unknown" ? [] : [response(prState === "merged", prState === "closed" ? "CLOSED" : "OPEN", "SUCCESS", {isDraft:prState === "draft"})], prState === "unknown" ? {} : signedIn);
        const result = await c.github.enrich({healthy:true,tasks:[task({scheduled:true,inputSource,pullRequests:prState === "none" ? [] : [{url}]})]},settings);
        assert.equal(result.snapshot.tasks[0].status, inputSource === "scheduled" || prState === "merged" ? "scheduled" : "needs_input");
      });
    }
  }
});

test("Running, interruptions and archives keep priority over schedule completions", async (t) => {
  const c = await setup(t, [response(true)], signedIn);
  const cases = [["inProgress","working"],["failed","interrupted"],["interrupted","interrupted"]];
  const result = await c.github.enrich({healthy:true,tasks:cases.map(([lastTurnEvent,status])=>task({scheduled:true,inputSource:"scheduled",status,observed:{archive:false,lastTurnEvent}}))},settings);
  assert.deepEqual(result.snapshot.tasks.map(x=>x.status),cases.map(x=>x[1]));
});


test("project and time scope exclude old history; selecting All time fetches it on demand", async (t) => {
  const c = await setup(t, [response(), response(true, "MERGED")], signedIn);
  const tasks = [task({id:"recent", updatedAt:new Date(99_000).toISOString(), project:{id:"a"}}), task({id:"old", updatedAt:new Date(-700_000_000).toISOString(), project:{id:"a"}, pullRequests:[{url:"https://github.com/example/repo/pull/13"}]}), task({id:"other", updatedAt:new Date(99_000).toISOString(), project:{id:"b"}, pullRequests:[{url:"https://github.com/example/repo/pull/14"}]})];
  await c.github.enrich({healthy:true,tasks},settings,{scope:{date:"7d",project:"a"}});
  assert.match(c.requests[0].options.body, /number:12/);
  assert.doesNotMatch(c.requests[0].options.body, /number:13|number:14/);
  await c.github.enrich({healthy:true,tasks},settings,{scope:{date:"all",project:"a"}});
  assert.match(c.requests[1].options.body, /number:13/);
  assert.doesNotMatch(c.requests[1].options.body, /number:12|number:14/);
  c.advance(60_001);
  await c.github.enrich({healthy:true,tasks:[tasks[1]]},settings);
  assert.equal(c.requests.length,2,"merged PR is not fetched again after cache TTL");
});


test("only cards in view start GitHub queries, including old chats in All time", async (t) => {
  const c = await setup(t, [response(), response()], signedIn);
  const tasks = [task({id:"visible"}), task({id:"offscreen",updatedAt:new Date(-700_000_000).toISOString(),pullRequests:[{url:"https://github.com/example/repo/pull/13"}]})];
  await c.github.enrich({healthy:true,tasks},settings,{scope:{date:"all",taskIds:[]}});
  assert.equal(c.requests.length,0);
  await c.github.enrich({healthy:true,tasks},settings,{scope:{date:"all",taskIds:["visible"]}});
  assert.match(c.requests[0].options.body,/number:12/);
  assert.doesNotMatch(c.requests[0].options.body,/number:13/);
  await c.github.enrich({healthy:true,tasks},settings,{scope:{date:"all",taskIds:["offscreen"]}});
  assert.match(c.requests[1].options.body,/number:13/);
  assert.doesNotMatch(c.requests[1].options.body,/number:12/);
});


test("saved cache survives another MCP process; new turns refresh it without repeated scans", async t => {
  const c = await setup(t, [response(false, "OPEN", "SUCCESS", {title:"Improve search",headRefOid:"a".repeat(40),mergeable:"MERGEABLE",mergeStateStatus:"CLEAN"}), response(true, "MERGED")], signedIn);
  const snapshot = {healthy:true,tasks:[task()]};
  const first = await c.github.enrich(snapshot,settings);
  assert.equal(first.snapshot.tasks[0].pullRequests[0].canMerge,true);
  assert.equal(first.snapshot.tasks[0].pullRequests[0].title,"Improve search");
  const saved = await readFile(c.github.cachePath,"utf8");
  assert.ok(!saved.includes("private-token"));
  if (process.platform !== "win32") assert.equal((await stat(c.github.cachePath)).mode & 0o777,0o600);
  const other = new NextGitHub({stateDir:c.dir,credentials:c.credentials,now:c.github.now,fetch:c.github.fetch});
  c.advance(24*60*60*1000);
  await other.enrich(snapshot,settings);
  assert.equal(c.requests.length,1);
  const updated = await other.enrich({healthy:true,tasks:[task({turnId:"turn-2"})]},settings);
  assert.equal(updated.snapshot.tasks[0].status,"completed");
  await c.github.enrich({healthy:true,tasks:[task({turnId:"turn-2"})]},settings);
  assert.equal(c.requests.length,2);
  await c.github.auth(client,"disconnect");
  await assert.rejects(()=>readFile(c.github.cachePath),{code:"ENOENT"});
});

test("pending CI refreshes only in view; completed CI then stays cached", async t => {
  const c = await setup(t,[response(false,"OPEN","PENDING"),response(false)],signedIn);
  const snapshot={healthy:true,tasks:[task()]};
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["chat"]}});
  c.advance(60_001);
  await c.github.enrich(snapshot,settings,{scope:{taskIds:[]}});
  assert.equal(c.requests.length,1);
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["chat"]}});
  assert.equal(c.requests.length,2);
  c.advance(60_001); await c.github.enrich(snapshot,settings);
  assert.equal(c.requests.length,2);
});

test("cache errors are explicit and account changes cannot reuse saved results", async t => {
  const c=await setup(t,[response(true,"MERGED"),response(false)],signedIn);
  const snapshot={healthy:true,tasks:[task()]};
  await c.github.enrich(snapshot,settings);
  await c.credentials.write(client,{token:"other-token",login:"other-user"});
  const changed=await c.github.enrich(snapshot,settings);
  assert.equal(changed.snapshot.tasks[0].status,"needs_input");
  assert.equal(c.requests.length,2);
  await writeFile(c.github.cachePath,"broken");
  const broken=await c.github.enrich(snapshot,settings);
  assert.match(broken.auth.error,/saved PR cache/);
  assert.equal(c.requests.length,2);
  assert.equal(broken.snapshot.tasks[0].pullRequests[0].state,"unknown");
});

test("same PR on two cards keeps separate turn keys without repeated checks", async t => {
  const c=await setup(t,[response(),response()],signedIn);
  const snapshot={healthy:true,tasks:[task(),task({id:"other",turnId:"other-turn"})]};
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["chat"]}});
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["other"]}});
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["chat"]}});
  assert.equal(c.requests.length,2);
});


test("unknown CI retries while visible even when merge state is settled", async t => {
  const c=await setup(t,[response(false,"OPEN","UNRECOGNIZED",{mergeStateStatus:"BLOCKED"}),response(false)],signedIn);
  const snapshot={healthy:true,tasks:[task()]};
  const first=await c.github.enrich(snapshot,settings);
  assert.equal(first.snapshot.tasks[0].pullRequests[0].checks,"unknown");
  c.advance(60_001);
  await c.github.enrich(snapshot,settings,{scope:{taskIds:[]}}); assert.equal(c.requests.length,1);
  await c.github.enrich(snapshot,settings,{scope:{taskIds:["chat"]}}); assert.equal(c.requests.length,2);
});


test("GitHub calculating mergeability retries even with settled CI and CLEAN merge state", async t => {
  const c=await setup(t,[response(false,"OPEN","SUCCESS",{mergeStateStatus:"CLEAN",mergeable:"UNKNOWN"}),response(false,"OPEN","SUCCESS",{mergeStateStatus:"CLEAN",mergeable:"MERGEABLE"})],signedIn);
  const snapshot={healthy:true,tasks:[task()]};
  const first=await c.github.enrich(snapshot,settings);
  assert.equal(first.snapshot.tasks[0].pullRequests[0].canMerge,false);
  c.advance(60_001);
  const second=await c.github.enrich(snapshot,settings);
  assert.equal(second.snapshot.tasks[0].pullRequests[0].canMerge,true);
  assert.equal(c.requests.length,2);
});


test("partial metadata errors preserve merged PR state; CI reads use existing read-only endpoints",async t=>{
 const reply=response(true,"MERGED");
 reply.errors=[{path:["p0","pullRequest","mergeable"],message:"Resource not accessible by integration"}];
 const c=await setup(t,[reply],signedIn);
 const r=await c.github.enrich({healthy:true,tasks:[task()]},settings);
 assert.equal(r.snapshot.tasks[0].pullRequests[0].state,"merged");
 assert.equal(r.snapshot.tasks[0].pullRequests[0].checks,"passed");
 assert.equal(r.snapshot.tasks[0].status,"completed");
 assert.equal(c.ciRequests.length,2);
 assert.ok(c.ciRequests.some(x=>x.url.includes("/check-runs?")));
 assert.ok(c.ciRequests.some(x=>x.url.includes("/status?")));
 assert.doesNotMatch(c.requests[0].options.body,/statusCheckRollup|commits\(/);
});

test("CI access failure preserves PR merge status, and an empty legacy-status result is not pending",async t=>{
 const c=await setup(t,[],signedIn);
 let denied=true;
 c.github.fetch=async endpoint=>({ok:!denied,status:denied?403:200,json:async()=>endpoint.includes("check-runs")?{total_count:1,check_runs:[{status:"completed",conclusion:"success"}]}:{total_count:0,state:"pending"}});
 const identity=pullRequestIdentity(url);
 assert.equal((await c.github.checks(identity,"a".repeat(40),"token")).checks,"unknown");
 denied=false;c.advance(60001);
 assert.equal((await c.github.checks(identity,"a".repeat(40),"token")).checks,"passed");
});


for (const checks of ["PENDING", "UNRECOGNIZED"]) {
  test(`merged PR with ${checks} CI retries only while visible and keeps merged state`, async t => {
    const c = await setup(t, [response(true, "MERGED", checks), response(true, "MERGED", "SUCCESS")], signedIn);
    const snapshot = { healthy: true, tasks: [task()] };
    const first = await c.github.enrich(snapshot, settings, { scope: { taskIds: ["chat"] } });
    assert.equal(first.snapshot.tasks[0].pullRequests[0].state, "merged");
    assert.equal(first.snapshot.tasks[0].pullRequests[0].checks, checks === "PENDING" ? "pending" : "unknown");
    c.advance(60001);
    await c.github.enrich(snapshot, settings, { scope: { taskIds: [] } });
    assert.equal(c.requests.length, 1);
    const refreshed = await c.github.enrich(snapshot, settings, { scope: { taskIds: ["chat"] } });
    assert.equal(c.requests.length, 2);
    assert.equal(refreshed.snapshot.tasks[0].pullRequests[0].state, "merged");
    assert.equal(refreshed.snapshot.tasks[0].pullRequests[0].checks, "passed");
    c.advance(60001);
    await c.github.enrich(snapshot, settings, { scope: { taskIds: ["chat"] } });
    assert.equal(c.requests.length, 2);
  });
}


test("closed PR with settled CI ignores irrelevant unknown mergeability", async t => {
  const c = await setup(t, [response(false, "CLOSED", "SUCCESS", {mergeStateStatus:"UNKNOWN",mergeable:"UNKNOWN"})], signedIn);
  const snapshot = {healthy:true,tasks:[task()]};
  await c.github.enrich(snapshot,settings);
  c.advance(60001);
  const cached = await c.github.enrich(snapshot,settings);
  assert.equal(cached.snapshot.tasks[0].pullRequests[0].state,"closed");
  assert.equal(c.requests.length,1);
});

test("repository access errors are distinct from rate limits and preserve known merge state", async t => {
  for (const [type, expected] of [["FORBIDDEN", "denied"], ["NOT_FOUND", "not_found"], ["RATE_LIMITED", undefined]]) {
    const c = await setup(t, [{data:{p0:null},errors:[{type,path:["p0"]}]}], signedIn);
    const result = await c.github.enrich({healthy:true,tasks:[task()]}, settings);
    assert.equal(result.snapshot.tasks[0].pullRequests[0].accessIssue, expected);
  }
  const reply=response(true,"MERGED");
  reply.errors=[{type:"FORBIDDEN",path:["p0","pullRequest","mergeable"]}];
  const c=await setup(t,[reply],signedIn);
  const result=await c.github.enrich({healthy:true,tasks:[task()]},settings);
  assert.equal(result.snapshot.tasks[0].pullRequests[0].state,"merged");
  assert.equal(result.snapshot.tasks[0].pullRequests[0].accessIssue,"denied");
});

test("CI permission failures have an access marker; HTTP rate limits do not", async t => {
  for (const [message, expected] of [["Resource not accessible by integration", "denied"], ["API rate limit exceeded", undefined]]) {
    const c=await setup(t, [],signedIn);
    c.github.fetch=async()=>({ok:false,status:403,json:async()=>({message})});
    const result=await c.github.checks(pullRequestIdentity(url),"a".repeat(40),"test-token");
    assert.equal(result.accessIssue,expected);
  }
});

test("one repository permission failure does not block the next PR's CI", async t => {
  const c=await setup(t,[],signedIn);
  let calls=0;
  c.github.fetch=async requestUrl=>{
    calls++;
    if(requestUrl.includes("/example/repo/")) return {ok:false,status:403,json:async()=>({message:"Resource not accessible by integration"})};
    return {ok:true,status:200,json:async()=>requestUrl.includes("check-runs")?{total_count:0,check_runs:[]}:{total_count:0,state:"pending"}};
  };
  const first=await c.github.checks(pullRequestIdentity(url),"a".repeat(40),"test-token");
  assert.equal(first.accessIssue,"denied");
  const second=await c.github.checks(pullRequestIdentity("https://github.com/other/project/pull/1"),"a".repeat(40),"test-token");
  assert.equal(second.checks,"none");
  assert.equal(calls,4);
});
test("a batch checks CI concurrently with at most five PRs at a time", async t => {
  const c=await setup(t,[],signedIn);
  let active=0, peak=0;
  const tasks=Array.from({length:8},(_,i)=>task({id:"chat"+i,pullRequests:[{url:"https://github.com/example/repo/pull/"+(i+1)}]}));
  c.github.fetch=async endpoint=>{
    if(endpoint.endsWith("/graphql")) return {ok:true,status:200,json:async()=>({data:Object.fromEntries(tasks.map((_,i)=>["p"+i,response(true,"MERGED").data.p0]))})};
    active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));
    active--;
    return {ok:true,status:200,json:async()=>endpoint.includes("check-runs")?{total_count:0,check_runs:[]}:{total_count:0,state:"pending"}};
  };
  const result=await c.github.enrich({healthy:true,tasks},settings);
  assert.ok(peak>2 && peak<=10,"two endpoints per PR, up to five PRs");
  assert.ok(result.snapshot.tasks.every(task=>task.pullRequests[0].checks==="none"));
});
