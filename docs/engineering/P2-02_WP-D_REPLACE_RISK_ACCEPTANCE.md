# P2-02 WP-D `INSERT OR REPLACE` 风险接受草案（G4）

状态：**PENDING PRODUCT OWNER APPROVAL**
编制日期：2026-11-24
基线：`feature/p2-02-wpd-slice1-1-remediation` @ `fb664cc`
本轮边界：**只起草，不修改 CI、不修改代码、不修改 Migration。**

> **本文件不是已生效的风险接受。**
> 在「产品负责人」栏签字之前，本文件只代表「风险已被识别并量化」，
> 不代表「风险已被接受」。任何以本文件为依据放宽工程约束的行为都无效。

| 签署项 | 姓名 | 日期 | 结论 |
| --- | --- | --- | --- |
| 产品负责人 | — | — | **未签署** |
| 架构 / 技术负责人 | — | — | **未签署** |
| 安全 / 合规（如需） | — | — | **未签署** |

---

## 1. 风险陈述

SQLite 的 `INSERT OR REPLACE` 在唯一约束冲突时**先删除冲突行、再插入新行**。
它不是「更新」，因此：

1. **可以改写已经冻结的终态裁决**——T2（`Execution_terminal_update_guard`）是
   `BEFORE UPDATE` 触发器，`REPLACE` 走的是 DELETE + INSERT，T2 永不触发。
2. **可以级联删除审计与握手证据**——删除 `Execution` 行会触发 `ON DELETE CASCADE`，
   把日志、产物、握手消息、注册审计一起删掉。
3. **可以替换 append-only 审计行**——T10 只拦 UPDATE，`REPLACE` 一行审计记录
   不触发 T10。

三条叠加的后果：**一次 `REPLACE` 就能让「谁在什么时候因为什么把一个执行判成终态」
这件事从数据库里彻底消失，而且不留任何失败痕迹。**

---

## 2. 机制：为什么现有 Trigger 拦不住

| Trigger | 时机 | 对 `REPLACE` 是否生效 | 原因 |
| --- | --- | --- | --- |
| T1 `Execution_terminal_insert_guard` | BEFORE INSERT | **部分生效** | 它只校验**新行**。新行若是 `status='running'` 且不带终态元组，T1 完全放行；被替换掉的终态行此时已经不存在 |
| T2 `Execution_terminal_update_guard` | BEFORE UPDATE | **不生效** | `REPLACE` 不产生 UPDATE |
| T3 `Execution_terminal_write_guard` | BEFORE UPDATE | **不生效** | 同上 |
| T4 `Execution_dispatch_transition_guard` | BEFORE UPDATE OF dispatchState | **不生效** | 同上（六态可以借 `REPLACE` 任意跳变） |
| T5 `Execution_start_clock_guard` | BEFORE UPDATE OF 时间列 | **不生效** | 同上（start 时钟可被整体重写） |
| T7 `RepositoryHandshakeMessage_insert_guard` | BEFORE INSERT | **部分生效** | 只校验新消息的形状（hash 格式、status、时间戳），不校验它与旧消息的关系 |
| T8 `RepositoryHandshakeMessage_update_guard` | BEFORE UPDATE | **不生效** | `REPLACE` 一条握手消息不触发 T8：身份/信封的不可变性、`execution.start` 不可 replay 全部失效 |
| T9 `ExecutionRegistrationAudit_insert_guard` | BEFORE INSERT | **部分生效** | 只校验新审计行自身合法（decision/epoch 语义），不校验它替换了什么 |
| T10 `ExecutionRegistrationAudit_no_update` | BEFORE UPDATE | **不生效** | `REPLACE` 一条审计行不触发 T10，「append-only」被绕过 |

**关键点：所有 Trigger 都假定「行的历史是连续的」；`REPLACE` 直接抹掉历史再重开一段。**

> 补充：SQLite 默认**不为外键级联动作触发 Trigger**（基线 §2.2 已记录）。
> 因此级联删除不会撞上 T10，也不会撞上任何其它守卫。

---

## 3. 级联删除面（`REPLACE` 一条 `Execution` 会连带删掉什么）

来源：`apps/api/prisma/schema.prisma` 的 `onDelete` 定义。

| 表 | 关系 | 删除动作 | 后果 |
| --- | --- | --- | --- |
| `ExecutionLog` | `executionId` → `Execution` | **Cascade** | 全部日志消失（含失败原因、CLI 输出） |
| `ExecutionArtifact` | 同上 | **Cascade** | diff / 产物证据消失 |
| `RepositoryHandshakeMessage` | 同上 | **Cascade** | 握手证据消失（含 `execution.start` 的唯一记录） |
| `RepositoryHandshakeEvent` | 同上 | **Cascade** | 握手事件时间线消失 |
| `ExecutionRegistrationAudit` | 同上 | **Cascade** | **append-only 审计整段消失** |
| `Activity` | `executionId`（可空） | **SetNull** | 活动记录还在，但与执行的关联被抹掉——比删除更难发现 |

注意最后一行：`Activity` 不删，只把 `executionId` 置 NULL。事后排查会看到
「有一条 execution.completed 活动，但找不到对应的执行」——这本身就是审计断裂的信号，
但没有任何告警会告诉你它发生过。

---

## 4. 当前生产 SQL 使用面

**结论：生产代码里没有 `INSERT OR REPLACE`，也没有任何写入型 raw SQL。**

证据（`grep -rn "queryRaw|executeRaw|OR REPLACE|OR IGNORE" apps/api/src apps/runner/src packages/*/src`）：

| 位置 | 语句 | 性质 |
| --- | --- | --- |
| `apps/api/src/common/prisma/prisma.service.ts:12` | `PRAGMA journal_mode = WAL` | 连接级设置，只读语义 |
| `:13` | `PRAGMA synchronous = NORMAL` | 同上 |
| `:17` | `PRAGMA busy_timeout = 15000` | 同上 |
| `apps/api/src/modules/health/health.controller.ts:14` | `` $queryRaw`SELECT 1` `` | 健康检查 |
| 其余 `$executeRawUnsafe` | 仅出现在 `apps/api/test/*.spec.ts` | 测试辅助（构造非法状态以验证 Trigger） |

`upsert` 的生产使用点（需要关注，因为它可能被实现为 `REPLACE`，见 §5）：

| 位置 | 用法 |
| --- | --- |
| `apps/api/src/common/seed/demo-data.ts:54,66,79,130,193,204,238,292` | seed 的 8 次 `upsert`，其中 `:204` 是 `execution.upsert`（`update: {}`） |
| `apps/api/src/modules/executions/executions.service.ts:1022` | `executionArtifact.upsert`（diff 产物幂等写入） |

**这意味着：当前风险暴露面 = 「seed 与 artifact 的 upsert 实际生成什么 SQL」+「未来任何人手写 REPLACE」。**

---

## 5. Prisma 原生 upsert 的实际行为

### 5.1 本轮结论：**UNVERIFIED**

本轮未实测。原因：本 worktree 的 `@prisma/client` 未生成
（`apps/api/node_modules/.prisma/client` 不存在——仓库没有 `postinstall`/`generate`，
这是独立复审记录的既有门禁缺口 P3-10），因此无法捕获 Prisma 实际发出的 SQL。

**不得**把「Prisma 一定不会用 REPLACE」当作既定事实写进任何验收结论。

### 5.2 两种可能行为及其后果

| 若 Prisma 生成 | 后果 | 风险等级 |
| --- | --- | --- |
| `INSERT ... ON CONFLICT(...) DO UPDATE SET ...`（SQLite 原生 upsert，3.24+） | 冲突走 **UPDATE** 路径 → T2/T8/T10 **会**触发 → 终态行无法被 upsert 改写；审计行无法被 upsert 替换 | 低 |
| `INSERT OR REPLACE` | 冲突走 DELETE + INSERT → §2 全部失效 | **高** |

`execution.upsert` 尤其关键：seed 重跑时若命中已存在的 `execution_seed_completed`，
按第一种行为会走 UPDATE（`update: {}`，等于空更新，被 T2 放行因为终态元组未变）；
按第二种行为会**删掉该执行并级联删除 5 张子表的行**，然后插入一条新的终态行。
后者在开发环境不会被注意到（数据看起来一样），但审计已经断过一次。

### 5.3 验证步骤（下一轮执行，本轮不做）

```bash
cd apps/api
pnpm exec prisma generate
# 1) 打开 SQL 日志
DEBUG="prisma:query" pnpm exec dotenv -e .env.test -- tsx -e "
  import { PrismaClient } from '@prisma/client';
  const p = new PrismaClient();
  await p.execution.upsert({ where: { id: 'probe' }, update: {}, create: { id: 'probe', taskId: 't', agentId: 'a', status: 'running', phase: 'running', dispatchState: 'running' } });
  await p.\$disconnect();
"
# 2) 在输出里查找 "ON CONFLICT" 还是 "OR REPLACE"
```

判据：出现 `ON CONFLICT` → 低风险路径；出现 `INSERT OR REPLACE` → 立即升级为阻断项。

---

## 6. 工程约束（即时生效，不依赖签署）

以下约束**不需要**等待风险接受即可执行，因为它们只是把「已知危险写法」列出来：

1. **禁止在 `apps/`、`packages/`、`scripts/` 的任何源码中手写 `INSERT OR REPLACE`。**
   包括字符串拼接、模板字符串、`$executeRaw` / `$executeRawUnsafe` 内的 SQL。
2. **禁止用 `REPLACE` 实现「幂等写入」。** 幂等应使用
   `INSERT ... ON CONFLICT DO NOTHING` / `DO UPDATE`（显式列），或 Prisma 的 `upsert`。
3. **禁止在测试之外使用 `$executeRawUnsafe`。** 现有测试用它构造非法状态验证 Trigger，
   这是合法用法；生产代码没有理由使用。
4. **对 `Execution` / `ExecutionRegistrationAudit` / `RepositoryHandshakeMessage`
   三张表，禁止任何形式的 DELETE**（级联删除是唯一允许的删除路径，且只能由删除
   `Task`/`Project`/`Workspace` 这类上层对象间接触发）。
5. **新增 raw SQL 必须在 PR 描述里说明：为什么 ORM 表达不了、是否可重复执行、失败时是否留半状态。**
6. **seed 重跑前必须先确认 upsert 的实际行为（§5.3）。** 在结论出来之前，
   对已有 demo 数据的库重跑 seed 视为有风险操作。

---

## 7. 建议的 CI 静态检查（本轮不落地）

### 7.1 方案 A：脚本 + 允许清单（推荐）

新增 `scripts/acceptance/check-sql-safety.mjs`，在 CI 的 static job 中执行：

```text
扫描范围：apps/*/src、packages/*/src、scripts/、apps/api/prisma/migrations/
失败条件：
  1. 出现 /INSERT\s+OR\s+REPLACE/i
  2. 出现 /\bREPLACE\s+INTO\b/i
  3. 出现 /\$executeRawUnsafe|\\$executeRaw\b/ 且文件不在允许清单内
允许清单（当前唯一）：
  apps/api/test/**            -- 构造非法状态以验证 Trigger
  apps/api/scripts/reset-database.mjs  -- 只删文件，不含 SQL
```

优点：零依赖、可本地跑、错误信息精确到行。
缺点：正则会被字符串拼接绕过（但拼接本身就应该在 review 中被拒）。

### 7.2 方案 B：ESLint 自定义规则

在 `eslint.config.mjs` 增加 `no-restricted-syntax`，对模板字符串/字符串字面量做模式匹配。
优点：与现有 `pnpm lint` 门禁天然集成。
缺点：规则写起来比脚本重，且对跨行 SQL 不友好。

### 7.3 落地顺序建议

1. 先做 §5.3 的行为验证（决定风险等级）；
2. 再落地方案 A（成本最低）；
3. 方案 B 作为补充，不替代 A。

**本轮不修改 `.github/workflows/ci.yml`，也不新增该脚本。**

---

## 8. 残余风险

即使 §6 的约束全部被遵守、§7 的检查全部落地，仍存在以下残余风险：

| # | 残余风险 | 缓解 |
| --- | --- | --- |
| R1 | 开发者通过 ORM 的 `upsert` 间接触发 REPLACE（若 §5.3 验证结果为 REPLACE） | 必须先在 §5.3 得出结论；若为 REPLACE，则禁止在生产代码使用 `upsert` 写 `Execution` 系列表 |
| R2 | 数据库被外部工具（DB Browser、sqlite3 CLI、运维脚本）直接修改 | 部署/运维流程约束（运维手册 §7）+ 生产库访问审计 |
| R3 | 触发器本身被 `DROP` 或替换 | `db:migrate:verify` 的 10 个 Trigger 断言 + `database-triggers.integration.spec.ts` |
| R4 | 恶意或被入侵的进程直接写 `.db` 文件 | **超出本设计范围**：SQLite 文件级访问无法被应用层阻止；需靠主机权限与备份 |

---

## 9. 待产品负责人决策的选项

| 选项 | 含义 | 后果 |
| --- | --- | --- |
| **A. 接受现状** | 保持「无 REPLACE + 靠 review 与约束」 | 风险停留在「人犯错」层面；无自动拦截 |
| **B. 接受 + 落地 CI 检查（推荐）** | §6 约束 + §7.1 脚本 | 拦截绝大部分手写场景；成本约半天 |
| **C. 要求数据库层根治** | 评估用 BEFORE INSERT Trigger 检测「同 id 已存在」来拒绝 REPLACE | **本轮未验证可行性**（见下），且需新 forward migration，风险与收益需单独评审 |
| **D. 不接受，阻断 Slice 2** | 在根治方案落地前不进入 Slice 2 | 与当前 `CONDITIONAL GO` 冲突，需要重新评估准入 |

> 关于选项 C：SQLite 的 `BEFORE INSERT` 触发器在 `REPLACE` 场景下是否仍能看到
> 待删除的旧行，取决于冲突解析与触发器执行的先后顺序。**本轮未做实验，不下结论。**
> 若要做，必须覆盖三种语句形态：`INSERT OR REPLACE`、`INSERT OR IGNORE`、
> `INSERT ... ON CONFLICT DO UPDATE`，确认新约束不会误伤后两者。
> 在实验完成前，本文档第 2 节「当前没有零副作用的数据库触发器解决方案」这一判断
> 指的是**已实现的 10 个 Trigger 之中没有任何一个覆盖该路径**，而不是「数学上不可能」。

---

## 10. 未验证项清单

| # | 项 | 状态 |
| --- | --- | --- |
| U1 | Prisma 6.16.2 在 SQLite 上 `upsert` 生成的确切 SQL | **UNVERIFIED**（§5.3 给出步骤） |
| U2 | `PRAGMA foreign_keys` 在 Prisma 连接上的实际取值（决定级联是否真的发生） | **UNVERIFIED**（预期为 ON；需实测确认） |
| U3 | 选项 C 的 Trigger 可行性 | **未实验** |
| U4 | 生产/共享环境是否存在历史 REPLACE 痕迹（审计断裂、孤立 Activity） | **UNVERIFIED**（无访问权限） |

U2 的实测方式：

```bash
node -e "const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('<db>', { readOnly: true });
console.log(db.prepare('PRAGMA foreign_keys').get());
db.close();"
```

注意：`PRAGMA foreign_keys` 是**连接级**设置，读一个未配置的连接会得到 0；
要验证 Prisma 的行为必须通过 Prisma 连接读，而不是裸 `node:sqlite`。

---

## 11. 交叉引用

- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §5.1（「不得绕过数据库触发器」）
- `docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md` §6 O8（本文件为阻断项）
- `docs/engineering/P2-02_WP-D_INSERT_STATE_CONSTRAINT_DESIGN.md`（同属「数据库层如何被绕过」）
- `docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md` §7（禁止操作清单）
- `P2-02_WP-D_SLICE1_INDEPENDENT_REVIEW.md` P3-5（本风险的最初取证）
