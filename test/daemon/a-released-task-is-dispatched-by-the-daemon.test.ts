import { operatorReleasePin } from "#src/lib/operator-release.js";
/**
 * W1-T10348 — A RELEASED verify:human TASK IS DISPATCHED BY THE DAEMON.
 *
 * READ 2026-10-21: `runDaemon` built its `dispatchOpts` with no `releasedIds`, so drain.ts filed every
 * verify:human task under `verify-not-auto` however it was released. W1-T6372, W1-T7271 and W1-T7736,
 * released with `rmd approve` on 2026-10-13, had zero dispatch rows in 8 days. The machine-filing judge's
 * durable route (pin the release on the record) was masked too: its `settled` map, written for an earlier
 * escalate ruling, carries the same pin a release leaves unchanged.
 *
 * These tests drive the REAL daemon loop and the REAL judge, never a source-text check.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock, type Clock } from "#src/lib/clock.js";
// Namespace imports, so the file still loads at a base without this task's exports and each test fails on its own.
import * as daemonLib from "#src/lib/daemon.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import * as drainLib from "#src/lib/drain.js";
import { runDrain, type DispatchFilterReason } from "#src/lib/drain.js";
import type { GardenCheckout } from "#src/lib/gardener.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import { recordOperatorRelease, runMachineFilingJudge, type MachineJudgePorts } from "#src/lib/machine-filing-judge.js";
import { loadPlan, parseTasksFromYaml, RELEASE_LEDGER_STEP, type Plan, type Task } from "#src/lib/plan.js";
import type { RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import * as runTask from "#src/run-task.js";

type Row = { step: string; extra: Record<string, unknown> };

const release = (taskId: string, machine = false, task: Task = parseTasksFromYaml(record(taskId), "release-fixture")[0]!) =>
  JSON.stringify({
    run_id: `APPROVE-${taskId}`, task_id: taskId, step: RELEASE_LEDGER_STEP, released: "verify-human", release_pin: operatorReleasePin(task),
    ...(machine ? { released_by: "verify-human-judge", author_class: "machine" } : {}),
  });

function durable(ids: string[], plan?: Plan) {
  return new Map(ids.map(id => [id, { at: "2026-10-24T10:00:00Z", pin: operatorReleasePin(plan?.byId.get(id) ?? parseTasksFromYaml(record(id), "release-fixture")[0]!) }]));
}

function record(id: string, over: { verify?: string; files?: string[]; dependsOn?: string[]; status?: string; extra?: string[] } = {}): string {
  return [
    `- id: ${id}`,
    `  title: ${id}`,
    "  repo: remudero",
    "  type: implement",
    `  depends_on: [${(over.dependsOn ?? []).join(", ")}]`,
    `  verify: ${over.verify ?? "human"}`,
    `  status: ${over.status ?? "queued"}`,
    `  files: [${(over.files ?? [`src/${id}.ts`]).join(", ")}]`,
    ...(over.extra ?? []),
  ].join("\n");
}

function planOf(t: TestContext, ...records: string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t10348-plan-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, records.join("\n") + "\n");
  return loadPlan(file);
}

/** Pins a current escalate ruling on a record, as the machine-filing judge leaves one it parked. */
function escalated(plan: Plan, id: string): Plan {
  const task = plan.byId.get(id)! as Task;
  task.risk_ruling = {
    verdict: "high", action: "escalate", confidence: 0.9, reasons: ["touches a security gate"],
    judged_at: "2026-10-14T00:00:00.000Z", pin: taskRulingPin(task),
  } as Task["risk_ruling"];
  return plan;
}

/** The real daemon loop over `ticks` polls: what it dispatched and every row it wrote. */
async function drive(plan: Plan, deps: Partial<DaemonDeps>, ticks = 3) {
  const spawned: string[] = [];
  const rows: Row[] = [];
  let polls = 0;
  const summary = await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        spawned.push(id);
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sleep: async () => {},
      checkStop: () => (++polls > ticks ? "test stop" : undefined),
      log: (step, extra = {}) => rows.push({ step, extra }),
      ...deps,
    } as DaemonDeps,
    { headroomEnabled: false, max: 1 },
  );
  const named = rows.filter((r) => r.step === "dispatch.released_filtered").map((r) => r.extra);
  return { spawned, rows, named, summary };
}

// ── 1. THE DAEMON PASSES THE RELEASED SET ─────────────────────────────────────────────────────────

test("W1-T10348: the daemon dispatches an operator-released verify:human task", async (t) => {
  const plan = () => planOf(t, record("W1-T1"), record("W1-T2"));
  const released = await drive(plan(), { readLedgerLines: () => [release("W1-T1")] });
  assert.deepEqual(released.spawned, ["W1-T1"], "the daemon's own tick selects and dispatches the released task");

  // Regression guards: the wall still stands for everything the operator did not name.
  const unreleased = await drive(plan(), { readLedgerLines: () => [] });
  assert.deepEqual(unreleased.spawned, [], "an unreleased verify:human task is still filtered");
  assert.deepEqual(unreleased.named, [], "and it is not a released task, so no released_filtered row names it");
  const unwired = await drive(plan(), {});
  assert.deepEqual(unwired.spawned, [], "no reader wired yields an empty set");
  assert.equal(drainLib.resolveReleasedIds({}, plan()).size, 0);
});

test("W1-T10348: a machine release with no escalate ruling dispatches; one over a current-pin escalation does not", async (t) => {
  const clear = await drive(planOf(t, record("W1-T3")), { readLedgerLines: () => [release("W1-T3", true)] });
  assert.deepEqual(clear.spawned, ["W1-T3"]);
  const parked = await drive(escalated(planOf(t, record("W1-T3")), "W1-T3"), { readLedgerLines: () => [release("W1-T3", true)] });
  assert.deepEqual(parked.spawned, [], "a second machine judge may not overrule an escalation that went to a person");
  // An operator release over the same escalation is the person's answer to it.
  const operator = await drive(escalated(planOf(t, record("W1-T3")), "W1-T3"), {
    readLedgerLines: () => [release("W1-T3", true), release("W1-T3")],
  });
  assert.deepEqual(operator.spawned, ["W1-T3"]);
  // A stale escalate pin (the record changed since it was judged) no longer stands.
  const stale = escalated(planOf(t, record("W1-T3")), "W1-T3");
  stale.byId.get("W1-T3")!.risk_ruling!.pin = "0".repeat(64);
  assert.deepEqual((await drive(stale, { readLedgerLines: () => [release("W1-T3", true)] })).spawned, ["W1-T3"]);
});

test("W1-T10348: the console kick keeps admitting an operator release, and the release record is read once per tick", async (t) => {
  let kicks = [{ taskId: "W1-T5", origin: "console-w1t10348" }];
  const kicked = await drive(planOf(t, record("W1-T4", { verify: "auto" }), record("W1-T5")), {
    readDurableReleases: () => durable(["W1-T5"]),
    pendingKicks: () => kicks,
    clearKick: (id) => { kicks = kicks.filter((k) => k.taskId !== id); },
  });
  assert.deepEqual(kicked.spawned, ["W1-T5"], "the kicked task is the durable release, ahead of the auto task");
  assert.ok(kicked.rows.some((r) => r.step === "console.kick_dispatched" && r.extra.task === "W1-T5"));

  // Six released candidates, one tick: the release record is read once, never once per candidate (W1-T6358).
  let durableReads = 0;
  const ids = ["W1-T11", "W1-T12", "W1-T13", "W1-T14", "W1-T15", "W1-T16"];
  const many = await drive(planOf(t, ...ids.map((id) => record(id))), {
    readDurableReleases: () => { durableReads += 1; return durable(ids); },
  });
  assert.equal(many.spawned.length, 1);
  assert.equal(many.summary.stopReason, "max_reached");
  assert.equal(durableReads, 1, "one tick, one read, six eligibility questions");
});

// ── 2. THE DURABLE RECORD ─────────────────────────────────────────────────────────────────────────

test("W1-T10348: a release that rotation shed is still honoured from operator-releases.json", async (t) => {
  const plan = () => planOf(t, record("W1-T6"));
  // The daemon: the ledger has rotated the row away; only the durable file remembers the release.
  const daemon = await drive(plan(), { readLedgerLines: () => [], readDurableReleases: () => durable(["W1-T6"]) });
  assert.deepEqual(daemon.spawned, ["W1-T6"]);

  // The run child and `rmd drain` read the same two records through the production reader pair.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t10348-state-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = ledgerPathFor({ root } as never);
  writeFileSync(ledgerPath, JSON.stringify({ step: "sweep.disposed", task_id: "W1-T9" }) + "\n");
  assert.equal(drainLib.resolveReleasedIds(runTask.releaseReadersFor(ledgerPath), plan()).has("W1-T6"), false, "positive control: nothing released yet");
  recordOperatorRelease(join(root, "state"), plan().byId.get("W1-T6")!, "2026-10-13T00:00:00.000Z");
  const resolved = drainLib.resolveReleases(runTask.releaseReadersFor(ledgerPath), plan());
  assert.ok(resolved.ids.has("W1-T6"), "the run child's admission reads operator-releases.json");
  assert.equal(resolved.authors.get("W1-T6"), "operator");

  const dispatched: string[] = [];
  await runDrain(plan(), {
    refreshMerged: () => () => false,
    runOne: async (id: string) => {
      dispatched.push(id);
      return { taskId: id, runId: `R-${id}`, merged: true, verdict: "merged", costUsd: 0 };
    },
    ...runTask.releaseReadersFor(ledgerPath),
    log: () => {},
  } as never, { max: 1 });
  assert.deepEqual(dispatched, ["W1-T6"], "`rmd drain` honours the durable release too");

  // An unreadable durable file releases nothing more and is named; the ledger's releases still stand.
  writeFileSync(join(root, "state", "operator-releases.json"), "{ not json");
  const broken = await drive(planOf(t, record("W1-T6"), record("W1-T7")), {
    ...runTask.releaseReadersFor(ledgerPath),
    readLedgerLines: () => [release("W1-T7")],
  });
  assert.deepEqual(broken.spawned, ["W1-T7"]);
  assert.ok(broken.rows.some((r) => r.step === "dispatch.releases_unreadable" && typeof r.extra.durable_error === "string"));

  // A throwing ledger reader never throws into selection and does not hide the durable releases.
  const throwing = drainLib.resolveReleases({
    readLedgerLines: () => { throw new Error("EACCES: ledger unreadable"); },
    readDurableReleases: () => durable(["W1-T8"]),
  }, planOf(t, record("W1-T6"), record("W1-T8")));
  assert.deepEqual([...throwing.ids], ["W1-T8"]);
  assert.equal(throwing.ledgerUnreadable, "EACCES: ledger unreadable");
});

// ── 4. A RELEASED TASK THAT DISPATCH FILTERS OUT IS NAMED ─────────────────────────────────────────

test("W1-T10348: a released task dispatch filters out is named with its reason", async (t) => {
  const plan = escalated(
    planOf(
      t,
      record("W1-T20", { extra: ["  dispatch_hold: true"] }),
      record("W1-T21", { files: [".github/workflows/ci.yml"] }),
      record("W1-T22", { dependsOn: ["W1-T29"] }),
      record("W1-T23"),
      record("W1-T24"),
      record("W1-T29", { verify: "auto", status: "blocked" }),
    ),
    "W1-T23",
  );
  const { spawned, named } = await drive(plan, {
    readLedgerLines: () => [release("W1-T23", true, plan.byId.get("W1-T23")!), release("W1-T21", false, plan.byId.get("W1-T21")!), release("W1-T22", false, plan.byId.get("W1-T22")!)],
    readDurableReleases: () => durable(["W1-T20"], plan),
  }, 4);
  assert.deepEqual(spawned, [], "a release lifts verify:human only: holds, workflow paths, deps and escalations still stand");
  const byTask = (id: string) => named.filter((n) => n.task === id);
  assert.deepEqual(byTask("W1-T20"), [{ task: "W1-T20", reason: "blocked", release_author: "operator" }], "a dispatch_hold, named once over four ticks");
  assert.deepEqual(byTask("W1-T21"), [{ task: "W1-T21", reason: "operator-build", release_author: "operator" }], "a workflow path still routes to operator-build (W1-T5351)");
  assert.deepEqual(byTask("W1-T22"), [{ task: "W1-T22", reason: "unmet-deps", release_author: "operator" }]);
  assert.deepEqual(byTask("W1-T23"), [{
    task: "W1-T23", reason: "verify-not-auto", release_author: "machine", set_aside: "current-pin escalate ruling",
  }], "a machine release set aside under a standing escalation is named, not silent");
  assert.deepEqual(byTask("W1-T24"), [], "an unreleased task is the idle tally's, not this row's");
  assert.deepEqual(byTask("W1-T29"), []);

  // A changed reason is named again; a repeated one is not.
  const rows: Record<string, unknown>[] = [];
  const tallied: string[] = [];
  const named2 = new Set<string>();
  const resolved = drainLib.resolveReleases({ readLedgerLines: () => [release("W1-T20", false, plan.byId.get("W1-T20")!)] }, plan);
  const onFiltered = daemonLib.releasedFilteredLogger(resolved, named2, (task) => tallied.push(task.id), (step, extra) => rows.push({ step, ...extra }));
  const task = plan.byId.get("W1-T20")!;
  for (const reason of ["blocked", "blocked", "run-branch-already-pushed", "blocked"] as DispatchFilterReason[]) onFiltered(task, reason);
  assert.deepEqual(rows.map((r) => r.reason), ["blocked", "run-branch-already-pushed"]);
  assert.equal(tallied.length, 4, "the idle tally still sees every filter");
});

test("W1-T10348: a released task still meets an open PR and a pushed run branch", async (t) => {
  const plan = () => planOf(t, record("W1-T30"), record("W1-T31"));
  const skipped = await drive(plan(), {
    readLedgerLines: () => [release("W1-T30"), release("W1-T31")],
    isOpenPr: (id) => (id === "W1-T30" ? 4242 : undefined),
    readPushedRunBranches: () => `${"a".repeat(40)}\trefs/heads/run-W1-T31-1790000000000\n`,
  });
  assert.deepEqual(skipped.spawned, []);
  assert.ok(skipped.rows.some((r) => r.step === "dispatch.skipped" && r.extra.task === "W1-T30" && r.extra.reason === "open-pr"));
  assert.ok(skipped.rows.some((r) => r.step === "dispatch.skipped" && r.extra.task === "W1-T31" && r.extra.reason === "run-branch-already-pushed"));
});

// ── 5. THE JUDGE PINS AN OPERATOR RELEASE OVER A SETTLED ESCALATION ───────────────────────────────

const EARLIER = fixedClock(1790980000000);
const LATER = fixedClock(1790990000000);
const SHARD = "plan/tasks.d/W1-T9700-x.yaml";

function machineShard(id: string): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    "  priority: 1",
    `  origin: ${JSON.stringify(`ci-friction:${id}`)}`,
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${files[0]}"`,
    "",
  ].join("\n");
}

function tree(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t10348-${prefix}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, SHARD), machineShard("W1-T9700"));
  return root;
}

/** Each workspace is a fresh copy of `main`; `land` merges its changed paths into `main`. */
function landingOnto(t: TestContext, main: string) {
  let lands = 0;
  const openWorkspace = (): GardenCheckout => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t10348-landing-`));
    cpSync(join(main, "plan"), join(root, "plan"), { recursive: true });
    return {
      root,
      land: ({ paths }) => {
        const changed = paths.filter((p) => readFileSync(join(root, p), "utf8") !== readFileSync(join(main, p), "utf8"));
        if (changed.length === 0) throw new Error("Command failed: git commit (exit 1)");
        for (const p of changed) writeFileSync(join(main, p), readFileSync(join(root, p), "utf8"));
        lands += 1;
        return `https://github.com/o/r/pull/${9900 + lands}`;
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  };
  return { openWorkspace, lands: () => lands };
}

test("W1-T10348: the judge pins an operator release over a settled escalation", async (t) => {
  const stale = tree(t, "stale");
  const main = tree(t, "main");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t10348-judge-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const landing = landingOnto(t, main);
  const high = async (): Promise<RiskJudgeVerdict> => ({ verdict: "high", confidence: 0.95, reasons: ["touches a security gate"] });
  const pass = async (clock: Clock, released: string[] = []) => {
    const logs: Row[] = [];
    const ports: MachineJudgePorts = {
      stateDir,
      plan: () => loadPlan(join(stale, "plan", "tasks.yaml")),
      riskJudge: high,
      openWorkspace: landing.openWorkspace,
      prState: () => "merged",
      stageProposal: () => undefined,
      log: (step, extra = {}) => void logs.push({ step, extra }),
      clock,
      operatorReleases: () => durable(released, loadPlan(join(stale, "plan", "tasks.yaml"))),
    };
    return { report: await runMachineFilingJudge(ports), logs };
  };
  const onMain = () => loadPlan(join(main, "plan", "tasks.yaml")).byId.get("W1-T9700")!;

  // The judge escalates; its PR merges while the daemon's checkout lags, so the next pass finds the
  // escalation already on main and settles it by the record's pin (W1-T5359): the host's state today.
  const first = await pass(EARLIER);
  assert.deepEqual(first.report.escalated, ["W1-T9700"]);
  assert.equal(onMain().risk_ruling?.action, "escalate");
  const second = await pass(EARLIER);
  assert.deepEqual(second.report.settled, ["W1-T9700"], "positive control: the escalation is settled");
  cpSync(join(main, SHARD), join(stale, SHARD)); // the checkout catches up: the record carries the escalation
  const record = loadPlan(join(stale, "plan", "tasks.yaml")).byId.get("W1-T9700")!;
  assert.equal(record.risk_ruling?.pin, taskRulingPin(record), "the escalation stands at the record's current pin");
  assert.deepEqual((await pass(LATER)).logs, [], "unreleased, the settled escalation is not re-asked");

  // The operator releases it. The release changes no pin, so the settled escalation must not mask it.
  const released = await pass(LATER, ["W1-T9700"]);
  assert.deepEqual(released.report.proceeded, ["W1-T9700"], "the release is pinned on the record");
  assert.equal(landing.lands(), 2);
  assert.equal(onMain().risk_ruling?.verdict, "operator");
  assert.equal(onMain().verify, "auto");

  // While the checkout still lags, the landed release settles once and then stays quiet (W1-T5406).
  const lagging = await pass(LATER, ["W1-T9700"]);
  assert.deepEqual(lagging.report.settled, ["W1-T9700"]);
  assert.deepEqual((await pass(LATER, ["W1-T9700"])).logs, [], "a settled release is not rendered again");
  assert.equal(landing.lands(), 2);
});
