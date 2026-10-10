import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";

const itemSchema = z.object({ id: z.string(), taskId: z.string().nullable(), title: z.string(), detail: z.string(), kind: z.enum(["ready", "interrupted", "confirmation", "error"]), read: z.boolean(), timestamp: z.string() });
const schema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), initialized: z.boolean(), chats: z.record(z.string(), z.object({ turn: z.string().nullable(), status: z.string().nullable(), announced: z.array(z.string()) })), items: z.array(itemSchema) });
const empty = () => ({ version: 1, revision: 0, initialized: false, chats: {}, items: [] });
const publicState = (state) => ({ revision: state.revision, items: state.items });

// Each operation locks and rereads the shared file. No process owns a stale copy.
export class NextNotifications {
  constructor(path, { now = () => new Date().toISOString() } = {}) { this.path = path; this.now = now; }
  async update(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await acquireWorkspaceLock(dirname(this.path));
    try {
      let state;
      try { state = schema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error("TaskChef cannot read notifications.json. Repair the file and refresh.");
        state = empty();
      }
      const before = JSON.stringify(state);
      await operation(state);
      state.items = state.items.slice(0, 100);
      if (JSON.stringify(state) !== before) {
        state.revision += 1;
        await writeDurableAtomic(this.path, JSON.stringify(state));
      }
      return publicState(state);
    } finally { await release(); }
  }
  add(state, { taskId = null, title, detail = "", kind, read = false }) {
    state.items.unshift({ id: randomUUID(), taskId, title, detail, kind, read, timestamp: this.now() });
  }
  async reconcile(getSnapshot, settings) {
    let snapshot;
    const notifications = await this.update(async (state) => {
      // Read the scanner while locked so two MCP processes cannot reconcile snapshots out of order.
      snapshot = await getSnapshot();
      if (snapshot.healthy === false) return;
      const chats = {};
      for (const task of snapshot.tasks) {
        const turn = task.turnId ?? null;
        const previous = state.chats[task.id];
        const announced = previous?.turn === turn ? previous.announced : [];
        const current = { turn, status: task.status ?? null, announced: [...announced] };
        // Archiving changes the board label, but must still consume the saved terminal event.
        const terminal = task.observed?.lastTurnEvent;
        const event = (task.status === "needs_input" || terminal === "completed") && task.inputSource === "ordinary"
          ? "ready" : task.status === "interrupted" || terminal === "interrupted" || terminal === "failed" ? "interrupted" : null;
        const eligible = !task.observed?.archive && !task.manualDone
          && (settings.showExec || task.observed?.source !== "exec")
          && (settings.showCli || task.observed?.source !== "cli");
        // Consume the baseline and hidden events too; enabling a setting must not replay old turns.
        if (event && turn && !current.announced.includes(event)) {
          current.announced.push(event);
          if (state.initialized && eligible && (event !== "ready" || task.status === "needs_input") && (!previous || previous.turn !== turn || previous.status !== task.status)) {
            this.add(state, { taskId: task.id, kind: event, title: event === "ready" ? `${task.title} is ready for input or review` : `${task.title} was interrupted` });
          }
        }
        chats[task.id] = current;
      }
      state.chats = chats;
      state.initialized = true;
    });
    return { snapshot, notifications };
  }
  async confirmation(task) {
    return this.update((state) => this.add(state, { taskId: task.id, title: `${task.title} marked Done`, kind: "confirmation", read: true }));
  }
  async action({ action, id, task, operation, error }) {
    return this.update((state) => {
      if (action === "read") { const item = state.items.find((item) => item.id === id); if (item) item.read = true; }
      else if (action === "read_all") state.items.forEach((item) => { item.read = true; });
      else if (action === "clear") state.items = [];
      else if (action === "error") {
        const titles = { move: `Could not move ${task?.title ?? "chat"}`, open: `Could not open ${task?.title ?? "chat"}`, done: `Could not mark ${task?.title ?? "chat"} Done`, copy: "Could not copy chat ID", settings: "Could not open plugin settings" };
        this.add(state, { taskId: task?.id ?? null, kind: "error", title: titles[operation], detail: error.slice(0, 1000) });
      }
    });
  }
}
