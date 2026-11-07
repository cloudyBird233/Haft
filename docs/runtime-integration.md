# Runtime integration

This document explains how the API selects an execution runtime, how runtime
availability reaches the UI, and how the three runtimes (`mock`, `codex`,
`opencode`) map onto the same execution model.

## Selection seam

`ExecutionsService` never branches on `runtime`. It asks
`RuntimeRegistryService`:

```ts
await registry.availability(computerId, projectId);
await registry.start(runtime, context);
await registry.stop(runtime, executionId);
await registry.getStatus(runtime, executionId);
```

`RuntimeRegistryService` registers:

| Runtime    | Implementation                     | Where it runs |
| ---------- | ---------------------------------- | ------------- |
| `mock`     | `MockRuntimeService`               | API process   |
| `codex`    | `RunnerRuntimeService('codex')`    | Runner host   |
| `opencode` | `RunnerRuntimeService('opencode')` | Runner host   |

A runner-backed runtime is deliberately thin: it builds a prompt, dispatches a
protocol message, and marks the execution finished when the server persists a
terminal event. It does not parse CLI output.

## Agent configuration

An agent has:

- `runtime`: `mock`, `codex`, or `opencode`;
- `computerId`: `computer_local` by default, or another registered computer.

For `codex`/`opencode`, a connected runner must be paired with that computer.
For `mock`, the computer is irrelevant and execution stays in-process.

The web task drawer loads `GET /api/runtimes?computerId=...&projectId=...` and
shows a reason when the assignee's runtime is unavailable:

| `reasonCode`            | Displayed reason                                        |
| ----------------------- | ------------------------------------------------------- |
| `COMPUTER_NOT_ASSIGNED` | Assign the agent to a computer first                    |
| `RUNNER_NOT_REGISTERED` | No runner is registered for this computer               |
| `RUNNER_OFFLINE`        | The runner is offline                                   |
| `CLI_NOT_INSTALLED`     | `<runtime label> is not installed on the runner`        |
| `CLI_NOT_AUTHENTICATED` | Probe message or `<runtime label> is not authenticated` |
| `PROJECT_NOT_MAPPED`    | The project is not mapped in the runner configuration   |

The start action is not the only guard: the API re-evaluates availability inside
`startForTask` and rejects the request if the runtime became unavailable between
render and click.

## Start path

```text
startForTask
  → validate task, assignee, agent status, no active execution
  → runtimeType = agent.runtime
  → if mock:
       create Execution(running, phase=running, progressMode=determinate)
  → if codex/opencode:
       require agent.computerId and computer
       require computer.status !== offline
       availability = registry.getAvailability(runtime, computerId, projectId)
       if !available: throw mapped error
       runnerId = availability.runnerId
       create Execution(running, phase=queued, progressMode=indeterminate, runnerId)
  → transaction: task → in_progress, agent → busy
  → activity + events
  → registry.start(runtime, context)
       mock: start in-process script
       runner: dispatchStart (20 s accept timeout)
  → on failure: failExecutionStart restores task/agent and marks execution failed
```

For runner executions, the initial HTTP response returns the `queued` execution.
The browser receives subsequent `execution.updated` events as the runner reports
`preparing`, `running`, and terminal phases.

## Status and phase mapping

`Execution.status` remains the product-level state:

| Runtime result          | status      | task          | agent    | extra fields                          |
| ----------------------- | ----------- | ------------- | -------- | ------------------------------------- |
| Start                   | `running`   | `in_progress` | `busy`   | `phase=queued` or `running`           |
| CLI exit 0              | `completed` | `done`        | `idle`   | `exitCode`, `summary`, Git evidence   |
| CLI exit ≠ 0 / timeout  | `failed`    | `failed`      | `error`  | `failureReason`, `exitCode`           |
| Runner lost / restarted | `failed`    | `failed`      | `error`  | `failureReason=RUNNER_RESTARTED` etc. |
| Cancellation confirmed  | `cancelled` | `cancelled`   | `idle`   | `cancelReason`                        |
| Start rejected          | `failed`    | restored      | restored | `failureReason`, error log            |

`Execution.phase` is additive and more precise:

```text
queued → preparing → running → finalizing → completed
                                           ↘ failed
                                           ↘ cancelled
```

The mock runtime skips `queued`/`preparing` and starts at `running`.
Runner executions start at `queued`, then the runner drives the phases. The legal
phase values are shared by contracts and the runner protocol.

## Prompt construction

`RunnerRuntimeService.buildPrompt` produces a bounded, task-derived prompt:

```text
You are <agent name>, working on a software task in an isolated Git worktree.
Task: <task title>

Task description:
<task description>

Implement the task in the current worktree. Run relevant checks when possible.
Do not commit, push, merge, or modify files outside this worktree.
Finish with a concise summary of what changed and any remaining risk.
```

Task text is data, not a command. It is written to the CLI's stdin and never
interpolated into a shell command, an argv entry, or a file path.

## Runtime-specific behavior

### Mock

- In-process, no runner required.
- Deterministic five steps at `MOCK_TICK_MS`.
- `auto` and `manual` modes; manual is driven by the test API.
- Used by the seeded completed execution, API tests, the business loop, and the
  visual suite.

### Fake Runner

- Real runner process and real protocol, simulated execution.
- Six deterministic steps; no CLI, Git worktree, or model.
- Advertises `codex`/`opencode` as `fake-1.0.0`, installed and authenticated.
- Failure triggers: title contains `[fail]`, description contains
  `HAFT_FAKE_FAIL`, or `HAFT_RUNNER_FAKE_FAIL=1`.
- Used by the three Fake Runner E2E tests and the runner integration tests.

### Real Codex

- Spawns `codex exec --json --color never --ephemeral --sandbox <sandbox> -C <worktree> [-m model] -`.
- Prompt written to stdin; Codex reads it because the final `-` is present.
- Sandbox defaults to `workspace-write`; `read-only` is allowed if requested by a
  trusted dispatch option. There is no bypass flag.
- Output is parsed from Codex JSONL (`thread.started`, `turn.completed`,
  `item.completed` with agent messages, reasoning, command execution, file
  changes, and errors).

### Real OpenCode

- Spawns `opencode run --standalone --format json [-m model] [--agent name] [--auto]`.
- Prompt written to stdin when no message argument is supplied.
- `--auto` only with `HAFT_RUNNER_ALLOW_AUTO_APPROVE=1`.
- Output is parsed from OpenCode JSON (`text`, `tool`, `step_finish`, `error`).

## Failure mapping

Runner failures arrive as `execution.failed` with a human-readable `reason`. The
API stores it in `failureReason` and appends an error log if the parsed stream
did not already contain one.

| Runner code / pattern    | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `PROJECT_NOT_MAPPED`     | Runner project map has no entry for the task project |
| `PROJECT_PATH_MISSING`   | Configured path does not exist                       |
| `PROJECT_NOT_GIT_ROOT`   | Path is not the root of a Git repository             |
| `PROJECT_HAS_NO_COMMITS` | Repository has no commit to branch from              |
| `BRANCH_EXISTS`          | Execution branch already exists                      |
| `WORKTREE_EXISTS`        | Worktree path already exists                         |
| `CLI_NOT_INSTALLED`      | Executable not found                                 |
| `CLI_NOT_AUTHENTICATED`  | Capability probe found no credentials                |
| `CLI_SPAWN_FAILED`       | Process could not start                              |
| `CLI_EXIT_CODE`          | CLI exited non-zero                                  |
| `CLI_TIMEOUT`            | CLI exceeded the timeout and was terminated          |
| `RUNNER_BUSY`            | Runner concurrency limit reached                     |
| `RUNTIME_NOT_ENABLED`    | Runtime not enabled in this runner mode              |

## Adding a runtime

1. Add the literal to `AGENT_RUNTIMES`/`RUNNER_RUNTIMES` and `RUNTIME_LABELS`.
2. Extend `RuntimeAvailabilityDto` if the new runtime has extra metadata.
3. Implement `AgentRuntime` on the server or reuse `RunnerRuntimeService`.
4. Add a runner capability probe and executor branch.
5. Add an argv builder with stdin prompts and safe defaults; never accept a
   binary path from task text or an HTTP body.
6. Add parser tests with real CLI JSONL fixtures, then an opt-in real E2E case.
7. Document the reason codes and failure patterns.

The invariant is simple: **the browser may choose a configured runtime, but it
may never choose an executable, path, shell command, or approval flag.**
