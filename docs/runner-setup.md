# Runner setup

This guide covers installing, pairing, and operating the Haft Agent Runner. The
runner is a separate process from the API and the web app. It can run a
deterministic Fake executor or real Codex/OpenCode CLIs.

See [runner-protocol.md](runner-protocol.md) for the wire protocol and
[execution-recovery.md](execution-recovery.md) for failure handling.

## Prerequisites

- Node.js 20.19+ and pnpm 11 (`corepack enable`).
- A checkout of this repository and `pnpm install`.
- Git on the runner host. Real mode requires the mapped project to be the root of
  a Git repository with at least one commit.
- For real mode, the CLI installed and authenticated for the same OS user that
  runs the runner.

The runner has no database and no HTTP API. It needs network access to the API's
Socket.IO `/runner` namespace.

## 1. Configure the API

Add a bootstrap secret to `apps/api/.env` (or the environment used to start the
API):

```dotenv
HAFT_RUNNER_BOOTSTRAP_TOKEN="replace-with-a-long-random-value"
```

Optional server settings:

| Variable                           | Default | Purpose                                                         |
| ---------------------------------- | ------- | --------------------------------------------------------------- |
| `HAFT_RUNNER_BOOTSTRAP_TOKEN`      | unset   | Required for first pairing. Treat it as a deployment secret.    |
| `HAFT_RUNNER_ADMIN_TOKEN`          | unset   | Required `x-haft-admin-token` for `/api/runners` when set.      |
| `HAFT_RUNNER_HEARTBEAT_TIMEOUT_MS` | 45000   | Mark a runner offline after this silence (minimum 10 s).        |
| `HAFT_RUNNER_RECONNECT_GRACE_MS`   | 60000   | Keep executions running while a runner reconnects (min 5 s).    |
| `HAFT_RUNNER_CANCEL_TIMEOUT_MS`    | 30000   | Wait for runner cancellation confirmation before returning 409. |
| `HAFT_RUNNER_MAX_CONCURRENT`       | 1       | Advertised in `runner.welcome` (1–32).                          |

Restart the API after changing these. When `HAFT_RUNNER_ADMIN_TOKEN` is unset,
`GET /api/runners` is loopback-only.

## 2. Pair a Fake Runner

Fake mode is the fastest way to prove pairing, dispatch, logs, cancellation, and
recovery without a model account.

```bash
export HAFT_RUNNER_BOOTSTRAP_TOKEN="replace-with-a-long-random-value"
export HAFT_RUNNER_ID=runner_local
export HAFT_RUNNER_COMPUTER_ID=computer_local
export HAFT_RUNNER_MODE=fake
pnpm --filter @raft-lite/runner start
```

PowerShell:

```powershell
$env:HAFT_RUNNER_BOOTSTRAP_TOKEN = "replace-with-a-long-random-value"
$env:HAFT_RUNNER_ID = "runner_local"
$env:HAFT_RUNNER_COMPUTER_ID = "computer_local"
$env:HAFT_RUNNER_MODE = "fake"
pnpm --filter @raft-lite/runner start
```

Or use root scripts:

```bash
pnpm runner:start   # one-shot
pnpm runner:dev     # watch mode
```

On first connect the runner exchanges the bootstrap token for a runner token and
writes it to `HAFT_RUNNER_TOKEN_FILE`. Subsequent restarts use the cached token.

Verify:

```bash
curl http://127.0.0.1:3001/api/runners
curl "http://127.0.0.1:3001/api/runtimes?computerId=computer_local&projectId=project_demo"
```

The Fake Runner reports `codex` and `opencode` as installed and authenticated.
Create an agent with one of those runtimes, assign `computer_local`, and start a
task. Fake execution takes roughly `6 × HAFT_RUNNER_STEP_MS` (default 1.5 s).

## 3. Configure real CLI mode

### Project allowlist

The runner only executes inside projects explicitly mapped by id to a local
repository path. The repository must be the root of a Git repository.

```bash
export HAFT_RUNNER_PROJECTS='{"project_demo":"/home/me/src/raft-lite-work"}'
```

Windows example:

```powershell
$env:HAFT_RUNNER_PROJECTS = '{"project_demo":"D:\\code\\raft-lite-work"}'
```

Alternatively use `--project project_demo=/path/to/repo` (repeatable). The
legacy fallback `HAFT_RUNNER_PROJECT_ID` + `HAFT_RUNNER_WORKSPACE_ROOT` maps one
project. Project ids in the runner map must match task project ids; otherwise
availability reports `PROJECT_NOT_MAPPED`.

### Worktree root

Each execution gets a branch `haft/<executionId>` and a worktree at
`<worktreeRoot>/<projectId>/<executionId>`.

```bash
export HAFT_RUNNER_WORKTREE_ROOT="$HOME/.haft/worktrees"
```

Default: `~/.haft/worktrees`. Use a different filesystem path on Windows if the
home directory is redirected. The runner refuses to reuse an existing branch or
worktree directory. Clean up stale entries with Git, not by deleting the directory
alone:

```bash
git -C /path/to/repo worktree remove --force /path/to/worktree
git -C /path/to/repo worktree prune
git -C /path/to/repo branch -D haft/<executionId>
```

### Worktree retention

| Variable                       | Default | Behavior                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------ |
| `HAFT_RUNNER_KEEP_WORKTREES`   | `1`     | Keep worktrees after collection for inspection.              |
| `HAFT_RUNNER_KEEP_WORKTREES=0` |         | Remove the worktree and prune after collecting Git evidence. |

Worktrees are kept by default so a reviewer can inspect the diff and run tests.
The real CLI E2E suite explicitly keeps them to assert file output. The branch
is never deleted automatically; retention is an operator decision.

### CLI paths and models

| Variable              | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `HAFT_CODEX_BIN`      | Explicit Codex executable; default `codex` on `PATH`.       |
| `HAFT_OPENCODE_BIN`   | Explicit OpenCode executable; default `opencode` on `PATH`. |
| `HAFT_CODEX_MODEL`    | Optional default model passed as `-m <model>` to Codex.     |
| `HAFT_OPENCODE_MODEL` | Optional default model passed as `-m <model>` to OpenCode.  |

On Windows, npm shims are `.cmd` files that Node cannot spawn without a shell.
The runner reads the shim and resolves the underlying `.exe`; if that fails,
point `HAFT_CODEX_BIN`/`HAFT_OPENCODE_BIN` at the executable directly.

Model availability is environment-specific. In particular, OpenCode may require
an explicit provider/model for the API key configured on the host. Set
`HAFT_OPENCODE_MODEL` (for example `provider/model`) or pass a model through a
trusted dispatch option. A missing model is an authentication/provider problem,
not a protocol problem.

### Authentication probes

Real mode probes once at runner startup:

```bash
codex --version
codex login status
opencode --version
opencode auth list
# fallback if auth list is unavailable:
opencode models
```

The result is reported to the server. Restart the runner after installing a CLI
or logging in, so the capability snapshot refreshes. `/api/runtimes` returns
`CLI_NOT_INSTALLED` or `CLI_NOT_AUTHENTICATED` with the probe message.

### Start real mode

```bash
export HAFT_RUNNER_MODE=real
export HAFT_RUNNER_REAL_RUNTIMES=codex,opencode
export HAFT_RUNNER_PROJECTS='{"project_demo":"/home/me/src/raft-lite-work"}'
export HAFT_RUNNER_CLI_TIMEOUT_MS=1800000
pnpm --filter @raft-lite/runner start
```

To enable only one runtime, use `HAFT_RUNNER_MODE=codex` or
`HAFT_RUNNER_MODE=opencode` (or set `HAFT_RUNNER_REAL_RUNTIMES`).

### Approval and sandbox rules

- **Codex** always runs with `--sandbox workspace-write` (or `read-only` if a
  trusted dispatch option requests it). There is no
  `--dangerously-bypass-approvals-and-sandbox` flag.
- **OpenCode** receives `--auto` only when the runner host explicitly sets
  `HAFT_RUNNER_ALLOW_AUTO_APPROVE=1`. Never enable it on a host where the mapped
  repository or CLI credentials are not disposable/trusted.
- The Git worktree is isolation for review, not an OS security boundary. The CLI
  still runs as your user and can access anything that user can access.

### Timeout and concurrency

| Variable / flag              | Default | Notes                                                       |
| ---------------------------- | ------- | ----------------------------------------------------------- |
| `HAFT_RUNNER_CLI_TIMEOUT_MS` | 1800000 | 10 s–2 h; a dispatch option may shorten it.                 |
| `HAFT_RUNNER_MAX_CONCURRENT` | 1       | 1–32; advertised to the server and enforced locally.        |
| `HAFT_RUNNER_STEP_MS`        | 250     | Fake executor step delay only.                              |
| `HAFT_RUNNER_HEALTH_PORT`    | 0       | `0` disables; otherwise `/health` and `/ready` on loopback. |

## Complete configuration reference

| Variable                         | Mode | Default                    | Description                                          |
| -------------------------------- | ---- | -------------------------- | ---------------------------------------------------- |
| `HAFT_SERVER_URL`                | both | `http://127.0.0.1:3001`    | API base URL; the runner appends `/runner`.          |
| `HAFT_RUNNER_ID`                 | both | `runner_local`             | Stable id; must be unique per computer.              |
| `HAFT_RUNNER_COMPUTER_ID`        | both | `computer_local`           | Existing Computer row in the API.                    |
| `HAFT_RUNNER_BOOTSTRAP_TOKEN`    | both | unset                      | Required only for first pairing or re-pairing.       |
| `HAFT_RUNNER_TOKEN_FILE`         | both | `~/.haft/runner-<id>.json` | Local token cache.                                   |
| `HAFT_RUNNER_MODE`               | both | `fake`                     | `fake`, `real`, `codex`, or `opencode`.              |
| `HAFT_RUNNER_FAKE_RUNTIMES`      | fake | `codex,opencode`           | Runtimes the Fake executor advertises.               |
| `HAFT_RUNNER_REAL_RUNTIMES`      | real | `codex,opencode`           | Runtimes the real executor enables.                  |
| `HAFT_CODEX_BIN`                 | real | `codex`                    | Codex executable name/path.                          |
| `HAFT_OPENCODE_BIN`              | real | `opencode`                 | OpenCode executable name/path.                       |
| `HAFT_CODEX_MODEL`               | real | unset                      | Default Codex model.                                 |
| `HAFT_OPENCODE_MODEL`            | real | unset                      | Default OpenCode model.                              |
| `HAFT_RUNNER_PROJECTS`           | both | `{ "<projectId>": cwd }`   | JSON map of project id → repository path.            |
| `HAFT_RUNNER_WORKTREE_ROOT`      | real | `~/.haft/worktrees`        | Root for per-execution worktrees.                    |
| `HAFT_GIT_BIN`                   | real | `git`                      | Git executable.                                      |
| `HAFT_RUNNER_KEEP_WORKTREES`     | real | `1`                        | `0` removes worktrees after collection.              |
| `HAFT_RUNNER_CLI_TIMEOUT_MS`     | real | `1800000`                  | CLI timeout in milliseconds.                         |
| `HAFT_RUNNER_ALLOW_AUTO_APPROVE` | real | unset                      | `1` adds `--auto` to OpenCode.                       |
| `HAFT_RUNNER_STEP_MS`            | fake | `250`                      | Fake step delay.                                     |
| `HAFT_RUNNER_HEALTH_PORT`        | both | `0`                        | Loopback health port; `0` disables.                  |
| `HAFT_RUNNER_MAX_CONCURRENT`     | both | `1`                        | Maximum local concurrent executions.                 |
| `HAFT_RUNNER_FAKE_FAIL`          | fake | unset                      | `1` forces deterministic failure for every fake run. |

Command-line equivalents exist for the main options:

```bash
pnpm --filter @raft-lite/runner start -- \
  --server http://127.0.0.1:3001 \
  --runner-id runner_local \
  --computer-id computer_local \
  --mode real \
  --project project_demo=/home/me/src/raft-lite-work \
  --codex-bin /usr/local/bin/codex \
  --opencode-bin /usr/local/bin/opencode \
  --codex-model gpt-5-codex \
  --opencode-model provider/model \
  --health-port 3299 \
  --max-concurrent 1
```

See `pnpm --filter @raft-lite/runner start -- --help` for the full list.

## Health endpoint

When `HAFT_RUNNER_HEALTH_PORT` is non-zero, the runner listens on
`127.0.0.1:<port>`:

- `GET /health` — process is up, returns `status`, `runnerId`, `mode`,
  `connected`, active ids, and pending log count.
- `GET /ready` — `200` only when connected, otherwise `503`.

The endpoint exposes no tokens, prompts, or repository paths. It is used by
process supervisors and by Playwright's readiness check.

## Token lifecycle

- First connection: bootstrap token → issued runner token. The server stores
  only `sha256(token)`.
- Later connections: cached token. The token file is inside the runner user's
  home or `HAFT_RUNNER_TOKEN_FILE`; protect it with filesystem permissions.
- Token rejected: the runner clears the cache, retries once with the bootstrap
  token, and raises a fatal error if that also fails.
- Re-pairing the same runner id rotates the token hash. The old token stops
  working; delete the old token file if necessary.

The CLI child environment strips all `HAFT_*` and `E2E_RUNNER_*` variables, so
neither the bootstrap token nor the issued token is visible to Codex/OpenCode or
their child processes.

## Operating notes

- Run one runner process per `runnerId`. A second connection with the same id
  replaces the first.
- The runner can run in the foreground, under a process supervisor, or as a
  service. It handles `SIGINT`/`SIGTERM` by cancelling active executions and
  disconnecting.
- Restarting the runner fails in-flight executions during reconciliation; it
  never silently re-runs them. See [execution-recovery.md](execution-recovery.md).
- Disk usage grows with kept worktrees. Monitor the worktree root and prune old
  execution worktrees after review.
- The API and runner clocks should be reasonably synchronized; protocol
  timestamps are informational, but heartbeat/reconnect windows use wall time.

## Troubleshooting

| Symptom                                      | Check                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `RUNNER_AUTH_FAILED` on connect              | Bootstrap token on the runner must equal `HAFT_RUNNER_BOOTSTRAP_TOKEN` on the API.                          |
| Runner never connects                        | `HAFT_SERVER_URL` must be reachable; the API must expose `/socket.io`/`/runner`; check CORS/proxy.          |
| `RUNNER_NOT_FOUND` after server reset        | The runner row was deleted. Set the bootstrap token and restart the runner to re-pair.                      |
| Runtime shows `CLI_NOT_INSTALLED`            | Use the same user/PATH as the runner; set an explicit `HAFT_*_BIN` after checking `--version`.              |
| Runtime shows `CLI_NOT_AUTHENTICATED`        | Log in with the CLI as the runner user, then restart the runner to re-probe.                                |
| `PROJECT_NOT_MAPPED`                         | Add the exact task `projectId` to `HAFT_RUNNER_PROJECTS`.                                                   |
| `PROJECT_NOT_GIT_ROOT`                       | Point at the repository root, not a subdirectory. Commit at least one file.                                 |
| `BRANCH_EXISTS` / `WORKTREE_EXISTS`          | Delete the old branch/worktree after review; each execution must get fresh isolation.                       |
| `CLI_TIMEOUT`                                | Increase `HAFT_RUNNER_CLI_TIMEOUT_MS` within the 2-hour cap, or reduce task scope.                          |
| `CLI_EXIT_CODE`                              | Inspect the execution log tail; fix authentication/model/configuration or the task itself.                  |
| Cancellation returns `RUNNER_OFFLINE`        | The runner disconnected before receiving the cancel. Reconnect it; the execution is still running.          |
| Cancellation returns `RUNNER_CANCEL_TIMEOUT` | The process did not stop within 30 s. Inspect the runner and the process tree; the execution stays running. |
| Worktrees consume too much disk              | Review diffs, then remove worktrees/branches; set `HAFT_RUNNER_KEEP_WORKTREES=0` for automatic cleanup.     |

## Security checklist

- Use a long random bootstrap token; do not commit it.
- Keep the API and runner on trusted hosts. The demo has no TLS or public runner
  authentication beyond the token.
- Do not expose `/runner` to the internet without a reverse proxy, TLS, network
  allowlists, and a stronger secret-rotation process.
- Keep `HAFT_RUNNER_ALLOW_AUTO_APPROVE` unset unless the mapped repository and
  credentials are disposable/trusted.
- Remember that a worktree is not a sandbox; Codex keeps `workspace-write`, but
  the process still runs as your OS user.
- Restrict filesystem permissions on the token file and worktree root.
- Review diffs before merging or deleting branches; the runner never commits or
  pushes.
