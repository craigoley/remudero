import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { ciFrictionGardenSpec, type CiFrictionGardenSources } from "../src/lib/ci-friction-gardener.js";
import {
  GARDEN_INVENTORY_RETRY_BASE_MS, gardenInventoryFailurePath, gardenPassDue, gardenStatePath, runGarden, type GardenerDeps,
} from "../src/lib/gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

// OBSERVED 2026-10-09 10:52-11:54Z on the fleet host: the ci-friction garden ran 47 passes for 1,505 s of
// child time. Every pass read the whole ledger union and then failed the same way ("workflow ownership
// ambiguous for ci-gate"). A failed inventory recorded no `lastCheap`, so the parent's due probe said yes
// on every 60 s poll.

const ANY_OWNER: CiFrictionGardenSources["ownerSearch"] = { filesContaining: () => [], fileExists: () => true };

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "inventory-failure-garden" });
  t.after(() => repo.cleanup());
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.2026-10-09T10-00-00-000Z.ndjson"), "");
  let now = Date.parse("2026-10-09T12:00:30.000Z");
  const clock = clockFromMillisFn(() => now);
  const reads = { count: 0 };
  const steps: string[] = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: repo.dir, clock,
    openWorkspace: () => { throw new Error("a failed inventory files nothing"); },
    log: (step) => void steps.push(step),
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => {
      reads.count += 1;
      throw new Error("ci-friction workflow ownership ambiguous for ci-gate");
    },
    planState: () => ({ tasks: [] }),
    ownerSearch: ANY_OWNER,
    mintTaskId: () => { throw new Error("no task is minted"); },
  };
  return { repo, stateDir, deps, sources, reads, steps, advance: (ms: number) => { now += ms; } };
}

test("a garden whose inventory failed is not due again until its inputs change or its retry wait passes", (t) => {
  const f = fixture(t);
  const spec = ciFrictionGardenSpec(f.deps, f.sources);
  assert.equal(gardenPassDue(spec, f.deps), true, "a first pass has nothing recorded");
  assert.throws(() => runGarden(spec, f.deps), /ownership ambiguous/);
  assert.equal(f.reads.count, 1);
  assert.equal(existsSync(gardenStatePath(f.stateDir, "ci-friction")), false, "a failed pass leaves no receipt");

  // The next poll over the same inputs spawns nothing, and a pass that runs anyway reads nothing.
  f.advance(GARDEN_INVENTORY_RETRY_BASE_MS - 1);
  assert.equal(gardenPassDue(spec, f.deps), false, "the same inputs fail the same way");
  assert.deepEqual(runGarden(spec, f.deps), { ran: false });
  assert.equal(f.reads.count, 1, "a deferred pass reads no corpus");

  // The wait grows with the streak: after one poll it retries, and its next wait is longer.
  f.advance(1);
  assert.equal(gardenPassDue(spec, f.deps), true, "a transient failure is retried");
  assert.throws(() => runGarden(spec, f.deps), /ownership ambiguous/);
  assert.equal(f.reads.count, 2);
  const streak = JSON.parse(readFileSync(gardenInventoryFailurePath(f.stateDir, "ci-friction"), "utf8"));
  assert.equal(streak.count, 2);
  f.advance(GARDEN_INVENTORY_RETRY_BASE_MS);
  assert.equal(gardenPassDue(spec, f.deps), false, "the second retry waits longer than one poll");

  // A changed input (a new commit) is due at once.
  f.repo.git("commit", "--quiet", "--allow-empty", "-m", "resolve the ownership");
  assert.equal(gardenPassDue(spec, f.deps), true, "a new commit may have fixed the cause");
});

test("a successful inventory clears the failure streak", (t) => {
  const f = fixture(t);
  let failing = true;
  const sources: CiFrictionGardenSources = {
    ...f.sources,
    ledgerRecords: () => {
      f.reads.count += 1;
      if (failing) throw new Error("ci-friction ledger union unreadable: incomplete ledger union");
      return [];
    },
  };
  const spec = ciFrictionGardenSpec(f.deps, sources);
  assert.throws(() => runGarden(spec, f.deps), /unreadable/);
  failing = false;
  f.advance(GARDEN_INVENTORY_RETRY_BASE_MS);
  assert.equal(runGarden(spec, f.deps).ran, true);
  assert.equal(existsSync(gardenInventoryFailurePath(f.stateDir, "ci-friction")), false, "the streak ended");
  assert.equal(gardenPassDue(spec, f.deps), false, "a clean pass records its inputs as usual");
});

test("a damaged failure record defers nothing", (t) => {
  const f = fixture(t);
  const spec = ciFrictionGardenSpec(f.deps, f.sources);
  assert.throws(() => runGarden(spec, f.deps), /ownership ambiguous/);
  writeFileSync(gardenInventoryFailurePath(f.stateDir, "ci-friction"), "{ not json");
  assert.equal(gardenPassDue(spec, f.deps), true, "an unreadable record is no reason to skip");
  writeFileSync(gardenInventoryFailurePath(f.stateDir, "ci-friction"), JSON.stringify({ cheap: "x", count: 1 }));
  assert.equal(gardenPassDue(spec, f.deps), true, "a record missing its timestamps is no reason to skip");
});
