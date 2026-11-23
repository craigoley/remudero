import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { resolveReleasedIds, resolveReleases } from "#src/lib/drain.js";
import { operatorReleasePin } from "#src/lib/operator-release.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { RELEASE_LEDGER_STEP, assertRunnable, mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import { composeSecondaryPlan, findTaskInCatalogs, opsPlanForLookup } from "#src/lib/task-lookup.js";

/**
 * W1-T13386: a `verify: human` task that only the second catalog holds is released by a pin, and two
 * readers must agree on that pin. The daemon's tick hashes the record as the catalog snapshot parsed
 * it; the task's own run first stamps `catalog: "ops"` on every record it composed in. This suite
 * drives both reads over one real catalog read, with the release written once.
 */

const OPS_ID = "W1-T900101", PUBLIC_ID = "W1-T900100", REPOSITORY = "fixture-private/ops";
const shard = (id: string, over: Record<string, string> = {}): string => {
  const fields = { title: `Fixture ${id}`, repo: "remudero", depends_on: "[]", type: "implement", verify: "human", status: "queued", ...over };
  return `- id: ${id}\n${Object.entries(fields).map(([key, value]) => `  ${key}: ${value}\n`).join("")}`;
};
const publicPlan = (text = shard(PUBLIC_ID, { verify: "auto" })): Plan => mergePlanBlobs([{ label: "public.yaml", text }]);
const NEVER_MERGED = () => false;

/** A state directory that names the second repository, and the read-only routes of that repository. */
function catalog(t: TestContext, text = shard(OPS_ID)) {
  const root = mkdtempSync(join(tmpdir(), "rmd-ops-release-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const api: OpsCatalogApi = async path => {
    const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { stateDir, api };
}

/** The plan the task's own run admits against: every record it composed in carries its catalog. */
function planAsTheRunStampsIt(primary: Plan, secondary: Plan): Plan {
  const composition = composeSecondaryPlan(primary, secondary);
  assert.equal(composition.outcome, "ok");
  if (composition.outcome !== "ok") throw new Error("unreachable");
  const tasks = composition.plan.tasks.map(record => composition.secondaryIds.has(record.id) ? { ...record, catalog: "ops" as const } : record);
  return { tasks, byId: new Map(tasks.map(record => [record.id, record])) } as Plan;
}

test("W1-T13386 criterion 2: a release pinned for an ops task is honoured by the tick's release read and by the run's runnable check", async t => {
  const fx = catalog(t), primary = publicPlan();
  const lookup = await findTaskInCatalogs(OPS_ID, { byId: primary.byId, stateDir: fx.stateDir, api: fx.api });
  assert.equal(lookup.outcome, "found"); assert.equal(lookup.catalog, "ops");
  const opsPlan = opsPlanForLookup(lookup)!;

  // The tick: the plan it dispatches from, and the record it hashes.
  const tick = composeSecondaryPlan(primary, opsPlan);
  assert.equal(tick.outcome, "ok");
  if (tick.outcome !== "ok") return;
  const tickRecord = tick.plan.byId.get(OPS_ID)!;
  assert.equal((tickRecord as Task & { catalog?: string }).catalog, undefined, "control: the tick's record carries no provenance stamp");
  const pin = operatorReleasePin(tickRecord);
  const releaseRow = JSON.stringify({ step: RELEASE_LEDGER_STEP, task_id: OPS_ID, run_id: `APPROVE-${OPS_ID}`, released: "verify-human", release_pin: pin });
  const readers = { readLedgerLines: () => [releaseRow] };

  const tickRead = resolveReleases(readers, tick.plan);
  assert.equal(tickRead.ids.has(OPS_ID), true, "the tick honours the release over its composed plan");
  assert.equal(tickRead.reapprovalRequired?.has(OPS_ID), false);

  // The run: the stamped plan, and the stamped task the one lookup hands it.
  const runPlan = planAsTheRunStampsIt(primary, opsPlan), runTask = lookup.task!;
  assert.equal(runTask.catalog, "ops", "control: the run's task carries the stamp");
  assert.equal((runPlan.byId.get(OPS_ID) as Task & { catalog?: string }).catalog, "ops", "control: the run's plan record carries the stamp");
  const runRead = resolveReleases(readers, runPlan);
  assert.deepEqual([...(runRead.reapprovalRequired ?? [])], [], "the run asks for no reapproval of a contract nobody changed");
  assert.doesNotThrow(() => assertRunnable(runPlan, runTask, NEVER_MERGED, resolveReleasedIds(readers, runPlan)),
    "the run admits the task the operator released");
  assert.equal(operatorReleasePin(runTask), pin, "because the provenance stamp does not change the pin");

  // The same release as the durable record `rmd approve` keeps beside the ledger.
  const durable = { readDurableReleases: () => new Map<string, unknown>([[OPS_ID, { at: "2026-11-17T00:00:00.000Z", pin }]]) };
  assert.equal(resolveReleases(durable, tick.plan).ids.has(OPS_ID), true);
  assert.doesNotThrow(() => assertRunnable(runPlan, runTask, NEVER_MERGED, resolveReleasedIds(durable, runPlan)));

  // Controls: the pin still binds the contract, and no release still means no run.
  const amended = { ...runTask, title: "A different contract" };
  assert.notEqual(operatorReleasePin(amended), pin, "a changed contract is a different pin, stamped or not");
  const amendedPlan = { tasks: [...primary.tasks, amended], byId: new Map([...primary.byId, [OPS_ID, amended]]) } as Plan;
  assert.throws(() => assertRunnable(amendedPlan, amended, NEVER_MERGED, resolveReleasedIds(readers, amendedPlan)), /verify:human/);
  assert.throws(() => assertRunnable(runPlan, runTask, NEVER_MERGED, resolveReleasedIds({ readLedgerLines: () => [] }, runPlan)), /verify:human/);
});

test("W1-T13386 criterion 2: a record with no provenance stamp hashes as it did before the stamp was left out", () => {
  // The pre-change algorithm, written out: sorted keys, undefined dropped, the record's own verify
  // hashed (W1-T12224), and only sourcePath, attempts and risk_ruling left out.
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  const before = (task: Record<string, unknown>): string => {
    const { sourcePath: _source, attempts: _attempts, risk_ruling: _ruling, ...contract } = task;
    return createHash("sha256").update(stable(contract)).digest("hex");
  };
  const record = publicPlan(shard(PUBLIC_ID)).byId.get(PUBLIC_ID)!;
  assert.equal(operatorReleasePin(record), before(record as unknown as Record<string, unknown>));
});

// ── The plan `rmd approve` pins from ─────────────────────────────────────────────────────────────
// Loaded on use: on a tree without the helper these tests fail alone, and the pin tests above still run.
async function releasePlan(taskId: string, primary: Plan, sources: { stateDir?: string; api?: OpsCatalogApi }) {
  const { findReleasePlanInCatalogs } = await import("#src/lib/task-lookup.js");
  return findReleasePlanInCatalogs(taskId, primary, sources);
}

test("W1-T13386: the release plan of an ops task is the plan the tick composes, and its record carries no provenance stamp", async t => {
  const fx = catalog(t), primary = publicPlan();
  const found = await releasePlan(OPS_ID, primary, fx);
  assert.equal(found.outcome, "found");
  if (found.outcome !== "found") return;
  assert.equal(found.catalog, "ops");
  const lookup = await findTaskInCatalogs(OPS_ID, { byId: primary.byId, stateDir: fx.stateDir, api: fx.api });
  const tick = composeSecondaryPlan(primary, opsPlanForLookup(lookup)!);
  assert.equal(tick.outcome, "ok");
  if (tick.outcome !== "ok") return;
  assert.deepEqual(found.plan.tasks.map(task => task.id), tick.plan.tasks.map(task => task.id), "both catalogs, in the tick's order");
  assert.deepEqual(found.plan.byId.get(OPS_ID), tick.plan.byId.get(OPS_ID), "the record the tick hashes");
  assert.equal(Object.hasOwn(found.plan.byId.get(OPS_ID)!, "catalog"), false, "no stamp on the pinned record");
  assert.equal(found.plan.byId.get(PUBLIC_ID), primary.byId.get(PUBLIC_ID), "public records are the public plan's own");
});

test("W1-T13386: a public task keeps the public plan and opens no private reader", async t => {
  const fx = catalog(t), primary = publicPlan();
  const forbidden: OpsCatalogApi = async () => { throw new Error("a public hit must not read the ops catalog"); };
  const found = await releasePlan(PUBLIC_ID, primary, { stateDir: fx.stateDir, api: forbidden });
  assert.deepEqual(found, { outcome: "found", catalog: "public", plan: primary });
  if (found.outcome === "found") assert.equal(found.plan, primary, "the very plan the caller loaded");
});

test("W1-T13386: an absent id, an unread catalog and a catalog the tick would hold are three different answers", async t => {
  const fx = catalog(t), primary = publicPlan();
  assert.deepEqual(await releasePlan("W1-T900199", primary, fx), { outcome: "absent" });
  assert.deepEqual(await releasePlan(OPS_ID, primary, { stateDir: undefined, api: fx.api }), { outcome: "absent" }, "a host that names no second catalog");
  const down: OpsCatalogApi = async () => { throw new Error("fixture transport is down"); };
  assert.deepEqual(await releasePlan(OPS_ID, primary, { stateDir: fx.stateDir, api: down }), { outcome: "unreadable", reason: "ops-unreadable" });
  // W1-T13749: an ops task whose own edge the tick holds has no record to pin, and is held with that edge.
  const dangling = catalog(t, shard(OPS_ID, { depends_on: "[W1-T900198]" }));
  assert.deepEqual(await releasePlan(OPS_ID, primary, dangling),
    { outcome: "held", hold: { reason: "invalid_cross_catalog_dependency", task: OPS_ID, dependsOn: "W1-T900198" } });
  // The catalog repeats a public id: the tick holds that id, not the ops task beside it, which is still released.
  const repeated = catalog(t, shard(OPS_ID) + shard(PUBLIC_ID));
  const beside = await releasePlan(OPS_ID, primary, repeated);
  assert.equal(beside.outcome, "found", JSON.stringify(beside));
  if (beside.outcome === "found") assert.equal(beside.plan.byId.has(PUBLIC_ID), false, "neither copy of the repeated id is in the plan it pins from");
});
