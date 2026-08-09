# TaskChef

TaskChef is a non-blocking interactive dispatcher for visible Codex tasks. It
keeps a data-only workspace, routes independent assignments to real Codex
tasks, records their latest reconciled state, and returns control immediately.

The canonical contract is [SPEC.md](SPEC.md). Deferred ideas are in
[BACKLOG.md](BACKLOG.md).

## Installation

TaskChef requires Node.js 18 or newer and Git.

Add the shared Favo Yang plugin marketplace, then install TaskChef:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
```

Open or create the folder that will hold TaskChef's dispatcher data, start a
new Codex task there, and ask:

```text
$taskchef-bootstrap Set up TaskChef in this folder and help me choose projects.
```

The plugin provides all three TaskChef skills and its deterministic CLI runtime;
dispatcher workspaces do not install or link skills themselves.

For headless CLI use, install the npm package with
`npm install --global taskchef`. Contributors can run `node bin/taskchef.js`
directly from a source checkout.

### Migrating from 1.x

TaskChef 2.x moves skill ownership from dispatcher-workspace symlinks to the
installed plugin. Run `$taskchef-bootstrap` once in an existing workspace to
remove the three legacy TaskChef links; unrelated `.agents` content is
preserved. The deprecated `ensureWorkspaceSkills()` export remains available
for compatibility but reports plugin-provided skills instead of creating
workspace links.

## Workspace

```text
AGENTS.md
taskchef.json
tasks/<task-id>/task.json
```

Create or repair the managed scaffold without supplying configuration:

```sh
taskchef workspace init --workspace <workspace>
taskchef doctor --workspace <workspace>
```

Initialization is idempotent. It creates an empty configuration when missing
and preserves existing configured projects. When upgrading from the earlier
workspace-linked distribution, initialization removes the three legacy
TaskChef skill symlinks and preserves unrelated `.agents` content.

## Projects

Add one project. Git status, the exact Git root, and a canonical GitHub origin
are detected automatically:

```sh
taskchef project add /workspace/payments \
  --name payments \
  --description "Owns payment authorization, capture, and refunds." \
  --workspace <workspace>
```

Import a JSON array from a file or stdin:

```sh
taskchef project import projects.json --workspace <workspace>
taskchef project import - --workspace <workspace> < projects.json
```

Import merges by canonical path. Existing names and descriptions are preserved
when omitted. `--replace` explicitly replaces the configured project set.

```sh
taskchef project list --workspace <workspace>
taskchef project remove payments --workspace <workspace>
```

Removal refuses to orphan existing task records unless `--force` is supplied.

## Tasks

Task creation and update read JSON from stdin:

```sh
printf '%s\n' '{"id":"t1","project":"/workspace/payments","title":"Echo input","instruction":"Create and test echo_input.py."}' |
  taskchef task create --json --workspace <workspace>

printf '%s\n' '{"status":"running","threadId":"019f..."}' |
  taskchef task update t1 --json --workspace <workspace>
```

Inspection commands:

```sh
taskchef task show <task-id> --workspace <workspace>
taskchef task list --workspace <workspace>
taskchef task list --status running --status blocked --project payments --workspace <workspace>
taskchef task summary --workspace <workspace>
taskchef task reconcile-candidates --json --workspace <workspace>
```

`task reconcile-candidates` returns only `running` and `blocked` tasks with
thread IDs. Pass `--include-finished` only for an explicit full refresh or when
a finished executor is known to have received new work.

Delegation does not reconcile task states first. Ask the dispatcher to refresh
or fix outdated task states when you want it to run `$taskchef-reconcile`.

## Complete CLI

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

All commands accept `--workspace <path>`. Add `--json` for deterministic JSON
output used by the TaskChef skills; otherwise the CLI prints human-readable
output.

## Release

Releases are automated with semantic-release from the `Release` GitHub Actions
workflow on `main`. Use Semantic Commit Messages so the release type can be
calculated:

```text
fix: correct task reconciliation
feat: add a new CLI command
feat!: change the workspace data contract
```

Publishing uses npm trusted publishing from `.github/workflows/release.yml`.
The workflow runs the test suite, validates the npm tarball, publishes the
calculated version after synchronizing the plugin manifest, creates the GitHub
release, commits the synchronized version files back to `main`, and pins the TaskChef entry
in `favoyang/codex-plugins` to that exact npm version.

The release job requires an Actions secret named `MARKETPLACE_DEPLOY_KEY`.
Store the private half of a dedicated SSH deploy key there, and add its public
half to `favoyang/codex-plugins` with write access. The key must be scoped only
to that catalog repository; the workflow's repository-scoped `GITHUB_TOKEN`
cannot update another repository.

## Development

```sh
npm test
npm pack --dry-run
npx -y -p semantic-release@25 -p @semantic-release/exec -p @semantic-release/git semantic-release --dry-run
```

## Boundaries

TaskChef is not an agent runtime, scheduler, hook service, or background
worker. Delegated work runs in real Codex tasks, never subagents.
Reconciliation is a single immediate snapshot pass and never polls or waits.
