# Raft Lite

Raft Lite is a single-machine **AI agent collaboration platform** demo. It pairs a task board and an agent roster with a deterministic Mock Runtime, real REST persistence, live Socket.IO execution logs, and a test interface that is only enabled when explicitly running in E2E test mode.

The repository is a complete, runnable product slice rather than a static prototype: every primary UI flow writes through the real API to SQLite and is covered by unit, integration, component, and browser tests.

![Raft Lite dashboard](docs/screenshots/dashboard-1440x900.png)

## What it does

- **Agents**: create, edit, filter, inspect, and delete AI workers. Agent details show runtime configuration, current task, and execution history.
- **Tasks**: create, edit, search, filter, assign, transition through a validated state machine, cancel, and delete tasks on a five-lane Kanban board.
- **Executions**: start a task with one click, watch deterministic progress and streamed logs, follow completion or failure, and cancel a running run.
- **Dashboard**: workspace metrics, recent tasks, activity feed, agent status, and runtime status.
- **Realtime**: task, agent, execution, log, and activity events are pushed over Socket.IO; TanStack Query caches are invalidated and updated live.
- **Testability**: stable `data-testid` attributes, a machine-readable UI interaction contract, deterministic seed data, a public API-backed test-data factory, and test-only runtime controls.

## Stack

| Layer            | Technology                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- |
| Workspace        | pnpm workspaces, TypeScript 5.8, Node.js >= 20.19                                  |
| Shared contracts | Zod, shared DTOs/types, tsup (CJS + ESM + declarations)                            |
| API              | NestJS 11, REST + Socket.IO, class-validator-free Zod pipe, Swagger/OpenAPI        |
| Persistence      | Prisma 6.16, SQLite, WAL journaling                                                |
| Web              | React 19, TypeScript, Vite 6, Tailwind CSS, Radix UI, TanStack Query, React Router |
| Unit/API tests   | Vitest, Supertest, Testing Library                                                 |
| End-to-end       | Playwright, serial workers, isolated API/web ports and SQLite database             |

## Repository layout

```text
apps/
  api/                 NestJS REST + Socket.IO API
    prisma/            schema, migration, deterministic seed
    src/modules/       agents, tasks, executions, runtime, events, workspace, test
    test/              API integration tests
  web/                 React/Vite SPA
    src/pages/         dashboard, agents, tasks, execution, not-found
    src/features/      agent/task forms, drawers, board, log panel
    src/test/          component tests
packages/
  contracts/           shared Zod schemas, constants, DTOs
tests/
  contract/            machine-readable UI interaction contract
  fixtures/            Playwright fixtures + API test-data factory
  support/             contract-aware selector helpers
  e2e/functional/      CRUD, filters, workflow, errors, accessibility
  e2e/business-loop/   cross-page end-to-end business scenario
  e2e/visual/          layout checks, screenshots, visual baseline
docs/                  architecture, data model, API, testing, report, screenshots
```

## Quick start

Prerequisites: Node.js 20.19+ and pnpm 11 (`corepack enable`).

```bash
pnpm install

# Environment (first run only). On Windows PowerShell use Copy-Item instead of cp.
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# Create the local SQLite database and seed deterministic demo data.
pnpm --filter @raft-lite/api db:deploy
pnpm db:seed

# Start the API on :3001 and the web app on :5173.
pnpm dev
```

Open <http://localhost:5173>. The API is at <http://127.0.0.1:3001/api>, and interactive API documentation is at <http://127.0.0.1:3001/api/docs>.

The web dev server proxies `/api` and `/socket.io` to `http://127.0.0.1:3001`.
The API binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only when running in
a container or intentionally exposing the API on the LAN.

## Commands

| Command           | Purpose                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`        | Build contracts, then run API (`:3001`) and web (`:5173`) together.                                |
| `pnpm build`      | Build contracts, API, and production web assets.                                                   |
| `pnpm lint`       | ESLint across the workspace.                                                                       |
| `pnpm typecheck`  | TypeScript checks for contracts, API, and web.                                                     |
| `pnpm test`       | Contracts, API integration, and web component tests.                                               |
| `pnpm test:e2e`   | Reset the isolated E2E database, start API (`:3101`) and web (`:5174`), run all Playwright suites. |
| `pnpm db:migrate` | Create/apply a development Prisma migration.                                                       |
| `pnpm db:deploy`  | Apply existing migrations to the development database.                                             |
| `pnpm db:seed`    | Seed deterministic demo data.                                                                      |
| `pnpm format`     | Prettier formatting.                                                                               |

Screenshots are regenerated by the visual E2E suite into `docs/screenshots/`.

## Demo data

The seed is deterministic and uses fixed IDs and timestamps:

| Entity              | ID                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspace           | `ws_demo`                                                                                                                   |
| Project             | `project_demo`                                                                                                              |
| Agents              | `agent_architect`, `agent_developer`, `agent_qa`                                                                            |
| Tasks               | `task_workspace_shell` (done), `task_arch_review` (in review), `task_log_viewer` (todo), `task_activity_contract` (claimed) |
| Completed execution | `execution_seed_completed`                                                                                                  |

Suggested tour:

1. Open **Overview** and note the seeded metrics and activity.
2. Open **Agents** and inspect Developer's execution history.
3. Open **Tasks**, start an execution on a claimed task, and follow the live progress and logs.
4. Cancel a running execution from its detail page.
5. Return to **Overview** to see the updated metrics and activity.

## Testing and selectors

The E2E test API is only registered when both `E2E_TEST_MODE=true` and `NODE_ENV!=production`; production builds expose no reset, seed, runtime-advance, or finish endpoints.

```bash
pnpm test:e2e
```

The Playwright configuration uses one serial worker because all tests share one API and database, resets the deterministic seed before each test, and starts isolated services:

- API: `http://127.0.0.1:3101`
- Web: `http://127.0.0.1:5174`
- E2E database: `apps/api/prisma/e2e.db`

See [docs/testing.md](docs/testing.md) for the full strategy, selector contract, required test IDs, test data factory, viewport/screenshot workflow, and troubleshooting.

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [API design](docs/api.md)
- [Testing strategy and selectors](docs/testing.md)
- [Implementation report](docs/REPORT.md)

## Scope and limitations

This is a local, single-user demo. It intentionally ships only the Mock Runtime; Codex and OpenCode runtimes are reserved adapters that are blocked at execution start. There is no authentication, multi-tenant isolation, or distributed scheduler. SQLite is sufficient for the single-machine target but writes are serialized. The test-only API must stay disabled outside test mode. See [docs/REPORT.md](docs/REPORT.md) for the complete implemented / not implemented / known-issues report.
