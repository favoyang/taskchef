#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { marked } from "marked";
import { CodexSessionScanner } from "../../src/codex-session-scanner.js";
import { displayUserPrompt } from "../../src/user-prompt.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const DEFAULT_PORT = 4780;
const LIST_CACHE_MS = 5_000;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      // Chat text is data, not markup. Keep raw HTML visible instead of executing it.
      return escapeHtml(token.text);
    },
    link(token) {
      const href = /^(https?:|mailto:)/i.test(token.href ?? "") ? token.href : null;
      const label = this.parser.parseInline(token.tokens);
      return href
        ? `<a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${label}</a>`
        : label;
    },
    image(token) {
      return escapeHtml(token.text || "");
    },
  },
});

function markdown(text) {
  return marked.parse(text);
}

function usage() {
  return [
    "Usage: node tools/codex-reader/server.js [options] [codex-home]",
    "",
    "Options:",
    "  --codex-home <path>  Codex home containing state_5.sqlite and thread_history_1.sqlite",
    "                       (default: $CODEX_HOME or ~/.codex)",
    "  --port <number>      Port on 127.0.0.1 (default: 4780)",
    "  -h, --help           Show this help",
  ].join("\n");
}

function parseArguments(argv) {
  let codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "--codex-home" || argument === "-C") {
      codexHome = argv[++index];
      if (!codexHome) throw new Error(`${argument} requires a path`);
      continue;
    }
    if (argument.startsWith("--codex-home=")) {
      codexHome = argument.slice("--codex-home=".length);
      if (!codexHome) throw new Error("--codex-home requires a path");
      continue;
    }
    if (argument === "--port" || argument === "-p") {
      port = Number(argv[++index]);
      continue;
    }
    if (argument.startsWith("--port=")) {
      port = Number(argument.slice("--port=".length));
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (codexHome !== (process.env.CODEX_HOME || join(homedir(), ".codex"))) {
      throw new Error("Pass only one codex-home path");
    }
    codexHome = argument;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535");
  return { help: false, codexHome, port };
}

function historyId(row) {
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const name = basename(row.rollout_path || "");
  const match = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(?:\\.zst)?$`).exec(name);
  if (!match) return row.id;
  return (match[2] || match[1]).toLowerCase();
}

function userText(item) {
  const content = item.content ?? item.input;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function cleanUserText(text) {
  const delegated = /^\s*<codex_delegation>[\s\S]*?<input>([\s\S]*)<\/input>[\s\S]*?<\/codex_delegation>\s*$/.exec(text);
  if (delegated) text = delegated[1];
  if (/^\s*<heartbeat>/.test(text)) {
    const instructions = /<instructions>([\s\S]*?)<\/instructions>/.exec(text)?.[1];
    const message = /<message>([\s\S]*?)<\/message>/.exec(text)?.[1];
    text = instructions || message || text;
  }
  return displayUserPrompt(text).trim();
}

function cleanAssistantText(text) {
  if (/^\s*<heartbeat>[\s\S]*<\/heartbeat>\s*$/.test(text)) {
    return (/<message>([\s\S]*?)<\/message>/.exec(text)?.[1] || text).trim();
  }
  return text.trim();
}

function transcriptMessages(history, threadId) {
  const rows = history.prepare(`
    SELECT item_json
    FROM thread_items
    WHERE thread_id = ? AND item_type IN ('userMessage', 'steeringUserMessage', 'agentMessage')
    ORDER BY rollout_ordinal, item_id
  `).all(threadId);
  const messages = [];
  for (const row of rows) {
    let item;
    try { item = JSON.parse(row.item_json); } catch { continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "userMessage" || item.type === "steeringUserMessage") {
      const text = cleanUserText(userText(item));
      if (text) messages.push({ role: "user", html: markdown(text) });
      continue;
    }
    if (item.type === "agentMessage") {
      const text = typeof item.text === "string" ? cleanAssistantText(item.text) : "";
      if (text) messages.push({ role: "assistant", html: markdown(text) });
    }
  }
  return messages;
}

function cleanTitle(task) {
  return String(task.title || "").replace(/\s+/g, " ").trim() || "Untitled chat";
}

function publicChat(task) {
  return {
    id: task.id,
    title: cleanTitle(task),
    project: {
      id: task.project?.id || "",
      name: task.project?.name || "No project",
    },
    updatedAt: task.updatedAt,
    pinned: Boolean(task.observed?.pinned),
    scheduled: Boolean(task.scheduled),
  };
}

function sortChats(chats) {
  return chats.sort((left, right) => {
    const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(difference) && difference !== 0) return difference;
    return left.title.localeCompare(right.title);
  });
}

async function start() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const codexHome = await realpath(options.codexHome);
  const info = await stat(codexHome);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${codexHome}`);
  for (const database of ["state_5.sqlite", "thread_history_1.sqlite"]) {
    const databaseInfo = await stat(join(codexHome, database)).catch(() => null);
    if (!databaseInfo?.isFile()) throw new Error(`Missing ${database} in ${codexHome}`);
  }

  const state = new DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
  const history = new DatabaseSync(join(codexHome, "thread_history_1.sqlite"), { readOnly: true });
  const scanner = new CodexSessionScanner({
    codexHome,
    statePath: join(tmpdir(), "codex-reader", "done.json"),
  });

  let listCache = null;
  let listCacheAt = 0;
  let listPending = null;

  async function chats() {
    if (listCache && Date.now() - listCacheAt < LIST_CACHE_MS) return listCache;
    if (listPending) return listPending;
    listPending = (async () => {
      const snapshot = await scanner.refresh();
      if (!snapshot.healthy) throw new Error(snapshot.scan?.error || "Codex databases are unavailable.");
      const chats = sortChats(snapshot.tasks
        .filter((task) => !task.observed?.archive)
        // The scanner already removes Guardian reviews and subagents. Exec runs are
        // non-interactive parent sessions, not chats; their review subagent twins
        // are filtered above, but the exec parent would otherwise remain.
        .filter((task) => task.observed?.source !== "exec")
        .map(publicChat));
      const projects = [...new Map(chats.map((chat) => [chat.project.id, chat.project])).values()]
        .sort((left, right) => left.name.localeCompare(right.name));
      listCache = { chats, projects, refreshedAt: new Date().toISOString() };
      listCacheAt = Date.now();
      return listCache;
    })().finally(() => { listPending = null; });
    return listPending;
  }

  function thread(id) {
    const chat = listCache?.chats.find((item) => item.id === id);
    if (!chat) return null;
    const row = state.prepare("SELECT id, rollout_path, history_mode FROM threads WHERE id = ?").get(id);
    if (!row) return null;
    return { ...chat, messages: transcriptMessages(history, historyId(row)) };
  }

  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/time.js", ["time.js", "text/javascript; charset=utf-8"]],
  ]);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end("Method not allowed");
        return;
      }

      const host = (request.headers.host ?? "").replace(/^\[|\](?=:)|:\d+$/g, "");
      if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'");

      if (url.pathname === "/api/chats") {
        const data = await chats();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        if (method === "HEAD") response.end();
        else response.end(JSON.stringify(data));
        return;
      }

      const match = /^\/api\/chats\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match) {
        const data = thread(match[1]);
        if (!data) {
          response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "Chat not found." }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        if (method === "HEAD") response.end();
        else response.end(JSON.stringify(data));
        return;
      }

      const asset = staticFiles.get(url.pathname);
      if (asset) {
        const [file, type] = asset;
        const body = await readFile(join(PUBLIC_DIR, file));
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        if (method === "HEAD") response.end();
        else response.end(body);
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error." }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.log(`Codex chats: http://127.0.0.1:${port}`);
  console.log(`Codex home: ${codexHome}`);

  const close = () => {
    server.close();
    scanner.close();
    state.close();
    history.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

start().catch((error) => {
  console.error(`codex-reader: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
