# TaskChef

TaskChef lets you delegate work across your Codex projects from one conversation.
Drop in a GitHub issue and ask for a fix, or bring a rough feature idea to
explore. TaskChef uses the project name, your conversation, and saved repository
mappings to choose the right project and create a separate, ordinary Codex task.
If the destination is unclear, it asks you to choose. One local Codex project
can map to several repositories.

Each task keeps its own conversation and native Codex tools. You can discuss an
approach, ask for a Markdown plan, and then request implementation in that same
task. The TaskChef dashboard gives you one place to find the task again, so you
spend less time selecting projects and searching through chats.

## What working with TaskChef looks like

**Start from an issue.** In your TaskChef dispatcher conversation, paste an
issue link and ask:

```text
Investigate this issue, fix the cause, and run the relevant tests: https://github.com/example/payments/issues/42
```

If the saved repository mapping identifies the payments project, TaskChef
opens a separate Codex task there. You can open that task to see the
investigation and continue the conversation about the fix.

**Start from an idea.** You can also ask:

```text
Explore an idea for clearer refund history in payments. Discuss the approach with me before coding.
```

TaskChef opens a task in the selected project. Discuss the options in that
task. If a written plan would help, ask it to save a Markdown plan, then ask
it to implement the agreed approach in the same task. A plan file is created
when you request one; it is not a required step for every task.

The dashboard groups tasks by **Working**, **Needs input**, **Completed**, and
**Failed** states and shows the latest request and result. Open a task to see
its total reported work duration, token usage, and estimated cost, with the
same figures for each turn in its activity timeline. Duration is reported
wall-clock time spent on turns; cost is an API-equivalent estimate, not a bill.
Token and cost figures can be unavailable when usage cannot be mapped to the
Codex task.
Keep it beside your conversation in Codex's built-in browser. The board gives
you an overview; in the list view, filter by **Needs input** when you want to
find decisions waiting for you. Select a task and choose **Open chat** to reply
in its original Codex conversation. Later outcomes update the
dashboard; TaskChef does not post each result back into the dispatcher chat.
These states normally come from the task's own reports; TaskChef does not
automatically supervise execution.

## Choose models for each role

In the dashboard's **Settings** page, choose a model and reasoning effort for
the **Orchestrator**, **Planner**, **Implementer**, and **Reviewer** roles.
TaskChef saves these preferences in native Codex agent files under
`~/.codex/agents/` and applies them when it dispatches the corresponding work.
Set them once for future tasks; a model choice you make explicitly for a task
takes precedence over its role preference.

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

## More detail

The [advanced guide](docs/advanced-guide.md) covers project indexing, routing,
task reporting, dashboard behavior, recovery, updates, and development. The
[specification](docs/spec.md) and [workflows](docs/workflows.md) describe the
implementation contracts. TaskChef was inspired by
[FirstMate](https://github.com/kunchenguid/firstmate); the
[comparison](docs/firstmate-taskchef-comparison.md) explains their different
approaches.
