# TaskChef

TaskChef is a local dispatch desk for Codex. Give one dispatcher a request and
it records each independently useful outcome, creates a normal Codex task in
the right project, and returns immediately. The executor task is where live
work, approvals, and follow-ups happen; TaskChef keeps every semantic result
while projecting the latest one for compact navigation and reporting.

```text
request -> recorded TaskChef task -> Codex executor -> current state + result history
```

## Which document should I read?

| Goal | Document |
| --- | --- |
| Install, configure, dispatch, inspect, and recover | This README |
| Follow the normative agent contract and MCP interfaces | [Specification](docs/spec.md) |
| Understand implementation flows and trust boundaries | [Workflows](docs/workflows.md) |
| Compare TaskChef with FirstMate | [FirstMate comparison research](docs/firstmate-taskchef-comparison.md) |
| Review deferred ideas | [Backlog](BACKLOG.md) |

## Install

TaskChef requires Node.js 18 or newer, Git, Codex desktop, and local access to
the projects that will receive work.

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
npm install --global taskchef
```

The plugin provides four skills and a local MCP server. The npm installation
puts the `taskchef` CLI on `PATH`. TaskChef installs no hooks, schedules,
daemons, login items, system services, or background identity search and needs
no elevated permissions.

## Bootstrap and configure

Ask the bootstrap skill to create the per-user dispatcher:

```text
$taskchef-bootstrap Set up TaskChef.
```

The canonical workspace is `~/.agents/taskchef`. TaskChef owns only:

```text
AGENTS.md       managed dispatcher instructions plus user additions
taskchef.json   schema-2 configured projects and routing metadata
tasks.jsonl     one task snapshot per line (schema 6; schema 4/5 migration supported)
```

List or change routing targets conversationally:

```text
$taskchef-bootstrap List my configured TaskChef projects.
$taskchef-bootstrap Add /workspace/payments as payments. It owns authorization, capture, refunds, and retries.
```

Or use the CLI:

```sh
taskchef project add /workspace/payments --name payments \
  --description "Authorization, capture, refunds, and retries."
taskchef project list
```

A project may advertise several GitHub repositories with repeated
`--github-repo`. TaskChef accepts Git roots and ordinary local folders on the
same execution host. Unsupported configuration schemas are rejected and are
never rewritten automatically.

## Dispatch

Open the TaskChef dispatcher project and ask for an outcome:

```text
In payments, fix duplicate charges after a retry, add a regression test, and report what changed.
```

From another project, invoke the delegation skill explicitly:

```text
$taskchef-delegate In payments, add structured logs for failed retries and test them.
```

TaskChef prepares a UUID and marker, persists the task before native creation,
creates the executor, and returns its task link. New executor instructions keep
the assignment visible from the first line, then place the correlation marker
immediately before an explicit `$taskchef-executor` invocation. That skill
reads the executor's own `CODEX_THREAD_ID`, self-links, and reports lifecycle
state. Independent outcomes may become separate executors; dependent work
should stay together.

At the start of every dispatcher turn, the managed workspace instructions ask
the MCP server to best-effort ensure the dashboard. A startup failure never
blocks an answer, report, or delegation. Every dispatcher response ends with
the stable [TaskChef Dashboard](http://127.0.0.1:3210/) link; a created-task
directive remains on the preceding line so dispatch still returns immediately.

For example, TaskChef generates this shape:

```text
Fix duplicate charges after a retry and add a regression test.

<!-- taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7 -->
Use $taskchef-executor to execute and report this delegated TaskChef assignment.
```

## Work with and report executors

Open an executor as an ordinary Codex task. Each executor reports `working`
when a turn starts and one semantic outcome before that same turn ends:

- `completed`: the requested outcome is complete;
- `needs_input`: a real user decision or missing fact blocks progress;
- `failed`: the executor or creation attempt ended unsuccessfully.

A native approval prompt is live Codex state, not `needs_input`.
TaskChef stores the current reported execution state and appends every concise
semantic result to `results`. A follow-up therefore appears as `working`
immediately without erasing any prior outcome. The final entry is exposed as a
derived `lastResult` compatibility alias; it is not persisted independently and
is planned for removal in the next major version after callers move to
`results.at(-1)`. TaskChef does not store transcripts or non-semantic events.

Delegated tasks created by earlier TaskChef versions remain compatible: their
inline executor protocol still parses, self-links, and may use the deprecated
`report_result` alias. The v7 inline-paragraph named exports remain as deprecated
historical snapshots, but new delegations use the executor skill and `report_state`.

## View and report tasks

Ask the dispatcher for an on-demand report:

```text
Report on the work TaskChef has dispatched.
```

The reporting skill combines cached semantic results with one bounded live
metadata snapshot. It does not poll or write inferred status. File-backed
inspection is also available:

```sh
taskchef task list
taskchef task list --project payments
taskchef task show c0f010ff
taskchef task summary
```

Add `--json` for structured output. `task show` accepts a full task UUID or
an unambiguous eight-character prefix.

## Dashboard

Dispatcher turns call the input-free `ensure_dashboard` MCP tool. It starts at
most one dashboard inside the existing TaskChef MCP process on
`127.0.0.1:3210`, or reuses a listener only when its bounded `/api/health`
identity proves the exact TaskChef/dashboard-server version and the same
canonical workspace. The response says `started` or `reused` and includes the
stable URL, canonical workspace, and versions.

The in-process dashboard closes with the MCP process. Closing Codex or reloading
the plugin may therefore stop the dashboard; the next dispatcher turn restores
it. TaskChef adds no OS-persistent component.

For manual development, run the foreground CLI:

```sh
taskchef dashboard
taskchef dashboard --port 3211
```

The loopback dashboard watches `tasks.jsonl`, groups current states, and opens
linked Codex tasks. List snapshots and SSE events carry only the latest-result
projection; opening task details fetches the full newest-first result history.
Task and result times are relative through 29 days (with minute detail for the
first six hours), then use a locale-aware calendar date. Each time is a keyboard-
accessible toggle for its full locale-aware date and time, and one shared
30-second timer keeps relative labels current without reloading the page.
It does not mutate TaskChef data and prints its local URL.
When a compatible foreground dashboard already owns port 3210,
`ensure_dashboard` reuses it but does not take ownership. If an unknown,
different-workspace, or stale-version process owns the port, TaskChef reports a
concise conflict and never kills or replaces that process. The foreground CLI
similarly asks you to stop the listener or choose another `--port`.

The health endpoint contains only a fixed service marker, health schema,
TaskChef version, dashboard-server version, and canonical workspace. It exposes
no task data, credentials, environment variables, process control, or secrets.

![Task detail result history](docs/images/result-history-dashboard.jpg)

## Common recovery

Check the managed workspace:

```sh
taskchef doctor
taskchef workspace init
taskchef workspace migrate
taskchef doctor
```

`doctor` is read-only. `workspace init` creates missing files and refreshes
managed instructions. `workspace migrate` explicitly upgrades supported schema
4/5 task lines to schema 6 under the workspace lock. It validates the complete
source and converted log before writing, creates an exclusive `tasks.jsonl.pre-v6-*.bak`
backup, atomically replaces the log, validates the result, and becomes an
idempotent no-op after migration. If replacement fails, the original remains
or the reported backup can be restored; unsupported or invalid input is rejected
before a backup or rewrite.

If a new record has no thread ID, the executor is link-pending. Reopen that
executor so its first action can retry `link_task`. Do not guess an identity
or edit `tasks.jsonl`. If native task creation failed, the record is retained
as `failed` with null thread and turn IDs.

Schemas other than 4, 5, and 6 remain unsupported. Retain such a workspace
unchanged and create a current workspace; the migration command deliberately
does not guess how to convert unknown formats.

## Boundaries

TaskChef dispatches; it is not a scheduler, supervisor, worker runtime, or
merge coordinator. Executor identity is a cooperative assertion inside a local
single-user trust boundary. The [specification](docs/spec.md) defines the
required contract; [workflows](docs/workflows.md) ties it to current code.

## Update

```sh
codex plugin marketplace upgrade favoyang-plugins
codex plugin add taskchef@favoyang-plugins
```

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Merges to `main` run semantic-release and update the shared plugin
marketplace. Removing unsupported schemas is a major-version change.
