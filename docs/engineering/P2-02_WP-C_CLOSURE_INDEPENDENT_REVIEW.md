# P2-02 WP-C 关闭复审报告（独立复审）

- 复审对象：`fd7852bb2ec46ec553b79cc6007a5beec2000d7b..d8594a1cb474ffcdeb68f6e701fa6975d8fc9850`
- 复审上下文：`1da8a07`（`docs(p2-02): document WP-C closure remediation`）
- 复审日期：2026-11-11
- 复审工作树：`D:\CODE\GIT\Haft-p2-02-wpc-closure-review`（detached HEAD `1da8a07`）
- 复审性质：独立、只读；未修改任何产品代码、测试、迁移、roadmap 或既有报告
- 本报告唯一新增文件：`docs/engineering/P2-02_WP-C_CLOSURE_INDEPENDENT_REVIEW.md`

---

## 1. 结论摘要

**WP-C 关闭复审结论：PASS WITH WARNINGS。**

F1、F2、F3 三项原阻塞性 Finding 已在代码与测试层面闭环；F4、F5 已加固，但仍留有 P3 级残余风险；另发现 5 项新的 P3 级问题或残余风险。**没有发现新的 P0/P1/P2，也没有发现任何仍可复现的“取消后仍发送 start / 仍 spawn CLI”或“missing CLI accepted-then-failed”路径。**

因此：

- **WP-C 可以验收为 PASS WITH WARNINGS**；
- **WP-D 可以开始**，原 F1、F3 对 WP-D 的阻塞已解除；
- R1–R5 均不阻塞 WP-D 开工，但建议在 WP-D 的取消/恢复矩阵和生产加固中跟踪，尤其是 R1（取消与已完成终态的排序）和 R2/R3（Runner 进程内簿记增长）。

### 1.1 原 Finding 关闭状态

| ID  | 原级别 | 原结论             | 本次复审结论                      | WP-C 阻塞 | WP-D 阻塞 |
| --- | ------ | ------------------ | --------------------------------- | --------- | --------- |
| F1  | P1     | FAIL               | **CLOSED / PASS**                 | 否        | 否        |
| F2  | P2     | FAIL               | **CLOSED / PASS**                 | 否        | 否        |
| F3  | P2     | FAIL               | **CLOSED / PASS**                 | 否        | 否        |
| F4  | P3     | PASS WITH WARNINGS | **PASS WITH WARNINGS（残余 R4）** | 否        | 否        |
| F5  | P3     | PASS WITH WARNINGS | **CLOSED / PASS（相邻残余 R3）**  | 否        | 否        |

### 1.2 本次新发现/残余风险

| ID  | 级别 | 摘要                                                            | 复现等级 | 阻塞 |
| --- | ---- | --------------------------------------------------------------- | -------- | ---- |
| R1  | P3   | 完成终态与取消终态在 Runner finalize 窗口内可能乱序             | 代码路径 | 否   |
| R2  | P3   | 取消/上下文失效发生在 live admission 期间时，admission 缓存泄漏 | 代码路径 | 否   |
| R3  | P3   | `cancelled` / `generations` 簿记 map 永不清理，随执行数增长     | 代码路径 | 否   |
| R4  | P3   | F4 的 feature 复核与 DB 提交之间仍有单次 await 窗口             | 代码路径 | 否   |
| R5  | P3   | F2 的 live auth probe 最坏可超过 20s start 接受预算             | 代码路径 | 否   |
| O-1 | 观察 | `matches`/fingerprint 仍比较配置路径，未比较 canonicalPath      | 代码路径 | 否   |

> 复现等级定义见第 3 节。R1–R5 均为代码路径确认、未保留运行时探针；O-1 为原审查已记录的非阻塞观察，本次复核其修复范围仍限于大小写/分隔符归一化。

---

## 2. 审查基线、范围与只读约束

### 2.1 提交与工作树

| 项目        | 值                                                             |
| ----------- | -------------------------------------------------------------- |
| 基线 diff   | `fd7852b..d8594a1`                                             |
| 上下文 HEAD | `1da8a07`                                                      |
| 复审工作树  | `D:\CODE\GIT\Haft-p2-02-wpc-closure-review`                    |
| 工作树状态  | detached HEAD `1da8a07`，复审开始时 `git status --short` 为空  |
| 远端分支    | `origin/feature/p2-02-project-aware-runner` 指向 `1da8a07`     |
| 主工作树    | `D:\CODE\GIT\Haft-p2-02`，`feature/p2-02-project-aware-runner` |

### 2.2 变更面

`git diff --stat fd7852b..d8594a1` 显示 13 个文件、1805 insertions、252 deletions：

- API：`executions.service.ts`、`repository-handshake.service.ts`、`repository-errors.ts`、`runtime-registry.service.ts`；
- API 测试：`runner.integration.spec.ts`；
- Prisma：`schema.prisma`、新增 `20261111130000_p2_02_execution_cancel_intent/migration.sql`；
- Runner：`executor.ts`、`fake-executor.ts`、`real-executor.ts`、`repository-context.ts`、`runner-client.ts`；
- Runner 测试：`repository-handshake.spec.ts`。

`git show --stat 1da8a07` 只包含修复报告 `P2-02_WP-C_CLOSURE_REMEDIATION_REPORT.md`。未发现契约包（`packages/contracts`）改动，未发现对既有独立审查报告的覆盖。

### 2.3 范围

本次复审覆盖：

1. F1：API 持久化取消意图、握手锁与检查点、Runner 取消生命周期、A–G 时序；
2. F2：accepted 前 live CLI admission；
3. F3：并发 repository 幂等、重复 ACK、contextId 一致性；
4. F4：创建事务内 live feature 检查；
5. F5：`starting` TTL 与 admission 异常释放；
6. 全部质量门禁；
7. Migration 的空库、既有库、重复 deploy、`integrity_check` / `foreign_key_check`。

### 2.4 明确不在本次范围

- **WP-D**：恢复扫描、重连矩阵、离线重放、恢复期取消矩阵均未实现，也未在本次验收；
- **多 API 实例**：按实施计划 Q5（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:2704`）属于 Phase 3+，进程内锁与 pending map 不跨实例；本次只按单 API 实例评审；
- **真实 CLI E2E**：本机未提供可用的真实 CLI/auth 组合，未运行 opt-in real E2E；F2 的 live admission 通过注入式 Runner 测试验证；
- **产品代码自动修复**：本次只读，不修复任何 Finding。

### 2.5 只读约束

- 复审期间未修改工作树中的产品代码、测试、迁移或既有文档；
- 未 rebase、未 force push、未创建 PR、未修改 `main`；
- 临时迁移探针与 SQLite 数据库均位于仓库外临时目录；
- 本报告是唯一新增文件，提交信息为 `docs(p2-02): add WP-C closure independent review`。

---

## 3. 证据分级与判定口径

### 3.1 证据等级

| 等级         | 含义                                                            |
| ------------ | --------------------------------------------------------------- |
| **已复现**   | 本次实际运行测试、门禁或迁移探针，并记录到可核对的输出          |
| **代码路径** | 静态阅读确认控制流、条件与状态迁移可到达；未保留运行时探针      |
| **推测**     | 仅凭接口/注释推断，缺少可执行路径或关键条件；本报告未使用该等级 |

### 3.2 严重级别

沿用原独立审查的定义：

- **P0**：数据损坏、安全绕过、不可恢复的错误启动；
- **P1**：违反冻结不变量，可能 spawn 错误进程或产生不可信终态；
- **P2**：违反退出标准/幂等要求，需要修复后才能验收；
- **P3**：窄竞态、资源泄漏或可维护性风险，不改变主路径正确性。

### 3.3 判定口径

- **PASS**：原 Finding 的触发路径已关闭，回归测试覆盖关键断言，门禁与迁移全部通过；
- **PASS WITH WARNINGS**：不存在 P0/P1/P2；仍有 P3 级窄竞态、资源泄漏或文档化残余风险；
- **FAIL**：仍存在 P0/P1/P2，或门禁/迁移失败。

本次结论为 PASS WITH WARNINGS，原因见第 13 节。

---

## 4. 变更面与冻结边界复核

### 4.1 冻结边界

| 边界                         | 结论 | 证据                                                                                       |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `RUNNER_PROTOCOL_VERSION`    | 未改 | `packages/contracts` 无 diff                                                               |
| `execution.start` v1 schema  | 未改 | 无契约字段变化                                                                             |
| 六种 `dispatchState`         | 未改 | 仍为 `created`/`repository_preparing`/`repository_ready`/`start_sent`/`running`/`terminal` |
| 既有错误码                   | 未改 | 复用 `REPOSITORY_CONTEXT_NOT_READY` 等；新增的是内部异常类，不是协议码                     |
| WP-A / WP-B 契约             | 未改 | 无绑定 DTO 或校验协议变化                                                                  |
| Mock Runtime 语义            | 未改 | mock 路径不进入 Runner 握手                                                                |
| worktree / recovery 隔离     | 未改 | `real-executor` 的隔离逻辑未改变语义                                                       |
| `cancelRequestedAt` 公开暴露 | 否   | 仅在 API 内部 select/update；`packages/contracts` 与 Execution DTO 均无该字段              |

### 4.2 Schema 与迁移

- `Execution.cancelRequestedAt DateTime?` 为可空字段，无默认值、无回填；
- 迁移 `20261111130000_p2_02_execution_cancel_intent/migration.sql` 只有一条 `ALTER TABLE "Execution" ADD COLUMN "cancelRequestedAt" DATETIME;`；
- 该字段表达“操作员取消意图”，不替代 `dispatchState`，也不改变公开状态机；
- 迁移顺序位于 P2-02 repository handshake 迁移之后，时间戳单调递增。

### 4.3 变更面判断

变更集中在 WP-C 的取消、admission 与 feature gate，没有扩散到 WP-A/WP-B、Mock Runtime、契约包或 UI。变更面与修复报告一致。

---

## 5. 质量门禁与测试结果

### 5.1 运行环境

- 操作系统：Windows / PowerShell；
- Node：`v24.14.0`；
- pnpm workspace：5 个项目；
- 独立工作树初始没有 `node_modules` 与 Prisma Client；
- 先执行 `pnpm install --offline --frozen-lockfile`，再执行 `pnpm --filter @raft-lite/contracts build`；
- 首次 API 测试因独立工作树未生成 Prisma Client 而失败；执行 `pnpm --filter @raft-lite/api exec prisma generate` 后复跑通过。该失败属于复审环境准备问题，不归因于产品代码。

### 5.2 测试套件

| 套件      | 命令                                      | 测试文件 | 测试数  | 结果     |
| --------- | ----------------------------------------- | -------- | ------- | -------- |
| Contracts | `pnpm --filter @raft-lite/contracts test` | 5        | 109     | PASS     |
| API       | `pnpm --filter @raft-lite/api test`       | 6        | 76      | PASS     |
| Runner    | `pnpm --filter @raft-lite/runner test`    | 16       | 138     | PASS     |
| Web       | `pnpm --filter @raft-lite/web test`       | 11       | 41      | PASS     |
| **合计**  |                                           | **38**   | **364** | **PASS** |

以上计数与修复报告 §14.1 的声明一致，但本次为独立复跑结果，不引用其结论。

### 5.3 质量门禁

| 门禁     | 命令                | 结果                                                                                                                                                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查 | `pnpm typecheck`    | contracts、api、runner、web 全部通过                                                                                                                                                                    |
| Lint     | `pnpm lint`         | `eslint . --max-warnings=0` 通过，0 error / 0 warning                                                                                                                                                   |
| 格式     | `pnpm format:check` | `format:check passed (changed files are Prettier-clean).`；输出 `50 unformatted file(s); 76 are grandfathered legacy debt.`，即 50 个未格式化文件全部属于基线中的 76 个历史债务文件，本次变更文件无回归 |

### 5.4 测试有效性抽查

本次没有只看“测试数量”，而是抽查了关键断言是否真实覆盖时序：

- **F1 A–G**：使用 `deferred`、真实 `policy.validate` gate、`canAdmit` gate，断言 envelope 顺序/数量、context 是否写回、`executor.start` 调用次数；
- **F2**：注入 `resolveExecutable` 返回 null、`probeAuthentication` 返回未认证，断言 `execution.start.rejected`、`accepted=0`、`spawn=0`；missing CLI 还断言 auth probe 未被调用；
- **F3**：用 gate 让两次 `prepare` 并发进入，断言 `policy.validate` 只调用一次、两个等待者拿到同一 `contextId`；另有冲突与取消测试；
- **F4**：spy `getAvailability`，在 availability 预检后、创建事务前让同一 `runnerId` 重新注册并丢失 feature，断言 409、`Execution` 行数为 0、Task/Agent 不变；
- **F5**：让 `executor.canAdmit` 抛错，断言 context 被释放；把 `starting` 时间推进 61 秒，断言 sweep 清理；
- **API F1/F3**：通过真实 Socket.IO 收发、数据库状态、审计事件计数和 outbound 消息类型断言，不是纯 mock。

### 5.5 未运行的验证

- 真实 CLI E2E（`pnpm test:e2e:real`）未运行：本机没有可用的真实 CLI/auth 组合；
- 多 API 实例并发未运行：按计划 Q5 超出 WP-C 范围；
- WP-D 恢复/重连矩阵未运行：尚未实现。

这些未运行项不改变本次对 WP-C 关闭面的结论，但在第 15 节作为边界记录。

---

## 6. Prisma Schema 与 Migration 验证

### 6.1 方法与位置

所有迁移探针使用仓库外临时 SQLite 数据库与临时 schema/migrations 副本，未触碰开发数据库：

- `C:\Users\A11720\AppData\Local\Temp\haft-wpc2-migprobe2-20261111145726`
- `C:\Users\A11720\AppData\Local\Temp\haft-wpc2-migprobe4-20261111154239`

做法：

1. 复制 `schema.prisma` 与除最后一条 `20261111130000_p2_02_execution_cancel_intent` 外的全部 migrations，构造“既有库”；
2. 先 deploy 前 5 条迁移；
3. 写入探针表 `_probe_data` 与一组合法的 Workspace/Project/Agent/Task/Execution 旧数据（`exec_probe`）；
4. 加入最后一条迁移并再次 deploy；
5. 用 `node:sqlite` 检查 `pragma_table_info`、`PRAGMA integrity_check`、`PRAGMA foreign_key_check` 与旧数据；
6. 再次 deploy 验证幂等；
7. 用 `prisma migrate diff --from-url ... --to-schema-datamodel ... --exit-code` 验证无 schema 漂移；
8. 另建全新数据库，从零 deploy 全部 6 条迁移并重复上述检查。

### 6.2 空库（fresh）

| 检查项                     | 结果                                       |
| -------------------------- | ------------------------------------------ |
| 应用迁移数                 | 6 / 6                                      |
| `cancelRequestedAt` 列     | `DATETIME`，`notnull=0`，`dflt_value=null` |
| `dispatchState` 列         | `TEXT`，`notnull=1`，默认 `'created'`      |
| `PRAGMA integrity_check`   | `ok`                                       |
| `PRAGMA foreign_key_check` | 空结果                                     |
| 重复 deploy                | `No pending migrations to apply.`          |
| `migrate diff --exit-code` | 0，`No difference detected.`               |

### 6.3 既有库升级（5 → 6）

| 检查项                         | 升级前                   | 升级后                                       |
| ------------------------------ | ------------------------ | -------------------------------------------- |
| 已完成迁移数                   | 5                        | 6                                            |
| `cancelRequestedAt`            | 不存在                   | `DATETIME`，`notnull=0`，`dflt_value=null`   |
| 探针表 `_probe_data` 行        | `{id:1, note:"keep-me"}` | 保持                                         |
| 旧 `Execution` 行 `exec_probe` | `running / created`      | `running / created / cancelRequestedAt=null` |
| `PRAGMA integrity_check`       | `ok`                     | `ok`                                         |
| `PRAGMA foreign_key_check`     | 空                       | 空                                           |
| 重复 deploy                    | —                        | `No pending migrations to apply.`            |
| `migrate diff --exit-code`     | —                        | 0，`No difference detected.`                 |

> `migrate diff` 前已将探针表 `_probe_data` 删除；旧 `Execution` 行保留，用于证明迁移不会重建表或丢失历史数据。

### 6.4 结论

迁移是**增量、可空、无回填**的 `ALTER TABLE ADD COLUMN`：

- 空库可完整创建；
- 既有库可无损升级；
- 重复 deploy 幂等；
- 迁移后的 schema 与 `schema.prisma` 无差异；
- 完整性检查与外键检查均通过；
- 历史 `Execution` 行的 `cancelRequestedAt` 为 `NULL`，与“从未请求取消”的语义一致；
- 未发现迁移导致的数据丢失、表重建或外键破坏。

---

## 7. F1 复核：API 持久化取消意图与握手串行化

### 7.1 原问题

原 F1（P1）：预启动取消不是持久意图；`release` 只删除已存在 context；in-flight `prepare` 仍会写回；API 在 cancel 后仍可能进入 `start_sent` 并发送 `execution.start`；Runner 可能在 cancel 后 spawn CLI。

### 7.2 修复后的控制流

本次复核确认 API 侧形成以下闭环：

1. **持久化意图**
   - `repository-handshake.service.ts:159-246` 的 `requestCancel` 在 per-execution 锁内先执行
     `updateMany({ where: { id, status: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } })`（`:192-195`）；
   - 该写入先于任何 Runner cancel 消息，且重复调用幂等；
   - 随后查找并 reject 该 execution 的 pending handshake（`:212-224`），再发送 `execution.cancel`（`:226-233`）；
   - `safeToFinalize` 只在“没有 pending 且 `dispatchState === 'created'`”时为 true（`:241`），因此“从未发出 repository”的预启动取消可以由 API 直接终结，不依赖 30 秒进程终止确认。

2. **锁串行化**
   - `withExecutionLock`（`:256-271`）把同一 executionId 的 `requestCancel`、repository 发送、start 发送串成 Promise 链；
   - `dispatch` 在发送 repository 前重新读取 `status`/`dispatchState`/`cancelRequestedAt`（`:281-301`），并用条件 `updateMany` 抢占 `repository_preparing`（`:317-325`）；
   - 进入 `start_sent` 前，`recheckAndTransition` 的条件更新包含 `cancelRequestedAt: null`（`:857-873`、`:887-895`）；
   - 真正发送 `execution.start` 前再次在锁内检查 `status`、`cancelRequestedAt` 和 `dispatchState === 'start_sent'`（`:433-451`），通过后才 `sendEnvelope`（`:452-458`）。

3. **ACK 事务内复核**
   - `recheckAndTransition` 在 Prisma 事务内重读 execution，`status !== 'running'` 或 `cancelRequestedAt` 非空立即抛 `RepositoryDispatchCancelledError`（`:754-758`）；
   - binding 版本、canonicalPath、policyVersion、identity/platform 的检查也都在同一事务内（`:772-855`）。

4. **迟到 ACK 不复活**
   - `onProtocolEvent` 在处理 repository/start ACK 前先调用 `isCancelRequested`（`:953-975`），命中则 reject pending 并删除；
   - `execution.accepted` 的条件更新要求 `dispatchState='start_sent'` 且 `cancelRequestedAt: null`（`:1008-1016`）；若取消先提交，更新计数为 0，走取消分支而不是 `running`（`:1017-1027`）。

5. **单一失败写入者**
   - `failExecutionStart` 在事务内检查 `cancelRequestedAt`（`executions.service.ts:737-766`），取消意图存在时返回 `false`，不覆盖取消终态、不双重回滚 Task/Agent；
   - `startForTask` 的 catch 先判断 `RepositoryDispatchCancelledError` 或持久化意图（`:390-421`），取消路径拥有终态，普通失败才走 `failExecutionStart`；
   - `cancelledStart` 返回 409 `EXECUTION_NOT_RUNNING`（`:1132-1139`），与测试断言一致。

### 7.3 API 回归测试复核

| 测试（`apps/api/test/runner.integration.spec.ts`）                                                          | 关键断言                                                                                                                                                   | 结果 |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `F1: persists cancel intent and ignores a late repository ACK before execution.start`（`:1270-1335`）       | `cancelRequestedAt` 落库；迟到 ACK 后不发送 `execution.start`；行状态 `cancelled`、`dispatchState=terminal`；Task `cancelled`、Agent `idle`                | PASS |
| `F1: serializes cancel between the repository ACK and execution.start`（`:1337-1404`）                      | 在 ACK 后、start 锁前注入 `requestCancel`；start 发送 0 次；状态不为 `running`；最终 `cancelled`                                                           | PASS |
| `F1: a persisted cancelRequestedAt blocks dispatch without sending execution.repository`（`:1406-1473`）    | 模拟 API 重启后已有 `cancelRequestedAt`；`dispatch` 抛 `RepositoryDispatchCancelledError`；`execution.repository`/`execution.start` 均不发送；行仍可被取消 | PASS |
| `F1: finalizes a pre-start cancel with no repository context without waiting for a process`（`:1475-1517`） | `dispatchState=created` 时取消立即 200；不发送 repository/start；`cancelled/terminal`                                                                      | PASS |

### 7.4 边界与残余

- `withExecutionLock` 是**进程内** Promise 链；按计划 Q5，多 API 实例不在 WP-C 范围。单实例内取消与 start 发送的线性化点成立。
- `requestCancel` 先写意图再发消息；API 重启后意图仍在，后续 dispatch 会被阻断。该点由 `:1406-1473` 的重启模拟测试覆盖。
- `safeToFinalize` 的成立前提是 `dispatchState='created'` 表示“从未发出 repository”；代码中 repository 发送前必然先条件更新为 `repository_preparing`，因此该前提成立。

### 7.5 结论

**F1 API 侧 CLOSED / PASS。** 未发现“cancel 已持久化但 API 仍发送 start”的单实例路径。

---

## 8. F1 复核：Runner 取消生命周期与 A–G 时序

### 8.1 `RepositoryContextManager` 生命周期

`apps/runner/src/repository-context.ts` 现在维护：

- `contexts`：已 ready/starting/started 的上下文；
- `inflight`：按 executionId 共享的 prepare Promise、fingerprint、AbortController（`:52-56`、`:108-134`）；
- `cancelled`：取消意图 tombstone（`:79`、`:177-188`）；
- `generations`：每次 release/cancel 递增的代数（`:80`、`:311-313`）。

关键行为：

1. `prepare` 入口先查 `cancelled`，命中直接抛 `RepositoryContextCancelledError`（`:90-94`）；
2. 已有 context 且参数匹配则复用；参数不同抛 `REPOSITORY_CONTEXT_CONFLICT`（`:96-106`）；
3. 同 executionId + 同 fingerprint 的并发 prepare 共享一个 Promise，返回同一 `contextId`（`:108-134`）；
4. `doPrepare` 在 `policy.validate`、default branch、policy 复查、branch commit 之后都调用 `throwIfInvalidated`（`:210-272`）；
5. 最后一次检查与 `contexts.set` 之间没有 `await`（`:270-291`），因此 cancel/release 不能在“检查通过但尚未写入”的窗口插入；
6. `release` 递增 generation、删除 inflight 并 abort、删除 context（`:163-171`）；
7. `cancel` 在 release 基础上永久写入 `cancelled`，并返回是否首次取消（`:177-188`）；
8. `beginStart` 对已取消 execution 返回 `missing`（`:137-146`）；
9. `sweep` 对 `ready` 使用 10 分钟 TTL，对 `starting` 使用 60 秒 TTL，`started` 豁免（`:58-59`、`:199-208`）。

### 8.2 `RunnerClient.handleCancel`

`apps/runner/src/runner-client.ts:572-594`：

- 先记录 `hadSession = executor.hasActiveSession(executionId)`；
- 同步调用 `repositoryContexts.cancel`（写入 tombstone、bump generation、abort in-flight、删除 context）；
- 总是调用 `executor.cancel`，用于清掉 admission-only 状态（例如已缓存的 executable）；
- 若 `hadSession` 为 true，直接返回，由 executor 的进程终止与终态事件路径负责；
- 若没有活跃 session 且是首次取消，直接发送 `execution.cancelled`（`:582-587`），不进入 `ProtocolEventQueue`。

该直接发送覆盖了“从未有 session”的预启动取消，避免 API 只能等 30 秒超时；E 测试验证重复取消不会发出第二个终态（`:673-694`）。

### 8.3 `runAdmission` 的取消检查

`apps/runner/src/runner-client.ts:617-732`：

- 入口检查 `isCancelled`（`:623-633`）：若已取消，发送 `execution.start.rejected(REPOSITORY_CONTEXT_NOT_READY)` 并返回；
- `beginStart` 返回 `missing`/`starting`/`started` 分别处理（`:642-665`）；
- 等待 live admission（`admissionFailure`，内部会调用 `executor.canAdmit`）后再次检查 `isCancelled`（`:686-689`）；命中则 release 并返回，不发送 accepted、不 spawn；
- 再次确认 context 未被替换（`:690-699`）；
- 只有以上检查都通过，才 `markStarted`、发送 `execution.accepted`、调用 `executor.start`（`:701-709`）；
- 外层 catch 在未 accepted 时 release 并发送 rejection；已 accepted 或已取消则不再发 rejection（`:721-730`）。

关键点：`isCancelled` 检查、`markStarted`、`send accepted`、`executor.start` 之间没有 `await`。因此一旦取消消息被事件循环处理，后续同步块不会在“已检查未取消”和“创建 session”之间被插入。

### 8.4 `handleRepository` 的取消/冲突处理

`apps/runner/src/runner-client.ts:798-852`：

- `prepare` 抛 `RepositoryContextCancelledError` 时直接返回，不再发送 `execution.repository.rejected`，避免与已发送的 `execution.cancelled` 竞争；
- 冲突错误（`REPOSITORY_CONTEXT_CONFLICT`）保留已有 context，便于 API 用原 payload 重试时拿到同一 `contextId`；
- 其他错误才 release 并发送 rejection。

### 8.5 A–G 时序测试复核

`apps/runner/test/repository-handshake.spec.ts:534-759`：

| 用例            | 场景                                 | 关键断言                                                                                                  | 结果 |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---- |
| A（`:537-567`） | prepare 进行中取消                   | `policy.validate` gate 卡住；取消后 abort；无 context 写回；无 repository.accepted；无 execution.accepted | PASS |
| B（`:569-598`） | repository accepted 后、start 前取消 | 迟到 start 收到 `REPOSITORY_CONTEXT_NOT_READY`；accepted=0；`executor.start`=0；accepted 早于 cancelled   | PASS |
| C（`:600-637`） | 慢 live admission 中取消             | accepted=0；start.rejected=0；`executor.start`=0                                                          | PASS |
| D（`:639-671`） | 已有活跃 session 时取消              | `executor.cancel` 恰好 1 次；cancelled 恰好 1 条；无重复 accepted/rejected；context 释放                  | PASS |
| E（`:673-694`） | 无 context、无 session 时取消        | 立即且仅发送一次 cancelled；重复取消不产生第二个终态                                                      | PASS |
| F（`:696-727`） | 并发重复 repository + 取消           | `policy.validate` 只调用 1 次；两个等待者都被取消；无 context/accepted/repository.rejected                | PASS |
| G（`:729-758`） | 取消后迟到 repository 与 start       | context 仍为空；无 repository.accepted/accepted；start 被 rejected；`executor.start`=0                    | PASS |

测试使用真实异步 gate（`deferred`、真实 `policy.validate`、真实 `canAdmit` spy），不是同步 mock 返回；断言覆盖 envelope 顺序、数量、context 状态与 executor 调用次数。

### 8.6 边界与残余

- A–G 的 session 取消测试 D 使用 `FakeExecutor` 的 `hasActiveSession`（`fake-executor.ts:92-94`），不覆盖 `RealExecutor` 在 `finalize` 窗口内的 `finished` 状态；该缺口对应 R1（第 13 节）。
- `executor.cancel` 在无 session 时会删除 `admittedExecutables`，但若 cancel 发生在 `canAdmit` 的 live probe 期间，缓存可能尚未写入；该缺口对应 R2。
- `cancelled`/`generations` map 无清理；对应 R3。

### 8.7 结论

**F1 Runner 侧 CLOSED / PASS（预启动取消语义）。** 未发现“cancel 后仍发送 start / 仍 spawn”的可达同步路径；A–G 与 API 集成测试共同覆盖了原 F1 的触发窗口。

---

## 9. F2 复核：accepted 前的 live CLI admission

### 9.1 原问题

原 F2（P2）：Runner 只读启动时缓存的 `runtimeCapabilities`；若 CLI 在注册后消失，admission 仍通过，先发 `execution.accepted`，随后在 `RealExecutor` 内因 `CLI_NOT_INSTALLED` 失败，形成 accepted-then-failed，违反 §8.9 与退出标准第 5 条。

### 9.2 修复后的控制流

1. **接口层**
   - `RunnerExecutor.canAdmit` 改为可同步或异步（`apps/runner/src/executor.ts:69-83`）；
   - `RunnerClient.runAdmission` 在 `markStarted` 和 `execution.accepted` 之前 `await this.admissionFailure(...)`（`runner-client.ts:677`）；
   - `admissionFailure` 最后调用 `executor.canAdmit(payload, context)`（`:768-776`），失败直接返回 `execution.start.rejected` 所需的 code/message。

2. **RealExecutor 的 live 检查**
   - `real-executor.ts:139-217`：
     - 检查 runtime 是否启用（`:143-150`）；
     - 已有 session 直接 admit（`:151-153`）；
     - 容量检查（`:154-161`）；
     - **live** `resolveExecutable(command)`（`:163-188`）；
     - **live** `probeAuthentication(runtime, resolved.path)`（`:190-212`）；
     - 只有成功后才把 executable path 写入 `admittedExecutables`（`:214-217`）。

3. **失败映射**
   - resolve 抛错或返回空：`REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_INSTALLED: ...`（`:169-188`）；
   - auth probe 抛错或未认证：`REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_AUTHENTICATED: ...`（`:190-212`）；
   - `runAdmission` 在 accepted 前收到该失败，发送 `execution.start.rejected`，不发送 accepted。

4. **start 复用**
   - `RealExecutor.start` 从 `admittedExecutables` 取本次 admission 解析出的路径（`:225-229`），避免 accepted 后重新做“是否安装”的普通决策；
   - `prepareAndRun` 中仍保留 `resolveExecutable` 作为最后时刻防御（`:430-443`），但正常路径不会触发。

### 9.3 回归测试复核

`apps/runner/test/repository-handshake.spec.ts:761-839`：

| 测试                              | 注入                                           | 关键断言                                                                                                                                           | 结果 |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| missing CLI（`:772-804`）         | `resolveExecutable` 返回 `{ path: null }`      | `execution.start.rejected` 的 code 为 `REPOSITORY_CONTEXT_NOT_READY`，message 以 `CLI_NOT_INSTALLED:` 开头；accepted=0；spawn=0；auth probe 未调用 | PASS |
| unauthenticated CLI（`:806-839`） | resolve 成功、`probeAuthentication` 返回未认证 | rejected message 以 `CLI_NOT_AUTHENTICATED:` 开头；accepted=0；spawn=0                                                                             | PASS |

测试同时证明 accepted 前完成了 live 检查，而不是只依赖启动缓存。

### 9.4 边界与残余

- **admission 后的 TOCTOU**：`canAdmit` 成功到 `start` 之间，CLI 仍可能被删除；`prepareAndRun` 的防御性 `resolveExecutable` 会把这种情况变成 accepted 后的 failed。这是任何“检查后使用”都无法完全消除的外部文件系统竞态；计划 §8.9 的语义边界是“execution.start 时刻的 live 检查”，不是“持有可执行文件句柄直到 spawn”。本次不将其计为 F2 未关闭。
- **R5**：`probeAuthentication` 的 20 秒单命令超时与 API 的 20 秒 `START_ACCEPT_TIMEOUT` 叠加，最坏情况可能超过 start 接受预算。该问题属于 F2 加固引入的时延耦合，详见第 13 节 R5。
- **probe 进程不可取消**：取消消息不会中止正在运行的 auth probe 子进程；probe 最长继续到自身超时。该点并入 R5 的修复建议。

### 9.5 结论

**F2 CLOSED / PASS。** missing/未认证 CLI 在 accepted 前被拒绝，accepted=0、spawn=0；未发现原 accepted-then-failed 路径。

---

## 10. F3 复核：并发 repository 幂等与重复 ACK

### 10.1 原问题

原 F3（P2）：API 在 2s/6s 重发同一条 `execution.repository`；Runner 的 `prepare` 只在入口查 map，多个 await 后各自写回并生成不同 `contextId`，破坏“same executionId + same bindingVersion/policyVersion/path → same contextId”。

### 10.2 修复后的控制流

1. **in-flight 共享**
   - `repository-context.ts:108-134` 以 executionId 为键保存 `{ fingerprint, controller, promise }`；
   - 同 executionId + 同 fingerprint 的并发 prepare 直接返回同一个 Promise，只执行一次 validate/git，返回同一 `contextId`；
   - 不同 fingerprint 立即抛 `REPOSITORY_CONTEXT_CONFLICT`，不取消第一个 prepare；
   - Promise 的 `finally` 只删除仍指向自己的 inflight 条目（`:124-129`），避免旧 Promise 清掉新条目。

2. **取消/释放**
   - `release`/`cancel` 删除 inflight、abort controller、递增 generation（`:163-188`）；
   - `doPrepare` 的每次 await 后检查 generation/signal/cancelled，迟到完成不能写回（`:294-305`）；
   - 最后一个检查与 `contexts.set` 之间无 await（`:270-291`）。

3. **API 重复 ACK**
   - `acceptedRepository` 先 `recheckAndTransition(..., 'repository_preparing')` 再到 `repository_ready`（`repository-handshake.service.ts:716-722`）；
   - 两个 transition 都使用带 `dispatchState` 与 `cancelRequestedAt: null` 条件的 `updateMany`（`:857-906`）；
   - 第一个 ACK 推进状态，第二个 ACK 因 `dispatchState` 已变化得到 `count=0`，走 `staleTransition` 或幂等分支，不会重复发送 start。

### 10.3 测试复核

**Runner 单元测试**（`repository-handshake.spec.ts`）：

| 测试                                                                                                      | 关键断言                                                                                          | 结果 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---- |
| `F3: shares one in-flight prepare and one contextId for concurrent duplicates`（`:316-337`）              | gate 卡住 validate；两个 prepare 并发；`policy.validate` 只调用 1 次；两个结果 `contextId` 相同   | PASS |
| `F3: rejects a different request while a prepare is in-flight without cancelling the first`（`:338-357`） | 第二个不同 fingerprint 得到 `REPOSITORY_CONTEXT_CONFLICT`；第一个 context 保留且 `contextId` 不变 | PASS |
| `F3/F1: cancel aborts an in-flight prepare and leaves no context behind`（`:359-376`）                    | cancel 后 prepare 抛 `RepositoryContextCancelledError`；context 为空                              | PASS |
| F（`:696-727`）                                                                                           | 并发重复 repository + cancel：validate 只 1 次；无 accepted/rejected/context                      | PASS |

**API 集成测试**（`runner.integration.spec.ts:1519-1571`）：

- 等待至少两条 `execution.repository`，断言它们 `messageId` 相同；
- 对两条消息分别发送 ACK；
- 断言只发送 1 次 `execution.start`；
- 断言 `repositoryContextId` 等于 `context_<executionId>`；
- 断言 `repository_ready` 审计恰好 1 条、`start_sent` 审计恰好 1 条。

结果：PASS。

### 10.4 观察（不计为 Finding）

- 并发重复 `execution.repository` 仍会由每个 `handleRepository` 各回送一条 `execution.repository.accepted`（同一 `contextId`）。API 的 `onProtocolEvent` 对重复 accepted 是幂等 resolve，`dispatch` 只执行一次 `acceptedRepository`，因此没有重复状态迁移或重复 start。原修复方向中“只发送一个 accepted”的字面目标未完全达到，但计划要求的 executionId 幂等与同一 contextId 已满足，故不作为阻塞 Finding。
- **O-1**：`fingerprint`/`matches` 仍比较 `payload.path` 的平台归一化形式（`repository-context.ts:315-336`），未比较 `canonicalPath`。同一仓库通过 junction/symlink 等不同路径表示重试时，可能被误判为冲突；详见第 13 节观察项。

### 10.5 结论

**F3 CLOSED / PASS。** 并发重复 repository 共享同一 prepare 与同一 contextId；API 重复 ACK 收敛为一次 start、一次 `repository_ready`、一次 `start_sent`。

---

## 11. F4 复核：创建事务内 live feature 检查

### 11.1 原问题

原 F4（P3）：availability 预检读取 live features，但创建 Execution 的事务内只重读 binding/identity，不重读 features；若同一 `runnerId` 在两步之间重新注册并丢失 feature，Execution 行已创建，随后 dispatch 失败并留下 1 条 failed 行，违反 G7 的“zero Execution rows”。

### 11.2 修复后的控制流

- `runtime-registry.service.ts:131-139` 新增 `hasLiveExecutionFeatures(runnerId)`，直接读取 `RunnerRegistryService` 的 live registration；
- `executions.service.ts:311-318` 在创建事务的 `requiresRunner` 分支内、`tx.execution.create` 之前调用该检查；不满足抛 `PROJECT_BINDING_UNSUPPORTED`（409）；
- `tx.execution.create` 位于 `:323-342`，即检查在同一 Prisma 事务回调内、写入之前；
- availability 预检仍保留（`:213-220`），但不再承担最终一致性。

### 11.3 回归测试复核

`apps/api/test/runner.integration.spec.ts:1573-1607`：

- spy `RuntimeRegistryService.getAvailability`；
- 在原 availability 返回后、创建事务前，用同一 `runnerId` 重新注册并只保留 `repository-validation-v1`、`repository-path-policy-v1`；
- 等待 `!hasLiveExecutionFeatures(RUNNER_ID)`；
- POST `/api/tasks/:id/start`；
- 断言 409 `PROJECT_BINDING_UNSUPPORTED`；
- 断言该 Task 的 `Execution` 行数为 0；
- 断言 Task 状态不变、Agent 仍为 `idle`。

结果：PASS。该测试确实覆盖了“预检后、事务检查前”的 feature 丢失，而不是只覆盖静态缺 feature。

### 11.4 残余窗口

检查是同步的 in-memory 读取（`:311`），紧接着是 `await tx.execution.create`（`:323`）。在 Prisma 的 DB await 期间，Node 事件循环可以处理同一 `runnerId` 的重新注册；重新注册可能移除 feature，而 create 仍会提交。随后 dispatch 的 `assertDispatchable` 再读 live features 时失败，`failExecutionStart` 留下 1 条 failed 行。

因此：

- F4 的原始宽窗口（availability → 事务内多步读取/写入）已被显著收窄；
- 但“检查通过”与“DB 提交”之间仍有一个 DB await 的窗口；
- 这不是“检查位置不对”，而是“in-memory 状态无法与 DB 提交原子化”的固有限制。

该残余记为 **R4（P3）**，详见第 13 节。

### 11.5 结论

**F4 PASS WITH WARNINGS。** 静态场景与“预检后、事务检查前”的丢失已被 409 + zero-row 测试覆盖；但 G7 的 zero-row 仍不是绝对保证，R4 需跟踪。

---

## 12. F5 复核：starting 生命周期与 admission 异常

### 12.1 原问题

原 F5（P3）：`beginStart` 把 `ready` 改为 `starting`；`sweep` 只清理 `ready`；`runAdmission` 没有包裹整个 admission 的 try/catch。若 admission 期间出现未预期异常，context 永久停在 `starting`，10 分钟 TTL 不会清理。

### 12.2 修复后的控制流

1. **短 TTL**
   - `repository-context.ts:58-59`：`PRE_START_TTL_MS = 10 * 60_000`，`STARTING_TTL_MS = 60_000`；
   - `sweep`（`:199-208`）：
     - `started` 豁免；
     - `ready` 使用 10 分钟；
     - `starting` 使用 60 秒；
     - 超时调用 `release`，删除 context、inflight 并 abort。

2. **异常释放**
   - `runAdmission` 的外层 catch（`runner-client.ts:721-730`）：
     - 若 `acceptedSent` 为 true 或 `isCancelled` 为 true，直接返回，不与运行期/取消终态竞争；
     - 否则 `repositoryContexts.release(executionId)`，再发送 `execution.start.rejected`；
   - `admissionFailure` 失败分支（`:677-681`）也会 release 后再 rejection。

3. **取消优先**
   - 若异常发生在取消之后，`isCancelled` 为 true，catch 不释放也不发 rejection；取消路径已经删除 context 并拥有终态。

### 12.3 回归测试复核

| 测试                                                                                          | 关键断言                                                                            | 结果 |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| `releases a starting context when admission throws`（`repository-handshake.spec.ts:841-860`） | `executor.canAdmit` 抛错；收到 `execution.start.rejected`；context 为空；accepted=0 | PASS |
| `F5: sweeps a starting context after the short admission TTL`（`:378-388`）                   | `beginStart` 后推进 61 秒；context 被清理                                           | PASS |
| ready TTL 测试（`:293-305`）                                                                  | ready context 10 分钟 TTL；started 不被清理                                         | PASS |

### 12.4 边界与残余

- 60 秒 `starting` TTL 可能误清理一个合法的超长 admission（例如 auth probe 接近 40 秒、加上容量/policy 检查）。清理后 `runAdmission` 的 context 复查会返回 `REPOSITORY_CONTEXT_NOT_READY`，执行被拒绝，不会 spawn；属于可用性边界，不是错误启动。
- `contexts` 被清理，但 `generations`/`cancelled` 两个簿记 map 不会清理；该资源增长记为 **R3（P3）**，详见第 13 节。它是 F5 相邻的残余，不是原 F5 的 `starting` context 泄漏。

### 12.5 结论

**F5 CLOSED / PASS。** `starting` 有 60 秒兜底 TTL；admission 异常会释放 context 并回送 rejection；未发现 context 永久停在 `starting` 的路径。

---

## 13. 新发现与残余风险

### 13.1 R1 — P3 — 完成终态与取消终态在 finalize 窗口内可能乱序

| 属性          | 内容                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | R1 / **P3** / OPEN                                                                                                                                                                                                                                                                                                    |
| **位置**      | `apps/runner/src/real-executor.ts:220-223,592-609,625,652`；`apps/runner/src/runner-client.ts:151-160,572-587`；`apps/runner/src/protocol-event-queue.ts:14-17`；`apps/api/src/modules/executions/executions.service.ts:62-64,941-966,974-1002`                                                                       |
| **代码证据**  | `hasActiveSession` 返回 `Boolean(session && !session.finished && !session.cancelled)`；`finalize` 在 `await collectGit` 之前就把 `session.finished = true`；`onCompleted` 只是把 `execution.completed` 入队；`handleCancel` 在 `hasActiveSession` 为 false 且首次取消时直接 `send('execution.cancelled')`，绕过队列。 |
| **触发条件**  | CLI 已以 0 退出并进入 `finalize`，`session.finished=true`，但 `collectGit`/`finishJournal` 或队列中的 `execution.completed` 尚未完成；操作员此时发送 `execution.cancel`。                                                                                                                                             |
| **影响**      | Runner 立即发送 `execution.cancelled`（`exitCode:null, git:null`）；API 的 per-execution 锁先处理 cancelled，`finishExecution` 把行置为 `cancelled`；随后到达的 `execution.completed` 因状态已非 `running` 被忽略，成功完成的 Git 结果/摘要丢失。不会错误 spawn，也不会改变预启动取消语义。                           |
| **可复现性**  | **代码路径确认，未运行时复现。** 复现配方：注入一个延迟的 `git.collect`（或延迟 `finishJournal`），在 `child close` 后、`collectGit` 完成前投递 `execution.cancel`；观察 outbound 顺序为 cancelled 先于 completed，数据库终态为 cancelled。                                                                           |
| **修复方向**  | 让 `handleCancel` 把“session 存在但已完成决定、终态尚未交付”视为 active（例如维护 `terminalQueued/terminalSent`，`hasActiveSession` 改用 `sessions.has` 而非 `!finished`），不再直接发送 cancelled；或把 cancelled 也放入同一 `ProtocolEventQueue`，并在队列任务中检查是否已有 terminal 决定。                        |
| **阻塞状态**  | **否。** 不影响 WP-C 验收；建议 WP-D 的取消/恢复矩阵显式定义“已完成决定但终态未送达”时 cancel 的语义。                                                                                                                                                                                                                |

**定级理由：** 该竞态要求操作员在 `finalize` 的短窗口内主动取消，属于“取消覆盖完成”与“完成覆盖取消”的语义边界；它不触发错误 spawn、不造成安全绕过或数据库损坏，也未被 WP-C 的退出标准或冻结不变量直接覆盖，因此按 P3 跟踪，而不是 P2。

**代码摘录：**

```ts
// real-executor.ts:220-223
hasActiveSession(executionId: string): boolean {
  const session = this.sessions.get(executionId);
  return Boolean(session && !session.finished && !session.cancelled);
}

// real-executor.ts:597-609
if (session.finished) return;
session.finished = true;
this.clearTimers(session);
...
const git = await this.collectGit(session);

// runner-client.ts:574-587
const hadSession = this.executor.hasActiveSession(executionId);
const first = this.repositoryContexts.cancel(executionId, resolved);
this.executor.cancel(executionId, resolved);
if (hadSession) return;
if (!first) return;
this.send('execution.cancelled', { ... });
```

---

### 13.2 R2 — P3 — 取消/上下文失效发生在 live admission 期间时，admission 缓存泄漏

| 属性          | 内容                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | R2 / **P3** / OPEN                                                                                                                                                                                                                                                                                                                                                                            |
| **位置**      | `apps/runner/src/real-executor.ts:214-217,225-229,262-267`；`apps/runner/src/runner-client.ts:686-699,721-730`                                                                                                                                                                                                                                                                                |
| **代码证据**  | `RealExecutor.canAdmit` 在 live resolve/auth 成功后执行 `this.admittedExecutables.set(payload.executionId, resolved.path)`；`cancel()` 只会在被调用时删除该 key；`runAdmission` 在 `canAdmit` 返回后若发现 `isCancelled`（`:686-689`）或 context 消失（`:690-699`），只 `release` 并返回，没有再调用 `executor.cancel` 或清理 `admittedExecutables`；外层 catch（`:721-730`）同样只 release。 |
| **触发条件**  | 取消在 `canAdmit` 的 `resolveExecutable`/`probeAuthentication` await 期间到达：此时 `handleCancel` 调用 `executor.cancel`，key 尚未写入；随后 `canAdmit` 成功并写入 key；`runAdmission` 的取消检查命中并返回，key 永久保留。context 在 admission 期间被 60 秒 sweep 或替换时也会走同一泄漏分支。                                                                                              |
| **影响**      | `admittedExecutables` 每个事件保留一个 executionId→path 字符串，进程生命周期内不释放。由于已取消 execution 的后续 start 会在入口被拒绝，不会复用该 path，也不会造成安全绕过；属于缓慢内存泄漏。                                                                                                                                                                                               |
| **可复现性**  | **代码路径确认，未运行时复现。** 复现配方：用 gate 卡住 `probeAuthentication`，在 gate 期间投递 `execution.cancel`，放行后断言 `admittedExecutables` 仍含该 executionId。                                                                                                                                                                                                                     |
| **修复方向**  | 在 `runAdmission` 的取消分支、context-missing 分支和 catch 分支统一清理 admission 缓存；例如新增 `executor.discardAdmission(executionId)`，或在这些分支调用 `executor.cancel(executionId)`（无 session 时只删除缓存），或让 `canAdmit` 返回 executable path 而不是内部缓存。                                                                                                                  |
| **阻塞状态**  | **否。** 仅资源泄漏，不影响正确性；建议生产前修复或在 admission 结束的 `finally` 中统一清理。                                                                                                                                                                                                                                                                                                 |

---

### 13.3 R3 — P3 — `cancelled` / `generations` 簿记 map 永不清理

| 属性          | 内容                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | R3 / **P3** / OPEN                                                                                                                                                                                                                                                                                                                    |
| **位置**      | `apps/runner/src/repository-context.ts:79-80,163-171,177-188,307-313`；`apps/runner/src/runner-client.ts:159,171,182,725`                                                                                                                                                                                                             |
| **代码证据**  | `cancelled` 与 `generations` 都是 `Map<string, ...>`；`release` 每次 `bumpGeneration`，`cancel` 每次写入 `cancelled`；代码中没有 `delete` 这两个 key 的路径。每个 terminal callback（completed/failed/cancelled）都会 `release`，因此每个执行至少留下一个 `generations` 条目；每次取消留下一个 `cancelled` 条目（含 reason 字符串）。 |
| **触发条件**  | 正常运行完成、失败、取消、admission 失败都会触发；无需异常。                                                                                                                                                                                                                                                                          |
| **影响**      | 长生命周期 Runner 的进程内存随执行数线性增长；每个条目很小，但 `cancelled` 还会保留取消原因文本。不会改变当前 execution 的状态机或 spawn 语义。                                                                                                                                                                                       |
| **可复现性**  | **代码路径确认，未运行时复现。** 可通过重复 `release`/`cancel` 后检查私有 map 大小观察增长；不需要真实 CLI。                                                                                                                                                                                                                          |
| **修复方向**  | 在确认没有 context、没有 inflight、没有待处理迟到消息后删除 generation；对 `cancelled` tombstone 使用有界 TTL/LRU（TTL 必须覆盖 API 重试、重连和 WP-D 重放窗口），或把 tombstone 持久化/转移到有界结构；至少增加最大值和告警。                                                                                                        |
| **阻塞状态**  | **否。** 资源增长，不影响 WP-C 主路径或 WP-D 开工；建议在生产长跑前处理。                                                                                                                                                                                                                                                             |

---

### 13.4 R4 — P3 — F4 的 feature 复核与 DB 提交之间仍有单次 await 窗口

| 属性          | 内容                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | R4 / **P3** / OPEN（F4 残余）                                                                                                                                                                                                                              |
| **位置**      | `apps/api/src/modules/executions/executions.service.ts:311-318,323-342`；`apps/api/src/modules/runtime/runtime-registry.service.ts:131-139`；`apps/api/src/modules/runners/repository-handshake.service.ts:556-575`                                        |
| **代码证据**  | `hasLiveExecutionFeatures(runnerId)` 是同步的 in-memory 读取；随后 `await tx.execution.create(...)` 才写 DB。两者之间没有锁住 Runner 注册事件。`assertDispatchable` 在 dispatch 时再次读取 live features，若此时已丢失则抛 `PROJECT_BINDING_UNSUPPORTED`。 |
| **触发条件**  | 同一 `runnerId` 在 `hasLiveExecutionFeatures` 返回 true 之后、`tx.execution.create` 的 DB await 完成之前重新注册，并移除 execution 必需 feature。窗口为一个 DB roundtrip。                                                                                 |
| **影响**      | Execution 行已创建；dispatch 失败后 `failExecutionStart` 把它标为 failed，Task/Agent 回滚；用户得到启动失败（`RUNTIME_START_FAILED` 500 路径）而不是 G7 要求的 409；数据库留下 1 条 failed Execution 行。不会错误 spawn，也不会改变已成功执行的状态。      |
| **可复现性**  | **代码路径确认，未运行时复现。** 现有 F4 测试在“事务检查之前”重注册，覆盖不到“检查之后、create await 期间”的窗口；需要在 Prisma create 的 await 中注入注册事件。                                                                                           |
| **修复方向**  | 把 runner feature 的 epoch/版本持久化到 DB，注册时递增，创建事务内比较 epoch；或在单 API 实例内用进程级互斥锁把注册处理与创建事务串行化；或明确接受该 P3 并在 G7 文档中注明“静态/预检后窗口已收窄，但非绝对 zero-row”。                                    |
| **阻塞状态**  | **否。** 原 F4 即为 P3；本次仍为 P3，不阻塞 WP-C 验收或 WP-D 开工。                                                                                                                                                                                        |

---

### 13.5 R5 — P3 — F2 的 live auth probe 最坏可超过 20s start 接受预算

| 属性          | 内容                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ID / 级别** | R5 / **P3** / OPEN（F2 残余）                                                                                                                                                                                                                                                        |
| **位置**      | `apps/runner/src/cli-probe.ts:11,117-139`；`apps/api/src/modules/runners/repository-handshake.service.ts:75-76,418-426`；`apps/runner/src/runner-client.ts:677`；`apps/runner/src/real-executor.ts:190-212`                                                                          |
| **代码证据**  | `PROBE_TIMEOUT_MS = 20_000`；OpenCode 的 `probeOpencodeAuth` 先跑 `auth list`，若不满足再跑 `models`，两次各自最多 20 秒；API 的 `START_ACCEPT_TIMEOUT_MS = 20_000`，从发送 `execution.start` 起计时。`runAdmission` 在发送 accepted 前 `await` 整个 live auth probe。               |
| **触发条件**  | `auth list` 接近 20 秒，或输出不含凭据而回退到 `models`，两次 probe 总时长超过 20 秒；或机器负载/杀毒软件使单次 probe 超时。                                                                                                                                                         |
| **影响**      | API 先触发 `START_ACCEPT_TIMEOUT`，把执行标为 failed 并发送 cancel；Runner 的 probe 仍在进行，随后返回 rejected 或 cancelled。合法但慢的 CLI 被误判为启动失败，用户看到 500/超时；若 probe 恰好在 cancel 到达前完成，可能出现短暂 spawn 后被终止的边界窗口。不会持久保留错误 spawn。 |
| **可复现性**  | **代码路径确认，未运行时复现。** 可通过注入延迟的 `probeAuthentication` 或 fake timer 复现；现有 F2 测试都是立即返回，不覆盖慢 probe。                                                                                                                                               |
| **修复方向**  | 把 admission probe 的总预算压到 `START_ACCEPT_TIMEOUT` 之内（例如每次 5 秒、总共不超过 10–15 秒），或只执行一个确定性的认证检查；把 cancel 传递给 probe 子进程（AbortController/kill）；若要提高 20 秒上限，必须按计划 §8.9 的冻结值走文档变更，不能静默修改。                       |
| **阻塞状态**  | **否。** 可用性边界，不改变 F2 的 accepted-before-spawn 主结论；建议在 WP-D 前或生产前处理。                                                                                                                                                                                         |

---

### 13.6 O-1 — 非阻塞观察 — `matches`/fingerprint 仍比较配置路径而非 canonicalPath

| 属性          | 内容                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | O-1 / **观察（低于 P3）** / OPEN                                                                                                                                                                                              |
| **位置**      | `apps/runner/src/repository-context.ts:315-324,326-336`                                                                                                                                                                       |
| **代码证据**  | `fingerprint` 使用 `comparable(payload.path, platform)`；`matches` 使用 `comparable(context.configuredPath, platform)`；`comparable` 只统一分隔符、去尾斜杠、Windows 小写，不做 `realpath`/junction/symlink 归一化。          |
| **触发条件**  | 同一仓库通过不同路径表示（junction、symlink、不同大小写在大小写敏感文件系统）重试，且 executionId/bindingVersion/policyVersion 相同。API 通常复用 binding.path，因此正常单次握手重试不会触发；属于跨表示重试/手工重放的边界。 |
| **影响**      | 可能返回 `REPOSITORY_CONTEXT_CONFLICT`，导致合法重试失败；不会错误 spawn，也不会产生错误 contextId。                                                                                                                          |
| **可复现性**  | **代码路径确认，未做 symlink/junction 运行时实测。** 原独立审查已将其列为非阻塞观察；本次确认修复只做了平台大小写/分隔符归一化。                                                                                              |
| **修复方向**  | 在 policy 校验得到 `canonicalPath` 后，用 canonicalPath 参与匹配/fingerprint；或在 prepare 前先做一次 `realpath` 并纳入 fingerprint；保持 API 侧 `sameRepositoryPath` 与 Runner 侧规则一致。                                  |
| **阻塞状态**  | **否。** 不作为 Finding 计数，仅记录以免被“已归一化”误读为“已 canonical 化”。                                                                                                                                                 |

---

### 13.7 新发现汇总

| ID  | 级别 | 是否新增      | 是否阻塞 WP-C | 是否阻塞 WP-D | 建议处理时点         |
| --- | ---- | ------------- | ------------- | ------------- | -------------------- |
| R1  | P3   | 是            | 否            | 否            | WP-D 取消矩阵/生产前 |
| R2  | P3   | 是            | 否            | 否            | 生产前               |
| R3  | P3   | 是            | 否            | 否            | 生产长跑前           |
| R4  | P3   | 是（F4 残余） | 否            | 否            | WP-D 期间或之后      |
| R5  | P3   | 是（F2 残余） | 否            | 否            | WP-D 前/生产前       |
| O-1 | 观察 | 否（原观察）  | 否            | 否            | 后续加固             |

本次未发现 P0、P1、P2 级新问题。

---

## 14. 退出标准与冻结不变量逐条对照

### 14.1 WP-C 退出标准

依据实施计划 `P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:2153-2164`：

| #   | 退出标准                                                                                   | 判定                   | 说明                                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | 成功顺序 repository → accepted → start → accepted                                          | **PASS**               | §8.1/§9.3；`repository-handshake.spec.ts:392-434` 顺序断言                                                  |
| 2   | 没有有效 accepted 不发 start                                                               | **PASS**               | §8.2；`runner.integration.spec.ts:913-983`                                                                  |
| 3   | 没有 accepted 不 spawn CLI                                                                 | **PASS**               | §9.3；`runner-client.ts:701-709` 同步顺序；F2 测试 spawn=0                                                  |
| 4   | `execution.start.rejected` 阻止 spawn                                                      | **PASS**               | §9.2；context/policy/busy/missing CLI 均走 rejected                                                         |
| 5   | `RUNTIME_NOT_ENABLED`、`RUNNER_BUSY`、missing CLI 必须 rejected，不能 accepted-then-failed | **PASS**               | F2 已在 accepted 前完成 live resolve/auth；测试 accepted=0、spawn=0                                         |
| 6   | binding/policy 变化在 start 前失败并 cancel                                                | **PASS**               | `recheckAndTransition`；`runner.integration.spec.ts:1031-1147`                                              |
| 7   | 缺失 defaultBranch 由 repository 拒绝                                                      | **PASS**               | `repository-context.ts:342-379`；`repository-handshake.spec.ts:279-291`                                     |
| 8   | 其他 Runner/platform 在预检和 post-accepted 重检均拒绝                                     | **PASS**               | `executions.service.ts` 的 `assertBindingRunnerIdentity`；`repository-handshake.service.ts:605-628,915-929` |
| 9   | start 发出后 binding 编辑不影响执行                                                        | **PASS**               | Execution 快照 + handshake 快照比较                                                                         |
| 10  | 旧 Runner 在创建 Execution 前 409                                                          | **PASS WITH WARNINGS** | 静态场景与“预检后、事务检查前”均 PASS；R4 的“检查后、create await 期间”仍有单次 await 窗口                  |

### 14.2 冻结不变量

依据实施计划 `P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:637-644`：

| #   | 不变量                                                                      | 判定     | 说明                                                                                   |
| --- | --------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| 1   | 任何 start 前失败都发 `execution.cancel`                                    | **PASS** | API 的 dispatch/start 失败路径均调用 `dispatchCancel`；F1 API 测试覆盖                 |
| 2   | Runner 在 preparing/ready 收到 cancel：中止准备、释放 context、不 spawn CLI | **PASS** | `cancelled` tombstone + generation + AbortController + 每 await 检查；A/B/C/E/F/G 覆盖 |
| 3   | API 在 cancel/rejection 后绝不发 start                                      | **PASS** | `cancelRequestedAt` 持久化 + 锁 + repository/start 前条件检查；API F1 四项测试         |
| 4   | 不向非 validatedByRunnerId / 平台不匹配的 Runner 发 start                   | **PASS** | 预检 + post-accepted 重检；无变化                                                      |
| 5   | 主 checkout 永不被触碰                                                      | **PASS** | worktree 隔离未改；WP-B 策略复用                                                       |
| 6   | terminal 后的 late accepted/rejected 被忽略                                 | **PASS** | `noteTerminal` + `pending.settled` + 条件更新；无变化                                  |

### 14.3 对照结论

- 10 项退出标准：9 项 PASS，1 项 PASS WITH WARNINGS（第 10 项，R4）；
- 6 项冻结不变量：全部 PASS；
- 原 F1 的两个 FAIL 项（不变量 2、3）和退出标准第 5 项（F2）均已关闭；
- 没有发现任何仍可复现的 P1/P2 路径。

---

## 15. 最终验收结论与 WP-D 准入

### 15.1 WP-C 验收结论

**PASS WITH WARNINGS。**

理由：

1. F1（P1）已关闭：API 持久化 `cancelRequestedAt`，repository/start 前有锁内检查与条件更新；Runner 有 cancel tombstone、generation、AbortController 与每个 await 后的检查；A–G 与 API 集成测试覆盖了原触发窗口；
2. F2（P2）已关闭：accepted 前完成 live resolve/auth，missing/未认证 CLI 走 `execution.start.rejected`，accepted=0、spawn=0；
3. F3（P2）已关闭：并发重复 repository 共享同一 in-flight Promise 和同一 contextId；API 重复 ACK 收敛为一次 start；
4. F4（P3）已收窄但未绝对闭环：R4 的单次 DB await 窗口仍在；
5. F5（P3）已关闭：`starting` 60 秒 TTL 与 admission 异常释放均已实现并测试；
6. 364 个测试、38 个测试文件、四项门禁、空库/既有库/重复 deploy 与完整性检查全部通过；
7. 新发现 R1–R5 均为 P3，不改变主路径正确性。

### 15.2 WP-D 准入决定

**WP-D 可以开始。**

| 项目                 | 决定                                                        |
| -------------------- | ----------------------------------------------------------- |
| 原 F1 对 WP-D 的阻塞 | **解除**                                                    |
| 原 F3 对 WP-D 的阻塞 | **解除**                                                    |
| 当前 P0/P1/P2        | **0**                                                       |
| R1–R5                | 不阻塞 WP-D 开工；建议在 WP-D 取消/恢复矩阵与生产加固中跟踪 |
| F4 zero-row          | 记录为 PASS WITH WARNINGS；不得对外宣称“绝对 zero-row”      |
| 多 API 实例          | 仍按计划 Q5 属于 Phase 3+，不在 WP-D 范围                   |
| 真实 CLI E2E         | 本次 NOT_VERIFIED；WP-D 若涉及真实恢复，应单独补 opt-in E2E |

### 15.3 对 WP-D 的具体提醒

1. **R1**：WP-D 的重连/恢复矩阵需要定义“CLI 已退出、completed 已决定但终态事件尚未送达时收到 cancel”的优先级；当前 Runner 会把这种情况直接发成 cancelled。建议在 WP-D 设计阶段先确定语义，再决定是否修 R1。
2. **R2/R3**：长跑 Runner 的进程内簿记会随执行/取消数量增长；WP-D 的恢复扫描如果长期运行，应在生产前清理。
3. **R4**：如果 WP-D 引入注册恢复或 feature 重放，应把 runner feature epoch 的持久化一并考虑，否则 zero-row 仍不是绝对保证。
4. **R5**：如果 WP-D 增加真实 CLI 恢复，应把 auth probe 的预算与 `START_ACCEPT_TIMEOUT` 对齐，避免恢复路径放大慢 probe 问题。

### 15.4 结论复述

WP-C 的方向、主路径、迁移与契约兼容性均通过独立复跑；原 P1/P2 阻塞已消除，剩余问题均为 P3 窄竞态、资源增长或可用性边界。**WP-C 可以以 PASS WITH WARNINGS 收尾，WP-D 可以开始，但必须保留 R1–R5 的跟踪，不得把 F4 的 zero-row 或 F2 的 live admission 描述为绝对保证。**

---

## 16. 附录：命令、环境与工作区状态

### 16.1 实际运行的命令

| 命令                                                | 结果                         |
| --------------------------------------------------- | ---------------------------- |
| `pnpm install --offline --frozen-lockfile`          | 成功                         |
| `pnpm --filter @raft-lite/contracts build`          | 成功                         |
| `pnpm --filter @raft-lite/contracts test`           | 109 passed / 5 files         |
| `pnpm --filter @raft-lite/runner test`              | 138 passed / 16 files        |
| `pnpm --filter @raft-lite/web test`                 | 41 passed / 11 files         |
| `pnpm --filter @raft-lite/api exec prisma generate` | 成功                         |
| `pnpm --filter @raft-lite/api test`                 | 76 passed / 6 files          |
| `pnpm typecheck`                                    | 全部通过                     |
| `pnpm lint`                                         | 0 error / 0 warning          |
| `pnpm format:check`                                 | changed files Prettier-clean |

测试日志位于仓库外：`D:\CODE\GIT\haft-wpc2-*.log`（contracts/api/runner/web/typecheck/lint/format）。

### 16.2 Migration 探针

- 临时数据库与 schema/migrations 副本：`C:\Users\A11720\AppData\Local\Temp\haft-wpc2-migprobe2-20261111145726`、`...migprobe4-20261111154239`；
- 使用 `prisma migrate deploy` 与 `prisma migrate diff --exit-code`；
- 使用 `node:sqlite` 执行 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、`pragma_table_info`；
- 未在仓库内创建数据库或迁移副本。

### 16.3 工作区与提交

- 复审开始时工作树 `git status --short` 为空；
- 复审期间未修改产品代码、测试、迁移或既有文档；
- 本报告是唯一新增文件；
- 计划提交信息：`docs(p2-02): add WP-C closure independent review`；
- 计划推送分支：`feature/p2-02-project-aware-runner`；
- 未 rebase、未 force push、未创建 PR、未修改 `main`；
- 最终 SHA、远端同步状态与工作树清洁度以提交/推送后的 `git status`、`git log` 为准。

### 16.4 证据边界

- 本报告的“PASS”以本次独立复跑的 364 个测试、四项门禁、三类 migration 探针与静态代码阅读为依据；
- R1–R5 未保留运行时探针，标记为“代码路径”；
- 未运行真实 CLI E2E，F2 的验证基于注入式 Runner 测试；
- 未运行多 API 实例并发，按计划 Q5 超出 WP-C 范围；
- 未运行 WP-D 恢复/重连矩阵，WP-D 尚未实现。

---

_本报告由独立复审生成，只新增 `docs/engineering/P2-02_WP-C_CLOSURE_INDEPENDENT_REVIEW.md`；未修改任何产品代码、测试、迁移、roadmap、实施计划或既有报告。_
