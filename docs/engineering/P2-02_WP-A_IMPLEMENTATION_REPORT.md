# P2-02 WP-A 实施报告：Repository Validation

- 分支：`feature/p2-02-project-aware-runner`
- 基线 HEAD：`2db3b9f docs(p2-02): add independent WP-B review report`
- 工作区状态：仅包含本报告所列变更；未提交、未推送、未创建 PR
- 范围：WP-A（Runner `repository.validate` → API 关联 → Binding 条件更新），并吸收 WP-B 复核中要求随 WP-A 完成的事项
- 明确未实现：WP-C / WP-D / WP-E

## 1. 结论摘要

WP-A 已端到端落地：真实 Runner 收到 `repository.validate` 后只做路径策略校验，返回带 `requestId` 的 `repository.validation`；API 只在认证连接、实时 feature、项目/绑定/版本/请求 ID 全部匹配时，才用条件更新写入 Binding。`ready` 只能由完整成功结果产生，超时/离线和陈旧响应都不会覆盖当前状态。绑定 CRUD 仍然不发送任何 Runner 消息。

验证结果：

| 命令                                        | 结果                                       |
| ------------------------------------------- | ------------------------------------------ |
| `pnpm --filter @raft-lite/contracts test`   | 5 个文件 / 107 tests passed                |
| `pnpm --filter @raft-lite/runner test`      | 15 个文件 / 113 tests passed               |
| `pnpm --filter @raft-lite/api test`         | 6 个文件 / 63 tests passed                 |
| `pnpm --filter @raft-lite/runner typecheck` | passed                                     |
| `pnpm typecheck`                            | contracts / api / runner / web 全部 passed |
| `pnpm lint`                                 | passed                                     |
| `pnpm format:check`                         | passed（本次变更文件均为 Prettier-clean）  |

## 2. 已实现并已验证

### 2.1 Contracts

- `packages/contracts/src/types.ts`
  - 新增 `RepositoryValidationResultDto`：`binding`、`status`、`canonicalPath`、`platform`、`policyVersion`、`headCommit`、`validatedAt`、`errorCode`、`message`。
  - 未新增错误码、`defaultBranch` 或 `execution.start` 相关类型。
- 复用既有 `repository.validate` / `repository.validation` 协议 schema，未修改协议版本。

### 2.2 Runner

- `apps/runner/src/repository-validation-cache.ts`（新增）
  - 5 分钟 TTL、最多 500 条。
  - 以 `requestId` 为键，`payloadHash` 防止同 ID 不同 payload 覆盖。
  - 同 ID 同 payload 命中缓存；同 ID 不同 payload 返回 `REPO_VALIDATION_FAILED` 且不覆盖原结果。
  - 命中缓存时由 `RunnerClient.send()` 生成新的 envelope `messageId`，payload 原样重放。
- `apps/runner/src/runner-client.ts`
  - 新增 `repository.validate` case。
  - 校验 `payload.computerId === config.computerId`；不匹配返回 `REPO_VALIDATION_FAILED`。
  - 调用 `RepositoryPathPolicy.validate(path)`；策略未配置时由 `validate()` 返回 `REPOSITORY_POLICY_NOT_CONFIGURED`。没有在调用前抢先读取 `configError`，以保留 WP-B 已确认的“device path 先于配置错误拒绝”的顺序（计划 §9.4）。
  - 成功结果必须含 `canonicalPath` + `headCommit`；缺失时降级为 `REPO_VALIDATION_FAILED`。
  - 任意未预期异常转为 `REPO_VALIDATION_FAILED`，不会把异常抛回 socket 消息循环。
  - 不读取、不推断、不校验 `defaultBranch`，也不会返回 `REPO_DEFAULT_BRANCH_NOT_FOUND`。
  - `advertisedCapabilities()` 只宣告 `repository-validation-v1` 与 `repository-path-policy-v1`，`projectIds` 恒为 `[]`；Fake/Real 共用同一注册路径。
- `apps/runner/src/main.ts`
  - 将启动时构造的真实 `RepositoryPathPolicy` 注入 `RunnerClient`。
- `apps/runner/src/real-executor.ts`
  - WP-B P2-1 的 fail-closed seam：没有 repository context 时在创建 session / 写 journal / 准备 worktree 之前失败，失败原因保持 `PROJECT_BINDING_UNSUPPORTED`，不存在 cwd fallback。该实现比“仅补测试”更强，但只影响无 context 的失败路径。
  - `prepareAndRun` 对 `session.projectPath` 做显式不变量检查，绝不再把 `''` 传给 `git.prepare`（`resolve('')` 会落到进程 cwd，属于 fail-open）。

### 2.3 API

- `apps/api/src/modules/runners/runner-registry.service.ts`
  - 新增实时注册信息缓存 `liveRegistrations`（只在 `runner.register` 后建立，连接建立时清空、断开时删除）。
  - 新增 `onRepositoryValidation()`、`getLiveRegistration()`、`hasLiveFeatures()`。
  - `sendRepositoryValidate(runnerId, payload, messageId?)` 支持重试复用同一个 `messageId`。
  - 新增 `repository.validation` inbound 分支，事件携带认证得到的 `runnerId`、连接对应的 `computerId` 和实时注册的 `platform`；没有 live registration 的响应直接丢弃并记日志。
- `apps/api/src/modules/runners/repository-validation.service.ts`（新增）
  - 预检：项目存在且属于默认 workspace、绑定存在、按 `binding.computerId` 找到 Runner、Runner 在线、实时 feature 同时含两个 WP-A feature。
  - 生成 `requestId`，条件写入 `validationRequestId`（同时清理上次的错误字段），失败返回 `BINDING_VERSION_STALE`。
  - 以同一个 `messageId` + 同一 payload 在 `timeout/2` 重试一次；超时默认 15000ms，clamp 5000–30000ms，支持 `HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS` / `REPOSITORY_VALIDATION_TIMEOUT_MS`。
  - 关联校验：应答 `requestId` 必须匹配 pending；`event.runnerId`、`event.computerId`、`event.platform` 必须匹配认证连接；payload 的 project/computer/binding/version 必须匹配请求。
  - 成功要求 `canonicalPath` + `headCommit` + `policyVersion` + `platform` 全部存在；否则按 `REPO_VALIDATION_FAILED` 处理，API 不补造任何字段。其中 `platform`/`policyVersion` 在协议 schema 中是必填，`canonicalPath`/`headCommit` 是可选，因此规范化层对四个字段都保留防御检查。
  - 显式拒绝 `REPO_DEFAULT_BRANCH_NOT_FOUND`：该码只属于 WP-C 握手/上下文准备，若 Runner 从 `repository.validation` 返回它，视为协议违规并降级为 `REPO_VALIDATION_FAILED`，不会持久化为验证结果（计划 §8.5）。
  - 条件更新 `WHERE id + projectId + computerId + bindingVersion + validationRequestId`；`count=0` 记 `STALE_REPOSITORY_VALIDATION` 并返回 `BINDING_VERSION_STALE`。
  - 状态迁移：成功 → `ready`；`REPO_PATH_NOT_FOUND` → `missing`；其他失败 → `error`；超时保持状态不变并记录 `REPOSITORY_VALIDATION_TIMEOUT`，只清除仍属于本请求的 `validationRequestId`。
  - 并发采用 Last Request Wins；旧请求的应答因 marker/version 不匹配被丢弃。
  - 发送阶段同步抛异常时也会清理 pending/计时器/DB marker，并返回 409 `REPO_VALIDATION_FAILED`；应用关闭时 best-effort 清理仍属于 pending 的 `validationRequestId`。
  - 条件更新成功后的回读若发现行已被删除，映射为 404 `BINDING_NOT_FOUND`，不再抛 Prisma `P2025` 的 500。
- `apps/api/src/modules/projects/*`
  - 新增 `POST /api/projects/:projectId/bindings/:bindingId/validate`（无 body）。
  - 200 成功/业务失败；404 项目/绑定不存在；409 离线、feature 不支持、陈旧；504 超时。
  - 返回 `RepositoryValidationResultDto`。
  - Binding create/update/delete 路径未接入 validation，不发 Runner 消息。
- `apps/api/src/modules/runners/runners.module.ts` 注册/导出新服务；`projects.module.ts` 引入 `RunnersModule`。

### 2.4 WP-B 复核事项

- P2-1：新增 RealExecutor 默认 resolver 的 fail-closed 单测，断言失败原因、未调用 `git.prepare`、未写 journal、无 active session。
- P2-2：新增 RunnerClient capabilities 单测，断言 `projectIds === []`、只宣告两个 WP-A feature、配置无 `projectPaths`。
- P3-5：新增 `repo === worktreeRoot`、`repo === recoveryRoot`、recoveryRoot junction 指向 repo、Git 仓库子目录非根四类测试。
- P3-6：新增 `policyVersion` canonical JSON + SHA-256 前 16 位 golden test，显式锁定 `allowDevicePaths: false`、root 去重/排序。
- P3-7：`config.spec.ts` 的默认 root 不相交断言改用 `containsPath` 双向检查。
- P3-1/P3-2：只修正计划文档表述：Phase 1 exit 不再要求 grep 零命中（保留合法常量/迁移提示），§9.4 明确 device path 无条件先拒绝、不参与配置错误的顺序比较。
- P3-3（Windows subst 同/异步 realpath 差异）与 P3-4（detached HEAD、Git < 2.13 行为）按要求记录为后续事项，本次未改实现。

## 3. 测试覆盖

新增/修改的测试文件：

- `apps/runner/test/repository-validation-cache.spec.ts`（6 tests）：命中、冲突不覆盖、不同 requestId、TTL、容量逐出、默认常量。
- `apps/runner/test/runner-client-validation.spec.ts`（8 tests）：真实 Git 根成功、`REPO_PATH_NOT_FOUND` 原样返回、computer 不匹配、策略未配置、异常映射、缓存重放/新 envelope ID、同 ID 不同 payload 冲突、capabilities。
- `apps/api/test/repository-validation.integration.spec.ts`（23 tests）：
  - 成功 → `ready`，DB 字段与 DTO 一致
  - `REPO_PATH_NOT_FOUND` → `missing`，保留 `path`
  - 其他错误 → `error`
  - `REPO_DEFAULT_BRANCH_NOT_FOUND` → 协议违规，降级 `REPO_VALIDATION_FAILED` 并写 `error`
  - `ok=true` 同时携带 `REPO_DEFAULT_BRANCH_NOT_FOUND` → 仍拒绝，不进入 `ready`
  - `Project.defaultBranch` 指向不存在分支时，路径验证仍可成功 → `ready`（path-only 边界）
  - Runner 离线 → 409 `RUNNER_OFFLINE`，绑定不变
  - live features 缺失（即使 DB capabilitiesJson 声称支持）→ 409 `RUNNER_FEATURE_UNSUPPORTED`
  - live features 完整（即使 DB 快照为空）→ 成功，证明门禁读实时注册
  - 超时 → 504，状态不变，记录 `REPOSITORY_VALIDATION_TIMEOUT`，迟到响应不落库
  - 半超时重试复用同一 `messageId`/payload；重试后响应可成功
  - 重复响应/未知 requestId 不二次写库
  - 校验期间改 path → 409 `BINDING_VERSION_STALE`
  - 校验期间删绑定 → 404 `BINDING_NOT_FOUND`
  - 两次并发校验 → Last Request Wins
  - 其他 Runner 冒充响应 → 409 `REPO_VALIDATION_FAILED`
  - 响应 platform 与 live 连接不一致 → 409 `REPO_VALIDATION_FAILED`
  - `ok=true` 但缺 `canonicalPath` 或 `headCommit` → 参数化用例，降级为 `error` + `REPO_VALIDATION_FAILED`
  - `ok=true` 但缺 `platform` → 协议 schema 直接丢弃，最终 504，绑定不变
  - 未知项目/绑定 → 404
  - Binding CRUD 零 Runner 消息
  - 测试结束后恢复 `HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS` / `HAFT_RUNNER_BOOTSTRAP_TOKEN`，避免跨文件环境污染
- `apps/api/test/projects.integration.spec.ts`：原“validate 路由应为 404”的 P2-01 断言更新为“显式 validate 路由 + 无在线 Runner 时 409 且绑定不变”，避免与 WP-A 路由冲突。
- Runner 既有测试更新：`config.spec.ts`、`real-executor.spec.ts`、`repository-policy.spec.ts`。

说明：`/__test__/reset` 按设计保留 Runner/Computer 环境行，因此新的 API 集成测试使用专用 computer（`computer_repository_validation`），并在 `afterAll` 删除本文件创建的 Runner/Computer，防止污染 `runner.integration.spec.ts` 的 Runner 列表断言。

## 4. 已实现但未直接验证

- `main.ts` 的真实 `RepositoryPathPolicy` 注入通过 typecheck/代码审阅确认，未做“启动完整 Runner 进程”测试。
- 超时环境变量 clamp 的边界值（5000/30000）未逐值做集成测试；集成测试使用 5000ms 验证了半超时重试与 504 行为。
- API 多实例部署下的 pending map / live registration 共享未验证（当前为进程内状态，需要粘性路由或后续共享事件总线）。
- Linux 路径策略矩阵未在本机运行（本机 Windows）；既有 WP-B 结论仍适用。
- 真实 Runner + 真实 API 的 E2E 未运行；WP-A 集成测试使用协议级 fake socket runner。

## 5. 未实现（明确不在 WP-A）

- WP-C：`RepositoryContextManager`、repository handshake、`dispatchState`、`execution.start` 门禁、Prisma Execution 字段/迁移。
- WP-D / WP-E：UI repository card、validation panel。
- `defaultBranch` 的读取/校验（path validation 不涉及分支）；仅保留 API 对 `REPO_DEFAULT_BRANCH_NOT_FOUND` 的防御性拒绝。
- 新的错误码、`execution.start` 协议变更、`HAFT_RUNNER_PROJECTS` 回归、伪造 `projectIds`。
- 旧 `PROJECT_NOT_MAPPED` / `projectIds` 门禁（P1-1 的既有 E2E 过渡失败保持原状，本 WP 不处理）。
- P3-3 / P3-4 的实现级修复（WP-B 复核项，Windows subst / Git 版本与 detached HEAD）。

## 6. 实现决策与残余风险

1. **失败时清理 provenance**：成功→ready 写入 `validatedByRunnerId`/`platform`；失败→missing/error 时同时清空 `platform` 与 `validatedByRunnerId`，比计划 §5.2 的最小字段列表更严格（避免 error/missing 状态仍显示旧的“已验证”来源）。执行门禁仍要求 `status='ready'`，因此不影响后续 WP-C 判定。
2. **超时后的 DB 写入无独立计时器**：超时计时器负责在等待应答阶段返回 504；收到应答后的关联/条件更新按本地 DB 延迟完成。若 DB 极慢，HTTP 响应可能晚于超时值，但不会错误写库。
3. **Runner 缓存只覆盖“已完成”的请求**：半超时重试若首个请求仍在执行，可能触发第二次策略执行；缓存保证完成后重放不重复执行，协议未要求 in-flight 合并。该并发窗口记录为后续优化（WP-A 独立复核 P3-1）。
4. **API 进程内状态**：pending 请求与 live registration 都是单进程内存；多实例部署需要 sticky session/共享事件总线，属于部署层事项。
5. **测试环境清理**：因测试 reset 保留 Runner/Computer，新增集成测试显式使用并清理专用身份，避免跨文件污染。
6. **`platform`/`policyVersion` 的协议必填**：`repositoryValidationPayloadSchema` 已要求两者非空，API 的规范化检查是防御层；集成测试只能通过未通过 schema 的消息模拟“缺失 platform”，最终表现为消息被丢弃并超时。

## 6.1 WP-A 独立复核吸收

独立复核结论为 PASS WITH WARNINGS，提出 2 个 P2 与若干 P3。本次已处理：

- P2-1（格式门禁）：报告与 `runner-registry.service.ts`、`real-executor.spec.ts` 已格式化；`pnpm format:check` 重新执行为 passed。
- P2-2（协议违规码）：`normalizeOutcome` 在成功分支之前无条件拒绝 `REPO_DEFAULT_BRANCH_NOT_FOUND`（含 `ok=true` 组合），降级 `REPO_VALIDATION_FAILED`，并补两条集成测试。
- P3-1（缓存 in-flight）：未实现合并，记录为后续；当前不会造成错误终态。
- P3-2（cwd 隐患）：`prepareAndRun` 增加空 `projectPath` 不变量检查，`git.prepare` 不再接收 `''`。
- P3-3（失败 provenance）：保留“失败即清空 `platform`/`validatedByRunnerId`”的严格决策，并在本报告 §6.1 记录。
- P3-4（测试缺口）：补 live-vs-DB feature 双向用例、`canonicalPath`/`headCommit` 参数化缺失、`defaultBranch` 分离用例、环境变量恢复。`policyVersion` 在协议 schema 中必填，无法通过正常 socket 消息构造缺失，故仅保留 API 防御检查并由 schema 测试覆盖。
- P3-5（生命周期）：首次发送与半超时重试均捕获同步异常并清理 pending/marker；关闭时 best-effort marker 清理。
- P3-6（fail-closed 事件序列）：保留实现并在本报告记录；WP-C 交接时需注意无 context 失败不再走 `preparing`/journal 分支。
- P3-7（文件清单）：已将本报告加入新增清单。
- P3-8（回读竞态）：回读改为 `findUnique`，行被删除时映射 404；混合快照窗口仍在，但不再产生 500。
- P3-9（`ok=true` + branch code）：已修复，见 P2-2。
- P3-10（重试发送异常）：已补 try/catch，并 reject 等待中的 HTTP promise，避免计时器未捕获异常或请求悬挂。
- P3-12（测试状态恢复）：`afterAll` 恢复 seed project 的 `defaultBranch`。

## 7. 变更文件

新增：

- `apps/runner/src/repository-validation-cache.ts`
- `apps/runner/test/repository-validation-cache.spec.ts`
- `apps/runner/test/runner-client-validation.spec.ts`
- `apps/api/src/modules/runners/repository-validation.service.ts`
- `apps/api/test/repository-validation.integration.spec.ts`
- `docs/engineering/P2-02_WP-A_IMPLEMENTATION_REPORT.md`
- `docs/engineering/P2-02_WP-A_INDEPENDENT_REVIEW.md`（独立复核报告）

修改：

- `packages/contracts/src/types.ts`
- `apps/runner/src/runner-client.ts`
- `apps/runner/src/main.ts`
- `apps/runner/src/real-executor.ts`
- `apps/runner/src/repository-policy.ts`
- `apps/runner/test/real-executor.spec.ts`
- `apps/runner/test/repository-policy.spec.ts`
- `apps/runner/test/config.spec.ts`
- `apps/api/src/modules/runners/runner-registry.service.ts`
- `apps/api/src/modules/runners/runners.module.ts`
- `apps/api/src/modules/projects/projects.controller.ts`
- `apps/api/src/modules/projects/projects.service.ts`
- `apps/api/src/modules/projects/projects.module.ts`
- `apps/api/test/projects.integration.spec.ts`
- `docs/engineering/P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md`（仅 P3-1/P3-2 措辞）

未提交、未推送、未创建 PR。
