import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects, createSweepFixAdmissionController, fixAdmissionCauseProbe, fixDispatchHoldAtHead,
  fixDispatchHoldAtHeadAsync, fixDispatchMemoryCause, runSweep,
  type FixAdmissionResidents, type FixHostPressure, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";

const NOW = Date.parse("2026-11-19T17:57:29Z");
const PASS_MS = 5 * 60_000;
const pr: OpenPrView = { prNumber: 19695, prUrl: "https://github.com/craigoley/remudero/pull/19695",
  taskId: "W1-T12041", headSha: "0a66a11", headRefName: "run-W1-T12041-1795100000000",
  reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false, mergeState: "dirty",
  mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" } };
const at = (ms: number) => new Date(ms).toISOString();
const MEMORY = "fix dispatch refused: worker admission refused (live host capacity exhausted for this full pass " +
  "(headroom 6149 MiB over the floor; charged 0 MiB for 0 reviews at 2048 and 0 MiB for 0 admitted fixes; a fix needs " +
  "6258 MiB (measured; typical 1754); 8 active, 0 fixes admitted) — repair remains queued and will be re-derived next pass)";
const STAND_IN = "fix dispatch refused: worker admission refused (host worker budget 4 exhausted for this full pass " +
  "(4 active, 0 reserved for review, 0 fixes admitted) — repair remains queued and will be re-derived next pass)";
const failure = (ms: number, error = MEMORY, headSha = pr.headSha) => ({ step: "sweep.fix.dispatch_failed",
  pr_number: pr.prNumber, task_id: pr.taskId, head_sha: headSha, error, ts: at(ms) });
const dispatch = (ms: number, headSha: string) => ({ step: "fix.dispatch", pr_number: pr.prNumber,
  task_id: pr.taskId, head_sha: headSha, ts: at(ms) });
const pass = (ms: number) => ({ step: "sweep.disposed", pr_number: pr.prNumber, head_sha: pr.headSha, ts: at(ms) });
/** A learned 40 min failure-to-success wait at an older head, two memory refusals at this head, and two passes 5 min apart. */
const seed = (): Record<string, unknown>[] => [failure(NOW - 10 * 3_600_000, MEMORY, "1111111"),
  dispatch(NOW - 10 * 3_600_000 + 40 * 60_000, "1111111"), pass(NOW - 2 * PASS_MS), pass(NOW - PASS_MS),
  failure(NOW - 60_000), failure(NOW - 30_000)];

const FLOOR = 1024;
type Readers = Parameters<typeof fixAdmissionCauseProbe>[0];
/** The readings the run child reads: a fix p90 of 6258 MiB, a typical of 1754 MiB and one live fix tree. */
const readers = (headroomMib: number, extra: Partial<Readers> = {}): Readers => ({
  hostWorkerBudget: 4, readActiveWorkers: () => 8,
  readPressure: () => ({ availableMib: FLOOR + headroomMib, floorMib: FLOOR, binding: "host",
    tier: headroomMib >= 6258 ? "fits" : "host-short" }),
  readEstimate: (workerClass) => ({ estimateMib: workerClass === "fix" ? 6258 : 2048, samples: 9 }),
  readTypical: (workerClass) => ({ estimateMib: workerClass === "fix" ? 1754 : 1200, samples: 9 }),
  readResidents: () => ({ fix: [1500], review: [] }),
  ...extra,
});
const probeOn = (headroom: () => number): NonNullable<SweepDeps["fixDispatchCauseProbe"]> =>
  async (cause) => fixDispatchMemoryCause(cause) ? fixAdmissionCauseProbe(readers(headroom())) : undefined;
const sweepDeps = (rows: Record<string, unknown>[], counts: { dispatched: number; escalated: number },
  extra: Partial<SweepDeps> = {}): SweepDeps => ({
  arm: () => {}, close: () => {}, dispatchFix: () => { counts.dispatched++; },
  escalate: () => { counts.escalated++; }, runId: "memory-held", ledgerPath: "/unused", now: () => NOW,
  readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(NOW), ...row }); }, ...extra });

test("W1-T13869 criterion 1: a memory-held fix dispatch runs again at the same head on the first pass whose admission has room", async () => {
  assert.equal(fixDispatchMemoryCause(String(fixDispatchHoldAtHead(pr, seed(), () => true, undefined, { nowMs: NOW })?.fields.cause)), true);
  const rows = seed();
  const counts = { dispatched: 0, escalated: 0 };
  let headroom = 6149;
  const deps = sweepDeps(rows, counts, { fixDispatchCauseProbe: probeOn(() => headroom) });
  await runSweep([pr], deps);
  assert.equal(counts.dispatched, 0, "the admission reading still refuses one fix");
  const held = rows.findLast(row => row.step === "sweep.disposed")!;
  const learnedRetry = Date.parse(String(held.failure_at)) + Number(held.backoff_ms);
  assert.equal(held.backoff_ms, 2 * 40 * 60_000, "the learned backoff is unchanged");
  headroom = 9204;
  const later = NOW + PASS_MS;
  assert.ok(later < learnedRetry, "the next pass comes before the learned next retry");
  await runSweep([pr], { ...deps, runId: "memory-free", now: () => later });
  assert.equal(counts.dispatched, 1, "dispatches again at the same head, with no new push");
});

test("W1-T13869 criterion 2: while the admission still refuses, the hold names probe present and a retry one pass away", async () => {
  const rows = seed();
  const counts = { dispatched: 0, escalated: 0 };
  for (const [i, now] of [NOW, NOW + PASS_MS, NOW + 2 * PASS_MS].entries()) {
    await runSweep([pr], sweepDeps(rows, counts, { runId: `held-${i}`, now: () => now,
      fixDispatchCauseProbe: probeOn(() => 6149) }));
    const held = rows.findLast(row => row.step === "sweep.disposed")!;
    assert.equal(held.probe_result, "present");
    assert.equal(held.next_retry_at, at(now + PASS_MS), "one sweep cadence after the pass");
    assert.notEqual(held.next_retry_at, at(Date.parse(String(held.failure_at)) + Number(held.backoff_ms)));
  }
  assert.equal(counts.dispatched, 0);
  const standIn = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, STAND_IN)], () => true, undefined,
    { nowMs: NOW, sweepPassMs: PASS_MS, causeProbe: async () => "present" });
  assert.equal(standIn?.fields.probe_result, "present", "the stand-in worker budget refusal is a memory cause too");
  assert.equal(standIn?.fields.next_retry_at, at(NOW + PASS_MS));
});

test("W1-T13869 criterion 3: the probe answers clear exactly when the run child's claim admits, and claims nothing", () => {
  const child = (r: Readers) => createSweepFixAdmissionController({ surface: "full", queueDepth: 1,
    hostWorkerBudget: r.hostWorkerBudget, activeWorkers: r.readActiveWorkers(), readActiveWorkers: r.readActiveWorkers,
    reviewReservations: 0, readPressure: r.readPressure, readEstimate: r.readEstimate, readTypical: r.readTypical,
    readResidents: r.readResidents }).claim(pr).admitted;
  const tiers: FixHostPressure["tier"][] = ["fits", "host-short", "container-short", "nothing-to-wait-for"];
  const trees: FixAdmissionResidents[] = [undefined, { fix: [], review: [] }, { fix: [1500], review: [] }, { fix: [], review: [900] }];
  let clear = 0;
  let present = 0;
  for (const headroom of [0, 1000, 1754, 2000, 6257, 6258, 9204, 13000])
    for (const tier of tiers)
      for (const residents of trees)
        for (const active of [0, 8])
          for (const reason of [undefined, "memory reading unreadable"]) {
            const r = readers(headroom, { readActiveWorkers: () => active, readResidents: () => residents,
              readPressure: () => ({ availableMib: FLOOR + headroom, floorMib: FLOOR, binding: "host", tier,
                ...(reason === undefined ? {} : { reason }) }) });
            const answer = fixAdmissionCauseProbe(r);
            assert.equal(answer, child(r) ? "clear" : "present", JSON.stringify({ headroom, tier, residents, active, reason }));
            if (answer === "clear") clear++;
            else present++;
          }
  assert.ok(clear > 0 && present > 0, "the grid holds both answers");
  const oneFix = readers(6258);
  for (let i = 0; i < 3; i++) assert.equal(fixAdmissionCauseProbe(oneFix), "clear");
  const controller = createSweepFixAdmissionController({ surface: "full", queueDepth: 1, hostWorkerBudget: 4,
    activeWorkers: 8, readActiveWorkers: oneFix.readActiveWorkers, reviewReservations: 0, readPressure: oneFix.readPressure,
    readEstimate: oneFix.readEstimate, readTypical: oneFix.readTypical, readResidents: oneFix.readResidents });
  assert.equal(controller.claim(pr).admitted, true, "the probes reserved nothing: the one fix the headroom holds is still free");
  assert.equal(fixAdmissionCauseProbe(readers(9204, { readPressure: () => { throw new Error("vm_stat failed"); } })), "present",
    "an unreadable pressure reading is present");
});

test("W1-T13869 criterion 4: a memory refusal is never escalated", async () => {
  const rows = seed();
  for (let i = 1; i <= 3; i++) rows.push(failure(NOW - 30_000 + i * 1000));
  const counts = { dispatched: 0, escalated: 0 };
  let judged = 0;
  const judge: FixProgressJudge = async () => { judged++; return { verdict: "escalate", loop: "memory", reason: "same refusal" }; };
  const extra: Partial<SweepDeps> = { fixProgressJudge: judge,
    readFixPressure: () => ({ availableMib: 64_000, floorMib: FLOOR, tier: "fits" }) };
  for (let i = 0; i < 3; i++) {
    await runSweep([pr], sweepDeps(rows, counts, { ...extra, runId: `escalate-${i}`, now: () => NOW + i * PASS_MS,
      fixDispatchCauseProbe: probeOn(() => 6149) }));
  }
  assert.ok(judged >= 1, "the judge is still read for its reason");
  assert.equal(rows.findLast(row => row.step === "sweep.disposed")?.judge_verdict, "escalate");
  assert.equal(counts.escalated, 0, "no escalation is filed");
  assert.equal(rows.some(row => "dispatch_cause_escalated" in row || row.fix_dispatch_failed_escalated === true), false);
  assert.equal(counts.dispatched, 0);
  const unprobed = seed();
  const unprobedCounts = { dispatched: 0, escalated: 0 };
  const late = NOW + 3 * 3_600_000;
  await runSweep([pr], sweepDeps(unprobed, unprobedCounts, { ...extra, runId: "no-probe", now: () => late }));
  assert.equal(unprobedCounts.escalated, 0);
  assert.equal(unprobedCounts.dispatched, 1, "without a probe, an escalate verdict does not hold a memory cause past its backoff");
});

test("W1-T13869 criterion 5: other causes keep today's probe and backoff", async () => {
  const probed: string[] = [];
  const spy: NonNullable<SweepDeps["fixDispatchCauseProbe"]> = async (cause) => { probed.push(cause); return "present"; };
  const opts = { nowMs: NOW, sweepPassMs: PASS_MS, causeProbe: spy };
  const catalog = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, "task catalog unreadable: ops-ref_moved")], () => true, undefined, opts);
  assert.deepEqual(probed, ["task catalog unreadable: ops-ref_moved"]);
  assert.equal(catalog?.fields.probe_result, "present");
  for (const error of ["fix dispatch refused: the PR head moved from 0a66a11 to 9f8e7d6", "fix dispatch refused: task W1-T12206 is already merged"]) {
    probed.length = 0;
    const held = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, error)], () => true, undefined, opts);
    assert.equal(probed.length, 0, `${error} is not probed`);
    assert.equal(held?.fields.probe_result, "unprobed");
    const retryAt = Date.parse(String(held?.fields.failure_at)) + Number(held?.fields.backoff_ms);
    assert.equal(held?.fields.next_retry_at, at(retryAt), "retried on the learned backoff");
    assert.equal(await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, error)], () => true, undefined, { ...opts, nowMs: retryAt }), undefined);
    assert.equal(fixDispatchMemoryCause(String(held?.fields.cause)), false);
  }
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-cause-"));
  try {
    writeFileSync(join(root, "ledger.ndjson"), "");
    const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root }, ledgerPath: join(root, "ledger.ndjson"),
      runId: "catalog-probe", plan: { tasks: [], byId: new Map() }, log: () => {} } as never);
    assert.equal(await effects.fixDispatchCauseProbe!("task catalog unreadable: ops-ref_moved"), "clear",
      "the ops catalog read still answers a catalog cause");
    assert.equal(await effects.fixDispatchCauseProbe!("fix dispatch refused: the PR head moved from <sha> to <sha>"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T13869 criterion 6: the production sweep deps answer a memory cause with the fix admission probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-probe-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root }, ledgerPath,
      runId: "memory-probe", plan: { tasks: [], byId: new Map() }, log: () => {} } as never);
    const answers: Array<string | undefined> = [];
    const rows = seed();
    const counts = { dispatched: 0, escalated: 0 };
    await runSweep([pr], sweepDeps(rows, counts, { ledgerPath, fixDispatchCauseProbe: async (cause) => {
      const answer = await effects.fixDispatchCauseProbe!(cause);
      answers.push(answer);
      return answer;
    } }));
    assert.ok(answers.length >= 1, "the memory cause is probed");
    assert.ok(answers.every(answer => answer === "clear" || answer === "present"), `the live admission answered ${answers.join(", ")}`);
    if (answers.at(-1) === "clear") assert.equal(counts.dispatched, 1, "a clear reading lifts the hold at once");
    else {
      assert.equal(counts.dispatched, 0);
      assert.equal(rows.findLast(row => row.step === "sweep.disposed")?.probe_result, "present");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
