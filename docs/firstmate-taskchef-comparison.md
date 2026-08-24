# FirstMate and TaskChef: a workflow-first comparison

**Evidence snapshot:** 2026-08-13

**TaskChef:** `favoyang/taskchef` v5.0.2 at commit `446dcc5`

**FirstMate:** [`kunchenguid/firstmate`](https://github.com/kunchenguid/firstmate) at commit [`4930d2c`](https://github.com/kunchenguid/firstmate/tree/4930d2caaba8a14b13b754cefc4bd22d77d993d0)

**Publication context:** The report was merged after TaskChef v5.1.1. The
intervening TaskChef changes were checked and improve delegation preparation and
provisional-task resolution; they do not change the user-workflow conclusions
below. The cited TaskChef evidence remains pinned to the v5.0.2 snapshot that
was originally analyzed.

## The short version

From a user's point of view, the choice is simple:

- **TaskChef gives you one place to send work, then opens the right Codex task.**
  After that, you work with each task directly.
- **FirstMate gives you one person-like coordinator who stays responsible for
  the work.** It assigns workers, follows their progress, brings decisions back
  to you, and carries the work toward a report, pull request, or approved merge.

In other words:

> TaskChef organizes your inbox. FirstMate runs your crew.

Neither approach is universally better. TaskChef is lighter, more transparent,
and fits naturally if you already like working in Codex tasks. FirstMate asks
you to adopt more tooling and more process, but it removes more coordination
work from your day.

The most important question is not “Which one supports more agents?” Both can
start several pieces of work. The question is:

> After a worker starts, do you want to manage it yourself, or do you want the
> coordinator to remain responsible until there is an outcome?

## A likely direction for TaskChef

The comparison also points to a smaller product opportunity than recreating
FirstMate's whole supervision system.

**Recommendation:** TaskChef could become a lightweight, Codex-native
counterpart to FirstMate by improving two parts of the user journey:

1. **Completion-aware reporting.** A TaskChef report would emphasize finished
   outcomes, important decisions, failed work, and the next useful action—not
   only the current state of each executor.
2. **Outcome-to-follow-up handoff.** When a completed investigation recommends
   implementation, TaskChef could create a new native Codex task containing the
   relevant result, evidence, constraints, and acceptance criteria. The user
   would approve that follow-up rather than manually copying the findings into
   another task.

Those additions would close much of the **user-visible** workflow gap. The user
could submit work in one place, return for a consolidated outcome, and continue
from research to implementation without visiting every executor or moving
context by hand.

TaskChef would still differ from FirstMate underneath. It would not need to own
worker sessions, continuously supervise them, recover their repository copies,
or manage a merge pipeline. Native Codex tasks and project instructions could
continue owning those responsibilities.

That leads to a more precise positioning:

> TaskChef can offer a FirstMate-like coordination experience by composing
> native Codex tasks, without becoming a separate agent runtime.

This is an inference and product recommendation based on the verified workflow
comparison. Completion-aware reporting and result-to-implementation handoff are
not TaskChef v5.0.2 features.

## What is being compared

“FirstMate” is an ambiguous name. This report compares TaskChef with
**Kunchenguid's open-source FirstMate**, the project described as “Talk to one
agent. Ship with a crew.” It does not refer to another product with the same or
a similar name. FirstMate was not present in the configured local skills
workspace, so its public repository was inspected at the exact commit shown
above. Its own overview describes the coordinator-and-crew workflow
([FirstMate `README.md:24-46`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/README.md#L24-L46)).

All examples in this report are explicitly **mock examples**. Names, task IDs,
paths, outputs, and pull requests are fabricated to make the workflows
concrete. Source-backed behavior is distinguished from opinion and
recommendation.

## How each product feels to use

### TaskChef: a dispatch desk for Codex

You keep a list of projects that TaskChef is allowed to use. You open the
TaskChef task and describe what you want in ordinary language:

> In payments-api, fix duplicate charges after a retry and add a regression
> test.

TaskChef identifies the project, creates a normal Codex task there, gives you a
link, and becomes available for the next request. If your request contains two
independent jobs, it can create two tasks.

From that point on, the new Codex task is where the work lives. You open it to:

- watch progress;
- answer questions;
- approve commands or sensitive actions;
- redirect the implementation;
- read the final result.

TaskChef can later give you a current summary of the tasks it created, but it
does not sit between you and the workers. It does not keep checking them, retry
failed work, enforce a pull-request process, or merge changes. This is a
deliberate boundary, not a missing background service: TaskChef specifies that
native Codex tasks remain authoritative and that dispatch returns immediately
([TaskChef specification: Purpose](../SPEC.md#purpose)).

The experience is close to having a receptionist who knows which room each job
belongs in and keeps a log of where it was sent.

### FirstMate: a hands-on engineering coordinator

You talk to one primary agent—the “first mate”—about work across your projects.
It does not merely open a worker and hand it back. It stays involved.

For a typical implementation request, FirstMate:

1. identifies the right project;
2. decides whether the request is implementation work or an investigation;
3. prepares task instructions and records the work in a queue;
4. starts a worker in an isolated copy of the repository;
5. watches for progress, failures, and decisions;
6. brings important questions to you;
7. follows the project's chosen review and delivery path;
8. reports the finished investigation or review-ready pull request;
9. cleans up only after the work is safely landed or otherwise resolved.

You normally keep talking to the first mate, not to each worker. The workers
are visible, and you can intervene, but FirstMate is designed to reconcile that
intervention and resume coordination. Its documented lifecycle covers intake,
dispatch, validation, pull requests, landing, and cleanup
([FirstMate `AGENTS.md:249-373`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L249-L373)).

The experience is closer to having a technical lead who delegates, checks in,
and returns with decisions and outcomes.

## The everyday journey, side by side

| Moment in the workflow | With TaskChef | With FirstMate | Workflow similarity |
|---|---|---|---:|
| You submit a request | Tell TaskChef which project or describe work clearly enough to route. | Tell the first mate the outcome you want. It resolves the project and the type of work. | 85% |
| The target is unclear | TaskChef asks rather than guessing. GitHub issue and PR links can provide an exact project match. | FirstMate uses the project registry, ongoing work, and repository context; it asks when no confident match exists. | 80% |
| One request contains several jobs | Independent jobs become separate Codex tasks. | Independent jobs become separate supervised workers; dependent jobs stay queued or coordinated. | 75% |
| Work starts | You receive links to ordinary Codex tasks. | Workers start in isolated repository copies and FirstMate retains responsibility. | 45% |
| You want progress | Open each executor, or ask TaskChef for a one-time report. | Ask the first mate; it also surfaces meaningful events without routine “still working” updates. | 40% |
| A worker needs a decision | The executor asks you directly in its task. | The worker reports to FirstMate, which answers within its authority or presents the decision to you. | 45% |
| A worker gets stuck | You notice in the task and guide or restart it using normal Codex interaction. | FirstMate detects relevant stalled or failed states and follows a recovery process. | 20% |
| The implementation is ready | The executor reports whatever the project workflow produced. | FirstMate follows the selected path: full validation and PR, direct PR, or a ready local branch. | 40% |
| A merge is needed | Governed by the executor's project instructions and your interaction with it. | Governed by the project's standing policy and the authority you granted; red work is not silently merged. | 35% |
| You return tomorrow | Existing Codex tasks remain the place to continue. TaskChef's history helps you find them. | FirstMate reconstructs active work from saved records and live worker state, then resumes supervision. | 50% |
| You want history | See what TaskChef sent, when, to which project and Codex task. | See a richer work history including queue state, task instructions, decisions, reports, worker state, and delivery artifacts. | 45% |

The percentages are editorial estimates of how similar the **user-visible
workflow** is at each stage. They are not benchmark results. A high percentage
means the user takes a similar action and sees a similar outcome; a low
percentage means responsibility or interaction shifts substantially between the
user and the coordinator.

## End-to-end workflow: TaskChef

### 1. Set up the inbox

TaskChef is built for a Codex desktop user with several local projects. You
install the plugin, run its bootstrap skill, and let it create a small TaskChef
workspace. You then register the projects it may route to. Each project has a
name, local path, optional description, and any GitHub repositories associated
with it (`README.md:32-82`; [TaskChef specification: Workspace](../SPEC.md#workspace)).

The practical setup work is mostly curating good project descriptions. If two
projects sound similar, clearer descriptions make conversational routing more
reliable.

```json
// MOCK configuration excerpt — all paths and organizations are fabricated
{
  "schemaVersion": 2,
  "projects": [
    {
      "name": "payments-api",
      "path": "/mock/work/payments-api",
      "isGitRepository": true,
      "githubRepos": ["https://github.com/mock-co/payments-api"],
      "description": "Payment authorization, capture, refunds, and retries."
    }
  ]
}
```

TaskChef can also route to a non-Git folder. It does not ask you to configure
worker models, review modes, merging policy, or background supervision. Those
belong to Codex and the target project.

### 2. Submit work

You can type an ordinary request inside the TaskChef project. From another
project, you explicitly invoke the delegation skill.

TaskChef breaks up the request only when the pieces are independently useful.
Each new worker receives the actual objective, constraints, expected tests, and
reporting requirement—not merely a pointer back to the dispatcher
(`skills/taskchef-delegate/SKILL.md:28-38`).

### 3. Let TaskChef choose the project

TaskChef considers the project's name, description, and associated GitHub
repositories. A pasted GitHub issue or pull-request link is especially strong
evidence: TaskChef compares the repository identity and routes only if exactly
one configured project matches. It asks when the match is missing or ambiguous
([TaskChef specification: Dispatch workflow](../SPEC.md#dispatch-workflow)).

This routing is one of TaskChef's strongest user-facing features. It avoids
sending a plausible-sounding job to the wrong checkout merely because two
projects use similar language.

### 4. Receive the executor task

TaskChef opens a normal Codex task in the selected project and returns a link.
The new task is independently openable and behaves like any other Codex task.
TaskChef also records enough information to find it later.

There is a small creation-time edge case: Codex may initially return only a
temporary identity while a worktree-backed task is materializing. TaskChef
records the request before creation, then the executor registers its own
durable child identity through `link_task` as its first action. Until that
succeeds, the record remains visibly link-pending and the executor retries on a
later turn without dispatcher search or identity guessing
([TaskChef specification: Executor self-linking](../SPEC.md#executor-self-linking)).
From the user's point of view, this means “preserved and waiting for the child
to identify itself,” not “lost.”

### 5. Work directly with the executor

This is the defining TaskChef workflow choice. Once the executor exists, you
leave the dispatch desk and enter the task itself.

That is useful when you want direct visibility. You see the worker's exact
questions and actions without a coordinating agent translating them. It also
means that if five tasks are active, you may still have five conversations to
visit.

### 6. Ask for a report when you need one

TaskChef keeps a submitted-task history. When you ask for status, it checks the
relevant Codex tasks once and gives you a current summary. It does not keep
polling and does not save that live status back into its history
(`skills/taskchef-report/SKILL.md:15-53`).

The history answers:

- What did I send?
- Which project received it?
- When was it sent?
- Which Codex task owns it?

It does not attempt to become a full audit trail of implementation decisions,
test runs, approvals, or final delivery.

### 7. Complete work in the executor

TaskChef considers its own job complete once the request has been safely
delegated and recorded. The executor's project instructions determine whether
“done” means changed files, a commit, a pull request, green CI, or a merge.

That keeps TaskChef easy to understand, but it also means workflow consistency
depends on the projects you send work to.

## End-to-end workflow: FirstMate

### 1. Set up a working home, not just an inbox

FirstMate is distributed as a repository containing its operating instructions,
skills, and helper scripts. You clone it and launch a supported coding-agent
harness inside it
([FirstMate `README.md:50-113`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/README.md#L50-L113)).

Setup is more demanding than TaskChef. A normal FirstMate installation expects
GitHub tooling, a terminal-session backend, isolated-worktree support, and a set
of supporting workflow tools. You also decide how each project should deliver
work:

- **full validation and PR** for the most controlled path;
- **direct PR** for a faster path;
- **local-only** for work that should stop on a ready local branch;
- optional standing authority for routine in-scope decisions and green merges.

You may also choose different worker tools or models for different types of
work. This flexibility is useful, but it creates more setup choices than a user
who simply wants “send this to Codex” may need.

### 2. Submit an outcome, not a worker instruction

You tell the first mate what you want. It resolves the project for each request
and decides how to shape the job.

There are two main task shapes:

- A **ship task** changes a project and follows its delivery path.
- A **scout task** investigates, diagnoses, plans, or audits and leaves a
  standalone report. A recommendation in that report does not silently become
  permission to implement it.

This distinction is valuable from a user perspective: “Find out why this
happens” remains research, while “fix it” becomes delivery. FirstMate documents
that separation explicitly
([FirstMate `AGENTS.md:266-280`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L266-L280)).

### 3. FirstMate records and prepares the job

Before starting a worker, FirstMate puts the job in a durable queue and writes a
task-specific brief. The brief includes the outcome, acceptance criteria,
constraints, and delivery expectations. This is more process than TaskChef's
single executor prompt, but it gives recovery and supervision a stable shared
reference.

If tasks are genuinely independent, FirstMate starts them without an arbitrary
concurrency cap. It waits only when there is a real dependency or unsafe shared
state—not merely because two changes touch the same file
([FirstMate `AGENTS.md:277-285`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L277-L285)).

### 4. A worker starts in an isolated copy

Each normal ship or scout worker gets a separate repository worktree. This is a
major user-facing difference: concurrent workers are designed not to edit the
same working copy. If FirstMate cannot prove that isolation, it stops the task
instead of starting it unsafely
([FirstMate `AGENTS.md:287-300`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L287-L300)).

You can see the worker in the selected terminal/session interface, but you are
not expected to manage its session routinely.

### 5. FirstMate supervises while you continue talking to one liaison

The first mate watches for meaningful changes: a decision, a failure, a worker
that has stopped responding, a review-ready pull request, or completed
investigation. Routine “still running” signals are not meant to become noisy
progress messages.

When a worker asks something, FirstMate either:

- answers within the authority you already granted;
- sends a concise follow-up to the worker; or
- gives you the evidence, consequence, options, and recommendation.

The coordinator is instructed to translate internal mechanics into plain
project outcomes rather than dumping raw worker logs into the conversation
([FirstMate `AGENTS.md:428-470`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L428-L470)).

This saves attention, but it also means you receive an interpreted summary. If
you prefer to see every question exactly as the worker asked it, TaskChef's
direct-task model is more natural.

### 6. Work follows the chosen delivery path

FirstMate does not use one universal definition of “done.” The chosen project
workflow controls the outcome:

- The most rigorous mode runs its full validation/review/CI pipeline before a
  pull request is presented as green.
- The direct-PR mode presents the pull request after it is opened; it does not
  imply the same validation guarantee.
- The local-only mode prepares a clean branch and waits for approval to land it
  locally.

Review rigor and permission to make decisions are separate. With standing
autonomy disabled, you approve important decisions and landing. With it
enabled, FirstMate can handle routine in-scope decisions and green merges, but
it still may not silently expand the request or override destructive,
irreversible, security-sensitive, red-merge, or discard boundaries
([FirstMate `AGENTS.md:302-324`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L302-L324)).

### 7. FirstMate reports the outcome and keeps unfinished work safe

For pull-request work, FirstMate returns a full URL and a concise outcome. For
an investigation, it reads and relays the report. It does not discard a worker's
copy merely because the worker stopped or a PR was opened. Cleanup waits until
work is safely landed or the user explicitly authorizes discard
([FirstMate `AGENTS.md:350-372`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L350-L372)).

### 8. If you close the session, FirstMate reconstructs the fleet

FirstMate saves enough information to reconcile active jobs after restart. It
checks its recorded tasks against the actual worker sessions and repository
copies. A dead worker can be relaunched into the existing task context rather
than treating the work as a brand-new request
([FirstMate `AGENTS.md:205-218`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L205-L218)).

This is one of FirstMate's clearest advantages for long-running work. It is also
one reason its internal state and setup are much larger than TaskChef's.

## Three realistic mock workflows

### Mock example 1: one repository, one implementation

**Request**

> In payments-api, fix duplicate charges after a provider retry, add a
> regression test, and open a PR. Do not merge it.

#### What happens with TaskChef

TaskChef finds `payments-api`, opens one Codex task, and replies immediately:

```text
MOCK OUTPUT
Created “Fix duplicate retry charge” in payments-api.
Open task: mock-thread-payments-01
```

You open that task. The worker implements the fix, asks you any questions
directly, runs the project's tests, and follows the project's PR instructions.
TaskChef is no longer in the loop.

Later, you can ask the dispatcher for a report:

```text
MOCK OUTPUT
Fix duplicate retry charge — completed
Regression test added; 42 tests passed.
PR: https://github.com/mock-co/payments-api/pull/42
```

That status came from the executor at report time. TaskChef does not copy it
into a permanent lifecycle record.

#### What happens with FirstMate

FirstMate classifies the request as implementation work, records it, creates a
separate repository copy, and starts a worker. The coordinator watches the job.
If the worker needs a product decision, FirstMate brings it to you. When the PR
is opened under the selected delivery path, FirstMate says something like:

```text
MOCK OUTPUT
Captain, the duplicate-charge fix is ready for review:
https://github.com/mock-co/payments-api/pull/42
The worker added a provider-retry regression test. I have not merged it.
```

FirstMate retains the job until the change is landed or otherwise resolved.

**User-visible difference:** TaskChef gets you into the right working
conversation. FirstMate tries to save you from entering that conversation at
all unless a decision needs you.

### Mock example 2: independent work across projects

**Request**

> Add structured retry-failure logs in payments-api. Separately, fix keyboard
> focus order in storefront. Run each project's tests and report both results.

#### What happens with TaskChef

TaskChef recognizes two independent outcomes and creates two Codex tasks:

```text
MOCK OUTPUT
Created “Add retry-failure logs” in payments-api — mock-thread-api-02
Created “Fix checkout focus order” in storefront — mock-thread-web-03
```

They can run at the same time. You now have two task links. You may visit each
one or ask TaskChef for a one-time combined report.

There is no saved “parent request” connecting these two records. TaskChef's
backlog explicitly lists grouping tasks from one broad request as future work
(`BACKLOG.md:6-14`).

#### What happens with FirstMate

FirstMate records two jobs, starts two isolated workers, and watches both. If
the storefront PR finishes while the API change remains in CI, it can give you
a useful partial outcome without treating elapsed time as progress:

```text
MOCK OUTPUT
Captain, the storefront fix is ready for review:
https://github.com/mock-co/storefront/pull/77
The payments logging change is still in CI; no decision is needed.
```

When both are ready:

```text
MOCK OUTPUT
Captain, both changes are ready:
- payments-api: https://github.com/mock-co/payments-api/pull/43 — CI green
- storefront: https://github.com/mock-co/storefront/pull/77 — accessibility checks green
Neither PR has been merged.
```

If the projects require different delivery policies, FirstMate preserves those
differences rather than forcing both into one shared batch contract
([FirstMate `bin/fm-spawn.sh:141-149`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/bin/fm-spawn.sh#L141-L149)).

**User-visible difference:** TaskChef gives you a neat set of parallel Codex
tasks. FirstMate gives you a combined supervisory view and owns the uneven
progress of the set.

### Mock example 3: creation failure and recovery

**Request**

> In catalog, add a health-check timeout test.

#### What happens with TaskChef

Suppose Codex accepts the task but initially returns only a temporary task
identity. TaskChef has already saved the marked delegation. The child reads its
own durable identity from native task context and calls `link_task`; the
dispatcher neither searches recent tasks nor repairs identity.

If the child's first link is interrupted or rejected, the record remains
link-pending and that same executor retries before substantive work on a later
turn. Status reporting does not infer or write an identity
([TaskChef specification: Executor self-linking](../SPEC.md#executor-self-linking)).
The user-visible state is:

```text
MOCK OUTPUT
The catalog request was accepted and recorded, but its executor has not linked
its durable Codex task yet. It remains link-pending for an executor retry.
```

TaskChef's recovery ends at task identity. If the executor later crashes during
implementation, you continue or recover it through normal Codex interaction.

#### What happens with FirstMate

Suppose the selected worker environment is unavailable. FirstMate stops before
starting the job and reports the concrete problem; it does not silently move the
job to a different environment
([FirstMate `AGENTS.md:201-204`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L201-L204)).

```text
MOCK OUTPUT
Captain, the catalog worker could not start because the selected terminal tool
is unavailable. I recommend restoring that configured tool. Switching worker
environments would change the agreed execution path.
```

After the tool is restored, FirstMate retries the same recorded job. If the
worker later dies after making uncommitted changes, FirstMate preserves the
repository copy and can launch a replacement worker into the same job. The
logical task remains the same even though the worker instance changed.

**User-visible difference:** TaskChef specializes in not losing the link
between a submitted request and a Codex task. FirstMate specializes in keeping
the job itself recoverable after a worker has started.

## Parallel work and multiple projects

Both products reduce project-switching, but they do so differently.

### TaskChef

- Can create several independent executors from one request.
- Can send several active tasks to the same project.
- Returns immediately, so the dispatch inbox remains responsive.
- Does not persist dependencies between tasks.
- Does not itself guarantee separate repository worktrees for same-project
  concurrency. Its backlog calls out isolation and conflict handling as an open
  area (`BACKLOG.md:25-34`).
- Works only with configured projects on the same local execution host.

### FirstMate

- Starts independent work concurrently and keeps genuine dependencies durable.
- Uses an isolated repository copy per normal task.
- Can maintain persistent domain-specific secondmates, locally or on an
  SSH-reachable host.
- Keeps local-only work with the primary coordinator.
- Treats an unavailable remote route as unavailable; it does not silently run
  the work locally instead
  ([FirstMate `docs/remote-secondmates.md:147-188`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/docs/remote-secondmates.md#L147-L188)).

For a user, TaskChef's model scales by giving you more task links. FirstMate's
model scales by adding more workers while trying to preserve one conversation.

## Questions, approvals, and control

### With TaskChef

The executor asks you questions directly. This is straightforward and gives you
the full context, but it means your attention can be divided across several
tasks. Approval rules come from Codex and the target project's instructions.
TaskChef does not impose a common approval or merge policy.

### With FirstMate

Workers normally ask FirstMate, and FirstMate asks you only when the decision
exceeds its authority. You can choose conservative projects where every merge
returns to you, or grant standing authority for routine, in-scope, green work.

Some boundaries remain yours even with more autonomy: destructive or
irreversible actions, security-sensitive choices, material scope expansion,
discarding unfinished work, and red merges are not treated as routine permission.

This is more convenient when many tasks are active, but it asks you to trust the
coordinator to summarize decisions accurately.

## Progress, history, and returning after a break

### TaskChef's history

TaskChef keeps a compact, durable log of submissions. It preserves the exact
instruction, selected project, creation time, TaskChef identity, and Codex task
link. Project removal does not erase old entries
([TaskChef specification: Task schema](../SPEC.md#task-schema)).

This is good for finding work and answering “where did that request go?” It is
not meant to answer every lifecycle question. Final outcomes, approvals, test
results, and transcripts remain in Codex.

### FirstMate's history

FirstMate keeps a work queue, briefs, investigation reports, decisions, worker
records, delivery details, and enough state to reconcile after restart. Its
status views distinguish between an old event and the worker's current reality;
the coordinator is expected to reconcile before presenting a conclusion
([FirstMate `AGENTS.md:374-409`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/AGENTS.md#L374-L409)).

This supports “what needs my attention?” and “what survived the restart?” much
better than a submission log, at the cost of more local operational state.

Neither system's own history is intended to store hidden model reasoning.

## Feature matrix in user terms

| What you may care about | TaskChef | FirstMate |
|---|---|---|
| One place to submit work for many projects | Yes | Yes |
| Work appears as ordinary Codex desktop tasks | Yes | No; Codex CLI can be a worker, but Codex desktop is not a FirstMate runtime backend |
| You talk directly to each worker | Yes | Optional, but the intended path is through FirstMate |
| One coordinator remains responsible | No | Yes |
| Independent work can run in parallel | Yes | Yes |
| Same-project workers get isolated repository copies | Not guaranteed by TaskChef | Yes |
| Non-Git folders are supported | Yes | Not as normal ship/scout work |
| Dependencies remain queued | No | Yes |
| Stuck workers are actively supervised | No | Yes |
| Work can resume after the coordinator restarts | Native Codex tasks continue independently | Yes, through saved records and worker reconciliation |
| Different worker tools/models can be chosen by job | No | Yes |
| Remote workers are supported | No | Yes, through configured secondmates with constraints |
| Investigation can be a first-class report rather than code | Left to the executor | Yes, as a scout task |
| PR and validation flow is built into the coordinator | No | Yes |
| The coordinator can merge green work when authorized | No | Yes |
| A permanent record shows where requests went | Yes | Yes |
| A permanent record follows the fuller lifecycle | No | Yes |
| Background/away supervision | No | Yes |
| Setup is small | Yes | No |
| Behavior is easy to explain | Yes | More complex |

Qualification: FirstMate can run Codex as a terminal worker, but its repository
explicitly says Codex desktop is not currently a supported task backend
([FirstMate `docs/codex-app-backend.md:1-29`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/docs/codex-app-backend.md#L1-L29)).

## Where each product is strongest

### TaskChef is strongest when

- You already like the Codex task experience.
- You want a central inbox without adding a second project-management system.
- You prefer to see and answer each worker directly.
- Your repositories already contain good instructions for testing, reviewing,
  and shipping.
- Some targets are ordinary folders rather than Git repositories.
- You value a small, inspectable history and minimal background activity.
- “Dispatch quickly, then get out of the way” matches how you work.

### TaskChef is weaker when

- You do not want to visit several active tasks.
- You need one place that continuously tells you what requires attention.
- Same-repository parallel work must have coordinator-enforced isolation.
- Failed implementation should be retried or recovered automatically.
- You want a consistent path from request to green PR or merge across projects.
- You need remote workers, dependencies, or a long-running supervisory queue.

### FirstMate is strongest when

- You want one conversation even while many workers are active.
- You want outcomes and decisions rather than a set of task links.
- Parallel repository work needs isolated copies by default.
- Long jobs must survive restarts and worker replacement.
- Projects need explicit and different review/landing policies.
- You want investigations to produce durable reports before implementation is
  authorized.
- Different agent tools or remote coordinators are worth operating.

### FirstMate is weaker when

- You want minimal setup.
- You primarily work in Codex desktop and want every job to be a native Codex
  task.
- You prefer direct worker conversations over summarized coordination.
- Your work includes non-Git folders.
- Your existing engineering platform already owns queues, worker supervision,
  CI delivery, and merge policy.
- The cost of maintaining terminal backends, supporting tools, and richer local
  state exceeds the tab-juggling it removes.

## Recommendation: choose based on the attention model

Choose **TaskChef** if your pain is:

> “I have many Codex projects and keep starting work in the wrong place.”

TaskChef fixes routing and findability while preserving the normal Codex model.
It is the better fit when each executor can largely take care of itself and you
do not mind opening it when interaction is needed.

Choose **FirstMate** if your pain is:

> “I have too many workers to watch, and I keep becoming the manual
> coordinator.”

FirstMate takes ownership of supervision, recovery, and delivery. It is the
better fit when the work is valuable or long-running enough to justify a more
opinionated operating system around the agents.

For many users, the safest progression is:

1. Start with TaskChef if routing is the immediate problem.
2. Add completion-aware reporting and a user-approved way to create an
   implementation task from a finished investigation.
3. Put strong testing and delivery instructions in each project so the native
   executors can own the work after handoff.
4. Move to a fully supervisory FirstMate-style coordinator only when repeated
   worker recovery, live decision mediation, or delivery management becomes the
   real bottleneck.

**Recommendation:** avoid casually nesting the two. Putting a FirstMate
coordinator behind each TaskChef task, or making FirstMate create TaskChef
dispatchers, would introduce two routing layers and make it unclear which system
owns questions, recovery, and completion.

## Constraints and known gaps

### TaskChef

- Same-host local projects only.
- No built-in worker supervision or implementation retries.
- No dependency model or saved grouping for tasks split from one request.
- No coordinator-owned worktree or conflict policy for same-project concurrency.
- No built-in PR, CI, or merge workflow.
- If Codex returns only a temporary creation identity, TaskChef has a careful
  recovery process, but an official temporary-to-durable mapping remains an
  upstream gap (`BACKLOG.md:43-55`).
- Search, date filtering, retention, scheduled reports, and inaccessible-task
  categories remain possible future work (`BACKLOG.md:6-23`).

### FirstMate

- Setup and maintenance are substantially heavier.
- Feature support varies by worker tool and terminal backend.
- Codex desktop is not a supported backend, even though Codex CLI can be a
  worker.
- Remote secondmates have extra host, login, toolchain, and recovery
  requirements; FirstMate's own documentation says genuine remote macOS
  behavior still needs an operator-run smoke test
  ([FirstMate `docs/remote-secondmates.md:227-246`](https://github.com/kunchenguid/firstmate/blob/4930d2caaba8a14b13b754cefc4bd22d77d993d0/docs/remote-secondmates.md#L227-L246)).
- Normal ship/scout tasks depend on Git worktrees.
- The coordinator makes judgment-heavy routing and summary decisions, even
  though scripts enforce many mechanical safety checks.

## Evidence and validation notes

The comparison was based on source rather than marketing pages.

For TaskChef, the local v5.0.2 checkout was inspected across its specification,
README, CLI, three skills, workspace implementation, delegation logic, plugin
manifest, package manifest, backlog, and tests. `node bin/taskchef.js help` was
checked, and the full test suite passed: **83/83 tests**.

For FirstMate, the public repository was cloned at commit `4930d2c`. The review
covered its README, operating instructions, architecture/configuration docs,
worker launch and control scripts, delivery modes, supervision, remote
secondmates, recovery behavior, trace correlation, and representative tests.
Selected tests for parallel spawn, delivery rules, state transitions, task
identity, tracing, and recovery passed outside the restricted sandbox. The
decision-hold test skipped because its optional `tasks-axi` dependency was not
installed.

No live agents, worktrees, pull requests, merges, or remote hosts were created
for this comparison. The full FirstMate test suite was not run because it is
large and includes optional-backend and live end-to-end suites. Claims about
Codex behavior outside TaskChef's own source were not treated as TaskChef
guarantees. FirstMate's “restart-proof” language was interpreted as its
documented recovery design, not as immunity to every host, network, credential,
or filesystem failure.
