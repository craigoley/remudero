/**
 * W1-T4111: the plan queue tends itself. A plan gardener (a gardener.ts spec) folds queued
 * duplicates and proposes retiring tasks that are done or can never run — always as a draft PR a
 * person decides, and each class is judged by that decision.
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
import { daemonCommand, gardenCheckout, type RunResult } from "../src/run-task.js";
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

function checkout(root: string, landed: Array<{ paths: string[]; title: string; body: string; review?: "operator" }>): () => GardenCheckout {
  return () => ({
    root,
    land: (opts) => {
      landed.push(opts);
      return "https://github.com/acme/remudero/pull/77";
    },
    dispose: () => {},
  });
}

const deps = (root: string, landed: Array<{ paths: string[]; title: string; body: string; review?: "operator" }>, prState?: () => "open" | "merged" | "closed") => ({
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
  const landed: Array<{ paths: string[]; title: string; body: string; review?: "operator" }> = [];
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
  const landed: Array<{ paths: string[]; title: string; body: string; review?: "operator" }> = [];
  const spec = planGardenSpec(deps(root, landed));
  // Every class this gardener has writes `retirement:`, so every class is a person's call.
  assert.deepEqual(Object.keys(spec.review ?? {}).sort(), [...PLAN_GARDEN_CLASSES].sort());
  const pass = runGarden(spec, deps(root, landed));
  assert.deepEqual(pass.plan?.actions.map((a) => a.target).sort(), ["W1-T2", "W1-T3"]);
  assert.equal(landed[0]!.review, "operator", "the PR opens for a person, never for auto-merge");
  assert.match(landed[0]!.body, /^\*\*Held for operator review\.\*\*/);
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

test("W1-T4111: an operator-review PR opens as a draft and a fleet PR does not", () => {
  const origin = gitRepo({ bare: true, kind: "w1t4111-origin" });
  const seed = gitRepo({ kind: "w1t4111-seed" });
  writeFileSync(join(seed.dir, "a.txt"), "a\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w1t4111-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4111-wt-`));
  const calls: string[][] = [];
  const open = (now: number) =>
    gardenCheckout({
      name: "plan",
      repoDir: clone.dir,
      worktreesRoot: worktrees,
      owner: "acme",
      repo: "remudero",
      log: () => {},
      clock: fixedClock(now),
      fetcher: (args) => {
        calls.push(args);
        return { html_url: "https://github.com/acme/remudero/pull/5", number: 5 };
      },
    });
  const held = open(1790000000001);
  const fleet = open(1790000000002);
  try {
    writeFileSync(join(held.root, "a.txt"), "held\n");
    withLiveWritesAllowed(() => held.land({ paths: ["a.txt"], title: "chore(plan): held", body: "b", review: "operator" }));
    writeFileSync(join(fleet.root, "a.txt"), "fleet\n");
    withLiveWritesAllowed(() => fleet.land({ paths: ["a.txt"], title: "chore(plan): fleet", body: "b" }));
    assert.ok(calls[0]!.includes("draft=true"), "held for a person: a draft GitHub will not merge");
    assert.ok(!calls[1]!.includes("draft=true"));
    assert.match(origin.git("log", "--oneline", "plan-garden-1790000000001"), /chore\(plan\): held/);
  } finally {
    held.dispose();
    fleet.dispose();
    assert.equal(existsSync(held.root), false);
    origin.cleanup();
    seed.cleanup();
    clone.cleanup();
  }
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
