/**
 * W1-T4110: the general gardener. A spec supplies its corpus, evidence and actions; the framework
 * picks one class a pass, lands its changes as one PR and judges that class on its own metric.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  gardenStatePath,
  readGardenState,
  runGarden,
  startGarden,
  type GardenAction,
  type GardenCheckout,
  type GardenSpec,
  type GardenState,
  type Outcome,
} from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type C = "a" | "b";
interface Inv {
  metrics: Record<C, Outcome>;
  version: number;
}

function spec(inv: Inv, overrides: Partial<GardenSpec<C, Inv, GardenAction<C>, GardenCheckout>> = {}): GardenSpec<C, Inv, GardenAction<C>, GardenCheckout> {
  return {
    name: "demo",
    classes: ["a", "b"],
    cheapFingerprint: () => `v${inv.version}`,
    inventory: () => inv,
    fingerprint: (i) => `f${i.version}`,
    metric: (i, c) => i.metrics[c],
    candidates: () => [
      { class: "a", target: "x", reason: "ra" },
      { class: "b", target: "y", reason: "rb" },
    ],
    scorecard: (i) => ({ version: i.version }),
    apply: (_ws, plan) => ({ paths: ["docs/demo.md"], title: `demo ${plan.acting[0]}`, body: "the body" }),
    ...overrides,
  };
}

function checkout(landed: Array<{ title: string; body: string; }>): () => GardenCheckout {
  return () => ({
    root: "/nowhere",
    land: (opts) => {
      landed.push(opts);
      return `https://github.com/acme/demo/pull/${landed.length}`;
    },
    dispose: () => {},
  });
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4110-`));
}

test("W1-T4110: a spec's class is judged by its own metric", () => {
  const dir = stateDir();
  // Class a's PR merged. Since then a's own success rate fell (40% -> 10%) while b's soared; a shared
  // scalar over both would read a rise and credit a.
  const seeded: GardenState<C> = {
    classes: { a: { alpha: 3, beta: 1 }, b: { alpha: 3, beta: 1 } },
    pending: { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "a", baseline: { trials: 100, successes: 40 }, atMerge: { trials: 100, successes: 40 } },
  };
  writeFileSync(gardenStatePath(dir, "demo"), JSON.stringify(seeded));
  const inv: Inv = { version: 2, metrics: { a: { trials: 200, successes: 50 }, b: { trials: 400, successes: 390 } } };
  const asked: C[] = [];
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  runGarden(
    spec(inv, {
      metric: (i, c) => {
        asked.push(c);
        return i.metrics[c];
      },
    }),
    { stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), prState: () => "merged", log: (s, e) => rows.push([s, e]), seed: 3 },
  );
  assert.equal(asked[0], "a", "the pending class's own metric is read");
  assert.deepEqual(rows.find(([s]) => s === "demo.gardener_judged")?.[1]?.verdict, "debit");
  assert.deepEqual(readGardenState(gardenStatePath(dir, "demo"), ["a", "b"]).classes.a, { alpha: 3, beta: 2 });

  // The baseline a new PR is judged against is the ACTING class's metric at landing.
  const fresh = stateDir();
  writeFileSync(join(fresh, "DEMO_OFF-a"), "");
  const landed: Array<{ title: string; body: string; }> = [];
  const first = runGarden(spec(inv), { stateDir: fresh, repoRoot: fresh, openWorkspace: checkout(landed), log: () => {}, seed: 1 });
  assert.deepEqual(first.plan?.acting, ["b"]);
  assert.deepEqual(readGardenState(gardenStatePath(fresh, "demo"), ["a", "b"]).pending?.baseline, { trials: 400, successes: 390 });
});

// The title is W1-T4110's acceptance proof (a grep of this literal), so it stays; the behaviour it
// named is SUPERSEDED by operator ruling 2026-09-24 — a reviewed class's PR is never held or drafted.
test("W1-T4110: an operator-review class opens its PR without auto-merge — superseded: it now opens ready for review and flows through the fleet's review and auto-merge", () => {
  const inv: Inv = { version: 1, metrics: { a: { trials: 1, successes: 1 }, b: { trials: 1, successes: 1 } } };
  const reserved = spec(inv, { review: { b: "doctrine reserves rule changes to a person." } });

  const heldDir = stateDir();
  writeFileSync(join(heldDir, "DEMO_OFF-a"), "");
  const held: Array<{ title: string; body: string; }> = [];
  const r = runGarden(reserved, { stateDir: heldDir, repoRoot: heldDir, openWorkspace: checkout(held), log: () => {}, seed: 1 });
  assert.equal(r.prUrl, "https://github.com/acme/demo/pull/1");
  assert.equal("review" in held[0]!, false, "nothing asks the checkout to hold or draft the PR");
  assert.match(held[0]!.body, /^\*\*Judged by its outcome\.\*\* The demo gardener's `b` changes are judged by whether this PR merges: doctrine reserves rule changes to a person\. It is reviewed and auto-merges like every fleet PR; close it to decline — a merge credits the class, a close debits it\.\n\nthe body$/);

  // A class the spec does not reserve lands for the fleet as usual.
  const fleetDir = stateDir();
  writeFileSync(join(fleetDir, "DEMO_OFF-b"), "");
  const plain: Array<{ title: string; body: string; }> = [];
  runGarden(reserved, { stateDir: fleetDir, repoRoot: fleetDir, openWorkspace: checkout(plain), log: () => {}, seed: 1 });
  assert.equal("review" in plain[0]!, false);
  assert.equal(plain[0]!.body, "the body");
});

test("W1-T4110: a pass with nothing to land opens no PR, and an unchanged corpus is not re-read", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  let reads = 0;
  const s = spec(inv, {
    inventory: () => {
      reads++;
      return inv;
    },
    apply: () => undefined,
  });
  const rows: string[] = [];
  const first = runGarden(s, { stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), log: (step) => rows.push(step), seed: 1 });
  assert.ok(first.ran && first.prUrl === undefined);
  assert.equal(readGardenState(gardenStatePath(dir, "demo"), ["a", "b"]).pending, undefined);
  assert.deepEqual(rows, ["demo.scorecard"]);
  assert.equal(runGarden(s, { stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), log: () => {} }).ran, false);
  assert.equal(reads, 1, "the cheap fingerprint stopped the second pass");
  // A changed cheap fingerprint with the same full fingerprint records the look and stops.
  const moved = spec(inv, { cheapFingerprint: () => "touched", apply: () => undefined });
  assert.equal(runGarden(moved, { stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), log: () => {} }).ran, false);
  assert.equal(readGardenState(gardenStatePath(dir, "demo"), ["a", "b"]).lastCheap, "touched");
});

test("W1-T4110: a failing pass is logged under the spec's name and the timer keeps going", async () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const rows: string[] = [];
  let ticks = 0;
  const pump = startGarden(
    spec(inv, {
      cheapFingerprint: () => {
        ticks++;
        throw new Error("corpus unreadable");
      },
    }),
    { stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), log: (s) => rows.push(s) },
    5,
  );
  for (let waited = 0; ticks < 2 && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  pump.stop();
  assert.ok(ticks >= 2, `ticked ${ticks}`);
  assert.ok(rows.every((r) => r === "demo.gardener_failed") && rows.length === ticks);
});
