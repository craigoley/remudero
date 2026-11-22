import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import type { Escalation } from "#src/lib/escalate.js";
import { REGISTERED_GARDEN_NAMES } from "#src/lib/garden-registry.js";
import { operatorReleasePin } from "#src/lib/operator-release.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { loadPlan, mergePlanBlobs, RELEASE_LEDGER_STEP, type Plan } from "#src/lib/plan.js";
import {
  APPROVE_RELEASE_REFUSED_STEP, approveInChild, clearanceBound, fixDispatchCauseProbe, opsMainCommit, opsRecordDigest, productionStuckStatePorts,
  productionStuckStateProbe, publicRecordDigest, readApproveRelease, readStuckStateRows, recordApproveReleaseRefusal, runStuckStateGardener, scanStuckState,
  type HeldItem, type ProbeResult, type StuckStatePorts,
} from "#src/lib/stuck-state-gardener.js";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { findReleasePlanInCatalogs } from "#src/lib/task-lookup.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/**
 * W1-T13750. Tonight's two `rmd approve` refusals (a pinned public view that held a moved id, then ops W1-T13599
 * depending on public W1-T13733, an id that view lacked) each cleared without code and each needed the operator to
 * re-run his release. #19383's `task catalog unreadable: ops-ref_moved` was escalated by the fix lane's judge minutes
 * before the reader fix that cleared it merged. The gardener here holds such work, re-probes it on the events that can
 * clear it, and re-runs only the refused action, through its own path.
 */

type Row = Record<string, unknown>;
const REPOSITORY = "fixture-private/ops";
const NOW = Date.parse("2026-11-19T00:15:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const shard = (id: string, over: Record<string, string> = {}): string => {
  const fields = { title: `Fixture ${id}`, repo: "remudero", depends_on: "[]", type: "implement", verify: "human", status: "queued", ...over };
  return `- id: ${id}\n${Object.entries(fields).map(([key, value]) => `  ${key}: ${value}\n`).join("")}`;
};
const planOf = (...texts: string[]): Plan => mergePlanBlobs([{ label: "public.yaml", text: texts.join("") }]);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** A state directory naming the ops repository, and that repository's read-only routes over a text a test may change. */
function opsCatalog(t: TestContext, initial: string) {
  let text = initial;
  const root = mkdtempSync(join(tmpdir(), "rmd-stuck-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const api: OpsCatalogApi = async path => {
    const commit = sha1(text), tree = sha1(commit + "root"), plan = sha1(commit + "plan");
    const blob = sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
    const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { root, stateDir, api, read: () => readOpsCatalogSnapshotAsync({ repository: REPOSITORY }, api),
    set: (next: string) => { text = next; }, commit: () => sha1(text) };
}

/** The gardener over one in-memory ledger, the operator's approve release path, and counted probes. */
function harness(fx: ReturnType<typeof opsCatalog>, publicPlan: Plan, probe?: (item: HeldItem) => Promise<ProbeResult>) {
  const h = {
    ledger: [] as Row[], logged: [] as Row[], escalations: [] as Escalation[], approveCalls: [] as string[][], probes: [] as string[],
    now: NOW, publicPlan, publicCommit: "a".repeat(40), refuseNextRetry: false,
  };
  const lookup = { stateDir: fx.stateDir, api: fx.api };
  /** In-memory approve port for the gardener's retry and failure cases. */
  const approvePath = async (id: string): Promise<number> => {
    const held = await findReleasePlanInCatalogs(id, h.publicPlan, lookup);
    if (held.outcome === "absent") return 2;
    if (held.outcome !== "found" || h.refuseNextRetry) {
      h.refuseNextRetry = false;
      recordApproveReleaseRefusal(id, held.outcome === "found" ? { reason: "compose-invalid_cross_catalog_dependency" } : refusalOf(held), {
        opsSnapshot: await fx.read(), append: row => h.ledger.push({ ts: iso(h.now), ...row }), publicCommit: h.publicCommit });
      return 1;
    }
    if (h.ledger.some(row => row.step === RELEASE_LEDGER_STEP && row.task_id === id)) return 0;
    h.ledger.push({ ts: iso(h.now), run_id: `APPROVE-${id}`, task_id: id, step: RELEASE_LEDGER_STEP, released: "verify-human",
      release_pin: operatorReleasePin(held.plan.byId.get(id)!) });
    return 0;
  };
  const realProbe = productionStuckStateProbe({ stateDir: fx.stateDir, publicPlan: () => h.publicPlan, api: fx.api, destinationRead: async () => undefined });
  const ports: StuckStatePorts = {
    stateDir: fx.stateDir,
    readRows: () => h.ledger,
    log: (step, extra = {}) => { const row = { ts: iso(h.now), step, ...extra }; h.ledger.push(row); h.logged.push(row); },
    escalate: e => { h.escalations.push(e); return `https://github.com/o/r/issues/${h.escalations.length}`; },
    eventStamps: { "public-main": () => h.publicCommit, "ops-main": () => fx.commit() },
    probe: async item => { h.probes.push(item.className); return (probe ?? realProbe)(item); },
    approve: async (...args: string[]) => { h.approveCalls.push(args); return approvePath(args[0]!); },
    nowMs: () => h.now,
  };
  const pass = async (advanceMs = MIN) => { h.now += advanceMs; await runStuckStateGardener(ports); };
  return { h, ports, pass, operatorApprove: approvePath };
}

const steps = (rows: readonly Row[], step: string) => rows.filter(row => row.step === step);

/** A composition refusal reason or the held edge that the fixture presents to the gardener. */
function refusalOf(answer: object): { reason: string; edge?: string } {
  if ("reason" in answer && typeof answer.reason === "string") return { reason: answer.reason };
  const hold = (answer as { hold: { reason: string; task: string; dependsOn?: string } }).hold;
  return { reason: `held-${hold.reason}`, edge: hold.dependsOn === undefined ? `${hold.task} in both catalogs` : `${hold.task} -> ${hold.dependsOn}` };
}
test("W1-T13750 criterion 1: the approve lookup and production probe read the pinned public plan", async t => {
  const id = "W1-T13599", dependency = "W1-T13733";
  const fx = opsCatalog(t, shard(id, { depends_on: "[W1-T13733]" }));
  const checkout = gitRepo({ scope: t, seedCommit: false });
  const planPath = join(checkout.dir, "plan", "tasks.yaml");
  const before = shard("W1-T13700", { verify: "auto" });
  mkdirSync(join(checkout.dir, "plan"));
  writeFileSync(planPath, before);
  checkout.git("add", "plan/tasks.yaml");
  checkout.git("commit", "--quiet", "-m", "fixture public plan");
  const publicCommit = checkout.git("rev-parse", "HEAD");
  checkout.git("update-ref", "refs/remotes/origin/main", publicCommit);

  const rows: Row[] = [];
  const lookup = { stateDir: fx.stateDir, api: fx.api };
  const release = () => readApproveRelease(id, loadPlan(planPath), checkout.dir, lookup, row => rows.push({ ts: iso(NOW), ...row }));
  assert.equal((await release())?.outcome, "held");
  const ops = await fx.read();
  assert.deepEqual(rows, [{
    ts: iso(NOW), run_id: `APPROVE-${id}`, task_id: id, step: APPROVE_RELEASE_REFUSED_STEP,
    class: "release-compose", reason: "held-invalid_cross_catalog_dependency", edge: `${id} -> ${dependency}`,
    public_commit: publicCommit, ops_commit: fx.commit(), ops_record_digest: opsRecordDigest(ops.plan!.byId.get(id)!),
  }]);
  const [item] = scanStuckState(rows).open;
  assert.equal(item?.signature, `held-invalid_cross_catalog_dependency ${id} -> ${dependency}`);
  const ports = productionStuckStatePorts({
    stateDir: fx.stateDir, api: fx.api, publicRoot: checkout.dir, publicMainCommit: () => publicCommit,
    log: () => {}, escalate: () => null, destinationRead: async () => undefined, approve: async () => 0, gardenNames: [],
  });

  writeFileSync(planPath, before + shard(dependency, { verify: "auto" }));
  assert.equal((await ports.probe(item!)).present, true, "an uncommitted dependency cannot clear the refusal");
  checkout.git("commit", "--quiet", "-am", "add public dependency");
  checkout.git("update-ref", "refs/remotes/origin/main", "HEAD");
  checkout.git("checkout", "--quiet", "--detach", publicCommit);
  assert.equal(loadPlan(planPath).byId.has(dependency), false, "the boot checkout still lacks the dependency");
  assert.deepEqual(await ports.probe(item!), { present: false, digest: rows[0]?.ops_record_digest });
  assert.equal((await release())?.outcome, "found");
  assert.equal(rows.length, 1, "a successful lookup writes no refusal");
});

test("W1-T13750 criterion 2: a held item is re-probed only on an event its class names, once per event", async t => {
  const fx = opsCatalog(t, shard("W1-T900201"));
  const present = async (): Promise<ProbeResult> => ({ present: true, reason: "still" });
  const { h, pass } = harness(fx, planOf(shard("W1-T900200", { verify: "auto" })), present);
  h.ledger.push({ ts: iso(NOW - MIN), step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T900201", class: "release-compose", reason: "compose-malformed", ops_record_digest: "d" },
    { ts: iso(NOW - MIN), step: "ci-friction.garden_filing_failed", reason: "plan destination is unreadable at pulls" });
  const count = (name: string) => h.probes.filter(p => p === name).length;
  const counts = () => [count("release-compose"), count("garden-filing-destination-unreadable")];
  await pass();
  assert.equal(steps(h.logged, "stuck_state.held").length, 2);
  await pass(); await pass();
  assert.deepEqual(counts(), [0, 0], "no event since the hold: no probe read");
  h.publicCommit = "b".repeat(40);
  await pass();
  assert.deepEqual(counts(), [1, 0], "a public origin/main commit probes the class that names it, once");
  await pass();
  assert.deepEqual(counts(), [1, 0]);
  fx.set(shard("W1-T900201") + shard("W1-T900202"));
  await pass();
  assert.deepEqual(counts(), [2, 1], "an ops main commit: once each");
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.boot" });
  await pass();
  assert.deepEqual(counts(), [3, 2], "a daemon boot: once each");
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.memory_pressure", tier: "elevated" });
  await pass();
  assert.deepEqual(counts(), [3, 2], "pressure rising is no clearing event");
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.memory_pressure", tier: "clear" });
  await pass();
  assert.deepEqual(counts(), [3, 3], "memory pressure back to normal: only the class that names it");
  await pass();
  assert.deepEqual(counts(), [3, 3]);
});

test("W1-T13750 criterion 3: an item escalates once, on its class's own clearance bound or a still-present cause after its clearing event", async t => {
  const fx = opsCatalog(t, shard("W1-T900301"));
  const { h, pass } = harness(fx, planOf(shard("W1-T900300", { verify: "auto" })), async () => ({ present: true, reason: "still" }));
  const T0 = NOW - 24 * 60 * MIN;
  const opsKey = "ops-dispatch-hold|ops-dispatch|source_pending";
  for (let i = 0; i < 3; i++) {
    h.ledger.push({ ts: iso(T0 + i * 10 * MIN), step: "dispatch.ops_catalog_held", outcome: "source_pending" },
      { ts: iso(T0 + i * 10 * MIN + MIN), step: "stuck_state.cleared", key: opsKey });
  }
  h.ledger.push({ ts: iso(T0), step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T900310", class: "release-compose", reason: "compose-malformed" },
    { ts: iso(T0 + 60 * MIN), step: RELEASE_LEDGER_STEP, task_id: "W1-T900310" });
  assert.deepEqual(clearanceBound("ops-dispatch-hold", h.ledger), { ms: MIN, basis: "class", samples: 3 });
  assert.deepEqual(clearanceBound("release-compose", h.ledger), { ms: 60 * MIN, basis: "class", samples: 1 });
  assert.deepEqual(clearanceBound("garden-filing-destination-unreadable", h.ledger), { ms: 60 * MIN, basis: "any-class", samples: 4 },
    "a class with no recovered episode takes the longest of any class");
  const boots = ["2026-11-18T00:12:44.679Z", "2026-11-18T03:02:59.402Z", "2026-11-18T03:23:47.852Z", "2026-11-18T04:09:18.956Z"].map(ts => ({ ts, step: "daemon.boot" }));
  assert.deepEqual(clearanceBound("release-compose", boots), { ms: Date.parse(boots[3]!.ts) - Date.parse(boots[2]!.ts), basis: "boot-gap", samples: 3 },
    "with none at all, the median gap between daemon.boot rows");
  assert.equal(clearanceBound("release-compose", []), undefined);

  h.ledger.push({ ts: iso(NOW), step: "dispatch.ops_catalog_held", outcome: "source_pending" },
    { ts: iso(NOW), step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T900301", class: "release-compose", reason: "compose-malformed", ops_record_digest: "d" });
  await pass(1000);
  assert.equal(steps(h.logged, "stuck_state.held").length, 2);
  await pass(10 * MIN);
  assert.equal(h.escalations.length, 1, "ten minutes is past the short class's bound");
  assert.equal(steps(h.logged, "stuck_state.escalated")[0]?.subject, "ops-dispatch", "the same age leaves the longer class unescalated");
  await pass(MIN);
  assert.equal(h.escalations.length, 1, "a second pass never escalates it again");
  await pass(60 * MIN);
  assert.equal(h.escalations.length, 2, "the longer class escalates past its own bound");
  assert.equal(steps(h.logged, "stuck_state.escalated")[1]?.subject, "task:W1-T900301");
  await pass(MIN);
  assert.equal(h.escalations.length, 2);

  // The clearing event: a public commit does not escalate a present cause, a daemon boot does, once.
  h.ledger.push({ ts: iso(h.now), step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T900302", class: "release-compose", reason: "compose-malformed", ops_record_digest: "d" });
  await pass(1000);
  h.publicCommit = "b".repeat(40);
  await pass(1000);
  assert.equal(h.escalations.length, 2, "a present cause after a public commit is not yet the class's clearing event");
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.boot" });
  await pass(1000);
  assert.equal(h.escalations.length, 3, "a present cause after the boot that clears this class escalates");
  assert.match(String(steps(h.logged, "stuck_state.escalated")[2]?.reason), /after daemon-boot/);
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.boot" });
  await pass(1000);
  assert.equal(h.escalations.length, 3, "and never again");
});

test("W1-T13750 criterion 4: a release whose ops record changed since the refusal is not replayed, and is escalated once", async t => {
  const fx = opsCatalog(t, shard("W1-T13599", { depends_on: "[W1-T13733]" }));
  const { h, pass, operatorApprove } = harness(fx, planOf(shard("W1-T13700", { verify: "auto" })));
  assert.equal(await operatorApprove("W1-T13599"), 1);
  const recorded = steps(h.ledger, APPROVE_RELEASE_REFUSED_STEP)[0]!.ops_record_digest;
  await pass();
  fx.set(shard("W1-T13599", { depends_on: "[W1-T13733]", title: '"A different contract"' }));
  h.publicPlan = planOf(shard("W1-T13700", { verify: "auto" }), shard("W1-T13733", { verify: "auto" }));
  h.publicCommit = "b".repeat(40);
  await pass();
  assert.deepEqual(h.approveCalls, [], "the changed record is not released");
  const changed = steps(h.logged, "stuck_state.record_changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.recorded_digest, recorded);
  assert.notEqual(changed[0]!.current_digest, recorded);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0]!.detail, /changed since the operator's refused release/);
  h.publicCommit = "c".repeat(40);
  h.ledger.push({ ts: iso(h.now + 1), step: "daemon.boot" });
  await pass();
  assert.deepEqual(h.approveCalls, []);
  assert.equal(h.escalations.length, 1, "escalated once");
  assert.equal(steps(h.ledger, RELEASE_LEDGER_STEP).length, 0);
});

const HEAD = "76dd0d7854bfdb9ffe4dc768093d8e7841896968";
const UNION_BOOTS = ["2026-11-18T00:12:44.679Z", "2026-11-18T03:02:59.402Z", "2026-11-18T03:23:47.852Z", "2026-11-18T04:09:18.956Z",
  "2026-11-18T06:19:16.789Z", "2026-11-18T09:23:58.919Z", "2026-11-18T12:55:15.158Z"];
const replay19383 = (): Row[] => [
  ...UNION_BOOTS.map(ts => ({ ts, step: "daemon.boot", run_id: "DAEMON" })),
  ...["2026-11-18T13:35:27.959Z", "2026-11-18T13:44:33.328Z"].map(ts => ({ ts, run_id: "DAEMON-1795006451613-7", task_id: "DAEMON",
    step: "sweep.fix.dispatch_failed", pr_number: 19383, head_sha: HEAD, error: "task catalog unreadable: ops-ref_moved" })),
];
const pr19383 = (at: number): OpenPrView => ({ prNumber: 19383, prUrl: "https://github.com/craigoley/remudero/pull/19383", taskId: "W1-T13653",
  headSha: HEAD, headRefName: "run-W1-T13653-1795008551380", reviewState: "success", checksState: "green", unmetCriteria: [],
  priorStrikes: 0, lastActivityAt: iso(at), autoMergeArmed: false, mergeState: "dirty",
  mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" } });

async function sweep19383(at: number, rows: Row[], probe?: SweepDeps["fixDispatchCauseProbe"]) {
  const escalations: string[] = [];
  let dispatched = 0;
  const deps: SweepDeps = { arm: () => {}, close: () => {}, dispatchFix: () => { dispatched++; },
    escalate: (_pr, reason) => { escalations.push(String(reason)); }, runId: `replay-${at}`, ledgerPath: "/unused", now: () => at,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: iso(at), ...row }); },
    fixProgressJudge: async () => ({ verdict: "escalate", loop: "sweep.fix.dispatch_failed: task catalog unreadable: ops-ref_moved",
      reason: "Zero fix rounds have run. Both dispatches failed before any worker started, with the same error." }),
    workerAdmissionHold: () => undefined, ...(probe ? { fixDispatchCauseProbe: probe } : {}) };
  await runSweep([pr19383(at)], deps);
  return { escalations, dispatched, disposed: rows.findLast(row => row.step === "sweep.disposed") };
}

test("W1-T13750 criterion 5: the sweep's fix-dispatch hold reads the registered probe for a task catalog unreadable cause", async t => {
  const at = Date.parse("2026-11-18T13:49:33.350Z");
  const base = await sweep19383(at, replay19383());
  assert.equal(base.escalations.length, 1, "control, base behaviour: an unprobed cause takes the judge's escalate verdict");
  assert.equal(base.dispatched, 0);

  let read: "clear" | "present" = "present";
  const reads: string[] = [];
  const probe = async (cause: string) => { reads.push(cause); return read; };
  const rows = replay19383();
  const held = await sweep19383(at, rows, probe);
  assert.deepEqual(held.escalations, [], "it holds without escalating while the fresh ops catalog read fails");
  assert.equal(held.dispatched, 0, "and still holds the dispatch");
  assert.equal(held.disposed?.probe_result, "present");
  assert.equal(held.disposed?.escalation_deferred, true);
  assert.equal(held.disposed?.cause_bound_basis, "boot-gap", "bounded by the union's own boot gaps, with no recovered episode yet");
  const again = await sweep19383(at + 4 * MIN, rows, probe);
  assert.deepEqual(again.escalations, []);
  read = "clear";
  const lifted = await sweep19383(at + 8 * MIN, rows, probe);
  assert.equal(lifted.dispatched, 1, "the first pass after the read answers ok runs the next fix dispatch");
  assert.deepEqual(lifted.escalations, []);
  assert.ok(reads.every(cause => cause === "task catalog unreadable: ops-ref_moved"));

  // Past the class's derived bound, a cause still present takes the judge's verdict as before.
  const late = await sweep19383(at + 4 * 60 * MIN, replay19383(), async () => "present");
  assert.equal(late.escalations.length, 1, "the bound, not a fixed age, ends the deferral");

  // The production probe: an unregistered cause is not probed; a registered one reads the ops catalog afresh.
  const effectsRoot = mkdtempSync(join(tmpdir(), "rmd-stuck-effects-"));
  t.after(() => rmSync(effectsRoot, { recursive: true, force: true }));
  const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root: effectsRoot },
    ledgerPath: "/unused", runId: "effects", plan: { tasks: [], byId: new Map() }, log: () => {} } as never);
  assert.equal(await effects.fixDispatchCauseProbe!("transport failed <n>"), undefined);
  assert.equal(await effects.fixDispatchCauseProbe!("task catalog unreadable: ops-ref_moved"), "clear", "no ops catalog named: nothing left to read");
  const fx = opsCatalog(t, shard("W1-T900501"));
  assert.equal(await fixDispatchCauseProbe("task catalog unreadable: ops-ref_moved", { stateDir: fx.stateDir, api: fx.api }), "clear");
  assert.equal(await fixDispatchCauseProbe("task catalog unreadable: ops-ref_moved", { stateDir: fx.stateDir, api: async () => { throw new Error("502"); } }), "present");
});

test("W1-T13750 criterion 6: the daemon runs the gardener as the registered garden stuck-state", () => {
  assert.ok((REGISTERED_GARDEN_NAMES as readonly string[]).includes("stuck-state"));
});

test("W1-T13750 criterion 7: the only action on held work is the refused action's own path, after its probe passes", async t => {
  const text = shard("W1-T13599", { depends_on: "[W1-T13733]" }) + shard("W1-T13601");
  const fx = opsCatalog(t, text);
  const { h, pass, operatorApprove } = harness(fx, planOf(shard("W1-T13700", { verify: "auto" })));
  // The tick names a held task the operator never asked to release.
  h.ledger.push({ ts: iso(NOW), step: "dispatch.ops_catalog_held", outcome: "invalid_cross_catalog_dependency", task_id: "W1-T13601" });
  assert.equal(await operatorApprove("W1-T13599"), 1);
  await pass();
  h.publicPlan = planOf(shard("W1-T13700", { verify: "auto" }), shard("W1-T13733", { verify: "auto" }));
  h.publicCommit = "b".repeat(40);
  h.refuseNextRetry = true;
  await pass();
  assert.deepEqual(h.approveCalls, [["W1-T13599"]], "the probe passed: one retry through the approve path, the id and nothing else");
  assert.equal(steps(h.logged, "stuck_state.retried")[0]?.exit_code, 1, "the retry refused again is recorded");
  assert.equal(steps(h.logged, "stuck_state.cleared").filter(row => row.class === "release-compose").length, 0, "and held");
  await pass(); await pass();
  assert.deepEqual(h.approveCalls, [["W1-T13599"]], "never repeated until another clearing event");
  fx.set(text + shard("W1-T13602"));
  await pass();
  assert.deepEqual(h.approveCalls, [["W1-T13599"], ["W1-T13599"]], "the next clearing event retries once more");
  assert.equal(steps(h.logged, "stuck_state.cleared").filter(row => row.class === "release-compose").length,
    steps(h.logged, "stuck_state.held").filter(row => row.class === "release-compose").length, "every refusal of the task is cleared by that one release");
  assert.deepEqual(steps(h.ledger, RELEASE_LEDGER_STEP).map(row => row.task_id), ["W1-T13599"], "no id the operator never tried is released");
  assert.ok(h.logged.every(row => /^stuck_state\./.test(String(row.step))), `the gardener writes only its own rows: ${h.logged.map(r => r.step).join(", ")}`);
  assert.deepEqual(readdirSync(fx.stateDir).sort(), ["plan-destination.json", "stuck-state.json"], "and no file but its own state");

  // Two refusals of one task with different reasons (before and after W1-T13749's per-task holds) share one retry.
  const twice = opsCatalog(t, shard("W1-T13599", { depends_on: "[W1-T13733]" }));
  const both = harness(twice, planOf(shard("W1-T13700", { verify: "auto" })));
  for (const refusal of [{ reason: "compose-invalid_cross_catalog_dependency" }, { reason: "held-invalid_cross_catalog_dependency", edge: "W1-T13599 -> W1-T13733" }]) {
    recordApproveReleaseRefusal("W1-T13599", refusal, { opsSnapshot: await twice.read(),
      append: row => both.h.ledger.push({ ts: iso(both.h.now), ...row }) });
  }
  await both.pass();
  assert.equal(steps(both.h.logged, "stuck_state.held").length, 2);
  both.h.publicPlan = planOf(shard("W1-T13700", { verify: "auto" }), shard("W1-T13733", { verify: "auto" }));
  both.h.publicCommit = "b".repeat(40);
  await both.pass();
  assert.deepEqual(both.h.approveCalls, [["W1-T13599"]], "one release for the task, never a second call");
  assert.equal(steps(both.h.logged, "stuck_state.retried").length, 1);
  assert.equal(steps(both.h.logged, "stuck_state.cleared").length, 2, "and both refusals are cleared by it");
});

test("W1-T13750 criterion 8: replays of tonight's compose refusals and #19383 never escalate a class that cleared within its bound", async t => {
  // The first shape: the pinned public view still held an id the ops catalog held; it cleared at the 23:49Z boot.
  const first = opsCatalog(t, shard("W1-T13580") + shard("W1-T13590", { depends_on: "[W1-T13580]" }) + shard("W1-T13591", { depends_on: "[W1-T13580]" }));
  const one = harness(first, planOf(shard("W1-T13580", { verify: "auto" })));
  one.h.ledger.push(...UNION_BOOTS.map(ts => ({ ts, step: "daemon.boot" })));
  one.h.now = Date.parse("2026-11-18T23:35:00.000Z");
  for (const id of ["W1-T13590", "W1-T13591"]) assert.equal(await one.operatorApprove(id), 1);
  assert.ok(steps(one.h.ledger, APPROVE_RELEASE_REFUSED_STEP).every(row => /^(?:compose|held)-duplicate_task_id$/.test(String(row.reason))));
  await one.pass();
  one.h.publicCommit = "b".repeat(40);
  await one.pass(5 * MIN);
  one.h.publicPlan = planOf(shard("W1-T13700", { verify: "auto" }));
  one.h.ledger.push({ ts: "2026-11-18T23:49:00.000Z", step: "daemon.boot" });
  one.h.now = Date.parse("2026-11-18T23:49:30.000Z");
  await one.pass(0);
  assert.deepEqual(one.h.approveCalls, [["W1-T13590"], ["W1-T13591"]]);
  assert.deepEqual(one.h.escalations, []);

  // The second shape: ops W1-T13599 depended on an id the public view lacked; ops #172 dropped the edge at 00:32:33Z.
  const dependants = shard("W1-T13610", { depends_on: "[W1-T13599]" }) + shard("W1-T13611", { depends_on: "[W1-T13599]" });
  const second = opsCatalog(t, shard("W1-T13599", { depends_on: "[W1-T13733]" }) + dependants);
  const two = harness(second, planOf(shard("W1-T13700", { verify: "auto" })));
  two.h.ledger.push(...UNION_BOOTS.map(ts => ({ ts, step: "daemon.boot" })), { ts: "2026-11-18T23:49:00.000Z", step: "daemon.boot" });
  two.h.now = Date.parse("2026-11-19T00:15:00.000Z");
  for (const id of ["W1-T13610", "W1-T13611"]) assert.equal(await two.operatorApprove(id), 1);
  await two.pass();
  two.h.publicCommit = "b".repeat(40);
  await two.pass(5 * MIN);
  assert.equal(two.h.approveCalls.length, 0, "a public commit that does not reach the view leaves the cause present");
  second.set(shard("W1-T13599") + dependants);
  two.h.now = Date.parse("2026-11-19T00:32:40.000Z");
  await two.pass(0);
  assert.deepEqual(two.h.approveCalls, [["W1-T13610"], ["W1-T13611"]]);
  assert.deepEqual(two.h.escalations, []);

  // #19383 at the gardener: the fix lane's own class, held, then cleared by its probe once the daemon booted on the fix.
  const third = opsCatalog(t, shard("W1-T13653"));
  const three = harness(third, planOf(shard("W1-T13700", { verify: "auto" })));
  three.h.ledger.push(...replay19383());
  three.h.now = Date.parse("2026-11-18T13:45:00.000Z");
  await three.pass(0);
  three.h.ledger.push({ ts: "2026-11-18T14:30:00.000Z", step: "daemon.boot" });
  three.h.now = Date.parse("2026-11-18T14:31:00.000Z");
  await three.pass(0);
  assert.equal(steps(three.h.logged, "stuck_state.cleared")[0]?.retry, "self", "the sweep's own next dispatch is the retry");
  assert.deepEqual(three.h.approveCalls, []);
  assert.deepEqual(three.h.escalations, []);
  // And at the sweep: the same rows within the derived bound escalate nothing (criterion 5's head run).
  assert.deepEqual((await sweep19383(Date.parse("2026-11-18T13:49:33.350Z"), replay19383(), async () => "present")).escalations, []);
});

test("W1-T13750 production ports: the ledger union, the events, each class's probe and every failure arm", async t => {
  const fx = opsCatalog(t, shard("W1-T13599", { depends_on: "[W1-T13733]" }) + shard("W1-T13610", { depends_on: "[W1-T13599]" }));
  // The ledger union, through the keyed async reader: a rotation and the live file, its own steps only.
  writeFileSync(join(fx.stateDir, "ledger.2026-11-18T23-27-33-439Z.ndjson.gz"), gzipSync([
    JSON.stringify({ ts: "2026-11-18T23:20:00.000Z", step: "daemon.boot" }),
    JSON.stringify({ ts: "2026-11-18T23:21:00.000Z", step: "review.posted" }),
    JSON.stringify({ ts: "2026-11-18T23:22:00.000Z", step: "flow.garden_filing_failed", reason: "plan destination is unreadable at pulls" }),
  ].join("\n") + "\n"));
  writeFileSync(join(fx.stateDir, "ledger.ndjson"), [
    JSON.stringify({ ts: "2026-11-19T00:15:00.000Z", step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T13610", class: "release-compose", reason: "compose-x" }),
    JSON.stringify({ ts: "2026-11-19T00:16:00.000Z", step: "flow.scorecard", pr_url: null }),
    JSON.stringify({ ts: "2026-11-19T00:17:00.000Z", step: "scout.garden_filing_failed", reason: "plan destination is unreadable at pulls" }),
  ].join("\n") + "\n");
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await readStuckStateRows(fx.stateDir, ["flow"])).map(row => row.step).sort(), [APPROVE_RELEASE_REFUSED_STEP, "daemon.boot", "flow.garden_filing_failed"]);
  }
  let approved: string[] = [];
  const ports = productionStuckStatePorts({ stateDir: fx.stateDir, log: () => {}, escalate: () => null, publicMainCommit: () => "f".repeat(40),
    publicRoot: fx.root, destinationRead: async () => undefined, api: fx.api,
    approve: async id => { approved = [id]; return 0; }, gardenNames: ["flow", "scout"] });
  assert.equal((await ports.readRows()).length, 4);
  assert.equal(await ports.eventStamps["public-main"]!(), "f".repeat(40));
  assert.equal(await ports.eventStamps["ops-main"]!(), fx.commit());
  assert.equal(await ports.approve("W1-T13610"), 0);
  assert.deepEqual(approved, ["W1-T13610"]);
  assert.equal(productionStuckStatePorts({ stateDir: fx.stateDir, log: () => {}, escalate: () => null, publicMainCommit: () => undefined,
    publicRoot: fx.root, destinationRead: async () => undefined, approve: async () => 0, gardenNames: [] }).stateDir, fx.stateDir, "with no api injected the ports build the host default");
  assert.equal(await opsMainCommit(fx.stateDir, async () => { throw new Error("transport"); }), undefined);
  assert.equal(await opsMainCommit(join(fx.root, "no-state"), fx.api), undefined);

  // The approve port: the operator's own verb in a child, the id and nothing else, its exit code the answer.
  const spawned: Array<{ file: string; args: readonly string[]; guard: string | undefined }> = [];
  const child = (fail?: unknown) => approveInChild({ execPath: "/node", execArgv: ["--import", "tsx"], entry: "src/run-task.ts", env: {},
    run: async (file, args, options) => { spawned.push({ file, args, guard: options.env.RMD_SELF_SYNC_DONE }); if (fail !== undefined) throw fail; return {}; } });
  assert.equal(await child()("W1-T13610"), 0);
  assert.deepEqual(spawned[0], { file: "/node", args: ["--import", "tsx", "src/run-task.ts", "approve", "W1-T13610"], guard: "1" });
  assert.equal(await child(Object.assign(new Error("exit 2"), { code: 2 }))("W1-T13610"), 2, "a refused approve's exit code");
  assert.equal(await child(new Error("spawn failed"))("W1-T13610"), 1, "a child that never ran is a failed retry");
  assert.equal(typeof approveInChild(), "function", "the default runs this process's own entry");

  // Every class's probe over the same reads the refused action makes.
  const item = (className: HeldItem["className"], extra: Partial<HeldItem> = {}): HeldItem =>
    ({ key: className, className, subject: "s", signature: "x", openedAt: NOW, ...extra });
  const probe = (publicPlan: Plan, api = fx.api, destinationRead = async () => undefined as unknown) =>
    productionStuckStateProbe({ stateDir: fx.stateDir, publicPlan: () => publicPlan, api, destinationRead });
  const lacking = planOf(shard("W1-T13700", { verify: "auto" })), holding = planOf(shard("W1-T13733", { verify: "auto" }));
  assert.deepEqual(await probe(lacking)(item("garden-filing-destination-unreadable")), { present: false });
  assert.deepEqual(await probe(lacking, fx.api, async () => { throw new Error("plan destination is unreadable at pulls"); })(item("garden-filing-destination-unreadable")),
    { present: true, reason: "plan destination is unreadable at pulls" });
  const failing: OpsCatalogApi = async () => { throw new Error("502"); };
  assert.deepEqual(await probe(lacking)(item("fix-dispatch-catalog-unreadable")), { present: false });
  assert.equal((await probe(lacking, failing)(item("fix-dispatch-catalog-unreadable"))).present, true);
  assert.equal((await probe(lacking, failing)(item("ops-dispatch-hold"))).present, true);
  const malformed = { tasks: [], byId: new Map([["W1-T1", {}]]) } as unknown as Plan;
  assert.deepEqual(await probe(malformed)(item("ops-dispatch-hold")), { present: true, reason: "compose-malformed" });
  assert.deepEqual(await probe(holding)(item("ops-dispatch-hold")), { present: false });
  assert.equal((await probe(lacking)(item("release-compose", { taskId: "W1-T13610" }))).present, true, "a refusal or a per-task hold is the cause present");
  assert.deepEqual(await probe(malformed)(item("release-compose", { taskId: "W1-T13610" })), { present: true, reason: "compose-malformed" });
  const released = await probe(holding)(item("release-compose", { taskId: "W1-T13610" }));
  assert.equal(released.present, false);
  assert.match(String(released.digest), /^[0-9a-f]{64}$/);
  // Amended in place by W1-T13785: a release found public names the public record's digest, which is never the ops digest an
  // ops refusal row recorded, so a task now in the public plan is still never replayed on that refusal.
  const nowPublic = planOf(shard("W1-T13733", { verify: "auto" }), shard("W1-T13611"));
  const foundPublic = await probe(nowPublic)(item("release-compose", { taskId: "W1-T13611" }));
  assert.deepEqual(foundPublic, { present: false, digest: publicRecordDigest(nowPublic.byId.get("W1-T13611")!) },
    "a task now in the public plan has no ops record: the probe names its public record's digest");
  assert.notEqual(foundPublic.digest, opsRecordDigest(nowPublic.byId.get("W1-T13611")!), "so it is never replayed on an ops record's refusal");
  writeFileSync(join(fx.stateDir, "plan-destination.json"), "{not json");
  assert.deepEqual(await probe(lacking)(item("fix-dispatch-catalog-unreadable")), { present: true, reason: "ops-destination-unreadable" });

  // Failure arms: a refusal row that cannot be written, a state file that cannot be parsed, a pass that throws.
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    recordApproveReleaseRefusal("W1-T13610", { reason: "compose-malformed" }, { opsSnapshot: await fx.read(), append: () => { throw new Error("disk full"); } });
  } finally { console.error = original; }
  assert.match(errors[0] ?? "", /could not record the refusal of 'W1-T13610': disk full/);
  const rows: Row[] = [];
  for (const reason of ["ops-unreadable", "destination-unreadable"]) {
    recordApproveReleaseRefusal("W1-T13610", { reason }, { append: row => rows.push(row) });
  }
  assert.equal(rows.length, 0, "a catalog read that failed writes nothing: it has no record to replay");
  recordApproveReleaseRefusal("W1-T13610", { reason: "compose-malformed" }, { append: row => rows.push(row) });
  assert.deepEqual([rows[0]?.class, rows[0]?.ops_record_digest, rows[0]?.public_commit], ["release-compose", null, null],
    "a refusal without an ops record has no digest, so it is never replayed");
  writeFileSync(join(fx.stateDir, "stuck-state.json"), "{torn");
  const logged: Row[] = [];
  const base: StuckStatePorts = { stateDir: fx.stateDir, readRows: () => [], log: (step, extra) => { logged.push({ step, ...extra }); },
    escalate: () => null, eventStamps: {}, probe: async () => ({ present: true }), approve: async () => 0 };
  await runStuckStateGardener(base);
  assert.deepEqual(logged, [], "an unreadable state with nothing held writes nothing");
  await runStuckStateGardener({ ...base, readRows: () => { throw new Error("ledger unreadable"); } });
  assert.deepEqual(logged, [{ step: "stuck-state.gardener_failed", error: "ledger unreadable" }]);

  // An item the action's own path cleared before the next pass (the operator re-ran his release) is recorded as cleared.
  const lane: Row[] = [{ ts: iso(NOW), step: APPROVE_RELEASE_REFUSED_STEP, task_id: "W1-T13610", class: "release-compose", reason: "compose-malformed" }];
  await runStuckStateGardener({ ...base, readRows: async () => lane, nowMs: () => NOW + MIN });
  lane.push({ ts: iso(NOW + 2 * MIN), step: RELEASE_LEDGER_STEP, task_id: "W1-T13610" });
  await runStuckStateGardener({ ...base, readRows: () => lane, nowMs: () => NOW + 3 * MIN });
  assert.equal((logged.at(-1) as Row | undefined)?.cleared_by, "own-path");
  assert.deepEqual(scanStuckState(lane).recovered.get("release-compose"), [2 * MIN]);
});
