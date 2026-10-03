/**
 * W1-T4110: the general gardener. A spec supplies its corpus, evidence and actions; the framework
 * picks one class a pass, lands its changes as one PR and judges that class on its own metric.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GardenStateUnreadableError,
  foldGardenEffects,
  gardenEffectsPath,
  gardenStatePath,
  initialGardenState,
  readGardenState,
  runGarden,
  startGarden,
  type GardenAction,
  type GardenCheckout,
  type GardenSpec,
  type GardenState,
  type GardenEffect,
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

function checkout(landed: Array<{ title: string; body: string }>): () => GardenCheckout {
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

test("a replay older than the 200-ID cache cannot add another credit", () => {
  const effects: GardenEffect[] = Array.from({ length: 201 }, (_, i) => ({
    id: `effect:${i}`, actionClass: "a", verdict: "credit", kind: "effect",
    at: "2026-10-02T00:00:00.000Z", sequence: i + 1,
  }));
  const first = foldGardenEffects(initialGardenState(["a", "b"]), effects);
  assert.equal(first.applied.length, 201, "every novel verdict applies");
  assert.equal(first.state.classes.a.alpha, 204);
  assert.equal(first.state.foldedEffects?.length, 200);
  const restarted = JSON.parse(JSON.stringify(first.state)) as GardenState<C>;
  const replay = foldGardenEffects(restarted, [effects[0]!]);
  assert.equal(replay.state.classes.a.alpha, 204);
  assert.deepEqual(replay.applied, []);
  assert.deepEqual(foldGardenEffects(replay.state, [effects[200]!]).applied, []);
});

test("a gardener watermark covers only an ordered consumed prefix", () => {
  const effect = (id: string, sequence?: number, actionClass = "a"): GardenEffect => ({
    id, sequence, actionClass, kind: "effect", verdict: "credit", at: "2026-10-02T00:00:00.000Z",
  });
  const original = initialGardenState(["a", "b"]);
  for (const effects of [
    [effect("later", 3), effect("earlier", 1)],
    [effect("first", 1), effect("second", 1)],
    [effect("same", 1), effect("same", 2)],
    [effect("legacy"), effect("sequenced", 1)],
  ]) {
    assert.throws(() => foldGardenEffects(original, effects), /ordered, unique producer prefix/);
    assert.equal(original.classes.a.alpha, 3);
    assert.equal(original.foldedEffectThrough, undefined);
  }
  const effects = [effect("first", 1), effect("unknown", 3, "new-class"), effect("last", 5, "b")];
  const prefix = foldGardenEffects(original, effects);
  assert.equal(prefix.state.foldedEffectThrough, 1);
  assert.equal(prefix.state.classes.a.alpha, 4);
  assert.equal(prefix.state.classes.b.alpha, 3);
  assert.deepEqual(prefix.remaining, effects.slice(1));
  assert.ok(!prefix.state.foldedEffects?.includes("unknown"));
  const restart = foldGardenEffects(prefix.state, effects);
  assert.deepEqual(restart.applied, []);
  assert.equal(restart.state.foldedEffectThrough, 1);
  const upgraded = foldGardenEffects<C | "new-class">({ ...restart.state, classes: { ...restart.state.classes, "new-class": { alpha: 3, beta: 1 } } }, restart.remaining);
  assert.equal(upgraded.applied.length, 2);
  assert.equal(upgraded.state.foldedEffectThrough, 5, "global sequence gaps belong to other gardeners");
  assert.equal(upgraded.state.classes.b.alpha, 4);
});

test("legacy gardener receipts remain idempotent beyond the recent cache and refuse missing history", () => {
  const effects: GardenEffect[] = Array.from({ length: 201 }, (_, i) => ({
    id: `legacy:${i}`, actionClass: "a", kind: "effect", verdict: "credit", at: "2026-10-02T00:00:00.000Z",
  }));
  const first = foldGardenEffects(initialGardenState(["a", "b"]), effects);
  assert.equal(first.applied.length, 201);
  assert.equal(first.state.foldedEffectThrough, undefined);
  assert.equal(first.state.foldedLegacyEffects?.length, 201);
  const replay = foldGardenEffects(JSON.parse(JSON.stringify(first.state)), [effects[0]!]);
  assert.equal(replay.state.classes.a.alpha, 204);
  assert.deepEqual(replay.applied, []);
  const oldReceipt = { ...initialGardenState(["a", "b"]), foldedEffects: effects.slice(1).map((e) => e.id) };
  assert.throws(() => foldGardenEffects(oldReceipt, [effects[0]!]), /receipt is unavailable/);
  assert.throws(() => foldGardenEffects(oldReceipt, [{ ...effects[0]!, sequence: 202 }]), /receipt is unavailable/);
  assert.deepEqual(foldGardenEffects(oldReceipt, [effects[200]!]).applied, []);
});

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
  const landed: Array<{ title: string; body: string }> = [];
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
  const held: Array<{ title: string; body: string }> = [];
  const r = runGarden(reserved, { stateDir: heldDir, repoRoot: heldDir, openWorkspace: checkout(held), log: () => {}, seed: 1 });
  assert.equal(r.prUrl, "https://github.com/acme/demo/pull/1");
  assert.equal("review" in held[0]!, false, "nothing asks the checkout to hold or draft the PR");
  assert.match(held[0]!.body, /^\*\*Judged by its outcome\.\*\* The demo gardener's `b` changes are judged by whether this PR merges: doctrine reserves rule changes to a person\. It is reviewed and auto-merges like every fleet PR; close it to decline — a merge credits the class, a close debits it\.\n\nthe body$/);

  // A class the spec does not reserve lands for the fleet as usual.
  const fleetDir = stateDir();
  writeFileSync(join(fleetDir, "DEMO_OFF-b"), "");
  const plain: Array<{ title: string; body: string }> = [];
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

test("W1-T4780: a merged review PR is judged with unchanged fingerprints", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const path = gardenStatePath(dir, "demo");
  writeFileSync(path, JSON.stringify({
    ...readGardenState(path, ["a", "b"]),
    lastCheap: "v1",
    lastPass: { fingerprint: "f1" },
    pending: { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "b", baseline: { trials: 0, successes: 0 } },
  }));
  let reads = 0;
  const landed: Array<{ title: string; body: string }> = [];
  const rows: string[] = [];
  const result = runGarden(spec(inv, {
    review: { b: "reviewed by the PR outcome" },
    inventory: () => { reads++; return inv; },
  }), { stateDir: dir, repoRoot: dir, openWorkspace: checkout(landed), prState: () => "merged", log: (step) => rows.push(step) });
  assert.equal(result.ran, false);
  assert.equal(reads, 0, "the terminal review verdict needs no inventory");
  assert.deepEqual(landed, [], "unchanged inputs do not open another PR");
  assert.deepEqual(rows, ["demo.gardener_judged"]);
  const saved = readGardenState(path, ["a", "b"]);
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.classes.b, { alpha: 4, beta: 1 });
});

test("W1-T4780: a merged metric PR progresses with unchanged action fingerprint", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 100, successes: 40 }, b: { trials: 0, successes: 0 } } };
  const path = gardenStatePath(dir, "demo");
  writeFileSync(path, JSON.stringify({
    ...readGardenState(path, ["a", "b"]),
    lastCheap: "v1",
    lastPass: { fingerprint: "stable" },
    pending: { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "a", baseline: { trials: 100, successes: 40 } },
  }));
  let reads = 0;
  const landed: Array<{ title: string; body: string }> = [];
  const s = spec(inv, { fingerprint: () => "stable", inventory: () => { reads++; return inv; } });
  const deps = { stateDir: dir, repoRoot: dir, openWorkspace: checkout(landed), prState: () => "merged" as const, log: () => {} };
  assert.equal(runGarden(s, deps).ran, false);
  assert.deepEqual(readGardenState(path, ["a", "b"]).pending?.atMerge, { trials: 100, successes: 40 });
  assert.equal(reads, 1, "a merge establishes its baseline despite unchanged inputs");
  inv.metrics.a = { trials: 200, successes: 90 };
  inv.version = 2;
  assert.equal(runGarden(s, deps).ran, false);
  const saved = readGardenState(path, ["a", "b"]);
  assert.equal(saved.pending, undefined, "later evidence settles the metric even when action candidates are unchanged");
  assert.deepEqual(saved.classes.a, { alpha: 4, beta: 1 });
  assert.equal(reads, 2);
  assert.deepEqual(landed, []);
});

test("W1-T4780: an open pending PR skips unchanged inventory", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const path = gardenStatePath(dir, "demo");
  writeFileSync(path, JSON.stringify({
    ...readGardenState(path, ["a", "b"]),
    lastCheap: "v1",
    lastPass: { fingerprint: "f1" },
    pending: { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "a", baseline: { trials: 0, successes: 0 } },
  }));
  let checked = 0;
  const result = runGarden(spec(inv, { inventory: () => { throw new Error("unchanged inventory must not run"); } }), {
    stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), prState: () => { checked++; return "open"; }, log: () => {},
  });
  assert.equal(result.ran, false);
  assert.equal(checked, 1, "each pass still checks the pending PR status");
  assert.ok(readGardenState(path, ["a", "b"]).pending);
});

test("W1-T4780: a closed metric PR is debited without a corpus read", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const path = gardenStatePath(dir, "demo");
  writeFileSync(path, JSON.stringify({
    ...readGardenState(path, ["a", "b"]),
    lastCheap: "v1",
    lastPass: { fingerprint: "f1" },
    pending: { prUrl: "https://github.com/acme/demo/pull/1", actionClass: "a", baseline: { trials: 0, successes: 0 } },
  }));
  const result = runGarden(spec(inv, { inventory: () => { throw new Error("closed PR needs no corpus"); } }), {
    stateDir: dir, repoRoot: dir, openWorkspace: checkout([]), prState: () => "closed", log: () => {},
  });
  assert.equal(result.ran, false);
  const saved = readGardenState(path, ["a", "b"]);
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.classes.a, { alpha: 3, beta: 2 });
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

const PENDING_PR = { prUrl: "https://github.com/acme/demo/pull/7", actionClass: "a", baseline: { trials: 0, successes: 0 } };

test("W1-T4938: corrupt existing gardener state refuses a duplicate PR", () => {
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const cases: Array<[string, string, string]> = [
    ["torn write", '{"classes":{"a":{"alpha":3,', "unparseable"],
    ["no classes", JSON.stringify({ pending: PENDING_PR }), "malformed"],
    ["class record not numbers", JSON.stringify({ classes: { a: { alpha: "3", beta: 1 } }, pending: PENDING_PR }), "malformed"],
    ["pending class unknown", JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, pending: { ...PENDING_PR, actionClass: "zzz" } }), "malformed"],
    ["pending without a PR url", JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, pending: { ...PENDING_PR, prUrl: 7 } }), "malformed"],
    ["fingerprint not a string", JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, lastPass: { fingerprint: 12 } }), "malformed"],
    ["legacy receipt not ids", JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, foldedLegacyEffects: [12] }), "malformed"],
  ];
  for (const [label, bytes, failureClass] of cases) {
    const dir = stateDir();
    const path = gardenStatePath(dir, "demo");
    writeFileSync(path, bytes);
    const effects = gardenEffectsPath(dir, "demo");
    writeFileSync(effects, JSON.stringify({ effects: [{ id: "e1", actionClass: "a", verdict: "credit", kind: "effect", at: "2026-09-30T00:00:00Z" }] }));
    const landed: Array<{ title: string; body: string }> = [];
    let opened = 0;
    let reads = 0;
    const rows: string[] = [];
    const s = spec(inv, { inventory: () => { reads++; return inv; }, apply: () => { throw new Error("apply must not run"); } });
    const deps = {
      stateDir: dir, repoRoot: dir, openWorkspace: () => { opened++; return checkout(landed)(); }, log: (step: string) => rows.push(step), seed: 1,
    };
    assert.throws(
      () => runGarden(s, deps),
      (e: unknown) => e instanceof GardenStateUnreadableError && e.path === path && e.failureClass === failureClass && e.message.includes(path) && e.message.includes(failureClass),
      label,
    );
    assert.equal(readFileSync(path, "utf8"), bytes, `${label}: the unreadable state is left for repair, never overwritten`);
    assert.ok(existsSync(effects), `${label}: the overseer's verdicts are not consumed against a record that was not read`);
    assert.deepEqual(landed, [], `${label}: no PR is landed`);
    assert.equal(opened + reads, 0, `${label}: no workspace is opened and no corpus is read`);
    assert.deepEqual(rows, [], `${label}: a refused pass writes no scorecard`);
    assert.throws(() => readGardenState(path, ["a", "b"]), GardenStateUnreadableError, `${label}: the reader names the failure instead of returning the optimistic prior`);
  }
});

test("W1-T5073: corrupt effects refuse a gardener pass without losing verdicts", () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const path = gardenEffectsPath(dir, "demo");
  const statePath = gardenStatePath(dir, "demo");
  const state = JSON.stringify(initialGardenState(["a", "b"]));
  writeFileSync(statePath, state);
  const landed: Array<{ title: string; body: string }> = [];
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const deps = { stateDir: dir, repoRoot: dir, openWorkspace: checkout(landed), log: (step: string, extra?: Record<string, unknown>) => rows.push([step, extra]), seed: 1 };
  for (const bytes of ["{bad", JSON.stringify({ effects: [{ id: "e1" }] })]) {
    writeFileSync(path, bytes);
    assert.throws(() => runGarden(spec(inv), deps), /demo-gardener-effects\.json.*(unparseable|malformed)/);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(readFileSync(statePath, "utf8"), state);
    assert.equal(landed.length, 0);
  }
  const timer = startGarden(spec(inv), deps, 1000);
  timer.stop();
  const failure = rows.find(([step]) => step === "demo.gardener_failed")?.[1];
  assert.equal(failure?.path, path);
  assert.equal(failure?.failure_class, "malformed");
  writeFileSync(path, JSON.stringify({ effects: [{ id: "e1", actionClass: "a", verdict: "credit", kind: "effect", at: "2026-09-30T00:00:00Z" }] }));
  runGarden(spec(inv, { candidates: () => [] }), deps);
  assert.equal(readGardenState(statePath, ["a", "b"]).classes.a.alpha, 4);
});

test("W1-T4938: first boot and compatible older gardener state still load", () => {
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  // No file: the reader returns the prior, and one pass initializes and records the state.
  const fresh = stateDir();
  const freshPath = gardenStatePath(fresh, "demo");
  assert.deepEqual(readGardenState(freshPath, ["a", "b"]), initialGardenState(["a", "b"]));
  const landed: Array<{ title: string; body: string }> = [];
  const first = runGarden(spec(inv), { stateDir: fresh, repoRoot: fresh, openWorkspace: checkout(landed), log: () => {}, seed: 1 });
  assert.ok(first.ran);
  assert.equal(landed.length, 1);
  assert.ok(readGardenState(freshPath, ["a", "b"]).pending, "the first boot pass recorded its pending PR");

  // An older record: one class only, none of the later optional fields. The class a spec added since
  // is initialized, the old record is kept, and the pass runs normally.
  const older = stateDir();
  const olderPath = gardenStatePath(older, "demo");
  writeFileSync(olderPath, JSON.stringify({ classes: { a: { alpha: 5, beta: 2 } }, lastPass: { fingerprint: "f0" } }));
  const loaded = readGardenState(olderPath, ["a", "b"]);
  assert.deepEqual(loaded.classes, { a: { alpha: 5, beta: 2 }, b: { alpha: 3, beta: 1 } });
  assert.deepEqual(loaded.lastPass, { fingerprint: "f0" });
  const second: Array<{ title: string; body: string }> = [];
  assert.ok(runGarden(spec(inv), { stateDir: older, repoRoot: older, openWorkspace: checkout(second), log: () => {}, seed: 1 }).ran);
  assert.equal(second.length, 1);

  // A full record, with every optional field a later gardener wrote, loads unchanged.
  const full = stateDir();
  const fullPath = gardenStatePath(full, "demo");
  const written = {
    classes: { a: { alpha: 4, beta: 2 }, b: { alpha: 3, beta: 3 } },
    lastPass: { fingerprint: "f1", landed: "https://github.com/acme/demo/pull/7" },
    lastCheap: "v1",
    pending: { ...PENDING_PR, atMerge: { trials: 3, successes: 1 } },
    filingFailures: { count: 2, lastAt: "2026-09-30T00:00:00.000Z", reason: "boom" },
    foldedEffects: ["e1"],
  };
  writeFileSync(fullPath, JSON.stringify(written));
  assert.deepEqual(readGardenState(fullPath, ["a", "b"]), written);
});

test("W1-T4938: unreadable gardener state is visible and repairable", async () => {
  const dir = stateDir();
  const inv: Inv = { version: 1, metrics: { a: { trials: 0, successes: 0 }, b: { trials: 0, successes: 0 } } };
  const path = gardenStatePath(dir, "demo");
  writeFileSync(path, "{not json");
  const landed: Array<{ title: string; body: string }> = [];
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const pump = startGarden(spec(inv), { stateDir: dir, repoRoot: dir, openWorkspace: checkout(landed), log: (s, e) => rows.push([s, e]), seed: 1 }, 5);
  const waitFor = async (done: () => boolean) => { for (let waited = 0; !done() && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5)); };
  await waitFor(() => rows.length >= 2);
  const failed = rows.find(([s]) => s === "demo.gardener_failed")?.[1];
  assert.ok(failed, "the refused pass is ledgered as gardener_failed");
  assert.ok(String(failed.error).includes(path), "the row names the unreadable path");
  assert.equal(failed.path, path);
  assert.equal(failed.failure_class, "unparseable");
  assert.deepEqual(landed, [], "nothing lands while the state is unreadable");
  assert.equal(readFileSync(path, "utf8"), "{not json");
  // Repair: a valid file lets the very next tick through, with no backoff to wait out.
  writeFileSync(path, JSON.stringify(initialGardenState(["a", "b"])));
  await waitFor(() => landed.length > 0);
  pump.stop();
  assert.equal(landed.length, 1, "the pass retried after repair and landed once");
});
