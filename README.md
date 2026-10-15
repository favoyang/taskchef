# TaskChef

A native dashboard for your Codex chats. See running work, questions that need
answers, queued prompts, usage estimates, schedules, and pull request status.
Chats appear regardless of how they were started.

## Install

TaskChef's marketplace lives in this repository. In Codex, open **Settings →
Plugins → Add → Add a marketplace** and use
`https://github.com/favoyang/taskchef.git`. Leave the Git ref as `main` and Sparse
paths empty. Open **Plugins → Personal**, find **TaskChef** under **TaskChef**,
and install it.

Alternatively, use the Codex CLI:

```sh
codex plugin marketplace add favoyang/taskchef
codex plugin add taskchef@taskchef
```

Restart Codex. Open **…** below Plugins in the left dock, find **TaskChef**, and
pin it to keep the board in the sidebar. TaskChef uses a local Node.js MCP
server and npm. Supported Node.js versions are 22.18+ in the 22 series, or
23.2 and newer. Node.js 24 is recommended for a new installation. Server
dependencies are included in the published package.

### Move from the shared marketplace

If you installed `taskchef@favoyang-plugins`, add the new marketplace and install
`taskchef@taskchef` with the commands above. After it installs successfully,
remove the old plugin with `codex plugin remove taskchef@favoyang-plugins`, then
restart Codex. Keep only one released TaskChef installation enabled. Local
settings, GitHub credentials, and Codex chat history are independent of the
marketplace cache and do not need to be reset. TaskChef Dev stays separate.

Codex databases and logs stay on your computer and remain the source of truth.
TaskChef keeps its own settings, manual Done marks, notification state, and
rebuildable caches. Optional GitHub authentication provides live PR status;
usage prices are API-equivalent estimates, not subscription billing.

## Delegate

From Codex's floating chat, use `$taskchef:delegate Do X in Y project.` The skill finds
native projects and creates an ordinary Codex chat. It asks when the destination
is unclear and returns the chat link. There is no executor skill or separate
task database. Confirmed project aliases can be retained as small routing notes.

## Upgrade from the dispatcher

The dispatcher CLI, five old skills, task tracking tools, and web server are
retired. Existing dispatcher workspaces and task logs are left untouched on
disk; they are no longer live state. Native settings remain in their existing
location. See the [native contract](docs/spec.md) and
[storage notes](docs/taskchef-next-storage.md).

## Development

```sh
npm ci
npm test
npm run check:mcp-app
npm run build:mcp-app
```

Develop on a topic branch and update **TaskChef Dev** first. Keep **TaskChef**
on the published release. After validation, independent review, merge, and a
successful release workflow, update TaskChef from the released package when
the merge publishes a release. Otherwise keep its existing published version.
The Dev copy uses the separate `taskchef-next` plugin ID and **TaskChef Dev**
name; apply that identity only to its local staging package. See
[development packaging](docs/mcp-app.md#development-plugin-identity).

[Native app guide](docs/mcp-app.md) · [GitHub setup](docs/taskchef-next-github.md)

## Feedback

[Report a bug](https://github.com/favoyang/taskchef/issues/new?template=bug_report.yml)
or [request a feature](https://github.com/favoyang/taskchef/issues/new?template=feature_request.yml).
