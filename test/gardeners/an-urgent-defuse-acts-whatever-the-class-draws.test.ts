/**
 * W1-T15073: an urgent defuse acts whatever the class draws.
 *
 * OBSERVED 2026-11-27: the expiring-fixture census reported 55 crossings inside its 7-day margin, yet
 * the gate gardener's passes acted only on the class that won the Beta draw ("compress"), so the
 * defuse class filed nothing while two suites went red under a shifted clock. A fixture deadline is a
 * date, not a sampled preference: a defuse whose crossing is inside the margin preempts the draw.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { GATE_GARDEN_CLASSES, gateGardenSpec, loadGateProbes, type GateGardenAction } from "#src/lib/gate-gardener.js";
import { gardenStatePath, planGarden, runGarden, type GardenCheckout, type GardenerDeps, type GardenState } from "#src/lib/gardener.js";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type C = (typeof GATE_GARDEN_CLASSES)[number];

/** Compress always draws near 1; every other class, defuse included, draws near 0 (below even odds). */
function drawsFavourCompress(): GardenState<C> {
  const classes = Object.fromEntries(GATE_GARDEN_CLASSES.map((c) => [c, c === "compress" ? { alpha: 1000, beta: 1 } : { alpha: 1, beta: 1000 }]));
  return { classes } as GardenState<C>;
}

function defuse(file: string, urgent: boolean): GateGardenAction {
  return {
    class: "defuse", target: file, reason: `a fixture in ${file} crosses its deadline`, file,
    edit: { kind: "defuse", finding: { file, line: 1, daysLeft: urgent ? 3 : 15 } as never, leadDays: 21, urgent },
  };
}

function compress(file: string): GateGardenAction {
  return { class: "compress", target: file, reason: `compress ${file}`, file, edit: { kind: "compress", finding: { file } as never } };
}

async function gateFixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "t15073-gate" });
  t.after(() => repo.cleanup());
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const workspace: GardenCheckout = { root: repo.dir, branch: "run-unfiled-1795800000000", land: () => "https://github.com/acme/remudero/pull/1", dispose: () => {} };
  const logs: { step: string; data: Record<string, unknown> }[] = [];
  const deps: GardenerDeps = {
    repoRoot: repo.dir, stateDir, clock: fixedClock(Date.parse("2026-11-28T12:00:00Z")), seed: 7,
    log: (step, data) => void logs.push({ step, data: (data ?? {}) as Record<string, unknown> }), openWorkspace: () => workspace,
  };
  const spec = gateGardenSpec(deps, await loadGateProbes(REPO_ROOT), { openOrigins: () => [], admissionViolations: () => [] });
  return { stateDir, deps, spec, logs };
}

test("W1-T15073 criterion 1: an urgent defuse candidate acts on the gate gardener's pass while a higher-drawn class has candidates", async (t) => {
  const f = await gateFixture(t);
  writeFileSync(gardenStatePath(f.stateDir, "gate"), JSON.stringify(drawsFavourCompress()) + "\n");
  const actions = [compress("src/lib/a.ts"), defuse("test/a.test.ts", true), defuse("test/b.test.ts", false)];
  let applied: GateGardenAction[] = [];
  // The real spec decides the class; only the inventory and the tree write are stood in for.
  const pass = {
    ...f.spec,
    inventoryAsync: undefined,
    cheapFingerprint: () => "t15073",
    inventory: () => ({ candidates: actions, tally: { trials: 0, successes: 0 } }),
    landingRefusal: undefined,
    prepare: () => [],
    apply: (_ws: GardenCheckout, plan: { actions: GateGardenAction[] }) => { applied = plan.actions; return undefined; },
  };
  runGarden(pass, f.deps);
  const scorecard = f.logs.find((l) => l.step === "gate.scorecard");
  assert.ok(scorecard, "the pass wrote its scorecard");
  assert.deepEqual(scorecard.data.acting, ["defuse"], "the urgent defuse's class acts, not the higher-drawn compress");
  assert.deepEqual(applied.map((a) => a.target).sort(), ["test/a.test.ts", "test/b.test.ts"], "the defuse class acts on its candidates");
});

test("W1-T15073 criterion 2: invariant:draws-decide-without-urgency — with no urgent defuse the chosen class is exactly the draw's choice", async (t) => {
  const f = await gateFixture(t);
  // A guard: it holds on origin/main (no preempt) and with this task's preempt alike.
  const preempt = f.spec.preempt;
  const states: GardenState<C>[] = [
    drawsFavourCompress(),
    { classes: Object.fromEntries(GATE_GARDEN_CLASSES.map((c) => [c, { alpha: 3, beta: 1 }])) } as GardenState<C>,
  ];
  const sets: GateGardenAction[][] = [
    [compress("src/lib/a.ts"), defuse("test/b.test.ts", false)],
    [compress("src/lib/a.ts")],
    [defuse("test/b.test.ts", false), defuse("test/c.test.ts", false)],
  ];
  for (const state of states) {
    for (const candidates of sets) {
      for (let seed = 1; seed <= 40; seed++) {
        const plain = planGarden({ classes: GATE_GARDEN_CLASSES, state, rng: seededRandom(seed), candidates: () => candidates });
        const withPreempt = planGarden({ classes: GATE_GARDEN_CLASSES, state, rng: seededRandom(seed), candidates: () => candidates, preempt });
        assert.deepEqual(withPreempt, plain, `seed ${seed}: no urgent candidate, so the draw alone decides`);
      }
    }
  }
  // A defuse outside the margin still competes on its draw: it loses to compress here.
  const lost = planGarden({ classes: GATE_GARDEN_CLASSES, state: drawsFavourCompress(), rng: seededRandom(3), candidates: () => sets[0]!, preempt });
  assert.deepEqual(lost.acting, ["compress"]);
  // A refused urgent defuse does not preempt, so its class cannot starve the rest.
  const refusedState = { ...drawsFavourCompress(), refusedActions: { "defuse:test/a.test.ts": { at: "2026-11-28T00:00:00Z" } } } as unknown as GardenState<C>;
  const keyed = planGarden({ classes: GATE_GARDEN_CLASSES, state: refusedState, rng: seededRandom(3), candidates: () => [compress("src/lib/a.ts"), defuse("test/a.test.ts", true)], preempt });
  assert.deepEqual(keyed.acting, ["compress"], "a refused urgent defuse falls back to the draw");
});
