# TaskChef native product contract

TaskChef is a local Codex dashboard. Codex databases and rollout logs own chat
identity, recorded prompts and replies, turn state, schedules, queue contents,
and token usage. TaskChef reads them without rewriting Codex data.

## Runtime

The plugin launches one stdio MCP server and advertises the native sidebar app.
It does not start an HTTP server, create a dispatcher workspace, index a second
project registry, or maintain tasks.jsonl. Only native dashboard tools are
registered. No task markers, self-linking, executor reports, or lifecycle
callbacks are needed for a chat to appear.

The MCP process closes its transport and resources on EOF, signals, protocol
close, or parent loss. Settings and caches use atomic writes. Shared state
writes also use the existing file lock, with its filename and timing preserved.
Open-chat callers must provide a UUID; the boundary check does not insist on
UUIDv7 or generate IDs.

## Feature state

TaskChef retains its current native settings, GitHub credentials, Done marks,
notification state, and scan/PR/usage/pricing caches. Credentials remain in the
system credential store. A Done mark is bound to the current turn. A new turn
invalidates stale derived data. Damaged state is preserved and reported rather
than silently reset. See [storage](taskchef-next-storage.md).

## Delegation

The packaged `$taskchef:delegate` skill uses native Codex project discovery and chat
creation. It passes an ordinary assignment, resolves ambiguity with the user,
and returns the native link. Explicit follow-ups use the selected existing
chat. Codex owns execution and outcomes; TaskChef does not mirror task records.

Optional routing memory contains only confirmed project aliases and explicit
preferences. Revalidate it against current native projects. It is not a task
log, a source of authority, or a store for prompts, results, or credentials.

## Transition and delivery

Retiring the dispatcher CLI, skills, tools and exported API is a breaking
change delivered in a major release. Existing legacy workspaces, task logs and
Codex data remain untouched. There is no automatic data deletion or archive
export feature. The release remains TaskChef; a development copy uses the
separate taskchef-next identity and TaskChef Dev name.

Release validation must exercise the native MCP server, bundled UI, delegate
skill and required dependencies, without requiring retired dispatcher files.
A future web product does not require shipping the old HTTP runtime.
