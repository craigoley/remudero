import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/lib/config.js";
import * as runner from "../src/run-task.js";
import { deriveFixMode, renderFixPrompt } from "../src/lib/prompt-render.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, drainDetachedSweepActions, fixRoundTally, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import { acceptanceAuthorTimeCheck } from "../src/lib/review.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const PATH = "plan/tasks.d/W1-T5543-fixture.yaml";
const BODY = `## Acceptance\n- the shard is filed | grep: id: W1-T5543 in ${PATH}`;
const clean: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const red: PlanPrPreflightResult = { ok: false, failures: [{ check: "lint-plan", firstLine: "rationale is missing" }], unreadable: [] };
const pr: OpenPrView = {
  prNumber: 9000, prUrl: "https://github.com/acme/remudero/pull/9000", headSha: HEAD,
  headRefName: "ci-friction-garden-1791084979333", isPlanFiling: true, planFilingSource: "github-files",
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  ciFailures: [{ name: "lint-plan", logTail: "rationale is missing", conclusion: "FAILURE" }], body: BODY,
};

test("W1-T5543: an uncured machine plan red gets a plan-scoped round", async () => {
  for (const author of ["remudero-fleet[bot]", "cao825"]) {
    const ledger: Record<string, unknown>[] = [];
    let rounds = 0;
    let escalations = 0;
    const deps = {
      runId: "plan-round-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
      appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
      arm() {}, close() {}, postReview: async () => {},
      dispatchFix() { assert.fail("plan filings must never enter the code rung"); },
      escalate() { escalations++; },
      readPlanRepairFacts: () => ({ authorLogin: author, title: "chore(plan): file fixture" }),
      repairPlanPr() { assert.fail("the mechanical cures do not match"); },
      dispatchPlanGateRound: async () => { rounds++; return { outcome: "pushed", headSha: NEXT }; },
    } as unknown as SweepDeps;
    const peer = { ...pr, prNumber: 9001, checksState: "green", reviewState: "success", isPlanFiling: false, ciFailures: undefined } as OpenPrView;
    await runSweep([pr, peer], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(rounds, author === "cao825" ? 0 : 1);
    assert.equal(escalations, author === "cao825" ? 1 : 0);
    if (rounds) {
      await runSweep([pr, peer], deps, DEFAULT_SWEEP_POLICY);
      assert.equal(rounds, 1, "the same observed head gets one round per sweep history");
      const row = ledger.find((l) => l.step === "sweep.plan_round.pushed")!;
      assert.equal(row.head_sha, HEAD);
      assert.equal(row.pr_number, pr.prNumber);
      assert.equal(row.lane_head, pr.headRefName);
      assert.deepEqual(row.checks, ["lint-plan"]);
    }
  }
});

test("plan rounds wait for a base red, respect admission, and stop on a repeated refusal", async () => {
  for (const scenario of ["base", "dry-run", "admission", "refusal"] as const) {
    const ledger: Record<string, unknown>[] = scenario === "base"
      ? [{ step: "main.health.observed", sha: NEXT, state: "red", failing_checks: ["lint-plan"] }] : [];
    let rounds = 0;
    let escalations = 0;
    const deps = {
      runId: "plan-round-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
      appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
      arm() {}, close() {}, postReview: async () => {},
      dispatchFix() { assert.fail("never dispatch code"); }, escalate() { escalations++; },
      readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }),
      repairPlanPr() { assert.fail("base reds wait without a mutation"); },
      dryRun: scenario === "dry-run",
      claimFixAdmission: () => scenario === "admission" ? { admitted: false, reason: "fleet full" } : { admitted: true },
      dispatchPlanGateRound: async () => { rounds++; throw new Error("lint repair refused"); },
    } as unknown as SweepDeps;
    const peer = { ...pr, prNumber: 9001, checksState: "green", reviewState: "success", isPlanFiling: false, ciFailures: undefined } as OpenPrView;
    for (let pass = 0; pass < 3; pass++) await runSweep([pr, peer], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(rounds, scenario === "refusal" ? 2 : 0, scenario);
    assert.equal(escalations, 0, "exhaustion is handed to the existing ambiguous-state ladder");
    if (scenario === "refusal") {
      assert.equal(ledger.filter((l) => l.step === "sweep.plan_round.refused").length, 2);
      assert.match(String(ledger.findLast((l) => l.step === "sweep.disposed" && l.pr_number === pr.prNumber)?.reason), /refused twice/);
      assert.equal(ledger.findLast((l) => l.step === "sweep.disposed" && l.pr_number === pr.prNumber)?.disposition, "blocked-ambiguous");
    }
  }
});

test("a plan round releases the daemon sweep while its worker runs", async () => {
  const ledger: Record<string, unknown>[] = [];
  let release!: (value: { outcome: "pushed"; headSha: string }) => void;
  const pending = new Promise<{ outcome: "pushed"; headSha: string }>((resolve) => { release = resolve; });
  const deps = {
    runId: "plan-detached-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
    appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
    arm() {}, close() {}, postReview: async () => {}, escalate() {}, dispatchFix() { assert.fail("never code"); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }), repairPlanPr() {},
    dispatchPlanGateRound: () => pending, detachFixWait: true,
  } as unknown as SweepDeps;
  const peer = { ...pr, prNumber: 9001, checksState: "green", reviewState: "success", isPlanFiling: false, ciFailures: undefined } as OpenPrView;
  let settled = false;
  const work = runSweep([pr, peer], deps, DEFAULT_SWEEP_POLICY).then(() => { settled = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, "the sweep must not await a plan worker");
    assert.equal(ledger.some((l) => l.step === "sweep.plan_round.dispatched"), true);
    assert.equal(ledger.some((l) => l.step === "sweep.plan_round.pushed"), false);
  } finally {
    release({ outcome: "pushed", headSha: NEXT });
    await work;
    await drainDetachedSweepActions();
  }
  assert.equal(ledger.some((l) => l.step === "sweep.plan_round.pushed" && l.headSha === NEXT), true);
});

function roundFixture(over: { paths?: string[]; body?: string; existing?: boolean; before?: string; diff?: string; post?: PlanPrPreflightResult; report?: string } = {}) {
  const calls: string[][] = [];
  const metadata: Array<{ title: string; body: string }> = [];
  const written: Array<{ title: string; body: string }> = [];
  const pushed: string[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const findings: string[] = [];
  let spawned = 0;
  let preflights = 0;
  const input = {
    pr, worktreePath: "/fixture", title: "chore(plan): file fixture", body: over.body ?? BODY,
    task: { id: "PR-9000", title: "fixture", files: [PATH], risk: "medium" as const, acceptance: [] },
    deps: {
      runGit(args: string[]) {
        calls.push(args);
        if (args[0] === "rev-parse") return calls.some((c) => c[0] === "commit") ? NEXT : HEAD;
        if (args[0] === "status") return (over.paths ?? [PATH]).map((p) => ` M ${p}\0`).join("");
        if (args[0] === "ls-tree") return over.existing ? PATH : "";
        if (args[0] === "show") return "- id: W1-T5543\n";
        if (args[0] === "diff") return args.includes("origin/main..." + HEAD) ? over.before ?? "" : over.diff ?? "";
        return "";
      },
      preflight: async (_tree: string, _sha: string, meta: { title: string; body: string }) => {
        preflights++;
        metadata.push(meta);
        return preflights === 1 ? red : over.post ?? clean;
      },
      spawn: async (prompt: string) => {
        spawned++;
        findings.push(prompt);
        return over.report ?? "COMMIT_MESSAGE: fix(plan): supply rationale";
      },
      push: async (sha: string) => { pushed.push(sha); },
      updateMetadata: async (meta: { title: string; body: string }) => { written.push(meta); },
      log: (step: string, extra?: Record<string, unknown>) => { logs.push({ step, extra }); },
    },
  };
  return { input, calls, metadata, written, pushed, logs, findings, spawned: () => spawned };
}

test("W1-T5543: the plan round stages only the PR's own plan paths", async () => {
  const good = roundFixture();
  assert.equal((await runner.runPlanScopedFixRound(good.input)).outcome, "pushed");
  assert.deepEqual(good.calls.find((c) => c[0] === "add"), ["add", "-A", "--", PATH]);
  for (const path of ["src/x.ts", "test/x.test.ts", "plan/tasks.d/other.yaml", "plan/../src/x.ts"]) {
    const bad = roundFixture({ paths: [PATH, path] });
    assert.equal((await runner.runPlanScopedFixRound(bad.input)).outcome, "refused", path);
    assert.equal(bad.calls.some((c) => c[0] === "commit" || c[0] === "add"), false);
    assert.deepEqual(bad.pushed, []);
  }
  const diff = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -4 +4 @@\n-  proof: old\n+  proof: weakened\n`;
  const badCriterion = roundFixture({ existing: true, diff });
  assert.match((await runner.runPlanScopedFixRound(badCriterion.input)).reason!, /untouched criterion/);
  assert.deepEqual(badCriterion.pushed, []);
  const touched = roundFixture({ existing: true, diff, before: diff.replace("weakened", "old") });
  assert.equal((await runner.runPlanScopedFixRound(touched.input)).outcome, "pushed");
  const appended = roundFixture({ existing: true, diff: diff + "+  claim: new exemption\n", before: diff });
  assert.equal((await runner.runPlanScopedFixRound(appended.input)).outcome, "refused");
});

test("W1-T5543: the plan round pushes only a preflight-clean commit", async () => {
  const good = roundFixture({ report: `COMMIT_MESSAGE: fix(plan): supply rationale\nPR_TITLE: chore(plan): corrected title\nPR_ACCEPTANCE:\n${BODY}\nEND_PR_ACCEPTANCE` });
  assert.equal((await runner.runPlanScopedFixRound(good.input)).outcome, "pushed");
  assert.deepEqual(good.pushed, [NEXT]);
  assert.match(good.findings[0]!, /MODE: plan-gate/);
  assert.match(good.findings[0]!, /rationale is missing/);
  assert.match(good.findings[0]!, /self-credit|W1-T3231/);
  assert.equal(good.written.at(-1)?.title, "chore(plan): corrected title");
  const bad = roundFixture({ post: red });
  const refused = await runner.runPlanScopedFixRound(bad.input);
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.reason, "rationale is missing");
  assert.deepEqual(bad.pushed, []);
  assert.deepEqual(bad.written, []);
  const refusedRows = bad.logs.map((l) => ({ ...l.extra, step: l.step }));
  assert.equal(fixRoundTally(refusedRows, "PR-9000", HEAD).strikes, 0);
  assert.equal(fixRoundTally(refusedRows, "PR-9000", HEAD).refusals.length, 1);
  assert.equal(fixRoundTally(good.logs.map((l) => ({ ...l.extra, step: l.step })), "PR-9000", HEAD).strikes, 1);
  const unreadable = roundFixture({ post: { ...clean, unreadable: [{ check: "tree", firstLine: "missing head" }] } });
  assert.equal((await runner.runPlanScopedFixRound(unreadable.input)).outcome, "refused");
  assert.deepEqual(unreadable.pushed, []);
  assert.equal(deriveFixMode({ planGateFindings: [], ciFailures: [] }), "plan-gate");
  assert.match(renderFixPrompt({ task: good.input.task, branch: pr.headRefName!, round: 1, evidence: { planGateFindings: red.failures, ciFailures: pr.ciFailures } }), /lint-plan/);
});

test("a plan round whose final preflight ran out of its budget holds the push and names the check that timed out", async () => {
  const timedOut = roundFixture({ post: { ...clean, timedOut: [{ check: "proof-discrimination", firstLine: "timed out after 9 ms — no verdict" }] } });
  const result = await runner.runPlanScopedFixRound(timedOut.input);
  assert.equal(result.outcome, "refused", "a check with no verdict is never a pass");
  assert.equal(result.reason, "timed out after 9 ms — no verdict");
  assert.deepEqual(timedOut.pushed, []);
});

test("W1-T5543: a worker that only corrects the title repairs metadata without a push", async () => {
  const titled = roundFixture({ paths: [], report: "PR_TITLE: chore(plan): corrected title" });
  const result = await runner.runPlanScopedFixRound(titled.input);
  assert.equal(result.outcome, "metadata-repaired", result.reason);
  assert.equal(result.headSha, HEAD);
  assert.equal(titled.written.at(-1)?.title, "chore(plan): corrected title");
  assert.deepEqual(titled.pushed, []);
  const idle = roundFixture({ paths: [], report: "nothing to do" });
  assert.equal((await runner.runPlanScopedFixRound(idle.input)).reason, "the worker changed nothing");
  assert.deepEqual(idle.written, []);
});

test("W1-T5543: a self-crediting filing body is cured without a worker", async () => {
  const fixed = roundFixture({ body: `${BODY}\n\nRemudero-Task: W1-T5543` });
  assert.equal((await runner.runPlanScopedFixRound(fixed.input)).outcome, "metadata-repaired");
  assert.equal(fixed.spawned(), 0);
  assert.equal(fixed.written.at(-1)?.body, BODY);
  assert.deepEqual(fixed.pushed, []);
  const existing = roundFixture({ existing: true, body: `${BODY}\nRemudero-Task: W1-T5543` });
  assert.equal((await runner.runPlanScopedFixRound(existing.input)).outcome, "pushed");
  assert.equal(existing.spawned(), 1, "an existing task's credit is retained");
  const invalid = roundFixture({ body: "Remudero-Task: W1-T5543", post: red });
  assert.equal((await runner.runPlanScopedFixRound(invalid.input)).outcome, "refused");
  assert.equal(invalid.spawned(), 1, "a remaining plan red proceeds to the scoped worker");
  const quoted = roundFixture({ body: BODY.replace("id: W1-T5543 in", "\"id: W1-T5543\" in") });
  Object.assign(quoted.input.deps, { execProof: (proof: string) => ({ hits: proof.includes('"') ? 0 : 1 }) });
  assert.equal((await runner.runPlanScopedFixRound(quoted.input)).outcome, "metadata-repaired");
  assert.equal(quoted.spawned(), 0);
  assert.equal(quoted.written[0]?.body, BODY);
  const noHeader = roundFixture({ body: "Files the task shard." });
  assert.equal((await runner.runPlanScopedFixRound(noHeader.input)).outcome, "metadata-repaired");
  assert.equal(noHeader.spawned(), 0);
  assert.equal(acceptanceAuthorTimeCheck(noHeader.written[0]!.body).ok, true);
});

test("the plan round carries read, spawn, metadata and push errors as refusals", async () => {
  for (const seam of ["runGit", "preflight", "spawn", "updateMetadata", "push"] as const) {
    const fixture = roundFixture({ report: "COMMIT_MESSAGE: fix(plan): rationale\nPR_TITLE: chore(plan): corrected" });
    Object.assign(fixture.input.deps, { [seam]: () => { throw new Error(`${seam} failed`); } });
    const result = await runner.runPlanScopedFixRound(fixture.input);
    assert.equal(result.outcome, "refused");
    assert.equal(result.reason, `${seam} failed`);
    assert.equal(fixture.logs.at(-1)?.step === "sweep.plan_round.error" || fixture.logs.at(-1)?.step === "fix.done", true);
  }
  const moved = roundFixture();
  moved.input.deps.runGit = () => NEXT;
  assert.match((await runner.runPlanScopedFixRound(moved.input)).reason!, /head moved/);
  assert.equal(moved.spawned(), 0);
  const missing = roundFixture({ report: "no commit subject" });
  assert.match((await runner.runPlanScopedFixRound(missing.input)).reason!, /COMMIT_MESSAGE/);
  assert.deepEqual(missing.pushed, []);
});

test("the plan round's default git seam commits in a detached tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-round-"));
  const fixtureRepo = gitRepo({ seedCommit: false, kind: "plan-round-repo" });
  const repo = fixtureRepo.dir;
  const git = fixtureRepo.git;
  let tree: string | undefined;
  try {
    git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    git("add", ".gitignore");
    git("commit", "--quiet", "-m", "chore(plan): fixture base");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    mkdirSync(dirname(join(repo, PATH)), { recursive: true });
    writeFileSync(join(repo, PATH), "- id: W1-T5543\n");
    git("add", PATH);
    git("commit", "--quiet", "-m", "chore(plan): fixture filing");
    const headSha = git("rev-parse", "HEAD");
    git("update-ref", "refs/pull/9000/head", headSha);
    git("remote", "add", "origin", repo);
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
    const materialized = runner.materializePlanRoundWorktree({ root } as Config, repo, pr.prNumber, headSha);
    assert.ok(materialized.worktreePath, materialized.failure?.message);
    tree = materialized.worktreePath;
    const fixture = roundFixture();
    const result = await runner.runPlanScopedFixRound({ ...fixture.input, pr: { ...pr, headSha }, worktreePath: tree!,
      deps: { ...fixture.input.deps, runGit: undefined,
        spawn: async () => {
          writeFileSync(join(tree!, PATH), "- id: W1-T5543\n  rationale: repaired\n");
          return "COMMIT_MESSAGE: fix(plan): repair fixture rationale";
        },
      },
    });
    assert.equal(result.outcome, "pushed", result.reason);
    assert.notEqual(result.headSha, headSha);
    assert.equal(git("rev-parse", "HEAD"), headSha, "the source branch remains at its prior head");
    assert.match(readFileSync(join(tree!, PATH), "utf8"), /rationale: repaired/);
    assert.deepEqual(fixture.pushed, [result.headSha]);
    git("worktree", "remove", "--force", tree!);
    tree = undefined;
    rmSync(join(repo, "node_modules"));
    const noToolchain = runner.materializePlanRoundWorktree({ root } as Config, repo, pr.prNumber, headSha, { prepare: () => false });
    assert.equal(noToolchain.worktreePath, undefined);
    assert.equal(noToolchain.failure?.message, "plan round toolchain unavailable");
  } finally {
    if (tree) git("worktree", "remove", "--force", tree);
    fixtureRepo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep adapter feeds CI tails and writes validated metadata through REST", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-effect-"));
  const writes: string[][] = [];
  const gitCalls: string[][] = [];
  const removed: string[] = [];
  let spawns = 0;
  try {
    const deps: Parameters<typeof buildSweepEffects>[0] = {
      owner: "acme", repo: "remudero", config: { root } as Config, repoRoot: process.cwd(),
      ledgerPath: join(root, "ledger.ndjson"), runId: "plan-round-test", log() {},
      plan: { tasks: [] } as never, policy: DEFAULT_SWEEP_POLICY,
      dispatchFixPreflightStandDownImpl: async () => undefined,
      ghJsonImpl: (args: string[]) => {
        writes.push(args);
        return { head: { ref: pr.headRefName, sha: HEAD }, user: { login: "remudero-fleet[bot]" }, title: "chore(plan): fixture", body: BODY };
      },
      fetchPrDiffFilesImpl: async () => [PATH, "src/x.ts"],
      fixBranchClaimKeyImpl: () => "plan-round-fixture",
      materializePlanRoundWorktreeImpl: () => ({ worktreePath: join(root, "tree") }),
      planRepairGitImpl: (_file, args) => {
        gitCalls.push([...args]);
        return args.includes("rev-parse") ? NEXT : "";
      },
      restRollupForImpl: async () => [], fetchCiFailuresImpl: () => pr.ciFailures,
      spawnImpl: async (args) => {
        spawns++;
        assert.equal(args.cwd, join(root, "tree"));
        assert.equal(args.tools?.includes("Bash"), false);
        return { text: "COMMIT_MESSAGE: fix(plan): repair", blocks: [], subtype: "success" } as never;
      },
      runPlanScopedFixRoundImpl: async (input: Parameters<typeof runner.runPlanScopedFixRound>[0]) => {
        assert.deepEqual(input.task.files, [PATH]);
        assert.deepEqual(input.pr.ciFailures, pr.ciFailures);
        await input.deps.spawn("plan fixture");
        await input.deps.updateMetadata({ title: "chore(plan): corrected", body: BODY });
        await input.deps.push(NEXT);
        return { outcome: "pushed", headSha: NEXT, preflight: clean };
      },
      worktreeRemoveImpl: (_repo, path) => { removed.push(path); },
    };
    const effects = buildSweepEffects(deps);
    const outcome = await withLiveWritesAllowed(() => effects.dispatchPlanGateRound!(pr));
    assert.equal(outcome.outcome, "pushed", outcome.reason);
    assert.equal(spawns, 1);
    assert.equal(writes.some((args) => args.includes("PATCH") && args.includes(`body=${BODY}`)), true);
    assert.deepEqual(removed, [join(root, "tree")]);
    assert.equal(gitCalls.some((args) => args.includes(`HEAD:refs/heads/${pr.headRefName}`)), true);
    deps.spawnImpl = async () => { throw new Error("worker unavailable"); };
    assert.equal((await buildSweepEffects(deps).dispatchPlanGateRound!(pr)).reason, "worker unavailable");
    assert.equal(removed.length, 2);
    deps.materializePlanRoundWorktreeImpl = () => ({ failure: { message: "missing tree" } });
    assert.equal((await buildSweepEffects(deps).dispatchPlanGateRound!(pr)).reason, "missing tree");
    assert.equal(removed.length, 2, "a missing tree is not removed");
    deps.ghJsonImpl = () => ({ head: { ref: pr.headRefName, sha: NEXT }, user: { login: "remudero-fleet[bot]" }, title: "t", body: BODY });
    assert.equal((await buildSweepEffects(deps).dispatchPlanGateRound!(pr)).reason, "the filing head or author changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
