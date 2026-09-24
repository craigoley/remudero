/**
 * W1-T4111: the plan queue tends itself. A plan gardener (a gardener.ts spec) folds queued
 * duplicates and proposes retiring tasks that are done or can never run — as a PR that opens ready
 * for review (never a draft, operator ruling 2026-09-24) and flows through the fleet's review and
 * auto-merge; each class is judged by whether that PR merges.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import { gardenStatePath, readGardenState, runGarden, startGarden, type GardenCheckout } from "../src/lib/gardener.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import {
  applyPlanActions,
  duplicateTasks,
  grepProofHolds,
  planGardenSpec,
  planInventory,
  planShards,
  PLAN_GARDEN_CLASSES,
  retirementCandidates,
} from "../src/lib/plan-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { armAutoMergeDetailed } from "../src/lib/arm-auto-merge.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";
import { decideSweepArm, DEFAULT_SWEEP_POLICY, deriveDisposition, sweepArmTaskId, type OpenPrView } from "../src/lib/sweep.js";
import { daemonCommand, GARDEN_BRANCH_RE, gardenCheckout, type RunResult } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

interface ShardSpec {
  id: string;
  title: string;
  files?: string[];
  depends_on?: string[];
  status?: string;
  retirement?: string;
  proof?: string;
}

function shard(t: ShardSpec): string {
  return [
    `- id: ${t.id}`,
    `  title: "${t.title}"`,
    "  repo: remudero",
    `  depends_on: [${(t.depends_on ?? []).join(", ")}]`,
    "  type: implement",
    `  status: ${t.status ?? "queued"}`,
    ...(t.retirement ? [`  retirement: ${t.retirement}`] : []),
    `  files: [${(t.files ?? ["learnings/ci-gate-lessons.yaml"]).join(", ")}]`,
    "  acceptance:",
    `    - claim: "c"`,
    `      proof: '${t.proof ?? `grep: never-written-${t.id} in learnings/ci-gate-lessons.yaml`}'`,
    "",
  ].join("\n");
}

/** A repo holding a plan: an empty monolith and one shard per task. */
function planRepo(tasks: ShardSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4111-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "learnings"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "learnings", "ci-gate-lessons.yaml"), "shipped-lesson: yes\n");
  for (const t of tasks) writeFileSync(join(root, "plan", "tasks.d", `${t.id}-x.yaml`), shard(t));
  return root;
}

function checkout(root: string, landed: Array<{ paths: string[]; title: string; body: string }>): () => GardenCheckout {
  return () => ({
    root,
    land: (opts) => {
      landed.push(opts);
      return "https://github.com/acme/remudero/pull/77";
    },
    dispose: () => {},
  });
}

const deps = (root: string, landed: Array<{ paths: string[]; title: string; body: string }>, prState?: () => "open" | "merged" | "closed") => ({
  stateDir: join(root, "state"),
  repoRoot: root,
  openWorkspace: checkout(root, landed),
  log: () => {},
  seed: 1,
  ...(prState ? { prState } : {}),
});

/** The ci-learning rung's real template: one lesson per gate, the count changing each window. */
const lesson = (gate: string, n: number) =>
  `THE ${gate} GATE REFUSED ${n} PULL REQUESTS IN THIS WINDOW AND EACH WAS REPAIRED — carry the lesson to the lane that keeps hitting it, so the same gate stops refusing for the same reason`;

test("W1-T4111: a duplicate queued task is folded into the older one", () => {
  const root = planRepo([
    // Filed later, but numbered lower in text order: W1-T10 sorts before W1-T9 as a string.
    { id: "W1-T10", title: lesson("ci-gate", 40) },
    { id: "W1-T9", title: lesson("ci-gate", 36) },
    // A templated title for a DIFFERENT gate is not a duplicate, though it scores 0.8.
    { id: "W1-T11", title: lesson("coverage-ratchet", 25) },
    // The same title declaring other files is a different task.
    { id: "W1-T12", title: lesson("ci-gate", 12), files: ["src/x.ts"] },
  ]);
  writeFileSync(join(root, "state", "PLAN_OFF-retire"), "");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const pass = runGarden(planGardenSpec(deps(root, landed)), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["merge"]);
  assert.deepEqual(pass.plan?.actions.map((a) => [a.target, (a as { into?: string }).into]), [["W1-T10", "W1-T9"]]);
  assert.equal(landed.length, 1);
  assert.deepEqual(landed[0]!.paths, ["plan/tasks.d/W1-T10-x.yaml"]);
  const folded = readFileSync(join(root, "plan", "tasks.d", "W1-T10-x.yaml"), "utf8");
  assert.match(folded, /^ {2}status: blocked\n {2}retirement: withdrawn\n {2}# plan gardener: merge W1-T10 into W1-T9 — /m);
  assert.match(landed[0]!.body, /proof: grep: plan gardener: merge W1-T10 into W1-T9 in plan\/tasks\.d\/W1-T10-x\.yaml/);
  // The folded shard still loads, and the plan now reads it as retired.
  assert.equal(loadPlan(join(root, "plan", "tasks.yaml")).byId.get("W1-T10")?.retirement, "withdrawn");
});

test("W1-T4111: a retirement is only ever proposed for operator review", () => {
  const root = planRepo([
    { id: "W1-T1", title: "gone", status: "blocked", retirement: "retired" },
    { id: "W1-T2", title: "waits on a retired task", depends_on: ["W1-T1"] },
    { id: "W1-T3", title: "already shipped", proof: "grep: shipped-lesson in learnings/ci-gate-lessons.yaml" },
    { id: "W1-T4", title: "still to do" },
  ]);
  writeFileSync(join(root, "state", "PLAN_OFF-merge"), "");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const spec = planGardenSpec(deps(root, landed));
  // Every class this gardener has writes `retirement:`, so every class is a person's call.
  assert.deepEqual(Object.keys(spec.review ?? {}).sort(), [...PLAN_GARDEN_CLASSES].sort());
  const pass = runGarden(spec, deps(root, landed));
  assert.deepEqual(pass.plan?.actions.map((a) => a.target).sort(), ["W1-T2", "W1-T3"]);
  // Operator ruling 2026-09-24: the PR is never held or drafted — it flows through the fleet's review
  // and auto-merge, and the person's decision is whether it merges or is closed.
  assert.equal("review" in landed[0]!, false, "nothing asks the checkout to hold or draft the PR");
  assert.match(landed[0]!.body, /^\*\*Judged by its outcome\.\*\* The plan gardener's `retire` changes are judged by whether this PR merges: /);
  assert.doesNotMatch(landed[0]!.body, /draft|held for|not queued for auto-merge/i);
  assert.match(readFileSync(join(root, "plan", "tasks.d", "W1-T2-x.yaml"), "utf8"), /retirement: retired\n {2}# plan gardener: retire W1-T2 — It depends on W1-T1/);
  assert.match(readFileSync(join(root, "plan", "tasks.d", "W1-T3-x.yaml"), "utf8"), /retirement: closed/);
  // The class is judged by the operator's decision alone: open waits, merged credits.
  writeFileSync(join(root, "plan", "tasks.d", "W1-T5-x.yaml"), shard({ id: "W1-T5", title: "new work" }));
  runGarden(spec, { ...deps(root, landed, () => "open") });
  assert.equal(readGardenState(gardenStatePath(join(root, "state"), "plan"), PLAN_GARDEN_CLASSES).pending?.actionClass, "retire");
  writeFileSync(join(root, "plan", "tasks.d", "W1-T6-x.yaml"), shard({ id: "W1-T6", title: "more work" }));
  runGarden(spec, { ...deps(root, landed, () => "merged") });
  assert.deepEqual(readGardenState(gardenStatePath(join(root, "state"), "plan"), PLAN_GARDEN_CLASSES).classes.retire, { alpha: 4, beta: 1 });
});

test("W1-T4111: the inventory skips credited and shared-shard tasks, and a proof must be a grep that holds", () => {
  const root = planRepo([{ id: "W1-T1", title: "credited" }, { id: "W1-T2", title: "open" }]);
  writeFileSync(join(root, "plan", "tasks.d", "W1-T3-pair.yaml"), shard({ id: "W1-T3", title: "a" }) + shard({ id: "W1-T4", title: "b" }));
  writeFileSync(join(root, "state", "merge-credit.json"), JSON.stringify({ "W1-T1": { trailer: { source: "trailer" } } }));
  const inv = planInventory(root, join(root, "state"));
  assert.deepEqual(inv.open.map((t) => t.id).sort(), ["W1-T2", "W1-T3", "W1-T4"]);
  assert.equal(planShards(root).has("W1-T3"), false, "a shard holding two tasks is never edited");
  assert.equal(grepProofHolds(root, "unit test: something"), false);
  assert.equal(grepProofHolds(root, "grep: nope in learnings/missing.yaml"), false);
  assert.equal(grepProofHolds(root, "grep: shipped-lesson in learnings/ci-gate-lessons.yaml"), true);
  // An already-retired shard and an unknown target are left alone.
  writeFileSync(join(root, "plan", "tasks.d", "W1-T9-x.yaml"), shard({ id: "W1-T9", title: "r", status: "blocked", retirement: "closed" }));
  const shards = planShards(root);
  assert.deepEqual(applyPlanActions(root, shards, [
    { class: "retire", target: "W1-T9", retirement: "closed", reason: "r" },
    { class: "retire", target: "W1-T404", retirement: "closed", reason: "r" },
  ]), []);
  assert.deepEqual(duplicateTasks([]), []);
  // A repo with no plan is not gardened quietly: the pass fails and the garden logs it.
  assert.throws(() => planInventory(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4111-empty-`)), "/nowhere"), /cannot read plan file/);
});

test("no garden PR is ever opened as a draft, a reviewed retirement included", () => {
  // Operator ruling 2026-09-24: a draft sits like a stuck PR. The whole path — the plan gardener's
  // reviewed `retire` class, landed through the real gardenCheckout — opens a PR ready for review.
  const seed = gitRepo({ kind: "nodraft-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T1-x.yaml"), shard({ id: "W1-T1", title: "gone", status: "blocked", retirement: "withdrawn" }));
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T2-x.yaml"), shard({ id: "W1-T2", title: "waits on it", depends_on: ["W1-T1"] }));
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "nodraft-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "nodraft-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}nodraft-state-`));
  writeFileSync(join(stateDir, "PLAN_OFF-merge"), "");
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}nodraft-wt-`));
  const calls: string[][] = [];
  const gardenDeps = {
    stateDir,
    repoRoot: clone.dir,
    log: () => {},
    seed: 1,
    openWorkspace: () =>
      gardenCheckout({
        name: "plan",
        repoDir: clone.dir,
        worktreesRoot: worktrees,
        owner: "acme",
        repo: "remudero",
        log: () => {},
        clock: fixedClock(1790000000001),
        fetcher: (args) => {
          calls.push(args);
          return { html_url: "https://github.com/acme/remudero/pull/5", number: 5 };
        },
      }),
  };
  const spec = planGardenSpec(gardenDeps);
  assert.ok(spec.review?.retire, "retire is a reviewed class — the one that used to open as a draft");
  const pass = withLiveWritesAllowed(() => runGarden(spec, gardenDeps));
  assert.equal(pass.prUrl, "https://github.com/acme/remudero/pull/5");
  assert.equal(calls.length, 1, "exactly one PR is created");
  assert.equal(calls[0]!.some((arg) => /^draft=/.test(arg)), false, `no draft field in ${JSON.stringify(calls[0])}`);
  assert.match(origin.git("log", "--oneline", "plan-garden-1790000000001"), /chore\(plan\): the plan gardener proposes to retire 1 queued task/);
  assert.equal(existsSync(join(worktrees, "plan-garden-1790000000001")), false, "the checkout is disposed");
  origin.cleanup();
  seed.cleanup();
  clone.cleanup();
});

test("W1-T4111: the daemon starts every garden and stops them when it ends", async () => {
  const root = planRepo([{ id: "W1-T1", title: "a" }]);
  let started = 0;
  let stopped = 0;
  await runDaemon(
    loadPlan(join(root, "plan", "tasks.yaml")),
    {
      refreshMerged: () => () => false,
      runOne: async (id): Promise<RunResult> => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      gardens: [
        (ms) => {
          started++;
          const g = startGarden(planGardenSpec(deps(root, [])), deps(root, []), ms);
          return { stop: () => { stopped++; g.stop(); } };
        },
      ],
      sleep: async () => {},
      log: () => {},
    },
    { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
  );
  assert.equal(started, 1);
  assert.equal(stopped, 1);
});

test("W1-T4111: a self-hosting daemon wires the plan gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4111-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  // Both classes off: the wired garden reads this repo's real plan but never opens a worktree.
  for (const c of PLAN_GARDEN_CLASSES) writeFileSync(join(root, "state", `PLAN_OFF-${c}`), "");
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.ok((captured?.gardens?.length ?? 0) >= 1, "the plan gardener is the first wired garden");
    captured!.gardens![0]!(60_000).stop();
    const state = readGardenState(gardenStatePath(join(root, "state"), "plan"), PLAN_GARDEN_CLASSES);
    assert.ok(state.lastPass, "the wired garden ran a pass over this repo's plan");
    assert.equal(state.pending, undefined, "with every class off, nothing was proposed");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("a task whose proofs only grep its own shard is never proposed as already done", () => {
  // 2026-09-23: W1-T1258 and W1-T2982 were proposed for retirement because every proof held — each grepped
  // text in the task's own shard, which holds from the moment it is filed.
  const root = planRepo([
    { id: "W1-T1", title: "self-proving", proof: "grep: self-proving in plan/tasks.d/W1-T1-x.yaml" },
    { id: "W1-T2", title: "really shipped", proof: "grep: shipped-lesson in learnings/ci-gate-lessons.yaml" },
  ]);
  const actions = retirementCandidates(planInventory(root, join(root, "state")), root);
  assert.deepEqual(actions.map((a) => a.target), ["W1-T2"]);
});

test("a garden PR opened ready for review is armed by the sweep once its review posts success", () => {
  // The path a garden PR takes now that it is never a draft (verified end to end, not added): the sweep
  // reviews it off its PR body's Acceptance block under the synthetic `PR-<n>` id, then its `mergeable`
  // row arms it under that same id — the path every trailer-less fleet PR takes.
  const head = "9a7bd00dcafebabe9a7bd00dcafebabe9a7bd00d";
  const pr: OpenPrView = {
    prNumber: 6885,
    prUrl: "https://github.com/acme/remudero/pull/6885",
    headRefName: "plan-garden-1790197666988",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-24T11:00:00Z",
    headSha: head,
    autoMergeArmed: false,
    isDraft: false,
    isPlanFiling: true,
  };
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.match(pr.headRefName!, GARDEN_BRANCH_RE, "the head identity gate admits it");
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now).disposition, "mergeable");
  assert.equal(deriveDisposition({ ...pr, isDraft: true }, DEFAULT_SWEEP_POLICY, now).disposition, "held-draft", "the draft it used to open as is what held it");
  const posted = [{ step: "review.posted", task_id: "PR-6885", head_sha: head, state: "success", capped: true, plan_only: true }];
  assert.equal(decideSweepArm(pr, posted).arm, true);
  const armId = sweepArmTaskId(pr, loadDefaultPolicy().values.sweep.armSessionPrs);
  assert.equal(armId, "PR-6885", "the sweep arms a trailer-less PR under the id its review was posted under");
  const armed: string[] = [];
  const result = armAutoMergeDetailed(pr.prUrl, armId, {
    headSha: () => head,
    ledgerLines: () => posted,
    armAuto: (url) => void armed.push(url),
    mergeDirect: () => assert.fail("an arm that succeeds never falls back to a direct merge"),
    disableAuto: () => {},
    say: () => {},
  });
  assert.equal(result.outcome, "armed");
  assert.deepEqual(armed, [pr.prUrl]);
});
