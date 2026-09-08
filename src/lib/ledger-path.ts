import { join } from "node:path";

import type { Config } from "./config.js";

/**
 * W1-T143 (DAEMON OBSERVABILITY): the ONE canonical ledger path, a PURE function of
 * `config.root` — DOCUMENTED (docs/operator-guide.md) and named aloud at the daemon's
 * own boot (`daemonCommand`'s `daemon.paths` ledger line) so it is provably
 * deterministic, never folklore. Every call site in this file that used to inline
 * `join(config.root, "state", "ledger.ndjson")` routes through this single function now
 * — mechanical, behavior-preserving (the expression was already byte-identical at every
 * site), so a future rename/relocation of the ledger changes exactly one line.
 */
export function ledgerPathFor(config: Config): string {
  return join(config.root, "state", "ledger.ndjson");
}

// W1-T2528 — module-scoped so it's monotonic across every lane runId this ONE process mints
// (retro/triage/plan): `Date.now()`'s 1ms resolution let two rungs collide (OBSERVED: identical
// epoch logged twice, then `fatal: a branch ... already exists`). Bumps only off the PRECEDING
// raw reading (never an ever-growing peak), so a differing reading passes through unchanged,
// keeping this repo's widespread `Date.now` mocks exact.
let lastRawNowMs = -1;
let lastLaneEpochMs = -1;
export function nextLaneEpochMs(): number {
  const now = Date.now();
  if (now === lastRawNowMs) return ++lastLaneEpochMs;
  lastRawNowMs = now;
  return (lastLaneEpochMs = now);
}
