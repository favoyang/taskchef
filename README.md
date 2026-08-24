# TaskChef

TaskChef is a local dispatch desk for Codex. Send work to one inbox, and
TaskChef routes each independently useful outcome to a normal Codex task in the
right configured project. It keeps a compact history and the executor's latest
semantic result; the Codex task remains the live place to work.

```text
request in TaskChef
        |
        +-- recorded task --> executor in project A
        +-- recorded task --> executor in project B
```

The dispatcher returns after creating each executor. Open an executor to guide
the work directly, or ask TaskChef for a current report later.

## Which document should I read?

| If you want to... | Read |
| --- | --- |
| Install, configure, dispatch, report, or recover | This README |
| Know the exact terminology and required behavior | [TaskChef specification](SPEC.md) |
| Understand MCP calls, field transitions, locking, and trust boundaries | [Delegation and result design](docs/delegation-design.md) |
| Compare TaskChef with FirstMate | [FirstMate and TaskChef research](docs/firstmate-taskchef-comparison.md) |
| Review deferred product ideas | [Backlog](BACKLOG.md) |

## Install

TaskChef requires Node.js 18 or newer, Git, Codex desktop, and local access to
each target project.

Add the Favo Yang plugin marketplace and install TaskChef:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
```

The plugin provides three skills and a local MCP server. It installs no
lifecycle hooks.

## Bootstrap your dispatcher

From any Codex project, ask the bootstrap skill to set up TaskChef:

```text
$taskchef-bootstrap Set up TaskChef.
```

The skill creates the per-user dispatcher workspace at `~/.agents/taskchef`,
registers it as a local Codex project when needed, and scans eligible local
projects. TaskChef creates and manages these files:

```text
AGENTS.md       managed dispatcher instructions plus your additions
taskchef.json   configured projects and routing metadata
tasks.jsonl     one latest snapshot per delegated task
```

Review the configured projects:

```text
$taskchef-bootstrap List my configured TaskChef projects.
```

Good project descriptions make conversational routing clearer. A configured
project may advertise several GitHub repositories, which is useful for a
managed workspace that owns multiple child repositories.

```text
$taskchef-bootstrap Add /workspace/payments as payments. It owns payment authorization, capture, refunds, and retries.
```

TaskChef accepts Git repositories and ordinary local folders. It routes only to
projects on the same local execution host.

## Dispatch work

Open the TaskChef dispatcher project and describe an outcome:

```text
In payments, fix duplicate charges after a retry, add a regression test, and report what changed.
```

The dispatcher records the request before it creates the executor, opens one
normal Codex task in `payments`, and immediately returns a task link. The
executor links its own durable Codex identity before doing substantive work.

To dispatch from another project, invoke the delegation skill explicitly:

```text
$taskchef-delegate In payments, add structured logs for failed retries and test them.
```

Independent outcomes may run in separate tasks:

```text
In payments, add retry-failure logs and tests. Separately, in storefront, fix the checkout form's keyboard focus order and run the browser tests.
```

Keep dependent or tightly coordinated work together. TaskChef does not split a
request merely because it mentions several repositories.

## Work with executors

Open an executor and use it like any other Codex task. That task owns the live
conversation, approvals, follow-ups, implementation, and delivery workflow.

Each executor reports one latest semantic outcome to TaskChef:

- `completed`: the requested outcome is complete;
- `needs_input`: a real user decision or missing fact blocks progress;
- `failed`: the executor or creation attempt ended unsuccessfully.

A native command-approval prompt is live Codex state, not `needs_input`.
TaskChef stores a concise result, not the transcript or a lifecycle event log.

## View and report tasks

Ask the dispatcher for an on-demand report:

```text
Report on the work TaskChef has dispatched.
```

The `$taskchef-report` skill reads TaskChef's cached semantic results and takes
one cheap native metadata snapshot for selected Codex tasks. Active or
approval-waiting native state overrides the cache. Focused reports may read an
idle task once when its native metadata is newer or the cache is uncertain.
Reports never poll and never write inferred state into `tasks.jsonl`.

For file-backed inspection without live Codex checks:

```sh
taskchef task list
taskchef task list --project payments
taskchef task show c0f010ff
taskchef task summary
```

Pass `--json` for machine-readable output. `task show` accepts a full TaskChef
task ID or an unambiguous eight-character prefix.

## Use the dashboard

Run the local read-only dashboard:

```sh
taskchef dashboard
```

Open the printed URL, normally `http://127.0.0.1:3210/`. The dashboard:

- updates when TaskChef links an executor or receives a semantic result;
- filters tasks by project, status, and update window;
- shows the recorded instruction, result, and identity metadata;
- opens a recorded task directly in Codex when its stored thread ID is a
  supported UUID;
- falls back to opening the configured project for null or opaque legacy
  identities.

Use `--port <number>` for a different port and `--workspace <path>` only when
you intentionally need a non-default workspace. Press Ctrl+C to stop the
server.

The server binds only to numeric loopback, does not authenticate browser
sessions, and exposes the local task history to any local process that can
reach its port. Do not proxy or tunnel it. State-changing open-in-Codex requests
require an exact Host and same-origin request; the dashboard never edits the
dispatcher workspace.

## Configure and diagnose

Use the bootstrap skill for routine administration:

```text
$taskchef-bootstrap Scan my local Codex projects and refresh TaskChef's configured project list.
$taskchef-bootstrap Diagnose my TaskChef workspace and repair what can be repaired safely.
```

The equivalent data CLI is useful for direct inspection and scripting:

```sh
taskchef doctor
taskchef workspace path
taskchef workspace init
taskchef project add /workspace/payments --name payments \
  --description "Payment authorization, capture, refunds, and retries." \
  --github-repo https://github.com/example/payments-api
taskchef project import projects.json
taskchef project list
taskchef project remove payments
```

Workspace resolution is deterministic: `--workspace <path>`, then an absolute
or `~/`-prefixed `TASKCHEF_WORKSPACE`, then `~/.agents/taskchef`. The current
directory is never an implicit TaskChef workspace.

Install the data CLI globally only if you want the short `taskchef` command:

```sh
npm install --global taskchef
```

Otherwise use `npx taskchef help`. The plugin already bundles the CLI used by
its skills.

## Common recovery

### An executor is link-pending

A newly recorded schema 4 task with no `threadId` is waiting for its executor
to self-link. Open that executor and continue it. The executor must retry
`link_task` with its own `CODEX_THREAD_ID`; do not search recent tasks or copy a
dispatcher, parent, `CODEX_SESSION_ID`, or provisional client ID into the
record.

If executor creation itself failed, TaskChef stores `failed` with null thread
and turn IDs. The original task record remains available for diagnosis.

### A pre-6.0 task has no thread ID

`taskchef task resolve` is a legacy recovery command for unresolved schema 1-3
records only. First establish one exact TaskChef marker match and one unique
durable executor ID:

```sh
taskchef task resolve c0f010ff-84f2-4838-a69d-0ff1f5d721d7 \
  --thread-id 019f9d46-f42c-7482-9707-3c107bf241ee
```

The command rejects schema 4 self-linking records. Never edit `tasks.jsonl`
by hand.

### The workspace looks damaged or stale

Run:

```sh
taskchef doctor
taskchef workspace init
taskchef doctor
```

`doctor` is read-only. `workspace init` refreshes the managed instructions,
migrates supported configuration, and removes obsolete workspace-local
TaskChef skill links. It does not rewrite legacy task history eagerly.

### Upgrading an old custom workspace

Back up `AGENTS.md`, `taskchef.json`, and `tasks.jsonl`, then initialize the
canonical `~/.agents/taskchef` destination only when it does not already exist.
Keep the backup until `project list`, `task list`, and `doctor` confirm the
expected contents. Do not merge task histories by hand; duplicate task or
thread identities require case-by-case review.

## Boundaries

- TaskChef is an interactive dispatcher, not a scheduler, daemon, worker
  runtime, or supervisor.
- Executors are visible Codex tasks; TaskChef does not wait for them or merge
  their changes.
- `tasks.jsonl` holds latest snapshots, not transcripts or transition events.
- TaskChef does not store `hostId`, hidden reasoning, or token usage.
- Executor identity is a cooperative assertion inside a local single-user
  trust boundary.

The [specification](SPEC.md) is the normative source for these guarantees. The
[workflow document](docs/delegation-design.md) ties them to the current 6.x
implementation.

## Update

Refresh the marketplace snapshot and reinstall TaskChef:

```sh
codex plugin marketplace upgrade favoyang-plugins
codex plugin add taskchef@favoyang-plugins
```

## Development

From a source checkout:

```sh
npm ci
npm test
npm pack --dry-run
```

The release workflow runs semantic-release on `main`, publishes the npm
package, creates the GitHub release, and updates the shared plugin marketplace
to the released version. Documentation-only changes do not require a TaskChef
runtime migration, but they may still produce a patch release under the
repository's Conventional Commit policy.
