// W1-T11157: the proof-discrimination job publishes what it judged for a head, and a review reads that record in
// SHADOW — it still runs every proof, and only ledgers whether each hosted outcome agrees with its own. Operator trust
// decision 2026-11-03: the record counts only as a successful GitHub Actions job of that workflow at that exact head,
// the executor is the gate's whole import closure plus its toolchain inputs and workflow, and no verdict reads it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  PROOF_REUSE_SHADOW_STEP, diffTouchedPaths, proofReuseShadowRow, readProofDiscriminationRecord, runReview,
  type ProofDiscriminationRecordRead, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import { buildAffectedSuitesGraph } from "#src/lib/affected-suites.js";
import { setProofSandboxForTests } from "#src/lib/review.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as gate from "#scripts/proof-discrimination-gate.mjs";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const OWNER = "acme";
const REPO = "remudero";
const PROOF = "grep: shadow marker in src/x.ts";
const CRITERIA = [{ claim: "the marker ships", proof: PROOF }];
const BODY = "## Acceptance\n- claim: the marker ships\n  proof: grep: shadow marker in src/x.ts\n\nRemudero-Task: W1-T11157\n";
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-export const x = 0;\n+export const x = \"shadow marker\";\n";
const PASSED = "proof:      grep: shadow marker in src/x.ts\nhits:       1\nverdict:    pass\nbase ref:   fork\nbase hits:  0\nbase:       no-match\n";
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** A head checkout holding a small executor: the gate script, what it imports, the toolchain inputs and the workflow. */
function headCheckout(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "t11157-head" });
  const files: Record<string, string> = {
    "scripts/proof-discrimination-gate.mjs": "import { run } from \"../src/lib/exec.ts\";\nexport const gate = run;\n",
    "src/lib/exec.ts": "import { helper } from \"#src/lib/helper.ts\";\nexport const run = helper;\n",
    "src/lib/helper.ts": "export const helper = 1;\n",
    "src/check-proof-main.ts": "export const main = 1;\n",
    "src/x.ts": "export const x = \"shadow marker\";\n",
    "src/unrelated.ts": "export const unrelated = 1;\n",
    "test/setup/tmp-hygiene.ts": "export {};\n",
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
  return { repo, headSha: repo.git("rev-parse", "HEAD") };
}

/** The record the gate itself would publish for `headSha` at `root`, with `overrides` applied. */
function recordLine(root: string, headSha: string, judged = [{ proof: PROOF, status: 0, stdout: PASSED }],
  overrides: Record<string, unknown> = {}): string {
  const record = gate.proofDiscriminationRecord({ headSha, baseSha: "fork", body: BODY, criteriaSource: "PR body Acceptance block",
    executor: gate.executorDigestsAt(root), judged });
  return gate.resultLine({ ...record, ...overrides });
}

/** The gh routes a published record is read through: the workflow's runs at the head, the run's jobs, the job's log. */
function recordRoutes(headSha: string, log: string, over: { run?: Record<string, unknown>; job?: Record<string, unknown> } = {}) {
  const run = { id: 77, head_sha: headSha, path: gate.PROOF_DISCRIMINATION_WORKFLOW, conclusion: "success", event: "pull_request", ...over.run };
  const job = { id: 88, run_id: 77, name: gate.PROOF_DISCRIMINATION_JOB, head_sha: headSha, conclusion: "success", ...over.job };
  return [
    { when: "actions/workflows/proof-discrimination-gate.yml/runs", stdout: JSON.stringify({ workflow_runs: [run] }) },
    { when: "actions/runs/77/jobs", stdout: JSON.stringify({ jobs: [job] }) },
    { when: "actions/jobs/88/logs", stdout: `2026-11-24T10:00:00.0000000Z npm ci\n2026-11-24T10:00:01.0000000Z ${log}\n` },
  ];
}

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }

/** One review of the fixture head, with gh answered by `routes`; returns the verdict and the shadow rows. */
async function review(t: TestContext, head: ReturnType<typeof headCheckout>, routes: Array<{ when: string; stdout?: string; exit?: number; stderr?: string }>,
  diff = DIFF) {
  setProofSandboxForTests({ mode: "unsandboxed", reason: "disposable proof fixture" });
  t.after(() => setProofSandboxForTests());
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
  const prUrl = `https://github.com/${OWNER}/${REPO}/pull/11157`;
  return withGhShim([...routes, { when: "pr diff", stdout: diff }, { when: "api", stdout: "{}" }], async shim => {
    const result = await runReview(host, { owner: OWNER, repo: REPO, prUrl,
      task: { id: "W1-T11157", acceptance: CRITERIA, files: ["src/x.ts"] },
      report: BODY, settingsFile: join(head.repo.dir, "settings.json"), config: { root: head.repo.dir } as never,
      headCheckoutDir: head.repo.dir, ledgerPath: join(head.repo.dir, ".git/ledger.ndjson"), runId: "t11157",
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (r: WorkerResult) => r,
      shadow: true, spawnReviewer: false, readReviewReuseFacts: () => undefined, runtimeImageSha: null,
    });
    return { result, shadow: rows.filter(row => row.step === PROOF_REUSE_SHADOW_STEP), calls: shim.calls() };
  });
}

/** The verdict with the per-run timing every review differs by removed, so two runs compare byte for byte. */
const verdictBytes = (result: unknown) => JSON.stringify(result, (key, value) => key === "durationMs" ? undefined : value);

describe("test/review/a-review-reuses-cis-proof-discrimination-result.test.ts", () => {
  test("the gate publishes one record line per head, before its verdict, naming each proof's head and base outcome", t => {
    const { repo, headSha } = headCheckout(t);
    const out: string[] = [];
    const written: Array<[string, string]> = [];
    const code = gate.main(["--event-path", "event.json", "--result-path", "result.json"], {
      root: repo.dir,
      readPayload: () => ({ readable: true, body: BODY, baseSha: "base-tip", headSha }),
      mergeBase: () => ({ ok: true, mergeBase: "fork" }),
      resolveCriteria: () => ({ criteria: [...CRITERIA, { claim: "credited", proof: "grep: x in src/x.ts", satisfied_by: "#1" },
        { claim: "stale", proof: "unit test: test/plan.test.ts" }], source: "PR body Acceptance block" }),
      runProof: (proof: string) => proof === PROOF ? { status: 0, stdout: PASSED }
        : { status: 5, stdout: "hits:       9\nverdict:    pass\nbase:       pass\n" },
      baseline: () => ({ "W1-T11157": 1 }),
      log: { log: (m: string) => out.push(m), error: (m: string) => out.push(m) },
      writeResult: (path: string, text: string) => written.push([path, text]),
    });
    assert.equal(code, 0, out.join("\n"));
    const lines = out.filter(line => line.startsWith(gate.RESULT_MARKER));
    assert.equal(lines.length, 1, "exactly one record line");
    assert.ok(out.indexOf(lines[0]!) < out.findIndex(line => /^proof-discrimination: OK/.test(line)), "the record precedes the verdict line");
    const record = JSON.parse(lines[0]!.slice(gate.RESULT_MARKER.length));
    assert.equal(record.format, gate.RESULT_FORMAT);
    assert.equal(record.head_sha, headSha);
    assert.equal(record.base_sha, "fork");
    assert.equal(record.body_digest, sha256(BODY));
    assert.equal(record.criteria_source, "PR body Acceptance block");
    assert.equal(record.workflow_digest, sha256(readFileSync(join(repo.dir, gate.PROOF_DISCRIMINATION_WORKFLOW))));
    assert.match(record.executor_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.proofs, [
      { proof: PROOF, head: "pass", base: "no-match", verdict: "pass" },
      { proof: "unit test: test/plan.test.ts", head: "pass", base: "pass", verdict: "executed_stale" },
    ], "every executed proof, never the credited one");
    assert.deepEqual(written.map(([path, text]) => [path, JSON.parse(text)]), [["result.json", record]]);
  });

  test("the executor digest covers the gate's import closure, the toolchain inputs, test/setup and the workflow — nothing else", t => {
    const { repo } = headCheckout(t);
    const before = gate.executorDigestsAt(repo.dir);
    assert.deepEqual(before.files, [".github/workflows/proof-discrimination-gate.yml", ".nvmrc", "package-lock.json", "package.json",
      "scripts/proof-discrimination-gate.mjs", "src/check-proof-main.ts", "src/lib/exec.ts", "src/lib/helper.ts", "test/setup/tmp-hygiene.ts"]);
    writeFileSync(join(repo.dir, "src/unrelated.ts"), "export const unrelated = 2;\n");
    assert.equal(gate.executorDigestsAt(repo.dir).executor_digest, before.executor_digest, "a file outside the executor moves nothing");
    for (const path of ["src/lib/helper.ts", "package-lock.json", "test/setup/tmp-hygiene.ts", ".nvmrc"]) {
      const original = readFileSync(join(repo.dir, path), "utf8");
      writeFileSync(join(repo.dir, path), `${original}// changed\n`);
      assert.notEqual(gate.executorDigestsAt(repo.dir).executor_digest, before.executor_digest, `${path} is in the executor`);
      writeFileSync(join(repo.dir, path), original);
    }
    writeFileSync(join(repo.dir, gate.PROOF_DISCRIMINATION_WORKFLOW), "name: changed\n");
    assert.notEqual(gate.executorDigestsAt(repo.dir).workflow_digest, before.workflow_digest);
  });

  test("the layered executor walk equals the whole-tree affected-suite graph's closure of the gate and its check-proof child", t => {
    const { repo } = headCheckout(t);
    const tracked = repo.git("ls-files", "-z").split("\0").filter(Boolean);
    const code = tracked.filter(path => /^(?:src|scripts|bin|test)\/.+\.(?:ts|mts|mjs|js|cjs)$/.test(path));
    const graph = buildAffectedSuitesGraph(new Map(code.map(path => [path, readFileSync(join(repo.dir, path), "utf8")])), [], { root: repo.dir });
    const closure = new Set<string>();
    const queue = ["scripts/proof-discrimination-gate.mjs", "src/check-proof-main.ts"];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (closure.has(path)) continue;
      closure.add(path);
      for (const dep of graph.dependencies.get(path) ?? []) queue.push(dep);
    }
    assert.ok(closure.has("src/lib/helper.ts"), "the walk follows a package-imports alias, as the selector does");
    const set: string[] = gate.proofDiscriminationExecutorSet(tracked, (path: string) => readFileSync(join(repo.dir, path), "utf8"));
    assert.deepEqual(set.filter(path => /^(?:src|scripts|bin)\//.test(path)), [...closure].sort());
  });

  test("an unreadable executor is named in the record and never changes the gate's exit code", () => {
    const out: string[] = [];
    const code = gate.main(["--event-path", "event.json"], {
      readPayload: () => ({ readable: true, body: BODY, baseSha: "base-tip", headSha: "h" }),
      mergeBase: () => ({ ok: true, mergeBase: "fork" }),
      resolveCriteria: () => ({ criteria: CRITERIA, source: "PR body Acceptance block" }),
      runProof: () => ({ status: 0, stdout: PASSED }),
      baseline: () => ({}),
      executorDigests: () => { throw new Error("git ls-files failed: not a git repository"); },
      log: { log: (m: string) => out.push(m), error: (m: string) => out.push(m) },
    });
    assert.equal(code, 0, out.join("\n"));
    const record = JSON.parse(out.find(line => line.startsWith(gate.RESULT_MARKER))!.slice(gate.RESULT_MARKER.length));
    assert.equal(record.executor_error, "git ls-files failed: not a git repository");
    assert.equal(record.executor_digest, null, "a review can never match a record whose executor was unreadable");
  });

  test("a record over the cap publishes only that it was too large", t => {
    const { repo, headSha } = headCheckout(t);
    const judged = Array.from({ length: 900 }, (_, i) => ({ proof: `grep: ${"m".repeat(60)}${i} in src/x.ts`, status: 0, stdout: PASSED }));
    const line = recordLine(repo.dir, headSha, judged);
    assert.ok(Buffer.byteLength(line) < 1024);
    assert.deepEqual(JSON.parse(line.slice(gate.RESULT_MARKER.length)),
      { format: gate.RESULT_FORMAT, head_sha: headSha, too_large: true, bytes: JSON.parse(line.slice(gate.RESULT_MARKER.length)).bytes });
    assert.ok(JSON.parse(line.slice(gate.RESULT_MARKER.length)).bytes > gate.RESULT_MAX_BYTES);
  });

  test("W1-T11157 criterion 2: an eligible record is compared proof by proof while the host still runs every proof, and the verdict never reads it", async t => {
    const head = headCheckout(t);
    const missing = await review(t, head, []);
    assert.deepEqual(missing.shadow.map(row => row.eligible), [false], "fixture assumption: no record at all");
    const agreeing = await review(t, head, recordRoutes(head.headSha, recordLine(head.repo.dir, head.headSha)));
    assert.equal(agreeing.shadow.length, 1, JSON.stringify(agreeing.shadow));
    const row = agreeing.shadow[0]!;
    assert.equal(row.eligible, true, String(row.reason));
    assert.equal(row.head_sha, head.headSha);
    assert.equal(row.hosted_run_id, 77);
    assert.equal(row.hosted_job_id, 88);
    assert.deepEqual(row.proofs, [{ proof: PROOF, hosted: "pass", hosted_head: "pass", hosted_base: "no-match", host: "executed_pass", agree: true }]);
    assert.equal(row.agreed, 1);
    assert.equal(row.disagreed, 0);
    assert.equal(typeof row.host_proof_ms, "number");
    assert.equal(row.would_save_ms, row.host_proof_ms, "an eligible reuse would have skipped the host proof time");
    assert.equal(agreeing.result.criteria[0]?.proof_exec, "executed_pass", "the host still executed the proof");
    for (const path of ["actions/workflows/proof-discrimination-gate.yml/runs?head_sha=", "actions/runs/77/jobs", "actions/jobs/88/logs"]) {
      assert.ok(agreeing.calls.some(call => call.includes(path)), `the record is read through ${path}`);
    }
    const disagreeing = await review(t, head, recordRoutes(head.headSha,
      recordLine(head.repo.dir, head.headSha, [{ proof: PROOF, status: 1, stdout: "verdict:    fail\n" }])));
    assert.deepEqual(disagreeing.shadow[0]?.proofs, [{ proof: PROOF, hosted: "fail", hosted_head: "fail", hosted_base: "not reported",
      host: "executed_pass", agree: false }]);
    assert.equal(disagreeing.shadow[0]?.disagreed, 1);
    assert.equal(verdictBytes(agreeing.result), verdictBytes(missing.result), "an agreeing record changes no verdict byte");
    assert.equal(verdictBytes(disagreeing.result), verdictBytes(missing.result), "a disagreeing hosted FAIL changes no verdict byte");
    assert.equal(missing.result.state, agreeing.result.state);
  });

  test("W1-T11157 criterion 3: a missing, unauthenticated or mismatched record, or a diff touching the executor, is ledgered as not eligible and changes nothing else", async t => {
    const head = headCheckout(t);
    const baseline = await review(t, head, []);
    const good = recordLine(head.repo.dir, head.headSha);
    const cases: Array<{ label: string; routes: Array<{ when: string; stdout?: string; exit?: number; stderr?: string }>; diff?: string; reason: RegExp }> = [
      { label: "missing", routes: [], reason: /^no successful proof-discrimination run at this head$/ },
      { label: "read failure", routes: [{ when: "actions/workflows/", exit: 1, stderr: "HTTP 403: Resource not accessible" }], reason: /^record unreadable: / },
      { label: "another workflow's run", routes: recordRoutes(head.headSha, good, { run: { path: ".github/workflows/fake.yml" } }), reason: /^no successful proof-discrimination run/ },
      { label: "a failed job", routes: recordRoutes(head.headSha, good, { job: { conclusion: "failure" } }), reason: /^run 77 has no successful proof-discrimination job/ },
      { label: "a body digest from another body", routes: recordRoutes(head.headSha, recordLine(head.repo.dir, head.headSha, undefined, { body_digest: sha256("other") })), reason: /^body digest mismatch$/ },
      { label: "a diff touching the executor", routes: recordRoutes(head.headSha, good),
        diff: `${DIFF}diff --git a/src/lib/helper.ts b/src/lib/helper.ts\n--- a/src/lib/helper.ts\n+++ b/src/lib/helper.ts\n@@ -1 +1 @@\n-x\n+y\n`,
        reason: /^diff touches the executor: src\/lib\/helper\.ts$/ },
    ];
    for (const scenario of cases) {
      const { result, shadow } = await review(t, head, scenario.routes, scenario.diff);
      assert.equal(shadow.length, 1, `${scenario.label}: one row`);
      assert.equal(shadow[0]!.eligible, false, scenario.label);
      assert.match(String(shadow[0]!.reason), scenario.reason, scenario.label);
      assert.equal(shadow[0]!.would_save_ms, 0, scenario.label);
      assert.equal(shadow[0]!.proofs, undefined, `${scenario.label}: no comparison is made`);
      if (scenario.diff === undefined) assert.equal(verdictBytes(result), verdictBytes(baseline.result), `${scenario.label}: changes nothing else`);
    }
  });

  test("W1-T11157 criterion 3: each authentication and match check names its own reason", async t => {
    const head = headCheckout(t);
    const line = recordLine(head.repo.dir, head.headSha);
    const io = (lines: string[], over: { run?: Record<string, unknown>; job?: Record<string, unknown>; runs?: unknown; jobs?: unknown } = {}) => ({
      json: async (args: string[]) => args[1]!.includes("/runs?") ? over.runs ?? { workflow_runs: [{ id: 77, head_sha: head.headSha,
        path: gate.PROOF_DISCRIMINATION_WORKFLOW, conclusion: "success", event: "pull_request", ...over.run }] }
        : over.jobs ?? { jobs: [{ id: 88, run_id: 77, name: gate.PROOF_DISCRIMINATION_JOB, head_sha: head.headSha, conclusion: "success", ...over.job }] },
      lines: async (_args: string[], onLine: (line: string) => void) => { for (const l of lines) onLine(l); },
    });
    const target = { owner: OWNER, repo: REPO, headSha: head.headSha };
    const read = (lines: string[], over = {}) => readProofDiscriminationRecord(target, io(lines, over));
    const ineligible = async (got: Promise<ProofDiscriminationRecordRead>, reason: RegExp, label: string) => {
      const value = await got;
      assert.equal(value.kind, "ineligible", label);
      assert.match(value.kind === "ineligible" ? value.reason : "", reason, label);
    };
    await ineligible(read([line], { runs: {} }), /^no successful/, "no runs listed");
    await ineligible(read([line], { run: { head_sha: "f".repeat(40) } }), /^no successful/, "a run at another head");
    await ineligible(read([line], { run: { conclusion: "failure" } }), /^no successful/, "a failed run");
    await ineligible(read([line], { run: { event: "push" } }), /^no successful/, "a run of another event");
    await ineligible(read([line], { jobs: {} }), /no successful proof-discrimination job/, "no jobs listed");
    await ineligible(read([line], { job: { name: "other" } }), /no successful proof-discrimination job/, "another job");
    await ineligible(read([line], { job: { head_sha: "f".repeat(40) } }), /no successful proof-discrimination job/, "a job at another head");
    await ineligible(read([line], { job: { run_id: 76 } }), /no successful proof-discrimination job/, "a job of another run");
    await ineligible(read([]), /^job 88 published 0 result records, not one$/, "no record line");
    await ineligible(read([line, line]), /^job 88 published 2 result records, not one$/, "a forged second line");
    await ineligible(read([`  stale (allowed): ${line}`]), /published 0 result records/, "an echoed proof string is not a record");
    await ineligible(read([`${gate.RESULT_MARKER}{not json`]), /^result record unreadable: /, "malformed");
    await ineligible(read([`${gate.RESULT_MARKER}${JSON.stringify({ format: "v0" })}`]), /^result record format v0 is not /, "another format");
    const atPath = await read([line], { run: { path: `${gate.PROOF_DISCRIMINATION_WORKFLOW}@refs/pull/1/merge` } });
    assert.equal(atPath.kind, "record", "the run path may carry its ref");
    const record = await read([`2026-11-24T10:00:01.0000000Z ${line}\r`]);
    assert.equal(record.kind, "record");

    const input = { prUrl: "https://github.com/acme/remudero/pull/11157", headSha: head.headSha, diff: DIFF, body: BODY, criteria: CRITERIA,
      headCheckoutDir: head.repo.dir, hostCriteria: [{ proof: PROOF, proof_exec: "executed_pass" as const }], hostProofMs: 1234 };
    const recordOf = (over: Record<string, unknown>): ProofDiscriminationRecordRead =>
      ({ kind: "record", runId: 77, jobId: 88, record: { ...JSON.parse(line.slice(gate.RESULT_MARKER.length)), ...over } });
    const eligible = await proofReuseShadowRow(recordOf({}), input);
    assert.equal(eligible.eligible, true, String(eligible.reason));
    assert.equal(eligible.would_save_ms, 1234);
    for (const [label, read, over, reason] of [
      ["another head", recordOf({ head_sha: "f".repeat(40) }), {}, /^result record names another head$/],
      ["too large", recordOf({ too_large: true }), {}, /^record too large$/],
      ["no body snapshot", recordOf({}), { body: undefined }, /^no PR body snapshot to compare$/],
      ["criteria from another task", recordOf({}), { criteria: [...CRITERIA, { claim: "more", proof: "grep: more in src/x.ts" }] }, /^criteria mismatch: 1 hosted proof\(s\), 2 at the host$/],
      ["another executor", recordOf({ executor_digest: "0".repeat(64) }), {}, /^executor digest mismatch$/],
      ["another workflow", recordOf({ workflow_digest: "0".repeat(64) }), {}, /^workflow digest mismatch$/],
      ["the gate script itself", recordOf({}), { diff: "diff --git a/scripts/proof-discrimination-gate.mjs b/scripts/proof-discrimination-gate.mjs\n" }, /^diff touches the executor: scripts\/proof-discrimination-gate\.mjs$/],
      ["the workflow", recordOf({}), { diff: `diff --git a/${gate.PROOF_DISCRIMINATION_WORKFLOW} b/${gate.PROOF_DISCRIMINATION_WORKFLOW}\n` }, /^diff touches the executor: \.github\/workflows\/proof-discrimination-gate\.yml$/],
      ["a deleted setup file", recordOf({}), { diff: "diff --git a/test/setup/gone.ts b/test/setup/gone.ts\ndeleted file mode 100644\n" }, /^diff touches the executor: test\/setup\/gone\.ts$/],
      ["the toolchain", recordOf({}), { diff: "diff --git a/package.json b/package.json\n" }, /^diff touches the executor: package\.json$/],
      ["a rename out of the executor", recordOf({}), { diff: "diff --git a/src/lib/helper.ts b/src/lib/moved.ts\nrename from src/lib/helper.ts\nrename to src/lib/moved.ts\n" }, /^diff touches the executor: src\/lib\/helper\.ts$/],
      ["an unreadable checkout", recordOf({}), { listTracked: async () => { throw new Error("not a git checkout"); } }, /^executor digest unreadable: not a git checkout$/],
      ["a malformed host verdict", recordOf({}), { hostCriteria: [{ proof: undefined, proof_exec: "executed_pass" }] }, /^shadow comparison failed: /],
    ] as const) {
      const row = await proofReuseShadowRow(read, { ...input, ...(over as object) } as typeof input);
      assert.equal(row.eligible, false, label);
      assert.match(String(row.reason), reason, label);
      assert.equal(row.would_save_ms, 0, label);
      assert.equal(row.proofs, undefined, label);
    }
    assert.deepEqual(diffTouchedPaths("diff --git a/a.ts b/b.ts\ncopy from c.ts\n"), ["a.ts", "b.ts", "c.ts"]);
  });
});
