# Runner protocol v1

The runner protocol is a strict, versioned, message-oriented protocol over the
Socket.IO `/runner` namespace. It runs on the same HTTP server as the API but is
a separate namespace from the browser `/events` stream.

All schemas live in
[`packages/contracts/src/runner-protocol.ts`](../packages/contracts/src/runner-protocol.ts)
and are used by both sides. Unknown fields, wrong versions, and unknown message
types are rejected.

## Transport and handshake

- Transport: Socket.IO over WebSocket (`transports: ['websocket']`).
- Namespace: `/runner`.
- Handshake auth: `runnerId`, `computerId`, optional `protocolVersion`, and
  either `token` or `bootstrapToken`.
- The Socket.IO middleware authenticates before any application message is
  accepted. A failed handshake produces a connection error with
  `{ code, message }`.
- Only one live connection per `runnerId`; a new connection replaces the old
  one with a fatal `RUNNER_REPLACED` error.

```json
{
  "runnerId": "runner_local",
  "computerId": "computer_local",
  "protocolVersion": 1,
  "bootstrapToken": "one-time-pairing-secret"
}
```

The server verifies that the computer exists, the protocol version matches, and
the token is valid. A bootstrap handshake creates/rotates the `Runner` row,
issues a new random token, and returns it in `runner.welcome.issuedToken`. The
runner stores that token in its local token file. Subsequent handshakes use
`token` and receive `issuedToken: null`.

The bootstrap token is a one-time pairing secret in the sense that the issued
runner token is the normal credential; the server does not invalidate the
bootstrap token after the first use. Protect it like a deployment secret.

## Envelope

Every application message is a strict envelope:

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "runnerId": "runner_local",
  "type": "execution.start",
  "sentAt": "2026-11-07T12:00:00.000Z",
  "payload": {}
}
```

- `protocolVersion` must be `1`.
- `messageId` is a stable unique id used for idempotency. The server remembers
  seen ids for 10 minutes.
- `runnerId` must match the authenticated connection.
- `sentAt` is an ISO-8601 datetime.
- `payload` is validated per message type.

## Server → runner

| Type                  | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `runner.welcome`      | Connection accepted; token/timeouts issued   |
| `runner.error`        | Protocol or application error                |
| `execution.start`     | Start a codex/opencode execution             |
| `execution.cancel`    | Request process-tree cancellation            |
| `execution.reconcile` | Ask the runner to reconcile given executions |
| `execution.log.ack`   | Acknowledge persisted runner log sequence    |

### `runner.welcome`

```json
{
  "issuedToken": "64-hex-character-token-or-null",
  "serverTime": "2026-11-07T12:00:00.000Z",
  "heartbeatIntervalMs": 10000,
  "reconnectGraceMs": 60000,
  "maxConcurrentExecutions": 1
}
```

`issuedToken` is present only after a bootstrap pairing. The runner updates its
heartbeat interval from this message.

### `execution.start`

```json
{
  "executionId": "cm...",
  "runtime": "codex",
  "taskId": "cm...",
  "taskTitle": "Implement the change",
  "taskDescription": "Details from the task brief",
  "projectId": "project_demo",
  "prompt": "You are Developer...",
  "options": {
    "model": null,
    "agent": null,
    "variant": null,
    "sandbox": null,
    "timeoutMs": null
  }
}
```

The server sends an empty or partial `options` object today; the schema allows
`model`, `agent`, `variant`, `sandbox`, and `timeoutMs` for future per-execution
configuration. Runner configuration supplies the default CLI path and model.

`prompt` is always written to the CLI's stdin. It is not placed in argv.

The runner must answer with `execution.accepted` before the server's 20-second
dispatch timeout. It may accept and then immediately fail (for example
`PROJECT_NOT_MAPPED`); the accepted message only acknowledges receipt.

### `execution.cancel`

```json
{
  "executionId": "cm...",
  "reason": "Cancelled by operator"
}
```

The runner terminates the process tree (`SIGTERM` to the process group on POSIX,
`taskkill /T /F` on Windows), with a 5-second force-kill timer and a 15-second
terminal fallback. It must eventually emit `execution.cancelled` (or a terminal
event produced by the process exit) so the server can complete the cancellation.
The server does not mark a runner execution cancelled on the strength of this
message alone.

### `execution.reconcile`

```json
{
  "reason": "reconnect",
  "executionIds": ["cm..."]
}
```

Sent after registration or snapshot analysis for executions the server and
runner both believe are running. Today the runner logs the request; the
authoritative reconciliation signal is the `runner.snapshot` the runner sends on
connect.

### `execution.log.ack`

```json
{
  "executionId": "cm...",
  "throughSeq": 17
}
```

Acknowledges that the server persisted runner log sequences up to
`throughSeq`. The runner drops those entries from its bounded pending buffer.

## Runner → server

| Type                  | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `runner.register`     | Identity, version, platform, capabilities    |
| `runner.heartbeat`    | Liveness and active execution ids            |
| `execution.accepted`  | Start acknowledgement                        |
| `execution.phase`     | `queued`/`preparing`/`running`/`finalizing`  |
| `execution.log`       | One or more structured log entries           |
| `execution.progress`  | Progress 0–100 and determinate/indeterminate |
| `execution.completed` | Successful terminal event                    |
| `execution.failed`    | Failure terminal event                       |
| `execution.cancelled` | Cancellation confirmed                       |
| `runner.snapshot`     | Local active executions and pending logs     |

### `runner.register`

Sent on every connect, after `runner.welcome`.

```json
{
  "computerId": "computer_local",
  "runnerVersion": "0.1.0",
  "platform": "win32",
  "architecture": "x64",
  "capabilities": {
    "runtimes": [
      {
        "runtime": "codex",
        "installed": true,
        "version": "codex-cli 0.x",
        "authenticated": true,
        "message": null
      }
    ],
    "projectIds": ["project_demo"],
    "maxConcurrentExecutions": 1
  }
}
```

### `runner.heartbeat`

```json
{
  "activeExecutionIds": ["cm..."],
  "status": "busy",
  "uptimeMs": 123456
}
```

Heartbeats update `Runner.lastHeartbeatAt` and status. Missing heartbeats for the
configured timeout (default 45 s) make the server mark the runner offline and
start the reconnect grace timer.

### `execution.accepted`

```json
{ "executionId": "cm...", "acceptedAt": "2026-11-07T12:00:00.000Z" }
```

### `execution.phase`

```json
{ "executionId": "cm...", "phase": "running", "message": "CLI process started" }
```

Terminal phases are also represented by the terminal messages below. The server
accepts any valid phase value and stores it on the execution while it is
`running`.

### `execution.log`

```json
{
  "executionId": "cm...",
  "entries": [
    {
      "sequence": 17,
      "eventId": "uuid",
      "stream": "stdout",
      "level": "info",
      "message": "Implemented the endpoint.",
      "timestamp": "2026-11-07T12:00:01.000Z"
    }
  ]
}
```

- `sequence` is the runner-local monotonic sequence (`runnerSeq`).
- `eventId` is a stable id for that line; retries reuse it.
- `stream` is `stdout`, `stderr`, or `system`.
- Messages are capped at 8,000 characters.
- The server persists each entry with its own global-per-execution `seq`,
  deduplicates on `(executionId, eventId)` and `(executionId, runnerSeq)`, then
  acks the highest applied runner sequence.

### `execution.progress`

```json
{
  "executionId": "cm...",
  "progress": 50,
  "step": 3,
  "progressMode": "determinate"
}
```

Progress is clamped to 0–100. Runner executions normally start
`indeterminate` at 5%, switch to `indeterminate` at 50% when output begins, and
finish `determinate` at 100%.

### Terminal messages

```json
{
  "executionId": "cm...",
  "exitCode": 0,
  "summary": "Implemented the endpoint.",
  "git": {
    "branchName": "haft/cm...",
    "baseCommit": "abc...",
    "headCommit": "def...",
    "changedFiles": 2,
    "diffStat": "2 files changed, 20 insertions(+)",
    "gitStatus": " M src/feature.ts\n?? test/feature.spec.ts"
  }
}
```

`execution.completed` uses the shape above. `execution.failed` adds
`reason` (required, max 2,000 chars). `execution.cancelled` adds an optional
`reason`. `git` may be `null` if no worktree existed or collection failed.

### `runner.snapshot`

Sent on every connect after registration.

```json
{
  "executions": [
    {
      "executionId": "cm...",
      "phase": "running",
      "lastSeq": 17,
      "startedAt": "2026-11-07T12:00:00.000Z",
      "runtime": "codex"
    }
  ],
  "pendingLogCount": 3
}
```

The server compares this snapshot with its `running` rows for the runner:

- Execution reported by the runner but not `running` on the server → the server
  sends `execution.cancel` with reason `Execution is not running on the server`.
- Execution `running` on the server but absent from the snapshot → failed with
  `RUNNER_RESTARTED`, unless it was created at/after the current connection
  (`createdAt >= connectedAt`), in which case it is kept while dispatch settles.
- Execution present on both sides → server sends `execution.reconcile`.

## Delivery semantics and ordering

- **At-least-once**: both sides may retry. The server deduplicates inbound
  `messageId`s for 10 minutes; log entries are deduplicated by database unique
  constraints.
- **Per-runner ordering**: `RunnerGateway` chains message handling per runner, so
  terminal events cannot overtake their final logs.
- **Two sequence spaces**: `runnerSeq` is runner-local and used for log
  idempotency/ack; `seq` is server-assigned and is the ordered log stream the UI
  reads.
- **Bounded replay**: the runner keeps up to 10,000 pending log entries per
  session and replays up to 200 per message after reconnect. A long disconnect
  can drop older unacknowledged entries.
- **No automatic re-run**: a lost execution is marked failed. Re-running is an
  explicit operator action after review.

## Error handling

`runner.error` payload:

```json
{ "code": "RUNNER_MESSAGE_INVALID", "message": "...", "fatal": false }
```

Fatal errors close the connection. Common codes:

| Code                       | Meaning                                      |
| -------------------------- | -------------------------------------------- |
| `RUNNER_AUTH_FAILED`       | Invalid/missing token or bootstrap token     |
| `RUNNER_HANDSHAKE_INVALID` | Handshake schema failure                     |
| `RUNNER_PROTOCOL_MISMATCH` | Protocol version other than 1                |
| `RUNNER_NOT_FOUND`         | Runner not paired / row removed              |
| `COMPUTER_NOT_FOUND`       | Computer id is not registered                |
| `RUNNER_REPLACED`          | A newer connection replaced this one (fatal) |
| `RUNNER_MESSAGE_INVALID`   | Envelope or payload failed schema validation |
| `RUNNER_MESSAGE_FAILED`    | Message could not be applied                 |

Application-level failures during execution are reported with
`execution.failed` and a human-readable `reason` such as
`PROJECT_NOT_MAPPED`, `CLI_NOT_INSTALLED`, `CLI_NOT_AUTHENTICATED`,
`CLI_EXIT_CODE`, `CLI_TIMEOUT`, or `RUNNER_BUSY`.

## Versioning

The protocol is deliberately version-locked: `protocolVersion` is the literal
`1`. A future incompatible version must use a new handshake/version and a new
message union. Adding optional payload fields is acceptable only if both sides
continue to use strict schemas with documented optional fields; otherwise bump
the version. The server stores `Runner.protocolVersion` and rejects mismatches
with `RUNNER_PROTOCOL_MISMATCH`.
