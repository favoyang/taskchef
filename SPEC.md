# TaskChef specification

## Purpose

TaskChef is an interactive Codex dispatcher. It routes independent assignments
to real Codex tasks in configured local projects, records each successful
dispatch in an append-only journey, and returns immediately.

Codex tasks remain authoritative for their progress and results. TaskChef does
not maintain a second lifecycle database.

## Core behavior

1. The user submits a request in the dispatcher workspace.
2. TaskChef separates only outcomes that can proceed independently.
3. It selects each target using configured project metadata and validates the
   selected local path.
4. It creates an independently openable Codex task in that project.
5. After creation returns a thread ID, it appends one dispatch entry.
6. It returns without waiting for the executor.
7. When requested, TaskChef can read journey entries, query the relevant Codex
   tasks once, and present a live report without persisting the fetched state.

Several active executors may target the same project.

## Workspace layout

```text
taskchef/
├── AGENTS.md
├── taskchef.json
└── dispatches.jsonl
```

`AGENTS.md` contains a marked block that routes setup and administration to
`$taskchef-bootstrap`, actionable work to `$taskchef-delegate`, and explicit
live report requests to `$taskchef-report`. Bootstrap preserves unrelated
instructions and refreshes only the managed block.

`workspace init` is idempotent. It creates an empty configuration and dispatch
log when missing, refreshes managed instructions, removes legacy TaskChef skill
symlinks, and migrates legacy task records that contain executor thread IDs.
It stops on a legacy pending record with no thread ID rather than discarding
that record. If a legacy record refers to a project that was removed from the
configuration, migration reconstructs its project snapshot from the existing
local project path.

`doctor` validates configuration, project paths, the JSONL log, managed
instructions, and the absence of legacy workspace structures without modifying
the workspace.

## Project configuration

`taskchef.json` is the user-facing routing configuration:

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "name": "payments-api",
      "path": "/workspace/payments-api",
      "isGitRepository": true,
      "githubRepo": "https://github.com/example/payments-api",
      "description": "Owns payment authorization, capture, refunds, and provider integrations."
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
- `projects` lists the local routing targets.
- `name` is the unique human-readable project identity.
- `path` is the normalized, canonical local directory. A Git project must use
  its repository root.
- `isGitRepository` identifies Git and non-Git projects.
- `githubRepo` is a canonical GitHub repository URL or `null`.
- `description` is optional routing context.

TaskChef classifies work against `name`, `githubRepo`, and `description`. The
path identifies the checkout but is not a routing hint. TaskChef asks the user
when metadata does not produce one clear match.

`project add` and `project import` detect Git status, exact Git roots, and
canonical GitHub origins. Import merges by canonical path and preserves an
existing name or description when omitted. `--replace` replaces the configured
set. Removing or replacing a project does not alter historical dispatch
entries.

The configuration does not store dispatcher identity, execution modes,
schedules, task status, results, host information, or the workspace path.

## Dispatch entry

`dispatches.jsonl` contains one compact JSON object per line, in append order:

```json
{"schemaVersion":1,"id":"d1-retry-logs","project":{"name":"payments-api","path":"/workspace/payments-api","isGitRepository":true,"githubRepo":"https://github.com/example/payments-api","description":"Owns payment authorization, capture, refunds, and provider integrations."},"title":"Add payment retry logs","instruction":"Add structured logs for failed payment retries and test them.","threadId":"019f9d46-f42c-7482-9707-3c107bf241ee","createdAt":"2026-08-08T10:00:00.000Z"}
```

- `schemaVersion` identifies the dispatch format.
- `id` is a unique TaskChef dispatch identifier.
- `project` is the complete configured project snapshot used for routing.
- `title` is a short task name.
- `instruction` is the complete executor instruction.
- `threadId` identifies the created Codex task.
- `createdAt` is the dispatch time as an ISO 8601 timestamp.

Every entry has exactly these fields. IDs and thread IDs must be unique. The
file is empty or newline terminated, with no blank lines. TaskChef rejects a
malformed log instead of skipping bad entries. Writers replace the complete
validated file atomically under a workspace lock, so an interrupted write
leaves either the old journey or the complete new journey.

The project snapshot preserves the route even if the project is renamed,
moved, or removed later. Entries never contain status, result, transcript,
hidden reasoning, `hostId`, or update timestamps.

## Dispatch workflow

For each assignment, `$taskchef-delegate`:

1. loads and validates configured projects
2. selects one unambiguous target
3. creates a real Codex task at the exact configured path
4. appends a dispatch entry only after receiving the task's thread ID
5. returns the created task link without reading or waiting for that task.

A failed executor creation produces no entry. If executor creation succeeds but
the append fails, the executor remains valid and TaskChef tells the user that
it was not recorded.

## Journey inspection and live reports

The CLI reads persisted history without contacting Codex:

- `dispatch show <id>` returns one entry.
- `dispatch list` returns entries in append order, optionally filtered by
  historical project name or exact path.
- `dispatch summary` returns the total and per-project counts.

When the user requests current state or outcomes, `$taskchef-report` loads the
relevant entries and queries every recorded Codex task exactly once, in batches
of no more than eight. It reports the snapshot and discards it. The report does
not update `dispatches.jsonl`, poll, wait, or create a scheduled job.

## Boundaries

TaskChef does not include:

- lifecycle status or result persistence
- task callbacks, hooks, polling, daemons, heartbeats, or schedules
- arbitrary Codex task discovery
- remote hosts or `hostId` storage
- transcript or hidden-reasoning collection
- one-active-task-per-project restrictions
- batch cancellation or replay
- bundled development runtimes in dispatcher workspaces.

## Acceptance test

1. Bootstrap creates `AGENTS.md`, `taskchef.json`, and `dispatches.jsonl`, then
   remains idempotent.
2. Project metadata routes an unambiguous request to the correct local project.
3. A successful delegation creates a visible Codex task and appends its thread
   ID with a project snapshot.
4. The dispatcher returns without waiting for execution.
5. Several independent assignments can create several entries, including
   multiple entries for the same project.
6. Journey commands return deterministic history and project counts.
7. A live report queries each relevant task once and writes nothing.
8. Malformed JSONL, duplicate IDs, duplicate thread IDs, and symlinked managed
   files fail safely.
