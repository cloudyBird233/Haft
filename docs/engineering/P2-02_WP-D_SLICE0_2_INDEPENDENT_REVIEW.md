# P2-02 WP-D Slice 0.2 独立复审报告

| 项目           | 内容                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 复审对象       | WP-D Slice 0.2 复审修复（P1-1、P2-1、P2-2、P2-3）                                                                    |
| 分支           | `feature/p2-02-wpd-slice0-2-review-remediation`                                                                      |
| 复审 diff      | `324b6d78b9234e2f4d080908ebd7a5d29b45305e..663cc28df213f1855ed72437dd8efb7cf96906ae`                                 |
| 上下文 HEAD    | `8a72d3a5ff6bb9c48ef498e806f5bfc292a31bf5`（仅多修复报告提交）                                                       |
| 复审日期       | 2026-11-13                                                                                                           |
| 复审方式       | 严格只读代码审查 + Windows 原生运行 + WSL2 Linux 精确 HEAD 副本运行 + 独立故障探针                                   |
| 总体结论       | **FAIL（WP-D Slice 0.2 范围）**                                                                                      |
| Slice 1 准入   | **不允许**：P2-2 未闭环；另有新的 P2 级跨平台缺口                                                                    |
| 本报告唯一新增 | `docs/engineering/P2-02_WP-D_SLICE0_2_INDEPENDENT_REVIEW.md`                                                         |
| 只读声明       | 未修改产品代码、测试、配置、契约、既有文档、`main` 或用户工作树；未 commit / push / rebase；未实施任何修复或 Slice 1 |

> 本报告不把修复报告中的“已修复”结论、测试数量或作者环境当成证据。下列结论来自对实际 diff、源码、测试文件和独立运行结果的复核。所有失败/缺口均给出可复现证据；无法复现或平台不适用处明确标注。

---

## 1. 结论摘要

**总体结论：FAIL。**

P1-1、P2-1（Windows 范围）和 P2-3 的核心不变量已实质修复；但 **P2-2 未完全闭环**：`resolve-corrupt` 只做了路径与文件类型校验，resolution sidecar 仍是“存在即视为已解决”的非原子文件，且 journal 内容校验存在同类的 fail-open 路径。按本次复审任务对 P2-2 的定义（路径 + sidecar + 内容完整性），不能签署 P2-2 已关闭。

因此：

- **WP-D Slice 0.2 不能验收为 PASS，也不能验收为 PASS WITH WARNINGS。**
- **不能进入 Slice 1。**
- P2-4 仍为 **Deferred**，本报告不宣布其关闭；本次没有用旧的 fake child 测试冒充受管路径证据。
- 未发现新的 P0/P1；新发现一项 P2（POSIX starting guard 跨平台缺口）和若干 P3/观察项。

### 1.1 原 Finding 关闭状态

| ID   | 原级别                     | 复审任务要求               | 本次结论                          | 是否阻塞 Slice 1       |
| ---- | -------------------------- | -------------------------- | --------------------------------- | ---------------------- |
| P1-1 | P1                         | 终态 finalize 并发竞态     | **CLOSED / PASS**                 | 否                     |
| P2-1 | P2                         | Windows starting guard     | **CLOSED / PASS（Windows 范围）** | 否                     |
| P2-2 | P2                         | resolve-corrupt 路径与内容 | **FAIL / NOT CLOSED**             | **是**                 |
| P2-3 | P2                         | 人工 resolve 全树证明      | **CLOSED / PASS WITH WARNINGS**   | 否                     |
| P2-4 | P2（按任务命名；原文缺失） | 明确 deferred 到 Slice 1   | **DEFERRED（未复审、未关闭）**    | 否（Slice 1 必须处理） |

### 1.2 新发现/残余风险

| ID  | 级别 | 摘要                                                                                       | 证据等级     | 阻塞 Slice 1 |
| --- | ---- | ------------------------------------------------------------------------------------------ | ------------ | ------------ |
| N-1 | P2   | POSIX supervisor 只在 spawn 前 `existsSync(guardPath)`；guard 路径为目录时仍启动 CLI       | 独立探针 IR7 | 建议阻塞     |
| N-2 | P3   | `finalize()` 注释称树未确认后“稍后可重试”，但 `markUncertain()` 已把 `finished` 置真       | 代码 + F9    | 否           |
| N-3 | P3   | guard 文件本地篡改、`isolation` 与平台不匹配未做交叉校验；`currentGuard()` 不复核身份      | 代码路径     | 否           |
| N-4 | P3   | Windows `AssignProcessToJobObject` 失败分支不检查 `TerminateProcess` 返回值                | 代码路径     | 否           |
| N-5 | P3   | 原始 WP-D Slice 0.1 独立复审文档不在仓库；修复报告标题写“Slice 0.1”而任务为 Slice 0.2      | 仓库检索     | 否           |
| N-6 | P3   | 已提交的 R19 在双平台都使用 `windows-job`，未覆盖 cgroup；cgroup 仅由本次临时探针 IR6 覆盖 | 测试文件     | 否           |

> 级别定义沿用仓库既有复审习惯：P0 = 灾难性/不可接受；P1 = 阻塞退出标准；P2 = 重要缺口或高概率风险；P3 = 低概率/防御纵深/文档与覆盖问题。

### 1.3 为什么测试全绿仍是 FAIL

新增的 F1–F9、S1–S8、R13–R19 在可执行平台上均通过，说明这些测试覆盖的路径确实正确；但 P2-2 的关键缺口不在已提交测试的覆盖范围内：

- R13 只测试了“普通文件、目录、嵌套目录、root 外路径”被拒绝；没有测试“root 直属、扩展名匹配、内容不是损坏 journal 的普通文件”。
- R14 只测试“root 直属的隔离普通文件”成功；没有测试空 sidecar、截断 sidecar、目录 sidecar。
- 没有测试 journal 记录本身字段非法（例如 `pid` 非数字）时是否应隔离，而不是被当作 legacy 记录直接 finalize。

本次独立探针 IR4、IR4b、IR5、IR8 分别复现了上述四个 fail-open 行为。它们不是“测试失败”，而是“测试未覆盖 + 代码实际 fail-open”的证据。

---

## 2. 审查基线、范围与只读约束

### 2.1 提交与工作树

| 项目           | 值                                              |
| -------------- | ----------------------------------------------- |
| 仓库           | `D:\CODE\GIT\Haft-p2-02-wpd-slice0-1`           |
| 分支           | `feature/p2-02-wpd-slice0-2-review-remediation` |
| HEAD           | `8a72d3a5ff6bb9c48ef498e806f5bfc292a31bf5`      |
| 基线           | `324b6d78b9234e2f4d080908ebd7a5d29b45305e`      |
| 修复提交       | `663cc28df213f1855ed72437dd8efb7cf96906ae`      |
| 报告提交       | `8a72d3a5ff6bb9c48ef498e806f5bfc292a31bf5`      |
| 复审开始时状态 | `git status --porcelain` 为空；HEAD 与分支一致  |
| 复审结束时状态 | 除本报告外无改动；未 commit / push / rebase     |

提交序列：

```text
8a72d3a docs(p2-02): document WP-D slice 0.2 remediation
663cc28 fix(p2-02): close WP-D slice 0 review findings
324b6d7 fix(p2-02): harden WP-D slice 0 process recovery
```

### 2.2 变更面

`git diff --stat 324b6d7..663cc28`：**8 个文件，1731 insertions，121 deletions**。

| 文件                                                 | 变更类型 | 复审关注点                                   |
| ---------------------------------------------------- | -------- | -------------------------------------------- |
| `apps/runner/native/windows-process-supervisor.cs`   | M        | starting guard 写入/回验、SpawnCli 顺序      |
| `apps/runner/src/real-executor.ts`                   | M        | finalize single-flight、仲裁、uncertain 语义 |
| `apps/runner/src/recovery.ts`                        | M        | resolve-corrupt 校验、全树证明               |
| `apps/runner/src/supervised-process.ts`              | M        | ready 失败清理、terminate/verify 有界返回    |
| `apps/runner/test/finalize-concurrency.spec.ts`      | A        | F1–F9                                        |
| `apps/runner/test/fixtures/no-guard-supervisor.cjs`  | A        | S6/S8 的 POSIX supervisor double             |
| `apps/runner/test/recovery-resolution.spec.ts`       | A        | R13–R19                                      |
| `apps/runner/test/supervised-process-safety.spec.ts` | A        | S1–S8                                        |

未发现 `packages/contracts`、协议、Schema、`main`、冻结设计文档或无关模块的改动；未删除既有测试。变更面与修复报告声明的范围一致。

### 2.3 审查范围

本次复审覆盖：

1. P1-1：`finalize()` 是否在任何 `await` 前完成互斥；并发请求是否共享同一决策；Journal 终态与终态事件是否严格一一对应；树未确认和 Journal 失败是否都不产生成功事件。
2. P2-1：Windows starting guard 是否在 `SpawnCli()` 前写入并回读验证；失败是否确实阻止 CLI 创建；`ready` 拒绝后 `terminate`/`verifyTreeGone` 是否不抛、不误报 confirmed、等待是否有界。
3. P2-2：`resolve-corrupt` 是否只接受 recovery root 直属、扩展名匹配的普通文件；是否验证内容确实是损坏 journal；resolution sidecar 是否可靠、不可被空文件/截断文件绕过。
4. P2-3：人工 resolve 是否在 guard、cgroup、process group、legacy PID 各路径上完成全树证明；cgroup 非空但 supervisor/CLI 已退出时是否拒绝。
5. 测试与门禁：Windows 与 Linux 的 runner 全量测试、F1–F9、S1–S8、R13–R19、typecheck、build、lint、Prettier、`format:check`。
6. 明确不覆盖：P2-4（deferred 到 Slice 1）、根级 `pnpm test`（API/Web/DB）、Slice 1 功能。

### 2.4 只读约束与产物

- 未修改产品代码、测试、配置、契约、`main`、冻结设计文档或任何既有报告。
- 未执行 `git commit`、`git push`、`git rebase`、`git reset`、删除或覆盖用户文件。
- 未实施任何修复；本报告只记录复审结论。
- 独立探针与日志均在仓库外：
  - Windows：`C:\Users\A11720\AppData\Local\Temp\opencode\independent-review.spec.ts`、`slice02-*.log`；
  - Linux：`/tmp/haft-slice02-review`（仓库外副本）、`/tmp/slice02-*.log`。
- WSL 副本用于 Linux 证据；复审前对 HEAD 的 **301 个 tracked 文件**逐个做 `git hash-object` 比对，**0 mismatch**，确认副本内容与 HEAD 完全一致（独立探针文件仅在副本中临时加入，运行后移出）。

### 2.5 基线文档缺失说明

修复报告 §2 声称基线 `324b6d7` 是“独立复审 PASS WITH WARNINGS”，但仓库与 git 历史中不存在 WP-D Slice 0.1 的独立复审文档：

- `docs/engineering/P2-02_WP-D_INDEPENDENT_REVIEW.md` 不存在；
- `git log --all --name-only -- docs/engineering | Select-String 'WP-D'` 只返回 `P2-02_WP-D_SLICE0_2_REMEDIATION_REPORT.md`；
- 现有独立复审只有 WP-A、WP-B、WP-C 系列。

因此，本次复审**无法独立核对原始 P1-1/P2-1/P2-2/P2-3 的原文措辞和级别映射**；该文档层面的核对标记为 **BLOCKED（原文不可得）**，但不阻塞代码/测试结论。复审以修复报告声明的范围 + 本次任务对 P2-2 的明确要求（不得只凭路径校验关闭）为准。这是文档可追溯性缺口（N-5），不影响代码与测试证据本身，但会影响“原 Finding 是否被准确复述”的审计。

---

## 3. 环境、命令与测试矩阵

### 3.1 环境

| 项目   | Windows                   | Linux（WSL2）                                     |
| ------ | ------------------------- | ------------------------------------------------- |
| 系统   | Windows NT 10.0.26200.0   | Ubuntu 24.04（WSL2）                              |
| Node   | v24.14.0                  | v22.14.0                                          |
| pnpm   | 11.5.2                    | 11.5.2                                            |
| Vitest | 3.2.7                     | 3.2.7                                             |
| 代码   | HEAD `8a72d3a` 工作树     | HEAD `8a72d3a` 的仓库外副本（301 文件 hash 一致） |
| 依赖   | 工作区既有 `node_modules` | `CI=true pnpm install --frozen-lockfile`          |

### 3.2 测试与门禁结果

| 命令                                                                                                                                                                           | 平台    | 结果                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------- |
| `pnpm --filter @raft-lite/runner test`                                                                                                                                         | Windows | 21 files / **193 passed, 3 skipped, 196 total**；36.59s |
| `pnpm --filter @raft-lite/runner exec vitest run test/finalize-concurrency.spec.ts test/supervised-process-safety.spec.ts test/recovery-resolution.spec.ts --reporter=verbose` | Windows | 3 files / **22 passed, 3 skipped, 25 total**            |
| `pnpm --filter @raft-lite/runner typecheck`                                                                                                                                    | Windows | 通过（`tsc --noEmit`）                                  |
| `pnpm --filter @raft-lite/runner build`                                                                                                                                        | Windows | 通过（tsup，3 个入口）                                  |
| `pnpm lint`                                                                                                                                                                    | Windows | 通过（`eslint . --max-warnings=0`）                     |
| `pnpm exec prettier --check`（7 个改动 TS/CJS 文件）                                                                                                                           | Windows | 通过                                                    |
| `pnpm format:check`                                                                                                                                                            | Windows | **失败**：4 个基线既有文件（见 §3.5）                   |
| `CI=true pnpm --filter @raft-lite/runner test`                                                                                                                                 | Linux   | 21 files / **194 passed, 2 skipped, 196 total**；4.03s  |
| `pnpm --filter @raft-lite/runner exec vitest run test/finalize-concurrency.spec.ts test/supervised-process-safety.spec.ts test/recovery-resolution.spec.ts --reporter=verbose` | Linux   | 3 files / **24 passed, 1 skipped, 25 total**            |
| `pnpm --filter @raft-lite/runner typecheck`                                                                                                                                    | Linux   | 通过                                                    |
| `pnpm --filter @raft-lite/runner build`                                                                                                                                        | Linux   | 通过                                                    |
| `pnpm lint`                                                                                                                                                                    | Linux   | 通过                                                    |
| `pnpm exec prettier --check`（7 个改动 TS/CJS 文件）                                                                                                                           | Linux   | 通过                                                    |
| `pnpm format:check`                                                                                                                                                            | Linux   | **失败**：同样 4 个基线既有文件                         |
| 独立探针 `vitest run test/independent-review.spec.ts`                                                                                                                          | Linux   | **9 passed / 9**（IR1–IR8，含 IR4b，见 §5）             |

说明：

- Windows 全量测试在仓库工作树运行，未加入任何复审测试文件。
- Linux 全量测试在 `/tmp/haft-slice02-review` 运行；为保持 21 个测试文件的基线计数，先移出独立探针，全量运行后再单独运行探针。
- 修复报告中的 Windows 耗时约 39.7s、Linux 约 6.2s；本次测得 36.59s / 4.03s。耗时差异属于机器负载与文件系统差异，**测试数量和通过/跳过状态一致**，不构成实质性差异。

### 3.3 跳过用例

| 平台    | 跳过用例 | 原因                                           |
| ------- | -------- | ---------------------------------------------- |
| Windows | S6、S8   | POSIX-only（`it.skipIf(win32)`）               |
| Windows | R18      | POSIX-only（`it.skipIf(win32)`）               |
| Linux   | S7       | Windows supervisor-only（`it.skipIf(!win32)`） |
| Linux   | R04b     | Windows `taskkill` 故障注入                    |

上述跳过与修复报告 §7.2 一致。这些用例**不属于 UNVERIFIED/BLOCKED**：每一项都在其适用平台上实际执行并通过；在另一平台跳过是设计上的平台不适用，不是无法复现。对应平台上的关键用例均已实际执行：

- F1–F9：Windows 与 Linux 均通过。
- S1–S5：双平台通过；S6、S8 Linux 通过；S7 Windows 通过。
- R13–R17（含 R15b）、R19：双平台通过；R18 Linux 通过。

### 3.4 独立探针

独立探针文件：`C:\Users\A11720\AppData\Local\Temp\opencode\independent-review.spec.ts`（仓库外；运行于 Linux 精确 HEAD 副本）。探针不修改仓库，不依赖修复报告中的测试 harness，直接调用 `RealExecutor`、`ExecutionRecovery`、`verifyGuardedTree`、`spawnSupervisedProcess` 等真实导出。共 9 个测试（IR1、IR2、IR3、IR4、IR4b、IR5、IR6、IR7、IR8）。

| 探针 | 目的                                                            | 结果/观察                                                                                                                              |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| IR1  | `journal.finish` pending 时到达 late failed，是否覆盖 completed | 1 次 finish、1 个 completed、0 failed；`finalizeCommitted=true`；session 移除                                                          |
| IR2  | Git collection pending 时到达 late completed，是否覆盖 failed   | 1 次 finish、1 个 failed（primary failure）、0 completed；`finalizeCommitted=true`                                                     |
| IR3  | 50 个同步调用者是否共享一个决策和一次终态写入                   | 1 次 finish、1 个 failed、0 completed                                                                                                  |
| IR4  | 空 resolution sidecar 是否让下一次 scan 变 clean                | **`clean=true`**；零字节 sidecar 被当作有效 resolution                                                                                 |
| IR4b | 截断 JSON sidecar 是否让下一次 scan 变 clean                    | **`clean=true, blocked=0`**；`{"version":1` 被当作有效 resolution                                                                      |
| IR5  | 任意普通文件（内容不是损坏 journal）是否被 resolve-corrupt 接受 | **`resolved=true`**；reason 为 “Corrupt journal kept as evidence with a resolution sidecar”                                            |
| IR6  | cgroup 非空且 supervisor/CLI 已退出时，人工 resolve 是否拒绝    | `cgroupMemberCount=26`；`verificationConfirmed=false`；`resolved=false`；reason 含 `PROCESS_TREE_NOT_CONFIRMED`；journal 保持 `active` |
| IR7  | POSIX guard 路径不是普通文件时，CLI 是否仍被启动                | **CLI 已启动**（pid 存在）；`readProcessGuard` 返回 `kind=invalid`                                                                     |
| IR8  | `pid` 非数字的 journal 是否被接受并 finalize                    | **`clean=true, blocked=0`**；journal 被改为 `interrupted`，无进程证明                                                                  |

> 注意：IR4/IR4b/IR5/IR7/IR8 是“观察型”测试：它们断言当前实现确实表现出 fail-open/缺口行为。测试通过表示**缺口被复现**，不表示行为正确。
>
> 平台边界：IR1–IR8 全部只在 **Linux** 精确 HEAD 副本运行，不能直接外推到 Windows。Windows 的对应路径由已提交的 F1–F9、S1–S8、R13–R19 覆盖；IR6 是 Linux cgroup 专用，IR7 是 POSIX supervisor 专用。未在 Windows 上重跑 IR1–IR5/IR8，因此这些探针的 Windows 行为标记为 **未运行/不外推**。

### 3.5 格式门禁说明

`pnpm format:check` 在 Windows 与 Linux 均失败，输出完全一致：

```text
format:check: 53 unformatted file(s); 76 are grandfathered legacy debt.
format:check failed. These files must be formatted (or the baseline must be explicitly regenerated):
  - apps/runner/src/process-guard.ts
  - apps/runner/src/process-supervisor-child.ts
  - apps/runner/src/recovery-admin.ts
  - apps/runner/test/recovery-hardening-os.spec.ts
```

独立核对：

- 这 4 个文件在 `324b6d7..HEAD` 中 **没有 diff**；
- 它们的最后一次提交都是 `324b6d7`；
- `scripts/acceptance/format-baseline.json` 与 `check-format.mjs` 在 `324b6d7..HEAD` 中没有变化；
- 因此该失败在基线 `324b6d7` 上同样存在，**不是 `663cc28` 引入的回归**。

修复报告 §7.3 对此的披露准确。需要强调的是：仓库级 `format:check` 仍是红灯；这不影响 P1-1/P2-1/P2-2/P2-3 的代码结论，但意味着“全部门禁绿色”不能作为本次验收声明。

---

## 4. Finding 逐项复核

### 4.1 P1-1：终态 finalize 并发竞态 — CLOSED / PASS

#### 4.1.1 代码核对

`apps/runner/src/real-executor.ts`：

- `RealSession` 新增 `finalizePromise`、`finalizeRequests`、`finalizeCommitted`（122–126 行）。
- `finalize()`（717–738 行）：
  - `session.finished` 为真时立即返回；
  - 已有 `finalizePromise` 且未 committed 时，把请求追加到 `finalizeRequests`，返回同一 Promise；
  - 无 in-flight 决策时，同步安装 `finalizePromise`，并在 `finally` 中仅当它仍是当前 Promise 时清空。
- `runFinalize()`（740–832 行）：
  - 先 `await confirmTreeAfterClose()`；
  - 树未确认/确认抛错时 `markUncertain()`，不写终态、不发终态事件；
  - 树确认后、任何 Git/Journal await 之前，同步设置 `finalizeCommitted=true`、`finished=true`（764–765 行）；
  - `collectGit` 失败改为 failed；
  - `journal.finish` 失败时改为 failed、不发送成功事件，加入 `uncertainOrphans`，保留 active journal（818–831 行）。
- `markUncertain()`（1615–1626 行）：设置 `finished=true`，清 timer，加入 `uncertainOrphans`，保留 session 供 heartbeat/snapshot 显示。

关于“同步互斥”的严格说明：`finalize()` 先调用 `runFinalize()`，再赋值 `finalizePromise`；`runFinalize` 会在第一个 `await` 处让出。由于 JS 单线程，其他任务不可能在这个同步区间内插入调用；且 `runFinalize` 在第一个 yield 之前不会触发用户回调，因此并发调用者看到的仍是同一 Promise。F1/F5/F9 和 IR1–IR3 均验证了这一点。

#### 4.1.2 测试与独立复现

已提交测试 `apps/runner/test/finalize-concurrency.spec.ts`：

- F1：两个相同 outcome 并发，共享一个决策；
- F2：finalize 进行中到达 failed，failed 确定性胜出；
- F3：close 与 15s fallback 竞争，只产生一个 cancelled；
- F4：close 与 `abortSpawnedProcess()` 竞争，只产生一个 failed；
- F5：树确认延迟，期间再次 finalize，不产生第二条流程；
- F6：Journal `finish()` 注入失败，0 终态事件、session 保留、`uncertainOrphans` 包含该 execution；
- F7：三个 completed 并发，只 1 次 finish、1 个 completed；
- F8：cancelled 与 failed 并发，Journal/事件一致为 failed；
- F9：树未确认，0 finish、0 终态事件、`finalizeCommitted=false`、active journal 保留、迟到 completed 不生效。

运行结果：Windows 与 Linux 均通过（F1–F9 包含在各自的 targeted 与 full suite 中）。

独立探针：

- **IR1**：`journal.finish` pending 时发起 late failed。结果：`journal.finish` 1 次、completed 1 个、failed 0 个、`finalizeCommitted=true`、`finalizeRequests.length=1`。
- **IR2**：Git collection pending 时发起 late completed。结果：failed 1 个（primary failure）、completed 0 个、finish 1 次。
- **IR3**：50 个同步调用者，最后一个为 failed。结果：finish 1 次、failed 1 个、completed 0 个。

#### 4.1.3 结论与残余

**P1-1 关闭。** 没有发现可以同时写出两个终态 Journal 或发送两个终态事件的路径。

残余（P3，N-2）：`finalize()` 的注释（713–715 行）说“树未确认时 decision 保持 open，promise 清空后稍后可重试”；但 `markUncertain()` 已把 `session.finished=true`，后续 `finalize()` 会直接返回，F9 也明确断言“in-process uncertainty is terminal”。实际语义是“保留 active journal/`uncertainOrphans`，由下一次启动恢复扫描处理”，不是“进程内重试”。这是注释/报告措辞不准确，不是功能缺陷；建议在 Slice 1 修正注释和修复报告 §3.2 的表述。

---

### 4.2 P2-1：Windows starting guard 与 ready 失败清理 — CLOSED / PASS（Windows 范围）

#### 4.2.1 代码核对

`apps/runner/native/windows-process-supervisor.cs`：

- `Main()` 在 `CreateJob()` 之后、`SpawnCli()` 之前：
  - `WriteGuard("starting", ...)` 必须返回 true（76–79 行）；
  - `VerifyGuard()` 必须返回 true（80–83 行）；
  - 任一失败立即抛错，进入 `catch`，返回 supervisor failure exit code 70，**不会执行 `SpawnCli()`**（85 行）。
- `WriteGuard()`（343–384 行）：
  - 写入同目录临时文件，`File.Replace`/`File.Move` 到目标；
  - 失败时清理临时文件并返回 `false`。
- `VerifyGuard()`（387–400 行）：
  - 按精确文本读回 guard，并与期望 JSON 文本逐字比较。
- `AssignProcessToJobObject` → `ResumeThread` 的顺序未改变（195–211 行）。

`apps/runner/src/supervised-process.ts`：

- `ready` 立即挂 `catch(() => undefined)`，避免未等待的 rejection 变成 unhandled（108–116 行）。
- `guardForOperation()`（127–140 行）先读当前 guard，读不到时有界等待 `ready`；`terminate()`/`verifyTreeGone()` 在无 guard 时返回 unconfirmed，不向上抛。
- `waitForGuardReady()`（288–350 行）校验 `executionId`、`launchToken`、`supervisorPid` 与 `child.pid` 一致；`state=failed` 立即拒绝；supervisor 提前退出时拒绝为 `PROCESS_SUPERVISOR_EXITED`。

#### 4.2.2 测试与独立复现

`apps/runner/test/supervised-process-safety.spec.ts`：

- S1：supervisor 未写 guard 即退出，`ready` 拒绝为 `PROCESS_SUPERVISOR_EXITED`；
- S2：guard 写入后消失再退出，不返回 ready；
- S3：guard 路径不可读（目录），超时拒绝；
- S4：guard `state=failed`，拒绝为 `PROCESS_SUPERVISOR_FAILED`；
- S5：正常 running guard，ready 成功；
- S6（POSIX）：ready 拒绝后 terminate/verifyTreeGone 不抛、confirmed=false；
- S7（Windows）：把 guard 路径预建为目录，starting guard 写入确定性失败；断言 CLI marker 不存在、ready 拒绝、terminate unconfirmed；
- S8（POSIX）：supervisor 卡在写 guard 前且保持存活，terminate 在 200ms 内返回，总耗时 <10s，confirmed=false、killIssued=true。

运行结果：

- Windows targeted：S7 实际执行并通过（约 1.6s），S6/S8 按平台跳过；
- Linux targeted：S6/S8 通过，S7 按平台跳过；
- 双平台 S1–S5 通过。

S7 使用真实 Windows supervisor（不是 mock），预建目录是确定性的文件系统故障注入；断言 `cliOut` 不存在，能证明 `SpawnCli()` 未执行。

#### 4.2.3 结论与残余

**P2-1 在其 Windows 范围内关闭。** Windows starting guard 的“写后回验 + 失败阻止 SpawnCli”已实现并由真实 supervisor 用例验证。

**新发现 N-1（P2）：POSIX supervisor 没有同等保护。**

`apps/runner/src/process-supervisor-child.ts`：

```ts
// 107–111 行
updateGuard({ state: 'starting' });
if (!existsSync(config.guardPath)) {
  throw new Error('process guard was not written');
}
```

- `updateGuard()`（475–483 行）在写临时文件/rename 失败时只 `appendLog`，**吞掉异常**；
- `existsSync(config.guardPath)` 只能证明“路径存在”，不能证明它是普通文件、内容可解析、`executionId/launchToken/supervisorPid` 与本次启动一致；
- 如果 guard 路径被预建为目录，`existsSync` 返回 true，supervisor 继续 `spawn()` CLI。

独立探针 **IR7**：在 Linux 上把 guard 路径预建为目录，启动真实 POSIX supervisor + `real-cli.cjs`。结果：

```json
{
  "observation": "POSIX CLI started even though the guard path is not a regular file",
  "guardKind": "invalid",
  "cliPid": 66994
}
```

影响：

- Runner 的 `ready` 会等待/超时（guard 永远不合法），但 CLI 已经运行；
- `terminate()` 没有可读 guard，只能对 supervisor 直接做有界清理，返回 `confirmed:false`；CLI 可能成为孤儿；
- 启动恢复扫描会因 guard invalid 而 block（fail-closed），不会静默放行，但会造成“可运行但无法确认清理”的可用性/孤儿风险。

这不是 P2-1 Windows 修复的回归；它是同一生命周期不变量在 POSIX 上的跨平台缺口。建议在 Slice 1 修复：`updateGuard({state:'starting'})` 后立即 `readProcessGuard` + 校验 `executionId/launchToken/supervisorPid/state`，失败则在 `spawn()` 前退出；`updateGuard` 在 spawn 前应返回成功/失败而不是吞异常。

口径说明：本报告按修复报告标题把 P2-1 限定为 Windows；若项目要求 P2-1 覆盖所有平台的 starting guard，则 N-1 应直接回挂 P2-1，P2-1 也不能签署关闭。两种口径下总体结论均为 FAIL（P2-2 已独立构成失败）。

---

### 4.3 P2-2：`resolve-corrupt` 路径、sidecar 与内容完整性 — FAIL / NOT CLOSED

#### 4.3.1 已实现的部分

`apps/runner/src/recovery.ts` 的 `resolveCorruptJournal()`（253–311 行）现在要求：

1. 目标 resolve 后位于 recovery root 内（`relative` + `..`/绝对路径检查，260–267 行）；
2. 目标父目录就是 recovery root（268–273 行）；
3. basename 匹配 `\.corrupt-\d+$`（274–279 行）；
4. `lstat()` 成功且为普通文件，拒绝符号链接、目录和其他类型（280–291 行）。

已提交测试：

- R13：普通文件、`corrupt-` 后缀目录、root 子目录中的 `corrupt-` 普通文件、root 外路径全部拒绝；前三种断言不产生 `.resolution.json`；
- R14：root 直属的隔离普通文件成功写入 sidecar；
- R07（既有真实 OS 用例）：真实 quarantined journal 仍可成功 resolve。

这些测试在 Windows 与 Linux 均通过。独立补充：

- Windows junction 探针：把 `evidence.json.corrupt-123` 建成 junction，`resolveCorruptJournal` 返回 `resolved:false`，reason 为 “The target is not a regular quarantined corrupt journal file”，未写 sidecar。说明 `lstat` 的类型检查在 Windows reparse point 上有效。

**结论：P2-2 的“路径/类型”子项已关闭。**

#### 4.3.2 未关闭的缺口 A：内容不是损坏 journal 也被接受

`resolveCorruptJournal()` 在完成路径/类型检查后，直接 `writeFile` sidecar（292–305 行），**没有验证目标内容**：

- 不检查目标是否是当前 scan 的 `corrupted` 列表中的文件；
- 不检查目标内容是否确实无法解析为 journal / 是否确实失败 `isValidRecord`；
- 不检查 note 是否非空；
- 不检查 sidecar 是否与目标路径/执行绑定。

独立探针 **IR5**：

```text
root/operator-note.corrupt-123  内容："this is not a journal and not invalid JSON evidence"
resolveCorruptJournal(..., "independent review")
→ {"resolved":true,"reason":"Corrupt journal kept as evidence with a resolution sidecar"}
```

即：任意 root 直属、扩展名匹配的普通文件都可以被“解决”，即使它从来不是损坏 journal。R13 没有覆盖这个场景（R13 的 `arbitrary` 是 `notes.json`，不匹配后缀；匹配后缀的用例是目录，被类型检查拒绝）。

#### 4.3.3 未关闭的缺口 B：sidecar 非原子写入

`resolveCorruptJournal()` 使用普通 `writeFile` 直接写最终路径：

```ts
// recovery.ts 292–305 行
await writeFile(
  `${target}.resolution.json`,
  `${JSON.stringify({ version: 1, resolution: 'operator-confirmed-process-gone', note, resolvedAt: ... })}\n`,
  'utf8',
);
```

没有临时文件 + fsync + rename。进程崩溃、磁盘满、并发写都可能在最终路径留下零字节或截断文件。对比：`persistBlockedState()`（935–957 行）和 `ExecutionJournal` 的 journal 写入（`execution-journal.ts` 476–487 行）都使用了临时文件 + rename。同文件的普通 `writeResolution()`（959–970 行）也使用普通 `writeFile`，但它不是 scan 的放行门；corrupt-journal 的 sidecar 才是。

#### 4.3.4 未关闭的缺口 C：`resolutionExists()` 只 stat，不校验内容

`recovery.ts` 1008–1015 行：

```ts
async function resolutionExists(file: string): Promise<boolean> {
  try {
    await stat(`${file}.resolution.json`);
    return true;
  } catch {
    return false;
  }
}
```

`findUnresolvedCorruptEvidence()` 在 862–864 行对每个 `*.corrupt-<digits>` 文件调用它；只要 sidecar 路径存在（文件、目录、符号链接、零字节、截断 JSON 都算），就跳过 block。

独立探针：

- **IR4**：第一次 scan 把 `broken.json` 隔离为 `broken.json.corrupt-<ts>`；写入零字节 `${quarantined}.resolution.json`；第二次 scan 返回 **`clean=true`**。
- **IR4b**：写入截断内容 `{"version":1`；第二次 scan 返回 **`clean=true, blocked=0`**。

这意味着：一个空的/损坏的 sidecar 就能让 Runner 认为“损坏 journal 已被操作员解决”，而实际上没有任何可审计的 operator note。这是本次复审判定 P2-2 未关闭的**核心证据**。

#### 4.3.5 未关闭的缺口 D：journal 内容校验不接受非法 PID

`apps/runner/src/execution-journal.ts` 的 `isValidRecord()`（489–519 行）校验了 `version`、`executionId`、`runtime`、`phase`、`status`、`startedAt`、`lastSequence` 等字段，也校验了 `supervisorPid`/`cliPid` 为可选数字，但**没有校验 `pid`、`processStartTime`、`processGroupId` 的类型**。

独立探针 **IR8**：

- 写入 active journal，`pid: "not-a-number"`，无 guard、`processKind:'direct'`、`spawnState:'intent'`；
- `scan()` 返回 **`clean=true, blocked=0`**；
- journal 被 finalize 为 **`interrupted`**，没有发生任何进程证明。

原因链：

1. `isValidRecord()` 不检查 `pid` 类型，记录被当作 valid；
2. `verifyRecordTree()` 看到 `record.pid !== null`，调用 `inspectProcess("not-a-number")` → `null`；
3. `isProcessAlive("not-a-number")` → `false`（`process.kill` 抛 `ERR_INVALID_ARG_TYPE`，非 `EPERM`）；
4. 无 process group/guard，返回 `confirmed:true`，journal 被 finalize。

这是与 P2-2 同类的“内容校验 fail-open”。它的前置条件是 journal 被篡改/损坏成非数字 PID（正常 writer 不会产生），但恢复门禁的职责正是拒绝这种记录，而不是把它当作 legacy 记录放行。建议把 `pid`/`processStartTime`/`processGroupId` 加入 `isValidRecord()` 的强校验；非法记录走 quarantine/block，而不是 finalize。

#### 4.3.6 结论

**P2-2 未关闭。** 路径/类型校验是必要但不充分的；sidecar 的非原子写入 + 存在性检查 + 缺乏内容绑定，使得“操作员确认”可以被空文件/截断文件绕过；`resolve-corrupt` 也接受任意匹配后缀的普通文件；journal 内容校验还存在同类 fail-open。

修复方向（供 Slice 1，不在此实施）：

1. sidecar 使用临时文件 + fsync + 原子 rename 写入最终路径；
2. `resolutionExists()` 改为“读取 + JSON 解析 + schema 校验 + 目标绑定校验”，空/截断/不匹配一律视为不存在；
3. `resolveCorruptJournal()` 校验目标确实是当前 scan/ledger 中的隔离损坏 journal（或内容确实失败 journal 校验），并要求非空 note；
4. 对 journal `pid`/identity 字段做严格类型校验，非法记录隔离/阻塞；
5. 新增回归测试：空 sidecar、截断 sidecar、目录 sidecar、任意 `*.corrupt-N` 普通文件、非法 PID journal。

---

### 4.4 P2-3：人工 resolve 的完整进程树证明 — CLOSED / PASS WITH WARNINGS

#### 4.4.1 代码核对

`apps/runner/src/recovery.ts`：

- `resolveBlockedExecution()` 现在调用 `verifyRecordTree()`（230 行），不再只检查 root PID；
- `verifyRecordTree()`（719–827 行）：
  - 有可读 guard：`verifyGuardedTree()` 必须 `confirmed:true`，`identityMismatch` 必须 false；
  - guard invalid/mismatch：拒绝；
  - guard missing 且 journal 记录了 supervisor（`processKind`、`guardPath` 或 `supervisorPid`）：拒绝（`SUPERVISOR_GUARD_MISSING`）；
  - legacy 有 PID：PID 已消失且身份不可复用，或明确拒绝；
  - legacy 有 POSIX process group：必须枚举成功且成员为空；
  - PID 为 null 且无 group/guard：保留 operator-attestation 路径（R01 依赖）。

`apps/runner/src/process-guard.ts` 的 `verifyGuardedTree()`（284–484 行）：

- 校验 supervisor/CLI 的 PID + startTime 身份；
- `linux-cgroup`：读取 cgroup members，非空则 `groupKnown=false`；
- `posix-group`：枚举 process group，非空且无匹配记录身份时 `identityMismatch=true`；
- `windows-job`：supervisor/CLI 仍存活则拒绝；两者都退出且 `jobCreated=true` 时，依据 Job Object 的 kill-on-close 语义确认。

#### 4.4.2 测试与独立复现

已提交测试 `apps/runner/test/recovery-resolution.spec.ts`：

- R15：guard 中 supervisor PID 存活且身份匹配 → 拒绝，journal 保持 active，finish 未调用；
- R15b：guard 校验时 `inspectProcess` 抛错 → 拒绝，journal 保持 active；
- R16：guard 中 PID 身份不匹配 → 拒绝；
- R17：legacy PID 存活且身份匹配 → 拒绝；
- R18（Linux）：POSIX、无 root PID、process group 非空 → 拒绝，reason 含 `PROCESS_GROUP_NOT_EMPTY`；
- R19：guard 可读且全树确认消失 → 成功，journal 变 interrupted，resolution sidecar 存在。

运行结果：Windows 与 Linux 均通过（R18 仅 Linux 执行，R19 双平台执行）。

独立探针 **IR6**（任务要求的 cgroup 非空 + supervisor/CLI 已退出场景）：

- 从 `/proc/self/cgroup` 找到 cgroup v2 路径 `/sys/fs/cgroup/init.scope`，`cgroup.procs` 当时有 **26** 个成员；
- 构造 guard：`supervisorPid=999999`、`cliPid=999998`（`inspectProcess` 返回 null，即两者均已退出），`isolation:'linux-cgroup'`、`cgroupPath` 指向上述路径；
- `verifyGuardedTree()`：`confirmed=false`，`cgroupMemberCount=26`；
- `resolveBlockedExecution()`：`resolved=false`，reason 为 `PROCESS_TREE_NOT_CONFIRMED: The protected cgroup/process group is not empty`；journal 保持 `active`。

这证明“supervisor/CLI 已退出但 cgroup 仍有成员”时不会误放行。

#### 4.4.3 结论与残余

**P2-3 原 finding（只看 root PID）已关闭。** guard/cgroup/process group/有 PID 的 legacy 路径均按 fail-closed 处理；PID 为 null 且无 group/guard 的 operator-attestation 是明确保留的例外。IR6 补足了已提交测试未覆盖的 cgroup 场景。

残余（均为 P3，不阻塞）：

1. **R19 的平台覆盖**：`guardRecord()` 默认 `isolation:'windows-job'`（`recovery-resolution.spec.ts` 66 行），R19 在 Windows 与 Linux 都使用该默认值，没有走 `linux-cgroup` 分支。IR6 是临时探针，未提交为回归测试（N-6）。建议把 IR6 的核心断言加入正式测试。
2. **journal↔guard 交叉校验**：`loadGuard()`（685–711 行）只校验 `executionId` 和 `launchToken`，不比较 journal 的 `supervisorPid`/`supervisorStartTime`/`cliPid`/`cliStartTime` 与 guard 是否一致。guard 被当作权威来源，这在正常情况下是正确的；但若 journal 与 guard 不一致（篡改/旧记录），当前不会显式报错。建议增加一致性检查（P3，N-3 的一部分）。
3. **legacy operator attestation**：PID 为 null 且无 group/guard 的旧 journal 仍允许人工 resolve（R01 语义）。这是修复报告 §9.1 明确记录的兼容路径；本次不把它算作 P2-3 失败，但 Slice 1 应明确是否继续接受该风险。
4. **本地 guard 篡改/平台隔离不匹配**：`currentGuard()`（`supervised-process.ts` 119–124 行）在读取到任意 `kind='ok'` 的 guard 时直接更新 `latestGuard`，不校验 `executionId/launchToken/supervisorPid`；`verifyGuardedTree()` 也不校验 `guard.isolation` 是否与当前平台匹配。拥有 recovery root 写权限的本地攻击者可能用伪造 guard 影响终止/验证目标（例如在 Linux 上伪造 `windows-job`）。这是本地同用户威胁模型下的 P3，建议在 Slice 1 加平台/身份一致性校验。

---

### 4.5 P2-4：Deferred

P2-4 不在本次修复范围，修复报告也没有声明关闭。本次复审**不检查、不宣布关闭**。

相关现状：

- `apps/runner/src/real-executor.ts` 仍保留 `TERMINAL_FALLBACK_MS = 15_000`（47 行）和 `handleTerminalFallback()`（1104–1106、1114 行起）；
- F3 只验证 close 与 fallback 的仲裁，不证明受管路径在 15s 内一定完成；
- 本次没有使用旧的 fake child 测试来冒充 managed/supervised 路径证据。

P2-4 继续作为 Slice 1 的明确输入；Slice 1 不能以“本次已修复”为由跳过它。

---

## 5. 独立探针结果汇总

运行命令（Linux 精确 HEAD 副本）：

```bash
cp /path/to/independent-review.spec.ts apps/runner/test/independent-review.spec.ts
pnpm --filter @raft-lite/runner exec vitest run test/independent-review.spec.ts --reporter=verbose
```

结果：**Test Files 1 passed (1) / Tests 9 passed (9)**。

| 探针 | 结果             | 解释                                                                  |
| ---- | ---------------- | --------------------------------------------------------------------- |
| IR1  | PASS             | 1 finish / 1 completed / 0 failed；P1-1 证据                          |
| IR2  | PASS             | 1 finish / 1 failed / 0 completed；P1-1 证据                          |
| IR3  | PASS             | 50 调用者 / 1 finish / 1 failed；P1-1 证据                            |
| IR4  | PASS（复现缺口） | 空 sidecar → 下一次 scan `clean=true`；P2-2 缺口                      |
| IR4b | PASS（复现缺口） | 截断 sidecar → `clean=true, blocked=0`；P2-2 缺口                     |
| IR5  | PASS（复现缺口） | 任意内容 `*.corrupt-123` → `resolved=true`；P2-2 缺口                 |
| IR6  | PASS             | cgroup 26 成员 / confirmed=false / resolved=false / active；P2-3 证据 |
| IR7  | PASS（复现缺口） | POSIX CLI 已启动 / guard kind=invalid；N-1 证据                       |
| IR8  | PASS（复现缺口） | 非法 PID journal → clean=true / status=interrupted；P2-2 缺口         |

关键原始输出：

```json
{"observation":"incomplete resolution sidecar","clean":true,"blocked":0}
{"observation":"malformed PID journal validation","clean":true,"blocked":0,"journalStatus":"interrupted"}
{"observation":"arbitrary regular file with quarantine suffix accepted","resolved":true,"reason":"Corrupt journal kept as evidence with a resolution sidecar"}
{"observation":"POSIX CLI started even though the guard path is not a regular file","guardKind":"invalid","cliPid":66994}
{"observation":"non-empty cgroup blocks operator resolution","cgroupMemberCount":26,"verificationConfirmed":false,"resolved":false,"reason":"Process tree is not proven gone for execution execution_independent_cgroup: PROCESS_TREE_NOT_CONFIRMED: The protected cgroup/process group is not empty","journalStatus":"active"}
```

---

## 6. 与修复报告的差异

| 修复报告声明                                                           | 本次核对                                                                                                 | 结论                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P2-2 “已修复”：目标类型/路径校验，R13–R14                              | 路径/类型校验确实存在并通过；但 sidecar 非原子、存在性检查、内容未校验；IR4/IR4b/IR5/IR8 复现 fail-open  | **实质性差异**                   |
| P2-1 “已修复”：Windows starting guard 写后回验                         | Windows 实现与 S7 真实 supervisor 用例均通过；POSIX supervisor 仍有同类缺口（IR7）                       | Windows 范围内准确；跨平台不完整 |
| P1-1 “失败路径不会因缓存 Promise 永久无法重试”                         | `markUncertain()` 设置 `finished=true`，进程内不会重试；F9 明确断言 terminal；实际恢复依赖下一次启动扫描 | 措辞差异，非功能缺陷             |
| R19 “guard 可读且全树确认消失”                                         | R19 使用 `windows-job`，双平台均不覆盖 cgroup；IR6 临时探针覆盖了 cgroup 非空场景                        | 覆盖差异                         |
| 测试计数：Windows 193 passed / 3 skipped；Linux 194 passed / 2 skipped | 独立复现完全一致（196 total）                                                                            | 一致                             |
| F1–F9、S1–S8、R13–R19 的平台执行声明                                   | 与 §3.3 的跳过矩阵一致；S7 在 Windows 真实执行，S6/S8 在 Linux 真实执行                                  | 一致                             |
| `format:check` 的 4 个文件为基线既有债                                 | 4 个文件在 `324b6d7..HEAD` 无 diff，最后提交均为 `324b6d7`；基线脚本/baseline 未变                       | 一致                             |
| 基线为“独立复审 PASS WITH WARNINGS”                                    | 仓库与历史中没有该 WP-D 独立复审文档；无法核对原文                                                       | 可追溯性差异                     |
| 报告标题“Slice 0.1 独立复审修复报告”                                   | 文件、分支、任务均为 Slice 0.2                                                                           | 文档命名差异                     |

---

## 7. 新发现与残余风险

### N-1（P2）POSIX supervisor 的 starting guard 仍可被目录/不可写路径绕过

- 位置：`apps/runner/src/process-supervisor-child.ts` 107–111、475–483 行。
- 证据：IR7；`existsSync` 对目录返回 true，`updateGuard` 吞掉写失败，CLI 仍被 `spawn()`。
- 影响：CLI 运行时没有可读 guard；`ready` 超时，`terminate` 无法证明树消失，可能留下孤儿；恢复扫描会 block（fail-closed，但可用性受损）。
- 建议：在 `spawn()` 前回读并校验 guard；`updateGuard` 在初始写入阶段返回失败/抛错，而不是吞异常。
- 是否阻塞 Slice 1：建议阻塞。Linux 是受支持平台，且该缺口与 P2-1 是同一不变量。

### N-2（P3）finalize 注释与 uncertain 语义不一致

- 位置：`apps/runner/src/real-executor.ts` 713–715 行 vs 1615–1626 行；F9。
- 影响：维护者可能误以为树未确认后可以在进程内重试，实际只能依赖下一次启动扫描；不影响当前终态一致性。
- 建议：修正注释和修复报告 §3.2 的“可重试”表述。

### N-3（P3）guard 本地篡改与平台隔离不匹配未校验

- 位置：`apps/runner/src/supervised-process.ts` 119–124 行；`apps/runner/src/recovery.ts` 685–711 行；`apps/runner/src/process-guard.ts` 284–484 行。
- 影响：拥有 recovery root 写权限的本地攻击者可以替换 guard、伪造 `isolation`（例如在 Linux 上使用 `windows-job`）或让 `currentGuard()` 接受不属于本 execution 的 guard。正常运行不会触发；属于本地同用户威胁模型。
- 建议：`currentGuard()` 校验 `executionId/launchToken/supervisorPid`；`verifyGuardedTree()` 校验 `isolation` 与 `process.platform` 匹配；`loadGuard()` 交叉校验 journal 的 PID/startTime 字段。

### N-4（P3）Windows `TerminateProcess` 返回值未检查

- 位置：`apps/runner/native/windows-process-supervisor.cs` 195–203 行。
- 场景：`AssignProcessToJobObject` 失败后，代码调用 `TerminateProcess` 终止 suspended CLI，但不检查返回值；若终止失败，suspended 进程可能泄漏（不会执行用户代码，但占用 PID/句柄）。
- 建议：检查返回值并在失败时记录到 guard/日志；确保 `CloseHandle` 后没有残留进程。

### N-5（P3）原始 WP-D 独立复审文档缺失、标题版本不一致

- 仓库与 git 历史中没有 WP-D Slice 0.1 独立复审文档；修复报告标题写“Slice 0.1”，文件/分支/任务为 Slice 0.2。
- 影响：无法独立核对原 Finding 的原文措辞、级别和验收条件；不影响本次代码证据。
- 建议：把原始复审文档纳入仓库，或在本报告/修复报告中明确引用其存放位置；修正标题版本。

### N-6（P3）R19 未覆盖 cgroup 分支

- 位置：`apps/runner/test/recovery-resolution.spec.ts` 55–77、309–331 行。
- 影响：已提交测试在双平台都使用 `windows-job`；cgroup 非空场景仅由本次临时 IR6 覆盖，未来回归可能漏检。
- 建议：新增一个 `linux-cgroup` 的正式测试（可在 Linux CI 运行），断言非空 cgroup 拒绝 resolve。

---

## 8. Slice 1 准入建议

**当前结论：不允许进入 Slice 1。**

按任务给出的准入规则：

> Slice 0.2 PASS 需要 P1-1、P2-1、P2-2、P2-3 全部闭环，且没有新的 P0/P1。

本次状态：

- P1-1：闭环；
- P2-1：Windows 范围闭环；
- P2-2：**未闭环**；
- P2-3：闭环（带 P3 警告）；
- P2-4：Deferred，Slice 1 必须处理，本报告不宣布关闭；
- 新发现：N-1 为 P2，N-2–N-6 为 P3；没有新的 P0/P1。

因此不满足 PASS 条件。即使不考虑 N-1，P2-2 的 sidecar/内容 fail-open 也足以阻止验收。

### 8.1 重新复审前的最小条件

1. **修复 P2-2**：
   - sidecar 原子写入（临时文件 + fsync + rename）；
   - `resolutionExists()` 读取并校验 JSON/schema/目标绑定，空/截断/目录/符号链接一律视为不存在；
   - `resolveCorruptJournal()` 验证目标确实是当前隔离的损坏 journal（或内容确实失败 journal 校验），要求非空 note；
   - journal `pid`/identity 字段严格校验，非法记录隔离/阻塞；
   - 增加对应回归测试（空 sidecar、截断 sidecar、任意 `*.corrupt-N`、非法 PID）。
2. **处理 N-1**：修复 POSIX starting guard 的写后回验；若决定接受为残余风险，需要明确 owner、截止时间和风险签字，不能默认为已关闭。
3. **保留 P2-4 为 Slice 1 输入**：不得以本次修复为由关闭；15s fallback 仍需在 Slice 1 处理。
4. **P3 建议**：修正 finalize 注释、加 guard/journal/平台交叉校验、检查 C# `TerminateProcess` 返回值、把 cgroup resolve 场景纳入正式测试。
5. **重新复审范围**：对新的修复提交重新运行 Windows/Linux 全量 runner 测试、F1–F9、S1–S8、R13–R19、独立 P2-2 探针、typecheck/build/lint/Prettier/`format:check`。

### 8.2 不能声明的内容

- 不能声明 WP-D Slice 0.2 PASS；
- 不能声明 P2-2 已关闭；
- 不能声明 P2-4 已关闭；
- 不能声明 Slice 1 已获准开始；
- 不能把本次“测试全绿”当作 P2-2 已闭环的证据。

---

## 9. 只读合规声明

- 本次复审未修改任何产品代码、测试、配置、契约、迁移、`main`、冻结设计文档或既有报告。
- 未执行 commit、push、rebase、reset、删除或覆盖用户文件。
- 未实施任何修复；本报告是唯一新增文件。
- 独立探针、日志、WSL 副本均在仓库外；运行后未在仓库留下测试文件。
- 复审开始时和结束时，除本报告外工作树保持干净；分支仍为 `feature/p2-02-wpd-slice0-2-review-remediation`，HEAD 仍为 `8a72d3a5ff6bb9c48ef498e806f5bfc292a31bf5`。

---

## 附录 A：关键命令与输出摘要

### A.1 Windows

```powershell
pnpm --filter @raft-lite/runner test
# 21 passed (21)
# Tests 193 passed | 3 skipped (196)
# Duration 36.59s

pnpm --filter @raft-lite/runner exec vitest run `
  test/finalize-concurrency.spec.ts `
  test/supervised-process-safety.spec.ts `
  test/recovery-resolution.spec.ts --reporter=verbose
# 3 passed (3)
# Tests 22 passed | 3 skipped (25)

pnpm --filter @raft-lite/runner typecheck   # exit 0
pnpm --filter @raft-lite/runner build       # exit 0
pnpm lint                                   # exit 0
pnpm exec prettier --check <7 changed TS/CJS files>  # exit 0
pnpm format:check                           # exit 1；4 个基线既有文件
```

### A.2 Linux（WSL2，`/tmp/haft-slice02-review`）

```bash
CI=true pnpm --filter @raft-lite/runner test
# 21 passed (21)
# Tests 194 passed | 2 skipped (196)
# Duration 4.03s

pnpm --filter @raft-lite/runner exec vitest run \
  test/finalize-concurrency.spec.ts \
  test/supervised-process-safety.spec.ts \
  test/recovery-resolution.spec.ts --reporter=verbose
# 3 passed (3)
# Tests 24 passed | 1 skipped (25)

pnpm --filter @raft-lite/runner typecheck   # exit 0
pnpm --filter @raft-lite/runner build       # exit 0
pnpm lint                                   # exit 0
pnpm exec prettier --check <7 changed TS/CJS files>  # exit 0
pnpm format:check                           # exit 1；同样 4 个文件

pnpm --filter @raft-lite/runner exec vitest run test/independent-review.spec.ts --reporter=verbose
# 1 passed (1)
# Tests 9 passed (9)
```

### A.3 HEAD 副本一致性

```text
git ls-tree -r HEAD --format='%(objectname) %(path)'  → 301 files
WSL copy: git hash-object each file
TOTAL=301 MISMATCH=0
```

### A.4 格式债核对

```text
apps/runner/src/process-guard.ts            diff(324b6d7..HEAD) = empty; last commit = 324b6d7
apps/runner/src/process-supervisor-child.ts diff = empty; last commit = 324b6d7
apps/runner/src/recovery-admin.ts           diff = empty; last commit = 324b6d7
apps/runner/test/recovery-hardening-os.spec.ts diff = empty; last commit = 324b6d7
```

---

## 附录 B：代码位置索引

| 主题                    | 文件:行                                                      |
| ----------------------- | ------------------------------------------------------------ |
| finalize 字段           | `apps/runner/src/real-executor.ts:122-126`                   |
| finalize 入口/单飞      | `apps/runner/src/real-executor.ts:717-738`                   |
| runFinalize/提交点      | `apps/runner/src/real-executor.ts:740-832`                   |
| markUncertain           | `apps/runner/src/real-executor.ts:1615-1626`                 |
| Windows starting guard  | `apps/runner/native/windows-process-supervisor.cs:76-89`     |
| Windows WriteGuard      | `apps/runner/native/windows-process-supervisor.cs:343-384`   |
| Windows VerifyGuard     | `apps/runner/native/windows-process-supervisor.cs:387-400`   |
| Windows job assign/term | `apps/runner/native/windows-process-supervisor.cs:195-211`   |
| POSIX starting guard    | `apps/runner/src/process-supervisor-child.ts:107-111`        |
| POSIX updateGuard       | `apps/runner/src/process-supervisor-child.ts:475-483`        |
| ready/cleanup           | `apps/runner/src/supervised-process.ts:108-199`              |
| waitForGuardReady       | `apps/runner/src/supervised-process.ts:288-350`              |
| resolveCorruptJournal   | `apps/runner/src/recovery.ts:253-311`                        |
| sidecar 写入            | `apps/runner/src/recovery.ts:292-305`                        |
| corrupt evidence 扫描   | `apps/runner/src/recovery.ts:850-876`                        |
| resolutionExists        | `apps/runner/src/recovery.ts:1008-1015`                      |
| verifyRecordTree        | `apps/runner/src/recovery.ts:719-827`                        |
| loadGuard               | `apps/runner/src/recovery.ts:685-711`                        |
| scan                    | `apps/runner/src/recovery.ts:147-186`                        |
| journal 校验            | `apps/runner/src/execution-journal.ts:489-519`               |
| journal 原子写          | `apps/runner/src/execution-journal.ts:476-487`               |
| verifyGuardedTree       | `apps/runner/src/process-guard.ts:284-484`                   |
| windows-job 分支        | `apps/runner/src/process-guard.ts:376-422`                   |
| F1–F9                   | `apps/runner/test/finalize-concurrency.spec.ts:321-565`      |
| S1–S8                   | `apps/runner/test/supervised-process-safety.spec.ts:80-302`  |
| S7                      | `apps/runner/test/supervised-process-safety.spec.ts:265-301` |
| R13–R19                 | `apps/runner/test/recovery-resolution.spec.ts:112-331`       |
| R19                     | `apps/runner/test/recovery-resolution.spec.ts:309-331`       |
| format gate             | `scripts/acceptance/check-format.mjs:88-118`                 |

---

**复审结论：FAIL。WP-D Slice 0.2 不得验收，Slice 1 不得开始。**
