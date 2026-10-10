// W1-T5954 — a pass with no `updateBranch` (the light pass `buildSweepLightHook` composes) cannot
// give a timed-out ci-gate its new head. Before this task it escalated "update-branch is not wired",
// and every later full pass read "already escalated at this head" and never refreshed (W1-T5941's
// sequence d). It now defers to a pass that has update-branch; escalation stays for a real refresh
// failure or the BACKSTOP, and a legacy "not wired" escalation row no longer counts as one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  CI_TIMEOUT_REFRESH_BACKSTOP,
  DEFAULT_SWEEP_POLICY,
  ciTimeoutRefreshDecision,
  runSweep,
  runSweepLightPass,
  type CiFailure,
  type OpenPrView,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "./helpers/sweep-test.js";
import { lightPassActionable } from "../src/run-task.js";

const PR_NUMBER = 9392;
const HEAD = "1f9c8198e0b0344153d1c20259ddf6c81f6ffc61";
const NEXT_HEAD = "2a0d9209f1c1455264e2d31360eef7d92a0eb172";
const LEGACY_WHY = "update-branch is not wired";

// W1-T5921's #9388 evidence: the gate's own TIMED OUT line over a never-started `rule-checks`.
const TIMEOUT_LOG_TAIL = [
  "2026-10-05T21:29:59.1000000Z waiting for required check(s) to complete:",
  "2026-10-05T21:29:59.1000000Z   - rule-checks",
  "2026-10-05T21:30:01.0000000Z ##[error]ci-gate: TIMED OUT waiting for required check(s) to complete (this is " +
    "NOT a check failure -- a NEW sha is the only remedy, re-running this same sha will not help):",
  "2026-10-05T21:30:01.0000000Z   - rule-checks",
  "2026-10-05T21:30:01.2000000Z ##[error]Process completed with exit code 1.",
].join("\n");

/** W1-T5941's QueueRepoFake, cut to the one PR whose ci-gate timed out. */
class TimeoutRepoFake {
  head = HEAD;
  timedOut = true;
  readonly branchUpdates: string[] = [];
  readonly escalations: string[] = [];
  update: () => UpdateBranchOutcome = () => "updated";

  openPrs(): OpenPrView[] {
    const hang = (name: string): CiFailure => ({ name, conclusion: "FAILURE", jobId: `${name.length}00`,
      logTail: `${name}: SHARD HANG — the matrix was cancelled while the PR head\n  was unchanged. THE TESTS DID NOT RUN — this is NOT a failure of this diff` });
    return [{
      prNumber: PR_NUMBER, prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`, taskId: "W1-T5908",
      headSha: this.head, headRefName: "run-W1-T5908-1791200000000", reviewState: "success",
      checksState: this.timedOut ? "red" : "pending", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: new Date().toISOString(), autoMergeArmed: false, isPlanFiling: false,
      ...(this.timedOut ? {
        redRequiredChecks: ["ci", "coverage-ratchet"],
        ciFailures: [{ name: "ci-gate", conclusion: "FAILURE", jobId: "901", logTail: TIMEOUT_LOG_TAIL }, hang("ci"), hang("coverage-ratchet")],
      } : {}),
    }];
  }

  effects(): Omit<SweepDeps, "ledgerPath" | "runId"> {
    return {
      arm: () => "armed",
      close: () => {},
      dispatchFix: () => { assert.fail("a ci-gate timeout never spends a fix strike"); },
      escalate: (_p, reason) => { this.escalations.push(reason); },
      requeueCheck: () => { assert.fail("a ci-gate timeout is never a same-sha requeue"); },
      readMergeQueueMembership: () => "not-queued",
      readLiveState: () => ({ ok: true, state: "OPEN", headSha: this.head }),
      updateBranch: (p) => {
        this.branchUpdates.push(p.headSha);
        const outcome = this.update();
        if (outcome === "updated") {
          this.head = NEXT_HEAD;
          this.timedOut = false;
        }
        return outcome;
      },
      readLedgerUnion: () => ({ complete: false, lines: [] }),
    };
  }
}

function scenario(t: TestContext, label: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5954-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const gh = new TimeoutRepoFake();
  let n = 0;
  const pass = async (surface: "full" | "light") => {
    const before = readLedgerLines(ledgerPath).length;
    const base = { ...gh.effects(), ledgerPath, runId: `SWEEP-W1-T5954-${label}-${++n}-${surface}` };
    if (surface === "full") {
      await runSweep(gh.openPrs(), base, DEFAULT_SWEEP_POLICY);
    } else {
      // `buildSweepLightHook`'s ordinary batch with an idle fleet: the fix rung admitted, update-branch unwired.
      await runSweepLightPass(gh.openPrs(), {
        ...base, actionable: (d) => lightPassActionable(d, true, false, true),
        readLiveHeadSha: () => gh.head, updateBranch: undefined,
      }, DEFAULT_SWEEP_POLICY);
    }
    const rows = readLedgerLines(ledgerPath).slice(before);
    const disposed = rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === PR_NUMBER).at(-1);
    return { rows, disposed, step: (step: string) => rows.filter((r) => r.step === step) };
  };
  const all = (step: string) => readLedgerLines(ledgerPath).filter((r) => r.step === step);
  return { gh, ledgerPath, pass, all };
}

test("a light pass with an idle fleet defers the ci-gate timeout without escalating, and the next full pass refreshes the head", async (t) => {
  const s = scenario(t, "defer");
  for (const i of [1, 2]) {
    const light = await s.pass("light");
    assert.deepEqual(s.gh.branchUpdates, [], `light pass ${i}: no update-branch on this surface`);
    assert.deepEqual(s.gh.escalations, [], `light pass ${i}: and no escalation`);
    assert.equal(light.rows.filter((r) => String(r.step).startsWith("sweep.ci_timeout_refresh")).length, 0,
      "a deferral spends no attempt and writes no escalation row");
    assert.match(String(light.disposed?.stand_down_reason),
      /deferred to full sweep \(update-branch not available on this pass\)/);
    assert.equal(light.disposed?.acted, false);
  }

  const full = await s.pass("full");
  assert.deepEqual(s.gh.branchUpdates, [HEAD], "the full pass gives the PR its new head");
  assert.equal(full.step("sweep.ci_timeout_refresh.outcome")[0]?.outcome, "updated");
  assert.equal(s.gh.head, NEXT_HEAD);
  assert.deepEqual(s.gh.escalations, []);
});

test("a real refresh failure after a light deferral still escalates once at this head", async (t) => {
  const s = scenario(t, "conflict");
  await s.pass("light");
  s.gh.update = () => "conflict";
  await s.pass("full");
  assert.deepEqual(s.gh.branchUpdates, [HEAD]);
  assert.equal(s.gh.escalations.length, 1);
  assert.match(s.gh.escalations[0], /update-branch returned conflict/);

  for (const surface of ["light", "full"] as const) await s.pass(surface);
  assert.deepEqual(s.gh.branchUpdates, [HEAD], "never refreshed twice at one head");
  assert.equal(s.gh.escalations.length, 1, "escalated once per (PR, head)");
  assert.equal(s.all("sweep.ci_timeout_refresh.escalated").length, 1);
});

test("a throwing update-branch after a light deferral is an error outcome and escalates", async (t) => {
  const s = scenario(t, "throws");
  await s.pass("light");
  s.gh.update = () => { throw new Error("gh exploded"); };
  const full = await s.pass("full");
  const outcome = full.step("sweep.ci_timeout_refresh.outcome")[0];
  assert.equal(outcome?.outcome, "error");
  assert.match(String(outcome?.error), /gh exploded/);
  assert.equal(s.gh.escalations.length, 1);
  assert.match(s.gh.escalations[0], /update-branch returned error \(gh exploded\)/);
});

test("at the BACKSTOP even a pass without update-branch escalates, because the bound needs no refresh", async (t) => {
  const s = scenario(t, "backstop");
  for (let i = 0; i < CI_TIMEOUT_REFRESH_BACKSTOP; i += 1) {
    appendLedger(s.ledgerPath, { run_id: "R", task_id: "W1-T5908", step: "sweep.ci_timeout_refresh.attempted",
      pr_number: PR_NUMBER, head_sha: `head-${i}` } as LedgerLine);
  }
  await s.pass("light");
  assert.deepEqual(s.gh.branchUpdates, []);
  assert.equal(s.gh.escalations.length, 1);
  assert.match(s.gh.escalations[0], /BACKSTOP/);
});

test("a live 'not wired' escalation row from before this fix does not block the full pass's refresh", async (t) => {
  const s = scenario(t, "legacy");
  appendLedger(s.ledgerPath, { run_id: "SWEEP-light", task_id: "W1-T5908", step: "sweep.ci_timeout_refresh.escalated",
    pr_number: PR_NUMBER, head_sha: HEAD, why: LEGACY_WHY } as LedgerLine);
  const full = await s.pass("full");
  assert.deepEqual(s.gh.branchUpdates, [HEAD], "the legacy row is not an escalation of this head");
  assert.doesNotMatch(String(full.disposed?.stand_down_reason), /already escalated/);
  assert.deepEqual(s.gh.escalations, []);
});

test("ciTimeoutRefreshDecision: only a 'not wired' escalation is ignored, and it never resets the BACKSTOP count", () => {
  const pr = { prNumber: PR_NUMBER, headSha: HEAD };
  const legacy = { step: "sweep.ci_timeout_refresh.escalated", pr_number: PR_NUMBER, head_sha: HEAD, why: LEGACY_WHY };
  assert.equal(ciTimeoutRefreshDecision([legacy], pr).kind, "refresh");
  assert.equal(ciTimeoutRefreshDecision([{ ...legacy, why: "update-branch returned conflict" }], pr).kind, "escalated",
    "a real escalation at this head still stands");
  const attempts = Array.from({ length: CI_TIMEOUT_REFRESH_BACKSTOP }, (_, i) =>
    ({ step: "sweep.ci_timeout_refresh.attempted", pr_number: PR_NUMBER, head_sha: `h${i}` }));
  assert.equal(ciTimeoutRefreshDecision([...attempts, { ...legacy, head_sha: "h9" }], { prNumber: PR_NUMBER, headSha: "next" }).kind,
    "escalate", "a legacy row is no escalation, so it cannot restart the count");
});
