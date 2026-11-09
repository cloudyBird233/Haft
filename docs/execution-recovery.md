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
2. Reports executions found in the recovery journal from a previous runner
   process **before** the snapshot: replays their spooled logs and sends
   `execution.failed` with `RUNNER_INTERRUPTED: ...`.
3. Sends `runner.snapshot` describing only genuine in-memory sessions, including
   phase and last log sequence.
4. Replays unacknowledged log entries from both the durable spool and the
   in-memory pending buffer, deduplicated by runner sequence.

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

## Runner restart and durable recovery

The runner keeps live sessions in memory, but every in-flight real execution also
has durable evidence on disk. The default root is
`HAFT_RUNNER_RECOVERY_ROOT` (default `~/.haft/recovery/<runnerId>`):

```text
<recoveryRoot>/
  <executionId>.json          atomic journal
  logs/<executionId>.ndjson   durable append-only log spool
```

### Execution journal

The journal is written **before** the CLI is spawned and updated while the
execution runs. Each record contains:

| Field              | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `executionId`      | Server execution id                                   |
| `runtime`          | `codex` or `opencode`                                 |
| `projectId`        | Project mapping id                                    |
| `pid`              | CLI process id once spawned                           |
| `processStartTime` | Platform-native start marker used to detect PID reuse |
| `processGroupId`   | POSIX process group (Windows: process id)             |
| `worktreePath`     | Isolated worktree path                                |
| `branchName`       | `haft/<executionId>`                                  |
| `baseCommit`       | Repository `HEAD` at worktree creation                |
| `phase`            | Last execution phase                                  |
| `status`           | `active`, `completed`, `failed`, `cancelled`, `interrupted` |
| `lastSequence`     | Last runner log sequence                              |
| `startedAt` / `updatedAt` / `finishedAt` | Timestamps                               |

Writes go to a same-directory temporary file and are atomically renamed over the
target. A crash leaves either the previous complete record or the new complete
record, never a half-written JSON document. Corrupt files are quarantined.
Non-critical sequence/phase updates are coalesced by 100 ms; phase transitions,
PID identity, and terminal status are written immediately.

### Durable log spool

Every log entry is appended to `logs/<executionId>.ndjson` **before** it is sent
to the server; the runner awaits the durable append and serializes logs/terminal
events per execution through an in-order queue. The server acknowledges the
highest persisted runner sequence with `execution.log.ack`; acknowledged entries
are removed by an atomic rewrite. The spool:

- deduplicates by runner `sequence`;
- tolerates a partial final line left by a crash;
- survives runner restarts and reconnects;
- is bounded at 10,000 entries / 8 MiB per execution, keeping the newest tail;
- replays at most 200 entries per message.

### Startup scan

`ExecutionRecovery.scan()` runs once at runner startup, before the socket
connects. For each `active` journal it verifies the recorded process identity:

1. Inspect the PID (Windows `Win32_Process`, Linux `/proc`, otherwise `ps`).
2. Check whether the recorded worktree path still exists and include that in the
   recovery summary. The check is read-only: recovery never deletes or repairs
   the path.
3. If no process exists, report `RUNNER_INTERRUPTED` and preserve the worktree and
   logs.
4. If the live start marker differs from `processStartTime`, the PID was reused;
   leave it untouched and report `RUNNER_INTERRUPTED` with the PID-reuse detail.
5. If the command line / process group does not belong to the execution, leave it
   untouched and report an ownership mismatch.
6. Only when identity and ownership match, terminate the whole process tree
   (`taskkill /T /F` on Windows, process-group signal on POSIX) and wait for the
   actual exit. If it is still alive, report it as not confirmed terminated.
7. Mark the journal `interrupted`, keep the spool, prune terminal journals after
   seven days.

The runner **never** starts a replacement execution. Recovery reports are sent
after registration and before the snapshot, so the server marks the execution
failed with `RUNNER_INTERRUPTED` instead of interpreting it as still running.
The snapshot then contains only sessions that genuinely exist in the current
process.

### Shutdown

`RunnerExecutor.shutdown()` returns
`{ clean, remainingExecutionIds, forced }`. It cancels every session, waits for
real process termination up to `HAFT_RUNNER_SHUTDOWN_GRACE_MS` (default 10 s),
escalates to a force tree kill, waits again, and reports any sessions that remain.
`RunnerClient.stop()` awaits this result, drains the per-execution protocol queue
so the last durable log and terminal event are sent, flushes the spool and
journal, logs `runner.shutdown_incomplete` when cleanup cannot be confirmed, and
only then disconnects. It no longer assumes a fixed 150 ms sleep equals
termination.

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
- Entries are appended to the durable NDJSON spool before being sent. The server
  acks the highest applied runner sequence, and the runner removes acknowledged
  entries from both the spool and the in-memory buffer.
- After reconnect, the runner merges spooled and in-memory entries, deduplicates
  by sequence, and replays at most 200 per message.
- The spool holds at most 10,000 entries / 8 MiB per execution. A very long
  disconnect can lose the older tail. Logs already persisted on the server are
  durable; a server-side unique `(executionId, runnerSeq)` constraint makes the
  replay idempotent.

## Recovery reason catalogue

| Reason                   | Meaning                                             |
| ------------------------ | --------------------------------------------------- |
| `RUNNER_DISCONNECTED`    | Runner did not reconnect within the grace window    |
| `RUNNER_RESTARTED`       | Runner reconnected but no longer owns the execution |
| `RUNNER_INTERRUPTED`     | Startup journal found a previous in-flight execution |
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

1. **Inspect the execution** with `GET /api/executions/:id`,
   `GET /api/executions/:id/logs`, and `GET /api/executions/:id/diff`; note
   `status`, `phase`, `runnerId`, `failureReason`, the last log lines, and any
   persisted Git evidence.
2. **Check the runner** with `GET /api/runners` and its health endpoint. If it is
   online, a reconnect will reconcile automatically.
3. **Inspect the recovery journal** under `HAFT_RUNNER_RECOVERY_ROOT` after a
   runner crash. `*.json` describes the interrupted execution and the process
   identity; `logs/*.ndjson` preserves its last log tail. Do not delete either
   before reviewing the worktree.
4. **Wait for the grace window** after a disconnect. Do not cancel immediately;
   a reconnect may legitimately resume ownership.
5. **If the execution is stale** (runner restarted, process gone), let
   reconciliation fail it. If it remains `running` with no runner, use the UI
   cancel action once the runner is back, or reset the task through the test API
   only in a test environment.
6. **Clean up worktrees/branches** after reviewing the diff:
   `git -C <repo> worktree remove --force <path>`, `git worktree prune`, then
   delete `haft/<executionId>` if it is no longer needed.
7. **Re-run explicitly** only after the failure is understood. The system will
   not do it for you.

## Guarantees and non-guarantees

Guaranteed:

- No automatic re-run after API or runner restart.
- No terminal success from a cancel request alone.
- An in-flight execution leaves an atomic journal and a durable log spool.
- Startup recovery reports the interruption to the server before the snapshot.
- Orphan CLI processes are terminated only after PID start-time and ownership
  verification; reused PIDs and unrelated processes are left untouched.
- Worktrees and logs are preserved for inspection, never deleted by recovery.
- Shutdown waits for actual process termination and reports incomplete cleanup.
- Logs persisted on the server survive reconnects and restarts.
- Runner events are accepted only from the runner that owns the execution.
- A failed start restores the task and agent to their pre-start state.

Not guaranteed:

- Survival of an in-flight CLI across a runner crash (it is identified and
  terminated, not resumed).
- Recovery of in-memory mock executions across an API restart.
- Re-delivery of log entries older than the spool cap or the bounded pending
  buffer.
- Cleanup of an orphan when the OS denies inspection/termination; the runner
  reports that it could not confirm termination.
- OS-level isolation from a malicious CLI; a worktree is not a sandbox.
- Automatic cleanup of kept worktrees or branches.
