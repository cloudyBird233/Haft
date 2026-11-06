# API design

The API is a NestJS REST service with a Socket.IO gateway. Shared Zod schemas in
`packages/contracts` define every request body and query string, so the API and
the web client cannot drift silently.

## Base URLs

| Environment | REST base                   | Socket.IO                      | OpenAPI                          |
| ----------- | --------------------------- | ------------------------------ | -------------------------------- |
| Development | `http://127.0.0.1:3001/api` | `http://127.0.0.1:3001/events` | `http://127.0.0.1:3001/api/docs` |
| E2E         | `http://127.0.0.1:3101/api` | `http://127.0.0.1:3101/events` | `http://127.0.0.1:3101/api/docs` |

The API binds to `127.0.0.1` by default; set `HOST` to change the interface. The
Vite dev server proxies `/api` and `/socket.io` to `127.0.0.1:3001` (or
`VITE_API_PROXY_TARGET`), so the browser normally talks to the web origin only.

## Response envelope

Successful responses:

```json
{
  "data": { "...": "endpoint payload" },
  "requestId": "4f6f0f5e-2d4a-4a4f-9d36-6f9f0f1c2b7a"
}
```

Errors:

```json
{
  "error": {
    "code": "INVALID_TASK_TRANSITION",
    "message": "Cannot move a task from Todo to Done",
    "details": { "from": "todo", "to": "done" }
  },
  "requestId": "4f6f0f5e-2d4a-4a4f-9d36-6f9f0f1c2b7a"
}
```

Every response carries `x-request-id`. A client-supplied `x-request-id` up to
120 characters is echoed; otherwise the server generates a UUID. The same ID is
written to the structured API log with method, path, status, and duration.

Delete endpoints return `200` with `{ "data": { "id": "..." } }` rather than an
empty `204`, keeping the envelope consistent.

## Validation

- Bodies and queries are parsed with Zod. Unknown fields are rejected because
  request schemas use `.strict()`.
- Validation failures return `400 VALIDATION_ERROR`; `details` is an array of
  `{ path, message }`.
- Named string IDs are trimmed and must be non-empty.
- Agent `name` is 2–60 characters, `role` 2–80, `description` up to 2000.
- Task `title` is 3–140 characters, `description` up to 4000.
- Cancellation and failure reasons are up to 500 characters.
- Pagination: `limit`/`offset`; defaults and maxima differ per endpoint (see the
  table below).

## Endpoints

### Health

| Method | Path          | Description                           |
| ------ | ------------- | ------------------------------------- |
| `GET`  | `/api/health` | Database readiness and test-mode flag |

```json
{
  "status": "ok",
  "database": "up",
  "testMode": false,
  "timestamp": "2026-01-12T14:00:00.000Z",
  "version": "0.1.0"
}
```

### Workspace and dashboard

| Method | Path             | Description                                                |
| ------ | ---------------- | ---------------------------------------------------------- |
| `GET`  | `/api/workspace` | Active workspace and its projects                          |
| `GET`  | `/api/dashboard` | Metrics, recent tasks, recent activities, agents, projects |

`DashboardDto`:

```json
{
  "workspace": {
    "id": "ws_demo",
    "name": "Raft Lite",
    "slug": "raft-lite",
    "createdAt": "...",
    "projects": []
  },
  "metrics": {
    "agentsTotal": 3,
    "agentsOnline": 3,
    "tasksRunning": 0,
    "tasksCompleted": 1,
    "tasksTotal": 4
  },
  "recentTasks": [],
  "recentActivities": [],
  "agents": [],
  "projects": []
}
```

`recentTasks` is the six most recently updated tasks; `recentActivities` is the
eight newest activity rows.

### Agents

| Method   | Path              | Description                                       |
| -------- | ----------------- | ------------------------------------------------- |
| `GET`    | `/api/agents`     | List and filter agents                            |
| `POST`   | `/api/agents`     | Create an agent                                   |
| `GET`    | `/api/agents/:id` | Agent detail, current task, recent executions     |
| `PATCH`  | `/api/agents/:id` | Update agent fields or status                     |
| `DELETE` | `/api/agents/:id` | Delete an idle agent and release its active tasks |

List query parameters:

| Parameter | Type      | Notes                                       |
| --------- | --------- | ------------------------------------------- |
| `search`  | string    | `contains` match on name, role, description |
| `status`  | enum      | `idle`, `busy`, `offline`, `error`          |
| `limit`   | int 1–100 | Default 50                                  |
| `offset`  | int ≥ 0   | Default 0                                   |

Create body:

```json
{
  "name": "Planner",
  "role": "Delivery Planner",
  "description": "Turns roadmap items into sequenced work.",
  "runtime": "mock",
  "computerId": "computer_local"
}
```

- `name` and `role` are required; `description` defaults to `""`; `runtime`
  defaults to `mock`; `computerId` defaults to `null`.
- `codex` and `opencode` are accepted values so agents can be configured ahead of
  adapter availability, but executions with them are rejected.
- Update accepts any subset of `name`, `role`, `description`, `runtime`,
  `computerId`, `status`; at least one field is required.
- `status: "busy"` is rejected; the busy state belongs to executions.
- Creating or updating with an unknown `computerId` returns
  `400 COMPUTER_NOT_FOUND`.

Agent detail adds:

```json
{
  "currentTask": { "...": "TaskSummaryDto or null" },
  "recentExecutions": ["ExecutionDto — latest five"]
}
```

The current task is the most recently updated task assigned to the agent in
`claimed`, `in_progress`, or `in_review`.

Deleting an agent with a running execution returns `409 AGENT_BUSY`. Otherwise
the delete transaction resets the agent's `claimed`, `in_progress`, and
`in_review` tasks to `todo`, unassigns them, and emits `task.updated` for each.
Terminal tasks keep their status but lose the assignee through the `SetNull`
relation. The `agent.deleted` activity includes `metadata.taskIds` when tasks
were released.

### Tasks

| Method   | Path                    | Description                              |
| -------- | ----------------------- | ---------------------------------------- |
| `GET`    | `/api/tasks`            | List and filter tasks                    |
| `POST`   | `/api/tasks`            | Create a task                            |
| `GET`    | `/api/tasks/:id`        | Task detail with execution history       |
| `PATCH`  | `/api/tasks/:id`        | Update fields or transition status       |
| `DELETE` | `/api/tasks/:id`        | Delete a task with no active execution   |
| `POST`   | `/api/tasks/:id/assign` | Assign or unassign an agent              |
| `POST`   | `/api/tasks/:id/start`  | Start a mock execution                   |
| `POST`   | `/api/tasks/:id/cancel` | Cancel the task and any active execution |

List query parameters:

| Parameter         | Type      | Notes                                     |
| ----------------- | --------- | ----------------------------------------- |
| `search`          | string    | `contains` match on title and description |
| `status`          | enum      | Any task status                           |
| `priority`        | enum      | `low`, `medium`, `high`, `urgent`         |
| `projectId`       | string    | Exact match                               |
| `assigneeAgentId` | string    | Exact match, or the literal `unassigned`  |
| `limit`           | int 1–200 | Default 100                               |
| `offset`          | int ≥ 0   | Default 0                                 |

Create body:

```json
{
  "title": "Implement audit trail",
  "description": "Record every state change with actor and timestamp.",
  "projectId": "project_demo",
  "assigneeAgentId": "agent_developer",
  "priority": "high"
}
```

- `title` and `projectId` are required.
- With an assignee the task starts in `claimed`; otherwise `todo`.
- Priority defaults to `medium`.
- Unknown project → `400 PROJECT_NOT_FOUND`; unknown assignee →
  `400 AGENT_NOT_FOUND`.

Update body is any subset of `title`, `description`, `projectId`, `priority`,
`status`. At least one field is required. A status change is checked against the
state machine (see [data-model.md](data-model.md)); illegal moves return
`409 INVALID_TASK_TRANSITION` with `{ from, to }`.

Assign body:

```json
{ "agentId": "agent_qa" }
```

Send `{ "agentId": null }` to unassign. Assigning a `todo` task moves it to
`claimed`; unassigning a `claimed` task moves it back to `todo`. Completed and
cancelled tasks cannot be assigned. A task with a running execution cannot be
reassigned.

Task detail adds `executionCount` and `executions` (newest first). Task summaries
include `latestExecution`; the detail drawer uses it to offer “Open run”.

Start returns the created `ExecutionDto` on success. Preconditions:

| Condition                                     | Error                           |
| --------------------------------------------- | ------------------------------- |
| Task missing                                  | `404 TASK_NOT_FOUND`            |
| Already running for this task                 | `409 EXECUTION_ALREADY_RUNNING` |
| No assignee                                   | `409 TASK_UNASSIGNED`           |
| Status not `todo` / `claimed` / `in_progress` | `409 TASK_NOT_STARTABLE`        |
| Agent already running something               | `409 AGENT_BUSY`                |
| Agent offline                                 | `409 AGENT_OFFLINE`             |
| Agent in error state                          | `409 AGENT_ERROR`               |
| Runtime not `mock`                            | `422 RUNTIME_NOT_AVAILABLE`     |
| Runtime rejected the start                    | `500 RUNTIME_START_FAILED`      |

Starts are serialized within one API process. Concurrent starts for the same
task return one `201` and one `409 EXECUTION_ALREADY_RUNNING`; concurrent starts
that target the same agent return one `201` and one `409 AGENT_BUSY`. This is
single-instance protection; multiple API instances would need a database
constraint or distributed lock.

If the runtime rejects the start, the endpoint returns `500 RUNTIME_START_FAILED`.
The execution is marked `failed`, the task and agent are restored to their
pre-start status (including the agent's `lastActiveAt`), an error log and an
`execution.failed` activity are written, and realtime events are emitted. The
task can be started again.

Cancel body is optional `{ "reason": "..." }`. The reason defaults to
“Cancelled by operator”. Returns `TaskCancellationDto`:

```json
{ "task": { "...": "TaskDto" }, "execution": { "...": "ExecutionDto or null" } }
```

### Executions

| Method | Path                         | Description                      |
| ------ | ---------------------------- | -------------------------------- |
| `GET`  | `/api/executions`            | List executions                  |
| `GET`  | `/api/executions/:id`        | One execution                    |
| `GET`  | `/api/executions/:id/logs`   | Logs in ascending sequence order |
| `POST` | `/api/executions/:id/cancel` | Cancel a running execution       |

List query parameters: `taskId`, `agentId`, `status`, `limit` (1–100, default
50), `offset`. Results are newest first.

Logs query parameters: `afterSeq` (int ≥ 0, exclusive), `limit` (1–500, default
200). Response is `{ items, total }` where `total` counts rows matching the
same `afterSeq` filter.

Cancel body is optional `{ "reason": "..." }`. Only `running` executions can be
cancelled; otherwise `409 EXECUTION_NOT_RUNNING`. Cancellation sets the execution
to `cancelled`, the task to `cancelled`, and the agent to `idle`, appends a
warning log, records an activity, and emits realtime events.

### Activities

| Method | Path              | Description          |
| ------ | ----------------- | -------------------- |
| `GET`  | `/api/activities` | Recent activity feed |

Query: `limit` (1–100, default 30), `offset`. Newest first. Each row includes
the related `agent` (`{ id, name }` or `null`) and `task`
(`{ id, title }` or `null`), so the UI can link without extra requests.

Activity types: `agent.created`, `agent.updated`, `agent.deleted`,
`task.created`, `task.updated`, `task.assigned`, `task.status_changed`,
`task.deleted`, `execution.started`, `execution.completed`, `execution.failed`,
`execution.cancelled`, and the reserved `workspace.seeded`.

When an agent deletion releases active tasks, `agent.deleted` includes
`metadata.taskIds`. A start-stage failure records `execution.failed` with
`metadata.stage = "start"` and the runtime error message.

### Computers

| Method | Path             | Description               |
| ------ | ---------------- | ------------------------- |
| `GET`  | `/api/computers` | List registered computers |

Computers are read-only in this phase; the seed registers `computer_local`.

## Error codes

| HTTP | Code                        | Typical cause                                                      |
| ---- | --------------------------- | ------------------------------------------------------------------ |
| 400  | `VALIDATION_ERROR`          | Zod parse failure                                                  |
| 400  | `PROJECT_NOT_FOUND`         | Unknown project on task create/update                              |
| 400  | `COMPUTER_NOT_FOUND`        | Unknown computer on agent create/update                            |
| 400  | `AGENT_NOT_FOUND`           | Unknown assignee on task create/assign                             |
| 404  | `AGENT_NOT_FOUND`           | Agent route id not found                                           |
| 404  | `TASK_NOT_FOUND`            | Task route id not found                                            |
| 404  | `EXECUTION_NOT_FOUND`       | Execution route/logs id not found                                  |
| 404  | `WORKSPACE_NOT_FOUND`       | Default workspace not seeded                                       |
| 404  | `NOT_FOUND`                 | Prisma `P2025` fallback                                            |
| 409  | `CONFLICT`                  | Prisma `P2002` fallback                                            |
| 409  | `AGENT_BUSY`                | Agent running, or manual busy status                               |
| 409  | `AGENT_STATUS_MANAGED`      | Attempt to set agent status to `busy`                              |
| 409  | `AGENT_OFFLINE`             | Start with an offline agent                                        |
| 409  | `AGENT_ERROR`               | Start with an agent in error state                                 |
| 409  | `TASK_EXECUTION_ACTIVE`     | Edit status/assign/delete while running                            |
| 409  | `TASK_TERMINAL`             | Cancel done task or assign terminal task                           |
| 409  | `TASK_NOT_STARTABLE`        | Start from review/done/stopped                                     |
| 409  | `TASK_UNASSIGNED`           | Start without an assignee                                          |
| 409  | `INVALID_TASK_TRANSITION`   | Illegal state-machine move                                         |
| 409  | `EXECUTION_ALREADY_RUNNING` | Second concurrent run for a task                                   |
| 409  | `EXECUTION_NOT_RUNNING`     | Cancel an already terminal execution                               |
| 422  | `RUNTIME_NOT_AVAILABLE`     | Codex/OpenCode runtime selected                                    |
| 500  | `RUNTIME_START_FAILED`      | Runtime rejected a start; execution failed and task/agent restored |
| 500  | `INTERNAL_ERROR`            | Unexpected exception (details not leaked)                          |

Test-control codes such as `RUNTIME_SESSION_NOT_FOUND` and
`RUNTIME_NOT_RUNNING` are only reachable when the test API is enabled.

## Socket.IO contract

Namespace: `/events`. No authentication; the demo is local-only. Events are
server-to-client broadcasts.

| Event               | Payload           | When                                     |
| ------------------- | ----------------- | ---------------------------------------- |
| `task.updated`      | `TaskDto`         | Create/update/assign/start/finish/cancel |
| `task.removed`      | `{ id }`          | Task delete                              |
| `agent.updated`     | `AgentDto`        | Create/update/status change              |
| `agent.removed`     | `{ id }`          | Agent delete                             |
| `execution.updated` | `ExecutionDto`    | Progress and terminal transitions        |
| `execution.log`     | `ExecutionLogDto` | Every persisted log line                 |
| `activity.created`  | `ActivityDto`     | Every recorded activity                  |

The web app also refetches after mutations, so missed events degrade to stale
data rather than broken state.

## Test API

Registered only when `E2E_TEST_MODE=true` **and** `NODE_ENV!=production`. These
routes are excluded from the `/api` prefix and from Swagger.

| Method | Path                               | Body                                           | Purpose                       |
| ------ | ---------------------------------- | ---------------------------------------------- | ----------------------------- |
| `POST` | `/__test__/reset`                  | `{ preset?: "default" \| "empty" }`            | Clear all data and reseed     |
| `POST` | `/__test__/seed`                   | same as reset                                  | Alias for reset               |
| `POST` | `/__test__/runtime/mode`           | `{ mode: "auto" \| "manual" }`                 | Deterministic manual stepping |
| `POST` | `/__test__/executions/:id/advance` | `{ steps?: 1..20 }`                            | Advance the runtime script    |
| `POST` | `/__test__/executions/:id/finish`  | `{ outcome: "success" \| "failure", reason? }` | Force an outcome              |

The test API has no shell or filesystem surface. It only manipulates the
configured SQLite database and the in-memory mock runtime.

## Examples

```bash
# Health
curl http://127.0.0.1:3001/api/health

# List tasks with a filter
curl "http://127.0.0.1:3001/api/tasks?status=todo&priority=medium"

# Create an agent
curl -X POST http://127.0.0.1:3001/api/agents \
  -H "content-type: application/json" \
  -d '{"name":"Planner","role":"Delivery Planner"}'

# Assign a task
curl -X POST http://127.0.0.1:3001/api/tasks/task_log_viewer/assign \
  -H "content-type: application/json" \
  -d '{"agentId":"agent_developer"}'

# Start an execution
curl -X POST http://127.0.0.1:3001/api/tasks/task_log_viewer/start

# Read logs after sequence 2
curl "http://127.0.0.1:3001/api/executions/<id>/logs?afterSeq=2&limit=100"

# Cancel
curl -X POST http://127.0.0.1:3001/api/executions/<id>/cancel \
  -H "content-type: application/json" \
  -d '{"reason":"Superseded by a new plan"}'
```

The OpenAPI document is generated from controller decorators and available at
`/api/docs` (UI) and `/api/docs-json` (JSON).
