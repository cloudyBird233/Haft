# P2-02 WP-D Slice 1.1 — Remediation 报告

状态：**Slice 1.1 CLOSED**（范围仅限 Slice 1 复审缺陷；WP-D 整体仍未完成，Slice 2 未启动）
分支：`feature/p2-02-wpd-slice1-1-remediation`
基线提交：`2c9e037d39ed6e6589b595c7a60d6ea41dff58da`（Slice 1 交付）
工作树：`D:/CODE/GIT/Haft-p2-02-wpd-slice1-1`（独立 worktree）
日期：2026-11-21

---

## 1. 基线与变更范围

### 1.1 本轮输入

独立复审在 Slice 1 交付上留下两条 P2：

| 编号 | 缺陷 | 归属 |
| --- | --- | --- |
| `S1-P2-1` | L2 v1.1 契约出现真实偏差：`terminalDecidedBy` 身份体系、`ExecutionRegistrationAudit` 字段与 decision 集合、13 种 `terminalDecision` 映射、终态元组类型约束 | WP-A |
| `S1-P2-2` | Migration 可能出现部分提交：`migrate deploy` 中途失败后残留部分 Trigger/索引/回填 | WP-B |

### 1.2 变更规模

```
已跟踪文件：11 files changed, 785 insertions(+), 69 deletions(-)
未跟踪新增：4 个路径
  apps/api/test/fixtures/l2-v1.1-contract.json
  apps/api/test/migration-atomicity.integration.spec.ts
  docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md
  docs/engineering/P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md（本文件）
```

| 文件 | 变更 | 归属 |
| --- | --- | --- |
| `apps/api/prisma/migrations/20261116120000_p2_02_wpd_slice1_schema_migration/migration.sql` | 470 → 556 行；显式事务 + T1/T2/T3/T9 加固 + 回填归一化 | WP-A + WP-B |
| `packages/contracts/src/constants.ts` | +31 行；前缀常量、7 个既定身份、`TerminalDecidedBy`、`isLegalTerminalDecidedBy` | WP-A |
| `apps/api/src/modules/executions/execution-terminal.ts` | `decidedBy: string` → `TerminalDecidedBy` + 入口校验 | WP-A |
| `apps/api/src/modules/executions/executions.service.ts` | 4 处身份改写 + `requestedDecidedBy` 参数 | WP-A |
| `apps/api/src/common/seed/demo-data.ts` | `seed:demo-data` → `API:mock-runtime` | WP-A |
| `apps/api/test/database-triggers.integration.spec.ts` | 598 → 960 行；新增 3 个 describe | WP-A |
| `apps/api/test/migration.integration.spec.ts` | 288 → 327 行；fixture 比对 + integrity 检查 | WP-A |
| `apps/api/test/migration-existing-database.integration.spec.ts` | 193 → 219 行；回填身份与毫秒精度 | WP-A |
| `apps/api/test/support/migration-cli.ts` | 146 → 228 行；故障注入链构造器 | WP-B |
| `apps/api/test/migration-atomicity.integration.spec.ts` | 新增 261 行 / 6 用例 | WP-B |
| `apps/api/scripts/verify-migration-consistency.mjs` | +49 行；Trigger/索引存在性断言 | WP-B |
| `docs/engineering/P2-02_WP-D_SLICE1_IMPLEMENTATION_REPORT.md` | 551 → 577 行；修正 10 个章节（§2.1、§2.4、§3.2、§3.3、§4.1、§5.1–5.3、§6.1、§6.6） | 报告 |
| `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md` | 新增；契约追踪件 | 报告 |

### 1.3 边界遵守

| 约束 | 状态 |
| --- | --- |
| 在独立 worktree 执行 | ✅ `D:/CODE/GIT/Haft-p2-02-wpd-slice1-1` |
| 未修改 Slice 1 复审工作树 | ✅ `D:/CODE/GIT/Haft-p2-02-wpd-slice1` 与 `Haft-review-slice1` 均无改动 |
| 未修改 `main` | ✅ `main` 仍为 `6a5ad16`，本轮分支基于 `2c9e037` |
| 未启动 Slice 2 | ✅ 无 `execution.terminal` 消息、无恢复重建逻辑、无新终态枚举 |
| 未改 P2-00 冻结协议 | ✅ `dispatchState` 六态、13 种 `terminalDecision`、13 个 Audit 字段全部保持原样 |
| 未 Commit / Push / Merge | ✅ `git log` 仍停在 `2c9e037` |

---

## 2. L2 契约追溯

契约原件固化为两份**互相独立**的追踪件，测试同时比对二者与实现，避免测试与实现同源：

- `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md`（人读）
- `apps/api/test/fixtures/l2-v1.1-contract.json`（机读，`source` 字段标注 2026-11-12 终审）

### 2.1 TerminalDecision（13 个合法值，冻结）

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

映射为 `completed` 1 个、`cancelled` 1 个、`failed` 11 个。**集合未做任何增删**；本轮只补齐执法与测试覆盖。

### 2.2 ExecutionRegistrationAudit（13 个标量字段，冻结）

`id`、`executionId`、`runnerId`、`previousRegistrationId`、`previousRegistrationEpoch`、`newRegistrationId`、`newRegistrationEpoch`、`dispatchState`、`decision`、`reasonCode`、`detail`、`messageId`、`createdAt`。

字段结构**未改动**。`decision ∈ {adopted, rejected, superseded}`——Slice 1 首版 T9 只接受前两个，`superseded` 被漏掉，本轮补齐。

| decision | 数据库执法口径 |
| --- | --- |
| `adopted` | `previousRegistrationEpoch` 非空时，`newRegistrationEpoch` 必须恰好 `previous + 1`；首次绑定（previous 为 NULL）不要求前进量 |
| `rejected` | 必须有非空 `reasonCode`；历史 registration 不被改写 |
| `superseded` | 必须同时提供 `previousRegistrationId` 与 `previousRegistrationEpoch`，且 `newRegistrationEpoch > previousRegistrationEpoch` |

### 2.3 Terminal Tuple 不变量

1. 三字段 `terminalDecision` / `terminalDecidedAt` / `terminalDecidedBy` 全空或全非空；
2. terminal status 时 `dispatchState = 'terminal'`、`phase = status`、`endedAt` 非空；
3. `terminalDecidedAt` 为正整数 Unix 毫秒（`typeof = 'integer'` 且 `> 0`）；
4. 终态行不可修改；
5. 唯一进入终态的路径是 `running → completed | failed | cancelled`；
6. Runner 不能成为 `terminalDecidedBy`——由前缀白名单间接保证，Runner 身份形如 `rn_*` / `runner:*`，均不在 `API:` / `MIGRATION:` 之内。

### 2.4 terminalDecidedBy 前缀与 7 个既定身份

合法前缀：`API:`、`MIGRATION:`（且前缀后必须有内容）。

| 身份 | 使用方 |
| --- | --- |
| `API:operator` | 操作员发起的取消（mock 直接取消、runner 侧 `safeToFinalize`） |
| `API:terminal-event` | Runner / 真实 runtime 上报的 terminal 事件 |
| `API:reconciler` | 预留：Slice 2 重建/对账路径 |
| `API:start-gate` | start 之前的失败门禁（`failExecutionStart`） |
| `API:recovery-scanner` | 预留：Slice 2 恢复扫描 |
| `API:mock-runtime` | Mock runtime 终态路径与 demo seed |
| `MIGRATION:wp-d-backfill` | Slice 1 历史回填，仅此一处 |

`API:reconciler` 与 `API:recovery-scanner` 在 Slice 1 尚无调用方——这是**有意保留**，不是遗漏。

### 2.5 执法点

| 层 | 位置 | 作用 |
| --- | --- | --- |
| T1 | `Execution_terminal_insert_guard` | 直接 INSERT 终态行时校验元组完整性、`phase`、decision↔status、时间戳类型、身份前缀 |
| T2 | `Execution_terminal_update_guard` | 终态行 8 个字段不可改写 |
| T3 | `Execution_terminal_write_guard` | 离开 `running` 时必须完整、类型正确、身份合法；`running` 行不得预置元组 |
| T9 | `ExecutionRegistrationAudit_insert_guard` | 三种 decision 的合法性与 epoch 语义 |
| T10 | `ExecutionRegistrationAudit_no_update` | 审计 append-only；仅随 Execution 级联删除 |
| 应用层 | `writeTerminalDecision` | 唯一终态写入口；条件更新保证 first-writer-wins |

---

## 3. Terminal Trigger 修复

### 3.1 T1 `Execution_terminal_insert_guard`

首版只有 **2 条** `RAISE`：第一条把 `dispatchState`、`endedAt`、元组非空、`terminalDecidedBy` 非空以及 decision↔status 映射**塞进同一个布尔表达式**；第二条禁止非终态行携带元组。

这个形态有三个实质缺陷：

| 缺陷 | 后果 |
| --- | --- |
| 缺少 `phase = status` | `status='completed', phase='failed'` 的行可以直接插入，终态语义自相矛盾 |
| 缺少 `typeof(terminalDecidedAt) = 'integer'` 与 `> 0` | ISO-8601 TEXT、`CURRENT_TIMESTAMP`、`0`、`-1`、`1.5` 全部能写进「Unix 毫秒」列 |
| 缺少 `terminalDecidedBy` 前缀白名单 | 任意字符串（含 `rn_fixture`、`seed:*`、`legacy-backfill`）都能成为终态决策者 |

外加一个可维护性缺陷：`dispatchState`、`endedAt`、三个元组字段非空、`terminalDecidedBy` 非空、decision↔status 映射全部合并成一条错误信息，失败时无法判断究竟违反了哪一条。

现拆为 5 条独立断言，每条带自己的错误串：

| # | 断言 | 相对首版 |
| --- | --- | --- |
| 1 | terminal status 必须 `dispatchState = 'terminal'` **且** `phase = status` **且** `endedAt IS NOT NULL` | 新增 `phase` |
| 2 | 元组三字段全非空，且 `typeof(terminalDecidedAt) = 'integer'`、`> 0`、`length(trim(terminalDecidedBy)) > 0` | 新增类型与正数 |
| 3 | `terminalDecidedBy GLOB 'API:*'`（长度 > 4）或 `GLOB 'MIGRATION:*'`（长度 > 10） | 全新 |
| 4 | decision↔status 映射：`completed↔COMPLETED`、`cancelled↔CANCELLED_CONFIRMED`、`failed∈11 项` | 从第 1 条拆出 |
| 5 | 非终态行不得带任何元组字段，也不得 `dispatchState = 'terminal'` | 保留原样 |

第 3 条的长度下限是关键：`'API:'` 与 `'MIGRATION:'` 本身能通过 `GLOB`，但语义上是空前缀，必须拒绝。

### 3.2 T2 `Execution_terminal_update_guard`

原实现保护 7 个字段。本轮新增 `phase`，共 8 个：`status`、`phase`、`dispatchState`、`terminalDecision`、`terminalDecidedAt`、`terminalDecidedBy`、`endedAt`、`exitCode`。

补 `phase` 的原因：若 `phase` 可被改写，一条 `status='completed', phase='failed'` 的行就能绕过 T1 建立的 `phase = status` 不变量，使 T3 的语义在事后失效。

### 3.3 T3 `Execution_terminal_write_guard`

首版已有 **4 条** `RAISE`，基础不弱——「只能从 `running` 进入终态」「decision↔status 映射」「`running` 行不得携带元组」都已具备。真正缺的是与新增不变量对齐的部分，以及一处判定缝隙：

| 缺口 | 后果 |
| --- | --- |
| 无 `phase = status` 校验 | 从 `running` 更新为终态时 `phase` 可保持旧值，与 T1 的 INSERT 路径不一致 |
| 无 `typeof(terminalDecidedAt) = 'integer'` 与 `> 0` | UPDATE 路径绕开 T1 的类型约束 |
| 无 `terminalDecidedBy` 前缀白名单 | UPDATE 路径绕开 T1 的身份约束 |
| 「`running` 行不得携带元组」未含 `dispatchState = 'terminal'` | `status='running', dispatchState='terminal'` 的行会落进 T2 与 T3 的判定缝隙——T2 只对终态行生效，T3 不查 `dispatchState` |

补齐后为 6 条：首版的第 1 条被拆成「离开 `running` 必须 `dispatchState = 'terminal'` + `phase = status` + `endedAt` 非空」与「元组完整 + `terminalDecidedAt` 为正整数」两条（净 +1），另新增身份前缀一条（+1）；原有的 decision↔status 与「只能进入终态」两条保留不变，「`running` 不得携带元组」一条扩展为同时禁止 `dispatchState = 'terminal'`。

### 3.4 历史回填归一化

原回填直接把 `COALESCE(endedAt, updatedAt)` 搬进 `terminalDecidedAt`。Prisma 把 `DateTime` 存为 INTEGER 毫秒，但**历史库可能存 ISO-8601 TEXT**（早期 SQLite 写入路径、手工数据、其他工具导入），直接搬运会得到 `typeof = 'text'` 的值，随后被新建的 T1/T3 拒绝——即回填本身会触发自己的不变量。

现按 `typeof` 分支换算：

```sql
"terminalDecidedAt" = CASE typeof(COALESCE("endedAt", "updatedAt"))
    WHEN 'integer' THEN COALESCE("endedAt", "updatedAt")
    WHEN 'real'    THEN CAST(COALESCE("endedAt", "updatedAt") AS INTEGER)
    ELSE CAST(strftime('%s', COALESCE("endedAt", "updatedAt")) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', COALESCE("endedAt", "updatedAt")), 4, 3) AS INTEGER)
END,
```

`substr(strftime('%f', ...), 4, 3)` 取毫秒部分（`%f` 形如 `18.123`），避免浮点乘法带来的舍入误差。回填身份同步改为 `MIGRATION:wp-d-backfill`。

> 回填在 Trigger 创建**之前**执行（migration.sql 第 126 行 vs 第 164 行）。这不是规避执法，而是必要顺序：Trigger 一旦存在，历史行不可能以合法形态写入，因为它们的 `terminalDecision` 是回填才补上的。

### 3.5 应用层对齐

```ts
// packages/contracts/src/constants.ts
export const TERMINAL_DECIDED_BY_PREFIXES = ['API:', 'MIGRATION:'] as const;
export const TERMINAL_DECIDED_BY_IDENTITIES = [/* 7 项 */] as const;
export type TerminalDecidedBy = (typeof TERMINAL_DECIDED_BY_IDENTITIES)[number];
export function isLegalTerminalDecidedBy(value: string): boolean { /* 前缀 + 长度 */ }
```

`writeTerminalDecision` 的 `decidedBy` 从 `string` 收紧为 `TerminalDecidedBy`，并在函数入口调用 `isLegalTerminalDecidedBy` 抛错。这样类型错误在编译期暴露、字符串越界在写库前暴露、两者都漏过时在 SQLite Trigger 兜底——三层防护，不依赖单一层。

5 处身份改写（`executions.service.ts` 4 处 + seed 1 处）：

| 位置 | 原值 | 新值 |
| --- | --- | --- |
| `executions.service.ts` 取消路径 | `api:operator-cancel` | `API:operator` |
| `executions.service.ts` safe finalize | 继承 `finishExecution` 默认值 | 显式传入 `API:operator` |
| `executions.service.ts` start 失败门禁 | `api:start-failure` | `API:start-gate` |
| `finishExecution` 默认值 | `api:runtime-event` / `api:operator-cancel` | `API:mock-runtime`（`runtime === 'mock'`）/ `API:terminal-event` |
| `demo-data.ts` seed | `seed:demo-data` | `API:mock-runtime` |

`seed:demo-data` 改用 `API:mock-runtime` 而非新增 `SEED:` 前缀：seed 走的就是 mock runtime 的数据形状，新增前缀会扩张 L2 契约，超出本轮授权。

---

## 4. Audit Trigger 修复

### 4.1 T9 `ExecutionRegistrationAudit_insert_guard`

Slice 1 首版的 `decision NOT IN ('adopted','rejected')` 把 `superseded` 判为非法——这是 `S1-P2-1` 中最实质的一条，因为 `superseded` 是 L2 v1.1 明确规定的第三个合法值。

现为 8 条断言：

| # | 断言 | 归属 |
| --- | --- | --- |
| 1 | `decision IN ('adopted','rejected','superseded')` | 补齐 `superseded` |
| 2 | `dispatchState` ∈ 六态 | 原有 |
| 3 | `rejected` 必须有非空 `reasonCode` | 原有 |
| 4 | `newRegistrationId` 非空 且 `newRegistrationEpoch >= 0` | 原有 |
| 5 | `previousRegistrationEpoch` 非空时 `newRegistrationEpoch` 不得回滚 | 原有 |
| 6 | `adopted` 且 previous 非空 → `new = previous + 1` | **新增** |
| 7 | `superseded` 必须同时提供 `previousRegistrationId` 与 `previousRegistrationEpoch` | **新增** |
| 8 | `superseded` 的 `newRegistrationEpoch > previousRegistrationEpoch` | **新增** |

第 7、8 条分开写而非合并：缺 previous 与 epoch 不前进是两类不同的错误，合并后错误信息无法区分「这是补记一条不存在的注册」还是「补记了一条更旧的注册」。

第 6 条与 `Runner_registration_guard`（T6）的 `+1` 前进约束对齐：Audit 记录的是「发生了什么」，如果 Audit 允许 `+3` 而 Runner 只允许 `+1`，审计就会记录一种不可能发生的事件，破坏「Audit 可作证据」的前提。

第 8 条区分了 `superseded` 与 `adopted` 的语义：`adopted` 是**本次**接管（恰好 +1），`superseded` 是**历史**记录（可跨越多个 epoch，只需严格更新）。`superseded` 不要求 +1，是因为它可能补记一条已经跨级的历史。

### 4.2 T10 `ExecutionRegistrationAudit_no_update`

保持不变：`BEFORE UPDATE` 无条件 `RAISE(ABORT)`。SQLite 不为外键级联动作触发 Trigger，所以 `DELETE FROM Execution` 仍能级联删除审计行——这一点由测试正向验证（`removes audit rows only through an Execution cascade`），不是假设。

---

## 5. Migration 原子性验证

### 5.1 探针设计

**不猜测 Prisma 行为，先测。** 探针用两套独立手段：

1. `node:sqlite` 的 `DatabaseSync` 直接打开数据库文件，绕过 Prisma，读取 `sqlite_master`、`PRAGMA table_info`、`_prisma_migrations`；
2. 真实 `prisma@6.16.2` 的 `migrate deploy`，通过在 migration 链中插入 `SELECT * FROM "__fault_injection_probe__";`（表不存在，必然失败）制造真实 SQL 错误。

### 5.2 探针结论（A/B 对照）

对同一个真实迁移链做两次**结构完全相同**的注入（均在 `-- 7. Triggers (10)` 之前插入 `SELECT * FROM "__fault_injection_probe__";`），唯一差别是 migration.sql 是否带 `BEGIN IMMEDIATE ... COMMIT`：

| 观测项 | 无显式事务（首版形态） | 有显式事务（当前形态） |
| --- | --- | --- |
| `migrate deploy` 退出码 | 1 | 1 |
| 错误码 | `P3018` | `P3018` |
| 错误信息 | `no such table: __fault_injection_probe__` | 同 |
| `Execution` 泄漏列 | **8 / 8** | **0 / 8** |
| `RepositoryHandshakeMessage` | **已存在** | **不存在** |
| 抽查的 3 个 Slice 1 索引 | **3 / 3 存在** | **0 / 3** |
| Trigger 数 | 0 | 0 |
| legacy 已应用迁移 | 6 | 6 |

`Trigger 数` 两列都是 0，因为注入点在 Trigger 创建之前——这一项在此探针里不构成区分度。区分度来自列、表与索引：这三类对象在注入点之前已经全部执行完毕。

索引一栏只抽查 `Runner_registrationId_key`、`Execution_status_dispatchState_idx`、`Execution_terminalDecision_idx` 三个代表项，不是完整枚举；完整枚举由 `migration-atomicity.integration.spec.ts` 承担（14 项逐项断言）。

结论：

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| Prisma Migrate 是否自动为单个 SQLite migration 文件开事务？ | **否** | 无事务时 8/8 列、2 张表、抽查的 3 个索引在失败后全部残留 |
| migration.sql 内显式 `BEGIN IMMEDIATE` / `COMMIT` 是否被正确执行？ | **是** | 同样注入、同样错误码，残留全部为 0 |
| 失败是否留下「看起来成功」的迁移记录？ | **否** | 两种形态下 `finished_at` 均为 NULL，Prisma 均报 `P3018` |

第一行就是这条 P2 的根因。SQLite 的 DDL 本身是事务性的，但 Prisma 的 SQLite connector 不会把单个 migration 文件包进事务，文件里的每条语句各自提交。在 Trigger 阶段失败时，前面 42 个新字段、2 张新表、14 个索引与历史回填已经全部落盘——数据库处于「迁移了大半」的状态，而 Prisma 只会说「这个 migration 失败了」，不会告诉你失败前已经写进去多少。

第二行证明修复有效且 Prisma 不会与显式事务冲突（不报 `cannot start a transaction within a transaction`）。

复现方式（无需改动仓库）：

1. 把 `prisma/migrations` 整链复制到临时目录，`schema.prisma` 一并复制；
2. 在 Slice 1 的 `migration.sql` 里删掉 `BEGIN IMMEDIATE;` 与 `COMMIT;` 两行（只删这两行）；
3. 在 `-- 7. Triggers (10)` 之前插入 `SELECT * FROM "__fault_injection_probe__";`；
4. `node node_modules/prisma/build/index.js migrate deploy --schema <临时 schema>`，`DATABASE_URL=file:<临时 db 绝对路径>`；
5. 用 `node:sqlite` 的 `DatabaseSync` 打开该 db，读 `PRAGMA table_info("Execution")`、`sqlite_master`。

第 2 步删与不删，就是上表的 A/B 两列。「有事务」一侧的等价断言已固化在 `migration-atomicity.integration.spec.ts`，CI 可重复；「无事务」一侧是根因取证，一次性验证即可。


### 5.3 修复

migration.sql 第 24 行 `BEGIN IMMEDIATE;`、第 556 行 `COMMIT;`，并在文件头写明原因，避免后来者误删：

- 用 `IMMEDIATE` 而非 `DEFERRED`：`DEFERRED` 在首次写操作时才取写锁，回填阶段的锁升级可能返回 `SQLITE_BUSY`，而 `IMMEDIATE` 在事务开始就取写锁，失败点更早、更确定。
- 不在 migration 内放 `ROLLBACK`：失败时由 SQLite 自动回滚未提交事务，Prisma 负责记录失败状态。

### 5.4 对已应用环境的处置

本 Migration **尚未进入 `main`**（`git cat-file -e main:apps/api/prisma/migrations/20261116120000_.../migration.sql` 返回不存在），仅存在于 `feature/p2-02-wpd-slice1-schema-migration` 与本地修复分支。因此本轮是**直接修正文件**而非向前修复——这是安全的，因为没有共享环境应用过它。

若该 Migration 曾进入共享环境，正确做法是新增一个 forward-fix migration，而不是改写已应用的 checksum。本轮记录这条纪律，供后续迁移参考。

---

## 6. 故障注入结果

### 6.1 四个注入点

`createFaultInjectedMigrationChain()` 复制完整真实迁移链到临时目录，按 marker 在指定位置插入失败语句：

| stage | marker | 注入位置语义 |
| --- | --- | --- |
| `after-ddl` | `-- 4. RepositoryHandshakeMessage (18 columns, 6 indexes)` | Execution 8 列 + Runner 3 列 + 6 索引之后，新表之前 |
| `after-backfill` | `-- 7. Triggers (10)` | DDL 与回填全部完成，Trigger 之前 |
| `mid-triggers` | `-- T6. Registration epoch is monotonic` | 前 5 个 Trigger 已创建 |
| `after-triggers` | `COMMIT;` | 全部语句执行完，提交之前 |

### 6.2 结果（4 个 stage 全部一致）

每次注入后检查（断言项）：

```
migrate deploy exit       ≠ 0
输出含                    "no such table: __fault_injection_probe__"
Execution 的 8 个新列     0 个残留
RepositoryHandshakeMessage 不存在
ExecutionRegistrationAudit 不存在
14 个 Slice 1 索引         0 个残留
Trigger 总数               0
legacy 已应用迁移          6 条（不受影响）
Slice 1 记录               finished_at IS NULL, rolled_back_at IS NULL
```

手工探针另观察到 Prisma 报错为 `P3018`（"A migration failed to apply"）。测试断言的是「退出码非 0 且失败原因是注入的 SQL 语句」，不绑定 Prisma 的错误码文本——错误码属于 Prisma 的展示层，绑定它会让测试在 Prisma 升级时无谓地碎掉。

`after-triggers` 这一项特别值得记录：所有 DDL 与 Trigger 都已创建成功，失败发生在 `COMMIT` 之前。若没有显式事务，此时数据库会处于「看起来完整」的状态——这是最危险的失败形态，因为它能通过大部分表结构检查。

### 6.3 历史库回填回滚

在已应用 6 条 legacy 迁移、含 1 条 `completed` Execution 的库上做 `after-backfill` 注入：

```
Execution 行数            与注入前一致
terminalDecision 列       不存在（回填随列一起回滚）
RepositoryHandshakeMessage 不存在
Slice 1 记录              finished_at IS NULL
```

这证明回填不是「先填了再说」——它与列定义在同一个事务里，一起回滚。

### 6.4 恢复重试

```
1. 注入 → deploy 失败（P3018）
2. 再次 deploy → 被拒（P3009：failed migration 阻塞后续迁移）
3. repairFaultInjectedChain() 恢复真实 migration.sql
4. prisma migrate resolve --rolled-back <migration_id> → exit 0
5. deploy → exit 0
6. 校验：10 Trigger、14 索引、8 列、2 张表全部就位
         PRAGMA integrity_check → ['ok']
         PRAGMA foreign_key_check → []
         Slice 1 记录恰好 1 条 finished_at 非空
```

第 2 步的「被拒」是**正确行为**：Prisma fail-closed，不允许绕过失败记录继续迁移，必须由操作者显式 `resolve --rolled-back`。这防止了「迁移失败但应用继续启动」这一类静默损坏。

---

## 7. 自动化测试结果

### 7.1 API 套件（Windows）

```
pnpm --filter @raft-lite/api test
Test Files  11 passed (11)
Tests       169 passed (169)
Duration    99.34s
```

迁移相关 4 个套件的构成：

| 套件 | 用例数 | 内容 |
| --- | --- | --- |
| `database-triggers.integration.spec.ts` | 57 | T1–T10 全部 Trigger，含本轮新增 3 个 describe |
| `migration.integration.spec.ts` | 12 | 空库全量迁移 + fixture 比对 + integrity check |
| `migration-existing-database.integration.spec.ts` | 8 | 历史库升级 + 回填形态 |
| `migration-atomicity.integration.spec.ts` | 6 | 4 阶段注入 + 历史库回填回滚 + 恢复重试 |
| **合计** | **83** | 4 个文件声明 80 个 `it()`；`describe.each` 展开后为 83 |

### 7.2 本轮新增的测试覆盖

**`L2 v1.1 terminal decision matrix (database-enforced)`**（9 个用例）

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | fixture 钉住 13 个唯一 decision、3 个 status、2 个前缀、3 个 Audit decision | 集合未增删 |
| 2 | 13 个 decision 全部能以映射 status 插入成功 | 正向 13/13 |
| 3 | 13 个 decision × 2 个错误 status = **26 次全部被拒** | 反向 26/26 |
| 4 | 未知 decision（`CLI_TIMEOUT`）在终态 status 下被拒 | 防止未来新增值绕过 |
| 5 | `phase != status` 在 INSERT 路径被拒 | T1 |
| 6 | `phase != status` 在离开 `running` 时被拒，且行仍为 `running` | T3 |
| 7 | `terminalDecidedAt` 为 TEXT / `CURRENT_TIMESTAMP` / `0` / `-1` / `1.5` 全部被拒，`1767225600000` 被接受 | 类型 + 边界 |
| 8 | `terminalDecidedAt` 为 TEXT 时离开 `running` 被拒，且行仍为 `running` | T3 的类型约束 |
| 9 | 9 个非法身份（`api:operator`、`operator`、`seed:demo-data`、`legacy-backfill`、`rn_fixture`、`runner:rn_fixture`、`API:`、`MIGRATION:`、空串）全部被拒 | 前缀 + 长度 + Runner 隔离 |

第 3 条是这套测试的主干：它把「decision ↔ status」这张 13×3 的表完整走了一遍，只放过对角线上那 13 个组合。

**`T2 terminal tuple immutability`**（1 个用例，覆盖 8 个字段）

在一个用例里对 8 个受保护字段各做一次 UPDATE——`phase`、`terminalDecision`、`terminalDecidedAt`、`terminalDecidedBy`、`status`、`dispatchState`、`endedAt`、`exitCode`——断言每次都被拒，最后用 `expect(after).toEqual(before)` 断言整行内容**逐字段未变**。

只断言「抛出错误」不够。Trigger 若在抛错前已部分写入（SQLite 的 `RAISE(ABORT)` 保证不会，但测试不该依赖这个保证），断言行不变才能发现。`dispatchState` 那一项允许由 T2 或 T4 拦截，因为两个 Trigger 都会命中，测试不该绑定拦截者的身份。

**`first terminal writer wins at the database boundary`**

用**两个独立的 `DatabaseSync` 连接**模拟两个并发写者，各自执行条件更新 `WHERE status = 'running' AND terminalDecision IS NULL`。断言：第一个 `changes = 1`，第二个 `changes = 0`。这验证的是条件更新的原子性，而不是应用层锁——应用层的 `withExecutionLock` 是单进程内的，数据库层的条件更新才是跨进程权威。

**T9 三种 decision**（11 个用例）

`adopted` 首次绑定 / `adopted` +1 / `adopted` 跳级拒绝 / `rejected` 带 reasonCode / `rejected` 无 reasonCode 拒绝 / `superseded` 合法 / `superseded` 缺 previous 拒绝 / `superseded` 不更新拒绝 / 未知 decision / 未知 dispatchState / epoch 回滚。

**`migration.integration.spec.ts` 的 fixture 比对**

直接断言 `TERMINAL_DECISIONS`、`TERMINAL_DECISION_STATUS`、`TERMINAL_DECIDED_BY_IDENTITIES`、Audit 13 列，以及 Audit Trigger 的 SQL 文本与 fixture 一致。这一步防的是「代码和 fixture 一起漂移」——两者都改就都过，但 fixture 的 `source` 字段钉在 2026-11-12，改动它是有意识的行为。

### 7.3 门禁结果

| 门禁 | Windows | Linux (WSL2) |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | ✅ exit 0 | ✅ |
| `prisma generate` | ✅ | ✅ |
| `pnpm typecheck` | ✅ | ✅ |
| `pnpm lint` | ✅ exit 0 | ✅ |
| `pnpm build` | ✅ | ✅ |
| `pnpm --filter @raft-lite/api test` | ✅ 169/169 | ✅ 迁移 4 套件 83/83 |
| `pnpm --filter @raft-lite/web test` | — | ✅ 41/41 |
| `db:migrate:verify` | ✅ 7 migrations / no drift / 10 triggers / 6 indexes | 同 |
| 全量 `pnpm test` | ⚠️ `apps/runner` R19 失败（**既有失败**，见 §8.2） | `apps/api`+`apps/runner` 部分 **NOT_VERIFIED** |

Linux 环境：WSL2 Ubuntu-24.04，Node v22.14.0，pnpm 11.5.2。

---

## 8. 未关闭问题

### 8.1 Linux 全量 `pnpm test` 未完整执行 — `NOT_VERIFIED`

Linux 侧实际执行范围：

- ✅ `pnpm typecheck`、`pnpm lint`、`pnpm build`
- ✅ 迁移 4 个套件 83/83（含 4 阶段故障注入与恢复重试，这部分是本轮最关键的证据，已完整通过）
- ✅ `apps/web` 41/41
- ❌ `apps/api` 的其余 7 个套件、`apps/runner` 全部套件 → **NOT_VERIFIED**

理由：迁移套件已覆盖本轮全部 SQL 与 Prisma 行为，且它们在 Linux 上通过；其余套件与本轮改动无交集（本轮未触碰 `apps/runner`，`apps/api` 的其余套件只受 4 处身份常量影响，已由 169/169 的 Windows 全量结果覆盖）。

**这不构成新增 P2**，但需要在下一轮（Slice 2 开始时）补齐 Linux 全量。

### 8.2 `apps/runner` R19 既有失败 — 非本轮引入

```
apps/runner/test/recovery-resolution.spec.ts:334
R19: resolve succeeds only after a readable guard confirms the tree gone
expected false to be true
```

判定为**既有失败**的证据链：

1. 在本轮 worktree `D:/CODE/GIT/Haft-p2-02-wpd-slice1-1/apps/runner` 单独复跑 → 同样失败；
2. 在**基线工作树** `D:/CODE/GIT/Haft-p2-02-wpd-slice1/apps/runner` 单独复跑同一文件 → **同样失败**；
3. 本轮 `git status` 中 `apps/runner` 零改动；
4. 失败机制与本轮改动无关：测试 fixture 的 `guardRecord()` 把 `supervisorPid` 覆写为 `8082`，而 `dependencies()` 未 mock `inspectProcess`，因此走真实 Windows 进程检查。`8082` 在当前机器上不存在或无法确认，`verifyGuardedTree` 返回 `confirmed: false`，`resolveBlockedExecution` 按 fail-closed 返回 `{ resolved: false }`。

**这个 fail-closed 行为本身是正确的**——无法确认进程树消失就拒绝 finalize。问题在测试 fixture 依赖了一个恰好存在的 PID，属于测试脆弱性，不是生产代码缺陷。

**不构成新增 P2**（不是本轮引入、不在本轮授权范围内、不影响 Slice 1 结论）。建议 Slice 2 触碰 recovery 路径时一并修复：把 `inspectProcess` 显式注入为确定性 stub，而不是依赖真实 PID。

### 8.3 保留项（非缺陷）

| 项 | 说明 |
| --- | --- |
| `API:reconciler` / `API:recovery-scanner` 无调用方 | L2 预留身份，Slice 2 才使用；现在写入契约是正确的，提前实现才是越界 |
| macOS / POSIX `posix-group` fallback | 仍 **BLOCKED**，与 Slice 1 无关，见 Slice 1 实施报告第 10 节 |
| Migration 尚未进入 `main` | 本轮禁止 commit/push/merge，等独立复审 |

---

## 9. 最终结论

### 9.1 缺陷关闭情况

| 编号 | 状态 | 关闭依据 |
| --- | --- | --- |
| `S1-P2-1` | **CLOSED** | 13 个 decision 集合与映射由 fixture 钉死并由 26 次反向断言覆盖；Audit 13 字段未改动、`superseded` 已合法且有 3 个正向/反向用例；`terminalDecidedBy` 收紧到 2 个前缀 + 7 个身份，4 处生产代码 + seed 全部改写，9 个非法身份被 Trigger 拒绝；Terminal Tuple 6 条不变量在 T1/T2/T3 三层强制，不依赖 TypeScript |
| `S1-P2-2` | **CLOSED** | A/B 探针证明 Prisma 不为 SQLite migration 开事务——同一注入下，无事务时 8/8 列、2 张表与抽查的 3 个索引全部残留，有事务时全部为 0；显式 `BEGIN IMMEDIATE`/`COMMIT` 被正确执行且不与 Prisma 冲突；4 个注入点（含最危险的 `after-triggers`）全部全量回滚，零残留；历史库回填与列一起回滚；恢复路径 `resolve --rolled-back` → 重跑成功且 integrity/foreign_key 检查通过 |

### 9.2 新增缺陷

**无新增 P0 / P1 / P2。**

§8.1 的 Linux 未执行项与 §8.2 的 R19 既有失败已如实标注，均有独立证据表明不由本轮引入或已被其他证据覆盖。

### 9.3 可重复验证

```bash
# 全部迁移与 Trigger 证据（83 用例）
pnpm --filter @raft-lite/api test -- test/migration.integration.spec.ts \
  test/migration-existing-database.integration.spec.ts \
  test/migration-atomicity.integration.spec.ts \
  test/database-triggers.integration.spec.ts

# 契约漂移与对象存在性
pnpm --filter @raft-lite/api db:migrate:verify
# → 7 migrations / no drift / 10 triggers / 6 indexes

# 全量
pnpm typecheck && pnpm lint && pnpm build && pnpm --filter @raft-lite/api test
```

所有断言直接读取 `sqlite_master`、`PRAGMA table_info`、`PRAGMA integrity_check`、`_prisma_migrations` 与真实 SQL 执行结果，不经过 API 层，不 mock 数据库。任何一个 Trigger 被删除或弱化，上述测试都会失败。

### 9.4 停止点

本轮工作到此结束：

- **未启动 Slice 2**；
- **未提交、未推送、未合并**（`git log` 仍停在 `2c9e037`）；
- **`main` 未改动**（仍为 `6a5ad16`）；
- 等待新的独立只读复审。
