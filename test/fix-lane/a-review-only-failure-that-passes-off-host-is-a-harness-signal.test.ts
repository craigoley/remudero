import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore the executable .mjs module has no declaration file.
import { prepareJudgedRun } from "#scripts/pure-test-pool.mjs";
import { runWorkerAcceptanceProofs, workerAcceptanceProofSpawner } from "#src/cli/commands/fix.js";
import { type CriterionVerdict } from "#src/lib/review.js";
import { runFixRung, routeFix, type ReviewRunResult } from "#test/helpers/run-task-test.js";
import { HOSTED_TEST_FILE_RE, hostedTestFileEvidence, readHostedFixProofResults, buildFixProgressInputWithHostedProofs, runSweep,
  type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildFixProgressInput, judgeFixProgress, parseFixProgressVerdict, resolveFixProgress,
  reviewerProofFailures, reviewLoadFromCapacity, type FixProgressHostedProofResult } from "#src/lib/fix-progress-judge.js";

const CLAIM = "the real owner cli completes";
const FILE = "test/fix-lane/real-owner.test.ts";
const PROOF = `unit test: ${FILE}`;
const OUTPUT = "not ok 1 - real owner cli\nError: timed out after 92000ms";
const HEAD = "current-head";
// No production producer writes a per-criterion load (W1-T11132 will); the sweep's review.capacity reading is the one.
const criterion: CriterionVerdict = { claim: CLAIM, proof: PROOF, met: false, reason: "review sandbox timeout",
  proof_exec: "executed_fail", proofFailureOutput: OUTPUT };
const POSTED_AT = "2026-11-03T01:00:30.000Z";
const CAPACITY = { ts: "2026-11-03T01:00:10.000Z", step: "review.capacity", task_id: "DAEMON", reason: "backlog-not-sustained",
  effective_width: 1, mem_available_mib: 16602.6, cpu_psi_some_avg10_pct: 61.2, memory_psi_some_avg10_pct: 0, cpu_psi_full_avg10_pct: 38.05 };
const LOAD = reviewLoadFromCapacity(CAPACITY, POSTED_AT)!;

/**
 * The log a real CI test job leaves for one proof file: node:test's TAP and spec reporters plus the receipts
 * scripts/pool-run-tally.mjs writes when scripts/pure-test-pool.mjs's prepareJudgedRun opts a run in, as CI does.
 */
const realLogs = new Map<boolean, string>();
function realHostedLog(fails: boolean): string {
  const cached = realLogs.get(fails);
  if (cached !== undefined) return cached;
  const root = mkdtempSync(join(tmpdir(), "rmd-hosted-log-"));
  try {
    mkdirSync(join(root, "test/fix-lane"), { recursive: true });
    writeFileSync(join(root, FILE), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n` +
      `test('real owner cli', () => assert.equal(${fails}, false));\n`);
    const judged = prepareJudgedRun({ files: [FILE], root });
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ...judged.env };
      delete env.NODE_TEST_CONTEXT;
      env.NODE_V8_COVERAGE = "";
      const run = spawnSync(process.execPath, ["--test", ...judged.args, "--test-reporter=tap", "--test-reporter-destination=stdout",
        "--test-reporter=spec", "--test-reporter-destination=stdout", FILE], { cwd: root, env, encoding: "utf8" });
      const log = `${run.stdout}\n${run.stderr}`;
      realLogs.set(fails, log);
      return log;
    } finally { judged.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const worker = { proof: PROOF, headSha: HEAD, result: "pass" as const, output: "# tests 1\n# pass 1\n# fail 0" };
const ci: FixProgressHostedProofResult = { headSha: HEAD, testFile: FILE, check: "test-fast-shard (2/8)",
  result: "pass", output: "real owner cli: passed" };

function hostedFixture(over: { sha?: string; conclusion?: string; log?: string; runs?: object[] } = {}) {
  const calls: string[] = [];
  const run = { id: 12, name: ci.check, conclusion: "success", status: "completed",
    started_at: "2026-11-03T01:00:00Z", details_url: "https://github.com/o/r/actions/runs/4/job/7" };
  return { calls, io: {
    json: async (args: string[]) => {
      calls.push(args[1]!);
      if (args[1]!.includes("/check-runs?")) return { check_runs: over.runs ?? [run] };
      if (args[1]!.endsWith("/status")) return { statuses: [] };
      if (args[1]!.endsWith("/actions/jobs/7")) return {
        head_sha: over.sha ?? HEAD, name: ci.check, conclusion: over.conclusion ?? "success" };
      assert.fail(`unexpected read: ${args}`);
    },
    text: async (args: string[]) => {
      calls.push(args[1]!);
      return over.log ?? realHostedLog(false);
    },
  }, run };
}

function workerFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-off-host-"));
  mkdirSync(join(root, "test/fix-lane"), { recursive: true });
  mkdirSync(join(root, "test/setup"), { recursive: true });
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "");
  const writeProof = (fails: boolean) => writeFileSync(join(root, FILE),
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real owner cli', () => assert.equal(${fails}, false));\n`);
  writeProof(false);
  let spawns = 0;
  const io = { readTree: async () => ({ head: HEAD, dirty: false }),
    spawn: async (...args: Parameters<typeof workerAcceptanceProofSpawner>) => {
      spawns++;
      assert.ok(args[1].includes(FILE), "the persisted proof's exact file reaches the real child");
      // The dependency-free fixture uses Node's native TypeScript support on the worker host.
      const argv = args[1].filter((arg, i, all) => arg !== "tsx" && !(arg === "--import" && all[i + 1] === "tsx"));
      return workerAcceptanceProofSpawner(args[0], argv, args[2], args[3]);
    } };
  return { root, io, writeProof, spawns: () => spawns, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function facts() {
  const ledger: Record<string, unknown>[] = [
    { step: "fix.dispatch", task_id: "W1-T11133", pr_number: 15532, round_id: "r1",
      head_sha: "old-head", unmet_claims: [CLAIM], reviewer_proof_failures: reviewerProofFailures([criterion]) },
    { step: "fix.done", task_id: "W1-T11133", pr_number: 15532, round_id: "r1",
      fix_outcome: "FIXED", pushed_head_sha: HEAD, worker_proof_results: [worker] },
    CAPACITY,
    { step: "review.posted", ts: POSTED_AT, task_id: "W1-T11133", pr_number: 15532, head_sha: HEAD,
      decision_verdict: { criteria: [criterion] } },
  ];
  return { taskId: "W1-T11133", prNumber: 15532, headSha: HEAD, currentRed: [`review:${CLAIM}`],
    ledger, reviewFailures: [criterion], hostedProofResults: [ci] };
}

describe("test/fix-lane/a-review-only-failure-that-passes-off-host-is-a-harness-signal.test.ts", () => {
  test("the worker acceptance step executes the persisted proof and records its own pass or failure", async () => {
    const f = workerFixture();
    const input = { worktreePath: f.root, headSha: HEAD, criteria: [criterion] };
    try {
      const [passed] = await runWorkerAcceptanceProofs(input, f.io);
      assert.equal(passed?.proof, PROOF);
      assert.equal(passed?.result, "pass", passed?.output);
      assert.match(passed!.output, /# tests 1/);
      f.writeProof(true);
      const [failed] = await runWorkerAcceptanceProofs(input, f.io);
      assert.equal(failed?.result, "fail");
      assert.match(failed!.output, /not ok|AssertionError|# fail 1/);
      assert.equal(f.spawns(), 2);
      for (const readTree of [async () => ({ head: "old", dirty: false }),
        async () => ({ head: HEAD, dirty: true }), async () => { throw new Error("tree unreadable"); }]) {
        const [result] = await runWorkerAcceptanceProofs(input, { ...f.io, readTree });
        assert.equal(result?.result, "fail");
        assert.match(result!.output, /tree/);
      }
      let reads = 0;
      f.writeProof(false);
      const [changed] = await runWorkerAcceptanceProofs(input, { ...f.io,
        readTree: async () => ({ head: ++reads === 1 ? HEAD : "changed", dirty: false }) });
      assert.equal(changed?.result, "fail");
      assert.match(changed!.output, /changed during/);
      assert.deepEqual(await runWorkerAcceptanceProofs({ ...input, criteria: [] }), []);
      const [unreadable] = await runWorkerAcceptanceProofs(input);
      assert.equal(unreadable?.result, "fail", "the default reader cannot certify a directory without a committed head");
    } finally { f.cleanup(); }
  });

  test("W1-T11133 a real node:test log names tests by title, so the file's pass comes from its completion receipt", async () => {
    const log = realHostedLog(false);
    assert.match(log, /^ok 1 - real owner cli$/m, "positive control: the real TAP line carries the test's title");
    assert.doesNotMatch(log, new RegExp(`^ok \\d+ - ${FILE.replace(/[./]/g, "\\$&")}$`, "m"),
      "and never the file path, so a matcher on `ok N - <file>` can never see a real pass");
    const target = { owner: "o", repo: "r", headSha: HEAD, proofs: [PROOF] };
    const [passed] = await readHostedFixProofResults(target, hostedFixture({ log }).io);
    assert.equal(passed?.result, "pass");
    const [failed] = await readHostedFixProofResults(target,
      hostedFixture({ conclusion: "failure", runs: [{ ...hostedFixture().run, conclusion: "failure" }], log: realHostedLog(true) }).io);
    assert.equal(failed?.result, "fail", "a real failing run names its file through the failing test's location");
    assert.equal(HOSTED_TEST_FILE_RE.test(`test at ${FILE}:5:1`), true, "a located test file is recognised");
    assert.equal(HOSTED_TEST_FILE_RE.test(`node --test ${FILE}`), false, "a bare path with no line and column is not a location");
    const torn = hostedTestFileEvidence(['RMD-TEST-FILE-DIAGNOSTIC {"phase":"completed","file":']);
    assert.equal(torn.completed.size, 0, "an unreadable receipt certifies nothing");
    assert.equal(torn.failing.size, 1, "and is kept as a failure, never dropped");
  });

  test("W1-T11133 the escalation's review load is the sweep's measured review.capacity reading, not an injected field", () => {
    assert.match(LOAD, /^cpu PSI full 38\.05%, some 61\.2% \(avg10\); memory PSI some 0%; 16603 MiB available; review\.capacity at 2026-11-03T01:00:10\.000Z, 20 s before the review posted$/);
    const input = buildFixProgressInput(facts());
    assert.equal(input.offHostPassEvidence?.[0]?.reviewLoad, LOAD, "the production row the sweep writes reaches the evidence");
    const noReading = facts();
    noReading.ledger = noReading.ledger.filter((row) => row.step !== "review.capacity");
    assert.equal(buildFixProgressInput(noReading).offHostPassEvidence?.[0]?.reviewLoad, undefined, "with no reading, no load is claimed");
    const later = facts();
    later.ledger = later.ledger.map((row) => row.step === "review.capacity" ? { ...row, ts: "2026-11-03T01:05:00.000Z" } : row);
    assert.equal(reviewLoadFromCapacity(later.ledger.find((r) => r.step === "review.capacity"), POSTED_AT), undefined,
      "a reading taken after the review posted is not the load it ran under");
  });

  test("hosted evidence is read from the named file's passing job at the exact head", async () => {
    const target = { owner: "o", repo: "r", headSha: HEAD, proofs: [PROOF] };
    const f = hostedFixture();
    const results = await readHostedFixProofResults(target, f.io);
    assert.equal(results.length, 1);
    assert.deepEqual({ ...results[0], output: undefined }, { ...ci, output: undefined });
    assert.match(results[0]!.output, /^RMD-TEST-FILE-DIAGNOSTIC .*"phase":"completed".*"file":"test\/fix-lane\/real-owner\.test\.ts"/,
      "the pass rests on the run's own completion receipt for the physical file");
    assert.ok(f.calls.includes(`repos/o/r/commits/${HEAD}/check-runs?per_page=100`));
    assert.ok(f.calls.includes("repos/o/r/actions/jobs/7"));
    assert.ok(f.calls.includes("repos/o/r/actions/jobs/7/logs"));
    for (const over of [{ sha: "old" }, { conclusion: "failure" }, { log: `ok 1 - ${FILE} # SKIP` }, { log: `ok 1 - ${FILE}` },
      { log: realHostedLog(false).split("\n").filter((line) => !line.includes('"phase":"completed"')).join("\n") },
      { log: `node --test ${FILE}\n# tests 0\n# fail 0` }, { log: "ok 1 - test/other.test.ts" },
      { runs: [f.run, { ...f.run, id: 13, conclusion: "failure" }] }]) {
      assert.deepEqual(await readHostedFixProofResults(target, hostedFixture(over).io), [], JSON.stringify(over));
    }
    for (const conclusion of ["success", "failure"]) {
      const red = hostedFixture({ conclusion, runs: [{ ...f.run, conclusion }], log: realHostedLog(true) });
      const results = await readHostedFixProofResults(target, red.io);
      assert.equal(results[0]?.result, "fail", "a reproduced proof failure is carried, including a contradictory passing line");
      const input = await buildFixProgressInputWithHostedProofs({ ...facts(), hostedProofResults: undefined }, async () => results);
      assert.equal(input.signals.offHostPass, undefined);
    }
    assert.deepEqual(await readHostedFixProofResults({ ...target, proofs: ["unit test: a title"] }, f.io), []);
    const missing = await buildFixProgressInputWithHostedProofs({ ...facts(), hostedProofResults: undefined }, async () => { throw new Error("job log denied"); });
    assert.equal(missing.signals.offHostPass, undefined);
    assert.match(missing.harnessGuidance!, /job log denied/);
  });

  test("the actual fix and sweep stand-ins escalate with production-collected hosted receipts", async () => {
    for (const lane of ["fix", "sweep"] as const) {
      const f = facts(), hosted = hostedFixture();
      const view: OpenPrView = { prNumber: 15532, prUrl: "https://github.com/o/r/pull/15532", taskId: f.taskId,
        headSha: HEAD, checksState: "green", reviewState: "failure", unmetCriteria: [criterion],
        priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date().toISOString(), criteriaRecoverable: true };
      const escalated: string[] = [];
      const deps: SweepDeps = { ledgerPath: "/unused/off-host-proof", runId: "off-host-test",
        readLedger: () => f.ledger, appendLine: (_path, row) => { f.ledger.push(row); },
        readHostedProofResults: (headSha, proofs) => readHostedFixProofResults({ owner: "o", repo: "r", headSha, proofs }, hosted.io),
        dispatchFix: () => assert.fail("a corroborated harness failure must never dispatch"),
        escalate: (_pr, reason) => { escalated.push(reason); }, arm: () => {}, close: () => {} };
      if (lane === "fix") {
        const outcome = await routeFix("OPEN", view, { ...deps, ledgerLines: () => f.ledger });
        assert.equal(outcome.outcome, "escalated");
      } else await runSweep([view], deps);
      assert.equal(escalated.length, 1, lane);
      for (const part of [PROOF, OUTPUT, worker.output, ci.check, LOAD])
        assert.ok(escalated[0]!.includes(part), `${lane} lost ${part}`);
      assert.ok(hosted.calls.some(call => call.endsWith("/logs")), `${lane} never read hosted evidence`);
    }
  });

  test("a real fix round persists its acceptance receipt in fix.done and escalates before a second worker", async () => {
    const f = workerFixture(), hosted = hostedFixture();
    // The daemon ledger the fix rung reads carries the sweep's review.capacity readings beside its own rows.
    const rows: Record<string, unknown>[] = [{ ...CAPACITY }], issues: string[] = [];
    const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
    const review = (headSha: string): ReviewRunResult => ({ state: "failure", headSha, criteria: [criterion],
      summary: "review sandbox timeout", testTheater: false, floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, reviewerOutcome: "success" });
    let workers = 0;
    const opts: Parameters<typeof runFixRung>[0] & {
      workerProofIo: typeof f.io; hostedProofReader: SweepDeps["readHostedProofResults"];
    } = {
      taskId: "W1-T11133", runId: "off-host-rung", task: { id: "W1-T11133", title: "off-host proof", files: [FILE] },
      prUrl: "https://github.com/o/r/pull/15532", branch: "run-W1-T11133-1", worktreePath: f.root,
      initialSessionId: "session", mount, settingsFile: "settings/worker.json", budgetUsd: 1, strikeCap: 10,
      config: { root: f.root, workerProviders: { harnessCommitsFix: true } } as never,
      initialReview: review("old-head"), progressDecision: { verdict: "continue", reason: "first round" },
      reviewBase: { owner: "o", repo: "r", headCheckoutDir: f.root, reviewerMount: mount },
      workerProofIo: f.io,
      hostedProofReader: (headSha, proofs) => readHostedFixProofResults({ owner: "o", repo: "r", headSha, proofs }, hosted.io),
      escalationJudge: async () => ({ decision: "deliver", reason: "harness failure" }),
      deps: {
        spawn: async () => {
          assert.equal(++workers, 1, "the harness verdict must prevent a second worker");
          return { sessionId: "session", costUsd: 0, numTurns: 1,
            text: "FIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(owner): repair owner\nPR_URL: https://github.com/o/r/pull/15532",
            blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [],
            childEnvKeys: [], model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false };
        },
        harnessCommitForShellLessWorker: input => { input.onCommit?.(HEAD); return 1; },
        commitsAhead: () => 0, worktreeHasUncommittedChanges: () => true,
        readRoundCommits: () => [{ sha: HEAD, subject: "fix(owner): repair owner", changedFiles: 1 }],
        push: () => ({ fixRoundPushedHead: HEAD }), readRemoteBranchHead: async () => HEAD,
        waitForCiGreen: async () => "green",
        runReview: async input => {
          input.log("review.posted", { ts: POSTED_AT, head_sha: HEAD, decision_verdict: { criteria: [criterion] } });
          return review(HEAD);
        },
        fetchPrBody: async () => "Remudero-Task: W1-T11133", fetchPrDiffFiles: async () => [FILE],
        ledgerPath: join(f.root, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, fields) => { rows.push({ ...fields, step, task_id: "W1-T11133" }); },
        issues: { create: (_title, body) => { issues.push(body); return "https://github.com/o/r/issues/1"; } },
        say: () => {}, account: r => r,
      },
    };
    try {
      const result = await runFixRung(opts);
      const done = rows.find(row => row.step === "fix.done");
      const receipts = done?.worker_proof_results as { result: string; proof: string; headSha: string; output: string }[];
      assert.equal(receipts?.[0]?.result, "pass", JSON.stringify(rows));
      assert.equal(receipts[0]!.proof, PROOF);
      assert.equal(receipts[0]!.headSha, HEAD);
      assert.match(receipts[0]!.output, /# tests 1/);
      assert.equal(result.outcome, "escalated", JSON.stringify({ result, rows }));
      assert.equal(workers, 1);
      assert.equal(f.spawns(), 1);
      assert.equal(issues.length, 1);
      for (const part of [PROOF, ci.check, LOAD, "# tests 1"]) assert.ok(issues[0]!.includes(part), part);
    } finally { f.cleanup(); }
  });

  test("persistent review failure plus both exact-head passes supplies the harness evidence", async () => {
    const input = buildFixProgressInput(facts());
    assert.equal(input.signals.reviewerOnlyFailurePersists, 1);
    assert.equal(input.signals.offHostPass, true);
    assert.deepEqual(input.rounds[0]!.workerProofResults, [worker]);
    assert.deepEqual(input.offHostPassEvidence, [{ claim: CLAIM, proof: PROOF,
      reviewerOutput: OUTPUT, reviewLoad: LOAD, worker, ci: [ci] }]);
    assert.match(input.harnessGuidance!, /harness/);
    const standIn = await judgeFixProgress(input);
    assert.equal(standIn.verdict, "escalate");
    if (standIn.verdict !== "escalate") assert.fail("a harness decision must stop dispatch");
    assert.equal(standIn.loop, "harness");
    for (const evidence of [PROOF, OUTPUT, worker.output, ci.check, ci.output, LOAD]) {
      assert.ok(standIn.reason.includes(evidence), `missing escalation evidence: ${evidence}`);
    }
    const persistedLoad = buildFixProgressInput({ ...facts(), reviewFailures: [criterion] });
    assert.equal(persistedLoad.offHostPassEvidence?.[0]?.reviewLoad, LOAD,
      "the live unmet producer may omit load, so retain the review's original ledger record");
  });

  test("a wired harness judgment follows the existing escalation route", async () => {
    const input = buildFixProgressInput(facts());
    let calls = 0;
    const result = await resolveFixProgress(input, [], { firstRound: true, judge: async seen => {
      calls++;
      assert.equal(seen.signals.offHostPass, true);
      return { verdict: "harness", reason: "fresh review sandbox needed" };
    } });
    assert.equal(calls, 1);
    assert.equal(result.decision.verdict, "escalate");
    assert.match(result.decision.reason, /fresh review sandbox needed/);
    assert.ok(result.decision.reason.includes(PROOF));
    assert.equal(result.receipt.step, "fix.progress_judged");
    assert.deepEqual(parseFixProgressVerdict('{"verdict":"harness","reason":"off-host proof passed"}'),
      { verdict: "escalate", loop: "harness", reason: "off-host proof passed" });
  });

  test("W1-T11133 criterion 2: reproduced or missing off-host results preserve ordinary judgments", async () => {
    for (const source of ["worker-fail", "ci-fail", "worker-missing", "ci-missing"] as const) {
      const f = facts();
      if (source === "worker-fail") f.ledger[1]!.worker_proof_results = [{ ...worker, result: "fail" }];
      if (source === "ci-fail") f.hostedProofResults = [{ ...ci, result: "fail" }];
      if (source === "worker-missing") delete f.ledger[1]!.worker_proof_results;
      if (source === "ci-missing") f.hostedProofResults = [];
      const input = buildFixProgressInput(f);
      assert.equal(input.signals.offHostPass, undefined, source);
      assert.equal(input.offHostPassEvidence, undefined, source);
      for (const decision of [
        { verdict: "continue" as const, reason: "a defect remains" },
        { verdict: "change-approach" as const, approach: "reproduce on worker", reason: "changed evidence" },
        { verdict: "escalate" as const, loop: "repeated patch", reason: "ordinary escalation" },
      ]) assert.deepEqual(await judgeFixProgress(input, async () => decision), decision);
      assert.equal((await judgeFixProgress(input)).verdict, "unavailable");
    }
    const old = facts();
    delete old.ledger[1]!.worker_proof_results;
    const legacy = buildFixProgressInput({ ...old, hostedProofResults: undefined });
    const noResults = buildFixProgressInput({ ...old, hostedProofResults: [] });
    assert.deepEqual(noResults.signals, legacy.signals);
    assert.deepEqual(Object.keys(legacy.signals).sort(), ["identicalDiffs", "identicalRedSets", "incompleteRounds",
      "noOpRounds", "oscillating", "refusedRounds", "reviewerOnlyFailurePersists"]);
  });

  test("stale, unrelated, superseded and malformed receipts cannot establish an off-host pass", () => {
    const changes: ((f: ReturnType<typeof facts>) => void)[] = [
      f => { f.ledger[1]!.worker_proof_results = [{ ...worker, headSha: "old-head" }]; },
      f => { f.ledger[1]!.worker_proof_results = [{ ...worker, proof: "unit test: unrelated" }]; },
      f => { f.hostedProofResults = [{ ...ci, headSha: "old-head" }]; },
      f => { f.hostedProofResults = [{ ...ci, testFile: "test/another.test.ts" }]; },
      f => { f.ledger[1]!.pushed_head_sha = "old-head"; },
      f => { f.ledger[1]!.fix_outcome = "NO_CHANGE"; },
      f => { f.ledger[1]!.subtype = "push_failed"; },
      f => { f.ledger[1]!.pr_number = 999; },
      f => { f.ledger.find((row) => row.step === "review.posted")!.pr_number = 999; },
      f => { f.reviewFailures = [{ ...criterion, proofFailureOutput: "different assertion" }]; },
      f => { f.reviewFailures = [{ ...criterion, proof_exec: "executed_pass" }]; },
      f => { f.currentRed.push("test-fast-shard (2/8)"); },
      f => { f.reviewFailures = []; },
      f => { f.ledger[1]!.worker_proof_results = [null, {}, { ...worker, result: "unknown" }]; },
      f => { f.ledger[1]!.worker_proof_results = [worker, { ...worker, result: "fail" }]; },
      f => { f.hostedProofResults = [ci, { ...ci, result: "fail" }]; },
      f => { f.hostedProofResults = [{ ...ci, check: "" }]; },
      f => { f.ledger[0]!.reviewer_proof_failures = [{ claim: CLAIM, digest: "wrong-output" }]; },
      f => { f.ledger[0]!.reviewer_proof_failures = reviewerProofFailures([{ ...criterion, proof: "unit test: old proof" }]); },
      f => { f.ledger.find((row) => row.step === "review.posted")!.decision_verdict = { criteria: [{ ...criterion, proof: "unit test: old proof" }] }; },
    ];
    for (const change of changes) {
      const f = facts();
      change(f);
      assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, change.toString());
    }
  });

  test("pending checks and later rounds cannot borrow an earlier pass", () => {
    const f = facts();
    // This case indexes rounds by position; the capacity reading is not what it judges.
    f.ledger = f.ledger.filter((row) => row.step !== "review.capacity");
    assert.equal(buildFixProgressInput({ ...f, pendingChecks: [ci.check] }).signals.offHostPass, undefined);
    f.ledger.push(
      { ...f.ledger[0], round_id: "r2", head_sha: HEAD },
      { ...f.ledger[1], round_id: "r2", fix_outcome: "NO_CHANGE" },
      { ...f.ledger[2] },
    );
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined);
    delete f.ledger[4]!.pushed_head_sha;
    f.ledger[4]!.fix_outcome = "FIXED";
    f.ledger[4]!.worker_proof_results = [{ ...worker, result: "fail" }];
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, "an unpushed failure supersedes the old pass");
    f.ledger.splice(3);
    f.ledger.push({ ...f.ledger[0], round_id: "r2", head_sha: HEAD });
    assert.equal(buildFixProgressInput(f).signals.offHostPass, undefined, "an ongoing round has no new result yet");
  });

  test("a wired judge chooses its verdict from the signal without a forced harness override", async () => {
    const input = buildFixProgressInput(facts());
    for (const decision of [
      { verdict: "continue" as const, reason: "investigate additional evidence" },
      { verdict: "change-approach" as const, approach: "inspect another cause", reason: "new facts" },
    ]) assert.deepEqual(await judgeFixProgress(input, async () => decision), decision);
    const decision = await judgeFixProgress(input, async () =>
      parseFixProgressVerdict('{"verdict":"harness","reason":"review environment"}'));
    assert.equal(decision.verdict, "escalate");
    assert.ok(decision.reason.includes(worker.output));
  });

  test("a harness verdict without corroborating results holds rather than dispatches", async () => {
    const f = facts();
    f.hostedProofResults = [];
    const decision = await judgeFixProgress(buildFixProgressInput(f), async () => ({ verdict: "harness", reason: "guess" }));
    assert.equal(decision.verdict, "unavailable");
    assert.match(decision.reason, /off-host/);
  });
});
