import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { acquireFileLock } from "./file-lock.js";
import { writeDurableAtomic } from "./state-store.js";

const itemSchema = z.object({ id: z.string(), taskId: z.string().nullable(), title: z.string(), detail: z.string(), kind: z.enum(["ready", "interrupted", "confirmation", "error"]), read: z.boolean(), timestamp: z.string() });
const schema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), initialized: z.boolean(), observedAt: z.number().nonnegative().default(0), chats: z.record(z.string(), z.object({ turn: z.string().nullable(), status: z.string().nullable(), announced: z.array(z.string()) })), items: z.array(itemSchema) });
const empty = () => ({ version: 1, revision: 0, initialized: false, observedAt: 0, chats: {}, items: [] });
const publicState = (state) => ({ revision: state.revision, items: state.items });

// Each operation locks and rereads the shared file. No process owns a stale copy.
export class NextNotifications {
  constructor(path, { now = () => new Date().toISOString(), clock = () => performance.timeOrigin + performance.now() } = {}) { this.path = path; this.now = now; this.clock = clock; }
  async update(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(dirname(this.path));
    try {
      let state;
      try { state = schema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error("TaskChef cannot read notifications.json. Repair the file and refresh.");
        state = empty();
      }
      const before = JSON.stringify({ ...state, observedAt: 0 });
      const beforeObservedAt = state.observedAt;
      await operation(state);
      state.items = state.items.slice(0, 100);
      const changed = JSON.stringify({ ...state, observedAt: 0 }) !== before;
      if (changed) state.revision += 1;
      if (changed || state.observedAt !== beforeObservedAt) {
        await writeDurableAtomic(this.path, JSON.stringify(state));
      }
      return publicState(state);
    } finally { await release(); }
  }
  add(state, { id = randomUUID(), taskId = null, title, detail = "", kind, read = false }) {
    state.items.unshift({ id, taskId, title, detail, kind, read, timestamp: this.now() });
  }
  async reconcile(getSnapshot, settings) {
    const observedAt = this.clock();
    // Network work must not hold the shared lock needed by local user actions.
    const snapshot = await getSnapshot();
    const notifications = await this.update((state) => {
      // A slower earlier request must not replace a newer process’s baseline.
      if (snapshot.healthy === false || observedAt <= state.observedAt) return;
      state.observedAt = observedAt;
      const chats = {};
      for (const task of snapshot.tasks) {
        const turn = task.turnId ?? null;
        const previous = state.chats[task.id];
        const announced = previous?.turn === turn ? previous.announced : [];
        const current = { turn, status: task.status ?? null, announced: [...announced] };
        // Archiving changes the board label, but must still consume the saved terminal event.
        const terminal = task.observed?.lastTurnEvent;
        const event = ((task.status === "needs_input" && terminal !== "inProgress") || terminal === "completed") && task.inputSource === "ordinary"
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
  async errorOnce(key, title, detail) {
    // Older release writers strip unknown fields from notifications.json.
    const path = `${this.path}.errors.json`;
    const readWatermark = async () => {
      try { return z.array(z.string()).parse(JSON.parse(await readFile(path, "utf8"))); }
      catch { return []; } // A damaged optional watermark must not prevent an alert.
    };
    let needsWatermark = false;
    const result = await this.update(async state => {
      if ((await readWatermark()).includes(key)) return;
      const id = `system-error:${key}`;
      // If the previous process stopped after saving the alert, finish its
      // watermark without adding a duplicate notification.
      if (!state.items.some(item => item.id === id)) this.add(state, { id, title, detail, kind: "error" });
      needsWatermark = true;
    });
    // Commit the alert first. A failed write can never suppress an unseen alert.
    if (needsWatermark) {
      const release = await acquireFileLock(dirname(this.path));
      try {
        const announced = await readWatermark();
        if (!announced.includes(key)) await writeDurableAtomic(path, JSON.stringify([...announced, key]));
      } finally { await release(); }
    }
    return result;
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
