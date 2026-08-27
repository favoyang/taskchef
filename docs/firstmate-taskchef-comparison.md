# FirstMate and TaskChef: architecture and fit

> **Research, not contract.** This document compares two version-scoped
> implementations. It does not define TaskChef behavior; the normative source
> is the [TaskChef specification](spec.md). Recheck the linked sources before relying on these
> conclusions after the access date.

For TaskChef installation and everyday use, start with the
[README](../README.md). For its current implementation flow, see
[TaskChef workflows](workflows.md).

## Scope and sources

**Access date:** 2026-08-25

**TaskChef scope:** the TaskChef 7 contract in this repository revision.
Current behavior was verified against the [specification](spec.md),
[workflows](workflows.md), packaged skills,
[MCP implementation](https://github.com/favoyang/taskchef/blob/main/src/mcp.js),
[workspace implementation](https://github.com/favoyang/taskchef/blob/main/src/workspace.js),
CLI, dashboard, and tests.

**FirstMate scope:**
[`kunchenguid/firstmate`](https://github.com/kunchenguid/firstmate) at commit
[`038d0f7`](https://github.com/kunchenguid/firstmate/tree/038d0f7ec6ba7238a151722931434dcf06ff37c4),
the tip of its official `main` branch when accessed. Repository history already
identified Kunchenguid's project as the intended FirstMate; no competing local
reference pointed to another project.

Primary FirstMate sources:

- [README](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/README.md)
  for product goals, installation, features, and supported harnesses;
- [AGENTS.md](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/AGENTS.md)
  for the coordinator's operating contract, authority, delegation, supervision,
  and delivery rules;
- [Architecture](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/architecture.md)
  for watcher, session backend, worktree, state, and recovery mechanics;
- [Configuration](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/configuration.md)
  for operational-home state, project modes, profiles, and extension settings;
- [Codex App boundary](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/docs/codex-app-backend.md)
  for the current limit that Codex desktop is not a selectable FirstMate runtime
  backend;
- [Vision](https://github.com/kunchenguid/firstmate/blob/038d0f7ec6ba7238a151722931434dcf06ff37c4/VISION.md)
  for the intended single-liaison, durable-fleet experience.

Unless labeled **Inference** or **Recommendation**, statements below are facts
supported by those version-scoped sources or the TaskChef 7 codebase.

## Executive comparison

**Fact:** TaskChef is a Codex-native dispatch and task-index layer. It routes a
request to visible Codex tasks, returns immediately, and lets the user work with
each executor directly. It stores one latest task snapshot and offers read-only
reports and a local dashboard.

**Fact:** FirstMate is an agent distribution for running a supervised crew. The
user talks to one primary coordinator, which dispatches workers into isolated
worktrees and visible session backends, watches meaningful state, escalates
decisions, follows configured delivery modes, and reconciles durable fleet state
after restart.

**Inference:** The products overlap at intake, project routing, parallel task
creation, and observability. Their central responsibility boundary differs:
TaskChef hands control to native Codex tasks; FirstMate retains coordination
responsibility until an outcome is landed, transferred, or safely preserved.

## Architecture at a glance

| Dimension | TaskChef 7 | FirstMate at `038d0f7` |
| --- | --- | --- |
| Primary goal | Put multi-project work into the right visible Codex task and make it findable later. | Let one person direct a supervised crew across projects through one liaison. |
| Product form | Codex plugin: five skills, local MCP server, data CLI, and loopback dashboard. | Cloneable agent distribution: instructions, internal skills, scripts, policies, and private on-disk state. |
| Runtime | Native Codex desktop tasks are the executors and live source of truth. | Harness-driven workers in tmux by default, with documented alternative session backends; Codex can be a harness, but Codex desktop is not a runtime backend. |
| Coordinator lifetime | Dispatcher returns immediately and does not supervise. | First mate remains active and uses watcher/guard mechanisms to supervise meaningful events. |
| Project isolation | Delegates to the configured Codex project; isolation follows native Codex/project behavior. | Ship and scout workers require separate Treehouse- or backend-managed worktrees. |
| Durable state | `taskchef.json` plus latest snapshots in `tasks.jsonl`. | Backlog, briefs, reports, task metadata, status-event logs, decisions, endpoint records, and configuration under an operational home. |

## Goals and user experience

### TaskChef

**Fact:** The user submits work in the dispatcher or explicitly invokes
`$taskchef-delegate` elsewhere. TaskChef creates independently openable Codex
tasks and returns links. The user opens those tasks for questions, approvals,
follow-ups, and delivery.

**Strength:** This preserves the familiar Codex task model and makes delegation
transparent. There is little new runtime or policy to learn.

**Limitation:** Several active executors still mean several conversations. A
dispatcher report reduces search cost but does not own supervision or recovery.

### FirstMate

**Fact:** The user talks to the first mate as the single liaison. Crewmates do
project work; the first mate reads projects, supervises the fleet, reconciles
direct user intervention, brings forward decisions, and reports outcomes.

**Strength:** The user can look away while one coordinator retains context and
responsibility across a larger fleet.

**Limitation:** The experience requires more local tooling, state, policy, and
operational machinery than a simple dispatcher. The coordinator's summaries
also insert an interpretation layer between user and worker.

## Task identity and persistence

### TaskChef

**Fact:** `prepare_dispatch` allocates a TaskChef UUID and exact correlation
marker. `record_task` persists the marked instruction before native task
creation. The executor then reads its own `CODEX_THREAD_ID` and calls
`link_task`; the dispatcher neither searches recent tasks nor repairs identity.
The task record keeps one immutable intent/project snapshot plus the latest
identity and semantic result fields.

**Fact:** Linking accepts one atomic null-to-canonical-Codex-UUIDv7 transition.
Exact retries are idempotent, conflicts fail, and link interruption remains
visibly pending. Schema 9 lifecycle callbacks use a required `turnRef`: the
native Codex turn ID when available, or a retained UUID with `turnId: null`.

### FirstMate

**Fact:** FirstMate assigns a task identity used across backlog entries, briefs,
worker endpoint metadata, worktrees, status events, reports, and delivery
artifacts. Durable disk records plus live backend state allow session-start and
watcher reconciliation.

**Inference:** TaskChef's identity model is narrower and easier to audit because
it binds one record to one native executor. FirstMate's richer identity graph is
necessary for supervision and recovery, but creates more reconciliation paths
and invariants.

## Delegation and concurrency

### TaskChef

**Fact:** The delegation skill splits only independently useful outcomes,
routes each to exactly one configured project, records before one native
creation call, and returns immediately. Multiple dispatchers and executors may
share the workspace; locking and atomic JSONL replacement serialize mutations.

**Fact:** TaskChef itself does not allocate worktrees, choose worker models,
schedule dependencies, retry failed execution, or enforce a repository delivery
mode. Those belong to Codex and each target project's instructions.

### FirstMate

**Fact:** FirstMate distinguishes ship work from scout investigation, prepares
durable task material, selects a configured harness/profile, and spawns workers
in isolated worktrees. Independent work may run concurrently; dependencies and
unsafe shared state can hold work back.

**Fact:** Supported runtime backends and harness adapters are explicit
extension surfaces. The reference path uses tmux, while other documented
backends have different verification or experimental status.

## Status and results

### TaskChef

**Fact:** Persisted statuses are `working`, `needs_input`, `completed`, and
`failed`. Executors report
`working` at turn start and a semantic state before ending. Schema 9 preserves
the paired turn timeline and semantic-only compatibility results while a newer
turn is working. If a terminal report is lost, the next valid working start
closes the predecessor with a timeline-only `interrupted` outcome rather than
semantic `failed`.
`needs_input` is reserved for a real semantic decision, not a native approval
prompt.

**Fact:** The copilot skill explains normalized cached briefs by default and
uses live Codex metadata only for an explicit fresh/live request or a focused
meaningful contradiction. It recommends safe next actions, never polls, and
never writes inferred state.

### FirstMate

**Fact:** FirstMate combines durable task/backlog state, append-only status
events, live backend evidence, validation/delivery artifacts, and watcher wake
records. Its supervision path distinguishes historical event logs from current
worker state and escalates meaningful decisions, failures, stalls, and delivery
milestones.

**Inference:** TaskChef optimizes for a small truthful cache and bounded reads;
FirstMate optimizes for continuity and active coordination. Neither data model
can be substituted for the other without changing product responsibility.

## UI and observability

### TaskChef

**Fact:** The loopback dashboard watches `tasks.jsonl`, streams stable validated
snapshots, filters and orders tasks, shows notifications and details, and opens
a task directly in Codex when its stored thread ID has a supported UUID shape.
This navigation check does not prove schema 4 or 5 self-link provenance. The
dashboard does not refresh native task state, submit replies, or show
transcripts or token usage.

**Fact:** The user can also ask TaskChef copilot for a concise cached brief or
focused live verification, or inspect the data CLI. Executor work remains
visible in normal Codex desktop tasks.

### FirstMate

**Fact:** Workers run in visible session backends that the user can inspect or
intervene in, while the first mate remains the primary interface. Fleet views,
durable status/decision records, and watcher-driven wakes provide the
coordinator's operational observability.

**Fact:** FirstMate currently documents Codex desktop as an integration
boundary, not a selectable worker backend. Codex CLI can participate through a
harness adapter.

## Integrations and extension model

| Area | TaskChef | FirstMate |
| --- | --- | --- |
| Codex | Built around native Codex projects, tasks, thread reads, and desktop deep links. | Codex is one verified harness; desktop tasks are not its worker runtime. |
| GitHub | Configured repository URLs aid routing; delivery remains the executor project's concern. | GitHub CLI, PR state, and configured delivery modes are part of supervised shipping workflows. |
| Skills | Five plugin skills with narrow bootstrap, dashboard recovery, delegate, executor, and conversational coordination responsibilities. | Internal firstmate-only skills plus standalone public skills; AGENTS.md routes conditional procedures. |
| MCP | Four primary local TaskChef tools plus one deprecated compatibility alias own deterministic identity and state writes. | FirstMate describes itself as an agent distribution rather than an MCP product; deterministic behavior lives largely in scripts. |
| Runtime extensions | Extend plugin skills/MCP/CLI/dashboard or compose native Codex capabilities. | Add or verify harness adapters, session backends, dispatch profiles, operational scripts, and optional integrations. |

## Trust and security boundaries

### TaskChef

**Fact:** The MCP server is local and does not receive transport-authenticated
Codex caller identity. Executor thread and turn IDs are cooperative assertions.
Validation prevents accidental parent/provisional identity capture, duplicate
identity use, stale-turn replacement, and malformed record mutation; it does
not resist a deliberately forged local MCP caller.

**Fact:** The dashboard binds to loopback, has no browser authentication, and
uses Host/Origin checks for open-in-Codex actions. It must not be exposed
through a proxy or tunnel. Workspace mutation uses one lock and atomic writes.

### FirstMate

**Fact:** The first mate is normally read-only over project clones; crewmates
make project changes in isolated worktrees. Merge, destructive action, and
standing autonomy are governed by explicit captain authority and per-project
delivery modes. Scripts validate task endpoints, homes, worktrees, and state
before sensitive lifecycle actions.

**Inference:** TaskChef has a smaller local attack and failure surface but
delegates repository safety to Codex and project policy. FirstMate explicitly
owns more delivery and process safety, which improves centralized control while
expanding the trusted script, state, backend, and credential surface.

## Strengths, limitations, and best fit

| Product | Strongest when | Less suitable when |
| --- | --- | --- |
| TaskChef | You already use Codex desktop; want one multi-project inbox; prefer direct executor conversations; value a small inspectable history; want minimal runtime machinery. | You want one liaison to supervise, recover, coordinate decisions, enforce delivery modes, or return only consolidated outcomes. |
| FirstMate | You want one coordinator to run many visible workers; need isolated worktrees, durable fleet recovery, proactive supervision, and consistent delivery policy across projects. | You want native Codex desktop tasks as the core UI; prefer minimal setup and state; or want to interact directly with every executor without a coordinator layer. |

## Recommendations

**Recommendation:** Choose TaskChef when the problem is routing and task
findability. Choose FirstMate when the problem is sustained supervisory
attention and delivery coordination.

**Recommendation:** Do not casually nest the systems. A FirstMate coordinator
behind every TaskChef executor, or TaskChef dispatch inside every FirstMate
worker, adds identity, authority, and recovery boundaries without a clear owner.
If composition is necessary, define exactly one supervisory layer and treat the
other as a leaf runtime or intake adapter.

**Recommendation:** TaskChef can borrow outcome-oriented reporting ideas
without becoming a supervisory runtime. Useful candidates are clearer
completion summaries and an explicit user-approved result-to-follow-up handoff.
They should preserve native Codex task ownership, bounded reads, and the absence
of background supervision.

**Inference:** Reproducing FirstMate's restart-proof crew management inside
TaskChef would not be a small feature. It would require new durable state,
worker liveness contracts, worktree ownership, decision queues, delivery
authority, retry/recovery policy, and a continuously supervised runtime. That
would change TaskChef's product category and should be evaluated as a separate
architecture rather than an incremental dashboard enhancement.
