- **A clock-shifted run failing ENOENT on its own fixture is the boot temp sweep, not a time bomb —
  use a private TMPDIR.**
  `daemonCommand`'s boot rung ends in `sweepStaleTempDirs({ maxAgeMs: policy.values.sweep.tmpMaxAgeMs })`.
  The sweep deletes every `rmd-*` directory (`RMD_TMP_PREFIX`) under `tmpdir()` that is older than 24 h
  (`DEFAULT_TEMP_SWEEP_MAX_AGE_MS`). It measures age as `Date.now()` minus each directory's REAL mtime.
  A fixture made by `makeTempDir` is itself an `rmd-*` directory under `tmpdir()`. Shift the clock a
  day forward and every such directory reads as stale, so the daemon under test deletes the plan it
  was just handed.

  **WHAT IT LOOKED LIKE.** On 2026-10-10 `test/new-work-is-ordered-by-cost-of-delay.test.ts`, run with
  the clock advanced one day, failed `filing-history-unreadable: ENOENT`. A red that appears only under
  a shifted clock reads as a time bomb (see the Code traps rule on fixed date constants). It was not
  one: the fixture's dates were fine, and the file had been deleted out from under it.

  **TELL THEM APART.** A real time bomb fails an ASSERTION on a date comparison. The sweep fails ENOENT,
  or "unreadable", on a path the fixture itself created.

  **THE FIX.** The test points `process.env.TMPDIR` at a private directory inside the fixture, puts the
  fixture's HOME under it (the ledger guard refuses a test append outside `tmpdir()`), and restores
  the old value afterwards. The sweep then sees only that private directory.

  **THE SECOND HARM, AND WHY THIS IS NOT ONLY A TEST BUG.** Without a private TMPDIR the sweep runs on
  the REAL shared temp directory. Under a clock shifted a day or more, every `rmd-*` directory there
  reads as stale, including the live scratch of other sessions and other processes, and the test
  deletes it. Never run a clock-shifted suite, or a `daemonCommand` fixture, against the shared
  `tmpdir()`. *(#10719, 2026-10-10)*
