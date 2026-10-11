- **Before filing, sweep the task's SUBJECT over every open PR head's tree (`git ls-remote --heads
  origin`), not only `origin/main`, counting per head against main.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below leaned on its neighbour ("the id half already does") and named its command only in its body. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **Sweep the SUBJECT over open PR heads, not only `origin/main` — the id half already does.** A
  main-only subject scan cannot see an in-flight sibling shard, the one case it exists to catch:
  `git ls-remote --heads origin`, then read each head's tree — real files, no REST call. COUNT per
  head against main's own count; presence hits EVERY head, all carrying main's shards. **One
  prompt, one lane**, too: NO SWEEP SEES UNPUSHED WORK, so that half is the operator's discipline,
  never a check. *(2026-08-22: a re-sweep at 11:22:23Z missed a PR opened 11:14:46Z — two shards on
  one subject, #2471 duplicated; #2408/#2411 on 08-21.)*
