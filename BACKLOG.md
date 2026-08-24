# TaskChef backlog

[`docs/spec.md`](docs/spec.md) is the current contract. These ideas need a concrete user case and a
clear data model before implementation.

## Task history views

- Add date ranges and title search if the task log becomes difficult to
  browse.
- Consider export formats for personal activity reports.
- Define archival or retention only when real logs become large enough to need
  it.
- Consider grouping entries created from one broad request without storing the
  full original prompt.

## Optional reports

- Consider user-scheduled, read-only digests that query recorded Codex tasks
  and publish a report without writing status or results to the TaskChef
  workspace.
- Define batching and partial-read behavior for large task histories.
- Decide whether inaccessible or deleted Codex tasks need a separate report
  category.

## Remote projects

- Import remote connection projects returned by native project discovery.
- Persist the native project and host identity needed to distinguish identical
  paths on different hosts.
- Re-resolve remote identities before dispatch.
- Define unavailable-host, renamed-project, moved-path, and stale-identity
  behavior.
- Evaluate isolated worktrees and conflict handling for concurrent tasks in one
  project.

## Integrations

- Add GitHub automation only when task history alone is insufficient.
- Evaluate automatic project discovery rules and exclusions.
- Consider multiple executor threads for one logical assignment if a real
  workflow requires it.

## Transport-authenticated executor identity

- If custom MCP later receives authenticated calling-task metadata, compare it
  with the executor's `link_task` assertion.
- Keep the current local cooperative trust model until such metadata exists;
  do not reintroduce parent/session identity, hooks, task search, or polling.
