# P2-02 WP-D Slice 2 范围与准入契约

状态：**草案，待 Slice 2 启动评审**
编制日期：2026-11-24
基线：`feature/p2-02-wpd-slice1-1-remediation` @ `fb664cc`
依据：`P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md`、`P2-02_WP-D_SLICE1_IMPLEMENTATION_REPORT.md`、
`P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md`、`docs/execution-recovery.md`、
`docs/phase-2-technical-roadmap.md`

> 本文只记录**设计基线中已经存在**的内容。凡是基线未定义的，一律标 `OPEN`，
> 不在此处代为决定。Slice 2 的实现不得超出本文第 1 节的范围。

---

## 0. 本文不是什么

- 不是 Slice 2 的实施计划（不含排期、任务拆分、代码设计）。
- 不是新的契约。13 个裁决值、六态状态机、终态元组不变量都以 L2 v1.1 为准，
  本文只是把它们**逐条摊开**，供 Slice 2 对照。
- 不是风险接受书。`INSERT OR REPLACE` 的风险见
  `P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`（状态：PENDING PRODUCT OWNER APPROVAL）。

---

## 1. Slice 2 功能范围

Slice 1 结束时，数据库契约已冻结，但**没有任何 Slice 2 业务逻辑被提前实现**
（实施报告 §11）。以下 8 项是 Slice 2 的全部范围，逐项给出「基线依据 / 已冻结 /
待实现」。

### 1.1 Runner 恢复

- **基线依据**：`docs/execution-recovery.md` §"Runner restart and durable recovery"
  （journal、NDJSON spool、startup scan、shutdown）。
- **已冻结**：`Execution.dispatchState` 六态、`recoveryDeadlineAt`（只能收紧）、
  13 个终态裁决值中的 `RUNNER_INTERRUPTED`。
- **待实现**：把 runner 侧 `RUNNER_INTERRUPTED` 报告映射为**终态裁决**
  `RUNNER_INTERRUPTED`（今天只写 `failureReason`，裁决落到 `EXECUTION_FAILED`，
  见 `apps/api/src/modules/executions/execution-terminal.ts:98-107` 的显式注释
  「pre-start matrix 是 Slice 2 工作，不得在此猜测」）。
- **不在范围**：runner 侧 journal/spool 的格式与实现（Slice 0/0.2 已完成）。

### 1.2 API 重启后的执行续跑

- **基线依据**：`docs/execution-recovery.md` §"API restart"。
- **已冻结**：`terminalDecidedBy` 的 `API:reconciler` / `API:recovery-scanner`
  两个预留身份（`packages/contracts/src/constants.ts:113,115`）。
- **待实现**：重启后对「上次进程留下的 running 行」的判定与裁决。
- **硬约束**：`docs/execution-recovery.md:105` —— **API 永不自动重新派发**。
  「续跑」在这里的含义是「把状态判定清楚」，不是「重新启动执行」。

### 1.3 `execution.reconcile`

- **基线依据**：`docs/execution-recovery.md` §"Runner reconnect and snapshot
  reconciliation"；协议消息类型已存在（`packages/contracts/src/runner-protocol.ts:452,477`）。
- **已冻结**：快照对账的三分支（runner 多报 / 服务端多出 / 双方都有）与
  `execution.createdAt >= runner.connectedAt` 的竞态保护。
- **待实现**：`execution.reconcile` 的**服务端裁决语义**——今天 runner 只记录该消息
  并继续本地会话，快照才是权威所有权信号（`docs/execution-recovery.md:90-91`）。
- **不在范围**：改动快照协议本身。

### 1.4 `execution.terminal`

- **基线依据**：协议类型已定义（`runner-protocol.ts:702,722`），
  `TERMINAL_OUTCOMES` / `LOG_COLLECTION_STATUSES` 常量已冻结
  （`constants.ts:197-206`）。
- **已冻结**：终态只能由 `writeTerminalDecision`（`execution-terminal.ts`）写入；
  条件更新 `status='running' AND terminalDecision IS NULL`，先写者胜。
- **待实现**：API 侧的 `execution.terminal` 入站处理——当前 API **没有**该消息的
  处理器（`apps/api/src/modules/runners/` 中无 `execution.terminal` 分支）。
- **不在范围**：新增裁决值。若某个 terminal 事件无法映射到 13 个值之一，
  必须拒绝并记录，**不得**临时新增枚举。

### 1.5 `logCollection` barrier

- **基线依据**：`LOG_COLLECTION_STATUSES`（complete / incomplete）、
  `LOG_INTEGRITY_STATUSES`（unknown / complete / incomplete / legacy_inferred）
  已冻结（`constants.ts:201-215`），注释明确「terminal 消息缺省时必须记 unknown，
  永不得默认为 complete」。
- **已冻结**：仅**词汇表**。
- **待实现**：barrier 状态机与其持久化。
- **重要边界**：**数据库当前没有 `logBarrierState` / `logIntegrity` 列**
  （`apps/api/prisma/schema.prisma` 的 `Execution` 模型无此字段）。因此 barrier 的
  持久化属于**新的 schema 变更**，必须走 forward migration，且不在 Slice 1 已冻结的
  契约范围内。Slice 2 不得假定这些列存在。
- **不在范围**：`P2-09` 的完整日志持久性（spool 上限、ACK 重放、跨实例 seq）。

### 1.6 ack deadline

- **基线依据**：实施报告 §4.4 —— `startSentAt → startAcceptDeadlineAt` 为 +20s
  （`startAcceptDeadlineAt` 写一次即冻结）；`recoveryDeadlineAt = startSentAt + 120s`
  （`RECOVERY_OUTER_LIMIT_MS`，`repository-handshake.service.ts:87,1013`）；
  ack deadline 的设计值为 `min(startSentAt + 120s, tAck + 30s)`。
- **已冻结**：两个截止时间列 + T5 的「只能收紧」。
- **待实现**：`min(...)` 的**运行时判定与推进**（实施报告 §11 明确列为本切片未实现）。
- **不在范围**：修改 20s / 120s 常量。

### 1.7 恢复扫描器

- **基线依据**：`docs/execution-recovery.md` §"Startup scan"（runner 侧扫描）与
  §"API restart"（API 侧重启对账）。
- **已冻结**：预留身份 `API:recovery-scanner`。
- **待实现**：API 侧的周期性/启动期扫描，把「无法确认归属的中间态行」收敛到终态。
- **已知边界（必须保留）**：现有对账查询一律带 `runnerId` 过滤
  （`runner-registry.service.ts:531-534`、`842-849`），
  `docs/execution-recovery.md:110-114` 明确「启动对账只处理 `runnerId` 非空的行」，
  因此 **mock 执行（`runnerId IS NULL`）不在任何现有恢复路径的视野内**。
  扫描器若改成全局查询，会第一次把 mock 行纳入恢复范围——这是
  `P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`（G3）的 OPEN 项，不得在本轮或
  Slice 2 实现时悄悄跨过。

### 1.8 多实例协调

- **基线依据**：路线图 TD-06（`max(seq)+1` 非原子）、TD-14（reconcile 不是完整状态机
  对账）、TD-28（ACK 与游标未分离），均指向「单实例假设被锁掩盖」。
- **已冻结**：数据库层的条件更新（先写者胜）、`execution.start` 的 Partial Unique Index、
  注册 epoch 单调。
- **待实现**：跨实例的互斥/租约。**基线尚未给出具体机制**——本项为 `OPEN`，
  不得由实现者自行发明后再补文档。

---

## 2. 13 个终态裁决值

来源：`P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md` §1（集合冻结）与 §4（身份冻结）。
**不得新增、不得改名、不得改映射。**

下表「已实现的写入身份」只记录**当前代码中真实存在的调用点**；
「待定」表示基线只冻结了值，没有给出该值的证据与写入方——属于 Slice 2 必须补齐的内容。

| # | terminalDecision | status | 已实现的写入身份 | 必需证据 | 对应状态转换 | 测试要求 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `COMPLETED` | `completed` | `API:mock-runtime`（`executions.service.ts:986`）、`API:terminal-event`（同处非 mock 分支）、`MIGRATION:wp-d-backfill`（迁移回填） | 运行时终态事件，或迁移回填自既有 `completed` 行 | `running → completed`，`dispatchState → terminal` | T3 正向；decision 与 status 不匹配时 T1/T3 ABORT |
| 2 | `CANCELLED_CONFIRMED` | `cancelled` | `API:operator`（`executions.service.ts:596`，mock 取消 / `safeToFinalize`）、`API:mock-runtime`、`API:terminal-event` | 进程树已确认终止，或该执行从未 spawn 进程（`repository-handshake.service.ts:254-256`） | `running → cancelled`，`dispatchState → terminal` | 同上；无终止证据时不得写 |
| 3 | `EXECUTION_FAILED` | `failed` | `API:mock-runtime` / `API:terminal-event` / `API:start-gate`（兜底）/ `MIGRATION:wp-d-backfill` | CLI 非零退出等运行时失败；启动门禁未匹配到更具体的值时兜底 | `running → failed` | 同上 |
| 4 | `START_REJECTED` | `failed` | **未实现** | 基线仅描述「executor rejection」（`docs/execution-recovery.md:31-32`），未给出裁决口径 → 待定 | `running → failed`（发生在 `execution.start` 之前） | T1/T3 映射合法；语义用例由 Slice 2 补 |
| 5 | `START_ACCEPT_TIMEOUT` | `failed` | `API:start-gate`（`execution-terminal.ts:100-101`） | 20s 接受窗口超时（`startAcceptDeadlineAt`，`docs/execution-recovery.md:44`） | `running → failed`（`start_sent` 之后） | 已有正向用例；补「超时后仍不得重发 start」 |
| 6 | `START_SEND_UNCONFIRMED` | `failed` | **未实现** | 基线只有名字，无证据定义 → 待定 | `running → failed`（`start_sent` 之后） | 同 #4 |
| 7 | `RUNNER_DISCONNECTED` | `failed` | **未实现**（今天写 `failureReason='RUNNER_DISCONNECTED'`，裁决落 `EXECUTION_FAILED`，`runner-registry.service.ts:959`） | 重连 grace 窗口耗尽（`docs/execution-recovery.md:53-56`） | `running → failed` | 必须区分「reason 码」与「裁决值」，反向用例断言二者不可互换 |
| 8 | `RUNNER_RESTARTED` | `failed` | **未实现**（同上，`runner-registry.service.ts:913`） | 快照缺失 + `createdAt < connectedAt` 守卫（`docs/execution-recovery.md:76-88`） | `running → failed` | 含 `start_sent` 不得被判为 RESTARTED 的反向用例（`runner-registry.service.ts:890-892`） |
| 9 | `RUNNER_INTERRUPTED` | `failed` | **未实现** | runner 启动扫描的 journal 证据（`docs/execution-recovery.md:169-194`） | `running → failed` | 报告必须在快照之前到达（`docs:190-194`） |
| 10 | `RUNNER_START_UNCONFIRMED` | `failed` | `API:start-gate`（`execution-terminal.ts:102-103`） | `start_sent` 后 30s 无 ack；WP-D 拥有该 grace（`runner-registry.service.ts:890-892`） | `running → failed` | 正向 + 「grace 内不得裁决」反向 |
| 11 | `RECOVERY_DEADLINE_EXCEEDED` | `failed` | **未实现** | `recoveryDeadlineAt` 已过（`startSentAt + 120s`，实施报告 §4.4） | `running → failed` | 边界：deadline 只能收紧，T5 反向用例已存在 |
| 12 | `MESSAGE_INTEGRITY_FAILED` | `failed` | **未实现** | 基线只有名字；T7/T8 校验的是消息形状与哈希格式，未定义「完整性失败」的判定点 → 待定 | `running → failed` | 同 #4；必须先定义判定点 |
| 13 | `CLOCK_ANOMALY` | `failed` | **未实现** | 基线只有名字 → 待定（与 `startSentAt` / `startAcceptDeadlineAt` / `recoveryDeadlineAt` 的时钟关系有关，但未定义判据） | `running → failed` | 同 #4 |

补充规则（来自基线，不是本文新增）：

- `terminalDecidedBy` 只允许 `API:` / `MIGRATION:` 两个前缀，且只允许 7 个既定身份；
  Runner 身份（`rn_*`、`runner:*`）一律非法。
- 终态元组三列全空或全非空；`terminalDecidedAt` 必须是**正整数 Unix 毫秒**。
- 终态行的 `status` / `phase` / `dispatchState` / 终态元组 / `endedAt` / `exitCode` 不可修改。

---

## 3. 六态状态机

来源：Migration T4 `Execution_dispatch_transition_guard`（`migration.sql:314-366`）与
T5 `Execution_start_clock_guard`（`:370-389`）。**六态之外没有第七个状态。**

| 状态 | 合法前驱 | 合法后继 | 必须具备的证据（数据库强制） | 是否允许恢复流程裁决 | 是否允许重新启动 Runner / 重新执行 |
| --- | --- | --- | --- | --- | --- |
| `created` | INSERT（唯一入口）；无 UPDATE 前驱 | `repository_preparing`、`terminal` | 无额外证据要求 | 允许：可因操作员取消意图 + 无 pending 直接终态化（`repository-handshake.service.ts:254-256` 的 `safeToFinalize`） | 不允许重跑。取消后如需继续，必须新建一次执行 |
| `repository_preparing` | `created` | `repository_ready`、`terminal` | 必须存在该执行的 `execution.repository` 消息（status ∈ created/sent/acked） | **基线未定义** → `OPEN`。注意：握手的 pending 是进程内 Map，API 重启后不存在，恢复流程不得假设可继续推进 | 不允许 |
| `repository_ready` | `repository_preparing` | `start_sent`、`terminal` | 上述消息 + `repositoryPreparedAt` + `repositoryPath` | 同上 `OPEN` | 不允许 |
| `start_sent` | `repository_ready` | `running`、`terminal` | 上述 + `startSentAt` + `startAcceptDeadlineAt` + 持久化的 `execution.start` 消息 | 允许：30s grace 后判 `RUNNER_START_UNCONFIRMED`；**不得**判 `RUNNER_RESTARTED`（`runner-registry.service.ts:890-892`） | 不允许重发 start（Partial Unique Index + 条件更新 + T5 三重保证） |
| `running` | `start_sent` | `terminal` | **数据库无证据要求**（这是 G3 的缺口，见下文） | 允许：靠 runner 快照对账 / 断连 grace / 恢复扫描收敛到终态 | 不允许重新派发（`docs/execution-recovery.md:105`） |
| `terminal` | `created` / `repository_preparing` / `repository_ready` / `start_sent` / `running` | **无** | 完整终态元组（T1/T3） | 不允许：T2 拒绝任何改写 | 不允许 |

两条附加约束（T4）：

1. 除 `terminal` 外，`dispatchState` 只能在 `status = 'running'` 时推进。
2. 六态之间不得越级、不得回退、不得停留在未定义值。

> **G3 缺口**：`running` 是唯一「进入时不需要任何数据库证据」的状态。
> 数据库无法区分「握手完成后合法进入的 running」与「直接 INSERT 出来的 running」。
> 技术设计与未决问题见 `P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`。

---

## 4. Legacy `cancelled` 行

### 4.1 现状（事实）

Slice 1 迁移对历史 `cancelled` 行只做了 `dispatchState = 'terminal'`，
`terminalDecision` 保持 `NULL`（`migration.sql:150-157`）。理由：数据库不持有
「进程终止已确认」的证据，回填等于伪造（基线 §3 末段）。

查询这类行的唯一正确方式：

```sql
SELECT id FROM "Execution" WHERE status = 'cancelled' AND terminalDecision IS NULL;
```

### 4.2 Slice 2 不能用普通更新补写（三层拒绝，逐层可验证）

| 层 | 位置 | 为什么拒绝 |
| --- | --- | --- |
| 数据库 T2 | `migration.sql:229-243` | 触发条件为 `OLD.status IN ('completed','failed','cancelled')`，`cancelled` 行一旦被 UPDATE 改动终态元组即 `RAISE(ABORT)` |
| 数据库 T3 | `migration.sql:249-310` | 只对 `OLD.status = 'running'` 生效，`cancelled` 行根本不进入该分支 |
| 应用层 | `execution-terminal.ts:53-59` | 条件更新要求 `status: 'running'`，对 `cancelled` 行 `count = 0`，函数返回 `false` |

结论：**旧 `cancelled` 行的终态元组在现有契约下不可补写。** 这不是实现遗漏，
是冻结契约的必然结果。

### 4.3 因此 Slice 2 的正确立场

1. **不得**修改数据库现有记录（T2 会拒绝，且绕过 T2 等于破坏审计）。
2. **不得**放宽 T2 去容纳「给历史行补写裁决」——那会把「不可伪造证据」这条不变量
   变成「可伪造」。
3. 允许的处理方式只有三种，且都需要产品/架构决策，不是实现者自选：
   - **(a) 保持现状**：这些行永久以 `terminalDecision IS NULL` 存在，作为「历史证据
     不足」的显式记录；查询方必须能处理 NULL。
   - **(b) 新增 forward migration**：为这类行写一个**明确的、不声称证据的**标注
     （例如新增一个独立的「历史缺口」列或审计行），而不是往终态元组里塞值。
   - **(c) 人工流程**：由操作员按 `docs/execution-recovery.md` §"Manual recovery
     playbook" 处理业务影响，数据库层保持不变。
4. Slice 2 的恢复矩阵**必须显式包含**「`status='cancelled' AND terminalDecision IS NULL`」
   这一分支，并明确它的判定结果（例如「不参与恢复裁决」），不得让它落进任何
   `default` 分支被自动处理。

### 4.4 实施报告 §3.2 的修订

原文（`P2-02_WP-D_SLICE1_IMPLEMENTATION_REPORT.md` §3.2 第 3 条）写的是
「…`terminalDecision` 保持 `NULL`，留给 Slice 2 的恢复判定或人工处理」。
这句话与冻结契约冲突：T2 不允许对终态行补写裁决，所以 Slice 2 的「恢复判定」
根本没有可写入的路径。该句已在本轮修订为与契约一致的表述（只允许查询、不允许补写）。
修订只改这一句，不改任何结论与数据。

---

## 5. Slice 2 不允许突破的边界

1. **不得绕过数据库触发器。**
   任何 `PRAGMA` 级别的开关、`INSERT OR REPLACE`、手工 `DROP TRIGGER`、
   或在应用层「先校验再跳过 Trigger」的写法，都视为破坏执法层。
   `INSERT OR REPLACE` 的具体风险与工程约束见
   `P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`。

2. **不得重复启动已确认运行的 Runner 执行。**
   `execution.start` 的 at-most-once 由三层保证（Partial Unique Index、条件更新
   `startSentAt: null`、T5）。Slice 2 的任何恢复路径都**不得**成为重放源
   （实施报告 §4.3：「持久化 start 只用于审计，不是重放源」）。

3. **不得基于缺少证据的 running 状态做恢复决策。**
   见到 `dispatchState='running'` 不等于「进程在跑」。裁决前必须能回答：
   该行的 `runnerId` 是谁、runner 是否在线、快照是否报告了它、
   `recoveryDeadlineAt` 是否已过。答不上来就只能 fail-closed（保持 `running` 并记录
   未决），不得猜。

4. **不得修改已经冻结的终态元组。**
   包括「补写」「纠正」「统一格式」等一切名义。唯一例外是迁移层的回填，
   且回填只允许在**没有 Trigger 之前**对 `completed` / `failed` 做确定性推导
   （Slice 1 已完成，Slice 2 不得再做第二次回填）。

5. **不得通过恢复过程破坏审计记录。**
   `ExecutionRegistrationAudit` 是 append-only（T10），行只随 `Execution` 级联删除。
   恢复流程不得为了「让状态看起来干净」而删除执行行、审计行或握手消息。
   删除执行行会连带删除审计——这本身就是破坏证据。

---

## 6. 未决事项（Slice 2 启动前必须收敛或明确接受）

| # | 事项 | 影响 | 归属 |
| --- | --- | --- | --- |
| O1 | 直接 INSERT `running` 行的合法性判定（mock 兼容 vs 真实 Runner 可信度） | 决定恢复矩阵能否信任 `running` | G3 设计，**OPEN** |
| O2 | 8 个未实现裁决值（#4、#6、#7、#8、#9、#11、#12、#13）的「证据 + 裁决时的 dispatchState」 | 决定恢复矩阵的完整性 | Slice 2 评审 |
| O3 | `repository_preparing` / `repository_ready` 在 API 重启后的判定 | 决定是否会出现永久悬挂的中间态 | Slice 2 评审 |
| O4 | `logCollection` barrier 的持久化 schema（当前**无列**） | 需要新的 forward migration | P2-09 / Slice 2 |
| O5 | 多实例协调的具体机制（基线未定义） | 决定能否水平扩展 | P2-11 / P2-12 |
| O6 | Linux 全量测试未执行（`NOT_VERIFIED`，Slice 1.1 报告 §8.1） | 不得声明 Linux 全绿 | Slice 2 开始时补齐 |
| O7 | `apps/runner` R19 既有失败（依赖真实 PID） | 会干扰恢复路径的测试信号 | 触碰 recovery 时一并修（实施报告 §8.2） |
| O8 | `INSERT OR REPLACE` 风险接受 | 阻断性合规项，需产品负责人签字 | G4，PENDING |

---

## 7. 准入判定

**当前 Slice 2 Entry Gate：仍为 `CONDITIONAL GO`。**

理由（与本轮交付的对应关系）：

| 条件 | 本轮状态 |
| --- | --- |
| 文档级收尾（运维手册、范围契约、风险草案、清理清单） | 本轮补齐，见 §8 交叉引用 |
| Slice 1 契约与代码一致 | 已一致；本轮仅修正实施报告 §3.2 的一句冲突表述 |
| `INSERT` 中间态约束 | **OPEN**（G3 未完成，见 `P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`） |
| `INSERT OR REPLACE` 风险 | **PENDING PRODUCT OWNER APPROVAL** |
| 数据库 checksum 现场 | 已清点，**清理未执行**（G1） |
| 共享/生产环境状态 | **UNVERIFIED** |

即：文档侧的进入条件已满足，**代码/数据库侧的 2 个阻断项（O1、O8）仍未关闭**，
因此不能升级为 `GO`。

---

## 8. 交叉引用

- `docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md`（G2，迁移运维口径）
- `docs/operations/WP-D_SLICE1_DATABASE_CLEANUP_INVENTORY.md`（G1，数据库清单）
- `docs/engineering/P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`（G3，INSERT 约束设计）
- `docs/engineering/P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`（G4，REPLACE 风险接受）
- `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md`（冻结契约）
- `docs/execution-recovery.md`（恢复行为设计基线）
