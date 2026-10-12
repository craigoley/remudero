import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  GARDEN_PENDING_RELEASE_MS,
  gardenStatePath,
  readGardenState,
  runGarden,
  type GardenAction,
  type GardenCheckout,
  type GardenSpec,
  type GardenState,
  type Outcome,
  type PrState,
} from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const oldPr = "https://github.com/acme/demo/pull/1";
const newPr = "https://github.com/acme/demo/pull/2";
const clock = fixedClock(Date.parse("2026-10-06T00:00:00.000Z"));
const cases = [
  { name: "metric credit", pr: "merged", successes: 100, verdict: "credit" },
  { name: "metric debit", pr: "merged", successes: 40, verdict: "debit" },
  { name: "metric release", pr: "merged", verdict: "released" },
  { name: "closed metric debit", pr: "closed", verdict: "debit" },
  { name: "review credit", pr: "merged", review: true, verdict: "credit" },
  { name: "decision credit", pr: "merged", decision: true, verdict: "credit" },
  { name: "closed decision debit", pr: "closed", decision: true, verdict: "debit" },
] as const;

for (const scenario of cases) {
  for (const landedPass of [false, true]) {
    test(`test/a-settled-gardener-pending-forgets-its-held-pass.test.ts: ${scenario.name}, ${landedPass ? "landed pass stays trusted" : "held candidates are offered"}`, () => {
      const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5841-`));
      const path = gardenStatePath(dir, "demo");
      const baseline = { trials: 100, successes: 40 };
      const initial: GardenState<"a"> = {
        classes: { a: { alpha: 100, beta: 1 } },
        pending: {
          prUrl: oldPr, actionClass: "a", baseline, atMerge: baseline,
          mergeSeenAt: new Date(clock.now() - GARDEN_PENDING_RELEASE_MS).toISOString(),
        },
        ...(landedPass ? { lastPass: { fingerprint: "stable", landed: oldPr } } : {}),
      };
      writeFileSync(path, JSON.stringify(initial));
      let cheap = "hold";
      let metric: Outcome = baseline;
      let pr: PrState = "open";
      let reads = 0;
      const landed: string[] = [];
      const verdicts: string[] = [];
      const action: GardenAction<"a"> = { class: "a", target: "held-candidate", reason: "work remains" };
      const spec: GardenSpec<"a", Outcome, GardenAction<"a">, GardenCheckout> = {
        name: "demo", classes: ["a"],
        ...("review" in scenario ? { review: { a: "judged by the PR outcome" } } : {}),
        ...("decision" in scenario ? { decision: ["a"] as const } : {}),
        cheapFingerprint: () => cheap,
        inventory: () => { reads++; return metric; },
        fingerprint: () => "stable",
        metric: (inventory) => inventory,
        candidates: () => [action],
        scorecard: () => ({}),
        apply: (_ws, plan) => {
          assert.deepEqual(plan.actions, [action]);
          return { paths: ["docs/demo.md"], title: "fix(demo): offer held candidate", body: "held work" };
        },
      };
      const deps = {
        stateDir: dir, repoRoot: dir, clock, seed: 1,
        prState: () => pr,
        openWorkspace: (): GardenCheckout => ({
          root: dir, land: () => { landed.push(action.target); return newPr; }, dispose: () => {},
        }),
        log: (step: string, row?: Record<string, unknown>) => {
          if (step === "demo.gardener_judged") verdicts.push(String(row?.verdict));
          if (step === "demo.pending_released") verdicts.push("released");
        },
      };
      runGarden(spec, deps);
      assert.deepEqual(landed, []);
      assert.deepEqual(readGardenState(path, ["a"]).lastPass,
        landedPass ? { fingerprint: "stable", landed: oldPr } : { fingerprint: "stable" });
      for (const waiting of ["open", "unknown"] as const) {
        pr = waiting;
        cheap = waiting;
        assert.equal(runGarden(spec, deps).ran, false, "a waiting verdict keeps the pass trusted");
        assert.equal(readGardenState(path, ["a"]).pending?.prUrl, oldPr);
      }

      pr = scenario.pr;
      const early = pr === "closed" || "review" in scenario || "decision" in scenario;
      if (!early) cheap = "settled";
      if ("successes" in scenario) metric = { trials: 200, successes: scenario.successes };
      const readsBefore = reads;
      runGarden(spec, deps);
      assert.deepEqual(verdicts, [scenario.verdict]);
      if (early) {
        assert.equal(reads, readsBefore, "terminal PR judgment keeps the cheap cadence");
        const settled = readGardenState(path, ["a"]);
        assert.equal(settled.pending, undefined);
        assert.deepEqual(settled.lastPass, landedPass ? { fingerprint: "stable", landed: oldPr } : undefined);
        cheap = "settled";
        runGarden(spec, deps);
      }
      assert.deepEqual(landed, landedPass ? [] : [action.target]);
      const saved = readGardenState(path, ["a"]);
      assert.equal(saved.pending?.prUrl, landedPass ? undefined : newPr);
      assert.deepEqual(saved.lastPass, { fingerprint: "stable", landed: landedPass ? oldPr : newPr });
      cheap = "another-look";
      runGarden(spec, deps);
      assert.deepEqual(landed, landedPass ? [] : [action.target], "a landed pass never re-files unchanged work");
    });
  }
}
