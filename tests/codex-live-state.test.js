import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexLiveState } from "../src/codex-live-state.js";

const task = { id: "0199aabb-ccdd-7eef-8abc-0123456789ab", turnId: "turn-1", status: "working", observed: { archive: false, lastTurnEvent: "inProgress" } };
const request = { id: 16, method: "mcpServer/elicitation/request", params: { threadId: task.id, turnId: task.turnId, message: "Allow upload to Gmail filters?", _meta: { codex_approval_kind: "mcp_tool_call", connector_name: "Browser use", origin: "https://mail.google.com/mail/u/0", secret: "must-not-leak" } } };
function frame(message) { const body = Buffer.from(JSON.stringify(message)); const buffer = Buffer.alloc(body.length + 4); buffer.writeUInt32LE(body.length); body.copy(buffer, 4); return buffer; }
async function fixture(t, { version = 11 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "taskchef-live-"));
  const path = join(dir, "ipc.sock");
  const messages = [];
  let peer;
  let revision = 1;
  let requests = [request];
  const publish = change => peer.write(frame({ type: "broadcast", method: "thread-stream-state-changed", version, sourceClientId: "owner", params: { conversationId: task.id, hostId: "local", change } }));
  const server = net.createServer(socket => {
    peer = socket;
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4) {
        const size = data.readUInt32LE();
        if (data.length < size + 4) break;
        const message = JSON.parse(data.subarray(4, size + 4)); data = data.subarray(size + 4); messages.push(message);
        if (message.method === "initialize") {
          const body = frame({ type: "response", method: "initialize", resultType: "success", result: { clientId: "test-client" } });
          socket.write(body.subarray(0, 2)); socket.write(body.subarray(2));
        } else if (message.params?.following) publish({ type: "snapshot", revision: revision++, conversationState: { id: task.id, threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] }, requests, turns: [{ secret: "history-must-not-leak" }] } });
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const live = new CodexLiveState({ socketPath: path });
  t.after(async () => { live.close(); peer?.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { live, messages, publish, peer: () => peer, setRequests: value => { requests = value; } };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 20));

test("reads fragmented live snapshots and only exposes approval display fields", async t => {
  const { live, messages } = await fixture(t);
  await live.refresh([task]);
  const result = live.decorate(task);
  assert.equal(result.needsApproval, true);
  assert.equal(result.status, "needs_input");
  assert.equal(result.pendingApprovals[0].origin, "https://mail.google.com");
  assert.equal(result.pendingApprovals[0].message, request.params.message);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
  assert.ok(messages.every(message => ["initialize", "thread-stream-following-changed"].includes(message.method)));
});

test("resolution patches clear approvals and a revision gap requests a fresh snapshot", async t => {
  const { live, publish, messages, setRequests } = await fixture(t);
  await live.refresh([task]);
  publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "remove", path: ["requests", 0] }, { op: "replace", path: ["threadRuntimeStatus", "activeFlags"], value: [] }] });
  await settled();
  assert.equal(live.decorate(task).needsApproval, undefined);
  setRequests([]);
  publish({ type: "patches", baseRevision: 99, revision: 100, patches: [] });
  await settled();
  assert.ok(messages.filter(message => message.params?.following).length >= 2);
});

test("new turns and archives cannot retain approvals from an old turn", async t => {
  const { live } = await fixture(t);
  await live.refresh([task]);
  const newer = { ...task, turnId: "turn-2" };
  assert.equal(live.decorate(newer).needsApproval, undefined);
  await live.refresh([newer]);
  assert.equal(live.decorate(newer).needsApproval, undefined);
  const archived = { ...task, observed: { ...task.observed, archive: true } };
  assert.equal(live.decorate(archived).needsApproval, undefined);
  await live.refresh([]);
  assert.equal(live.entries.size, 0);
});

test("ordinary elicitation is not displayed as an approval request", async t => {
  const { live, setRequests } = await fixture(t);
  setRequests([{ ...request, params: { ...request.params, _meta: {} } }]);
  await live.refresh([task]);
  assert.equal(live.decorate(task).needsApproval, true); // Explicit runtime flag permits a generic notice.
  assert.deepEqual(live.decorate(task).pendingApprovals, []);
});

test("incompatible protocol fails softly and clears cached approval state", async t => {
  const { live } = await fixture(t, { version: 99 });
  await live.refresh([task]);
  assert.match(live.error, /protocol changed/);
  assert.equal(live.decorate(task).status, "working");
  await live.refresh([task]);
  assert.equal(live.entries.size, 0);
});

test("socket failure and owner disconnect remove stale state without throwing", async t => {
  const { live, peer } = await fixture(t);
  await live.refresh([task]);
  peer().write(frame({ type: "broadcast", method: "client-status-changed", params: { clientId: "owner", status: "disconnected" } }));
  await settled();
  assert.equal(live.decorate(task).needsApproval, undefined);
  peer().destroy(); await settled();
  assert.match(live.error, /closed/);
  assert.equal(live.decorate(task).status, "working");
});

test("missing socket never prevents the database task from rendering", async () => {
  const live = new CodexLiveState({ socketPath: join(tmpdir(), `absent-${Date.now()}`, "ipc.sock") });
  await live.refresh([task]);
  assert.match(live.error, /ENOENT/);
  assert.equal(live.decorate(task), task);
  live.close();
});

test("malformed snapshots and patches fail softly rather than throwing during decoration", async t => {
 for (const malformed of [{ type: "active", activeFlags: {} }, { type: "active", activeFlags: null }]) {
  const {live,publish}=await fixture(t);await live.refresh([task]);
  publish({type:"snapshot",revision:2,conversationState:{id:task.id,requests:[request],threadRuntimeStatus:malformed}});
  await settled();assert.match(live.error,/runtime status/);assert.equal(live.decorate(task),task);
 }
 const {live,publish}=await fixture(t);await live.refresh([task]);
 publish({type:"patches",baseRevision:1,revision:2,patches:[{op:"replace",path:["requests"],value:[null]}]});
 await settled();assert.match(live.error,/approval requests/);assert.equal(live.decorate(task),task);
});
