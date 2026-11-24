# P2-02 WP-D G3 定点设计审查：Recovery Scanner 信任边界

状态：**设计完成；O-1 在本轮关闭；G3 仍为 NOT CLOSED（无实现）**
编制日期：2026-11-24
基线：`feature/p2-02-wpd-slice1-1-remediation` @ `fb664cc`（工作区含本轮之前的未提交文档，已保留）
本轮边界：**只读设计审查**。未修改生产代码、测试、Schema、Migration、数据库；未执行 Migration；
未 commit / push；未启动 Slice 2。

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| Mock 执行能否被真实 Runner Recovery 误认 | 只要扫描器用**正向**判据 `runnerId IS NOT NULL`，不能；用 `runnerId IS NULL` 反推 mock 则不可靠（见 §3.3 A4） |
| 真实执行的 `runnerId` 是否等于"握过手" | **不等于**。`runnerId` 在 INSERT 时写入，早于任何消息（§2.2） |
| `running` 今天是否有完整证据 | **没有**。两条缺口：①INSERT 可直达 `running`；②`UPDATE start_sent→running` 无 ack 校验（§2.5） |
| 原审查的 INSERT 建议是否够用 | 不够。缺 `running + runnerId IS NOT NULL`，且未处理 `terminal + runnerId IS NOT NULL`（§4.4） |
| 是否需要在数据库层识别 mock | **不可能**。数据库只能识别"无 runner"，`runtime` 是客户端可控字符串（§4.6） |
| G3 判定 | **IMPLEMENTATION READY**（边界与验收条件已冻结）；G3 关闭状态仍为 **NOT CLOSED** |
| Slice 2 Entry Gate | 仍为 **CONDITIONAL GO**：O-1 关闭，但 O8（REPLACE 风险签署）未决 + 实现未落地 |

---

## 1. 取证索引（本轮全部结论的代码出处）

| 断言 | 位置 |
| --- | --- |
| 唯一生产建行点；mock 与真实 Runner 的分叉 | `apps/api/src/modules/executions/executions.service.ts:167-169`、`:227-236`、`:329-348` |
| `requiresRunner` 判定只来自 `assignee.runtime` | 同上 `:167-168` |
| `runtime` 是 Agent 上的客户端可写字段 | `apps/api/prisma/schema.prisma:128`（`Agent.runtime String @default("mock")`） |
| `Execution.runnerId` 可空、外键 `ON DELETE SET NULL` | `schema.prisma:169`、`:222` |
| 握手的四个状态推进点 | `apps/api/src/modules/runners/repository-handshake.service.ts:759-771`、`:966-995`、`:1001-1034`、`:1139-1153` |
| 两条消息在建行阶段就被持久化（`status='created'`） | 同上 `:743-758`（`acquireDispatch`） |
| `sent` 的真实含义（transport 已接手） | 同上 `:480-487`；`handshake-message.service.ts:55-67` |
| `acked` 的真实含义（Runner 已接受） | `handshake-message.service.ts:77-89` |
| T4 对 `start_sent` 的证据只要求消息 `status IN ('created','sent','acked')` | `20261116120000_p2_02_wpd_slice1_schema_migration/migration.sql:354-365` |
| T4 **不校验** `running` 的 ack 证据 | 同上 `:319-326`（允许列表里没有 `running` 分支的证据条件） |
| 现有四个恢复查询都以 `runnerId` 为第一过滤条件 | `runner-registry.service.ts:205-217`、`:531-541`、`:838-849`、`:981-988` |
| `failOrphanedExecutions` **不带** `dispatchState` 过滤 | 同上 `:985-988` |
| 快照对账三分支与 `createdAt >= connectedAt` 守卫 | 同上 `:858-923` |
| Runner 身份 = 配置字符串 + token | `apps/runner/src/config.ts:125`、`apps/runner/src/token-store.ts:3-25` |
| 注册纪元每次 register 轮换 +1 | `runner-registry.service.ts:470-505` |
| 单实例假设（连接表在进程内存） | 同上 `:144-175`、`:332-360` |

> 与既有设计文档的一处事实修正：`P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md` §2.4 记为"三条查询"，
> 实际是**四条**——`onModuleInit` 的启动扫描（`:205-217`）同样是 `status='running' AND runnerId IS NOT NULL`。
> 这条更关键：它就是"恢复扫描器"的原型，且它**已经**依赖 `runnerId` 过滤来排除 mock。
> 修正后结论不变，但"隐式约定"的覆盖面比原文更大。

---

## 2. 第一部分：Mock Runtime 完整追踪

### 2.1 唯一建行点

`startForTaskLocked` 是生产代码里唯一的 `execution.create`（全仓库 grep 仅两处测试直接建行，
均在 `runner.integration.spec.ts:1455`、`:1524`，且都是 `created` + `runnerId`）。

```ts
const runtimeType = task.assignee.runtime as AgentRuntimeType;   // :167
const requiresRunner = runtimeType !== 'mock';                   // :168
...
dispatchState: requiresRunner ? 'created' : 'running',           // :345
phase:         requiresRunner ? 'queued'  : 'running',           // :342
runnerId,                                                        // :333（mock 分支恒为 null）
```

`runnerId` 只在 `requiresRunner` 分支被赋值（`:227`，来自 `availability.runnerId`，即该 computer
的 `Runner` 行）。mock 分支从不进入该分支，因此**建行语句里的 `runnerId` 恒为 `null`**。

### 2.2 六个问题的逐条回答

**Q1. Mock 执行是否始终具有 `runnerId=NULL`？**
是——在**生产写入路径**上。但"始终"要分两层：

- 出生时：必然 `NULL`（唯一建行点决定）。
- 终身：**不保证**。`Execution.runner` 是 `onDelete: SetNull`（`schema.prisma:222`），
  删除 `Runner` 行（今天没有 API 端点，但存在运维/脚本路径，且 `Computer` 删除会级联到 `Runner`）
  会把该 runner 的历史执行（含正在 `running` 的）改成 `runnerId = NULL`。
  这不会把 mock 变成真实执行，但会把**真实执行**伪装成"无 runner"。

**Q2. 是否存在 Mock 执行获得非空 `runnerId` 的路径？**
生产路径：**没有**。非生产路径有三条，都不能算"合法路径"：

| 路径 | 是否可达 | 说明 |
| --- | --- | --- |
| 测试直接建行 | 是 | `runner.integration.spec.ts:1455/1524`，`runnerId=RUNNER_ID` 但 `dispatchState='created'`，形态合法 |
| 任意 raw SQL / 未来的 admin 工具 | 是 | 这正是 G3 要拦的入口 |
| FK 反向（真实执行 → `runnerId=NULL`） | 是 | 见 Q1 终身层 |

**Q3. Mock 执行是否可能通过其他字段伪装成真实 Runner？**
逐字段核对（`Execution` 上所有与 Runner 相关的列）：

| 字段 | mock 出生值 | 真实执行 `created` 阶段 | 能否作判据 |
| --- | --- | --- | --- |
| `runnerId` | `NULL` | 非空 | **唯一可靠**（服务端写入） |
| `runtime` | `'mock'` | `'codex'`/`'opencode'` | **不能**：客户端可控（Agent 配置） |
| `registrationId` | `NULL` | `NULL`（握手时才写） | 不能（两阶段同值） |
| `registrationEpoch` | `0` | `0` | 不能 |
| `repositoryProjectId` / `repositoryBindingId` | `NULL` | 非空（mock 不建） | 只能作正向佐证 |
| `startSentAt` / `startAcceptDeadlineAt` / `recoveryDeadlineAt` | `NULL` | `created` 阶段也是 `NULL` | 只能作正向佐证 |
| `branchName` / `baseCommit` / `headCommit` | `NULL` | 终态才写 | 不能 |
| `lastRunnerSeq` | `0` | `0` | 不能 |

结论：**只有 `runnerId` 能区分**，且它区分的是"有 runner / 无 runner"，不是"mock / 真实"。

**Q4. Mock 执行的 `dispatchState` 生命周期是什么？**
`running → terminal`，**单跳，无中间态**：

| 阶段 | `dispatchState` | 触发点 |
| --- | --- | --- |
| 出生 | `running` | `executions.service.ts:345` |
| 运行中 | `running`（不变） | `MockRuntimeService` 只发内存事件，从不写 `dispatchState` |
| 终态 | `terminal` | `writeTerminalDecision`（`execution-terminal.ts:64`），T4 允许 `running → terminal` |

mock 从不出现 `created` / `repository_preparing` / `repository_ready` / `start_sent`。

**Q5. Mock 执行是否需要持久化恢复？**
**不需要，也不应该。**

- `MockRuntimeService` 是纯内存 `Map`（`mock-runtime.service.ts:59`），无 journal、无 spool、无进程。
- API 重启后 mock 行滞留为 `running` 是**已知限制**（`docs/execution-recovery.md:110-114`）。
- 它的正确处置是"人工/操作员终结"（取消或重置），**不是**任何 `RUNNER_*` 裁决。
- 若恢复扫描器对 mock 行判 `RUNNER_RESTARTED`，等于把一个 demo 执行写成"Runner 重启丢了它"——
  这是一条**从未发生过的执行的失败记录**，属伪造证据。

**Q6. Mock 执行是否需要保留原有日志和 Git 信息？**

| 资产 | mock 现状 | 结论 |
| --- | --- | --- |
| 日志 | 会落库：`MockRuntimeService.emit` → `ExecutionsService.handleLog` → `ExecutionLog`（含 `seq`） | **必须保留**：这是 mock 执行唯一的持久证据 |
| Git 信息 | **从不产生**：mock 的 `completed` 事件不带 `git`（`mock-runtime.service.ts:187`），`finishExecution` 因此不写 `branchName`/`baseCommit`/diff artifact | **不应补写**：mock 没有 worktree，填 Git 字段就是伪造 |
| `ExecutionArtifact` | 永远没有 `git-diff` 行 | 同上 |

> 推论（对扫描器有用）：`runtime='mock'` 且 `branchName IS NULL` 且无 `git-diff` artifact 是 mock 的
> 一致形态；但这只用于**审计解释**，不得作为安全判据。

---

## 3. 第二部分：真实 Runner 完整追踪

### 3.1 状态推进时序（含证据写入点）

| # | 阶段 | 代码 | 写入 | `dispatchState` | 新增持久证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 选 Runner | `executions.service.ts:219-235` | 无 | — | 无（内存 live registration） |
| 2 | 建行 | `:329-348` | `Execution` | `created` | `runnerId`、`repositoryProjectId`、`repositoryBindingId` |
| 3 | 提交事务 | `:358` | — | `created` | — |
| 4 | 发起派发 | `:386` → `runner-runtime.service.ts:31` | — | `created` | — |
| 5 | 持久化两条消息 + 状态推进（同一事务） | `repository-handshake.service.ts:743-775` | `RepositoryHandshakeMessage` ×2 + `Execution` | `repository_preparing` | `execution.repository`(created)、`execution.start`(created)、`registrationId`/`registrationEpoch` |
| 6 | 发出 repository | `:427-428` | 消息 `sent` + `sentAt` | `repository_preparing` | — |
| 7 | 收到 `execution.repository.accepted` | `:966-995` | `Execution` + 消息 `acked` | `repository_ready` | `repositoryPath`、`repositoryPreparedAt`、`repositoryPolicyVersion` |
| 8 | 发出 start + 固定时钟 | `:1001-1034`（发在 `:480-487`） | `Execution` + 消息 `sent` | `start_sent` | `startSentAt`、`startAcceptDeadlineAt`(+20s)、`recoveryDeadlineAt`(+120s) |
| 9 | 收到 `execution.accepted` | `:1139-1153` | `Execution` + 消息 `acked` | `running` | 消息 `ackedAt` |
| 10 | 终态 | `execution-terminal.ts:42-72` | `Execution` | `terminal` | 终态元组 + `endedAt` |

### 3.2 七个问题的逐条回答

**Q1. 真实 Runner 在哪个阶段获得 `runnerId`？**
第 2 步（建行），值来自第 1 步的 `availability.runnerId`，后者来自该 computer 的 `Runner` 行。
**早于任何握手消息**。

**Q2. `runnerId` 是什么时候持久化的？**
与建行同一事务（`:329-348`），在 `runtimes.start()` 之前（`:386`）。
所以"持久化了 runnerId"与"发出了任何消息"之间没有因果关系。

**Q3. 是否可能先出现 `runnerId`，再出现握手消息？**
**总是如此**，这是唯一顺序。因此：

> `runnerId IS NOT NULL` ⇒ 只能证明"服务端为该执行选定了这个 Runner"。
> 它**不能**证明：消息已持久化、消息已发出、Runner 已收到、进程已启动。

**Q4. `running` 状态是否一定具备完整握手证据？**

必须把"证据"分级，否则这句话没有意义：

| 证据等级 | 含义 | 数据库载体 | 谁能伪造 |
| --- | --- | --- | --- |
| E0 形状 | 状态值合法、时钟列非空 | `dispatchState`、`startSentAt`、`startAcceptDeadlineAt` | 任何能写这一行的人 |
| E1 意图 | 已持久化 `execution.start` 消息 | `RepositoryHandshakeMessage` 行存在（`status='created'` 即可） | 同上（T7 只校验形状） |
| E2 送达 | 消息已交给 transport | 消息 `status IN ('sent','acked')` + `sentAt` | 同上 |
| E3 接收 | Runner 已确认接受 | 消息 `status='acked'` + `ackedAt` | 同上 |

按此分级：

- `start_sent` 的数据库证据是 **E0 + E1**（T4 的 `EXISTS` 接受 `status='created'`，见 `migration.sql:359-364`）。
  而 E1 是**必然成立**的：第 5 步在建行阶段就写入了 `execution.start` 行（`:753-758`）。
  所以 `start_sent` 实际只表示"已决定启动并固定了时钟"，**不表示已发出**。
- `running` 的**强证据**是 E3（`execution.accepted` 后 `markAcked`，`:1149-1151`），
  但数据库**不要求**它：T4 的允许列表里 `start_sent → running` 没有任何证据条件。

> **第二条缺口（本轮新发现，记为 R2）**：
> ```sql
> UPDATE "Execution" SET dispatchState='running' WHERE dispatchState='start_sent';
> ```
> 这一条语句今天会**成功**，无需任何 ack、无需任何消息状态变化。
> 也就是说：即使 INSERT 被完全封死，`running` 仍然可以通过一条 UPDATE 在没有 Runner 确认的情况下产生。
> G3 原文只讨论了 INSERT 入口，漏了这条 UPDATE 入口。

**Q5. 是否存在异常路径可以绕过证据链？**

| # | 路径 | 今天是否可行 | 覆盖它的执法点 |
| --- | --- | --- | --- |
| P1 | `INSERT` 直达 `running` + 真实 `runnerId` | **可行** | 无（T4 不作用于 INSERT）→ G3 主项 |
| P2 | `INSERT` 三个中间态（可自带假消息满足 EXISTS） | **可行**（先插消息再插行则完全通过） | 无 |
| P3 | `UPDATE start_sent → running` 无 ack | **可行** | 无 → R2 |
| P4 | `INSERT OR REPLACE` 抹掉历史重开 | 可行（若 Prisma/运维产生 REPLACE） | 无 → G4 |
| P5 | `UPDATE` 修改 `runnerId` 本身 | 可行（无 Trigger 保护该列） | 无（见 §3.3 A4） |

**Q6. Runner 重启后是否保留原身份？**

| 身份层 | 载体 | 跨重启 | 说明 |
| --- | --- | --- | --- |
| `Runner.id`（= `runnerId`） | `HAFT_RUNNER_ID` 配置（默认 `runner_local`）+ `~/.haft/runner-<id>.json` token | **稳定** | 是"配置的字符串"，不是服务端颁发 |
| `Runner.registrationId` | 每次 `runner.register` 重新生成 UUID | **不稳定** | 轮换 |
| `Runner.registrationEpoch` | 每次 register +1（`Runner_registration_guard` 强制） | **单调递增** | 纪元不可回退 |

所以：**执行行上的 `runnerId` 指向的是一个"配置身份"，它跨进程重启稳定；而 `registrationId/epoch`
指向的是"这一次连接"，重启后必然变化。**

**Q7. 多实例环境下如何识别同一个 Runner？**
**不能可靠识别。** 事实：

- `Runner.computerId` 是 `@unique`（`schema.prisma:91`）——一台电脑只允许一个 Runner 行。
- 连接表 `connections` / `liveRegistrations` 是**进程内存** `Map`（`runner-registry.service.ts:144-175`）。
- 两个进程用同一 `runnerId` + 同一 token 连接时：后注册者覆盖 `liveRegistrations` 并推进 epoch，
  前者的 socket 仍然存在但已不被视为当前注册——**没有任何冲突检测或踢出机制**。

结论：`runnerId` 在单实例下是可信的"谁"，在多实例下只是"谁自报了名字"。这与 O5（多实例协调）一致，
不在本轮解决，但扫描器不得基于"runnerId 存在 ⇒ 该 Runner 唯一且在线"做决策。

### 3.3 四个概念的严格区分（本轮的核心结论）

| 概念 | 判定来源 | 判据 | 不可由什么推出 |
| --- | --- | --- | --- |
| **身份可信** | `liveRegistrations.get(runnerId)`（内存）+ token 校验 | 该 runnerId 当前有一条已认证 socket 且已 `register` | 不能由 DB 的 `runnerId` 列推出（那是历史分配） |
| **曾经启动** | `execution.start` 消息 `status IN ('sent','acked')` + `startSentAt` | E2/E3 证据 | 不能由 `dispatchState='running'` 推出（R2 缺口） |
| **当前仍存活** | Runner 的 `runner.snapshot`（唯一权威所有权信号）+ `execution.reconcile` | 快照报告了该 executionId | 不能由 `Runner.status='online'` 推出（DB 状态是上一次连接的残留） |
| **可安全恢复** | 上述三者 + `recoveryDeadlineAt` + 无 cancel 意图 | 见 §5 判定树 | 不能由任意单一字段推出 |

> 一句话：**`runnerId` 非空只回答"当初派给谁"，不回答"现在还在不在跑"。**

---

## 4. 第三部分：Recovery Scanner 的可信查询契约

### 4.1 三条不可协商的原则

1. **正向白名单，不做反向推断。** 扫描域用 `runnerId IS NOT NULL` **正向选择**，
   绝不用 `runtime <> 'mock'` 或 `runtime = 'codex'` 反向排除（`runtime` 客户端可控）。
2. **fail-closed。** 证据不足 ⇒ 保持 `running` + 记录未决，不得猜、不得判成功、不得启第二个 Runner。
3. **证据先于状态。** 看到 `dispatchState` 只当作"声称"，必须再验证证据行（§6.4）才允许裁决。

### 4.2 扫描域（唯一允许的形态）

```sql
-- RecoveryScanner 的候选集：这是唯一合法的入口查询
SELECT id, runnerId, dispatchState, startSentAt, recoveryDeadlineAt, createdAt, cancelRequestedAt
FROM "Execution"
WHERE status = 'running'
  AND runnerId IS NOT NULL                    -- 正向判据：无 runner 的执行永不出现在这里
  AND dispatchState IN ('created','repository_preparing','repository_ready','start_sent','running')
  AND cancelRequestedAt IS NULL;              -- 已有取消意图的行由取消路径拥有
```

- `status = 'running'` 排除全部终态行（T2 保证终态不可变，扫描器无权也无必要触碰）。
- `runnerId IS NOT NULL` 排除 mock / demo（含 FK 失联后的真实执行——见 §4.3 A4 的取舍）。
- `dispatchState IN (...)` 显式列出五态，**不使用 `NOT IN ('terminal')`**：新增第七态时默认被排除而不是被纳入。

### 4.3 A/B/C 三组逐条回答

#### A. Mock 执行

**A1. 是否应当完全排除在真实 Runner Recovery Scanner 之外？**
是。必须，且必须用**数据库字段条件**表达，不能靠"扫描器恰好这么写"。

**A2. 明确的字段与查询条件：**

| 目的 | 条件 | 强度 |
| --- | --- | --- |
| 扫描域排除 | `runnerId IS NOT NULL` | 强（服务端写入、非客户端可控） |
| 审计区分（非安全判据） | `runtime = 'mock' AND runnerId IS NULL AND registrationId IS NULL AND startSentAt IS NULL` | 弱（仅用于解释与报表） |

**A3. mock 的处置归属：**
不属于 Recovery Scanner。它的"滞留 `running`"由操作员/UI 取消处理
（`ExecutionsService.cancel` → `cancelMockExecution`，`decidedBy='API:operator'`）。
扫描器可以**报告**它（指标：`mock_stale_running`），但不得产生任何 `RUNNER_*` 裁决。

**A4. 一个必须写明的取舍（FK `ON DELETE SET NULL`）：**
`Execution.runnerId` 在 `Runner` 行被删除时会变 `NULL`（`schema.prisma:222`）。今天没有 API 端点，
但这是**数据层可达**的。后果与取舍：

| 方案 | 行为 | 风险 |
| --- | --- | --- |
| 用 `runnerId IS NOT NULL` 正向选择（**推荐**） | 失联的真实执行会**掉出**扫描域，滞留 `running` | 安全方向：不会误恢复、不会误启第二个 Runner；代价是人工介入 |
| 用 `runtime <> 'mock'` 兜底 | 能覆盖失联行 | **不安全**：`runtime` 客户端可控，且会把 mock 拉回来 |

结论：采用正向选择，接受"失联即人工"。同时在运维手册登记"删除 `Runner` 行前必须先终结其 running 执行"。

#### B. 真实 Runner（`runnerId IS NOT NULL`）

| `dispatchState` | 进入扫描 | 允许重新启动 | 需要 reconcile | 需要 grace | 允许终态化 | 证据要求 |
| --- | --- | --- | --- | --- | --- | --- |
| `created` | 是 | **否**（从未派发） | 否 | 是：`createdAt + PRE_START_GRACE`（建议 120s） | 是（grace 过后 + runner 在线但快照无它，或 runner 长期不回来） | E0；且必须 **0 条**握手消息（见下） |
| `repository_preparing` | 是 | **否** | 是（若消息已 `sent`/`acked`） | 是：同上 | 仅当消息 `status='created' AND sentAt IS NULL`（从未发出） | E1 |
| `repository_ready` | 是 | **否** | 是（消息可能已 `acked`） | 是：同上 | 否（除非 reconcile 证明 Runner 无此上下文） | E1+E2 |
| `start_sent` | 是 | **否**（start at-most-once） | 是 | 是：`startAcceptDeadlineAt`（+20s）→ 30s 门禁 | 是：`RUNNER_START_UNCONFIRMED` | E0+E1+E2 |
| `running` | 是 | **否**（永不重派） | 是（快照权威） | 是：`recoveryDeadlineAt` / 断连 grace 60s | 是：`RUNNER_RESTARTED` / `RUNNER_DISCONNECTED` / `RECOVERY_DEADLINE_EXCEEDED` | E0+E1+E2+**E3** |

三条硬规则（本轮冻结）：

1. **`created` 的可终态化推理是可证明的**：`acquireDispatch` 在同一事务里先写两条消息再推进状态
   （`:743-775`），所以生产路径上 `dispatchState='created'` ⇒ **零条握手消息** ⇒ 从未发出 ⇒
   不可能有 Runner 上下文或进程。这是唯一可以"无需 Runner 确认就安全终态化"的状态。
2. **`start_sent` 绝不重发**（Partial Unique Index + `startSentAt` 条件更新 + T5 三重保证）。
3. **`running` 绝不重新派发**（`docs/execution-recovery.md:105`）。

#### C. 异常数据（逐条给判定，禁止落进 `default` 分支）

| # | 行形态 | 是否可能（生产路径） | 判定 | 处置 |
| --- | --- | --- | --- | --- |
| C1 | `running` + `runnerId IS NULL` | 是（mock）；FK 失联时也会出现 | **不是真实 Runner 执行** | 不进扫描域；按 mock 处置（操作员取消/重置）。若该执行存在握手消息 ⇒ 说明它曾是真实执行（FK 失联），记录告警 `runner_identity_lost`，保持 `running` 等人工 |
| C2 | `running` + `runnerId` 非空 + **无握手消息** | 生产路径不可能；只能由 INSERT（P1）或历史脏数据产生 | **证据缺失，不是健康执行** | 不恢复、不重启；判 `MESSAGE_INTEGRITY_FAILED`（见 §6.4 的映射理由）；需 Slice 2 批准 |
| C3 | `start_sent` + `runnerId IS NULL` | 不可能（`start_sent` 需 start 消息，而消息只在真实路径写） | 证据自相矛盾 | 同 C2 |
| C4 | `created` + `runnerId` 非空 | **正常**（真实执行出生形态） | 合法 | 按 §4.3 B 的 `created` 行处理 |
| C5 | `terminal` + `runnerId` 非空 | **正常**（真实执行历史） | 合法 | 扫描域外；T2 不可改写 |
| C6 | `runnerId` 存在但 `Runner` 行不存在 | FK 开启时不可能（会 SET NULL）；FK 关闭或外部工具写入时可能 | 身份不可验证 | 不得恢复；记录 `runner_row_missing`；人工处理 |
| C7 | DB 说 `running`，Runner 实际没有 | **常态**（重启/崩溃/超时） | 由快照权威裁定 | 快照缺失 + `createdAt < connectedAt` ⇒ `RUNNER_RESTARTED`；`start_sent` 不得判 RESTARTED（既有守卫 `:890-892`）；断连超 grace ⇒ `RUNNER_DISCONNECTED` |

**两条禁止（复述并加强）：**

- 禁止把 C2/C3 这类"证据不足"的行当作健康执行——它们的 `dispatchState` 只是自称。
- 禁止在无法确认原 Runner 状态时启动第二个 Runner：这既违反 at-most-once，也会造成两个进程写同一个
  worktree（`haft/<executionId>` 分支冲突）。

---

## 5. 第四部分：G3 INSERT 约束逐条重评

### 5.1 逐条评估

| 原建议 | 评估 | 理由 |
| --- | --- | --- |
| 允许 INSERT `created` | **保留** | 真实执行唯一出生态（`:345`）。`created` 不声称任何证据 |
| 允许 INSERT `running` | **保留，但必须加条件** | 只有"无 runner 的 running"（mock/demo）合法 |
| 允许 INSERT `terminal` | **保留，但建议加条件**（见 5.4） | 生产终态一律 UPDATE；INSERT 只服务 seed 与测试 |
| 拒绝 `repository_preparing` / `repository_ready` / `start_sent` | **保留** | 这三个状态的语义就是"某一步握手已发生"，INSERT 必然是伪造 |
| 拒绝 `running AND runnerId IS NOT NULL` | **保留，且是本设计的核心** | 切断 P1 |

### 5.2 Q4.1 为什么允许直接 INSERT `terminal`？

代码事实：**生产路径从不 INSERT 终态行**。终态唯一写入口是 `writeTerminalDecision` 的**条件 UPDATE**
（`execution-terminal.ts:53-70`）。允许 INSERT `terminal` 的合法用途只有两个：

| 用途 | 位置 | 形态 |
| --- | --- | --- |
| demo seed | `apps/api/src/common/seed/demo-data.ts:204-225` | `execution.upsert`，`dispatchState='terminal'`、`runnerId` 未设（NULL）、`decidedBy='API:mock-runtime'` |
| 触发器/迁移测试 | `database-triggers.integration.spec.ts:100`、`migration.integration.spec.ts:307`、`migration-atomicity.integration.spec.ts:179` | 无 `runnerId` |

也就是说：**"允许 INSERT terminal"本质上是"允许 demo/测试构造一条不需要运行时的历史"**，
而不是"允许生产写入终态"。

### 5.3 Q4.2 是否可能绕过正常终态写入流程？

**是，且绕过四处：**

| 被绕过的东西 | 正常路径 | INSERT 路径 |
| --- | --- | --- |
| `running` 前置条件 | `where status='running'` | 无 |
| 条件更新（先写者胜） | `terminalDecision: null` 条件 | 无 |
| `dispatchState` 链（`running → terminal`） | T4 允许列表 | 无（T4 不作用于 INSERT） |
| 身份与运行时的一致性 | 由调用点保证（mock→`API:mock-runtime`） | **无校验**：`runtime='codex'` + `decidedBy='API:mock-runtime'` 可共存 |

T1 只校验**形状**（元组完整、`decidedAt` 是正整数毫秒、前缀合法、decision 与 status 匹配），
不校验"这条执行是否真的跑过"。

### 5.4 Q4.3 是否需要限制终态元组、审计记录或必要证据？

结论：**加一条最小的、不引入新列的约束**——`INSERT terminal ⇒ runnerId IS NULL`。

理由：

1. 生产上不存在"INSERT 一条带 runner 的终态行"的路径（§5.2 已逐点核对）。
2. 不加这条，就可以造出**"某个真实 Runner 成功完成了一次从未发生的执行"**的历史行，
   而 T1 会认为它完全合法。这类伪造比伪造 `running` 更难被发现（终态不可变、不进扫描域、无告警）。
3. 成本为零：不新增列、不回填、不影响任何 UPDATE 路径。

兼容性核对（全部通过）：

| 调用点 | 形态 | 是否受影响 |
| --- | --- | --- |
| `demo-data.ts:204` seed | `terminal` + 无 `runnerId` | 不受影响 |
| `database-triggers.integration.spec.ts` 的 `insertExecutionRaw` / `createExecutionFixture` | `terminal` + 无 `runnerId` | 不受影响 |
| `migration.integration.spec.ts:307` | `terminal` + 无 `runnerId` | 不受影响 |
| `migration-atomicity.integration.spec.ts:179` | `terminal` + 无 `runnerId` | 不受影响 |
| `migration-existing-database.integration.spec.ts:49-61` | **迁移前**插入（含 `repository_preparing`） | 不受影响（BEFORE INSERT 触发器此时尚未创建） |
| `runner.integration.spec.ts` | 无任何 `execution.create` 的终态行 | 不受影响 |

> 明确边界：这条约束会阻止"用 INSERT 导入真实 Runner 的历史执行"。当前没有该需求；
> 若将来需要，正确做法是走 Migration 层的显式回填（在触发器创建之前），而不是放开 INSERT。

### 5.5 Q4.4 `running + runnerId IS NULL` 是否只允许 Mock 路径？

**生产上只允许 mock**，但数据库只能保证"无 runner"，不能保证"是 mock"。措辞必须精确：

> 数据库不变量：`dispatchState='running'` 的 INSERT 行 **没有 runner**。
> "mock" 是这一集合在**当前代码**中的唯一成员，属于应用层语义，不是数据库语义。

这条区别很重要，因为它决定了扫描器的判据只能是 `runnerId IS NOT NULL`（正向），
而不是"`runnerId IS NULL` ⇒ mock"（反向，会被 FK 失联打破）。

### 5.6 Q4.5 是否可以在数据库层可靠识别 Mock 和真实 Runner？

**不能识别 mock，只能识别"有无 runner"。**

- `runtime` 来自 `Agent.runtime`（`schema.prisma:128`），通过 Agent 的 CRUD 可改，属客户端可控输入。
  用 `CHECK (runtime='mock' OR runnerId IS NOT NULL)` 之类的约束会：①把安全边界建立在一个可改字段上；
  ②在"Agent 从 mock 改成 codex"后让历史行语义漂移。
- `registrationId` 在真实路径的 `created` 阶段也是 `NULL`，与 mock 同值。
- 唯一由服务端在 `requiresRunner` 分支写入且客户端不可控的字段是 `runnerId`。

### 5.7 Q4.6 是否存在合法生产路径会被上述限制破坏？

逐条核对后：**没有**。

| 生产/测试路径 | 形态 | 结论 |
| --- | --- | --- |
| mock 建行（`executions.service.ts:329`） | `running` + `runnerId NULL` | 允许（规则 G3 不触发） |
| 真实建行（同上） | `created` + `runnerId` | 允许 |
| 握手链全部推进 | 全部 UPDATE | 不受影响（触发器只作用于 INSERT） |
| seed | `terminal` + 无 runner | 允许 |
| 测试 fixture 默认 | `created` + 无 runner | 允许（O-2：不加"created ⇒ runner 非空"） |
| 测试直接建行 | `created` + `runnerId` | 允许 |
| 迁移回填 | UPDATE，且在任何触发器创建之前 | 不受影响 |

**唯一需要改的测试**（属"升级测试"，不是"放宽约束"）：

- `database-triggers.integration.spec.ts` 的 `accepts the full six-state walk`（`:404-421`）
  用一条 `status='created'` 的 start 消息完成 `start_sent → running`。
  若采纳 §6.2 的 R2（`running` 需 E2/E3 证据），该用例必须把消息改成 `status='sent'`（或 `acked`），
  并新增一条反向用例："`start_sent → running` 且消息仍为 `created` ⇒ ABORT"。

### 5.8 最终 INSERT 规则（4 条，最小集）

```sql
-- forward migration: 2026xxxx_p2_02_wpd_execution_insert_guard（本轮不落地）
CREATE TRIGGER "Execution_dispatch_insert_guard"
BEFORE INSERT ON "Execution"
FOR EACH ROW
BEGIN
    -- G1. 出生状态必须是六态之一
    SELECT RAISE(ABORT, 'Execution_dispatch_insert_guard: dispatchState must be one of the six frozen states')
    WHERE NEW."dispatchState" NOT IN
          ('created','repository_preparing','repository_ready','start_sent','running','terminal');

    -- G2. 三个中间态只能由 UPDATE + 证据推进得到
    SELECT RAISE(ABORT, 'Execution_dispatch_insert_guard: repository_preparing, repository_ready and start_sent require handshake evidence and cannot be inserted')
    WHERE NEW."dispatchState" IN ('repository_preparing','repository_ready','start_sent');

    -- G3. 出生即 running 只允许"无 runner"的执行（mock / demo）
    SELECT RAISE(ABORT, 'Execution_dispatch_insert_guard: a real execution cannot be inserted as running; it must start in created')
    WHERE NEW."dispatchState" = 'running' AND NEW."runnerId" IS NOT NULL;

    -- G4. 带 runner 的终态行只能由 running -> terminal 的 UPDATE 产生
    SELECT RAISE(ABORT, 'Execution_dispatch_insert_guard: a terminal execution with a runner must be produced by the running -> terminal transition')
    WHERE NEW."dispatchState" = 'terminal' AND NEW."runnerId" IS NOT NULL;
END;
```

### 5.9 建议同批交付的两条 UPDATE 期约束（R1/R2，超出 G3 原文但同属本边界）

| # | 约束 | 关闭的缺口 | 依赖 |
| --- | --- | --- | --- |
| R1 | `NEW.dispatchState='running'` ⇒ `startSentAt IS NOT NULL` **且** 存在 `execution.start` 消息 `status IN ('sent','acked')` | P3 的一半（无消息也能跳 `running`） | 无需改代码 |
| R2 | 同上，但要求 `status='acked' AND ackedAt IS NOT NULL` | P3 全部（未 ack 也能跳 `running`） | **需改一行写入顺序**：`onProtocolEvent` 中把 `markAcked` 移到 `updateMany` 之前（同一事务内，`:1139-1153`），否则触发器看到的是 `sent` |

建议：**先落 R1（零代码改动、零风险），把 R2 作为 Slice 2 的明确改进项**。理由：R1 已能把
"完全没有 start 消息"的伪造 `running` 拦死；R2 才拦"有消息但 Runner 没收到"，需要动握手写入顺序，
属行为变更，必须与 Slice 2 的 `execution.accepted` 语义一起评审。

> 交付纪律（沿用 O-4）：新 Trigger 必须与 ① `verify-migration-consistency.mjs` 的 `requiredTriggers`
> 登记、② `database-triggers.integration.spec.ts` 的正反用例、③ 本文件 §7 的矩阵 同批交付，
> 且必须是**新的 forward migration**（`BEGIN IMMEDIATE … COMMIT`），不得改写
> `20261116120000_p2_02_wpd_slice1_schema_migration`。

---

## 6. 第五部分：Slice 2 自动化验收契约

### 6.1 测试矩阵（每项：输入 / 初始态 / 操作 / 预期 / 失败信号 / 对应约束）

约定：`rn_live` = 已注册并连接的 Runner；`rn_gone` = 存在但离线；所有 `INSERT` 均指 raw SQL
（与现有 `database-triggers.integration.spec.ts` 同风格）。

| # | 场景 | DB 初始态 | 操作 | 预期 | 失败时的信号 | 对应代码/约束 |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Mock `running`，`runnerId=NULL` | `status='running', dispatchState='running', runnerId=NULL` | 运行 RecoveryScanner | **不进入**扫描候选集；不产生任何 `RUNNER_*` 裁决；可产出指标 `mock_stale_running` | 若产生裁决 ⇒ 断言失败 + 日志 `recovery.scope_violation` | `runnerId IS NOT NULL`（§4.2） |
| T2 | 真实 `running`，证据完整 | `start_sent → running` 已由 `execution.accepted` 完成；start 消息 `acked`；`startSentAt`/`recoveryDeadlineAt` 非空 | Scanner + `runner.snapshot` 报告该 id | 进入扫描；判定"双方都有" ⇒ 发送 `execution.reconcile`，保持 `running` | 若被终态化 ⇒ 断言失败 | `runner-registry.service.ts:920-923` |
| T3 | `running` + 有 runner + **缺握手证据** | `INSERT` 造行（在新约束下应被拒，故用**迁移前**遗留行或临时禁用触发器构造） | Scanner | **不得恢复/重启**；判 `MESSAGE_INTEGRITY_FAILED`（需 O2 批准）；记录 `recovery.evidence_missing` | 若判 `RUNNER_RESTARTED` ⇒ 断言失败 | §4.3 C2；证据检查 SQL（§6.4） |
| T4 | `start_sent` + `runnerId` 非空 | `startSentAt`/`startAcceptDeadlineAt` 非空；start 消息 `sent` | 快照不含该 id，且 `createdAt < connectedAt` | **不得**判 `RUNNER_RESTARTED`；30s grace 后判 `RUNNER_START_UNCONFIRMED` | 若判 RESTARTED ⇒ 断言失败 | `runner-registry.service.ts:890-902` |
| T5 | `INSERT repository_ready` | 空执行图 | raw INSERT（带 `repositoryPreparedAt`+`repositoryPath`+假消息） | `ABORT`：`Execution_dispatch_insert_guard` | 错误文本不匹配 ⇒ 失败 | G2 |
| T6 | `INSERT start_sent` | 同上 | raw INSERT（带 `startSentAt`+真实 start 消息） | `ABORT`：同上 | 同上 | G2 |
| T7 | `INSERT running + runnerId` | 同上 | raw INSERT | `ABORT`：同上（**核心用例**） | 同上 | G3 |
| T8 | `INSERT terminal` | 同上 | ① 无 runner + 完整元组 ② 带 `runnerId` + 完整元组 | ① 成功 ② `ABORT`（若采纳 G4）；若**不**采纳 G4，则 ② 必须成功且被 §6.4 记为已知局限 | 断言与决策不一致 ⇒ 失败 | G4（§5.4） |
| T9 | `terminal` 被 `REPLACE` 改写 | 一条合法终态行 | `INSERT OR REPLACE` 同 id，改 `terminalDecision` | **数据库层无法拒绝**（T2 不作用于 REPLACE）。验收判据改为：① CI 静态检查禁止 REPLACE；② 改写后 `Activity.executionId` 变 NULL / 子表行数归零 ⇒ 审计断裂检测命中 | 若宣称"触发器已拦住" ⇒ 失败（虚假结论） | G4 §2；`P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md` |
| T10 | Runner 不存在但 DB 仍 `running` | `runnerId='rn_gone'`，`Runner.status='offline'` | 等待 grace（60s）→ Scanner | 判 `RUNNER_DISCONNECTED`；**不启第二个 Runner**；不新建 Execution | 若出现第二个 `execution.start` 消息 ⇒ 失败 | `:952-999`、`:981-988` |
| T11 | mock 完整生命周期（回归） | 通过 `POST /executions` 创建 mock 执行 | 推进至完成 | 行从未出现 `created`/`start_sent`；终态 `decidedBy='API:mock-runtime'`；无 `git-diff` artifact | 出现中间态 ⇒ 失败 | `mock-runtime.service.ts`、`:985-986` |
| T12 | `UPDATE start_sent → running` 无 ack（R1/R2 回归） | `start_sent` + start 消息 `status='created'` | 单条 UPDATE | R1：`ABORT`；未采纳 R1 时：成功（记为缺口） | 与决策不一致 ⇒ 失败 | §5.9 |
| T13 | FK 失联后的扫描域（A4 回归） | 真实 `running` 行，删除其 `Runner` 行 | Scanner | `runnerId` 变 `NULL` ⇒ **掉出扫描域**；不得被当作 mock 取消；记录 `runner_identity_lost` | 若被自动取消/终态化 ⇒ 失败 | §4.3 A4 |
| T14 | `created` + `runnerId` 正常出生（回归） | 真实执行刚建行，runner 在线 | Scanner | 不终态化；等 `createdAt + PRE_START_GRACE`；快照不含它属正常 | 若立刻判失败 ⇒ 失败 | §4.3 B |

### 6.2 每条用例的失败信号规范

统一要求（避免"测试通过但系统错了"）：

| 类别 | 要求 |
| --- | --- |
| 数据库拒绝 | 断言错误文本以触发器名开头（`Execution_dispatch_insert_guard:`），并断言**原行未被修改** |
| 扫描器误纳/误判 | 断言"没有产生终态写入"（`terminalDecision IS NULL` 且 `status` 仍为 `running`）+ 断言日志事件名（`recovery.scope_violation` / `recovery.evidence_missing`） |
| 重复启动 | 断言 `RepositoryHandshakeMessage WHERE messageType='execution.start'` 的行数恒为 1 |
| 证据缺失 | 断言裁决值属于 13 个冻结值，且 `terminalDecidedBy` 为 `API:recovery-scanner` |

---

## 7. 第六部分：最终设计决策

### 7.1 Trust Boundary（四类执行的定义）

| 类 | 名称 | 判定式（SQL） | 谁拥有它的终态 | 可否被 Recovery Scanner 触碰 |
| --- | --- | --- | --- | --- |
| **M** | Mock Execution | `runnerId IS NULL AND runtime='mock' AND startSentAt IS NULL` | 操作员（`API:operator`）或 mock runtime（`API:mock-runtime`） | **否** |
| **R** | Real Runner Execution | `runnerId IS NOT NULL` | Runner 事件 / 恢复裁决（`API:recovery-scanner`、`API:reconciler`） | 是（仅 `status='running'`） |
| **Rc** | Recoverable Execution | `R AND status='running' AND dispatchState IN ('start_sent','running') AND cancelRequestedAt IS NULL AND 证据完整（§6.4）` | 恢复裁决 | 是 |
| **T** | Terminal Execution | `status IN ('completed','failed','cancelled')` | 不可变（T2） | **否**（只读审计） |

补充：`R` 中**不可恢复**的子集（`created`/`repository_preparing`/`repository_ready` 与证据缺失的
`running`）由 Scanner 观察但只能"按 §4.3 B 的规则终态化或保持未决"，**永不可重启**。

### 7.2 数据库约束（最终推荐）

**INSERT（4 条，见 §5.8）**：G1 六态白名单 / G2 拒绝三中间态 / G3 拒绝 `running+runner` /
G4 拒绝 `terminal+runner`。

**UPDATE（建议 2 条）**：R1 `running` 需 `startSentAt` + start 消息 `status IN ('sent','acked')`；
R2 同 R1 但要求 `acked`（需改写入顺序）。

**保持不变的不变量**（本轮不重开）：六态冻结、T1/T2/T3 终态元组、T4 转换允许列表、T5 时钟只收紧、
T7/T8 消息不可变、T9/T10 审计 append-only、`execution.start` Partial Unique Index。

**明确不做**：

- 不新增列（无 `isMock`、无 `birthState`）。
- 不加 `created ⇒ runnerId 非空`（O-2：成本高、收益低）。
- 不用 `runtime` 做任何 CHECK。

### 7.3 Recovery Scanner 查询规则（最终）

```text
输入：now
候选集：status='running' AND runnerId IS NOT NULL
        AND dispatchState IN (created, repository_preparing, repository_ready, start_sent, running)
        AND cancelRequestedAt IS NULL

对每一行：
  1. runner = Runner.findUnique(runnerId)
     若 runner 不存在 → 记录 runner_row_missing，跳过（不恢复、不终态化）

  2. 证据检查（见 6.4）
     若 dispatchState='running' 且证据不完整 → 记录 evidence_missing，
        判 MESSAGE_INTEGRITY_FAILED（Slice 2 需批准），结束
     若 dispatchState='start_sent' 且无 start 消息 → 同上

  3. live = liveRegistrations.get(runnerId)
     若 live 存在（在线）：
        a. 快照报告了该 id → dispatchReconcile，保持 running
        b. 快照未报告：
             createdAt >= connectedAt → 保持（竞态守卫，既有逻辑）
             dispatchState='start_sent' → 不判 RESTARTED；等 startAcceptDeadlineAt
             否则 → 判 RUNNER_RESTARTED
     若 live 不存在（离线）：
        a. dispatchState='created' 且 无任何握手消息 且 now > createdAt + PRE_START_GRACE
             → 判 EXECUTION_FAILED（原因 PRE_START_ABANDONED，仅写 failureReason）
        b. now > recoveryDeadlineAt（若有）→ RECOVERY_DEADLINE_EXCEEDED
        c. 否则保持 running（等重连 grace）

  4. 任何分支都不得：重新发送 execution.start、新建 Execution、删除 Execution/审计/消息
```

`PRE_START_GRACE` 的取值建议 `RECOVERY_OUTER_LIMIT_MS`（120s，`repository-handshake.service.ts:87`），
理由是它与 `recoveryDeadlineAt` 同量级，且不与 20s/30s 的 start 门禁冲突。**该常量属 Slice 2 决策**。

### 7.4 证据要求（每个状态转换的必需持久化证据）

| 转换 | 必需证据（数据库可验证） | 现状强度 | 缺口 |
| --- | --- | --- | --- |
| `INSERT → created` | 无（不声称证据） | — | — |
| `created → repository_preparing` | `execution.repository` 消息存在（T4） | E1（`created` 即可） | 消息可先于状态伪造插入 |
| `repository_preparing → repository_ready` | 上述 + `repositoryPreparedAt` + `repositoryPath`（T4） | E1 | 同上 |
| `repository_ready → start_sent` | 上述 + `execution.start` 消息 + `startSentAt` + `startAcceptDeadlineAt`（T4） | E0+E1 | E1 在建行阶段即成立 ⇒ `start_sent` 不证明"已发出" |
| `start_sent → running` | **应有 E3（acked）**；今天无任何强制 | **E0 only** | **R1/R2**（§5.9） |
| `running → terminal` | 完整终态元组 + `phase=status` + `endedAt`（T3） | 强 | — |
| `INSERT → running`（mock） | 无 runner（G3） | 强（采纳 G3 后） | — |
| `INSERT → terminal` | 完整元组（T1）+ 无 runner（G4） | 中（采纳 G4 后） | 无法区分"INSERT 的终态"与"UPDATE 的终态" |

**证据缺失的裁决映射（需 Slice 2 批准）**：
`running`/`start_sent` 声称已启动但缺少 start 消息或其 `sentAt`，语义是"持久化证据与状态自相矛盾"，
13 个冻结值中最贴合的是 **`MESSAGE_INTEGRITY_FAILED`**（其"判定点"此前未定义，本轮给出：
"执行声称已进入 `running`/`start_sent`，但缺少可验证的 `execution.start` 证据行"）。
**不得**新增枚举，也**不得**映射到 `RUNNER_RESTARTED`（那会把伪造记录说成"Runner 重启丢了它"）。

### 7.5 测试矩阵

见 §6.1（T1–T14）。冻结的验收条件：

1. 每条数据库拒绝用例必须断言错误文本 + 原行未变。
2. 每条扫描器用例必须断言"未产生终态写入"或"产生的裁决值 ∈ 13 个冻结值 + 写入身份合法"。
3. 任何用例都不得通过"放宽约束"来变绿；需要改的是用例形态（例如把 start 消息改成 `sent`）。

### 7.6 G3 最终判定

**`IMPLEMENTATION READY`**

含义与边界：

| 项 | 状态 |
| --- | --- |
| O-1（扫描器查询边界未定） | **CLOSED**：§4.2 / §7.3 给出唯一合法形态与判定树 |
| INSERT 约束设计 | **FROZEN**（G1–G4，§5.8） |
| UPDATE 证据约束 | R1 **FROZEN**；R2 **待 Slice 2 评审**（依赖写入顺序变更） |
| 验收矩阵 | **FROZEN**（§6.1） |
| 实现 | **未开始**（本轮只读） |
| **G3 关闭状态** | **NOT CLOSED** |

按本轮约束，**不得**因设计文档完成而把 G3 标为 CLOSED。G3 转 CLOSED 的条件是：
forward migration + `requiredTriggers` 登记 + 正反用例 + 扫描器实现 + §6.1 全绿。

### 7.7 对 Slice 2 Entry Gate 的影响

| 条件 | 变化 |
| --- | --- |
| O1（INSERT `running` 合法性） | OPEN → **CLOSED（设计层）** |
| O8（`INSERT OR REPLACE` 风险） | 仍 **PENDING PRODUCT OWNER APPROVAL**（阻断） |
| 实现未落地 | 仍阻断"G3 CLOSED" |

结论：Entry Gate 仍为 **CONDITIONAL GO**，阻断项从 2 个降为 1 个（O8），
但 Slice 2 的实现**必须**包含 §5.8 + §7.3，否则不得开工。

---

## 8. 本轮未做 / 下一轮最小修改方案（供批准，不自行实施）

| # | 动作 | 文件 | 规模 |
| --- | --- | --- | --- |
| 1 | 新增 forward migration：`Execution_dispatch_insert_guard`（G1–G4）+ 可选 R1 | `apps/api/prisma/migrations/2026xxxx_p2_02_wpd_execution_insert_guard/migration.sql` | ~35 行 SQL，`BEGIN IMMEDIATE … COMMIT` |
| 2 | 登记新触发器 | `apps/api/scripts/verify-migration-consistency.mjs:101-112` | +1 行 |
| 3 | 正反用例 | `apps/api/test/database-triggers.integration.spec.ts` | +8 用例；改 1 个既有用例（六态走查的 start 消息改 `sent`） |
| 4 | 扫描器（Slice 2） | 新文件 `apps/api/src/modules/executions/recovery-scanner.service.ts` | §7.3 判定树 |
| 5 | R2 的写入顺序调整（可选） | `repository-handshake.service.ts:1139-1153` | 交换 `markAcked` 与 `updateMany` |
| 6 | 运维约束登记 | `docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md` | 新增"删除 Runner 行前必须先终结其 running 执行" |

---

## 9. 交叉引用

- `docs/engineering/P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`（G3 原设计，本文修正其 §2.4 的查询计数并扩展 G4/R1/R2）
- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md`（§1.7 恢复扫描器、§3 六态表、§6 O1）
- `docs/engineering/P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`（G4，REPLACE 绕过路径；本文 T9 沿用其"不宣称触发器能拦"的结论）
- `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md`（13 裁决值、身份前缀、终态元组）
- `docs/execution-recovery.md`（§Runner reconnect、§API restart、§Mock executions are different）
- `docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md`（forward migration 纪律）
