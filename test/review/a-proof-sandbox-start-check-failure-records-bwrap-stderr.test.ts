import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { execWhitelistedProof, execWhitelistedProofAsync, judgeReview, judgeReviewAsync, parseWhitelistedProof,
  proofConcludedNothing, proofExecutionOutcome, ProofSandboxUnavailableError, sandboxStartFailure, sandboxStartFailureOf,
  setProofSandboxForTests, unmetReviewCriteria, type ReviewEvidence, type SandboxStartFailure } from "#src/lib/review.js";
import { opsReviewCommentBody, opsReviewRecord } from "#src/cli/commands/review.js";
import { inconclusiveLoadLowered, pendingProofRetryCause, type OpenPrView } from "#src/lib/sweep.js";

// W1-T15100. OBSERVED 2026-11-27: about 13% of review.proof_execution rows in 24 h (292 of about 2,227) ended "error" in
// under 100 ms, their sandbox start check failing with only "Command failed: bwrap --die-with-parent ..." kept, and the
// review called each one inconclusive_load and parked its PR pending.
const PROOF_FILE = "test/start-check.test.ts";
const criteria = [{ claim: "the behaviour holds", proof: `unit test: ${PROOF_FILE}` }];
const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sandbox-start-`));
mkdirSync(join(checkout, "test"), { recursive: true });
writeFileSync(join(checkout, PROOF_FILE), "import { test } from 'node:test'; test('x', () => {});\n");
after(() => { setProofSandboxForTests(); rmSync(checkout, { recursive: true, force: true }); });
const DIFF = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
const evidence = (extra: Partial<ReviewEvidence>): ReviewEvidence =>
  ({ diff: DIFF, report: "the behaviour holds", headCheckoutDir: checkout, sampleLoad: () => ({ load1: 30 }), ...extra } as ReviewEvidence);
const MISSING = join(checkout, "gone");
const failure: SandboxStartFailure = { stderr: "bwrap: Can't mkdir /tmp/x: No space left on device\n", exitCode: 1, signal: null,
  bindSources: [{ path: checkout, existed: true }, { path: MISSING, existed: false }] };
const startFailed = () => new ProofSandboxUnavailableError("Command failed: bwrap --die-with-parent", failure);

test("W1-T15100 criterion 1: a failed start check records bwrap's stderr, exit code and bind sources", async () => {
  // A real failing spawn, sync and async: bwrap's stderr and exit code survive, and each bind source is checked on disk.
  const args = ["--ro-bind", checkout, checkout, "--bind", MISSING, "/tmp", "--ro-bind", checkout, "/x"];
  const script = ["-e", "process.stderr.write('bwrap: setting up uid map: Permission denied\\n'); process.exit(1)"];
  let sync: unknown;
  try { execFileSync(process.execPath, script, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }); } catch (error) { sync = error; }
  let async: unknown;
  try { await promisify(execFile)(process.execPath, script); } catch (error) { async = error; }
  for (const error of [sync, async]) {
    assert.deepEqual(sandboxStartFailure(error, args), { stderr: "bwrap: setting up uid map: Permission denied\n", exitCode: 1,
      signal: null, bindSources: [{ path: checkout, existed: true }, { path: MISSING, existed: false }] });
  }
  assert.deepEqual(sandboxStartFailure({ signal: "SIGKILL" }, []), { stderr: "", exitCode: null, signal: "SIGKILL", bindSources: [] });
  assert.equal(sandboxStartFailure({ stderr: Buffer.from("raw") }, []).stderr, "raw");

  // Through the real start check: a "sandbox" binary that refuses bwrap's argv fails its check before the proof runs.
  setProofSandboxForTests({ mode: "bwrap", binary: "/bin/sh" });
  const proof = parseWhitelistedProof(criteria[0]!.proof)!;
  let thrownSync: unknown, thrownAsync: unknown;
  try { execWhitelistedProof(proof, checkout); } catch (error) { thrownSync = error; }
  try { await execWhitelistedProofAsync(proof, checkout); } catch (error) { thrownAsync = error; }
  setProofSandboxForTests();
  for (const thrown of [thrownSync, thrownAsync]) {
    const recorded = sandboxStartFailureOf(thrown);
    assert.ok(recorded, String(thrown));
    assert.notEqual(recorded.stderr.trim(), "", "the start check's own stderr is kept");
    assert.equal(typeof recorded.exitCode, "number");
    assert.ok(recorded.bindSources.length > 0 && recorded.bindSources.every((b) => typeof b.existed === "boolean"));
  }
  assert.equal(sandboxStartFailureOf(new Error("other")), undefined);

  // The review.proof_execution row and the review record both carry it.
  assert.deepEqual(proofExecutionOutcome({ error: startFailed() }), { outcome: "sandbox_start_failed", sandbox_stderr: failure.stderr,
    sandbox_exit_code: 1, sandbox_signal: null, sandbox_bind_sources: failure.bindSources });
  assert.deepEqual(proofExecutionOutcome({ error: new Error("x") }), { outcome: "error" });
  assert.deepEqual(proofExecutionOutcome({ outcome: "pass" }), { outcome: "pass" });
  const [criterion] = judgeReview(criteria, evidence({ execProof: () => { throw startFailed(); } })).criteria;
  assert.equal(criterion!.proof_exec, "sandbox_start_failed");
  assert.deepEqual(criterion!.sandboxStartFailure, failure);
  assert.match(criterion!.reason, /exit 1; bwrap stderr: bwrap: Can't mkdir \/tmp\/x: No space left on device; missing bind sources: .*gone/);
  const signalled = { ...failure, stderr: "", exitCode: null, signal: "SIGKILL", bindSources: [] };
  const killed = judgeReview(criteria, evidence({ execProof: () => { throw new ProofSandboxUnavailableError("x", signalled); } }));
  assert.match(killed.criteria[0]!.reason, /signal SIGKILL; bwrap stderr: \(empty\); missing bind sources: none/);
  assert.deepEqual(JSON.parse(JSON.stringify(criterion)).sandboxStartFailure, failure, "the review record serialises it");
  // The host's per-head review record keeps it, field by field.
  const record = opsReviewRecord({ taskId: "W1-T1", prUrl: "https://github.com/o/r/pull/1", headSha: "a".repeat(40), state: "pending",
    decisionDigest: "d", criteria: [criterion!], reasons: [], findings: [] });
  assert.deepEqual(record.criteria[0]!.sandbox_start_failure, { stderr: failure.stderr, exit_code: 1, signal: null, bind_sources: failure.bindSources });
  // A `grep:` proof keeps its keyword floor, and its failed start check's evidence too.
  const grepCriteria = [{ claim: "the behaviour holds", proof: "grep: behaviour in src/x.ts" }];
  const [grep] = judgeReview(grepCriteria, evidence({ execProof: () => { throw startFailed(); } })).criteria;
  assert.equal(grep!.proof_exec, "not_executable");
  assert.deepEqual(grep!.sandboxStartFailure, failure);
});

test("W1-T15100 criterion 2: a failed start check is sandbox_start_failed and re-runs on the next pass", async () => {
  // Intermittent: the first start fails, the re-run on the next pass starts and passes — the review is not parked.
  let calls = 0;
  const flaky = await judgeReviewAsync(criteria, evidence({ asyncExecProof: async () => { calls++; if (calls === 1) throw startFailed(); return "pass"; } }));
  assert.equal(calls, 2, "the failed start check was re-run on the next pass");
  assert.equal(flaky.criteria[0]!.proof_exec, "executed_pass");
  assert.equal(flaky.state, "success");
  // A repeat failure is sandbox_start_failed — never inconclusive_load, never unmet — and holds the verdict pending.
  let repeats = 0;
  const stuck = await judgeReviewAsync(criteria, evidence({ asyncExecProof: async () => { repeats++; throw startFailed(); } }));
  assert.equal(repeats, 2);
  assert.equal(stuck.criteria[0]!.proof_exec, "sandbox_start_failed");
  assert.notEqual(stuck.criteria[0]!.proof_exec, "inconclusive_load");
  assert.equal(stuck.state, "pending");
  assert.equal(stuck.floorState, "pending");
  assert.deepEqual(unmetReviewCriteria(stuck.criteria), []);
  assert.equal(proofConcludedNothing("sandbox_start_failed"), true);
  assert.equal(proofConcludedNothing("executed_fail"), false);
  assert.match(opsReviewCommentBody("pending", criteria, stuck.criteria), /UNDETERMINED: the behaviour holds/);
  // Its pending summary names the start check, never host load.
  assert.match(stuck.summary, /^remudero-review: sandbox-start-failed — /);
  assert.doesNotMatch(stuck.summary, /load/);
  // The next sweep pass re-reviews it at ANY load: a start failure says nothing about load.
  const URL = "https://github.com/acme/remudero/pull/1", HEAD = "a".repeat(40);
  const pr: OpenPrView = { prNumber: 1, prUrl: URL, taskId: "W1-T1", headSha: HEAD, checksState: "green", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date().toISOString() };
  const row = (proofExec: string, extra: Record<string, unknown> = {}) => ({ task_id: "W1-T1", pr_url: URL, head_sha: HEAD,
    step: "review.posted", state: "pending", ts: new Date().toISOString(),
    decision_verdict: { state: "pending", criteria: [{ claim: "c", proof: "p", met: false, reason: "r", proof_exec: proofExec, ...extra }] } });
  assert.equal(inconclusiveLoadLowered(pr, [row("sandbox_start_failed")], () => ({ load1: 99 })), true);
  assert.equal(inconclusiveLoadLowered(pr, [row("sandbox_start_failed")], () => ({})), true, "no load sample is needed");
  assert.equal(inconclusiveLoadLowered(pr, [row("executed_fail")], () => ({ load1: 1 })), false);
  assert.equal(inconclusiveLoadLowered(pr, [row("inconclusive_load", { load: { start: { load1: 20 }, end: { load1: 41 } } })], () => ({ load1: 60 })),
    false, "a load-shaped proof still waits for lower load");
  // The sweep names the cause it re-reviews for: the start check, never a quieter host.
  assert.equal(pendingProofRetryCause(pr, [row("sandbox_start_failed")], () => ({ load1: 99 })), "sandbox-start-failed");
  assert.equal(pendingProofRetryCause(pr, [row("inconclusive_load", { load: { start: { load1: 20 }, end: { load1: 41 } } })], () => ({ load1: 5 })),
    "inconclusive-load");
  assert.equal(pendingProofRetryCause(pr, [row("executed_fail")], () => ({ load1: 1 })), undefined);
});
