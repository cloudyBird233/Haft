# P2-02 WP-B 独立审查报告

| 项目       | 内容                                                        |
| ---------- | ----------------------------------------------------------- |
| 审查对象   | Haft P2-02 WP-B — Repository Path Policy                    |
| 分支       | `feature/p2-02-project-aware-runner`                        |
| 被审查提交 | `e13262c`（审查在工作树内容上完成；提交内容与审查内容一致） |
| 审查日期   | 2026-11-10                                                  |
| 审查方式   | 严格只读代码审查 + 独立测试运行 + 仓库外临时探针            |
| 总体结论   | **PASS WITH WARNINGS（WP-B 范围内）**                       |
| 合并门禁   | **BLOCKED（P1-1，WP-C 前不可作为独立全绿变更合并）**        |
| P2-02 整体 | **尚不可验收**（WP-A/C/D/E 未完成）                         |

> 审查阶段未修改任何受版本控制文件；本报告为审查结束后新增的文档。未采用实现 Agent 的 PASS 作为证据；以下结论均来自独立阅读、运行和探针。

---

## 0. 审查范围与基线

- 冻结基线：
  - `docs/phase-2-technical-roadmap.md:520-677`（P2-02 卡片，尤其路径安全与 `policyVersion`）
  - `docs/engineering/P2-02_PROJECT_AWARE_RUNNER_IMPLEMENTATION_PLAN.md` §9（1110-1376）、§14.2（1823-1861）、§14.5（1894-1927）、WP-B（2036-2072）、§16.6（2322-2331）、§17 Phase 1（2346-2354）
- 已独立阅读：
  - 源码：`apps/runner/src/repository-policy.ts`（新增）、`config.ts`、`main.ts`、`real-executor.ts`、`runner-client.ts`
  - 测试：`apps/runner/test/repository-policy.spec.ts`（新增）、`config.spec.ts`、`fake-executor.spec.ts`、`real-executor.spec.ts`
  - 相关执行路径/文档：`apps/api/src/modules/runtime/runtime-registry.service.ts`、`tests/support/repository.ts`、`playwright.config.ts`、`docs/runner-setup.md`
- 只读声明：审查期间 `git status --porcelain` 仅显示审查开始前已有的 7 个修改 + 2 个新增文件；测试/探针只写入 gitignored 的 `test-results/`、`apps/runner/dist/` 和系统临时目录。

---

## 1. 总体结论

**WP-B 范围内：PASS WITH WARNINGS。**  
**作为独立合并候选：BLOCKED（P1-1）。**  
**P2-02 整体：尚不可验收（WP-C/D/E 未完成）。**

理由概述：

- 未发现 P0：没有可绕过 allowed roots、把 device/UNC 路径带入真实执行、或污染主仓库的路径。
- 路径策略实现与 §9.2/§9.3/§9.4 基本一致；六种双向隔离布局、Git 结构、`policyVersion`、旧配置移除均有独立证据。
- 唯一 P1 是“旧 API + 新 Runner”的过渡态导致 Fake Runner E2E/CI 可复现失败。这是计划 §3.3.7 明确描述的 safe-but-non-functional 状态，**不是路径策略漏洞**；但当前分支不能声称 CI 全绿，也不能作为一个独立的全绿变更合并。
- WP-B 的**策略接口**可以冻结，WP-A 可以开始；但 `policyVersion`/`assertStillAllowed` 尚未接入真实执行路径，WP-C 必须完成接线。

---

## 2. 问题列表（P0–P3）

### P0

无。未发现安全绕过、主仓库污染或路径逃逸。

---

### P1-1 · Fake Runner E2E/CI 可复现失败（合并门禁）

- **级别**：P1
- **文件:行**：
  - `apps/runner/src/runner-client.ts:507-513`（`projectIds: []`）
  - `apps/api/src/modules/runtime/runtime-registry.service.ts:162-164`（旧 `PROJECT_NOT_MAPPED` 门禁）
  - `tests/support/repository.ts:8-26`（`waitForFakeRunner` 轮询 runtime 可用性）
  - `playwright.config.ts:119-130`（仍设置 `HAFT_RUNNER_PROJECTS`）
- **问题**：新 Runner 不再有 project→path 映射，`capabilities().projectIds` 恒为 `[]`；旧 API 的 runtime availability 仍要求 `runner.capabilities.projectIds.includes(projectId)`，因此返回 `PROJECT_NOT_MAPPED`，`waitForFakeRunner` 永远等不到 `available=true`。
- **复现**：

  ```powershell
  pnpm exec playwright test tests/e2e/functional/runner-execution.spec.ts `
    --grep "runs a Codex execution" --reporter=line
  ```

  独立运行结果：`1 failed`，45 秒超时，位置 `tests/support/repository.ts:26`，错误信息为
  `The Fake Runner did not register for computer_local/project_demo`。

- **期望**：在阶段门禁/CI 中 E2E 为绿；或明确记录该过渡态并在 WP-C 之前禁止合并。
- **实际**：确定性 Fake Runner E2E 在共享 setup 即失败；`visual.spec.ts`、`projects-bindings.spec.ts`、`runner-execution.spec.ts` 都调用 `waitForFakeRunner`，因此 Fake Runner 套件整体被阻塞。
- **建议修复**：
  1. **首选**：保持分支不合并/CI 门禁，直到 WP-C 删除旧 `PROJECT_NOT_MAPPED` 门禁并加入 feature gate（§17 Phase 3 明确要求“Remove the early accepted and the old projectIds gate”）。
  2. 或在同一变更中完成 WP-C 的 gate 过渡并更新 E2E fixture；**不得**为了修 E2E 重新加入 `HAFT_RUNNER_PROJECTS` 或伪造 `projectIds`，那会违反 WP-B 的移除要求，并可能在旧/新 gate 之间产生窗口。
- **范围说明**：这是 P1 级合并/CI 门禁问题，不是 WP-B 路径策略缺陷；计划 §3.3.7 已明确“old API + new Runner 是 safe but non-functional，不是支持的 rollout 状态”。

---

### P2-1 · 默认生产 `resolveRepositoryPath` 的 fail-closed 路径没有单元测试

- **级别**：P2
- **文件:行**：
  - `apps/runner/src/real-executor.ts:127`（默认 `() => null`）
  - `apps/runner/src/real-executor.ts:277-283`（`PROJECT_BINDING_UNSUPPORTED`）
  - `apps/runner/test/real-executor.spec.ts:164`（所有测试都注入 resolver）
- **问题**：WP-B 的关键过渡保证是“没有仓库 context 时真实执行 fail closed，绝不回退 cwd”。当前测试全部注入 `resolveRepositoryPath: () => '/virtual/repository'`，没有任何测试构造默认 dependency 并断言失败。
- **复现**：把 `real-executor.ts:127` 的默认值改成 `() => process.cwd()`，运行 `pnpm --filter @raft-lite/runner test`，仍然 94/94 通过；没有测试能捕获这种回退。
- **期望**：新增测试：不传 `resolveRepositoryPath`，调用 `executor.start()`，断言 `onFailed` 的原因包含 `PROJECT_BINDING_UNSUPPORTED`，`git.prepare`/`spawnProcess` 均未被调用，且没有 journal/worktree 写入。
- **实际**：无默认路径测试；也没有断言 `git.prepare` 收到的入参就是 resolver 返回值。
- **建议修复**：补一个默认 dependency 测试，并在现有成功测试中断言 `git.prepare` 的第一个参数为 `/virtual/repository`；同时断言 spawn 次数在 `start` 前为 0。
- **严重性判断**：代码当前正确，属测试可信度缺口，不阻塞 WP-B 策略冻结；但在 WP-C 接线前应补上，否则“无 cwd fallback”只是注释承诺。

---

### P2-2 · `projectIds: []` / 旧能力映射移除没有单元测试

- **级别**：P2
- **文件:行**：`apps/runner/src/runner-client.ts:507-513`；`apps/runner/test/` 下没有 `runner-client.spec.ts`。
- **问题**：本 WP 最有兼容性影响的变更之一（capabilities 不再暴露 project map）只由 E2E 间接覆盖，而 E2E 当前又因 P1-1 失败。单元层没有直接断言 `projectIds === []`，也没有断言不再读取 `config.projectPaths`。
- **复现**：把 `projectIds: []` 改回 `['project_demo']`，`pnpm --filter @raft-lite/runner test` 仍 94/94 通过；只有 E2E 会受影响，而 E2E 的失败点是 setup 超时，不是清晰的 capability 断言。
- **期望**：一个聚焦的 runner-client/capabilities 测试，断言 `projectIds` 为空、`features` 尚未声明（WP-B 边界）、且旧 `projectPaths` 字段不存在。
- **实际**：无该测试。
- **建议修复**：将 `capabilities()` 抽成可测试的纯函数，或用 fake socket 构造 `RunnerClient` 后断言 register payload。若认为 WP-C 会重写该段，也应在 WP-C 的测试清单中显式加入这一行，避免遗漏。

---

### P2-3 · E2E fixture 仍使用旧映射与 `process.cwd()`，未按 §14.5 建立临时 Git 仓库

- **级别**：P2
- **文件:行**：
  - `playwright.config.ts:119-130`（`HAFT_RUNNER_PROJECTS: JSON.stringify({ project_demo: process.cwd() })`，无 allowed roots/worktree/recovery 环境）
  - `tests/support/repository.ts:29-45`（`ensureReadyRepositoryBinding` 仍依赖 test-only `markProjectBindingReady`）
  - 计划 §14.5（1894-1927）
- **问题**：§14.5 要求 Fake Runner E2E 使用 `test-results/e2e/repository` 的临时 Git 仓库、allowed roots 与 worktree/recovery 兄弟目录，并移除 `HAFT_RUNNER_PROJECTS`。当前 fixture 仍是旧模型；即使 P1-1 的 API gate 被 WP-C 修好，新 Runner 在该 fixture 下也会因 `allowedRepositoryRoots=[]` 而在验证/握手阶段失败（`REPOSITORY_POLICY_NOT_CONFIGURED`）。
- **复现**：用当前 `playwright.config.ts` 启动 Fake Runner，打印配置可见 `allowedRepositoryRoots: []`；将来 `repository.validate` 对 `process.cwd()` 路径会先命中空 roots 的 configError。
- **期望**：临时 Git 仓库 + `HAFT_RUNNER_ALLOWED_ROOTS` + 兄弟 `HAFT_RUNNER_WORKTREE_ROOT`/`HAFT_RUNNER_RECOVERY_ROOT`；`ensureReadyRepositoryBinding` 走真实 validate；主仓库 HEAD 前后不变。
- **实际**：旧映射 + cwd，无 allowed roots。
- **建议修复**：按 §14.5 在 WP-E 完成；若团队要求 E2E 在 WP-C 前变绿，则必须与 P1-1 一起提前完成，但不要在 WP-B 内用伪造 projectId 绕过。
- **备注**：这是 P1-1 的根因之一，但独立列为 P2，因为即使 gate 修好，fixture 仍需更新。

---

### P2-4 · `docs/runner-setup.md` 仍在指导已被移除的 `--project` / `HAFT_RUNNER_PROJECTS`

- **级别**：P2（面向运维的兼容性/文档缺口）
- **文件:行**：
  - `docs/runner-setup.md:14-15`（“mapped project”）
  - `docs/runner-setup.md:91-116`（Project allowlist、`HAFT_RUNNER_PROJECTS`、`--project`、`PROJECT_NOT_MAPPED`）
  - `docs/runner-setup.md:204, 248, 269, 330`（旧环境变量、CLI 示例、错误码修复建议）
- **问题**：WP-B 已删除 `--project`（strict `parseArgs` 会直接拒绝）并忽略 `HAFT_RUNNER_PROJECTS`（仅警告）。但主设置指南仍让操作者配置旧映射，并在 `PROJECT_NOT_MAPPED` 故障排查中建议“把 projectId 加到 `HAFT_RUNNER_PROJECTS`”。按文档操作会得到 unknown option，或配置被静默忽略后真实执行 fail closed。
- **复现**：
  - `pnpm --filter @raft-lite/runner start -- --project project_demo=D:/repo` → `--project` 被 strict parse 拒绝。
  - 仅设置 `HAFT_RUNNER_PROJECTS` → `allowedRepositoryRoots=[]`，真实执行不可用，仅打印一次警告。
- **期望**：文档改为 `--allowed-root`/`HAFT_RUNNER_ALLOWED_ROOTS`、`--allow-unc`、worktree/recovery 兄弟目录约束，并删除 `PROJECT_NOT_MAPPED` 的旧修复建议。
- **实际**：文档仍描述 P2-01 之前的模型；`docs/runner-setup.md:111-116` 甚至写着“P2-02 will replace it”，而本分支已经是 P2-02 WP-B。
- **建议修复**：WP-E 文档任务中重写；至少在合并前把 real-mode 设置段替换为 allowed-root 模型，避免操作者按旧文档配置出不可用 Runner。
- **备注**：代码中的一次性 `console.warn` 已存在（`config.ts:38-46`），但它不能替代主文档。

---

### P3-1 · 计划 Phase 1 的两条 grep exit 与 §9.1/§9.3 自相矛盾

- **级别**：P3（计划文本/流程问题，非实现缺陷）
- **文件:行**：计划 `2354` vs `1122`、`1134`、`1195`、`1213`
- **问题**：Phase 1 exit 要求 `rg HAFT_RUNNER_PROJECTS apps/runner/src` 和 `rg -i "allow.?device" apps/runner` 都“returns nothing”。但 §9.1 明确要求一次性警告文本包含 `HAFT_RUNNER_PROJECTS`，§9.3 明确要求 hash 输入包含固定常量 `allowDevicePaths: false`。正确实现必然让这两条 grep 命中。
- **复现**：
  - `rg HAFT_RUNNER_PROJECTS apps/runner/src` → `config.ts:39,44,81`
  - `rg -i "allow.?device" apps/runner` → `repository-policy.ts:591`、`repository-policy.spec.ts:441,444`
- **期望**：exit 检查针对行为（不存在 `projectPaths` 读取、不存在 device-path 配置面），而不是标识符本身；或修订计划文本。
- **实际**：按字面执行会误判正确实现为失败。
- **建议修复**：不要为了 grep 删除固定 hash key 或警告；把检查改为例如 `rg "projectPaths|parseProjectPaths" apps/runner/src` 和 `rg "allowDevicePaths\\s*[:=]\\s*true|allow-device-paths|ALLOW_DEVICE_PATHS" apps/runner`。这是冻结计划内部的矛盾，建议在 WP-B 冻结记录中注明。

---

### P3-2 · Device path 的错误优先级强于 §9.4 的枚举顺序

- **级别**：P3
- **文件:行**：`apps/runner/src/repository-policy.ts:183-192`；`repository-policy.spec.ts:154-158`；计划 §9.4 step 1/2。
- **问题**：§9.4 把“Policy configured”列为第 1 步、“Input shape/device path”列为第 2 步；但实现先检查 device path，再检查 `configError`。因此 `allowedRepositoryRoots=[]` + `\\?\C:\repo` 返回 `REPO_PATH_INVALID`，而不是字面顺序下的 `REPOSITORY_POLICY_NOT_CONFIGURED`。代码注释和测试明确固化了这一更强行为。
- **复现**：空 allowed roots 的 policy 调用 `validate('\\\\?\\C:\\repo')` → `REPO_PATH_INVALID`。
- **期望**：计划/实现一致；或明确记录“device path 永远先拒绝”的例外。
- **实际**：device-first；安全性更强，无绕过。
- **建议修复**：在 §9.4 加一句“device 检查先于配置错误，作为无条件拒绝”；不建议改代码去匹配字面顺序。

---

### P3-3 · `policyVersion` 使用同步非 native realpath，Windows subst 盘符与验证路径不一致

- **级别**：P3（Windows 边缘场景，无授权绕过）
- **文件:行**：`apps/runner/src/repository-policy.ts:600-605`（`normalizeForPolicy` → `canonicalizeRootSync`）、`612-633`（`realpathSync`）、`635-656`（异步 `realpath`）
- **问题**：Windows 上 `fs.realpathSync`（非 native）不会把 `subst` 盘符解析到物理路径，而 `fs.promises.realpath` 会。于是：
  - 以 `Y:\allowed`（subst）配置和以物理 `C:\...\allowed` 配置会得到不同的 `policyVersion`，尽管验证授权的是同一物理树；
  - 构造函数的 root/root overlap 检查（同步）可能漏掉 subst 别名造成的重叠，而 `validate()` 的异步 `isolationFailure` 会拒绝（仍 fail closed，只是启动时 `configError` 为空、到验证时才报错）。
- **复现**（仓库外探针）：
  - `realpathSync('Y:\\allowed')` → `Y:\allowed`
  - `realpath('Y:\\allowed')` → `C:\Users\...\target\allowed`
  - `policyVersion(alias)=8cbc8d015b3b8c40`，`policyVersion(physical)=af9331fc7ab9f670`；两者 `validate()` 同一 repo 均 `ok=true`。
- **期望**：等价物理根得到相同 `policyVersion`；构造期 overlap 与验证期一致。
- **实际**：hash 不同；overlap 在 validate 阶段才被拒绝。
- **建议修复**：在 Windows 的 `canonicalizeRootSync` 使用 `realpathSync.native`（或统一用异步 canonicalizer 在启动时计算 policyVersion），并加一个 subst 场景测试（可跳过环境不支持的情况）。不影响当前授权结果，故 P3。

---

### P3-4 · Git 最低版本未文档化；detached HEAD 行为与计划措辞有歧义

- **级别**：P3
- **文件:行**：`apps/runner/src/repository-policy.ts:400-409`（`--show-superproject-working-tree`）、`455-466`（HEAD）；`docs/runner-setup.md:14-15`
- **问题**：
  - `git rev-parse --show-superproject-working-tree` 需要 Git ≥ 2.13；更老的 Git 会以非零退出，被归类为 `REPO_VALIDATION_FAILED`，而不是可操作的“Git 版本过低”。
  - 计划 §9.4 step 9 的括号写着 “empty repository or detached/unborn HEAD”，但实现对 detached HEAD 返回 `ok=true`（`rev-parse HEAD` 成功）。§14.2 表格只要求 empty/no HEAD 失败，因此行为可能是可接受的，但文字有歧义。
- **复现**：
  - 本地 Git 2.46.0；Git < 2.13 未验证。
  - 探针：`git checkout --detach` 后 `validate(repo)` → `ok=true`，`headCommit` 正常。
- **期望**：文档写明最低 Git 版本；明确 detached HEAD 是否应拒绝。
- **实际**：无版本说明；detached HEAD 被接受。
- **建议修复**：在 `runner-setup.md` 写 Git ≥ 2.13（或更高）；若计划意图是拒绝 detached HEAD，则增加 `git symbolic-ref -q HEAD` 检查并补测试；否则修订计划措辞。

---

### P3-5 · 三个隔离/Git 边界只有探针验证，没有直接单测

- **级别**：P3（测试可信度）
- **文件:行**：`apps/runner/test/repository-policy.spec.ts:284-371`；`496-519`
- **问题**：以下行为代码正确、探针通过，但套件没有直接断言：
  1. `repo === worktreeRoot` / `repo === recoveryRoot`（等号算重叠，§9.4 step 7）。
  2. recoveryRoot 的 junction 指向 repo 内部（套件只测了 worktreeRoot junction）。
  3. Git 仓库的子目录（应 `REPO_NOT_GIT_ROOT`，套件只测了非 Git 普通目录）。
- **复现**（仓库外探针）：
  - `worktreeRoot=repo` → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`，`message="repository is inside worktreeRoot"`
  - `recoveryRoot=repo` → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`
  - recovery junction → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`，`message="recoveryRoot is inside repository"`
  - `validate(repo/sub)` → `REPO_NOT_GIT_ROOT`
- **期望**：把上述 3 个 case 加入套件，避免未来重构只保留“嵌套”路径而丢掉等号/反向 symlink 覆盖。
- **实际**：仅探针验证。
- **建议修复**：在现有 `bidirectional isolation` 和 `Git shape` describe 中各补 1-2 个 it；成本低。

---

### P3-6 · `policyVersion` 测试没有固定 `allowDevicePaths: false` 的 hash 输入

- **级别**：P3（测试可信度）
- **文件:行**：`apps/runner/test/repository-policy.spec.ts:441-447`；`apps/runner/src/repository-policy.ts:591`
- **问题**：测试只断言配置对象没有 `allowDevicePaths` 字段，以及 policy 可构造；没有断言该固定常量确实参与 hash。若未来有人从 `computePolicyVersion` 删除这一行，现有测试（相同配置相等、不同配置不等、无效配置稳定）仍会全部通过，但 roadmap §569 要求的 hash 输入形状已被破坏。
- **复现**：删除 `repository-policy.ts:591` 的 `allowDevicePaths: false`；`repository-policy.spec.ts` 仍 27/27 通过（hash 值整体变化，但测试只做相对比较）。
- **期望**：一个 golden-hash 测试：用固定 `platform: 'linux'`、固定绝对路径（不存在也可，`canonicalizeRootSync` 会按最长存在前缀处理）计算期望 SHA-256 前 16 位并断言；或导出 `computePolicyVersion` 直接断言 canonical JSON 含该 key。
- **实际**：无直接断言。
- **建议修复**：补 golden-hash 测试；这同时能锁定根排序、去重和 worktree/recovery 输入。

---

### P3-7 · `config.spec.ts` 的默认 root 不相交断言使用了 `startsWith`

- **级别**：P3（测试质量）
- **文件:行**：`apps/runner/test/config.spec.ts:143-148`
- **问题**：该测试用 `startsWith` 判断默认 `worktreeRoot`/`recoveryRoot` 不相交，而这正是策略实现和计划明确禁止的反模式。对当前默认值它恰好通过，但不能证明“路径包含”语义；未来默认值改成 `C:\repos` 与 `C:\repos2` 会误报，改成 `C:\repos` 与 `D:\repos` 会误放。
- **复现**：把默认值临时改为 `C:\repos` 与 `C:\repos2`，`startsWith` 断言失败，但二者其实不相交；改为 `C:\repos` 与 `D:\repos`，断言通过，但也不是包含关系。
- **期望**：使用 `containsPath`/`path.relative`，或直接断言 `new RepositoryPathPolicy(defaultConfig).configError === null`。
- **实际**：`startsWith`。
- **建议修复**：改为 `containsPath(config.worktreeRoot, config.recoveryRoot, process.platform) === false` 双向断言，或复用 policy 构造器。

---

## 3. 路径安全逐项核对

> “PASS”均来自本次独立运行/探针；测试文件为 `apps/runner/test/repository-policy.spec.ts`。

| #   | 检查项                                                                  | 期望                                         | 证据                       | 结果                                |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- | -------------------------- | ----------------------------------- |
| 1   | allowed root 包含 repo                                                  | `ok=true`                                    | spec 93-113                | PASS                                |
| 2   | allowed root 等于 repo                                                  | `ok=true`                                    | spec 106-112               | PASS                                |
| 3   | Windows 大小写不同（`C:\Repo` vs `c:\repo`）                            | `ok=true`，canonical 保留真实大小写          | spec 212-230；探针         | PASS（Windows）                     |
| 4   | Linux 大小写不同                                                        | 大小写敏感，失败                             | spec 223-230 的条件分支    | NOT_VERIFIED（本机无 Linux）        |
| 5   | 相对路径 `repo`                                                         | `REPO_PATH_NOT_ABSOLUTE`                     | spec 130                   | PASS                                |
| 6   | 盘符相对 `C:repo`                                                       | `REPO_PATH_NOT_ABSOLUTE`                     | spec 131                   | PASS                                |
| 7   | `..` traversal（含混合分隔符）                                          | `REPO_PATH_TRAVERSAL`                        | spec 132-136；探针         | PASS                                |
| 8   | 空/空白/NUL                                                             | `REPO_PATH_INVALID`                          | spec 137-138；探针         | PASS                                |
| 9   | UNC 默认拒绝                                                            | `REPO_UNC_NOT_ALLOWED`                       | spec 161-163               | PASS（Windows）                     |
| 10  | `allowUnc=true` 的真实 UNC 成功                                         | 成功/或按网络失败                            | 无网络共享                 | NOT_VERIFIED                        |
| 11  | Device `\\?\C:\repo`                                                    | `REPO_PATH_INVALID`，无 opt-in               | spec 147-159；探针         | PASS（Windows）                     |
| 12  | Device `\\.\PhysicalDrive0`                                             | `REPO_PATH_INVALID`                          | spec 148-153               | PASS（Windows）                     |
| 13  | Device `\\?\UNC\server\share`                                           | `REPO_PATH_INVALID`（device 优先于 UNC）     | spec 150,166；探针         | PASS（Windows）                     |
| 14  | Device `//?/C:/repo` 混合分隔符                                         | `REPO_PATH_INVALID`                          | spec 151-153；探针         | PASS（Windows）                     |
| 15  | 空配置 + device path                                                    | 仍 `REPO_PATH_INVALID`（强于字面 §9.4 顺序） | spec 154-158               | PASS（见 P3-2）                     |
| 16  | Junction/symlink 逃逸 allowed root                                      | `REPO_PATH_OUTSIDE_ALLOWED_ROOTS`            | spec 194-210；探针         | PASS（Windows）；Linux NOT_VERIFIED |
| 17  | 不存在的路径                                                            | `REPO_PATH_NOT_FOUND`                        | spec 182                   | PASS                                |
| 18  | 文件而非目录                                                            | `REPO_PATH_INVALID`                          | spec 183                   | PASS                                |
| 19  | 在 allowed roots 之外                                                   | `REPO_PATH_OUTSIDE_ALLOWED_ROOTS`            | spec 184-191；兄弟前缀探针 | PASS                                |
| 20  | 无 usable root / 相对 root                                              | `REPOSITORY_POLICY_NOT_CONFIGURED`           | spec 373-390               | PASS                                |
| 21  | `assertStillAllowed` 基本重检                                           | 不抛错                                       | spec 451-459               | PASS                                |
| 22  | `assertStillAllowed` 移动 repo / 改 root / 新 overlap / 替换为逃逸 link | 对应 `REPO_*` 错误                           | spec 461-519               | PASS                                |
| 23  | 生产路径调用 `assertStillAllowed`                                       | worktree/recovery 写入前必须调用             | 当前无调用点               | NOT_VERIFIED（WP-C 待接线）         |

**补充说明**：

- 设备路径在 policy 配置错误之前拒绝，是代码注释（`repository-policy.ts:184-186`）和测试（154-158）明确固化的更强行为；无安全绕过。
- `isInsideAllowedRoot` 对每个 root 做异步 `realpath`，不存在的 root 不授权任何路径（`repository-policy.ts:298-313`）；这是 fail-closed 的正确方向。
- 所有包含判断使用 `path.relative`（`containsPath`，`repository-policy.ts:547-557`），没有 `startsWith` 前缀判断。

---

## 4. 六种双向隔离布局

| #   | 布局                                                   | 期望                                | 证据                                 | 结果 |
| --- | ------------------------------------------------------ | ----------------------------------- | ------------------------------------ | ---- |
| 1   | repo 在 worktreeRoot 内                                | `REPO_PATH_NESTED_IN_WORKTREE_ROOT` | spec 284-294                         | PASS |
| 2   | repo 在 recoveryRoot 内                                | `REPO_PATH_NESTED_IN_WORKTREE_ROOT` | spec 296-304                         | PASS |
| 3   | worktreeRoot 在 repo 内                                | `REPO_PATH_NESTED_IN_WORKTREE_ROOT` | spec 307-317                         | PASS |
| 4   | recoveryRoot 在 repo 内                                | `REPO_PATH_NESTED_IN_WORKTREE_ROOT` | spec 318-325；recovery junction 探针 | PASS |
| 5   | worktreeRoot / recoveryRoot 相互重叠（相等、任一嵌套） | `REPOSITORY_POLICY_NOT_CONFIGURED`  | spec 328-341（3 种）                 | PASS |
| 6   | 三者互不相交                                           | `ok=true`                           | spec 343-351                         | PASS |

**额外边界（探针通过，套件未直接覆盖，见 P3-5）**：

- `repo === worktreeRoot` → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`（`repository is inside worktreeRoot`）
- `repo === recoveryRoot` → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`（`repository is inside recoveryRoot`）
- worktreeRoot junction 指向 repo 内 → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`（spec 353-371）
- recoveryRoot junction 指向 repo 内 → `REPO_PATH_NESTED_IN_WORKTREE_ROOT`（探针）
- `worktreeRoot`/`recoveryRoot` 不存在时，按最长存在前缀 + 剩余路径规范化，仍能检测嵌套（spec 307-325）。

---

## 5. Git 结构证据

| 场景                                                    | 期望                             | 证据                       | 结果                                  |
| ------------------------------------------------------- | -------------------------------- | -------------------------- | ------------------------------------- |
| Git 主 checkout 根                                      | `ok=true` + 40 位 `headCommit`   | spec 93-104；探针          | PASS                                  |
| 非 Git 目录                                             | `REPO_NOT_GIT_ROOT`              | spec 235-244               | PASS                                  |
| Git 仓库的子目录                                        | `REPO_NOT_GIT_ROOT`              | 探针                       | PASS（套件未直接覆盖，P3-5）          |
| Bare repo                                               | `REPO_BARE_UNSUPPORTED`          | spec 235-244               | PASS                                  |
| Linked worktree                                         | `REPO_PATH_IS_WORKTREE`          | spec 247-253               | PASS                                  |
| Submodule                                               | `REPO_PATH_IS_WORKTREE`          | spec 247-271               | PASS                                  |
| 空仓库/unborn HEAD                                      | `REPO_VALIDATION_FAILED`         | spec 274-279               | PASS                                  |
| 非空但无效 HEAD ref                                     | `REPO_VALIDATION_FAILED`         | 探针                       | PASS（套件未直接覆盖，P3-5）          |
| Detached HEAD（有效 commit）                            | 计划措辞有歧义；当前 `ok=true`   | 探针                       | 行为已验证；意图 NOT_VERIFIED（P3-4） |
| 缺少 `defaultBranch`                                    | `ok=true`，validate 不做分支检查 | spec 115-123；方法 arity 1 | PASS                                  |
| Git < 2.13（`--show-superproject-working-tree` 不支持） | 应给出可操作错误/文档要求        | 本地 Git 2.46.0            | NOT_VERIFIED（P3-4）                  |

**代码路径**：`repository-policy.ts:367-467`，全部使用 `execFile('git', ['-C', canonical, ...args])`，无 shell；`GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`，30s 超时/1MB 输出上限。

---

## 6. `policyVersion` 输入与稳定性

| 输入/性质                              | 实现                               | 测试/证据                     | 结果                                     |
| -------------------------------------- | ---------------------------------- | ----------------------------- | ---------------------------------------- |
| `allowDevicePaths: false` 固定常量     | `repository-policy.ts:591`         | spec 441-447；grep 无配置字段 | PASS（但 hash 输入未 golden 锁定，P3-6） |
| `allowUnc`                             | `repository-policy.ts:592`         | spec 410-425                  | PASS                                     |
| allowed roots 规范化、去重、排序       | `repository-policy.ts:587-589`     | spec 394-408                  | PASS                                     |
| `worktreeRoot` / `recoveryRoot`        | `repository-policy.ts:594-595`     | spec 410-425                  | PASS                                     |
| 不包含 runnerId/hostname/time/无关 env | `computePolicyVersion` 仅上述 5 项 | 代码审查                      | PASS                                     |
| 相同配置 → 相同 hash                   | 纯函数 SHA-256 前 16 位            | spec 394-408                  | PASS                                     |
| root 顺序无关                          | 排序后序列化                       | spec 394-408                  | PASS                                     |
| 策略变化 → hash 变化                   | root/allowUnc/worktree/recovery    | spec 410-425                  | PASS                                     |
| 无效 overlap 配置仍有稳定 hash         | 仍计算 policyVersion               | spec 427-438                  | PASS                                     |
| Windows subst 别名与物理路径           | 同步/异步 realpath 语义不一致      | 探针                          | P3-3（无授权绕过）                       |

**结论**：`policyVersion` 的输入集合与 roadmap `:569` / 计划 §9.3 一致；除 Windows subst 边缘外，稳定性和变更敏感性满足 WP-B 要求。

---

## 7. 旧配置清理与 cwd fallback

| 项                                                      | 结论                                                 | 证据                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `parseProjectPaths`                                     | 已删除                                               | `rg` 无匹配；`config.ts` diff                                                              |
| `RunnerConfig.projectPaths`                             | 已删除                                               | `config.ts:8-34` 无该字段；`config.spec.ts:111-112`                                        |
| `--project`                                             | 已删除；strict parse 拒绝                            | `config.spec.ts:101-103`                                                                   |
| `HAFT_RUNNER_PROJECTS`                                  | 忽略 + 一次性警告                                    | `config.ts:38-46,81-83`；`config.spec.ts:105-132`                                          |
| `HAFT_RUNNER_PROJECT_ID` / `HAFT_RUNNER_WORKSPACE_ROOT` | 忽略                                                 | `config.spec.ts:105-114`；src 无读取                                                       |
| `INIT_CWD` / `process.cwd()` 作为仓库选择               | 无                                                   | `rg` runner src 无匹配；`tokenFile` 的 `resolve` 仅用于非仓库路径                          |
| `real-executor` 读取 `projectPaths`                     | 已移除；默认 resolver 返回 null                      | `real-executor.ts:127,277-283`                                                             |
| `runner-client` 旧 project map gate                     | 已移除；`projectIds: []`                             | `runner-client.ts:507-513`                                                                 |
| 真实执行 fail closed                                    | 无 context → `PROJECT_BINDING_UNSUPPORTED`，不 spawn | `real-executor.ts:277-283`                                                                 |
| 非 Runner 表面的旧配置                                  | 仍存在                                               | `playwright.config.ts:128`、`tests/support/repository.ts`、`docs/runner-setup.md`（P1/P2） |

**结论**：真实 Runner 执行路径已无 `HAFT_RUNNER_PROJECTS` / `projectPaths` / cwd fallback；旧配置只残留在 E2E fixture 和文档中，属于 P1/P2 的过渡态清理，不是执行路径回退。

---

## 8. 测试执行报告

### PASS

| 命令                                        | 结果                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm --filter @raft-lite/contracts test`   | PASS：5 files / 107 tests                                                 |
| `pnpm --filter @raft-lite/runner test`      | PASS：13 files / 94 tests（`repository-policy` 27/27）                    |
| `pnpm --filter @raft-lite/runner typecheck` | PASS                                                                      |
| `pnpm typecheck`                            | PASS（contracts、runner、api、web）                                       |
| `pnpm lint`                                 | PASS（`eslint . --max-warnings=0`）                                       |
| `pnpm format:check`                         | PASS（changed files Prettier-clean；legacy debt 仍被 grandfathered）      |
| `pnpm --filter @raft-lite/api test`         | PASS：5 files / 40 tests                                                  |
| `pnpm --filter @raft-lite/web test`         | PASS：11 files / 41 tests                                                 |
| Error code registry 检查                    | PASS：使用的 `REPO_*`/`REPOSITORY_*`/`PROJECT_BINDING_UNSUPPORTED` 均存在 |
| Contracts/schema 变更检查                   | PASS：无 contracts/API/schema 变更                                        |

### FAIL

| 命令                                                                                                                      | 结果                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec playwright test tests/e2e/functional/runner-execution.spec.ts --grep "runs a Codex execution" --reporter=line` | **FAIL**：1 failed；45s 超时；`tests/support/repository.ts:26`；`The Fake Runner did not register for computer_local/project_demo`（P1-1） |

### NOT_RUN

| 命令                                   | 原因                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @raft-lite/runner lint` | 该包无 `lint` script（`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`）；root `pnpm lint` 已通过                                                                               |
| 完整 `pnpm test:e2e`                   | 未跑完整套件；targeted spec 已在共享 setup 失败。由于 `waitForFakeRunner` 被 `visual`/`projects-bindings`/`runner-execution` 共用，Fake Runner 套件预期同样被阻塞 |
| `pnpm test:e2e:real`                   | 需要真实 CLI/认证，未运行                                                                                                                                         |

### NOT_VERIFIED

| 项                                                            | 原因                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| Linux 路径矩阵（大小写敏感、POSIX symlink、`//server/share`） | 本机仅 Windows；CI `ubuntu-latest` 矩阵未在本次本地审查中执行 |
| Windows device/UNC 用例在 Linux 的行为                        | 设计上 n/a                                                    |
| `allowUnc=true` 的真实 UNC 共享成功                           | 无网络共享                                                    |
| Git < 2.13 行为                                               | 本地 Git 2.46.0                                               |
| 真实 Codex/OpenCode E2E                                       | 需要安装与认证                                                |
| 完整浏览器视觉/UI E2E                                         | 只跑了 targeted `runner-execution` 用例                       |
| Detached HEAD 是否应拒绝                                      | 计划 §9.4 措辞有歧义；当前行为已验证为接受                    |
| 生产路径 `assertStillAllowed` 调用                            | WP-C 尚未接线；当前只有单测                                   |

---

## 9. 架构边界

**变更范围**：7 个修改 + 2 个新增，全部在 `apps/runner`：

- `src/config.ts`、`src/main.ts`、`src/real-executor.ts`、`src/runner-client.ts`
- 新增 `src/repository-policy.ts`
- `test/config.spec.ts`、`test/fake-executor.spec.ts`、`test/real-executor.spec.ts`
- 新增 `test/repository-policy.spec.ts`

**边界判断**：

- 未修改 `packages/contracts`、`apps/api`、`apps/web`、Prisma schema、`execution.start`、协议/错误码注册表；`docs/phase-2-technical-roadmap.md` 未改动。
- 未实现 WP-A：没有 `repository.validate` handler、`RepositoryValidationCache`、API validate route。
- 未实现 WP-C：没有 `execution.repository`、`execution.repository.accepted/rejected`、`RepositoryContextManager`、`features` 声明、early `execution.accepted` 移除、`projectIds` 旧 gate 移除。
- 未实现 WP-D/E：没有恢复状态机、E2E fixture、文档重写。
- `real-executor.ts` 的 `resolveRepositoryPath` 是**显式的临时 WP-B seam**（`real-executor.ts:51-56`）：生产默认返回 null，fail closed；测试注入路径。它不是 WP-C 的握手实现。
- `main.ts` 构造 `RepositoryPathPolicy` 并记录 `policyVersion`/warnings/configError，但**没有**把它传入 `RunnerClient`/`RealExecutor`；`RunnerClientOptions` 仍只有 `config`/`onFatal`。这是 WP-B 的预期过渡态：WP-A 接 validation，WP-C 接 handshake/worktree/recovery。
- `projectIds: []` + 未声明 `features` 的组合让旧 API 继续用旧 gate 阻断真实执行（safe but non-functional），不会误发 P2-02 消息。
- 当前没有 `assertStillAllowed` 的生产调用点；因此“worktree 创建前/恢复日志写入前再次校验”尚未生效。WP-C 必须把 policy 传入 `GitWorktreeManager`/`RealExecutor`/context manager，并在写入前调用；否则 WP-B 的策略只是库，不是执行路径的强制门禁。

**边界结论**：WP-B 没有越界实现 WP-A/C/D/E；对 `runner-client`/`real-executor` 的修改是 §9.9 “移除旧映射”的必要部分。唯一需要明确记录的是：策略尚未接线，当前真实执行是 fail-closed 不可用状态，而不是“已受策略保护”的状态。

---

## 10. 最终验收意见：冻结 WP-B / 进入 WP-A

### 可以冻结 WP-B 策略接口：是（有条件）

- 无 P0/P1 路径安全缺陷；六种隔离布局、Git 结构、`policyVersion`、旧配置移除均通过独立验证。
- `RepositoryPathPolicy` 的公开接口与 §9.2 一致：`validate(path)` 无 defaultBranch 参数、`assertStillAllowed(canonicalPath)`、`configError`、`policyVersion`。
- 冻结条件：
  1. CI 的 **Linux unit matrix** 必须确认 `repository-policy` 全绿（本次本地仅 Windows，Linux 为 NOT_VERIFIED）。
  2. P2-1/P2-2 的测试缺口应在 WP-A 期间补上，尤其是默认 fail-closed seam 和 `projectIds: []`。
  3. P3-5/P3-6 的低成本测试补强建议纳入 WP-A 的测试清单。
  4. 把 P3-1/P3-2 作为计划文本/评审记录注记，不要为了字面 exit 去改正确实现。

### 可以开始 WP-A：是

- WP-A 只依赖已冻结的 `RepositoryPathPolicy.validate()` 接口和 `policyVersion`；可以在不等待 WP-C 的情况下实现 `repository.validate`、validation cache、API route 和 binding 状态更新。
- WP-A 实现时注意：
  - 不添加 defaultBranch 检查（属于 WP-C/context）。
  - `configError`（`REPOSITORY_POLICY_NOT_CONFIGURED`）要映射为验证失败结果，不能伪造 `ok=true`。
  - `validate()` 返回的 `canonicalPath`/`headCommit`/`policyVersion`/`platform` 必须原样回传，不能由 API 合成。

### 当前分支能否合并/声称 CI 全绿：否

- P1-1 是可复现的 Fake Runner E2E/CI 红；根因是旧 API 的 `PROJECT_NOT_MAPPED` 门禁与 `projectIds: []` 的过渡态。
- 正确修复顺序是 WP-C：删除旧 gate + 加入 feature gate + 更新 early accepted/握手；**不要**在 WP-B 内重新引入 `HAFT_RUNNER_PROJECTS`、`--project` 或伪造 projectId。
- 如果团队流程要求每个 PR 全绿，则应把 WP-B 与 WP-C 的 gate 过渡放在同一合并批次，或明确将 E2E 标记为“已知过渡失败、WP-C 前不合并”，而不是把它当作 PASS。

### P2-02 整体验收：尚不可

- 当前只完成 WP-B；WP-A/C/D/E 未完成。
- 真实执行在旧 API + 新 Runner 下是 safe-but-non-functional（§3.3.7），不是可交付状态。
- 只有在 WP-C 完成握手/gate 过渡、WP-D 完成恢复、WP-E 完成 E2E/docs 后，才能对 P2-02 整体给出 PASS。

---

## 附录 A · 主要独立验证命令

```powershell
pnpm --filter @raft-lite/contracts test
pnpm --filter @raft-lite/runner test
pnpm --filter @raft-lite/runner typecheck
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @raft-lite/api test
pnpm --filter @raft-lite/web test
pnpm exec playwright test tests/e2e/functional/runner-execution.spec.ts `
  --grep "runs a Codex execution" --reporter=line
```

## 附录 B · 审查结论摘要

- **P0**：0
- **P1**：1（P1-1，E2E/CI 过渡态）
- **P2**：4（测试缺口 2、E2E fixture 1、文档 1）
- **P3**：7（计划文本 1、错误优先级 1、Windows subst 1、Git 版本/HEAD 1、测试覆盖 3）

**最终意见：冻结 WP-B 路径策略接口并开始 WP-A；在 WP-C 完成旧 gate/feature gate 过渡前，不要把当前分支作为独立全绿变更合并。**
