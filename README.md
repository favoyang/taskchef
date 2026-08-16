# TaskChef

Bring work for all your local Codex projects to one inbox. TaskChef reads each
request, chooses the right project, and opens a normal Codex task there. It
keeps a task history so you can find the work later. The created Codex tasks
remain the source of truth for progress and results.

If a request contains independent work for different projects, TaskChef can
open several tasks. It returns as soon as they are created, so you can send the
next request or open any executor and work with it directly.

## The mental model

- The **dispatcher workspace** is the per-user `~/.agents/taskchef` folder that
  stores project routes and task history. A Codex task opened in this folder is the
  **dispatcher**.
- A **configured project** is a local repository or folder where TaskChef may
  send work.
- An **executor** is the normal Codex task that handles delegated work inside a
  configured project.
- A **task entry** records what TaskChef delegated, which project it chose, and
  the executor's Codex task ID.

```text
request in dispatcher
        |
        +-- task entry --> executor in project A
        +-- task entry --> executor in project B
```

TaskChef does not copy executor results into its workspace. When you ask for a
report, it reads the recorded task IDs, checks those Codex tasks once, and
shows their current state without saving another snapshot.

See [Delegation design](docs/delegation-design.md) for the complete illustrated
workflow, durable and provisional-ID examples, safety invariants, and measured
CLI-versus-MCP latency comparison.

## Quickstart

### 1. Install the plugin

You need Node.js 18 or newer, Git, and local access to each target project.

Add the [Favo Yang plugin marketplace](https://github.com/favoyang/codex-plugins)
and install TaskChef:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
```

### 2. Bootstrap the dispatcher workspace

Invoke the bootstrap skill from any Codex project:

```text
$taskchef-bootstrap Set up TaskChef.
```

Bootstrap creates `~/.agents/taskchef`, opens it in the current Codex desktop
app when it is not already a saved local project, and creates:

```text
AGENTS.md
taskchef.json
tasks.jsonl
```

TaskChef scans eligible local Codex projects during setup and adds them to the
managed project list in `taskchef.json`.

`taskchef.json` defines the available routes. A project name or GitHub issue or
pull-request URL in your request is usually enough for TaskChef to choose the
right project. Each project's `githubRepos` field is a list. A managed
`*-workspace` project lists all child or sub-repositories there, so links into
any of them route to the workspace. If a project needs more context, extend its
optional `description` field with responsibilities and keywords that
distinguish it from nearby projects.

The generated `AGENTS.md` turns ordinary requests in the TaskChef project into
delegated work. From any other project, explicitly invoke `$taskchef-delegate`;
it uses the same configuration and task history.

### 3. Delegate the first task

Suppose bootstrap found a project named `payments-api`. This prompt delegates
one task to it:

```text
In payments-api, fix the duplicate charge shown after a payment retry, add a regression test, and report what changed.
```

TaskChef replies with a link to the new Codex task. Open it to follow progress
or give the executor more instructions. The dispatcher is ready for another
request immediately.

The plugin's focused MCP tools prepare and record delegations directly in the
canonical workspace. They preserve TaskChef's lock and atomic-write guarantees
without shell quoting, stdin handling, temporary record files, or a separate
command-sandbox permission round trip.

## Everyday workflows

### Route work across projects

Suppose `storefront` is another configured project and owns the customer web
interface. These two changes do not depend on each other, so they can run in
separate tasks:

```text
In payments-api, add structured logs for failed payment retries and test them. Separately, in storefront, fix the checkout form's keyboard focus order and run the browser tests.
```

TaskChef opens one executor in each project. If several changes need close
coordination, keep them in one task instead of splitting them just because
they touch frontend and backend code. Multiple active executors may also use
the same project.

### Follow up on delegated work

Open an executor and prompt it like any other Codex task. Its thread is the
live source of truth for progress, questions, and results.

The dispatcher workspace keeps `tasks.jsonl`, a history of submitted
delegations. New tasks are appended; the only later change allowed is filling
an unresolved task's nullable thread ID. The log records what TaskChef sent,
when it sent it, which project it selected, and which Codex task received the
work.

Every delegated instruction begins with a unique
`<!-- taskchef_id=<UUID> -->` marker followed by a blank line. The valid HTML
comment stays invisible in rendered Markdown.
If worktree creation does not return a thread ID immediately, TaskChef records
the marked delegation as unresolved, then makes at most two exact-marker checks
during a short bounded window. Candidate reads use one programmatic batch per
check. If the batch cannot execute or TaskChef cannot identify exactly one
task, the recorded marker remains available for recovery.

### Ask for a live report

Ask the dispatcher when you want a current overview:

```text
Report on the work TaskChef has dispatched.
```

This runs `$taskchef-report`. It reads the task history, checks the relevant
Codex tasks once, and reports their current states and outcomes. Nothing is
written back to the log, and TaskChef does not keep polling after the report.

### Manage configured projects

Use `$taskchef-bootstrap` to scan local Codex projects and refresh the managed
list:

```text
$taskchef-bootstrap Scan my local Codex projects and update TaskChef's managed project list.
```

The same skill can diagnose the workspace and repair configuration errors that
it can fix safely:

```text
$taskchef-bootstrap Diagnose this TaskChef workspace and fix any repairable configuration errors.
```

Project paths must exist when you add or dispatch to them. Configure the
repository root for a Git project. TaskChef also accepts non-Git folders. It
detects Git status and the canonical GitHub `origin` when adding or importing
a project. Repeat `--github-repo` to configure several repositories, or place a
`githubRepos` array in an import. URLs are canonicalized and deduplicated.

Removing a project does not rewrite old task entries. Each entry keeps the
project metadata that TaskChef used when it delegated the work.

## Important boundaries

- TaskChef is an interactive dispatcher. It is not a scheduler, daemon, hook
  service, or background worker.
- Executors are visible Codex tasks. The dispatcher may wait briefly to resolve
  a worktree task's thread ID, but it does not supervise executors or wait for
  them to finish.
- TaskChef routes only to projects on the same local execution host.
- The task history contains successful delegations, not current task status or
  task results.
- TaskChef does not store executor transcripts, hidden reasoning, or `hostId`.
- A live report is a one-time read of recorded Codex tasks. TaskChef discards
  the fetched state after presenting it.

## Updating

Refresh the marketplace snapshot, then reinstall TaskChef:

```sh
codex plugin marketplace upgrade favoyang-plugins
codex plugin add taskchef@favoyang-plugins
```

## CLI reference

The plugin has three skills:

- `$taskchef-bootstrap` initializes, diagnoses, and configures a workspace
- `$taskchef-delegate` routes requests and creates executor tasks
- `$taskchef-report` reads the task history and reports live executor state once

Normal delegation uses the plugin's bundled MCP tools. The bootstrap and report
skills continue to call the CLI for deterministic workspace administration,
task-history reads, and later recovery. The same CLI is also available for
direct inspection, benchmarking, and manual operations over the shared
workspace logic. Run it once with `npx` if you do not want a global installation:

```sh
npx taskchef help
```

For the shorter command used below, install it globally:

```sh
npm install --global taskchef
```

The npm package provides the data CLI. The Codex plugin provides the skills and
focused MCP tools used during delegation; native Codex tools still create and
inspect executor tasks. From a source checkout, use `node bin/taskchef.js`.

```text
taskchef help
taskchef doctor
taskchef workspace path
taskchef workspace init
taskchef project add <path>
taskchef project import [<file> | -]
taskchef project list
taskchef project remove <name>
taskchef dispatch prepare
taskchef task record
taskchef task resolve <task-id> --thread-id <thread-id>
taskchef task show <task-id-or-8-character-prefix>
taskchef task list
taskchef task summary
```

Workspace resolution is deterministic: `--workspace <path>`, then the
`TASKCHEF_WORKSPACE` environment variable, then `~/.agents/taskchef`. The
current directory is never an implicit workspace. Data commands use concise
human-readable output by default and accept `--json` for machine-readable
output. Run `taskchef help` for every option.

`taskchef dispatch prepare --json` is the CLI equivalent of the MCP
`prepare_dispatch` operation: it resolves the canonical workspace, loads and
validates configured projects, and returns a generated task UUID, preparation
timestamp, and exact correlation marker. Normal delegation calls the MCP tool;
the CLI command remains useful for diagnostics and benchmarks. `task record`
accepts one JSON value only from closed, non-interactive standard input and is
intended for manual recovery or direct CLI use, not the skill's normal
recording path.

For repeatable live delegation measurements, run
`npm run benchmark:e2e -- write`. It reads one non-interactive JSON value,
validates a stable schema, derives durations and summary totals, and writes a
timestamped result under the supplied output directory (default:
`reports/e2e-benchmarks`). Use `validate <file>` to verify a saved result and
`clean [directory]` to remove only prior TaskChef end-to-end result JSON files.
Start from `assets/e2e-benchmark-example.json`; the writer accepts strict
schema fields only and supports stopped workflows after preparation, creation,
or recording failures. The writer stamps `taskchefVersion` from its own package;
saved files retain that version for historical validation.

### One-time upgrade from an older workspace

TaskChef 5 does not include a general migration command. For a one-time upgrade,
stop delegating and validate the old workspace. Then perform this one-time copy
only when the destination does not already exist:

```sh
set -eu
old_workspace=/path/to/old-taskchef-workspace
new_workspace="$HOME/.agents/taskchef"
backup_workspace="$old_workspace.pre-taskchef-5-backup"
if [ -e "$new_workspace" ]; then
  printf '%s\n' "Refusing to overwrite existing destination: $new_workspace" >&2
  exit 1
fi
if [ -e "$backup_workspace" ]; then
  printf '%s\n' "Refusing to overwrite existing backup: $backup_workspace" >&2
  exit 1
fi
taskchef doctor --workspace "$old_workspace"
cp -pR "$old_workspace" "$backup_workspace"
install -d -m 700 "$new_workspace"
install -m 600 "$old_workspace/AGENTS.md" "$new_workspace/AGENTS.md"
install -m 600 "$old_workspace/taskchef.json" "$new_workspace/taskchef.json"
install -m 600 "$old_workspace/tasks.jsonl" "$new_workspace/tasks.jsonl"
taskchef workspace init --workspace "$new_workspace" --register-codex
taskchef doctor --workspace "$new_workspace"
```

Keep the backup and old saved Codex project until `project list`, `task list`,
and `doctor` confirm the expected project and task counts. Do not merge several
histories by hand; conflicting task or thread IDs require case-by-case review.

### Project administration

```sh
taskchef workspace init
taskchef doctor

taskchef project add /workspace/payments \
  --name payments \
  --description "Owns payment authorization, capture, and refunds." \
  --github-repo https://github.com/example/payments-api \
  --github-repo https://github.com/example/payments-sdk

taskchef project list
taskchef project remove payments
```

Human-readable project listings group configured GitHub repositories by
project. The first row shows the project details; additional repository rows
leave the repeated name, kind, and path columns blank. A project without a
configured repository has one row containing `-` in the repository column:

```text
NAME      KIND    GITHUB REPOSITORY                        PATH
notes     folder  -                                        /workspace/notes
payments  git     https://github.com/example/payments-api  /workspace/payments
                  https://github.com/example/payments-sdk
```

Import projects as a JSON array from a file or standard input:

```sh
taskchef project import projects.json
taskchef project import - < projects.json
```

Import merges by canonical path, preserves an existing name or description
when the imported object omits it, and unions repository lists without
duplicates. `--replace` replaces the configured project set.

The current configuration schema is version 2. Version 1 remains readable:
legacy `githubRepo: null` normalizes to `githubRepos: []`, and a legacy string
normalizes to a one-item `githubRepos` list. `workspace init` persists this
migration atomically; other configuration writes also emit version 2. Legacy
task lines remain readable without an eager rewrite of the append-only history.

### Task history

`task record` reads one submitted delegation from standard input. The
`project` value is the exact configured project path:

```sh
printf '%s\n' '{"id":"c0f010ff-84f2-4838-a69d-0ff1f5d721d7","project":"/workspace/payments","title":"Add retry logs","instruction":"<!-- taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7 -->\n\nAdd structured logs for failed retries and test them.","threadId":"019f..."}' |
  taskchef task record --json
```

If a task has `threadId: null`, a later Codex workflow can find its exact
marker and pass the verified durable ID through its prescribed interface. The
delegate skill uses the MCP `resolve_task` tool during bounded post-creation
recovery; the report skill and direct manual recovery use the equivalent CLI
operation below. Both reach the same atomic logic, which permits only the
one-way transition from null to one unique thread ID:

```sh
taskchef task resolve c0f010ff-84f2-4838-a69d-0ff1f5d721d7 \
  --thread-id 019f9d46-f42c-7482-9707-3c107bf241ee
```

Inspect the task history without querying Codex tasks:

```sh
taskchef task show c0f010ff
taskchef task show c0f010ff --json
taskchef task list
taskchef task list --project payments
taskchef task list --ascending
taskchef task list --full-id
taskchef task summary
```

Human-readable task listings include both the task ID and Codex thread ID.
UUID-shaped IDs use their first eight-character section by default; pass
`--full-id` to show both IDs in full. Null thread IDs appear as `-`, consistent
with other empty table cells. Tasks are newest-first by default; pass
`--ascending` to list them from oldest to newest. ID formatting does not alter
the complete values in `--json` output, and the selected order applies to its
`tasks` array.

`task show` accepts either the full task ID or the exact eight-character task
ID printed by the default human-readable list. A short ID must identify exactly
one recorded task; use `task list --full-id` when a short ID is missing or
ambiguous. Its default output labels the title, project name and path, creation
time, full task and thread IDs, and instruction. A null thread ID appears as
`-`, and multiline instructions retain their original line breaks and
indentation. Pass `--json` to receive the unchanged complete task object.

```text
Title: Add retry logs
Project: payments
Project path: /workspace/payments
Created: 2026-08-12T10:00:00.000Z
Task ID: c0f010ff-84f2-4838-a69d-0ff1f5d721d7
Thread ID: 019f9d46-f42c-7482-9707-3c107bf241ee
Instruction:
<!-- taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7 -->

Add structured logs for failed payment retries and test them.
```

The list remains a compact table:

```text
TITLE           PROJECT   CREATED                   ID        THREAD ID
Add retry logs  payments  2026-08-12T10:00:00.000Z  c0f010ff  019f9d46
```

The complete data contract is in [SPEC.md](SPEC.md). The illustrated runtime
workflow and latency analysis are in
[Delegation design](docs/delegation-design.md). Deferred ideas are in
[BACKLOG.md](BACKLOG.md).

## Development and release

```sh
npm test
npm pack --dry-run
npx -y -p semantic-release@25 -p @semantic-release/exec -p @semantic-release/git semantic-release --dry-run
```

The `Release` GitHub Actions workflow runs semantic-release on `main`.
Semantic Commit Messages determine the release type:

```text
fix: correct task log validation
feat: add a new CLI command
feat!: change the workspace data contract
```

The workflow tests the package and validates the npm tarball before publishing
through npm trusted publishing. It synchronizes version files, creates the
GitHub release, and pins the TaskChef entry in `favoyang/codex-plugins` to the
published npm version. Marketplace updates use the `MARKETPLACE_DEPLOY_KEY`
Actions secret, a write-enabled deploy key scoped to the catalog repository.
