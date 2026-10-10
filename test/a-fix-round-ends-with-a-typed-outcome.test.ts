import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { anchoredFixOutcome, decideFixOutcomeAction } from "../src/lib/fix-outcome.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import { commitWorkerEdits, missingCommitLinePrompt, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];

function fixture(report: string, files = ["src/fix.ts"]) {
  const repo = gitRepo({ kind: "fix-outcome" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "test"));
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "test/existing.test.ts"), "old assertion\n");
  writeFileSync(join(repo.dir, "src/fix.ts"), "old source\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const rows: Row[] = [];
  let spawns = 0;
  let pushes = 0;
  let waits = 0;
  let edit: (() => void) | undefined;
  const review = {
    state: "failure", criteria: [{ claim: "repair failing check", proof: "unit test: repair", met: false,
      reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "head-a", reviewerOutcome: "failure",
  } as Run["initialReview"];
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text: report, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
  const run: Run = {
    taskId: "W1-T5532", runId: "outcome-run", task: { id: "W1-T5532", title: "typed fix", files },
    prUrl: "https://github.com/acme/remudero/pull/5532", branch: "run-W1-T5532-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => { spawns++; edit?.(); return worker; },
      waitForCiGreen: async () => { waits++; return "green"; },
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T5532", ...extra }), say: () => {}, account: (r) => r,
    },
  };
  return { repo, run, rows, worker, setEdit: (fn: () => void) => { edit = fn; },
    counts: () => ({ spawns, pushes, waits }) };
}

test("W1-T5532: the fix prompt asks for one anchored FIX_OUTCOME line", () => {
  for (const harnessCommits of [true, false]) {
    const prompt = renderFixPrompt({ task: { id: "W1-T5532", title: "typed fix", files: ["src/fix.ts"] },
      round: 1, branch: "run-W1-T5532-1", evidence: { review: { unmetCriteria: [], summary: "repair" } }, harnessCommits });
    assert.match(prompt, /exactly one anchored `FIX_OUTCOME:/);
    for (const name of ["FIXED", "BASE_RED", "FLAKE", "NEEDS_SCOPE", "NEEDS_DESIGN"]) assert.ok(prompt.includes(name));
    assert.match(prompt, /test\/.*added or edited.*undeclared/);
    const plan = renderFixPrompt({ task: { id: "W1-T5532", title: "plan fix", files: ["plan/tasks.yaml"] },
      round: 1, branch: "run-W1-T5532-1", evidence: { review: { unmetCriteria: [], summary: "repair" } }, harnessCommits });
    assert.doesNotMatch(plan, /test\/.*added or edited.*undeclared/);
  }
});

test("W1-T5532: an undeclared test file edit is committed by a fix round", async () => {
  const f = fixture("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(tests): repair assertion");
  f.setEdit(() => writeFileSync(join(f.repo.dir, "test/existing.test.ts"), "repaired assertion\n"));
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "fixed");
  assert.equal(f.repo.git("show", "HEAD:test/existing.test.ts"), "repaired assertion");
  assert.deepEqual(f.rows.find((r) => r.step === "implement.harness_commit")?.admitted_tests, ["test/existing.test.ts"]);
  assert.equal(f.rows.find((r) => r.step === "fix.done")?.fix_outcome, "FIXED");
});

test("W1-T5532: an implement round still refuses an undeclared test edit", async () => {
  const f = fixture("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(tests): repair assertion", ["plan/tasks.yaml"]);
  writeFileSync(join(f.repo.dir, "test/existing.test.ts"), "changed\n");
  const impl = commitWorkerEdits(f.repo.dir, ["src/fix.ts"], "fix(tests): repair assertion");
  assert.equal(impl.committed, false);
  assert.equal(impl.reason, "every change the worker made is outside its declared files");
  await runFixRung(f.run);
  assert.equal(f.counts().pushes, 0);
  assert.equal(f.rows.find((r) => r.step === "fix.commit_refused")?.reason, impl.reason);
});

test("W1-T5532: a stated FIXED with edits commits under a derived subject", async () => {
  const f = fixture("REPORT\nFIX_OUTCOME: FIXED");
  f.setEdit(() => writeFileSync(join(f.repo.dir, "src/fix.ts"), "fixed source\n"));
  assert.equal((await runFixRung(f.run)).outcome, "fixed");
  assert.equal(f.counts().spawns, 1);
  const commit = f.rows.find((r) => r.step === "implement.harness_commit");
  assert.equal(commit?.subject_source, "harness-derived");
  assert.equal(commit?.fix_outcome, "FIXED");
  const idle = fixture("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair");
  await runFixRung(idle.run);
  assert.equal(idle.rows.find((r) => r.step === "fix.commit_refused")?.fix_outcome_contradiction, true);
});

test("W1-T5532: a BASE_RED claim is verified against main before any refund", async () => {
  for (const state of ["fails", "passes", "absent", "unrunnable", "throws"] as const) {
    const f = fixture("REPORT\nFIX_OUTCOME: BASE_RED");
    f.run.ciFailures = [{ name: "ci", logTail: "not ok - test/existing.test.ts" }];
    f.run.deps.readMainTip = () => "main-tip";
    f.run.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) => {
      assert.deepEqual(files, ["test/existing.test.ts"]);
      assert.equal(sha, "main-tip");
      if (state === "throws") throw new Error("probe failed");
      return [{ file: files[0], outcome: state, duration_ms: 1, cached: false }];
    };
    const result = await runFixRung(f.run);
    assert.equal(result.strikes, state === "fails" ? 0 : 1);
    assert.equal(result.outcome, "stood_down");
    assert.equal(f.rows.some((r) => r.step === "fix.strike_refunded" && r.reason === "worker-base-red-verified"), state === "fails");
    assert.equal(f.counts().pushes, 0);
    if (state !== "fails") assert.equal(f.rows.find((r) => r.step === "fix.done")?.base_red_claim, "refuted");
  }
});

test("W1-T5532: a FLAKE re-runs the failing jobs once and refunds on green", async () => {
  for (const green of [true, false]) {
    const f = fixture("REPORT\nFIX_OUTCOME: FLAKE");
    f.run.ciFailures = [{ name: "ci", logTail: "not ok - test/existing.test.ts", jobId: "123" }];
    let calls = 0;
    f.run.deps.requeueCheck = (failure) => {
      assert.equal(failure.jobId, "123");
      assert.ok(f.rows.some((r) => r.step === "sweep.check_requeued"));
      calls++; return true;
    };
    f.run.deps.waitForCiGreen = async () => green ? "green" : "red";
    const first = await runFixRung(f.run);
    assert.equal(first.strikes, green ? 0 : 1);
    await runFixRung(f.run);
    assert.equal(calls, 1);
    assert.equal(f.rows.filter((r) => r.step === "fix.strike_refunded").length, green ? 1 : 0);
    if (!green) assert.equal(f.rows.find((r) => r.step === "fix.done")?.flake_claim, "refuted");
  }
});

test("W1-T5532: NEEDS_DESIGN and non-test NEEDS_SCOPE leave the round with a named row", async () => {
  const design = fixture("REPORT\nFIX_OUTCOME: NEEDS_DESIGN clarify retry ownership");
  const outcome = await runFixRung(design.run);
  assert.equal(outcome.outcome, "needs_design");
  assert.equal(outcome.strikes, 1);
  assert.equal(design.counts().spawns, 1);
  assert.equal(design.rows.find((r) => r.step === "fix.needs_design")?.reason, "clarify retry ownership");
  assert.equal((await runFixRung(design.run)).outcome, "needs_design");
  assert.equal(design.counts().spawns, 1);
  const scope = fixture("REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/other.ts");
  await runFixRung(scope.run);
  assert.deepEqual(scope.rows.find((r) => r.step === "fix.scope_needed")?.paths, ["src/other.ts"]);
  assert.match(String(scope.rows.find((r) => r.step === "fix.commit_refused")?.scope_amendment_detail), /src\/other.ts/);
  assert.equal(scope.counts().pushes, 0);
});

test("W1-T5532: a missing FIX_OUTCOME line behaves exactly as today", async () => {
  const f = fixture("REPORT\nCOMMIT_MESSAGE: fix(ci): repair");
  f.setEdit(() => writeFileSync(join(f.repo.dir, "src/fix.ts"), "fixed source\n"));
  assert.equal((await runFixRung(f.run)).outcome, "fixed");
  assert.equal(f.rows.find((r) => r.step === "fix.done")?.fix_outcome, "unstated");
  const missing = fixture("REPORT\nno commit line");
  missing.worker.provider = undefined;
  missing.setEdit(() => writeFileSync(join(missing.repo.dir, "src/fix.ts"), "edit\n"));
  await runFixRung(missing.run);
  assert.equal(missing.counts().spawns, 2);
  assert.equal(missing.rows.find((r) => r.step === "fix.commit_refused")?.reason, "no anchored COMMIT_MESSAGE line in the report");
});

test("W1-T5532: typed outcome parsing rejects malformed and escaping paths", () => {
  for (const text of ["", "prose FIX_OUTCOME: FIXED", "FIX_OUTCOME: FIXED extra", "FIX_OUTCOME: NEEDS_SCOPE /tmp/file",
    "FIX_OUTCOME: NEEDS_SCOPE test/../src/a.ts", "FIX_OUTCOME: NEEDS_SCOPE C:\\file", "FIX_OUTCOME: NEEDS_SCOPE test/a.ts,",
    "FIX_OUTCOME: NEEDS_DESIGN ", `FIX_OUTCOME: NEEDS_DESIGN ${"a".repeat(501)}`,
    "FIX_OUTCOME: FIXED\nFIX_OUTCOME: UNKNOWN"]) assert.equal(anchoredFixOutcome(text), undefined, text);
  assert.deepEqual(anchoredFixOutcome("FIX_OUTCOME: BASE_RED\nFIX_OUTCOME: FIXED"), { kind: "FIXED" });
  assert.deepEqual(anchoredFixOutcome("FIX_OUTCOME: NEEDS_SCOPE test/a.ts,src/b.ts"), { kind: "NEEDS_SCOPE", paths: ["test/a.ts", "src/b.ts"] });
  assert.deepEqual(decideFixOutcomeAction(anchoredFixOutcome("FIX_OUTCOME: NEEDS_SCOPE test/a.ts,src/b.ts"), { admitTests: true }),
    { kind: "scope-needed", testPaths: ["test/a.ts"], paths: ["src/b.ts"] });
  assert.equal(decideFixOutcomeAction(undefined, { admitTests: true }).kind, "legacy");
  assert.equal(decideFixOutcomeAction({ kind: "BASE_RED" }, { admitTests: true }).kind, "verify-base");
  assert.equal(decideFixOutcomeAction({ kind: "FLAKE" }, { admitTests: true }).kind, "rerun-once");
  assert.equal(decideFixOutcomeAction({ kind: "NEEDS_DESIGN", reason: "why" }, { admitTests: true }).kind, "hand-off");
  assert.deepEqual(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["test/a.ts"] }, { admitTests: false }),
    { kind: "scope-needed", testPaths: [], paths: ["test/a.ts"] });
  assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["test/a.ts"] }, { admitTests: true }).kind, "commit");
});

test("W1-T5532: the resumed writer can authorize a derived fix or report another outcome", async () => {
  assert.match(missingCommitLinePrompt({ provider: "claude", title: "fix", report: "REPORT", worktreePath: "/unused" }), /FIX_OUTCOME/);
  for (const answer of ["FIXED", "NEEDS_DESIGN clarify ownership"]) {
    const f = fixture("REPORT\nno commit line");
    // Exercise the legacy session-resume path; known providers now commit the first attempt directly.
    f.worker.provider = undefined;
    let calls = 0;
    f.run.deps.spawn = async () => {
      calls++;
      writeFileSync(join(f.repo.dir, "src/fix.ts"), "edit\n");
      return { ...f.worker, text: calls === 1 ? "REPORT\nno commit line" : `REPORT\nFIX_OUTCOME: ${answer}` };
    };
    assert.equal((await runFixRung(f.run)).outcome, answer === "FIXED" ? "fixed" : "needs_design");
    assert.equal(calls, 2);
    assert.equal(f.rows.some((r) => r.step === "fix.commit_refused"), false);
  }
});

test("W1-T5532: test admission includes additions and deletions without staging non-test scope", async () => {
  for (const change of ["add", "delete", "mixed"] as const) {
    const f = fixture(`REPORT\nFIX_OUTCOME: NEEDS_SCOPE test/existing.test.ts${change === "mixed" ? ",src/other.ts" : ""}\nCOMMIT_MESSAGE: fix(tests): repair scope`);
    f.setEdit(() => {
      if (change === "delete") rmSync(join(f.repo.dir, "test/existing.test.ts"));
      else writeFileSync(join(f.repo.dir, change === "add" ? "test/new.test.ts" : "test/existing.test.ts"), "edit\n");
      if (change === "mixed") writeFileSync(join(f.repo.dir, "src/other.ts"), "undeclared\n");
    });
    // W1-T6465: the run-<taskId> head now carries task identity, so the mixed round reaches the
    // amendment writer; a shard-less fixture refuses it offline instead of reaching the real gh.
    if (change === "mixed") f.run.deps.scopeAmendmentWritePorts = { repoDir: f.repo.dir, findShard: () => undefined,
      lookupIdentity: () => undefined, probeExisting: () => undefined } as unknown as NonNullable<typeof f.run.deps.scopeAmendmentWritePorts>;
    const result = await runFixRung(f.run);
    assert.equal(result.outcome, change === "mixed" ? "stood_down" : "fixed");
    const path = change === "add" ? "test/new.test.ts" : "test/existing.test.ts";
    assert.deepEqual(f.rows.find((r) => r.step === "implement.harness_commit")?.admitted_tests, [path]);
    assert.equal(f.counts().pushes, 1);
    assert.equal(f.repo.git("show", "--name-only", "--format=", "HEAD"), path);
    if (change === "mixed") assert.match(String(f.rows.find((r) => r.step === "fix.commit_refused")?.scope_amendment_detail), /src\/other.ts/);
  }
});

test("W1-T5532: incomplete or failed flake verification cannot refund a strike", async () => {
  for (const mode of ["no-job", "no-failures", "queue-refused", "queue-throws", "wait-throws", "timeout", "foreign-head"]) {
    const f = fixture("REPORT\nFIX_OUTCOME: FLAKE");
    f.run.ciFailures = mode === "no-failures" ? undefined : [{ name: "ci", logTail: "test/existing.test.ts", ...(mode === "no-job" ? {} : { jobId: "123" }) }];
    f.run.deps.requeueCheck = () => {
      if (mode === "queue-throws") throw new Error("queue offline");
      return mode !== "queue-refused";
    };
    f.run.deps.waitForCiGreen = async () => {
      if (mode === "wait-throws") throw new Error("ci offline");
      return mode === "timeout" ? "timeout" : { state: "green", sha: "foreign-head" };
    };
    assert.equal((await runFixRung(f.run)).strikes, 1, mode);
    assert.equal(f.rows.some((r) => r.step === "fix.strike_refunded"), false, mode);
    assert.equal(f.rows.find((r) => r.step === "fix.done")?.flake_claim, "refuted", mode);
  }
});

test("W1-T5532: the default base probe runs a failing test at the fetched main tip", async () => {
  const f = fixture("REPORT\nFIX_OUTCOME: BASE_RED");
  f.repo.addRemote("origin", f.repo.dir);
  symlinkSync(join(process.cwd(), "node_modules"), join(f.repo.dir, "node_modules"), "dir");
  mkdirSync(join(f.repo.dir, "test/setup"));
  writeFileSync(join(f.repo.dir, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(f.repo.dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(f.repo.dir, "test/existing.test.ts"), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("broken main", () => assert.equal(1, 2));\n');
  f.repo.git("add", "package.json", "test/existing.test.ts", "test/setup/tmp-hygiene.ts");
  f.repo.git("commit", "-qm", "broken main");
  f.run.ciFailures = [{ name: "ci", logTail: "not ok - test/existing.test.ts" }];
  const result = await runFixRung(f.run);
  assert.equal(result.strikes, 0, JSON.stringify(f.rows.filter((r) => /base_reproduction|base_red/.test(r.step))));
  const refund = f.rows.find((r) => r.step === "fix.strike_refunded");
  assert.equal(refund?.reason, "worker-base-red-verified");
  assert.equal(refund?.main_sha, f.repo.git("rev-parse", "HEAD"));
});
