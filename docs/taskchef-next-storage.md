# Local data and storage

Codex owns its databases, rollout logs, and chat history. TaskChef reads them
locally without rewriting them.

TaskChef stores settings, queue marks, notifications, routing notes, and caches
under `~/.agents/taskchef/`. Derived usage, pricing, and PR caches live in its
`cache/` directory and contain no chat message bodies. Released TaskChef and
TaskChef Dev share this state.
Credentials stay in the system credential store; there is no plaintext token
fallback. Optional confirmed project aliases live in `delegation-memory.md`.
Preserve a damaged persistent state file and seek support before repair; deleting the whole directory also
removes preferences and marks.

## Storage migration error

Use this procedure only when startup reports that storage needs migration.
The current runtime can read an existing native `~/.agents/taskchef-next/`
store before migration. Two independent native stores, unexpected links, or an
unfinished migration lock stop startup; TaskChef does not choose or merge them.

On macOS or Linux with `lsof` available:

1. Install compatible current packages for every TaskChef client you use.
2. If Codex has an old project rooted at `~/.agents/taskchef`, use Codex's
   project controls to move its root to the intended archive destination or
   remove the obsolete root while preserving its chats. Do not edit Codex databases.
3. Quit Codex and all TaskChef clients. Stop any old dashboard through its
   normal controls. In an external terminal, from the installed package, run:

   ```sh
   node scripts/migrate-taskchef-state.js
   ```

4. Restart Codex and verify settings, queue marks, GitHub connection, notifications,
   and usage. Preserve separate release and Dev installations if both are used.

The command refuses active writers and stops if process inspection fails.
It moves retired dispatcher state intact to `~/.agents/taskchef-old` and moves
an obsolete registry separately under that archive. It moves the native store
to `~/.agents/taskchef` and creates a `taskchef-next` link to that store for
older clients. Existing archives or conflicting native stores are never merged
or overwritten. Codex databases and chat history are outside the migration.
These are storage paths used by the migration tool, not a setup requirement
for new installations.

If a run was interrupted, inspect the layout before retrying. A leftover
`~/.agents/.taskchef-storage-migration` lock requires confirming that no writer
or migration is running, then removing only the empty lock with `rmdir`.
Keep inventories and the archive. If the layout is unclear or process checks
are unsupported, [request support](https://taskchef.dev/support/) rather than
moving or deleting stores manually.

See [troubleshooting](troubleshooting.md) for data errors and
[privacy](https://taskchef.dev/privacy/) for external requests.
