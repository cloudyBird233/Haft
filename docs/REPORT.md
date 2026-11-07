# Implementation report

## Summary

Haft Phase 1 is delivered as a runnable pnpm monorepo with three independently
deployable processes:

- a React 19 SPA;
- a NestJS REST + Socket.IO API backed by Prisma/SQLite;
- a Haft Agent Runner that owns local CLI processes, Git worktrees,
  cancellation, timeouts, and log replay.

The deterministic Mock Runtime and Fake Runner prove the complete product loop
without a model account. Real Codex and OpenCode execution is implemented,
isolated behind an opt-in E2E suite, and manually accepted on a prepared Windows
host. The server owns business state; the runner owns local execution and never
accesses the database.

Every primary flow writes through the real API and survives a reload: agent
create/edit/delete, task create/edit/assign/transition/cancel/delete, execution
start/progress/logs/complete/fail/cancel, activity history, runner dispatch,
Git evidence, and dashboard aggregation.

## Delivered scope

### Agent Runner and protocol

- Independent `apps/runner` Node.js process with `fake`, `real`, `codex`, and
  `opencode` modes.
- Versioned, strict Socket.IO protocol v1 on the `/runner` namespace:
  registration, heartbeat, snapshot, dispatch, acceptance, phase, log,
  progress, completion, failure, cancellation, reconcile, and log
  acknowledgement.
- One-time bootstrap pairing: the server stores only `sha256(token)` and issues
  a runner token; the runner caches it locally with restricted permissions.
- Capability probing for Codex/OpenCode (`--version`, auth checks) reported to
  the server and surfaced through runtime availability.
- Per-runner message ordering, `messageId` deduplication, log deduplication by
  `eventId`/`runnerSeq`, bounded pending-log buffers, and replay after reconnect.
- Optional loopback health endpoint (`/health`, `/ready`) for supervisors and
  tests.

### Server integration

- `Runner` Prisma model and incremental migration
  `20261107090000_runner_phase1`; existing execution data is preserved and
  terminal statuses are mapped to terminal phases.
- `RunnerRegistryService` for identity, pairing, connection state, dispatch,
  recovery, snapshots, and ownership checks.
- `RunnerRuntimeService` for codex/opencode behind the existing `AgentRuntime`
  seam.
- `RuntimeRegistryService` as the single runtime-selection point; no runtime
  name branching in `ExecutionsService`.
- `GET /api/runtimes` with `available`, `reasonCode`, runner status, CLI version,
  authentication, and project mappings.
- `GET /api/runners`, loopback-only by default, optional
  `x-haft-admin-token` protection.
- `Execution.phase`, `runnerId`, `exitCode`, `summary`, `branchName`,
  `baseCommit`, `headCommit`, `lastRunnerSeq`, `progressMode`, and structured
  `ExecutionLog` fields (`stream`, `eventId`, `runnerSeq`).

### Fake Runner

- Real runner process, real protocol, real persistence, deterministic simulated
  execution with six steps and phases `preparing` → `running` → `finalizing` →
  `completed`.
- Deterministic failure triggers (`[fail]` title, `HAFT_FAKE_FAIL` description,
  or `HAFT_RUNNER_FAKE_FAIL=1`).
- Three Playwright scenarios: successful protocol execution, cancellation
  waiting for runner confirmation, deterministic failure propagation.
- Runner/API integration tests for pairing, dispatch, reconciliation, and
  duplicate handling.

### Real CLI execution

- Codex: `exec --json --color never --ephemeral --sandbox workspace-write
-C <worktree> [-m model] -`; prompt on stdin; no sandbox bypass flag.
- OpenCode: `run --standalone --format json [-m model] [--agent name] [--auto]`;
  prompt on stdin; `--auto` only when `HAFT_RUNNER_ALLOW_AUTO_APPROVE=1`.
- No shell: every CLI and Git call uses an argv array with `shell: false`.
- Process-tree termination: POSIX process group, Windows `taskkill /T /F`.
- CLI timeout, cancellation confirmation, exit-code handling, JSONL parsing,
  ANSI stripping, and credential-pattern redaction.
- CLI child environment strips every `HAFT_*` and `E2E_RUNNER_*` variable; the
  runner token is never visible to a model process.

### Git isolation

- One worktree per execution: `<worktreeRoot>/<projectId>/<executionId>` on
  branch `haft/<executionId>`, created from the repository's current `HEAD`.
- Refuses non-Git roots, repositories without commits, existing branches, and
  existing worktree paths.
- Collects branch, base/head commit, changed-file count, diff stat, and status.
- Never commits, pushes, merges, or fetches.
- Keeps worktrees by default for review; `HAFT_RUNNER_KEEP_WORKTREES=0` removes
  and prunes them after collection.

### Recovery and cancellation

- Start rollback restores task/agent state, marks the execution failed, writes
  an error log/activity, and returns `RUNTIME_START_FAILED`.
- Heartbeats and a reconnect grace window keep executions alive across short
  disconnects.
- Snapshot reconciliation fails missing executions with `RUNNER_RESTARTED`,
  skips executions created after the current connection, and cancels executions
  the runner reports but the server no longer considers running.
- API restart marks runners offline and schedules reconciliation; nothing is
  re-dispatched automatically.
- Runner cancellation waits for `execution.cancelled`; otherwise the API returns
  `RUNNER_OFFLINE` or `RUNNER_CANCEL_TIMEOUT` and leaves the execution running.
- Logs are persisted before UI emission and replayed idempotently after
  reconnect.

### Runtime UX

- Task detail loads runtime availability for the assignee's computer and
  project.
- Start is blocked with a precise reason when the computer, runner, CLI,
  authentication, or project mapping is missing.
- Execution page shows phase, progress mode, exit code, summary, failure/cancel
  reasons, and Git branch metadata.

### Testability and documentation

- 72 deterministic unit/integration/component tests.
- 42 deterministic browser E2E tests, including three Fake Runner scenarios.
- Opt-in real CLI Playwright project with its own database, ports, runner id,
  disposable Git repository, and worktree root.
- Test reset preserves `Computer` and `Runner`, so a paired Fake Runner survives
  the suite.
- New documentation: runner architecture, protocol, setup, runtime integration,
  execution recovery, plus updated README, architecture, data model, API,
  testing, and this report.

## Requirements traceability

| Requirement                                             | Status | Evidence                                                          |
| ------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| Independent Agent Runner process                        | Done   | `apps/runner`, `pnpm runner:start`, `/runner` namespace           |
| Runner does not access the server database              | Done   | Runner has no Prisma dependency; API persists all runner events   |
| Server owns business state, runner owns local execution | Done   | `RunnerRegistryService` / `RunnerClient` boundary                 |
| Versioned runner protocol v1                            | Done   | `packages/contracts/src/runner-protocol.ts`, `runner-protocol.md` |
| One-time bootstrap token, hashed runner token           | Done   | `authenticate`, `tokenHash`, `TokenStore`                         |
| Default loopback-only runner management                 | Done   | `runner-access.ts`, `GET /api/runners`                            |
| Real Codex/OpenCode execution                           | Done   | `real-executor.ts`, `cli-args.ts`, manual acceptance below        |
| Git worktree isolation, no auto commit/push/merge       | Done   | `git-worktree.ts`; E2E asserts primary checkout untouched         |
| No shell interpolation or arbitrary web binary path     | Done   | `shell: false`, argv builders, runner-only `HAFT_*_BIN`           |
| Runner token never passed to CLI                        | Done   | `buildCliEnvironment` strips `HAFT_*`/`E2E_RUNNER_*`              |
| Codex never bypasses sandbox                            | Done   | `--sandbox workspace-write`; no bypass flag in `cli-args.ts`      |
| OpenCode `--auto` explicit opt-in                       | Done   | `allowAutoApprove` only from `HAFT_RUNNER_ALLOW_AUTO_APPROVE=1`   |
| Real-time logs and phases                               | Done   | protocol phase/log/progress, `/events`, execution page            |
| Cancellation confirmed by runner                        | Done   | `waitForExecutionTerminal`, `RUNNER_CANCEL_TIMEOUT`               |
| Recovery without unconditional re-run                   | Done   | snapshot reconciliation, `RUNNER_RESTARTED`/`RUNNER_DISCONNECTED` |
| Preserve Mock Runtime (auto/manual) and Test API        | Done   | existing runtime tests + 42 E2E tests still pass                  |
| Preserve API/UI contracts and existing behavior         | Done   | original suites pass; counts below                                |
| Incremental migration without data loss                 | Done   | second migration copies existing execution/log rows               |
| Fake Runner proven before real CLI                      | Done   | 3 E2E scenarios + 5 API runner integration tests                  |
| Independent real CLI tests                              | Done   | `playwright.real.config.ts`, `tests/e2e-real`                     |
| `HAFT_REAL_CLI_E2E=1` gate                              | Done   | both real CLI tests skip without it                               |
| Documentation set                                       | Done   | README + 10 docs, including five runner/recovery documents        |
| Windows/Linux/macOS portability                         | Done   | platform-aware executable resolution and process termination      |

## Validation

Validation was run on Windows with Node.js 24 and pnpm 11.

| Command              | Result                                                                        |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm test`          | Pass — 72 tests: 5 contracts, 26 API, 29 runner, 12 web                       |
| `pnpm test:e2e`      | Pass — 42 Playwright tests, 1 worker, 1.8 min; 0 `Socket timeout` occurrences |
| `pnpm build`         | Pass — contracts, API, web, and runner bundle                                 |
| `pnpm lint`          | Pass — ESLint, zero warnings                                                  |
| `pnpm typecheck`     | Pass — contracts, API, web, runner                                            |
| Real CLI E2E (Codex) | Pass — 1 passed (35.3 s), OpenCode skipped without opt-in                     |
| Real CLI E2E (both)  | Pass — Codex 30.2 s, OpenCode 15.2 s, 2 passed (1.3 min)                      |

The E2E run covers 38 functional tests (including 3 Fake Runner tests), 1
business-loop test, and 3 visual tests. The visual run regenerates screenshots in
`docs/screenshots/` and compares the dashboard 1440×900 capture against the
committed baseline.

### Real CLI manual acceptance

Environment: Windows, Codex CLI and OpenCode CLI installed and authenticated as
the runner user; disposable Git repository prepared by
`tests/e2e-real/prepare-project.mjs`.

```bash
HAFT_REAL_CLI_E2E=1 pnpm test:e2e:real
# 1 passed, 1 skipped (OpenCode not opted in), 47.9 s

HAFT_REAL_CLI_E2E=1 \
HAFT_REAL_E2E_OPENCODE=1 \
HAFT_REAL_OPENCODE_MODEL=tvt/tvt-deepseek-v4.1-flash \
pnpm test:e2e:real
# 2 passed, 1.3 min; Codex 30.2 s, OpenCode 15.2 s
```

Observed assertions for both passing runs:

- execution `completed`, phase `completed`, runner id `runner_real_e2e`;
- branch `haft/<executionId>`, exit code `0`, non-empty summary;
- task `done`, agent `idle`;
- marker file created in the isolated worktree with the expected content;
- primary checkout unchanged;
- logs include the worktree-ready and successful-exit messages;
- log `seq` values are unique.

The OpenCode test is skipped unless `HAFT_REAL_E2E_OPENCODE=1` and a usable model
are provided. A skip is not reported as a pass.

### SQLite and test stability

API logs previously showed a Prisma SQLite 5-second socket timeout during heavy
E2E contention. Mitigations now in place:

- test/real-e2e database URLs use `connection_limit=1&socket_timeout=20`;
- `PrismaService` sets `PRAGMA busy_timeout = 15000`;
- `reset-database.mjs` parses URL query parameters and removes stale
  `-wal`/`-shm` sidecars.

After the mitigation, the complete E2E suite passed with zero `Socket timeout`
log lines.

### Repository state

All Phase 1 work is uncommitted in the working tree. No commit, push, merge, or
branch rewrite was performed by this implementation. Screenshots were regenerated
by the visual suite and are also uncommitted.

Supporting checks:

- `pnpm db:seed` — deterministic seed verified.
- Fresh API migration/database setup — `db:prepare:e2e` and
  `db:prepare:real-e2e` produce clean databases, including the new migration.
- Test API remains gated by `E2E_TEST_MODE=true` **and**
  `NODE_ENV!=production`.
- API tests use `test.db`; deterministic E2E uses `e2e.db`; real CLI E2E uses
  `real-e2e.db`; none touch `dev.db`.
- Fake Runner E2E uses a separate runner id (`runner_e2e`) and health port
  (`3199`), so it cannot collide with the real CLI suite
  (`runner_real_e2e`, `3299`).

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

- **Web authentication, authorization, and multi-tenancy.** The demo assumes a
  single trusted local operator and the fixed `ws_demo` workspace. Runner
  management has a loopback/admin-token guard, but the browser API is open.
- **Distributed scheduling.** One computer and one runner per computer; no queue,
  placement algorithm, or multi-runner failover.
- **Automatic commit/push/merge.** Deliberately excluded. The runner reports a
  branch and diff; a human reviews and integrates.
- **OS-level sandboxing.** A Git worktree isolates the working tree, not the
  process. Codex keeps its `workspace-write` sandbox; OpenCode depends on its
  own approval mode and the host trust boundary.
- **Runner auto-update, signed binaries, mutual TLS.** Out of scope for Phase 1.
- **Notifications, attachments, comments, subtasks, labels, drag-and-drop.**
- **Docker/reverse-proxy/HTTPS deployment assets.**
- **Durable mock runtime sessions.** Mock state remains in process memory.

## Known issues and limitations

1. **Single-writer SQLite.** WAL and `busy_timeout` improve resilience, but
   SQLite serialises writes and is not suitable for multiple API instances.
2. **Mock executions do not survive an API restart.** Startup reconciliation
   handles only runner-backed executions. A stale mock `running` row must be
   reset or cancelled manually.
3. **Real CLI behavior depends on the host.** CLI version, authentication,
   provider/model availability, and local policy are external. The runner
   reports `CLI_NOT_INSTALLED`/`CLI_NOT_AUTHENTICATED` and the real E2E test
   skips rather than faking success.
4. **Real CLI E2E is opt-in and not part of the default gate.** It requires two
   authenticated CLIs, a compatible model, and a disposable repository.
5. **Worktrees are not an OS sandbox.** A CLI runs as the runner user and can
   access anything that user can access. Codex's sandbox is the main in-CLI
   boundary; OpenCode `--auto` is explicitly opt-in.
6. **Runner transport security depends on deployment.** The demo uses a token
   over Socket.IO, binds locally by default, and does not provide TLS or mutual
   authentication. Do not expose `/runner` directly to untrusted networks.
7. **Bootstrap token is reusable.** It is used only for pairing/re-pairing, but
   the server does not consume it after first use. Rotate it like a deployment
   secret.
8. **Token file permissions.** The runner requests mode `0600`, but Windows ACLs
   differ; protect the token directory with OS permissions.
9. **Kept worktrees and branches accumulate.** Default retention is intentional
   for review; disk usage is an operator responsibility.
10. **Log replay is bounded.** A very long disconnect can drop older
    unacknowledged runner log entries (10,000-entry buffer, 200 per replay
    message). Persisted server logs remain durable.
11. **Windows shim resolution.** npm `.cmd` shims are parsed to find the
    underlying `.exe`; unusual wrappers may require an explicit `HAFT_*_BIN`.
12. **Visual baseline is platform-specific.** The committed snapshot is
    `chromium-win32`; regenerate per platform or use a pinned container.
13. **No auth on `/events`.** The browser realtime namespace is open to clients
    allowed by CORS, consistent with the local single-user demo scope.
14. **Execution-start serialization is in-process.** A multi-instance API would
    need a database constraint or distributed lock.
15. **Single production JS chunk.** Vite reports a bundle larger than 500 kB;
    route-level code splitting is a future optimization.

## Key files

| Concern                  | File                                                       |
| ------------------------ | ---------------------------------------------------------- |
| Workspace scripts        | `package.json`                                             |
| Shared contracts         | `packages/contracts/src/{constants,types,schemas}.ts`      |
| Runner protocol          | `packages/contracts/src/runner-protocol.ts`                |
| Database schema          | `apps/api/prisma/schema.prisma`                            |
| Runner migration         | `apps/api/prisma/migrations/20261107090000_runner_phase1`  |
| Seed data                | `apps/api/src/common/seed/demo-data.ts`                    |
| Runtime seam             | `apps/api/src/modules/runtime/agent-runtime.interface.ts`  |
| Mock runtime             | `apps/api/src/modules/runtime/mock-runtime.service.ts`     |
| Runtime selection        | `apps/api/src/modules/runtime/runtime-registry.service.ts` |
| Runner adapter           | `apps/api/src/modules/runtime/runner-runtime.service.ts`   |
| Runner registry          | `apps/api/src/modules/runners/runner-registry.service.ts`  |
| Runner gateway           | `apps/api/src/modules/runners/runner.gateway.ts`           |
| Execution orchestration  | `apps/api/src/modules/executions/executions.service.ts`    |
| Realtime gateway         | `apps/api/src/modules/events/events.gateway.ts`            |
| Runner client            | `apps/runner/src/runner-client.ts`                         |
| Real executor            | `apps/runner/src/real-executor.ts`                         |
| Fake executor            | `apps/runner/src/fake-executor.ts`                         |
| CLI args/parser/probe    | `apps/runner/src/cli-{args,output,probe}.ts`               |
| Git worktrees            | `apps/runner/src/git-worktree.ts`                          |
| Process utilities        | `apps/runner/src/process-utils.ts`                         |
| Runner configuration     | `apps/runner/src/config.ts`                                |
| Test API                 | `apps/api/src/modules/test/test.controller.ts`             |
| UI interaction contract  | `tests/contract/ui-interaction.contract.json`              |
| Fake Runner E2E          | `tests/e2e/functional/runner-execution.spec.ts`            |
| Real CLI E2E             | `tests/e2e-real/real-cli.spec.ts`                          |
| Playwright configs       | `playwright.config.ts`, `playwright.real.config.ts`        |
| Runner architecture docs | `docs/runner-architecture.md`                              |
| Runner protocol docs     | `docs/runner-protocol.md`                                  |
| Runner setup docs        | `docs/runner-setup.md`                                     |
| Runtime integration docs | `docs/runtime-integration.md`                              |
| Execution recovery docs  | `docs/execution-recovery.md`                               |

## Recommended next steps

1. Add durable mock-session recovery or startup failure for stale mock
   executions.
2. Harden remote runner deployment: TLS, mTLS or short-lived tokens, bootstrap
   token rotation/expiry, and network allowlists.
3. Add a worktree retention policy/job with size limits and review metadata.
4. Add per-execution model/agent/sandbox options to task configuration, wired
   through the existing `RuntimeExecutionOptions` schema.
5. Add CI with artifact upload; run the deterministic suite on every change and
   the real CLI suite on a self-hosted, provisioned runner.
6. Add route-level code splitting and pagination/virtualisation for large lists.
7. Run visual tests in a pinned container and maintain per-platform baselines.
