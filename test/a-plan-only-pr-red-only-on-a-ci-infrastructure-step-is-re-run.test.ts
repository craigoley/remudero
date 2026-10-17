import assert from "node:assert/strict";
import test from "node:test";

// Read through the namespaces, so this file still LOADS at a base that lacks a symbol and fails per test.
import * as sweep from "#src/lib/sweep.js";
import type { CiFailure, OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import * as logs from "#src/lib/tick-read-worker.js";

// W1-T9932 — #12415 (plan-file-1792176840187, head f817c6c97) was red only because ci-shard (7/8)'s
// artifact upload hit `Failed to FinalizeArtifact: Unable to make request: ECONNRESET` after all 558
// tests passed. The sweep disposed it plan-proof-unrunnable ("needs a plan repair") three times, and
// nothing re-ran the job. TRANSCRIPT is CI run 38955270104's job log for that shard, verbatim from
// "ok 558" to the job's cleanup (~/Remudero-notes/f8-12415-ci.log, lines 4951-5044).
const TRANSCRIPT = [
  "2026-10-16T19:32:22.0087948Z # Subtest: W1-T2659 REACHABILITY: daemonCommand WIRES the wipe-test rung into the deps it hands runDaemon",
  "2026-10-16T19:32:22.0088687Z ok 558 - W1-T2659 REACHABILITY: daemonCommand WIRES the wipe-test rung into the deps it hands runDaemon",
  "2026-10-16T19:32:22.0089133Z   ---",
  "2026-10-16T19:32:22.0089454Z   duration_ms: 2219.98213",
  "2026-10-16T19:32:22.0089702Z   type: 'test'",
  "2026-10-16T19:32:22.0089959Z   ...",
  "2026-10-16T19:32:22.0090164Z 1..558",
  "2026-10-16T19:32:22.0090381Z # tests 558",
  "2026-10-16T19:32:22.0090606Z # suites 0",
  "2026-10-16T19:32:22.0090816Z # pass 558",
  "2026-10-16T19:32:22.0091024Z # fail 0",
  "2026-10-16T19:32:22.0091232Z # cancelled 0",
  "2026-10-16T19:32:22.0091452Z # skipped 0",
  "2026-10-16T19:32:22.0091652Z # todo 0",
  "2026-10-16T19:32:22.0091880Z # duration_ms 139537.290157",
  "2026-10-16T19:32:22.0388049Z test-tier-manifest: rest run complete — 66/66 file(s) reported, # tests 558, # fail 0.",
  "2026-10-16T19:32:22.0711065Z ##[group]Run # NO EARLY `exit 0` IN THIS STEP, DELIBERATELY. The check below enumerates skip-shaped",
  "2026-10-16T19:32:22.0711760Z ^[[36;1m# NO EARLY `exit 0` IN THIS STEP, DELIBERATELY. The check below enumerates skip-shaped^[[0m",
  "2026-10-16T19:32:22.0712366Z ^[[36;1m# guards — a conditional whose block reaches `exit 0` — so writing this step's own gate^[[0m",
  "2026-10-16T19:32:22.0712954Z ^[[36;1m# that way would add a fourteenth guard demanding coverage for the privilege of running^[[0m",
  "2026-10-16T19:32:22.0713513Z ^[[36;1m# the coverage check. An if/else costs one line and enumerates as nothing.^[[0m",
  "2026-10-16T19:32:22.0713905Z ^[[36;1m#^[[0m",
  "2026-10-16T19:32:22.0714270Z ^[[36;1m# SHARD 1 ONLY, AND ONLY WHEN THE WORKFLOW ITSELF CHANGED. The guard population cannot^[[0m",
  "2026-10-16T19:32:22.0714858Z ^[[36;1m# move unless ci.yml does, and a full pass is ~14 minutes (shard 1 of #10400 and #10522 took^[[0m",
  "2026-10-16T19:32:22.0715608Z ^[[36;1m# 15.3 min, 2026-10-09/10; 43 guards over 100 ci.yml-reading suites at 2026-10-13), so^[[0m",
  "2026-10-16T19:32:22.0716143Z ^[[36;1m# running it four times on every PR would buy nothing at four times the cost.^[[0m",
  "2026-10-16T19:32:22.0716799Z ^[[36;1mif [ \"7\" = \"1\" ] && grep -qxF \".github/workflows/ci.yml\" changed-files.txt; then^[[0m",
  "2026-10-16T19:32:22.0717271Z ^[[36;1m  node scripts/workflow-guard-mutation-ratchet.mjs^[[0m",
  "2026-10-16T19:32:22.0717602Z ^[[36;1melse^[[0m",
  "2026-10-16T19:32:22.0718083Z ^[[36;1m  echo \"workflow-guard-mutation: not shard 1, or ci.yml is not in this diff — the guard population cannot have moved.\"^[[0m",
  "2026-10-16T19:32:22.0718600Z ^[[36;1mfi^[[0m",
  "2026-10-16T19:32:22.0757093Z shell: /usr/bin/bash -e {0}",
  "2026-10-16T19:32:22.0757395Z env:",
  "2026-10-16T19:32:22.0757623Z   RMD_AFFECTED_SUITE_LIVE: 0",
  "2026-10-16T19:32:22.0757884Z ##[endgroup]",
  "2026-10-16T19:32:22.0812898Z workflow-guard-mutation: not shard 1, or ci.yml is not in this diff — the guard population cannot have moved.",
  "2026-10-16T19:32:22.0841136Z ##[group]Run node scripts/flake-screen.mjs --shard 7",
  "2026-10-16T19:32:22.0841535Z ^[[36;1mnode scripts/flake-screen.mjs --shard 7^[[0m",
  "2026-10-16T19:32:22.0873640Z shell: /usr/bin/bash -e {0}",
  "2026-10-16T19:32:22.0873938Z env:",
  "2026-10-16T19:32:22.0874163Z   RMD_AFFECTED_SUITE_LIVE: 0",
  "2026-10-16T19:32:22.0874436Z   RMD_JOB_STARTED_MS: 1792178982220",
  "2026-10-16T19:32:22.0874712Z ##[endgroup]",
  "2026-10-16T19:32:22.1347469Z flake-screen: shard 7 — 0 added test file(s); shard 1 screens them.",
  "2026-10-16T19:32:22.1442168Z ##[group]Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "2026-10-16T19:32:22.1442585Z with:",
  "2026-10-16T19:32:22.1442828Z   name: flake-retry-shard-7",
  "2026-10-16T19:32:22.1443122Z   path: /home/runner/work/_temp/flake-retry",
  "2026-10-16T19:32:22.1443430Z   retention-days: 1",
  "2026-10-16T19:32:22.1443686Z   if-no-files-found: ignore",
  "2026-10-16T19:32:22.1443951Z   compression-level: 6",
  "2026-10-16T19:32:22.1444198Z   overwrite: false",
  "2026-10-16T19:32:22.1444447Z   include-hidden-files: false",
  "2026-10-16T19:32:22.1444710Z   archive: true",
  "2026-10-16T19:32:22.1444934Z env:",
  "2026-10-16T19:32:22.1445155Z   RMD_AFFECTED_SUITE_LIVE: 0",
  "2026-10-16T19:32:22.1445606Z ##[endgroup]",
  "2026-10-16T19:32:22.2898460Z With the provided path, there will be 1 file uploaded",
  "2026-10-16T19:32:22.2904449Z Artifact name is valid!",
  "2026-10-16T19:32:22.2904995Z Root directory input is valid!",
  "2026-10-16T19:32:22.6390439Z Uploading artifact: flake-retry-shard-7.zip",
  "2026-10-16T19:32:22.6426564Z Beginning upload of artifact content to blob storage",
  "2026-10-16T19:32:22.9429823Z Uploaded bytes 138",
  "2026-10-16T19:32:23.0138714Z Finished uploading artifact content to blob storage!",
  "2026-10-16T19:32:23.0139782Z SHA256 digest of uploaded artifact is 0d2bc732c731a24a56ec5f34090942803c2920773d50152d6eeefb020a57ddb1",
  "2026-10-16T19:32:23.0140363Z Finalizing artifact upload",
  "2026-10-16T19:32:24.3697938Z ##[error]Failed to FinalizeArtifact: Unable to make request: ECONNRESET",
  "If you are using self-hosted runners, please make sure your runner has access to all GitHub endpoints: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#communication-between-self-hosted-runners-and-github",
  "2026-10-16T19:32:24.3823164Z ##[group]Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "2026-10-16T19:32:24.3823604Z with:",
  "2026-10-16T19:32:24.3823849Z   name: test-duration-shard-7",
  "2026-10-16T19:32:24.3824169Z   path: /home/runner/work/_temp/test-duration",
  "2026-10-16T19:32:24.3824487Z   retention-days: 1",
  "2026-10-16T19:32:24.3824753Z   if-no-files-found: ignore",
  "2026-10-16T19:32:24.3825027Z   compression-level: 6",
  "2026-10-16T19:32:24.3825282Z   overwrite: false",
  "2026-10-16T19:32:24.3825800Z   include-hidden-files: false",
  "2026-10-16T19:32:24.3826094Z   archive: true",
  "2026-10-16T19:32:24.3826319Z env:",
  "2026-10-16T19:32:24.3826560Z   RMD_AFFECTED_SUITE_LIVE: 0",
  "2026-10-16T19:32:24.3826821Z ##[endgroup]",
  "2026-10-16T19:32:24.5203390Z With the provided path, there will be 1 file uploaded",
  "2026-10-16T19:32:24.5208614Z Artifact name is valid!",
  "2026-10-16T19:32:24.5209137Z Root directory input is valid!",
  "2026-10-16T19:32:24.8805122Z Uploading artifact: test-duration-shard-7.zip",
  "2026-10-16T19:32:24.8844500Z Beginning upload of artifact content to blob storage",
  "2026-10-16T19:32:25.1771970Z Uploaded bytes 1690",
  "2026-10-16T19:32:25.2495675Z Finished uploading artifact content to blob storage!",
  "2026-10-16T19:32:25.2496799Z SHA256 digest of uploaded artifact is 462a0f90937ed3938641348de797982821723dbbb3857e86f2e6464648c743b1",
  "2026-10-16T19:32:25.2497631Z Finalizing artifact upload",
  "2026-10-16T19:32:25.6592708Z Artifact test-duration-shard-7 successfully finalized. Artifact ID 12070277658",
  "2026-10-16T19:32:25.6593654Z Artifact test-duration-shard-7 has been successfully uploaded! Final size is 1690 bytes. Artifact ID is 12070277658",
  "2026-10-16T19:32:25.6596295Z Artifact download URL: https://github.com/craigoley/remudero/actions/runs/38955270104/artifacts/12070277658",
  "2026-10-16T19:32:25.6795796Z Post job cleanup.",
];

const NOW = Date.parse("2026-10-16T19:39:00Z");
const HEAD = "f817c6c97".padEnd(40, "0");
const JOB = "117156441241";
const SHARD = "ci-shard (7/8)";

/** The job log GitHub serves: 557 earlier passing tests, then the verbatim transcript. */
function jobLog(transcript: readonly string[] = TRANSCRIPT): string {
  const earlier = Array.from({ length: 557 }, (_, i) => `2026-10-16T19:32:21.0000000Z ok ${i + 1} - earlier test ${i + 1}`);
  return ["2026-10-16T19:29:59.0000000Z TAP version 13", ...earlier, ...transcript].join("\n");
}

function reduced(log: string): string {
  const reducer = logs.ciFailureRegionReducer(60);
  for (const line of log.split("\n")) reducer.push(line);
  return reducer.finish();
}

function edit(from: RegExp, to: string): string[] {
  return TRANSCRIPT.map((line) => from.test(line) ? line.replace(from, to) : line);
}

function shard(logTail = reduced(jobLog())): CiFailure {
  return { name: SHARD, conclusion: "FAILURE", jobId: JOB, logTail };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 12415,
    prUrl: "https://github.com/craigoley/remudero/pull/12415",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: "plan-file-1792176840187",
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [shard(), { name: "ci", conclusion: "FAILURE", logTail: "##[error]Process completed with exit code 1." },
      { name: "ci-gate", conclusion: "FAILURE", logTail: "ci-gate: required check(s) FAILED — holding merge:" }],
    body: "Files W1-T9932.\n\n## Acceptance\n- W1-T9932 is filed | grep: W1-T9932 in plan/tasks.d",
    ...over,
  };
}

// A green peer keeps the red on ONE PR, so the pass never reads it as every PR's base-caused red.
function greenPeer(): OpenPrView {
  return planPr({
    prNumber: 6900, prUrl: "https://github.com/craigoley/remudero/pull/6900", taskId: "W1-T4000", checksState: "green",
    reviewState: "success", headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false, ciFailures: undefined,
  });
}

async function pass(pr: OpenPrView, ledger: Record<string, unknown>[], over: Partial<SweepDeps> = {}) {
  const requeued: Array<{ name: string; jobId?: string }> = [];
  const infraEscalated: Array<{ name: string; reason: string; signature: string }> = [];
  const escalated: string[] = [];
  const planRounds: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: async () => {},
    escalate: (_pr: OpenPrView, reason: string) => { escalated.push(reason); },
    requeueCheck: (_pr: OpenPrView, check: { name: string; jobId?: string }) => {
      requeued.push({ name: check.name, jobId: check.jobId });
      return true;
    },
    escalateInfrastructureCheck: (_pr: OpenPrView, check: CiFailure, reason: string, signature: string) => {
      infraEscalated.push({ name: check.name, reason, signature });
    },
    dispatchPlanGateRound: async (p: OpenPrView) => { planRounds.push(p.prNumber); return { outcome: "pushed" }; },
    ledgerPath: "/dev/null/w1-t9932.ndjson",
    runId: "W1-T9932-test",
    readLedger: () => ledger,
    appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
    ...over,
  } as unknown as SweepDeps;
  const summary = await sweep.runSweep([pr, greenPeer()], deps, sweep.DEFAULT_SWEEP_POLICY);
  const action = summary.actions.find((a) => a.prNumber === pr.prNumber);
  const disposed = ledger.filter((l) => l.step === "sweep.disposed" && l.pr_number === pr.prNumber).at(-1);
  const infraRows = ledger.filter((l) => l.step === "sweep.ci_infrastructure_requeue" && l.pr_number === pr.prNumber);
  return { requeued, infraEscalated, escalated, planRounds, disposed, infraRows, action };
}

// The failed job's only failure annotation, as GitHub served it for check run 117156441241.
const ANNOTATION = [
  "Failed to FinalizeArtifact: Unable to make request: ECONNRESET",
  "If you are using self-hosted runners, please make sure your runner has access to all GitHub endpoints: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#communication-between-self-hosted-runners-and-github",
];

test("W1-T9932: a FinalizeArtifact ECONNRESET after a complete passing summary classifies as infrastructure", async () => {
  const log = jobLog();
  for (const region of [reduced(log), logs.extractCiFailureRegion(log, 60)]) {
    for (const line of ["# tests 558", "# fail 0", "test-tier-manifest: rest run complete — 66/66 file(s) reported, # tests 558, # fail 0.",
      "Finished uploading artifact content to blob storage!", "Finalizing artifact upload",
      "##[error]Failed to FinalizeArtifact: Unable to make request: ECONNRESET"]) {
      assert.ok(region.split("\n").some((l) => l.trim() === line), `the region keeps ${JSON.stringify(line)}:\n${region}`);
    }
    assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: region }),
      sweep.ARTIFACT_FINALIZE_TRANSPORT_RESET);
    assert.match(sweep.ciInfrastructureFailedStep(region) ?? "", /^Run actions\/upload-artifact@/);
  }
  for (const code of ["ETIMEDOUT", "ECONNREFUSED", "EPIPE", "socket hang up"]) {
    const region = reduced(jobLog(edit(/ECONNRESET$/, code)));
    assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: region }),
      sweep.ARTIFACT_FINALIZE_TRANSPORT_RESET, code);
  }
  // The annotation names only the reset, so the read goes on to the job log for the region beside the summary.
  const rollup = [{ name: SHARD, conclusion: "FAILURE", detailsUrl: `https://github.com/o/r/actions/runs/38955270104/job/${JOB}` }];
  const [read] = await logs.fetchCiFailuresAsync("o", "r", rollup, 60, { fetchAnnotations: () => ANNOTATION, fetchJobLog: () => jobLog() });
  assert.equal(read?.tailSource, "log");
  assert.deepEqual(read?.annotationFallback, { outcome: "artifact-finalize-only" });
  assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: read?.conclusion, logTail: read?.logTail ?? "" }),
    sweep.ARTIFACT_FINALIZE_TRANSPORT_RESET);
  const unread = await logs.fetchCiFailuresAsync("o", "r", rollup, 60, { fetchAnnotations: () => ANNOTATION,
    fetchJobLog: () => { throw new Error("log gone"); } });
  assert.equal(unread[0]?.logTail, ANNOTATION.join("\n"), "an unreadable log keeps the annotation");
  assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: unread[0]!.logTail }), undefined);
  // The W1-T3194 entry is unchanged.
  assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: [
    "Artifact upload completed successfully!", "Finalizing artifact upload",
    "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary"].join("\n") }), sweep.ARTIFACT_FINALIZE_INTERMEDIARY_403);
});

test("W1-T9932: a finalize reset beside a failing, missing or partial summary stays a genuine red", () => {
  const variants: Record<string, string> = {
    "a failing count": reduced(jobLog(edit(/# fail 0$/, "# fail 1"))),
    "no summary at all": reduced(jobLog(TRANSCRIPT.filter((l) => !/# (tests|pass|fail) \d+$|file\(s\) reported/.test(l)))),
    "a partial manifest": reduced(jobLog(edit(/66\/66 file/, "65/66 file"))),
    "zero tests": reduced(jobLog(edit(/# tests 558$/, "# tests 0"))),
    "a TAP not ok": reduced(jobLog(edit(/ok 558 - /, "not ok 558 - "))),
    "an AssertionError": `${reduced(jobLog())}\nAssertionError [ERR_ASSERTION]: expected 1 to equal 2`,
    "a TS error": `${reduced(jobLog())}\nsrc/x.ts(1,1): error TS2322: Type 'string' is not assignable`,
    "permission wording": `${reduced(jobLog())}\nResource not accessible by integration`,
    "a non-transport finalize error": reduced(jobLog(edit(/Unable to make request: ECONNRESET$/, "(500) Internal Server Error"))),
    "no upload before finalize": reduced(jobLog(TRANSCRIPT.filter((l) => !/Finished uploading artifact content/.test(l)))),
    "the reset before the summary": ["##[error]Failed to FinalizeArtifact: Unable to make request: ECONNRESET",
      "Finished uploading artifact content to blob storage!", "Finalizing artifact upload", "# tests 558", "# fail 0"].join("\n"),
  };
  for (const [shape, logTail] of Object.entries(variants)) {
    assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail }), undefined, `${shape}:\n${logTail}`);
  }
  assert.equal(sweep.classifyCiInfrastructureFailure({ conclusion: "CANCELLED", logTail: reduced(jobLog()) }), undefined);
});

test("W1-T9932: a plan-only PR red only on an infrastructure step is re-run, not sent to a plan repair", async () => {
  const ledger: Record<string, unknown>[] = [];
  const first = await pass(planPr(), ledger);
  assert.deepEqual(first.requeued, [{ name: SHARD, jobId: JOB }], "the failed job is re-run once");
  assert.deepEqual(first.infraEscalated, []);
  assert.deepEqual(first.escalated, [], "no plan violation is escalated");
  assert.deepEqual(first.planRounds, []);
  assert.equal(first.infraRows.length, 1);
  const row = first.infraRows[0]!;
  assert.equal(row.surface, "pr");
  assert.equal(row.plan_only, true);
  assert.equal(row.check_name, SHARD);
  assert.equal(row.job_id, JOB);
  assert.equal(row.signature, sweep.ARTIFACT_FINALIZE_TRANSPORT_RESET);
  assert.equal(row.outcome, "dispatched");
  assert.match(String(row.failed_step), /^Run actions\/upload-artifact@/);
  assert.equal(row.matched_error, "##[error]Failed to FinalizeArtifact: Unable to make request: ECONNRESET");
  assert.ok(String(row.matched_error).length <= 200);
  assert.equal(first.disposed?.disposition, "wait");
  assert.equal(first.disposed?.blocker, "awaiting-ci");
  assert.doesNotMatch(String(first.disposed?.reason), /needs a plan repair/);
  assert.match(String(first.disposed?.reason), /re-ran the failed job/);

  // A pass that may not act defers the re-run and still names no plan repair.
  const light = await pass(planPr({ headSha: "1".repeat(40) }), [], { actionable: (d: string) => d === "post-review" } as Partial<SweepDeps>);
  assert.deepEqual(light.requeued, []);
  assert.deepEqual(light.escalated, []);
  assert.equal(light.disposed?.disposition, "wait");
  assert.equal(light.disposed?.blocker, "awaiting-ci");
  assert.match(String(light.disposed?.reason), /infrastructure re-run deferred: /);
  assert.doesNotMatch(String(light.disposed?.reason), /needs a plan repair/);
  const dry = await pass(planPr({ headSha: "3".repeat(40) }), [], { dryRun: true } as Partial<SweepDeps>);
  assert.deepEqual(dry.requeued, []);
  assert.equal(dry.action?.disposition, "wait");
  assert.match(String(dry.action?.reason), /infrastructure re-run deferred: dry run$/);

  // The code path's fresh-rollup admission: a shard already re-run green is not re-run again.
  const green = [{ name: SHARD, conclusion: "SUCCESS", startedAt: "2026-10-16T20:08:00Z" }];
  const rerun = await pass(planPr({ headSha: "4".repeat(40) }), [], { readCiGateRollup: async () => green } as Partial<SweepDeps>);
  assert.deepEqual(rerun.requeued, []);
  assert.equal(rerun.disposed?.blocker, "awaiting-ci");
  assert.match(String(rerun.disposed?.reason), /fresh CI rollup: green or in flight, no requeue/);
});

test("W1-T9932: a repeat infrastructure red on the same head escalates instead of re-running", async () => {
  const ledger: Record<string, unknown>[] = [];
  await pass(planPr(), ledger);
  const again = await pass(planPr(), ledger);
  assert.deepEqual(again.requeued, [], "the head@check ledger key bounds it to one re-run");
  assert.deepEqual(again.infraEscalated.map((e) => [e.name, e.signature]), [[SHARD, sweep.ARTIFACT_FINALIZE_TRANSPORT_RESET]]);
  assert.deepEqual(again.escalated, [], "never sent to a plan repair");
  assert.equal(again.infraRows.at(-1)?.outcome, "repeated");
  assert.equal(again.disposed?.disposition, "wait");
  assert.equal(again.disposed?.blocker, "escalated");
  assert.doesNotMatch(String(again.disposed?.reason), /needs a plan repair/);

  const fresh = await pass(planPr({ headSha: "2".repeat(40) }), ledger);
  assert.deepEqual(fresh.requeued, [{ name: SHARD, jobId: JOB }], "a new head starts clean");
});

test("W1-T9932: a plan-only PR with a genuine test red keeps its plan route", async () => {
  const genuine = shard(reduced(jobLog(edit(/# fail 0$/, "# fail 1"))));
  const own = await pass(planPr({ ciFailures: [genuine, { name: "ci-gate", conclusion: "FAILURE", logTail: "" }] }), []);
  assert.deepEqual(own.requeued, []);
  assert.deepEqual(own.infraRows, []);
  assert.equal(own.disposed?.disposition, "refused-escalate");
  assert.equal(own.disposed?.blocker, "plan-proof-unrunnable");
  assert.match(String(own.disposed?.reason), /needs a plan repair/);

  // One genuine red decides the head: its infra-only sibling is not re-run either.
  const mixed = await pass(planPr({ ciFailures: [shard(), { ...genuine, name: "ci-shard (2/8)", jobId: "117156441200" }] }), []);
  assert.deepEqual(mixed.requeued, []);
  assert.deepEqual(mixed.infraRows, []);
  assert.equal(mixed.disposed?.disposition, "refused-escalate");
  assert.equal(mixed.disposed?.blocker, "plan-proof-unrunnable");
});
