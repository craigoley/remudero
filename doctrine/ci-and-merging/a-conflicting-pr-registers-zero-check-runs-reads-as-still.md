- **A CONFLICTING PR registers ZERO check runs. `total: 0` reads as "still queued" but means
  `mergeable_state: dirty` — check mergeability before waiting on CI.** *(#1399 — a full CI cycle
  spent waiting on checks that were never going to start)*
