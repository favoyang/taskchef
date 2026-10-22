# Codex Chats reader

A local, read-only web view of the Codex chat databases in a Codex home
directory. It does not start Codex, contact OpenAI, or write to `~/.codex`.

## Run

```sh
npm run reader
# or
node tools/codex-reader/server.js
```

Open <http://127.0.0.1:4780>.

Use another Codex home directory (the directory normally named `.codex`):

```sh
node tools/codex-reader/server.js --codex-home /path/to/codex-home
node tools/codex-reader/server.js /path/to/codex-home
```

Change the port:

```sh
node tools/codex-reader/server.js --port 4781
```

## What it shows

- Active chats from `state_5.sqlite` and `thread_history_1.sqlite`.
- Codex pins from `.codex-global-state.json`.
- Active heartbeat schedules from `automations/` and `codex-dev.db`.
- Guardian review threads and subagent threads are excluded.
- Non-interactive `codex exec` runs are omitted. They are not chats; the review
  prompt rows that appear beside a subagent are the exec parent sessions.
- Thread list sorted by update time, newest first.
- Project, Pinned, and Scheduled filters in the top bar.

Archived chats are omitted from the list.
