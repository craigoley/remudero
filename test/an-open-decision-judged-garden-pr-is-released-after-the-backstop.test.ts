import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  gardenNeedsInventory,
  gardenStatePath,
  readGardenState,
  runGarden,
  runGardenAsync,
  type GardenAction,
  type GardenCheckout,
  type GardenSpec,
  type PrState,
} from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PROOF = "test/an-open-decision-judged-garden-pr-is-released-after-the-backstop.test.ts";
const AT = Date.parse("2026-10-06T00:00:00Z");
const BACKSTOP = 24 * 3_600_000;
const OLD_PR = "https://github.com/acme/demo/pull/1";
const NEW_PR = "https://github.com/acme/demo/pull/2";
type Class = "held" | "next";

function fixture(kind: "review" | "decision", recordedAt: unknown = new Date(AT).toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5842-`));
  const path = gardenStatePath(dir, "demo");
  const classes = { held: { alpha: 100, beta: 1 }, next: { alpha: 100, beta: 1 } };
  const pending = { prUrl: OLD_PR, actionClass: "held", baseline: { trials: 0, successes: 0 } };
  writeFileSync(path, JSON.stringify({ classes, pending, ...(recordedAt === false ? {} : { pendingRecordedAt: recordedAt }), lastCheap: "stable", lastPass: { fingerprint: "stable" } }));
  let at = AT;
  let pr: PrState = "open";
  let cheap = "stable";
  let work = false;
  let reads = 0;
  const queried: string[] = [];
  const landed: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const action: GardenAction<Class> = { class: "next", target: "remaining", reason: "held work" };
  const spec: GardenSpec<Class, null, GardenAction<Class>, GardenCheckout> = {
    name: "demo", classes: ["held", "next"],
    ...(kind === "review" ? { review: { held: "operator decision", next: "operator decision" } } : { decision: ["held", "next"] }),
    cheapFingerprint: () => cheap,
    inventory: () => { reads++; return null; },
    fingerprint: () => "stable",
    candidates: () => work ? [action] : [],
    scorecard: () => ({}),
    apply: (_ws, plan) => {
      assert.deepEqual(plan.actions, [action]);
      return { paths: ["docs/demo.md"], title: "fix(demo): offer held work", body: "remaining work" };
    },
  };
  const deps = () => ({
    stateDir: dir, repoRoot: dir, clock: fixedClock(at), seed: 1,
    prState: (url: string) => { queried.push(url); return pr; },
    openWorkspace: (): GardenCheckout => ({ root: dir, land: () => { landed.push(NEW_PR); return NEW_PR; }, dispose: () => {} }),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
  });
  return {
    path, spec, deps, classes, queried, landed, rows,
    read: () => readGardenState(path, spec.classes),
    pass: () => runGarden(spec, deps()),
    at: (value: number) => { at = value; },
    pr: (value: PrState) => { pr = value; },
    cheap: (value: string) => { cheap = value; },
    work: () => { work = true; },
    reads: () => reads,
    releases: () => rows.filter((r) => r.step === "demo.pending_released"),
    judgments: () => rows.filter((r) => r.step === "demo.gardener_judged"),
  };
}

for (const kind of ["review", "decision"] as const) {
  test(`${PROOF}: ${kind} open PR holds before the backstop, releases at it, and is never re-judged`, () => {
    const g = fixture(kind);
    g.at(AT + BACKSTOP - 1);
    assert.equal(gardenNeedsInventory(g.spec, g.deps(), "open"), false);
    assert.equal(g.pass().ran, false);
    assert.equal(g.read().pending?.prUrl, OLD_PR);
    assert.equal(g.reads(), 0);
    assert.deepEqual(g.releases(), []);
    g.at(AT + BACKSTOP);
    assert.equal(gardenNeedsInventory(g.spec, g.deps(), "open"), true);
    g.pass();
    assert.equal(g.read().pending, undefined);
    assert.equal(g.read().pendingRecordedAt, undefined);
    assert.deepEqual(g.read().classes, g.classes);
    assert.deepEqual(g.judgments(), []);
    assert.deepEqual(g.releases().map((r) => r.extra), [{
      pr_url: OLD_PR, action_class: "held", waited_ms: BACKSTOP, bound_ms: BACKSTOP,
      reason: `open PR ${OLD_PR} exceeded the decision backstop`,
    }]);
    assert.deepEqual(g.landed, []);
    const queries = g.queried.length;
    for (const terminal of ["merged", "closed"] as const) {
      g.pr(terminal);
      g.cheap(terminal);
      g.pass();
    }
    assert.equal(g.queried.length, queries);
    assert.deepEqual(g.read().classes, g.classes);
    assert.equal(g.releases().length, 1);
  });

  test(`${PROOF}: ${kind} release forgets the held pass and offers unchanged candidates`, async () => {
    const g = fixture(kind);
    g.work();
    g.at(AT + BACKSTOP);
    const result = await runGardenAsync(g.spec, { ...g.deps(), prState: async (): Promise<PrState> => "open" });
    assert.equal(result.prUrl, NEW_PR);
    assert.deepEqual(result.plan?.acting, ["next"]);
    assert.deepEqual(g.read().classes, g.classes);
    assert.deepEqual(g.read().lastPass, { fingerprint: "stable", landed: NEW_PR });
    assert.equal(g.read().pendingRecordedAt, new Date(AT + BACKSTOP).toISOString());
    assert.equal(g.releases().length, 1);
  });

  for (const terminal of ["merged", "closed"] as const) {
    test(`${PROOF}: ${kind} ${terminal} PR is judged even past the backstop`, () => {
      const g = fixture(kind);
      g.at(AT + 2 * BACKSTOP);
      g.pr(terminal);
      g.pass();
      assert.equal(g.read().pending, undefined);
      assert.equal(g.read().pendingRecordedAt, undefined);
      assert.equal(g.read().lastPass, undefined);
      assert.deepEqual(g.read().classes.held, terminal === "merged" ? { alpha: 101, beta: 1 } : { alpha: 100, beta: 2 });
      assert.deepEqual(g.judgments().map((r) => r.extra?.verdict), [terminal === "merged" ? "credit" : "debit"]);
      assert.deepEqual(g.releases(), []);
      assert.equal(g.reads(), 0);
    });
  }
}

test(`${PROOF}: legacy open pending is stamped once before the cheap return`, () => {
  const g = fixture("decision", false);
  g.pass();
  assert.equal(g.read().pendingRecordedAt, new Date(AT).toISOString());
  g.at(AT + BACKSTOP - 1);
  g.pass();
  assert.equal(g.read().pendingRecordedAt, new Date(AT).toISOString());
  assert.equal(g.reads(), 0);
  g.at(AT + BACKSTOP);
  g.pass();
  assert.equal(g.read().pending, undefined);
  assert.equal(g.releases().length, 1);
});

test(`${PROOF}: an unknown PR state cannot release an overdue pending`, () => {
  const g = fixture("decision");
  g.at(AT + 2 * BACKSTOP);
  g.pr("unknown");
  assert.equal(gardenNeedsInventory(g.spec, g.deps(), "unknown"), false);
  g.pass();
  assert.equal(g.read().pending?.prUrl, OLD_PR);
  assert.deepEqual(g.releases(), []);
  assert.deepEqual(g.read().classes, g.classes);
});

test(`${PROOF}: malformed recording timestamps refuse the pass`, () => {
  for (const stamp of [null, 123, "not-a-date"]) {
    const g = fixture("decision", stamp);
    assert.throws(() => g.pass(), /pendingRecordedAt/);
    assert.deepEqual(g.rows, []);
  }
});
