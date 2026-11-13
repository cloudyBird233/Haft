# P2-02 WP-D Slice 0.1 独立复审修复报告

| 项目         | 内容                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 分支         | `feature/p2-02-wpd-slice0-2-review-remediation`                           |
| 复审基线     | `324b6d78b9234e2f4d080908ebd7a5d29b45305e`（独立复审 PASS WITH WARNINGS） |
| 代码修复提交 | `663cc28df213f1855ed72437dd8efb7cf96906ae`                                |
| 修复范围     | P1-1、P2-1、P2-2、P2-3                                                    |
| 当前状态     | **等待新的独立只读复审；本报告不宣布 PASS，不进入 Slice 1**               |
| 未修改的内容 | `main`、冻结设计文档、既有测试、协议/Schema、无关模块                     |

---

## 1. 结论摘要

本次任务范围内只处理独立复审报告中的 4 项 Finding（P1-1、P2-1、P2-2、P2-3）。

| ID   | 原级别 | 复审结论 | 修复后状态（待复审确认） | 主要证据                                                        |
| ---- | ------ | -------- | ------------------------ | --------------------------------------------------------------- |
| P1-1 | P1     | FAIL     | 已修复                   | finalize single-flight；F1–F9 并发/失败注入测试                 |
| P2-1 | P2     | WARN     | 已修复                   | Windows starting guard 写后回验；S1–S8；真实 Windows supervisor |
| P2-2 | P2     | WARN     | 已修复                   | resolve-corrupt 目标类型/路径校验；R13–R14                      |
| P2-3 | P2     | WARN     | 已修复                   | 人工 resolve 全树证明；R15–R19                                  |

本次没有实施 Slice 1，没有修改 `main`，没有 force push / rebase，没有删除既有测试，没有改动冻结设计文档。

---

## 2. 修复基线与工作方式

- 起点为 `324b6d78b9234e2f4d080908ebd7a5d29b45305e`，工作区干净。
- 从该基线创建并切换到 `feature/p2-02-wpd-slice0-2-review-remediation`。
- 代码与测试提交：`663cc28df213f1855ed72437dd8efb7cf96906ae`。
- 本报告随后单独提交，不修改代码提交内容。
- 所有故障均为确定性注入：Promise gate、可控 fake child、把 guard 路径预先创建为目录、测试用 supervisor fixture、mock journal `finish()` 失败；不依赖磁盘满、网络抖动等不可控条件。

---

## 3. P1-1：终态 finalize 并发竞态

### 3.1 根因

原 `finalize()` 在 `await confirmTreeAfterClose(...)` 之前没有互斥。close 事件、`abortSpawnedProcess()`、15 秒 fallback 等路径可以同时通过 `session.finished` 检查，随后分别写 Journal 终态并发送终态事件，复现了复审证据中的 `EVENTS ["failed","completed"]`。

### 3.2 修复实现

`apps/runner/src/real-executor.ts` 的 `RealSession` 新增三个字段：

- `finalizePromise`：正在进行的终态决策。
- `finalizeRequests`：决策提交前到达的所有请求（outcome + payload）。
- `finalizeCommitted`：终态是否已经同步提交。

`finalize()` 遵守以下顺序：

1. 若 `session.finished` 已为真，立即返回已完成的 Promise。
2. 若 `finalizePromise` 已存在且尚未 committed，把本次请求追加到 `finalizeRequests`，返回同一个 Promise。
3. 否则**在第一个 `await` 之前**同步安装 `finalizePromise`。
4. 若 `finalizePromise` 在 `finally` 中仍是当前 Promise 则清空；这样失败路径不会因缓存的 Promise 永久无法重试。

`runFinalize()` 的终态提交点：

- `confirmTreeAfterClose()` 抛错或返回未确认时，`markUncertain()`，不写终态 Journal、不发终态事件、保留 session 与 active journal。
- 树确认成功后，若无并发路径已把 session 标记为 uncertain，则同步执行仲裁并设置 `finalizeCommitted = true`、`session.finished = true`；此后即使 Git 收集或 Journal 写入仍在 `await`，迟到请求也不能覆盖结果。
- Journal `finish()` 失败时只把本地结果改为 failed，不发送任何 completed/cancelled 成功事件；active journal 保留，session 进入 `uncertainOrphans`。

### 3.3 确定性仲裁

`arbitrateFinalizeRequest()` 的优先级固定为：

1. 显式 `failed` 请求（第一个）；
2. `session.cancelled`（取第一个 cancelled 请求；缺失时用取消原因构造）；
3. `session.timedOut`（生成 `CLI_TIMEOUT` failed）；
4. 其他 `cancelled` 请求；
5. `completed` 请求；
6. 请求列表第一项；
7. 保底 `failed`。

同一类别取第一个请求的 payload。已 committed 后的迟到调用只返回已完成 Promise，不追加、不重写。

### 3.4 并发测试（F1–F9）

文件：`apps/runner/test/finalize-concurrency.spec.ts`

| 用例 | 场景                                            | 关键断言                                                                                                  |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| F1   | 两个相同 outcome 并发 finalize                  | 返回同一 Promise；`verifyTreeGone`/`collect`/`journal.finish` 各 1 次；1 个 completed；迟到 failed 不生效 |
| F2   | finalize 进行中到达 failed                      | Journal 与事件均为 failed，failed 原因保留                                                                |
| F3   | close 与 15s fallback 竞争（cancelled）         | 只 1 次 journal.finish、1 个 cancelled、0 failed/0 completed                                              |
| F4   | close 与 `abortSpawnedProcess()` 竞争           | 只 1 次 failed，abort 原因保留，0 completed                                                               |
| F5   | 树确认延迟，期间再次 finalize（含不同 outcome） | 共享同一 Promise；只 1 次树确认；failed 赢得仲裁                                                          |
| F6   | Journal `finish()` 注入失败                     | 0 终态事件；session 保留；`uncertainOrphans` 含该 execution；snapshot 可见                                |
| F7   | 三个 completed 并发                             | 只 1 次 journal.finish、只 1 个 completed                                                                 |
| F8   | cancelled 与 failed 并发                        | Journal/事件一致为 failed；failed payload 来自 failed 请求                                                |
| F9   | 树未确认                                        | 0 journal.finish、0 终态事件；`finalizeCommitted=false`；保留 active journal；迟到 completed 也不生效     |

所有 F 用例都断言了 `session.finished`，并在 F1/F9 额外断言了 `finalizePromise` 清理与“迟到调用不产生第二条终态路径”。

---

## 4. P2-1：Windows starting guard 与 ready 失败清理

### 4.1 Windows supervisor

`apps/runner/native/windows-process-supervisor.cs`：

- `WriteGuard()` 从吞异常改为返回 `bool`；临时文件写入失败时清理临时文件并返回 `false`。
- 新增 `VerifyGuard()`：按精确文本读回刚写入的 guard，并与期望 JSON 文本比较。
- `Main()` 在 `CreateJob()` 之后、`SpawnCli()` 之前：
  1. `WriteGuard("starting", ...)` 必须返回 true；
  2. `VerifyGuard()` 必须返回 true；
  3. 任一失败立即抛错，进入 `catch`，返回 supervisor failure exit code 70，**不会执行 `SpawnCli()`**。
- `SpawnCli()` 之后的 running guard 写入失败同样抛错；`catch` 调用 `TryTerminateJob()`，且 Job Object 仍保持 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。未改变 `CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject` → `ResumeThread` 的顺序。

### 4.2 Runner 侧 ready/清理

`apps/runner/src/supervised-process.ts`：

- 立即为 `ready` 挂 `catch(() => undefined)`，避免 supervisor 快速失败且 executor 尚未等待时产生 unhandled rejection。
- 新增 `guardForOperation(waitMs)`：
  - 先读当前 guard；
  - 读不到时用 `waitForReadyBounded()` 等待 `ready`，超时时间取调用方 `timeoutMs`（`terminate`/`verifyTreeGone`），不再无条件等待 20 秒；
  - `ready` 拒绝时返回 `PROCESS_SUPERVISOR_NOT_READY: ...`，不向上抛。
- `terminate()` 在无 guard 时：
  - 对 Node 持有的 supervisor 直接子进程做一次有界 `SIGKILL` 清理（最多等 2 秒退出）；
  - 无论是否发出 kill，都返回 `confirmed: false`、`requested: true`，保留 active journal；若确实发出 kill，`killIssued: true`。
  - 有 guard 时对 `terminateGuardedTree()` 的异常也转为 unconfirmed，而不是抛出。
- `verifyTreeGone()` 在无 guard 时直接返回 `confirmed: false`、`identityMismatch: false` 的 unconfirmed 结果。
- `waitForGuardReady()` 改为导出函数并增加可选 `timeoutMs`（默认仍为 20 秒），供测试使用真实 guard 文件验证 ready 契约。

### 4.3 测试（S1–S8）

文件：`apps/runner/test/supervised-process-safety.spec.ts`

| 用例 | 平台    | 场景                                                      | 关键断言                                                                                               |
| ---- | ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S1   | 双平台  | supervisor 未写 guard 即退出                              | `ready` 拒绝为 `PROCESS_SUPERVISOR_EXITED`；guard 不存在                                               |
| S2   | 双平台  | guard 写入后消失再退出                                    | 不返回 ready；拒绝为 EXITED                                                                            |
| S3   | 双平台  | guard 路径不可读（目录）                                  | 超时拒绝为 `PROCESS_SUPERVISOR_TIMEOUT`                                                                |
| S4   | 双平台  | guard state=failed                                        | 拒绝为 `PROCESS_SUPERVISOR_FAILED`                                                                     |
| S5   | 双平台  | 正常写入 running guard                                    | ready 成功并返回 running guard                                                                         |
| S6   | POSIX   | ready 拒绝后调用 terminate/verifyTreeGone                 | 两者都不抛；均 `confirmed=false`；terminate `killIssued=false`；reason 含 NOT_READY                    |
| S7   | Windows | 把 guard 路径预建为目录，使 starting guard 写入确定性失败 | `SpawnCli()` 未执行（CLI marker 文件不存在）；ready 拒绝；terminate unconfirmed                        |
| S8   | POSIX   | supervisor 卡在写 guard 之前且保持存活                    | terminate 在 200ms 等待后返回；总耗时 < 10s；`confirmed=false`、`killIssued=true`、reason 含 NOT_READY |

S7 的目录注入是确定性的文件系统故障，不使用磁盘满等不可控条件；该用例在真实 Windows supervisor 上编译并执行通过。

---

## 5. P2-2：`resolve-corrupt` 目标校验

`apps/runner/src/recovery.ts` 的 `resolveCorruptJournal()` 现在必须同时满足：

1. 目标解析后位于 recovery root 之内（`relative` + `..`/绝对路径检查，不再用字符串前缀）；
2. 目标的父目录就是 recovery root（必须是 root 直属文件）；
3. basename 匹配 `\.corrupt-\d+$`（与 `ExecutionJournal` 的 `<file>.corrupt-<Date.now()>` 隔离命名一致）；
4. `lstat()` 成功且为普通文件，拒绝符号链接、目录和其他类型。

不满足时返回 `resolved: false` 与具体原因，不写 resolution sidecar。

测试：`apps/runner/test/recovery-resolution.spec.ts`

- **R13**：任意普通文件、`corrupt-` 后缀目录、root 子目录中的 `corrupt-` 普通文件、root 外路径全部拒绝，且不产生 `.resolution.json`。
- **R14**：root 直属的隔离普通文件成功写入 sidecar。
- **R07（既有真实 OS 用例）**：真实 quarantined journal 仍可成功 resolve，回归未被破坏。

---

## 6. P2-3：人工 resolve 的完整进程树证明

### 6.1 实现

`resolveBlockedExecution()` 不再只检查 root PID 是否存活，而是调用 `verifyRecordTree()`：

- **有可读 guard**：
  - `verifyGuardedTree()` 必须 `confirmed: true`；
  - `identityMismatch` 必须为 false；
  - 覆盖 supervisor、CLI、Linux cgroup/process group 成员。
- **guard 缺失/损坏/身份不匹配**：拒绝 resolve。只要 journal 记录了 supervisor（`processKind`、`guardPath` 或 `supervisorPid`），缺失 guard 即 fail-closed。
- **legacy 记录（无 guard）**：
  - 有 PID：PID 已消失且身份不可复用，或明确拒绝；
  - 有 POSIX process group：必须枚举成功且成员为空；
  - PID 为 null 且无 group/guard 的既有 operator-attestation 路径保留（R01 依赖），这是唯一不提供自动树证明的路径。
- guard 校验抛错转为 `confirmed: false`，不会误放行。

### 6.2 测试（R15–R19）

文件：`apps/runner/test/recovery-resolution.spec.ts`

| 用例 | 场景                                                 | 关键断言                                                            |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| R15  | guard 中 supervisor PID 仍存活且身份匹配             | 拒绝；reason 含 `still alive`；journal 保持 active；`finish` 未调用 |
| R15b | guard 校验时 `inspectProcess` 抛错                   | 拒绝；reason 含身份未验证；journal 保持 active                      |
| R16  | guard 中 PID 身份与记录不匹配                        | 拒绝；reason 含 `PID identity is not verified`                      |
| R17  | legacy PID 存活且身份匹配                            | 拒绝；reason 含 `PID_STILL_ALIVE`；journal 保持 active              |
| R18  | POSIX、无 root PID、process group 非空（Linux 执行） | 拒绝；reason 含 `PROCESS_GROUP_NOT_EMPTY`                           |
| R19  | guard 可读且全树确认消失                             | 成功；journal 变 interrupted；resolution sidecar 存在               |

R02/R03/R05/R09 等既有真实 OS 用例继续通过，说明真实 supervisor/guard 路径未被削弱。

---

## 7. 验证证据

### 7.1 环境

| 项目     | Windows                                    | Linux                                               |
| -------- | ------------------------------------------ | --------------------------------------------------- |
| 系统     | Windows NT 10.0.26200.0                    | WSL2 Ubuntu 24.04                                   |
| Node     | v24.14.0                                   | v22.14.0                                            |
| pnpm     | 11.5.2                                     | 11.5.2                                              |
| 代码状态 | `663cc28df213f1855ed72437dd8efb7cf96906ae` | 同一提交内容复制到 `/tmp/haft-slice02-linux` 后执行 |
| 依赖     | 工作区既有 `node_modules`                  | `CI=true pnpm install --frozen-lockfile`            |

Linux 证据的说明：工作区位于 Windows 文件系统的 Git worktree 中，WSL 内 Git worktree 元数据路径不可用，因此将仓库内容（排除 `node_modules`/`.git`）复制到 WSL 临时目录，安装同一 lockfile 依赖后运行同一批测试文件。测试内容与提交一致。

### 7.2 命令与结果

| 命令                                               | 平台    | 结果                                                      |
| -------------------------------------------------- | ------- | --------------------------------------------------------- |
| `pnpm --filter @raft-lite/runner typecheck`        | Windows | 通过                                                      |
| `pnpm --filter @raft-lite/runner build`            | Windows | 通过（tsup，3 个入口）                                    |
| `pnpm --filter @raft-lite/runner test`             | Windows | 21 个测试文件；193 passed，3 skipped，196 total；约 39.7s |
| `pnpm lint`                                        | Windows | 通过（`eslint . --max-warnings=0`）                       |
| `prettier --check`（本次改动的 7 个源码/测试文件） | Windows | 通过                                                      |
| `pnpm --filter @raft-lite/runner typecheck`（WSL） | Linux   | 通过                                                      |
| `vitest run`（WSL，完整 runner 测试集）            | Linux   | 21 个测试文件；194 passed，2 skipped，196 total；约 6.2s  |

跳过的用例均为平台专属：

- Windows 跳过 S6、S8（POSIX-only）与 R18（POSIX-only）。
- Linux 跳过 S7（Windows supervisor）与 R04b（Windows taskkill 注入）。

关键新增用例均已在对应平台实际执行：

- F1–F9：Windows 与 Linux 均通过。
- S1–S6、S8：Linux 通过；S1–S5、S7：Windows 通过（S6、S8 按平台跳过）。
- R13–R19：Windows 与 Linux 均通过（R18 仅在 Linux 执行）。
- 真实 Windows supervisor 的 S7 与既有 R02/R03/R05/R09 均在 Windows 通过。

### 7.3 格式门禁说明

`pnpm format:check` 当前失败，原因是 4 个**本任务未修改**的文件不在既有格式债基线中：

- `apps/runner/src/process-guard.ts`
- `apps/runner/src/process-supervisor-child.ts`
- `apps/runner/src/recovery-admin.ts`
- `apps/runner/test/recovery-hardening-os.spec.ts`

这 4 个文件在本提交中没有 diff；失败在基线 `324b6d7` 上同样存在。本任务修改/新增的 7 个文件已通过 `prettier --check`，未通过修改格式债务基线来掩盖问题。

---

## 8. 冻结边界合规

| 边界                | 结论 | 说明                                                             |
| ------------------- | ---- | ---------------------------------------------------------------- |
| `main`              | 未改 | 只在功能分支提交                                                 |
| 冻结设计文档        | 未改 | 未修改计划、Roadmap、复审报告                                    |
| 协议 / Schema       | 未改 | 未修改 contracts、消息顺序或错误码                               |
| 既有测试            | 未删 | 仅新增测试文件与一个测试 fixture                                 |
| Job Object 保护顺序 | 未改 | `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread` |
| Slice 1             | 未做 | 无 Slice 1 实现或文档                                            |
| force push / rebase | 未做 | 新分支直接提交                                                   |

---

## 9. 残留说明与复审关注点

1. **legacy operator attestation**：PID 为 null、且没有 guard/process group 的旧 journal 仍允许人工 resolve（R01 既有语义）。一旦 journal 记录了 supervisor、guardPath 或 supervisorPid，缺失 guard 即拒绝。复审可确认该兼容路径是否仍符合 Slice 0.2 预期。
2. **Windows process group**：P2-3 的 process group 枚举只在 POSIX 执行；Windows 依赖 guard 的 Job Object 语义与 supervisor/CLI 身份校验。
3. **unready supervisor 清理**：只能证明 Node 持有的直接子进程被信号终止，不能证明其受保护树消失，因此结果始终 `confirmed: false`，active journal 保留给启动恢复。
4. **格式门禁**：见 §7.3，属于基线既有问题，不在本任务范围内修改。
5. 本次未执行根级 `pnpm test`（含 API/Web/Contracts 与数据库依赖）；执行范围为 runner 的相关回归、Windows 真实 supervisor 用例、类型检查、构建与 lint。

---

## 10. 复审请求

请新的独立只读复审至少覆盖：

1. `finalize()` 是否在任何 `await` 之前完成互斥；并发请求是否共享同一 Promise；Journal/事件是否严格一一对应。
2. 仲裁顺序是否确定；树未确认与 Journal 失败是否都不产生成功事件。
3. Windows starting guard 是否在 `SpawnCli()` 前完成写入与读回验证；失败是否确实阻止 CLI 创建。
4. `terminate`/`verifyTreeGone` 在 `ready` 拒绝时是否不抛、不误报 confirmed；清理等待是否有界。
5. `resolve-corrupt` 是否只接受 recovery root 直属的 `*.corrupt-<digits>` 普通文件。
6. 人工 resolve 是否在 guard/process group/legacy PID 各路径上完成全树证明。
7. 测试是否使用确定性故障注入，且在 Windows/Linux 的可执行范围内实际运行。

在复审给出结论前，本任务不宣布 WP-D Slice 0.2 PASS，不进入 Slice 1。
