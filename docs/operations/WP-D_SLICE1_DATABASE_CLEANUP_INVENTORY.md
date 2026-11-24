# WP-D Slice 1 数据库清理清单（G1）

状态：**核查完成，清理未执行**
核查日期：2026-11-24
核查基线：`D:/CODE/GIT/Haft-p2-02-wpd-slice1-1`，分支 `feature/p2-02-wpd-slice1-1-remediation`，HEAD `fb664cc`
适用阶段：Slice 1 收尾（进入 Slice 2 之前的准备）
本轮授权：**只读核查 + 方案准备**。禁止删除、覆盖、重建、`migrate deploy`、`db push`。

---

## 1. 结论摘要

| 结论 | 内容 |
| --- | --- |
| 需要处理的数据库文件 | 5 个（3 个 `test.db`、1 个 `fresh.db`、1 个 `baseline.db`） |
| 其中属于一次性测试库 | 5 / 5，均不含不可恢复的业务数据 |
| 与当前 Migration 文件 checksum 一致 | **仅 1 个**（`Haft-p2-02-wpd-slice1-1` 的 `test.db`） |
| 被 `reset-database.mjs` 的 DISPOSABLE 白名单覆盖 | **仅 3 个 `test.db`**；`fresh.db`、`baseline.db` **不在白名单** |
| 存在未清理的 SQLite 回滚日志（`-journal`） | 2 个（`fresh.db`、`baseline.db`） |
| 存在无法恢复的重要测试数据 | **无** |
| 共享 / 生产环境 | **UNVERIFIED**，本轮无权也不得推定 |

一句话：这些数据库都是本机一次性产物，**没有一个可以作为「当前 Migration 链已正确应用」的证据**；其中 4 个的 checksum 与当前 `migration.sql` 不一致，必须按本手册重新建立，而不是修补。

---

## 2. 核查方法与边界

- 所有读取在**副本**上进行：先把 `.db` 复制到系统临时目录，再用 `node:sqlite`（Node 22.22.2）以只读语义读取 `sqlite_master`、`PRAGMA table_info`、`PRAGMA integrity_check`、`PRAGMA foreign_key_check`、`_prisma_migrations` 与业务行。
- 原文件**未被打开写入**，`sha256` 在核查前后一致（见 §3 表）。
- 副本**未包含** `-wal` / `-shm` / `-journal` 旁文件，因此表中「行内容」反映的是主库文件本身；`-journal` 存在时，SQLite 下次打开可能先做回滚，真实可见状态需按 §4.3 复核。
- 未执行任何 `prisma` 命令；未连接任何共享数据库。

核查命令（可重复执行，只读）：

```bash
sha256sum <db>            # 文件指纹
node inspect.mjs <copy>   # 读取 sqlite_master / _prisma_migrations / 行数
```

---

## 3. 清单

### 3.1 当前 Migration 文件基准（checksum 对照用）

`apps/api/prisma/migrations/` 下 7 个目录的 `migration.sql` SHA256：

| # | Migration | 文件 SHA256 |
| --- | --- | --- |
| 1 | `20261106095317_init` | `e193589f063faa5a2814ceaac0f6f99271ce0549a7f60eb4034f648f4bdc1308` |
| 2 | `20261107090000_runner_phase1` | `b19ad8888edccc6ddbd3e9ab41355fa8d2b90781cedad42601ebd5c3e8e5cbfd` |
| 3 | `20261107160000_execution_git_diff` | `51f3f2a97f33236df6a1d65a358faba5d8ba5a908e285d75363db1a0579b3acf` |
| 4 | `20261109120103_p2_01_project_repository_binding` | `4128c5140a154055f52b58ab2022a4d6f6ba5154145e99917cc2964c5c6f9ce2` |
| 5 | `20261111120000_p2_02_repository_handshake` | `dda2da5eb4cf7fac29025b0e79e720a7d133a9cf5e7d82698f503997150d72e8` |
| 6 | `20261111130000_p2_02_execution_cancel_intent` | `2f97996a59a21d1f47605830c2d05826e0398e9cebc04d6e2d606752c019147f` |
| 7 | `20261116120000_p2_02_wpd_slice1_schema_migration` | `e2c858104848b94e8746c6dfc27ee8cd086014c7c0f318926d5614eb33757bf8` |

> 第 7 条即 Slice 1 Migration。Prisma 的 `_prisma_migrations.checksum` 就是 `migration.sql` 内容的 SHA256——第 7 条在 `Haft-p2-02-wpd-slice1-1` 的 `test.db` 中记录值与文件 SHA256 逐字节相等，可作为该口径的实证。

### 3.2 数据库清单

| # | 位置 | 大小 | SHA256 | 旁文件 | `_prisma_migrations` | 第 7 条 checksum | 与文件一致 | 数据 | 一次性库 | 白名单 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `Haft-p2-02-wpd-slice1/apps/api/prisma/test.db` | 1,413,120 | `da6a7795b8dab8c59261ea13866a306438e151b28c5083ff40ecda96cad77e62` | `-wal`(0 B)、`-shm`(32 KiB) | 7 条，均 `finished_at` 非空、`rolled_back_at` 为空 | `2c57449ced2b16615f4355f5f493f5d93c9246f1aba881cf465eefea6848f235` | **否** | demo seed | 是 | 是 |
| D2 | `Haft-p2-02-wpd-slice1/apps/api/prisma/fresh.db` | 360,448 | `598c2823a4f8b9d64be8f09812ab356cac9105ef480aedcd602d84cd87458e4c` | `-journal`(37,448 B) | 7 条 | `88213f4fad935afde0c248211e0798e24e49265b6a1008889bdd60e1b26e885b` | **否** | 0 行 | 是 | **否** |
| D3 | `Haft-p2-02-wpd-slice1/apps/api/prisma/baseline.db` | 262,144 | `d41758997e9b8202762a2bb5499d0bd0722d2c1cf06f339447c36cef1f7d0b59` | `-journal`(37,448 B) | **6 条**（无第 7 条） | 不适用 | 不适用 | 0 行，无 `terminalDecision` 列 | 是 | **否** |
| D4 | `Haft-p2-02-wpd-slice1-1/apps/api/prisma/test.db` | 1,413,120 | `9aaae704c712a3f98800511d022af2eec25d291426ab6cb17250b948a0eacca2` | `-wal`(0 B)、`-shm`(32 KiB) | 7 条 | `e2c858104848b94e8746c6dfc27ee8cd086014c7c0f318926d5614eb33757bf8` | **是** | demo seed | 是 | 是 |
| D5 | `Haft-review-slice1/apps/api/prisma/test.db` | 1,413,120 | `af7f0d9f8a7a68788c27615662d96334ade66e7cd8b2f1c1382e73db0f21b343` | `-wal`(0 B)、`-shm`(32 KiB) | 7 条 | `2c57449ced2b16615f4355f5f493f5d93c9246f1aba881cf465eefea6848f235` | **否** | demo seed | 是 | 是 |

所有 5 个库：`PRAGMA integrity_check` = `ok`，`PRAGMA foreign_key_check` = 空，15 张表、10 个 Trigger、46 个索引（D3 除外：13 张表、0 个 Trigger、32 个索引，属 Slice 1 之前的形态）。

### 3.3 行内容（D1 / D4 / D5）

三库都是 demo seed 的完整副本，**没有任何握手消息、没有任何注册审计行**：

| 表 | D1 | D4 | D5 |
| --- | --- | --- | --- |
| `Workspace` / `Project` | 2 / 2 | 1 / 1 | 2 / 2 |
| `Computer` / `Runner` / `Agent` / `Task` | 4 / 3 / 3 / 4 | 4 / 3 / 3 / 4 | 4 / 3 / 3 / 4 |
| `Execution` / `ExecutionLog` / `Activity` | 1 / 5 / 4 | 1 / 5 / 4 | 1 / 5 / 4 |
| `RepositoryHandshakeMessage` | 0 | 0 | 0 |
| `ExecutionRegistrationAudit` | 0 | 0 | 0 |

唯一一条 Execution 均为 `execution_seed_completed`（`runtime=mock`、`runnerId=NULL`、`status=completed`、`dispatchState=terminal`、`terminalDecision=COMPLETED`），差别只在裁决身份：

- D4：`terminalDecidedBy = API:mock-runtime`（与当前 `apps/api/src/common/seed/demo-data.ts:221` 一致）
- D1 / D5：`terminalDecidedBy = seed:demo-data`（**当前 T1 Trigger 会拒绝**的前缀）

---

## 4. 逐项判定

### 4.1 D1 / D5：checksum 不一致，且含有当前契约会拒绝的行

- 记录值 `2c5744…` ≠ 文件值 `e2c858…`。差异来源可确定：Slice 1.1 修正把整份脚本包进 `BEGIN IMMEDIATE … COMMIT`、并收紧了 T1 的身份前缀校验（见 `P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md` §3.1、§5.3），文件因此被改写，而这两个库建于改写之前（2026-11-16 16:59 / 11-20 16:01）。
- 直接后果一：对这两个库执行 `prisma migrate deploy` 会因 checksum 漂移被拒绝（详见运维手册第 3 节 E）。
- 直接后果二：它们含 `terminalDecidedBy = 'seed:demo-data'` 的行——该值不在 `TERMINAL_DECIDED_BY_IDENTITIES` 的 7 个身份内，当前 T1 会 `RAISE(ABORT)`。这说明它们是**旧 seed 产物**，不能代表当前 schema + seed 的行为。
- 判定：**一次性产物，无保留价值**。不要试图 `resolve` 或补写，直接按 §8 重建。

### 4.2 D2 `fresh.db`：空库验证产物，checksum 也是旧的

- 0 行数据，7 条迁移全部 `finished_at` 非空；`journal_mode=delete`（不是 WAL），与运行时库不同。
- 记录值 `88213f…` 与 D1/D5 的 `2c5744…` 又不同，说明它是**更早一次**空库应用的结果（2026-11-16 15:54）。同一 Migration 目录在本机至少产生过三个不同 checksum 的产物。
- 判定：一次性产物。**注意它不在 DISPOSABLE 白名单**，`reset-database.mjs` 会拒绝删除它。

### 4.3 D3 `baseline.db`：Slice 1 之前的基线库

- 只有 6 条迁移，`Execution` 无 `terminalDecision` 列，0 个 Trigger，0 行数据。
- 它是「迁移前基线」的对照物（用于 `migration-existing-database` 场景的手工准备）。
- 判定：一次性产物，但**语义上是「迁移前」样本**。删除前请确认 Slice 2 不再需要一份真实的历史形态库；若需要，应由 `git` 中的 6 条迁移重新生成，而不是保留这个文件。

### 4.4 两个库存在未清理的 `-journal`

`fresh.db-journal` 与 `baseline.db-journal` 均为 37,448 字节，修改时间与主库相同（2026-11-16 15:47 / 15:54）。这表示**上次写入没有正常收尾**（进程中断或异常退出）。

- 本次核查在**不含 journal 的副本**上完成，因此表中行数/迁移条数是主库文件的形态，**不等于** SQLite 回滚后的形态。
- 若要确认这两个库的真实状态，必须在隔离副本中**连同 `-journal` 一起**打开（不要在原位置打开）。
- 这不影响清理结论（两者都是 0 行的一次性库），但**禁止**把它们当作任何形式的证据。

### 4.5 `reset-database.mjs` 白名单覆盖情况

`apps/api/scripts/reset-database.mjs:25`：

```js
const DISPOSABLE = new Set(['test.db', 'e2e.db', 'real-e2e.db']);
```

| 文件 | 是否被覆盖 | 说明 |
| --- | --- | --- |
| `test.db`（D1/D4/D5） | 是 | 名称匹配，且脚本只删 `''`/`-wal`/`-shm` |
| `fresh.db`（D2） | **否** | 名称不在集合内，脚本会 `exit 1` 拒绝 |
| `baseline.db`（D3） | **否** | 同上 |

补充两点（写手册时已一并记录）：

1. 脚本删除的旁文件只有 `''`、`-wal`、`-shm`，**不包含 `-journal`**。因此对 D2/D3 这类带 `-journal` 的文件，即使手工把名字改成白名单名称，也会留下 journal 残片。
2. 脚本按 `DATABASE_URL` 的 `file:` basename 判定，路径固定解析到 `apps/api/prisma/`。它不会、也不能处理本清单之外的位置。

### 4.6 是否存在无法恢复的重要测试数据

**否。** 依据：

- 5 个库中 3 个为 0 行；另 3 个（D1/D4/D5）只有 demo seed 的 9 类固定行，且 `demo-data.ts` 使用 `upsert` + 固定 `SEED_IDS`，可由 `pnpm --filter @raft-lite/api db:seed` 幂等重建。
- 没有任何 `RepositoryHandshakeMessage` / `ExecutionRegistrationAudit` 行——即没有任何真实的握手/审计证据会随删除而丢失。
- 没有任何库被 `.env.test` / `.env.e2e` / `.env.real-e2e` 之外的东西引用；`baseline.db`、`fresh.db` 无脚本引用。
- 迁移历史的唯一权威来源是 `apps/api/prisma/migrations/`（在 git 中），不在数据库里。

---

## 5. 共享 / 生产环境：UNVERIFIED

本清单**只覆盖本机 worktree**。对任何共享或生产 SQLite 实例：

- 本轮未连接、未查询、未取得任何证据；
- **不得**假定其已应用或未应用 Slice 1 Migration；
- **不得**假定其 checksum 与当前文件一致；
- 状态保持 **UNVERIFIED**，直到环境所有者出具 `_prisma_migrations` 与 `sqlite_master` 的实际输出。

判定共享环境状态的唯一方式见运维手册 §2（执行前检查）与 §3（失败诊断），并且必须由环境所有者执行。

---

## 6. 待确认事项（需要人决策，不在本轮自行决定）

| # | 事项 | 需要谁确认 | 默认处置（未确认前） |
| --- | --- | --- | --- |
| Q1 | D1（Slice 1 worktree `test.db`）是否需要在删除前留档？ | 项目负责人 | 先按 §8.1 隔离备份，再删 |
| Q2 | D5（review worktree `test.db`）同上 | 独立复审人 | 同上 |
| Q3 | D3 `baseline.db` 是否作为「迁移前形态」样本保留？ | 项目负责人 | 保留，暂不删 |
| Q4 | 是否把 `fresh.db` 加入 DISPOSABLE 白名单（或改名归档）？ | 项目负责人 | 不改代码，按 §8.2 手工归档 |
| Q5 | 共享/生产环境是否已应用 Slice 1 Migration？ | 环境所有者 | 保持 UNVERIFIED |
| Q6 | 重建后是否需要重新 seed demo 数据？ | 项目负责人 | 默认不 seed（测试库由 `pnpm test` 自行 reset） |

---

## 7. 本轮明确未做的事

- 未删除、未移动、未重命名、未覆盖、未重建任何数据库；
- 未执行 `prisma migrate deploy` / `migrate resolve` / `db push`；
- 未修改 `reset-database.mjs` 或任何脚本；
- 未改动 `apps/api/prisma/migrations/` 下任何文件；
- 未连接共享环境。

---

## 8. 后续安全清理步骤（待授权后执行）

以下步骤**本轮未执行**，仅为批准后的操作顺序。每一步的判据都必须当场核对，不能「按记忆执行」。

### 8.0 前置条件

1. 已确认目标路径属于本机 worktree，且 `git status` 干净（或已记录未跟踪文件清单）。
2. 已确认目标环境：本机 / 共享。**共享环境需要环境所有者书面确认**，并改用运维手册 §2 的检查清单。
3. 已确认没有进程持有目标文件（Windows 下用 `handle`/资源监视器确认，Linux 下 `lsof`）。

### 8.1 清理前隔离（先备份，不先删）

```bash
# 例：D1
mkdir -p <archive>/2026-11-24-slice1-test-db
cp "D:/CODE/GIT/Haft-p2-02-wpd-slice1/apps/api/prisma/test.db" \
   <archive>/2026-11-24-slice1-test-db/test.db
cp "D:/CODE/GIT/Haft-p2-02-wpd-slice1/apps/api/prisma/test.db-shm" \
   <archive>/2026-11-24-slice1-test-db/ 2>/dev/null || true
sha256sum <archive>/2026-11-24-slice1-test-db/test.db
```

判据：归档副本 SHA256 与 §3.2 表中值一致（D1 `da6a7795…`、D5 `af7f0d9f…`）。不一致则停止，不要继续。

> 归档不是「备份生产数据」，只是保留现场。**不要**把归档放在仓库目录内（会被误提交）。

### 8.2 清理（只在白名单内自动删；其余手工）

```bash
# 白名单内的三个 test.db：用脚本删，避免手写 rm
cd "D:/CODE/GIT/Haft-p2-02-wpd-slice1/apps/api"
DATABASE_URL="file:./test.db" node scripts/reset-database.mjs
```

```bash
# fresh.db / baseline.db：不在白名单，手工删除前必须先隔离（§8.1）
# 且必须连同 -journal 一起处理，否则会留下残片
```

判据：脚本输出 `removed test.db, test.db-wal, test.db-shm` 或 `no existing files`；删除后 `ls` 确认目标文件不存在。

### 8.3 用当前冻结的 Migration 重建

```bash
cd "D:/CODE/GIT/Haft-p2-02-wpd-slice1-1/apps/api"
pnpm --filter @raft-lite/api db:deploy   # = prisma migrate deploy，只走 migration，不走 db push
```

判据：输出 `7 migrations applied` / `No pending migrations`，退出码 0。任何 `P3018` / `P3009` 一律按运维手册 §3 诊断，**不得**直接 `resolve --applied`。

### 8.4 对照文件 SHA256 与数据库记录

```bash
sha256sum apps/api/prisma/migrations/*/migration.sql
```

再用只读查询比对 `_prisma_migrations.checksum`（命令见运维手册 §6.1）。判据：7 条记录逐条等于 §3.1 表中值。

### 8.5 验证 Schema、Trigger、Index 与完整性

```bash
pnpm --filter @raft-lite/api db:migrate:verify
```

判据：输出 `7 migrations / no drift / 10 triggers / 6 indexes`，退出码 0。该脚本在临时目录重建空库，不碰任何现有数据库。

再对目标库做一次只读检查（运维手册 §6.2）：`integrity_check = ok`、`foreign_key_check` 为空、10 个 Trigger 名称齐全、`Execution` 有 8 个新列。

### 8.6 回滚路径

若 §8.3 失败：

1. 停止，不重试；
2. 按运维手册 §3 判定属于 A–E 哪一种；
3. 只有在满足运维手册 §4 或 §5 的全部前置条件时，才允许 `resolve --applied` / `resolve --rolled-back`；
4. 任何情况下都不得用 `db push` 收尾。

---

## 9. 与其它交付物的关系

- 清理与重建的**操作口径**：`docs/operations/WP-D_SQLITE_MIGRATION_RUNBOOK.md`（G2）
- Slice 2 不得触碰的边界：`docs/engineering/P2-02_WP-D_SLICE2_SCOPE_AND_ENTRY_CONTRACT.md`（G5）
- `INSERT OR REPLACE` 相关风险：`docs/engineering/P2-02_WP-D_REPLACE_RISK_ACCEPTANCE.md`（G4）
