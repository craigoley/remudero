- **Every builder, reviewer and worker must clean up its own disposable workspace artifacts before
  finishing; preserve active/shared paths, unpublished work and durable evidence, and leave
  worktree retirement to the harness.**

This applies to interactive builders and every dispatched worker, regardless of provider or role.
Workers do not automatically load CLAUDE.md: the common spawn boundary injects the cleanup contract.
The generated AGENTS.md carries the same headline for Codex builders.

Before finishing, wait for your own checks and their consumers, preserve the required receipts in
an approved durable location, then remove only disposable scratch, temporary fixtures, caches and
generated artifacts that you created and that no live process or downstream check needs. Do not
create a second copy of an immutable dependency snapshot just to retire the first. Cleanup is
bounded by your existing tool/write authority; a read-only worker must not gain write access for it.

Never delete the current working directory, a harness-owned checkout/worktree, shared dependencies,
credentials, state or ledger/history. Preserve unpublished commits, dirty/untracked source,
unversioned scripts/reports and durable validation evidence. Do not stop another worker or remove
an active claim/lock. Unclear ownership, activity, publication or data safety means keep the path.

Create a disposable worktree with `rmd worktree add <dir> -b <branch> <base>`: on APFS it clones the
operator checkout's unchanged files copy-on-write instead of writing a second ~128 MB copy, and off
APFS it falls back to a normal checkout. `rmd hand-worktree` materializes through the same code.

The harness owns its worktree teardown; hand-created checkouts that are no longer needed go through
the existing guarded publication-aware retirement path, never a blanket recursive delete. The
six-hour janitor is a crash/backstop reaper, not a substitute for finishing your own cleanup.
Keep the required output schema unchanged; record retained paths and the reason in the allowed
report or receipt when that contract permits it.

Test fixtures should pass their test or enclosing suite as `scope` to the shared Git/ledger
helpers, or use `ownedFixtureDir(scope, kind)`. Register asynchronous child/writer closure with
`until(closed)` before the scope completes. Its teardown releases only its fresh pinned scratch;
failed closure or changed identity keeps the path, fails the hook and survives the exit backstop.
Use `retain(reason)` for required failure evidence. Caller-supplied shared directories keep their
original owner. Existing process-exit cleanup remains the fallback for unmigrated fixtures.

For local source-mapped coverage, `npm run diff-coverage:local -- --batch-size N <tests...>`
uses serial judged batches and the existing pinned compact/raw-range merger. Choose N from the
admitted workload profile; it changes no hosted gate. Every selected file must exist and be tracked.
Closed successful raw scratch is disposed after compaction; failed/raw-requested inputs and per-batch
TAP, LCOV, input hashes and terminal receipts remain available. Resource output labels path-block
accounting, phase-only samples, partial inventories and unknown cleanup. The1GiB signal is an
investigation warning, never permission to delete an active tree or relax a disk floor.
