# TaskChef Next sidebar

TaskChef Next requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite connections. The rest of TaskChef continues to support the package's Node.js 18 minimum. An unsupported Node runtime produces a fatal version error before TaskChef Next opens a database.

Call `open_taskchef_board` in Codex to open **TaskChef Next**. In a sidebar or fullscreen host view, it shows the read-only board, filters, and chat details. In an inline chat view, it shows a short recent-chat list with direct **Open chat** actions. The app uses local Codex metadata and does not modify the TaskChef dispatcher workspace.

The server reads all eligible top-level chats from `~/.codex/state_5.sqlite` and their latest turn from `~/.codex/thread_history_1.sqlite`. Both SQLite connections are read-only. It excludes typed subagents and Guardian reviews, JSON subagent sources, known `thread_spawn_edges` children, chats with no turn record. Standalone `source=exec` and regular `source=cli` chats remain eligible in the collector, but the view hides them by default. The plugin details page has native switches for Show exec sessions, Show CLI sessions, and Show archived chats. The MCP server stores these choices in `~/.agents/taskchef-next/settings.json`, shared by all TaskChef Next views. Each visible poll reads the current settings, even when the database snapshot is unchanged. These choices apply to the board, counts, project choices, Details eligibility, and the compact inline view. Archived chats are hidden by default and use their own Archived column when shown. Details shows the recorded lifetime direct child count. Names and titles can contain user text; the app prefers name, then title, then a chat ID fallback.

The board uses these queue labels:

| Column | Rule |
| --- | --- |
| Scheduled | Latest completed input has a heartbeat marker matching a known automation, has no `clientId`, and that matching schedule is active. |
| Running | Latest selected turn is `inProgress`. There is no age cutoff. |
| Waiting for input/review | Latest turn completed, interrupted, or failed and the chat remains open. Interrupted or failed turns have an Interrupted tag. This does not prove Codex asked a question. |
| Done | Chat is marked Done in TaskChef Next. This does not prove the work succeeded. |
| Archived | Chat is archived in Codex. Hidden by default; separate from Done. |
| Unverified | An unrecognized turn state. |

Archived and manual Done marks take precedence. Active schedules remain visible as a badge even when the chat is Running or Waiting. After ordinary input, a completed scheduled chat goes to Waiting. The app reads active heartbeat links from `automations/*/automation.toml` and the latest first input from `thread_items`. It checks the observed `<heartbeat><automation_id>` wrapper; this internal format can change. Missing or unrecognized input markers use Waiting rather than guessing Scheduled. Schedule read errors appear as a warning. Paused schedules do not give an active schedule badge. Cron run history is not treated as an active heartbeat chat.

**Mark Done** changes only `~/.agents/taskchef-next/done.json`, using a lock and atomic write. The mark is bound to the current turn ID, so a new turn resets it. There is no Reopen button; send a new prompt in Codex to start another turn. Archived and in-progress chats cannot be marked from this app. Codex databases, rollout files, and dispatcher task reports are never modified. An unreadable or invalid Done state file produces a separate local-state error and blocks Done changes; the app preserves the file and does not call it a Codex database failure. Raw input text stays on the server; only the inferred input source is returned. See [the research note](taskchef-next-status-research.md) for the optional Luna judgment route.

Both databases and the expected tables must be available. Missing or incompatible databases, or failed queries, produce a fatal app error and clear the visible inventory. Rollout files never replace database inventory or status. The selected-chat detail may optionally read a bounded head and tail of the JSONL file at its database `rollout_path` for message counts and byte coverage. The path stays server-side. This detail never changes the database-derived status. If the path or file is absent or cannot be parsed, database metadata remains available. No raw transcript content is returned. All reads are local and read-only.

In sidebar or fullscreen mode, the mounted app requests a fresh snapshot every five seconds while `document.visibilityState` is `visible`. It pauses polling when the document becomes hidden and refreshes immediately when visible again. If Codex only hides a mounted iframe with CSS, the document may remain visible and polling may continue. Inline mode loads once and does not poll; manual **Refresh** remains available. Switching from inline to a full view starts polling and requests a fresh snapshot. Whether the host hides or unmounts the app is host-dependent. Mount, React unmount, document `visibilitychange`, window `pagehide`, display-mode, and host-teardown events are logged as single-string browser console warnings with the `[TaskChef] TaskChef Next lifecycle:` prefix, followed by JSON with only `visibility` and `displayMode`. For browser debugging, right-click the sidebar app and select **Dev Tools** in Codex. The console shows these lifecycle events. Repeated events are logged individually. `pagehide` can indicate iframe navigation or disposal even when React cleanup does not run. It does not prove that a sidebar switch disposed the iframe: the host may keep the iframe mounted, and a destroyed iframe may not deliver a final event.

The UI is bundled as the `ui://taskchef/task-board/v3` MCP resource. Build it with `npm run build:mcp-app`; run `npm run check:mcp-app` and the relevant tests before release. Reopen the app after rebuilding the resource.

The selected rollout filename determines the history lookup ID. Ordinary chats use the chat ID. After a revert, Codex keeps the chat ID but selects a filename ending in `<chat-id>_<rollout-id>.jsonl`. `thread_history_1.sqlite.thread_turns.thread_id` and `thread_items.thread_id` then use the rollout ID. The scanner follows `state_5.sqlite.threads.rollout_path` to select that ID; it does not open logs to get board status. For paginated history, a missing or unrecognized selected filename or invalid timestamp produces an explicit metadata error; old chat-ID rows are never substituted. A canonical filename must also identify the same stable chat. Legacy histories may use noncanonical filenames and retain Codex's stable-ID lookup rule.

Old history rows can remain under the original chat ID. Reading those rows instead of the selected rollout can show an old interrupted turn. This was a TaskChef lookup bug, not evidence that Codex's database was stale.

## Query and refresh rules

Every visible-document poll checks for database changes, at five-second intervals. Unchanged database records are cached; there is no timestamp cursor or changed-row query. Concurrent requests share an in-flight refresh. Showing the document again or clicking Refresh requests an immediate refresh.

Each database reload reads the eligible chat metadata, then runs `WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1` for each selected rollout ID. Codex's existing `idx_thread_turns_page` index supports this lookup. It no longer ranks every turn in the history table. The latest first input and linked final reply are read by their full primary keys: rollout ID, turn ID, and item ID; it never scans all message bodies. This server creates no indexes and writes nothing to Codex.

There is no 300-chat cap. All eligible chats with a current-rollout turn are included. Done cards still expand in small groups in Board view. This reduces the initial rendered board while keeping complete counts. List view includes all matching chats. If larger installations become slow, measure database time and rendering separately before adding pagination.

See the [storage schema](taskchef-next-storage.md), including the editable diagram and PNG.

### TaskChef Next card content

Cards show the chat title, project, a two-line excerpt of the latest saved assistant reply in the selected rollout's latest turn, last activity time, and Open chat. Next cards omit the clock icon and use local calendar dates: today shows only a time such as `2:30PM`, yesterday shows `Yesterday`, older dates show `July 7th`, with the year added for previous years. The tooltip retains the exact timestamp; clicking the date switches between compact and exact text. An active schedule remains a badge. The final reply uses `final_agent_item_id` and the full item primary key. When no final reply is linked, an indexed query reads the latest `agentMessage` in that same turn. Excerpts are capped at 2,000 characters; an absent reply is stated explicitly. Heartbeat wrappers show only their `<message>` text; a quiet heartbeat without that block has no reply excerpt. No model summarizes or judges the text. Saved replies render as Markdown: compact formatting on cards, and headings, lists, code blocks, and tables in Details. Links open in a new tab. Raw HTML is ignored; images appear as caption links without automatic image requests. Relative file links appear as text. Details still shows the bounded excerpt, not the whole conversation.

Queue reasons and lifetime direct-subagent counts appear in Details, alongside the saved reply excerpt. They are not card summaries. The ordinary TaskChef dashboard keeps its Request/Result and usage layout.



### Database change checks

Every visible five-second poll reads `PRAGMA data_version` on the same two read-only connections. The first poll, manual Refresh, or a changed counter runs the indexed database queries and replaces the cached records. An unchanged poll reuses those records; it does not query chat, turn, or item tables. Counters are captured before queries so commits during a read cause another read on the next poll. Neither connection holds a transaction between polls.

Every poll separately reads and parses `automations/*/automation.toml`. For the Done file, each poll checks file identity, modification/change timestamps, and size; it reads and parses contents only when those metadata change. Manual Refresh also rereads the contents. A missing file means no manual marks. Added, removed, paused, or changed schedules and Done marks therefore apply on the next poll, including when the databases are unchanged. Queue labels are rebuilt from cached records and current schedules/Done marks. An open chat whose latest selected turn is `inProgress` remains Running regardless of timestamp age. Time passing alone never changes its queue label.

Each poll checks both database file identities. Replacement reconnects and reloads; missing files or database/query errors discard the cache and clear the board with a fatal error. A later poll retries. Server shutdown closes the connections. The scan readout reports whether database records were queried or reused. This skips unchanged snapshots; it does not fetch only changed rows.

PR-based Done labels are planned, not implemented. For completed chats, the intended rule is all attached PRs merged → Done; an unmerged attached PR → Waiting for review. GitHub status must come from an authenticated source before these labels can be applied.

### Native plugin settings

TaskChef Next advertises `openai/settings` with `taskchef_settings_read` and
`taskchef_settings_update`. The read tool returns the schema, current values,
and a Chat visibility group. The update tool accepts only changed Boolean
properties and preserves the others. All three switches default to false.
Updates use the existing local workspace lock and atomic file writer. Codex
SQLite files remain read-only. Invalid settings fail visibly rather than
silently resetting preferences.

Open the installed TaskChef Next plugin details page to edit its native
settings. The sidebar receives them at its next visible refresh, or immediately
when Refresh is clicked. Settings persist across sidebar and embedded views.
The old browser-local visibility keys are no longer used; configure the native
switches once after upgrading. The Board/List choice stays browser-local.
See the [OpenAI structured settings specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#structured-settings).

### Board presentation

TaskChef Next exposes only Board. The List implementation remains in the
source, but the Board/List selector is hidden and saved List choices are
ignored. Interrupted chats appear in Waiting for input/review with an
Interrupted tag; their recorded status remains available in Details.
Scheduled, Running, Waiting, and Done remain visible when empty, with a short
message specific to each column. This keeps their positions steady when chats
change state or filters change. Archived remains an optional column.

The header Settings icon opens the installed local plugin details page using
its configured marketplace root. If that root cannot be resolved, it opens
the plugin browser. This desktop link was checked against the installed
app's link parser; it is not part of the published MCP settings specification.
Native host navigation still needs a manual check where host automation is
unavailable.

### Reply image covers

Next board cards feature the first supported Markdown image in the latest
selected assistant reply, above the title. The full saved reply is inspected,
even when the image occurs after the 2,000-character text excerpt. Code examples
and raw HTML do not count as images. No image is borrowed from an older turn.

Covers load when near the visible area. HTTPS images load directly in the
sidebar without a referrer. Local absolute paths load through an app-only MCP
tool tied to the chat, turn and saved image URL. Local PNG, JPEG, GIF and WebP
files up to 4 MiB are supported; no remote URL is fetched by the MCP server.
Missing, oversized, unsupported or failed image covers are hidden.
Click a cover to open chat Details. Text and navigation remain available.
The Markdown text renderer still shows image captions rather than inline images.

This follows Trello’s image-above-title cover option:
[Add a card cover](https://support.atlassian.com/trello/docs/what-is-a-card-cover).


### Next notifications

The bell beside Settings opens the notification center. It has All and Unread
filters, Mark all read, and Clear all. Click a chat message to open Details and
mark it read. New messages appear in a five-second overlay toast; the board does
not move. At most three toasts are shown at once. Saved messages do not replay
as toasts when a view opens.

- A new completed turn with a verified ordinary input creates an unread “ready for input or review” message.
- An interrupted or failed turn creates an unread interruption message, including scheduled failures.
- Routine scheduled completions stay quiet.
- Mark Done creates a confirmation that is already read. It does not increase the unread badge.
- Opening a chat, copying an ID, and refreshing have no success message. Action failures use the same center.
- Database read errors remain visible on the board until recovery.

The MCP process stores the newest 100 messages, read status, and per-chat turn
watermarks in `notifications.json` beside its settings file. Views share this
file through the existing lock and atomic writer; no daemon is added. Clear all
removes messages but keeps watermarks, so polling cannot replay cleared events.
The first successful scan establishes a quiet baseline. Subsequent visible
five-second refreshes reconcile changes, including cached database snapshots.
Exec and CLI visibility settings also suppress notifications from hidden sources;
project and date filters only change the board. Archived chats stay quiet. Saved notifications can still open Details for a chat
that is now hidden by Settings.

When views are closed or hidden, no background scan runs. A later refresh can
notice the latest saved turn change. It cannot reconstruct intermediate turns
that finished while no view was checking. Notifications are local app messages;
this feature does not send OS notifications. A damaged notification file fails
visibly and is preserved for repair.
