# Account-private shared Git workspaces

## Author compatibility and explicit idle migration

Shared object/dependency reuse is not an author-gate pass. An unmigrated bare
pool puts `core.bare=true` in common config. Enabling `worktreeConfig` without
moving that value can turn linked author trees into bare repositories. The
maintained author refusal remains unchanged.

`node scripts/shared-git-author-migration.mjs inspect <absolute-pool>` is read-only.
It pins the common configuration and complete bounded worktree inventory. The
writer accepts only a protected, owned bare pool without includes, a common
`core.worktree`, existing worktree configurations, or foreign configuration locks.
Unsupported/ambiguous topologies remain an operator-reviewed case.

After source qualification and a separately approved idle window, an already
admitted one-worker descendant may use `apply <pool> <plan-sha256> --confirm-idle`.
The flag is an operator assertion, not an automatic idle detector: a test slot
alone does not prove all worktrees idle. Do not run this during another author's
work, review, or Git operation. All Git clients must support worktreeConfig.

The writer preserves a private original config, stages the main-only bare value
before atomically publishing common config without that value, and verifies the
pool and linked trees. It neither edits refs/indexes/source nor retires worktrees.
Only its own inode-matched locks are removed. A partial staging/read-back failure
is retained for operator review, never retried or automatically rolled back.
Restore a backup only in a new reviewed idle window after checking intervening
configuration changes; a blind copy could overwrite new branch metadata.

No installed wrapper, live pool, scheduler, author admission limit, or pilot is
changed by merging this source. Qualify each profile and its maintained author
gate separately after any explicitly authorized adoption.

Research: [Git worktree configuration](https://git-scm.com/docs/git-worktree#_configuration_file)
documents the main-worktree exception and the required relocation of these keys.

Stage new unfiled author work in linked worktrees sharing one existing account's
Git object store. This source command neither migrates an active checkout nor
creates a clone, changes another profile's permissions, prunes history, installs
dependencies from the network or starts a service. It is not a filed-task dispatch
path: filed work retains its normal claims, shipped-credit checks and harness.

## Policy and use

`~/.config/remudero/git-storage.json` must be a private, singly linked, owned
regular file. Absence is disabled. Legacy unversioned local-helper configuration
is deliberately not upgraded or accepted implicitly. Example **disabled** policy:

```json
{"schema":"rmd-git-storage/v1","enabled":false}
```

An independently reviewed enabled policy names existing physical `pool`,
`parent`, `dependencyRoot` directories beneath the current account's home, an
explicit physical `dependencyDonor`, and `poolKind` of `existing-checkout` or
`qualified-bare`. Each account keeps its own Git metadata and dependency store;
sharing across its new worktrees does not require cross-user writable metadata.
A bare pool requires its matching full initial integrity receipt. Current Git
connectivity is checked after fetching; fragile object alternates are refused.

```sh
node --import tsx scripts/shared-workspace.mjs status
# Only from an already admitted one-worker author/worker descendant:
node --import tsx scripts/shared-workspace.mjs create unfiled
```

The create command verifies a genuine inherited one-worker identity and normal
native Mac pressure, preserving the existing 2-GiB new-workspace reserve. It does
not allocate, recover, release or replace any reservation. A bare operator shell
without an inherited worker returns NOT_RUN. No configuration or installed tool
is changed by this PR. Adoption must be separately qualified in both profiles.

Git operations use retained, bounded owned-process capture: at most 90 seconds
across Git phases, 30 seconds and 1 MiB output per phase, with terminal receipts
under the configured private parent. Auto-maintenance is disabled only for these
commands; normal checkout/push hooks remain intact. Dependency materialization
retains its maintained checks with no lock wait or fresh npm-install fallback;
its copy/read bounds are separate from the Git-phase budget, not a claim of full
runner or whole-job qualification.

Any uncertain dependency or post-creation read-back retains the new workspace
and failed receipts for harness retirement. There is no timestamp-based lease
removal, path reuse, retry, automatic worktree cleanup or Git pruning. A successful
fixture is not real fleet adoption, measured peak savings or pilot activation.

Git documents the shared object/ref model in its maintained
[worktree reference](https://git-scm.com/docs/git-worktree). Unlike borrowed
clone alternates, the owning common store remains explicitly retained.
