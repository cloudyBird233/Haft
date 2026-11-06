# Architecture

Raft Lite is a single-machine, single-workspace demo of an AI agent collaboration
platform. It is deliberately small enough to run on a laptop, but every screen is
backed by a real NestJS API, a real SQLite database, and a deterministic runtime
that emits real-time events. There is no mocked frontend state and no static
fixture masquerading as a product.

## System context

```text
┌─────────────────────────────────────────────────────────────────┐
│ Browser                                                         │
│  React 19 + Vite + Tailwind + Radix + TanStack Query            │
│  Routes: /  /agents  /tasks  /executions/:id                    │
└───────────────┬──────────────────────────────┬──────────────────┘
                │ HTTP /api/*                  │ Socket.IO /events
                │ (Vite proxy in dev)          │
┌───────────────▼──────────────────────────────▼──────────────────┐
│ NestJS API (:3001 dev, :3101 e2e)                               │
│  Controllers → Zod validation → Services → Prisma              │
│  ExecutionsService ← AgentRuntime events                        │
│  EventsGateway (Socket.IO)                                      │
└───────────────┬──────────────────────────────┬──────────────────┘
                │                              │
        ┌───────▼────────┐          ┌──────────▼──────────┐
        │ SQLite          │          │ MockRuntimeService  │
        │ Prisma 6.16     │          │ in-process timers   │
        │ WAL mode        │          │ auto / manual modes │
        └────────────────┘          └─────────────────────┘
```

The API and the web app are separate processes in development and E2E. In a
production-like deployment the built web assets could be served by any static
host as long as `/api` and `/socket.io` are proxied to the API.

## Repository structure

```text
packages/contracts    Zod schemas, enums, labels, DTO types shared by API + web
apps/api              NestJS application
  prisma/             schema, migration, deterministic seed
  src/common/         envelope, errors, logging, Prisma, validation, seed
  src/modules/        agents, tasks, executions, runtime, events, activities,
                      workspace, computers, health, conditional test API
  test/               Vitest + Supertest integration tests
apps/web              React SPA
  src/pages/          route-level pages
  src/features/       forms, drawers, Kanban board, execution log panel
  src/providers/      TanStack Query, Socket.IO, toasts
  src/services/       typed API client + query keys
  src/test/           Testing Library component tests
tests/                Playwright E2E, contract, fixtures, support helpers
docs/                 this document set and generated screenshots
```

## Layering rules

1. **Contracts are the source of truth for shapes.** `packages/contracts` exports
   literal unions (`TaskStatus`, `ExecutionStatus`, ...), labels, the task state
   machine, DTO interfaces, and Zod schemas. The API validates with the schemas;
   the web imports the DTO types and label maps. Changing a status means changing
   one package, not three copies.
2. **Controllers stay thin.** They declare routes, attach `ZodValidationPipe`,
   and delegate to services. No business rules live in controllers.
3. **Services own invariants.** Assignment rules, task transitions, execution
   start preconditions, cancellation, activity records, and Socket.IO emissions
   are enforced server-side. The UI only reflects what the API accepted.
4. **The runtime is behind a seam.** `ExecutionsService` depends on the
   `AgentRuntime` interface, never on timer internals. `MockRuntimeService` is the
   only implementation wired in this phase.
5. **The database is the durable truth.** The mock runtime keeps live session
   state in memory, but every log line, progress value, status change, and
   activity is persisted before it is emitted. Sessions are released on
   completion, failure, cancellation, or stop; `getStatus` returns `null` for a
   terminal execution.

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
  → validate task exists, is unassigned? no, has assignee, status startable
  → validate agent belongs to workspace, is idle/not running another execution
  → validate runtime === 'mock'
  → transaction: create Execution(running, 0), task → in_progress, agent → busy
  → record activity execution.started + emit task/agent/execution events
  → AgentRuntime.start(context)
  → on start failure: execution → failed, task/agent restored, error log + activity

MockRuntimeService.start
  → create in-memory session (step=0, seq=1)
  → emit log "Mock runtime attached..." and progress 0
  → auto mode: schedule tick every MOCK_TICK_MS
  → manual mode: wait for test controls

Runtime event → ExecutionsService.withExecutionLock(executionId)
  log       → persist ExecutionLog(seq), emit execution.log
  progress  → update Execution.progress, emit execution.updated
  completed → transaction: execution completed, task done, agent idle
              + activity execution.completed + events
  failed    → transaction: execution failed, task failed, agent error
              + activity execution.failed + events
```

`withExecutionLock` serialises persistence per execution. Auto ticks and manual
test control calls therefore cannot interleave log sequence numbers or race the
terminal transition. A terminal `finishExecution` is idempotent: it re-reads the
row and returns early unless the execution is still `running`.

Execution starts use a separate in-process `execution-start` lock because the
“no running execution” checks and the creation transaction are separate
statements. This prevents duplicate starts for the same task or agent in the
single-instance demo; a multi-instance deployment would need a database-level
constraint or distributed lock as well.

Cancellation (`POST /api/executions/:id/cancel` or `POST /api/tasks/:id/cancel`)
uses the same lock, stops the runtime session, marks the execution `cancelled`,
the task `cancelled`, the agent `idle`, appends a warning log, records an
activity, and emits all affected events. A task with no active execution can be
cancelled directly; cancelling an already-cancelled task is a no-op that returns
its current state.

Deleting an idle agent runs in one transaction: active assigned tasks are reset
to `todo`, unassigned, and emitted as `task.updated`; the agent row is deleted;
and `agent.deleted` records the released task IDs. An agent with a running
execution cannot be deleted.

## Realtime architecture

`EventsGateway` is a Socket.IO gateway on the `/events` namespace. It broadcasts
DTOs after the corresponding database write:

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

CORS origins come from `WEB_ORIGIN` (comma-separated). If unset, only the local
development and E2E origins (`localhost` / `127.0.0.1` on ports 5173 and 5174)
are accepted. The API binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only
when running in a container or intentionally exposing it on the LAN.

## Determinism

Determinism is a first-class architectural concern, not only a testing trick:

- The seed uses fixed IDs and fixed timestamps (`ws_demo`, `agent_developer`,
  `execution_seed_completed`, `2026-01-12T14:00:00.000Z`, ...).
- The mock runtime has a fixed five-step script with exact progress values
  (20, 40, 60, 80, 100) and fixed log messages.
- `MOCK_TICK_MS` controls pacing only, never content or ordering.
- Test mode can switch the runtime to `manual`; then `advance` and `finish`
  endpoints drive the same code path, making E2E assertions race-free.
- Playwright runs with `workers: 1` and uses `timezoneId: 'UTC'`, `locale:
'en-US'`, `reducedMotion: 'reduce'`, and a fixed viewport.

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

## Failure handling and recovery

- Network errors and non-2xx responses are normalised by the web API client into
  an `ApiClientError` with `code`, `message`, and `details`.
- Every data surface has explicit loading, empty, error, and retry states. Error
  states use `role="alert"` where appropriate and keep the retry action focusable.
- Form submissions surface server validation errors inside the open dialog and
  keep the entered values intact.
- A failed toast keeps its error variant even after a later refresh (covered by
  the dashboard E2E test).
- A missing task or execution renders a dedicated not-found state instead of an
  empty drawer or an unhandled exception.
- A top-level `ErrorBoundary` catches unexpected render errors and offers a
  reload action, so a programming error cannot leave a blank page.
- The mock runtime can be forced to fail, which exercises the failure path:
  execution `failed`, task `failed`, agent `error`, error log, failure reason.

## Key tradeoffs

| Decision                             | Reason                                               | Consequence                                             |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| Single default workspace (`ws_demo`) | Keeps the demo focused on the agent/task loop        | No tenancy or workspace switcher                        |
| SQLite + WAL                         | Zero setup, durable, fast enough for one machine     | Writes are serialised; not a clustered DB               |
| In-memory runtime sessions           | Simple deterministic simulation                      | Active executions are not resumable across API restarts |
| Fixed seed IDs                       | Comparable screenshots and straightforward E2E tests | Seed must be reset for clean-state tests                |
| Five visual lanes for seven statuses | Readable board without seven columns                 | Lanes group statuses; cards always show exact status    |
| Mock-only executable runtime         | Avoids arbitrary shell execution                     | Codex/OpenCode adapters are intentionally blocked       |
| No auth                              | Local single-user demo                               | Must not be exposed publicly as-is                      |

## Extension path

A real runtime adapter would implement `AgentRuntime`:

```ts
interface AgentRuntime {
  readonly type: string;
  start(context: RuntimeContext): Promise<void>;
  stop(executionId: string): Promise<void>;
  getStatus(executionId: string): Promise<RuntimeStatus | null>;
  onEvent(listener: RuntimeEventListener): () => void;
}
```

The adapter would translate CLI process output into the same `log`, `progress`,
`completed`, and `failed` events. Because `ExecutionsService` only consumes that
event union, persistence, activities, realtime updates, and the UI would keep
working unchanged. Real adapters would also need workspace-scoped allowlists,
credential handling, process sandboxing, and restart recovery — all explicitly
out of scope for this phase.
