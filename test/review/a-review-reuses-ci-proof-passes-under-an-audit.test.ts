// W1-T14745: a review counts a proof's hosted PASS from CI's proof-discrimination record at the exact head instead of
// executing it, while an audit derived from the recorded agreement still executes a share of those proofs and returns
// to every proof after any disagreement. A hosted FAIL, a stale or missing outcome and an executor-touching diff run
// on the host. Every fixture head here LACKS the text its proof greps for, so a host execution FAILS the proof and a
// reuse is the only way a criterion reads executed_pass — the verdict itself tells the two paths apart.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { PROOF_REUSE_SHADOW_STEP, planProofReuse, runReview, type ProofDiscriminationRecordRead, type ReviewCommandHost } from "#src/cli/commands/review.js";
import {
  PROOF_REUSE_MIN_AUDIT_SHARE, agreementStreak, hostedPassIsReusable, hostedReuseOutcome, proofReuseAudited, proofReuseAuditShare,
  readProofReuseAgreement,
} from "#src/lib/proof-reuse-audit.js";
import { setProofSandboxForTests } from "#src/lib/review.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as gate from "#scripts/proof-discrimination-gate.mjs";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const OWNER = "acme";
const REPO = "remudero";
const PROOF = "grep: audited marker in src/x.ts";
const CRITERIA = [{ claim: "the marker ships", proof: PROOF }];
const BODY = "## Acceptance\n- claim: the marker ships\n  proof: grep: audited marker in src/x.ts\n\nRemudero-Task: W1-T14745\n";
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n";
const HOSTED_PASS = { proof: PROOF, status: 0, stdout: "verdict:    pass\nbase ref:   fork\nbase:       no-match\n" };
const CLEAN_RECORD = { ts: "2026-11-24T10:00:00.000Z", step: PROOF_REUSE_SHADOW_STEP, eligible: true, agreed: 100_000, disagreed: 0 };

/** A head checkout holding a small executor and an `src/x.ts` that does NOT contain the proof's text; a head whose
 *  hash leaves PROOF outside the audited floor share, so a long clean record reuses it. */
function headCheckout(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "t14745-head" });
  const files: Record<string, string> = {
    "scripts/proof-discrimination-gate.mjs": "import { run } from \"../src/lib/exec.ts\";\nexport const gate = run;\n",
    "src/lib/exec.ts": "export const run = 1;\n",
    "src/check-proof-main.ts": "export const main = 1;\n",
    "src/x.ts": "export const x = 1;\n",
    "package.json": JSON.stringify({ name: "fixture", imports: { "#src/*": "./src/*" } }),
    "package-lock.json": "{}\n",
    ".nvmrc": "24.22.3\n",
    ".github/workflows/proof-discrimination-gate.yml": "name: Proof discrimination\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  }
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture head");
  let headSha = repo.git("rev-parse", "HEAD");
  for (let n = 0; proofReuseAudited(headSha, PROOF, PROOF_REUSE_MIN_AUDIT_SHARE) && n < 500; n++) {
    repo.git("commit", "--allow-empty", "-qm", `unaudited head ${n}`);
    headSha = repo.git("rev-parse", "HEAD");
  }
  assert.equal(proofReuseAudited(headSha, PROOF, PROOF_REUSE_MIN_AUDIT_SHARE), false, "fixture: the head is outside the floor audit share");
  return { repo, headSha };
}

function recordLine(root: string, headSha: string, judged: Array<{ proof: string; status: number; stdout: string }> = [HOSTED_PASS]): string {
  return gate.resultLine(gate.proofDiscriminationRecord({ headSha, baseSha: "fork", body: BODY, criteriaSource: "PR body Acceptance block",
    executor: gate.executorDigestsAt(root), judged }));
}

function recordRoutes(headSha: string, log: string) {
  const run = { id: 77, head_sha: headSha, path: gate.PROOF_DISCRIMINATION_WORKFLOW, conclusion: "success", event: "pull_request" };
  const job = { id: 88, run_id: 77, name: gate.PROOF_DISCRIMINATION_JOB, head_sha: headSha, conclusion: "success" };
  return [
    { when: "actions/workflows/proof-discrimination-gate.yml/runs", stdout: JSON.stringify({ workflow_runs: [run] }) },
    { when: "actions/runs/77/jobs", stdout: JSON.stringify({ jobs: [job] }) },
    { when: "actions/jobs/88/logs", stdout: `2026-11-24T10:00:01.0000000Z ${log}\n` },
  ];
}

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }

/** One review of the fixture head with the ledger holding `history` and gh answering `routes`. */
async function review(t: TestContext, head: ReturnType<typeof headCheckout>, routes: Array<{ when: string; stdout?: string }>,
  history: Array<Record<string, unknown>>, diff = DIFF) {
  setProofSandboxForTests({ mode: "unsandboxed", reason: "disposable proof fixture" });
  t.after(() => setProofSandboxForTests());
  const ledgerPath = join(head.repo.dir, ".git/ledger.ndjson");
  writeFileSync(ledgerPath, history.map(row => `${JSON.stringify(row)}\n`).join(""));
  const host: ReviewCommandHost = {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
    JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
    attributeWorkerStreamEvent: (event) => event,
    ledgeredNonDispatchSpawn: (_lane, raw) => raw ?? spawnWorker,
    lintPlanForReview: unexpected,
    liveWorkerRunIds: new Set<string>(),
    materializeReviewWorktree: unexpected,
    readHeadShaRest: () => head.headSha,
    readMainPlanTreeSha: unexpected,
    realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: (verdict) => verdict.summary,
    reviewWorkerLockId: (runId) => runId,
    reviewerClockBoundMs: () => 60_000,
    reviewSubjectGit: unexpected,
  };
  const rows: Array<Record<string, unknown>> = [];
  return withGhShim([...routes, { when: "pr diff", stdout: diff }, { when: "api", stdout: "{}" }], async () => {
    const result = await runReview(host, { owner: OWNER, repo: REPO, prUrl: `https://github.com/${OWNER}/${REPO}/pull/14745`,
      task: { id: "W1-T14745", acceptance: CRITERIA, files: ["src/x.ts"] },
      report: BODY, settingsFile: join(head.repo.dir, "settings.json"), config: { root: head.repo.dir } as never,
      headCheckoutDir: head.repo.dir, ledgerPath, runId: "t14745",
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (r: WorkerResult) => r,
      shadow: true, spawnReviewer: false, readReviewReuseFacts: () => undefined, runtimeImageSha: null,
    });
    return { result, row: rows.find(row => row.step === PROOF_REUSE_SHADOW_STEP) };
  });
}

describe("test/review/a-review-reuses-ci-proof-passes-under-an-audit.test.ts", () => {
  test("the audit share is derived from the recorded agreement: all, then the rule of three, down to a floor", () => {
    assert.equal(proofReuseAuditShare(0), 1, "no agreement on record audits every proof");
    assert.equal(proofReuseAuditShare(3), 1, "three agreements still prove nothing the rule of three accepts");
    assert.equal(proofReuseAuditShare(30), 0.1);
    assert.equal(proofReuseAuditShare(300), PROOF_REUSE_MIN_AUDIT_SHARE);
    assert.equal(proofReuseAuditShare(10_000_000), PROOF_REUSE_MIN_AUDIT_SHARE, "a long clean record keeps a floor, never zero");
    assert.equal(proofReuseAuditShare(Number.NaN), 1);
    assert.ok(proofReuseAuditShare(60) > proofReuseAuditShare(600) || proofReuseAuditShare(60) === PROOF_REUSE_MIN_AUDIT_SHARE);
    const row = (ts: string, agreed: number, disagreed = 0, eligible: unknown = true) => ({ ts, eligible, agreed, disagreed });
    assert.equal(agreementStreak([]), 0);
    assert.equal(agreementStreak([row("2026-11-01T00:00:00Z", 40), row("2026-11-02T00:00:00Z", 60)]), 100, "agreements accumulate");
    assert.equal(agreementStreak([row("2026-11-03T00:00:00Z", 5, 1), row("2026-11-02T00:00:00Z", 60), row("2026-11-01T00:00:00Z", 40)]), 0,
      "any disagreement newest returns the share to every proof, whatever came before it");
    assert.equal(agreementStreak([row("2026-11-01T00:00:00Z", 40, 2), row("2026-11-03T00:00:00Z", 7), row("2026-11-02T00:00:00Z", 2)]), 9,
      "only the agreements after the newest disagreement count, in any row order");
    assert.equal(agreementStreak([row("2026-11-01T00:00:00Z", 40, 0, false), row("2026-11-02T00:00:00Z", 3, 0, "yes")]), 0, "a row that compared nothing adds nothing");
    assert.equal(agreementStreak([{ eligible: true, agreed: 50, disagreed: 0 }, row("2026-11-02T00:00:00Z", 4, 1)]), 0, "an unstamped row never hides a stamped disagreement");
  });

  test("an audited proof is a pure function of head, proof and share, and the share is the fraction audited", () => {
    assert.equal(proofReuseAudited("a".repeat(40), PROOF, 1), true);
    assert.equal(proofReuseAudited("a".repeat(40), PROOF, 0), false);
    const first = proofReuseAudited("a".repeat(40), PROOF, 0.5);
    assert.equal(proofReuseAudited("a".repeat(40), PROOF, 0.5), first, "the same head audits the same proofs");
    let audited = 0;
    for (let n = 0; n < 2000; n++) if (proofReuseAudited(n.toString(16).padStart(40, "0"), PROOF, 0.25)) audited++;
    assert.ok(audited > 400 && audited < 600, `about a quarter audited, got ${audited}/2000`);
  });

  test("only a hosted head PASS at a base that discriminates is countable; every other outcome runs on the host", () => {
    assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base: "no-match" }), true);
    assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base: "fail" }), true);
    assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base: "ABSENT" }), true, "a verified-absent base target discriminates");
    for (const base of ["pass", "UNKNOWN", "UNREADABLE", "COULD", "not reported", undefined]) {
      assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base }), false, `base ${String(base)} proved nothing`);
    }
    for (const verdict of ["fail", "executed_stale", "refused", "no-match", "exec_error", "unreadable"]) {
      assert.equal(hostedPassIsReusable({ verdict, head: "pass", base: "fail" }), false, `hosted ${verdict}`);
    }
    assert.equal(hostedPassIsReusable({ verdict: "pass", head: "fail", base: "fail" }), false);
    const reuse = { keys: new Set([JSON.stringify(["grep", ["-arn", "--", "m", "src/x.ts"]])]), headCwd: "/head", baseCwd: "/base" };
    const proof = { command: "grep", args: ["-arn", "--", "m", "src/x.ts"] };
    assert.equal(hostedReuseOutcome(reuse, proof, "/head"), "pass");
    assert.equal(hostedReuseOutcome(reuse, proof, "/base"), "fail", "the merge base answers the miss CI recorded");
    assert.equal(hostedReuseOutcome(reuse, proof, "/elsewhere"), undefined);
    assert.equal(hostedReuseOutcome(reuse, { command: "grep", args: ["other"] }, "/head"), undefined, "another proof executes");
    assert.equal(hostedReuseOutcome(undefined, proof, "/head"), undefined);
    assert.equal(hostedReuseOutcome({ ...reuse, baseCwd: undefined }, proof, "/base"), undefined);
  });

  test("the agreement history is read through the ledger and an unreadable ledger is an empty record", async () => {
    const lines = [JSON.stringify({ step: "s", eligible: true, agreed: 2 }), "{torn", JSON.stringify({ step: "other", eligible: true, agreed: 9 })];
    let asked: unknown;
    const read = await readProofReuseAgreement("/ledger", "s", async (dir, opts) => { asked = { dir, step: opts.step, keeps: opts.keep(lines[0]!) }; return { rawLines: lines }; });
    assert.deepEqual(asked, { dir: "/ledger", step: "s", keeps: true });
    assert.deepEqual(read.rows, [{ step: "s", eligible: true, agreed: 2 }], "a torn line and another step's row are not agreement");
    const failed = await readProofReuseAgreement("/ledger", "s", async () => { throw new Error("ledger unreadable: EIO"); });
    assert.deepEqual(failed, { rows: [], unreadable: "ledger unreadable: EIO" });
    assert.equal(proofReuseAuditShare(agreementStreak(failed.rows)), 1, "no readable agreement audits every proof");
  });

  test("a plan counts only the eligible record's countable proofs and says why when it counts none", async t => {
    const head = headCheckout(t);
    const record = (over: Record<string, unknown> = {}): ProofDiscriminationRecordRead => ({ kind: "record", runId: 77, jobId: 88,
      record: { ...JSON.parse(recordLine(head.repo.dir, head.headSha).slice(gate.RESULT_MARKER.length)), ...over } });
    const input = { prUrl: "https://github.com/acme/remudero/pull/14745", headSha: head.headSha, diff: DIFF, body: BODY, criteria: CRITERIA,
      headCheckoutDir: head.repo.dir, target: { owner: OWNER, repo: REPO }, agreement: { rows: [CLEAN_RECORD] } };
    const clean = await planProofReuse(record(), input);
    assert.equal(clean.audit.reuse_applied, true, JSON.stringify(clean.audit));
    assert.deepEqual([...clean.reused], [PROOF]);
    assert.equal(clean.audit.audit_share, PROOF_REUSE_MIN_AUDIT_SHARE);
    assert.equal(clean.audit.audited, 0);
    const audited = await planProofReuse(record(), { ...input, agreement: { rows: [] } });
    assert.equal(audited.reuse, undefined, "no agreement on record: the host executes every proof");
    assert.equal(audited.audit.audit_share, 1);
    assert.equal(audited.audit.audited, 1);
    const disagreed = await planProofReuse(record(), { ...input, agreement: { rows: [CLEAN_RECORD, { ...CLEAN_RECORD, ts: "2026-11-24T11:00:00.000Z", agreed: 9, disagreed: 1 }] } });
    assert.equal(disagreed.reuse, undefined, "a disagreement returns the audit to every proof");
    for (const [label, over, reason] of [
      ["hosted FAIL", { proofs: [{ proof: PROOF, head: "fail", base: "not reported", verdict: "fail" }] }, undefined],
      ["hosted stale", { proofs: [{ proof: PROOF, head: "pass", base: "pass", verdict: "executed_stale" }] }, undefined],
      ["an unmeasured base", { proofs: [{ proof: PROOF, head: "pass", base: "UNKNOWN", verdict: "pass" }] }, undefined],
      ["another head", { head_sha: "f".repeat(40) }, /another head/],
      ["another executor", { executor_digest: "0".repeat(64) }, /executor digest mismatch/],
    ] as const) {
      const plan = await planProofReuse(record(over), input);
      assert.equal(plan.reuse, undefined, label);
      assert.deepEqual([...plan.reused], [], label);
      if (reason !== undefined) assert.match(String(plan.audit.reuse_reason), reason, label);
    }
    const touching = await planProofReuse(record(), { ...input, diff: "diff --git a/scripts/proof-discrimination-gate.mjs b/scripts/proof-discrimination-gate.mjs\n" });
    assert.equal(touching.reuse, undefined);
    assert.match(String(touching.audit.reuse_reason), /^diff touches the executor/);
    const missing = await planProofReuse({ kind: "ineligible", reason: "no successful proof-discrimination run at this head" }, input);
    assert.equal(missing.audit.reuse_reason, "no successful proof-discrimination run at this head");
    const broken = await planProofReuse(record(), { ...input, criteria: undefined as never });
    assert.match(String(broken.audit.reuse_reason), /^reuse planning failed: /);
  });

  test("a clean record is counted without a host run, and any disagreement or missing record has the host execute the proof", async t => {
    const head = headCheckout(t);
    const routes = recordRoutes(head.headSha, recordLine(head.repo.dir, head.headSha));
    const reused = await review(t, head, routes, [CLEAN_RECORD]);
    assert.equal(reused.result.criteria[0]?.proof_exec, "executed_pass", "CI's PASS is counted although this head lacks the text");
    assert.equal(reused.row?.reuse_applied, true, JSON.stringify(reused.row));
    assert.equal(reused.row?.reused, 1);
    assert.deepEqual(reused.row?.proofs, [], "a counted proof is not a host measurement, so it joins no agreement");
    assert.equal(reused.row?.agreed, 0);
    assert.equal(reused.row?.disagreed, 0);

    const noHistory = await review(t, head, routes, []);
    assert.notEqual(noHistory.result.criteria[0]?.proof_exec, "executed_pass", "no recorded agreement: the host ran it and it failed here");
    assert.equal(noHistory.row?.reuse_applied, false);
    assert.equal(noHistory.row?.audited, 1);
    assert.equal((noHistory.row?.proofs as Array<{ agree: boolean }>)[0]?.agree, false, "the audit recorded CI and the host disagreeing");
    assert.equal(noHistory.row?.disagreed, 1);

    const afterDisagreement = await review(t, head, routes, [CLEAN_RECORD, { ...CLEAN_RECORD, ts: "2026-11-24T11:00:00.000Z", agreed: 3, disagreed: 1 }]);
    assert.notEqual(afterDisagreement.result.criteria[0]?.proof_exec, "executed_pass", "after a disagreement every proof is audited again");
    assert.equal(afterDisagreement.row?.audit_share, 1);

    const failedHosted = await review(t, head, recordRoutes(head.headSha, recordLine(head.repo.dir, head.headSha,
      [{ proof: PROOF, status: 1, stdout: "verdict:    fail\n" }])), [CLEAN_RECORD]);
    assert.notEqual(failedHosted.result.criteria[0]?.proof_exec, "executed_pass", "a hosted FAIL is executed on the host");
    assert.equal(failedHosted.row?.reuse_applied, false);

    const executorDiff = await review(t, head, routes, [CLEAN_RECORD],
      `${DIFF}diff --git a/src/lib/exec.ts b/src/lib/exec.ts\n--- a/src/lib/exec.ts\n+++ b/src/lib/exec.ts\n@@ -1 +1 @@\n-x\n+y\n`);
    assert.notEqual(executorDiff.result.criteria[0]?.proof_exec, "executed_pass", "an executor-touching diff is executed on the host");
    assert.match(String(executorDiff.row?.reason), /^diff touches the executor/);

    const noRecord = await review(t, head, [], [CLEAN_RECORD]);
    assert.notEqual(noRecord.result.criteria[0]?.proof_exec, "executed_pass", "a missing record is executed on the host");
  });
});
