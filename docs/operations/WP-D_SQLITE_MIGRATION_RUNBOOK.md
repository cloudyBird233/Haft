# WP-D SQLite Migration 运维手册

适用范围：`apps/api` 的 Prisma + SQLite 迁移链（当前 7 条迁移，含 WP-D Slice 1 的
`20261116120000_p2_02_wpd_slice1_schema_migration`）
读者：**没有参与 WP-D 开发的工程师**，按本手册可独立判断、执行与验证
状态：Slice 1 收尾产出，随 `feature/p2-02-wpd-slice1-1-remediation` 提交
最后更新：2026-11-24

> 本手册只描述「如何安全地部署、诊断与恢复迁移」。它不授权任何人改动已应用的
> Migration 文件、手工改写 `_prisma_migrations`、或用 `db push` 绕过迁移链。

---

## 0. 命令速查与风险标注

所有命令都标注三件事：**适用场景 / 执行前提 / 风险**。没有标注的命令不要执行。

| 命令 | 场景 | 风险 |
| --- | --- | --- |
| `pnpm --filter @raft-lite/api db:deploy` | 把未应用的迁移应用到目标库 | 低。只执行 migration 链；失败时按 §3 诊断 |
| `pnpm --filter @raft-lite/api db:migrate:verify` | 验证迁移链能否从空库重建 schema，且 Trigger/Index 齐全 | 无。脚本自建临时库，不碰任何现有库 |
| `prisma migrate status` | 读状态：哪些已应用、哪些待应用、是否有失败记录 | 无（只读） |
| `prisma migrate diff` | 比较两个 schema 来源的差异 | 无（只读） |
| `prisma migrate resolve --applied` | 声明某条迁移「已应用」 | **高**。会让 Prisma 跳过该迁移；条件见 §4 |
| `prisma migrate resolve --rolled-back` | 声明某条迁移「已回滚」 | **高**。会允许重跑；条件见 §5 |
| `prisma migrate dev` | 本地开发：生成新迁移 | **禁止用于共享/生产**（会尝试 reset） |
| `prisma db push` | 直接把 datamodel 推到库 | **本仓库全面禁止**，见 §7 |

统一的工作目录与前置：

```bash
cd apps/api
pnpm install --frozen-lockfile        # 依赖必须与 lockfile 一致
pnpm exec prisma generate             # 仓库无 postinstall，必须显式生成客户端
```

> 为什么必须显式 `generate`：本仓库没有 `postinstall` 钩子，`@prisma/client` 在
> pnpm workspace 下安装后是空 stub，`prisma migrate *` 之外的代码路径会拿不到模型。
> 这是既有门禁缺口（独立复审 P3-10），不是迁移本身的问题。

---

## 1. Migration 基本原则

1. **已应用的迁移不得就地修改。** 迁移一旦被某个环境执行，`migration.sql` 的任何
   字节变化都会改变 `_prisma_migrations.checksum`，下次 `migrate deploy` 会把该环境
   判为「迁移被篡改」并拒绝继续（§3 E）。修正只能靠**新的 forward migration**。
2. **后续修改一律新增 forward migration。** 包括：补 Trigger、加索引、修数据。
   不允许「删掉旧迁移重写一遍」。
3. **迁移必须串行执行。** 同一数据库上同时跑两个 `migrate deploy` 会互相踩
   `_prisma_migrations` 的写入与锁。CI 的 `concurrency` 只保证同一分支不并发，
   不保证跨流水线/跨人工操作不并发——部署窗口必须人为串行化。
4. **`BEGIN IMMEDIATE` 不等于跨进程迁移互斥。** 它只是让**单个 migration 文件**内的
   语句全有或全无（Prisma 不会为 SQLite 的单个迁移文件开事务，这是 Slice 1.1 实测
   确认的事实）。两个进程各自 `BEGIN IMMEDIATE` 仍会先后排队执行同一批语句，
   第二个会撞上已存在的表/列。**互斥必须靠部署流程，不能靠 SQL。**
5. **数据库是执法层，不是建议层。** 本迁移链创建 10 个 Trigger 来强制终态元组、
   六态状态机、start 时钟、注册 epoch、握手证据与审计 append-only。任何一个 Trigger
   缺失，数据库层不变量就静默失效——所以「表结构对了」不等于「迁移成功了」（§4）。

---

## 2. 执行前检查

**场景**：任何一次对非临时库执行 `migrate deploy` 之前。
**前提**：能读到目标库文件与其 `DATABASE_URL`。
**风险**：跳过本节是绝大多数迁移事故的起点。

### 2.1 确认目标库是哪一个

```bash
# 从环境文件确认，不要凭记忆
grep DATABASE_URL apps/api/.env.test apps/api/.env.e2e apps/api/.env.real-e2e 2>/dev/null
```

SQLite 的 `file:./x.db` 是**相对 `apps/api/prisma/` 解析**的。所以
`file:./test.db` = `apps/api/prisma/test.db`。判定目标前必须先做这一步。

> 本仓库不提供 `.env`（只有 `.env.example`），因此 `prisma migrate *` 在没有
> `dotenv -e <envfile>` 时**不会**指向任何库。任何「它自己找到了数据库」的印象都是错的。

### 2.2 记录迁移文件 checksum

```bash
sha256sum apps/api/prisma/migrations/*/migration.sql
```

保存输出。这是后续所有比对的基准；不要用「我记得是 e2c858…」代替当场计算。

### 2.3 读取当前迁移状态

```bash
cd apps/api
pnpm exec dotenv -e .env.test -- prisma migrate status --schema prisma/schema.prisma
```

关注三件事：

- 是否有 `failed` 迁移（有则先看 §3 D，**不要**直接 deploy）；
- 是否有 `not yet applied`（正常，属于本次要应用的）；
- 已应用条数与预期是否一致（当前链共 7 条）。

### 2.4 读取数据库实际形态（只读）

```bash
# 用 node:sqlite 直读，不经过 Prisma；对副本执行更安全
node -e "const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
console.log('integrity:', JSON.stringify(all('PRAGMA integrity_check')));
console.log('fk:', JSON.stringify(all('PRAGMA foreign_key_check')));
console.log('triggers:', all('SELECT name FROM sqlite_master WHERE type = ?', 'trigger').map((r) => r.name).join(','));
console.log('migrations:', JSON.stringify(all('SELECT migration_name, finished_at, rolled_back_at, checksum FROM _prisma_migrations ORDER BY started_at'), null, 1));
db.close();" apps/api/prisma/test.db
```

**期望**：`integrity: ok`、`fk: []`、7 条迁移且 `rolled_back_at` 全为 `NULL`、
10 个 Trigger 齐全。

**注意**：如果库旁边有 `-wal` / `-shm` / `-journal`，只读打开主文件看到的不一定是
SQLite 的真实视图。对**有疑点的库**，把 `.db` 与全部旁文件复制到临时目录后再读。

### 2.5 备份

**场景**：任何非一次性库。
**前提**：磁盘空间足够，且已确认没有进程持有该文件。
**风险**：SQLite 的备份不能用「复制正在写入的 `.db`」代替。

```bash
# 推荐：SQLite 在线备份（一致性快照）
sqlite3 <db> ".backup '<backup-path>'"
# 若没有 sqlite3 CLI，必须先停掉所有写入方，再连同 -wal/-shm 一起复制
```

判据：备份文件能被 `PRAGMA integrity_check` 打开并返回 `ok`。**备份不可打开 = 没有备份。**

### 2.6 检查完整性

```bash
sqlite3 <db> "PRAGMA integrity_check; PRAGMA foreign_key_check;"
```

判据：`ok` 且无输出（外键检查为空）。任一失败 → 停止，先处理数据完整性问题，
不要在这个库上应用迁移。

---

## 3. 迁移失败后的诊断

先分类，再动手。**五类失败的处置完全不同，误判会把「可恢复」变成「不可恢复」。**

判定的第一手证据永远是：`migrate deploy` 的完整输出 + `_prisma_migrations` 的实际行 +
`sqlite_master` 的实际对象。

### A. Migration 完全未执行

**特征**

- `migrate deploy` 在第一条语句前就失败（连接失败、`DATABASE_URL` 指错、schema 解析失败、
  `P1001`/`P1003` 之类）；
- `_prisma_migrations` 里没有这条迁移的行，或只有 `started_at` 没有 `finished_at`；
- `sqlite_master` 中该迁移应创建的对象**一个都不存在**。

**处置**

1. 修正外部原因（路径、权限、env 文件）；
2. 直接重跑 `db:deploy`；
3. **不需要** `resolve`。

**风险**：低。这是唯一可以「直接重试」的情形。

### B. Migration 中途失败，DDL 未提交

**特征**

- 当前 Migration 链带显式 `BEGIN IMMEDIATE … COMMIT`（第 24 行 / 第 556 行），
  所以**中途任何语句失败都会整体回滚**；
- `_prisma_migrations` 中该迁移 `finished_at IS NULL`、`rolled_back_at IS NULL`；
- `sqlite_master` 中该迁移的对象**全部不存在**（列、表、索引、Trigger 都没有）。

**验证（必须做，不能假设）**

```bash
node -e "const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const cols = all('PRAGMA table_info(Execution)').map((c) => c.name);
console.log('newColumns:', ['terminalDecision', 'startSentAt', 'registrationId'].filter((c) => cols.includes(c)));
console.log('newTables:', all('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)', 'table', 'RepositoryHandshakeMessage', 'ExecutionRegistrationAudit'));
console.log('triggerCount:', all('SELECT count(*) AS c FROM sqlite_master WHERE type = ?', 'trigger')[0].c);
db.close();" <db>
```

**期望**：`newColumns: []`、`newTables: []`、`triggers: 0`（针对 Slice 1 迁移）。

**处置**

1. 清理 Prisma 的失败记录（§5，条件全部满足才行）：
   `prisma migrate resolve --rolled-back 20261116120000_p2_02_wpd_slice1_schema_migration`
2. 重跑 `db:deploy`；
3. 按 §6 验证。

**风险**：中。若对象**不是**全空（例如部分列已存在），说明不是 B 而是 C——**不要**走这条路径。

### C. SQL 已 COMMIT，但 Prisma 元数据未写入

**特征**

- 数据库对象**已全部存在**（列、表、索引、Trigger 齐全）；
- `_prisma_migrations` 中该迁移 `finished_at IS NULL`；
- 通常是进程在 `COMMIT` 之后、Prisma 写元数据之前被杀（断电、Ctrl-C、容器重启）。

**判定要点**：这不是「迁移没做」，而是「做了但没记账」。

**处置**

1. 按 §4 的**全部**条件逐条验证；
2. 全部满足才 `prisma migrate resolve --applied <migration_name>`；
3. 再跑 `db:deploy`（应当报告无待应用迁移）；
4. 按 §6 验证。

**风险**：**高**。若跳过 §4 的任一条，你会得到一个「看起来成功、实际缺 Trigger」的库——
这正是本切片要消灭的失败形态。

### D. Prisma 已记录失败 Migration

**特征**

- `_prisma_migrations` 中该迁移有行、`finished_at IS NULL`、`logs` 非空；
- 后续 `migrate deploy` 直接报 `P3009`（"migrate found failed migrations"）并拒绝执行
  **任何**迁移。

**处置**

1. 先按 A/B/C 判定数据库实际处于哪一种状态；
2. 属于 B → `resolve --rolled-back` 后重试；
3. 属于 C → 按 §4 验证后 `resolve --applied`；
4. 属于「部分提交」（既有列又有缺 Trigger）→ **停下来**，按 §4 的失败分支处理，
   即：不允许 resolve，必须人工评估后写 forward migration 或重建库。

**风险**：高。`P3009` 是保护，不是故障；绕过它而不判状态是最常见的错误。

### E. Migration checksum 不一致

**特征**

- `migrate deploy` 报迁移已被修改 / checksum 不匹配；
- `_prisma_migrations.checksum` 与当前 `migration.sql` 的 SHA256 不同。

**已知实例（本机）**：Slice 1 worktree 与 review worktree 的 `test.db` 记录的是
`2c5744…`，当前文件是 `e2c858…`；`fresh.db` 记录的是 `88213f…`。
原因是 Slice 1.1 修正改写了该文件（加事务边界、收紧 T1 身份校验），而这些库建于改写之前。
详见 `docs/operations/WP-D_SLICE1_DATABASE_CLEANUP_INVENTORY.md`。

**处置（按环境性质二选一）**

- **一次性库**（`test.db` / `e2e.db` / `real-e2e.db`）：删掉重建，不要 resolve。
  ```bash
  cd apps/api && DATABASE_URL="file:./test.db" node scripts/reset-database.mjs
  pnpm --filter @raft-lite/api db:deploy
  ```
- **有数据的库**：**不得**为了消除告警而修改文件或改 checksum。正确做法是：
  1. 判定该库实际应用的是哪一版内容（比对 `sqlite_master` 与两版 SQL 的差异）；
  2. 若差异只是注释/事务边界且对象完全一致 → 仍需评审后才能决定是否
     `resolve --applied` 重建记录（**需要书面批准，不在本手册的自动授权范围**）；
  3. 若差异涉及对象 → 视为「该库未应用当前迁移」，用 forward migration 补齐，
     并单独记录这一偏差。

**风险**：高。改文件「修好」checksum 是最具破坏性的做法：它会让所有已应用环境
在下次部署时一起失败。

> **关于 `migration.sql` 第 88–92 行的注释（含第 91 行引用 `db:migrate:verify`）**
>
> 该注释是对紧随其后的 Partial Unique Index
> `RepositoryHandshakeMessage_execution_start_unique` 的说明，声称该索引由
> `pnpm --filter @raft-lite/api db:migrate:verify` 校验、且不会被 `prisma migrate dev`
> 重新生成。无论这段措辞是否足够精确，**都不得通过编辑该文件来"修正"**：任何字节变化
> 都会改变 checksum，把「注释不精确」升级成「所有已应用环境的迁移校验失败」。
> 以本手册 §6.1 与 `db:migrate:verify` 的实际检查项为准（该脚本的 `requiredIndexes`
> 确实包含此索引）。若确实需要澄清，只能在**新的 forward migration 的注释里**、
> 或在文档中说明。

---

## 4. `resolve --applied` 的使用条件

**场景**：数据库对象已存在，但 Prisma 没有记录（§3 C）。
**前提**：以下**每一条**都必须当场验证通过，缺一条就不得使用。
**风险**：高。`--applied` 让 Prisma 永远跳过这条迁移；判断错了，数据库将永久缺失该迁移
本应建立的对象，而且此后再没有任何机制会发现。

逐条检查（以 Slice 1 迁移为例）：

1. **所有预期表和列存在**
   ```sql
   PRAGMA table_info("Execution");      -- 必须含 registrationId / registrationEpoch / startSentAt /
                                        -- startAcceptDeadlineAt / recoveryDeadlineAt /
                                        -- terminalDecision / terminalDecidedAt / terminalDecidedBy
   PRAGMA table_info("Runner");         -- 必须含 registrationId / registrationEpoch / lastRegisteredAt
   PRAGMA table_info("RepositoryHandshakeMessage");   -- 18 列
   PRAGMA table_info("ExecutionRegistrationAudit");   -- 13 列
   ```
2. **所有必要索引存在**
   ```sql
   SELECT name FROM sqlite_master WHERE type='index' AND name IN (
     'Runner_registrationId_key','Runner_lastRegisteredAt_idx',
     'Execution_status_dispatchState_idx','Execution_runnerId_registrationEpoch_idx',
     'Execution_recoveryDeadlineAt_idx','Execution_terminalDecision_idx',
     'RepositoryHandshakeMessage_messageId_key',
     'RepositoryHandshakeMessage_executionId_messageType_attempt_key',
     'RepositoryHandshakeMessage_execution_start_unique',
     'RepositoryHandshakeMessage_executionId_messageType_createdAt_idx',
     'RepositoryHandshakeMessage_status_createdAt_idx','RepositoryHandshakeMessage_runnerId_status_idx',
     'ExecutionRegistrationAudit_executionId_createdAt_idx','ExecutionRegistrationAudit_runnerId_createdAt_idx');
   -- 必须返回 14 行
   ```
   并且 Partial Index 必须是 partial：
   ```sql
   PRAGMA index_list("RepositoryHandshakeMessage");   -- execution_start_unique 的 partial 必须为 1
   ```
3. **所有必要 Trigger 存在（10 个，一个都不能少）**
   ```sql
   SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;
   -- Execution_terminal_insert_guard / Execution_terminal_update_guard / Execution_terminal_write_guard /
   -- Execution_dispatch_transition_guard / Execution_start_clock_guard / Runner_registration_guard /
   -- RepositoryHandshakeMessage_insert_guard / RepositoryHandshakeMessage_update_guard /
   -- ExecutionRegistrationAudit_insert_guard / ExecutionRegistrationAudit_no_update
   ```
4. **回填数据完整**
   ```sql
   SELECT status, terminalDecision, COUNT(*) FROM "Execution"
    WHERE status IN ('completed','failed') GROUP BY status, terminalDecision;
   -- completed 只能是 COMPLETED；failed 只能是 EXECUTION_FAILED
   SELECT COUNT(*) FROM "Execution"
    WHERE status IN ('completed','failed')
      AND (terminalDecision IS NULL OR terminalDecidedAt IS NULL
           OR terminalDecidedBy IS NULL OR typeof(terminalDecidedAt) <> 'integer'
           OR terminalDecidedAt <= 0);
   -- 必须为 0
   SELECT COUNT(*) FROM "Execution" WHERE status='cancelled' AND terminalDecision IS NOT NULL;
   -- 必须为 0（历史 cancelled 行不得被补写裁决）
   ```
5. **`integrity_check` 通过**
   ```sql
   PRAGMA integrity_check;      -- ok
   ```
6. **`foreign_key_check` 通过**
   ```sql
   PRAGMA foreign_key_check;    -- 空结果
   ```
7. **Schema 与预期迁移完全一致**

   ```bash
   cd apps/api
   pnpm exec dotenv -e .env.test -- prisma migrate diff \
     --from-url "file:<absolute-path-to-db>" \
     --to-schema-datamodel prisma/schema.prisma --script
   ```
   期望输出包含 `This is an empty migration`（即无差异）。

**只有 1–7 全部通过**，才执行：

```bash
cd apps/api
pnpm exec dotenv -e .env.test -- prisma migrate resolve \
  --applied 20261116120000_p2_02_wpd_slice1_schema_migration \
  --schema prisma/schema.prisma
pnpm --filter @raft-lite/api db:deploy
```

**绝对不允许**的理由：「表已经存在了」「反正 deploy 会报 P3009」「Trigger 以后再补」。
表存在只说明 DDL 跑过，不说明 Trigger 建立过——而本切片全部不变量都在 Trigger 里。

**若第 1–7 中有任何一条不通过**：不要 resolve。按 §3 B/C/D 重新分类，或重建库。

---

## 5. `resolve --rolled-back` 的使用条件

**场景**：迁移失败后需要重试，而 Prisma 记着这条失败记录（§3 B/D）。
**前提**：必须先证明「数据库确实回到了迁移前状态」。
**风险**：高。误判会让重试撞上已存在的对象，或在半迁移状态上继续叠加。

必须同时成立：

1. **Migration SQL 未完成 COMMIT**
   - `_prisma_migrations` 中该迁移 `finished_at IS NULL`；
   - `logs` 中存在失败语句的错误信息。
2. **数据库处于可确认的迁移前状态**
   - 该迁移应创建的对象**一个都不存在**（列/表/索引/Trigger 全空，按 §3 B 的验证脚本）；
   - 若是历史库回填场景：`terminalDecision` 列**不存在**（回填与列在同一事务内，一起回滚）。
3. **不存在已经提交的部分 Schema**
   - 只要发现**任一**对象已存在，就不满足此条件 → 转 §3 C。
4. **重试不会与已有对象冲突**
   - `CREATE TABLE` / `CREATE INDEX` / `CREATE TRIGGER` 都不带 `IF NOT EXISTS`；
     已有同名对象会让重试立即失败。

全部成立后：

```bash
cd apps/api
pnpm exec dotenv -e .env.test -- prisma migrate resolve \
  --rolled-back 20261116120000_p2_02_wpd_slice1_schema_migration \
  --schema prisma/schema.prisma
pnpm --filter @raft-lite/api db:deploy
```

**注意**：`--rolled-back` 只改 Prisma 的记账，**不会**回滚任何 SQL。它之所以安全，
前提是数据库本来就已经回滚了（当前 Migration 的 `BEGIN IMMEDIATE … COMMIT` 保证了这一点）。
如果数据库没回滚而你先 `--rolled-back`，你就在制造一个「对象存在但记录为空」的库。

---

## 6. 恢复后的验证

### 6.1 checksum 与记录对照

```bash
sha256sum apps/api/prisma/migrations/*/migration.sql
```

```sql
SELECT migration_name, checksum, finished_at IS NOT NULL AS applied, rolled_back_at
  FROM _prisma_migrations ORDER BY started_at;
```

**期望**：7 条，`applied` 全为 1，`rolled_back_at` 全为 `NULL`，每条 `checksum` 与
`sha256sum` 输出逐字符相等。

**失败处理**：不一致 → 不要改文件、不要改记录。按 §3 E 处理，并记录到部署日志。

### 6.2 结构与对象

```bash
pnpm --filter @raft-lite/api db:migrate:verify
```

**期望输出**（当前链）：

```
verify-migration-consistency: OK
  migrations applied from empty: 7
  datamodel drift: none (empty migration)
  required triggers present: 10
  required indexes present: 6
```

**失败处理**：

- `does not apply to an empty database` → 迁移链本身有问题，**停止部署**；
- `schema.prisma and the migration chain disagree` → 有人改了 datamodel 没写迁移，停止；
- `missing triggers` / `missing indexes` → 迁移链被弱化，停止。

该脚本在系统临时目录建库，**不会**碰目标库；它证明的是「迁移链能重建出正确结构」，
不证明「目标库就是那个结构」。目标库仍需 §6.3。

### 6.3 目标库自身的完整检查

```sql
PRAGMA integrity_check;        -- ok
PRAGMA foreign_key_check;      -- 空
SELECT COUNT(*) FROM sqlite_master WHERE type='trigger';   -- 10
SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';  -- 46
```

再抽查一条 Trigger 的正文确实存在（不是同名空壳）：

```sql
SELECT sql FROM sqlite_master WHERE name='Execution_terminal_update_guard';
```

**失败处理**：Trigger 数量不足 → 按 §4 判定是否属于「结构在、Trigger 缺」，
这种情况**不允许** resolve，只能重建或写 forward migration 补 Trigger。

### 6.4 行为验证（可选但推荐）

对一次性库执行应用测试套件，让 Trigger 真的被触发一次：

```bash
pnpm --filter @raft-lite/api test -- test/database-triggers.integration.spec.ts
pnpm --filter @raft-lite/api test -- test/migration.integration.spec.ts
```

**期望**：全绿。任何一条 Trigger 被删除或弱化，这些用例会失败。

---

## 7. 禁止操作

以下行为**一律禁止**，无论出于何种「快速修复」的理由：

1. **用 `db push` 绕过 Migration。** 它直接按 datamodel 建表，不写 `_prisma_migrations`，
   也不创建任何 Trigger——得到一个「schema 对、不变量全无」的库，且此后无法用
   `migrate deploy` 对齐。本仓库的 npm script 已移除 `db push`。
2. **手工删除 `_prisma_migrations` 记录。** 删记录等于让 Prisma 认为迁移没做过，
   下一次 deploy 会在已有对象上重跑并失败；或更糟：把已迁移的库当成空库。
3. **未经检查手工补写 Trigger。** 手工补的 Trigger 与 migration 中的版本一旦有差异，
   `db:migrate:verify` 与 `database-triggers.integration.spec.ts` 都会失真。
   需要补 Trigger 就走 forward migration。
4. **不检查数据库状态就执行 `resolve`。** `resolve` 是记账操作，不是修复操作；
   它不会改变数据库，所以它也无法修复数据库。
5. **并发执行多个 Migration 部署任务。** 见 §1.3/§1.4。
6. **修改已应用的 `migration.sql`（含只改注释）。** 见 §3 E 的注释说明。
7. **对共享/生产库执行 `prisma migrate dev` / `migrate reset`。** 二者都可能 reset。

---

## 8. 术语与事实来源

| 术语 | 含义 | 来源 |
| --- | --- | --- |
| 迁移链 | `apps/api/prisma/migrations/` 下按目录名排序的 7 个迁移 | 仓库 |
| 六态 | `created` / `repository_preparing` / `repository_ready` / `start_sent` / `running` / `terminal` | `P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md` §3 |
| 13 个终态裁决 | `terminalDecision` 的合法取值集合 | 同上 §1 |
| 终态元组 | `terminalDecision` + `terminalDecidedAt` + `terminalDecidedBy` | 同上 §3 |
| 执法点 T1–T10 | 10 个 SQLite Trigger | 同上 §5 |
| 原子性 | 单文件迁移的 `BEGIN IMMEDIATE … COMMIT` | `P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md` §5 |

相关文档：

- `docs/operations/WP-D_SLICE1_DATABASE_CLEANUP_INVENTORY.md`（本机数据库清单）
- `docs/engineering/P2-02_WP-D_SLICE1_IMPLEMENTATION_REPORT.md`（Slice 1 实施）
- `docs/engineering/P2-02_WP-D_SLICE1_1_REMEDIATION_REPORT.md`（原子性修复与故障注入）
- `docs/engineering/P2-02_WP-D_L2_V1_1_CONTRACT_BASELINE.md`（冻结契约）
