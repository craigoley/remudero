import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/lib/config.js";
import * as runner from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, MACHINE_LANE_HEAD_RE, isMachineLanePlanHead, planConflictRoundCandidate, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const SHARDS = ["plan/tasks.d/W1-T1-a.yaml", "plan/tasks.d/W1-T2-b.yaml", "plan/tasks.d/W1-T3-c.yaml"];
const clean: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

/** #11381-shaped: a backlog gardener's plan filing that went dirty under the plan gardener's retirements. */
const dirty: OpenPrView = {
  prNumber: 11381, prUrl: "https://github.com/acme/remudero/pull/11381", headSha: HEAD,
  headRefName: "backlog-garden-1791904155914", isPlanFiling: true, planFilingSource: "github-files",
  checksState: "none", reviewState: "none", mergeState: "dirty", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), autoMergeArmed: false, body: "## Acceptance\n- priority added to a | grep: priority in plan/tasks.d/W1-T1-a.yaml\n- priority added to b | grep: priority in plan/tasks.d/W1-T2-b.yaml",
  mergeConflict: { files: SHARDS.map((path) => ({ path, oursDeleted: 0, theirsDeleted: 1 })), oursLog: "", theirsLog: "" },
};

function sweepDeps(author: string, onRound: () => void, escalations: { reasons: string[] }) {
  const ledger: Record<string, unknown>[] = [];
  const deps = {
    runId: "plan-conflict-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
    appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
    arm() {}, close() {}, postReview: async () => {},
    dispatchFix() { assert.fail("a plan filing must never enter the code rung"); },
    escalate(_pr: OpenPrView, reason: string) { escalations.reasons.push(reason); },
    readPlanRepairFacts: () => ({ authorLogin: author }),
    repairPlanPr() { assert.fail("the mechanical cures read check logs, never a merge state"); },
    dispatchPlanGateRound: async () => { onRound(); return { outcome: "pushed", headSha: NEXT }; },
  } as unknown as SweepDeps;
  return { deps, ledger };
}

const policy = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };

test("W1-T9289: a dirty fleet gardener plan PR is dispatched to the plan-scoped conflict round", async () => {
  let rounds = 0;
  const escalations = { reasons: [] as string[] };
  const { deps, ledger } = sweepDeps("remudero-fleet[bot]", () => { rounds++; }, escalations);
  assert.equal(planConflictRoundCandidate(dirty), true);
  await runSweep([dirty], deps, policy);
  assert.equal(rounds, 1);
  assert.deepEqual(escalations.reasons, []);
  const disposed = ledger.findLast((l) => l.step === "sweep.disposed" && l.pr_number === dirty.prNumber)!;
  assert.notEqual(disposed.disposition, "blocked-ambiguous");
  assert.doesNotMatch(String(disposed.reason), /rmd-owned run branch/);
  assert.match(String(disposed.reason), /plan-scoped round/);
  assert.equal(ledger.some((l) => l.step === "sweep.plan_round.pushed" && l.head_sha === HEAD), true);
  await runSweep([dirty], deps, policy);
  assert.equal(rounds, 1, "one round per head");
  // A non-plan conflicting path is never the plan round's to resolve.
  const code = { ...dirty, mergeConflict: { ...dirty.mergeConflict!, files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }] } };
  assert.equal(planConflictRoundCandidate(code), false);
});

test("W1-T9289: a dirty operator plan PR keeps the not-dispatched refusal", async () => {
  for (const [author, head] of [["cao825", dirty.headRefName!], ["remudero-fleet[bot]", "unjam-1791904155914"]] as const) {
    let rounds = 0;
    const escalations = { reasons: [] as string[] };
    const { deps, ledger } = sweepDeps(author, () => { rounds++; }, escalations);
    await runSweep([{ ...dirty, headRefName: head }], deps, policy);
    assert.equal(rounds, 0, `${author} ${head}`);
    const disposed = ledger.findLast((l) => l.step === "sweep.disposed" && l.pr_number === dirty.prNumber)!;
    assert.equal(disposed.disposition, "blocked-ambiguous");
    assert.match(String(disposed.reason), /head is not this PR task's rmd-owned run branch — not dispatched/);
  }
});

test("W1-T9289: every GARDEN_NAMES branch is a machine-lane plan head", () => {
  assert.equal(runner.GARDEN_NAMES.length >= 16, true);
  for (const name of runner.GARDEN_NAMES) {
    assert.equal(isMachineLanePlanHead(`${name}-garden-1791904155914`), true, name);
    assert.equal(runner.GARDEN_BRANCH_RE.test(`${name}-garden-1`), true, name);
  }
  assert.equal(MACHINE_LANE_HEAD_RE.test("fix-lane-garden-1"), true);
  assert.equal(isMachineLanePlanHead("run-W1-T9289-1792335237071"), false);
  assert.equal(isMachineLanePlanHead("unjam-1791904155914"), false);
});

const A = "plan/tasks.d/W1-T1-a.yaml";
const B = "plan/tasks.d/W1-T2-b.yaml";
const BASE_A = "- id: W1-T1\n  title: a\n  status: queued\n  attempts: 0\n";
const BASE_B = "- id: W1-T2\n  title: b\n  status: queued\n  attempts: 0\n";

/** main retired W1-T1 (rewriting its `status:` line); the branch inserts `priority:` under that same line. */
function conflictFixture() {
  const fixtureRepo = gitRepo({ seedCommit: false, kind: "plan-conflict-repo" });
  const repo = fixtureRepo.dir;
  const git = fixtureRepo.git;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  write(".gitignore", "node_modules\n");
  write(A, BASE_A);
  write(B, BASE_B);
  git("add", "-A");
  git("commit", "--quiet", "-m", "chore(plan): fixture base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "backlog-garden-1791904155914");
  write(A, BASE_A.replace("  status: queued\n", "  status: queued\n  priority: 1\n"));
  write(B, BASE_B.replace("  status: queued\n", "  status: queued\n  priority: 2\n"));
  git("commit", "--quiet", "-am", "chore(plan): add priority lines");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "main");
  write(A, BASE_A.replace("  status: queued\n", "  status: retired\n"));
  git("commit", "--quiet", "-am", "chore(plan): retire W1-T1");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("update-ref", "refs/pull/11381/head", headSha);
  git("remote", "add", "origin", repo);
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
  return { fixtureRepo, repo, git, headSha, base };
}

test("W1-T9289: the conflict round keeps the retirement from main and drops a placement on a retired task", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-conflict-"));
  const { fixtureRepo, repo, git, headSha } = conflictFixture();
  const trees: string[] = [];
  try {
    const run = async (worker: (tree: string) => string, post: PlanPrPreflightResult = clean) => {
      const materialized = runner.materializePlanRoundWorktree({ root } as Config, repo, 11381, headSha);
      assert.ok(materialized.worktreePath, materialized.failure?.message);
      const tree = materialized.worktreePath!;
      trees.push(tree);
      const pushed: string[] = [];
      const prompts: string[] = [];
      const preflighted: Array<{ sha: string; a: string }> = [];
      const written: Array<{ title: string; body: string }> = [];
      const result = await runner.runPlanScopedFixRound({
        pr: { ...dirty, headSha }, worktreePath: tree, conflict: true, title: "chore(plan): add priority lines",
        body: dirty.body!, task: { id: "PR-11381", title: "fixture", files: [A, B] },
        deps: {
          preflight: async (t: string, sha: string) => { preflighted.push({ sha, a: readFileSync(join(t, A), "utf8") }); return post; },
          spawn: async (prompt: string) => { prompts.push(prompt); return worker(tree); },
          push: async (sha: string) => { pushed.push(sha); },
          updateMetadata: async (meta: { title: string; body: string }) => { written.push(meta); },
          log() {},
        },
      } as never);
      return { result, tree, pushed, prompts, preflighted, written };
    };

    const good = await run((tree) => {
      writeFileSync(join(tree, A), BASE_A.replace("  status: queued\n", "  status: retired\n"));
      return "PR_ACCEPTANCE:\n## Acceptance\n- priority added to b | grep: priority in plan/tasks.d/W1-T2-b.yaml\nEND_PR_ACCEPTANCE";
    });
    assert.equal(good.result.outcome, "pushed", good.result.reason);
    assert.match(good.prompts[0]!, /merge-conflict/);
    assert.match(good.prompts[0]!, /keep main's side/);
    assert.deepEqual(good.pushed, [good.result.headSha]);
    assert.deepEqual(good.preflighted.map((p) => p.sha), [good.result.headSha], "the pushed head is the one preflighted");
    const merged = readFileSync(join(good.tree, A), "utf8");
    assert.match(merged, /status: retired/, "main's retirement is kept");
    assert.doesNotMatch(merged, /priority:/, "the placement on the retired task is dropped");
    assert.match(readFileSync(join(good.tree, B), "utf8"), /priority: 2/, "a placement that still applies survives");
    const parents = git("rev-list", "--parents", "-n", "1", good.result.headSha!).split(" ");
    assert.equal(parents.length, 3, "a merge commit, never a rebase");
    assert.equal(parents[1], headSha);
    assert.equal(parents[2], git("rev-parse", "origin/main"));
    assert.equal(good.written.length, 1, "the acceptance line is rewritten through updateMetadata");
    assert.doesNotMatch(good.written[0]!.body, /priority added to a/);
    assert.match(good.written[0]!.body, /priority added to b/);

    // Taking the branch's side leaves markers or the placement: never pushed on markers.
    const markers = await run(() => "nothing resolved");
    assert.equal(markers.result.outcome, "refused");
    assert.match(markers.result.reason!, /conflict markers remain/);
    assert.deepEqual(markers.pushed, []);

    const stray = await run((tree) => { writeFileSync(join(tree, "src-x.txt"), "x"); return ""; });
    assert.equal(stray.result.outcome, "refused");
    assert.match(stray.result.reason!, /outside the conflicted plan paths/);
    assert.deepEqual(stray.pushed, []);

    const red = await run((tree) => {
      writeFileSync(join(tree, A), BASE_A.replace("  status: queued\n", "  status: retired\n"));
      return "";
    }, { ok: false, failures: [{ check: "lint-plan", firstLine: "rationale is missing" }], unreadable: [] });
    assert.equal(red.result.outcome, "refused");
    assert.equal(red.result.reason, "rationale is missing");
    assert.deepEqual(red.pushed, []);
  } finally {
    for (const tree of trees) git("worktree", "remove", "--force", tree);
    rmSync(join(repo, "node_modules"), { force: true });
    fixtureRepo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
