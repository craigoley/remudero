- **(h) A GATE RUN FROM A CHECKOUT that is BEHIND answers about a file and a threshold that both
  moved — run it against `origin/main`'s blobs and report the behind-count.** MEASURED: the
  operator checkout sat 465 commits behind, and `node scripts/claude-md-budget-ratchet.mjs` there
  printed `60965 bytes (cap 61046) OK` while `git show origin/main:CLAUDE.md` is 63798 against a
  cap of 65536 raised 2026-08-22 — BOTH operands stale, exit 0, no warning. The failure is
  invisible because the gate is honest about what it read and silent about which tree that was.
  `git rev-list --count HEAD..origin/main` costs nothing; print it beside any gate verdict taken
  outside a fresh worktree. *(2026-08-23, this retro's own first measurement)*
