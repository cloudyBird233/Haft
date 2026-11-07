# Testing strategy and UI contract

Raft Lite is tested at four levels. The goal is not “many tests”; it is that every
primary flow is proven end-to-end against the real API, every invariant is proven
without a browser, and every UI affordance is addressable by a stable semantic
selector.

## Test pyramid

| Level                                     | Tool                    | Location                        | Count |
| ----------------------------------------- | ----------------------- | ------------------------------- | ----- |
| Shared contracts                          | Vitest                  | `packages/contracts/test`       | 5     |
| API integration + runtime + state machine | Vitest, Supertest       | `apps/api/test`, `apps/api/src` | 26    |
| Runner unit tests                         | Vitest                  | `apps/runner/test`              | 29    |
| Web component behavior                    | Vitest, Testing Library | `apps/web/src/test`             | 12    |
| Browser E2E                               | Playwright              | `tests/e2e`                     | 42    |

Browser E2E is split into three suites on purpose:

| Suite         | Location                  | Tests | Purpose                                                       |
| ------------- | ------------------------- | ----- | ------------------------------------------------------------- |
| Functional    | `tests/e2e/functional`    | 38    | CRUD, filters, workflow, errors, accessibility, Fake Runner   |
| Business loop | `tests/e2e/business-loop` | 1     | One cross-page scenario: agent → task → execution → dashboard |
| Visual        | `tests/e2e/visual`        | 3     | Screenshot gallery, layout invariants, one visual baseline    |

The opt-in real CLI suite lives outside `tests/e2e`, runs separately, and is
never counted in the deterministic suite.

## Commands

```bash
pnpm test          # contracts + API + runner + web (72 tests)
pnpm test:e2e      # resets the E2E DB, starts isolated servers + Fake Runner, runs 42 tests
pnpm test:e2e:real # opt-in real Codex/OpenCode suite (HAFT_REAL_CLI_E2E=1)
pnpm test:e2e:ui   # Playwright UI mode
pnpm show-report   # open the latest HTML report

# Focused runs
pnpm exec playwright test tests/e2e/functional/tasks.spec.ts
pnpm exec playwright test tests/e2e/functional/runner-execution.spec.ts
pnpm exec playwright test tests/e2e/business-loop
pnpm exec playwright test tests/e2e/visual --update-snapshots
```

`pnpm test:e2e` runs `pretest:e2e`, which builds `@raft-lite/contracts` and resets
`apps/api/prisma/e2e.db`. Playwright then starts:

- API: `pnpm --filter @raft-lite/api start:e2e` on `127.0.0.1:3101`
- Web: `pnpm --filter @raft-lite/web dev:e2e` on `127.0.0.1:5174`
- Fake Runner: `pnpm --filter @raft-lite/runner start` with health on
  `127.0.0.1:3199`

API and web reuse an already-running local server unless `CI` is set. The Fake
Runner uses runner id `runner_e2e`, computer `computer_local`, project
`project_demo`, and a cached token under `test-results/.runner/`.

## Test isolation

- Playwright uses `workers: 1`; the API and database are shared, so parallel
  workers would race the reset. This is a deliberate tradeoff for a single-machine
  demo, not an accident.
- The auto-used `resetSeed` fixture calls `POST /__test__/reset` before every
  test. Tests that need empty states call `factory.reset('empty')` themselves.
  Resets clear workspace content but preserve `Computer` and `Runner` rows, so
  the paired Fake Runner survives the whole suite.
- API tests use `apps/api/prisma/test.db` via `apps/api/.env.test`; Playwright
  uses `apps/api/prisma/e2e.db` via `apps/api/.env.e2e`. Neither touches
  `dev.db`. Real CLI tests use `apps/api/prisma/real-e2e.db`.
- Test database URLs set `connection_limit=1&socket_timeout=20`, and
  `PrismaService` sets `PRAGMA busy_timeout = 15000`. This keeps a serial reset
  or a slow query from surfacing Prisma's default 5-second SQLite socket timeout
  when another connection is writing.
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

## Fake Agent Runner

The Fake Runner is a real runner process using the real protocol, but its
executor simulates work instead of spawning a CLI. It advertises `codex` and
`opencode` as installed/authenticated (`fake-1.0.0`) and walks a fixed six-step
script at `HAFT_RUNNER_STEP_MS` (default 250 ms):

| Step | Progress | Message                                               |
| ---- | -------- | ----------------------------------------------------- |
| 1    | 10       | Fake runner prepared an isolated worktree.            |
| 2    | 30       | Fake runner inspected repository conventions.         |
| 3    | 50       | Fake runner applied simulated implementation changes. |
| 4    | 70       | Fake runner updated simulated tests.                  |
| 5    | 85       | Fake runner validated the simulated diff.             |
| 6    | 95       | Fake runner collected the simulated Git result.       |
| end  | 100      | `completed`, exit code 0, simulated Git result        |

Phases are `preparing` → `running` → `finalizing` → `completed`. Cancellation
logs a warning, waits at most `min(100, stepMs)`, sends
`execution.cancelled`, and the API waits for that confirmation before returning.

Deterministic failure triggers:

- task title contains `[fail]`, or
- task description contains `HAFT_FAKE_FAIL`, or
- the runner process has `HAFT_RUNNER_FAKE_FAIL=1`.

The Fake Runner is covered by three E2E tests in
`tests/e2e/functional/runner-execution.spec.ts`: successful execution through the
protocol and task completion, cancellation waiting for a runner confirmation,
and deterministic failure propagation to task/agent state and logs. API-level
protocol tests in `apps/api/test/runner.integration.spec.ts` cover pairing,
dispatch, stale-runner reconciliation, and duplicate log handling.

## Real CLI E2E (opt-in)

Real CLI execution has a completely separate Playwright project:

```bash
# Codex only; OpenCode test is skipped unless explicitly enabled.
HAFT_REAL_CLI_E2E=1 pnpm test:e2e:real

# Both CLIs, with an explicit OpenCode model.
HAFT_REAL_CLI_E2E=1 \
HAFT_REAL_E2E_OPENCODE=1 \
HAFT_REAL_OPENCODE_MODEL=tvt/tvt-deepseek-v4.1-flash \
pnpm test:e2e:real
```

It uses:

| Concern       | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Config        | `playwright.real.config.ts`                              |
| API           | `http://127.0.0.1:3201`                                  |
| Runner health | `http://127.0.0.1:3299`                                  |
| Database      | `apps/api/prisma/real-e2e.db`                            |
| Runner id     | `runner_real_e2e`                                        |
| Project       | disposable Git repo at `test-results/real-e2e/workspace` |
| Worktrees     | `test-results/real-e2e/worktrees` (kept for assertions)  |
| Mode          | `real`, runtimes `codex,opencode`, timeout 600 s         |

`tests/e2e-real/prepare-project.mjs` creates the one-time repository. Each test
starts a real task, waits for a terminal state, and asserts:

- the execution is `completed`, `phase` is `completed`, `runnerId` is
  `runner_real_e2e`, the branch is `haft/<executionId>`, exit code is 0, and a
  summary exists;
- the task is `done` and the agent is `idle`;
- the marker file exists inside the worktree with the expected content;
- the primary checkout was not modified;
- logs contain the isolated-worktree and successful-exit messages, and `seq`
  values are unique.

Codex and OpenCode are installed and authenticated on the runner host. The runner
probes capabilities at startup; if a CLI is unavailable or unauthenticated, the
affected test is skipped with the reason rather than failing or faking success.
A skipped real CLI test is not evidence of a passing real execution; manual
acceptance must be recorded in [REPORT.md](REPORT.md).

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

### Functional (38)

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
- **Fake Runner (3)**: Codex execution through the runner protocol; cancellation
  waits for runner confirmation; deterministic failure propagation.
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
- **Runner recovery** — a reconnect snapshot fails missing executions with
  `RUNNER_RESTARTED`, skips executions created after the connection, and rejects
  events from a runner that does not own the execution (API).
- **Runner log idempotency** — duplicate `messageId`/`eventId` replays do not
  duplicate logs, and server `seq` stays unique (API + runner unit).

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

| Symptom                                                | Cause / fix                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API tests fail with “database disk image is malformed” | An interrupted run left a corrupt `test.db`. Delete `apps/api/prisma/test.db`, `test.db-wal`, and `test.db-shm`, then rerun.                                   |
| E2E pretest fails with malformed `e2e.db`              | Same as above; delete the three `e2e.db*` files and rerun `pnpm test:e2e`. `apps/api/scripts/reset-database.mjs` removes stale sidecars before reset.          |
| `EADDRINUSE` on 3101/5174                              | A previous Playwright server is still running. Stop it or let Playwright reuse it if healthy; CI requires free ports.                                          |
| Playwright cannot launch Chromium 1248                 | Use the cached 1228 fallback described above, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.                                                                         |
| Socket status stays disconnected in E2E                | Check `apps/web/.env.e2e`: `VITE_SOCKET_URL` must point at `http://127.0.0.1:3101`; the E2E web server must bind `127.0.0.1`.                                  |
| Old toast assertions fail late in a flow               | Toasts live 4.5 s. Assert the toast immediately after the action, or assert durable UI state instead.                                                          |
| Visual snapshot fails after a UI change                | Inspect `test-results` diff, confirm the change is intentional, then run with `--update-snapshots`.                                                            |
| Contract helper throws unknown selector                | Add the selector to `ui-interaction.contract.json`; required IDs are validated automatically on load.                                                          |
| API says `E2E_TEST_MODE` endpoints are 404             | Start with `NODE_ENV=test` and `E2E_TEST_MODE=true` (the E2E scripts do this).                                                                                 |
| Fake Runner never becomes ready on 3199                | Check the API bootstrap token matches `E2E_RUNNER_BOOTSTRAP_TOKEN`; delete the cached `test-results/.runner/runner-e2e.json` and rerun.                        |
| `/api/runtimes` says `CLI_NOT_INSTALLED`               | Install the CLI on the runner host or set `HAFT_CODEX_BIN` / `HAFT_OPENCODE_BIN` to an explicit executable path.                                               |
| `/api/runtimes` says `CLI_NOT_AUTHENTICATED`           | Run `codex login` or `opencode auth login` on the runner host, then restart the runner so capabilities are probed again.                                       |
| `/api/runtimes` says `PROJECT_NOT_MAPPED`              | Add the task's project id to `HAFT_RUNNER_PROJECTS` (JSON map of project id → repository path) and restart the runner.                                         |
| Real execution fails with `PROJECT_NOT_GIT_ROOT`       | The mapped path must be the root of a Git repository with at least one commit. Worktrees are created from `HEAD`.                                              |
| Real execution fails with `BRANCH_EXISTS`              | An earlier execution branch `haft/<executionId>` still exists; delete it or keep worktrees and choose a fresh execution.                                       |
| Real execution fails with `WORKTREE_EXISTS`            | A stale worktree directory remains under the worktree root; remove it with `git worktree remove --force <path>` (or `git worktree prune`) and retry.           |
| Prisma logs `Socket timeout` during E2E                | Test DB URLs use `connection_limit=1&socket_timeout=20` and the API sets `busy_timeout=15000`. If it still appears, stop stray API/Prisma processes and rerun. |
| Real CLI E2E skipped despite `HAFT_REAL_CLI_E2E=1`     | The runner probe marked the runtime unavailable. Inspect `/api/runtimes` on `:3201` and the runner log; a skip is not a pass.                                  |

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

Do not run `pnpm test:e2e:real` on a generic CI worker without provisioning and
authenticating both CLIs. It is a manual/self-hosted acceptance gate; the
deterministic Fake Runner suite already covers the protocol end to end.
