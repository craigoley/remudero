import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { GARDEN_LEDGER_BUCKET_MS, type GardenerDeps } from "#src/lib/gardener.js";
import { redesignGardenSpec } from "#src/lib/redesign-gardener.js";
import { withTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T11069 criterion 1: the redesign garden's due check reads no ledger and moves only with the plan or the hour", async () => {
  await withTempDir("redesign-due", (dir) => {
    let nowMs = Date.parse("2026-11-01T13:05:00Z");
    const clock = clockFromMillisFn(() => nowMs);
    let ledgerReads = 0;
    const deps: GardenerDeps = {
      stateDir: join(dir, "state"), repoRoot: REPO_ROOT, clock, seed: 1, log: () => {},
      openWorkspace: () => { throw new Error("the due check never opens a workspace"); },
    };
    const spec = redesignGardenSpec(deps, {
      clock,
      ledger: () => { ledgerReads++; throw new Error("the due check must not read the ledger union"); },
    });
    const first = spec.cheapFingerprint();
    assert.equal(ledgerReads, 0, "the due check walked the ledger on the daemon loop");
    nowMs += GARDEN_LEDGER_BUCKET_MS / 2 - 1;
    assert.equal(spec.cheapFingerprint(), first, "inside one hourly bucket the due check is stable");
    nowMs += GARDEN_LEDGER_BUCKET_MS;
    assert.notEqual(spec.cheapFingerprint(), first, "a new hourly bucket makes the pass due again");
    assert.equal(ledgerReads, 0);
  });
});
