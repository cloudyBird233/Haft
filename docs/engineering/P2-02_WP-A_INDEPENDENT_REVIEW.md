# P2-02 WP-A 独立复核报告：Repository Validation

- 复核对象：`feature/p2-02-project-aware-runner` 工作区（未提交）
- 基线 HEAD：`2db3b9f docs(p2-02): add independent WP-B review report`
- 复核方式：独立只读复核（未修改文件、未提交、未推送、未创建 PR）
- 复核范围：WP-A（Runner `repository.validate` → API 关联 → Binding 条件更新），以及 WP-B 复核吸收项
- 复核轮次：初评 → 修复后增量复核 → 最终确认

## 1. 最终结论

**PASS WITH WARNINGS**

> WP-A 独立复核结论为 PASS WITH WARNINGS：P2-1、P2-2（含 P3-9）已修复且无 P1/P2 遗留；剩余 P3-1（缓存未合并 in-flight）、P3-3（失败清空 provenance 与计划字段口径不同）、P3-4（`policyVersion` 仅 schema 级覆盖）、P3-8（按 id 回读仍存在混合快照窗口）为已记录技术债，不阻塞进入 WP-C。

- 未发现 P1（阻断）或 P2（应修）级遗留问题。
- 主链路在代码层面符合计划：真实 Runner 只做路径策略校验，API 只在认证连接、实时 feature、项目/绑定/版本/请求 ID 全部匹配时条件写入 Binding。
- `ready` 只能由完整成功结果产生；超时、离线、陈旧响应、身份/platform 不匹配都不会覆盖当前状态。
- Binding CRUD 不发送任何 Runner 消息。
- 未触碰 WP-C / WP-D / WP-E，未修改 `execution.start`、Prisma Execution schema、`RepositoryContextManager`、`dispatchState`、`PROJECT_NOT_MAPPED` 或 `docs/phase-2-technical-roadmap.md`。

## 2. 复核方法

独立复核执行了：

- `git status` / `git diff` / 逐文件源码阅读；
- `pnpm exec tsc --noEmit`（contracts / api / runner / web）；
- `pnpm lint`；
- `pnpm format:check`；
- `prettier --list-different` 定点检查；
- `vitest list --json` 核对测试文件与用例数量；
- `policyVersion` golden hash 手工核对。

受只读约束，复核者未重跑会写 `apps/api/test.db` 的 API 测试，也未重跑会生成临时 Git 仓库的 Runner 测试；因此下文“测试 passed”分为两类：

- **独立验证**：format / lint / typecheck / 测试清单数量；
- **实施方实测**：contracts 107、runner 113、api 63 的实际 passed 结果（复核者只核对了清单数量一致）。

## 3. 初评发现与修复状态

### P2-1 格式门禁实际失败，实施报告声明不实（已修复）

- 初评证据：`pnpm format:check` 失败，报告却写 passed；涉及报告自身以及本次修改的 `runner-registry.service.ts`、`real-executor.spec.ts`。
- 修复：三个文件已 Prettier 格式化；报告已更新。
- 复核：`pnpm format:check` 实测通过（`51 unformatted / 76 legacy`，changed files clean）；相关文件 `prettier --list-different` 无输出。
- 状态：**FIXED**。

### P2-2 API 未拒绝 `REPO_DEFAULT_BRANCH_NOT_FOUND`（已修复）

- 初评证据：`normalizeOutcome` 只特判 `REPO_PATH_NOT_FOUND`，其余错误码原样持久化，违反计划 §8.5。
- 修复：`normalizeOutcome` 在 `response.ok` 分支之前无条件拒绝 `REPO_DEFAULT_BRANCH_NOT_FOUND`，降级为 `REPO_VALIDATION_FAILED`。
- 补强：新增两条集成测试：
  - `ok=false` + 该错误码 → HTTP 200 / `status=error` / `validationErrorCode=REPO_VALIDATION_FAILED`；
  - `ok=true` + 完整 facts + 该错误码 → 同样拒绝，不进入 `ready`（初评后的 P3-9）。
- 复核：检查确认 branch 错误码检查位于成功分支之前；两条测试均通过。
- 状态：**FIXED**（含 P3-9）。

## 4. 其余 Findings 状态

| 编号  | 内容                                                                     | 状态                       | 证据 / 说明                                                                                                                                      |
| ----- | ------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-1  | Runner 缓存无 in-flight 合并，半超时重试可能重复执行一次策略             | **记录为技术债**           | `repository-validation-cache.ts` 只缓存已完成结果；不造成错误终态，报告 §6.1 已记录                                                              |
| P3-2  | `session.projectPath ?? ''` 可能把空字符串传给 `git.prepare`（cwd 回退） | **FIXED**                  | `real-executor.ts` 增加非空不变量检查，`git.prepare` 不再接收 `''`                                                                               |
| P3-3  | 失败路径清空 `platform`/`validatedByRunnerId`，超出计划 §5.2 最小字段集  | **已记录决策，计划未同步** | 失败即清除 provenance，避免 error/missing 仍显示旧验证来源；报告 §6.1 明确记录                                                                   |
| P3-4  | 测试覆盖缺口                                                             | **基本 FIXED**             | 已补 live-vs-DB 双向、`defaultBranch` 分离、`canonicalPath`/`headCommit` 参数化、env 恢复；`policyVersion` 由 schema 必填覆盖，无 API 级缺失用例 |
| P3-5  | 生命周期清理不完整                                                       | **FIXED**                  | 首次发送与 retry 均捕获同步异常并清理 pending/marker；关闭时 best-effort 清理 marker                                                             |
| P3-6  | fail-closed 提前失败改变事件序列（不再发 `preparing`/写 journal）        | **记录项**                 | 报告已记录，WP-C 交接需注意                                                                                                                      |
| P3-7  | 报告 §7 文件清单遗漏报告自身                                             | **FIXED**                  | 已加入报告自身与独立复核报告                                                                                                                     |
| P3-8  | 条件更新后按 id 回读存在混合快照窗口                                     | **部分缓解**               | `findUnique` 返回 null 时映射 404，不再产生 Prisma P2025 的 500；混合快照窗口仍在，已记录                                                        |
| P3-9  | `ok=true` + `REPO_DEFAULT_BRANCH_NOT_FOUND` 仍会被接受                   | **FIXED**                  | 检查移到成功分支之前，并新增集成测试                                                                                                             |
| P3-10 | retry 定时器中的发送异常未保护                                           | **FIXED**                  | try/catch + `abandonPending().finally(() => pending.reject(...))`，无 double-settle / 请求悬挂                                                   |
| P3-11 | 报告列出不存在的独立复核报告文件                                         | **FIXED**                  | 本文件已生成                                                                                                                                     |
| P3-12 | `defaultBranch` 测试未在 `afterAll` 恢复                                 | **FIXED**                  | `project.updateMany` 恢复为 `main`                                                                                                               |

## 5. 需求覆盖矩阵

| #   | 复核项                                                                                            | 结论 | 证据 / 说明                                                                                                |
| --- | ------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 仅 WP-A；只新增 `RepositoryValidationResultDto`                                                   | PASS | contracts 仅 `types.ts` +21 行；无 schema/constants/protocol 变更                                          |
| 2   | 复用冻结 P2-00 协议                                                                               | PASS | `runner-protocol.ts` 无 diff；`repository.validate` / `repository.validation` 为基线消息                   |
| 3   | Runner 缓存 5 分钟/500 条/幂等/冲突/重放新 envelope ID                                            | PASS | 缓存实现与单测齐全；冲突不覆盖；重放由 `send()` 生成新 `messageId`；并发窗口见 P3-1                        |
| 4   | Runner 校验 computerId、调用 policy、configError 映射、异常兜底、不读 defaultBranch、capabilities | PASS | `runner-client.ts` 实现齐全；Runner 源码无 `defaultBranch`；只宣告两个 WP-A feature，`projectIds=[]`       |
| 5   | API live registration / live feature 门禁                                                         | PASS | `hasLiveFeatures` 读 live map；新增 live-vs-DB 双向集成测试锁定                                            |
| 6   | API 关联、条件更新、Last Request Wins、超时/重试、身份/platform、协议违规码                       | PASS | 条件更新 WHERE 完整；半超时同 `messageId`/payload；branch 错误码已无条件拒绝                               |
| 7   | REST 状态码与 DTO                                                                                 | PASS | 200 成功/业务失败；404 项目/绑定缺失；409 离线/不支持/陈旧；504 超时；返回 `RepositoryValidationResultDto` |
| 8   | WP-B 吸收项 P2-1 / P2-2 / P3-5 / P3-6 / P3-7 / P3-1 / P3-2 / P3-3 / P3-4                          | PASS | P2-1、P2-2、P3-5、P3-6、P3-7 已补测/修正；P3-1/P3-2 仅文档措辞；P3-3/P3-4 记录为后续（WP-B 项）            |
| 9   | 测试与报告一致性                                                                                  | PASS | 数量经 `vitest list` 核对：contracts 5/107、runner 15/113、api 6/63；format/lint/typecheck 独立通过        |
| 10  | 禁止 WP-C/D/E、schema、`execution.start`、`PROJECT_NOT_MAPPED`、`HAFT_RUNNER_PROJECTS` 回归       | PASS | diff 未触及这些区域；`real-executor` fail-closed 属 WP-B P2-1 要求                                         |
| 11  | Binding CRUD 零 Runner 消息                                                                       | PASS | 集成测试断言 create/update/delete 期间未收到任何 Runner 消息                                               |

## 6. 测试与报告一致性

| 报告声明                            | 独立复核                                    | 结论                 |
| ----------------------------------- | ------------------------------------------- | -------------------- |
| contracts 5 文件 / 107 tests passed | `vitest list`：5 / 107                      | 数量一致；未独立执行 |
| runner 15 文件 / 113 tests passed   | `vitest list`：15 / 113                     | 数量一致；未独立执行 |
| api 6 文件 / 63 tests passed        | `vitest list`：6 / 63（validation 文件 23） | 数量一致；未独立执行 |
| `pnpm typecheck` 全部 passed        | 独立 `tsc --noEmit` / 根脚本通过            | 一致                 |
| `pnpm lint` passed                  | 独立执行通过                                | 一致                 |
| `pnpm format:check` passed          | 独立执行通过                                | 一致                 |
| golden hash `db4c97086eb740a2`      | 序列化输入与测试一致                        | 一致                 |
| 真实 Runner + 真实 API E2E 未运行   | 报告 §4 已如实披露                          | 一致（未验证项）     |

测试隔离复核：

- 新增 API 集成测试使用专用 `computer_repository_validation` / `runner_validation_integration` 等身份，并在 `afterAll` 删除，避免 `/__test__/reset` 保留 Runner/Computer 导致跨文件污染；
- `afterAll` 恢复 `HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS`、`HAFT_RUNNER_BOOTSTRAP_TOKEN` 和 seed project 的 `defaultBranch`；
- 未发现新增测试的高概率竞态。

## 7. 范围纪律

- 未修改 `apps/api/src/modules/executions/`、`RepositoryContextManager`、`dispatchState`、Prisma schema/migrations、`packages/contracts/src/runner-protocol.ts` / `constants.ts` / `schemas.ts`、`execution.start`、`PROJECT_NOT_MAPPED`、`docs/phase-2-technical-roadmap.md`。
- 未恢复 `HAFT_RUNNER_PROJECTS` 执行路径；Runner 仍只忽略并警告。
- `apps/runner/src/real-executor.ts` 的 fail-closed 提前失败是 WP-B P2-1 “无 journal/worktree 写入”要求所必需的实现变更，已披露；其事件序列变化（无 context 失败不再走 `preparing`/journal）记录给 WP-C。
- 计划文档仅按 WP-B 复核 P3-1/P3-2 修正措辞，未发生规范漂移。
- 工作区未提交、未推送、未创建 PR，符合交付要求。

## 8. 剩余风险与建议

1. **P3-1**：为 Runner 缓存增加 in-flight 合并，避免半超时重试重复执行 FS/Git；不阻塞 WP-C。
2. **P3-3**：确认失败后 provenance 的产品/审计口径，并同步计划 §5.2 或保留报告中的严格决策。
3. **P3-4**：`policyVersion` 缺失只能由协议 schema 拦截；如需 API 级防御测试，可对规范化函数做单元测试。
4. **P3-8**：如需返回严格一致快照，可将条件更新与回读放入交互式事务；当前窗口不影响 DB 终态。
5. **未验证项**：真实 Runner + 真实 API 的 E2E、Linux 路径策略矩阵、API 多实例下 pending/live registration 共享；均已在实施报告 §4 披露。

## 9. 最终建议

可以进入 WP-C 的设计与准备。WP-A 主链路、协议边界、REST 语义、测试与质量门禁均已达到可交付状态；剩余事项均为已记录的技术债或部署层未验证项，不构成本阶段的阻断。
