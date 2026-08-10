# TaskChef

TaskChef lets one Codex task send work to other Codex tasks in your local
projects. Give the dispatcher a request and it opens a visible task in the
right project for each independent piece of work. You can open those tasks and
talk to them directly while the dispatcher remains free for the next request.

It is useful when your work spans several repositories or folders and you want
one place to route it.

## The mental model

The README uses these TaskChef terms:

- The **dispatcher workspace** is a small folder that holds routing information
  and task records. A Codex task opened in this folder is the **dispatcher**.
- A **configured project** is a local repository or folder where TaskChef may
  send work.
- A **delegated task** is an independent assignment from your request. Its
  **executor** is the Codex task that handles the assignment in the configured
  project.
- **Reconciliation** refreshes the saved state in the dispatcher workspace
  from an executor's current state.

```text
request in dispatcher
        │
        ├── task record ── executor task in project A
        └── task record ── executor task in project B
```

Executors are normal Codex tasks that you can open independently. They are not
subagents hidden inside the dispatcher. TaskChef creates them and immediately
returns control to you.

## Quickstart

### 1. Install the plugin

You need Node.js 18 or newer and Git. Each target project must be on the same
local execution host as the dispatcher.

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

Bootstrap creates these files:

```text
AGENTS.md
taskchef.json
tasks/
```

During the same bootstrap process, TaskChef tries to find eligible local Codex
projects and add them to the managed project list in `taskchef.json`.

The `taskchef.json` file defines the workspace and its project routes. A
configured project name or GitHub pull request URL in the request is usually
enough for routing. When it is not, add the project's responsibilities and
useful keywords to its optional `description` field.

The generated `AGENTS.md` makes this Codex task the dispatcher. After setup,
ordinary work requests in this project are delegated by default, so you do not
need to name the skill each time.

### 3. Delegate the first task

Suppose bootstrap found a project named `payments-api`. Name it in the request
so TaskChef knows where to send the work:

```text
In payments-api, fix the duplicate charge shown after a payment retry, add a regression test, and report what changed.
```

The workspace instructions invoke TaskChef automatically. You may also call
`$taskchef-delegate` explicitly.

TaskChef matches the request against each project's name, GitHub repository,
and description. Its reply contains a link to the new task, which also appears
in Codex's task list. Open the task to follow its progress or talk to the
executor. The dispatcher is ready for another request right away.

## Everyday workflows

### Route work across projects

Suppose bootstrap also found `storefront`, the project for the customer web
interface. Name both projects when a request needs work in each one:

```text
In payments-api, return the payment retry reason. Then in storefront, display that reason to the customer. Test both changes.
```

TaskChef splits the request into the smallest pieces that are useful on their
own. It asks which project to use if the route is missing or ambiguous.
Multiple active tasks may use the same project.

### Follow up on delegated work

Open an executor and prompt it like any other Codex task. That task is the live
source of truth. The dispatcher keeps the latest reconciled snapshot, but it
does not copy the transcript.

### Refresh saved status

TaskChef does not poll executors or update records in the background. Ask the
dispatcher to refresh them when you want the current status:

```text
Refresh the TaskChef task states.
```

This runs `$taskchef-reconcile`. It checks each active executor once and updates
the saved snapshots without waiting for anything else. Delegating new work does
not refresh old records.

### Manage configured projects

Use `$taskchef-bootstrap` to rescan local Codex projects and update the managed
project list:

```text
$taskchef-bootstrap Scan my local Codex projects and update TaskChef's managed project list.
```

The same skill can check the workspace and repair configuration errors that it
can fix safely:

```text
$taskchef-bootstrap Diagnose this TaskChef workspace and fix any repairable configuration errors.
```

Project paths must exist. For a Git project, configure the repository root, not
a subdirectory. TaskChef also accepts non-Git folders. When it adds or imports
a project, it detects Git status and the canonical GitHub `origin`.

## Important boundaries

- TaskChef is an interactive dispatcher, not an agent runtime, scheduler,
  daemon, hook service, or background worker.
- Delegated work runs in visible Codex tasks. The dispatcher does not supervise
  them in the foreground or wait for them to finish.
- TaskChef routes only to projects on the same execution host. It does not
  support remote connection projects.
- Saved status can be stale until you request reconciliation.
- `finished` means the executor has ended its current attempt. Check the result
  to see whether it succeeded, failed, completed only part of the work, or left
  the outcome uncertain.
- TaskChef stores a limited set of task metadata and result links, but not
  transcripts or hidden reasoning.

## Updating

Refresh the marketplace snapshot, then reinstall TaskChef:

```sh
codex plugin marketplace upgrade favoyang-plugins
codex plugin add taskchef@favoyang-plugins
```

Start a new Codex task to load the updated skills.

## CLI reference

The plugin has three skills:

- `$taskchef-bootstrap` initializes, diagnoses, and configures a workspace
- `$taskchef-delegate` routes requests and creates executor tasks
- `$taskchef-reconcile` refreshes saved task state once

The deterministic CLI underneath these skills manages the workspace data
directly. Install the npm package globally if you want to use it without the
plugin:

```sh
npm install --global taskchef
```

The npm package does not install the Codex skills that create or reconcile
executor tasks. From a source checkout, run `node bin/taskchef.js` instead.

```text
taskchef help
taskchef doctor
taskchef workspace init
taskchef project add <path>
taskchef project import [<file> | -]
taskchef project list
taskchef project remove <name>
taskchef task create
taskchef task update <task-id>
taskchef task show <task-id>
taskchef task list
taskchef task summary
taskchef task reconcile-candidates
```

Workspace and data commands accept `--workspace <path>` and default to the
current directory. Commands that return workspace data accept `--json` for
deterministic output. Run `taskchef help` to see all options.

### Project administration

```sh
taskchef workspace init --workspace <workspace>
taskchef doctor --workspace <workspace>

taskchef project add /workspace/payments \
  --name payments \
  --description "Owns payment authorization, capture, and refunds." \
  --workspace <workspace>

taskchef project list --workspace <workspace>
taskchef project remove payments --workspace <workspace>
```

Import projects as a JSON array from a file or standard input:

```sh
taskchef project import projects.json --workspace <workspace>
taskchef project import - --workspace <workspace> < projects.json
```

Import merges projects by canonical path. If an imported project omits its name
or description, TaskChef keeps the existing value. Use `--replace` to replace
the project set. Project removal fails if it would orphan a task record unless
you pass `--force`.

### Task inspection and low-level updates

Task creation and updates read JSON from standard input:

```sh
printf '%s\n' '{"id":"t1","project":"/workspace/payments","title":"Echo input","instruction":"Create and test echo_input.py."}' |
  taskchef task create --json --workspace <workspace>

printf '%s\n' '{"status":"running","threadId":"019f..."}' |
  taskchef task update t1 --json --workspace <workspace>
```

These commands inspect saved snapshots without querying Codex tasks:

```sh
taskchef task show <task-id> --workspace <workspace>
taskchef task list --workspace <workspace>
taskchef task list --status running --status blocked --project payments --workspace <workspace>
taskchef task summary --workspace <workspace>
taskchef task reconcile-candidates --json --workspace <workspace>
```

`task reconcile-candidates` returns `running` and `blocked` records with thread
IDs. Use `--include-finished` only for a full refresh or when someone has given
new work to a finished executor.

The complete workspace and task data contract is in [SPEC.md](SPEC.md).
Deferred ideas are in [BACKLOG.md](BACKLOG.md).

## Development and release

```sh
npm test
npm pack --dry-run
npx -y -p semantic-release@25 -p @semantic-release/exec -p @semantic-release/git semantic-release --dry-run
```

The `Release` GitHub Actions workflow runs semantic-release on `main`. Semantic
Commit Messages determine the release type:

```text
fix: correct task reconciliation
feat: add a new CLI command
feat!: change the workspace data contract
```

The workflow tests the package and validates the npm tarball before publishing
through npm trusted publishing. It also synchronizes the version files, creates
the GitHub release, and pins the TaskChef entry in `favoyang/codex-plugins` to
the published npm version. Marketplace updates use the
`MARKETPLACE_DEPLOY_KEY` Actions secret. The secret contains a write-enabled
deploy key scoped to the catalog repository.
