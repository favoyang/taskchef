# TaskChef specification

## Purpose

TaskChef is an interactive Codex dispatcher. It turns a user request into
independent assignments, creates real Codex tasks in the selected projects,
records their latest reconciled state, and returns control immediately.

TaskChef is not an agent runtime, scheduler, or background service.

## Core behavior

1. The user opens the TaskChef workspace and submits a request.
2. TaskChef splits the request into the smallest useful independent tasks.
3. TaskChef classifies each assignment using configured project metadata and
   validates every target against the configured project list.
4. TaskChef creates one `task.json` record per delegated task with status
   `pending`.
5. TaskChef creates one independently openable Codex task in each target
   project.
6. TaskChef records the returned `threadId`, changes the status to `running`,
   and returns immediately without waiting.
7. The user may open and prompt any delegated task directly.
8. When the user asks to refresh or fix outdated task states, TaskChef performs
   one bounded reconciliation of active `running` and `blocked` threads.
9. Reconciliation updates each task's current status and result, then returns
   control without waiting for future activity. Ordinary delegation does not
   trigger reconciliation first.

Multiple ongoing tasks may target the same project.

## Workspace layout

```text
taskchef-workspace/
├── AGENTS.md
├── taskchef.json
├── .agents/
│   └── skills/
│       ├── taskchef-bootstrap -> <TaskChef bootstrap skill>
│       ├── taskchef-delegate -> <TaskChef delegate skill>
│       └── taskchef-reconcile -> <TaskChef reconciliation skill>
└── tasks/
    └── <task-id>/
        └── task.json
```

The workspace contains TaskChef-managed dispatcher instructions, user
configuration, and task data. TaskChef source, tests, reports, and
implementation utilities remain in the source repository.

## Dispatcher instructions

TaskChef owns a marked block in the workspace `AGENTS.md`. The block tells
Codex to use `$taskchef-bootstrap` for workspace setup and administration and
`$taskchef-delegate` for actionable requests without completing delegated work
in the dispatcher thread. The final instruction reserves `$taskchef-reconcile`
for user-requested refreshes or repairs of outdated task states.

`workspace init` copies the canonical file when `AGENTS.md` does not exist. When it
does exist, bootstrap preserves unrelated user content and adds or refreshes
only the TaskChef managed block. Repeating the merge is idempotent. Malformed
or duplicate TaskChef markers fail safely instead of overwriting the file.
Initialization also installs all three TaskChef skill links. It is idempotent,
takes no configuration input, creates `{ "schemaVersion": 1, "projects": [] }`
when configuration is missing, and preserves existing configured projects.

`doctor` diagnoses configuration, task storage, managed instructions, skill
links, project paths, and task records without modifying the workspace.

## Configuration

`taskchef.json` is the only user-facing configuration file.

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "name": "payments-api",
      "path": "/workspace/payments-api",
      "isGitRepository": true,
      "githubRepo": "https://github.com/example/payments-api",
      "description": "Owns payment authorization, capture, refunds, and provider integrations. Use for changes to the public payments API or its transaction lifecycle."
    },
    {
      "name": "local-data-tools",
      "path": "/workspace/local-data-tools",
      "isGitRepository": false,
      "githubRepo": null
    }
  ]
}
```

- `schemaVersion` identifies the configuration format.
- `projects` lists the local projects TaskChef may classify and manage.
- `name` is the unique human-readable project identity. It is explicit even
  when it matches the checkout directory name.
- `path` is the exact canonical local project directory.
- `isGitRepository` states whether the saved Codex project is a Git repository.
  When true, `path` must be the exact Git root. When false, the project runs
  directly in its canonical directory without Git assumptions.
- `githubRepo` is the canonical GitHub repository URL, or `null` when the
  project has no canonical GitHub remote. It may be `null` for either Git or
  non-Git projects.
- `description` is an optional semantic routing description. When present, it
  explains the project's responsibilities and the kinds of requests that
  should target it, similarly to a skill trigger description.

Project paths must exist, resolve to canonical directories, and match the
project selected for delegation. A Git project path must resolve to its exact
repository root. A non-Git project must use `githubRepo: null`. Names and paths
must be unique.

TaskChef classifies a requested outcome against `name`, `githubRepo`, and the
optional `description`. The path identifies the checkout but is not a
classification signal. A description should be specific enough to distinguish
the project from its neighbors; generic technology labels are insufficient.
TaskChef selects a project only when the metadata yields one clear match; it
asks the user when no project or several projects plausibly match. It must not
guess solely from a directory name.

Project configuration is managed through `project add`, `project import`,
`project list`, and `project remove`. Add and import detect Git status, exact
Git roots, and canonical GitHub origins. Import accepts a JSON array from a
file or stdin, merges by canonical path, and preserves an existing name or
description when omitted. `--replace` is the only replacement mode.

The configuration does not store dispatcher identity, project-to-task
assignments, execution modes, scheduling options, host information, or the
workspace path. The directory containing `taskchef.json` is the workspace, and
the currently open Codex task is the dispatcher.

## Task record

Each independent assignment has one `tasks/<task-id>/task.json` file.

```json
{
  "schemaVersion": 1,
  "id": "t1-echo-input-20260808",
  "project": "/workspace/t1",
  "title": "Echo user input",
  "instruction": "Create echo_input.py so it reads one line from standard input and echoes it exactly. Test the script and report the result.",
  "status": "finished",
  "threadId": "019f9d46-f42c-7482-9707-3c107bf241ee",
  "result": {
    "message": "Created and tested echo_input.py.",
    "githubPRs": [],
    "githubIssues": []
  },
  "createdAt": "2026-08-08T10:00:00.000Z",
  "updatedAt": "2026-08-08T10:05:00.000Z"
}
```

### Fields

- `schemaVersion`: task format version.
- `id`: stable TaskChef task identifier.
- `project`: exact configured project directory.
- `title`: short human-readable task name.
- `instruction`: complete task-specific instruction.
- `status`: current reconciled lifecycle state.
- `threadId`: independently openable Codex task ID, or `null` while pending.
- `result`: latest meaningful report, or `null` when none exists.
- `createdAt`: task creation time as an ISO 8601 timestamp.
- `updatedAt`: latest task update time as an ISO 8601 timestamp.

The task-specific instruction includes the requested outcome, constraints,
expected testing, and reporting expectations. Task records have no separate acceptance or
decision fields.

## Status model

TaskChef supports four statuses:

- `pending`: the record exists, but executor creation has not completed.
- `running`: the executor thread exists and may be working.
- `blocked`: progress requires user input, permission, credentials, or another
  external condition.
- `finished`: the executor concluded its current attempt and reported a result.

Typical transitions are:

```text
pending → running → finished
                  ↘ blocked → running
```

`finished` describes the executor lifecycle. It does not guarantee that the
goal was achieved. The result message explains success, partial completion,
failure, or uncertainty. A finished task returns to `running` if the user gives
its thread more work.

## Result

`result` is `null` until there is a meaningful report.

```json
{
  "result": null
}
```

When present, it has exactly three fields:

```json
{
  "result": {
    "message": "Implemented the change and opened a pull request.",
    "githubPRs": [
      "https://github.com/example/t1/pull/12"
    ],
    "githubIssues": [
      "https://github.com/example/t1/issues/8"
    ]
  }
}
```

- `message` is a required concise outcome, progress report, or blocker.
- `githubPRs` is a list of canonical GitHub pull-request URLs.
- `githubIssues` is a list of canonical GitHub issue URLs.

The URL lists are empty when no related resources exist. TaskChef does not store
separate artifact, verification, commit, decision, or completion fields.

## Dispatch workflow

For each delegated task, TaskChef:

1. classifies and validates the target against project metadata in
   `taskchef.json`;
2. writes `task.json` with `status: pending`, `threadId: null`, and
   `result: null`;
3. creates a real Codex task rooted at the exact project;
4. records its `threadId` and changes the status to `running`;
5. returns control after all requested tasks have been dispatched.

TaskChef does not wait for delegated tasks to finish.

## Reconciliation workflow

When the user asks to refresh or fix outdated task states, TaskChef uses
`$taskchef-reconcile` to perform one bounded pass:

1. use `task reconcile-candidates --json` to load only `running` and `blocked`
   task records with executor thread IDs;
2. query each returned `threadId` once using an immediate native task snapshot;
3. do not wait for future activity;
4. update `status`, `result`, and `updatedAt` from the current thread state;
5. report the concise current state and return control.

The native Codex thread is the live source of truth between reconciliations.
`task.json` is only the latest reconciled snapshot. It may still say `running`
after the executor has finished and until the user explicitly requests a
reconciliation pass.

Reconciliation must be safe to repeat. TaskChef has no reconciliation timestamp,
event cursor, event log, callback, or automatic workspace update.
Finished records are excluded from normal reconciliation. An explicit full
refresh uses `--include-finished` to detect a new attempt added directly to a
finished executor thread.

## Inspection workflow

`task list` returns task records with optional repeated `--status` filters and
an optional configured project name or path. `task summary` returns total and
per-status counts. These commands only inspect persisted TaskChef state and do
not query native executor threads.

## Boundaries

TaskChef is local, interactive, task-focused, and asynchronous. It does not include:

- `runs/` or records of the original broad prompt;
- `events.jsonl` or lifecycle history;
- hooks or automatic completion signals;
- executor callbacks;
- schedules, polling, daemons, heartbeats, or background reconciliation;
- remote hosts or `hostId` storage;
- project-to-current-task assignments;
- one-active-task-per-project restrictions;
- transcript or hidden-reasoning collection;
- arbitrary Codex task discovery;
- npm registry publication; the supported distribution is a GitHub-source
  global install or a managed source checkout.

See `BACKLOG.md` for deferred capabilities and experiments.

## MVP acceptance test

The MVP is successful when:

1. `taskchef.json` describes two local projects with names, paths,
   `isGitRepository`, GitHub repositories or explicit `null` values, and
   optional routing descriptions; at least one acceptance fixture is non-Git.
2. One request produces two task-specific `task.json` records.
3. Two independently openable Codex tasks are created in the correct projects.
4. Both `threadId` values are recorded.
5. The dispatcher returns without waiting for execution.
6. The user can open and prompt either delegated task directly.
7. A user request to refresh outdated states reconciles each active thread once
   without reading finished executor threads; ordinary delegation does not.
8. Status and result snapshots are updated correctly.
9. Two ongoing tasks may target the same project without data collisions.
10. The workspace contains dispatcher instructions, configuration, task
    records, and the three TaskChef skill links.
11. Bootstrap creates or idempotently merges the TaskChef-managed `AGENTS.md`
    block without overwriting unrelated instructions.
