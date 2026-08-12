# TaskChef

Bring work for all your local Codex projects to one inbox. TaskChef reads each
request, chooses the right project, and opens a normal Codex task there. It
keeps a task history so you can find the work later. The created Codex tasks
remain the source of truth for progress and results.

If a request contains independent work for different projects, TaskChef can
open several tasks. It returns as soon as they are created, so you can send the
next request or open any executor and work with it directly.

## The mental model

- The **dispatcher workspace** is a small folder that stores project routes and
  task history. A Codex task opened in this folder is the
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

## Quickstart

### 1. Install the plugin

You need Node.js 18 or newer, Git, and local access to each target project.

Add the [Favo Yang plugin marketplace](https://github.com/favoyang/codex-plugins)
and install TaskChef:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
```

### 2. Create the dispatcher workspace

Create a folder wherever you keep local projects:

```sh
mkdir -p ~/taskchef
cd ~/taskchef
```

Add `~/taskchef` as a project in Codex. Start a new task in that project and
run the bootstrap skill:

```text
$taskchef-bootstrap Set up TaskChef in this folder.
```

Bootstrap creates:

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

The generated `AGENTS.md` turns ordinary requests in this project into
delegated work. You do not need to name the delegate skill each time.

### 3. Delegate the first task

Suppose bootstrap found a project named `payments-api`. This prompt delegates
one task to it:

```text
In payments-api, fix the duplicate charge shown after a payment retry, add a regression test, and report what changed.
```

TaskChef replies with a link to the new Codex task. Open it to follow progress
or give the executor more instructions. The dispatcher is ready for another
request immediately.

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

Every delegated instruction includes a unique `# taskchef_id=<UUID>` marker.
If worktree creation does not return a thread ID immediately, TaskChef records
the marked delegation as unresolved, then waits briefly for the durable task.
It prefers a native Codex client-ID resolver when available and otherwise makes
two exact-marker checks during a short bounded window. If it still cannot
identify exactly one task, the recorded marker remains available for recovery.

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

The CLI underneath these skills manages workspace data. Run it once with `npx`
if you do not want a global installation:

```sh
npx taskchef help
```

For the shorter command used below, install it globally:

```sh
npm install --global taskchef
```

The npm package provides the data CLI. The Codex plugin provides the skills
that create and inspect executor tasks. From a source checkout, use
`node bin/taskchef.js`.

```text
taskchef help
taskchef doctor
taskchef workspace init
taskchef project add <path>
taskchef project import [<file> | -]
taskchef project list
taskchef project remove <name>
taskchef task record
taskchef task resolve <task-id> --thread-id <thread-id>
taskchef task show <task-id>
taskchef task list
taskchef task summary
```

Workspace and data commands accept `--workspace <path>` and default to the
current directory. Data commands accept `--json` for machine-readable output.
Run `taskchef help` for every option.

### Project administration

```sh
taskchef workspace init --workspace <workspace>
taskchef doctor --workspace <workspace>

taskchef project add /workspace/payments \
  --name payments \
  --description "Owns payment authorization, capture, and refunds." \
  --github-repo https://github.com/example/payments-api \
  --github-repo https://github.com/example/payments-sdk \
  --workspace <workspace>

taskchef project list --workspace <workspace>
taskchef project remove payments --workspace <workspace>
```

Import projects as a JSON array from a file or standard input:

```sh
taskchef project import projects.json --workspace <workspace>
taskchef project import - --workspace <workspace> < projects.json
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
printf '%s\n' '{"id":"c0f010ff-84f2-4838-a69d-0ff1f5d721d7","project":"/workspace/payments","title":"Add retry logs","instruction":"# taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7\n\nAdd structured logs for failed retries and test them.","threadId":"019f..."}' |
  taskchef task record --json --workspace <workspace>
```

If a task has `threadId: null`, Codex can later find its exact marker and pass
the verified durable ID to the CLI. Resolution is atomic and only permits the
one-way transition from null to one unique thread ID:

```sh
taskchef task resolve c0f010ff-84f2-4838-a69d-0ff1f5d721d7 \
  --thread-id 019f9d46-f42c-7482-9707-3c107bf241ee \
  --workspace <workspace>
```

Inspect the task history without querying Codex tasks:

```sh
taskchef task show t1 --workspace <workspace>
taskchef task list --workspace <workspace>
taskchef task list --project payments --workspace <workspace>
taskchef task summary --workspace <workspace>
```

The complete data contract is in [SPEC.md](SPEC.md). Deferred ideas are in
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
