import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { writeLedger } from "./helpers/ledger-fixture.js";
import { readLedgerLines } from "../src/lib/status.js";
import { deriveDayCostUsd } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { costGovernorGateFor } from "../src/run-task.js";

const BEFORE_MIDNIGHT = Date.parse("2026-09-10T23:59:59.000Z");
const AFTER_MIDNIGHT = Date.parse("2026-09-11T00:00:01.000Z");

test("W1-T3307: a pinned consultation cannot lose a pre-midnight row to the next UTC day", () => {
  const { dir, path } = writeLedger([
    { run_id: "SEED", task_id: "W1-T3307", step: "verdict", verdict: "failed", cost_usd: 999, ts: new Date(BEFORE_MIDNIGHT).toISOString() },
  ]);
  try {
    const lines = readLedgerLines(path);
    assert.equal(
      deriveDayCostUsd(lines, AFTER_MIDNIGHT),
      0,
      "the pre-task Date.now() read after midnight drops the row from the UTC day window",
    );

    let reads = 0;
    const deferred = costGovernorGateFor(path, "RUN", () => {
      reads += 1;
      return BEFORE_MIDNIGHT;
    })(500);

    assert.equal(deferred?.deferred, true, "the pinned pre-midnight consultation counts the $999 row");
    assert.equal(deferred?.observedDayCostUsd, 999);
    assert.equal(reads, 1, "one consultation reads its injected clock exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3307: an uninjected gate still uses the real clock and defers current-day spend", () => {
  const { dir, path } = writeLedger([
    { run_id: "SEED", task_id: "W1-T3307", step: "verdict", verdict: "failed", cost_usd: 999, ts: new Date(Date.now()).toISOString() },
  ]);
  try {
    const deferred = costGovernorGateFor(path, "RUN")(500);
    assert.equal(deferred?.deferred, true, "the default remains the real clock rather than a frozen or absent ceiling");
    assert.equal(deferred?.observedDayCostUsd, 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
