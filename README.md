# TaskChef

A native dashboard for your Codex chats. See running work, questions that need
answers, queued prompts, usage estimates, schedules, and pull request status.
Chats appear regardless of how they were started.

## Install

Install **TaskChef** from the `favoyang-plugins` Codex marketplace. TaskChef uses
a local Node.js MCP server; Node.js 22.18+, 23.2+, or 24+ is required. Open **TaskChef**
from the Codex sidebar. No dispatcher workspace or project indexing is needed.

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

## Directory preparation

See [submission readiness](docs/submission/readiness.md) and
[MagicPath onboarding research](docs/submission/magicpath-onboarding.md).
The full local dashboard needs confirmation of a supported public distribution
route; these drafts do not change its current marketplace installation.
