# TaskChef Next sidebar

TaskChef Next requires Node.js 22.18.0 or later for read-only SQLite connections. The rest of TaskChef continues to support the package's Node.js 18 minimum. An older Node runtime produces a fatal version error before TaskChef Next opens a database.

Call `open_taskchef_board` in Codex to open **TaskChef Next**. In a sidebar or fullscreen host view, it shows the read-only List and Board views, filters, and chat details. In an inline chat view, it shows a short recent-chat list with direct **Open chat** actions. The app uses local Codex metadata and does not modify the TaskChef dispatcher workspace.

The server reads up to 300 recent chats from `~/.codex/state_5.sqlite` and their latest turn status from `~/.codex/thread_history_1.sqlite`. It uses read-only SQLite connections. It reads IDs, names, titles, timestamps, working directories, archive flags, and turn statuses. It displays a nonempty name first, then a nonempty title, then a chat ID fallback. Names and titles can contain user text. It does not read transcripts, `item_json`, tool output, or message bodies for the inventory. A recent `inProgress` turn can mark a chat **Working**, but live activity is unverified. Other statuses remain **Unresolved** because a turn status does not establish task outcome.

Both databases and the expected tables must be available. Missing or incompatible databases, or failed queries, produce a fatal app error and clear the visible inventory. Rollout files never replace database inventory or status. The selected-chat detail may optionally read a bounded head and tail of the JSONL file at its database `rollout_path` for message counts and byte coverage. The path stays server-side. This detail never changes the database-derived status. If the path or file is absent or cannot be parsed, database metadata remains available. No raw transcript content is returned. All reads are local and read-only.

In sidebar or fullscreen mode, the mounted app requests a fresh snapshot every five seconds while `document.visibilityState` is `visible`. It pauses polling when the document becomes hidden and refreshes immediately when visible again. If Codex only hides a mounted iframe with CSS, the document may remain visible and polling may continue. Inline mode loads once and does not poll; manual **Refresh** remains available. Switching from inline to a full view starts polling and requests a fresh snapshot. Whether the host hides or unmounts the app is host-dependent. A small readout reports the current document visibility and host display mode. Mount, React unmount, document `visibilitychange`, window `pagehide`, display-mode, and host-teardown events are logged as single-string browser console warnings with the `TaskChef Next lifecycle:` prefix, followed by JSON with only `visibility` and `displayMode`. Repeated events are logged individually. `pagehide` can indicate iframe navigation or disposal even when React cleanup does not run. It does not prove that a sidebar switch disposed the iframe: the host may keep the iframe mounted, and a destroyed iframe may not deliver a final event.

On macOS, Codex desktop logs are under `~/Library/Logs/com.openai.codex/YYYY/MM/DD/codex-desktop-*.log`. To watch lifecycle events across all current desktop log files for today, run:

```sh
log_dir="$HOME/Library/Logs/com.openai.codex/$(date +%Y/%m/%d)"
tail -n 0 -F "$log_dir"/codex-desktop-*.log | rg --line-buffered 'TaskChef Next lifecycle:'
```

Start the command before opening TaskChef Next. Re-run it after restarting Codex or when log rotation creates a new file, because the command only selects files present when it starts. If no log file exists yet, start Codex and then run the command. The logs show events delivered to the app. Closing or hiding a view may produce no lifecycle event if the host keeps its iframe mounted and visible. The `unmounted` warning describes React effect cleanup; it requires a React unmount and is not a general iframe disposal signal.

The UI is bundled as the `ui://taskchef/task-board/v3` MCP resource. Build it with `npm run build:mcp-app`; run `npm run check:mcp-app` and the relevant tests before release. Reopen the app after rebuilding the resource.
