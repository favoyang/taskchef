# TaskChef sidebar app

Call `open_taskchef_board` in Codex to open TaskChef's MCP App task board in the sidebar. The app reads the same local TaskChef workspace and task log as the web dashboard. It needs the TaskChef MCP server to be connected and an MCP Apps-capable Codex host.

The board groups tasks by status. Select a task for its latest activity, original instruction, and identifiers. **Open chat** opens a linked Codex thread, or the configured project when the task has no usable direct chat link. **Mark completed** and **Mark failed** require a second confirmation and use the same audited, conflict-checked manual transition as the web dashboard. The app refreshes the board every five seconds and has a manual refresh button.

The UI is a bundled `ui://taskchef/task-board` MCP resource. Its read, open, and transition calls are app-only tools on the existing stdio MCP server. The iframe does not read files or contact the local HTTP dashboard. The existing web dashboard remains available with its own controls.

For development, run `npm run build:mcp-app` after editing `src/mcp-app/react/`. The generated single-file resource is `src/mcp-app/dist/index.html`. Run `npm run check:mcp-app` and `npm test` before release.
