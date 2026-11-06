# Testing strategy and UI contract

Raft Lite is tested at four levels. The goal is not “many tests”; it is that every
primary flow is proven end-to-end against the real API, every invariant is proven
without a browser, and every UI affordance is addressable by a stable semantic
selector.

## Test pyramid

| Level                                     | Tool                    | Location                        | Count |
| ----------------------------------------- | ----------------------- | ------------------------------- | ----- |
| Shared contracts                          | Vitest                  | `packages/contracts/test`       | 5     |
| API integration + runtime + state machine | Vitest, Supertest       | `apps/api/test`, `apps/api/src` | 21    |
| Web component behavior                    | Vitest, Testing Library | `apps/web/src/test`             | 12    |
| Browser E2E                               | Playwright              | `tests/e2e`                     | 39    |

Browser E2E is split into three suites on purpose:

| Suite         | Location                  | Tests | Purpose                                                       |
| ------------- | ------------------------- | ----- | ------------------------------------------------------------- |
| Functional    | `tests/e2e/functional`    | 35    | CRUD, filters, workflow, errors, accessibility                |
| Business loop | `tests/e2e/business-loop` | 1     | One cross-page scenario: agent → task → execution → dashboard |
| Visual        | `tests/e2e/visual`        | 3     | Screenshot gallery, layout invariants, one visual baseline    |

## Commands

```bash
pnpm test          # contracts + API + web (38 tests)
pnpm test:e2e      # resets the E2E DB, starts isolated servers, runs 39 tests
pnpm test:e2e:ui   # Playwright UI mode
pnpm show-report   # open the latest HTML report

# Focused runs
pnpm exec playwright test tests/e2e/functional/tasks.spec.ts
pnpm exec playwright test tests/e2e/business-loop
pnpm exec playwright test tests/e2e/visual --update-snapshots
```

`pnpm test:e2e` runs `pretest:e2e`, which builds `@raft-lite/contracts` and resets
`apps/api/prisma/e2e.db`. Playwright then starts:

- API: `pnpm --filter @raft-lite/api start:e2e` on `127.0.0.1:3101`
- Web: `pnpm --filter @raft-lite/web dev:e2e` on `127.0.0.1:5174`

Both reuse an already-running local server unless `CI` is set.

## Test isolation

- Playwright uses `workers: 1`; the API and database are shared, so parallel
  workers would race the reset. This is a deliberate tradeoff for a single-machine
  demo, not an accident.
- The auto-used `resetSeed` fixture calls `POST /__test__/reset` before every
  test. Tests that need empty states call `factory.reset('empty')` themselves.
- API tests use `apps/api/prisma/test.db` via `apps/api/.env.test`; Playwright
  uses `apps/api/prisma/e2e.db` via `apps/api/.env.e2e`. Neither touches
  `dev.db`.
- The E2E web build uses `.env.e2e` (`VITE_API_PROXY_TARGET=
http://127.0.0.1:3101` and `VITE_SOCKET_URL=http://127.0.0.1:3101`), so REST
  and Socket.IO both target the test API. In development, empty
  `VITE_SOCKET_URL` means same-origin through the Vite proxy.
- Playwright runs in UTC, `en-US`, light color scheme, reduced motion, and a fixed
  1440×900 viewport. This removes timezone and font-motion drift from
  screenshots and date assertions.

## Test-only API

Registered only when `E2E_TEST_MODE=true` and `NODE_ENV!=production`:

| Endpoint                                | Purpose                                          |
| --------------------------------------- | ------------------------------------------------ |
| `POST /__test__/reset`                  | Clear all rows and reseed (`default` or `empty`) |
| `POST /__test__/seed`                   | Alias for reset                                  |
| `POST /__test__/runtime/mode`           | `auto` or `manual`                               |
| `POST /__test__/executions/:id/advance` | Step the script deterministically                |
| `POST /__test__/executions/:id/finish`  | Force success or failure                         |

The module is added to the Nest module graph only under that condition, so
production deployments return 404 for these routes. The endpoints cannot run
shell commands or access arbitrary files; they only manipulate the configured
SQLite database and the in-memory mock runtime.

## Deterministic runtime controls

The default mode is `auto`: five steps at `MOCK_TICK_MS` (650 ms in development,
100 ms for API tests, 250 ms for E2E). Each step emits one log and one progress
value (20/40/60/80/100) and the last step emits `completed`.

Tests that need exact intermediate state switch to `manual`:

```ts
await factory.setRuntimeMode('manual');
const { execution } = await factory.createRunningExecution();
await factory.advanceExecution(execution.id, 2); // progress 40, three logs
await factory.finishExecution(execution.id, 'success');
```

This drives the production code path (`ExecutionsService` → runtime events →
persistence → Socket.IO), so it does not bypass the behavior under test. The
`auto` mode is still covered by API tests and the business-loop E2E test.

## Fixtures and test-data factory

`tests/fixtures/index.ts` exposes:

- `factory`: `RaftTestFactory`, an API-backed data factory.
- `resetSeed`: auto-used fixture that resets the default seed before each test.

`tests/fixtures/test-data-factory.ts` creates ordinary domain data through the
public REST API — never by writing SQLite directly. It covers agents, tasks,
assignment, executions, logs, runtime mode, advance/finish, and unique names:

```ts
const agent = await factory.createAgent({ role: 'Release Steward' });
const task = await factory.createTask({ assigneeAgentId: agent.id });
const { execution } = await factory.createRunningExecution({
  task: { title: 'Capture the execution gallery' },
});
```

Because factory calls use the same validation and state machine as the UI, a
factory helper failing is a real API regression, not a fixture artifact.

## Machine-readable UI interaction contract

`tests/contract/ui-interaction.contract.json` is the single description of the
user-visible surface used by the E2E suites:

- routes and URL templates (`/tasks?task={taskId}`, `/executions/{executionId}`);
- selector definitions (`testId`, `role`, accessible name/pattern);
- required test IDs (the assignment’s mandatory list);
- five board lanes and the statuses mapped to each;
- UI state sets for forms, executions, agents, and tasks;
- canonical flows (`createAgent`, `createTask`, `startExecution`,
  `stopExecution`);
- test API endpoints, gating condition, and deterministic seed IDs.

`tests/support/ui-contract.ts` loads the contract at import time. It throws if a
required test ID has no selector definition, then exposes:

```ts
byTestId(page, 'agents.card');
bySelector(page, 'agents.create'); // getByRole when semantics exist
resolveTestId('taskBoard.lane', { lane: 'active' }); // task-lane-active
route('execution', { executionId: id });
```

`bySelector` prefers role + accessible name and falls back to `data-testid`, so
tests assert the same semantics a screen-reader user experiences rather than
CSS structure.

### Required test IDs

All of these are present and exercised:

| Test ID                  | Surface                                              |
| ------------------------ | ---------------------------------------------------- |
| `agent-create-button`    | Agents page primary action                           |
| `agent-list`             | Agent roster (`role="list"`)                         |
| `agent-card`             | Agent card button (`aria-label="View agent {name}"`) |
| `task-create-button`     | Tasks page primary action                            |
| `task-board`             | Five-lane Kanban board                               |
| `task-card`              | Task card button (`aria-label="Open task {title}"`)  |
| `task-detail-panel`      | Task detail drawer (`role="dialog"`)                 |
| `execution-start-button` | Start execution in task detail                       |
| `execution-stop-button`  | Cancel execution on the execution page               |
| `execution-log`          | Live log viewer (`role="log"`, accessible name)      |

### Naming rules

- Lowercase kebab-case, stable across refactors: `agent-create-button`,
  `execution-start-button`.
- Namespaced keys in the contract use dots (`agents.create`, `taskForm.submit`)
  and resolve to the kebab-case DOM attribute.
- Dynamic IDs use `{placeholder}` templates and are interpolated by the helper.
- Test IDs are for selecting behavior; assertions still prefer visible text,
  roles, `data-status`, and ARIA values.

## What the E2E suites cover

### Functional (35)

- **Agents (7)**: create via keyboard-accessible dialog and persist; search and
  status filters plus empty filter state; profile/current task/execution history;
  edit role and status; delete through confirmation; deleting an agent resets its
  active tasks to Todo and closes the detail drawer; empty roster state.
- **Dashboard (6)**: metrics, recent tasks, activity, agent status; navigation
  between routes; create-task entry point; empty workspace states; recoverable
  dashboard error; error toast variant preserved after failed refresh.
- **Error states (8)**: agent list failure + retry; task board failure + retry;
  server error inside an open form; task detail failure + retry; offline agent
  blocked from starting; execution detail failure + retry; log stream failure
  with focused retry; missing execution state.
- **Executions (4)**: start → deterministic progress/logs → completion; cancel
  through confirmation; forced failure with reason and error log; seeded history
  with task link and accessible log semantics.
- **Tasks (10)**: five-lane board with exact statuses and counts; create and
  persist; search/filter/empty filter; status workflow; assign/unassign;
  edit brief and priority; cancel with nested alert dialog and Escape
  preservation; delete only after confirmation; empty board; task-not-found.

### Business loop (1)

One test creates an agent, creates and assigns a task, starts an execution,
watches it complete, verifies the task moved to Done, then verifies the dashboard
metrics and activity feed reflect the new state. This guards cross-page
integration and cache invalidation that isolated tests can miss.

### Visual (3)

- Dashboard at 1440×900, 1280×800, and 1920×1080 with a page-overflow assertion
  and one committed baseline at 1440×900 (`maxDiffPixelRatio: 0.02`).
- Agents, agent detail, tasks board, task detail, create-task dialog, and
  create-agent dialog, each captured with an overflow check; the five board lanes
  are asserted to share the same top edge.
- Running and completed execution states captured with live logs; progress and
  log counts are asserted before capture.

Screenshots are written to `docs/screenshots/` by the suite. The baseline lives
under `tests/e2e/visual/visual.spec.ts-snapshots/`.

### Regression guards

The latest hardening pass adds targeted coverage for:

- **Concurrent starts** — two starts for the same task, or two tasks targeting
  the same agent, produce one `201` and one `409` (API).
- **Start rollback** — a runtime rejection marks the execution `failed`, restores
  the task and agent, writes an error log and activity, and a retry succeeds
  (API).
- **Agent deletion cleanup** — active assigned tasks return to `todo`, other
  agents' tasks are untouched, and `task.updated` events are emitted (API).
- **Agent drawer closure** — deleting an agent closes the open detail drawer
  (E2E).
- **Terminal session cleanup** — the mock runtime releases sessions on stop or
  finish and `getStatus` returns `null` afterwards (unit).
- **Render recovery** — the top-level `ErrorBoundary` shows a reload fallback
  instead of a blank page (web unit).

## Accessibility and interaction guarantees

The E2E suite verifies, not just describes:

- dialogs are `role="dialog"`/`role="alertdialog"` and focus the first field;
- Escape closes dialogs, including the nested cancel/delete alert dialogs;
- card actions are real buttons with accessible names, not hover-only divs;
- filters are labelled comboboxes and the search field is a labelled searchbox;
- the execution log is `role="log"` with an accessible name;
- progress is `role="progressbar"` with `aria-valuenow`;
- status changes are exposed through `data-status` and live status text;
- error surfaces use alerts and focusable retry actions;
- no primary action is hidden behind hover.

## Visual baseline workflow

```bash
# Regenerate screenshots and the committed baseline after an intentional UI change
pnpm exec playwright test tests/e2e/visual --update-snapshots

# Compare against the baseline without rewriting it
pnpm exec playwright test tests/e2e/visual
```

The visual suite is deterministic because it resets the seed, waits for fonts,
disables animations/caret during capture, fixes locale/timezone, and uses a
single worker. `playwright.config.ts` resolves `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
when set, otherwise prefers the cached Chromium 1228 build (the revision used to
capture the committed baseline), and finally lets Playwright use its default
browser. Pinning the revision keeps visual comparisons stable even after
`playwright install` adds a newer Chromium. Set the environment variable to use
a different browser build.

## Troubleshooting

| Symptom                                                | Cause / fix                                                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| API tests fail with “database disk image is malformed” | An interrupted run left a corrupt `test.db`. Delete `apps/api/prisma/test.db`, `test.db-wal`, and `test.db-shm`, then rerun.                          |
| E2E pretest fails with malformed `e2e.db`              | Same as above; delete the three `e2e.db*` files and rerun `pnpm test:e2e`. `apps/api/scripts/reset-database.mjs` removes stale sidecars before reset. |
| `EADDRINUSE` on 3101/5174                              | A previous Playwright server is still running. Stop it or let Playwright reuse it if healthy; CI requires free ports.                                 |
| Playwright cannot launch Chromium 1248                 | Use the cached 1228 fallback described above, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.                                                                |
| Socket status stays disconnected in E2E                | Check `apps/web/.env.e2e`: `VITE_SOCKET_URL` must point at `http://127.0.0.1:3101`; the E2E web server must bind `127.0.0.1`.                         |
| Old toast assertions fail late in a flow               | Toasts live 4.5 s. Assert the toast immediately after the action, or assert durable UI state instead.                                                 |
| Visual snapshot fails after a UI change                | Inspect `test-results` diff, confirm the change is intentional, then run with `--update-snapshots`.                                                   |
| Contract helper throws unknown selector                | Add the selector to `ui-interaction.contract.json`; required IDs are validated automatically on load.                                                 |
| API says `E2E_TEST_MODE` endpoints are 404             | Start with `NODE_ENV=test` and `E2E_TEST_MODE=true` (the E2E scripts do this).                                                                        |

## CI guidance

A minimal pipeline:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
pnpm build
```

Run E2E serially, keep `docs/screenshots` and the visual baseline in the
artifact set, and publish the Playwright HTML report on failure. If the runner
lacks Chromium 1248, either install it or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a compatible build.
