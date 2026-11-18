/**
 * W1-T13428 — A SCOUT REFUSAL ROW KEEPS ITS OWN STEP NAME.
 *
 * The scout logged scout.record_refused with the symptom's step in a payload field named `step`; the gardener log
 * spreads the payload after the row's own step, so the row was stored under the symptom's name and the scout then
 * counted it as one more recurrence. The payload now says `symptom_step` and `refused_task_id`, and scoutSymptoms
 * skips the scout's own rows. Rows go through appendLedger into a temporary ledger, shaped as gardenRunCommand logs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { GardenCheckout, GardenerDeps } from "#src/lib/gardener.js";
import { appendLedger } from "#src/lib/ledger.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { SCOUT_WINDOW_MS, scoutGardenSpec, scoutShard, scoutSymptoms } from "#src/lib/scout-gardener.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const RUN = "GARDEN-scout-fixture";
const SCOUT_ORIGIN = { state: "linked", version: 1, name: "scout", passId: "00000000-0000-4000-8000-000000000000" };

/** The gardener log gardenRunCommand builds, into a temporary ledger: the payload spread after the row's own step. */
function gardenerLog(t: TestContext): { log: GardenerDeps["log"]; rows: () => Record<string, unknown>[] } {
  const ledger = writeLedger([], { scope: t });
  return {
    log: (step, extra = {}) => appendLedger(ledger.path, { run_id: RUN, task_id: "DAEMON", step, lane: "daemon", ...extra }),
    rows: () => readLedgerLines(ledger.path) as Record<string, unknown>[],
  };
}

/** A queued test-only scout draft whose re-derivation spans two writers at risk low, which plan lint refuses. */
function refusedRederivation(t: TestContext, log: GardenerDeps["log"]) {
  const repo = gitRepo({ scope: t, kind: "t13428-rederive" });
  const step = "verify_human.release_escalated";
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  for (const file of ["verify-human-judge", "verify-human-release"]) writeFileSync(join(repo.dir, `src/lib/${file}.ts`), `log(${JSON.stringify(step)});`);
  repo.git("add", "src");
  const original = scoutShard({ step, older: 2, newer: 3, total: 5, files: [] }, "W1-T99052", [5]).text.replace("  risk: high", "  risk: low");
  const path = "plan/tasks.d/W1-T99052.yaml";
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, path), original);
  const task = loadPlanFromYaml(original, path).tasks[0]!;
  const spec = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(NOW), log,
    openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => { throw new Error("a re-derived draft keeps its id"); },
    plan: () => ({ all: [task], open: [task], shards: new Map([[task.id, path]]) }),
    ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0, openRunTasks: () => new Set(),
  });
  const actions = spec.candidates(spec.inventory(), () => 0);
  assert.equal(actions.length, 1, "the draft is re-derived");
  const landed = spec.apply({ root: repo.dir, branch: "scout-t13428" } as GardenCheckout, { actions, acting: ["file-uncovered-symptom"] }, {});
  return { step, taskId: task.id, landed, original, text: () => readFileSync(join(repo.dir, path), "utf8") };
}

/** A fresh filing of a recurring symptom whose minted id cannot render, which the renderer refuses. */
function refusedFreshFiling(t: TestContext, log: GardenerDeps["log"]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13428-fresh-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const step = "widget.sync_failed";
  const ledger = [0.9, 0.85, 0.2, 0.15].map((f) => ({ ts: new Date(NOW - SCOUT_WINDOW_MS * f).toISOString(), step }));
  const spec = scoutGardenSpec({ repoRoot: "/unused", stateDir: "/unused", clock: fixedClock(NOW), log,
    openWorkspace: () => { throw new Error("unused"); } }, {
    clock: fixedClock(NOW), ledger: () => ledger, plan: () => ({ open: [], all: [], shards: new Map() }),
    mergedTasks: () => new Map(), mergedLastDay: () => 5, pricedSteps: () => new Set(), fileExists: () => false,
    mintTaskId: () => "W1-T9: [",
  });
  const inv = spec.inventory();
  const landed = spec.apply({ root, branch: "scout-t13428-fresh" } as GardenCheckout,
    { actions: spec.candidates(inv, () => 0), acting: ["file-uncovered-symptom"] }, {});
  return { step, landed, root };
}

test("W1-T13428 criterion 1: a refused re-derivation appends a scout.record_refused row naming its symptom_step", (t) => {
  const ledger = gardenerLog(t);
  const pass = refusedRederivation(t, ledger.log);
  const rows = ledger.rows();
  const refused = rows.filter((r) => r.step === "scout.record_refused");
  assert.equal(refused.length, 1, JSON.stringify(rows));
  assert.equal(refused[0]!.symptom_step, pass.step);
  assert.equal(refused[0]!.refused_task_id, pass.taskId);
  assert.match(String(refused[0]!.reason), /sizing/);
  assert.equal(refused[0]!.task_id, "DAEMON", "the row keeps its own task id");
  assert.equal(rows.filter((r) => r.step === pass.step).length, 0, "no row of the pass carries the symptom's step");
});

test("W1-T13428 criterion 2: a refused fresh filing appends the same row shape, its minted id under refused_task_id", (t) => {
  const ledger = gardenerLog(t);
  const pass = refusedFreshFiling(t, ledger.log);
  const rows = ledger.rows();
  const refused = rows.filter((r) => r.step === "scout.record_refused");
  assert.equal(refused.length, 1, JSON.stringify(rows));
  assert.equal(refused[0]!.symptom_step, pass.step);
  assert.equal(refused[0]!.refused_task_id, "W1-T9: [");
  assert.equal(refused[0]!.task_id, "DAEMON", "the minted id does not replace the row's own task id");
  assert.match(String(refused[0]!.reason), /^unparseable: /);
  assert.equal(rows.filter((r) => r.step === pass.step).length, 0);
});

test("W1-T13428 criterion 3: scoutSymptoms counts no row the scout wrote, and only the real rows of a mixed step", () => {
  const at = (f: number): string => new Date(NOW - SCOUT_WINDOW_MS * f).toISOString();
  const real = (step: string) => [0.9, 0.2, 0.15].map((f) => ({ ts: at(f), step }));
  const scout = (step: string) => [0.95, 0.9, 0.8, 0.3, 0.2, 0.1, 0.05].map((f) => ({ ts: at(f), step, run_id: RUN, gardener_origin: SCOUT_ORIGIN }));
  const symptoms = scoutSymptoms([...scout("sweep.fix.dispatch_failed"), ...real("inbox.draft_error"), ...scout("inbox.draft_error")], NOW, () => false);
  assert.deepEqual(symptoms.map((s) => s.step), ["inbox.draft_error"], "a step with only scout rows is no symptom");
  assert.deepEqual([symptoms[0]!.older, symptoms[0]!.newer, symptoms[0]!.total], [1, 2, 3], "the real rows only");
  const other = { ...SCOUT_ORIGIN, name: "backlog" };
  assert.equal(scoutSymptoms(real("x.run_failed").map((r) => ({ ...r, gardener_origin: other })), NOW, () => false).length, 1,
    "another gardener's rows still count");
});

test("W1-T13428 criterion 4: a refused draft is left byte for byte and a refused fresh filing writes no task file", (t) => {
  const ledger = gardenerLog(t);
  const rederived = refusedRederivation(t, ledger.log);
  assert.equal(rederived.landed, undefined, "nothing lands");
  assert.equal(rederived.text(), rederived.original, "the refused draft is unchanged");
  const fresh = refusedFreshFiling(t, ledger.log);
  assert.equal(fresh.landed, undefined);
  assert.equal(existsSync(join(fresh.root, "plan")), false, "no task file was written");
});
