# P2-01 — Project CRUD and repository bindings

Status: implemented on `feature/p2-01-project-crud-repository-binding`.
P2-02 is **not** implemented in this change.

This document describes the P2-01 slice only: Project lifecycle management, the
`ProjectRepositoryBinding` data model and CRUD, and the execution guard that
prevents a real Runner execution while a binding is not validated. It also
records the work that intentionally remains in P2-02.

## Scope and responsibility split

| Concern                                              | P2-01  | P2-02                                      |
| ---------------------------------------------------- | ------ | ------------------------------------------ |
| Project CRUD, archive/restore, default branch        | Yes    | —                                          |
| `ProjectRepositoryBinding` model and CRUD            | Yes    | —                                          |
| Binding path storage, `pathHash`, `bindingVersion`   | Yes    | —                                          |
| Binding creation always `unverified`                 | Yes    | —                                          |
| Real-execution guard for missing/unverified bindings | Yes    | —                                          |
| Execution repository snapshot                        | Yes    | —                                          |
| Archived-project execution guard                     | Yes    | —                                          |
| `repository.validate` / `repository.validation`      | **No** | Yes                                        |
| Runner repository path policy and allowed roots      | **No** | Yes                                        |
| Writing `ready`, `missing`, or `error` from the API  | **No** | Yes (only from a matching Runner response) |
| `repoUrl` / clone / fetch metadata                   | **No** | Out of Phase 2 scope                       |

P2-01 never contacts a Runner for Project or Binding operations. The API may
only send Runner messages for an actual execution start and its normal
lifecycle. There is no `POST .../bindings/:id/validate` route, no pending
validation cache, and no Runner capability requirement for binding CRUD.

The dependency direction is fixed: `P2-00 → P2-01 → P2-02`. P2-01 does not
call `repository.validate` and does not assume that any validation has
succeeded. P2-02 consumes the Binding model delivered here.

## Data model

### Project

Added to the existing `Project`:

| Column          | Type      | Notes                                                |
| --------------- | --------- | ---------------------------------------------------- |
| `defaultBranch` | String    | Default `main`; the sole authoritative branch        |
| `archivedAt`    | DateTime? | `null` = active; archives block tasks and executions |

`repoUrl` is deliberately **not** added. Phase 2 executes local paths on the
Runner host; URL/clone behavior is not part of the P2-01 or P2-02 scope.

Project keys remain unique per workspace, are trimmed and upper-cased, and can
be changed only by creating a new project. `PATCH /api/projects/:id` mutates
`name`, `description`, `color`, `defaultBranch`, and `archived`; `key` and
`archivedAt` are rejected by the strict schema.

### ProjectRepositoryBinding

| Column                    | Type          | P2-01 behavior                                     |
| ------------------------- | ------------- | -------------------------------------------------- |
| `id`                      | String, PK    |                                                    |
| `projectId`               | FK → Project  | Cascade delete                                     |
| `computerId`              | FK → Computer | Cascade delete                                     |
| `path`                    | String        | Stored verbatim; never normalized by the API       |
| `pathHash`                | String        | SHA-256 of the exact path bytes                    |
| `bindingVersion`          | Int           | Starts at 1; increments only on a real path change |
| `platform`                | String?       | Reserved for P2-02 Runner metadata                 |
| `status`                  | String        | Always `unverified` in P2-01                       |
| `validationRequestId`     | String?       | Reserved for P2-02 request correlation             |
| `canonicalPath`           | String?       | Reserved for P2-02 Runner realpath                 |
| `validationErrorCode`     | String?       | Reserved for P2-02 concrete `REPO_*` failures      |
| `validationError`         | String?       | Reserved for P2-02 human-readable failures         |
| `lastValidatedAt`         | DateTime?     | Reserved for P2-02 validation timestamps           |
| `validatedByRunnerId`     | FK → Runner?  | Reserved for P2-02 validators; `SetNull` on delete |
| `validatedBindingVersion` | Int?          | Reserved for the version that produced a success   |
| `policyVersion`           | String?       | Reserved for the P2-02 path-policy fingerprint     |
| `createdAt`, `updatedAt`  | DateTime      |                                                    |

Unique on `(projectId, computerId)`; indexed by `(projectId, status)`,
`computerId`, and `validatedByRunnerId`. There is no `defaultBranch` column on
the binding: the Project is the only branch authority, and every Execution
captures a branch snapshot.

### Binding state model

The contract fixes four states:

| Status       | Meaning in P2-01                         | Who may write it |
| ------------ | ---------------------------------------- | ---------------- |
| `unverified` | The default and only P2-01 product state | P2-01 API        |
| `ready`      | Validation succeeded for this version    | P2-02 only       |
| `missing`    | The validated path no longer exists      | P2-02 only       |
| `error`      | Validation failed for another reason     | P2-02 only       |

P2-01's REST API must never write `ready`, `missing`, or `error`. Test fixtures
may seed `ready` for success-path tests (see [Testing](#testing)), but that is
not a product API and is never mounted unless `E2E_TEST_MODE=true`.

A real execution requires `status = ready` **and**
`validatedBindingVersion = bindingVersion`. A ready binding whose version is
stale is still blocked.

## API

| Method   | Path                                    | Notes                                             |
| -------- | --------------------------------------- | ------------------------------------------------- |
| `GET`    | `/api/projects`                         | List with task/execution/binding counts           |
| `POST`   | `/api/projects`                         | Create                                            |
| `GET`    | `/api/projects/:id`                     | Detail plus bindings                              |
| `PATCH`  | `/api/projects/:id`                     | Update metadata or archive/restore                |
| `DELETE` | `/api/projects/:id`                     | Reject with `PROJECT_HAS_TASKS` when tasks exist  |
| `GET`    | `/api/projects/:id/bindings`            | List bindings                                     |
| `POST`   | `/api/projects/:id/bindings`            | Create; always `unverified`, version 1            |
| `PATCH`  | `/api/projects/:id/bindings/:bindingId` | Change only `path`; bump version and reset status |
| `DELETE` | `/api/projects/:id/bindings/:bindingId` | Delete                                            |

Create a project:

```json
{
  "key": "HAFT",
  "name": "Haft Platform",
  "description": "Phase 2 project management",
  "color": "#6f6a60",
  "defaultBranch": "main"
}
```

Create a binding:

```json
{
  "computerId": "computer_local",
  "path": "D:\\code\\haft-work"
}
```

The response has `status: "unverified"`, `bindingVersion: 1`,
`canonicalPath: null`, `validatedBindingVersion: null`, and
`lastValidatedAt: null`. Creating a second binding for the same
`(projectId, computerId)` returns `409 BINDING_DUPLICATE_COMPUTER`.

`PATCH` accepts only `path`. Sending `defaultBranch`, `status`,
`bindingVersion`, `pathHash`, `canonicalPath`, `computerId`, or `id` returns
`400 BINDING_FIELD_IMMUTABLE`. Unknown fields return `400 VALIDATION_ERROR`.
Changing to a different path increments `bindingVersion`, recomputes
`pathHash`, and resets the binding to `unverified` with all validation metadata
cleared. A same-value PATCH leaves the version unchanged. A cross-project
binding request returns `404 BINDING_NOT_FOUND`.

### Archive behavior

`PATCH /api/projects/:id` with `{ "archived": true }` sets `archivedAt` and
blocks:

- creating a Task in the project (`409 PROJECT_ARCHIVED`);
- moving an existing Task into the project (`409 PROJECT_ARCHIVED`);
- starting any execution for a Task in the project (`409 PROJECT_ARCHIVED`).

Task creation performs a fast precheck and then re-reads the Project inside the
same database transaction that inserts the Task. Moving a Task to another
Project re-reads the target Project inside the update transaction. The
transactional read also verifies `Project.workspaceId`; a project from another
workspace is still `PROJECT_NOT_FOUND`.

A `PROJECT_ARCHIVED` rejection creates no Task, commits no Activity, and emits no
WebSocket task update. The Task remains in its source Project when a move is
rejected. Restoring with `{ "archived": false }` clears `archivedAt`.

The execution guard runs before the binding gate and again inside the
Execution-creation transaction. It creates no Execution and does not modify the
Task or Agent.

## Execution gate and snapshot

For a real runtime (`codex` or `opencode`), `startForTask` performs these checks
before creating an Execution:

1. The Task exists and the assigned Agent is not offline/busy/error.
2. The assigned Computer exists and is online.
3. The Project is not archived.
4. A binding exists for `(projectId, computerId)`; otherwise
   `409 PROJECT_BINDING_MISSING`.
5. The binding is `ready` for its current `bindingVersion`; otherwise
   `409 PROJECT_BINDING_NOT_READY`.
6. A connected Runner advertises the runtime for the project.

The deterministic in-process `execution-start` lock is only an optimization; it
is **not** the correctness mechanism for bindings.

Inside the same database transaction that creates the Execution, the service
re-reads:

- `Project.archivedAt` and `Project.defaultBranch`; and
- the binding `id`, `status`, `bindingVersion`, and
  `validatedBindingVersion`.

If the Project became archived, the start is rejected with
`409 PROJECT_ARCHIVED`. If the binding disappeared or its id/version/status
changed after the precheck, the start is rejected with
`409 PROJECT_BINDING_MISSING` or `409 PROJECT_BINDING_NOT_READY`. The
transactional rows are the source of the snapshot:

```json
{
  "repositoryProjectId": "project_demo",
  "repositoryBindingId": "cm...",
  "repositoryBindingVersion": 1,
  "repositoryDefaultBranch": "main"
}
```

`repositoryDefaultBranch` always comes from the transactional `Project` read,
never from the Task relation loaded before the precheck. A default-branch change
committed between the precheck and the transaction therefore cannot produce a
stale branch snapshot, and it does not cause a retry or a second
`execution.start` dispatch. The Mock Runtime path is unchanged: it creates no
repository snapshot and stores `repositoryDefaultBranch = null`.

A concurrent path change or re-validation therefore cannot produce an
Execution that points at a stale path/version. No Task/Agent state is committed
when the transaction rejects.

## Concurrency guarantees

| Race                                                          | Result                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Path change between precheck and Execution insert             | `409 PROJECT_BINDING_NOT_READY`; no Execution; Task/Agent unchanged         |
| Binding deleted between precheck and Execution insert         | `409 PROJECT_BINDING_MISSING`; no Execution                                 |
| Status/validated version changed between precheck and insert  | `409 PROJECT_BINDING_NOT_READY`; no Execution                               |
| Project archived between precheck and Execution insert        | `409 PROJECT_ARCHIVED`; no Execution                                        |
| Default branch changed between precheck and Execution insert  | Snapshot uses the transaction value; one Execution, one dispatch            |
| Project archived between Task precheck and Task insert        | `409 PROJECT_ARCHIVED`; no Task, Activity, or task WebSocket event          |
| Target Project archived between Task-move precheck and update | `409 PROJECT_ARCHIVED`; Task stays in its source Project; no Activity/event |
| Two starts racing for the same Task                           | Serialized by `execution-start`; one Execution, one active-run conflict     |
| Two bindings racing for the same Computer on one Project      | Unique `(projectId, computerId)` constraint                                 |

There is no correctness dependency on a browser-side lock, a front-end
pre-check, or an in-memory validation cache.

## Runner communication

P2-01 binding operations send **zero** Runner messages. In particular:

- no `repository.validate` dispatch;
- no handling of inbound `repository.validation`;
- no pending-validation map, timeout, or request id in the API;
- no Runner capability advertisement gate for binding CRUD;
- no Runner path policy, allowed-roots configuration, or repository cache in the
  Runner.

The frozen P2-00 protocol schemas for those messages remain in
`packages/contracts/src/runner-protocol.ts`; P2-02 will implement them. P2-01
only preserves the additive `RunnerCapabilities.features` field and serializer
parsing so the protocol remains forward compatible.

## Migration and history compatibility

Migration `20261109120103_p2_01_project_repository_binding`:

1. adds `Project.defaultBranch` with default `main` and `Project.archivedAt`;
2. creates `ProjectRepositoryBinding` and its unique/indexed constraints;
3. adds the four Execution snapshot columns;
4. rebuilds `Project` to add those columns while preserving every existing row
   and column; no unrelated data is changed.

All new Project columns are nullable/defaulted, so existing rows survive with
`defaultBranch = "main"` and `archivedAt = NULL`. Existing Executions receive
`NULL` snapshot columns until a new execution starts. The migration is
forward-only and does not delete Task, Agent, Execution, log, or artifact data.

### Rollback

The repository uses a forward-only SQLite migration history. Rolling back means
restoring the pre-P2-01 database backup/snapshot and reverting the code commit;
there is no production `down` migration. Do not edit an applied migration in a
deployed database. For a development database, delete the SQLite file and run
`pnpm db:migrate` / `pnpm db:seed` again.

## UI

- Projects list/cards show key, name, description, default branch, counts, and
  archived state. No repository URL is rendered.
- The create/edit dialog contains key, name, description, color, and default
  branch only.
- The project detail drawer lists bindings with computer, raw path, status,
  version, and validation timestamps.
- A new or path-changed binding is shown as `Unverified` with the message
  `Unverified. P2-02 repository validation is required before real execution.`
  There is no `Validate`, `Revalidate`, or runner-waiting action in P2-01.
- Task detail disables real execution for a missing/unverified/error/stale
  binding and states the explicit P2-02 reason. Mock execution is unaffected.

## Testing

- `packages/contracts/test/project-binding.test.ts` — project key/name/branch
  schemas, rejection of P2-02 fields, opaque binding paths, immutable PATCH
  passthrough, and the four status constants.
- `apps/api/test/projects.integration.spec.ts` — Project CRUD/counts, duplicate
  key, archive/restore, archived Task rejection, delete conflict,
  cross-workspace 404, binding CRUD/duplicate/`pathHash`/version/reset,
  immutable fields, absence of the validation route, archived execution
  rejection without side effects, and deterministic Task-creation /
  Task-migration archive races (no Task, Activity, or WebSocket task update).
- `apps/api/test/runner.integration.spec.ts` — missing/unverified/stale binding
  gates, zero Runner messages for binding CRUD, archived execution rejection
  with a connected Runner, Execution snapshot correctness, a deterministic
  binding-change race between precheck and Execution creation, and a
  deterministic default-branch change during `getAvailability` proving the
  branch snapshot comes from the execution transaction with exactly one
  `execution.start` dispatch.
- Web component tests cover the Projects page, project form, project detail
  drawer, unverified states, and Task execution hints.
- `tests/e2e/functional/projects-bindings.spec.ts` — UI loop: create Project →
  create Binding → observe `unverified` and no Validate action → create Task →
  confirm real execution is disabled with the explicit P2-02 reason and no
  Execution exists.
- Fake Runner and real-CLI success paths use the E2E-only
  `POST /__test__/projects/:projectId/bindings/:bindingId/ready` fixture to
  obtain a `ready` binding. That endpoint is compiled into
  `TestModule` only when `E2E_TEST_MODE=true`; it is not part of the product
  API and is never called by P2-01 business code.

## Final consistency verification

Verified on 2026-11-10 from baseline
`c14f8c704afc0535c9c99fdc5d3cffef64c017a1` with the final P2-01 consistency
fix applied.

| Scenario                                                                      | Automated coverage                                           | Result |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| Execution branch snapshot comes from the creation transaction                 | `runner.integration.spec.ts` default-branch race             | PASS   |
| Branch change does not cause a retry or duplicate `execution.start`           | same test, dispatch count assertion                          | PASS   |
| Archived Project cannot start an existing Task                                | `projects.integration.spec.ts`, `runner.integration.spec.ts` | PASS   |
| Binding is re-read inside the Execution-creation transaction                  | `runner.integration.spec.ts` binding-change race             | PASS   |
| Binding version change cannot produce a stale Execution snapshot              | same test, `repositoryBindingVersion` assertions             | PASS   |
| Failed start leaves Task/Agent state unchanged and sends no `execution.start` | same test plus archived-start test                           | PASS   |
| Binding CRUD sends zero Runner messages                                       | `runner.integration.spec.ts`                                 | PASS   |
| Task creation rejects a Project archived after the precheck                   | `projects.integration.spec.ts` Task-creation race            | PASS   |
| Task migration rejects a target Project archived after the precheck           | `projects.integration.spec.ts` Task-migration race           | PASS   |
| Rejected Task write creates no Task, Activity, or WebSocket task update       | both race tests                                              | PASS   |
| Mock Runtime behavior is unchanged                                            | API integration Mock Runtime tests                           | PASS   |

Local acceptance gate (2026-11-10):

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build` — PASS.
- Contracts 107, API 40, Runner 60, Web 41 deterministic tests — PASS.
- Playwright E2E 44 tests — PASS.
- `git diff --check` — PASS.

P2-01 still does not implement any P2-02 Runner validation, path policy, or
repository handshake behavior. The legacy `HAFT_RUNNER_PROJECTS` mapping is a
pre-P2-02 execution mechanism; until P2-02 replaces it, P2-01's binding status
guard blocks real CLI execution.

## P2-02 work still pending

- `repository.validate` server→Runner request and `repository.validation`
  response, including request correlation and idempotency.
- Writing `ready` only from a matching successful response for the exact
  `bindingVersion`; writing `missing`/`error` from classified failures.
- Runner repository path policy: `allowedRepositoryRoots`, realpath/containment
  checks, Git root/bare/linked-worktree checks, rejections for UNC/device paths,
  and `policyVersion`.
- Runner capability advertisement (`repository-validation-v1`,
  `repository-path-policy-v1`) and API fail-closed behavior when absent.
- `execution.repository` / `.accepted` / `.rejected` handshake and replacement
  of the legacy `HAFT_RUNNER_PROJECTS` execution mapping.
- The Web Validate/Revalidate action, validation error details, and canonical
  path/HEAD display.
- The `Project.repoUrl` question, if it is ever needed, belongs to a separately
  approved scope; Phase 2 currently executes local paths only.

Until P2-02 lands, every product-created binding remains `unverified` and
real execution is blocked by design. Mock execution and all Project/Binding
management flows remain fully usable.
