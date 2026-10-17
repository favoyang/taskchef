# Troubleshooting

For installation steps, see [Get started](https://taskchef.dev/docs/).
For common questions, see the [FAQ](https://taskchef.dev/docs/faq/).

## Missing chats or unavailable data

Clear project, search, Pinned, and Updated filters. Enable CLI, exec, or archived
chats in Settings if needed. Calendar has a separate Scheduled toggle.
Subagents and chats without a recorded turn stay off Board and Calendar.
These filters do not narrow Usage accounting.

TaskChef requires local Codex databases (`state_5.sqlite` and
`thread_history_1.sqlite` under the Codex home). Missing or incompatible tables
or failed queries show a data error. Open Codex, check that its local data is
available, and refresh. Do not edit databases to change TaskChef status.

Use the app's **Refresh** button for current data. After updating the plugin,
restart Codex for backend changes and use sidebar context-menu **Refresh** to
reload an already-open dashboard. For PR errors, see [GitHub connection](github.md).

## Usage and work-time differences

Usage reads local rollout records; missing or deleted logs and unknown model
prices can leave estimates incomplete. Cost is not a bill. Weekly limits use
logged observations; TaskChef does not query the service for a live allowance.
An expired reading stays unavailable until a new one is recorded.
Work time excludes idle waits and child-chat time; token usage includes linked
subagents. Calendar uses the selected recorded turn history, so rewinds or
missing timing can omit earlier work. See the
[Usage](https://taskchef.dev/docs/usage/) and
[Calendar](https://taskchef.dev/docs/calendar/) guides.

## Local state errors

Preserve a damaged settings or queue-mark file before seeking support. Do not
reset the entire state directory. See [local data and storage](taskchef-next-storage.md)
for current storage locations and offline recovery when startup reports a
storage migration error.
