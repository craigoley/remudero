import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { ledgerPathFor, nextLaneEpochMs } from "../src/lib/ledger-path.js";
import type { Config } from "../src/lib/config.js";

function withFrozenClock<T>(epochMs: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => epochMs;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("ledgerPathFor resolves the canonical live ledger under config.root", () => {
  const config = { root: "/tmp/remudero-ledger-path" } as Config;
  assert.equal(ledgerPathFor(config), join(config.root, "state", "ledger.ndjson"));
});

test("nextLaneEpochMs stays monotonic when the wall clock repeats", () => {
  withFrozenClock(1788830806642, () => {
    const first = nextLaneEpochMs();
    const second = nextLaneEpochMs();
    assert.equal(second, first + 1);
    assert.ok(second > first);
  });
});
