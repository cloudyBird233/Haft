# Testing strategy and UI contract

Raft Lite is tested at five levels. The goal is not “many tests”; it is that every
primary flow is proven end-to-end against the real API, every invariant is proven
without a browser, and every UI affordance is addressable by a stable semantic
selector.

## Test pyramid

| Level                                     | Tool                    | Location                        |
| ----------------------------------------- | ----------------------- | ------------------------------- |
| Shared contracts                          | Vitest                  | `packages/contracts/test`       |
| API integration + runtime + state machine | Vitest, Supertest       | `apps/api/test`, `apps/api/src` |
| Runner unit tests                         | Vitest                  | `apps/runner/test`              |
| Web component behavior                    | Vitest, Testing Library | `apps/web/src/test`             |
| Browser E2E                               | Playwright              | `tests/e2e`                     |

Current test counts are produced by CI from native Vitest/Playwright JSON
reports (see [Continuous integration](#continuous-integration)); they are not
maintained by hand in this document.

Browser E2E is split into three suites on purpose:

| Suite         | Location                  | Purpose                                                       |
| ------------- | ------------------------- | ------------------------------------------------------------- |
| Functional    | `tests/e2e/functional`    | CRUD, filters, workflow, errors, accessibility, Fake Runner   |
| Business loop | `tests/e2e/business-loop` | One cross-page scenario: agent → task → execution → dashboard |
| Visual        | `tests/e2e/visual`        | Screenshot gallery, layout invariants, one visual baseline    |

The opt-in real CLI suite lives outside `tests/e2e`, runs separately, and is
never counted in the deterministic suite. Results are always reported by layer:
API + deterministic runtime and UI + deterministic runtime (Mock Runtime plus
the Fake Runner) are covered by `pnpm test` / `pnpm test:e2e`; API + real CLI and
UI + real CLI are covered only by `pnpm test:e2e:real`, and a gated skip is never
reported as a pass.

## Commands

```bash
pnpm test          # contracts + API + runner + web
pnpm test:e2e      # resets the E2E DB, starts isolated servers + Fake Runner
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
dispatch, stale-runner reconciliation, duplicate log handling, diff persistence,
diff idempotency, and rejection of Git results from a non-owning runner.

### Git diff coverage

- `apps/runner/test/git-worktree.spec.ts` creates real temporary repositories and
  covers modified, added, deleted, renamed, untracked, binary, empty, and
  over-limit patches, plus worktree retention and repository-root rejection.
- `apps/api/test/runner.integration.spec.ts` asserts the diff metadata and patch
  are persisted separately, the diff endpoint returns the stored artifact,
  over-limit multibyte patches are cut to the byte cap and marked truncated,
  duplicate terminal messages are idempotent, and an intruder runner cannot
  submit Git evidence.
- `apps/web/src/test/diff-parser.test.ts` covers file/status/rename/binary
  parsing; `changes-panel.test.tsx` covers loading, empty, populated, and error
  states.
- `tests/e2e/functional/runner-execution.spec.ts` asserts the Changes tab
  selectors, statuses, diff content, and truncation badge against the Fake
  Runner.

### Runner crash-recovery coverage

- `execution-journal.spec.ts` — complete record round-trip, atomic recovery with
  a crashed temp file, corrupt-file quarantine, terminal pruning.
- `log-spool.spec.ts` — ordered persistence, duplicate suppression, ACK cleanup,
  crash recovery with a partial final line (including repair before the next
  append), size caps, replay limit.
- `protocol-event-queue.spec.ts` — a log send and its terminal event wait for a
  durable append, executions do not block each other, and a failed event does not
  stall the queue.
- `recovery.spec.ts` — interruption reporting, worktree/log preservation,
  worktree-presence reporting when the path is gone, PID start-time
  verification, PID-reuse protection, ownership mismatch, unverified identity,
  orphan tree termination, and no replay of terminal journals.
- `process-identity.spec.ts` — live start marker/command line, exit waiting, and
  process-tree termination.
- `real-executor.spec.ts` — a real-executor child-close wait, graceful-to-forced
  escalation after the shutdown grace window, and an incomplete-cleanup report
  when the child never confirms termination.
- `fake-executor.spec.ts` — shutdown waits for session termination and reports a
  clean result instead of relying on a fixed delay.

## Real CLI E2E (opt-in)

Real CLI execution has a completely separate Playwright project with three
tests: a Codex API flow, a Codex browser-UI flow, and a separately gated OpenCode
API flow.

```bash
# Codex API + Codex UI; the OpenCode test is skipped unless explicitly enabled.
HAFT_REAL_CLI_E2E=1 pnpm test:e2e:real

# All three, with an explicit OpenCode model.
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
| Web           | `http://127.0.0.1:5274`                                  |
| Runner health | `http://127.0.0.1:3299`                                  |
| Database      | `apps/api/prisma/real-e2e.db`                            |
| Runner id     | `runner_real_e2e`                                        |
| Project       | disposable Git repo at `test-results/real-e2e/workspace` |
| Worktrees     | `test-results/real-e2e/worktrees` (kept for assertions)  |
| Recovery      | `test-results/real-e2e/recovery`                         |
| Mode          | `real`, runtimes `codex,opencode`, timeout 600 s         |

`tests/e2e-real/prepare-project.mjs` creates the disposable repository.
`tests/e2e-real/real-cli.spec.ts` starts a real task through the API and
`tests/e2e-real/real-ui.spec.ts` drives the real browser UI end to end:

- creates the Codex agent and an unassigned task through the UI;
- assigns the task to the agent through task detail and verifies the API state;
- starts from task detail, waits for a parsed Codex log event, live logs, and a
  `completed` banner;
- verifies task `done` and agent `idle`;
- opens the Changes tab and asserts branch, base/head commit, changed file,
  unified diff content, and `diffTruncated=false`;
- asserts the marker file exists inside the worktree with the expected content;
- asserts the primary checkout has the same HEAD, commit count, `git status`, and
  remote configuration, and that the execution branch never moved past the base
  commit (no commit, merge, or push);
- asserts logs contain the isolated-worktree and successful-exit messages, a
  parsed CLI event (`Codex thread started`/`turn started`/`turn completed`), and
  unique `seq` values.

The UI suite uses `apps/web/.env.real-e2e` and a Vite proxy targeting port 3201.
Both suites use their own runner token file, database, ports, worktree root, and
recovery root, so they cannot affect the deterministic E2E database or the
user's real repositories.

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
  `stopExecution`, `inspectExecutionChanges`);
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

| Test ID                    | Surface                                              |
| -------------------------- | ---------------------------------------------------- |
| `agent-create-button`      | Agents page primary action                           |
| `agent-list`               | Agent roster (`role="list"`)                         |
| `agent-card`               | Agent card button (`aria-label="View agent {name}"`) |
| `task-create-button`       | Tasks page primary action                            |
| `task-board`               | Five-lane Kanban board                               |
| `task-card`                | Task card button (`aria-label="Open task {title}"`)  |
| `task-detail-panel`        | Task detail drawer (`role="dialog"`)                 |
| `execution-start-button`   | Start execution in task detail                       |
| `execution-stop-button`    | Cancel execution on the execution page               |
| `execution-log`            | Live log viewer (`role="log"`, accessible name)      |
| `execution-changes-tab`    | Changes tab (`role="tab"`, name `Changes`)           |
| `execution-changed-files`  | Changed-file list in the diff panel                  |
| `execution-diff-panel`     | Git diff panel                                       |
| `execution-diff-file`      | One parsed file patch (`data-status`, `data-path`)   |
| `execution-diff-content`   | Unified patch text for one file                      |
| `execution-diff-truncated` | Truncation badge (`data-truncated`)                  |

### Naming rules

- Lowercase kebab-case, stable across refactors: `agent-create-button`,
  `execution-start-button`.
- Namespaced keys in the contract use dots (`agents.create`, `taskForm.submit`)
  and resolve to the kebab-case DOM attribute.
- Dynamic IDs use `{placeholder}` templates and are interpolated by the helper.
- Test IDs are for selecting behavior; assertions still prefer visible text,
  roles, `data-status`, and ARIA values.

## What the E2E suites cover

### Functional

- **Agents**: create via keyboard-accessible dialog and persist; search and
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

### Business loop

One test creates an agent, creates and assigns a task, starts an execution,
watches it complete, verifies the task moved to Done, then verifies the dashboard
metrics and activity feed reflect the new state. This guards cross-page
integration and cache invalidation that isolated tests can miss.

### Visual

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
- **Diff ownership, persistence, and caps** — a non-owning runner cannot submit
  Git evidence, duplicate terminal messages are idempotent, an over-limit
  multibyte patch is cut to the byte cap and marked truncated, and the patch is
  stored as a separate artifact rather than in `ExecutionDto` (API).
- **Append-before-send ordering** — a log send and its terminal event wait for a
  durable spool append, executions are independent, and a failed event does not
  stall later events (runner unit).
- **Crash recovery** — journals/spools survive crashes, corrupt files are
  quarantined, PID reuse and ownership mismatches are left untouched, verified
  orphans are terminated, worktrees/logs are preserved, and interrupted runs are
  never replayed (runner unit).
- **Shutdown termination** — the fake and real executors wait for actual
  session/child termination, escalate after the grace window, and report
  incomplete cleanup instead of relying on a fixed delay (runner unit).

## Accessibility and interaction guarantees

The E2E suite verifies, not just describes:

- dialogs are `role="dialog"`/`role="alertdialog"` and focus the first field;
- Escape closes dialogs, including the nested cancel/delete alert dialogs;
- card actions are real buttons with accessible names, not hover-only divs;
- filters are labelled comboboxes and the search field is a labelled searchbox;
- the execution log is `role="log"` with an accessible name;
- progress is `role="progressbar"` with `aria-valuenow`;
- status changes are exposed through `data-status` and live status text;
- the Logs/Changes views are real `role="tab"` controls with matching tabpanels;
- diff files expose `data-status`/`data-path`, and binary files set
  `data-binary="true"` and render an explicit binary hint;
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

| Symptom                                                | Cause / fix                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API tests fail with “database disk image is malformed” | An interrupted run left a corrupt `test.db`. Delete `apps/api/prisma/test.db`, `test.db-wal`, and `test.db-shm`, then rerun.                                                                                                                    |
| E2E pretest fails with malformed `e2e.db`              | Same as above; delete the three `e2e.db*` files and rerun `pnpm test:e2e`. `apps/api/scripts/reset-database.mjs` removes stale sidecars before reset.                                                                                           |
| `EADDRINUSE` on 3101/5174                              | A previous Playwright server is still running. Stop it or let Playwright reuse it if healthy; CI requires free ports.                                                                                                                           |
| `EADDRINUSE` on 3201/5274/3299 (real E2E)              | Stop a previous real E2E API/web/runner. The real config never reuses servers, so a stale process always fails fast.                                                                                                                            |
| Stale recovery journal after a crash                   | Inspect `test-results/real-e2e/recovery` (real suite) or `~/.haft/recovery/<runnerId>`; it is evidence, not state. The next runner start reports it and never re-runs it.                                                                       |
| Playwright cannot launch Chromium 1248                 | Use the cached 1228 fallback described above, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.                                                                                                                                                          |
| Socket status stays disconnected in E2E                | Check `apps/web/.env.e2e`: `VITE_SOCKET_URL` must point at `http://127.0.0.1:3101`; the E2E web server must bind `127.0.0.1`.                                                                                                                   |
| Old toast assertions fail late in a flow               | Toasts live 4.5 s. Assert the toast immediately after the action, or assert durable UI state instead.                                                                                                                                           |
| Visual snapshot fails after a UI change                | Inspect `test-results` diff, confirm the change is intentional, then run with `--update-snapshots`.                                                                                                                                             |
| Contract helper throws unknown selector                | Add the selector to `ui-interaction.contract.json`; required IDs are validated automatically on load.                                                                                                                                           |
| API says `E2E_TEST_MODE` endpoints are 404             | Start with `NODE_ENV=test` and `E2E_TEST_MODE=true` (the E2E scripts do this).                                                                                                                                                                  |
| Fake Runner never becomes ready on 3199                | Check the API bootstrap token matches `E2E_RUNNER_BOOTSTRAP_TOKEN`; delete the cached `test-results/.runner/runner-e2e.json` and rerun.                                                                                                         |
| `/api/runtimes` says `CLI_NOT_INSTALLED`               | Install the CLI on the runner host or set `HAFT_CODEX_BIN` / `HAFT_OPENCODE_BIN` to an explicit executable path.                                                                                                                                |
| `/api/runtimes` says `CLI_NOT_AUTHENTICATED`           | Run `codex login` or `opencode auth login` on the runner host, then restart the runner so capabilities are probed again.                                                                                                                        |
| `/api/runtimes` says `PROJECT_NOT_MAPPED`              | Add the task's project id to `HAFT_RUNNER_PROJECTS` (JSON map of project id → repository path) and restart the runner.                                                                                                                          |
| Real execution fails with `PROJECT_NOT_GIT_ROOT`       | The mapped path must be the root of a Git repository with at least one commit. Worktrees are created from `HEAD`.                                                                                                                               |
| Windows unit tests fail with `PROJECT_NOT_GIT_ROOT`    | The hosted Windows runner can expose an 8.3 alias such as `C:\Users\RUNNER~1\...` via `TEMP`, which Git's canonical `--show-toplevel` does not match. CI sets `TMP`/`TEMP`/`TMPDIR` to `runner.temp` for the unit step; keep that env in place. |
| Real execution fails with `BRANCH_EXISTS`              | An earlier execution branch `haft/<executionId>` still exists; delete it or keep worktrees and choose a fresh execution.                                                                                                                        |
| Real execution fails with `WORKTREE_EXISTS`            | A stale worktree directory remains under the worktree root; remove it with `git worktree remove --force <path>` (or `git worktree prune`) and retry.                                                                                            |
| Prisma logs `Socket timeout` during E2E                | Test DB URLs use `connection_limit=1&socket_timeout=20` and the API sets `busy_timeout=15000`. If it still appears, stop stray API/Prisma processes and rerun.                                                                                  |
| Real CLI E2E skipped despite `HAFT_REAL_CLI_E2E=1`     | The runner probe marked the runtime unavailable. Inspect `/api/runtimes` on `:3201` and the runner log; a skip is not a pass.                                                                                                                   |

## Continuous integration

The Phase 2 CI foundation consists of two workflows. Neither workflow may claim a
pass without evidence: counts come from native reports, a skipped real CLI test is
not a pass, and an unavailable audit endpoint is an infrastructure failure. CI
pins Node.js `22.14.0` and pnpm `11.5.2`; pnpm 11 requires Node.js `>=22.13`.

### Pull request / main workflow (`ci.yml`)

| Property    | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Triggers    | `pull_request`, push to `main`, `workflow_dispatch`                      |
| Never       | `pull_request_target`, hosted fallback for real CLI, `continue-on-error` |
| Permissions | `contents: read`                                                         |
| Concurrency | Superseded pull-request runs are cancelled                               |

Jobs:

| Job        | Runner                             | What it proves                                                     |
| ---------- | ---------------------------------- | ------------------------------------------------------------------ |
| `static`   | `ubuntu-latest`                    | lint, typecheck, changed-file formatting, build                    |
| `unit`     | `ubuntu-latest` + `windows-latest` | all deterministic Vitest layers, each layer reported independently |
| `e2e`      | `ubuntu-latest`                    | Chromium + Fake Runner browser suite, no real CLI                  |
| `security` | `ubuntu-latest`                    | lockfile drift + production audit + `git diff --check`             |
| `summary`  | `ubuntu-latest`                    | report completeness, dynamic totals, required-job gate             |

`pnpm install --frozen-lockfile` is used everywhere, and Prisma Client is
generated explicitly before typecheck, build, and tests because the lockfile
install does not run `prisma generate`. The unit jobs also build
`packages/contracts` before the four test layers; API, runner, and web import its
`dist` output, which does not exist in a clean checkout.

Formatting: `pnpm format:check` runs
`scripts/acceptance/check-format.mjs`. It compares the working tree against
`scripts/acceptance/format-baseline.json` and fails if a changed file is not
Prettier-clean. The baseline contains legacy debt inherited from the frozen
baseline; it must shrink as owning tasks format their files. Use
`pnpm exec prettier --write <file>` on files your task owns. Never mass-format
another task's source to clear the baseline. `pnpm format:check:all` is the
non-grandfathered, whole-repository view. Regenerate the debt list only with
`node scripts/acceptance/check-format.mjs --write-baseline` after an explicit
repository decision.

Production audit: the security job runs
`node scripts/acceptance/security-audit.mjs` against
`https://registry.npmjs.org` because the default mirror may not expose an audit
endpoint. High/critical findings block unless
`scripts/acceptance/audit-exemptions.json` contains a matching entry with
`reason`, `owner`, and a future `expiresAt`. Expired exemptions fail closed.
Moderate/low findings are reported but do not block. When an audit call itself
fails, the job reports `BLOCKED`; it never reports `PASS`.

### Reports and artifacts

- Vitest and Playwright emit JSON/JUnit only when `CI_TEST_REPORT_DIR` is set, so
  local `pnpm test` output is unchanged.
- `scripts/acceptance/run-unit-tests.mjs` runs contracts, API, runner, and web
  independently and writes `orchestration.json`; one failing layer does not hide
  the others.
- `scripts/acceptance/summarize-ci.mjs` writes `test-summary.json`,
  `test-summary.md`, and `metadata.json`, appends the Markdown to the GitHub job
  summary, and fails when a required layer/platform report is missing or failed.
- Artifacts: `unit-<os>`, `e2e-playwright`, `e2e-reports`, `static-report`,
  `security-report`, and `ci-summary`, retained for 14 days and uploaded with
  `if: always()`.
- Uploads set `overwrite: true`. Re-running a failed job replaces its
  same-named artifact, so the summary cannot silently download an older report
  from a previous run attempt.
- Upload exclusions: `.env` files, SQLite databases, `test-results/.runner/**`
  runner tokens, and `auth.json` CLI credentials.
- The visual suite keeps per-platform Playwright snapshots. CI uses
  `dashboard-1440x900-chromium-linux.png`; regenerate it on Linux with
  `pnpm exec playwright test tests/e2e/visual/visual.spec.ts --grep "dashboard layout is stable" --update-snapshots`
  after an intentional layout change. Keep the Windows baseline as well.

### Real CLI workflow (`real-cli.yml`)

`real-cli.yml` is deliberately separate:

- `workflow_dispatch` only, with a full 40-character commit SHA, a pinned Codex
  version, and an optional OpenCode model;
- protected GitHub environment `real-cli` with required reviewers and deployment
  branch restrictions;
- self-hosted runner label `haft-real-cli-ephemeral`; there is no hosted-runner
  fallback;
- isolated low-privilege user, `HOME`, `CODEX_HOME`, `TMPDIR`, XDG directories,
  database (`real-e2e.db`), ports (`3201/5274/3299`), disposable repository,
  worktree root, and recovery root; the optional environment variable
  `HAFT_REAL_CLI_ALLOWED_USER` pins the dedicated account and rejects any other
  user;
- the environment secret `HAFT_CODEX_AUTH_JSON` is materialized into the isolated
  `CODEX_HOME/auth.json` in a separate step. It is never printed, never written
  into the repository, never passed to the test step, and is removed by cleanup;
- the personal `~/.codex` is never used;
- a fail-closed preflight verifies the runner is self-hosted, the user is not
  root/Administrator, the home and Codex home are isolated, the commit matches and
  is reachable from `origin/main`, the checkout is clean, the pinned CLI version
  and optional SHA256 match, authentication works, the ports are free, and no
  previous test state exists;
- `scripts/acceptance/real-cli-report.mjs` validates the Playwright JSON report
  and the preflight record. A missing report or a missing/blocked preflight
  produces `BLOCKED`; required tests that are skipped or flaky never produce
  `PASS`;
- evidence is collected, redacted, hashed (`manifest.json`, `sha256.txt`), and
  uploaded with 30-day retention; cleanup runs under `if: always()` and uploads a
  separate cleanup record.

A real CLI run is PASS only when the preflight is PASS, both required Codex tests
(API and UI) pass, and the report/manifest exist. OpenCode remains optional and
explicitly enabled.

### Branch protection (administrator step)

Workflow files cannot protect a branch. In **Settings → Branches**, protect
`main` and require the checks `Static checks`, `Unit tests (ubuntu-latest)`,
`Unit tests (windows-latest)`, `Browser E2E (Fake Runner)`,
`Security and whitespace gates`, and `CI summary`. Require branches to be up to
date, and block force pushes and deletions. Create the protected `real-cli`
environment separately with reviewers, branch restrictions, and the environment
secret/variables described above.

### Local parity

```bash
pnpm install --frozen-lockfile
pnpm --filter @raft-lite/api exec prisma generate
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

Run the real CLI suite only on the dedicated isolated host. Never run it on a
developer machine with personal CLI credentials, and never fold it into the
deterministic PR pipeline.

### CI troubleshooting

| Symptom                                 | Cause / fix                                                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` lists legacy files       | They are expected baseline debt. Only reformat files owned by your task; if a new file appears, format it.                                                                             |
| `security` job says `BLOCKED`           | The audit endpoint was unreachable or returned non-JSON. Fix registry/network access; do not treat it as a pass.                                                                       |
| Unit report missing in summary          | The artifact upload or matrix job failed. Re-run the layer and confirm `CI_TEST_REPORT_DIR` is absolute.                                                                               |
| E2E report exists but status is `empty` | Playwright ran no tests (for example, a web-server startup failure). Inspect `test-results` and the job log.                                                                           |
| Windows-only unit failure               | Reproduce locally on Windows; check path separators and file-locking in the failing layer. Linux PASS does not imply Windows PASS.                                                     |
| Known E2E flake: task delete            | `tasks.spec.ts` occasionally times out waiting for the detail delete action and passes on the configured CI retry. Inspect the trace; a retry is visible as `flaky`, not a clean pass. |
| Real CLI preflight `BLOCKED`            | Check the runner label/environment, isolated `HOME`/`CODEX_HOME`, pinned version/SHA256, auth file, ports, and clean checkout. Missing prerequisites are blocked, not skipped.         |
| Real CLI report `SKIPPED`               | The runtime probe marked the CLI unavailable. Fix installation/authentication; a skip is not acceptance evidence.                                                                      |
