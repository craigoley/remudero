import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { gardenStatePath, readGardenState, runGarden, runGardenAsync,
  type GardenAction, type GardenCheckout, type GardenSpec, type GardenState } from "#src/lib/gardener.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("terminal gardener feedback is durable before inventory failure and is judged only once", async t => {
  for (const mode of ["sync", "async"] as const) for (const pr of ["merged", "closed", "open", "unknown"] as const) {
    await t.test(`${mode} ${pr}`, async t => {
      const { dir } = ownedFixtureDir(t, "terminal-feedback");
      const path = gardenStatePath(dir, "fixture");
      const initial: GardenState<"draft"> = { classes: { draft: { alpha: 7, beta: 1 } }, lastCheap: "before",
        pending: { prUrl: "https://github.com/acme/demo/pull/10707", actionClass: "draft",
          baseline: { trials: 0, successes: 0 }, targets: [{ class: "draft", target: "declined-target" }] } };
      writeFileSync(path, JSON.stringify(initial));
      let attempt = 0, inventories = 0, prReads = 0;
      const logged: Array<{ verdict: unknown; saved: GardenState<"draft"> }> = [];
      const fail = () => { inventories++; throw new Error("fixture inventory unavailable"); };
      const spec: GardenSpec<"draft", string, GardenAction<"draft">, GardenCheckout> = {
        name: "fixture", classes: ["draft"], decision: ["draft"], cheapFingerprint: () => `attempt-${attempt}`,
        inventory: fail, ...(mode === "async" ? { inventoryAsync: async () => fail() } : {}),
        fingerprint: value => value, candidates: () => { throw new Error("failed inventory cannot offer actions"); },
        scorecard: () => { throw new Error("failed inventory cannot report a scorecard"); },
        apply: () => { throw new Error("failed inventory cannot publish"); },
      };
      const deps = { stateDir: dir, repoRoot: dir,
        openWorkspace: (): GardenCheckout => { throw new Error("no external workspace is requested"); },
        prState: () => { prReads++; return pr; },
        log: (step: string, row: Record<string, unknown> = {}) => {
          if (step === "fixture.gardener_judged") logged.push({ verdict: row.verdict, saved: readGardenState(path, ["draft"]) });
        } };
      for (; attempt < 2; attempt++) {
        if (mode === "async") await assert.rejects(runGardenAsync(spec, deps), /fixture inventory unavailable/);
        else assert.throws(() => runGarden(spec, deps), /fixture inventory unavailable/);
      }
      assert.equal(inventories, 2, "changed input retries are still attempted and still fail");
      const saved = readGardenState(path, ["draft"]), terminal = pr === "merged" || pr === "closed";
      const expected = { alpha: pr === "merged" ? 8 : 7, beta: pr === "closed" ? 2 : 1 };
      assert.deepEqual(saved.classes.draft, expected);
      assert.equal(saved.pending === undefined, terminal);
      assert.equal(logged.length, terminal ? 1 : 0, "one terminal decision is never logged twice after failed inventory");
      assert.equal(prReads, terminal ? 1 : 2);
      if (terminal) {
        assert.equal(logged[0]!.verdict, pr === "merged" ? "credit" : "debit");
        assert.equal(logged[0]!.saved.pending, undefined, "the terminal state was durable before its ledger row");
        assert.deepEqual(logged[0]!.saved.classes.draft, expected);
      }
      if (pr === "closed") assert.ok(saved.declinedTargets?.some(target =>
        target.target === "declined-target" && target.prNumber === 10707), "a failed inventory cannot forget a closed target");
    });
  }
});

test("metric feedback and merge baselines survive a later scorecard failure without repeated decisions", async t => {
  for (const mode of ["sync", "async"] as const) for (const outcome of ["credit", "debit", "waiting", "first-merge", "released"] as const) {
    await t.test(`${mode} ${outcome}`, async t => {
      const { dir } = ownedFixtureDir(t, "metric-feedback");
      const path = gardenStatePath(dir, "fixture"), baseline = { trials: 100, successes: 40 };
      const current = { trials: 200, successes: outcome === "credit" ? 100 : outcome === "debit" ? 40 : 80 };
      const initial: GardenState<"draft"> = { classes: { draft: { alpha: 7, beta: 1 } }, lastCheap: "before",
        pending: { prUrl: "https://github.com/acme/demo/pull/10707", actionClass: "draft", baseline,
          ...(outcome === "first-merge" ? {} : { atMerge: baseline,
            mergeSeenAt: new Date(Date.now() - (outcome === "released" ? 2 * 24 * 3_600_000 : 0)).toISOString() }) } };
      writeFileSync(path, JSON.stringify(initial));
      let attempt = 0, inventories = 0;
      const logged: Array<{ step: string; verdict: unknown; saved: GardenState<"draft"> }> = [];
      const spec: GardenSpec<"draft", string, GardenAction<"draft">, GardenCheckout> = {
        name: "fixture", classes: ["draft"], cheapFingerprint: () => `attempt-${attempt}`,
        inventory: () => { inventories++; return "corpus"; }, fingerprint: value => value,
        metric: () => current, candidates: () => [],
        scorecard: () => { throw new Error("fixture scorecard unavailable"); },
        apply: () => { throw new Error("a failed scorecard cannot publish"); },
      };
      const deps = { stateDir: dir, repoRoot: dir,
        openWorkspace: (): GardenCheckout => { throw new Error("no external workspace is requested"); },
        prState: () => "merged" as const,
        log: (step: string, row: Record<string, unknown> = {}) => {
          if (step === "fixture.gardener_judged" || step === "fixture.pending_released")
            logged.push({ step, verdict: row.verdict, saved: readGardenState(path, ["draft"]) });
        } };
      for (; attempt < 2; attempt++) {
        if (mode === "async") await assert.rejects(runGardenAsync(spec, deps), /fixture scorecard unavailable/);
        else assert.throws(() => runGarden(spec, deps), /fixture scorecard unavailable/);
      }
      const saved = readGardenState(path, ["draft"]), settled = ["credit", "debit", "released"].includes(outcome);
      assert.equal(inventories, 2);
      assert.deepEqual(saved.classes.draft, { alpha: outcome === "credit" ? 8 : 7, beta: outcome === "debit" ? 2 : 1 });
      assert.equal(saved.pending === undefined, settled);
      assert.equal(logged.length, settled ? 1 : 0);
      if (settled) {
        assert.equal(logged[0]!.saved.pending, undefined, "the logged metric decision is already durable");
        assert.equal(logged[0]!.step, outcome === "released" ? "fixture.pending_released" : "fixture.gardener_judged");
        assert.equal(logged[0]!.verdict, outcome === "released" ? undefined : outcome);
      } else assert.deepEqual(saved.pending!.atMerge, outcome === "first-merge" ? current : baseline);
    });
  }
});
