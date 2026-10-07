# TaskChef Next sidebar

TaskChef Next requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite connections. The rest of TaskChef continues to support the package's Node.js 18 minimum. An unsupported Node runtime produces a fatal version error before TaskChef Next opens a database.

Call `open_taskchef_board` in Codex to open **TaskChef Next**. In a sidebar or fullscreen host view, it shows the read-only List and Board views, filters, and chat details. In an inline chat view, it shows a short recent-chat list with direct **Open chat** actions. The app uses local Codex metadata and does not modify the TaskChef dispatcher workspace.

The server reads all eligible top-level chats from `~/.codex/state_5.sqlite` and their latest turn from `~/.codex/thread_history_1.sqlite`. Both SQLite connections are read-only. It excludes typed subagents and Guardian reviews, JSON subagent sources, known `thread_spawn_edges` children, and chats with no turn record. Regular CLI chats remain eligible. The parent summary shows its recorded direct child count. Names and titles can contain user text; the app prefers name, then title, then a chat ID fallback.

The board uses these queue labels:

| Column | Rule |
| --- | --- |
| Scheduled | Latest completed input has a heartbeat marker matching a known automation, has no `clientId`, and that matching schedule is active. |
| Running | Latest turn is `inProgress` with activity within two minutes. Live activity remains unverified. |
| Waiting for input/review | Latest turn completed and the chat remains open. This does not prove Codex asked a question. |
| Interrupted | Latest turn is `interrupted` or `failed`. |
| Done | Chat is archived or marked Done in TaskChef Next. This does not prove the work succeeded. |
| Unverified | Old `inProgress` or an unrecognized turn state. |

Archived and manual Done marks take precedence. Active schedules remain visible as a badge even when the chat is Running or Waiting. After ordinary input, a completed scheduled chat goes to Waiting. The app reads active heartbeat links from `automations/*/automation.toml` and the latest first input from `thread_items`. It checks the observed `<heartbeat><automation_id>` wrapper; this internal format can change. Missing or unrecognized input markers use Waiting rather than guessing Scheduled. Schedule read errors appear as a warning. Paused schedules do not give an active schedule badge. Cron run history is not treated as an active heartbeat chat.

**Mark Done** and **Reopen** change only `~/.agents/taskchef-next/done.json`, using a lock and atomic write. The mark is bound to the current turn ID, so a new turn resets it. Archived and in-progress chats cannot be marked from this app. Codex databases, rollout files, and dispatcher task reports are never modified. An unreadable or invalid Done state file produces a separate local-state error and blocks Done changes; the app preserves the file and does not call it a Codex database failure. Raw input text stays on the server; only the inferred input source is returned. See [the research note](taskchef-next-status-research.md) for the optional Luna judgment route.

Both databases and the expected tables must be available. Missing or incompatible databases, or failed queries, produce a fatal app error and clear the visible inventory. Rollout files never replace database inventory or status. The selected-chat detail may optionally read a bounded head and tail of the JSONL file at its database `rollout_path` for message counts and byte coverage. The path stays server-side. This detail never changes the database-derived status. If the path or file is absent or cannot be parsed, database metadata remains available. No raw transcript content is returned. All reads are local and read-only.

In sidebar or fullscreen mode, the mounted app requests a fresh snapshot every five seconds while `document.visibilityState` is `visible`. It pauses polling when the document becomes hidden and refreshes immediately when visible again. If Codex only hides a mounted iframe with CSS, the document may remain visible and polling may continue. Inline mode loads once and does not poll; manual **Refresh** remains available. Switching from inline to a full view starts polling and requests a fresh snapshot. Whether the host hides or unmounts the app is host-dependent. Mount, React unmount, document `visibilitychange`, window `pagehide`, display-mode, and host-teardown events are logged as single-string browser console warnings with the `[TaskChef] TaskChef Next lifecycle:` prefix, followed by JSON with only `visibility` and `displayMode`. For browser debugging, right-click the sidebar app and select **Dev Tools** in Codex. The console shows these lifecycle events. Repeated events are logged individually. `pagehide` can indicate iframe navigation or disposal even when React cleanup does not run. It does not prove that a sidebar switch disposed the iframe: the host may keep the iframe mounted, and a destroyed iframe may not deliver a final event.

The UI is bundled as the `ui://taskchef/task-board/v3` MCP resource. Build it with `npm run build:mcp-app`; run `npm run check:mcp-app` and the relevant tests before release. Reopen the app after rebuilding the resource.

The selected rollout filename determines the history lookup ID. Ordinary chats use the chat ID. After a revert, Codex keeps the chat ID but selects a filename ending in `<chat-id>_<rollout-id>.jsonl`. `thread_history_1.sqlite.thread_turns.thread_id` and `thread_items.thread_id` then use the rollout ID. The scanner follows `state_5.sqlite.threads.rollout_path` to select that ID; it does not open logs to get board status. For paginated history, a missing or unrecognized selected filename or invalid timestamp produces an explicit metadata error; old chat-ID rows are never substituted. A canonical filename must also identify the same stable chat. Legacy histories may use noncanonical filenames and retain Codex's stable-ID lookup rule.

Old history rows can remain under the original chat ID. Reading those rows instead of the selected rollout can show an old interrupted turn. This was a TaskChef lookup bug, not evidence that Codex's database was stale.

## Query and refresh rules

Every visible-document poll requests a fresh database snapshot, at five-second intervals. There is no timestamp cursor or incremental cache. Concurrent requests share an in-flight refresh. Showing the document again or clicking Refresh requests an immediate refresh.

Each refresh reads the eligible chat metadata, then runs `WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1` for each selected rollout ID. Codex's existing `idx_thread_turns_page` index supports this lookup. It no longer ranks every turn in the history table. Only the latest first input item is read by its full primary key: rollout ID, turn ID, and item ID; it never scans all message bodies. This server creates no indexes and writes nothing to Codex.

There is no 300-chat cap. All eligible chats with a current-rollout turn are included. Done cards still expand in small groups in Board view. This reduces the initial rendered board while keeping complete counts. List view includes all matching chats. If larger installations become slow, measure database time and rendering separately before adding pagination or a cache.

See the [storage schema](taskchef-next-storage.md), including the editable diagram and PNG.
