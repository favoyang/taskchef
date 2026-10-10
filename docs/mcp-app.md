# TaskChef sidebar

The public app name is **TaskChef**. “TaskChef Next” remains the internal project name.

TaskChef requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite connections. The rest of TaskChef continues to support the package's Node.js 18 minimum. An unsupported Node runtime produces a fatal version error before TaskChef opens a database.

Call `open_taskchef_board` in Codex to open **TaskChef**. In a sidebar or fullscreen host view, it shows the read-only board, filters, and chat details. In an inline chat view, it shows a short recent-chat list with direct **Open chat** actions. The app uses local Codex metadata and does not modify the TaskChef dispatcher workspace.

The server reads all eligible top-level chats from `~/.codex/state_5.sqlite` and their latest turn from `~/.codex/thread_history_1.sqlite`. Both SQLite connections are read-only. It excludes typed subagents and Guardian reviews, JSON subagent sources, known `thread_spawn_edges` children, chats with no turn record. Standalone `source=exec` and regular `source=cli` chats remain eligible in the collector, but the view hides them by default. The plugin details page has native switches for Show exec sessions, Show CLI sessions, and Show archived chats. The MCP server stores these choices in `~/.agents/taskchef-next/settings.json`, shared by all TaskChef views. Each visible poll reads the current settings, even when the database snapshot is unchanged. These choices apply to the board, counts, project choices, Details eligibility, and the compact inline view. Archived chats are hidden by default and use their own Archived column when shown. Details shows the recorded lifetime direct child count. Names and titles can contain user text; the app prefers name, then title, then a chat ID fallback.

The board uses these queue labels:

| Column | Rule |
| --- | --- |
| Scheduled | Active schedule with a normally completed scheduled prompt, a completed human turn whose PRs are all merged, or a human turn acknowledged by a drop into Scheduled. |
| Running | Latest selected turn is `inProgress`. There is no age cutoff. |
| Waiting for input/review | Latest turn completed, interrupted, or failed and the chat remains open. Interrupted or failed turns have an Interrupted tag. This does not prove Codex asked a question. |
| Done | A chat is marked Done in TaskChef, or its latest turn completed and all attached PRs are confirmed merged. Manual marks require any attached PRs to be confirmed merged. Both require no active schedule. This does not prove the larger task succeeded. |
| Archived | Chat is archived in Codex. Hidden by default; separate from Done. |
| Unverified | An unrecognized turn state. |

Archived takes precedence. Manual Done marks apply only without active schedules; every attached PR must be confirmed merged. A normally completed scheduled prompt returns to Scheduled regardless of PR status. After a completed human turn, attached PRs determine Done or Waiting for ordinary chats, and Scheduled or Waiting for actively scheduled chats. A manual acknowledgement returns an idle scheduled human turn to Scheduled. Active schedules remain visible as a badge even when the chat is Running or Waiting. After ordinary input, a completed scheduled chat goes to Waiting. The app reads active heartbeat links from `automations/*/automation.toml` and the latest first input from `thread_items`. It checks the observed `<heartbeat><automation_id>` wrapper; this internal format can change. Missing or unrecognized input markers use Waiting rather than guessing Scheduled. Schedule read errors appear as a warning. Paused schedules do not give an active schedule badge. Cron run history is not treated as an active heartbeat chat.

**Mark Done** changes only `~/.agents/taskchef-next/done.json`, using a lock and atomic write. The mark is bound to the current turn ID, so a new turn resets it. There is no Reopen button; send a new prompt in Codex to start another turn. Archived, in-progress, and actively scheduled chats cannot be marked Done from this app. PR-linked chats require confirmed merge status before a Done drop is allowed. Codex databases, rollout files, and dispatcher task reports are never modified. An unreadable or invalid Done state file produces a separate local-state error and blocks Done changes; the app preserves the file and does not call it a Codex database failure. Raw input text stays on the server; only the inferred input source is returned. See [the research note](taskchef-next-status-research.md) for the optional Luna judgment route.

Both databases and the expected tables must be available. Missing or incompatible databases, or failed queries, produce a fatal app error and clear the visible inventory. Rollout files never replace database inventory or status. The selected-chat detail may optionally read a bounded head and tail of the JSONL file at its database `rollout_path` for message counts and byte coverage. The path stays server-side. This detail never changes the database-derived status. If the path or file is absent or cannot be parsed, database metadata remains available. The board returns a bounded excerpt of the latest saved assistant reply for cards and Details; it does not return the whole transcript. All reads are local and read-only.

In sidebar or fullscreen mode, the mounted app requests a fresh snapshot every five seconds while `document.visibilityState` is `visible`. It pauses polling when the document becomes hidden and refreshes immediately when visible again. If Codex only hides a mounted iframe with CSS, the document may remain visible and polling may continue. Inline mode loads once and does not poll; manual **Refresh** remains available. Switching from inline to a full view starts polling and requests a fresh snapshot. Whether the host hides or unmounts the app is host-dependent. Mount, React unmount, document `visibilitychange`, window `pagehide`, display-mode, and host-teardown events are logged as single-string browser console warnings with the `[TaskChef] TaskChef lifecycle:` prefix, followed by JSON with only `visibility` and `displayMode`. For browser debugging, right-click the sidebar app and select **Dev Tools** in Codex. The console shows these lifecycle events. Repeated events are logged individually. `pagehide` can indicate iframe navigation or disposal even when React cleanup does not run. It does not prove that a sidebar switch disposed the iframe: the host may keep the iframe mounted, and a destroyed iframe may not deliver a final event.

The UI is bundled as the `ui://taskchef/task-board/v3` MCP resource. Build it with `npm run build:mcp-app`; run `npm run check:mcp-app` and the relevant tests before release. Use Codex’s sidebar context-menu **Refresh** to reload its HTML and restart the widget. The app’s own Refresh button updates board data only.

The selected rollout filename determines the history lookup ID. Ordinary chats use the chat ID. After a revert, Codex keeps the chat ID but selects a filename ending in `<chat-id>_<rollout-id>.jsonl`. `thread_history_1.sqlite.thread_turns.thread_id` and `thread_items.thread_id` then use the rollout ID. The scanner follows `state_5.sqlite.threads.rollout_path` to select that ID; it does not open logs to get board status. For paginated history, a missing or unrecognized selected filename or invalid timestamp produces an explicit metadata error; old chat-ID rows are never substituted. A canonical filename must also identify the same stable chat. Legacy histories may use noncanonical filenames and retain Codex's stable-ID lookup rule.

Old history rows can remain under the original chat ID. Reading those rows instead of the selected rollout can show an old interrupted turn. This was a TaskChef lookup bug, not evidence that Codex's database was stale.

## Query and refresh rules

Every visible-document poll checks for database changes, at five-second intervals. Unchanged database records are cached; there is no timestamp cursor or changed-row query. Concurrent requests share an in-flight refresh. Showing the document again or clicking Refresh requests an immediate refresh.

Each database reload reads the eligible chat metadata, then runs `WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1` for each selected rollout ID. Codex's existing `idx_thread_turns_page` index supports this lookup. It no longer ranks every turn in the history table. The latest first input and linked final reply are read by their full primary keys: rollout ID, turn ID, and item ID; it never scans all message bodies. This server creates no indexes and writes nothing to Codex.

There is no 300-chat cap. All eligible chats with a current-rollout turn are included. Done cards still expand in small groups in Board view. This reduces the initial rendered board while keeping complete counts. List view includes all matching chats. If larger installations become slow, measure database time and rendering separately before adding pagination.

See the [storage schema](taskchef-next-storage.md), including the editable diagram and PNG.

### TaskChef card content

Cards show the chat title, project, a two-line excerpt of the latest saved assistant reply in the selected rollout's latest turn, last activity time, and Open chat. TaskChef cards omit the clock icon and use local calendar dates: today shows only a time such as `2:30PM`, yesterday shows `Yesterday`, older dates show `July 7th`, with the year added for previous years. The tooltip retains the exact timestamp; clicking the date switches between compact and exact text. An active schedule remains a badge. The final reply uses `final_agent_item_id` and the full item primary key. When no final reply is linked, an indexed query reads the latest `agentMessage` in that same turn. Excerpts are capped at 2,000 characters; an absent reply is stated explicitly. Heartbeat wrappers show only their `<message>` text; a quiet heartbeat without that block has no reply excerpt. No model summarizes or judges the text. Saved replies render as Markdown: compact formatting on cards, and headings, lists, code blocks, and tables in Details. Links open in a new tab. Raw HTML is ignored; images appear as caption links without automatic image requests. Relative file links appear as text. Details still shows the bounded excerpt, not the whole conversation.

Queue reasons and lifetime direct-subagent counts appear in Details, alongside the saved reply excerpt. They are not card summaries. The ordinary TaskChef dashboard keeps its Request/Result and usage layout.



### Database change checks

Every visible five-second poll reads `PRAGMA data_version` on the same two read-only connections. The first poll, manual Refresh, or a changed counter runs the indexed database queries and replaces the cached records. An unchanged poll reuses those records; it does not query chat, turn, or item tables. Counters are captured before queries so commits during a read cause another read on the next poll. Neither connection holds a transaction between polls.

Every poll separately reads and parses `automations/*/automation.toml`. For the Done file, each poll checks file identity, modification/change timestamps, and size; it reads and parses contents only when those metadata change. Manual Refresh also rereads the contents. A missing file means no manual marks. Added, removed, paused, or changed schedules and Done marks therefore apply on the next poll, including when the databases are unchanged. Queue labels are rebuilt from cached records and current schedules/Done marks. An open chat whose latest selected turn is `inProgress` remains Running regardless of timestamp age. Time passing alone never changes its queue label.

Each poll checks both database file identities. Replacement reconnects and reloads; missing files or database/query errors discard the cache and clear the board with a fatal error. A later poll retries. Server shutdown closes the connections. The scan readout reports whether database records were queried or reused. This skips unchanged snapshots; it does not fetch only changed rows.

PR-based Done labels use saved Codex attachments and authenticated GitHub status. After a completed turn, all attached PRs confirmed merged means Scheduled while a schedule is active, otherwise Done. An unmerged or unavailable PR means Waiting for review. See [GitHub setup](taskchef-next-github.md); registration and real sign-in remain required.

### Native plugin settings

TaskChef advertises `openai/settings` with `taskchef_settings_read` and
`taskchef_settings_update`. The read tool returns the schema, current values,
and Chat visibility, Card display, and GitHub groups. The update tool accepts
changed Boolean preferences and preserves other values. All switches default
to false. Card timestamps default to compact ages: `<1m`, `1m`, `2h`, `5d`,
and `1mo` (30-day months). Enable **Show calendar dates** to use the previous
local format: `2:30PM` today, `Yesterday`, or `Oct 3rd`. Running cards keep
their hourglass and elapsed work duration in either mode.
Updates use the existing local workspace lock and atomic file writer. Codex
SQLite files remain read-only. Invalid settings fail visibly rather than
silently resetting preferences.

Open the installed TaskChef plugin details page to edit its native
settings. The sidebar receives them at its next visible refresh, or immediately
when Refresh is clicked. Settings persist across sidebar and embedded views.
The old browser-local visibility keys are no longer used; configure the native
switches once after upgrading. The Board/List choice stays browser-local.
See the [OpenAI structured settings specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#structured-settings).

### Board presentation

TaskChef exposes only Board. The List implementation remains in the
source, but the Board/List selector is hidden and saved List choices are
ignored. Interrupted chats appear in Waiting for input/review with an
Interrupted tag; their recorded status remains available in Details.
Scheduled, Running, Waiting, and Done remain visible when empty, with a short
message specific to each column. This keeps their positions steady when chats
change state or filters change. Archived remains an optional column.

The header Settings icon calls the app-only `taskchef_app_open_settings` tool.
The server resolves this installed plugin's marketplace catalog file and requests its
native details page through the operating system's Codex URL handler, using the
same method as Open chat. It does not depend on the MCP view's link handler.
An unresolved plugin location or failed desktop opener produces a notification.
The deep link is based on the installed desktop parser, not the published MCP
settings specification. A successful opener only confirms that navigation was
requested; the native page still needs a manual check where host automation is
unavailable.

### Project picker

The searchable picker uses `projects` and `project_roots` from `state_5.sqlite`,
including saved projects that have no visible chats. Project names and order
come from the saved registry. Chats use `threads.project_id` first. Older
assignments use the desktop's project ID migration map and project root hints
from `.codex-global-state.json`. Git's `.git` pointer and `commondir` identify a
worktree's original checkout when no assignment is saved. Nested folders match
the most specific saved project root. Working folders remain in chat details.

Projectless chat IDs, folders under `~/Documents/Codex`, and folders that do not
match a saved project share the **No project** entry. **All projects** clears the
filter. The dropdown has folder icons, a check for the selection, search by name
or path, and keyboard navigation. It does not create projects.

Project settings changes are checked on the next visible poll. The desktop
settings file is parsed only when its file stamp changes. Its unrelated fields
are never returned to the view. Invalid project metadata produces a visible
error; it does not silently replace the saved inventory.

### Reply image covers

TaskChef board cards feature the first supported Markdown image in the latest
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


### TaskChef notifications

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


## Local UI review without restarting Codex

For UI-only changes, update the HTML in the installation that the running MCP
server uses. Do not install a new preview version for each style change. Codex
can keep the old MCP process running while a plugin update removes its old
folder. Its next resource read then fails with `ENOENT`, and the sidebar shows
“Couldn't refresh app”.

From the source checkout, run:

```sh
npm run update:mcp-app-preview -- /path/to/the/running/taskchef-next/version
```

The helper builds the UI, checks the target is TaskChef, and replaces only
`src/mcp-app/dist/index.html` atomically. It preserves the plugin version, server
code, dependencies, and local data. It refuses missing or redirected HTML paths.
Then right-click **TaskChef** in the Codex sidebar and choose **Refresh**.
Switching sidebar apps only hides the loaded view; it does not reload its HTML.

Use the current installation’s version folder. If Refresh reports a missing
older version in the desktop logs, the MCP process still uses that old folder;
updating a different folder will not repair it. A full plugin/runtime update is
still needed for server code or dependency changes. This helper is for local
preview review, not production plugin distribution.

## GitHub PR status

TaskChef reads saved PR attachments and can connect to GitHub with device
sign-in. See [GitHub setup and board rules](taskchef-next-github.md).


### Chat search

**Search chats** matches chat titles, saved reply excerpts, project names,
known project repositories, and latest-turn PR titles and repository names.
Matching ignores letter case; every word must match somewhere in those fields.
Project and time filters still apply.

Search uses the current snapshot. PR titles become searchable after GitHub
loads them; repository names from saved PR URLs are searchable before status
loads. Search does not add a separate GitHub lookup or scan local Git remotes.
The existing visible-card refresh still runs when the displayed cards change.


## Dragging chats between queues

Every card can drag. Valid destination columns are highlighted during dragging, with padding between
the rounded column border and its cards.
Done and Scheduled moves require a Waiting card (including Interrupted cards).
Cards from any column can drop into Archived to show the archive instructions. Dropping a chat
without an active schedule into Done uses the existing local Done mark.
Attached PRs must all be confirmed merged by the server. The mark also records
the confirmed URLs; a newly attached PR invalidates that acknowledgement.
Blocked drops leave the card in place and explain the rule through TaskChef
notifications. An active scheduled chat with a human turn can return to
Scheduled. This acknowledgement is stored under `scheduled:<chat-id>` in the
local mark file and is bound to the selected turn ID. It expires when a new
turn starts and does not change or pause the automation.

Dropping into the visible Archived column opens instructions and an Open chat
button. The user archives the chat through Codex's top-right **… → Archive**
menu. This sidebar does not invoke CLI archiving, and it does not show an
Archive drop target when the Archived column is hidden.


The first board fetch shows Loading… in empty columns. Later empty columns use
their normal queue messages. Cards slide between positions when the board updates;
reduced-motion preferences disable the slide. Opening the notification center
marks notifications read as they become visible in its scrollable panel.

The Waiting column is titled Waiting for review. Hovering the notification bell
opens the center; moving into its panel keeps it open, and leaving closes it after
a short delay. The button remains usable with a keyboard or touch.

The Theme selector after Refresh offers Dark (default), Light, and System. The choice is saved in this view's local storage and restored when it reopens. System follows the operating system's appearance.
