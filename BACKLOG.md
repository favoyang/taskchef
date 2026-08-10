# TaskChef backlog

`SPEC.md` is the current contract. These ideas need a concrete user case and a
clear data model before implementation.

## Journey views

- Add date ranges and title search if the dispatch log becomes difficult to
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
- Define batching and partial-read behavior for large journeys.
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

- Add GitHub automation only when dispatch history alone is insufficient.
- Evaluate automatic project discovery rules and exclusions.
- Consider multiple executor threads for one logical assignment if a real
  workflow requires it.
