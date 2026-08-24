# TaskChef

TaskChef is a local dispatch desk for Codex. Give one dispatcher a request and
it records each independently useful outcome, creates a normal Codex task in
the right project, and returns immediately. The executor task is where live
work, approvals, and follow-ups happen; TaskChef keeps the latest compact
snapshot for navigation and reporting.

```text
request -> recorded TaskChef task -> Codex executor -> latest semantic result
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

The plugin provides three skills and a local MCP server. The npm installation
puts the `taskchef` CLI on `PATH`. TaskChef installs no hooks, schedules,
daemons, or background identity search.

## Bootstrap and configure

Ask the bootstrap skill to create the per-user dispatcher:

```text
$taskchef-bootstrap Set up TaskChef.
```

The canonical workspace is `~/.agents/taskchef`. TaskChef owns only:

```text
AGENTS.md       managed dispatcher instructions plus user additions
taskchef.json   schema-2 configured projects and routing metadata
tasks.jsonl     one schema-4 snapshot per task
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
creates the executor, and returns its task link. The executor reads its own
`CODEX_THREAD_ID` and self-links before substantive work. Independent
outcomes may become separate executors; dependent work should stay together.

## Work with and report executors

Open an executor as an ordinary Codex task. Each executor reports its latest
semantic outcome:

- `completed`: the requested outcome is complete.
- `needs_input`: a real user decision or missing fact blocks progress.
- `failed`: execution or executor creation failed.

A native approval prompt is live Codex state, not `needs_input`. TaskChef
stores a concise summary, never a transcript or hidden reasoning.

Ask for a current report:

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

```sh
taskchef dashboard
```

The loopback dashboard watches `tasks.jsonl`, groups current states, and opens
linked Codex tasks. It does not mutate TaskChef data and prints its local URL.

## Common recovery

Check the managed workspace:

```sh
taskchef doctor
taskchef workspace init
taskchef doctor
```

`doctor` is read-only. `workspace init` creates missing current-schema files
and refreshes managed instructions; it does not migrate unsupported
configuration or task records.

If a new record has no thread ID, the executor is link-pending. Reopen that
executor so its first action can retry `link_task`. Do not guess an identity
or edit `tasks.jsonl`. If native task creation failed, the record is retained
as `failed` with null thread and turn IDs.

If an unsupported workspace must be retained, keep it as a backup and create a
new current workspace. TaskChef provides no conversion or merge command.

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
