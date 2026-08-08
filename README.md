# TaskChef

TaskChef is a non-blocking interactive dispatcher for visible Codex tasks. It
keeps a data-only workspace, routes independent assignments to real Codex
tasks, records their latest reconciled state, and returns control immediately.

The canonical contract is [SPEC.md](SPEC.md). Deferred ideas are in
[BACKLOG.md](BACKLOG.md).

## Installation

TaskChef requires Node.js 18 or newer and Git.

Install the CLI and its bundled skills directly from the public GitHub source:

```sh
npm install --global github:favoyang/taskchef
```

Then initialize a dispatcher workspace. Initialization links the three bundled
TaskChef skills into that workspace; no separate skill installation is needed.

```sh
taskchef workspace init --workspace <workspace>
taskchef doctor --workspace <workspace>
```

TaskChef is not currently published to the npm registry. Contributors working
from a source checkout can run `node bin/taskchef.js` directly; this managed
skills workspace installs the checkout CLI and skills with symlinks.

## Workspace

```text
AGENTS.md
taskchef.json
.agents/skills/taskchef-bootstrap -> <source>/.agents/skills/taskchef-bootstrap
.agents/skills/taskchef-delegate -> <source>/.agents/skills/taskchef-delegate
.agents/skills/taskchef-reconcile -> <source>/.agents/skills/taskchef-reconcile
tasks/<task-id>/task.json
```

Create or repair the managed scaffold without supplying configuration:

```sh
taskchef workspace init --workspace <workspace>
taskchef doctor --workspace <workspace>
```

Initialization is idempotent. It creates an empty configuration when missing
and preserves existing configured projects.

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

## Boundaries

TaskChef is not an agent runtime, scheduler, hook service, or background
worker. Delegated work runs in real Codex tasks, never subagents.
Reconciliation is a single immediate snapshot pass and never polls or waits.
