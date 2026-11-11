# P2-02 WP-C 收尾修复报告：F1–F5

| 项目         | 内容                                                               |
| ------------ | ------------------------------------------------------------------ |
| 分支         | `feature/p2-02-project-aware-runner`                               |
| 修复基线     | `fd7852bb2ec46ec553b79cc6007a5beec2000d7b`（独立审查报告提交）     |
| 代码修复提交 | `d8594a1cb474ffcdeb68f6e701fa6975d8fc9850`                         |
| 被审查实现   | `1eedb987deae0a9fcc6d2b540cebf9bc364e2ba3`                         |
| 冻结基线     | `a48e62d4e18e6834c9fb5df18bd6ede9aee61134`                         |
| 修复范围     | F1、F2、F3 必须修复；F4、F5 加固                                   |
| 当前状态     | **等待新的独立只读复审；本报告不宣布 WP-C PASS，不进入 WP-D**      |
| 未修改的内容 | `main`、独立审查报告、实施计划、Roadmap、Contract 协议、既有错误码 |

---

## 1. 结论摘要

本次修复针对独立审查的 5 项 Finding，全部落在 WP-C 范围内：

| ID  | 原级别 | 原结论 | 修复后状态（待复审确认） | 关键证据                                                             |
| --- | ------ | ------ | ------------------------ | -------------------------------------------------------------------- |
| F1  | P1     | FAIL   | 已修复                   | 持久化 cancel intent；API 四处检查；Runner A–G 时序测试              |
| F2  | P2     | FAIL   | 已修复                   | accepted 前 live CLI 检查；rejected 且 accepted/spawn 均为 0         |
| F3  | P2     | FAIL   | 已修复                   | per-execution in-flight Promise + 请求指纹；并发重复只产生一个上下文 |
| F4  | P3     | WARN   | 已加固                   | feature 检查移入创建事务；409 时 Execution 行数为 0                  |
| F5  | P3     | WARN   | 已加固                   | `starting` 短 TTL；admission 异常释放 context 并回送 rejection       |

本次没有新增或修改 `dispatchState` 六态、`RUNNER_PROTOCOL_VERSION`、`execution.start` v1 schema、既有错误码、WP-A/WP-B 契约、Mock Runtime 语义、RealExecutor 仓库隔离、worktree/recovery 隔离或 P2-01 生命周期。唯一 Schema 变更是增量的 `Execution.cancelRequestedAt`。

**本报告只提供修复实现与可复现证据；WP-C 是否通过由新的独立只读审查决定。**

---

## 2. 修复基线与工作方式

- 从 `feature/p2-02-project-aware-runner` 的 `fd7852b` 继续，未修改 `main`。
- 未 rebase、未 force push、未删除历史、未覆盖 `P2-02_WP-C_INDEPENDENT_REVIEW.md`。
- 未创建 PR。
- 代码修复与测试在一个提交中；本报告在随后的独立文档提交中。
- 所有运行时验证在本地测试数据库或仓库外临时 SQLite 副本中执行，未触碰开发数据库。

---

## 3. 冻结边界合规确认

| 边界                        | 结论   | 说明                                                                                                                |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_PROTOCOL_VERSION`   | 未改   | `packages/contracts` 无变更                                                                                         |
| `execution.start` v1 schema | 未改   | 未新增/删除字段，未改变消息顺序语义                                                                                 |
| 六种 `dispatchState`        | 未改   | 仍为 `created`、`repository_preparing`、`repository_ready`、`start_sent`、`running`、`terminal`；取消用独立字段表达 |
| 既有错误码                  | 未改   | 复用 `REPOSITORY_CONTEXT_NOT_READY`、`REPOSITORY_CONTEXT_REJECTED` 等                                               |
| WP-A / WP-B 契约            | 未改   | 未修改绑定 DTO、校验协议或路径策略                                                                                  |
| Mock Runtime 语义           | 未改   | Mock 执行路径未进入 Runner 握手                                                                                     |
| RealExecutor 仓库隔离       | 未改   | worktree 创建、主 checkout 隔离、recovery 语义保持原样                                                              |
| P2-01 生命周期              | 未改   | 未修改 Task/Agent/Execution 的既有公开状态机                                                                        |
| API 重启后的取消意图        | 持久化 | `Execution.cancelRequestedAt` 落库，重启后可继续阻断握手                                                            |

---

## 4. F1 根因

原实现同时缺少两层保障：

1. **API 没有持久化取消意图。** 取消只发送 `execution.cancel` 并轮询终态；ACK 事务和 start 发送只检查 `status === 'running'`，因此取消后仍可能推进 `repository_preparing → repository_ready → start_sent` 并发送 `execution.start`。
2. **Runner 没有取消意图。** `release` 只删除已存在的 context；in-flight `prepare` 在多个 `await` 之后仍会写回 map。`executor.cancel` 在没有 session 时直接返回，取消被丢弃。

因此存在“操作员已取消，但 prepare 完成、accepted、start、spawn 继续发生”的窗口，违反计划 §6.5 不变量 2、3 与 §15 WP-C 退出标准。

---

## 5. F1 API 修复

### 5.1 持久化意图

- `Execution` 新增可空字段 `cancelRequestedAt`，由 Migration `20261111130000_p2_02_execution_cancel_intent` 增量添加。
- `RepositoryHandshakeService.requestCancel` 在 per-execution 锁内先执行幂等的 `updateMany` 写入意图，再中止 pending handshake、发送 `execution.cancel`。
- 历史行保持 `NULL`，表示“从未请求取消”，不需要回填。

### 5.2 串行化

`RepositoryHandshakeService.executionLocks` 为每个 `executionId` 维护 Promise 链。取消意图写入、repository 检查与发送、start 检查与发送都经过同一把锁：

- 取消先获得锁：dispatch 在锁内一定能读到 `cancelRequestedAt`，不会发送 repository/start。
- dispatch 先获得锁：start 已发送后才可能写入取消意图，此时取消走运行期终止路径，不会出现“取消后仍发送 start”。

### 5.3 四个检查点

1. **发送 `execution.repository` 前**：锁内重读 `status`、`dispatchState`、`cancelRequestedAt`，并用条件 `updateMany`（`dispatchState='created'` 且 `cancelRequestedAt IS NULL`）抢占 `repository_preparing`。
2. **repository ACK 事务内**：`recheckAndTransition` 在事务中重读执行行；`cancelRequestedAt` 非空直接抛 `RepositoryDispatchCancelledError`。状态更新本身也带 `cancelRequestedAt: null` 条件。
3. **进入 `start_sent` 前**：由 `repository_ready → start_sent` 的事务条件更新完成，条件包含 `cancelRequestedAt: null`；失败时区分 stale 与 cancelled。
4. **发送 `execution.start` 前**：锁内再次检查 `status`、`cancelRequestedAt` 和 `dispatchState === 'start_sent'`，通过后才调用 `sendEnvelope`。

### 5.4 迟到 ACK 与重启

- `onProtocolEvent` 在处理任何 repository/start ACK 前先读取持久化意图；命中则 reject pending，迟到事件不再推进状态。
- `execution.accepted` 的条件更新要求 `start_sent` 且 `cancelRequestedAt: null`；若取消在更新前提交，更新计数为 0，走取消分支而不是 `running`。
- 独立集成测试直接创建带 `cancelRequestedAt` 的 `running/created` 行并调用 `dispatch`，证明 API 重启场景下 dispatch 被拒绝且不发送任何消息。

### 5.5 单一失败写入者

- `failExecutionStart` 仍是启动期同步失败的唯一写入者，并在事务内检查 `cancelRequestedAt`；检测到取消时返回 `false`，不回滚 Task/Agent。
- `RepositoryDispatchCancelledError` 不进入 `failExecutionStart`；取消路径负责 `cancelled` 终态与 Task/Agent 语义，避免双重回滚。
- 无 repository 上下文且 `dispatchState='created'` 的预启动取消由 API 直接安全终结为 `cancelled`；已连接的 Runner 仍会收到 `execution.cancel`，没有 session 时由 Runner 回送 `execution.cancelled`。

---

## 6. F1 Runner 修复

`RepositoryContextManager` 与 `RunnerClient` 增加了完整的取消生命周期：

- **立即记录取消意图**：`cancel()` 同步写入 `cancelled` map，之后的 `prepare` 直接抛 `RepositoryContextCancelledError`。
- **中止 in-flight prepare**：每个 execution 的 prepare 持有 `AbortController` 与 generation；`cancel()` 递增 generation 并 abort。所有 Git 子进程通过 `execFile(..., { signal })` 接收中止。
- **每个 await 后检查**：`doPrepare` 在 validate、default branch、policy 复查、branch commit 之后都调用 `throwIfInvalidated`；最后一次检查与 `contexts.set` 之间不包含 `await`。
- **释放 Context**：`release()` 删除 context、删除 inflight 并 abort；`cancel()` 在 release 基础上永久记录意图。
- **阻止异步完成重新插入**：generation 不匹配或 signal 已 abort 时抛错，不会写回 map。
- **阻止迟到 repository 重建**：`prepare` 入口先检查 `cancelled`，迟到消息直接失败。
- **阻止后续 start admission**：`beginStart` 对已取消 execution 返回 `missing`；`runAdmission` 在开头、live admission 之后、`markStarted` 之前都检查取消。
- **无 Session 也确认取消**：`handleCancel` 在没有活跃 executor session 且是首次取消时直接发送 `execution.cancelled`。
- **有 Session 沿用终止逻辑**：仍调用 `executor.cancel`，由既有的进程终止、强杀与终态事件路径完成；不会重复发送终态。

---

## 7. F1 A–G 时序测试

新增 7 项测试，全部使用真实异步 gate（deferred/AbortController）与事件顺序断言，而非同步 mock 返回值：

| 用例 | 场景                                     | 关键断言                                                                                                                  |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A    | prepare 进行中取消                       | prepare 被中止；无 context 写回；无 repository.accepted；无 execution.accepted                                            |
| B    | repository accepted 之后、start 之前取消 | 迟到 start 得到 `REPOSITORY_CONTEXT_NOT_READY`；无 execution.accepted；`executor.start` 0 次；accepted 事件早于 cancelled |
| C    | 慢速 live admission 中取消               | 无 execution.accepted；无 start.rejected（取消路径拥有终态）；`executor.start` 0 次                                       |
| D    | 已有活跃 session 时取消                  | `executor.cancel` 恰好 1 次；恰好 1 个 execution.cancelled；无重复 accepted/rejected                                      |
| E    | 无 context、无 session 时取消            | 立即且仅发送一次 execution.cancelled；重复取消不产生第二个终态                                                            |
| F    | 并发重复 repository + 取消               | `policy.validate` 只调用 1 次；两个等待者都被取消；无 context、accepted、repository.rejected                              |
| G    | 取消后再收到迟到 repository 与 start     | context 仍为空；无 repository.accepted/accepted；start 被 rejected；`executor.start` 0 次                                 |

对应文件：`apps/runner/test/repository-handshake.spec.ts`。

API 侧新增 6 项集成测试，覆盖持久化意图、ACK 与 start 之间的取消、重启后的 dispatch 阻断、无上下文预启动取消、重复 ACK 幂等、F4 事务内 feature 丢失。

---

## 8. F2 修复：accepted 前的 live CLI admission

- `RunnerExecutor.canAdmit` 改为可同步或异步；`RunnerClient.runAdmission` 在 `markStarted` 和发送 `execution.accepted` 之前等待它完成。
- `RealExecutor.canAdmit` 在 `execution.start` 到达时执行 live `resolveExecutable` 与 `probeAuthentication`，不再把启动期能力缓存当作最终证据。
- 失败统一返回 `REPOSITORY_CONTEXT_NOT_READY`，消息前缀分别为 `CLI_NOT_INSTALLED:` 与 `CLI_NOT_AUTHENTICATED:`，由 Runner 发送 `execution.start.rejected`。
- admission 成功时缓存本次解析出的可执行文件路径，`start` 直接复用，避免 accepted 之后重新做“是否安装”的普通决策。
- `RealExecutor.start` 保留防御性 `resolveExecutable` 复查，但该复查只作为最后时刻竞态保护，不是正常 admission 失败路径。
- 现有错误码未新增；错误通过既有 `errorCode` 映射传递。

测试断言：

- 缓存显示 installed、live resolve 返回空：收到 `execution.start.rejected`，message 以 `CLI_NOT_INSTALLED:` 开头，`execution.accepted` 数量为 0，spawn 未被调用，auth probe 未被调用。
- live resolve 成功但认证失败：`CLI_NOT_AUTHENTICATED:`，accepted 数量为 0，spawn 未被调用。
- 因此不再存在 missing CLI 的 accepted-then-failed 路径。

---

## 9. F3 修复：并发 repository 幂等

- `RepositoryContextManager.inflight` 以 `executionId` 为键保存 Promise、请求指纹与 AbortController。
- 相同 executionId 与相同指纹的并发 `prepare` 共享同一个 Promise，只执行一次 validate/git，并返回同一个 `contextId`。
- 相同 executionId 但不同指纹立即返回 `REPOSITORY_CONTEXT_CONFLICT`，不取消第一个 prepare。
- Promise 的 `finally` 只清理仍指向自己的 inflight 条目；失败不会留下悬挂条目。
- `cancel()`/`release()` 删除 inflight 并 abort，所有等待者观察一致结果；取消后不允许重新建立上下文。
- `RunnerClient.handleRepository` 对取消错误不再发送 repository.rejected，避免与已发送的 `execution.cancelled` 竞争；冲突错误保留已有 context，便于 API 重试原请求时仍拿到同一 contextId；其他失败才 release。

API 侧：

- repository 重发复用同一 `messageId` 与同一 payload，Runner 返回同一 contextId。
- `acceptedRepository` 的事务和条件更新保证重复 ACK 不会重复推进；`execution.accepted` 对已 `running` 的重复事件幂等 resolve。
- 集成测试断言两次 ACK 后：只发送 1 次 `execution.start`、只产生 1 个 `repository_ready` 审计、只产生 1 个 `start_sent` 审计、`repositoryContextId` 与 Runner 上下文一致。

---

## 10. F4 加固：创建事务内的 live feature 检查

- `RuntimeRegistryService.hasLiveExecutionFeatures(runnerId)` 封装既有 live feature 判断。
- `ExecutionsService` 在创建 Execution 的 Prisma 事务内、写入 Execution 之前重读 live features；不满足时抛 `PROJECT_BINDING_UNSUPPORTED`（409）。
- 可行性预检仍保留作为快速失败，但不再承担最终一致性。
- 集成测试在 availability 预检之后、创建事务之前让同一 runnerId 重新注册并丢失执行 feature，断言：409、`Execution` 行数为 0、Task 状态不变、Agent 仍为 idle。

---

## 11. F5 加固：`starting` 生命周期与 admission 异常

- `RepositoryContextManager.sweep` 现在同时处理 `ready` 与 `starting`：`ready` 使用 10 分钟 TTL，`starting` 使用 60 秒短 TTL；`started` 继续豁免。
- `runAdmission` 增加外层 `try/catch`：
  - 非取消异常：`release(executionId)` 并发送 `execution.start.rejected`，不会让 context 永久停在 `starting`。
  - 已发送 accepted 或已取消：不再发送 rejection，避免与运行期/取消终态竞争。
- admission 失败分支原本就会 release；新增测试让 `executor.canAdmit` 抛错，断言 context 被释放。
- 另有测试把 `starting` 时间推进到 60 秒，断言 sweep 清理；`started` 不受影响。

---

## 12. Prisma Schema 与 Migration

### 12.1 Schema

`apps/api/prisma/schema.prisma` 的 `Execution` 增加：

```prisma
/// Durable operator cancel intent. Set before any Runner cancel message is
/// sent and checked by every pre-start handshake transition. It is an
/// internal field, not a substitute dispatch state.
cancelRequestedAt DateTime?
```

该字段不进入公开 Execution DTO，不替代 `dispatchState`，也不改变 Task/Agent/Execution 的公开状态机。

### 12.2 Migration

目录：`apps/api/prisma/migrations/20261111130000_p2_02_execution_cancel_intent/`

```sql
-- P2-02 WP-C closure: durable pre-start cancel intent.
-- Additive only. Historical rows keep NULL, meaning no cancel was requested.

ALTER TABLE "Execution" ADD COLUMN "cancelRequestedAt" DATETIME;
```

无数据回填、无表重建、无索引变更、无外键变更。旧行 `NULL` 表示没有取消意图，语义与修复前一致。

---

## 13. Migration 验证证据

验证在仓库外临时 SQLite 副本中执行，使用正式 `prisma migrate deploy` 工作流，不接触开发数据库。

| 场景                                                                                           | 结果                                                                                                  | 判定 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- |
| 空库执行 6 个 Migration                                                                        | 6 个全部应用，`All migrations have been successfully applied.`                                        | PASS |
| 空库重复 deploy                                                                                | `No pending migrations to apply.`                                                                     | PASS |
| 空库结构检查                                                                                   | `Execution.cancelRequestedAt` 存在；`PRAGMA integrity_check` 为 `ok`；`PRAGMA foreign_key_check` 为空 | PASS |
| 既有库（5 个基线 Migration + Workspace/Project/Agent/Task/Execution 数据）再应用本次 Migration | 历史 Execution 行保留，`cancelRequestedAt` 为 `null`；列存在                                          | PASS |
| 既有库重复 deploy                                                                              | `No pending migrations to apply.`                                                                     | PASS |

历史行验证输出：

```json
{
  "rows": [
    {
      "id": "e",
      "status": "running",
      "dispatchState": "repository_preparing",
      "cancelRequestedAt": null
    }
  ],
  "hasCancelRequestedAt": true
}
```

空库结构与完整性输出：

```json
{ "hasCancelRequestedAt": true, "integrity": [{ "integrity_check": "ok" }], "foreign": [] }
```

---

## 14. 质量门禁、阻断结论与复审请求

### 14.1 实际运行的测试与门禁

| 套件/门禁 | 命令                                                  | 结果                                                      |
| --------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Contracts | `pnpm --filter @raft-lite/contracts test`             | 109 passed，5 个测试文件                                  |
| API       | `pnpm --filter @raft-lite/api test`                   | 76 passed，6 个测试文件                                   |
| Runner    | `pnpm --filter @raft-lite/runner test`                | 138 passed，16 个测试文件                                 |
| Web       | `pnpm --filter @raft-lite/web test`（`--pool=forks`） | 41 passed，11 个测试文件                                  |
| Typecheck | `pnpm typecheck`                                      | contracts、api、runner、web 全部通过                      |
| Lint      | `pnpm lint`（`eslint . --max-warnings=0`）            | 0 error / 0 warning                                       |
| Format    | `pnpm format:check`                                   | `format:check passed (changed files are Prettier-clean).` |

测试总数：**364**（109 + 76 + 138 + 41），共 38 个测试文件。

### 14.2 spawn / accepted 阻断结论

- **缺少 CLI 时不得 accepted-then-failed**：F2 的 live admission 在 accepted 之前完成；测试断言 accepted 数量为 0、spawn 为 0，错误以 `execution.start.rejected` + `REPOSITORY_CONTEXT_NOT_READY` 返回。
- **取消后不得发送 repository/start**：API 的持久化意图、per-execution 锁与四处检查共同保证；A、B、E、G 四类 Runner 时序测试与 API 三项取消集成测试均断言无 `execution.repository`、无 `execution.start`、无 accepted、无 spawn。
- **取消后不得复活上下文**：generation + AbortController + 入口检查 + “最后检查与写入之间无 await”共同保证；A、F、G 断言 context 为空。
- **取消后不得重新准入**：`beginStart` 返回 `missing`，`runAdmission` 多处检查取消；B、C、G 断言 `executor.start` 为 0。
- **在本次测试覆盖的时序窗口内，spawn 只能发生在 accepted 之后且 admission 成功之后。** 若取消在 `execution.start` 已成功发送后才提交，则按运行期取消处理，由进程终止路径负责；这是协议中 start 发送作为线性化点的必然边界，不属于“取消后仍发送 start”。

### 14.3 并发 prepare 幂等结论

- 相同 executionId、相同 binding/policy/path 的并发 repository 消息共享同一个 in-flight Promise，只执行一次 prepare，只产生一个 `contextId`。
- 不同指纹的并发消息返回 `REPOSITORY_CONTEXT_CONFLICT`，不会破坏第一个 prepare。
- 取消/释放会 abort 共享操作并使 generation 失效，迟到完成不能写回。
- API 层重复 ACK 通过条件更新与幂等 resolve 收敛，不重复发送 start。

### 14.4 剩余风险等级

- P0：0
- P1：0（F1 已修复，等待独立复审确认）
- P2：0（F2、F3 已修复，等待独立复审确认）
- P3：0（F4、F5 已加固，等待独立复审确认）

复审边界内仍需注意：

1. 取消在 start 已发送之后到达时，Runner 已可能创建 session；此时按既有运行期取消/终止语义处理，不能承诺“未 spawn”。
2. API 进程在握手进行中重启时，WP-C 不负责自动恢复 `repository_preparing` 行；取消意图已持久化且能阻止后续 dispatch/start，完整恢复留给 WP-D。
3. 独立审查的非阻塞观察中，`matches` 的路径比较已按平台归一化（大小写与分隔符），但协议监听器异常不阻塞 pending 的既有观察不在本次修复范围内。

### 14.5 工作区、提交与远端状态

- 代码修复单独提交：`d8594a1cb474ffcdeb68f6e701fa6975d8fc9850`（`fix(p2-02): close WP-C handshake race conditions`）
- 本报告单独提交：`docs(p2-02): document WP-C closure remediation`
- 分支：`feature/p2-02-project-aware-runner`
- 未修改 `main`；未 rebase、未 force push、未删除历史；未创建 PR。
- 推送后工作区应为干净状态；最终 SHA 与远端同步状态以本次任务结束时的 `git status` / `git log` 为准。

### 14.6 复审请求

请新的独立只读审查至少覆盖：

1. F1 的 API 持久化意图、四处检查、锁串行化、迟到 ACK 不复活，以及 Runner A–G 时序测试。
2. F2 的 accepted 前 live CLI admission，确认 missing/auth 失败时 `acceptedCount=0`、`executor.start=0`。
3. F3 的并发 prepare 共享 Promise/contextId、冲突与取消清理，以及 API 重复 ACK 幂等。
4. F4 的事务内 feature 检查是否确实 zero-row。
5. F5 的 `starting` 短 TTL 与 admission 异常释放。
6. 全部质量门禁与 Migration 的空库/既有库/重复 deploy。

在复审给出结论前，本任务不宣布 WP-C PASS，不进入 WP-D。
