# P2-02 WP-C 独立审查报告：Execution Repository Handshake

| 项目              | 内容                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| 审查对象          | Haft P2-02 WP-C — Execution Repository Handshake                                    |
| 分支              | `feature/p2-02-project-aware-runner`                                                |
| 被审查提交        | `1eedb987deae0a9fcc6d2b540cebf9bc364e2ba3`                                          |
| 冻结基线          | `a48e62d4e18e6834c9fb5df18bd6ede9aee61134`                                          |
| 审查时主仓库 HEAD | `c2f2987d7264236659b19ae4d9e32f6c86b742b4`（相对被审查提交仅多 WP-C 实现报告）      |
| 审查日期          | 2026-11-11                                                                          |
| 审查方式          | 严格只读代码审查 + 独立测试运行 + 仓库外迁移探针 + 临时 Runner 探针（运行后已删除） |
| 总体结论          | **FAIL（WP-C 范围）**                                                               |
| WP-D 准入         | **不可开始**：F1 未修复前，取消/恢复语义没有可靠基础                                |

> 本报告只新增文档，没有修改产品代码、现有测试、roadmap 或实施计划。实现报告中的 PASS 与测试计数未被当作证据；下列结论来自独立阅读、运行和探针。

---

## 1. 审查结论

**总体结论：FAIL。**

WP-C 的正常握手主路径、状态机条件更新、迁移、契约兼容性和现有测试门禁整体质量较好，但存在一个 P1 级不变量违反和两个 P2 级退出标准/幂等缺陷：

| ID  | 级别 | 结论               | 摘要                                                                                                                                                                                                          |
| --- | ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P1   | **FAIL**           | 预启动阶段的操作员取消不会持久化到 Runner/API 状态机；取消可能被丢弃，API 仍会发送 `execution.start`，Runner 仍可能 spawn CLI。                                                                               |
| F2  | P2   | **FAIL**           | Runner 只用启动时缓存的 CLI 能力做 admission；CLI 在启动后消失时，仍会先发 `execution.accepted`，之后才以 `CLI_NOT_INSTALLED` 失败，违反 §8.9 / AC-15B“绝不 accepted-then-failed”。                           |
| F3  | P2   | **FAIL**           | `execution.repository` 的 2s/6s 重试与 Runner 的异步 `prepare` 没有 in-flight 去重；并发重复 prepare 可能生成不同 `contextId`，违反 §11.2/§11.3 的 executionId 幂等要求，并可能把一次本可成功的握手变成失败。 |
| F4  | P3   | PASS WITH WARNINGS | live feature 检查在创建 Execution 的预检中，但不在创建事务内；Runner 在窗口内降级 feature 时会先创建再失败，违反 G7 的“zero Execution rows”期望（窄竞态）。                                                   |
| F5  | P3   | PASS WITH WARNINGS | `state='starting'` 的上下文不在 TTL sweep 范围内；admission 出现意外异常时该上下文会永久留在内存中，违反 §9.8“starting 必须转为 started 或被 release”。                                                       |

**为什么测试全绿仍是 FAIL：** 现有测试覆盖的是“取消发生在 repository.accepted 之后”、顺序重发、静态缺 feature 等场景；F1/F2/F3 都位于测试未覆盖的时序窗口，F2 甚至没有 `CLI_NOT_INSTALLED` 的测试引用。测试通过只能证明已覆盖路径正确，不能证明冻结不变量成立。

**WP-C 退出标准：** §15 的 10 条中，第 5 条（missing CLI 必须 `execution.start.rejected`，不能 accepted-then-failed）直接失败；§6.5 的第 2、3 条（cancel 中止准备/不 spawn、cancel 后不发 start）直接失败。因此 WP-C 不能签署完成。

**WP-D 准入：** **不可开始。** WP-D 的恢复矩阵以 `dispatchState` 和取消/终止语义为基础；在 F1 修复前开始 WP-D，会把“取消被丢弃后仍 spawn”的语义带入恢复路径。F2/F3 必须在 WP-C 收尾时修复；F4/F5 可作为 WP-D 前的低优先级加固。

**P0/P1/P2/P3 统计：** P0 = 0，P1 = 1，P2 = 2，P3 = 2（另有 2 条非阻塞观察，不计入 Findings）。

---

## 2. 审查范围、基线与工作方式

### 2.1 提交与工作树

- 冻结基线：`a48e62d4e18e6834c9fb5df18bd6ede9aee61134`（WP-A 完成）。
- 被审查提交：`1eedb987deae0a9fcc6d2b540cebf9bc364e2ba3`（WP-C 实现）。
- 分支：`feature/p2-02-project-aware-runner`。
- 审查时主仓库 HEAD：`c2f2987d7264236659b19ae4d9e32f6c86b742b4`，相对 `1eedb98` 只多 `docs/engineering/P2-02_WP-C_IMPLEMENTATION_REPORT.md`（281 行新增）。
- 独立审查工作树：`D:\CODE\GIT\Haft-p2-02-wpc-review`，detached HEAD 位于 `1eedb98`。所有测试、迁移探针和 Runner 探针都在该工作树运行；主仓库在产品代码上保持干净。

### 2.2 独立阅读范围

产品代码与配置：

- `apps/api/src/modules/runners/repository-handshake.service.ts`（新增，877 行）
- `apps/api/src/modules/runners/runner-registry.service.ts`
- `apps/api/src/modules/runners/repository-errors.ts`、`repository-state.ts`
- `apps/api/src/modules/executions/executions.service.ts`
- `apps/api/src/modules/runtime/runner-runtime.service.ts`、`runtime-registry.service.ts`
- `apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/20261111120000_p2_02_repository_handshake/migration.sql`
- `apps/runner/src/repository-context.ts`（新增，262 行）
- `apps/runner/src/runner-client.ts`、`real-executor.ts`、`fake-executor.ts`、`executor.ts`、`git-worktree.ts`
- `packages/contracts/src/constants.ts`、`types.ts`、`runner-protocol.ts`（确认未改）

测试与证据：

- `apps/api/test/runner.integration.spec.ts`
- `apps/runner/test/repository-handshake.spec.ts`、`real-executor.spec.ts`、`fake-executor.spec.ts`、`repository-policy.spec.ts` 等
- `docs/engineering/P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md`：§6.3、§6.5、§8.6–§8.11、§9.8、§9.9、§10.2、§11.2、§14.7、§15 WP-C、§18.2
- `docs/phase-2-technical-roadmap.md` 的 P2-02 卡片边界
- WP-A 独立审查、WP-B 独立审查、WP-C 实现报告（只作为被审查声明，不作为证据）

### 2.3 只读声明与探针

- 审查期间没有修改 `1eedb98` 中的产品代码或现有测试。
- 为验证 F1，临时创建了 `apps/runner/test/zz-wpc-review-probe.spec.ts`，单独运行 1/1 通过后立即删除；`git status --short` 恢复为空。
- 迁移探针在 `C:\Users\A11720\AppData\Local\Temp\opencode\haft-wpc-review-*` 的仓库外副本中运行，不接触主仓库或开发数据库。
- 本报告是审查结束后唯一新增的受版本控制文件。

### 2.4 不在本次范围

- WP-D 的恢复扫描、重连矩阵、`RUNNER_START_UNCONFIRMED` 30s grace、API 重启恢复。
- WP-E 的 Playwright Fake Runner E2E、真实 CLI E2E、UI 和文档收尾。
- WP-B 已审查的路径策略细节；本报告只检查 WP-C 是否把该策略接入握手/执行路径。
- 多 API 实例、分布式 pending map/timer（计划 §18.2 明确为 Phase 3+）。

按用户要求，WP-D/WP-E 未实现本身不作为 WP-C 缺陷；只有 WP-C 已经导致错误状态、重复启动、泄漏或不安全行为时才计入 Findings。F1 正是“取消后仍可能 spawn”的不安全行为，因此属于 WP-C，而不是 WP-D 的范围豁免。

---

## 3. 证据分级与验证方法

本报告把证据分成四类，避免把“文件存在”或“实现报告声称”当成“已验证”：

| 类别           | 含义                                   | 本报告中的例子                                                                                                              |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 实际运行       | 本次独立执行命令并读取输出             | contracts 109、runner 124、API 70、web 41；typecheck/lint/format；fresh/existing DB 的 `prisma migrate deploy`；F1 临时探针 |
| 代码/迁移实证  | 逐行阅读代码或直接查询数据库结构       | 取消路径、admission 顺序、条件更新、迁移列/索引/回填                                                                        |
| 仅存在性核对   | 只确认文件/字段/测试名存在，未证明行为 | 部分错误码、DTO 字段、计划条款的交叉引用                                                                                    |
| 报告声明未采信 | 实现报告或注释声称，但本次未独立证明   | 实现报告声称“missing CLI 在 accepted 前拒绝”；本次代码显示并非如此                                                          |

关键命令与结果在 §13 集中列出。所有测试命令都带 `--filter`，只运行对应 workspace；没有运行完整 Playwright E2E，也没有运行真实 CLI。

---

## 4. 要求与不变量对照

> 判定只使用 **PASS / PASS WITH WARNINGS / FAIL**。证据列中的行号均指被审查提交 `1eedb98` 的文件行号。

| #   | 要求/不变量                                                                                                                | 判定                   | 证据与说明                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 成功顺序必须是 `execution.repository → execution.repository.accepted → execution.start → execution.accepted`               | **PASS**               | API 在 `repository-handshake.service.ts:221-254` 先 await repository ACK，再发 start；Runner 在 `runner-client.ts:621-627` 先发 accepted 再调用 executor；测试 `repository-handshake.spec.ts:266-308`。                                                                       |
| 2   | 没有有效 `execution.repository.accepted` 时绝不发送 `execution.start`                                                      | **PASS**               | `dispatch` 在 `repository-handshake.service.ts:221-225` await `repositoryDeferred`；API 测试 `runner.integration.spec.ts:911-983` 断言 no-start-without-accepted。                                                                                                            |
| 3   | 没有 `execution.accepted` 时绝不 spawn CLI                                                                                 | **PASS**               | Runner 在 `runner-client.ts:621-627` 先 `send('execution.accepted')`，再 `executor.start`；`RealExecutor.start` 只在之后创建 session。正常 admission 路径满足。                                                                                                               |
| 4   | `RUNTIME_NOT_ENABLED`、`RUNNER_BUSY`、context-not-ready 必须 `execution.start.rejected`，不得 spawn                        | **PASS**               | `runner-client.ts:578-619` 在 `markStarted`/accepted 前完成 context、policy、`canAdmit` 检查；`admissionFailure` 失败即 release + `sendStartRejected`；测试 `repository-handshake.spec.ts:310-331`。                                                                          |
| 5   | missing CLI 也必须 `execution.start.rejected`，**绝不 accepted-then-failed**（§8.9、AC-15B）                               | **FAIL**               | Runner 只检查启动时缓存的 `runtimeCapabilities`（`runner-client.ts:669-691`）；live `resolveExecutable` 在 accepted 之后的 `real-executor.ts:359-365`。见 F2。                                                                                                                |
| 6   | binding/policy 在握手期间变化必须 start 前失败并 cancel                                                                    | **PASS**               | `recheckAndTransition` 在事务内重读 execution/binding、校验版本/policy/canonicalPath（`repository-handshake.service.ts:519-660`）；API 测试 `runner.integration.spec.ts:1029-1147`。                                                                                          |
| 7   | 缺失 `Project.defaultBranch` 必须在 `execution.repository` 被 `REPO_DEFAULT_BRANCH_NOT_FOUND` 拒绝，早于 `execution.start` | **PASS**               | `RepositoryContextManager.prepare` 在 `repository-context.ts:95` 调 `assertDefaultBranch`；测试 `repository-handshake.spec.ts:227-240`。                                                                                                                                      |
| 8   | binding 必须在预检和 accepted 后的事务内同时满足 runner identity + platform                                                | **PASS**               | 预检 `executions.service.ts:226`、创建事务内 `executions.service.ts:308`；`assertBindingRunnerIdentity` 读 live registration（`executions.service.ts:1172-1205`）；ACK 后 `repository-handshake.service.ts:560-563`、`670-689`。测试 `runner.integration.spec.ts:1148-1213`。 |
| 9   | start 发出后，后续 binding 编辑不得影响当前 execution                                                                      | **PASS**               | Execution 快照字段在创建事务写入（`executions.service.ts:317-322`）；handshake 使用快照比较（`repository-handshake.service.ts:539-542`）；start 后不再重读 binding 来改变 payload。                                                                                           |
| 10  | 旧 Runner（缺少 handshake features）必须在创建 Execution 前返回 409                                                        | **PASS**               | `runtime-registry.service.ts:179-183` 在 availability 中检查 live features；`executions.service.ts:210-217` 在创建前调用；测试 `runner.integration.spec.ts:305-322`（只测 availability，未测 POST 的 zero-row，见 F4）。                                                      |
| 11  | 预启动取消必须 abort preparation、release context、**不 spawn CLI**（§6.5 第 2 条）                                        | **FAIL**               | `execution.cancel` 只做 `release` + `executor.cancel`（`runner-client.ts:358-361`）；`release` 只删除已存在条目（`repository-context.ts:144-146`），in-flight `prepare` 会在之后插入；无 session 时 `executor.cancel` no-op（`real-executor.ts:192-196`）。见 F1。            |
| 12  | API 在 cancel 后绝不发送 `execution.start`（§6.5 第 3 条）                                                                 | **FAIL**               | `cancel` 不改变 execution 的 status/dispatchState（`executions.service.ts:510-529`），`acceptedRepository`/`recheckAndTransition` 只要求 `status === 'running'`（`repository-handshake.service.ts:519-548`），因此 cancel 后仍可进入 `start_sent` 并发送 start。见 F1。       |
| 13  | 预启动 context TTL：`ready` 10 分钟清理；`started` 豁免；`starting` 必须短命并转为 started/release（§9.8）                 | **PASS WITH WARNINGS** | `sweep` 只处理 `state === 'ready'`（`repository-context.ts:153-161`）；`starting` 在 `beginStart` 设置（`127-135`），正常路径会转为 started 或 release，但异常路径没有清理。见 F5。                                                                                           |
| 14  | ACK 丢失时重发同一 `messageId`/payload；API 只完成一次状态迁移                                                             | **PASS**               | `armRepositoryTimers` 2s/6s 重发同一 `repositoryMessage`（`repository-handshake.service.ts:463-485`）；条件 `updateMany` 防止重复迁移；测试 `runner.integration.spec.ts:984-1028`。                                                                                           |
| 15  | Runner 对同一 `executionId` + 相同 bindingVersion/policyVersion/path 必须返回**同一 contextId**                            | **FAIL**               | `prepare` 只在入口检查 map，之后 await 多个 git 操作才插入（`repository-context.ts:61-124`）；没有 in-flight promise map；API 的 2s 重试可在第一次 prepare 完成前启动第二次。见 F3。                                                                                          |
| 16  | 所有 dispatchState 迁移使用条件 update，不得回退                                                                           | **PASS**               | `acceptedRepository` 两次 `recheckAndTransition`（`repository-handshake.service.ts:498-504`）；`updateMany` 以 `dispatchState` 为条件（`636-660`）；`execution.accepted` 以 `start_sent` 为条件（`753-777`）。                                                                |
| 17  | 同步预启动失败只能由 `failExecutionStart` 写终态，幂等并回滚 Task/Agent                                                    | **PASS**               | `executions.service.ts:689-769`；`updateMany` 以 `status='running'` 为条件；二次调用跳过；测试 `runner.integration.spec.ts:1214-1263`。                                                                                                                                       |
| 18  | `finishExecution` 必须写 `dispatchState='terminal'` 并终止 pending handshake                                               | **PASS**               | `executions.service.ts:920-948` 写 terminal；`977` 调 `noteTerminal`；`noteTerminal` 拒绝 pending（`repository-handshake.service.ts:124-136`）。                                                                                                                              |
| 19  | inbound ACK 必须绑定认证后的 `runnerId`，不能由其他 Runner 伪造                                                            | **PASS**               | `runner-registry.service.ts:556-611` 先用 `ownsExecution(runnerId, executionId)`，再发出带 runnerId 的 protocol event；pending key 为 `runnerId:executionId`（`repository-handshake.service.ts:446`、`707-720`）；测试 `runner.integration.spec.ts:839-910`。                 |
| 20  | live feature 丢失时 G7 要求 409 `PROJECT_BINDING_UNSUPPORTED` 且 zero Execution rows                                       | **PASS WITH WARNINGS** | 正常静态场景满足；但 feature 检查在创建事务外，窗口内降级会先建行再失败。见 F4。                                                                                                                                                                                              |
| 21  | 重连/重启恢复矩阵（WP-D）                                                                                                  | **PASS WITH WARNINGS** | WP-C 故意不实现 startup scan/30s grace（`repository-handshake.service.ts:90-91`、`runner-registry.service.ts:872-883`）；这是 WP-D 范围，本次不作为 WP-C 缺陷，但不能据此认为恢复语义已验证。                                                                                 |

**对照结论：** 主路径和大多数防护是 PASS；第 5、11、12、15 条失败，对应 F1/F2/F3；第 13、20 条是 F5/F4 的警告。第 5、11、12 条是计划明确写的冻结不变量，不是“WP-D 未完成”可以解释的。

---

## 5. 变更范围与架构边界

### 5.1 变更规模

`git diff --stat a48e62d..1eedb98` 的结果：

- 27 个文件变更，3031 行新增，254 行删除。
- 新增 4 个产品文件：
  - `apps/api/src/modules/runners/repository-handshake.service.ts`
  - `apps/api/src/modules/runners/repository-errors.ts`
  - `apps/api/src/modules/runners/repository-state.ts`
  - `apps/runner/src/repository-context.ts`
- 新增 1 个迁移：`apps/api/prisma/migrations/20261111120000_p2_02_repository_handshake/migration.sql`
- 修改 contracts、API、Runner、测试和 DTO；没有修改 `docs/phase-2-technical-roadmap.md` 或实施计划。
- 没有修改 `packages/contracts/src/runner-protocol.ts`、`RUNNER_PROTOCOL_VERSION`、`execution.start` v1 schema 或错误码注册表。
- 没有实现 WP-D 的恢复扫描/重连矩阵，也没有实现 WP-E 的 Playwright fixture、UI、真实 CLI E2E 和文档收尾。

### 5.2 架构接线

WP-C 把原来的 `RunnerRegistryService.dispatchStart` 直发路径替换为：

`ExecutionsService.startForTask` → `RuntimeRegistryService.start` → `RunnerRuntimeService.start` → `RepositoryHandshakeService.dispatch` → `execution.repository` → ACK → `execution.start` → `execution.accepted`。

关键点：

- `RunnerRuntimeService` 只负责构造 prompt 和把 `runnerId/executionId/runtime/...` 交给 handshake；不再直接发 `execution.start`（`runner-runtime.service.ts:26-46`）。
- `RuntimeRegistryService.availability` 删除了旧的 `projectIds.includes(projectId)` 门禁，改为 live features 门禁（`runtime-registry.service.ts:158-183`），与 WP-B 的“移除 project map”一致。
- `RepositoryHandshakeService` 是唯一持有 pending map、repository/start 两层 deferred、重试/超时定时器和 `noteTerminal` 的服务。
- `ExecutionsService.failExecutionStart` 仍是同步预启动失败的唯一终态写入者；handshake 只抛 `RepositoryDispatchError`，不直接写 `failed`/`terminal`（`repository-errors.ts:3-18`、`executions.service.ts:689-769`）。
- Runner 侧新增 `RepositoryContextManager`，并把 `RepositoryPathPolicy` 传入 `RealExecutor`，在 `prepareAndRun` 的 journal/worktree 写入前再次 `assertStillAllowed`（`real-executor.ts:314-323`）。
- `GitWorktreeManager.prepare` 增加 `baseCommit` 参数，并增加 repository/worktree 双向包含检查（`git-worktree.ts:54-121`）。

### 5.3 边界判断

**PASS。** WP-C 没有越界实现 WP-D/E；没有恢复扫描、没有 30s `RUNNER_START_UNCONFIRMED`、没有 Playwright fixture 重写。`apps/api/src/modules/test/test.service.ts` 的改动是测试辅助：为 test-only 的 `markProjectBindingReady` 补齐 `canonicalPath`、`policyVersion`、`platform`、`validatedByRunnerId`，使 P2-02 预检可用；它不是生产路径的行为变更。

需要明确记录的是：`test.service.ts` 把 `canonicalPath` 直接设为 `binding.path`，这不是生产 canonicalization；它只服务于测试，不能作为“canonicalPath 已验证”的证据。

---

## 6. 契约、DTO 与协议兼容性

### 6.1 Contracts 变更

| 变更                                                                                                                                                    | 位置                                                     | 判断                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 `DISPATCH_STATES` 六态及 `DispatchState` 类型                                                                                                      | `packages/contracts/src/constants.ts:31-49`              | **PASS**：顺序与计划 §7.2 一致，`terminal` 不进入 `EXECUTION_STATUSES`。                                                                                      |
| 新增 `DISPATCH_STATE_LABELS`                                                                                                                            | 同上                                                     | **PASS**：六个状态均有 label，测试 `phase2-vocabulary.test.ts:115-138`。                                                                                      |
| `ExecutionDto` 增加 `repositoryPath`、`repositoryPolicyVersion`、`repositoryContextId`、`repositoryBaseCommit`、`repositoryPreparedAt`、`dispatchState` | `packages/contracts/src/types.ts:258-268`                | **PASS**：纯 additive；serializer 同步（`apps/api/src/common/serializers.ts:356-364`）。                                                                      |
| 未新增错误码                                                                                                                                            | —                                                        | **PASS**：WP-C 复用既有 `REPOSITORY_*`/`REPO_*`/`PROJECT_BINDING_*` 码；CLI 竞态按计划 §8.9 使用 `REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_INSTALLED:` 前缀。 |
| 未改 `execution.start` / repository 消息 schema                                                                                                         | `packages/contracts/src/runner-protocol.ts` 不在 diff 中 | **PASS**：`RUNNER_PROTOCOL_VERSION = 1` 和 v1 严格性保持不变；contracts 的 109 个测试通过。                                                                   |
| `features` 使用既有 `RunnerFeature` 联合类型                                                                                                            | `packages/contracts/src/constants.ts`                    | **PASS**：`project-binding-v1`、`repository-handshake-v1`、`repository-path-policy-v1` 均为既有 feature；Runner 另声明 `repository-validation-v1`。           |

### 6.2 兼容性判断

- API 和 Runner 都使用同一份 contracts；没有 wire schema 变更，因此旧 Runner 不会因为字段解析失败而崩溃，但会因为缺少 features 被 availability 门禁拒绝（409 `PROJECT_BINDING_UNSUPPORTED`）。这是计划预期的安全降级。
- `ExecutionDto` 新增字段都是 nullable/可序列化的；web 41 个测试通过，说明现有 UI 对新增字段不敏感。WP-E 的展示尚未实现，不在本次范围。
- `dispatchState` 是协议阶段指示，不是用户可见 status；测试明确断言 `EXECUTION_STATUSES` 不含 `terminal`，避免 UI 把内部状态当作终态。
- `repositoryPreparedAt` 使用 API 接收时间（`repository-handshake.service.ts:644`），不是 Runner 的 `acceptedAt`；符合计划 Q7。

**结论：PASS。** 契约层没有发现破坏性变更、未注册错误码或协议版本漂移。

---

## 7. Prisma Schema 与迁移

### 7.1 Schema

`apps/api/prisma/schema.prisma` 的 `Execution` 新增 6 列：

| 列                        | 类型        | 默认/约束                    | 用途                  |
| ------------------------- | ----------- | ---------------------------- | --------------------- |
| `repositoryPath`          | `String?`   | nullable                     | ACK 的 canonical path |
| `repositoryPolicyVersion` | `String?`   | nullable                     | ACK 的 policy version |
| `repositoryContextId`     | `String?`   | nullable                     | Runner 的 contextId   |
| `repositoryBaseCommit`    | `String?`   | nullable                     | 准备时的 base commit  |
| `repositoryPreparedAt`    | `DateTime?` | nullable                     | API 接收 ACK 时间     |
| `dispatchState`           | `String`    | `NOT NULL DEFAULT 'created'` | 协议阶段              |

新增两个索引：`@@index([dispatchState])`、`@@index([runnerId, dispatchState])`。

新增 `RepositoryHandshakeEvent`：

- 字段：`id`、`executionId`、`state`、`bindingVersion`、`policyVersion`、`code`、`message`、`createdAt`。
- 外键：`executionId → Execution.id`，`ON DELETE CASCADE ON UPDATE CASCADE`。
- 索引：`@@index([executionId, createdAt])`。
- 注释明确不存 prompt、token、diff 或仓库内容；实现中的 `audit()` 只写状态和代码/消息（`repository-handshake.service.ts:828-852`）。

### 7.2 迁移 SQL

`20261111120000_p2_02_repository_handshake/migration.sql`：

1. `ALTER TABLE` 增加 6 列；`dispatchState` 带 `DEFAULT 'created'`。
2. 创建两个索引。
3. 回填：`status IN ('completed','failed','cancelled')` → `dispatchState='terminal'`。
4. 回填：`status='running'` → `dispatchState='running'`（包括历史 mock 行；WP-D 负责恢复，WP-C 不重新握手）。
5. 创建审计表和索引/外键。

### 7.3 独立迁移证据

在仓库外副本中执行 `prisma migrate deploy`：

| 场景        | 命令/环境                                                           | 结果                                                                                                      |
| ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 全新 SQLite | 空 `fresh2.db` + `prisma migrate deploy`                            | **PASS**：5 个迁移全部应用，输出 `All migrations have been successfully applied.`                         |
| 重复 deploy | 同一 `fresh2.db` 再执行                                             | **PASS**：`No pending migrations to apply.`                                                               |
| 既有基线库  | 先应用 4 个基线迁移，插入 5 行（running/terminal），再应用 WP2 迁移 | **PASS**：terminal 行变 `terminal`，running 行变 `running`；再次 deploy `No pending migrations to apply.` |
| 完整性      | `PRAGMA integrity_check`                                            | **PASS**：`ok`                                                                                            |
| 表结构      | `PRAGMA table_info('Execution')`                                    | **PASS**：6 列均存在；`dispatchState` 为 `TEXT NOT NULL DEFAULT 'created'`                                |
| 索引        | `PRAGMA index_list('Execution')`                                    | **PASS**：`Execution_dispatchState_idx`、`Execution_runnerId_dispatchState_idx` 存在                      |
| 审计表      | `PRAGMA table_info('RepositoryHandshakeEvent')`                     | **PASS**：8 列齐全；FK 为 `Execution(id)`，`ON DELETE CASCADE`                                            |
| 审计索引    | `PRAGMA index_list('RepositoryHandshakeEvent')`                     | **PASS**：`RepositoryHandshakeEvent_executionId_createdAt_idx` 存在                                       |

补充说明：

- 项目测试/初始化流程使用 `prisma db push`。在同一个 DB 上先 `db push` 再 `migrate deploy` 会得到 Prisma P3005（数据库非空且没有 `_prisma_migrations` 历史）。这是 Prisma 工作流差异，不是 WP-C 迁移缺陷；正式从基线迁移部署时 `migrate deploy` 正常。
- 实现报告声称的“既有库回填”使用 raw SQL 证据；本次用正式 `migrate deploy` 独立复现了 fresh/existing/repeat 三条路径，结论与报告一致。
- 未在真实生产数据量/长时间锁的 SQLite 上测试；SQLite 的 `ALTER TABLE ADD COLUMN` 是轻量操作，风险低，但仍属于未验证项（§14）。

**结论：PASS。** Schema、迁移、回填、索引、审计表和外键均与计划 §7 一致，且没有修改基线迁移历史。

---

## 8. API 握手状态机

### 8.1 入口与预检

`ExecutionsService.startForTask` 在 `withLock('execution-start')` 内执行 `startForTaskLocked`（`executions.service.ts:84-88`），保证单 API 实例内 start 串行。runner 路径的预检顺序：

1. Task 存在、未归档、可启动（`todo/claimed/in_progress`）。
2. 分配了 agent，agent 在线且不 busy。
3. Task 的项目存在、未归档。
4. 计算机/runner 存在且在线；binding 存在且 `status='ready'`、`validatedBindingVersion === bindingVersion`、canonicalPath/policyVersion/platform/validatedByRunnerId 非空。
5. `runtimes.getAvailability` 检查 CLI installed/authenticated + live features。
6. 选中 runner，并 `assertBindingRunnerIdentity` 检查 `validatedByRunnerId` 和 live platform。
7. 创建事务内重读 project archived/defaultBranch、binding 版本/ready 状态和 runner identity/platform，再写 Execution 快照和 Task/Agent 状态。

关键代码：`executions.service.ts:96-341`。第 4–6 步在事务外，第 7 步在事务内重读 binding（`272-309`）；这比只信预检更安全。F4 指出的是第 5 步 live feature 没有在第 7 步事务内重读，属于窄竞态。

### 8.2 dispatch 的 acquired → preparing

`RepositoryHandshakeService.dispatch`（`repository-handshake.service.ts:138-280`）：

1. `loadSnapshot` 读 Execution + runner.computerId，要求 ownership、repository 快照字段齐全。
2. `assertDispatchable`：status running、dispatchState created、live runner connected、computerId 匹配、live features 齐全、binding 仍 ready 且 identity/platform 匹配、canonicalPath/policyVersion 非空。
3. `assertCapacity`：数据库 count 该 runner 其他 running 行，`< maxConcurrentExecutions`。
4. `updateMany({id, dispatchState:'created'} → 'repository_preparing')` 作为 dispatcher lease；`count=0` 则返回 `EXECUTION_ALREADY_RUNNING`。
5. 读 binding 的 `path/canonicalPath/policyVersion`，构造 `execution.repository` payload，创建 pending，arm 2s/6s 重试和 15s 总超时，发送。
6. await `repositoryDeferred`；收到 ACK 后 `acceptedRepository` 做两次事务迁移：`repository_preparing → repository_ready`、`repository_ready → start_sent`。
7. 构造并发送 `execution.start`，arm 20s start-accept 超时，await `startDeferred`。
8. 收到 `execution.accepted` 后 `updateMany(start_sent → running)`，audit `running`，`settled=true`。

错误路径：任何 `RepositoryDispatchError` 都会 audit `handshake_failed`，`dispatchCancel` 发 `execution.cancel`，然后抛出；`ExecutionsService` 捕获后调用 `failExecutionStart`，再 `runtimes.stop`（对 runner 是再次 cancel）并返回 `RUNTIME_START_FAILED`（`executions.service.ts:368-419`）。

### 8.3 ACK 重检与条件状态迁移

`recheckAndTransition`（`repository-handshake.service.ts:511-667`）在一个 `prisma.$transaction` 内：

- 重读 Execution，要求 `status='running'`、`runnerId`、`repositoryProjectId/BindingId/BindingVersion/DefaultBranch` 与 pending snapshot 一致。
- 重读 binding，要求存在、`validatedBindingVersion === bindingVersion`、`policyVersion`/`canonicalPath` 非空。
- `requireLivePlatform`：live runner 仍连接、computerId 一致、live features 仍齐全；任何一项失败返回 `PROJECT_BINDING_NOT_READY`，不降级成 path mismatch。
- `assertBindingIdentity`：binding.validatedByRunnerId 必须等于 pending.runnerId，binding.platform 必须等于 live.platform。
- `repository_preparing` 阶段：校验 ACK 的 executionId/projectId/bindingId/bindingVersion/defaultBranch/policyVersion/canonicalPath 全部匹配；然后 `updateMany({dispatchState:'repository_preparing'} → 'repository_ready')`，写入 `repositoryPath/PolicyVersion/ContextId/BaseCommit/PreparedAt`。
- `repository_ready` 阶段：再次重读 binding/identity/platform/policy/canonicalPath，然后 `updateMany({dispatchState:'repository_ready'} → 'start_sent')`。

条件 update 的 `count=0` 会抛 `staleTransition`（`REPOSITORY_CONTEXT_MISMATCH`），不会把状态回退。这个设计符合 §6.4。

### 8.4 start accepted 与终态

- `execution.accepted` 只在 `pending.startMessage` 已存在时处理（`repository-handshake.service.ts:749-752`），避免 repository ACK 被误当 start ACK。
- `updateMany({dispatchState:'start_sent'} → 'running')`；如果已经 `running` 且 status running，则视为 duplicate accepted 并 resolve（`753-777`）。
- `finishExecution` 写 `dispatchState='terminal'`，并调用 `noteTerminal` 终止 pending（`executions.service.ts:920-977`）。
- `failExecutionStart` 写 `failureReason`、`dispatchState='terminal'`、回滚 Task/Agent，并以 status running 为条件保证幂等（`689-769`）。

### 8.5 状态机判定

**PASS（核心状态机）。** 条件迁移、ACK 校验、identity/platform 重检、binding/policy 变化、capacity、重试/超时、`failExecutionStart` 单一写入者均与计划一致。API 测试覆盖了 no-start-without-accepted、ACK mismatch、policy change、start.rejected、runner replacement/platform mismatch 等主路径。

但状态机没有“cancel intent”状态：`cancel` 只发消息，不改 status/dispatchState；`recheckAndTransition` 的 `status === 'running'` 检查无法识别取消。这是 F1 的 API 侧根因，不是状态机条件更新的实现错误。

---

## 9. Runner 上下文、准入与执行

### 9.1 `RepositoryContextManager.prepare`

`repository-context.ts:61-125` 的顺序：

1. 若 map 已有同 executionId 的 context：`matches` 则返回同一个 contextId；不匹配则 `REPOSITORY_CONTEXT_CONFLICT`。
2. 无 policy → `REPOSITORY_POLICY_NOT_CONFIGURED`。
3. `payload.policyVersion !== policy.policyVersion` → `REPOSITORY_POLICY_CHANGED`。
4. `policy.validate(payload.path)`：路径存在性、绝对路径、traversal、UNC/device、allowed roots、realpath、Git root/bare/linked worktree/submodule、HEAD 等由 WP-B 策略完成。
5. `assertDefaultBranch(validation.canonicalPath, payload.defaultBranch)`：`git check-ref-format --branch` + `rev-parse --verify --quiet refs/heads/<branch>^{commit}`。
6. 再次 `policy.assertStillAllowed(canonicalPath)`（TOCTOU）。
7. `branchCommit(canonicalPath, defaultBranch)` 解析 base commit。
8. 构造 context 并 `this.contexts.set(executionId, context)`。

`prepare` 不 spawn CLI、不创建 worktree、不触碰主 checkout；符合 §9.8。

### 9.2 上下文状态与 TTL

- `ready`：准备完成，等待 start。
- `starting`：`beginStart` 已把状态置为 starting，admission 进行中。
- `started`：`markStarted` 后，start 已完成准入并交给 executor；不再受 TTL 清理。

`sweep` 只删除 `ready` 且 `now - lastUsedAt >= 10min` 的 context（`repository-context.ts:153-161`）。`started` 豁免；`starting` 被跳过。计划 §9.8 明确说 `starting` 是短命的，必须转为 `started` 或被 release；当前没有对 `starting` 的 TTL/异常清理。见 F5。

### 9.3 admission 顺序

`runner-client.ts:578-628`：

| 步骤 | 检查                                                                        | 失败行为                                                                                |
| ---- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1    | `beginStart`：missing → reject                                              | `execution.start.rejected` `REPOSITORY_CONTEXT_NOT_READY`                               |
| 2    | `started` → 重发 accepted，不 respawn                                       | accepted                                                                                |
| 3    | `starting` 且有 in-flight admission → await 它                              | 等第一个结果                                                                            |
| 4    | `get(executionId)` 取 context                                               | missing → rejected                                                                      |
| 5    | `repositoryPolicy` 存在                                                     | rejected `REPOSITORY_POLICY_NOT_CONFIGURED`                                             |
| 6    | `context.policyVersion === live policyVersion`                              | rejected `REPOSITORY_POLICY_CHANGED`                                                    |
| 7    | `policy.assertStillAllowed(context.canonicalPath)`                          | rejected 对应 `REPO_*`                                                                  |
| 8    | `executor.canAdmit(payload, context)`：runtime enabled、duplicate、capacity | rejected `RUNTIME_NOT_ENABLED`/`RUNNER_BUSY`/context-not-ready                          |
| 9    | real 模式：缓存的 `runtimeCapabilities` installed/authenticated             | rejected `REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_INSTALLED:`/`CLI_NOT_AUTHENTICATED:` |
| 10   | `markStarted` + `send('execution.accepted')` + `executor.start`             | accepted 后异步失败                                                                     |

第 1–9 步都在 accepted 之前，第 10 步才 accepted + spawn。这个顺序本身是 PASS，且现有 Runner 测试 `repository-handshake.spec.ts:266-308` 用 executor.start spy 验证了 accepted 在 start 之前。

**缺口：** 第 9 步的 CLI 能力来自启动时 `prepareCapabilities`（`runner-client.ts:191-193, 765-778`），不是 live 检查；第 10 步之后 `RealExecutor.prepareAndRun` 才 `resolveExecutable`（`real-executor.ts:359-365`）。见 F2。

### 9.4 RealExecutor 的执行顺序

`RealExecutor.start`（`real-executor.ts:158-190`）：

1. 若已有 session：返回（duplicate）。
2. 无 `context.canonicalPath`：`failBeforeStart`（这是编程错误路径，不是正常 admission 拒绝）。
3. 创建 session，`sessions.set`，phase `preparing`。
4. `void this.prepareAndRun(...)`。

`prepareAndRun`（`real-executor.ts:300-424`）：

1. 再检查 session.projectPath 和 repositoryPolicy。
2. `assertStillAllowed(context.canonicalPath)`（TOCTOU）。
3. `beginJournal`、`git.prepare(canonicalPath, projectId, executionId, {baseCommit})`。
4. `persistJournal` 写 worktree/branch/baseCommit/phase。
5. `emitProgress`。
6. 若 `session.cancelled` → finalize cancelled。
7. `resolveExecutable(command)`；无路径 → `RunnerFailure('CLI_NOT_INSTALLED', ...)`。
8. 若 `session.cancelled` → finalize cancelled。
9. `buildCliArgs`、`emitPhase('running')`、`spawnProcess`。
10. 绑定 stdout/stderr/close/error，写 journal PID，运行。

**取消语义的重要分界：** 一旦 session 已创建（第 3 步之后），`execution.cancel` 会设置 `session.cancelled`，`prepareAndRun` 在第 6/8 步或 `cancel()` 的 terminate/fallback 中处理；这条路径是 PASS。问题在于 **session 尚未创建** 的预启动窗口：`executor.cancel` 找不到 session 就 no-op，RunnerClient 也没有保存 cancel 意图。见 F1。

### 9.5 路径安全接线

`RealExecutor` 在 worktree 写入前再次 `assertStillAllowed`（`real-executor.ts:320-323`），`GitWorktreeManager` 增加双向 containment（`git-worktree.ts:108-121`）。这满足 WP-B → WP-C 的接线要求：WP-C 不再有“策略只是库、没有生产调用点”的问题。

**结论：PASS WITH WARNINGS（正常 admission/执行路径）；F2、F3、F5 是时序/幂等/TTL 缺口，不是正常路径的顺序错误，但会阻止 WP-C 验收。**

---

## 10. 取消、失败、超时与清理语义

### 10.1 两种取消路径

| 路径                             | 行为                                                                                                                                        | 判定           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Mock runtime                     | `withExecutionLock` 内 `runtimes.stop`，直接 DB 写 `cancelled`/`terminal`，恢复 Task/Agent                                                  | **PASS**       |
| Runner runtime，session 已存在   | `dispatchCancel` → Runner `executor.cancel` 设置 cancelled，terminate/fallback → `execution.cancelled` → API `finishExecution` 写 cancelled | **PASS**       |
| Runner runtime，session 尚未创建 | API 只发 `execution.cancel`；Runner release 现有 context + `executor.cancel` no-op；没有终态事件；API 30s 后 `RUNNER_CANCEL_TIMEOUT`        | **FAIL（F1）** |

`cancelRunnerExecution`（`executions.service.ts:598-637`）在发送 cancel 后轮询 `waitForExecutionTerminal`（`1070-1085`），只有执行行 `status !== 'running'` 才返回。它不会自己写 `cancelled`，因为“真实取消必须等 Runner 确认进程树停止”。这个原则本身正确；问题是没有为“Runner 尚无进程”提供确认/终止路径。

### 10.2 F1 的完整时序

```
API                          Runner
 |-- POST /executions/:id/cancel -->  (读取 status=running)
 |-- execution.cancel ------------>  release(executionId)  // map 为空，no-op
 |                                   executor.cancel(id)   // 无 session，no-op
 |                                   （没有 execution.cancelled）
 |-- 继续等待 30s ...
 |                                   （此前已收到 execution.repository，prepare 仍在 await）
 |                                   prepare 完成，contexts.set(...)
 |                                   execution.repository.accepted -->
 |-- acceptedRepository: preparing -> ready -> start_sent
 |-- execution.start ------------->  admission 通过
 |                                   execution.accepted -->
 |                                   executor.start(...) -> RealExecutor session -> git/worktree -> spawn CLI
 |-- start accepted，execution 进入 running
 |-- 30s 到，返回 409 RUNNER_CANCEL_TIMEOUT
```

如果 cancel 发生在 `prepare` 的 `await` 期间，`release` 找不到 context，`prepare` 完成后仍会插入；如果 cancel 发生在 `execution.repository` 发送之前，Runner 甚至没有 context 可 release，之后 dispatch 仍会发 repository/start。两种都是“取消被丢弃”。

如果 cancel 发生在 context 已存在但 `execution.start` 尚未发送，`release` 会删除 context，之后 start 被 Runner 拒绝；API 的 `failExecutionStart` 会把行标为 `failed`，`cancel` 请求返回 failed 而不是 cancelled。这是 F1 的较轻表现：没有 spawn，但操作员取消没有产生 `cancelled` 终态。

### 10.3 失败与终态清理

- `failExecutionStart`：同步预启动失败的唯一终态写入者；`status='running'` 条件 update；回滚 Task/Agent；二次调用/已终态跳过；写 error log 和 activity（`executions.service.ts:689-769`）。**PASS**。
- `finishExecution`：Runner 的 `execution.completed/failed/cancelled` 事件走这里；写 `dispatchState='terminal'`、任务/agent 状态、git artifact，并 `noteTerminal`（`887-977`）。**PASS**。
- `noteTerminal`：拒绝 repository/start 两个 deferred，删除 pending（`repository-handshake.service.ts:124-136`）。**PASS**，但它只在 `finishExecution` 调用；`cancelRunnerExecution` 不调用，因为取消尚未确认。F1 的修复需要把“cancel intent”接入这条路径或在 pre-start 直接终态化。
- 失败时 `dispatch` 会发 `execution.cancel`（`repository-handshake.service.ts:260-276`），Runner release context；即使 Runner 离线，ready context 也有 10 分钟 TTL。**PASS**。
- `audit()` 是 best-effort，失败只吞掉（`repository-handshake.service.ts:828-852`）；审计缺失不会破坏握手，符合计划“audit 不得阻断握手”的意图。

### 10.4 判定

**FAIL。** 取消的正常/后置路径正确，但预启动窗口不满足 §6.5 第 2、3 条。F1 不是“WP-D 尚未实现恢复”的问题，而是 WP-C 已经能 spawn CLI 的错误状态。

---

## 11. 幂等、并发与 WP-D 边界

### 11.1 已实现的幂等保障

| 机制                                                                              | 位置                                               | 判定                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------- |
| `execution.repository` 重试使用同一 messageId/sentAt/payload                      | `repository-handshake.service.ts:463-485`          | **PASS**               |
| API 条件 `updateMany` 防止重复 `repository_ready`/`start_sent`/`running`          | `repository-handshake.service.ts:635-660, 753-777` | **PASS**               |
| 重复 `execution.repository.accepted`：pending 已 settle 后忽略                    | `repository-handshake.service.ts:707-725`          | **PASS**               |
| 重复 `execution.start`：`started` 重发 accepted，不 respawn                       | `runner-client.ts:587-593`                         | **PASS**               |
| 重复 `execution.accepted`：`dispatchState='running'` 且 status running 时 resolve | `repository-handshake.service.ts:753-777`          | **PASS**               |
| Runner 终态事件：`finishExecution` status guard                                   | `executions.service.ts:906-912`                    | **PASS**               |
| 同一 executionId 的顺序重发 prepare：`matches` 返回同一 contextId                 | `repository-context.ts:61-72`                      | **PASS（仅顺序场景）** |

### 11.2 未覆盖的并发窗口

**F3：并发 prepare。** API 在 t=2s/6s 重发 `execution.repository`；Runner 的 socket handler 是 `void this.handleRepository(...)`（`runner-client.ts:355-357`），不等待、不排队。`prepare` 在入口查 map 后要 await `policy.validate`、branch 检查、`assertStillAllowed`、`branchCommit`，最后才 `contexts.set`（`repository-context.ts:87-123`）。如果第一次 prepare 超过 2s，第二次会在 map 为空时开始，两者都完成并各自 set/发送 accepted：

- 两个 accepted 的 `contextId` 不同；API 只 resolve 第一个，但 Runner map 保留最后一个。
- API 把第一个 `contextId` 写入 `Execution.repositoryContextId`（`repository-handshake.service.ts:642`），与 Runner 实际保留的 context 不一致。
- 若其中一个 prepare 先失败并发送 `execution.repository.rejected`，而另一个稍后成功，API 可能先收到 rejection 并失败整次执行；反过来则 rejection 被当作 stale 忽略。
- 计划 §11.2 明确要求 “same executionId + same bindingVersion/policyVersion/path → same contextId”（`1486`），§11.3 的 “Repository accepted replay” 也以 executionId+contextId 为键（`1501`）。当前实现只在“第一次已 set”后的顺序重发下满足。

**F4：feature 窗口。** `getAvailability` 的 live feature 检查（`runtime-registry.service.ts:179-183`）在创建事务前；创建事务内的 `assertBindingRunnerIdentity` 只重读 live registration 的 platform/identity（`executions.service.ts:1172-1205`），不重读 features。如果在两步之间 Runner 以同一 runnerId 重新注册并丢失 `repository-handshake-v1`，Execution 行会先创建，随后 `dispatch.assertDispatchable`（`repository-handshake.service.ts:352-357`）抛 `PROJECT_BINDING_UNSUPPORTED`，`failExecutionStart` 把行标为 failed。计划 G7（`1963`）要求 409 + zero Execution rows；这是窄竞态，正常静态场景满足。

**F5：starting 泄漏。** `beginStart` 在 `repository-context.ts:133` 设置 `starting`；如果 `admissionFailure` 或 `executor.canAdmit` 抛出未预期异常，`handleStart` 的 `finally` 只删除 `admissions` map（`runner-client.ts:559-565`），不会 release context。`runAdmission` 没有 try/catch/finally 包裹整个 admission。之后 context 永久是 `starting`，sweep 跳过，10 分钟 TTL 不生效。duplicate start 仍可继续（`starting` 且无 inFlight 时 fall through），所以不会 double-spawn，但会泄漏内存和旧 policy/canonical 快照。

### 11.3 WP-D 边界

以下内容 **不是** WP-C 缺陷，本次不计入 Findings：

- API 重启后对 `created/repository_preparing/repository_ready/start_sent` 的恢复扫描。
- `start_sent` 断连后的 30s `RUNNER_START_UNCONFIRMED` grace。
- 断连/重连后 resend repository、reconcile snapshot、`RUNNER_RESTARTED` 的完整矩阵。
- `failOrphanedExecutions` 的 60s runner-disconnect grace 细节。

WP-C 明确把这些留给 WP-D（`repository-handshake.service.ts:90-91`；`runner-registry.service.ts:872-883`）。但 F1 的“取消后 spawn”是 WP-C 自己已经造成的错误状态，不能用 WP-D 豁免。

### 11.4 判定

**FAIL。** 顺序幂等和条件状态迁移正确，但并发 prepare（F3）违反 §11.2 的“同一 executionId/参数必须返回同一 contextId”，属于需要修复的幂等缺陷；feature 窗口（F4）和 starting 泄漏（F5）是附加的 P3 警告。F3 会影响 WP-D 的 ACK-loss/重连矩阵，建议在 WP-D 开始前修复。

---

## 12. Findings（逐条）

严重级别定义：**P0** = 数据损坏/安全绕过/不可恢复的错误启动；**P1** = 违反冻结不变量，可能 spawn 错误进程或产生不可信终态；**P2** = 违反退出标准/幂等要求，需要修复后才能验收；**P3** = 窄竞态、资源泄漏或可维护性风险，不改变主路径正确性。所有行号均指被审查提交 `1eedb98`。

### F1 — P1 — 预启动操作员取消不是持久的，取消后仍可能发送 start 并 spawn CLI

| 属性          | 内容                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | F1 / **P1**                                                                                                                                                                                                                                                                                     |
| **违反条款**  | 计划 §6.5 不变量 2、3（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:640-641`）；§15 WP-C“`execution.cancel` releases pre-start contexts”（`:2149`）                                                                                                                                       |
| **位置**      | `apps/api/src/modules/executions/executions.service.ts:598-637`；`apps/runner/src/runner-client.ts:358-361`；`apps/runner/src/repository-context.ts:61-123,144-146`；`apps/runner/src/real-executor.ts:192-196`；`apps/api/src/modules/runners/repository-handshake.service.ts:498-509,511-548` |
| **WP-D 阻塞** | **是。** WP-D 的取消/恢复矩阵依赖“cancel 是持久意图”，F1 未修复前不能开始 WP-D。                                                                                                                                                                                                                |

**代码证据。**

1. API 的 Runner 取消路径只发消息并在数据库中轮询，不写 cancel intent，也不改 `status`/`dispatchState`：

```ts
// executions.service.ts:603-605
let dispatched = true;
if (execution.runnerId) {
  dispatched = this.runtimes.cancelOnRunner(execution.runnerId, execution.id, reason);
}
// executions.service.ts:622-624
// Real cancellation is only complete when the runner confirms ...
const terminal = await this.waitForExecutionTerminal(execution.id, RUNNER_CANCEL_TIMEOUT_MS);
```

2. Runner 收到 `execution.cancel` 只做两件事：

```ts
// runner-client.ts:358-361
case 'execution.cancel':
  this.repositoryContexts.release(message.payload.executionId);
  this.executor.cancel(message.payload.executionId, message.payload.reason);
  break;
```

3. `release` 只删除已经存在的 map 条目：

```ts
// repository-context.ts:144-146
release(executionId: string): void {
  this.contexts.delete(executionId);
}
```

4. `prepare` 在入口检查 map 后要 await 多个异步操作，最后才写入；取消发生在这段窗口时，`release` 找不到条目，`prepare` 完成后仍会 `set`，把上下文“复活”：

```ts
// repository-context.ts:62-72 入口检查
const existing = this.contexts.get(payload.executionId);
...
// repository-context.ts:87-106 异步 validate / branch / assertStillAllowed / branchCommit
// repository-context.ts:123 最后写入
this.contexts.set(context.executionId, context);
```

5. `executor.cancel` 在没有 session 时直接返回；此时 CLI 尚未创建 session，取消被完全丢弃：

```ts
// real-executor.ts:192-196
cancel(executionId: string, reason?: string): void {
  const session = this.sessions.get(executionId);
  if (!session || session.finished || session.cancelled) {
    return;
  }
```

6. API 侧的 ACK 迁移只检查 `status === 'running'` 和快照字段，不识别“已请求取消”；因此取消后仍可完成 `repository_preparing → repository_ready → start_sent` 并发送 `execution.start`：

```ts
// repository-handshake.service.ts:535-543
if (
  !execution ||
  execution.status !== 'running' ||
  execution.runnerId !== pending.runnerId ||
  ...
)
```

**触发条件。**

- 操作员在 `execution.repository` 已发送、Runner 仍在 `prepare`（或尚未处理 repository）时点击取消；或
- 操作员在 API 的 `dispatch` 发送 repository 之前取消，而取消请求先到、dispatch 后到；或
- 取消发生在 context 已 ready、`execution.start` 尚未发送时（较轻表现：start 被 Runner 拒绝，执行变为 `failed` 而不是 `cancelled`）。

**影响。**

- 取消请求返回 `409 RUNNER_CANCEL_TIMEOUT`（30s）后，执行仍可能继续：Runner 完成 prepare、发送 accepted、API 进入 `start_sent`、Runner admission 通过、`RealExecutor` 创建 session 并 **spawn CLI**。这是 WP-C 已经造成的错误启动，不是 WP-D 的“恢复未实现”。
- 违反冻结不变量：Runner 没有 abort preparation，API 在 cancel 后仍发送 `execution.start`。
- 用户看到“取消失败/超时”，但任务实际在运行，可能产生 diff、提交或外部副作用。

**可复现性。**

- 代码路径确定；取消窗口由 `prepare` 的多个 await 决定。
- 本次在审查工作树临时创建 `apps/runner/test/zz-wpc-review-probe.spec.ts`，用 gate 卡住 `policy.validate`，在 prepare 进行中调用 `release`，随后放行；断言 `manager.get(executionId)` 仍然非空，测试 **1/1 通过**，随后删除该文件并确认 `git status --short` 为空。该探针证明“释放不会取消 in-flight prepare”，完整 spawn-after-cancel 的端到端时序由同一代码路径推出，未保留为正式测试。
- 现有 Runner 测试 `repository-handshake.spec.ts:333-358` 只覆盖“context 已 ready 后 cancel”，不覆盖 in-flight prepare；API 测试 `runner.integration.spec.ts:775-814` 只覆盖“session 已存在后 cancel”。

**修复方向（不在本次自动修复）。**

1. Runner 增加按 `executionId` 的取消意图（`cancelled: Set<string>` 或 `AbortController`），在 `prepare` 的每个 await 之后检查；命中则中止并抛出/返回取消，不得 `contexts.set`。
2. `release` 同时记录取消意图，确保“先 cancel 后 prepare 完成”不会复活上下文；prepare 完成写入前再次检查。
3. API 在取消时持久化 cancel intent（例如新增 `cancelRequestedAt` 或受控的 `dispatchState='cancel_requested'`），`acceptedRepository` / `recheckAndTransition` 在事务内检查；取消后禁止进入 `start_sent`。
4. 对“Runner 尚无进程”的预启动取消定义终态确认：Runner 发 `execution.cancelled`，或 API 在确认无 context 时安全写 `cancelled`；不能只依赖 30s 超时。
5. 增加两个回归测试：prepare 进行中 cancel → 不 spawn、无 start；repository 发送前 cancel → 不发送 repository/start。

---

### F2 — P2 — 缺失 CLI 仍会先 `execution.accepted` 再失败，违反 §8.9 / AC-15B

| 属性          | 内容                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ID / 级别** | F2 / **P2**                                                                                                                                                                    |
| **违反条款**  | 计划 §8.9 CLI capability race（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:1068`）；§15 退出标准第 5 条（`:2159`）                                                      |
| **位置**      | `apps/runner/src/runner-client.ts:669-691,621-627`；`apps/runner/src/real-executor.ts:158-190,359-365`；`apps/api/src/modules/runners/repository-handshake.service.ts:749-777` |
| **WP-D 阻塞** | **否**（不改变恢复矩阵），但**阻塞 WP-C 验收**，应在签署 WP-C 前修复。                                                                                                         |

**代码证据。**

Runner 的 admission 只读启动时缓存的 `runtimeCapabilities`：

```ts
// runner-client.ts:669-691
if (this.config.mode === 'real') {
  const capability = this.runtimeCapabilities.find((item) => item.runtime === payload.runtime);
  if (!capability?.installed) {
    return { ok: false, code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
      message: `CLI_NOT_INSTALLED: ${capability?.message ?? ...}`, retryable: false };
  }
  if (!capability.authenticated) { ... }
}
```

该缓存来自启动时的 `prepareCapabilities`（`runner-client.ts:192,765-778`），不是 `execution.start` 时刻的 live 探测。

admission 通过后先 `markStarted`、发送 `execution.accepted`，再调用 executor：

```ts
// runner-client.ts:621-627
this.repositoryContexts.markStarted(payload.executionId);
this.send('execution.accepted', { executionId: payload.executionId, acceptedAt: ... });
this.executor.start(payload, context);
```

`RealExecutor.start` 创建 session 后异步 `prepareAndRun`，live `resolveExecutable` 在 accepted 之后：

```ts
// real-executor.ts:359-365
const command = this.config.cliPaths[payload.runtime] ?? payload.runtime;
const resolved = await this.resolveExecutable(command);
if (!resolved.path) {
  throw new RunnerFailure(
    'CLI_NOT_INSTALLED',
    resolved.error ?? `${payload.runtime} CLI was not found`,
  );
}
```

失败由 `prepareAndRun` 的 catch 走 `this.fail(session, ...)`，即 `execution.failed` 终态，而不是 `execution.start.rejected`。

**触发条件。**

- Runner 启动/能力探测之后、`execution.start` 之前，CLI 被卸载、改名、PATH 变化、`cliPaths` 指向的二进制被删除；或
- API 预检使用的是上一次注册的能力快照，Runner 在同一连接期间能力已变化但没有重新注册。

**影响。**

- API 先收到 accepted 并把 `dispatchState` 迁到 `running`，随后收到 failed；Execution 失败，Task/Agent 按运行期失败语义处理（task=failed、agent=error），而不是 `failExecutionStart` 的预启动回滚（task 回到 todo/claimed、agent 释放）。
- 直接违反 §15 第 5 条“missing CLI 必须 `execution.start.rejected`，never accepted-then-failed”。
- 实现报告第 183 行声称“CLI installed/authenticated admission”在 accepted 前完成；代码只覆盖缓存能力，声明不成立。

**可复现性。**

- 静态路径确定：将 `resolveExecutable` 替换为返回 `{ path: null }`，且启动时缓存仍为 installed，即可稳定观察到 accepted 后 failed。
- 本次未单独运行该探针；现有 `repository-handshake.spec.ts` 和 `real-executor.spec.ts` 没有覆盖“缓存 installed、live 缺失”的时序。

**修复方向（不在本次自动修复）。**

1. 在 admission 产生 accepted 之前执行 live `resolveExecutable`（或轻量 `--version`/存在性检查），失败返回 `execution.start.rejected`，code 使用 `REPOSITORY_CONTEXT_NOT_READY`，message 前缀 `CLI_NOT_INSTALLED:`/`CLI_NOT_AUTHENTICATED:`。
2. 保留 `RealExecutor` 内的复查作为 defense-in-depth；但该复查失败不得再作为正常 admission 失败路径。
3. 增加 Runner 单测：缓存 installed、live resolve 返回 null → 必须 `start.rejected` 且 `executor.start` 未被调用。

---

### F3 — P2 — 并发重复 `execution.repository` 可能生成不同 `contextId`，违反 executionId 幂等

| 属性          | 内容                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | F3 / **P2**                                                                                                                                                                |
| **违反条款**  | 计划 §11.2 表（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:1486`）、§11.3（`:1501`）、AC-23（`:2478`）、§9.8 幂等要求（`:1347`）                                    |
| **位置**      | `apps/runner/src/runner-client.ts:355-356`；`apps/runner/src/repository-context.ts:61-123`；`apps/api/src/modules/runners/repository-handshake.service.ts:463-485,639-650` |
| **WP-D 阻塞** | **是（WP-D 前必须修复）。** WP-D 的 repository 重发/重连矩阵会放大该窗口，修复后再开始 WP-D。                                                                              |

**代码证据。**

API 在 2s/6s 重发同一条 repository 消息：

```ts
// repository-handshake.service.ts:463-485
const timer = setTimeout(() => { ... send same repositoryMessage ... }, 2000);
const timeout = setTimeout(() => { ... }, 6000);
```

Runner 的 socket handler 不串行化：

```ts
// runner-client.ts:355-356
case 'execution.repository':
  void this.handleRepository(message.payload);
  break;
```

`prepare` 只在入口查 map，之后 await 多个操作，最后才写入：

```ts
// repository-context.ts:62-72
const existing = this.contexts.get(payload.executionId);
if (existing) { ... return existing; }
// repository-context.ts:87-106 await validate / assertDefaultBranch / assertStillAllowed / branchCommit
// repository-context.ts:123
this.contexts.set(context.executionId, context);
```

因此两次并发 prepare 都可能看到空 map，各自生成 `randomUUID()`（`:109`），并分别发送 accepted。API 只 resolve 第一个 deferred，把第一个 `contextId` 写入 Execution（`repository-handshake.service.ts:639-650`）；Runner 的 map 最终保留后完成的那个，二者不一致或至少不是同一上下文。

**触发条件。**

- 单次 prepare 超过 2 秒（大仓库、慢盘、杀毒软件、网络路径、git 冷缓存），且 API 的重发在第一次完成前到达；或
- 断线重连后 WP-D 重发 repository，而旧 prepare 仍在进行。

**影响。**

- 违反“same executionId + same bindingVersion/policyVersion/path → same contextId”。
- Runner 保留的 context 与 API 记录的 `repositoryContextId` 不一致，后续诊断/恢复关联错误。
- 若其中一次 prepare 失败并先发送 rejection，API 会把本可成功的执行失败化；反过来 rejection 被当作 stale 忽略。
- 不直接导致 double-spawn（`execution.start` 仍按 executionId 只接受一个 context），但会破坏 WP-D 重发所依赖的幂等基础。

**可复现性。**

- 通过注入延迟的 `policy.validate` 并发调用两次 `prepare` 可稳定复现两个不同 `contextId`；本次未保留并发探针（F1 探针已证明 prepare 的异步窗口存在）。
- 现有测试 `repository-handshake.spec.ts:194-207` 只覆盖顺序重发（第一次已完成），不覆盖并发。

**修复方向（不在本次自动修复）。**

1. `RepositoryContextManager` 增加 `inflight: Map<executionId, Promise<RepositoryContext>>`；重复 prepare await 同一个 promise，成功后返回同一个 contextId。
2. 失败时清理 inflight 条目；成功写入 contexts 后再删除。
3. 或在 RunnerClient 层按 executionId 串行化 `handleRepository`，并保持 rejection/accepted 的顺序。
4. 增加并发测试：两个 prepare 同时进入，一个成功，断言同一 contextId、只发送一个 accepted、无冲突 rejection。

---

### F4 — P3 — live feature 检查不在创建事务内，G7 的“zero Execution rows”存在窄竞态

| 属性          | 内容                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / 级别** | F4 / **P3**                                                                                                                                                                                                         |
| **违反条款**  | 计划 G7（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:1963`）                                                                                                                                                 |
| **位置**      | `apps/api/src/modules/runtime/runtime-registry.service.ts:179-183`；`apps/api/src/modules/executions/executions.service.ts:210-217,308-322`；`apps/api/src/modules/runners/repository-handshake.service.ts:324-357` |
| **WP-D 阻塞** | **否。**                                                                                                                                                                                                            |

**代码证据。**

availability 在创建事务前检查 live features：

```ts
// runtime-registry.service.ts:179-183
} else if (!this.runners.hasLiveFeatures(runner.id, EXECUTION_REQUIRED_FEATURES)) {
  available = false;
  reasonCode = 'PROJECT_BINDING_UNSUPPORTED';
}
```

创建事务内只重读 binding 版本/ready、canonicalPath/policy/platform/identity，不重读 features（`executions.service.ts:308-322`、`assertBindingRunnerIdentity` `:1172-1205`）。若 Runner 在这两步之间以同一 runnerId 重新注册并丢失 `repository-handshake-v1`，Execution 行已经创建；随后 `dispatch.assertDispatchable` 抛 `PROJECT_BINDING_UNSUPPORTED`（`repository-handshake.service.ts:324-357`），`failExecutionStart` 把该行标为 `failed`。

**触发条件。**

- Runner 重新注册（同 runnerId）恰好发生在 availability 与创建事务之间，且新注册缺少必需 feature。窗口很窄。

**影响。**

- 用户收到启动失败，而不是 G7 要求的 409；数据库留下 **1 条 failed Execution 行**，违反“zero Execution rows”。
- 不产生错误 spawn 或错误状态迁移，属于可观测性和契约偏差。

**可复现性。**

- 需要精确注入注册时序；本次未运行。代码路径确定，但正常静态场景（先注册缺 feature 再启动）已被 `runner.integration.spec.ts:305-322` 覆盖为 availability 拒绝；该测试没有断言 POST 的 zero-row。

**修复方向（不在本次自动修复）。**

1. 在创建事务内重读 live features（与 platform/identity 同一处），不满足则抛 409，事务不写行。
2. 或把 feature 校验移到 `assertDispatchable` 之前并让失败发生在事务内；保持 G7 的 zero-row 语义。
3. 增加集成测试：availability 之后、POST 之前切换注册 feature，断言 409 且 Execution count 不变。

---

### F5 — P3 — `starting` 上下文不在 TTL sweep 内，异常 admission 会永久泄漏

| 属性          | 内容                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ID / 级别** | F5 / **P3**                                                                                                                                                  |
| **违反条款**  | 计划 §9.8（`P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md:1356`）：“a `starting` context is short-lived and must either become `started` or be released” |
| **位置**      | `apps/runner/src/repository-context.ts:127-135,153-161`；`apps/runner/src/runner-client.ts:547-566,568-628`                                                  |
| **WP-D 阻塞** | **否。**                                                                                                                                                     |

**代码证据。**

`beginStart` 把 `ready` 改为 `starting`：

```ts
// repository-context.ts:131-134
if (context.state === 'started') return 'started';
if (context.state === 'starting') return 'starting';
context.state = 'starting';
return 'acquired';
```

`sweep` 只清理 `ready`：

```ts
// repository-context.ts:154-160
for (const [executionId, context] of this.contexts) {
  if (context.state !== 'ready') continue;
  if (now - context.lastUsedAt >= PRE_START_TTL_MS) {
    this.contexts.delete(executionId);
  }
}
```

`handleStart` 的 `finally` 只删除 admissions map，不 release context：

```ts
// runner-client.ts:559-565
try {
  await admission;
} finally {
  if (this.admissions.get(payload.executionId) === admission) {
    this.admissions.delete(payload.executionId);
  }
}
```

`runAdmission` 没有包裹整个 admission 的 try/catch；如果 `repositoryPolicy.assertStillAllowed`、`executor.canAdmit` 或 `send` 抛出未预期异常，`beginStart` 已把状态置为 `starting`，异常沿 `handleStart` 的 `void` 调用冒泡，context 既没有 `markStarted` 也没有 `release`。

**触发条件。**

- admission 期间出现未预期异常（策略实现 bug、executor 抛错、socket send 抛错等）；或
- 进程在 admission 中途长时间挂起后恢复。

**影响。**

- context 永久处于 `starting`，10 分钟 TTL 不会清理，造成内存/旧 policy/canonicalPath 快照泄漏。
- 后续 duplicate start 在 `starting` 且无 in-flight 时会 fall through 重新 admission，通常不会 double-spawn，但可能复用过期上下文；异常还可能导致 unhandled rejection（取决于进程级处理）。

**可复现性。**

- 通过让 `executor.canAdmit` 抛错即可复现 context 保持 `starting`；本次未单独运行。代码路径确定。

**修复方向（不在本次自动修复）。**

1. `runAdmission` 用 try/catch/finally 包裹；任何异常都 `release(executionId)` 并发送 `execution.start.rejected`（或记录后关闭连接），不能让状态停在 `starting`。
2. `sweep` 对 `starting` 增加短 TTL（例如 1 分钟）作为兜底；`started` 继续豁免。
3. 增加测试：`canAdmit` 抛错后 context 被释放；`starting` 超过短 TTL 被清理。

---

### 12.6 非阻塞观察（不计入 Findings）

以下两项不改变主路径正确性，不作为 WP-C 失败理由，但建议在 WP-D/E 前顺手处理：

1. **`matches` 比较 raw `configuredPath` 而非 `canonicalPath`**（`repository-context.ts:163-172`）。同一仓库通过不同路径表示（大小写、分隔符、符号链接/junction）重发时，可能被判为 `REPOSITORY_CONTEXT_CONFLICT`。API 侧已用 `sameRepositoryPath` 做 platform-aware 比较，Runner 侧未复用同一规则。现有测试只覆盖完全相同的字符串。
2. **`emitProtocolEvent` 吞掉 listener 异常**（`runner-registry.service.ts:987-1002`）。若 handshake listener 抛错，pending deferred 不会被 reject，只能等到 15s/20s 超时；日志会记录 `runner.protocol_listener_failed`，但调用方看不到即时错误。建议 listener 抛错时显式 `noteTerminal` 或 reject 对应 pending。

---

## 13. 测试与门禁证据

### 13.1 实际运行的命令

所有命令都在独立审查工作树 `D:\CODE\GIT\Haft-p2-02-wpc-review`（detached `1eedb98`）中运行，依赖已通过 `pnpm install --offline --frozen-lockfile` 安装，Prisma Client 已生成。

| 套件/门禁 | 命令                                       | 独立运行结果                                                                                                                          | 判定     |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Contracts | `pnpm --filter @raft-lite/contracts test`  | **109 passed**，5 个测试文件                                                                                                          | **PASS** |
| API       | `pnpm --filter @raft-lite/api test`        | **70 passed**，6 个测试文件                                                                                                           | **PASS** |
| Runner    | `pnpm --filter @raft-lite/runner test`     | **124 passed**，16 个测试文件                                                                                                         | **PASS** |
| Web       | `pnpm --filter @raft-lite/web test`        | **41 passed**，11 个测试文件                                                                                                          | **PASS** |
| Typecheck | `pnpm typecheck`                           | 全部 workspace 通过                                                                                                                   | **PASS** |
| Lint      | `pnpm lint`（`eslint . --max-warnings=0`） | 0 error / 0 warning                                                                                                                   | **PASS** |
| Format    | `pnpm format:check`                        | `format:check: 53 unformatted file(s); 76 are grandfathered legacy debt.` / `format:check passed (changed files are Prettier-clean).` | **PASS** |

合计 **344 个测试、38 个测试文件**通过；与实现报告声称的 contracts 109 / API 70 / runner 124 / web 41 一致。实现报告的测试计数本身不作为证据，以上是本次独立运行结果。

### 13.2 迁移与数据库证据

已在仓库外副本中独立执行，不接触主仓库或开发数据库。详细结果见 §7.3，摘要：

| 场景                                                             | 结果                                                               | 判定     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| 全新 SQLite 执行 5 个 `prisma migrate deploy`                    | 全部应用，`All migrations have been successfully applied.`         | **PASS** |
| 同一 DB 重复 deploy                                              | `No pending migrations to apply.`                                  | **PASS** |
| 既有基线 DB（4 个基线迁移 + running/terminal 行）再应用 WP2 迁移 | terminal → `terminal`，running → `running`；再次 deploy 无 pending | **PASS** |
| 表结构/索引/审计表/外键                                          | 6 列、2 索引、审计表 8 列、FK cascade 均存在                       | **PASS** |
| `PRAGMA integrity_check`                                         | `ok`                                                               | **PASS** |

`prisma db push` 后直接 `migrate deploy` 得到 P3005，是项目现有测试初始化与正式迁移工作流的差异，不是 WP-C 迁移缺陷；正式从基线迁移部署的路径已独立验证。

### 13.3 测试覆盖与 Findings 的关系

现有测试全绿并不能推翻 F1/F2/F3，因为缺口正好位于测试未覆盖的时序窗口：

| Finding | 现有覆盖                                                                                                                         | 缺口                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F1      | `repository-handshake.spec.ts:333-358`（context ready 后 cancel）；`runner.integration.spec.ts:775-814`（session 存在后 cancel） | 没有 in-flight `prepare` 中 cancel；没有 repository 发送前 cancel；没有“cancel 后不得 start/spawn”断言               |
| F2      | `repository-handshake.spec.ts:266-308` 覆盖 accepted 在 spawn 前；`real-executor.spec.ts` 覆盖 context 缺失、进程关闭与强杀      | 没有“启动时 cached installed、start 时 live 缺失 → 必须 rejected”的断言；仓库中也没有 `CLI_NOT_INSTALLED` 的测试引用 |
| F3      | `repository-handshake.spec.ts:194-207` 覆盖顺序重发同一 contextId                                                                | 没有并发 prepare；没有 2s 重发与慢 prepare 的交错                                                                    |
| F4      | `runner.integration.spec.ts:305-322` 覆盖静态缺 feature 的 availability 拒绝                                                     | 没有 availability 与创建事务之间的 feature 变化；没有 POST zero-row 断言                                             |
| F5      | 没有                                                                                                                             | 没有 admission 异常后的 context 释放；没有 `starting` TTL                                                            |

### 13.4 未运行的测试

以下测试**没有**在本次审查中运行，不能把“存在测试文件”当作已验证：

- 完整 Playwright E2E（`pnpm test:e2e` / WP-E 范围）。
- 真实 CLI（codex/opencode）启动、认证、diff、进程树取消的 real-e2e。
- 多 API 实例、跨进程 pending map、真实网络断连/重连（WP-D 范围）。
- 生产规模 SQLite 数据量下的迁移耗时/锁行为。
- 负载/并发压力测试（多 runner、多 execution 同时握手）。

**§13 判定：PASS。** 已运行的 344 个测试和全部门禁通过；但这只证明已覆盖路径正确，不改变 §12 的 Findings。

---

## 14. 未验证项与证据边界

**§14 判定：PASS WITH WARNINGS。** 以下项目没有被本次审查独立证明，读者不应把它们视为已验收：

| #   | 未验证项                                     | 原因/边界                                                                               | 对结论的影响                                                           |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | F1 的完整“cancel 后 spawn CLI”端到端复现     | 只运行了 release-during-prepare 探针（1/1 通过），未保留人工延迟 + 真实 executor 的 E2E | 代码路径确定，结论不依赖 E2E；但修复后应有正式回归测试                 |
| 2   | F2 的 live CLI 缺失时序                      | 未注入 `resolveExecutable` 返回 null 的专用探针                                         | 代码路径确定；修复后应有 Runner 单测                                   |
| 3   | F3 的并发 prepare 时序                       | 未运行并发探针；F1 探针只证明异步窗口存在                                               | 代码路径确定；属于 WP-D 重发前必须补测的场景                           |
| 4   | F4 的 feature 切换竞态                       | 需要精确控制注册时序，本次未注入                                                        | 窄竞态，P3；不影响主路径                                               |
| 5   | F5 的 admission 异常路径                     | 未注入 `canAdmit` 抛错                                                                  | P3；修复后应有释放断言                                                 |
| 6   | 真实 CLI 的进程树取消                        | 未运行 real-e2e；现有 cancel 逻辑只通过 fake/单元测试                                   | §10 对“session 已存在”的 PASS 是基于代码与 fake 测试，不是真实进程证据 |
| 7   | Windows junction/符号链接/UNC 的真实路径逃逸 | WP-B 已审查；本次只确认 WP-C 接线，未重新做真实文件系统攻击测试                         | 路径安全结论继承 WP-B，不在本次重复证明                                |
| 8   | 多 API 实例下的 pending/定时器一致性         | 计划 §18.2 明确为 Phase 3+；单实例锁 `withLock` 不跨进程                                | 不属于 WP-C 范围，但不能据此认为生产多实例安全                         |
| 9   | 生产数据量迁移/长事务/锁                     | 只在空库和小样本既有库上跑 `migrate deploy`                                             | SQLite `ADD COLUMN` 风险低，但仍未验证                                 |
| 10  | 审计表长期增长与保留策略                     | 没有 retention/rotation 实现或测试                                                      | 不影响握手正确性，属于运维债务                                         |
| 11  | Web UI 对新增 DTO 字段的展示                 | 只运行了 web 单测；WP-E 未实现                                                          | 新增字段是 additive，现有 UI 不敏感                                    |
| 12  | 实现报告的“CLI admission”声明                | 报告声称 accepted 前检查 installed/authenticated；代码只查缓存                          | 已作为 F2 记录，声明不采信                                             |

### 14.1 证据分级回顾

- **实际运行：** §13 的 344 个测试、typecheck/lint/format、fresh/existing/repeat 迁移、F1 探针。
- **代码/迁移实证：** §8–§11 的行号引用、状态机条件更新、admission 顺序、迁移结构。
- **仅存在性核对：** 部分错误码、DTO 字段、测试名、计划条款的交叉引用。
- **报告声明未采信：** 实现报告的 PASS 表、测试计数（计数已独立复核但结论不采信）、CLI admission 声明、预启动 cancel 的 WP-D 延期说法。

### 14.2 对“实现报告称预启动 cancel 可延到 WP-D”的判定

实现报告第 267 行承认“预启动阶段的操作员取消可能等待/超时”，并把完整处理留给 WP-D。这个说法不能接受：

- WP-C 的冻结不变量 §6.5 第 2、3 条已经要求 cancel 中止准备且 cancel 后不发 start。
- 当前实现不是“取消稍后处理”，而是 **cancel 被丢弃后仍可能 spawn**，属于 WP-C 已经造成的错误状态。
- WP-D 可以在 WP-C 之后补齐“重连/恢复”的取消矩阵，但不能为 WP-C 的 spawn-after-cancel 兜底。

---

## 15. 最终验收结论与 WP-D 准入决定

### 15.1 WP-C 验收结论

**FAIL。** WP-C 的主路径（正常握手、条件状态迁移、快照/binding 重检、迁移、契约兼容、失败回滚）实现质量较好，344 个测试和全部门禁通过；但冻结不变量 §6.5 第 2、3 条和退出标准第 5 条被实际代码路径违反：

- **F1（P1）**：预启动取消不是持久意图；cancel 可能被丢弃，API 仍发送 `execution.start`，Runner 仍可能 spawn CLI。
- **F2（P2）**：missing CLI 不是 `execution.start.rejected`，而是 accepted 后 failed。
- **F3（P2）**：并发重复 repository 可能生成不同 contextId，破坏 executionId 幂等。

因此 WP-C **不能签署完成**，也不能以“测试全绿”或“实现报告已记录”替代冻结不变量。

### 15.2 退出标准逐条对照

| #   | §15 WP-C 退出标准                                                                          | 判定                   | 说明                                                                                 |
| --- | ------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------ |
| 1   | 成功顺序 repository → accepted → start → accepted                                          | **PASS**               | §8.1、§9.3；`repository-handshake.spec.ts:266-308`                                   |
| 2   | 没有有效 accepted 不发 start                                                               | **PASS**               | §8.2；`runner.integration.spec.ts:911-983`                                           |
| 3   | 没有 accepted 不 spawn CLI                                                                 | **PASS**               | `runner-client.ts:621-627`；正常 admission 路径                                      |
| 4   | `execution.start.rejected` 阻止 spawn                                                      | **PASS**               | `runner-client.ts:613-619`；现有测试覆盖 context/policy/busy                         |
| 5   | `RUNTIME_NOT_ENABLED`、`RUNNER_BUSY`、missing CLI 必须 rejected，不能 accepted-then-failed | **FAIL**               | missing CLI 失败，见 F2                                                              |
| 6   | binding/policy 变化在 start 前失败并 cancel                                                | **PASS**               | `recheckAndTransition`；`runner.integration.spec.ts:1029-1147`                       |
| 7   | 缺失 defaultBranch 由 repository 拒绝                                                      | **PASS**               | `repository-context.ts:95`；`repository-handshake.spec.ts:227-240`                   |
| 8   | 其他 Runner/platform 在预检和 post-accepted 重检均拒绝                                     | **PASS**               | `executions.service.ts:1172-1205`；`repository-handshake.service.ts:560-563,670-689` |
| 9   | start 发出后 binding 编辑不影响执行                                                        | **PASS**               | Execution 快照 + handshake 快照比较                                                  |
| 10  | 旧 Runner 在创建 Execution 前 409                                                          | **PASS WITH WARNINGS** | 静态场景 PASS；F4 的窄竞态可留下 1 条 failed 行                                      |

冻结不变量对照：

| §6.5 不变量                                                                | 判定     | 说明                                                                     |
| -------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| 1. 任何 start 前失败都发 `execution.cancel`                                | **PASS** | `repository-handshake.service.ts:260-276`                                |
| 2. Runner 在 preparing/ready 收到 cancel：中止准备、释放 context、不 spawn | **FAIL** | F1；in-flight prepare 不在 release 范围内                                |
| 3. API 在 cancel/rejection 后绝不发 start                                  | **FAIL** | F1；cancel 不改变 status/dispatchState，ACK 重检只要求 running           |
| 4. 不向非 validatedByRunnerId / 平台不匹配的 Runner 发 start               | **PASS** | 预检 + post-accepted 重检                                                |
| 5. 主 checkout 永不被触碰                                                  | **PASS** | worktree 隔离；WP-B 策略接线                                             |
| 6. terminal 后的 late accepted/rejected 被忽略                             | **PASS** | `noteTerminal` + pending 移除；`repository-handshake.service.ts:707-725` |

### 15.3 修复优先级（建议的 WP-C 收尾顺序）

1. **F1（必须，P1）：** Runner 增加 cancel intent / AbortController；API 持久化 cancel intent 并在 ACK 事务内检查；预启动取消必须有终态确认；补 in-flight prepare 与 pre-dispatch cancel 回归测试。
2. **F2（必须，P2）：** admission 在 accepted 前做 live CLI 检查；失败用 `REPOSITORY_CONTEXT_NOT_READY` + `CLI_NOT_INSTALLED:`/`CLI_NOT_AUTHENTICATED:`；补 cached-installed/live-missing 测试。
3. **F3（必须或 WP-D 前必须，P2）：** 增加 per-execution in-flight prepare promise / 串行化；补并发重发测试。
4. **F4、F5（建议，P3）：** 创建事务内重读 features；admission 异常释放 context + `starting` 短 TTL；补对应测试。
5. 修复后重新运行 §13 的全部测试与门禁，并请求独立复审；复审至少覆盖 F1/F2/F3 的新回归测试和零行/无 spawn 断言。

### 15.4 WP-D 准入决定

**WP-D 不可开始。**

| 决定          | 内容                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **WP-D 状态** | **BLOCKED**，直到 F1 修复并通过复审                                                                                      |
| **F1**        | **阻塞 WP-D**：恢复/取消矩阵不能建立在“cancel 可能被丢弃”的语义上                                                        |
| **F3**        | **阻塞 WP-D（WP-D 前必须修复）**：WP-D 的 repository 重发/重连依赖 executionId 幂等；并发 contextId 不一致会污染恢复关联 |
| **F2**        | **不阻塞 WP-D 开工**，但**阻塞 WP-C 验收**；应在 WP-C 收尾时修复                                                         |
| **F4/F5**     | 不阻塞 WP-D；可作为 WP-D 期间的加固项，但需保留 finding 跟踪                                                             |

WP-D 可以并行准备设计/测试草稿，但不得在 F1 修复前开始实现恢复扫描、重连矩阵或取消恢复，否则会把“取消后仍 spawn”的错误语义带入恢复路径。

### 15.5 结论复述

WP-C 的方向正确、主路径扎实、迁移与契约兼容性好；问题集中在**取消的持久性**、**admission 的 live 能力检查**和**repository 重发的并发幂等**这三个时序边界。它们不是 WP-D/E 未实现造成的范围外问题，而是 WP-C 已经能导致的错误启动/错误终态。修复 F1/F2/F3 并补齐针对性回归测试后，WP-C 具备重新验收的基础。

---

_本报告由独立审查生成，只新增 `docs/engineering/P2-02_WP-C_INDEPENDENT_REVIEW.md`；未修改任何产品代码、现有测试、roadmap 或实施计划。_
