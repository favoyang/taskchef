import net from "node:net";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Private desktop IPC, observed in Codex 26.1007.30912. Never send decisions or
// thread mutations. Only initialize and subscribe/unsubscribe to local chats.
const STREAM_VERSION = 11;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const text = value => typeof value === "string" ? value.slice(0, 4000) : null;
const approvalMethods = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);

function approval(request, task) {
  const params = request?.params;
  if (!params || params.threadId !== task.id || params.turnId !== task.turnId) return null;
  const meta = params._meta ?? {};
  const elicitation = request.method === "mcpServer/elicitation/request" && meta.codex_approval_kind === "mcp_tool_call";
  if (!approvalMethods.has(request.method) && !elicitation) return null;
  let origin = null;
  try { const url = new URL(meta.origin); if (["http:", "https:"].includes(url.protocol)) origin = url.origin; } catch { /* Optional origin. */ }
  return {
    id: String(request.id), turnId: params.turnId,
    title: text(meta.connector_name) ?? (request.method.includes("commandExecution") ? "Command execution" : request.method.includes("fileChange") ? "File changes" : "Permissions"),
    message: text(params.message) ?? text(params.reason) ?? "Codex needs permission to continue.",
    origin,
  };
}

function validateState(state) {
  const status = state.threadRuntimeStatus;
  if (status != null && (typeof status !== "object" || typeof status.type !== "string"
    || (status.type === "active" && (!Array.isArray(status.activeFlags) || !status.activeFlags.every(flag => typeof flag === "string"))))) throw new Error("Invalid Codex IPC runtime status");
  if (!Array.isArray(state.requests) || !state.requests.every(request => request && typeof request === "object"
    && typeof request.method === "string" && request.params && typeof request.params === "object")) throw new Error("Invalid Codex IPC approval requests");
  return state;
}

// Apply only the two fields we consume. Conversation text, images, credentials,
// and unrelated patches are discarded and never enter TaskChef snapshots.
function patchState(state, patches) {
  const result = structuredClone(state);
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || !["threadRuntimeStatus", "requests"].includes(patch.path[0])) continue;
    if (!["add", "replace", "remove"].includes(patch.op) || patch.path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Invalid live-state patch");
    let parent = result;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw new Error("Missing live-state patch path");
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length || (patch.op !== "add" && key === parent.length)) throw new Error("Invalid live-state array patch");
      if (patch.op === "remove") parent.splice(key, 1);
      else if (patch.op === "add") parent.splice(key, 0, patch.value);
      else parent[key] = patch.value;
    } else {
      if (!parent || typeof parent !== "object") throw new Error("Invalid live-state patch path");
      if (patch.op === "remove") delete parent[key]; else parent[key] = patch.value;
    }
  }
  return validateState(result);
}

export class CodexLiveState {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), socketPath, now = Date.now, timeoutMs = 1000 } = {}) {
    this.socketPath = socketPath ?? (process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : join(codexHome, "ipc", "ipc.sock"));
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.entries = new Map();
    this.retryAt = 0;
    this.error = null;
    this.closed = false;
  }
  async connect() {
    if (this.clientId || this.closed || this.now() < this.retryAt) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (process.platform !== "win32") {
          const [socket, directory] = await Promise.all([lstat(this.socketPath), lstat(dirname(this.socketPath))]);
          if (!socket.isSocket() || socket.uid !== process.getuid() || !directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o022)) throw new Error("Codex IPC socket ownership or permissions are invalid");
        }
        if (this.closed) return;
        await new Promise(resolve => {
          const socket = this.socket = net.createConnection(this.socketPath);
          this.buffer = Buffer.alloc(0);
          const timer = setTimeout(() => this.fail("Codex IPC initialization timed out"), this.timeoutMs);
          this.finishConnect = () => { clearTimeout(timer); resolve(); };
          socket.on("connect", () => this.send({ type: "request", requestId: randomUUID(), version: 0, method: "initialize", params: { clientType: "taskchef" } }));
          socket.on("data", chunk => {
            if (this.socket !== socket) return;
            try {
              this.buffer = Buffer.concat([this.buffer, chunk]);
              while (this.buffer.length >= 4) {
                const size = this.buffer.readUInt32LE();
                if (!size || size > MAX_FRAME_BYTES) throw new Error("Codex IPC frame is invalid or too large");
                if (this.buffer.length < size + 4) break;
                const message = JSON.parse(this.buffer.subarray(4, size + 4));
                this.buffer = this.buffer.subarray(size + 4);
                this.receive(message);
              }
            } catch (error) { this.fail(error.message); }
          });
          socket.on("error", error => this.fail(`Codex IPC connection failed (${error.code ?? "error"})`));
          socket.on("close", () => { if (this.socket === socket && !this.closed) this.fail("Codex IPC connection closed"); });
        });
      } catch (error) { this.fail(error.code ? `Codex IPC unavailable (${error.code})` : error.message); }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  send(message) {
    if (!this.socket || this.socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length); body.copy(frame, 4);
    this.socket.write(frame);
  }
  follow(id, following) {
    this.send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: this.clientId, version: 1, params: { conversationId: id, hostId: "local", following } });
  }
  receive(message) {
    if (message.type === "response" && message.method === "initialize" && message.resultType === "success") {
      if (typeof message.result?.clientId !== "string") throw new Error("Invalid Codex IPC initialization");
      this.clientId = message.result.clientId;
      this.finishConnect?.(); this.finishConnect = null;
      return;
    }
    if (message.type === "client-discovery-request") {
      this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.method === "client-status-changed" && message.params?.status === "disconnected") {
      for (const entry of this.entries.values()) if (entry.owner === message.params.clientId) { entry.state = null; entry.revision = null; }
      return;
    }
    if (message.type !== "broadcast" || message.method !== "thread-stream-state-changed" || message.params?.hostId !== "local") return;
    const entry = this.entries.get(message.params.conversationId);
    if (!entry) return;
    if (message.version !== STREAM_VERSION) throw new Error("Codex IPC protocol changed; live approvals are unavailable");
    const change = message.params.change;
    if (!change || !Number.isSafeInteger(change.revision)) throw new Error("Invalid Codex IPC revision");
    if (change.type === "snapshot") {
      const state = change.conversationState;
      if (state?.id !== message.params.conversationId || !Array.isArray(state.requests)) throw new Error("Invalid Codex IPC snapshot");
      entry.state = validateState({ threadRuntimeStatus: state.threadRuntimeStatus, requests: state.requests });
      entry.owner = message.sourceClientId;
    } else if (change.type === "patches") {
      if (!entry.state || entry.owner !== message.sourceClientId || entry.revision !== change.baseRevision) {
        entry.state = null; entry.revision = null;
        this.follow(message.params.conversationId, true);
        return;
      }
      if (!Array.isArray(change.patches)) throw new Error("Invalid Codex IPC patches");
      entry.state = patchState(entry.state, change.patches);
    } else throw new Error("Unknown Codex IPC state message");
    entry.revision = change.revision;
    entry.ready?.(); entry.ready = null;
  }
  fail(message) {
    this.error ??= message;
    this.retryAt = this.now() + 15_000;
    this.socket?.destroy(); this.socket = null; this.clientId = null; this.buffer = Buffer.alloc(0);
    this.finishConnect?.(); this.finishConnect = null;
    for (const entry of this.entries.values()) entry.ready?.();
    this.entries.clear();
  }
  async refresh(tasks) {
    if (this.closed) return;
    const selected = tasks.filter(task => !task.observed?.archive && task.observed?.lastTurnEvent === "inProgress");
    const ids = new Set(selected.map(task => task.id));
    for (const [id, entry] of this.entries) if (!ids.has(id) || selected.find(task => task.id === id)?.turnId !== entry.turnId) {
      this.follow(id, false); entry.ready?.(); this.entries.delete(id);
    }
    if (!selected.length) return;
    await this.connect();
    if (!this.clientId) return;
    const waiting = [];
    for (const task of selected) if (!this.entries.get(task.id)?.state) {
      const entry = this.entries.get(task.id) ?? { turnId: task.turnId, state: null, revision: null };
      entry.ready?.();
      waiting.push(new Promise(resolve => { entry.ready = resolve; }));
      this.entries.set(task.id, entry); this.follow(task.id, true);
    }
    if (waiting.length) {
      let timer;
      await Promise.race([Promise.all(waiting), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
      clearTimeout(timer);
    }
  }
  decorate(task) {
    if (!task || task.observed?.archive || task.observed?.lastTurnEvent !== "inProgress") return task;
    const entry = this.entries.get(task.id);
    if (!entry?.state || entry.turnId !== task.turnId) return task;
    const state = entry.state;
    if (state.threadRuntimeStatus?.type !== "active" || !Array.isArray(state.threadRuntimeStatus.activeFlags) || !state.threadRuntimeStatus.activeFlags.includes("waitingOnApproval")) return task;
    const pendingApprovals = state.requests.map(request => approval(request, task)).filter(Boolean);
    // An old request must not decorate a newly selected database turn.
    if (state.requests.length && !state.requests.some(request => request.params?.turnId === task.turnId)) return task;
    return { ...task, needsApproval: true, pendingApprovals, status: "needs_input", statusLabel: "Needs approval", summary: "Codex is waiting for permission. Open the chat to review and approve." };
  }
  close() {
    this.closed = true;
    for (const id of this.entries.keys()) this.follow(id, false);
    this.fail("Codex IPC closed");
  }
}
