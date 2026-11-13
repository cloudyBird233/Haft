# P2-02 WP-D Slice 0.2.1 修复报告（C6 N-1 / P2-2A / P2-2B / P2-2C）

- 报告日期：2026-11-13
- 修复分支：`feature/p2-02-wpd-slice0-2-1-remediation`
- 基线提交：`5357818999c885da6530974de9c55436b7801b5c`（C6 独立复审提交）
- 代码/测试提交：`41ef234ff427ae7ae4adac89b3e42d814d9ff7cf`
- 本轮结论：**PASS WITH WARNINGS**

> 本结论仅代表本轮 N-1、P2-2A、P2-2B、P2-2C 修复范围的本地证据。
> 它不表示 C6 独立复审已经通过，也不表示 Slice 1 已获准启动。最终验收仍须由新的独立复审完成。

---

## A. 结论与状态

C6 复审判定 FAIL 的核心问题是“证据存在性”被当成了“证据有效性”。本轮把相关门禁改为：**读取同一文件描述符、校验内容与身份、失败一律 blocked**。

| Finding / 子项                                           | C6 状态  | 本轮状态                         | 关闭证据                        |
| -------------------------------------------------------- | -------- | -------------------------------- | ------------------------------- |
| N-1：POSIX starting guard 可被目录/符号链接/写入失败绕过 | FAIL     | 本轮修复范围内关闭（待独立复审） | IR7；N-1 专项 19 个用例         |
| P2-2A：sidecar 非原子写、`resolutionExists()` 只 stat    | FAIL     | 本轮修复范围内关闭（待独立复审） | IR4、IR4b；P2-2A 专项 14 个用例 |
| P2-2B：任意 `*.corrupt-N` 可被 resolve                   | FAIL     | 本轮修复范围内关闭（待独立复审） | IR5；P2-2B 专项 8 个用例        |
| P2-2C：非法 PID journal 被 finalize 为 interrupted       | FAIL     | 本轮修复范围内关闭（待独立复审） | IR8；P2-2C 专项 34 个用例       |
| P2-4：managed/supervised 15s fallback                    | Deferred | **仍为 Deferred，未关闭**        | 本报告不宣称关闭                |
| N-2–N-6（P3）                                            | 未关闭   | 本轮范围外，未修改               | —                               |

本轮没有新的 P0/P1 级问题；没有删除既有测试；没有放宽 fail-closed 断言。

---

## B. 基线与变更清单

### B.1 基线

- 基线 HEAD：`5357818999c885da6530974de9c55436b7801b5c`
- 基线测试量：Windows 196（193 passed / 3 skipped）；Linux 196（194 passed / 2 skipped）
- 基线格式门禁已知债务：`process-guard.ts`、`process-supervisor-child.ts`、`recovery-admin.ts`、`recovery-hardening-os.spec.ts` 不在格式债基线中

### B.2 源码变更

| 文件                                          | 变更                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runner/src/safe-file.ts`                | 新增。证据文件只按普通文件读取：`lstat` 预检、`O_NOFOLLOW`/`O_NONBLOCK` open、对同一 fd `fstat`、从同一 fd 读取、SHA-256。                                                  |
| `apps/runner/src/process-supervisor-guard.ts` | 新增。starting guard 的结构校验、身份绑定校验，以及 spawn 前的路径类型预检。                                                                                                |
| `apps/runner/src/process-supervisor-child.ts` | POSIX supervisor 在 `spawn()` 前接入 guard 校验；`updateGuard()` 使用独占临时文件 + `fsync` + rename，并返回成败；running guard 写入失败会终止 CLI 树。                     |
| `apps/runner/src/recovery-evidence.ts`        | 新增。resolution sidecar v2 与 corrupt provenance v1 的原子发布、严格读取、摘要/大小/文件名/root/executionId 绑定校验。                                                     |
| `apps/runner/src/recovery.ts`                 | `resolve-corrupt` 要求有效 provenance、非空 note、有效且目标绑定的 sidecar；scan 不再以路径存在性放行；guard sidecar 也走严格校验。                                         |
| `apps/runner/src/execution-journal.ts`        | 隔离时写入 provenance；排除 `.provenance.json`；严格校验 `pid`、`processStartTime`、`processGroupId`、`supervisorPid`、`cliPid`、`processKind`、`spawnState` 及跨字段关系。 |
| `apps/runner/src/process-guard.ts`            | `readProcessGuard()` 改为 fd-safe 普通文件读取，避免 FIFO/符号链接让恢复侧阻塞；未改 guard 写入与终止逻辑。                                                                 |

### B.3 测试变更

| 文件                                                        | 变更                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runner/test/recovery-resolution.spec.ts`              | R14 改为先走真实 corruption isolation，再 resolve；保留 R13–R19 原有语义。                                                                                |
| `apps/runner/test/recovery-hardening-os.spec.ts`            | R03 的 journal fixture 补上真实 writer 会写入的 `supervisorPid`/`supervisorStartTime`；该文件因成为本轮变更文件而执行了 Prettier 格式化。未放宽任何断言。 |
| `apps/runner/test/journal-pid-schema.spec.ts`               | 新增 34 个 PID/身份 schema 与 IR8 用例。                                                                                                                  |
| `apps/runner/test/posix-supervisor-guard-hardening.spec.ts` | 新增 19 个 N-1/IR7 用例，其中 5 个使用真实 POSIX supervisor + `real-cli.cjs`。                                                                            |
| `apps/runner/test/recovery-evidence-hardening.spec.ts`      | 新增 22 个 P2-2A/P2-2B/IR4/IR4b/IR5 用例。                                                                                                                |

---

## C. 问题复现与关闭证据（IR4 / IR4b / IR5 / IR7 / IR8）

| 探针 | 原始 fail-open 行为                                   | 本轮测试                                                                                | Windows                          | Linux |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------- | ----- |
| IR4  | 零字节 sidecar 让下一次 scan `clean=true`             | `IR4: a zero-byte sidecar never makes the next scan clean`                              | PASS                             | PASS  |
| IR4b | 截断 sidecar 让下一次 scan `clean=true, blocked=0`    | `IR4b: a truncated sidecar never makes the next scan clean`                             | PASS                             | PASS  |
| IR5  | 任意 `*.corrupt-123` 被 `resolve=true`                | `IR5: an arbitrary *.corrupt-N file without provenance is rejected`                     | PASS                             | PASS  |
| IR7  | guard 路径为目录时 CLI 仍被 spawn                     | `IR7: a directory at the guard path blocks the CLI spawn`（以及符号链接、FIFO、空文件） | 不适用：POSIX-only，Windows 跳过 | PASS  |
| IR8  | `pid:"not-a-number"` 被接受并 finalize 为 interrupted | `IR8: a non-numeric PID is never finalized as interrupted`                              | PASS                             | PASS  |

IR4/IR4b 的断言现在同时检查：

- `scan.clean === false`；
- 存在 `corrupt-journal` blocked 条目；
- 原 quarantined 文件仍保留；
- 零字节/截断 sidecar 不会被当作有效 resolution。

IR5 的断言现在同时检查：

- `resolved === false`；
- reason 包含 `no valid isolation provenance`；
- 不产生 `.resolution.json`；
- scan 仍 blocked。

IR7 在 Linux 上使用真实 POSIX supervisor 和真实 CLI fixture：guard 路径预先放置目录、符号链接、FIFO、空文件后，supervisor 必须失败退出，CLI marker 不得出现。Windows 不使用该 supervisor，因此该组用例按平台跳过，不是 Windows 失败。

IR8 同时验证了非法 PID journal 被 quarantine、`scan.executions` 为空、quarantined 内容仍为 `status:"active"`，不会被改写为 `interrupted`。

---

## D. N-1：POSIX starting guard 的 fd 级验证与 spawn 前置门禁

### D.1 修复实现

1. **不按路径存在性判断 guard**
   - `safe-file.ts` 先 `lstat` 拒绝符号链接；
   - `open` 使用 `O_NOFOLLOW | O_NONBLOCK`；
   - 对打开的 fd 执行 `fstat`，要求 `isFile()`；
   - 内容与摘要从同一 fd 读取，避免 read 阶段再次跟随路径；
   - 大小上限 1 MiB（guard）/16 MiB（journal 证据），超限拒绝。

2. **guard JSON 与身份严格校验**
   - `version === 1`；
   - `executionId`、`launchToken`、`supervisorStartTime`、`createdAt`、`updatedAt` 必须为非空字符串；
   - `parentPid`、`supervisorPid` 必须为正安全整数；
   - `processGroupId`、`cliPid` 必须为 null 或正安全整数；
   - `state` 必须属于已知枚举；
   - starting guard 必须与当前 supervisor 的 executionId、launchToken、parentPid、supervisorPid、supervisorStartTime、processGroupId、isolation、createdAt 一致；
   - starting guard 必须满足 `state:'starting'`、`cliPid:null`、`cliStartTime:null`、`treeConfirmedGone:false`、`exitCode:null`、`signal:null`、`detail:null`。

3. **接入真实 spawn 前置门禁**
   - `main()` 在 `spawn()` 之前调用 `assertGuardPathAvailable()`；
   - 初始 guard 写入失败（`updateGuard()` 返回 false）直接抛错；
   - 随后调用 `readValidatedStartingGuard()`，失败即抛错；
   - 只有以上步骤全部成功，才允许创建 CLI；
   - running guard 写入失败时调用 `terminateTree('guard-write-failed', ...)`，不留下“CLI 在跑但没有 durable evidence”的状态。

### D.2 预存路径处理

`assertGuardPathAvailable()` 对预存路径一律拒绝启动：

- 目录；
- 符号链接（含 Windows junction/reparse point 的路径类型检查由 lstat 覆盖）；
- FIFO；
- socket；
- 普通文件（stale guard）；
- 其他特殊文件。

拒绝发生在写入 guard 和 `spawn()` 之前。即使 hostile actor 在写入后替换路径，`readValidatedStartingGuard()` 仍会读取实际文件并因内容/身份不匹配而阻断。

### D.3 N-1 测试

`apps/runner/test/posix-supervisor-guard-hardening.spec.ts` 共 19 个用例：

- 14 个单元级用例：合法 guard、目录、符号链接、FIFO、空文件、坏 JSON、结构非法 JSON、executionId/launchToken/supervisorPid/state 不匹配、验证期间替换路径、预存普通文件/目录、预存符号链接/FIFO；
- 5 个真实 supervisor 用例：目录、符号链接、FIFO、空文件四种 IR7 场景，以及正常 POSIX 启动回归。

Windows：11 passed / 8 skipped（POSIX-only）；Linux：19 passed。

---

## E. P2-2A / P2-2B / P2-2C 修复

### E.1 P2-2A：resolution sidecar 原子写入与严格读取

**写入**（`recovery-evidence.ts`）：

- 同目录独占临时文件：`open(path, 'wx', 0o600)`；
- 完整写入后对 fd 执行 `fsync`；
- 通过硬链接 `link(temp, target)` 原子发布；目标已存在时返回 `EEXIST`，绝不覆盖；
- 发布后对父目录执行 fsync（Windows 不支持目录 fsync，按平台 no-op）；
- 目录 fsync 失败时删除已发布目标，保持 blocked；
- 失败路径清理临时文件；
- 已存在有效 sidecar 或无效 sidecar 都拒绝覆盖，保留审计证据。

**读取**（`readResolutionSidecar`）：

- 只接受普通文件；
- JSON 必须可解析；
- `version === 2`、`kind === 'corrupt-journal-resolution'`；
- `executionId` 必须为 null 或非空字符串；
- `targetName` 必须与当前目标 basename 一致；
- `targetSize`、`targetSha256` 必须与当前目标内容一致；
- `resolution === 'operator-confirmed-process-gone'`；
- `note` 非空；
- `resolvedAt` 可解析。

**绑定**（`readValidCorruptResolution`）：

- sidecar 的 `executionId` 必须与 provenance 的 `executionId` 一致；
- 任一文件缺失、损坏、截断、类型不符、摘要/大小/文件名/身份不匹配，scan 均保持 blocked；
- `resolveCorruptJournal()` 在已有有效或无效 sidecar 时都拒绝再次写入。

并发行为：两个并发 resolve 只有一个成功发布，另一个收到 `EEXIST`/校验失败；已有 sidecar 不会被第二个 note 覆盖。

### E.2 P2-2B：corrupt journal provenance

真实 quarantine 路径在 rename 成功后写入 `<target>.provenance.json`，记录：

- `version: 1`；
- `kind: 'corrupt-journal-quarantine'`；
- `recoveryRoot`（规范化绝对路径）；
- `originalName`（去掉 `.corrupt-<digits>` 后的原文件名）；
- `quarantinedName`；
- `executionId`（从损坏 journal 尽量提取，失败为 null）；
- `isolatedAt`；
- `sha256` 与 `size`（隔离文件实际内容）。

`resolveCorruptJournal()` 只有在 provenance 有效时才可能成功。provenance 校验包括：

- recovery root 一致；
- basename 确实是 `*.corrupt-<digits>`；
- `originalName` 与去后缀结果一致；
- `quarantinedName` 与当前 basename 一致；
- `size`、`sha256` 与当前隔离文件一致。

因此以下情况全部 blocked：

- 任意普通文件仅改名为 `*.corrupt-N`；
- 只有有效 sidecar、没有 provenance；
- 隔离后内容被修改；
- provenance 从另一个 recovery root 复制；
- provenance 属于另一个 execution/journal 文件；
- provenance 写入失败（journal 仍保留隔离文件，但不可 resolve）。

`execution-journal.ts` 的目录扫描同时排除 `.resolution.json` 与 `.provenance.json`，避免把证据文件再次当作 journal 隔离。

### E.3 P2-2C：Journal PID/身份 schema

`isValidRecord()` 现在要求：

- `pid`：必须存在，且为 null 或正安全整数；
- `processStartTime`：必须存在，且为 null 或非空字符串；
- `processGroupId`：必须存在，且为 null 或正安全整数；
- `supervisorPid`、`cliPid`：可缺省/null，或正安全整数；
- `supervisorStartTime`、`cliStartTime`：可缺省/null，或非空字符串；
- `processKind`：null/缺省/`supervisor`/`direct`；
- `spawnState`：null/缺省/`intent`/`supervisor-ready`/`running`。

跨字段约束：

- `cliPid` 不得等于 `pid`；
- `direct` 不得携带 supervisor/cli 身份，也不得声明 `supervisor-ready`；
- `supervisor` + `supervisor-ready`/`running` 时：
  - `pid`、`supervisorPid` 必须为正安全整数且相等；
  - `supervisorStartTime` 必须非空；
- `supervisor-ready` 只允许 `processKind:'supervisor'`；
- `running` 必须有正数 `pid`；
- 缺失 `pid`/`processStartTime`/`processGroupId`、字符串 PID、0、负数、小数、超安全整数、布尔 PID 全部视为非法。

非法记录进入 quarantine/block，不会被 `finalize` 为 `interrupted`。合法的 `pid:null` active 记录仍按原有语义 blocked（`PID_NOT_RECORDED`），而不是被误隔离。缺少较新可选身份字段的历史记录仍可接受。

---

## F. 验证矩阵

### F.1 环境

| 项目     | Windows                                    | Linux（WSL2）                                                  |
| -------- | ------------------------------------------ | -------------------------------------------------------------- |
| OS       | Microsoft Windows NT 10.0.26200.0          | Ubuntu 24.04.5 LTS，kernel `6.18.33.2-microsoft-standard-WSL2` |
| Node     | v24.14.0                                   | v22.14.0                                                       |
| pnpm     | 11.5.2                                     | 11.5.2                                                         |
| 代码状态 | `41ef234ff427ae7ae4adac89b3e42d814d9ff7cf` | 同一提交内容复制到 `/tmp/haft-slice0-2-1` 后执行               |
| 依赖     | 工作区既有 `node_modules`                  | `CI=true pnpm install --frozen-lockfile`；`contracts` 先 build |

Linux 证据说明：工作区位于 Windows 文件系统，WSL 内 Git worktree 元数据路径不可用，因此把仓库内容（排除 `.git`/`node_modules`/`dist`）复制到 WSL 临时目录，使用同一 lockfile 安装依赖后运行同一批测试文件。

### F.2 双平台结果

| 命令                                                             | 平台            | 结果                                                                           |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `pnpm --filter @raft-lite/runner test -- --reporter=dot`         | Windows         | 24 个测试文件；**259 passed / 12 skipped / 0 failed**，271 total；约 32.5s     |
| `pnpm --filter @raft-lite/runner exec vitest run --reporter=dot` | Linux           | 24 个测试文件；**269 passed / 2 skipped / 0 failed**，271 total；约 4.2s       |
| `pnpm --filter @raft-lite/runner typecheck`                      | Windows / Linux | 通过                                                                           |
| `pnpm --filter @raft-lite/runner build`                          | Windows / Linux | 通过（tsup，3 个入口）                                                         |
| `pnpm lint`                                                      | Windows / Linux | 通过（`eslint . --max-warnings=0`）                                            |
| `pnpm typecheck`（根工作区）                                     | Windows         | 通过（contracts / runner / api / web）                                         |
| `prettier --check`（本轮 12 个变更/新增文件）                    | Windows / Linux | 通过                                                                           |
| `pnpm format:check`                                              | Windows         | **失败**，仅剩 `apps/runner/src/recovery-admin.ts`（本任务未修改的基线格式债） |

相对基线：

- Windows：196 → 271 total；193 → 259 passed；3 → 12 skipped。
- Linux：196 → 271 total；194 → 269 passed；2 → 2 skipped。
- 新增 3 个测试文件、75 个用例：
  - `journal-pid-schema.spec.ts`：34；
  - `posix-supervisor-guard-hardening.spec.ts`：19；
  - `recovery-evidence-hardening.spec.ts`：22。
- 新增用例平台执行：Windows 66 passed / 9 skipped；Linux 75 passed。

### F.3 既有重点套件

| 套件                              | Windows                                        | Linux                                        |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| F1–F9（finalize 并发/终态一致性） | 9 passed                                       | 9 passed                                     |
| S1–S8（supervisor safety）        | S1–S5、S7 passed；S6、S8 skipped（POSIX-only） | S1–S6、S8 passed；S7 skipped（Windows-only） |
| R13–R19（recovery resolution）    | R13–R17、R19 passed；R18 skipped（POSIX-only） | R13–R19 全部 passed（含 R15b）               |

平台跳过均来自既有或新增的 POSIX/Windows 专属用例，不是功能失败：

- Windows 跳过 9 个新增 POSIX 专属用例（8 个 N-1/IR7 + 1 个 sidecar 符号链接）；
- Windows 额外跳过 3 个既有平台专属用例（S6、S8、R18）；
- Linux 跳过 2 个既有 Windows 专属用例（S7、R04b）。

### F.4 passed / failed / skipped / blocked 汇总

| 类别                       | 数量   |
| -------------------------- | ------ |
| passed（Windows）          | 259    |
| passed（Linux）            | 269    |
| failed（Windows / Linux）  | 0 / 0  |
| skipped（Windows / Linux） | 12 / 2 |
| blocked（测试）            | 0      |

`blocked` 在这里指测试无法执行；本轮没有 blocked 测试。`format:check` 的失败是既有格式债门禁问题，不是测试 blocked。

### F.5 故障注入与恢复路径

本轮新增用例实际覆盖：

- sidecar 临时写失败；
- sidecar 原子发布失败；
- sidecar 目录 fsync 失败；
- sidecar 中途写失败后的临时文件清理；
- 并发 resolve；
- 已有有效 sidecar 不被覆盖；
- sidecar 为目录/符号链接；
- sidecar 摘要篡改；
- sidecar 从另一个目标复制；
- sidecar executionId 不匹配；
- provenance 写失败；
- provenance 内容/root/文件名/摘要不匹配；
- guard 路径为目录/符号链接/FIFO/空文件/坏 JSON/结构非法 JSON；
- guard 身份字段不匹配与验证期间路径替换；
- journal 字符串/0/负数/小数/超安全整数/布尔/缺失 PID，以及 `supervisorPid`/`cliPid`/`processGroupId`/`processStartTime` 非法值；
- `processKind`/`spawnState` 跨字段不一致。

---

## G. 冻结边界、遗留风险与复审建议

### G.1 冻结边界合规

| 边界                      | 结论       | 说明                                                              |
| ------------------------- | ---------- | ----------------------------------------------------------------- |
| `main`                    | 未改       | 只在功能分支提交                                                  |
| 冻结设计文档              | 未改       | 未修改计划、Roadmap、既有复审报告                                 |
| 协议 / Schema             | 未改       | 未修改 `packages/contracts`、消息顺序或错误码                     |
| 既有测试                  | 未删       | 仅新增测试文件；R14 改为真实 quarantine；R03 fixture 补全真实字段 |
| P1-1 / P2-1 / P2-3        | 未重新实施 | 只保留其既有实现与回归                                            |
| Windows native supervisor | 未改       | `windows-process-supervisor.cs` 无 diff                           |
| `real-executor.ts`        | 未改       | `real-executor.ts` 无 diff                                        |
| P2-4                      | 未关闭     | managed/supervised 15s fallback 仍为 Deferred                     |
| force push / rebase       | 未做       | 新分支直接提交                                                    |

### G.2 警告与残余风险

1. **格式门禁仍有既有债务**
   - `pnpm format:check` 仍失败，唯一 regression 是 `apps/runner/src/recovery-admin.ts`；
   - 该文件本轮未修改，失败在基线上已存在；
   - 本轮变更/新增的 12 个文件全部 Prettier-clean；
   - 未通过修改 `format-baseline.json` 来掩盖问题。

2. **P2-4 仍为 Deferred**
   - managed/supervised 15s fallback 不在本轮范围；
   - 本报告不宣称 P2-4 已关闭，也不应据此启动 Slice 1。

3. **P3 新发现未处理**
   - N-2（finalize 注释与 uncertain 语义）、N-3（guard 本地篡改/平台隔离交叉校验）、N-4（Windows `TerminateProcess` 返回值）、N-5（原始 WP-D 复审文档缺失）、N-6（R19 cgroup 分支）均未在本轮修改。

4. **Windows 目录 fsync 的平台限制**
   - Linux 上 sidecar 发布后对父目录执行 fsync；
   - Windows 上 Node 不支持目录 fsync，`syncDirectory` 按平台 no-op；
   - sidecar 文件本身仍执行 `fsync`，发布仍使用原子硬链接；这是平台能力限制，不是本轮 fail-open 回归。

5. **威胁模型**
   - provenance/sidecar 的摘要校验能阻止“空文件、截断、误复制、内容篡改、错误目标”导致的放行；
   - 它对拥有 recovery root 写权限的本地攻击者不是密码学防伪；该威胁模型与 C6 复审的本地同用户边界一致。

### G.3 复审建议

建议新的独立复审重点复核：

1. IR4、IR4b、IR5、IR7、IR8 是否在独立探针中保持 fail-closed；
2. provenance 与 sidecar 的绑定是否覆盖 root/文件名/大小/摘要/executionId；
3. `resolveCorruptJournal()` 在已有无效 sidecar 时是否仍然 blocked；
4. 非法 PID journal 是否只进入 quarantine/block，不进入 finalize；
5. POSIX supervisor 在预存目录/符号链接/FIFO/空文件时是否完全不创建 CLI。

在新的独立复审给出结论前，不启动 Slice 1。
