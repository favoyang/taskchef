import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  const credentials = { read: async () => structuredClone(credential), write: async (_, next) => { credential = structuredClone(next); }, remove: async () => { credential = {}; } };
  const github = new NextGitHub({ stateDir: dir, now: () => time, credentials, fetch: async (url, options) => {
    requests.push({ url, options });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, `Unexpected request: ${url}`);
    return { ok: !next.httpError, status: next.httpError ?? 200, json: async () => next };
  } });
  return { github, requests, credentials, read: () => credential, advance: (ms) => { time += ms; } };
}
const signedIn = { token: "private-token", login: "tester" };
const response = (merged = false, state = "OPEN", checks = "SUCCESS", extra = {}) => ({ data: { p0: { pullRequest: { merged, state, isDraft: false, commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] }, ...extra } } } });

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
  const c = await setup(t, [response(true, "MERGED"), response(false)], signedIn);
  const snapshot = { healthy: true, tasks: [task()] };
  const first = await c.github.enrich(snapshot, settings);
  assert.equal(first.snapshot.tasks[0].status, "completed");
  await c.github.enrich(snapshot, settings); assert.equal(c.requests.length, 1);
  c.advance(60_001);
  const updated = await c.github.enrich(snapshot, settings);
  assert.equal(updated.snapshot.tasks[0].status, "needs_input");
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
  assert.equal(result.snapshot.tasks[0].status, "needs_input");
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
