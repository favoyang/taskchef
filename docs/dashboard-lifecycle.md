# Dashboard lifecycle

This document defines how the canonical TaskChef dashboard starts, survives MCP
reloads, changes version, and stops. The [specification](spec.md) is normative;
the [README](../README.md) covers user operation, and
[workflows](workflows.md) maps these guarantees to implementation.

## Process model

The canonical dashboard is a loopback-only process scoped to a running Codex
application session. TaskChef MCP activation launches it, but one MCP transport
does not own it. It can therefore survive an individual MCP EOF, signal,
transport close, or plugin reload while another TaskChef MCP transport in the
same Codex session remains active.

TaskChef does not install a daemon, login item, lifecycle hook, or privileged
service. A foreground `taskchef dashboard` remains a separate `standalone`
launcher.

## Start and reuse

Unless `dashboard.autostart` is explicitly `false`, MCP activation runs the same
serialized ensure operation exposed by `ensure_dashboard`. Failure is isolated
from MCP startup and emits a bounded diagnostic.

The canonical session manager requires an explicit nonzero port and normally
binds `127.0.0.1:3210`. Its deterministic lifecycle is:

1. No listener: start the installed dashboard and wait until its health endpoint
   is reachable.
2. Exact current identity for the canonical workspace: reuse it after another
   health probe. A `session` listener first registers the activating Codex PID
   in its in-memory lease.
3. Exact older TaskChef identity for the canonical workspace: request graceful
   shutdown, wait a bounded time for port release, then start the installed
   version within the same ensure operation.
4. Recognized newer TaskChef identity: refuse to downgrade it.
5. Unknown, malformed, different-workspace, or unrelated listener: report a
   clear conflict without sending a control request or process signal.

Health is an exact bounded structured identity containing the service marker,
schema, TaskChef version, dashboard server version, canonical workspace, and
launcher. It is sufficient service recognition in TaskChef's trusted,
single-user localhost model. It is not cryptographic authentication.

Concurrent activations can all observe a free port. Only one detached process
can bind it; other activators inspect and reuse or replace the winner according
to the same rules. A detached child reports readiness over inherited IPC after
the server has bound, completed initialization, and created its first in-memory
lease. A bounded timeout cancels failed or slow startup.

## MCP reload and plugin upgrade

Closing an MCP transport does not close the dashboard. Each exact same-version
reuse registers the activating Codex PID. The dashboard checks these in-memory
leases with non-signalling existence probes and closes after all registered PIDs
are gone for the configured grace period.

Lease state is deliberately not transferred across versions. A replacement
dashboard initially knows only the activating session. A later ensure from
another session registers that session, and can restart the dashboard if the
first lease has already expired. This accepted consequence keeps upgrade
behavior deterministic and avoids durable or cross-version ownership state.

Releases using the former HMAC control protocol do not understand the simple
shutdown request. The first upgrade from such a release reports that the
recognized older listener refused graceful shutdown and leaves it running. Stop
that verified TaskChef listener through its existing lifecycle, then activate
or ensure the newly installed plugin again. TaskChef never adds a generic
process-kill fallback to cross this one-time compatibility boundary.

## Local control boundary

The dashboard listens only on `127.0.0.1` or `::1` and has no browser login.
Its health identity contains no task data, credentials, environment variables,
or process-control details.

The session-registration and graceful-shutdown endpoints are intentionally
small localhost controls. They require the exact listener Host and Origin,
JSON content type, a non-simple `X-TaskChef-Control` header, and an exact bounded
body. Each body includes the exact structured health identity observed by the
caller. The receiver compares it with its own identity before registering a
session or accepting shutdown. On a mismatch the caller probes the listener
again and applies the normal lifecycle rules to the current occupant. These
checks block ordinary cross-site browser requests and DNS rebinding to a
different Host. They are request-shape checks, not authentication or an
ownership protocol.

Future LAN access is outside this model. It must be a separate opt-in feature
with password-backed user authentication and suitable transport protection.

TaskChef sends graceful shutdown only after exact recognized TaskChef health for
the same canonical workspace. It never discovers or kills a port owner, sends
OS signals to an unknown process, uses forceful termination, searches broadly
for processes, or requires elevated permission.

## Dashboard state and presentation

A newly started server creates or deduplicates a verified private workspace
snapshot before monitors or derived-state writers start. Reuse does not create
another startup snapshot. Snapshot failure aborts the new server.

The dashboard watches task history and the project index. It warns when
historical task snapshots reference paths absent from the current index and
offers recovery-oriented read-only commands. It never mutates or restores
configuration.

The detail view distinguishes an active turn whose final usage is pending from
a terminal turn whose usage is being calculated. Available usage keeps both the
token total and API-equivalent USD estimate. The dashboard owns a bounded
background queue for derived usage and stops that queue with the server.

![Pending token usage in the task detail view](images/dashboard-token-pending.jpg)

Reported work is wall-clock elapsed time derived from TaskChef lifecycle
timestamps. It excludes idle gaps and unfinished portions of active turns from
the terminal total. Missing, malformed, reversed, zero-width, or unsupported
timestamp ranges display an unavailable state.

## Lifecycle matrix

| Event | Result |
| --- | --- |
| Activation with no listener | Start installed session dashboard |
| Activation with exact current listener | Register a session lease when supported, verify health again, reuse |
| Activation with recognized older listener | Request graceful shutdown, wait boundedly, start installed version |
| Activation with recognized newer listener | Refuse downgrade and leave it running |
| Activation with unknown or different-workspace listener | Report conflict and leave it untouched |
| One MCP EOF, signal, or reload | Dashboard remains while a registered Codex PID is alive |
| All registered Codex PIDs disappear | Dashboard closes after the grace period |
| `dashboard.autostart: false` | Explicit ensure remains available |
| Foreground `taskchef dashboard` | Standalone process follows foreground CLI lifetime |
