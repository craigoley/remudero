import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { CONFIG_GARDEN_CLASSES, CONFIG_GARDEN_LEDGER_STEPS, configGardenSpec, runConfigGarden, type ConfigInventory } from "../src/lib/config-gardener.js";
import { GARDEN_PENDING_RELEASE_MS, gardenEffectsPath, gardenNeedsInventory, gardenStatePath, type GardenerDeps, type PrState } from "../src/lib/gardener.js";
import { gatherRuns, type LedgerRecord } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T5668 — a pending garden PR keeps `gardenPassDue` true, but the pass then returns on an unchanged cheap
 * fingerprint without reading the inventory, so `runConfigGarden` must not build the 60-day inventory first.
 */
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const PR = "https://github.com/fixture/repo/pull/7";
const EMPTY: ConfigInventory = { nowIso: new Date(NOW).toISOString(), runs: [], queued: [], recommendations: [], active: [], cooling: [] };

function fixture(t: { after(fn: () => void): void }, prState: PrState, pending: Record<string, unknown> | undefined = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pending-no-inventory-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const events: string[] = [];
  const prLookups: string[] = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir, clock: fixedClock(NOW), seed: 7,
    log: (step) => void events.push(step),
    openWorkspace: () => { throw new Error("no workspace expected"); },
    prState: (url) => { prLookups.push(url); return prState; },
  };
  const state = (extra: Record<string, unknown>) => writeFileSync(gardenStatePath(stateDir, "config"), JSON.stringify({
    classes: Object.fromEntries(CONFIG_GARDEN_CLASSES.map((c) => [c, { alpha: 3, beta: 1 }])), lastCheap: "same", ...(pending ? { pending: { prUrl: PR, actionClass: "recalibrate-budget", baseline: { trials: 0, successes: 0 }, ...pending } } : {}), ...extra,
  }));
  return { root, stateDir, deps, events, prLookups, state };
}

function counted(deps: GardenerDeps, cheap: () => string) {
  const calls = { inventory: 0 };
  const spec = { ...configGardenSpec(deps), cheapFingerprint: cheap, inventory: async () => { calls.inventory++; return EMPTY; } };
  return { calls, spec };
}

test("unit test: test/a-pending-config-garden-pr-reads-no-inventory.test.ts: a pending open garden PR with an unchanged cheap fingerprint builds no inventory", async (t) => {
  const f = fixture(t, "open");
  f.state({});
  const { calls, spec } = counted(f.deps, () => "same");
  const pass = await runConfigGarden(spec, f.deps);
  assert.equal(pass.ran, false);
  assert.equal(calls.inventory, 0, "the unchanged pass reads no inventory");
  assert.equal(f.prLookups.length, 1, "the pending PR's state is asked for once for the whole pass");

  const changed = counted(f.deps, () => "changed");
  await runConfigGarden(changed.spec, f.deps);
  assert.equal(changed.calls.inventory, 1, "positive control: a changed fingerprint still builds the inventory");
});

test("a merged pending PR whose metric has no baseline yet, or whose release is due, still builds the inventory", async (t) => {
  const terminal = fixture(t, "merged");
  terminal.state({});
  const a = counted(terminal.deps, () => "same");
  await runConfigGarden(a.spec, terminal.deps);
  assert.equal(a.calls.inventory, 1, "a merged metric class pins its baseline from one inventory");

  const stamped = { atMerge: { trials: 1, successes: 1 } };
  const fresh = fixture(t, "merged", { ...stamped, mergeSeenAt: new Date(NOW - 1000).toISOString() });
  fresh.state({});
  const b = counted(fresh.deps, () => "same");
  await runConfigGarden(b.spec, fresh.deps);
  assert.equal(b.calls.inventory, 0, "a stamped merge inside the release bound reads nothing");

  const frozen = fixture(t, "merged", { ...stamped, mergeSeenAt: new Date(NOW - GARDEN_PENDING_RELEASE_MS).toISOString() });
  frozen.state({});
  const c = counted(frozen.deps, () => "same");
  await runConfigGarden(c.spec, frozen.deps);
  assert.equal(c.calls.inventory, 1, "a frozen metric's release is due on the clock");
});

test("gardenNeedsInventory mirrors the returns before the inventory", (t) => {
  const needs = (f: ReturnType<typeof fixture>, cheap: string, prState?: PrState) =>
    gardenNeedsInventory({ ...configGardenSpec(f.deps), cheapFingerprint: () => cheap }, f.deps, prState);

  const closed = fixture(t, "closed");
  closed.state({});
  assert.equal(needs(closed, "same", "closed"), false, "a closed PR is judged without an inventory on an unchanged fingerprint");
  assert.equal(needs(closed, "other", "closed"), true);

  const effects = fixture(t, "open");
  effects.state({});
  writeFileSync(gardenEffectsPath(effects.stateDir, "config"), "");
  assert.equal(needs(effects, "same", "open"), true, "waiting overseer effects are folded by the pass");

  const retry = fixture(t, "open", undefined);
  retry.state({ filingFailures: { count: 1, lastAt: new Date(NOW).toISOString(), reason: "x" } });
  assert.equal(needs(retry, "other"), false, "a filing retry wait reads nothing");

  const idle = fixture(t, "open", undefined);
  idle.state({});
  assert.equal(needs(idle, "same"), false);
  assert.equal(needs(idle, "other"), true);
});

test("gatherRuns over the filtered read attributes a run whose first pr_url row is one of the four steps", () => {
  const steps = ["acceptance.repair.unrepresentable", "changeset_claim.repaired", "retro.pr.recovered", "pr.body_normalize.error"];
  for (const step of steps) assert.ok(CONFIG_GARDEN_LEDGER_STEPS.includes(step), `${step} is in the filtered read`);
  const url = "https://github.com/fixture/repo/pull/9";
  const rows: LedgerRecord[] = steps.flatMap((step, i) => [
    { run_id: `w${i}`, task_id: `T-${i}`, step: "run.start", type: "implement" },
    { run_id: `w${i}`, step: "implement.done", cost_usd: 2, num_turns: 3 },
    { run_id: `w${i}`, step, pr_url: `${url}${i}` },
  ]);
  const filtered = rows.filter((row) => CONFIG_GARDEN_LEDGER_STEPS.includes(String(row.step)));
  assert.equal(filtered.length, rows.length, "no row of these runs is dropped by the filter");
  const gathered = gatherRuns(filtered);
  assert.deepEqual(gathered.map((r) => r.prUrl), steps.map((_, i) => `${url}${i}`));
  assert.deepEqual(gathered, gatherRuns(rows));
});
