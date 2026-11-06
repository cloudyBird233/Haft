# Implementation report

## Summary

Raft Lite is delivered as a runnable pnpm monorepo rather than a visual mock. It
contains a React 19 SPA, a NestJS REST + Socket.IO API, a Prisma/SQLite database,
a deterministic Mock Runtime behind an `AgentRuntime` seam, a machine-readable UI
interaction contract, an API-backed test-data factory, and four layers of
automated tests.

Every primary flow writes through the real API and survives a reload: agent
create/edit/delete, task create/edit/assign/transition/cancel/delete, execution
start/progress/logs/complete/fail/cancel, activity history, and dashboard
aggregation.

## Delivered scope

### Workspace and dashboard

- Persistent application shell with sidebar navigation, runtime status, socket
  connection status, and an offline banner.
- Overview with agent/task metrics, recent tasks, recent activities, agent
  roster, and runtime card.
- Metric and activity updates after business operations (verified by the
  business-loop test).
- Explicit loading, empty, error, and retry states.

### Agents

- Roster with search across name/role/description and status filter.
- Create and edit dialogs with validation, runtime/computer/status fields,
  focus management, Escape dismissal, and in-dialog server errors.
- Detail drawer with configuration, current task, and five most recent
  executions.
- Delete confirmation with running-execution protection.
- Empty roster and empty filter states.

### Tasks

- Five-lane Kanban board (To do / Active / In review / Done / Stopped) with exact
  status labels on cards and per-lane counts.
- Create/edit with project, assignee, priority, and description.
- Search plus status, priority, assignee (including unassigned), and project
  filters.
- Detail drawer with status workflow, assignment, edit, cancel, delete,
  execution history, latest-run link, and start action.
- Server-enforced state machine and assignment invariants.
- Empty board, empty filter, missing task, and execution-active states.

### Executions

- One-click start from task detail with precondition checks (assignee, agent
  state, runtime availability, existing runs).
- Deterministic five-step mock runtime with progress and streamed logs.
- Execution page with status banner, progressbar, task/agent cards, failure and
  cancellation reasons, log viewer, refresh, and cancel-with-confirmation.
- Automatic task/agent transitions: start → `in_progress`/`busy`; success →
  `done`/`idle`; failure → `failed`/`error`; cancel → `cancelled`/`idle`.
- Realtime log append and execution/task/agent updates over Socket.IO.

### Activities and realtime

- Activity records for agent/task/execution operations with related agent/task
  summaries.
- Socket.IO namespace `/events` broadcasting task, agent, execution, log, and
  activity events.
- TanStack Query cache patching/invalidation, plus refetch-on-focus and manual
  refresh as a fallback for missed events.

### Testability and documentation

- Stable semantic roles and kebab-case `data-testid` attributes on all primary
  controls and states.
- `tests/contract/ui-interaction.contract.json` describing routes, selectors,
  required test IDs, lanes, states, flows, test API, and seed IDs.
- Typed contract resolver (`byTestId`, `bySelector`, `resolveTestId`, `route`).
- API-backed test-data factory and auto-reset Playwright fixture.
- Test-only API gated by `E2E_TEST_MODE=true` **and** `NODE_ENV!=production`,
  with no shell or filesystem surface.
- Functional, business-loop, and visual E2E suites kept separate.
- Deterministic seed and screenshots in `docs/screenshots/`.
- README, architecture, data model, API, testing, and this report.

## Requirements traceability

| Requirement                                                                  | Status | Evidence                                               |
| ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| pnpm workspace with React/TS/Vite/Tailwind/Radix/TanStack Query/React Router | Done   | `package.json`, `apps/web/package.json`                |
| NestJS REST + Socket.IO                                                      | Done   | `apps/api/src/modules`, `events.gateway.ts`            |
| Prisma + SQLite                                                              | Done   | `schema.prisma`, migration, `PrismaService` WAL setup  |
| Agents CRUD/detail/history                                                   | Done   | API + `agents.spec.ts` (7 tests)                       |
| Tasks Kanban CRUD/filter/search/assign/status                                | Done   | API + `tasks.spec.ts` (10 tests)                       |
| Deterministic runtime behind seam                                            | Done   | `AgentRuntime`, `MockRuntimeService`, unit + E2E tests |
| Execution progress/logs/cancel                                               | Done   | `executions.spec.ts` (4 tests), business loop          |
| Activities and dashboard                                                     | Done   | dashboard tests, business loop                         |
| Stable semantic controls/test IDs, no hover-only actions                     | Done   | contract + accessibility assertions                    |
| Dialog focus/keyboard behavior                                               | Done   | component + E2E Escape/focus tests                     |
| Required test IDs                                                            | Done   | contract `requiredTestIds`, exercised in E2E           |
| Test interfaces only in test mode, no shell                                  | Done   | conditional `TestModule`, endpoint allowlist           |
| Machine-readable UI contract                                                 | Done   | `ui-interaction.contract.json`                         |
| Test data factories                                                          | Done   | `test-data-factory.ts`                                 |
| Separate functional/visual/business-loop E2E                                 | Done   | `tests/e2e/*`                                          |
| Architecture/data model/API/testing docs                                     | Done   | `docs/*.md`                                            |
| Screenshots and final report                                                 | Done   | `docs/screenshots/*.png`, this file                    |
| `pnpm dev/build/lint/typecheck/test/test:e2e`                                | Done   | validation section below                               |
| Real API persistence, no static-only UI                                      | Done   | API integration + business-loop tests                  |

## Validation

Validation was run on Windows with Node.js 24 and pnpm 11.

| Command          | Result                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | Pass — contracts build; API health 200 (`testMode:false`), web 200, styles compiled, `/__test__/reset` 404 |
| `pnpm lint`      | Pass — ESLint, zero warnings                                                                               |
| `pnpm typecheck` | Pass — contracts, API, web                                                                                 |
| `pnpm test`      | Pass — 38 tests (5 contracts, 21 API, 12 web)                                                              |
| `pnpm test:e2e`  | Pass — 39 Playwright tests, 1 worker; verified twice                                                       |
| `pnpm build`     | Pass — contracts, API, Vite production bundle                                                              |

The E2E run covers 35 functional tests, 1 business-loop test, and 3 visual tests.
The visual run regenerates all screenshots in `docs/screenshots/` and compares
the dashboard 1440×900 capture against the committed baseline.

Supporting checks:

- `pnpm db:seed` — idempotent deterministic seed verified.
- `pnpm dev` was probed with a real browser-facing request: API health returned
  `{ status: "ok", database: "up", testMode: false }`, the web root and compiled
  CSS returned 200, and `POST /__test__/reset` returned 404 outside E2E mode.
- E2E pretest — contracts build + isolated `e2e.db` reset verified, including
  removal of stale `-wal`/`-shm` files.
- Documentation audit — relative links resolve; test counts match the suites
  (5 contracts + 21 API + 12 web; 35 functional + 1 business-loop + 3 visual);
  all 22 product routes and 10 required test IDs are documented; all 11
  screenshots in `docs/screenshots/` appear in the gallery.
- API tests use `test.db`; Playwright uses `e2e.db`; both are separate from
  `dev.db`.
- Production/dev mode does not register the test controller. Test endpoints
  return 404 unless both gating variables are set.
- Regression coverage added for concurrent execution starts, runtime-start
  rollback, agent-deletion task cleanup, the agent detail drawer closing after
  deletion, terminal mock-runtime session release, and the top-level
  `ErrorBoundary`. The API suite covers the concurrency/rollback paths; the
  functional E2E suite covers the deletion flow end to end.

## Screenshot gallery

Generated by `tests/e2e/visual/visual.spec.ts` at 1440×900 unless noted.

| File                               | Surface                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `dashboard-1440x900.png`           | Overview with metrics, recent tasks, activity, agents |
| `dashboard-1280x800.png`           | Overview at 1280 width                                |
| `dashboard-1920x1080.png`          | Overview at 1920 width                                |
| `agents-1440x900.png`              | Agent roster and filters                              |
| `agent-detail-1440x900.png`        | Agent profile drawer and execution history            |
| `tasks-1440x900.png`               | Five-lane task board                                  |
| `task-detail-1440x900.png`         | Task detail drawer                                    |
| `create-task-dialog-1440x900.png`  | Task creation dialog                                  |
| `create-agent-dialog-1440x900.png` | Agent creation dialog                                 |
| `execution-running-1440x900.png`   | Running execution with partial progress/logs          |
| `execution-completed-1440x900.png` | Completed execution with final log                    |

The visual baseline is
`tests/e2e/visual/visual.spec.ts-snapshots/dashboard-1440x900-chromium-win32.png`.

## Not implemented (intentional)

- **Real Codex/OpenCode runtimes.** `AgentRuntime` and runtime labels exist, but
  selecting those runtimes is rejected at execution start with
  `RUNTIME_NOT_AVAILABLE`. This phase ships the mock adapter only and never
  executes arbitrary shell commands.
- **Authentication, authorization, multi-tenancy.** The demo assumes a single
  trusted local operator and the fixed `ws_demo` workspace.
- **Multi-machine scheduling.** Computers are read-only; there is no agent
  placement, heartbeat, or distributed queue.
- **Execution resume/reconciliation.** Runtime sessions are in memory. Restarting
  the API while an execution is running leaves the database row `running` with
  no worker; no startup reconciliation is implemented.
- **Notifications, file attachments, comments, subtasks, labels.** Only the
  agent/task/execution/activity loop is in scope.
- **Advanced board interactions.** Drag-and-drop is not implemented; status
  changes use the explicit, accessible workflow controls.
- **Production deployment assets.** No Dockerfile, reverse-proxy config, HTTPS
  setup, or hosted demo is provided.

## Known issues and limitations

1. **Single-writer SQLite.** WAL improves responsiveness, but SQLite serialises
   writes and is not suitable for multiple API instances.
2. **In-memory runtime sessions are not durable.** A crash or restart during a
   run leaves a stale `running` execution and a busy agent. Recovery requires
   manual cancellation or a future reconciliation job.
3. **Mock runtime only.** Progress and logs are simulated; there is no real
   agent process, model call, or repository mutation.
4. **Test API gating depends on environment.** It must never be deployed with
   `E2E_TEST_MODE=true`. The check includes `NODE_ENV!=production`, but a
   misconfigured staging deployment could still expose it.
5. **Serial E2E.** All Playwright tests share one API and database, so
   `workers: 1` is required. A parallel CI matrix would need isolated databases
   and ports per worker.
6. **Visual baseline is platform-specific.** The committed snapshot is
   `chromium-win32` at 1440×900. Font rasterisation can differ on Linux/macOS;
   regenerate baselines per platform or run visual tests in a pinned container.
7. **Pinned Chromium revision.** The config prefers cached Chromium 1228 for
   stable screenshots and falls back to Playwright’s default. A machine without
   either must install a browser or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
8. **Toast timing.** Toasts last 4.5 s. Tests assert them promptly; long flows
   should assert durable UI state instead.
9. **Activity list scope.** `GET /api/activities` is not filtered by workspace
   because the product is single-workspace today.
10. **No pagination UI.** Lists request up to the API default limit (50 agents,
    100 tasks, 50 executions); the UI does not expose pagination controls.
11. **Curly quotes in activity summaries.** Summaries use typographic quotes for
    readability; consumers should treat them as display strings, not parse them.
12. **No auth on Socket.IO.** The gateway accepts all connections allowed by CORS
    and has no token/handshake validation.
13. **Single production JS chunk.** Vite reports a 572 kB minified entry bundle
    (166 kB gzip) and suggests code splitting. This is acceptable for a local
    demo; a public deployment should lazy-load routes and vendor chunks.
14. **Execution-start serialization is in-process.** Concurrent starts are
    serialized safely for the single API instance used by this demo. Running
    multiple API instances would require a database constraint or distributed
    lock in addition to the in-process lock.

## Key files

| Concern                 | File                                                      |
| ----------------------- | --------------------------------------------------------- |
| Workspace scripts       | `package.json`                                            |
| Shared contracts        | `packages/contracts/src/{constants,types,schemas}.ts`     |
| Database schema         | `apps/api/prisma/schema.prisma`                           |
| Seed data               | `apps/api/src/common/seed/demo-data.ts`                   |
| Runtime seam            | `apps/api/src/modules/runtime/agent-runtime.interface.ts` |
| Mock runtime            | `apps/api/src/modules/runtime/mock-runtime.service.ts`    |
| Execution orchestration | `apps/api/src/modules/executions/executions.service.ts`   |
| Realtime gateway        | `apps/api/src/modules/events/events.gateway.ts`           |
| Render-error recovery   | `apps/web/src/components/error-boundary.tsx`              |
| Test API                | `apps/api/src/modules/test/test.controller.ts`            |
| UI interaction contract | `tests/contract/ui-interaction.contract.json`             |
| Playwright fixtures     | `tests/fixtures/{index,test-data-factory}.ts`             |
| Visual suite            | `tests/e2e/visual/visual.spec.ts`                         |
| Playwright config       | `playwright.config.ts`                                    |

## Recommended next steps

1. Add startup reconciliation for executions left `running` after a restart, or
   make runtime sessions durable.
2. Introduce a `CodexRuntime` adapter with explicit workspace allowlists,
   credentials, sandboxing, and process-tree cleanup; keep the HTTP surface
   shell-free.
3. Add authentication and workspace scoping before exposing the API beyond
   localhost.
4. Add pagination/virtualisation for large agent, task, and execution lists.
5. Run visual tests in a pinned container and maintain per-platform baselines.
6. Add CI with artifact upload for the Playwright report and screenshots.
7. Consider a partial unique index or transactional guard for concurrent
   execution starts if the app ever runs more than one API process.
