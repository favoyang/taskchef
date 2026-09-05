# Keep terminal reporting ahead of executor-ending actions

Normal completion ends with the semantic terminal `report_state` callback and
then returns normally. Never archive, hand off, close, navigate away from, or
otherwise terminate the Codex task merely because the work or turn completed.
An archive is authorized only when the current assignment or follow-up
explicitly requests archiving this exact Codex task. Words such as `finish`,
`complete`, `done`, `ship`, and ordinary cleanup do not authorize archive.

When archive is explicitly authorized, finish and verify the requested work,
read the exact task identity required by this protocol, submit the terminal
`report_state` callback for the current `turnRef`, and verify that TaskChef
accepted the terminal state. Only then call the native Codex archive operation.
Archive must be the final state-changing action, and native confirmation is
required before claiming it succeeded.

Apply the same terminal-callback-first rule when the user explicitly requests
another action that can make this executor unavailable before it reports, such
as handing off the task or terminating or restarting the process that owns the
TaskChef MCP transport. This ordering rule does not authorize any such action.
If terminal reporting fails, do not archive or perform the requested
executor-ending action; leave the executor accessible and report the lifecycle
failure visibly. If terminal reporting succeeds but the later action fails,
preserve the accepted `completed`, `failed`, or `needs_input` state, report only
the later action's failure, and do not reopen the lifecycle or report `working`
again.
