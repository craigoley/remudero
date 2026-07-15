# Plan-sync: the in-repo PR flow (W1-T15)

`MASTER-PLAN.md` and `plan/tasks.yaml` are the one artifact whose edit history
matters most — and they were once copied into the tree **out-of-band (scp)**,
which is how a dirty, unreviewed version arrived with no provenance and no
diff to inspect. That never happens again: **plan edits land exactly like code,
through a reviewable PR against `main`, gated by the same `ci` +
`remudero-review` checks as every other change.** No file arrives by
scp/rsync/manual copy.

## The flow

1. **Branch.** Cut a branch off `main`, same as for any code change.
2. **Edit.** Change `MASTER-PLAN.md` and/or `plan/tasks.yaml` directly on that
   branch — a normal file edit, not a copy from elsewhere.
3. **Open a PR.** `gh pr create` against `main`. A plan-only PR is a **manual
   PR** in the sense of [CONTRIBUTING.md](../CONTRIBUTING.md#manual-prs-plan-edits-docs-hand-run-changes---you-must-post-the-review):
   nothing auto-posts `remudero-review` for it, so the PR body must contain an
   `Acceptance:` block (claim + observable proof per line) before running
   `rmd review <pr-number>` to post the required status.
4. **Gate.** The PR merges only when both `ci` and `remudero-review` are
   green — identical bar to a code PR. A plan change with no stated,
   substantiated acceptance criteria **fails closed**.
5. **Merge.** Once green, merge through GitHub like any other PR. The merge
   commit *is* the provenance record: who changed the plan, what changed, and
   why, all in `git log` — never reconstructable from an scp'd file with no
   history.

No `rmd plan sync` command exists yet (a future CLI helper is out of scope for
this doc — see `plan/tasks.yaml` if one gets scheduled); until then, this PR
flow **is** the plan-sync mechanism, not a placeholder for one.

## Why this matters

- **Provenance.** A `git log` entry, PR discussion, and review verdict beat a
  file that silently appeared in the tree.
- **Same gate, no exceptions.** The plan is not special-cased below the code
  quality bar (Standing rule 15/16 territory) — it goes through the identical
  `ci` + `remudero-review` gate.
- **Reviewable diffs.** A plan edit as a PR diff is inspectable line-by-line,
  the same way a code diff is — an scp'd file replacement is not.

See also [docs/review-gate.md](review-gate.md) for how `remudero-review` and
the `rmd review <n>` escape hatch work, and MASTER-PLAN §13 for the
cross-reference from the plan itself.
