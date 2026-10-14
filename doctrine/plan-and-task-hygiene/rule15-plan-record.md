- **`rule15-filing` refuses a plan record in `files:` only when an OUT-OF-PLAN path rides along —
  the record ALONE passes at `verify: auto`.** MEASURED through `rule15FilingViolation`
  (`src/lib/task-linter.ts`) with a blocking control: own shard alone, and own shard +
  `MASTER-PLAN.md`, pass; own shard + `src/lib/x.ts` BLOCKS; `verify: human` and
  `blocked`/`merged`/`done` are carve-outs. The MIXTURE is the mechanism (the gate's own message
  says why), so a ratified scope widening still goes in the source comment and PR body, not the
  shard; `scope_violation` is ADVISORY and names "review-ratified widenings" legitimate.
  *(#2255; the "NEVER" corrected 2026-09-04 — the gate was right, the prose was not)*
