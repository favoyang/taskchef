# TaskChef backlog

`SPEC.md` is the current contract. This backlog is ordered by product priority.
Each feature still needs a concrete user case and data model before
implementation.

TaskChef normally forwards one request to one project task. Splitting is not a
backlog feature: the delegation skill does it only when the user explicitly
asks for standalone tasks or distinct requirements clearly belong to different
projects. Ambiguous routing requires a user choice rather than a general
preview step.

## P0: Reliable Codex task identity

### Native provisional-thread resolution

Worktree creation can return only a provisional `clientThreadId` or
`pendingWorktreeId`, with no supported mapping to the durable `threadId`. Track
[openai/codex#26861](https://github.com/openai/codex/issues/26861).

Prefer an official bounded operation such as
`wait_for_thread(clientThreadId, timeoutMs) -> { status, threadId? }` or
`resolve_client_thread(clientThreadId) -> { status, threadId? }`. A reserved
durable ID returned by creation or a materialization event containing it would
also close the gap.

Re-evaluate TaskChef's marker-discovery fallback when Codex exposes a native
contract. Keep exact correlation verification unless the native contract gives
equivalent guarantees.

In TaskChef, **unresolved** means that executor creation was accepted but
TaskChef could not identify exactly one durable Codex thread ID. It does not
mean that the executor is active, blocked, failed, or unfinished.

### Recovery visibility

If unresolved entries remain common, make them easier to find and diagnose.
Consider an unresolved-only history filter,
one bounded recovery attempt, and a concise reason such as no match, ambiguous
match, deadline exceeded, or inaccessible candidate. Never guess a thread ID.

## P1: Reporting and history discovery

The desired reporting product is not yet settled. Start with observed user
questions rather than a dashboard or stored lifecycle model.

Candidate improvements:

- filter history by date range, title text, project, and unresolved identity;
- define batching and partial-read behavior for large live reports;
- distinguish an inaccessible or deleted Codex task from an unresolved task;
- export selected history for personal activity reports;
- evaluate optional scheduled, read-only digests only if repeated manual report
  requests show a clear need.

Reports must continue to query Codex tasks as the source of truth and must not
persist status or results in the TaskChef workspace.

## P2: Project routing beyond one local host

### Remote projects

- Import remote connection projects returned by native project discovery.
- Persist native project and host identity so identical paths on different
  hosts remain distinct.
- Re-resolve remote identities before dispatch.
- Define unavailable-host, renamed-project, moved-path, and stale-identity
  behavior.

### Project discovery

Evaluate automatic project discovery only after defining explicit inclusion,
exclusion, naming, and update rules. Preserve user-curated descriptions and
repository mappings.

### Concurrent checkout safety

Evaluate isolated worktrees and conflict warnings when several active tasks
target one project. Do not impose a one-active-task-per-project restriction.

## P3: External integrations

Consider GitHub or tracker automation only when task history and live reports
are demonstrably insufficient. Define the concrete action, authorization
boundary, duplicate handling, and source of truth before adding an integration.

## Not planned

- task groups or persistence of the original broad request;
- automatic dependency graphs or downstream task scheduling;
- multiple executor threads for one logical assignment;
- lifecycle status, results, transcripts, or hidden reasoning in task history;
- retention or archival until real history size creates an operational need.
