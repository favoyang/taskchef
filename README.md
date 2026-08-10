# TaskChef

TaskChef turns one Codex task into a lightweight dispatch desk for your local
projects. Give it a request, and it routes each independent piece of work to a
new, visible Codex task in the right project. You can open those tasks, follow
up with them directly, and keep using the dispatcher without waiting for them
to finish.

Use TaskChef when you regularly work across several repositories or folders
and want one place to hand work to the right project without losing the normal
Codex task experience.

## The mental model

TaskChef uses a few specific terms:

- A **dispatcher workspace** is a small folder that stores project routing
  information and task records. The Codex task opened in this folder is the
  **dispatcher**.
- A **configured project** is a local repository or folder to which TaskChef is
  allowed to route work.
- A **delegated task** is one independently useful assignment created from your
  request. Its **executor** is the normal Codex task that performs that work in
  the configured project.
- **Reconciliation** is an on-demand refresh that copies the executor's latest
  state back into the dispatcher workspace.

```text
request in dispatcher
        │
        ├── task record ── executor task in project A
        └── task record ── executor task in project B
```

The executor tasks are real, independently openable Codex tasks—not subagents
hidden inside the dispatcher. TaskChef creates them and returns control
immediately.

## Quickstart

### 1. Install the plugin

You need:

- Node.js 18 or newer
- Git
- Each target project on the same local execution host as the dispatcher

Add the [Favo Yang plugin marketplace](https://github.com/favoyang/codex-plugins)
and install TaskChef:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
```

### 2. Create the dispatcher workspace

Create a folder in your favourite location:

```sh
mkdir -p ~/taskchef
cd ~/taskchef
```

Add `~/taskchef` as a project in Codex. Start a new task in that project and run the
bootstrap skill:


```text
$taskchef-bootstrap Set up TaskChef in this folder.
```

TaskChef creates this data-only scaffold:

```text
AGENTS.md
taskchef.json
tasks/
```

Bootstrap creates an empty project list. Before delegating work, configure at
least one target project with a separate prompt:

```text
$taskchef-bootstrap List my local Codex projects and help me select and add the projects TaskChef should route to.
```

The `taskchef.json` file defines the workspace and project routing structure.
Describe each project's responsibilities and likely requests so TaskChef can
route work clearly.

The generated `AGENTS.md` turns this Codex task into the dispatcher. You no
longer need to type the skill name each time. Ordinary actionable work requests
in this project are treated as delegation prompts by default.

### 3. Delegate the first task

Send an ordinary work request in the dispatcher:

```text
Fix the duplicate charge shown after a payment retry, add a regression test, and report what changed.
```

The workspace instructions invoke TaskChef automatically. You can also be
explicit with `$taskchef-delegate`.

TaskChef selects the project from its name, GitHub repository, and description,
then replies with a created-task link. Open that link—or find the new task in
Codex's task list—to watch progress and continue the conversation directly
with its executor. The dispatcher does not wait, so you can give it another
request immediately.

## Everyday workflows

### Route work across projects

A request can produce more than one executor when it contains independent
outcomes for different projects:

```text
Update the payments API to return the retry reason, then update the storefront to display it. Test both changes.
```

TaskChef creates the smallest independently useful assignments it can route
clearly. If no project or several projects plausibly match, it asks instead of
guessing. Multiple ongoing tasks may target the same project.

### Follow up on delegated work

Open a created executor task and prompt it like any other Codex task. Its thread
is the live source of truth. The dispatcher stores only the latest reconciled
snapshot, not a transcript.

### Refresh saved status

TaskChef does not poll executor tasks or update records in the background. Ask
the dispatcher for a one-time refresh when you want current statuses:

```text
Refresh the TaskChef task states.
```

This invokes `$taskchef-reconcile`, checks each active executor once, updates
the saved snapshots, and returns without waiting. Ordinary delegation does not
refresh older records first.

### Manage configured projects

Use `$taskchef-bootstrap` for workspace administration:

```text
$taskchef-bootstrap List the configured projects.
$taskchef-bootstrap Add /absolute/path/to/docs as docs. It owns product documentation and examples.
$taskchef-bootstrap Remove docs from this workspace.
$taskchef-bootstrap Diagnose this TaskChef workspace.
```

Project paths must exist. A Git project must be configured at its exact
repository root. A non-Git folder is also supported. TaskChef detects Git
status and a canonical GitHub `origin` when adding or importing projects.

## Important boundaries

- TaskChef is an interactive dispatcher, not an agent runtime, scheduler,
  daemon, hook service, or background worker.
- Delegated work runs in visible Codex tasks. The dispatcher does not supervise
  them in the foreground or wait for completion.
- Project routing is local to one execution host. Remote connection projects
  are outside the current contract.
- Saved status can be stale until you request reconciliation.
- `finished` means the executor concluded its current attempt. The result may
  describe success, partial completion, failure, or uncertainty.
- TaskChef stores bounded task metadata and result links. It does not collect
  transcripts or hidden reasoning.

## Troubleshooting

**Codex does not recognize a TaskChef skill.** Confirm the plugin is installed,
then start a new Codex task. Skills are loaded when the task starts.

**TaskChef cannot choose a project.** List the configured projects and give
each one a distinct responsibility-focused description. TaskChef deliberately
refuses ambiguous routing.

**A project path is rejected.** Use an existing canonical local directory. For
a Git repository, pass its top-level root rather than a subdirectory. The
project must also be available to Codex on the executor host.

**A task record remains `running` after its executor stopped.** This is expected
until reconciliation. Ask the dispatcher to refresh TaskChef task states.

**Executor creation failed and left a `pending` record.** Ask the dispatcher to
retry that exact TaskChef task ID. Pending records are preserved so a failed
creation is visible and retryable. Non-pending records are not reused.

**The workspace looks damaged or stale.** Ask
`$taskchef-bootstrap Diagnose and repair this TaskChef workspace.` Doctor is
read-only. Bootstrap reruns idempotent initialization to repair the managed
scaffold while preserving configured projects and unrelated `AGENTS.md`
content.

## Updating

Refresh the marketplace snapshot and reinstall TaskChef:

```sh
codex plugin marketplace upgrade favoyang-plugins
codex plugin add taskchef@favoyang-plugins
```

Start a new Codex task to load the updated skills.

### Migrating from 1.x

TaskChef 2.x moved skill ownership from dispatcher-workspace symlinks to the
installed plugin. Run `$taskchef-bootstrap` once in an existing workspace. It
removes only the three legacy TaskChef links and preserves unrelated `.agents`
content. The deprecated `ensureWorkspaceSkills()` export remains available for
compatibility but reports plugin-provided skills instead of creating links.

## CLI reference

Most users should interact through the three plugin skills:

- `$taskchef-bootstrap` initializes, diagnoses, and configures a workspace
- `$taskchef-delegate` routes requests and creates executor tasks
- `$taskchef-reconcile` refreshes saved task state once

The deterministic CLI underneath them is useful for inspection, automation,
and development. Install the npm package globally for CLI-only use:

```sh
npm install --global taskchef
```

The npm CLI manages workspace data. Installing it alone does not add the Codex
skills that create or reconcile executor tasks. Contributors can run
`node bin/taskchef.js` from a source checkout.

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

Workspace and data commands accept `--workspace <path>`. The current directory
is the default. Commands that return workspace data accept `--json` for
deterministic JSON output. Run `taskchef help` for every option.

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

Import accepts a JSON array from a file or standard input:

```sh
taskchef project import projects.json --workspace <workspace>
taskchef project import - --workspace <workspace> < projects.json
```

Import merges by canonical path and preserves existing names and descriptions
when omitted. `--replace` explicitly replaces the project set. Removal refuses
to orphan existing task records unless `--force` is supplied.

### Task inspection and low-level updates

Task creation and update read JSON from standard input:

```sh
printf '%s\n' '{"id":"t1","project":"/workspace/payments","title":"Echo input","instruction":"Create and test echo_input.py."}' |
  taskchef task create --json --workspace <workspace>

printf '%s\n' '{"status":"running","threadId":"019f..."}' |
  taskchef task update t1 --json --workspace <workspace>
```

Inspect the persisted snapshots without querying Codex threads:

```sh
taskchef task show <task-id> --workspace <workspace>
taskchef task list --workspace <workspace>
taskchef task list --status running --status blocked --project payments --workspace <workspace>
taskchef task summary --workspace <workspace>
taskchef task reconcile-candidates --json --workspace <workspace>
```

`task reconcile-candidates` returns only `running` and `blocked` records that
have thread IDs. `--include-finished` is reserved for an explicit full refresh
or a finished executor that received new work.

The complete workspace and task data contract is in [SPEC.md](SPEC.md).
Deferred ideas are in [BACKLOG.md](BACKLOG.md).

## Development and release

```sh
npm test
npm pack --dry-run
npx -y -p semantic-release@25 -p @semantic-release/exec -p @semantic-release/git semantic-release --dry-run
```

Releases use semantic-release from the `Release` GitHub Actions workflow on
`main`. Use Semantic Commit Messages so the release type can be calculated:

```text
fix: correct task reconciliation
feat: add a new CLI command
feat!: change the workspace data contract
```

The workflow runs tests, validates the npm tarball, publishes through npm
trusted publishing, synchronizes version files, creates the GitHub release,
and pins the TaskChef entry in `favoyang/codex-plugins` to that exact npm
version. Cross-repository marketplace updates require the
`MARKETPLACE_DEPLOY_KEY` Actions secret, containing a write-enabled deploy key
scoped only to that catalog repository.
