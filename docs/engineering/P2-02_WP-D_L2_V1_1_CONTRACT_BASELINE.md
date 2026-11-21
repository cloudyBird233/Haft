# P2-02 WP-D L2 v1.1 契约基线（Slice 1 追踪件）

状态：**已固化，供 Slice 1 / Slice 1.1 与后续切片共同引用**
来源：**2026-11-12 L2 v1.1 Schema 终审**
落地范围：`Execution.terminal*`、`ExecutionRegistrationAudit`、对应 SQLite Trigger

> 本文件与 `apps/api/test/fixtures/l2-v1.1-contract.json` 是同一份基线的两种表达：
> 人类可读的追踪文档 + 机器可读的测试 fixture。测试从 fixture 反向断言
> `packages/contracts` 与 Migration 中的 SQL，避免"测试与实现同源"。
>
> 若本文件与 2026-11-12 终审原件冲突，以原件为准；发现冲突必须先修本文件与
> fixture，再修代码，不得只改其中一侧。

---

## 1. TerminalDecision（13 个合法值，冻结）

| # | decision | 映射 status |
| --- | --- | --- |
| 1 | `COMPLETED` | `completed` |
| 2 | `CANCELLED_CONFIRMED` | `cancelled` |
| 3 | `EXECUTION_FAILED` | `failed` |
| 4 | `START_REJECTED` | `failed` |
| 5 | `START_ACCEPT_TIMEOUT` | `failed` |
| 6 | `START_SEND_UNCONFIRMED` | `failed` |
| 7 | `RUNNER_DISCONNECTED` | `failed` |
| 8 | `RUNNER_RESTARTED` | `failed` |
| 9 | `RUNNER_INTERRUPTED` | `failed` |
| 10 | `RUNNER_START_UNCONFIRMED` | `failed` |
| 11 | `RECOVERY_DEADLINE_EXCEEDED` | `failed` |
| 12 | `MESSAGE_INTEGRITY_FAILED` | `failed` |
| 13 | `CLOCK_ANOMALY` | `failed` |

- 集合、拼写、映射三者都不可增删改；新增值必须同时修改 Migration Trigger 与
  `TERMINAL_DECISIONS` / `TERMINAL_DECISION_STATUS`，并重新走契约终审。
- 历史实施报告中出现过的 `CLI_EXIT_NONZERO`、`CLI_TIMEOUT`、
  `REPOSITORY_PREPARE_FAILED`、`REPOSITORY_READY_TIMEOUT`、`DISPATCH_REJECTED`、
  `RUNNER_LOST`、`RECOVERY_UNRESOLVED`、`CANCELLED_BEFORE_START` **不属于**
  本基线，数据库会拒绝。

## 2. ExecutionRegistrationAudit（13 个标量字段，冻结）

| # | 字段 | 可空 | 说明 |
| --- | --- | --- | --- |
| 1 | `id` | 否 | 主键 |
| 2 | `executionId` | 否 | 外键 → `Execution.id`，`ON DELETE CASCADE` |
| 3 | `runnerId` | 否 | 非外键，Runner 删除后审计仍保留 |
| 4 | `previousRegistrationId` | 是 | 被替换的 registration；首次绑定为 NULL |
| 5 | `previousRegistrationEpoch` | 是 | 与 `previousRegistrationId` 成对出现 |
| 6 | `newRegistrationId` | 否 | 本次尝试/采纳的 registration |
| 7 | `newRegistrationEpoch` | 否 | 非负整数 |
| 8 | `dispatchState` | 否 | 六态之一 |
| 9 | `decision` | 否 | `adopted` / `rejected` / `superseded` |
| 10 | `reasonCode` | 是 | `rejected` 必填 |
| 11 | `detail` | 是 | 自由文本，不含敏感内容 |
| 12 | `messageId` | 是 | 关联的握手消息 |
| 13 | `createdAt` | 否 | 写入时刻 |

### 2.1 decision 语义（数据库执法口径）

| decision | 约束 |
| --- | --- |
| `adopted` | 有 `previousRegistrationEpoch` 时，`newRegistrationEpoch` 必须恰好 `previous + 1`（与 `Runner_registration_guard` 只允许 +1 一致）；首次绑定（previous 为 NULL）不要求前进量 |
| `rejected` | 必须有非空 `reasonCode`；历史 registration 不被改写 |
| `superseded` | 必须提供 `previousRegistrationId` 与 `previousRegistrationEpoch`，且 `newRegistrationEpoch > previousRegistrationEpoch`；表示该 registration 已被更新的注册取代，是一条历史审计 |

### 2.2 append-only

- `ExecutionRegistrationAudit_no_update` 拒绝任何 UPDATE。
- 行只随 `Execution` 级联删除；`runnerId` 故意不是外键，Runner 删除不会带走审计。
- SQLite 默认不为外键级联动作触发 Trigger，因此级联删除仍然可用。

## 3. Terminal Tuple（数据库不变量）

对 `Execution` 的任意一行：

1. `terminalDecision`、`terminalDecidedAt`、`terminalDecidedBy` **全空或全非空**。
2. 当 `status ∈ {completed, failed, cancelled}`：
   - `dispatchState = 'terminal'`；
   - `phase = status`；
   - `endedAt IS NOT NULL`；
   - `terminalDecision` 属于第 1 节的 13 个值，且与 status 的映射一致；
   - `terminalDecidedAt` 是**正整数 Unix 毫秒**（SQLite `typeof = 'integer'` 且 `> 0`）；
   - `terminalDecidedBy` 以 `API:` 或 `MIGRATION:` 开头，且前缀后非空。
3. 非终态行不得携带终态元组，也不得 `dispatchState = 'terminal'`。
4. 终态行的 `status`、`phase`、`dispatchState`、终态元组、`endedAt`、`exitCode` 不可修改。
5. 进入终态的唯一合法转换是 `running -> completed | failed | cancelled`。
6. Runner 身份（例如 `rn_*`、`runner:*`）不是合法 `terminalDecidedBy`。

历史遗留的 `cancelled` 行是唯一例外：Slice 1 不为它们伪造
`CANCELLED_CONFIRMED`，其终态元组保持 NULL，只把 `dispatchState` 置为
`terminal`。这类行不能复活，也不能补写裁决（T2 仍会拒绝）。

## 4. terminalDecidedBy（身份前缀与既定身份）

合法前缀：`API:`、`MIGRATION:`。

| 身份 | 使用方 |
| --- | --- |
| `API:operator` | 操作员发起的取消（mock 直接取消、runner 侧 `safeToFinalize`） |
| `API:terminal-event` | Runner / 真实 runtime 上报的 terminal 事件 |
| `API:reconciler` | 预留：Slice 2 重建/对账路径 |
| `API:start-gate` | start 之前的失败门禁（`failExecutionStart`） |
| `API:recovery-scanner` | 预留：Slice 2 恢复扫描 |
| `API:mock-runtime` | Mock runtime 的终态路径与 demo seed |
| `MIGRATION:wp-d-backfill` | Slice 1 历史回填，仅此一处 |

禁止：`api:*`（小写）、`seed:*`、`legacy-backfill`、Runner 身份、空前缀。

## 5. 执法点

| 层 | 位置 | 作用 |
| --- | --- | --- |
| T1 | `Execution_terminal_insert_guard` | 直接插入终态行时校验元组、phase、decision、时间戳类型、身份前缀 |
| T2 | `Execution_terminal_update_guard` | 终态行不可改写 |
| T3 | `Execution_terminal_write_guard` | 离开 `running` 时必须完整、类型正确、身份合法 |
| T9 | `ExecutionRegistrationAudit_insert_guard` | 三种 decision 的合法性与 epoch 语义 |
| T10 | `ExecutionRegistrationAudit_no_update` | 审计 append-only |
| 应用层 | `writeTerminalDecision` | 单一终态写入口；条件更新第一写者胜 |
| 测试 | `database-triggers.integration.spec.ts` / `migration.integration.spec.ts` | 直接执行 SQL 验证上述每一条 |
