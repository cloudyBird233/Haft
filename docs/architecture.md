# Architecture

Raft Lite is a single-machine, single-workspace demo of an AI agent collaboration
platform. It is deliberately small enough to run on a laptop, but every screen is
backed by a real NestJS API, a real SQLite database, and real execution
infrastructure: a deterministic in-process Mock Runtime plus an independent
Agent Runner that can drive Codex or OpenCode inside isolated Git worktrees.
There is no mocked frontend state and no static fixture masquerading as a
product.

## System context

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Browser                                                                │
│  React 19 + Vite + Tailwind + Radix + TanStack Query                   │
│  Routes: /  /agents  /tasks  /executions/:id                           │
└───────────────┬─────────────────────────────────┬──────────────────────┘
                │ HTTP /api/*                     │ Socket.IO /events
                │ (Vite proxy in dev)             │
┌───────────────▼─────────────────────────────────▼──────────────────────┐
│ NestJS API (:3001 dev, :3101 e2e, :3201 real e2e)                      │
│  Controllers → Zod validation → Services → Prisma                     │
│  ExecutionsService → RuntimeRegistryService                            │
│    ├─ MockRuntimeService (in-process timers, auto/manual)              │
│    └─ RunnerRuntimeService ─┐                                          │
│  RunnerRegistryService ←────┘  identity, dispatch, recovery            │
│  RunnerGateway (Socket.IO /runner)   EventsGateway (Socket.IO /events) │
└───────────────┬─────────────────────────────────┬──────────────────────┘
                │                                 │
        ┌───────▼────────┐              ┌─────────▼──────────────────────┐
        │ SQLite          │              │ Haft Agent Runner (separate    │
        │ Prisma 6.16     │              │ Node process)                  │
        │ WAL mode        │              │  RunnerClient + TokenStore     │
        └─────────────────┘              │  FakeExecutor | RealExecutor   │
                                         │  CLI probe / JSONL parser      │
                                         │  Git worktree manager          │
                                         └─────────┬──────────────────────┘
                                                   │ spawn (argv, no shell)
                                         ┌─────────▼──────────────────────┐
                                         │ codex / opencode + git         │
                                         │ one worktree per execution     │
                                         └────────────────────────────────┘
```

The API and the web app are separate processes in development and E2E. In a
production-like deployment the built web assets could be served by any static
host as long as `/api`, `/socket.io`, and `/runner` are proxied to the API.

The runner is a separate trust domain. The API owns business state (tasks,
agents, executions, logs, activities) and the database. The runner owns only
local process execution and local Git state. The runner never opens the SQLite
database, and the server never sends its own credentials to a CLI.

## Repository structure

```text
packages/contracts    Zod schemas, enums, labels, DTOs, runner protocol v1
apps/api              NestJS application
  prisma/             schema, incremental migrations, deterministic seed
  src/common/         envelope, errors, logging, Prisma, validation, seed
  src/modules/        agents, tasks, executions, runtime, runners, events,
                      activities, workspace, computers, health, test API
  test/               Vitest + Supertest integration and runner protocol tests
apps/runner           Haft Agent Runner (independent process)
  src/                config, token store, protocol client, fake/real executors,
                      CLI probing/parsing, process utilities, Git worktrees
  test/               pure unit tests for args, parsing, config, Git and processes
apps/web              React SPA
  src/pages/          route-level pages
  src/features/       forms, drawers, Kanban board, execution log panel
  src/providers/      TanStack Query, Socket.IO, toasts
  src/services/       typed API client + query keys
  src/test/           Testing Library component tests
tests/                Playwright E2E, contract, fixtures, support helpers
tests/e2e-real/       opt-in real CLI suite and disposable Git fixture
docs/                 this document set and generated screenshots
```

## Layering rules

1. **Contracts are the source of truth for shapes.** `packages/contracts` exports
   literal unions (`TaskStatus`, `ExecutionStatus`, `ExecutionPhase`, ...),
   labels, the task state machine, DTO interfaces, Zod request schemas, and the
   runner protocol v1 schemas. The API validates with the schemas; the web
   imports the DTO types and label maps; the runner validates both directions of
   the protocol with the same schemas.
2. **Controllers stay thin.** They declare routes, attach `ZodValidationPipe`,
   and delegate to services. No business rules live in controllers.
3. **Services own invariants.** Assignment rules, task transitions, execution
   start preconditions, cancellation, activity records, and Socket.IO emissions
   are enforced server-side. The UI only reflects what the API accepted.
4. **The runtime is behind a seam.** `ExecutionsService` depends on
   `RuntimeRegistryService`, never on timer internals, Socket.IO details, or
   runtime names. The registry selects `MockRuntimeService` or a
   `RunnerRuntimeService` for `codex`/`opencode`.
5. **The database is the durable truth.** The mock runtime and runner keep live
   session state in memory, but every log line, progress value, status change,
   execution phase, and activity is persisted before it is emitted to the UI.
6. **The runner is not a second API.** It cannot read business data or write the
   database. It receives an `execution.start` message, executes, and streams
   protocol events back. The server validates ownership and idempotency before
   applying each event.

## Request lifecycle

Every HTTP request passes through:

1. `requestContext` middleware — accepts or generates `x-request-id`, records the
   start time, and logs method, path, status, and duration on response finish.
2. Nest router — the global prefix is `/api`. The `__test__` namespace is
   excluded from the prefix so test helpers are reachable at `/__test__/*`.
3. `ZodValidationPipe` — parses and validates query/body input. Failures become a
   `VALIDATION_ERROR` with per-field details. Request schemas are `.strict()`, so
   unknown fields are rejected rather than silently ignored.
4. Service / Prisma — business operation, activity record, and Socket.IO emission.
5. `ResponseEnvelopeInterceptor` — wraps successful payloads as
   `{ data, requestId }`.
6. `AllExceptionsFilter` — maps `AppException`, Zod errors, Prisma errors, and
   unknown exceptions to `{ error: { code, message, details }, requestId }` with a
   stable status code. Unknown errors are logged but not leaked to the client.

This gives every response a correlation ID and a machine-readable error shape,
which is why the E2E error-state tests can assert recovery paths without relying
on prose messages alone.

## Execution lifecycle

```text
POST /api/tasks/:id/start
  → serialize starts in-process (prevents duplicate starts from concurrent requests)
  → validate task, assignee, agent state and runtime availability
  → mock: create Execution(running, phase=running)
    runner: create Execution(running, phase=queued, runnerId, indeterminate)
  → transaction: task → in_progress, agent → busy
  → record activity execution.started + emit task/agent/execution events
  → RuntimeRegistryService.start(runtime, context)

Mock path
  → MockRuntimeService session with a fixed five-step script
  → auto mode schedules ticks; manual mode waits for test controls
  → RuntimeEvent {log, progress, completed, failed}

Runner path
  → RunnerRuntimeService validates the execution and dispatches
    execution.start over /runner (20 s acceptance timeout)
  → runner: execution.accepted
  → runner: preparing worktree → running CLI → finalizing → terminal
  → runner events: phase, log, progress, completed/failed/cancelled
  → server persists each event, applies phase/progress/logs, and emits UI events

Terminal transition (idempotent)
  → completed: execution completed, task done, agent idle
  → failed:    execution failed, task failed, agent error, failureReason
  → cancelled: execution cancelled, task cancelled, agent idle, cancelReason
  → activity + task/agent/execution events
```

`withExecutionLock` serialises persistence per execution, so log sequence
numbers and terminal transitions cannot interleave. The start path uses a
separate in-process `execution-start` lock because the “no running execution”
checks and the creation transaction are separate statements. This protects the
single API instance used by the demo; multiple instances would need a
database-level constraint or distributed lock.

## Runner architecture

The runner is documented in depth in
[runner-architecture.md](runner-architecture.md). The short version:

- **Pairing** uses a one-time bootstrap token over the `/runner` Socket.IO
  namespace. The server stores only `sha256(token)` in `Runner.tokenHash` and
  issues a fresh runner token on first pairing. The runner caches the token in a
  local file; the CLI child environment strips every `HAFT_*` and
  `E2E_RUNNER_*` variable, so the token is never inherited by a model process.
- **Capabilities** are probed once at start. Fake mode advertises
  `codex`/`opencode` as installed and authenticated without invoking a model.
  Real mode runs fixed `--version` and auth probes (`codex login status`,
  `opencode auth list`, with `opencode models` as a fallback).
- **Dispatch** is allowed only for a connected, paired runner whose capability
  list includes the runtime and whose project map includes the task project.
  The server also enforces max concurrency and agent/task preconditions.
- **Isolation**: every real execution gets a Git worktree at
  `<worktreeRoot>/<projectId>/<executionId>` on branch `haft/<executionId>`,
  created from the project repository's current `HEAD`. The runner refuses to
  reuse an existing branch or worktree. It never commits, pushes, merges, or
  fetches. The worktree is isolation for review and diff collection, not an OS
  sandbox.
- **Processes** are spawned with an argv array and `shell: false`; task prompts
  are written to stdin. Cancellation terminates the process tree (process group
  on POSIX, `taskkill /T /F` on Windows) and is only reported after the process
  exits. A timeout produces a `CLI_TIMEOUT` failure.
- **Output** is parsed from Codex/OpenCode JSONL into bounded log entries.
  Unknown JSON events are ignored; raw stderr is preserved; ANSI is stripped and
  common credential patterns are redacted before persistence.
- **Git result** reports the branch, base commit, head commit, changed-file
  count, diff stat, and status. By default worktrees are kept for inspection;
  `HAFT_RUNNER_KEEP_WORKTREES=0` removes them after collection.

## Realtime architecture

Two Socket.IO namespaces serve different purposes:

| Namespace | Consumer | Auth                      | Direction                       |
| --------- | -------- | ------------------------- | ------------------------------- |
| `/events` | browser  | none (local-only demo)    | server → client broadcasts      |
| `/runner` | runner   | handshake token/bootstrap | bidirectional protocol messages |

`EventsGateway` broadcasts DTOs after the corresponding database write:

| Event               | Payload           |
| ------------------- | ----------------- |
| `task.updated`      | `TaskDto`         |
| `task.removed`      | `{ id }`          |
| `agent.updated`     | `AgentDto`        |
| `agent.removed`     | `{ id }`          |
| `execution.updated` | `ExecutionDto`    |
| `execution.log`     | `ExecutionLogDto` |
| `activity.created`  | `ActivityDto`     |

The web `SocketProvider` connects to the gateway and patches or invalidates
TanStack Query caches. Progress events patch only the execution detail; terminal
states invalidate execution, log, and workspace queries. Log entries are appended
to the execution log query. Task and agent updates invalidate their lists and the
dashboard, and `agent.removed` also invalidates tasks and executions. The UI
therefore stays usable even if a socket event is missed: queries still refetch on
focus, on manual refresh, and after mutations.

The runner gateway processes messages from one runner strictly in arrival order.
This guarantees that terminal events never overtake the final logs that explain
them and that log acknowledgements follow the same order as the stream.

## Determinism

Determinism is a first-class architectural concern, not only a testing trick:

- The seed uses fixed IDs and fixed timestamps (`ws_demo`, `agent_developer`,
  `execution_seed_completed`, `2026-01-12T14:00:00.000Z`, ...).
- The mock runtime has a fixed five-step script with exact progress values
  (20, 40, 60, 80, 100) and fixed log messages.
- The Fake Runner has a fixed six-step script with exact progress values
  (10, 30, 50, 70, 85, 95, then 100) and deterministic phase/log messages. It
  fails intentionally when the task title contains `[fail]`, the description
  contains `HAFT_FAKE_FAIL`, or `HAFT_RUNNER_FAKE_FAIL=1`.
- `MOCK_TICK_MS` and `HAFT_RUNNER_STEP_MS` control pacing only, never content or
  ordering.
- Test mode can switch the mock runtime to `manual`; then `advance` and `finish`
  endpoints drive the same code path, making E2E assertions race-free.
- Playwright runs with `workers: 1` and uses `timezoneId: 'UTC'`, `locale:
'en-US'`, `reducedMotion: 'reduce'`, and a fixed viewport.
- Real CLI execution is never part of the deterministic suite. It has its own
  DB, ports, repository, worktree root, and opt-in environment variable.

The same matrix powers `docs/screenshots/*.png`; screenshots are captured by the
visual suite rather than by hand.

## Test-mode isolation

`TestController` is registered only when:

```text
process.env.E2E_TEST_MODE === 'true' && process.env.NODE_ENV !== 'production'
```

The module is conditionally added to the Nest module graph, so a production
deployment does not register `/__test__/*` and those routes return 404. The test
API can reset the database, seed an empty workspace, switch runtime mode, advance
steps, and force success/failure. It cannot execute shell commands, read
arbitrary files, or affect anything outside the configured SQLite database.
`HealthDto.testMode` exposes the same boolean for diagnostics.

Resetting the database preserves the `Runner` and `Computer` rows, so a paired
Fake Runner keeps working across tests without re-pairing. Active in-memory
runner sessions are not reset by the test API; tests use the deterministic Fake
Runner only and wait for terminal states.

## Failure handling and recovery

- Network errors and non-2xx responses are normalised by the web API client into
  an `ApiClientError` with `code`, `message`, and `details`.
- Every data surface has explicit loading, empty, error, and retry states. Error
  states use `role="alert"` where appropriate and keep the retry action focusable.
- Form submissions surface server validation errors inside the open dialog and
  keep the entered values intact.
- A failed toast keeps its error variant even after a later refresh.
- A missing task or execution renders a dedicated not-found state instead of an
  empty drawer or an unhandled exception.
- A top-level `ErrorBoundary` catches unexpected render errors and offers a
  reload action.
- If a runtime rejects a start, the execution is marked `failed`, the task and
  agent are restored to their pre-start state, an error log and activity are
  written, and the endpoint returns `RUNTIME_START_FAILED`.
- If the runner disconnects, executions stay `running` during the reconnect
  grace window. A reconnect snapshot decides what the runner still owns; any
  missing execution is failed with `RUNNER_RESTARTED`/`RUNNER_DISCONNECTED` and
  is **never** re-run automatically.
- Cancellation of a runner execution blocks until the runner sends
  `execution.cancelled` or the cancel timeout expires with
  `RUNNER_CANCEL_TIMEOUT`; a successful HTTP response never pretends a process
  died before it did.

See [execution-recovery.md](execution-recovery.md) for the complete matrix and
manual recovery procedure.

## Key tradeoffs

| Decision                             | Reason                                               | Consequence                                                       |
| ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Single default workspace (`ws_demo`) | Keeps the demo focused on the agent/task loop        | No tenancy or workspace switcher                                  |
| SQLite + WAL                         | Zero setup, durable, fast enough for one machine     | Writes are serialised; not a clustered DB                         |
| In-memory runtime sessions           | Simple deterministic simulation                      | Active mock executions are not resumable across API restarts      |
| Runner-owned process state           | Server never holds process handles or CLI secrets    | Runner restart fails in-flight executions; no silent resume       |
| Git worktree per execution           | Keeps the user's checkout untouched                  | Requires a clean Git repository and disk space; not an OS sandbox |
| Fake Runner before real CLI          | Proves protocol, persistence and UI without accounts | Real CLI failures stay isolated in an opt-in suite                |
| Fixed seed IDs                       | Comparable screenshots and straightforward E2E tests | Seed must be reset for clean-state tests                          |
| Five visual lanes for seven statuses | Readable board without seven columns                 | Lanes group statuses; cards always show exact status              |
| No web auth                          | Local single-user demo                               | Must not be exposed publicly as-is                                |

## Extension path

A new runtime can be added without changing `ExecutionsService`:

1. Add the runtime to the contract unions and `RuntimeAvailabilityDto` labels.
2. Implement `AgentRuntime` on the server, or extend `RunnerRuntimeService` plus
   the runner executor/arg builder for a new CLI.
3. Add a `RunnerRuntimeCapability` probe and protocol value.
4. Return a precise `reasonCode` from `RuntimeRegistryService.availability` so
   the UI can explain why the runtime is unavailable.

The event union (`RuntimeEvent`) is the stable seam: persistence, activities,
realtime updates, and the UI keep working unchanged. Real adapters still need
workspace-scoped allowlists, credential handling, process cleanup, and restart
recovery policies. None of these are implied by a Git worktree alone.
