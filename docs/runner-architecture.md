# Runner architecture

The Haft Agent Runner is a separate Node.js process that owns local execution:
CLI child processes, Git worktrees, cancellation, timeouts, and local capability
probing. The API owns business state and never spawns a CLI. This split keeps
credentials and process handles away from the HTTP surface and makes the
server/runner boundary explicit.

See [runner-protocol.md](runner-protocol.md) for the wire format,
[runner-setup.md](runner-setup.md) for configuration, and
[execution-recovery.md](execution-recovery.md) for failure handling.

## Topology

```text
┌───────────────────────────── API process ─────────────────────────────┐
│ ExecutionsService                                                     │
│   └─ RuntimeRegistryService                                           │
│        ├─ MockRuntimeService            (in-process)                  │
│        ├─ RunnerRuntimeService(codex) ─┐                              │
│        └─ RunnerRuntimeService(opencode)│                             │
│                                         ▼                             │
│                              RunnerRegistryService                    │
│                                identity / dispatch / recovery         │
│                                         │                             │
│                              RunnerGateway  /runner (Socket.IO)       │
│                              EventsGateway  /events  (browser)        │
│                                         │                             │
│                              Prisma → SQLite (business state)         │
└─────────────────────────────────────────┼─────────────────────────────┘
                                          │ WebSocket, protocol v1
┌─────────────────────────────────────────▼─────────────────────────────┐
│ Runner process                                                        │
│  RunnerClient        handshake, register, heartbeat, snapshot, send   │
│  TokenStore          local token cache (0600 where supported)         │
│  FakeExecutor        deterministic six-step simulation                │
│  RealExecutor        worktree → CLI → parse → finalize                │
│  CliProbe            version + authentication checks                  │
│  GitWorktreeManager  prepare / collect / cleanup                      │
│  ProcessUtils        argv spawn, process-tree termination, env strip   │
│  health server       optional /health and /ready on 127.0.0.1         │
└─────────────────────────────────────────┬─────────────────────────────┘
                                          │ spawn, shell: false
                              ┌───────────▼────────────┐
                              │ codex / opencode / git │
                              │ one worktree per run   │
                              └────────────────────────┘
```

The runner does not connect to the database, does not expose an HTTP command
surface, and does not accept arbitrary executable paths from task text. The
project allowlist and CLI path are runner configuration.

## Server responsibilities

### `RunnerGateway`

- Owns the `/runner` Socket.IO namespace.
- Authenticates the handshake in Socket.IO middleware before any application
  message is accepted.
- Rejects malformed envelopes and messages with `runner.error`.
- Replaces a previous connection for the same `runnerId`.
- Processes messages from one runner strictly in arrival order.
- Moves validated messages to `RunnerRegistryService`; it contains no business
  rules.

### `RunnerRegistryService`

- Pairs runners with bootstrap tokens and verifies cached tokens with a
  constant-time hash comparison.
- Persists identity, capabilities, status, heartbeat, connection timestamps, and
  protocol version.
- Dispatches `execution.start` and waits for `execution.accepted` (20 s).
- Dispatches `execution.cancel`, `execution.reconcile`, and `execution.log.ack`.
- Applies inbound phase/log/progress/terminal events through the same
  `RuntimeEvent` union used by the mock runtime.
- Enforces ownership: a runner may only report events for executions whose
  `runnerId` matches.
- Deduplicates messages by `messageId` and logs by `(executionId, eventId)` /
  `(executionId, runnerSeq)`.
- Schedules the reconnect grace timer and reconciles snapshots.

### `RunnerRuntimeService`

- A thin `AgentRuntime` adapter for one runtime (`codex` or `opencode`).
- Builds a bounded prompt from the task title/description and dispatch context.
- Calls `RunnerRegistryService.dispatchStart`.
- Does not parse CLI output, touch files, or know about worktrees.
- Events for both runner runtimes are subscribed once by
  `RuntimeRegistryService`, so a message cannot be delivered twice.

### `RuntimeRegistryService`

- The only place that selects a runtime implementation.
- Reports availability for `mock`, `codex`, and `opencode`.
- Exposes precise `reasonCode` values (`RUNNER_OFFLINE`, `CLI_NOT_INSTALLED`,
  `CLI_NOT_AUTHENTICATED`, `PROJECT_NOT_MAPPED`, ...).
- `ExecutionsService` never branches on a runtime name.

## Runner responsibilities

### `RunnerClient`

- Probes capabilities at startup.
- Reads a cached token; if absent, uses the bootstrap token from configuration.
- Maintains the Socket.IO connection, heartbeat, and reconnect loop.
- Registers capabilities after every connect and sends a local snapshot.
- Replays unacknowledged logs after reconnect.
- Dispatches server messages to the executor and sends executor callbacks back.
- Re-pairs once with the bootstrap token if the cached token is rejected.

### Executors

Both executors implement:

```ts
interface RunnerExecutor {
  start(payload: ExecutionStartMessage['payload']): void;
  cancel(executionId: string, reason?: string): void;
  acknowledge(executionId: string, throughSeq: number): void;
  pendingLogs(executionId: string): RunnerLogEntry[];
  pendingLogCount(): number;
  snapshot(): RunnerSnapshotExecution[];
  activeExecutionIds(): string[];
  shutdown(reason?: string): void;
}
```

`FakeExecutor` is deterministic and never touches a process or repository.
`RealExecutor` implements the full pipeline:

1. Verify the runtime is enabled and the concurrency limit is free.
2. Emit `preparing`.
3. Resolve the project path from `HAFT_RUNNER_PROJECTS`.
4. Create a worktree and branch.
5. Resolve the executable (including Windows `.cmd` shim resolution).
6. Build argv, spawn with `shell: false`, write the prompt to stdin.
7. Emit `running`, stream parsed logs and progress.
8. On exit, collect Git evidence and emit `finalizing` → terminal event.
9. Clean up the worktree if `HAFT_RUNNER_KEEP_WORKTREES=0`.

### Capability probe

Real mode probes each enabled runtime once:

| Runtime  | Version check | Auth check                                              |
| -------- | ------------- | ------------------------------------------------------- |
| codex    | `--version`   | `codex login status` (`logged in`, not `not logged in`) |
| opencode | `--version`   | `opencode auth list` (stored credential), else `models` |

The probe result is sent at registration and stored in
`Runner.capabilitiesJson`. It is not re-probed on every execution; restart the
runner after changing authentication or installing a CLI.

### Token store

The issued token is cached at `HAFT_RUNNER_TOKEN_FILE` (default
`~/.haft/runner-<runnerId>.json`) with a `0600` mode request. The file is only
read by the runner process. On a rejected token, the runner clears the cache and
retries once with the bootstrap token. The token is never written to logs and is
never inherited by a CLI child process.

## Dispatch sequence

```text
Browser            API                                  Runner
  │ POST start      │                                      │
  ├────────────────►│ validate task/agent                  │
  │                 │ availability → runnerId              │
  │                 │ create Execution(queued, runnerId)   │
  │                 │ execution.start ────────────────────►│
  │                 │                                      │ execution.accepted
  │                 │◄─────────────────────────────────────┤
  │ 201 Execution   │                                      │ preparing → worktree
  │◄────────────────┤                                      │
  │                 │◄──── execution.phase/log/progress ───┤
  │                 │ persist, emit /events                │
  │                 │◄──── execution.completed ────────────┤
  │                 │ transaction: execution/task/agent    │
  │                 │ emit /events                         │
  │◄────────────────┤                                      │
```

If the runner does not accept within 20 seconds, dispatch fails and the server
sends a best-effort cancel for that execution. The API rolls back the start,
marks the execution `failed`, restores task/agent state, and returns
`RUNTIME_START_FAILED`.

## Concurrency and backpressure

- `HAFT_RUNNER_MAX_CONCURRENT` (1–32, default 1) is advertised to the server and
  enforced again inside the executor.
- The server checks the runner's persisted `maxConcurrentExecutions` before
  dispatch.
- The existing agent/task locks already prevent one agent or one task from
  running twice; the runner limit is an additional host-level guard.
- Each session buffers up to 10,000 unacknowledged log entries. The server acks
  the highest persisted `runnerSeq`; `execution.log.ack` lets the runner drop
  those entries. After reconnect, the runner replays up to 200 entries per
  message, and the server deduplicates by `eventId` and `runnerSeq`.
- A slow or disconnected server therefore does not silently lose the recent log
  tail, but the buffer is bounded: very long disconnections can drop older
  unacknowledged entries.

## Isolation and trust boundaries

- **Git worktree, not OS sandbox.** Each execution runs in
  `<worktreeRoot>/<projectId>/<executionId>` on branch `haft/<executionId>`.
  The main checkout is never the CLI working directory. The runner refuses
  non-Git roots, missing commits, existing branches, and existing worktree
  paths. It never commits, pushes, merges, or fetches.
- **No shell.** CLI and Git calls use `spawn(binary, args, { shell: false })`.
  Task prompts go to stdin, so shell metacharacters in task text cannot become
  commands.
- **No server secret in the CLI.** `buildCliEnvironment` strips every `HAFT_*`
  and `E2E_RUNNER_*` variable before spawning.
- **No arbitrary executable from the web.** CLI paths come only from runner
  configuration (`HAFT_CODEX_BIN`, `HAFT_OPENCODE_BIN`). The API cannot pass a
  binary path or arbitrary CLI flag.
- **Codex sandbox.** Codex always receives `--sandbox workspace-write` (or the
  stricter `read-only` if requested by a trusted dispatch option). There is no
  bypass flag.
- **OpenCode approval.** `--auto` is only added when the runner host explicitly
  sets `HAFT_RUNNER_ALLOW_AUTO_APPROVE=1`. The default is interactive-safe.
- **Runner management.** `GET /api/runners` is loopback-only unless an admin
  token is configured. Pairing uses the bootstrap token; the server stores only
  a token hash.
- **Local-only default.** The API and health server bind to loopback by default.
  A remote runner must use an explicitly reachable server URL and network
  controls; this demo does not provide TLS or a public runner gateway.

## Failure domains

| Failure                 | Owner  | Behavior                                                         |
| ----------------------- | ------ | ---------------------------------------------------------------- |
| Runner process exits    | server | Grace window, then `RUNNER_DISCONNECTED` failure; no re-run      |
| Runner reconnect        | both   | Snapshot reconciliation; missing executions fail, shared resume  |
| API process restarts    | server | On runner reconnect, reconcile running rows; no automatic re-run |
| CLI exits non-zero      | runner | `execution.failed` with exit code and parsed error               |
| CLI exceeds timeout     | runner | Force-kill process tree, `CLI_TIMEOUT` failure                   |
| Cancel requested        | both   | Runner confirms after process-tree termination                   |
| Worktree creation fails | runner | `execution.failed` before any CLI spawn                          |
| Log socket drops        | runner | Bounded pending buffer; replay after reconnect                   |
| Token rejected          | runner | Clear cached token, retry once with bootstrap token              |

## Adding a new CLI runtime

1. Add the runtime literal to `RUNNER_RUNTIMES`/`AGENT_RUNTIMES` and labels.
2. Extend `RunnerRuntimeCapability` handling and the probe.
3. Add an argv builder that keeps the prompt on stdin and never enables a
   sandbox bypass by default.
4. Add output parsing; ignore unknown events rather than persisting raw JSON.
5. Extend `RealExecutor` only if the runtime needs different lifecycle behavior;
   otherwise it can reuse the existing worktree/process pipeline.
6. Add availability tests, argv tests, parser tests, and an opt-in real E2E case.
