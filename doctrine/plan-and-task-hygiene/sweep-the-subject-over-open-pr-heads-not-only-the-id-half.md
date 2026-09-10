- **Sweep the SUBJECT over open PR heads, not only `origin/main` — the id half already does.** A
  main-only subject scan cannot see an in-flight sibling shard, the one case it exists to catch:
  `git ls-remote --heads origin`, then read each head's tree — real files, no REST call. COUNT per
  head against main's own count; presence hits EVERY head, all carrying main's shards. **One
  prompt, one lane**, too: NO SWEEP SEES UNPUSHED WORK, so that half is the operator's discipline,
  never a check. *(2026-08-22: a re-sweep at 11:22:23Z missed a PR opened 11:14:46Z — two shards on
  one subject, #2471 duplicated; #2408/#2411 on 08-21.)*
