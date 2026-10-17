# Board and settings

[Install TaskChef](https://taskchef.dev/docs/) and open it in the Codex sidebar.
Use Board for current work, [Calendar](https://taskchef.dev/docs/calendar/) for
recorded work dates, and [Usage](https://taskchef.dev/docs/usage/) for accounting.

## Read the Board

| Column | Meaning |
| --- | --- |
| Scheduled | A chat has an active schedule and has returned to its scheduled queue. |
| Running | The current recorded turn is in progress. |
| Waiting for review | A completed, interrupted, or failed turn needs attention. This does not always mean Codex asked a question. Live approval waits also appear here when available. |
| Done | The latest completed turn's PRs are confirmed merged, or you marked an eligible turn Done. This does not prove the whole assignment succeeded. |
| Archived | Chats archived in Codex, shown only when enabled in Settings. |
| Unverified | The recorded turn state is not recognized. |

Archived chats take precedence over other columns. Routine completed scheduled
prompts return to Scheduled. A human follow-up can leave a scheduled chat in
Waiting; drag an eligible card back to Scheduled to acknowledge it. This does
not change or pause its schedule.

Drag an eligible Waiting card to Done to mark its current turn complete. Active
schedules and running or approval-waiting turns cannot be marked Done. Any
latest-turn PRs must be confirmed merged first. A new turn resets the mark.
To archive, open the chat and use Codex's **… → Archive** menu. Dropping onto a
visible Archived column shows those instructions.

## Find and inspect chats

Choose a project, search, or enable **Pinned** to show Codex-pinned chats.
Search matches titles, prompt/reply excerpts, project names, known repository
names, and loaded latest-turn PR titles. Every search word must match somewhere;
matching ignores case. Search does not read the whole conversation. **Updated**
limits Board to the latest 24 hours, seven days, or All time (the default).
Calendar shares project, search, and Pinned; it ignores Updated.
Usage has its own range and project comparison controls.

Cards show the current request while running and the latest response otherwise.
Open Details for the recorded prompt and response, earlier turns, work time,
usage, queued prompts, questions, and PRs when available. Answer questions or
approve requests in Codex. Live approval detection depends on the running
Codex desktop connection; when unavailable, TaskChef uses saved turn state.

Work time counts recorded finished turns plus current running time. It excludes
idle review waits and child-chat time. Missing history can make it incomplete.
A rewind can limit the selected history. Usage includes linked descendants;
token totals and cost have different coverage from work time.

PR icons show draft, open, merged, closed, and check states. Hover or focus the
status line for details. Earlier-turn PRs can appear with an **Earlier turn PR**
label; they do not decide the current turn's Done state. See [GitHub setup](github.md).

## Settings and refresh

Open the header Settings button or TaskChef's installed plugin details page.
**Show CLI sessions**, **Show exec sessions**, and **Show archived chats** start
off. They affect Board and Calendar, not Usage accounting. Subagents and chats
without recorded turns do not appear on Board or Calendar.
**Show usage on cards** starts on; turning it off keeps usage in Details.
**Show calendar dates** replaces relative ages with local dates and times.
The palette control selects light, dark, or system appearance and a theme.

The full dashboard refreshes local data every five seconds while its document
is visible. The compact inline chat view loads once; use **Refresh** there.
The app's Refresh button updates data, including PR status. To reload dashboard
HTML after an update, use the sidebar context-menu **Refresh**; switching apps
alone may keep the loaded page.

The bell opens local notifications for completed ordinary turns, interruptions,
and action errors. Routine scheduled completions stay quiet. Notifications are
in-app messages, not operating-system alerts. Closed views do not run a background
scan, so intermediate completed turns may not be reconstructed later.

For missing chats or data errors, see [troubleshooting](troubleshooting.md).
