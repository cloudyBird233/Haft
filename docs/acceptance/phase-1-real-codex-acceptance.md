# Haft Phase 1：真实 Codex Runtime 端到端验收报告

> **验收结论：BLOCKED**
>
> 本次验收在环境预检阶段发现前置能力缺失：Haft 当前没有 Project 创建 API/UI，无法按验收要求创建专用 Project。按照“发现关键步骤失败必须停止后续依赖步骤”的验收原则，未创建验收仓库、未启动服务、未执行真实 Codex、未运行自动化测试，也未伪造任何执行结果。
>
> 报告生成时间：2026-11-07T15:23:30+08:00（China Standard Time）
>
> 产品在代码和文档中的实际名称为 **Raft Lite**，与任务中的 “Haft” 指同一仓库。

---

## 1. 验收时间

| 项目 | 值 |
| --- | --- |
| 验收阶段 | 环境预检 / 阻塞记录 |
| 预检完成时间 | 2026-11-07 15:23:30 +08:00 |
| 时区 | China Standard Time (UTC+08:00) |
| 是否进入执行阶段 | 否 |
| 阻塞原因 | 缺少 Project 创建 API/UI，无法满足“创建专用 Project”的前置条件 |

---

## 2. 环境信息

| 项目 | 值 | 状态 |
| --- | --- | --- |
| 操作系统 | Microsoft Windows 11 专业版 10.0.26200，64-bit | PASS |
| Node.js | v24.14.0（要求 >= 20.19） | PASS |
| pnpm | 11.5.2 | PASS |
| Git | 2.46.0.windows.1 | PASS |
| Codex CLI | codex-cli 0.164.0 | PASS |
| Codex 认证 | `codex login status` → `Logged in using ChatGPT` | PASS |
| Playwright | 1.64.1 | PASS |
| Playwright Chromium | 已安装（`chromium-1228` / `chromium-1248` / headless shell） | PASS |
| Haft API | 未启动，端口 3001 空闲 | NOT_VERIFIED |
| Haft Web | 未启动，端口 5173 空闲 | NOT_VERIFIED |
| Haft Runner | 未启动，Runner token 缓存目录 `~/.haft` 不存在 | NOT_VERIFIED |
| 验收测试仓库 | `D:\CODE\GIT\haft-real-acceptance` 不存在 | NOT_VERIFIED |
| 验收 Worktree 根 | `D:\CODE\GIT\haft-real-acceptance-worktrees` 不存在 | NOT_VERIFIED |
| 验收数据库 | `apps/api/prisma/acceptance.db` 不存在 | NOT_VERIFIED |
| 验收报告目录 | `docs/acceptance` 原不存在（本报告创建） | PASS |

### 2.1 端口检查结果

```text
3001 free
3101 free
3201 free
5173 free
5174 free
3299 free
3199 free
3399 free
```

### 2.2 安全说明

- 未读取、打印或泄露 Codex 的 `auth.json` 或任何认证密钥。
- 仅执行 `codex login status` 查询认证状态。
- 未启动 Runner，因此未创建或读取 Runner token 文件。

---

## 3. Haft 版本和 Git Commit

| 项目 | 值 |
| --- | --- |
| 产品名称 | Raft Lite（任务中称为 Haft） |
| 包版本 | `0.1.0`（根 `package.json`） |
| 当前分支 | `main` |
| HEAD Commit | `cf39a76d268f647cb87ca64fd2a9ca23e77a1c0d` |
| Commit 标题 | `feat: add runner architecture and real CLI execution` |
| 工作区状态 | `git status --short` 无输出（干净） |
| `git diff --stat` | 无输出（无未提交修改） |
| `git worktree list` | 仅 `D:/CODE/GIT/Haft  cf39a76 [main]` |

验收开始前的基线已记录：

```text
branch: main
HEAD: cf39a76d268f647cb87ca64fd2a9ca23e77a1c0d
status: clean
worktrees: D:/CODE/GIT/Haft  cf39a76 [main]
```

> 说明：`docs/REPORT.md` 的“Repository state”段落称 Phase 1 工作全部未提交，但当前仓库实际是干净状态并停在 `cf39a76`。这是文档时效性差异，不影响本次阻塞结论，但建议后续修正。

---

## 4. Codex CLI 版本

### 4.1 实际版本

```text
$ codex --version
codex-cli 0.164.0
```

### 4.2 认证状态

```text
$ codex login status
Logged in using ChatGPT
```

### 4.3 CLI 参数兼容性

已检查实际安装的 Codex CLI 帮助信息，Runner 使用的参数均存在：

```text
$ codex exec --help

Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
  -C, --cd <DIR>
      --ephemeral
      --color <COLOR>
      --json
```

Runner 实际构造的命令为：

```text
codex exec --json --color never --ephemeral --sandbox workspace-write -C <worktree> [-m <model>] -
```

结论：**PASS**。Codex CLI 版本与 Runner 的参数构造兼容，任务文本通过 stdin 传入，未放入命令行。

---

## 5. Runner 状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Runner 进程 | NOT_VERIFIED | 未启动 |
| Runner 配对 | NOT_VERIFIED | 不存在 `~/.haft/runner-*.json` |
| Runner 在线状态 | NOT_VERIFIED | 未调用 `/api/runners` |
| Codex Runtime 能力 | NOT_VERIFIED | 未调用 `/api/runtimes` |
| 项目映射 | NOT_VERIFIED | 未配置 `HAFT_RUNNER_PROJECTS` |

由于验收在 Project 创建阶段被严格阻塞，Runner 未启动，因此没有 Runner ID、健康状态、CLI capability 快照或项目映射证据可供记录。不得用推测值替代实际结果。

---

## 6. Agent ID

**N/A（未创建）**

未通过 Haft Web 创建 Codex Agent。原因：验收要求先创建专用 Project，而 Haft 当前没有 Project 创建能力，后续依赖步骤按严格阻塞原则未执行。

---

## 7. Task ID

**N/A（未创建）**

未通过 Haft Web 创建验收 Task。不得使用直接数据库写入或测试工厂绕过业务前置条件。

---

## 8. Execution ID

**N/A（未执行）**

未点击真实 Start，未创建 Execution。没有 Execution ID 可用于 Worktree、日志或 Git 证据关联。

---

## 9. Worktree 路径

**N/A（未创建）**

验收测试仓库和 Worktree 根目录均未创建：

```text
D:\CODE\GIT\haft-real-acceptance              -> 不存在
D:\CODE\GIT\haft-real-acceptance-worktrees    -> 不存在
```

因此不存在可检查的 Worktree 路径，也无法验证其与原始仓库路径不同的隔离性。

---

## 10. Git Branch

**N/A（未创建）**

未产生 Execution，因此没有 Haft 约定的 `haft/<executionId>` 分支。

---

## 11. Base Commit

**N/A（未创建）**

验收测试仓库未初始化，未产生初始 Commit。Haft 开发仓库的 `cf39a76...` 仅是开发仓库基线，不是一次 Execution 的 Base Commit。

---

## 12. Head Commit

**N/A（未创建）**

没有 Worktree，也没有 CLI 执行，因此没有 Worktree Head Commit。也无法验证“未自动 Commit”这一结果。

---

## 13. 实际执行日志

**无。**

未启动真实 Codex 执行，因此没有任何 Mock Runtime、Fake Runner 或真实 Codex CLI 日志。不得用预检命令输出冒充 Execution 日志。

本次预检实际执行的只读命令及输出如下，仅作为环境证据：

```text
$ node --version
v24.14.0

$ pnpm --version
11.5.2

$ git --version
git version 2.46.0.windows.1

$ codex --version
codex-cli 0.164.0

$ codex login status
Logged in using ChatGPT

$ git rev-parse --abbrev-ref HEAD
main

$ git rev-parse HEAD
cf39a76d268f647cb87ca64fd2a9ca23e77a1c0d

$ git status --short
(no output)
```

---

## 14. Git Diff

**无。**

没有 Worktree、没有 CLI 修改，因此不存在可展示的 Git Diff、`git diff --stat`、未跟踪文件或目标文件内容。

此外，静态检查发现 Haft Web 自身也没有 Git Diff 展示功能（见第 18.3 节），因此即使执行成功，也无法在 Execution 页面满足“完成后展示 Git Diff”的要求。

---

## 15. Task / Agent / Execution 最终状态

| 实体 | 最终状态 | 说明 |
| --- | --- | --- |
| Task | N/A | 未创建 |
| Agent | N/A | 未创建 |
| Execution | N/A | 未执行 |

无法验证以下要求：

- Execution `status = completed`
- Execution `runtime = codex`
- Execution `exitCode = 0`
- Execution `branchName` 正确
- Execution `baseCommit` 正确
- Execution `changedFiles` 正确
- Execution `summary` 非空
- Task `status = done`
- Agent `status = idle`

---

## 16. 原始工作区安全检查

### 16.1 Haft 开发仓库

验收前后均检查 `D:\CODE\GIT\Haft`：

```text
branch: main
HEAD: cf39a76d268f647cb87ca64fd2a9ca23e77a1c0d
git status --short: (empty)
git diff --stat: (empty)
git worktree list: D:/CODE/GIT/Haft  cf39a76 [main]
```

| 检查项 | 结果 |
| --- | --- |
| 是否有意外修改 | 否 |
| 是否有意外删除 | 否 |
| 是否有未授权的新文件 | 否（本报告是唯一新增的验收产物） |
| 是否有分支变化 | 否，仍为 `main` |
| 是否有 Git 配置变化 | 未执行任何 Git 配置写入；未修改 `.git/config` |
| 是否清理用户原有文件 | 否 |
| 是否自动 Commit / Push / Merge | 否 |

### 16.2 验收测试仓库

未创建，因此不存在被修改的测试仓库。

**结论：PASS（未对原始 Haft 工作区造成任何非授权修改）。**

---

## 17. 自动化测试结果

**NOT_VERIFIED（未运行）。**

按照严格阻塞原则，未执行以下自动化测试：

```text
pnpm test
pnpm test:e2e
HAFT_REAL_CLI_E2E=1 pnpm test:e2e:real
```

原因：验收前置条件（创建专用 Project）无法满足，继续运行测试不能证明本次真实 Codex 业务闭环。未运行的结果不得记为 PASS。

已执行的仅是环境预检命令（`node --version`、`pnpm --version`、`git --version`、`codex --version`、`codex login status`、`codex exec --help`），不属于自动化测试套件。

---

## 18. 验收结论

### 18.1 总体结论

**BLOCKED。**

本次验收未能进入真实 Codex 执行阶段。阻塞点是产品能力缺失，而不是环境不可用：

- Node.js、pnpm、Git、Codex CLI 和 Codex 认证均正常。
- Haft 开发仓库干净，基线可复现。
- Haft 没有 Project 创建 API/UI，无法满足“创建专用 Project”的硬性前置条件。

### 18.2 验收项目清单

| # | 验收项目 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | Node.js / pnpm / Git 可用 | PASS | 版本满足要求 |
| 2 | Codex CLI 已安装 | PASS | `codex-cli 0.164.0` |
| 3 | Codex 已认证 | PASS | `Logged in using ChatGPT` |
| 4 | Codex CLI 参数与 Runner 兼容 | PASS | `exec --json --color --ephemeral --sandbox -C -m -` 均存在 |
| 5 | Haft API 可用 | NOT_VERIFIED | 未启动 |
| 6 | Haft Web 可用 | NOT_VERIFIED | 未启动 |
| 7 | Haft Runner 可用 | NOT_VERIFIED | 未启动 |
| 8 | Runner 在线 | NOT_VERIFIED | 未启动 |
| 9 | Codex Runtime 能力可用 | NOT_VERIFIED | 未调用 `/api/runtimes` |
| 10 | 项目映射正确 | NOT_VERIFIED | 未配置 Runner 项目映射 |
| 11 | 创建专用 Project | **BLOCKED** | Haft 无 Project 创建 API/UI |
| 12 | 创建独立测试仓库 | NOT_VERIFIED | 按严格阻塞未创建 |
| 13 | 通过 UI 创建 Codex Agent | NOT_VERIFIED | 未执行 |
| 14 | 通过 UI 创建 Task | NOT_VERIFIED | 未执行 |
| 15 | 通过 UI 点击真实 Start | NOT_VERIFIED | 未执行 |
| 16 | Worktree 创建 | NOT_VERIFIED | 未执行 |
| 17 | Worktree 路径与原始仓库不同 | NOT_VERIFIED | 未执行 |
| 18 | 独立分支 `haft/<executionId>` | NOT_VERIFIED | 未执行 |
| 19 | Base Commit 正确 | NOT_VERIFIED | 未执行 |
| 20 | 原始测试仓库未被修改 | NOT_VERIFIED | 未创建测试仓库 |
| 21 | 目标文件已修改 | NOT_VERIFIED | 未执行 |
| 22 | 新文件已创建 | NOT_VERIFIED | 未执行 |
| 23 | 无自动 Commit / Push / Merge | NOT_VERIFIED | 未执行 |
| 24 | 实时日志来自真实 Codex | NOT_VERIFIED | 未执行 |
| 25 | stdout / stderr 被采集 | NOT_VERIFIED | 未执行 |
| 26 | 日志序号递增 | NOT_VERIFIED | 未执行 |
| 27 | 刷新后日志仍存在 | NOT_VERIFIED | 未执行 |
| 28 | 执行期间取消按钮有效 | NOT_VERIFIED | 未执行 |
| 29 | Execution `completed` / `runtime=codex` / `exitCode=0` | NOT_VERIFIED | 未执行 |
| 30 | `branchName` / `baseCommit` 正确 | NOT_VERIFIED | 未执行 |
| 31 | `changedFiles` 正确 | **FAIL** | `Execution` 表与 `ExecutionDto` 未提供该字段 |
| 32 | `summary` 非空 | NOT_VERIFIED | 未执行 |
| 33 | Task `done` | NOT_VERIFIED | 未执行 |
| 34 | Agent `idle` | NOT_VERIFIED | 未执行 |
| 35 | Execution 页面展示 Git Diff | **FAIL** | Web 无 Git Diff 展示实现 |
| 36 | 原始 Haft 仓库安全 | PASS | 仅新增本报告，未修改源码/数据库/Git 历史 |
| 37 | 自动化测试通过 | NOT_VERIFIED | 未运行 |
| 38 | 生成验收报告 | PASS | 本文件 |

### 18.3 预检发现的功能缺口（导致无法完整 PASS）

#### 缺口 A：没有 Project 创建 API/UI

证据：

- `apps/api/src/modules/workspace/workspace.controller.ts:10-18` 只有 `GET /api/workspace` 和 `GET /api/dashboard`。
- `apps/api/src/modules/` 下不存在 `projects` 模块或 `projects.controller.ts`。
- `docs/api.md` 的 “Workspace and dashboard” 只列出两个 GET 接口。
- `apps/api/src/common/seed/demo-data.ts` 通过 `SEED_IDS.project = 'project_demo'` 固定 upsert 一个 Project。
- `apps/web/src/features/tasks/task-form-dialog.tsx:171-185` 只提供已有 Project 的下拉选择，没有创建入口。

影响：无法按验收要求“在 Haft 中创建一个专用 Project，并将其映射到 Runner 的测试仓库”。直接写数据库插入 Project 会绕过 Haft 业务接口，不符合验收原则，因此未采用。

#### 缺口 B：Execution 页面不展示 Git Diff / branch / summary / exitCode

证据：

- `apps/web/src/pages/execution-page.tsx:237-258` 只展示 Started、Ended、Duration、Runtime，没有 `branchName`、`baseCommit`、`headCommit`、`summary`、`exitCode` 或 Git Diff。
- 在 `apps/web/src` 中搜索 `branchName`、`baseCommit`、`headCommit`、`changedFiles`、`diff`，没有找到任何 Git 证据渲染代码。
- `docs/REPORT.md:120-121` 声称 “Execution page shows phase, progress mode, exit code, summary, failure/cancel reasons, and Git branch metadata”，与实际 UI 不符。

影响：即使真实 Codex 执行成功，也无法满足“完成后展示 Git Diff”的验收要求。只能通过外部 `git -C <worktree> diff` 检查，不能算作 Haft UI 能力通过。

#### 缺口 C：`changedFiles` / `diffStat` / `gitStatus` 未持久化或暴露

证据：

- Runner 已收集这些数据：`apps/runner/src/git-worktree.ts:177-184`。
- Runner 协议已定义这些字段：`packages/contracts/src/runner-protocol.ts:100-107`。
- 但 `apps/api/prisma/schema.prisma:119-145` 的 `Execution` 模型没有 `changedFiles`、`diffStat`、`gitStatus`。
- `packages/contracts/src/types.ts:192-216` 的 `ExecutionDto` 没有这些字段。
- `apps/api/src/modules/executions/executions.service.ts:732-737` 的 `finishExecution` 只保存 `branchName`、`baseCommit`、`headCommit`，丢弃了 `changedFiles`、`diffStat`、`gitStatus`。

影响：验收要求的 “changedFiles 正确” 无法通过 Server/API 字段验证；只能在 Worktree 中用 Git 命令人工计算，不能算作产品能力通过。不得通过手工修改数据库补齐。

---

## 19. 尚未解决的问题

1. **Project CRUD 缺失**：Haft 需要 Project 创建/查询/更新/删除 API 与 Web 入口，并保证 Project 归属当前 workspace、输入校验、活动事件与现有数据模型一致。
2. **Runner 项目映射与新建 Project 的衔接**：当前 Runner 通过 `HAFT_RUNNER_PROJECTS` 环境变量映射项目 ID 到本地仓库路径；在 Project CRUD 实现后，需要确认新 Project ID 可以被映射并出现在 `/api/runtimes` 的 `projectIds` 中。
3. **Execution 页面 Git Diff 缺失**：需要在 Execution 页面展示 branch、base/head commit、changed files、diff stat、完整 diff（或可展开的 diff 面板），并处理空 diff、失败、取消和超长 diff。
4. **Execution 页面元数据缺失**：`summary`、`exitCode`、`branchName`、`baseCommit`、`headCommit` 已存在于 API DTO，但页面未渲染；需要补齐或明确产品设计。
5. **`changedFiles` / `diffStat` / `gitStatus` 持久化缺失**：需要 Prisma 迁移、`Execution` 字段、DTO 字段、Runner 事件落库和 UI 展示；否则无法满足本验收的字段检查。
6. **文档准确性**：`docs/REPORT.md` 关于 Execution 页面能力和仓库提交状态的描述与当前实现/仓库状态不一致，需要修正。
7. **Runner 状态 UI**：当前没有独立的 Runner 管理/状态页面，Runner 状态只能通过 `/api/runners`、`/api/runtimes` 或任务详情抽屉间接确认；如验收要求页面级证据，需要补充。
8. **重新验收前置条件**：完成上述 1–5 项后，重新执行本报告对应的完整验收流程；在专用 Project 创建能力可用前，不得给出完整 PASS 结论。

---

## 附录 A：本次验收遵守的约束

| 约束 | 遵守情况 |
| --- | --- |
| 不使用 Mock Runtime 代替真实 Codex | 未执行任何 Runtime，未伪造 |
| 不使用 Fake Runner 代替真实 Runner | 未启动 Runner |
| 不绕过 Haft Server 直接启动 Codex | 未启动 Codex |
| 不直接修改数据库伪造执行结果 | 未写入任何数据库 |
| 不修改 Haft 源代码掩盖问题 | 未修改源码 |
| 不自动 Commit / Push / Merge | 未执行 |
| 不清理用户原有 Git 修改 | 未执行清理；验收前工作区本就干净 |
| 不读取/打印/泄露 CLI 认证密钥 | 仅查询 `codex login status` |
| 结论必须有实际命令/响应/文件证据 | 本报告仅记录实际只读预检输出；未验证项明确标记 |

## 附录 B：状态定义

| 状态 | 含义 |
| --- | --- |
| PASS | 已通过实际命令、API 响应、页面状态或文件证据验证 |
| FAIL | 已验证不满足要求，或静态检查确认能力缺失 |
| BLOCKED | 因前置条件缺失，无法继续执行后续依赖步骤 |
| NOT_VERIFIED | 尚未执行验证，不能视为通过 |

## 附录 C：未执行的操作清单

- 未创建 `D:\CODE\GIT\haft-real-acceptance` 测试仓库。
- 未创建 `D:\CODE\GIT\haft-real-acceptance-worktrees`。
- 未创建 `apps/api/prisma/acceptance.db`。
- 未启动 Haft API、Web 或 Runner。
- 未启动 Codex CLI。
- 未创建 Agent、Task 或 Execution。
- 未运行 `pnpm test`、`pnpm test:e2e` 或 `pnpm test:e2e:real`。
- 未修改 Haft 源码、数据库或 Git 历史。
- 未执行 Commit、Push 或 Merge。

---

**报告结束。当前唯一结论是：验收被 Project CRUD 缺失阻塞，真实 Codex 端到端闭环尚未验证。**
