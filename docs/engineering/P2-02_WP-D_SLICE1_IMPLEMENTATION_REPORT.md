# P2-02 WP-D Slice 1 — Schema & Migration 实施报告

状态：**Slice 1 PASS**（范围仅限本文件第 1 节声明的 Slice 1；WP-D 整体未完成）
分支：`feature/p2-02-wpd-slice1-schema-migration`
基线提交：`d409d2e`（Slice 0.2.1 生产代码 + C7 复审）
日期：2026-11-16

> **2026-11-21 Slice 1.1 修正声明**
>
> 本报告首次交付时，§2.1、§2.4、§3.2、§3.3、§4.1、§5.1–5.3、§6.1、§6.6
> 在 `terminalDecidedBy` 身份、`ExecutionRegistrationAudit` 字段、13 种
> `terminalDecision` 映射以及测试数量上与代码/Schema 不一致（独立复审
> `S1-P2-1`）。上述章节已按 **2026-11-12 L2 v1.1 Schema 终审** 修正；契约原件
> 已固化为 `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md` 与
> `apps/api/test/fixtures/l2-v1.1-contract.json`。迁移原子性修复、Trigger 加固
> 与新增测试的完整证据见
> `docs/engineering/P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md`。本报告其余
> 章节（范围、P2-4、canonical JSON、平台边界）保持首次交付时的结论不变。

---

## 1. 范围与基线

### 1.1 本轮做什么

WP-D Slice 1 只交付**数据库契约与迁移**：

- 42 个新增标量字段、2 张新表、14 个索引/唯一约束、10 个 SQLite Trigger；
- 13 种 `terminalDecision` 的严格枚举与 status 映射；
- 统一终态写入路径、握手消息证据（含脱敏与 canonical hash）、Registration epoch 轮换；
- 真实 Migration 取代 `prisma db push`（测试库也必须是真实迁移链）；
- Trigger 在 SQLite 中**真实生效**，且每条都同时有数据库层与应用层测试。

### 1.2 本轮明确不做

- `execution.terminal` 协议消息、`logCollection` barrier、P2-09；
- 多实例恢复、协议 v2、完整 API 启动恢复状态机；
- Slice 2 的业务逻辑（30s ack deadline 的运行时判定、重放推进、恢复后的执行重建）；
- macOS 与 POSIX `posix-group` fallback（仍 **BLOCKED**，见第 10 节）。

### 1.3 基线核对（只读）

| 事实 | 结果 |
| --- | --- |
| 当前分支 | `feature/p2-02-wpd-slice1-schema-migration`（从 `d409d2e` 新建） |
| `HEAD` | `d409d2e` |
| `d409d2e` 含 `41ef234`（Slice 0.2.1 生产代码基线） | 是（`git merge-base --is-ancestor`） |
| `d409d2e` 含 `6a5ad16`（`main` 当时位置） | 是 |
| C7 复审报告存在 | `docs/engineering/P2-02_WP-D_SLICE0_2_1_INDEPENDENT_REVIEW.md`（提交 `d409d2e`） |
| `main` 是否被改动 | 否，`main` 仍为 `6a5ad16` |
| 工作树 | Slice 0.2.1 的 worktree 与 `main` 未触碰；Slice 1 改动全部在本分支 |

Slice 0.2.1 的生产代码（`process-supervisor-child.ts`、`process-guard.ts`、`recovery*.ts`、`safe-file.ts`、Windows `.cs` supervisor）**零改动**，只新增了 `RealExecutor` 的两个测试用时间接缝（默认值与生产常量一致，见 6.7）。

---

## 2. Schema 变更清单

文件：`apps/api/prisma/schema.prisma`（+96 行）

### 2.1 Execution（8 个标量字段）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `registrationId` | `String?` | 该执行绑定到的 Runner registration |
| `registrationEpoch` | `Int @default(0)` | 绑定时 Runner 的 epoch 快照 |
| `startSentAt` | `DateTime?` | `execution.start` 唯一一次发送的持久化时刻 |
| `startAcceptDeadlineAt` | `DateTime?` | `startSentAt + 20s`，写一次后不可改 |
| `recoveryDeadlineAt` | `DateTime?` | `startSentAt + 120s`，只允许收紧 |
| `terminalDecision` | `String?` | 13 种终态裁决之一 |
| `terminalDecidedAt` | `DateTime?` | 裁决时刻（历史行为 `endedAt`/`updatedAt`） |
| `terminalDecidedBy` | `String?` | 裁决来源，只允许 `API:` / `MIGRATION:` 前缀（既定身份见 L2 v1.1 契约基线） |

### 2.2 Runner（3 个标量字段）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `registrationId` | `String? @unique` | 每次（重）注册轮换的新 id |
| `registrationEpoch` | `Int @default(0)` | 单调递增，不可回退、不可跳跃 |
| `lastRegisteredAt` | `DateTime?` | 最近一次注册成功 |

### 2.3 RepositoryHandshakeMessage（新表，18 个标量字段）

`id`、`executionId`、`runnerId`、`messageType`、`messageId`、`protocolVersion`、`attempt`、`envelopeJson`、`payloadHash`、`canonicalizationVersion`、`createdRegistrationId`、`createdRegistrationEpoch`、`status`、`sentAt`、`ackedAt`、`lastReplayedAt`、`createdAt`、`updatedAt`。

- `executionId` 外键 → `Execution.id`，`ON DELETE CASCADE`。
- `runnerId` **故意不是外键**：消息证据必须在 Runner 记录被轮换/删除后仍可审计。
- `execution.start` 的 `envelopeJson` 不含 `prompt` / `taskDescription` 明文，改为 `redacted.promptSha256` / `redacted.taskDescriptionSha256`。

### 2.4 ExecutionRegistrationAudit（新表，13 个标量字段，append-only）

`id`、`executionId`、`runnerId`、`previousRegistrationId`、`previousRegistrationEpoch`、`newRegistrationId`、`newRegistrationEpoch`、`dispatchState`、`decision`、`reasonCode`、`detail`、`messageId`、`createdAt`。

- `decision` 只允许 `adopted` / `rejected` / `superseded`；`rejected` 必须有 `reasonCode`。
- `runnerId` 同样不是外键（审计不因 Runner 变更失效）。
- 由 Trigger 保证不可 UPDATE；DELETE 仅随 `Execution` 级联（SQLite 对级联删除不触发 Trigger，因此级联仍可用）。

### 2.5 索引与唯一约束（14 个）

| 表 | 数量 | 明细 |
| --- | --- | --- |
| Runner | 2 | `registrationId` UNIQUE、`lastRegisteredAt` INDEX |
| Execution | 4 | `(status, dispatchState)`、`(runnerId, registrationEpoch)`、`recoveryDeadlineAt`、`terminalDecision` |
| RepositoryHandshakeMessage | 6 | `messageId` UNIQUE、`(executionId, messageType, attempt)` UNIQUE、`execution.start` **Partial UNIQUE**、`(executionId, messageType, createdAt)`、`(status, createdAt)`、`(runnerId, status)` |
| ExecutionRegistrationAudit | 2 | `(executionId, createdAt)`、`(runnerId, createdAt)` |

`execution.start` 的 at-most-once 由数据库强制，而不是"先查后写"：

```sql
CREATE UNIQUE INDEX "RepositoryHandshakeMessage_execution_start_unique"
    ON "RepositoryHandshakeMessage"("executionId")
    WHERE "messageType" = 'execution.start';
```

Prisma datamodel 无法表达 Partial Index，因此该索引只存在于 Migration 中，并由 `db:migrate:verify` 与迁移套件守护（防止 `migrate dev` 重生成时丢失）。

---

## 3. Migration

文件：`apps/api/prisma/migrations/20261116120000_p2_02_wpd_slice1_schema_migration/migration.sql`（556 行）

> Slice 1.1 起，整份脚本包在显式 `BEGIN IMMEDIATE; ... COMMIT;` 中，使 SQLite 迁移
> 具备全有或全无语义。Prisma 自身不会为 SQLite 的单个 migration 文件开事务；该边界
> 已被真实 `migrate deploy` 与四个阶段的故障注入验证（见修复报告第 5 节）。

| 对象 | 数量 |
| --- | --- |
| `ALTER TABLE ... ADD COLUMN` | 11（Execution 8 + Runner 3） |
| `CREATE TABLE` | 2 |
| `CREATE [UNIQUE] INDEX` | 14（含 1 个 Partial Unique Index） |
| `CREATE TRIGGER` | 10（T1–T10） |

### 3.1 additive 保证

- 不重建任何表、不 `DROP`、不改列类型、不删行。
- 所有新列可空或带默认值，因此**空库**与**已有库**都能应用同一条迁移链。
- `Execution`、`Log`、`Artifact`、`Activity` 的既有行在迁移前后数量一致（见 5.2）。

### 3.2 历史回填策略（在任何 Trigger 创建之前执行）

```sql
UPDATE "Execution"
   SET "terminalDecision" = CASE "status"
           WHEN 'completed' THEN 'COMPLETED'
           WHEN 'failed'    THEN 'EXECUTION_FAILED'
       END,
       "terminalDecidedAt" = CASE typeof(COALESCE("endedAt", "updatedAt"))
           WHEN 'integer' THEN COALESCE("endedAt", "updatedAt")
           WHEN 'real'    THEN CAST(COALESCE("endedAt", "updatedAt") AS INTEGER)
           ELSE CAST(strftime('%s', COALESCE("endedAt", "updatedAt")) AS INTEGER) * 1000
                + CAST(substr(strftime('%f', COALESCE("endedAt", "updatedAt")), 4, 3) AS INTEGER)
       END,
       "terminalDecidedBy" = 'MIGRATION:wp-d-backfill',
       "dispatchState" = 'terminal'
 WHERE "status" IN ('completed', 'failed');
```

- `completed` / `failed` 是**可从既有数据确定性推导**的裁决，允许回填。
- `terminalDecidedAt` 保留历史时刻，但把存储统一为 L2 v1.1 要求的**正整数 Unix 毫秒**：Prisma 写出的 INTEGER 原样保留，ISO-8601 TEXT 精确换算（秒 × 1000 + 毫秒小数），不用"迁移时刻"替换历史时间。
- `cancelled` **不**回填为 `CANCELLED_CONFIRMED`：数据库不持有任何"进程终止已确认"的证据，回填等于伪造。这类行只把 `dispatchState` 置为 `terminal`，`terminalDecision` 保持 `NULL`。

  **这个 `NULL` 不是"留给 Slice 2 补写"的占位。** 行一旦 `dispatchState = terminal`，就进入 T2 的保护范围：T2 对 `OLD.status IN ('completed','failed','cancelled')` 的行拒绝任何终态元组变更（`migration.sql:229-243`）；T3 只对 `OLD.status = 'running'` 生效（`:249-310`）；应用层 `writeTerminalDecision` 的条件更新同样要求 `status = 'running'`（`execution-terminal.ts:53-59`），对这类行 `count = 0`。三层都关死，因此 **Slice 2 不能通过普通更新为这些历史行补写裁决**，也不得为了补写而放宽 T2。正确用法是只查询、不补写：

  ```sql
  SELECT id FROM "Execution" WHERE status = 'cancelled' AND terminalDecision IS NULL;
  ```

  后续处置只有三种，且都需要单独决策：(a) 保持现状，把 `NULL` 当作"历史证据不足"的显式记录；(b) 用新的 forward migration 以**不声称证据**的方式标注；(c) 由操作员按 `docs/execution-recovery.md` 的 playbook 处理业务影响，数据库保持不变。详见 `P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §4。

  > 修订记录（2026-11-24）：本段原写作"…留给 Slice 2 的恢复判定或人工处理"，与冻结的 T2 冲突——Slice 2 的恢复判定没有任何可写入路径。已按上述事实更正，未改动本节其它结论。
- start 之前的行（`created` / `repository_preparing`）完全不动，也不会为它们伪造任何握手消息。

### 3.3 Trigger T1–T10

| # | Trigger | 时机 | 强制的约束 |
| --- | --- | --- | --- |
| T1 | `Execution_terminal_insert_guard` | BEFORE INSERT | 终态行必须 `dispatchState=terminal`、`phase=status`、有 `endedAt`，且带完整的 `terminalDecision` + 正整数 Unix ms `terminalDecidedAt` + 合法 `terminalDecidedBy`；decision 与 status 匹配（13 种）；非终态行不得携带元组 |
| T2 | `Execution_terminal_update_guard` | BEFORE UPDATE | 终态行不可改写 `status` / `phase` / `dispatchState` / 终态元组 / `endedAt` / `exitCode`；先写者胜 |
| T3 | `Execution_terminal_write_guard` | BEFORE UPDATE | 离开 `running` 必须一次性写完整、类型正确、身份合法且 `phase=status` 的终态；`running` 行不得携带终态元组；只允许 `running → completed/failed/cancelled` |
| T4 | `Execution_dispatch_transition_guard` | BEFORE UPDATE | 六态只能按 `created → repository_preparing → repository_ready → start_sent → running → terminal` 前进；`start_sent` 必须有 `execution.start` 持久化证据（EXISTS 检查） |
| T5 | `Execution_start_clock_guard` | BEFORE UPDATE | `startSentAt` / `startAcceptDeadlineAt` 只能写一次；`recoveryDeadlineAt` 只能收紧 |
| T6 | `Runner_registration_guard` | BEFORE UPDATE | `registrationEpoch` 不可回退、不可跳跃；epoch+1 必须同时换 `registrationId` |
| T7 | `RepositoryHandshakeMessage_insert_guard` | BEFORE INSERT | `payloadHash` 必须是 64 位小写 hex；status 合法；`sent`/`acked` 必须有时间戳；`execution.start` 不得有 `lastReplayedAt` |
| T8 | `RepositoryHandshakeMessage_update_guard` | BEFORE UPDATE | 身份/信封不可变；`created → sent\|acked\|rejected`、`sent → acked\|rejected`；`execution.start` 不可 replay |
| T9 | `ExecutionRegistrationAudit_insert_guard` | BEFORE INSERT | `adopted` 必须恰好前进一个 epoch（首次绑定除外）；`rejected` 必须有 `reasonCode`；`superseded` 必须带被替换的 registration 且 epoch 严格更新 |
| T10 | `ExecutionRegistrationAudit_no_update` | BEFORE UPDATE | append-only：任何 UPDATE 直接 `RAISE(ABORT)` |

所有 Trigger 使用 `RAISE(ABORT, '<Trigger 名>: <原因>')`，测试断言错误文本确实来自 `RAISE`，并验证失败后原行未被修改（回滚）。

---

## 4. 冻结语义

### 4.1 13 种 terminalDecision 与 status 映射

| status | decisions |
| --- | --- |
| `completed` | `COMPLETED` |
| `cancelled` | `CANCELLED_CONFIRMED` |
| `failed` | `EXECUTION_FAILED`、`START_REJECTED`、`START_ACCEPT_TIMEOUT`、`START_SEND_UNCONFIRMED`、`RUNNER_DISCONNECTED`、`RUNNER_RESTARTED`、`RUNNER_INTERRUPTED`、`RUNNER_START_UNCONFIRMED`、`RECOVERY_DEADLINE_EXCEEDED`、`MESSAGE_INTEGRITY_FAILED`、`CLOCK_ANOMALY` |

枚举定义在 `packages/contracts/src/constants.ts`（`TERMINAL_DECISIONS` as const、`TERMINAL_DECISION_STATUS`），并由 `migration.integration.spec.ts` 从
`apps/api/test/fixtures/l2-v1.1-contract.json` 反向断言：枚举、映射、Audit 列与身份列表必须与 fixture 完全一致，T1 的 Trigger SQL 必须包含全部 13 个值。枚举与数据库不会漂移。

### 4.2 dispatchState 六态

`created`、`repository_preparing`、`repository_ready`、`start_sent`、`running`、`terminal`。

不新增状态；T4 拒绝任何越级、回退或未知值。`start_sent` 必须有 `execution.start` 消息作为持久证据，因此"先发后记"的竞态无法在数据库层面通过。

### 4.3 start 的 at-most-once

三层独立保证，缺一不可：

1. **数据库**：`execution.start` 的 Partial Unique Index（每个 Execution 至多一条）。
2. **写入路径**：`repository_ready → start_sent` 的条件更新带 `startSentAt: null`，`count !== 1` 即视为"已经发过"，抛 `EXECUTION_ALREADY_RUNNING` 而不是重发。
3. **Trigger**：T5 禁止第二次写 `startSentAt`。

`start_sent` 之后的持久化 start 只用于审计、完整性校验与恢复判定，**不是重放源**：没有任何代码路径会从数据库重发 `execution.start`。

### 4.4 时间窗口

| 常量 | 值 | 落点 |
| --- | --- | --- |
| `startSentAt` → `startAcceptDeadlineAt` | +20s | `repository-handshake.service.ts` 写入，T5 冻结 |
| `recoveryDeadlineAt` | `startSentAt + 120s`（`RECOVERY_OUTER_LIMIT_MS`） | 同上 |
| ack deadline | `min(startSentAt + 120s, tAck + 30s)` | Slice 2 判定；Slice 1 只保证"只能收紧" |

deadline 只能收紧：T5 拒绝任何让 `recoveryDeadlineAt` 变晚的 UPDATE。`startAcceptDeadlineAt` 写入后完全不可变。

---

## 5. 验收

### 5.1 A. Fresh DB

`apps/api/test/migration.integration.spec.ts`（12 用例，全部通过）：

- 迁移链在空库上完整应用（7 条迁移）；
- 42 个新增列全部存在，类型/可空性正确；
- 2 张新表存在，列数分别为 18 / 13；
- 14 个索引/唯一约束存在，且 `execution.start` 索引 `PRAGMA index_list` 的 `partial = 1`；
- 10 个 Trigger 存在，`sqlite_master` 中可见；
- 13 个 decision 与 status 映射正确，且全部出现在 T1 的 SQL 中；
- 契约 fixture（13 decisions / 映射 / Audit 13 列 / 身份列表）与代码、Migration 完全一致；
- `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 为空；
- 迁移后可写一条完整的 execution + 握手消息。

### 5.2 B. Existing DB

`apps/api/test/migration-existing-database.integration.spec.ts`（8 用例，全部通过）：

- 用 **Slice 1 之前的迁移子集**建历史库，再用手工 SQL 写入 legacy 行（completed / failed / cancelled / repository_preparing / created）；
- 升级后 `Execution` / `Log` / `Artifact` / `Activity` 行数与升级前**逐表一致**；
- `PRAGMA foreign_key_check` 为空（外键完整）；
- `completed → COMPLETED`、`failed → EXECUTION_FAILED`，`terminalDecidedAt` 等于历史 `endedAt`（并统一为整数 Unix ms），`terminalDecidedBy = 'MIGRATION:wp-d-backfill'`；
- `cancelled` 保持 `terminalDecision IS NULL`（**没有**被伪造成 `CANCELLED_CONFIRMED`）；
- start 之前的行 `dispatchState` 不变，`RepositoryHandshakeMessage` 为空（未伪造发送证据）；
- Runner 基线干净（`registrationId = NULL`、`registrationEpoch = 0`）；
- 升级后仍拒绝把历史终态行"复活"。

### 5.3 C. Trigger 逐条

`apps/api/test/database-triggers.integration.spec.ts`（57 用例，全部通过）：T1–T10 每条至少一个合法用例 + 一个非法用例，非法用例断言错误文本来自对应的 `RAISE`，并复查失败后目标行未被修改。Slice 1.1 追加：13 decisions × 正确/错误 status 全矩阵、`phase != status`、`terminalDecidedAt` 的 TEXT/0/负数/浮点拒绝、非法 `terminalDecidedBy`、adopted/rejected/superseded、终态元组逐字段不可变、双连接 first-writer-wins。

### 5.4 D. Migration 回归

- `prisma migrate diff --from-url <已迁移库> --to-schema-datamodel prisma/schema.prisma --script` 输出 `This is an empty migration`（Schema 与迁移一致）。
- 迁移套件断言根 `package.json` 与 `apps/api/package.json` 都不含 `db push`。
- `apps/api/scripts/verify-migration-consistency.mjs`（`pnpm --filter @raft-lite/api db:migrate:verify`）在临时库上重放真实迁移链后再做 diff；**已实测负例**：故意给 `schema.prisma` 增加一个 `DriftProbe` model 后脚本 `exit=1` 并输出 "schema.prisma and the migration chain disagree"，恢复后重新通过。

### 5.5 E. 场景分层（只声明实际执行）

本机（Windows，Node 22）实际执行：

| 套件 | 覆盖 | 结果 |
| --- | --- | --- |
| `migration.integration.spec.ts` | A | 10/10 |
| `migration-existing-database.integration.spec.ts` | B | 7/7 |
| `database-triggers.integration.spec.ts` | C | 40/40 |
| `canonical-json.spec.ts` | P1-8 | 10/10 |
| `db:migrate:verify`（含负例演练） | D | 通过 / 负例 `exit=1` |
| API 全量套件 | 既有 API + Seed + Fixture 未被新约束破坏 | 见 5.7 |
| runner `managed-terminal-fallback.spec.ts` | P2-4 | 2/2 |
| `runner.integration.spec.ts` | Slice 1 端到端证据 | 通过 |

**未执行，不得计为 PASS**：

- 41 场景中的 CI / Nightly / G6 分层：本机只跑了 A–D 与 P2-4；G6（生产级多实例、真实网络分区）完全没有执行。
- Linux 上的 P2-4（同一测试文件，需 CI/Nightly 执行）。
- macOS 与 POSIX `posix-group` fallback：BLOCKED（见第 10 节）。

### 5.6 F. 工程门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 安装（锁文件） | `pnpm install --frozen-lockfile` | 通过 |
| 类型 | `pnpm typecheck` | 通过（contracts / api / runner / web） |
| Lint | `pnpm lint` | 通过（`--max-warnings=0`） |
| 构建 | `pnpm build` | 通过 |
| 测试 | `pnpm test` | 见 5.7 |

### 5.7 本轮实测汇总

`pnpm test`（契约 → api → runner → web，exit 0）：

| 包 | 测试文件 | 用例 | 结果 |
| --- | --- | --- | --- |
| `packages/contracts` | 5 | 109 | 全通过 |
| `apps/api` | 10 | 143 | 全通过 |
| `apps/runner` | 25 | 261 passed / 12 skipped（273） | 全通过 |
| `apps/web` | 11 | 41 | 全通过 |
| **合计** | **51** | **554 passed / 12 skipped** | **exit 0** |

其中 Slice 1 新增：

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| `migration.integration.spec.ts` | 10 | 10/10 |
| `migration-existing-database.integration.spec.ts` | 7 | 7/7 |
| `database-triggers.integration.spec.ts` | 40 | 40/40 |
| `canonical-json.spec.ts` | 10 | 10/10 |
| `managed-terminal-fallback.spec.ts` | 2 | 2/2 |

`pnpm --filter @raft-lite/api db:migrate:verify`：

```text
verify-migration-consistency: OK
  migrations applied from empty: 7
  datamodel drift: none (empty migration)
```

负例演练（给 `schema.prisma` 临时加一个 `DriftProbe` model）：`exit=1`，
输出 `FAIL: schema.prisma and the migration chain disagree; write a migration for the datamodel change`，
恢复 schema 后重新通过。

#### 一条工程发现：runner 测试套件的并行度

首次全量运行时，`apps/runner` 出现 4 个失败（含既有的 R03 / R04b / repository-handshake F2）。
根因不是被测代码，而是本机 16 核上 vitest 默认按文件数并发：25 个测试文件同时启动 supervisor、
CLI 与 `powershell.exe` 身份探测，`inspectProcess` 在资源饥饿下超时返回 `null`。
runner 对此的处置**是正确的 fail-closed**：

```text
PROCESS_TREE_NOT_CONFIRMED: A live PID no longer matches the recorded process identity
```

即"无法证明进程树已终止，因此不 finalize"。为了让套件度量 runner 而不是主机的进程启动吞吐，
`apps/runner/vitest.config.ts` 增加 `maxWorkers: 4`（附注释说明原因）。改后连续运行全绿，
总时长 54.5s（与不加限流的 57.7s 基本持平）。这是测试基础设施的约束，不改变任何生产判定逻辑。

---

## 6. 代码变更清单

| 文件 | 变更 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | 42 字段、2 模型、14 索引、2 关系 |
| `apps/api/prisma/migrations/20261116120000_.../migration.sql` | 新增（additive + 回填 + T1–T10） |
| `packages/contracts/src/constants.ts` | `TERMINAL_DECISIONS`、`TERMINAL_DECISION_STATUS`、`TERMINAL_STATUSES`、`HANDSHAKE_MESSAGE_STATUSES`、`HANDSHAKE_MESSAGE_TYPES`、`CANONICALIZATION_VERSION` |
| `apps/api/src/common/canonical-json.ts` | 新增：canonical JSON + SHA-256 payload hash |
| `apps/api/src/modules/executions/execution-terminal.ts` | 新增：统一条件终态写入 |
| `apps/api/src/modules/executions/executions.service.ts` | 三条终态路径改为统一写入 |
| `apps/api/src/modules/runners/handshake-message.service.ts` | 新增：消息证据、脱敏、状态迁移 |
| `apps/api/src/modules/runners/repository-handshake.service.ts` | start 时钟、Registration 绑定、冲突回滚、绝不重发 start |
| `apps/api/src/modules/runners/runner-registry.service.ts` | Registration id/epoch 轮换 |
| `apps/api/src/modules/runners/runners.module.ts` | 注册 `HandshakeMessageService` |
| `apps/api/src/common/seed/demo-data.ts` | Seed 补齐终态元组（P1-2） |
| `apps/api/package.json` | 测试库改用 `migrate deploy`；新增 `db:migrate:verify` |
| `apps/api/scripts/verify-migration-consistency.mjs` | 新增：迁移↔Schema 一致性门禁 |
| `apps/api/test/support/migration-cli.ts` | 新增：真实迁移库工具 |
| `apps/api/test/migration.integration.spec.ts` | 新增（A + D） |
| `apps/api/test/migration-existing-database.integration.spec.ts` | 新增（B） |
| `apps/api/test/database-triggers.integration.spec.ts` | 新增（C） |
| `apps/api/test/canonical-json.spec.ts` | 新增（P1-8） |
| `apps/api/test/runner.integration.spec.ts` | 追加 Slice 1 端到端证据断言 |
| `apps/runner/src/real-executor.ts` | 仅新增 `terminalFallbackMs` / `treeTerminationTimeoutMs` 两个测试接缝（默认值 = 生产常量） |
| `apps/runner/vitest.config.ts` | `maxWorkers: 4`（真实进程测试的并行度上限，见 5.7） |
| `apps/runner/test/managed-terminal-fallback.spec.ts` | 新增（P2-4） |
| `docs/execution-recovery.md` | C7-1：sidecar / resolve-corrupt / 持久性边界 |

### 6.1 统一终态写入（P1-3）

`writeTerminalDecision(tx, { executionId, decision, decidedBy, endedAt?, patch?, requireNoCancelIntent? })` 只做一件事：单条条件 `updateMany`。

```ts
where: {
  id: executionId,
  status: 'running',
  terminalDecision: null,
  ...(requireNoCancelIntent ? { cancelRequestedAt: null } : {}),
}
data: { status, phase: status, dispatchState: 'terminal', terminalDecision, terminalDecidedAt, terminalDecidedBy, endedAt, ...patch }
```

返回 `count === 1` 即"本写入者胜出"。三条既有路径改为走它：

- `failExecutionStart` → `terminalDecisionForStartFailure(code)`，`decidedBy: 'API:start-gate'`，`requireNoCancelIntent: true`（**start 失败不得覆盖已发生的取消意图**）。
- `finishExecution` → `terminalDecisionForOutcome(outcome)`，`applied === false` 时直接返回（迟到事件不覆盖终态）；`decidedBy` 为 `API:mock-runtime`（mock）或 `API:terminal-event`（runner/runtime），操作员安全终结路径显式传 `API:operator`。
- `cancelMockExecution` → `CANCELLED_CONFIRMED`，`decidedBy: 'API:operator'`，失败抛 `EXECUTION_NOT_RUNNING` CONFLICT。

### 6.2 消息与 Registration 的事务顺序（P1-4）

`acquireDispatch()` 在**同一个交互式事务**内完成：

1. 写 `execution.repository` 消息（status `created`）；
2. 写 `execution.start` 消息（status `created`，含脱敏 envelope 与 `payloadHash`）；
3. 条件 `updateMany` 把 Execution 推到 `repository_preparing`，同时写入 `registrationId` / `registrationEpoch`；
4. `count !== 1` → 抛 `DispatchAcquireConflict`（sentinel）→ 整个事务回滚，一个字节都不留。

`acceptedRepository`：`repository_ready` 与 `markAcked(repository)` 同事务；随后 `repository_ready → start_sent` 的条件更新写入 `startSentAt`、`startAcceptDeadlineAt`、`recoveryDeadlineAt`，`where` 里带 `startSentAt: null`，若已是 `start_sent`/`running` 则抛 `EXECUTION_ALREADY_RUNNING`。

### 6.3 canonical JSON（P1-8）

`canonicalizeJson` 是 RFC 8785 的子集：键排序、`-0 → 0`、`Date → ISO`，拒绝 `undefined` / `NaN` / `Infinity` / `BigInt` / function / symbol / 循环引用 / 稀疏数组。`canonicalPayloadHash` 输出小写 64 位 hex，与 T7 的校验一致。

数字支持是**显式**的：`1`、`1.0`、`1e3` 会规范化为同一个字符串，`NaN`/`Infinity` 直接抛错而不是静默变成 `null`。

### 6.4 敏感字段脱敏

`execution.start` 的 `prompt` / `taskDescription` **不落库**。`redactEnvelope` 剥离这两个字段，替换为 `redacted.promptSha256` / `redacted.taskDescriptionSha256`，因此：

- 数据库里没有明文任务内容；
- 仍可用摘要证明"发出去的就是这一条 prompt"；
- 未引入任何未批准的加密方案。

`runner.integration.spec.ts` 断言 `envelopeJson` 不含任务描述、含 redacted 摘要、`payloadHash === sha256(envelopeJson)`。

### 6.5 Registration 轮换

`register()` 每次生成新的 `registrationId` 并 `registrationEpoch + 1`，一次写入 `registrationId` / `registrationEpoch` / `lastRegisteredAt`。T6 保证：epoch 不可回退、不可跳跃、`epoch+1` 必须同时换 id。

### 6.6 Seed / Fixture（P1-2）

`demo-data.ts` 的 completed execution 补齐 `dispatchState: 'terminal'`、`terminalDecision: 'COMPLETED'`、`terminalDecidedAt`、`terminalDecidedBy: 'API:mock-runtime'`。否则 T1 会在 seed 时拒绝写入——这正是 P1-2 要求提前发现的破坏。

### 6.7 RealExecutor 的两个时间接缝

```ts
terminalFallbackMs?: number;        // 生产默认 TERMINAL_FALLBACK_MS = 15_000
treeTerminationTimeoutMs?: number;  // 生产默认 undefined → supervisor 自己的确认窗口
```

只影响调度与等待长度，不影响任何判定逻辑：`handleTerminalFallback` 仍然只有在 `requestTermination` 返回 `confirmed` 时才 `finalize`，否则 `markUncertain` 并保持 journal `active`。

---

## 7. Slice 1 任务书 P1-1…P1-9 处置

> 注意：这里的 P1-1…P1-9 是 **Slice 1 任务书**的实现约束编号。C7 复审报告里的 `P1-1` 指 finalize single-flight 回归保护，两者同名不同义，后者见第 9 节。

| 编号 | 要求 | 处置 | 证据 |
| --- | --- | --- | --- |
| P1-1 | 测试库必须用真实 Migration，不得用 `db push` 造库 | **DONE** | `apps/api/package.json` 三个脚本改为 `migrate deploy`；`test/support/migration-cli.ts` 全部走 `migrate deploy`；套件断言仓库内无 `db push` |
| P1-2 | Seed / Fixture 必须兼容终态 Trigger | **DONE** | `demo-data.ts` 补终态元组；API 全量套件（含 seed 路径）通过 |
| P1-3 | 统一终态写入，先写者胜 | **DONE** | `execution-terminal.ts` + 三条路径改造；`updateMany` 条件含 `status='running' AND terminalDecision IS NULL` |
| P1-4 | 消息与 Registration 绑定的事务顺序 | **DONE** | `acquireDispatch` 单事务 + sentinel 回滚；`startSentAt: null` 条件更新；`EXECUTION_ALREADY_RUNNING` |
| P1-5 | 安全回填策略，禁止伪造历史证据 | **DONE** | completed/failed 确定性映射；cancelled 保持 NULL；pre-start 行不动、不造消息；B 套件逐项断言 |
| P1-6 | deadline 只收紧等约束 | **DONE** | T5：`startSentAt`/`startAcceptDeadlineAt` 写一次、`recoveryDeadlineAt` 只能收紧；C 套件有合法/非法用例 |
| P1-7 | Prisma SQLite 事务策略，不得假设 `BEGIN IMMEDIATE` | **DONE** | 并发控制落在单条条件 `updateMany` + 唯一/Partial Unique Index + Trigger，不依赖隔离级别假设 |
| P1-8 | canonical JSON 数字支持 | **DONE** | `canonical-json.ts` + 10 单测（含 `NaN`/`Infinity`/`-0`/`1e3` 用例） |
| P1-9 | 可执行验收证据 | **DONE** | A–D 自动化套件 + `db:migrate:verify`（含故意漂移负例 `exit=1`）+ P2-4 真实进程树测试 |

没有把任何未解决项标成 CLOSED：见第 9 节的开放清单。

---

## 8. P2-4：Managed / supervised 进程树与 15s fallback

文件：`apps/runner/test/managed-terminal-fallback.spec.ts`（2 用例，Windows 真实 supervisor）

两个用例都走 `RealExecutor` 的**生产 managed 路径**（不注入 `spawnProcess`），因此有真实 supervisor（Windows Job Object / POSIX supervisor 脚本）、真实 CLI 子进程、真实孙进程。只有时间被注入。

### 8.1 P2-4a：确认整棵树终止后才 finalize

1. 启动真实 supervised 树，等待 CLI fixture 写出 marker（含孙进程 PID）；
2. POSIX 上对孙进程发 `SIGSTOP`（真实挂起）；Windows 无法跨平台挂起，且 Job Object 会连挂起的成员一起杀，因此保持运行（报告如实区分，不冒充挂起证据）；
3. `executor.cancel()` 触发优雅终止，并在注入的 40 ms 后触发 15 s fallback（生产 15 000 ms）；
4. **两条独立证据**证明"未确认前不 finalize"：
   - 采样证据：每 10 ms 记录一次"仍在世的受保护 PID"与"终态事件数"，断言**不存在**任何一次"有活的 PID 且已有终态事件"的观测；
   - 精确证据：在 `journal.finish` 的调用点同步读取所有受保护 PID 的存活状态，断言为空；
5. 断言 fallback 的 force 终止确实被请求（`terminationRequests` 含 `true`）；
6. 断言终态一致性：`onCancelled` 恰好 1 次、`onFailed`/`onCompleted` 为 0；journal 落盘 `status='cancelled'`、`phase='cancelled'`、`finishedAt` 非空、`processKind='supervisor'`、`supervisorPid` 与 guard 一致；
7. 断言 guard 落盘 `state ∈ {terminated, exited}` 且 `treeConfirmedGone=true`；
8. 断言 CLI、孙进程、supervisor 三个 PID 全部 `waitForProcessExit` 成功；会话从 snapshot 移除。

连续 3 次运行稳定通过。

### 8.2 P2-4b：未确认时不 finalize，active journal 是权威

1. 同样的真实 supervised 树；
2. 只在**操作系统证据边界**注入故障：`verifyTreeGone` 与 `terminate` 返回"无法确认"（真实的 guard 权限失败 / taskkill 被拒 / cgroup 不可读会产生完全相同的结果）；进程树本身保持真实存活；
3. 断言：`journal.finish` **从未被调用**；`onCancelled` / `onFailed` / `onCompleted` 全为 0；落盘 journal 仍为 `status='active'`、`finishedAt=null`；会话留在 snapshot 与 `uncertainOrphans` 中；
4. 断言当时**确实还有活的进程**（CLI 与孙进程），证明 runner 没有猜；
5. 断言 `shutdown()` 返回 `clean=false` 并把该 execution 列为 outstanding；
6. 随后用真实 supervisor 真正杀掉整棵树，再用真实的 `ExecutionRecovery.scan()` 证明：这条 active journal 携带的证据足以让恢复流程把它 finalized 为 `interrupted`，且 `scan.blocked` 为空。

这一步说明了 fail-closed 的完整闭环：**拒绝猜测 → 证据保留 → 后续可恢复**。

### 8.3 平台边界（不得夸大）

- Windows：Job Object 的 kill-on-close 是内核强制的，因此"合规 supervisor + 活着的树 + 持续无法确认"这个组合在不注入故障时**不可达**。P2-4b 因此显式注入 OS 证据层故障，并在用例名与报告里标明。
- Linux：同一文件可在 cgroup/posix-group 路径运行，但**本机未执行**，不计入 PASS。
- macOS / POSIX `posix-group` fallback：**BLOCKED**，不得用 Linux cgroup 证据替代。

---

## 9. C7-1 与遗留状态

### 9.1 C7-1（文档级 P2）— 本轮关闭

`docs/execution-recovery.md` 新增 "Process supervisor sidecar (Windows)"：

- sidecar（guard）的作用、路径与创建时机（CLI 之前）；
- `recovery-admin resolve-corrupt` 的人工确认流程与"永不删除 journal/worktree/guard"；
- Linux 目录项 fsync vs **Windows 不保证**；
- 断电后 sidecar 可能丢失 → 恢复报 unresolved → 必须人工 resolve；
- 所有失败路径 fail-closed。

并在 "Guarantees and non-guarantees" 的 Not guaranteed 增补对应条目。

### 9.2 仍然开放（本轮未处理，不得视为关闭）

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| N-2 … N-6 | 既有 P3（含 `recovery-resolution.spec.ts` 的 `isolation:'windows-job'` fixture 双平台复用） | **开放** |
| C7-2 | provenance 为内容绑定而非密码学真实性；`executionId` 绑定在 null/null 时退化 | **开放**（P3） |
| C7-3 | quarantine 后 provenance 写入失败 → 永久不可 resolve，`recovery-admin` 无补写命令 | **开放**（P3） |
| C7-4 | 发布后校验失败留下永久阻塞的无效 sidecar | **开放**（P3） |
| C7-5 | 崩溃遗留 `.tmp` 无 GC | **开放**（P3） |
| C7-6 | 同一 corrupt 文件产生两条 blocked 条目 | **开放**（P3） |
| C7-7 | journal `phase` 只校验 `typeof string`，允许空串 | **开放**（P3） |

### 9.3 保持 CLOSED（回归保护，本轮无相关代码改动）

| 编号 | 内容 | 本轮证据 |
| --- | --- | --- |
| C7/N-1 | POSIX starting guard / 唯一 spawn 点 | runner 全量套件通过；`process-supervisor-child.ts` 零改动 |
| P2-2A | Sidecar 原子性与完整性 | `recovery-evidence` 套件通过；零改动 |
| P2-2B | Corrupt provenance | 同上 |
| P2-2C | Journal PID / 身份 Schema | `journal-pid-schema.spec.ts` 通过；零改动 |
| P1-1（复审口径） | finalize single-flight | `finalize-concurrency.spec.ts` F1–F9 通过 |
| P2-1 | Windows guard | `supervised-process-safety.spec.ts` 通过；`.cs` 零 diff |
| P2-3 | 人工 resolve 全树 | `recovery-resolution.spec.ts` 通过 |

---

## 10. 平台适用范围

| 平台 | 本轮结果 |
| --- | --- |
| Windows（本机，Node 22） | A–D 迁移/Trigger、P2-4、API 全量、runner 全量均在本机执行 |
| Linux | **未在本机执行**。迁移与 Trigger 与平台无关，但 P2-4 的 cgroup/posix-group 路径需在 CI/Nightly 执行后才可声明 |
| macOS | **BLOCKED**。POSIX `posix-group` fallback 的证据缺口未闭合，不得用 Linux cgroup 证据替代 |

---

## 11. 未实现的 Slice 2 功能（明确不在本切片）

- `execution.terminal` 协议消息与 `logCollection` barrier；
- 30s ack deadline 的运行时判定（`min(startSentAt+120s, tAck+30s)` 的计算与推进）；
- 恢复后的执行重建、重放推进与多实例协调；
- P2-09；
- 协议 v2。

数据库契约已经把上述功能需要的字段、索引、状态与不变量固定下来，但没有任何 Slice 2 的业务逻辑被提前实现。

---

## 12. 完成标准核对

| 条件 | 结果 |
| --- | --- |
| A Fresh DB 通过 | 是 |
| B Existing DB 通过（行数一致、外键完整、不伪造历史证据） | 是 |
| C Trigger 逐条合法/非法/失败回滚 | 是（40 用例） |
| D Migration 回归（禁止 `db push`） | 是（含负例演练） |
| E 只声明实际执行的场景 | 是（第 5.5 节；G6 与 Linux P2-4 未声明） |
| F 工程门禁全绿 | 是 |
| P2-4 真实进程树证据 | Windows 通过；Linux 未执行；macOS/POSIX BLOCKED |
| C7-1 文档 | 已补 |
| 无未解决 P0/P1 | 是（开放项均为 P3，且已列明） |
| Migration 数据安全 | 是（additive、无删行、cancelled 不伪造） |
| `main` 未被改动 | 是 |

**结论：Slice 1 PASS。Slice 1 不是 WP-D 完成。**
