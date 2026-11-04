import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { judgeReview, judgeReviewAsync, memoizeAsyncProofExecutor, preparePromisedReviewDecision, recordedLoad1,
  sampleHostLoad, type ReviewEvidence, type ReviewVerdict } from "#src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, inconclusiveLoadLowered, INCONCLUSIVE_LOAD_MAX_RERUNS, runSweep, runSweepLightPass,
  type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

const PROOF_FILE = "test/load-shaped.test.ts";
const criteria = [{ claim: "the behaviour holds", proof: `unit test: ${PROOF_FILE}` }];
const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inconclusive-load-`));
mkdirSync(join(checkout, "test"), { recursive: true });
writeFileSync(join(checkout, PROOF_FILE), "import { test } from 'node:test'; test('x', () => {});\n");
writeFileSync(join(checkout, "test/other.test.ts"), "import { test } from 'node:test'; test('other', () => {});\n");
after(() => rmSync(checkout, { recursive: true, force: true }));

const DIFF = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
function samples(...loads: number[]): () => { load1: number; cpuPsiSomeAvg10Pct: number } {
  let i = 0;
  return () => ({ load1: loads[Math.min(i++, loads.length - 1)], cpuPsiSomeAvg10Pct: 60 });
}
function judge(extra: Partial<ReviewEvidence>): ReviewVerdict {
  return judgeReview(criteria, {
    diff: DIFF, report: "the behaviour holds", headCheckoutDir: checkout, sampleLoad: samples(30, 41), ...extra,
  } as ReviewEvidence);
}

test("a unit-test proof ended by a timeout is inconclusive_load, pending, with the load at start and end", () => {
  const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  const verdict = judge({ execProof: () => { throw timeout; } });
  const [criterion] = verdict.criteria;
  assert.equal(criterion.proof_exec, "inconclusive_load");
  assert.equal(criterion.met, false);
  assert.deepEqual(criterion.load, { start: { load1: 30, cpuPsiSomeAvg10Pct: 60 }, end: { load1: 41, cpuPsiSomeAvg10Pct: 60 } });
  assert.equal(recordedLoad1(criterion.load), 41);
  assert.equal(verdict.state, "pending");
  assert.equal(verdict.floorState, "pending");
  assert.match(verdict.summary, /inconclusive-load/);
  // never an unmet criterion: it names no failing claim and so seeds no fix round
  assert.doesNotMatch(verdict.summary, /the behaviour holds/);
});

test("a unit-test proof killed by a signal is inconclusive_load, not exec_error", () => {
  const killed = Object.assign(new Error("spawnSync node SIGKILL"), { signal: "SIGKILL", status: null });
  assert.equal(judge({ execProof: () => { throw killed; } }).criteria[0].proof_exec, "inconclusive_load");
});

test("a unit-test proof whose executor threw an error with no timeout, signal or spawn marker stays exec_error", () => {
  const verdict = judge({ execProof: () => { throw new Error("proof timed out"); } });
  assert.equal(verdict.criteria[0].proof_exec, "exec_error");
  assert.equal(verdict.criteria[0].load, undefined);
});

test("a spawn error (a sandbox that could not exec) is inconclusive_load", () => {
  const spawnError = Object.assign(new Error("spawn bwrap EAGAIN"), { code: "EAGAIN", syscall: "spawn bwrap" });
  assert.equal(judge({ execProof: () => { throw spawnError; } }).criteria[0].proof_exec, "inconclusive_load");
});

test("a plain executed failure with no hosted-CI evidence stays executed_fail and fails", () => {
  const verdict = judge({ execProof: () => "fail" });
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail");
  assert.equal(verdict.state, "failure");
  assert.ok(verdict.criteria[0].load, "the load around a conclusive failure is recorded too");
});

test("a failure while hosted CI passed the same file at the head is inconclusive_load and pending", () => {
  const verdict = judge({ execProof: () => "fail", hostedCiFilePassed: new Map([[PROOF_FILE, "passed" as const]]) });
  assert.equal(verdict.criteria[0].proof_exec, "inconclusive_load");
  assert.equal(verdict.criteria[0].met, false);
  assert.equal(verdict.state, "pending");
});

test("hosted CI that failed the file or never ran it leaves the failure executed_fail", () => {
  for (const hosted of [new Map([[PROOF_FILE, "failed" as const]]), new Map([["test/other.test.ts", "passed" as const]])]) {
    const verdict = judge({ execProof: () => "fail", hostedCiFilePassed: hosted });
    assert.equal(verdict.criteria[0].proof_exec, "executed_fail");
    assert.equal(verdict.state, "failure");
  }
});

test("a failure that reproduces below the recorded load stays executed_fail", () => {
  const hosted = new Map([[PROOF_FILE, "passed" as const]]);
  const lower = judge({ execProof: () => "fail", hostedCiFilePassed: hosted, priorInconclusiveLoad1: 41, sampleLoad: samples(5, 5) });
  assert.equal(lower.criteria[0].proof_exec, "executed_fail");
  assert.equal(lower.state, "failure");
  const stillLoaded = judge({ execProof: () => "fail", hostedCiFilePassed: hosted, priorInconclusiveLoad1: 41, sampleLoad: samples(60, 60) });
  assert.equal(stillLoaded.criteria[0].proof_exec, "inconclusive_load");
});

test("a conclusive pass is unaffected by the load seam", () => {
  const verdict = judge({ execProof: () => "pass" });
  assert.deepEqual(verdict.criteria[0].load, { start: { load1: 30, cpuPsiSomeAvg10Pct: 60 }, end: { load1: 41, cpuPsiSomeAvg10Pct: 60 } });
  assert.notEqual(verdict.criteria[0].proof_exec, "inconclusive_load");
});

test("actual asynchronous proof execution retains its start and end load through replay and memoization", async () => {
  for (const outcome of ["pass", "fail", "timeout"] as const) {
    let load = 40, runs = 0, readings = 0;
    const sample = () => { readings++; return { load1: load, cpuPsiSomeAvg10Pct: load / 2 }; };
    const exec = memoizeAsyncProofExecutor(async () => {
      runs++;
      assert.equal(load, 40);
      await Promise.resolve();
      load = 2;
      if (outcome === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return outcome;
    }, sample);
    const evidence: ReviewEvidence = { diff: DIFF, report: "the behaviour holds", headCheckoutDir: checkout,
      asyncExecProof: exec, sampleLoad: sample, hostedCiFilePassed: new Map([[PROOF_FILE, "passed"]]) };
    for (let fold = 0; fold < 2; fold++) {
      const verdict = await judgeReviewAsync([...criteria, { ...criteria[0], claim: "another criterion" }], evidence);
      assert.equal(verdict.state, outcome === "pass" ? "success" : "pending");
      for (const criterion of verdict.criteria) {
        assert.equal(criterion.proof_exec, outcome === "pass" ? "executed_pass" : "inconclusive_load");
        assert.deepEqual(criterion.load, { start: { load1: 40, cpuPsiSomeAvg10Pct: 20 }, end: { load1: 2, cpuPsiSomeAvg10Pct: 1 } });
      }
    }
    assert.equal(runs, 1, "neither a shared criterion nor a later decision fold runs the proof again");
    assert.ok(readings >= 2);
  }
});

test("synchronous criteria sharing a proof retain its original measurements", () => {
  let load = 40, runs = 0;
  const verdict = judgeReview([...criteria, { ...criteria[0], claim: "another criterion" }], {
    diff: DIFF, report: "the behaviour holds", headCheckoutDir: checkout,
    sampleLoad: () => ({ load1: load }), execProof: () => { runs++; load = 2; return "fail"; },
    hostedCiFilePassed: new Map([[PROOF_FILE, "passed"]]),
  });
  assert.equal(runs, 1);
  assert.deepEqual(verdict.criteria.map(c => c.load), Array(2).fill({ start: { load1: 40 }, end: { load1: 2 } }));
});

test("sampleHostLoad reads loadavg and the cgroup cpu pressure, leaving an unreadable source absent", () => {
  const files: Record<string, string> = {
    "/proc/loadavg": "24.50 20.00 18.00 3/900 1234\n",
    "/sys/fs/cgroup/cpu.pressure": "some avg10=63.25 avg60=50.00 avg300=40.00 total=1\nfull avg10=0.00 avg60=0 avg300=0 total=0\n",
  };
  const read = (path: string): string => { if (path in files) return files[path]; throw new Error(`ENOENT ${path}`); };
  assert.deepEqual(sampleHostLoad(read), { load1: 24.5, cpuPsiSomeAvg10Pct: 63.25 });
  const none = sampleHostLoad(() => { throw new Error("ENOENT"); });
  assert.equal(none.load1, undefined);
  assert.equal(none.cpuPsiSomeAvg10Pct, undefined);
  assert.equal(none.unreadable?.length, 3, "each unreadable source is named with its reason");
  assert.match(none.unreadable?.[0] ?? "", /^\/proc\/loadavg: ENOENT/);
  const garbage = sampleHostLoad((path) => path === "/proc/loadavg" ? "garbage" : (() => { throw new Error("x"); })());
  assert.equal(garbage.load1, undefined);
  assert.equal(garbage.unreadable?.[0], "/proc/loadavg: malformed");
  assert.equal(sampleHostLoad((path) => path === "/proc/loadavg" ? "1.0 2 3" : "none\n").unreadable?.length, 2);
});

// ── W1-T11132 criterion 2: the sweep's load-gated re-review ────────────────────────────────────────
const URL = "https://github.com/acme/remudero/pull/15532";
const HEAD = "dd024de0000000000000000000000000000000000";
const pr = (extra: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 15532, prUrl: URL, taskId: "W1-T10573", headSha: HEAD, checksState: "green", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date().toISOString(), ...extra,
});
const posted = (criterion: Record<string, unknown>, verdict: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: "W1-T10573", pr_url: URL, head_sha: HEAD, step: "review.posted", state: "pending", ts: "2026-11-02T20:22:00Z",
  decision_verdict: { state: "pending", criteria: [{ claim: "c", proof: "p", met: false, reason: "r", ...criterion }], ...verdict },
});
const inconclusive = (load1: number): Record<string, unknown> =>
  posted({ proof_exec: "inconclusive_load", load: { start: { load1: 20 }, end: { load1 } } });
const at = (load1: number | undefined) => () => (load1 === undefined ? {} : { load1 });

test("W1-T11132 criterion 2: the sweep re-reviews once its own load sample is below the recorded load", () => {
  assert.equal(inconclusiveLoadLowered(pr(), [inconclusive(41)], at(12)), true);
  assert.equal(inconclusiveLoadLowered(pr(), [inconclusive(41)], at(41)), false, "equal is not lower");
  assert.equal(inconclusiveLoadLowered(pr(), [inconclusive(41)], at(60)), false, "still loaded: wait");
  assert.equal(inconclusiveLoadLowered(pr(), [inconclusive(41)], at(undefined)), false, "an unreadable sample is not a guess");
});

test("W1-T11132 criterion 2: no retry unless inconclusive_load is the ONLY pending cause", () => {
  const other = posted({ proof_exec: "cannot_evaluate" }, { cannotEvaluate: true });
  assert.equal(inconclusiveLoadLowered(pr(), [other], at(1)), false);
  const harvest = posted({ proof_exec: "inconclusive_load", load: { start: { load1: 40 }, end: { load1: 40 } } },
    { promisedFollowUpObservation: { state: "unknown", reason: "x" } });
  assert.equal(inconclusiveLoadLowered(pr(), [harvest], at(1)), false);
  const noRecording = posted({ proof_exec: "inconclusive_load" });
  assert.equal(inconclusiveLoadLowered(pr(), [noRecording], at(1)), false, "no recorded load, no comparison");
  assert.equal(inconclusiveLoadLowered(pr({ reviewState: "success" }), [inconclusive(41)], at(1)), false);
  assert.equal(inconclusiveLoadLowered(pr({ headSha: "other" }), [inconclusive(41)], at(1)), false);
  assert.equal(inconclusiveLoadLowered(pr(), [{ ...inconclusive(41), state: "failure" }], at(1)), false);
  const mixed = inconclusive(41);
  (mixed.decision_verdict as ReviewVerdict).criteria.push({ claim: "unresolved", proof: "prose", met: false,
    reason: "not evaluated", proof_exec: "not_executable" });
  assert.equal(inconclusiveLoadLowered(pr(), [mixed], at(1)), false);
});

test("W1-T11132 criterion 2: a head re-run more than the cap is left to the operator", () => {
  const rows = Array.from({ length: INCONCLUSIVE_LOAD_MAX_RERUNS + 1 }, () => inconclusive(41));
  assert.equal(inconclusiveLoadLowered(pr(), rows.slice(0, INCONCLUSIVE_LOAD_MAX_RERUNS), at(1)), true);
  assert.equal(inconclusiveLoadLowered(pr(), rows, at(1)), false);
});

test("W1-T11132 criterion 2: production decision preparation recovers prior load by head and exact proof", async t => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prior-proof-load-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const oldVerdict = judge({ execProof: () => "fail", hostedCiFilePassed: new Map([[PROOF_FILE, "passed"]]) });
  const row = { ...posted({}), decision_verdict: oldVerdict };
  writeFileSync(ledgerPath, JSON.stringify(row) + "\n");
  for (const [headSha, acceptance, expected] of [
    [HEAD, criteria, "executed_fail"],
    ["another-head", criteria, "inconclusive_load"],
    [HEAD, [{ claim: "the behaviour holds", proof: "unit test: test/other.test.ts" }], "inconclusive_load"],
  ] as const) {
    const prepared = await preparePromisedReviewDecision({
      input: { headSha, diff: DIFF, report: "the behaviour holds", acceptance: [...acceptance] },
      headCheckoutDir: checkout, ledgerPath, prUrl: URL, task: { id: "W1-T10573" },
    });
    const result = await prepared.judge({ diff: DIFF, report: "the behaviour holds", sampleLoad: samples(5, 5),
      asyncExecProof: async () => "fail", hostedCiFilePassed: new Map([[PROOF_FILE, "passed"], ["test/other.test.ts", "passed"]]) });
    assert.equal(result.criteria[0].proof_exec, expected);
    assert.equal(result.state, expected === "executed_fail" ? "failure" : "pending");
  }
  writeFileSync(ledgerPath, "");
  for (const compressed of [false, true]) {
    const archive = join(dir, `ledger.2026-11-02T21-00-00-000Z.ndjson${compressed ? ".gz" : ""}`);
    const text = JSON.stringify(row) + "\n";
    writeFileSync(archive, compressed ? gzipSync(text) : text);
    const prepared = await preparePromisedReviewDecision({
      input: { headSha: HEAD, diff: DIFF, report: "the behaviour holds", acceptance: criteria },
      headCheckoutDir: checkout, ledgerPath, prUrl: URL, task: { id: "W1-T10573" },
    });
    const result = await prepared.judge({ diff: DIFF, report: "the behaviour holds", sampleLoad: samples(5, 5),
      asyncExecProof: async () => "fail", hostedCiFilePassed: new Map([[PROOF_FILE, "passed"]]) });
    assert.equal(result.criteria[0].proof_exec, "executed_fail", "rotation preserves the prior head-bound load");
    rmSync(archive);
  }
});

test("W1-T11132 criterion 2: full and light sweeps release delivered pending reviews and retain the conclusive rerun", async t => {
  for (const sweep of [runSweep, runSweepLightPass]) {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}load-retry-sweep-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const ledgerPath = join(dir, "ledger.ndjson"), now = Date.now();
    writeFileSync(ledgerPath, JSON.stringify({ ...inconclusive(41), ts: new Date(now).toISOString() }) + "\n");
    const view = pr({ reviewPendingSince: new Date(now).toISOString() });
    let reviews = 0, load = 60;
    const deps: SweepDeps = { ledgerPath, runId: "load-retry", now: () => now, sampleLoad: () => ({ load1: load }),
      arm: () => {}, close: () => assert.fail("no close"), dispatchFix: () => assert.fail("no fix round"),
      escalate: () => assert.fail("no escalation"), postReview: () => {
        reviews++;
        appendFileSync(ledgerPath, JSON.stringify({ ...posted({ proof_exec: "executed_pass", met: true }),
          state: "success", decision_verdict: { state: "success", criteria: [{ proof_exec: "executed_pass", met: true }] },
          ts: new Date(now + 1).toISOString() }) + "\n");
      },
    };
    await sweep([view], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 0, "positive dedup control: the pending verdict stays delivered while load is high");
    load = 41;
    await sweep([view], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 0, "equal load does not release delivery");
    load = 5;
    const summary = await sweep([view], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 1, JSON.stringify(summary));
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(raw => JSON.parse(raw));
    assert.equal(rows.find(row => row.step === "sweep.review_admitted")?.prior_cause, "inconclusive-load");
    await sweep([view], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 1, "the conclusive result replaces the hold even with a stale pending snapshot");
  }
});
