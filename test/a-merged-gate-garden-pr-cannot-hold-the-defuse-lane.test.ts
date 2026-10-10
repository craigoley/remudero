/**
 * W1-T5825: a merged gate-garden PR cannot hold the defuse lane. The gate gardener awaited #9019 (a
 * `refresh`, merged 2026-10-04 02:21Z) for a day because its metric, the fire-rate tally, only grows
 * on a `measured` report and every daily report read `partial`; while a class is pending no class
 * acts, so the defuse class saw an expiring fixture and never filed it. A merged metric-judged
 * pending whose tally never moves is now released after a bound, and `defuse` is judged by its PR's
 * decision, never by a tally that does not measure defusal.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { GATE_GARDEN_CLASSES, gateGardenSpec, loadGateProbes } from "../src/lib/gate-gardener.js";
import {
  GARDEN_PENDING_RELEASE_MS,
  gardenStatePath,
  initialGardenState,
  judgeGardenPending,
  readGardenState,
  runGarden,
  type PrState,
} from "../src/lib/gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const probes = loadGateProbes(ROOT);
const HELD_AT = Date.parse("2026-10-04T02:31:00Z");
const DAY = 86_400_000;
const FILE = "test/fixture.test.ts";
const HELD_PR = "https://github.com/acme/remudero/pull/9019";
const DEFUSE_PR = "https://github.com/acme/remudero/pull/9300";
const FROZEN = { trials: 657, successes: 651 };

/** The live shape read 2026-10-05: a refresh PR merged, a tally frozen at 657/651, and a fixture
 *  crossing inside the defuse lead horizon. Every other gate class is switched off. */
async function heldGarden(pending: Record<string, unknown> = {}, lastPass?: { fingerprint: string }) {
  const repo = gitRepo({ kind: "w1t5825-held-garden" });
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  const stamp = new Date(HELD_AT - 16 * DAY).toISOString();
  put(FILE, `const row = {\n  lastActivityAt: "${stamp}",\n};\n`);
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/comment-load-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put(".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\n        "ci"\n        ]\n      ADVISORY: >-\n        [\n        "dashboard"\n        ]\n');
  put("plan/tasks.yaml", "[]\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed held garden");
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir);
  for (const c of ["tighten", "refresh", "demote"]) put(`state/GATE_OFF-${c}`, "");
  const tally = (o: { trials: number; successes: number }) => put("state/gate-gardener-tally.json", JSON.stringify({ seen: [], ...o }) + "\n");
  tally(FROZEN);
  const state = { ...initialGardenState(GATE_GARDEN_CLASSES), pending: { prUrl: HELD_PR, actionClass: "refresh", baseline: FROZEN, ...pending }, ...(lastPass ? { lastPass } : {}) };
  writeFileSync(gardenStatePath(stateDir, "gate"), JSON.stringify(state, null, 2) + "\n");
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const landed: string[] = [];
  const prStates = new Map<string, PrState>([[HELD_PR, "merged"]]);
  // W1-T6036: the fixture stands for a confirmed bomb — red only once the clock is shifted past it.
  const sources = { thresholdDays: 30, mintTaskId: () => "W1-T6001", openOrigins: () => [] as string[], admissionViolations: () => [], runSuite: (_file: string, shiftDays: number) => shiftDays < 1 };
  const deps = (at: number) => ({
    repoRoot: repo.dir, stateDir, clock: fixedClock(at), seed: 1,
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    prState: (url: string) => prStates.get(url) ?? "open",
    openWorkspace: () => ({
      root: repo.dir, branch: "run-unfiled-1791072000000",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts.title), DEFUSE_PR),
      dispose: () => {},
    }),
  });
  const pass = async (at: number) => runGarden(gateGardenSpec(deps(at), await probes, sources), deps(at));
  const read = () => readGardenState(gardenStatePath(stateDir, "gate"), GATE_GARDEN_CLASSES);
  const fingerprint = async () => { const s = gateGardenSpec(deps(HELD_AT), await probes, sources); return s.fingerprint(s.inventory()); };
  return { pass, read, rows, landed, prStates, tally, fingerprint, step: (s: string) => rows.filter((r) => r.step === s) };
}

test("W1-T5825: a merged pending whose tally never moves is released after the bound and the next pass plans the defuse", async () => {
  const g = await heldGarden();
  const first = await g.pass(HELD_AT);
  assert.deepEqual(first.plan?.actions, [], "while the refresh is pending no class acts");
  assert.equal(first.scorecard?.proposed, 0);
  assert.equal(g.step("gate.scorecard").at(-1)?.extra?.awaiting, HELD_PR);
  assert.equal(g.read().pending?.mergeSeenAt, fixedClock(HELD_AT).iso(), "the merge is stamped when first seen");
  // One minute short of the bound the hold stands: the tally has not moved and nothing is released.
  await g.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS - 60_000);
  assert.equal(g.read().pending?.prUrl, HELD_PR);
  assert.equal(g.step("gate.pending_released").length, 0);
  const released = await g.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS);
  assert.deepEqual(g.step("gate.pending_released").map((r) => r.extra), [{
    pr_url: HELD_PR, action_class: "refresh", waited_ms: GARDEN_PENDING_RELEASE_MS, bound_ms: GARDEN_PENDING_RELEASE_MS,
  }]);
  assert.deepEqual(released.plan?.acting, ["defuse"], "the released lane plans the defuse candidate it saw while held");
  assert.deepEqual(released.plan?.actions.map((a) => a.target), [`expiring-fixture:${FILE}`]);
  assert.equal(released.prUrl, DEFUSE_PR);
  assert.equal(g.step("gate_garden.defuse_filed").length, 1);
  const after = g.read();
  assert.deepEqual(after.classes.refresh, { alpha: 3, beta: 1 }, "a release is neither a credit nor a debit");
  assert.equal(g.step("gate.gardener_judged").length, 0);
  assert.deepEqual(after.pending, { prUrl: DEFUSE_PR, actionClass: "defuse", baseline: { trials: 0, successes: 0 } });
});

test("W1-T5825: a pending held by the code before this fix is stamped once and released a bound later", async () => {
  const g = await heldGarden();
  const fingerprint = await g.fingerprint();
  // The live state: atMerge pinned before the stamp existed, and a held pass's fingerprint naming the
  // expiring fixture, which an unreleased pass would trust as already handled.
  const legacy = await heldGarden({ atMerge: FROZEN }, { fingerprint });
  const first = await legacy.pass(HELD_AT);
  assert.equal(first.ran, false);
  assert.equal(legacy.read().pending?.mergeSeenAt, fixedClock(HELD_AT).iso());
  const released = await legacy.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS);
  assert.equal(legacy.step("gate.pending_released").length, 1);
  assert.deepEqual(released.plan?.acting, ["defuse"], "a fingerprint recorded while held is not trusted once the hold ends");
});

test("W1-T5825: a pending whose tally is conclusive is credited without a release", async () => {
  const credited = await heldGarden();
  await credited.pass(HELD_AT);
  credited.tally({ trials: 857, successes: 851 });
  // A new day changes the cheap fingerprint, as a new fire-rate report would; still inside the bound.
  await credited.pass(HELD_AT + DAY - 3_600_000);
  assert.deepEqual(credited.step("gate.gardener_judged").map((r) => r.extra?.verdict), ["credit"]);
  assert.deepEqual(credited.read().classes.refresh, { alpha: 4, beta: 1 });
  assert.equal(credited.step("gate.pending_released").length, 0);
});

test("W1-T7393: an inconclusive gate tally waits until the bound then frees the defuse lane", async () => {
  const moving = await heldGarden();
  await moving.pass(HELD_AT);
  moving.tally({ trials: 659, successes: 653 });
  const early = await moving.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS - 1);
  assert.equal(moving.read().pending?.prUrl, HELD_PR);
  assert.equal(early.ran, false);
  assert.deepEqual(moving.landed, []);
  assert.equal(moving.step("gate.pending_released").length, 0);
  const late = await moving.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS);
  assert.deepEqual(moving.step("gate.pending_released").map((r) => r.extra), [{
    pr_url: HELD_PR, action_class: "refresh", waited_ms: GARDEN_PENDING_RELEASE_MS,
    bound_ms: GARDEN_PENDING_RELEASE_MS, trials: 2, difference: 1 - FROZEN.successes / FROZEN.trials,
  }]);
  assert.deepEqual(moving.read().classes.refresh, { alpha: 3, beta: 1 });
  assert.equal(moving.step("gate.gardener_judged").length, 0);
  assert.deepEqual(late.plan?.acting, ["defuse"]);
  assert.deepEqual(late.plan?.actions.map((a) => a.target), [`expiring-fixture:${FILE}`]);
  assert.equal(late.prUrl, DEFUSE_PR);
  assert.equal(moving.read().pending?.prUrl, DEFUSE_PR);
  assert.equal(moving.step("gate_garden.defuse_filed").length, 1);
});

test("W1-T5825: a merged defuse PR is settled by its decision, never by the tally", async () => {
  for (const [decision, record] of [["merged", { alpha: 4, beta: 1 }], ["closed", { alpha: 3, beta: 2 }]] as const) {
    const g = await heldGarden();
    await g.pass(HELD_AT);
    await g.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS);
    assert.equal(g.read().pending?.actionClass, "defuse");
    g.prStates.set(DEFUSE_PR, decision);
    await g.pass(HELD_AT + GARDEN_PENDING_RELEASE_MS + 60_000);
    const state = g.read();
    assert.equal(state.pending?.prUrl === DEFUSE_PR, false, `a ${decision} defuse is not awaiting the frozen tally`);
    assert.deepEqual(state.classes.defuse, record);
    assert.deepEqual(g.step("gate.gardener_judged").map((r) => r.extra?.verdict), [decision === "merged" ? "credit" : "debit"]);
  }
  const spec = gateGardenSpec({ repoRoot: ROOT, stateDir: ROOT, openWorkspace: () => { throw new Error("unused"); }, log: () => {} }, await probes);
  assert.deepEqual(Object.keys(spec.review ?? {}), ["demote"], "a defuse is decided by its merge, but it is not a person's call");
});

test("W1-T5825: judging a frozen pending releases only with a clock, at the bound", () => {
  const state = { ...initialGardenState(GATE_GARDEN_CLASSES), pending: { prUrl: HELD_PR, actionClass: "refresh" as const, baseline: FROZEN, atMerge: FROZEN, mergeSeenAt: fixedClock(HELD_AT).iso() } };
  assert.equal(judgeGardenPending(state, FROZEN, "merged").verdict, "waiting", "a caller with no clock keeps today's judgement");
  assert.equal(judgeGardenPending(state, FROZEN, "merged", fixedClock(HELD_AT + GARDEN_PENDING_RELEASE_MS - 1)).verdict, "waiting");
  const released = judgeGardenPending(state, FROZEN, "merged", fixedClock(HELD_AT + GARDEN_PENDING_RELEASE_MS));
  assert.equal(released.verdict, "released");
  assert.equal(released.state.pending, undefined);
  assert.deepEqual(released.state.classes, state.classes);
  assert.equal(judgeGardenPending(state, FROZEN, "open", fixedClock(HELD_AT + 2 * GARDEN_PENDING_RELEASE_MS)).verdict, "waiting", "an open PR is never released");
});
