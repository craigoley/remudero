// W1-T14745: a review counts a proof's hosted PASS from CI's proof-discrimination record at the exact head instead of
// executing it, while an audit derived from the recorded agreement still executes some of those proofs and returns to
// every proof after any disagreement. A fixture head built "without the text" lacks what its proof greps for, so a host
// execution FAILS the proof and a counted hosted pass is the only way its criterion reads executed_pass.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  PROOF_REUSE_SHADOW_STEP, planProofReuse, recordProofReuseOutcome, runReview, type ProofDiscriminationRecordRead, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import {
  PROOF_REUSE_DISAGREEMENT_STEP, hostedPassIsReusable, proofReuseAudited, proofReuseAuditPath, proofReuseAuditShare, proofReuseKey,
  readProofReuseAudit, recordProofReuseAudit, settleProofReuseAudit,
} from "#src/lib/proof-reuse-audit.js";
import { judgeReviewAsync, setProofSandboxForTests } from "#src/lib/review.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as gate from "#scripts/proof-discrimination-gate.mjs";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const OWNER = "acme";
const REPO = "remudero";
const REPOSITORY = `${OWNER}/${REPO}`;
const PR_URL = `https://github.com/${REPOSITORY}/pull/14745`;
const PROOF = "grep: audited marker in src/x.ts";
const OTHER = "grep: second marker in src/y.ts";
const CRITERIA = [{ claim: "the marker ships", proof: PROOF }];
const BOTH = [...CRITERIA, { claim: "the second marker ships", proof: OTHER }];
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n";
const EXECUTOR_DIFF = `${DIFF}diff --git a/src/lib/exec.ts b/src/lib/exec.ts\n--- a/src/lib/exec.ts\n+++ b/src/lib/exec.ts\n@@ -1 +1 @@\n-x\n+y\n`;

interface Judged { proof: string; status: number; stdout: string }
const passed = (proof: string): Judged => ({ proof, status: 0, stdout: "verdict:    pass\nbase ref:   fork\nbase:       no-match\n" });
const failed = (proof: string): Judged => ({ proof, status: 1, stdout: "verdict:    fail\n" });
const bodyFor = (criteria: typeof CRITERIA) =>
  `## Acceptance\n${criteria.map(c => `- claim: ${c.claim}\n  proof: ${c.proof}\n`).join("")}\nRemudero-Task: W1-T14745\n`;

/** A head checkout holding a small executor. `src/x.ts` holds PROOF's text only when `marked`; `selects` picks, by
 *  empty commits, a head sha the caller's audit condition holds for. */
function headCheckout(t: TestContext, over: { marked?: boolean; selects?: (headSha: string) => boolean } = {}) {
  const repo = gitRepo({ scope: t, kind: "t14745-head" });
  const files: Record<string, string> = {
    "scripts/proof-discrimination-gate.mjs": "import { run } from \"../src/lib/exec.ts\";\nexport const gate = run;\n",
    "src/lib/exec.ts": "export const run = 1;\n",
    "src/check-proof-main.ts": "export const main = 1;\n",
    "src/x.ts": over.marked ? "export const x = \"audited marker\";\n" : "export const x = 1;\n",
    "src/y.ts": "export const y = \"second marker\";\n",
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
  for (let n = 0; over.selects && !over.selects(headSha) && n < 200; n++) {
    repo.git("commit", "--allow-empty", "-qm", `candidate head ${n}`);
    headSha = repo.git("rev-parse", "HEAD");
  }
  assert.ok(!over.selects || over.selects(headSha), "fixture: a head satisfying the audit condition");
  return { repo, headSha };
}
type Head = ReturnType<typeof headCheckout>;

const outsideShare = (agreed: number) => (headSha: string) => !proofReuseAudited(headSha, PROOF, proofReuseAuditShare(agreed));
const insideShare = (agreed: number) => (headSha: string) => proofReuseAudited(headSha, PROOF, proofReuseAuditShare(agreed));

/** One ledger directory, so each scenario owns its audit journal. */
function state(head: Head, name: string) {
  const dir = join(head.repo.dir, ".git", "t14745", name);
  mkdirSync(dir, { recursive: true });
  const journal = proofReuseAuditPath(dir, { owner: OWNER, repo: REPO });
  const read = () => {
    const audit = readProofReuseAudit(journal, REPOSITORY, () => []);
    assert.ok(audit.kind === "read", JSON.stringify(audit));
    return audit;
  };
  return { ledgerPath: join(dir, "ledger.ndjson"), journal, read };
}

/** `count` distinct recorded agreements, as earlier audited reviews would have journalled them. */
function seed(journal: string, count: number, from = 0): void {
  assert.equal(recordProofReuseAudit(journal, { head_sha: "seed", agreed: Array.from({ length: count }, (_, i) => `seed-${from + i}`),
    disagreed: 0, held: [], host_ms: 400, host_runs: 4 }), undefined);
}

function recordLine(head: Head, judged: Judged[], criteria = CRITERIA, overrides: Record<string, unknown> = {}): string {
  const record = gate.proofDiscriminationRecord({ headSha: head.headSha, baseSha: "fork", body: bodyFor(criteria),
    criteriaSource: "PR body Acceptance block", executor: gate.executorDigestsAt(head.repo.dir), judged });
  return gate.resultLine({ ...record, ...overrides });
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

/** One review of the fixture head through the real {@link runReview}, with gh answering `routes`. */
async function review(t: TestContext, head: Head, ledgerPath: string, routes: Array<{ when: string; stdout?: string }>,
  over: { criteria?: typeof CRITERIA; diff?: string; reviewer?: (cwd: string) => void; ledger?: Array<Record<string, unknown>> } = {}) {
  setProofSandboxForTests({ mode: "unsandboxed", reason: "disposable proof fixture" });
  t.after(() => setProofSandboxForTests());
  const criteria = over.criteria ?? CRITERIA;
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
  writeFileSync(ledgerPath, (over.ledger ?? []).map(row => `${JSON.stringify(row)}\n`).join(""));
  const rows: Array<Record<string, unknown>> = [];
  const reviewer = over.reviewer;
  return withGhShim([...routes, { when: "pr diff", stdout: over.diff ?? DIFF }, { when: "api", stdout: "{}" }], async () => {
    const result = await runReview(host, { owner: OWNER, repo: REPO, prUrl: PR_URL,
      task: { id: "W1-T14745", acceptance: criteria, files: ["src/x.ts"] },
      report: bodyFor(criteria), settingsFile: join(head.repo.dir, "settings.json"), config: { root: head.repo.dir } as never,
      headCheckoutDir: head.repo.dir, ledgerPath, runId: "t14745",
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (r: WorkerResult) => r,
      shadow: true, spawnReviewer: reviewer !== undefined, readReviewReuseFacts: () => undefined, runtimeImageSha: null,
      ...(reviewer === undefined ? {} : {
        calibrationCase: true,
        reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 4, provider: "claude" } as never,
        reviewerSpawnWorker: (async (args: { cwd: string }) => {
          reviewer(args.cwd);
          return { sessionId: "t14745-reviewer", text: "REVIEW_VERDICT 1: PASS", blocks: [], stderr: "",
            exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [], model: "sonnet",
            effort: "medium", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
            compactionEvents: [], qualitySuspect: false, subtype: "success", isError: false, apiError: false } as WorkerResult;
        }) as never,
      }),
    });
    return { result, row: rows.find(row => row.step === PROOF_REUSE_SHADOW_STEP)!,
      disagreements: rows.filter(row => row.step === PROOF_REUSE_DISAGREEMENT_STEP) };
  });
}

describe("test/review/a-review-reuses-ci-proof-passes-under-an-audit.test.ts", () => {
  test("W1-T14745 criterion 1: an unselected hosted pass is the verdict, marked with its hosted run and job, and the host executor is not called for it", async t => {
    const head = headCheckout(t, { selects: outsideShare(998) });
    const executed: string[] = [];
    const judged = await judgeReviewAsync(BOTH, { diff: DIFF, report: bodyFor(BOTH), headCheckoutDir: head.repo.dir,
      hostedProofPasses: new Map([[PROOF, { hosted_run_id: 77, hosted_job_id: 88 }]]),
      asyncExecProof: async proof => { executed.push(proof.args.join(" ")); return "pass"; } });
    assert.equal(executed.length, 1, `only the uncounted proof runs: ${executed.join(" | ")}`);
    assert.match(executed[0]!, /second marker/);
    assert.equal(judged.criteria[0]?.proof_exec, "executed_pass");
    assert.equal(judged.criteria[0]?.met, true);
    assert.deepEqual(judged.criteria[0]?.hosted_reuse, { hosted_run_id: 77, hosted_job_id: 88 });
    assert.match(judged.criteria[0]!.reason, /counted from proof-discrimination run 77 job 88/);
    assert.equal(judged.criteria[1]?.hosted_reuse, undefined, "a proof the host ran carries no marker");

    const s = state(head, "reused");
    seed(s.journal, 998);
    const reviewed = await review(t, head, s.ledgerPath, recordRoutes(head.headSha, recordLine(head, [passed(PROOF)])));
    assert.equal(reviewed.result.criteria[0]?.proof_exec, "executed_pass", "this head lacks the text: a host run would fail it");
    assert.deepEqual(reviewed.result.criteria[0]?.hosted_reuse, { hosted_run_id: 77, hosted_job_id: 88 });
    assert.match(reviewed.result.criteria[0]!.reason, /counted from proof-discrimination run 77 job 88/);
  });

  test("W1-T14745 criterion 1: the reviewer's proof evidence names a counted proof's hosted run and job", async t => {
    const head = headCheckout(t, { selects: outsideShare(998) });
    const s = state(head, "reviewer");
    seed(s.journal, 998);
    let evidence: { executions: unknown[]; criteria: Array<{ hosted_reuse?: unknown }> } | undefined;
    const reviewed = await review(t, head, s.ledgerPath, recordRoutes(head.headSha, recordLine(head, [passed(PROOF)])), {
      reviewer: cwd => { evidence = JSON.parse(readFileSync(join(cwd, ".git", "rmd-review-proofs.json"), "utf8")); },
    });
    assert.ok(evidence, `the reviewer ran: ${reviewed.result.reviewerOutcome}`);
    assert.deepEqual(evidence.executions, [], "no host execution, before or after the reviewer");
    assert.deepEqual(evidence.criteria[0]?.hosted_reuse, { hosted_run_id: 77, hosted_job_id: 88 });
    assert.equal(reviewed.result.criteria[0]?.proof_exec, "executed_pass");
  });

  test("W1-T14745 criterion 2: a hosted FAIL, stale or absent outcome, an ineligible record and every proof of an executor-touching diff run on the host as before", async t => {
    const head = headCheckout(t, { selects: outsideShare(998) });
    const scenario = async (name: string, routes: Array<{ when: string; stdout?: string }>, over: { criteria?: typeof CRITERIA; diff?: string } = {}) => {
      const s = state(head, name);
      seed(s.journal, 998);
      return review(t, head, s.ledgerPath, routes, over);
    };
    const asMain = (await scenario("baseline", [])).result.criteria[0]!;
    assert.equal(asMain.proof_exec, "executed_fail", "fixture: the host fails this proof");
    const good = (overrides: Record<string, unknown> = {}, judged = [passed(PROOF)]) =>
      recordRoutes(head.headSha, recordLine(head, judged, CRITERIA, overrides));
    const outcome = (verdict: string, base: string) => ({ proofs: [{ proof: PROOF, head: "pass", base, verdict }] });
    const cases: Array<[string, Array<{ when: string; stdout?: string }>]> = [
      ["hosted-fail", good({}, [failed(PROOF)])],
      ["hosted-stale", good(outcome("executed_stale", "pass"))],
      ["unmeasured-base", good(outcome("pass", "UNKNOWN"))],
      ["outcome-absent", good({ proofs: [] })],
      ["another-head", good({ head_sha: "f".repeat(40) })],
      ["executor-digest", good({ executor_digest: "0".repeat(64) })],
      ["workflow-digest", good({ workflow_digest: "0".repeat(64) })],
    ];
    for (const [name, routes] of cases) {
      const { result, row } = await scenario(name, routes);
      const got = result.criteria[0]!;
      assert.deepEqual([got.proof_exec, got.met, got.reason, got.hosted_reuse], [asMain.proof_exec, asMain.met, asMain.reason, undefined], name);
      assert.deepEqual(row.reused, [], name);
    }
    const routes = recordRoutes(head.headSha, recordLine(head, [passed(PROOF), passed(OTHER)], BOTH));
    const touching = await scenario("executor-diff", routes, { criteria: BOTH, diff: EXECUTOR_DIFF });
    assert.deepEqual(touching.result.criteria.map(c => [c.proof_exec, c.hosted_reuse]),
      [["executed_fail", undefined], ["executed_pass", undefined]], "every proof of an executor-touching diff runs on the host");
    assert.match(String(touching.row.reason), /^diff touches the executor/);
    assert.deepEqual(touching.row.reused, []);

    const mixed = await scenario("mixed", recordRoutes(head.headSha, recordLine(head, [failed(PROOF), passed(OTHER)], BOTH)), { criteria: BOTH });
    assert.equal(mixed.result.criteria[0]?.proof_exec, "executed_fail", "the hosted FAIL runs here beside a counted pass");
    assert.equal(mixed.result.criteria[0]?.hosted_reuse, undefined);
  });

  test("W1-T14745 criterion 3: the audit starts at every proof and falls as agreements accumulate, with no floor", async t => {
    assert.equal(proofReuseAuditShare(0), 1);
    assert.equal(proofReuseAuditShare(Number.NaN), 1);
    const shares = [0, 1, 2, 10, 100, 10_000].map(proofReuseAuditShare);
    assert.deepEqual([...shares].sort((a, b) => b - a), shares);
    assert.equal(new Set(shares).size, shares.length, "every further agreement lowers it");
    assert.ok(proofReuseAuditShare(1e9) > 0 && proofReuseAuditShare(1e9) < 1e-8, "no floor");
    assert.equal(proofReuseAudited("a".repeat(40), PROOF, 1), true);
    assert.equal(proofReuseAudited("a".repeat(40), PROOF, 0.5), proofReuseAudited("a".repeat(40), PROOF, 0.5), "deterministic");
    let selected = 0;
    for (let n = 0; n < 2000; n++) if (proofReuseAudited(n.toString(16).padStart(40, "0"), PROOF, 0.25)) selected++;
    assert.ok(selected > 400 && selected < 600, `about a quarter selected, got ${selected}/2000`);

    const head = headCheckout(t, { marked: true });
    const s = state(head, "accumulate");
    const routes = recordRoutes(head.headSha, recordLine(head, [passed(PROOF)]));
    const first = await review(t, head, s.ledgerPath, routes);
    assert.equal(first.row.audit_share, 1, "no history audits every proof");
    assert.deepEqual([first.row.reused, first.row.audited], [[], [PROOF]]);
    assert.equal(first.result.criteria[0]?.hosted_reuse, undefined);
    assert.deepEqual(first.disagreements, []);
    assert.equal(s.read().agreed, 1);
    seed(s.journal, 1);
    assert.equal(s.read().agreed, 2, "agreements accumulate");
    await review(t, head, s.ledgerPath, routes);
    assert.ok(s.read().agreed <= 3, "one head and proof counts once however often it is reviewed");
  });

  test("W1-T14745 criterion 3: an audited disagreement takes the host outcome, writes its row once and returns the audit to every proof", async t => {
    const head = headCheckout(t, { selects: insideShare(2) });
    for (const [name, reviewer] of [["binding", undefined], ["with-reviewer", () => {}]] as const) {
      const s = state(head, name);
      seed(s.journal, 2);
      const routes = recordRoutes(head.headSha, recordLine(head, [passed(PROOF)]));
      const got = await review(t, head, s.ledgerPath, routes, { reviewer });
      assert.equal(got.result.criteria[0]?.proof_exec, "executed_fail", `${name}: the host outcome is the verdict`);
      assert.equal(got.result.criteria[0]?.met, false);
      assert.deepEqual(got.disagreements, [{ step: PROOF_REUSE_DISAGREEMENT_STEP, pr_url: PR_URL, repo: REPOSITORY,
        head_sha: head.headSha, proof: PROOF, hosted: "pass", host: "executed_fail" }], name);
      assert.equal(got.row.audit_share, 0.5);
      assert.equal(got.row.disagreed, 1);
      assert.equal(readFileSync(s.journal, "utf8").trim().split("\n").length, 2, `${name}: one measurement per review`);
      assert.equal(s.read().agreed, 0, "the counts are reset");
      assert.equal(proofReuseAuditShare(s.read().agreed), 1);
      const other = headCheckout(t, { selects: outsideShare(2) });
      const next = await review(t, other, s.ledgerPath, recordRoutes(other.headSha, recordLine(other, [passed(PROOF)])));
      assert.equal(next.row.audit_share, 1, "another head, unselected before, is audited now");
      assert.deepEqual(next.row.audited, [PROOF]);
    }
  });

  test("W1-T14745 criterion 4: reuse never passes what the host would fail: only a hosted pass counts and a proof the host did not pass stays there", async t => {
    for (const base of ["fail", "no-match", "ABSENT"]) assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base }), true, base);
    for (const base of ["pass", "UNKNOWN", "UNREADABLE", "COULD", "not reported", undefined]) {
      assert.equal(hostedPassIsReusable({ verdict: "pass", head: "pass", base }), false, String(base));
    }
    for (const verdict of ["fail", "executed_stale", "refused", "no-match", "exec_error", "unreadable"]) {
      assert.equal(hostedPassIsReusable({ verdict, head: "pass", base: "fail" }), false, verdict);
    }
    assert.equal(hostedPassIsReusable({ verdict: "pass", head: "fail", base: "fail" }), false);

    const head = headCheckout(t, { selects: sha => insideShare(2)(sha) && outsideShare(1000)(sha) });
    const routes = recordRoutes(head.headSha, recordLine(head, [passed(PROOF)]));
    for (const [name, firstRoutes] of [["after-disagreement", routes], ["after-ineligible-failure", []]] as const) {
      const s = state(head, name);
      seed(s.journal, 2);
      const first = await review(t, head, s.ledgerPath, [...firstRoutes]);
      assert.equal(first.result.criteria[0]?.proof_exec, "executed_fail", name);
      seed(s.journal, 1000, 100);
      assert.equal(outsideShare(s.read().agreed)(head.headSha), true, "fixture: the share alone would now reuse it");
      const again = await review(t, head, s.ledgerPath, routes);
      assert.equal(again.result.criteria[0]?.proof_exec, "executed_fail", `${name}: never turned into a pass`);
      assert.deepEqual([again.row.reused, again.row.audited], [[], [PROOF]], name);
      assert.equal(typeof again.row.would_save_ms, "number", "nothing reused: still a would-be saving");
      assert.equal(again.row.saved_ms, undefined);
    }
    const s = state(head, "ledgered");
    seed(s.journal, 1000);
    const row = { ts: "2026-11-24T10:00:00.000Z", step: PROOF_REUSE_DISAGREEMENT_STEP, repo: REPOSITORY, head_sha: head.headSha, proof: PROOF };
    const ledgered = await review(t, head, s.ledgerPath, routes, { ledger: [row] });
    assert.deepEqual(ledgered.row.audited, [PROOF], "the ledger's disagreement row holds the proof with no journal line for it");
    assert.equal(ledgered.result.criteria[0]?.proof_exec, "executed_fail");
  });

  test("W1-T14745 criterion 4: the shadow row keeps being written, naming the reused and audited proofs and the time reuse saved", async t => {
    const head = headCheckout(t, { selects: sha => outsideShare(998)(sha) && !proofReuseAudited(sha, OTHER, proofReuseAuditShare(998)) });
    const s = state(head, "row");
    seed(s.journal, 998);
    s.read();
    assert.equal(recordProofReuseAudit(s.journal, { head_sha: "seed", agreed: [], disagreed: 0,
      held: [proofReuseKey(head.headSha, OTHER)], host_ms: 0, host_runs: 0 }), undefined);
    const { row } = await review(t, head, s.ledgerPath,
      recordRoutes(head.headSha, recordLine(head, [passed(PROOF), passed(OTHER)], BOTH)), { criteria: BOTH });
    assert.equal(row.eligible, true, String(row.reason));
    assert.deepEqual([row.reused, row.audited], [[PROOF], [OTHER]]);
    assert.equal(row.saved_ms, 100, "one reused proof at the recorded 400 ms over 4 runs");
    assert.equal("would_save_ms" in row, false);
    assert.deepEqual((row.proofs as Array<{ proof: string }>).map(p => p.proof), [OTHER], "a reused proof is no host measurement");
    assert.equal(row.agreed, 1);
  });

  test("an unreadable audit state, a torn line or a lost disagreement widens the audit", async t => {
    const head = headCheckout(t);
    const s = state(head, "arms");
    assert.equal(s.read().agreed, 0, "a missing journal is no history");
    seed(s.journal, 5);
    writeFileSync(s.journal, "{torn\n", { flag: "a" });
    assert.equal(s.read().agreed, 0, "a torn line may have been a disagreement");
    seed(s.journal, 3, 10);
    writeFileSync(s.journal, "{\"agreed\":1}\n", { flag: "a" });
    assert.equal(s.read().agreed, 0, "so may a line that is not an entry");
    const eio = readProofReuseAudit(s.journal, REPOSITORY, () => [], () => { throw Object.assign(new Error("EIO: read"), { code: "EIO" }); });
    assert.deepEqual(eio, { kind: "unreadable", reason: "EIO: read" });
    const noRows = readProofReuseAudit(s.journal, REPOSITORY, () => { throw new Error("ledger unreadable"); });
    assert.deepEqual(noRows, { kind: "unreadable", reason: "ledger unreadable" });
    const row = { step: PROOF_REUSE_DISAGREEMENT_STEP, repo: REPOSITORY, head_sha: head.headSha, proof: PROOF };
    const ledgered = readProofReuseAudit(s.journal, REPOSITORY, () => [row]);
    assert.ok(ledgered.kind === "read" && ledgered.held.has(proofReuseKey(head.headSha, PROOF)), "a ledgered disagreement holds its proof");

    const unwritable = join(s.journal, "below-a-file.jsonl");
    const logged: Array<Record<string, unknown>> = [];
    const outcome = recordProofReuseOutcome({ auditPath: unwritable, repo: REPOSITORY, prUrl: PR_URL, headSha: head.headSha,
      audited: new Set([PROOF]), hostMs: 1, criteria: [{ proof: PROOF, proof_exec: "executed_fail" }],
      log: (step, extra) => logged.push({ step, ...extra }) });
    assert.match(String(outcome.audit_error), /ENOTDIR|EEXIST/);
    assert.equal(logged[0]?.audit_error, outcome.audit_error, "the row says the reset was not journalled");
    const lost = readProofReuseAudit(s.journal, REPOSITORY, () => logged);
    assert.equal(lost.kind, "unreadable", "so every later review runs every proof");

    const input = { prUrl: PR_URL, headSha: head.headSha, diff: DIFF, body: bodyFor(CRITERIA), criteria: CRITERIA, headCheckoutDir: head.repo.dir };
    const record: ProofDiscriminationRecordRead = { kind: "record", runId: 77, jobId: 88,
      record: JSON.parse(recordLine(head, [passed(PROOF)]).slice(gate.RESULT_MARKER.length)) };
    const blind = await planProofReuse(record, { ...input, audit: lost });
    assert.deepEqual([[...blind.passes], [...blind.audited]], [[], [PROOF]]);
    assert.match(String(blind.row.audit_unreadable), /never journalled/);
    const untimed = await planProofReuse(record, { ...input, headSha: head.headSha,
      audit: { kind: "read", agreed: 1e12, held: new Set(), hostMs: 0, hostRuns: 0 } });
    assert.equal(untimed.passes.size, 1);
    assert.equal(untimed.row.saved_ms, null, "no timing on record is not a zero saving");
    const broken = await planProofReuse(record, { ...input, criteria: undefined as never, audit: lost });
    assert.equal(broken.passes.size, 0);
    assert.match(String(broken.row.reuse_error), /^reuse planning failed: /);
  });

  test("only an answer other than pass disputes CI; a run that reached none is held without a disagreement", () => {
    const settle = (proof_exec: string, floorMet = true, audited = true) => settleProofReuseAudit({ headSha: "h", hostMs: 5,
      audited: new Set(audited ? [PROOF] : []), criteria: [{ proof: PROOF, proof_exec, floorMet }, { proof: PROOF, proof_exec, floorMet }] });
    for (const exec of ["executed_fail", "executed_stale", "stale_self_path", "cannot_evaluate"]) {
      assert.equal(settle(exec).entry?.disagreed, 1, exec);
    }
    assert.equal(settle("exec_error", false).entry?.disagreed, 1, "the review failed the criterion on it");
    for (const exec of ["exec_error", "inconclusive_load", "base_unreadable", "not_executable"]) {
      const got = settle(exec);
      assert.deepEqual([got.disagreements, got.entry?.held], [[], [proofReuseKey("h", PROOF)]], exec);
    }
    assert.equal(settle("executed_fail", false, false).entry?.disagreed, 0, "an unaudited proof disputes nothing");
    assert.equal(settle("executed_pass", true, false).entry, undefined, "nothing measured, nothing journalled");
    assert.equal(settle("not_executable", true, false).entry, undefined);
  });
});
