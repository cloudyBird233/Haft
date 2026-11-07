# Execution recovery

This document describes what the system guarantees when a start fails, a runner
disconnects, the API restarts, a CLI hangs, a cancellation is requested, or a log
message is replayed. The guiding rule is: **never fake a terminal state and never
silently re-run a task.**

## State model

An execution has a coarse `status` and a finer `phase`:

```text
status: running ──────────────► completed | failed | cancelled
phase:  queued → preparing → running → finalizing → completed
                                              ↘ failed
                                              ↘ cancelled
```

- `status` drives task/agent transitions and is the product contract.
- `phase` is additive UI/runner detail. It is updated only while `status =
running`; terminal events set both fields to the same terminal value.
- Terminal transitions are idempotent: `finishExecution` re-reads the row and
  returns early unless it is still `running`.

A task has at most one running execution, and an agent can run at most one
execution at a time. Both checks run under the in-process `execution-start` lock.

## Start failure (dispatch rejected)

When `registry.start` throws — runtime unavailable between the availability check
and dispatch, runner disconnected, accept timeout, missing project mapping, or
executor rejection:

1. `failExecutionStart` runs in one transaction:
   - execution → `failed`, phase `failed`, `endedAt`, `failureReason`;
   - task → its status before this start;
   - agent → its status and `lastActiveAt` before this start.
2. An error log (`Execution failed to start: ...`) is appended.
3. `execution.failed` activity is recorded with `metadata.stage = "start"`.
4. Task/agent/execution updates are emitted.
5. The HTTP endpoint returns `500 RUNTIME_START_FAILED`.

The execution row is kept for audit. The task can be started again. If the
runner accepted the start but missed the 20-second acceptance window, the server
sends a best-effort `execution.cancel` so a timed-out dispatch cannot leave an
unsupervised process running.

## Runner disconnect

1. The socket disconnect marks the runner `offline` and records
   `disconnectedAt`.
2. Running executions stay `running`.
3. A reconnect timer starts for `HAFT_RUNNER_RECONNECT_GRACE_MS` (default 60 s).
4. If the runner reconnects in time, the timer is cleared.
5. If not, every running execution for that runner is failed with
   `RUNNER_DISCONNECTED` (no re-run).

Heartbeat expiry uses the same path: `RunnerRegistryService` checks every 10 s
and marks a runner offline when `lastHeartbeatAt` is older than
`HAFT_RUNNER_HEARTBEAT_TIMEOUT_MS` (default 45 s). Heartbeats are accepted only
while the server still has a live connection entry for that runner.

## Runner reconnect and snapshot reconciliation

On every connect the runner:

1. Sends `runner.register` with its current capabilities.
2. Sends `runner.snapshot` describing every execution it still holds in memory,
   including phase and last log sequence.
3. Replays unacknowledged log entries.

The server compares the snapshot with its `running` rows for that runner:

| Situation                                                          | Action                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Runner reports an execution the server no longer considers running | Send `execution.cancel` (“Execution is not running on the server”)          |
| Server has a running execution absent from the snapshot            | Fail it with `RUNNER_RESTARTED` unless it was created after this connection |
| Both sides have the execution                                      | Send `execution.reconcile`; keep it running                                 |

The “created after this connection” guard (`execution.createdAt >=
runner.connectedAt`) avoids a race: an execution can be created and dispatched
after the runner's snapshot is captured but before the server evaluates it. Such
an execution is kept while dispatch settles rather than being failed as
“restarted”.

The runner currently logs `execution.reconcile` and continues its local session;
the snapshot is the authoritative ownership signal.

## API restart

On `RunnerRegistryService.onModuleInit`:

1. Every runner is marked `offline` with `disconnectedAt = now`. Persisted
   `online` state from the previous process is not trusted.
2. For each runner with at least one running execution, a recovery timer is
   scheduled.
3. Each paired runner reconnects, authenticates with its cached token, registers,
   and sends a snapshot.
4. Reconciliation proceeds as above.

The API never automatically re-dispatches a running execution after restart.
If a runner does not return within the grace window, executions fail with
`RUNNER_DISCONNECTED`; if it returns but no longer owns an execution, the
execution fails with `RUNNER_RESTARTED`.

**Mock executions are different.** The mock runtime is in-process and has no
durable session. An API restart while a mock execution is running leaves a stale
`running` row; startup reconciliation only handles executions with a non-null
`runnerId`. This is a known limitation of the demo. Reset or cancel the stale row
from the UI/API after restart; do not treat it as a successful run.

## Runner restart

The runner keeps active sessions only in memory. A runner process restart loses
them. On reconnect, its snapshot omits those executions, so the server fails them
with `RUNNER_RESTARTED`. The runner does not resume a process tree across
restarts and never starts a replacement execution on its own.

Any real CLI process that survived the runner crash is no longer supervised.
Check the host for orphaned `codex`/`opencode` processes and terminate them
manually before re-running the task. Worktrees from the failed execution remain
for inspection (when `HAFT_RUNNER_KEEP_WORKTREES=1`, the default).

## Cancellation

### Mock

Cancellation stops the in-memory session and marks the execution cancelled in the
same request. The response returns the terminal execution.

### Runner

1. The API sends `execution.cancel`.
2. If the runner is not connected, the API returns `409 RUNNER_OFFLINE` and the
   execution stays `running`.
3. The runner logs the request and terminates the process tree: `SIGTERM` to
   the process group on POSIX, `taskkill /T /F` on Windows. A force-kill timer
   after 5 s and a 15 s terminal fallback ensure a terminal event.
4. The API polls the execution row for up to
   `HAFT_RUNNER_CANCEL_TIMEOUT_MS` (default 30 s).
5. On `execution.cancelled`, the server marks execution/task cancelled, agent
   idle, appends a warning log, records an activity, and emits events.
6. If no terminal event arrives, the API returns `409 RUNNER_CANCEL_TIMEOUT` and
   the execution remains `running`. The process may still be alive.

The runner only reports `execution.cancelled` after the process exited or was
force-terminated (or after the terminal fallback). The HTTP layer never assumes
success from the cancel request alone.

### Timeout

A CLI exceeding `HAFT_RUNNER_CLI_TIMEOUT_MS` (or a shorter dispatch timeout) is
force-killed. The runner emits `execution.failed` with reason
`CLI_TIMEOUT: ...` and the exit code/signal if available. A 15 s fallback ensures
a terminal event even if the process refuses to die, though the OS process may
still require manual cleanup.

## Logs, duplicates, and replay

- Runner log entries carry a runner-local `sequence` and a stable `eventId`.
- The server assigns its own `seq` per execution, so server-generated messages
  and CLI output share one ordered stream.
- `(executionId, eventId)` and `(executionId, runnerSeq)` are unique; retries
  are ignored.
- Inbound envelopes are deduplicated by `messageId` for 10 minutes.
- After reconnect, the runner replays pending entries. The server acks the
  highest applied runner sequence, and the runner drops acknowledged entries.
- The pending buffer is bounded at 10,000 entries per session, and replay sends
  at most 200 entries per message. A very long disconnect can lose the older
  tail. The execution log is durable once persisted on the server.

## Recovery reason catalogue

| Reason                   | Meaning                                             |
| ------------------------ | --------------------------------------------------- |
| `RUNNER_DISCONNECTED`    | Runner did not reconnect within the grace window    |
| `RUNNER_RESTARTED`       | Runner reconnected but no longer owns the execution |
| `CLI_TIMEOUT`            | CLI exceeded its execution timeout                  |
| `CLI_EXIT_CODE`          | CLI exited non-zero                                 |
| `PROJECT_NOT_MAPPED`     | Project id not configured on the runner             |
| `PROJECT_PATH_MISSING`   | Configured repository path does not exist           |
| `PROJECT_NOT_GIT_ROOT`   | Path is not a Git repository root                   |
| `PROJECT_HAS_NO_COMMITS` | No commit to branch from                            |
| `BRANCH_EXISTS`          | Execution branch already exists                     |
| `WORKTREE_EXISTS`        | Worktree path already exists                        |
| `CLI_NOT_INSTALLED`      | Executable not found                                |
| `CLI_NOT_AUTHENTICATED`  | CLI has no credentials                              |
| `CLI_SPAWN_FAILED`       | Process could not be spawned                        |
| `RUNNER_BUSY`            | Concurrency limit reached                           |
| `RUNTIME_NOT_ENABLED`    | Runtime not enabled in the current runner mode      |

Failure reasons are stored on the execution, written as an error log if absent,
and included in the `execution.failed` activity metadata.

## Manual recovery playbook

1. **Inspect the execution** with `GET /api/executions/:id` and
   `GET /api/executions/:id/logs`; note `status`, `phase`, `runnerId`,
   `failureReason`, and the last log lines.
2. **Check the runner** with `GET /api/runners` and its health endpoint. If it is
   online, a reconnect will reconcile automatically.
3. **Wait for the grace window** after a disconnect. Do not cancel immediately;
   a reconnect may legitimately resume ownership.
4. **If the execution is stale** (runner restarted, process gone), let
   reconciliation fail it. If it remains `running` with no runner, use the UI
   cancel action once the runner is back, or reset the task through the test API
   only in a test environment.
5. **Clean up worktrees/branches** after reviewing the diff:
   `git -C <repo> worktree remove --force <path>`, `git worktree prune`, then
   delete `haft/<executionId>` if it is no longer needed.
6. **Re-run explicitly** only after the failure is understood. The system will
   not do it for you.

## Guarantees and non-guarantees

Guaranteed:

- No automatic re-run after API or runner restart.
- No terminal success from a cancel request alone.
- Logs persisted on the server survive reconnects and restarts.
- Runner events are accepted only from the runner that owns the execution.
- A failed start restores the task and agent to their pre-start state.

Not guaranteed:

- Survival of an in-flight CLI across a runner crash.
- Recovery of in-memory mock executions across an API restart.
- Re-delivery of log entries older than the runner's bounded pending buffer.
- OS-level isolation from a malicious CLI; a worktree is not a sandbox.
- Automatic cleanup of kept worktrees or branches.
