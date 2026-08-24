---
title: Remove dashboard session authentication
state: closed
priority: P1
created_at: 2026-08-24
closed_at: 2026-08-24
agent_sessions:
  - codex:01a031a2-bba5-70f0-8b31-f4147391e17a
---

## Goal

Temporarily remove dashboard launch-capability and session-cookie authentication so independent local browsers can share one loopback dashboard while retaining the remaining local-server security controls.

## Implementation

- [x] Remove launch tokens, cookie exchange, and session gates from dashboard routes and return a clean startup URL.
- [x] Keep loopback binding, Host and Origin/CSRF checks, resource bounds, SSE backpressure, and safe static headers intact.
- [x] Update dashboard tests for unauthenticated root, snapshot, events, actions, concurrent independent clients, and retained rejection boundaries.
- [x] Remove obsolete capability/session documentation and document the deliberate local-only tradeoff.
- [x] Run the full relevant test suite and close this plan.
- [x] Pass the independent branch-review loop before pull request delivery.
