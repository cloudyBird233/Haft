# P2-02 WP-C 实施报告：Execution Repository Handshake

- 分支：`feature/p2-02-project-aware-runner`
- 基线 HEAD：`a48e62d4e18e6834c9fb5df18bd6ede9aee61134`
- 工作区：`D:\CODE\GIT\Haft-p2-02`
- 范围：WP-C（`execution.repository` → `execution.repository.accepted` → `execution.start` → `execution.accepted`）
- 明确未实现：WP-D（恢复/重连）、WP-E（UI/E2E/文档收尾）；未修改 roadmap、`execution.start` v1 schema、协议版本或错误码

## 1. 结论摘要

WP-C 已端到端落地。真实 API 在创建 Execution 后、发送 `execution.start` 前，必须完成 `execution.repository` 握手并收到与认证 Runner 关联的 `execution.repository.accepted`；Runner 在准入（上下文、策略、运行时、CLI、容量、重复执行）全部通过后才发送 `execution.accepted`，随后才允许 executor 启动 CLI。任一阶段失败都会在 API 侧由 `failExecutionStart` 单一写入终态，并回滚 Task/Agent，绝不发送 `execution.start`。

核心验收：

| 项目                                                      | 结果                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 消息顺序 `repository → accepted → start → accepted`       | PASS（集成测试按接收顺序断言）                                                              |
| 无 `execution.repository.accepted` 不发 `execution.start` | PASS（测试名：`never sends execution.start without a valid execution.repository.accepted`） |
| ACK 与认证 runnerId 关联                                  | PASS（inbound 所有权校验 + pending key）                                                    |
| 握手重试 t=0/2s/6s、15s 超时                              | PASS（同一 messageId、同一 payload、同一 sentAt）                                           |
| ACK 后事务性 Binding 复检                                 | PASS（版本/策略/规范路径/平台/在线/feature）                                                |
| 旧 Runner fail-closed                                     | PASS（`PROJECT_BINDING_UNSUPPORTED` 409，创建 Execution 之前）                              |
| 旧 `projectIds` 门禁移除                                  | PASS（门禁只使用实时 feature）                                                              |
| 测试                                                      | contracts 109、API 70（其中握手 18）、runner 124、web 41 全绿                               |
| 质量门禁                                                  | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 全部 PASS                                |

P0 未关闭项：0。P1 未关闭项：0（WP-B 的 P1-1 根因已在本工作包移除）。P2/后续项：WP-D 的重连恢复、`start_sent` 宽限、预启动阶段取消细化，以及 WP-E 的 E2E fixture/UI/文档收尾，见 §11。

## 2. 变更范围与文件清单

### 2.1 新增

| 文件                                                                                 | 作用                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/api/prisma/migrations/20261111120000_p2_02_repository_handshake/migration.sql` | 六个 Execution 列、两个索引、终态/运行中回填、审计表                |
| `apps/api/src/modules/runners/repository-errors.ts`                                  | `RepositoryDispatchError`（同步预启动失败，不写终态）               |
| `apps/api/src/modules/runners/repository-handshake.service.ts`                       | 握手状态机、重试/超时、ACK 关联、事务复检、审计、失败清理           |
| `apps/api/src/modules/runners/repository-state.ts`                                   | 平台感知的路径比较（win32 大小写不敏感 + 分隔符归一化；POSIX 精确） |
| `apps/runner/src/repository-context.ts`                                              | Runner 侧上下文管理、默认分支检查、10 分钟预启动 TTL                |
| `apps/runner/test/repository-handshake.spec.ts`                                      | 上下文/顺序/准入/取消/策略/重复 start 单测（11 个）                 |

### 2.2 修改

- Contracts：`packages/contracts/src/constants.ts`、`types.ts`、`test/phase2-vocabulary.test.ts`
- API：`prisma/schema.prisma`、`common/serializers.ts`、`modules/executions/executions.service.ts`、`modules/runners/runner-registry.service.ts`、`modules/runners/runners.module.ts`、`modules/runtime/runner-runtime.service.ts`、`modules/runtime/runtime-registry.service.ts`、`modules/test/test.service.ts`、`test/runner.integration.spec.ts`
- Runner：`executor.ts`、`fake-executor.ts`、`git-worktree.ts`、`real-executor.ts`、`runner-client.ts`，以及 4 个既有测试文件
- 未修改：`packages/contracts/src/runner-protocol.ts`、协议版本、错误码枚举、roadmap、既有 P2-01/P2-02 卡片

合计：20 个修改文件 + 6 个新增文件（不含本报告）。

## 3. Contracts 与 Execution DTO

- 新增冻结联合 `DISPATCH_STATES`：`created`、`repository_preparing`、`repository_ready`、`start_sent`、`running`、`terminal`，以及 `DispatchState` 和 `DISPATCH_STATE_LABELS`。
- `ExecutionDto` 增补六个字段（纯增量）：`repositoryPath`、`repositoryPolicyVersion`、`repositoryContextId`、`repositoryBaseCommit`、`repositoryPreparedAt`、`dispatchState`。
- `toExecutionDto` 映射六个字段；历史/异常行缺少 `dispatchState` 时回退 `created`，避免序列化 undefined。
- 新增 contracts 测试锁定六态顺序、标签完整性，以及 `terminal` 不属于用户可见 ExecutionStatus。
- 未新增协议消息、payload 字段、feature 名称或错误码；`execution.start` v1 与 `RUNNER_PROTOCOL_VERSION = 1` 保持不变。

## 4. Prisma schema、迁移与回填证据

### 4.1 Schema

- `Execution` 新增：`repositoryPath`、`repositoryPolicyVersion`、`repositoryContextId`、`repositoryBaseCommit`、`repositoryPreparedAt`、`dispatchState String @default("created")`。
- 索引：`@@index([dispatchState])`、`@@index([runnerId, dispatchState])`。
- 新增审计模型 `RepositoryHandshakeEvent`（`executionId`、`state`、`bindingVersion`、`policyVersion`、`code`、`message`、`createdAt`，`onDelete: Cascade`，`executionId+createdAt` 索引）。

### 4.2 迁移内容

- 仅新增列/索引/表，不重建表、不删除数据。
- `dispatchState` 默认 `'created'`。
- 回填规则：`status IN ('completed','failed','cancelled')` → `terminal`；`status = 'running'` → `running`。历史 `running`（含 mock）不会被 WP-C 重新握手；恢复归 WP-D。

### 4.3 验证证据

**空库**：使用 `DATABASE_URL=file:./.migration-check-empty.db` 执行 `prisma migrate deploy`，5 个迁移（含 WP-C）全部成功；PRAGMA 检查六个列均存在，两个 `dispatchState` 索引存在，`RepositoryHandshakeEvent` 表存在。

**已有数据库**：先用 WP-C 之前的 schema 建库，插入四条历史行，再执行 WP-C 迁移 SQL：

| id               | 迁移前 status | 迁移后 dispatchState |
| ---------------- | ------------- | -------------------- |
| `exec_running`   | `running`     | `running`            |
| `exec_completed` | `completed`   | `terminal`           |
| `exec_failed`    | `failed`      | `terminal`           |
| `exec_cancelled` | `cancelled`   | `terminal`           |

同时确认 `dispatchState` 的列默认值为 `'created'`。

## 5. API 握手状态机

### 5.1 顺序与状态迁移

成功路径：

1. `POST /api/tasks/:id/start` 在事务中创建 Execution（`dispatchState='created'`）。
2. `RepositoryHandshakeService.dispatch` 条件更新 `created → repository_preparing`，审计 `repository_preparing`。
3. 发送带 `messageId` 的 `execution.repository`（payload 来自 Execution 快照 + Binding 的 `path`/`policyVersion`）。
4. 收到 `execution.repository.accepted` 后，事务复检并条件更新 `repository_preparing → repository_ready`，写入 `repositoryPath`、`repositoryPolicyVersion`、`repositoryContextId`、`repositoryBaseCommit`、`repositoryPreparedAt`（API 接收时间）。
5. 同一事务链把 `repository_ready → start_sent`。
6. 发送 `execution.start`（schema 不变）。
7. 收到 `execution.accepted` 后条件更新 `start_sent → running`，审计 `running`。

测试通过 `repository → accepted → start → accepted` 的接收顺序验证；在 ACK 之前等待 300ms 并断言只收到 `execution.repository`。

### 5.2 重试与超时

- 发送时刻 t=0；重试 `t=2s`、`t=6s`；总超时 `15s`。
- 重试复用同一个 envelope 对象：`messageId`、`sentAt`、payload 完全一致；Runner 以 `executionId` 做幂等键。
- 收到 ACK 后立即清除重试与超时计时器；重复 ACK 不会重复迁移。
- 超时映射 `REPOSITORY_HANDSHAKE_TIMEOUT`；`start_sent` 后另有 20s `START_ACCEPT_TIMEOUT`。

### 5.3 ACK 关联

- inbound 事件先经过 `RunnerRegistryService.ownsExecution(runnerId, executionId)` 校验，再投递给握手服务。
- pending key 为 `runnerId:executionId`，因此 ACK 只能匹配最初选中的 Runner 连接。
- ACK 的 `executionId`、`projectId`、`bindingId`、`bindingVersion`、`defaultBranch`、`policyVersion`、`canonicalPath` 全部参与校验。

### 5.4 ACK 后事务性复检

在同一 `prisma.$transaction` 内完成：

- Execution 仍为 `running`，`runnerId`、项目/绑定/版本/默认分支与快照一致。
- Binding 仍存在；`status='ready'`；`bindingVersion` 与快照一致；`validatedBindingVersion === bindingVersion`。
- `validatedByRunnerId === 选中的 Runner`；`binding.platform === 实时 Runner.platform`。
- `policyVersion`、`canonicalPath` 非空且与预期一致（路径按平台比较）。
- 实时 Runner 仍在线、属于同一 Computer、仍宣告三个执行 feature。
- ACK 与 Binding 的 `policyVersion`、`canonicalPath`、`bindingVersion` 一致。

检查与条件更新在同一事务内，避免并发重新验证在检查与写入之间替换 Binding。更新使用 `updateMany(where: id + expected dispatchState)`，`count=0` 视为陈旧事件，不向后回滚状态。

### 5.5 审计

`RepositoryHandshakeEvent` 记录 `repository_preparing`、`repository_ready`、`start_sent`、`running`、`handshake_failed`。审计写入失败不会中断握手（best-effort）。

## 6. 失败语义与单一失败写入者

- `RepositoryHandshakeService` 不写终态，只抛 `RepositoryDispatchError(code, message, retryable)`。
- `ExecutionsService.failExecutionStart` 是同步预启动失败的唯一终态写入者：
  - 事务内再次确认 `status='running'`，条件更新为 `failed` + `phase='failed'` + `dispatchState='terminal'` + `failureReason`。
  - 同事务恢复 Task 原状态、Agent 原状态与 `lastActiveAt`。
  - 幂等：已经是终态时跳过，绝不二次回滚或覆盖既有原因。
- `failureReason` 形如 `CODE: message`，并避免 Runner 已带前缀时重复拼接。
- HTTP 响应为 `500 RUNTIME_START_FAILED`，`error.details = { code, retryable }`，便于 UI 展示具体 `REPO_*` / `PROJECT_BINDING_*`。
- `REPOSITORY_POLICY_CHANGED` 额外把 Binding 条件更新为 `unverified`，清空 `canonicalPath`/`validatedByRunnerId`/`validatedBindingVersion`/`policyVersion`，写入 `validationErrorCode`；只更新版本仍匹配的 Binding。
- 失败时向 Runner 发送 `execution.cancel`；Runner 释放上下文。
- 终态之后到达的 `execution.accepted` 不会复活执行（条件更新失败并记录 warning）。
- Mock Runtime 不变，创建时 `dispatchState='running'`；`failExecutionStart` 仍可复用同一终态写入路径；`finishExecution`/取消写入 `dispatchState='terminal'`。

## 7. 旧门禁移除与实时 Feature 门禁

- `RuntimeRegistryService` 删除 WP-B 的 `projectIds.includes(projectId)` 判断；`availability(computerId, _projectId)` 不再使用 `projectId`。
- 执行门禁改为实时注册信息 `hasLiveFeatures(runnerId, EXECUTION_REQUIRED_FEATURES)`：
  - `project-binding-v1`
  - `repository-handshake-v1`
  - `repository-path-policy-v1`
- 缺任一 feature 时 availability 返回 `available=false`、`reasonCode='PROJECT_BINDING_UNSUPPORTED'`；`runtimeUnavailable` 将其映射为 HTTP 409，且发生在 Execution 事务之前。因此旧 Runner 不会产生 Execution 行，也不会收到握手消息。
- 新 Runner 在 `RUNNER_IMPLEMENTED_FEATURES` 中同时宣告四个 feature：`project-binding-v1`、`repository-validation-v1`、`repository-path-policy-v1`、`repository-handshake-v1`；`projectIds` 仍恒为 `[]`，但不再参与门禁。
- `ExecutionsService` 预检额外要求 Binding 的身份与平台匹配实时 Runner（`validatedByRunnerId`、`binding.platform`），不匹配返回 409 `PROJECT_BINDING_NOT_READY`，且不创建 Execution。
- 未恢复 `HAFT_RUNNER_PROJECTS`、`--project`、`projectPaths` 或 cwd fallback；Runner 源码中仅在“已废弃环境变量”警告文本里出现旧变量名。

## 8. Runner 侧上下文、准入与执行器

### 8.1 RepositoryContextManager

- 以 `executionId` 为幂等键；相同参数（项目/绑定/版本/策略/默认分支/配置路径，路径按平台比较）返回同一 `contextId`。
- 同 `executionId` 不同参数返回 `REPOSITORY_CONTEXT_CONFLICT`，且不覆盖已有上下文。
- `policyVersion` 与当前 Runner 策略不一致 → `REPOSITORY_POLICY_CHANGED`。
- 先执行 `RepositoryPathPolicy.validate`，再执行默认分支检查，最后再次 `assertStillAllowed`（TOCTOU）。
- 默认分支检查只在上下文准备阶段，使用 `execFile` 单参数、无 shell：
  1. `git check-ref-format --branch <branch>`
  2. `git rev-parse --verify --quiet refs/heads/<branch>^{commit}`
     任一步失败 → `REPO_DEFAULT_BRANCH_NOT_FOUND`。
- 通过 `git rev-parse --verify refs/heads/<branch>^{commit}` 记录 `baseCommit`。
- 预启动 TTL 为 10 分钟；后台每 60s 仅清扫 `ready` 且超过 TTL 的上下文，`starting`/`started` 不清扫。`execution.cancel`、完成、失败、取消都会释放上下文。

### 8.2 准入先于 accepted

`RunnerClient.handleStart` 在发送 `execution.accepted` 之前依次检查：

1. 上下文存在且状态可获取（缺失 → `REPOSITORY_CONTEXT_NOT_READY`）。
2. 上下文 `policyVersion` 与实时策略一致（变化 → `REPOSITORY_POLICY_CHANGED`）。
3. `policy.assertStillAllowed(canonicalPath)` 重新校验包含关系与隔离。
4. `executor.canAdmit`：运行时启用、容量、无重复执行。
5. real 模式：CLI 已安装且已认证；竞态失败使用 `REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_INSTALLED:`/`CLI_NOT_AUTHENTICATED:` 前缀，不新增错误码。

任一失败：释放上下文、发送 `execution.start.rejected`，不发送 accepted、不 spawn。重复 start 在 `starting` 时等待同一次准入；`started` 后只重发 accepted，绝不二次 spawn。准入成功后先发送 `execution.accepted`，再调用 `executor.start(payload, context)`。

### 8.3 Executor

- `FakeExecutor` 使用上下文中的规范路径，但保持合成行为（不调用真实 CLI）。
- `RealExecutor`：
  - 只使用上下文 `canonicalPath` 与 `baseCommit`，绝不回退 cwd 或 `projectPaths`。
  - 在写 journal / 创建 worktree 之前再次 `assertStillAllowed`。
  - worktree 位于 `worktreeRoot` 下且与仓库互不包含；recovery journal 位于 `recoveryRoot` 下且与仓库互不包含；`GitWorktreeManager` 拒绝任一方向的重叠。
  - 无上下文时在创建 session/journal/worktree 之前失败（`REPOSITORY_CONTEXT_NOT_READY`），保持 fail-closed。

## 9. Runner 替换、平台匹配与策略变更

- 预检（创建 Execution 前）和 ACK 后复检都要求：
  - `binding.validatedByRunnerId === 选中的实时 Runner id`
  - `binding.platform === 实时 Runner.platform`
    任一不匹配 → `PROJECT_BINDING_NOT_READY`；不切换 Runner、不发送 `execution.start`。
- 同一 `runnerId` 但实时平台变化（例如 win32 → linux）同样被拒绝；测试覆盖平台不匹配和“绑定由另一个 Runner 验证”两种场景。
- Binding 版本变化 / 规范路径变化 → `REPOSITORY_BINDING_CHANGED`。
- 策略版本变化或 Runner 上报不同策略 → `REPOSITORY_POLICY_CHANGED`；Binding 置为 `unverified` 并要求重新验证。
- 路径比较由 `repository-state.ts` 完成：`win32` 大小写不敏感、反斜杠归一化；POSIX 精确比较；不使用 API 主机的 `path.resolve` 解释 Windows Runner 路径。
- 一旦 `execution.start` 已发送，后续 Binding 编辑只影响新 Execution，不影响当前快照。

## 10. 测试与质量门禁

| 命令                                      | 结果                                       |
| ----------------------------------------- | ------------------------------------------ |
| `pnpm --filter @raft-lite/contracts test` | 5 文件 / 109 tests passed                  |
| `pnpm --filter @raft-lite/api test`       | 6 文件 / 70 tests passed（runner 集成 18） |
| `pnpm --filter @raft-lite/runner test`    | 16 文件 / 124 tests passed                 |
| `pnpm --filter @raft-lite/web test`       | 11 文件 / 41 tests passed（回归）          |
| `pnpm typecheck`                          | contracts / api / runner / web 全部 passed |
| `pnpm lint`                               | passed（0 error / 0 warning）              |
| `pnpm format:check`                       | passed（本次变更文件均为 Prettier-clean）  |

### 10.1 WP-C API 集成测试（18 项中的新增/改写）

- `never sends execution.start without a valid execution.repository.accepted`：顺序、ACK 前无 start、快照字段、审计事件序列。
- `retries execution.repository with the same messageId and payload`：同一 `messageId`/`sentAt`/payload，重复 ACK 只产生一次 `repository_ready`。
- `fails the execution when the repository ACK does not match the binding`：`REPOSITORY_CONTEXT_MISMATCH`、终态、取消、Task/Agent 回滚、迟到 accepted 不复活。
- `unverifies the binding and fails when the policy changes after the ACK`：`REPOSITORY_POLICY_CHANGED`、Binding `unverified`、无 start。
- `rejects a binding validated by another runner or platform before creating an execution`：两种 `PROJECT_BINDING_NOT_READY`、无 Execution 行。
- `fails and cancels when the runner rejects execution.start`：`execution.start.rejected` → 终态、具体 `failureReason`、取消。
- `pairs, registers, and exposes runtime availability without a project map`：旧 `PROJECT_NOT_MAPPED` 不再出现，任意 projectId 均可用。
- `rejects a runner that does not advertise the execution handshake features`：`PROJECT_BINDING_UNSUPPORTED`。
- 既有测试全部保留并通过（完整执行、日志、diff、取消、重连快照、所有权、绑定 CRUD 无消息等）。

### 10.2 Runner 单测

新增 `apps/runner/test/repository-handshake.spec.ts`（11 项）：上下文幂等/冲突/策略/TTL/默认分支/具体错误码、消息顺序、无上下文拒绝 start、取消释放、策略拒绝、重复 start 幂等。既有 fake/real executor、worktree、runner-client 校验测试同步更新并通过。

### 10.3 迁移验证

见 §4.3：空库 `migrate deploy` 与“已有数据 + 手工执行迁移 SQL”均通过；历史终态/运行中行回填符合预期。

### 10.4 未运行项（明确记录）

- Playwright Fake Runner E2E 未运行：WP-E 才负责基于真实临时 Git 仓库的 fixture、`HAFT_RUNNER_ALLOWED_ROOTS`/worktree/recovery 配置和 UI 收尾；本工作包不放宽该边界。状态记为 `NOT_VERIFIED`，不是静默跳过。
- Real CLI E2E 未运行：需要真实 CLI/认证，归 WP-E 的验收范围。

## 11. 冻结边界、非目标与遗留风险

### 11.1 合规确认

- 未修改 `execution.start` v1 schema、`RUNNER_PROTOCOL_VERSION`、协议消息/字段、feature 注册表或错误码。
- 未实现 WP-D/WP-E；未修改 roadmap 或 P2-02 卡片。
- 未恢复 `HAFT_RUNNER_PROJECTS`、`--project`、`INIT_CWD`、`process.cwd()` 或 projectIds 映射作为仓库选择机制。
- Mock Runtime 行为不变，仅持久化 `dispatchState='running'`。
- 未删除或弱化既有测试；只新增测试并更新因握手顺序而必须调整的测试辅助逻辑。

### 11.2 严重级别状态

| 级别 | 状态           | 说明                                                                          |
| ---- | -------------- | ----------------------------------------------------------------------------- |
| P0   | 0 未关闭       | 无已知安全/正确性缺口                                                         |
| P1   | 0 未关闭       | WP-B P1-1（旧 `PROJECT_NOT_MAPPED` 门禁）根因已随旧门禁移除；本工作包测试全绿 |
| P2   | 转入 WP-D/WP-E | 见下                                                                          |

### 11.3 WP-D 注意事项

- `start_sent` 断线后的 30s `RUNNER_START_UNCONFIRMED` 宽限未实现；当前快照对账会跳过 `start_sent` 并记 warning，不会误报 `RUNNER_RESTARTED`。
- `repository_preparing`/`repository_ready`/`start_sent` 的重连重发与 API 重启恢复归 WP-D；WP-C 仅保证不把预启动行误判为丢失。
- 预启动阶段的操作员取消尚未与握手的 `noteTerminal` 完全联动，可能出现取消等待/409 超时；WP-D 需细化。
- 多 API 实例下 pending map/timer 非分布式；SQLite 单实例范围外，属 Phase 3+ 关注点。

### 11.4 WP-E 注意事项

- 需要基于真实临时 Git 仓库重做 Fake Runner E2E fixture，并配置 allowed roots/worktree/recovery 隔离。
- UI 需展示新增的六个字段与 `dispatchState`，并对 `PROJECT_BINDING_*`/`REPO_*` 给出可操作文案。
- `docs/api.md`、`docs/runner-protocol.md`、`docs/runner-setup.md`、`docs/data-model.md`、`docs/execution-recovery.md`、`docs/testing.md` 的 P2-02 文档更新归 WP-E。

## 12. 提交与验证结论

- 实现提交：`feat(p2-02): implement WP-C execution repository handshake`，SHA：`1eedb987deae0a9fcc6d2b540cebf9bc364e2ba3`。
- 本报告随独立的 `docs(p2-02): add WP-C implementation report` 提交保存；分支推送后由最终交付说明给出两个 SHA 与远端状态。
- 工作区在提交前仅包含 WP-C 代码、测试、迁移与本报告；未提交构建产物、数据库文件或临时迁移检查文件。
- 结论：WP-C 范围内 P0/P1 清零，核心不变量与顺序验收通过；WP-D/WP-E 边界保持未实现，等待后续工作包。
