# Orchestrated execution contract

Use this workflow only when the linked TaskChef record reports
`executionMode: orchestrated`, or when an existing legacy task is explicitly
adopted on a new follow-up through execution contract version 1. The visible
executor remains the stable parent. It owns authority interpretation, TaskChef
lifecycle and phase writes, repository/worktree choice, single-writer safety,
Planrock reconciliation, handoff acceptance, user communication, and delivery
verification. It delegates substantive investigation, planning,
implementation, and independent review; it must not silently do that work
itself when spawning fails.

## Classify the current prompt

Before the working report, classify the explicit current request and latest
accepted plan without treating unchecked plan steps as permission:

| Intent | Required sequence |
| --- | --- |
| `investigate` | Fresh planner; save a plan only when requested or required for the accepted handoff; no product-code mutation. |
| `plan_and_implement` | Fresh planner, then fresh implementer, then the independent review loop. Existing implementation authority carries through; do not ask routinely again. |
| `implement` | Fresh implementer, then independent review. Add a planner only for material uncertainty; do not force a ceremonial plan for a small fix. |
| `continue_plan` | Reconcile the exact saved plan and current repository state, then use a fresh implementer and independent review. Add a planner only when the plan or evidence is materially stale. |

Report `intent`, a bounded `acceptedScope`, and an optional `planRef` with
repository identity, repository-relative path, revision, and content hash on
the initial `working` call. A later “implement it” remains in this parent but
uses a new lifecycle turn and a new implementer. “Ship” or “deliver” has only
the authority granted by the applicable repository instructions.

## Resolve and reserve each phase

Run only one substantive phase at a time. Immediately before every spawn:

1. Call `resolve_execution_role` for exactly `planner`, `implementer`, or
   `reviewer`, preserving explicit role-scoped or clearly task-wide model and
   effort instructions. An unqualified historical model instruction applies
   to the visible parent only.
2. Missing means omit overrides and inherit through the current subagent
   interface. Invalid, duplicate, unresolved, or unsupported settings stop the
   phase visibly; never claim fallback was honored. Cached availability is
   advisory. Validate any override against the current spawn tool. If that
   interface itself proves a cache-flagged model and effort are supported,
   re-resolve with `nativeAvailabilityConfirmed: true`; the flag cannot repair
   invalid or ambiguous role configuration.
3. Generate a unique phase ID and event UUID. Call `report_phase` with
   `reserve`, the current execution revision, kind, attempt, role, exact
   `resolution` returned by `resolve_execution_role`, whether the child will
   write, and a unique review pass
   ID for review. Do this before spawning.
4. Spawn a fresh no-history child. Never reuse a planner as implementer or an
   implementer as reviewer. Pass only the supported model/effort overrides;
   do not use a named-agent selector as a substitute for the narrow adapter.
5. Call `report_phase` with `start` and the returned opaque agent handle. Bind
   a durable child thread with `bind` only when the native interface exposes it
   or the child explicitly asserts its own durable identity; record that
   provenance. Never infer identity from a title, path, inherited parent ID,
   transcript, process ancestry, or UUID-looking handle.

If spawn fails, finish the reserved phase as failed. An uncertain spawn
response or timeout is not proof that a writer stopped. Reconcile or interrupt
the native child and establish terminal status before releasing ownership. If
that cannot be established, halt dependent work. Retries use a new attempt and
retain prior attempts.

## Child handoff

Every child receives a bounded worker contract without the parent's TaskChef
marker or executor invocation. Include:

- task, turn, phase, and attempt identity;
- intent and exact authorized scope;
- repository root, worktree, branch, base commit, and current diff fingerprint;
- owned paths and exclusive writer/read-only status;
- plan repository-relative identity, resolved path, and content hash when used;
- relevant repository instructions, accepted decisions, dependencies,
  acceptance criteria, and validation commands; and
- required return fields: outcome, artifact paths, diff summary, validation
  commands/results, unresolved issues, and any live approval/input reference.

Tell every writer it is not alone in the codebase, must preserve unrelated
changes, and must stop on unexpected overlap. The parent must not stage,
commit, rewrite the plan, switch branches, or run mutating formatters while a
child owns write access. Reviewers are read-only. Revalidate status, HEAD, and
intended paths at every transfer.

When the child ends, verify its artifacts exist, its actual diff matches
scope, claimed checks have evidence, and no child remains an active writer.
Then finish the phase with its terminal state, bounded summary, and artifact
references. Child success alone never proves the assignment complete.

## Planning and implementation

Planrock remains the durable accepted plan/progress store; phase records are
execution telemetry. Use repository-local `plans/`, record this stable parent
session, reconcile full scope on follow-up, validate every mutation, and keep
model routing out of plan YAML. Give plan write ownership to only one agent at
a time.

Use child-repository topic worktrees when repository policy requires them.
Planner ownership is read-only except for explicitly assigned plan artifacts.
Implementer ownership covers only the authorized patch and tests. Neither may
link as the TaskChef executor, report parent lifecycle/phase state, create a
replacement visible task, broaden authority, merge, or publish by inference.

## Independent review

Use the installed `branch-review-subagent-loop` as the sole independent review
owner after implementation and after every accepted fix. It resolves a fresh
reviewer immediately before each pass and requires neutral complete-diff
coverage and `CLEAN`. TaskChef records each review pass as a read-only review
phase but does not redefine the loop.

By default fixes remain in the invoking parent. If the installed review skill
exposes its delegated-fix contract, the orchestrator may send verified findings
to a fresh implementer with exclusive write ownership. Wait for that writer to
end, verify and validate its patch, then start a new fresh neutral reviewer.
Missing fresh spawning or incomplete coverage is a hard review-gate failure.

## Failure, steering, and recovery

A child question returns to the parent. Ask the user once and use semantic
`needs_input` only when the turn must end for that decision. A native approval
stays live and is not semantic input. Preserve denial and permission scope
across retries. Technical failure becomes `failed` only after bounded in-scope
recovery is exhausted.

New user steering in the same native prompt keeps the current lifecycle
identity. A genuinely new prompt uses a new turn identity. Before a newer turn
starts, reconcile and stop old native children; the storage transition fences
unfinished phase reports but does not itself terminate a process. Stale child
completion cannot advance the newer turn. Cancellation terminates descendants
before parent completion.

Only the self-linked parent calls `report_phase`. Events use the returned
execution revision and unique event IDs; identical retries are safe, changed
payloads are conflicts. Phase events do not rewrite lifecycle timestamps.
Manual dashboard completion is blocked while a phase is active.

## Usage truthfulness and completion

TaskChef currently exposes parent-only ccusage totals. The dashboard labels
orchestrated coverage partial and counts started descendant phases as missing
from the total. Do not sum child numeric claims, infer lineage, inspect private
transcripts, or describe parent totals as complete descendant accounting.
Late usage must remain attributable to its original turn; it never blocks
semantic completion.

Before reporting `completed`, verify every intent-required phase is accepted,
no phase or writer is active, required validation and independent review pass,
PR/check state meets repository policy, Planrock is current, and the complete
requested outcome is satisfied. TaskChef enforces these minimum phase gates:
`investigate` requires a completed plan phase; `plan_and_implement` requires
completed plan, implement, and review phases; `implement` and `continue_plan`
require completed implement and review phases. The latest attempt of each
required non-review phase must succeed, and the final review after the latest
writer must succeed; an earlier clean review cannot bless later edits.
