---
title: Real-time local task dashboard
state: closed
priority: P1
created_at: 2026-08-23
closed_at: 2026-08-24
agent_sessions:
  - codex:01a02f29-8174-7a71-a3f9-80d648f385ac
---

## Goal

Add a readable, local-only TaskChef dashboard that watches the canonical
`tasks.jsonl` safely, surfaces meaningful task changes in real time, and stays
within supported Codex integration boundaries.

## Implementation

- [x] Add a read-only dashboard server and CLI command with loopback binding,
      validated snapshots, directory watching, polling fallback, and SSE
      reconnect support.
- [x] Build the accessible dashboard UI with meaningful-update ordering,
      project/status filters, change toasts, and task-detail disclosure.
- [x] Document the dashboard workflow and the supported versus deferred Codex
      integrations established by CLI/help and official-documentation checks.
- [x] Add focused server, monitor, security-header, and CLI tests and run the
      complete validation suite.
- [x] Run the independent branch review gate, fix verified findings, revalidate,
      and deliver the change through a pull request.

## Integration boundary

- Supported now: open a project workspace with the documented
  `codex app <path>` CLI command and manually navigate to the recorded task.
- Deferred: direct desktop navigation to a recorded task because neither the
  CLI nor official documentation exposes a stable thread deep link.
- Deferred: live-state refresh because TaskChef's report skill owns native
  metadata checks and no supported read-only browser/server API is available.
- Deferred: continue/reply because `codex resume <session> [prompt]` starts an
  interactive CLI session and can immediately execute a prompt; it is not a
  desktop prefilled-draft handoff, and the dashboard must not submit work
  without an explicit supported draft flow.
