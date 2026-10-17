# TaskChef

A native dashboard for your Codex chats. See running work, review requests,
queued prompts, pull requests, recorded work, and usage in one sidebar.
Chats appear regardless of how they were started; no delegation setup is needed.

## Install and open

In Codex, open **Settings → Plugins → Add → Add a marketplace** and enter
`https://github.com/favoyang/taskchef.git`. Leave Git ref as `main` and Sparse
paths empty. In **Plugins → Personal**, install **TaskChef** from **TaskChef**.
Or use the Codex CLI:

```sh
codex plugin marketplace add favoyang/taskchef
codex plugin add taskchef@taskchef
```

Restart Codex. Open **…** below Plugins in the left dock, select **TaskChef**,
and pin it to keep the dashboard in the sidebar.

TaskChef needs local Codex data and Node.js 22.18+ in the 22 series, or 23.2
and newer. Node.js 24 is recommended. npm is needed for installation; the
published package includes server dependencies. See the
[installation guide](https://taskchef.dev/docs/) and
[troubleshooting](docs/troubleshooting.md).

## Your dashboard

- **Board** groups chats into Scheduled, Running, Waiting for review, and Done.
  Open a card for its recorded prompt, response, work time, usage, and PRs;
  **Open chat** returns to Codex. Use project, search, Updated, and Pinned filters.
  [Board and settings guide](docs/dashboard.md).
- **Calendar** shows recorded work by local date, with gaps and resumed work.
  It is work history, not a future schedule planner. Project, search, and Pinned
  apply; Updated does not. **Scheduled** starts on; turn it off to hide chats
  with active schedules. [Calendar guide](https://taskchef.dev/docs/calendar/).
- **Usage** compares recorded tokens and estimated cost over time and by project.
  It includes desktop, CLI, exec, archived, and linked subagent usage, regardless
  of Board filters. Cost uses current API-equivalent prices, not subscription
  charges. Missing logs or prices can leave totals incomplete. Weekly limits
  are logged allowance observations, not a live balance; an expired reading is
  unavailable until another arrives. [Usage guide](https://taskchef.dev/docs/usage/).

Open Settings to show CLI, exec, or archived chats, which are hidden from Board
and Calendar by default. Subagents stay off those views. Connect GitHub for PR
and CI status and merge-based Done placement. Green checks alone do not mean
approval or merge. [GitHub setup](docs/github.md).

Codex owns chat history and execution. TaskChef reads local Codex databases and
logs and keeps its settings, Done marks, notifications, and caches locally.
GitHub is optional. See [privacy](https://taskchef.dev/privacy/) and
[the product contract](docs/spec.md).

## Optional delegation

In Codex's floating chat, use `$taskchef:delegate Do X in Y project.` The skill
finds the native project, creates an ordinary Codex chat, and returns its link.
It asks when the destination is unclear. See the [delegate skill](skills/delegate/SKILL.md).

## Help

[FAQ](https://taskchef.dev/docs/faq/) · [Support](https://taskchef.dev/support/) ·
[Report a bug](https://github.com/favoyang/taskchef/issues/new?template=bug_report.yml) ·
[Request a feature](https://github.com/favoyang/taskchef/issues/new?template=feature_request.yml) ·
[Terms](https://taskchef.dev/terms/)
