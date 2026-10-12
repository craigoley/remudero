- **A test run with no `# tests` summary is NOT A RESULT, and a summary over an UNVERIFIED FILE LIST
  is not one either — `node --test` given a ghost path returns a green count, silently. `ls` first.** A killed or timed-out run prints every assertion it reached and no totals, so its
  failure set is a SUBSET BY CONSTRUCTION and reads as "fewer failures on this side". One session
  recorded 3436 assertions with no summary and was about to diff it against a complete 5660-test run,
  which would have manufactured a four-file regression that does not exist. This COMPOUNDS the
  compare-both-sides discipline rather than being covered by it: comparing failure SETS instead of
  counts does not save you when one side is truncated, because the truncated set is a subset either
  way. Require `# tests`/`# pass`/`# fail` on BOTH sides before diffing, and normalise paths first
  when the sides ran in different trees. With `pkill -f`, excluding your own pid is not enough on a
  shared host; discriminate by `/proc/<pid>/cwd`, not argv shape. *(2026-08-09)*
