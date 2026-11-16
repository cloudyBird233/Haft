# P2-02 WP-D Slice 0.2.1 独立复审报告（C7）

| 项目          | 内容                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复审对象      | WP-D Slice 0.2.1（C6 发现 N-1、P2-2A、P2-2B、P2-2C 的修复）                                                                                                    |
| 复审类型      | 独立只读复审（C7），非实施任务                                                                                                                                 |
| 复审分支      | `feature/p2-02-wpd-slice0-2-1-remediation`                                                                                                                     |
| 代码/测试提交 | `41ef234ff427ae7ae4adac89b3e42d814d9ff7cf`                                                                                                                     |
| 实施报告提交  | `058e5d8119ebc106aa4be5e321472543319f7f62`                                                                                                                     |
| C6 复审提交   | `5357818999c885da6530974de9c55436b7801b5c`                                                                                                                     |
| 复审 diff     | `663cc28df213f1855ed72437dd8efb7cf96906ae..41ef234ff427ae7ae4adac89b3e42d814d9ff7cf`                                                                           |
| 复审环境      | Windows 10.0.26200.9711 / Node v22.22.2 / pnpm 11.5.2；Linux Ubuntu 24.04.5 LTS（WSL2，kernel 6.18.33.2-microsoft-standard-WSL2）/ Node v22.14.0 / pnpm 11.5.2 |
| **总体结论**  | **PASS WITH WARNINGS**（四项 C6 发现在 Windows 与 Linux 双平台均以真实执行证据关闭；遗留 1 项 P2 文档级警告 C7-1、6 项 P3、P2-4 仍 Deferred）                  |
| Slice 1 准入  | **允许，附条件**（C7-1 持久性边界必须写入文档；P2-4 与 N-2…N-6 须在 Slice 1 显式排期）                                                                         |
| 只读声明      | 复审期间未修改产品代码、测试、配置、契约、既有文档、`main`；未切换/重置/清理工作树；未实施修复；未启动 Slice 1。报告本体随后按指示单独提交到本分支             |

> 本报告**不采信**实施报告的任何结论或测试输出作为依据，所有判断来自对真实 diff、源码、测试实现和独立运行的复核。最终结论虽与其同为 PASS WITH WARNINGS，但依据、警告项与准入条件均独立得出（其实施报告未提出 C7-1…C7-7 中的任何一项）。
> 本报告是唯一新增产物，不修改任何既有文件；提交见 §附录 B。

---

## 1. 复审范围

### 1.1 覆盖项

1. **N-1**：POSIX starting guard 的 fd 级验证、路径类型拒绝、spawn 前置门禁。
2. **P2-2A**：resolution sidecar 的原子发布、文件/目录 fsync、严格读取与绑定校验、并发 resolve、故障注入。
3. **P2-2B**：corrupt journal provenance 的产生路径、字段绑定、跨 root / 跨文件 / 内容篡改拒绝、信任边界。
4. **P2-2C**：Journal PID 与进程身份 Schema 的单字段与跨字段校验、历史兼容。
5. **回归保护**：P1-1（finalize single-flight）、P2-1（Windows starting guard）、P2-3（人工 resolve 全树证明）。
6. **门禁**：Windows 与 Linux 双平台的全量测试、定向套件、typecheck、build、lint、Prettier、`format:check`。

### 1.2 明确不覆盖

- P2-4（managed/supervised 15s fallback）仍 Deferred，本报告不宣布关闭。
- N-2、N-3、N-4、N-5、N-6（P3）不在本轮范围，仅确认未被声明关闭。
- macOS 全部、POSIX `posix-group` 回退分支：无真实执行证据，保持 BLOCKED（见 §10.2）。
- WP-D 整体、Slice 1 功能、API/Web/DB 侧测试。

---

## 2. Git 基线和提交关系

### 2.1 实际仓库状态（与任务描述的差异）

| 项目           | 任务描述                                   | 实际观测                                                |
| -------------- | ------------------------------------------ | ------------------------------------------------------- |
| 当前分支       | `feature/p2-02-wpd-slice0-2-1-remediation` | **`main`**（工作区干净，`git status --porcelain` 为空） |
| 当前 HEAD      | —（未给）                                  | `6a5ad16fe538281f14d1a6ce700eb87843789fa6`              |
| 4 个基线提交   | 均给哈希                                   | **全部存在**，类型均为 commit                           |
| 代码提交父节点 | 未给                                       | `41ef234f` ← `5357818`（C6 复审提交）                   |
| 报告提交父节点 | 未给                                       | `058e5d81` ← `41ef234f`（报告是代码提交的直接子节点）   |

结论：**`main`（6a5ad16）是特性分支的祖先**（`git merge-base --is-ancestor` 与 `git merge-base HEAD 41ef234f = 6a5ad16` 双向确认）。特性分支在 `main` 之上线性累积了 WP-A/WP-B/WP-C/WP-D 全部提交，未发生分叉或重写。

```text
6a5ad16 (main)  ← 祖先
  └─ … WP-A / WP-B / WP-C …
     └─ e6e1c7e  fix(p2-02): make recovery journal fail-closed
        └─ 324b6d7  fix(p2-02): harden WP-D slice 0 process recovery   ← 原始问题基线
           └─ 663cc28  fix(p2-02): close WP-D slice 0 review findings   ← Slice 0.2 代码
              └─ 8a72d3a  docs: slice 0.2 remediation report
                 └─ 5357818  docs: slice 0.2 independent review (C6)
                    └─ 41ef234  fix(runner): close C6 N-1 and P2-2      ← 本轮代码/测试
                       └─ 058e5d81  docs: slice 0.2.1 remediation report ← 本轮报告
```

`origin/feature/p2-02-wpd-slice0-2-1-remediation` = `058e5d81`，与本地一致，未发现远端分叉。

### 2.2 工作树与执行环境的处置

- 因任务禁止切换分支，**未执行 checkout**。`main` 工作树不包含本轮任何文件（`main` 甚至没有 `apps/runner/src/recovery-evidence.ts`），因此不能在该树上执行待审代码。
- 执行验证使用 `git archive 41ef234f` 导出到仓库外目录 `%TEMP%\haft-review-41ef234`，`CI=true pnpm install --frozen-lockfile` 安装（lockfile 与 `main` 逐字节相同，`git diff 6a5ad16 41ef234f -- pnpm-lock.yaml` 为空），先构建 `@raft-lite/contracts` 再运行 runner 测试。
- Linux 侧使用**同一个**归档在 WSL 的 ext4 分区另建副本 `/root/haft-c7`（Windows 的 `node_modules` 是 win32 安装产物，pnpm 会因平台不匹配要求清空重装，故不复用），`CI=true pnpm install --frozen-lockfile` 6.9 s 完成，未改动仓库。
- 该两份副本与我新增的探针文件均不进入仓库；仓库工作树在复审前后均为 clean。
- **环境变更说明（如实记录）**：复审开始时 `wsl.exe` 被本机 WorkBuddy 程序黑名单禁止，报告初稿据实标为 BLOCKED 并已提交（`bfb77b5`）。随后操作员解除该限制，本轮据同一提交补跑全部 Linux 证据，本版报告据此改判。**未因改判而放宽任何判定标准**：Linux 侧要求与 Windows 侧完全相同（同一归档、同一命令、同一跳过项逐条解释）。

### 2.3 变更范围

`git diff --stat 663cc28d..41ef234f`：**14 个文件，4076 insertions，806 deletions**。

| 类别     | 文件                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 新增源码 | `safe-file.ts`、`process-supervisor-guard.ts`、`recovery-evidence.ts`                                           |
| 修改源码 | `execution-journal.ts`、`process-guard.ts`、`process-supervisor-child.ts`、`recovery.ts`                        |
| 新增测试 | `journal-pid-schema.spec.ts`、`posix-supervisor-guard-hardening.spec.ts`、`recovery-evidence-hardening.spec.ts` |
| 修改测试 | `recovery-hardening-os.spec.ts`、`recovery-resolution.spec.ts`                                                  |
| 文档     | C6 复审报告、Slice 0.2 修复报告（前一提交带入）                                                                 |

范围合规性核查（全部为**空 diff**，即未触碰）：

```
apps/runner/native/           （Windows supervisor .cs 未改）
apps/runner/src/real-executor.ts
apps/runner/src/supervised-process.ts
apps/runner/src/recovery-admin.ts
packages/  scripts/  .github/
```

- 未删除任何测试：`git diff --diff-filter=D --name-only 663cc28d 41ef234f` 为空。
- 无 Schema/协议/错误码变更，无 `packages/contracts` 变更。

### 2.4 既有测试是否被弱化（逐字符级核查）

`recovery-hardening-os.spec.ts` 的 1389 行 diff 中，**忽略空白后仅 61 insertions / 108 deletions**。对两版本做去空白字符级序列比对后，差异只有两类：

1. 尾随逗号（Prettier）；
2. **一处**真实语义变更：R03 的 journal fixture 增加 `supervisorPid` / `supervisorStartTime`。

```diff
+ supervisorPid: tree.guard.supervisorPid,
+ supervisorStartTime: tree.guard.supervisorStartTime,
```

该变更是必要的：新 Schema 要求 `processKind:'supervisor' + spawnState:'running'` 时 `supervisorPid === pid` 且 `supervisorStartTime` 非空，真实 writer 本就写入这两个字段，fixture 之前是"不真实"的。**未发现断言被删除、放宽或空转**。

`recovery-resolution.spec.ts` 的 R14 被**加强**而非弱化：从"直接构造 `broken.json.corrupt-456`"改为"先写损坏 journal → 真实 scan 隔离 → resolve"，并**新增** `expect(existsSync(provenance)).toBe(true)`。原断言（resolved=true、sidecar 存在）保留。

---

## 3. 实际代码审查结果（总览）

| 编号  | C6 结论           | 本报告独立结论                                                      | 证据来源                                                                                                    |
| ----- | ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| N-1   | FAIL/P2           | **CLOSED**（代码 + Windows 单元 + **Linux 真实 POSIX supervisor**） | 源码 + 19 用例（Linux 19/19；Windows 11 passed / 8 skipped）+ 独立 IR7 探针 5/5（Linux）+ 静态唯一 spawn 点 |
| P2-2A | FAIL/P2           | **CLOSED**（双平台）；Windows 断电持久性边界见 §5.4、C7-1           | 源码 + IR4/IR4b + 35 项独立探针（双平台）                                                                   |
| P2-2B | FAIL/P2           | **CLOSED（在声明的同用户威胁模型内）**；真实性非密码学，见 §6.4     | 源码 + IR5 复现 + 伪造探针（双平台）                                                                        |
| P2-2C | FAIL/P2           | **CLOSED**                                                          | 源码 + IR8 复现 + 15 类非法身份探针（双平台）                                                               |
| P1-1  | CLOSED            | 保持 **CLOSED**                                                     | F1–F9 双平台通过                                                                                            |
| P2-1  | CLOSED（Windows） | 保持 **CLOSED**                                                     | S1–S5、S7（真实 Windows supervisor）通过；S6/S8 在 Linux 通过                                               |
| P2-3  | CLOSED            | 保持 **CLOSED**                                                     | R13–R17、R19 双平台通过；R18 在 Linux 通过                                                                  |
| P2-4  | DEFERRED          | **仍 DEFERRED**                                                     | 未提及关闭，代码无相关变更                                                                                  |

---

## 4. N-1：POSIX starting guard

### 4.1 文件描述符安全性（逐项）

`apps/runner/src/safe-file.ts`：

| 要求                      | 实现                                                      | 位置                      |
| ------------------------- | --------------------------------------------------------- | ------------------------- |
| O_NOFOLLOW                | `readFlags()` 按平台常量拼接                              | `safe-file.ts:148-153`    |
| O_NONBLOCK                | 同上，避免 FIFO 阻塞                                      | `safe-file.ts:152`        |
| lstat 预拒绝符号链接      | `rejectSymbolicLink()`                                    | `safe-file.ts:131-140`    |
| 对同一 fd 做 fstat        | `fstatSync(descriptor)` / `handle.stat()`                 | `safe-file.ts:108`、`:62` |
| 拒绝目录                  | `!info.isFile()` → `not-regular`                          | `safe-file.ts:109-113`    |
| 拒绝 FIFO/socket/特殊文件 | 同上（FIFO 以 `O_NONBLOCK` 打开后 fstat 判定非普通文件）  | 同上                      |
| 从同一 fd 读取            | `readFileSync(descriptor)` / `handle.readFile()`          | `safe-file.ts:119`、`:73` |
| 大小上限                  | 1 MiB（guard/sidecar/provenance）、16 MiB（journal 证据） | 调用点传入                |
| TOCTOU                    | 校验与读取都在已打开的 fd 上；路径替换不影响判定          | 见 4.4 用例               |

`ELOOP`/`EMLINK` 被映射为 `symlink`，`ENOENT` 映射为 `missing`，其余为 `unreadable`（`safe-file.ts:158-166`）——三者都会被 guard 校验转成"拒绝"。

### 4.2 Guard 身份验证

`apps/runner/src/process-supervisor-guard.ts`：

- 结构校验 `isProcessGuardRecord()`（`:84-116`）：`version===1`、`executionId`/`launchToken`/`supervisorStartTime`/`createdAt`/`updatedAt` 非空字符串、`parentPid`/`supervisorPid` 正安全整数、`processGroupId`/`cliPid` 为 null 或正安全整数、`state`/`isolation` 属于已知枚举、`exitCode`/`signal`/`detail` 类型正确。
- **身份绑定** `matchesStartingGuard()`（`:119-140`）逐字段比对 `executionId`、`launchToken`、`parentPid`、`supervisorPid`、`supervisorStartTime`、`processGroupId`、`cgroupPath`、`isolation`、`jobCreated`、`createdAt`，并强制 `state==='starting'`、`cliPid===null`、`cliStartTime===null`、`treeConfirmedGone===false`、`exitCode/signal/detail===null`。

即：验证的是"**当前这次 launch 的 guard**"，不是"格式正确的某个 guard"。C6 担心的"仅校验格式"已被排除。

### 4.3 Spawn 前置门禁（真实执行路径）

`apps/runner/src/process-supervisor-child.ts` 的 `main()`：

```text
115  assertGuardPathAvailable(config.guardPath);        // 预存路径一律拒绝
116  if (!updateGuard({ state: 'starting' })) throw;     // 独占临时文件 + fsync + rename，返回成败
119  const validated = readValidatedStartingGuard(...);  // 身份 + 内容校验
120  if (!validated.ok) throw;
125  isParentAlive(...) 复核，父进程已死则 terminated 退出
138  child = spawn(config.command, config.args, {...})  // 唯一 spawn 点
```

- 全文件 `spawn(` 只出现 **1 次**（第 138 行），不存在第二条创建 CLI 的路径。
- `assertGuardPathAvailable()`（`process-supervisor-guard.ts:71-92`）对目录/符号链接/FIFO/socket/普通文件/其他特殊文件**一律抛错**，且发生在写入与 spawn 之前。
- `updateGuard()` 由 `void` 改为 `boolean`，使用 `openSync(tmp,'wx',0o600)` + `writeFileSync(fd)` + `fsyncSync` + `renameSync`，失败时关闭 fd、删除临时文件并返回 `false`（`process-supervisor-child.ts:491-521`）。
- running guard 写入失败 → `terminateTree('guard-write-failed', ...)` 并 return，不留下"CLI 在跑但无持久证据"的状态（`:179-190`）。

故障路径核查（代码推演）：

| 场景                        | 结果                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| guard 初始化失败            | 抛错 → `main().catch` → exit 70；`child===null`，guard 记 `failed`/`treeConfirmedGone:true`                                                 |
| guard 路径被预存为目录      | `assertGuardPathAvailable` 抛错 → 不写 guard、不 spawn；`catch` 内的 `updateGuard` 因 rename 到目录而失败（返回 false，被忽略）→ 仍不 spawn |
| guard 文件被替换            | `readValidatedStartingGuard` 读到替换后的内容 → 身份不匹配 → 抛错 → 不 spawn                                                                |
| guard 读取失败              | 返回 `{ok:false}` → 抛错 → 不 spawn                                                                                                         |
| stale guard（同路径旧文件） | `assertGuardPathAvailable` 拒绝 → 不 spawn                                                                                                  |
| parent 退出                 | guard 写后、spawn 前有一次 `isParentAlive` 复核，直接 `terminated` 退出                                                                     |
| supervisor 异常退出         | 父进程侧 `ready` 以 `PROCESS_SUPERVISOR_EXITED/FAILED` 拒绝（S1/S2/S3/S4）                                                                  |

### 4.4 必须复跑项 IR7 的处置

- **单元级（双平台）**：guard 路径为**目录**、空文件、坏 JSON、结构非法 JSON、`executionId`/`launchToken`/`supervisorPid`/`state` 不匹配、验证期间路径替换、预存普通文件/目录——**全部通过**（`posix-supervisor-guard-hardening.spec.ts`，Linux **19/19 passed**；Windows **11 passed / 8 skipped**，跳过项为符号链接/FIFO 语义与全部 IR7 真实 supervisor 用例）。
- **真实 POSIX supervisor + 真实 CLI 的 IR7 四场景（目录/符号链接/FIFO/空文件）**：在 Linux 上真实执行并通过——仓库内该文件 **19/19**，四个 IR7 用例与"正常启动不受影响"对照全部 `✓`（每例 433–741 ms，非空转）。
- **本报告自写的独立 IR7 探针**（`c7-ir7-probe.spec.ts`，不使用仓库 helper，直接调用 `spawnSupervisedProcess` + `fixtures/real-cli.cjs`）：Linux **5/5 passed**。判据是 CLI 自身产生的**副作用**而非返回值：

```text
expect(existsSync(cliOut)).toBe(false);                       // CLI 从未写出产物
expect(await readdir(join(root, 'artifacts'))).toEqual([]);   // 产物目录为空
expect(liveProcessesMatching(marker)).toEqual([]);            // ps -eo args 无残留进程
control: 正常启动确实写出 marker → expect(existsSync(cliOut)).toBe(true)
```

- 对照项的意义：若探针本身失效（例如 supervisor 根本没启动），"产物不存在"会假性通过；因此同一文件内的正向对照证明该探针**有能力观测到 CLI 启动**，四例的"未创建"才是有效否定证据。
- **结论**：IR7 由 BLOCKED 改判为 **CLOSED**，且证据独立于实施方测试。

---

## 5. P2-2A：Resolution Sidecar 原子性与完整性

### 5.1 原子发布（逐项）

`apps/runner/src/recovery-evidence.ts`：

| 要求                       | 实现                                                                                                   | 判定                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| 临时文件与目标同一文件系统 | 临时文件为 `${targetPath}.<pid>.<uuid>.tmp`，与目标同目录                                              | ✅                   |
| 临时文件独占创建           | `open(path,'wx',0o600)`（`defaultEvidenceIo.writeTempFile`，`:74-81`）                                 | ✅                   |
| 临时文件名冲突             | 含 `process.pid` + `randomUUID()`                                                                      | ✅                   |
| 已有目标文件的处理         | `link(temp,target)` 在目标存在时返回 `EEXIST`，**绝不覆盖**；文件系统不支持硬链接则失败而非回退 rename | ✅                   |
| 真正不可覆盖的原子发布     | 同目录硬链接（`:88`），非 `rename`                                                                     | ✅                   |
| 并发 resolve               | 只有一个 `link` 成功；另一个 `EEXIST` → 失败                                                           | ✅（探针验证）       |
| 目标已存在但内容不一致     | 读取侧重新校验摘要，不一致即 invalid                                                                   | ✅                   |
| 崩溃于发布前               | 只有 `.tmp`，目标不存在 → blocked（探针"interrupted publish"）                                         | ✅                   |
| 崩溃于发布后               | 目标完整（数据已 fsync 后 link）                                                                       | ✅                   |
| 孤儿临时文件               | 失败路径 `rm(temporary)`；进程崩溃会遗留 `.tmp`                                                        | ⚠️ 惰性无害，见 C7-5 |
| 覆盖已有审计证据           | `writeResolutionSidecar` 在既有 sidecar 有效或无效时**都拒绝写入**（`:129-140`）                       | ✅                   |

### 5.2 文件与目录同步

- 文件 fsync：`handle.sync()` 在关闭前对已写入的 fd 执行（`:78`）；失败会抛出并使 resolve 失败。
- 目录同步：`syncDirectory()`（`:94-110`）在 `win32` 直接 `return`；其他平台 `open(dir)` + `handle.sync()`，仅把 `EINVAL/ENOTSUP/EISDIR/EBADF/EPERM` 视为"该文件系统不支持"而放行。
- 目录同步失败（非忽略码）→ `publishAtomic` 删除已发布目标并抛出（`:317-330`），使 resolve 失败并保持 blocked。探针"a failing directory sync leaves no sidecar and no temp file"验证：目标不存在、无 `.tmp` 残留、scan 仍 blocked。

### 5.3 Sidecar 完整性验证

`readResolutionSidecar()`（`:154-207`）+ `isResolutionRecord()`（`:376-398`）+ `resolutionMismatch()`（`:401-415`）：

- 只接受普通文件（经 `readRegularFileSnapshot`，拒绝符号链接/目录/FIFO）；
- JSON 可解析；
- `version===2`、`kind==='corrupt-journal-resolution'`；
- `executionId` 为 null 或非空字符串；
- `targetName` 与目标 basename 一致；
- `targetSize`/`targetSha256` 与**重新读取的目标内容**一致（摘要格式 `/^[a-f0-9]{64}$/`）；
- `resolution==='operator-confirmed-process-gone'`；
- `note` 非空；`resolvedAt` 可解析；
- 与 provenance 的 `executionId` 交叉一致（`readValidCorruptResolution`，`:260-287`）。

`resolutionExists()` 已被删除（`recovery.ts` 旧 `:1008-1015`），scan 改用 `readValidCorruptResolution()`（`recovery.ts:917`），guard sidecar 也改用 `readResolutionSidecar()`（`:950`）。**"存在即放行"路径已彻底移除**。

### 5.4 Windows 持久性边界（本报告认为必须明确回答的问题）

实施报告称"Windows 不支持目录 fsync，故 no-op"。本报告不接受"平台限制"作为结论，做如下判定：

1. **进程崩溃（crash）**：安全。数据先 `fsync` 再 `link`，写入侧不存在半写目标；崩溃只可能留下 `.tmp` 或完全缺失目标，二者都是 blocked。
2. **系统断电（power loss）**：NTFS 上目录项（硬链接名）不保证已落盘，因此**可能丢失 sidecar 文件名**。丢失后的行为是 `readValidCorruptResolution → invalid` → **scan 保持 blocked**，需要操作员重新 resolve。
3. **不会出现的失败方向**：**不存在"目标名存在但内容半写"**——因为 inode 数据在 link 之前已 `fsync`；硬链接不会暴露部分内容。因此断电**不会**产生 `invalid sidecar → clean=true`。
4. 结论：Windows 上本机制保证的是**原子性 + 内容持久性**，**不保证目录项跨断电持久**。即"可能多做一次人工 resolve"，不是"错误放行"。
5. 因此**必须明确降低 Windows 的持久性保证级别**（Linux = 目录项持久；Windows = 进程崩溃持久、断电后可能需重新确认）。
6. **文档现状核查（不只做假设）**：`docs/execution-recovery.md` 全文检索 `resolve` / `sidecar` / `provenance` / `recovery-admin` **零命中**；`recovery-admin` 与 `resolve-corrupt` 仅出现在 engineering 报告里，任何用户文档都没有它们。也就是说：**当前不存在"承诺跨断电持久"的文档，因而没有虚伪承诺；但也因此没有任何地方告诉运维"Windows 断电后可能需要重新确认"**。故本项记为 **C7-1（P2，文档级）**：需补写 sidecar / resolve 流程与平台持久性边界，而不是修改代码。

安全方向已验证为 fail-closed（最坏结果是"多做一次人工 resolve"，不是"错误放行"），故本项不阻塞 Slice 0.2.1 的安全性结论，但**必须**在文档中写明边界。

---

## 6. P2-2B：Corrupt Journal Provenance

### 6.1 产生路径

唯一写入点是 `ExecutionJournal.recordCorruption()`（`execution-journal.ts:413-447`）：`quarantine()` 成功 rename 后才调用 `writeCorruptProvenance()`；失败只记录 `provenanceError`，不删除隔离文件。

`writeCorruptProvenance()`（`recovery-evidence.ts:293-330`）记录：`version:1`、`kind:'corrupt-journal-quarantine'`、`recoveryRoot`（`resolve()` 规范化）、`originalName`（去掉 `.corrupt-<digits>`）、`quarantinedName`、`executionId`（best-effort）、`isolatedAt`、`sha256`、`size`。

### 6.2 字段是否真正参与验证

`provenanceMismatch()`（`:418-450`）逐项比对：

| 字段              | 是否参与验证                                                              | 失败后果 |
| ----------------- | ------------------------------------------------------------------------- | -------- |
| `recoveryRoot`    | ✅ 与 `resolve(recoveryRoot)` 严格相等                                    | invalid  |
| `quarantinedName` | ✅ 与当前 basename 相等                                                   | invalid  |
| `originalName`    | ✅ 与去后缀结果相等                                                       | invalid  |
| `sha256`          | ✅ 与重新读取的文件内容比对                                               | invalid  |
| `size`            | ✅ 与重新读取的字节数比对                                                 | invalid  |
| `version`/`kind`  | ✅ Schema 硬校验                                                          | invalid  |
| `isolatedAt`      | ✅ 必须是可解析时间（仅格式，不与 mtime 交叉）                            | invalid  |
| `executionId`     | ⚠️ 仅与 sidecar 交叉一致；journal 不可解析时两侧均为 null，绑定退化为恒真 | 见 C7-2  |

另外，目标文件名本身必须匹配 `\.corrupt-\d+$`（`provenanceMismatch` 前置判断），因此 `.provenance.json` 不会被当成 journal。

### 6.3 故障路径

| 场景                                              | 行为                                                                               | 判定                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| provenance 写入失败                               | 隔离文件保留，`provenanceError` 记录；resolve 返回 `no valid isolation provenance` | fail-closed ✅                 |
| quarantine 已 rename、provenance 尚未产生（崩溃） | 同上，但**永久不可 resolve**                                                       | fail-closed ✅ / 运维缺口 C7-3 |
| provenance 内容不完整                             | Schema 或字段比对失败                                                              | ✅                             |
| corrupt 文件被修改                                | 摘要/大小不匹配                                                                    | ✅（探针验证）                 |
| provenance 被修改（摘要）                         | 不匹配                                                                             | ✅（探针验证）                 |
| 跨 recovery root 复制                             | `recoveryRoot` 不匹配                                                              | ✅（仓库测试 + 逻辑推演）      |
| 跨文件名复制                                      | `quarantinedName`/`originalName` 不匹配                                            | ✅（探针验证）                 |
| 只有 sidecar、没有 provenance                     | `readValidCorruptResolution` 先读 provenance，直接失败                             | ✅（探针验证）                 |

### 6.4 信任边界（本报告的核心判断）

任务要求"不得只因为 provenance 文件存在就认定来源可信"。本报告做了两项独立判断：

1. **它证明了什么**：provenance 把"隔离文件当前的字节"与"隔离元数据（root、原文件名、隔离文件名、时间、executionId）"绑定，因此可以拒绝：任意改名的普通文件、内容被改写的隔离文件、跨 root/跨名字复制的证据、只有 sidecar 的伪造。
2. **它没有证明什么**：provenance 与 corrupt 文件都是 **同权限的普通 JSON**，没有 HMAC/签名/独立密钥。我用独立探针实测：**只要同时伪造 corrupt 文件与匹配的 provenance（kinds/root/name/size/sha256 全部自洽），`resolveCorruptJournal` 会返回 `resolved: true`，scan 变 clean**（探针 `c7-trust-boundary-probe.spec.ts`，1 passed）。

因此 provenance 的真实性**由文件系统权限而非密码学保证**：隔离文件与证据文件为 `0600`（`defaultAtomicWrite` 与 `writeTempFile`），recovery root 由 `mkdir(recursive)` 以默认 umask 创建（通常 `0755`）。可写者 = runner 所属用户（或 root/管理员）。

**判定**：这与 C6 自己声明的"本地同用户威胁模型"（C6 §4.4.3 与 §N-3 均把"拥有 recovery root 写权限的本地攻击者"明确定性为 P3）一致，故 **P2-2B 在声明的威胁模型内关闭**；但实施报告 E.2/G.2.5 之外应更明确地写成"**内容绑定 + 权限边界**"，而不是让读者以为 provenance 具备来源真实性证明。记为 C7-2（P3）。

该伪造探针在 Linux 上同样通过（属于 35/35 的一部分），说明"内容绑定而非密码学"是**跨平台一致的机制属性**，不是某个文件系统的副作用。

---

## 7. P2-2C：Journal PID 与身份 Schema

### 7.1 单字段校验

`isValidRecord()`（`execution-journal.ts:521-563`）：

| 字段                                   | 规则                                            | 允许 null | 允许字符串数字 | 安全整数 |
| -------------------------------------- | ----------------------------------------------- | --------- | -------------- | -------- |
| `pid`                                  | **必填**，null 或正安全整数（`pidOrNull`）      | ✅        | ❌             | ✅       |
| `processStartTime`                     | **必填**，null 或非空字符串                     | ✅        | —              | —        |
| `processGroupId`                       | **必填**，null 或正安全整数                     | ✅        | ❌             | ✅       |
| `supervisorPid` / `cliPid`             | 可缺省/null，或正安全整数                       | ✅        | ❌             | ✅       |
| `supervisorStartTime` / `cliStartTime` | 可缺省/null，或非空字符串                       | ✅        | —              | —        |
| `processKind`                          | null/缺省/`supervisor`/`direct`                 | ✅        | ❌（枚举）     | —        |
| `spawnState`                           | null/缺省/`intent`/`supervisor-ready`/`running` | ✅        | ❌（枚举）     | —        |
| `lastSequence`                         | 安全整数且 ≥ 0                                  | ❌        | ❌             | ✅       |
| `updatedAt`                            | 非空字符串                                      | ❌        | —              | —        |
| `finishedAt`                           | null 或非空字符串                               | ✅        | —              | —        |

`0`、负数、小数、`Number.MAX_SAFE_INTEGER+2`、布尔、数字字符串、缺失，全部被拒。

### 7.2 跨字段关系

`validPidRelationships()`（`:565-614`）：

- `cliPid` 不得等于 `pid`（两侧非 null 时）；
- `spawnState==='supervisor-ready'` ⇒ `processKind==='supervisor'`、`pid`/`supervisorPid` 为正整数且**相等**、`supervisorStartTime` 非空；
- `spawnState==='running'` ⇒ `pid` 为正整数；
- `processKind==='direct'` ⇒ 无 `supervisorPid`、无 `cliPid`、无 `cliStartTime`、不得声明 `supervisor-ready`；
- `processKind==='supervisor'` ⇒ `supervisorPid` 与 `pid` 一致；处于 `supervisor-ready`/`running` 时二者必填且相等、`supervisorStartTime` 非空。

这些约束与真实 writer 完全一致（`real-executor.ts:1320-1425`）：supervised 分支写 `pid=guard.supervisorPid`、`supervisorPid=guard.supervisorPid`、`spawnState='supervisor-ready'`；direct 分支只写 `pid`/`processStartTime`/`processGroupId`/`processKind:'direct'`，不写 `cliPid`。**未发现会误杀合法记录的规则**。

### 7.3 历史兼容

- `execution-journal.ts` 历史上只被一个提交引入（`553eb9a`），该版本与 `324b6d7` 的 `begin()` 都已写入 `pid`/`processStartTime`/`processGroupId`/`updatedAt`/`finishedAt`，因此"必填"不会误隔离历史记录。
- 较新的可选字段（`launchToken`/`guardPath`/`supervisorPid`/`supervisorStartTime`/`cliPid`/`cliStartTime`/`processKind`/`spawnState`）缺省仍被接受：探针"a legal historical record without newer identity fields is still finalized"通过，记录被正常 finalize 为 `interrupted`。
- 非法值**不会**被折算成 null/默认值：`pidOrNull` 对字符串/布尔/0 一律 false，直接进入 quarantine。
- 合法 `pid:null` 的 active 记录**不会**被隔离，仍按原语义 block（`PID_NOT_RECORDED`）——探针与 R01 均验证。

---

## 8. IR4 / IR4b / IR5 / IR7 / IR8 独立复现

探针文件（我自写，不使用仓库测试 helper，只调用已提交的公开导出）：`test/c7-independent-probe.spec.ts`，**34 passed / 0 failed**；另有 `test/c7-trust-boundary-probe.spec.ts`，1 passed。**两者在 Windows 与 Linux 上均为 35/35 通过**，断言与预期完全一致。

> 交叉校验：Windows 全量复跑在我加入这两个探针文件后为 `26 files / 294 passed / 12 skipped`，减去探针的 2 文件 / 35 用例，恰为仓库自身的 `24 files / 259 passed / 12 skipped`——说明探针未掩盖也未替换任何仓库用例。

| 探针         | 复现场景                                                                                                                                                                               | 修复前（C6 证据）                        | 本次结果（双平台一致）                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| **IR4**      | 零字节 sidecar                                                                                                                                                                         | `clean=true`                             | **`clean=false`**，存在 `corrupt-journal` blocked 条目，隔离文件保留                         |
| **IR4b**     | 截断 sidecar `{"version":2,"kind":`                                                                                                                                                    | `clean=true, blocked=0`                  | **`clean=false`**，隔离文件保留                                                              |
| IR4c（新增） | JSON 合法但 schema 缺 `note`                                                                                                                                                           | —                                        | `clean=false`                                                                                |
| **IR5**      | 任意 `plain-note.corrupt-999`                                                                                                                                                          | `resolved=true`                          | **`resolved=false`**，reason 含 `no valid isolation provenance`，无 sidecar，scan blocked    |
| IR5b（新增） | 有效 sidecar 但无 provenance                                                                                                                                                           | —                                        | `resolved=false`                                                                             |
| IR5c（新增） | provenance 复制到同 root 另一隔离名                                                                                                                                                    | —                                        | `resolved=false`                                                                             |
| IR5d（新增） | provenance 摘要被改                                                                                                                                                                    | —                                        | `resolved=false`                                                                             |
| IR5e（新增） | 隔离后内容被改                                                                                                                                                                         | —                                        | `resolved=false`                                                                             |
| **IR8**      | `pid:"not-a-number"`                                                                                                                                                                   | `clean=true` + finalize 为 `interrupted` | **quarantine**；`scan.executions=[]`；隔离内容 `status:"active"`，未 finalize                |
| IR8 扩展     | 字符串/0/负/小数/超安全整数/布尔/缺失 PID、非法 `processStartTime`/`processGroupId`/`processKind`/`spawnState`、`supervisor-ready` 不匹配、direct 携带 supervisor 身份、`cliPid===pid` | —                                        | **15/15 全部 quarantine，0 个进入终态**                                                      |
| **IR7**      | 真实 POSIX supervisor + CLI                                                                                                                                                            | CLI 被启动                               | **CLOSED（Linux 真实执行）**：仓库内 19/19；独立探针 5/5，CLI 产物与进程均不存在，含正向对照 |

补充负向复现（全部为 fail-closed）：并发 resolve（恰好 1 个成功）、硬链接拒绝覆盖、目录 fsync 失败、发布中断、sidecar 跨目标复制、遗留 `.tmp` 不影响判定、provenance 写入失败后不可 resolve。

---

## 9. 测试独立复跑结果

### 9.1 环境

| 项目     | Windows                                                   | Linux（WSL2）                                                                |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OS       | 10.0.26200.9711                                           | Ubuntu 24.04.5 LTS，kernel `6.18.33.2-microsoft-standard-WSL2`，WSL 2.7.14.0 |
| Node     | **v22.22.2**（实施报告记录为 v24.14.0，版本不同）         | **v22.14.0**（亦非 v24）                                                     |
| pnpm     | 11.5.2                                                    | 11.5.2                                                                       |
| 代码状态 | `41ef234f` 的 `git archive` 精确副本，`--frozen-lockfile` | **同一归档**，另建 `/root/haft-c7`（ext4），`--frozen-lockfile`              |
| cgroup   | 不适用（Job Object）                                      | cgroup v2，隔离模式实测 `linux-cgroup`（见 9.3）                             |

> 说明：两侧 Node 主版本均为 22，与实施报告作者的 v24 不同。本轮因此是"在 Node 22 上的独立复跑"，不是对作者环境的逐位重放；但两平台之间用的是**同一个 Node 主版本**，跨平台对比不受版本差异干扰。

### 9.2 Windows

| 命令                                                     | 结果                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm --filter @raft-lite/runner test -- --reporter=dot` | **24 个测试文件；259 passed / 12 skipped / 0 failed（271 total）**，48.08s |
| `pnpm --filter @raft-lite/runner typecheck`              | 通过                                                                       |
| `pnpm --filter @raft-lite/runner build`                  | 通过（tsup，3 个入口：main / process-supervisor-child / recovery-admin）   |
| `pnpm lint`                                              | 通过（`eslint . --max-warnings=0`）                                        |
| `prettier --check`（本轮 12 个变更/新增文件）            | **全部通过**                                                               |
| `pnpm format:check`                                      | **失败**，仅 `apps/runner/src/recovery-admin.ts`                           |
| F1–F9                                                    | 9 passed                                                                   |
| S1–S8                                                    | 6 passed / 2 skipped（S6、S8 POSIX-only）                                  |
| R13–R19                                                  | 7 passed / 1 skipped（R18 POSIX-only）                                     |
| 独立探针                                                 | 35 passed（34 + 信任边界 1），位于 2 个额外文件                            |

与实施报告 F.2 的 Windows 数字（259/12/271）**完全一致**。加入探针后复跑为 `26 files / 294 passed / 12 skipped`，两者相减正好回到 259，前后自洽。

### 9.3 Linux（WSL2）

| 命令                                                     | 结果                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @raft-lite/runner test -- --reporter=dot` | **24 个测试文件；269 passed / 2 skipped / 0 failed（271 total）**，4.58 s                                      |
| `pnpm --filter @raft-lite/runner typecheck`              | 通过                                                                                                           |
| `pnpm --filter @raft-lite/runner build`                  | 通过（tsup，同 3 个入口：`main` 270.57 KB / `process-supervisor-child` 22.88 KB / `recovery-admin` 110.08 KB） |
| `pnpm lint`                                              | 通过（`eslint . --max-warnings=0`）                                                                            |
| `prettier --check`（本轮 12 个变更/新增文件）            | **全部通过**（`All matched files use Prettier code style!`）                                                   |
| `pnpm format:check`                                      | **失败**，仅 `apps/runner/src/recovery-admin.ts`（与 Windows 同一文件）                                        |
| `posix-supervisor-guard-hardening.spec.ts`               | **19/19 passed**（含四个 IR7 + 正常启动对照，无跳过）                                                          |
| `recovery-hardening-os.spec.ts`                          | 13 passed / 1 skipped（R04b Windows-only）                                                                     |
| `recovery-resolution.spec.ts`                            | **8/8 passed**（R18 在 Linux 上真实执行；Windows 为 7 passed / 1 skipped）                                     |
| 独立探针                                                 | 35 passed（IR4/IR4b/IR5/IR8 + sidecar/provenance）+ **IR7 5 passed**                                           |

与实施报告 F.2 声称的 Linux 数字（269/2/271）**完全一致**；本次为该数字提供了独立复跑，不再是"未验证"。

**Linux 上的 2 个 skipped（逐项，非"通过"）**：

| #   | 用例                                                                               | 原因                                     |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `S7: Windows starting-guard failure blocks SpawnCli and cleanup stays unconfirmed` | Windows-only（`taskkill` / Job Object）  |
| 2   | `R04b: a failed taskkill is reported as unconfirmed and the target stays alive`    | Windows-only（依赖 `taskkill` 失败语义） |

合计 269 + 2 = 271，与 Windows 侧 259 + 12 = 271 **用例总数相同**，说明两平台跑的是同一套用例，只是平台专属项互换跳过。

**cgroup 分支是否真的被覆盖（本报告单独取证）**：R03 中的 cgroup 断言写在 `if (process.platform === 'linux' && tree.guard.isolation === 'linux-cgroup')` 内，条件不成立时会静默跳过。为排除"看似通过实则未进入分支"，我用独立探针（`c7-isolation-probe.spec.ts`）走同一 `spawnSupervisedProcess` 路径打印实际选择：

```text
C7_ISOLATION_PROBE {"isolation":"linux-cgroup",
                    "cgroupPath":"/sys/fs/cgroup/haft-runner/token_1794809568426",
                    "cliPid":105644,"supervisorPid":105632,"processGroupId":105632}
C7_CGROUP_PIDS      {"pids":[105632,105644],"cliPid":105644}
```

即本机确实选择 `linux-cgroup`，`cgroup.procs` 同时包含 supervisor 与 CLI，R03 的 cgroup 断言**被实际执行**而非跳过。终止后 `/sys/fs/cgroup/haft-runner/` 只剩 55 个控制文件、**无子目录残留**，未观察到 cgroup 泄漏。

### 9.4 格式门禁归因

`format:check` 输出：`49 unformatted file(s); 76 are grandfathered legacy debt`，唯一未祖父化文件为 `apps/runner/src/recovery-admin.ts`。独立核实：

- `git diff 663cc28d 41ef234f -- apps/runner/src/recovery-admin.ts` 为空；
- 该文件 blob 在 `324b6d7`/`663cc28d`/`5357818`/`41ef234f` 四个提交上**完全相同**（`9932dc46…`）；
- `scripts/acceptance/format-baseline.json` blob 在 `663cc28d`/`41ef234f` 相同（`b610f266…`）。

结论：**该格式失败在 C6 基线上已存在，与本轮无关**，未发现"用格式债掩盖新问题"。本轮 12 个代码文件全部 Prettier-clean。

Linux 侧输出与 Windows **逐字相同**（`49 unformatted file(s); 76 are grandfathered legacy debt`，唯一未祖父化文件同为 `apps/runner/src/recovery-admin.ts`），失败集合不随平台变化，进一步排除"本机格式配置差异"这一解释。

---

## 10. skipped / BLOCKED 清单

### 10.1 Windows 12 个 skipped（逐项）

| #   | 用例                                                                    | 原因                            |
| --- | ----------------------------------------------------------------------- | ------------------------------- |
| 1   | `S6: a rejected ready never makes terminate or verifyTreeGone throw...` | POSIX-only（既有）              |
| 2   | `S8: cleanup of a supervisor stuck before its guard is bounded...`      | POSIX-only（既有）              |
| 3   | `R18: resolve refuses a non-empty protected process group...`           | POSIX-only（既有）              |
| 4   | N-1 unit: `rejects a symbolic link`                                     | 需要 POSIX symlink 语义（新增） |
| 5   | N-1 unit: `rejects a FIFO without blocking`                             | 需要 `mkfifo`（新增）           |
| 6   | N-1 unit: `refuses pre-existing symbolic-link and FIFO guard paths`     | 同上（新增）                    |
| 7   | IR7: `directory at the guard path blocks the CLI spawn`                 | POSIX supervisor（新增）        |
| 8   | IR7: `symbolic link at the guard path blocks the CLI spawn`             | 同上（新增）                    |
| 9   | IR7: `FIFO at the guard path blocks the CLI spawn`                      | 同上（新增）                    |
| 10  | IR7: `empty file at the guard path blocks the CLI spawn`                | 同上（新增）                    |
| 11  | IR7: `leaves a normal POSIX launch unaffected`                          | 同上（新增）                    |
| 12  | P2-2A: `rejects a sidecar that is a symbolic link`                      | POSIX symlink（新增）           |

合计：**9 个新增 POSIX 专属 + 3 个既有平台专属 = 12**，与实施报告 F.3 完全对应。**不把 skipped 计为 passed。**

### 10.2 BLOCKED

解除 WSL 限制后，原先整块 BLOCKED 的 Linux 矩阵已全部取得真实证据。**剩余 BLOCKED 仅两项，且都不是本轮修复引入的**：

| 项目                 | 原因                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| macOS 全部           | 无真实 OS 证据（沿用既有 BLOCKED），本轮未获得 macOS 环境                                                                        |
| POSIX group fallback | 本机 cgroup v2 可用，实测隔离模式为 `linux-cgroup`；`posix-group` 回退分支**未被任何平台执行**，因此其行为只能靠代码阅读，不外推 |

> `posix-group` 回退分支属于既有设计（非本轮新增），其未覆盖状态与本轮四项发现无关；但"未覆盖"就是未覆盖，本报告不将其计入通过。

---

## 11. 复审矩阵与新发现问题

### 11.1 复审矩阵

| 编号    | 问题                                                                                         | 独立复审结论                                                        | 证据                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-1     | POSIX starting guard / spawn 门禁                                                            | **CLOSED**（代码 + Windows 单元 + Linux 真实 POSIX spawn）          | `process-supervisor-child.ts:115-138`（唯一 spawn 点）；`process-supervisor-guard.ts:29,71`；`safe-file.ts:86-153`；19 用例双平台通过；IR7 探针 5/5 |
| P2-2A   | Sidecar 原子性与完整性                                                                       | **CLOSED**（双平台）；Windows 断电持久性边界见 C7-1                 | `recovery-evidence.ts:74-110,120-207,293-330,317-330`；IR4/IR4b + 8 项 sidecar 探针                                                                 |
| P2-2B   | Corrupt provenance                                                                           | **CLOSED（同用户威胁模型内）**；真实性为内容绑定而非密码学，见 C7-2 | `execution-journal.ts:413-447`；`recovery-evidence.ts:293-330,418-450`；IR5 + 4 项伪造/篡改探针                                                     |
| P2-2C   | Journal PID / 身份 Schema                                                                    | **CLOSED**                                                          | `execution-journal.ts:521-614`；IR8 + 15 类非法身份 + 历史兼容探针                                                                                  |
| P1-1    | 回归保护（finalize single-flight）                                                           | 保持 **CLOSED**                                                     | F1–F9 双平台通过                                                                                                                                    |
| P2-1    | 回归保护（Windows guard）                                                                    | 保持 **CLOSED**                                                     | S1–S5、S7（真实 Windows supervisor）通过；`.cs` 无 diff                                                                                             |
| P2-3    | 回归保护（人工 resolve 全树）                                                                | 保持 **CLOSED**                                                     | R13–R17、R19 双平台通过；R18 在 Linux 通过                                                                                                          |
| P2-4    | Managed fallback                                                                             | **DEFERRED（未关闭）**                                              | 代码无相关变更；报告未宣称关闭                                                                                                                      |
| N-2…N-6 | 既有 P3                                                                                      | **仍开放（本轮未处理）**                                            | N-6：`recovery-resolution.spec.ts:66` 仍为 `isolation:'windows-job'`，双平台同一 fixture                                                            |
| C7-1    | Windows 目录项持久性边界未文档化；且用户文档完全没有 sidecar/`resolve-corrupt` 的描述        | **P2（文档级，方向 fail-closed）**                                  | `recovery-evidence.ts:94-96`；`docs/execution-recovery.md` 全文无 `resolve`/`sidecar` 命中；断电推演 + fail-closed 证明                             |
| C7-2    | provenance 非密码学真实性；`executionId` 绑定在 null/null 时退化                             | **P3**                                                              | 伪造探针 1 passed；`execution-journal.ts:616-624`                                                                                                   |
| C7-3    | quarantine 后 provenance 写入失败/崩溃 → 永久不可 resolve，`recovery-admin` 无补写或清理命令 | **P3**                                                              | `execution-journal.ts:420-435`；`recovery-admin.ts` 命令集仅 status/list/resolve/resolve-corrupt                                                    |
| C7-4    | 发布后校验失败会留下"无效 sidecar"，后续 resolve 永久被拒                                    | **P3**                                                              | `recovery-evidence.ts:101-113` + `recovery.ts:320-333`                                                                                              |
| C7-5    | 崩溃遗留 `.tmp` 无 GC（惰性无害）                                                            | **P3**                                                              | 探针"leftover sidecar temp file does not make recovery clean"                                                                                       |
| C7-6    | 同一 corrupt 文件产生两条 blocked 条目（`CORRUPT_JOURNAL` + `UNRESOLVED_CORRUPT_JOURNAL`）   | **P3**                                                              | R08 运行日志                                                                                                                                        |
| C7-7    | `phase` 只校验 `typeof === 'string'`，允许空字符串                                           | **P3**                                                              | `execution-journal.ts:527`                                                                                                                          |

**未发现新的 P0/P1，未发现新的安全绕过路径。**

### 11.2 关键判断说明

- **"存在即放行"是否彻底消失**：是。`resolutionExists()` 已删除；两条 scan 路径（corrupt journal、guard sidecar）都改为内容校验。
- **"guard 格式正确"是否仍在冒充"身份正确"**：否。`matchesStartingGuard()` 逐字段比对本次 launch 身份。
- **"sidecar 原子性"是否只因出现 `link` 就成立**：硬链接保证"要么没有目标名、要么目标名指向完整 inode"，且 `EEXIST` 阻断覆盖；配合发布前 fsync，原子性与内容完整性成立。唯一不成立的是 Windows 的目录项断电持久性（C7-1），且方向为 fail-closed。
- **IR7 的"未创建 CLI"是否只是测试断言而非真实证据**：是真实证据。判据是 CLI fixture 自身写出的产物文件与 `ps -eo args` 的进程快照，且同文件内的正向对照证明该判据能观测到启动；四例的否定结论因此有效。
- **Linux 结果是否只是"把 Windows 结果换个平台重跑"**：不是。Linux 独有覆盖包括真实 POSIX supervisor（`linux-cgroup` 隔离、`mkfifo`、symlink 语义）、cgroup 成员核验、S6/S8/R18，这些在 Windows 上全部 skip。
- **P2-4 未被误判关闭**：确认仍 Deferred。

---

## 12. 最终结论

### **PASS WITH WARNINGS**

理由（严格按任务的 PASS 条件逐条）：

| PASS 条件                       | 状态                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| 1. N-1 完全关闭                 | ✅ 代码 + Windows 单元 + **Linux 真实 POSIX spawn（仓库 19/19、独立探针 5/5）**           |
| 2. P2-2A 完全关闭               | ✅ 双平台（IR4/IR4b + 原子发布/并发/故障注入探针）                                        |
| 3. P2-2B 完全关闭               | ✅ 双平台（声明威胁模型内）                                                               |
| 4. P2-2C 完全关闭               | ✅ 双平台（IR8 + 15 类非法身份 + 历史兼容）                                               |
| 5. 既有 CLOSED 保持             | ✅ P1-1、P2-1、P2-3 均无回归                                                              |
| 6. 无新增 P0/P1                 | ✅ 新增最高为 C7-1（P2，文档级，方向 fail-closed）                                        |
| 7. 双平台可执行范围有真实证据   | ✅ Windows 24 文件/259 passed/12 skipped；Linux 24 文件/269 passed/2 skipped，均 0 failed |
| 8. Windows 持久性限制已明确评估 | ✅ §5.4 完成；结论是"必须文档化降级"→ C7-1                                                |
| 9. 无新的安全绕过路径           | ✅ 未发现                                                                                 |

**为什么不是 PASS**：C7-1 是一项**仍未处理的 P2**。它不是代码缺陷（方向 fail-closed，最坏情况是多做一次人工确认），但"Windows 断电后可能丢失 resolve 结果、需要重新确认"这一运维可见的边界，当前在**任何用户文档中都不存在**——`docs/execution-recovery.md` 连 `resolve`/`sidecar` 都没写。按"未文档化的行为等于未定义行为"的标准，不能签无条件 PASS。

**为什么不是 FAIL**：四项 C6 发现在两个平台上都以真实执行证据关闭，没有发现任何可导致"误判进程已死""覆盖审计证据""伪造隔离来源""非法 PID 被 finalize"的路径。所有故障注入的失败方向都是 blocked / quarantine。

**为什么不是 BLOCKED**：上一版 BLOCKED 的唯一原因是 POSIX 证据缺失；该原因已消除（WSL 解除后取得 IR7 与 Linux 全量矩阵）。剩余 BLOCKED 仅 macOS 与 `posix-group` 回退分支，二者与本轮四项发现无关，且不影响 Slice 0.2.1 的安全性判定。

**Warnings（须在 Slice 1 前处理或显式接受）**：

| 编号 | 级别 | 内容                                                                       | 处置建议                                        |
| ---- | ---- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| C7-1 | P2   | Windows 目录项持久性未文档化；sidecar/resolve 流程无用户文档               | 补写 `docs/execution-recovery.md`，写明平台差异 |
| C7-2 | P3   | provenance 为内容绑定而非密码学真实性；null/null 时 `executionId` 绑定退化 | 文档措辞改为"内容绑定 + 权限边界"               |
| C7-3 | P3   | quarantine 后 provenance 写入失败 → 永久不可 resolve                       | 评估 `recovery-admin` 补写/清理命令             |
| C7-4 | P3   | 发布后校验失败留下永久阻塞的无效 sidecar                                   | 同上                                            |
| C7-5 | P3   | 崩溃遗留 `.tmp` 无 GC                                                      | 惰性无害，可排期                                |
| C7-6 | P3   | 同一 corrupt 文件产生两条 blocked 条目                                     | 去重或合并展示                                  |
| C7-7 | P3   | `phase` 仅校验 `typeof string`，允许空串                                   | 收紧为非空                                      |

---

## 13. Slice 1 准入建议

1. **Slice 0.2.1 是否通过**：**通过（PASS WITH WARNINGS）**。四项 C6 发现在双平台均以真实执行证据关闭，未发现回归；警告项为 C7-1（P2 文档级）与 C7-2…C7-7（P3）。
2. **Slice 1 是否满足准入条件**：**满足，附条件**。N-1 跨平台安全门禁已在 Linux 真实 supervisor 上闭环，不再构成阻塞；但下列条件应在 Slice 1 计划中绑定：
   - C7-1 必须在 Slice 1 交付前写入文档（否则 Windows 运维无法解释"为什么要再 resolve 一次"）；
   - P2-4（managed/supervised 15s fallback）仍 **Deferred**，必须作为 Slice 1 的显式工作项，不得默认已关闭。
3. **仍 BLOCKED 的平台与功能（仅两项）**：
   - **macOS 全部**：无真实 OS 证据，沿用既有 BLOCKED；
   - **POSIX `posix-group` 回退分支**：本机 cgroup v2 可用，该分支未被任何平台执行，仅能代码阅读。
   - 已解除：Linux 全量矩阵、IR7 四场景、cgroup 回归、R18/S6/S8、POSIX finalize single-flight。
4. **Slice 1 建议补齐的遗留测试**（按优先级）：
   - `posix-group` 回退分支的运行证据：在禁用/不可写 cgroup v2 的容器或内核下跑一次 R03 等价路径，覆盖 `isolation==='posix-group'`；
   - C7-3 的可恢复性：为"quarantine 成功但 provenance 写入失败"增加一条从 blocked 状态恢复的测试（当前只有"永久不可 resolve"的负向断言）；
   - C7-4：为"发布后校验失败留下无效 sidecar"增加一条"后续仍可人工修复"的用例，或明确接受永久阻塞并写入运维文档；
   - C7-5：`.tmp` 遗留的 GC 策略若实现，需配套"GC 不影响在途发布"的并发测试；
   - N-6：R19 目前未覆盖 cgroup 分支，建议补齐（与第 1 项同源）。
5. **不需要在 Slice 1 重做的部分**：N-1 门禁、P2-2A 原子发布、P2-2B provenance 绑定、P2-2C 身份 Schema——本轮已双平台验证，只要不修改 `safe-file.ts`/`process-supervisor-guard.ts`/`recovery-evidence.ts`/`execution-journal.ts` 的相应逻辑，无需重复取证。
6. **对实施报告的最终态度**：其实施结论（PASS WITH WARNINGS）在**结论层面**与本报告一致，但依据不同——本报告的每一项都来自独立复跑与自写探针，未采信其测试输出；其 F.2 的 Linux 数字（269/2/271）本轮已独立复现并确认无误。

---

## 附录 A：本次复审使用的命令与产物

```text
git status --short ; git rev-parse HEAD ; git log --oneline
git cat-file -t <4 个基线提交>
git merge-base --is-ancestor 41ef234f HEAD   → NO
git merge-base --is-ancestor HEAD 41ef234f   → YES（main 是祖先）
git diff --stat/--name-status 663cc28d 41ef234f
git diff -w 663cc28d 41ef234f -- apps/runner/test/recovery-hardening-os.spec.ts
（去空白字符级序列比对，确认唯一语义变更为 R03 fixture 字段）
git archive 41ef234f | tar -x -C %TEMP%\haft-review-41ef234
CI=true pnpm install --frozen-lockfile
pnpm --filter @raft-lite/contracts build
pnpm --filter @raft-lite/runner test -- --reporter=dot
pnpm --filter @raft-lite/runner exec vitest run --reporter=verbose（提取 skipped 清单）
pnpm --filter @raft-lite/runner typecheck / build
pnpm lint ; pnpm exec prettier --check <12 files> ; pnpm format:check
npx vitest run test/c7-independent-probe.spec.ts        → 34 passed
npx vitest run test/c7-trust-boundary-probe.spec.ts     → 1 passed
```

Linux（WSL2）——**全部经 `wsl -d Ubuntu-24.04 -- bash -c '…'` 执行**：

```text
wsl -v ; uname -r ; node -v ; pnpm -v
  → 2.7.14.0 / 6.18.33.2-microsoft-standard-WSL2 / v22.14.0 / 11.5.2
tar -xf /mnt/c/Users/A11720/AppData/Local/Temp/haft-41ef234.tar -C /root/haft-c7
  （与 Windows 同一个 git archive，非二次导出）
CI=true pnpm install --frozen-lockfile                  → 6.9 s
pnpm --filter @raft-lite/contracts build
pnpm --filter @raft-lite/runner test -- --reporter=dot  → 24 files / 269 passed / 2 skipped
pnpm --filter @raft-lite/runner exec vitest run --reporter=verbose | grep ↓
  → S7（Windows-only）、R04b（Windows-only）
pnpm --filter @raft-lite/runner typecheck               → 通过
pnpm --filter @raft-lite/runner build                   → 3 入口
pnpm lint                                               → 通过
npx prettier --check <12 files>                         → All matched files use Prettier code style!
pnpm format:check                                       → 仅 apps/runner/src/recovery-admin.ts
npx vitest run test/c7-independent-probe.spec.ts test/c7-trust-boundary-probe.spec.ts → 35 passed
npx vitest run test/c7-ir7-probe.spec.ts                → 5 passed（真实 POSIX supervisor）
npx vitest run test/c7-isolation-probe.spec.ts          → 1 passed（打印 isolation=linux-cgroup）
ls /sys/fs/cgroup/haft-runner/ | wc -l                  → 55（仅控制文件，无子目录残留）
```

> 可复现性注记：本机的 WorkBuddy 会把裸 `bash` 解析到 Windows PortableGit，故 `wsl --exec /bin/bash` 与 `bash -lc` 均失败（`execvpe(E:/workbuddy/.../PortableGit/usr/bin/bash) failed`）。必须使用 `wsl -d <distro> -- bash -c '<script>'` 的写法。

## 附录 B：只读与边界声明

- 未修改 `apps/runner`、`packages`、`scripts`、CI 配置或任何既有文档。
- 未检出/切换/重置分支，`main` 工作树在复审前后均为 clean（`git status --short` 前后均为空）。
- 除本报告外未 commit / push / rebase；未删除任何文件；未启动 Slice 1；未实施任何修复。
- 执行验证在两份仓库外副本进行：Windows `%TEMP%\haft-review-41ef234`、Linux `/root/haft-c7`；三个探针文件只存在于这两份副本，均已清理或不被提交。
- 本报告是唯一新增产物，落在 `docs/engineering/P2-02_WP-D_SLICE0_2_1_INDEPENDENT_REVIEW.md`。初版（WSL 受限，结论 BLOCKED）提交为 `bfb77b5`；WSL 解除后据同一被审提交 `41ef234f` 补跑 Linux 证据，本版为改判后的修订，**被审代码在任何阶段都未被触碰**。
- 改判只改变结论，不改变证据标准：上一版把 Linux 全部标为 BLOCKED 是因为无法执行，不是因为执行后不通过；本版把每一项 BLOCKED 逐条替换为实际命令与实际输出，未删除任何一条曾经的保留意见。
