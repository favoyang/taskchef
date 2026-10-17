# TaskChef product contract

TaskChef is a local Codex dashboard. Codex owns chat identity, execution,
recorded prompts and replies, turn state, schedules, queued prompts, and token
records. TaskChef reads Codex databases and logs without rewriting them.

## Dashboard and local state

The plugin runs a local stdio MCP server with a bundled sidebar UI. Board and
Calendar show eligible top-level chats with recorded turns. Visibility settings
can include CLI, exec, and archived chats; subagents remain off those views.
Usage accounts for all recorded chat sources, including archived chats and
linked descendants counted once under the root project's attribution.

TaskChef owns preferences, turn-bound Done and Scheduled acknowledgements,
notification state, optional delegation routing notes, and derived scan, PR,
usage, and pricing caches. Settings and persistent state use protected local
writes. Invalid persistent state fails visibly and is preserved for repair.
GitHub credentials remain in the system credential store.

Done describes the selected turn. A new turn invalidates its acknowledgement.
Running and live approval waits cannot be marked Done. Attached latest-turn PRs
require confirmed merge status; active schedules prevent Done placement.
Calendar dates represent recorded work, not planned future execution.
Usage cost is an API-equivalent estimate; allowance readings are logged
observations. Missing records can make accounting incomplete.

## Actions and external access

Open chat returns to Codex. Users answer questions, approve requests, archive
chats, and control execution in Codex. TaskChef's queue marks do not modify
Codex turn status or schedules. Optional desktop IPC supplies live approval
state; loss of that connection falls back to saved database state.

GitHub sign-in enables read-only PR and CI queries. Public pricing updates
fetch the official API pricing table without chat content or an API key.
See [GitHub setup](github.md) and [privacy](https://taskchef.dev/privacy/).

## Optional delegate skill

The packaged delegate skill uses native project discovery and chat creation or
explicitly authorized follow-up messaging. Codex owns the resulting chats and
execution. Confirmed aliases are routing hints, revalidated against current
projects. Routing notes contain no task records, full prompts, results, or
credentials and cannot override user instructions.

## Contributor boundary

The runtime closes its transport and resources on EOF, signals, protocol close,
or parent loss. Settings and caches use atomic writes; shared state writes also
keep the existing lock filename and timing. Open-chat callers must provide a
UUID, without a UUIDv7 restriction or generated replacement ID. The plugin does
not start a separate HTTP dispatcher runtime, create a dispatcher workspace,
maintain a second project registry, or use a separate task log as live state.


Changes must preserve local Codex data, existing TaskChef state, and credential
storage. Release manifests retain the `taskchef` identity. Dev staging uses the
separate `taskchef-dev` identity; it must not overwrite a released installation.
Package validation must exercise MCP startup, the built UI, delegate skill,
and required production dependencies. Tests and release automation remain
in this repository. Usage guides start at the [README](../README.md).
