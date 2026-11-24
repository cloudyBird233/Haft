# P2-02 WP-D INSERT 状态约束技术设计（G3）

状态：**设计完成，未落地；含 3 项 OPEN，因此本项不标 CLOSED**
编制日期：2026-11-24
基线：`feature/p2-02-wpd-slice1-1-remediation` @ `fb664cc`
本轮边界：**只出设计**。不改 Migration、不改 schema、不改生产代码、不改测试、不执行任何数据库操作。

---

## 0. 问题陈述

当前数据库允许通过**一次 INSERT** 直接把执行行放进 `start_sent` 等中间状态，
从而绕过整条握手证据链：

```sql
INSERT INTO "Execution" (id, taskId, agentId, runnerId, status, phase, dispatchState, ...)
VALUES ('ex', 't1', 'a1', 'rn_real', 'running', 'running', 'start_sent', ...);
-- 今天：成功。T1 只校验终态行；T4 是 BEFORE UPDATE OF dispatchState，不拦 INSERT。
```

原审查建议是「允许 INSERT `created`/`running`/`terminal`，拒绝 `repository_preparing`/
`repository_ready`/`start_sent`」。方向正确，但不能机械照搬——必须先回答六个问题
（§1），再给最小约束（§5）。

---

## 1. 六个必答问题

### Q1. Mock Runtime 为什么需要直接 INSERT `running`？

因为 mock 执行**没有 dispatch 握手**，把它建模成「先 created 再走握手」才是伪造证据。

代码事实（`apps/api/src/modules/executions/executions.service.ts`）：

- `:168` `const requiresRunner = runtimeType !== 'mock';`
- `:329-346` 在**同一个事务**里 `tx.execution.create(...)`，其中
  `status: 'running'`、`dispatchState: requiresRunner ? 'created' : 'running'`。
- `:386` 事务提交后才 `this.runtimes.start(runtimeType, ...)`。

即：mock 执行一出生就是 `running`（`dispatchState='running'`），因为它的生命周期里
不存在 `execution.repository` / `execution.start` 这两条消息。若强制它从 `created`
起步，就必须为它伪造两条握手消息才能推进到 `running`——这与「不伪造证据」直接冲突。

### Q2. Mock 和真实 Runner 是否有持久化类型区分？

**有，而且有两重。**

| 维度 | mock | 真实 Runner |
| --- | --- | --- |
| `Execution.runtime` | `'mock'`（`AGENT_RUNTIMES` 之一，`packages/contracts/src/constants.ts:1`） | `'codex'` / `'opencode'` |
| `Execution.runnerId` | `NULL`（`executions.service.ts:227` 只在 `requiresRunner` 时赋值） | 非空 |
| 出生时 `dispatchState` | `running` | `created` |

注意 `runtime` 是**客户端可控的字符串**（来自任务/agent 配置），单靠它不足以作为
安全判据；`runnerId` 是服务端在 `requiresRunner` 分支里写入的，更可靠。两者结合才够。

### Q3. Recovery Scanner 是否扫描 Mock 执行？

**当前不存在 API 侧恢复扫描器**（Slice 2 才实现）。现有的对账查询一律带 `runnerId` 过滤：

- `apps/api/src/modules/runners/runner-registry.service.ts:531-534`
  （重连时告诉 runner「服务端认为还在跑什么」）
- `runner-registry.service.ts:842-849`（快照对账）

```ts
where: { runnerId, status: 'running', dispatchState: { in: ['start_sent', 'running'] } }
```

`docs/execution-recovery.md:110-114` 明确记录：

> **Mock executions are different.** … An API restart while a mock execution is running
> leaves a stale `running` row; startup reconciliation only handles executions with a
> non-null `runnerId`. This is a known limitation of the demo.

**所以：今天 mock 行不会被任何恢复路径看到。** 但这是**查询写法的偶然结果**，
不是数据库保证——Slice 2 若把扫描器写成全局查询（`dispatchState IN (...)` 不带
`runnerId`），mock 行会立刻进入恢复视野。这正是本设计要固定的边界。

### Q4. 如果直接 INSERT `running`，数据库能否判断其是否合法？

**不能。** 现有 Trigger 都不覆盖这条路径：

| Trigger | 时机 | 对 INSERT `running` 的作用 |
| --- | --- | --- |
| T1 `Execution_terminal_insert_guard` | BEFORE INSERT | 只对 `status IN ('completed','failed','cancelled')` 校验元组；对非终态行只禁止携带终态元组。`status='running'` + `dispatchState='running'` 完全通过 |
| T3 `Execution_terminal_write_guard` | BEFORE UPDATE | 不作用于 INSERT |
| T4 `Execution_dispatch_transition_guard` | **BEFORE UPDATE OF dispatchState** | 不作用于 INSERT（`migration.sql:315`） |
| T5 `Execution_start_clock_guard` | BEFORE UPDATE OF 时间列 | 不作用于 INSERT |

结论：INSERT 是六态状态机的**唯一无证据入口**。

### Q5. 是否可能创建没有握手证据的 `running` 行，并被 Recovery Scanner 当成真实执行？

**是，今天可以。** 具体链路：

1. 直接 INSERT `status='running', dispatchState='running', runnerId='rn_<真实 runner>'`；
2. 该行不带 `startSentAt`、不带 `execution.start` 消息、不带 `registrationId`；
3. 现有/未来的恢复查询条件（`runnerId = X AND status='running' AND dispatchState IN
   ('start_sent','running')`）**完全匹配**；
4. 恢复流程会把它当成「服务端认为在跑、runner 没报告」的行，进而判 `RUNNER_RESTARTED`
   或派发 cancel——基于一条从未发生过的执行。

这不是理论风险：任何能执行 SQL 的路径（测试辅助、数据修复脚本、未来的 admin 工具、
被注入的 ORM 调用）都能造出这种行。

### Q6. 是否需要增加条件约束或其他可信证据？

需要，但**只需一条 INSERT 期约束**就能把上面的链路切断，见 §5。
不需要新增列、不需要回填、不需要改动任何已应用的 Migration。

---

## 2. 四条路径的现状（逐条取证）

### 2.1 生产 INSERT 路径（唯一）

| 项 | 内容 |
| --- | --- |
| 位置 | `apps/api/src/modules/executions/executions.service.ts:329` |
| 语句 | `tx.execution.create({ data: { status: 'running', phase: requiresRunner ? 'queued' : 'running', dispatchState: requiresRunner ? 'created' : 'running', runtime, runnerId, ... } })` |
| 调用方 | `POST /api/tasks/:id/executions`（或等价入口）→ `startExecution` |
| 特征 | 单事务内建行 + 更新 task/agent；提交后才 `runtimes.start()` |

全仓库 `apps/api/src` 中**只有这一处** `execution.create`
（`grep -rn "execution.create" apps/api/src` 仅命中此文件）。测试侧另有两处直接建行
（`apps/api/test/runner.integration.spec.ts:1455`、`:1524`），均为
`dispatchState: 'created'` + `runnerId` 非空，见 §5 的兼容性核对。

### 2.2 Mock 路径

- 数据库：由 §2.1 以 `dispatchState='running'` 建立，`runnerId=null`、`runtime='mock'`。
- 运行时：`MockRuntimeService`（`apps/api/src/modules/runtime/mock-runtime.service.ts`）
  是**纯内存**会话（`sessions: Map`），**不写数据库**；它通过 `emit()` 把
  log/progress/completed/failed 事件交给监听者，由 `executions.service` 落库。
- 终态：`writeTerminalDecision`，`decidedBy` 由 `executions.service.ts:985-986` 决定
  （mock → `API:mock-runtime`）。
- **mock 从不创建 `RepositoryHandshakeMessage`**，也从不进入 `created`/`repository_*`/
  `start_sent`。握手只由 `RunnerRuntimeService.start` 触发
  （`apps/api/src/modules/runtime/runner-runtime.service.ts:31` → `handshake.dispatch`），
  mock 走的是另一个实现。

### 2.3 真实 Runner 路径

| 阶段 | 位置 | `dispatchState` |
| --- | --- | --- |
| 建行 | `executions.service.ts:345` | `created`（`runnerId` 非空） |
| 持久化 repository 消息 | `repository-handshake.service.ts:763` 附近 | `created` → `repository_preparing` |
| 收到 accepted | `:970-974` | `repository_preparing` → `repository_ready` |
| 持久化 start + 发 start | `:1005-1010` | `repository_ready` → `start_sent` |
| 收到 accepted（start） | `:1144-1147` | `start_sent` → `running` |

每一次推进都是 **UPDATE**，都要过 T4 的证据检查（`EXISTS` 握手消息 + 时间列）。
这条链的完整性完全依赖「`running` 只能从 `start_sent` 来」——而 T4 的允许列表
（`migration.sql:320-326`）确实没有 `created → running`、`repository_ready → running`。

### 2.4 Recovery Scanner 的查询与判断路径

| 场景 | 查询 | 判断 |
| --- | --- | --- |
| runner 重连 | `runnerId = X AND status='running' AND dispatchState IN ('start_sent','running')`（`:531-534`） | 把这些 id 发给 runner 做 reconcile |
| 快照对账 | 同上（`:842-849`） | 三分支：runner 多报 → cancel；服务端多出 → 视 `createdAt` 与 `connectedAt` 决定保留或 `RUNNER_RESTARTED`；双方都有 → reconcile |
| 断连 grace 超时 | `failOrphanedExecutions(runnerId, 'RUNNER_DISCONNECTED')`（`:959`） | 全部失败（不重跑） |

三条都以 `runnerId` 为**第一过滤条件**。这是当前唯一阻止 mock 行进入恢复的手段，
且它是隐式的。

---

## 3. 原审查建议的评估

> 允许 INSERT：`created` / `running` / `terminal`；拒绝：`repository_preparing` /
> `repository_ready` / `start_sent`。

**评估：方向正确，但不完整。**

| 建议 | 评估 |
| --- | --- |
| 允许 `created` | 正确。真实 Runner 路径必需（§2.3），且 `created` 本身不声称任何证据 |
| 允许 `running` | 正确但**不充分**：不区分「mock 出生即 running」与「伪造的 runner running」。必须补一条 `runnerId` 条件 |
| 允许 `terminal` | 正确。T1 已经强制完整元组 + 合法身份 + decision/status 匹配；seed 也依赖它 |
| 拒绝三个中间态 | 正确。这三个状态的语义就是「已经发生了某个握手步骤」，INSERT 出来必然是伪造 |

补强点：`running` 的允许必须**带上「无 runner」这一条件**，否则建议只堵了三个状态，
最危险的那条（伪造 runner 的 running）仍然敞开。

---

## 4. 最小可行约束设计

### 4.1 形式

新增一个 **BEFORE INSERT** Trigger（建议名 `Execution_dispatch_insert_guard`，
与既有 T1–T10 的命名风格一致），只做三件事：

```sql
-- 伪代码（本轮不落地，实际 SQL 需在 forward migration 中评审）
BEFORE INSERT ON "Execution"
FOR EACH ROW
BEGIN
  -- 1. 六态之外的值不得作为出生状态
  RAISE(ABORT) WHERE NEW."dispatchState" NOT IN
    ('created','repository_preparing','repository_ready','start_sent','running','terminal');

  -- 2. 三个中间态不得被 INSERT（它们只能由 UPDATE + 证据推进得到）
  RAISE(ABORT) WHERE NEW."dispatchState" IN
    ('repository_preparing','repository_ready','start_sent');

  -- 3. 出生即 running 只允许无 runner 的执行（mock / demo）
  RAISE(ABORT) WHERE NEW."dispatchState" = 'running' AND NEW."runnerId" IS NOT NULL;
END;
```

### 4.2 为什么这是「最小」

- **不新增列**：不需要 `isMock`、不需要 `birthState`、不需要回填。
- **不改已有 Trigger**：T1–T10 一个字都不动，因此已应用环境的 checksum 不受影响。
- **只作用于 INSERT**：已有行不满足新条件也不会被追溯拒绝，**无需数据迁移**。
- **可判定**：`runnerId IS NOT NULL` 是服务端写入的字段，不是客户端可控的 `runtime` 字符串。

### 4.3 为什么不是「更强」的方案

以下方案被评估后放弃，理由写在这里以免 Slice 2 重复讨论：

| 方案 | 放弃理由 |
| --- | --- |
| 用 `runtime='mock'` 作为判据 | 客户端可控（任务配置里可改），不能作为安全边界 |
| 要求 `running` 必须有 `startSentAt` | mock 没有 start 时钟；会直接破坏 mock 兼容性 |
| 要求 `running` 必须有 `execution.start` 消息（EXISTS） | 同上；且 mock 从未持久化握手消息 |
| 禁止 INSERT `running`，强制 mock 也走 `created` | 会迫使 mock 伪造握手证据，与「不伪造」冲突 |
| 用 `registrationId IS NULL` 判 mock | `registrationId` 在真实路径上由握手写入，但在 `created` 阶段也是 NULL，无法区分 |

### 4.4 落地方式（不在本轮）

- 必须是**新的 forward migration**（例如 `2026xxxx_p2_02_wpd_execution_insert_guard`）。
  **不得**修改 `20261116120000_p2_02_wpd_slice1_schema_migration/migration.sql`
  ——该文件已被多个环境应用，改它等于改 checksum（见运维手册 §3 E）。
- 新迁移同样需要 `BEGIN IMMEDIATE … COMMIT` 包裹（单文件原子性）。
- 新迁移需要在 `apps/api/scripts/verify-migration-consistency.mjs` 的
  `requiredTriggers` 中登记，否则门禁不覆盖它。
- 需要 `database-triggers.integration.spec.ts` 增加 §6 的正反向用例。

---

## 5. 对现有 Mock Runtime 的兼容性

| 检查项 | 结论 | 依据 |
| --- | --- | --- |
| mock 执行 INSERT（`running` + `runnerId NULL`） | **允许** | §4.1 规则 3 只拦 `runnerId IS NOT NULL` |
| 真实执行 INSERT（`created` + `runnerId`） | **允许** | 规则 2 只拦三个中间态 |
| seed 执行 INSERT（`terminal` + 完整元组 + `runnerId NULL`） | **允许** | T1 已覆盖，规则 1/2/3 均不触发 |
| 握手链 UPDATE（`created→…→running→terminal`） | **不受影响** | Trigger 只作用于 INSERT |
| 测试 fixture（默认 `dispatchState='created'`，不设 `runnerId`） | **允许** | `database-triggers.integration.spec.ts:97,222` |
| 测试直接建行（`created` + `runnerId=RUNNER_ID`） | **允许** | `runner.integration.spec.ts:1455-1471`、`:1524-1539` |
| 任何 INSERT 三个中间态的地方 | **不存在** | 全仓库 grep 无命中（生产代码与测试均无） |

Mock 侧唯一需要**文档化**的行为差异：mock 行的 `dispatchState='running'` 从此有了
「数据库保证它没有 runner」的含义。`docs/execution-recovery.md:110-114` 的
「API 重启后 mock 行会滞留」结论不变。

---

## 6. 对 Slice 2 恢复矩阵的影响

加上该约束后，恢复矩阵可以依赖一条**可证明**的推理：

> `dispatchState='running' AND runnerId IS NOT NULL`
> ⇒ 该行只能由 `start_sent → running` 的 UPDATE 得到
> ⇒ `start_sent` 曾被满足
> ⇒ 该执行存在持久化的 `execution.start` 消息 + `startSentAt` + `startAcceptDeadlineAt`

这条推理链是 Slice 2 判定 `RUNNER_RESTARTED` / `RUNNER_START_UNCONFIRMED` /
`RECOVERY_DEADLINE_EXCEEDED` 的前提。**没有这条约束，该前提不成立**——恢复矩阵会建立在
「running 一定走过握手」这个未被数据库保证的假设上。

反过来，恢复矩阵必须显式写明的分支：

| 行形态 | 恢复矩阵的处置 | 说明 |
| --- | --- | --- |
| `running` + `runnerId` 非空 | 进入正常恢复判定 | 有握手证据 |
| `running` + `runnerId` 为空（mock / demo） | **不进入 runner 恢复判定**；按 `docs/execution-recovery.md:110-114` 由 UI/API 取消或重置 | 无 runner，也无持久会话 |
| `dispatchState IN ('repository_preparing','repository_ready')` | 见 G5 §6 的 O3（基线未定义） | 不得默认「继续推进」 |
| `status='cancelled' AND terminalDecision IS NULL` | 不参与裁决（不可补写，T2 拒绝） | 见 G5 §4 |

---

## 7. 正反向测试场景

### 7.1 正向（必须成功）

| # | 场景 | 断言 |
| --- | --- | --- |
| F1 | INSERT `status='running', dispatchState='running', runnerId=NULL`（mock 形态） | 成功，行存在 |
| F2 | INSERT `status='running', dispatchState='created', runnerId='rn_x'`（runner 形态） | 成功 |
| F3 | INSERT `status='completed', dispatchState='terminal'` + 完整元组 + `runnerId=NULL`（seed 形态） | 成功 |
| F4 | 完整握手 UPDATE 链 `created→repository_preparing→repository_ready→start_sent→running→terminal` | 每一步成功（回归：证明新 Trigger 没误伤 UPDATE） |

### 7.2 反向（必须 ABORT，且失败后原行未被修改）

| # | 场景 | 期望错误文本 |
| --- | --- | --- |
| R1 | INSERT `dispatchState='repository_preparing'` | `Execution_dispatch_insert_guard: …` |
| R2 | INSERT `dispatchState='repository_ready'`（即使带 `repositoryPreparedAt` + `repositoryPath`） | 同上 |
| R3 | INSERT `dispatchState='start_sent'`（即使带 `startSentAt` + 真实 `execution.start` 消息） | 同上 |
| R4 | INSERT `dispatchState='running', runnerId='rn_real'` | 同上（**本设计的核心用例**） |
| R5 | INSERT `dispatchState='bogus'` | 同上 |
| R6 | INSERT `dispatchState='terminal', status='running'` | T1 既有拒绝（回归） |
| R7 | UPDATE `created → running`（越级） | T4 既有拒绝（回归） |

### 7.3 必须补的端到端用例

| # | 场景 | 断言 |
| --- | --- | --- |
| E1 | mock 执行完整生命周期（创建 → 推进 → 完成） | 全绿，且行从未出现 `created`/`start_sent` |
| E2 | 真实 runner 执行完整握手（`runner.integration.spec.ts:911-983` 已有类似） | 全绿 |
| E3 | 恢复扫描器（Slice 2 实现后）对 mock 行的处置 | 断言**不**产生 `RUNNER_*` 裁决 |

---

## 8. 未决问题（OPEN）

本设计**不标 CLOSED**，原因如下。

### O-1（阻断性）恢复扫描器的查询边界未定

约束能保证「`running` + `runnerId` 非空 ⇒ 走过握手」，但**不能**保证扫描器不去处理
mock 行。今天靠的是三条查询都带 `runnerId` 过滤这一**隐式约定**；扫描器尚不存在，
无法验证它会遵守。若扫描器写成全局查询，mock 行会被当成「服务端认为在跑、runner 未报告」
并被判 `RUNNER_RESTARTED`——一个 demo 执行会被写成失败。

→ 必须与 Slice 2 的扫描器设计**同时**评审，并在扫描器里显式写 `runnerId IS NOT NULL`。
在此之前，「mock 兼容性」与「真实 Runner 状态可信度」只在 INSERT 维度上同时成立，
**在恢复维度上不成立**。

### O-2（非阻断）是否也给 `created` 加条件

真实路径的 `created` 一定带 `runnerId`；mock 从不进 `created`。理论上可以加
「`created` ⇒ `runnerId` 非空」，但测试 fixture 大量使用 `created` + 无 `runnerId`
（`database-triggers.integration.spec.ts:97,222`），会迫使测试改造。收益低、成本高，
建议**不加**，并在此记录理由。

### O-3（非阻断）`terminal` INSERT 是否也该限制

`INSERT ... status='completed', runnerId='rn_real'` 可以造出一条「runner 执行的历史终态行」。
T1 会强制完整元组与合法身份，所以它至少是**显式声明**的（有 `decidedBy` 可审计），
危害远小于伪造 `running`。建议**不加**，但 Slice 2 的审计口径应能区分
「INSERT 出来的终态行」与「UPDATE 进入的终态行」（今天数据库无法区分，属已知局限）。

### O-4（流程性）落地顺序

本约束必须作为 forward migration 与以下三件事**同一批**交付：
① `verify-migration-consistency.mjs` 的 `requiredTriggers` 登记；
② `database-triggers.integration.spec.ts` 的 §7.2 反向用例；
③ G5 §2 的裁决值表更新（`running` 的证据要求从「无」变为「隐含 start_sent」）。
只交付 Trigger 而不交付 ①②③，等于新增一个无人验证的执法点。

---

## 9. 结论

| 问题 | 结论 |
| --- | --- |
| 能否用一条 INSERT 期约束同时保住 mock 兼容性与真实 Runner 可信度？ | **在 INSERT 维度可以**（§4.1 三条规则） |
| 是否需要在数据库之外增加可信证据？ | 不需要新列；`runnerId` 已足够区分 |
| 本设计是否可以直接落地？ | 否。必须走 forward migration，且与 ① ② ③ 同批（O-4） |
| G3 状态 | **DESIGN READY / NOT CLOSED**，阻断项 O-1 |

---

## 10. 交叉引用

- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §2（13 个裁决值表）
- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §3（六态表，`running` 行「数据库无证据要求」）
- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §6 O1（本设计的阻断项）
- `docs/engineering/P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`（同为「数据库层如何被绕过」的相邻风险）
- `docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md` §1（新约束必须走 forward migration）
