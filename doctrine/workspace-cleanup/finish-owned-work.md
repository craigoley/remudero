# Finish owned work

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

The harness owns its worktree teardown; hand-created checkouts that are no longer needed go through
the existing guarded publication-aware retirement path, never a blanket recursive delete. The
six-hour janitor is a crash/backstop reaper, not a substitute for finishing your own cleanup.
Keep the required output schema unchanged; record retained paths and the reason in the allowed
report or receipt when that contract permits it.
