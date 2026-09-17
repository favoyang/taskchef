# TaskChef

When work spans several Codex projects, you have to choose the right project,
find each conversation again, and check which tasks are waiting for you.
TaskChef gives you one conversation for delegating that work and a dashboard
for seeing what needs your attention.

**Less time managing tasks. More time moving them forward.**

Give TaskChef a GitHub issue or a rough idea. It uses an explicit project name,
the conversation's context, or saved repository mappings to choose a Codex
project; if the destination is unclear, it asks you to choose. One local Codex
project can map to several repositories. TaskChef creates separate, ordinary
Codex tasks in those projects. Each has its own conversation and native tools,
and tasks can run in parallel.

You can keep using Codex as you do today. Start by delegating work where the
project choice or follow-up is cumbersome, then bring more work into TaskChef
as you go.

## What working with TaskChef looks like

In your TaskChef dispatcher conversation, paste an issue link and ask:

```text
Investigate this issue, fix the cause, and run the relevant tests: https://github.com/example/payments/issues/42
```

If the saved repository mapping identifies the payments project, TaskChef
opens a separate Codex task there and returns its link. The task investigates
the issue in its own conversation while other delegated tasks can work in
other projects.

> **Screenshot placeholder:** Issue handoff in the dispatcher conversation,
> with a link to the new payments task.

Later, open the dashboard to see tasks across your projects. The board groups
them by **Working**, **Needs input**, **Completed**, and **Failed**. In the list
view, filter by **Needs input** to find decisions waiting for you, including a
question from the payments task.

> **Screenshot placeholder:** Dashboard with tasks from several projects and
> the **Needs input** filter selected.

Select the payments task and choose **Open chat** to answer in its original
Codex conversation. When the work finishes, its result appears on the
dashboard; TaskChef does not post each result back into the dispatcher chat.

> **Screenshot placeholder:** Original payments task conversation after a reply,
> followed by its completed result on the dashboard.

You can also start from a rough idea:

```text
Explore an idea for clearer refund history in payments. Discuss the approach with me before coding.
```

TaskChef opens a task in the selected project. Discuss the options in that
task. If a written plan would help, ask it to save a Markdown plan, then ask
it to implement the agreed approach in the same task. A plan file is created
when you request one; it is not a required step for every task.

Keep the dashboard beside your conversation in Codex's built-in browser. It
shows each task's latest request and result. Open a task to see its total
reported work duration, token usage, and estimated cost, with the same figures
for each turn in its activity timeline. Duration is reported wall-clock time
spent on turns; cost is an API-equivalent estimate, not a bill. Token and cost
figures can be unavailable when usage cannot be mapped to the Codex task.
Task states normally come from the task's own reports; TaskChef does not
automatically supervise execution.

## Install and delegate your first task

You need Node.js 18 or newer, Git, Codex desktop, and local access to the
projects that will receive work. Install the plugin and CLI:

```sh
codex plugin marketplace add favoyang/codex-plugins
codex plugin add taskchef@favoyang-plugins
npm install --global taskchef
```

Set up the local TaskChef dispatcher and index your saved Codex projects:

```text
$taskchef-bootstrap Set up TaskChef and index my local Codex projects.
```

Open the TaskChef dispatcher project created at `~/.agents/taskchef`. Replace
`<your-project>` with one of your indexed Codex project names and try a
read-only first request:

```text
In <your-project>, explain how to run the app and tests. Do not change files.
```

TaskChef returns a link to the new Codex task. Its local dashboard is at
[127.0.0.1:3210](http://127.0.0.1:3210/). If it is unavailable, ask
`$taskchef-dashboard` to ensure and open it. You can add repository mappings
or refine project descriptions with `$taskchef-bootstrap` when routing needs
more context. If the installed skills do not appear, activate or reload the
TaskChef plugin in Codex and try again.

## Choose models for each role

In the dashboard's **Settings** page, choose a model and reasoning effort for
the **Orchestrator**, **Planner**, **Implementer**, and **Reviewer** roles.
TaskChef saves these preferences in native Codex agent files under
`~/.codex/agents/` and applies them when it dispatches the corresponding work.
Set them once for future tasks; a model choice you make explicitly for a task
takes precedence over its role preference.

## More detail

The [advanced guide](docs/advanced-guide.md) covers project indexing, routing,
task reporting, dashboard behavior, recovery, updates, and development. The
[specification](docs/spec.md) and [workflows](docs/workflows.md) describe the
implementation contracts. TaskChef was inspired by
[FirstMate](https://github.com/kunchenguid/firstmate); the
[comparison](docs/firstmate-taskchef-comparison.md) explains their different
approaches.
