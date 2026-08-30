import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseAcceptanceBlock } from "../src/lib/review.js";
import { reviewCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2462: reviewCommand actually CALLS resolvePlanCriteriaAtHead ────────────────────────────
//
// W1-T2432 shipped `resolvePlanCriteriaAtHead` (lib/review.ts) fully proven standalone in
// test/review-resolves-criteria-at-the-prs-own-head.test.ts, but deliberately left it UNCALLED —
// its own doc says so: "NEVER WIRED HERE, on purpose... swapping reviewCommand's call... is a
// follow-up plumbing change". Until this task, `reviewCommand` (run-task.ts) still called
// `resolvePlanCriteriaForReview`, which reads the CONTAINER's checked-out working tree via
// `loadPlan(planPath)` rather than the PR's own head sha — so a `plan/tasks.d/` shard that merged
// between two daemon boots stayed invisible to a review of the very PR head that shard reached.
//
// This file proves the SWAP at reviewCommand's own call site, against all six of the task's
// acceptance claims (see plan/tasks.d/W1-T2462-*.yaml).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_TS = join(REPO_ROOT, "src", "run-task.ts");

/** A minimal well-formed task entry — mirrors
 *  test/review-resolves-criteria-at-the-prs-own-head.test.ts's own `task()` fixture, the smallest
 *  shape `parseTasksFromYaml` accepts. */
const task = (id: string, acceptance: string[] = []): string =>
  [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    ...(acceptance.length
      ? ["  acceptance:", ...acceptance.flatMap((claim) => [`    - claim: "${claim}"`, `      proof: "${claim}, per the PR body"`])]
      : []),
  ].join("\n");

const TRAILERED_BODY = (taskId: string) => `REPORT\n\nsome text\n\nRemudero-Task: ${taskId}\n`;

// ── CLAIMS 1, 2, 4, 6 — DRIVEN THROUGH A SPAWNED PROBE ──────────────────────────────────────────
//
// `reviewCommand`'s own `repoRoot` is a MODULE-LEVEL constant resolved AT IMPORT TIME
// (`resolveRepoRoot`, lib/repo-location.ts) from `process.argv`/`process.cwd()` — it is NOT one of
// `reviewCommand`'s injectable `deps`. The only way to point it at a scratch git repo is
// `--repo-root <dir>`, read from argv before the module graph loads, so proving the wiring reads
// AT A GIVEN SHA (rather than whatever is checked out on disk) means driving the real
// `reviewCommand` in a spawned child process — the same spawn-a-probe idiom
// test/base-blob-read-failure.test.ts's own group-5 test uses to observe a fact only visible from
// outside the process.

/** A real git repo with a committed `plan/` — `resolvePlanCriteriaAtHead` (via `loadPlanAtRef`)
 *  reads git OBJECTS, never the working tree, so this fixture (not `loadPlan`'s scratch-dir
 *  cousin) is what a caller through `reviewCommand` needs. Mirrors
 *  test/review-resolves-criteria-at-the-prs-own-head.test.ts's own `gitPlanRepo`. */
function gitPlanRepo(): { dir: string; run: (args: string[]) => string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-wires-at-head-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Test"]);
  // `resolveOwnerRepo()` (`reviewCommand`'s first line) shells `git config --get remote.origin.url`
  // UNCONDITIONALLY, even though the `--repo` in `rest` below always overrides its result — a repo
  // with no remote at all would make `reviewCommand` throw before ever reaching an injectable dep.
  run(["remote", "add", "origin", "https://github.com/o/r.git"]);
  mkdirSync(join(dir, "plan"), { recursive: true });
  // `resolveMount(loadMounts(mountsPath(repoRoot)), ...)` reads `<repoRoot>/.remudero/mounts.yaml`
  // off the real FILESYSTEM (never a git object) — copied here, untracked, so the routing table
  // this checkout already ships is what the probe resolves against; no mounts fixture to maintain.
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  const commit = (msg: string): string => {
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", msg, "--allow-empty"]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  return { dir, run, commit };
}

interface ProbeScenario {
  headRefOid: string;
  body: string;
}
interface ProbeResult {
  criteria?: { claim: string }[];
  taskId?: string;
  fetchViewCalls?: number;
  error?: string;
}

/** Drive the REAL `reviewCommand` (src/run-task.ts) against `scratchDir`, once per entry in
 *  `scenarios`, inside ONE spawned child process (`--repo-root scratchDir` pins the module-level
 *  `repoRoot` `reviewCommand` reads — see the block comment above). `fetchView`/`materialize`/
 *  `postReviewPending` are stubbed so nothing needs a live `gh` auth or a real worktree checkout;
 *  `runReview` captures the resolved `task.acceptance`/`task.id` and throws a sentinel so nothing
 *  is ever actually posted. Returns one result per scenario, in order. */
function driveReviewCommand(scratchDir: string, scenarios: ProbeScenario[]): ProbeResult[] {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-review-wires-at-head-state-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "rmd-review-wires-at-head-probe-"));
  const script = join(scriptDir, "probe.ts");
  try {
    writeFileSync(
      script,
      [
        // Silenced BEFORE the drive below: reviewCommand's own diagnostic `console.log`/
        // `console.error` calls would otherwise interleave with the JSON this probe prints on its
        // last line, corrupting the parse — the sentinel throw is what stops it, this is what
        // keeps stdout clean.
        `console.log = () => {};`,
        `console.error = () => {};`,
        `import { reviewCommand } from ${JSON.stringify(RUN_TASK_TS)};`,
        `const scenarios = ${JSON.stringify(scenarios)};`,
        `const stateRoot = ${JSON.stringify(stateRoot)};`,
        `async function main() {`,
        `  const out = [];`,
        `  for (const scenario of scenarios) {`,
        `    let fetchViewCalls = 0;`,
        `    let captured;`,
        `    const SENTINEL = "rmd-probe-stop";`,
        `    try {`,
        `      await reviewCommand("review-wires-at-head-branch", ["--repo", "o/r"], {`,
        `        fetchView: () => { fetchViewCalls += 1; return { headRefOid: scenario.headRefOid, headRefName: "b", body: scenario.body, url: "https://github.com/o/r/pull/1", number: 1 }; },`,
        `        loadConfig: () => ({ root: stateRoot }),`,
        `        materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip" } }),`,
        `        postReviewPending: async () => ({ posted: false }),`,
        `        runReview: (args) => { captured = { criteria: args.task.acceptance, taskId: args.task.id }; throw new Error(SENTINEL); },`,
        `      });`,
        `      out.push({ error: "reviewCommand resolved instead of throwing the probe's sentinel" });`,
        `    } catch (e) {`,
        `      if (!captured || e.message !== SENTINEL) out.push({ error: String((e && e.stack) || e) });`,
        `      else out.push({ ...captured, fetchViewCalls });`,
        `    }`,
        `  }`,
        `  process.stdout.write(JSON.stringify(out));`,
        `}`,
        `main();`,
      ].join("\n"),
    );
    const childEnv = { ...process.env };
    // Same hygiene as test/base-blob-read-failure.test.ts's own probe: a coverage-instrumented
    // child that never exercises most of the module graph it loads only pollutes the ratchet.
    delete childEnv.NODE_V8_COVERAGE;
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--repo-root", scratchDir], {
      cwd: REPO_ROOT, // so the bare `tsx` loader specifier resolves from THIS checkout's node_modules
      encoding: "utf8",
      env: childEnv,
    });
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as ProbeResult[];
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("reviewCommand resolves at the PR's own head sha, judges a shard the PR's own diff adds, still fails closed on an id absent at that head, and still cannot see a shard that merges later", () => {
  const { dir, run, commit } = gitPlanRepo();
  try {
    // C0 ("boot"): the container's simulated last-booted state — a monolith declaring one
    // unrelated task, no shards at all yet.
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-AT-BASE") + "\n");
    const c0 = commit("boot: monolith only");

    // C1: a shard lands — THE PR's OWN DIFF ADDING THE SHARD ITS TRAILER NAMES (claim 2).
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(dir, "plan", "tasks.d", "w1-at-shard.yaml"), task("W1-AT-SHARD", ["shard criterion lands"]) + "\n");
    const c1 = commit("shard lands (this PR's own diff)");

    // C2: a SECOND shard lands AFTER c1 — the residual window claim 6 names: invisible to any read
    // pinned at c1, visible once the head moves past it.
    writeFileSync(join(dir, "plan", "tasks.d", "w1-at-late.yaml"), task("W1-AT-LATE", ["late criterion lands"]) + "\n");
    const c2 = commit("a later shard merges after c1");

    // The container's own checked-out working tree is left at c0 — detached, exactly as stale as
    // the filing's own rationale describes (never restarted past either shard). Everything below
    // must resolve from the git ref it is handed, never from what is physically on disk here.
    run(["checkout", "--quiet", "--detach", c0]);

    const results = driveReviewCommand(dir, [
      // (1) & (2): resolves from the head sha's OWN committed shard, not the stale checked-out
      // tree (which has no tasks.d/ at all on disk right now).
      { headRefOid: c1, body: TRAILERED_BODY("W1-AT-SHARD") },
      // (6): a shard merged AFTER c1 (i.e. c2) must stay invisible when reviewing at c1.
      { headRefOid: c1, body: TRAILERED_BODY("W1-AT-LATE") },
      // Control for (6): the SAME id, reviewed at c2 (after it landed), IS visible — proving the
      // boundary is precise, not a general failure to read shards at all.
      { headRefOid: c2, body: TRAILERED_BODY("W1-AT-LATE") },
      // (4): a trailer whose id resolves NOWHERE in the plan at that head still reads as no
      // criteria — fail-closed stays fail-closed.
      { headRefOid: c1, body: TRAILERED_BODY("W1-AT-NOPE") },
    ]);

    const [atHeadWithOwnShard, lateBeforeItLands, lateAfterItLands, unresolvableId] = results;

    assert.equal(atHeadWithOwnShard.error, undefined, atHeadWithOwnShard.error);
    assert.deepEqual(
      (atHeadWithOwnShard.criteria ?? []).map((c) => c.claim),
      ["shard criterion lands"],
      "claim 1 & 2: the shard the PR's own diff added at its head sha must be judged from, even though the checked-out working tree here has no tasks.d/ at all",
    );
    assert.equal(atHeadWithOwnShard.fetchViewCalls, 1, "resolving criteria must not cost a second PR-view fetch");

    assert.equal(lateBeforeItLands.error, undefined, lateBeforeItLands.error);
    assert.deepEqual(
      (lateBeforeItLands.criteria ?? []).map((c) => c.claim),
      [],
      "claim 6: a shard merging AFTER the reviewed head sha must stay invisible — this wiring claims no more than that residual window",
    );

    assert.equal(lateAfterItLands.error, undefined, lateAfterItLands.error);
    assert.deepEqual(
      (lateAfterItLands.criteria ?? []).map((c) => c.claim),
      ["late criterion lands"],
      "control: the same id IS found once the reviewed head sha has moved past where it landed",
    );

    assert.equal(unresolvableId.error, undefined, unresolvableId.error);
    assert.deepEqual(
      (unresolvableId.criteria ?? []).map((c) => c.claim),
      [],
      "claim 4: a trailer whose id resolves nowhere at the head sha reads as no criteria to judge, not a crash and not a pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLAIM 3 — AN UNTRAILERED BODY IS UNCHANGED, IN-PROCESS (no spawn needed: the resolver is
// never even reached) ────────────────────────────────────────────────────────────────────────

test("an untrailered body is unchanged — still resolves from its own PR body Acceptance block, and the head-sha resolver is never reached to establish that", async () => {
  // STRUCTURAL: `reviewCommand` only calls `resolvePlanCriteriaAtHead` inside `if (taskId)` — the
  // same gate test/resolver-divergence-detector.test.ts pins for the same reason — so a body
  // carrying no anchored trailer can never make it touch a git object at all.
  const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    runTaskSrc,
    /if\s*\(taskId\)\s*{\s*const resolved = resolvePlanCriteriaAtHead\(body, repoRoot, /,
    "resolvePlanCriteriaAtHead must be gated on a resolved taskId, never called for an untrailered body",
  );

  // BEHAVIOURAL: a deliberately UNREACHABLE headRefOid (never a real git object anywhere) proves
  // the point operationally — if the gate above were ever removed, resolving against this sha
  // would surface as a named divergence rather than silently degrading, and this assertion would
  // catch the regression by finding something other than the body's own Acceptance block.
  const body = ["REPORT", "", "## Acceptance", "- the thing works | grep: thing in src/x.ts"].join("\n");
  const root = mkdtempSync(join(tmpdir(), "rmd-review-wires-at-head-untrailered-"));
  const SENTINEL = "stop-before-posting";
  let captured: { task: { acceptance: { claim: string }[] } } | undefined;
  try {
    await assert.rejects(
      () =>
        reviewCommand("review-untrailered-branch", ["--repo", "o/r"], {
          fetchView: () => ({
            headRefOid: "0000000000000000000000000000000000dead",
            headRefName: "b",
            body,
            url: "https://github.com/o/r/pull/1",
            number: 1,
          }),
          loadConfig: () => ({ root }) as Config,
          materialize: () =>
            ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip" } }) as unknown as ReturnType<
              typeof import("../src/run-task.js").materializeReviewWorktree
            >,
          runReview: ((args: { task: { acceptance: { claim: string }[] } }) => {
            captured = args;
            throw new Error(SENTINEL);
          }) as unknown as typeof import("../src/run-task.js").runReview,
        }),
      (e: Error) => e.message === SENTINEL,
    );
    assert.ok(captured, "runReview must still be reached — an untrailered body is unchanged, never a reason to refuse the review");
    assert.deepEqual(
      captured.task.acceptance.map((c) => c.claim),
      parseAcceptanceBlock(body).map((c) => c.claim),
      "criteria must come from the body's own Acceptance block, exactly as before this task",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CLAIM 5 — NO SECOND NETWORK FETCH, SYNCHRONOUS — IN-PROCESS AGAINST THIS REAL CHECKOUT ──────

test("the swap costs no second network fetch and stays synchronous — one fetchView call resolves and judges in the same tick", async () => {
  // STRUCTURAL: resolvePlanCriteriaAtHead is called with no `await` in front of it at its call
  // site — its result is hand straight into the criteria used to build runReview's own arguments
  // in the same synchronous block, exactly claim 5 requires ("resolving and judging in the same
  // tick").
  const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.doesNotMatch(
    runTaskSrc,
    /await\s+resolvePlanCriteriaAtHead/,
    "resolvePlanCriteriaAtHead must be called synchronously, never awaited",
  );

  // BEHAVIOURAL: driving a REAL trailered review — against a task (W1-T2432) actually committed
  // with real acceptance criteria at this checkout's own HEAD — touches `fetchView` (the ONLY
  // network seam reviewCommand's deps expose) exactly once. Resolving criteria at the head sha
  // reads LOCAL git objects via `runGit`, never a second `gh`/REST round trip.
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const body = TRAILERED_BODY("W1-T2432");
  const root = mkdtempSync(join(tmpdir(), "rmd-review-wires-at-head-fetchcount-"));
  const SENTINEL = "stop-before-posting";
  let fetchViewCalls = 0;
  let captured: { task: { acceptance: { claim: string }[] } } | undefined;
  try {
    await assert.rejects(
      () =>
        reviewCommand("review-fetch-count-branch", ["--repo", "o/r"], {
          fetchView: () => {
            fetchViewCalls += 1;
            return { headRefOid: headSha, headRefName: "b", body, url: "https://github.com/o/r/pull/1", number: 1 };
          },
          loadConfig: () => ({ root }) as Config,
          materialize: () =>
            ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip" } }) as unknown as ReturnType<
              typeof import("../src/run-task.js").materializeReviewWorktree
            >,
          runReview: ((args: { task: { acceptance: { claim: string }[] } }) => {
            captured = args;
            throw new Error(SENTINEL);
          }) as unknown as typeof import("../src/run-task.js").runReview,
        }),
      (e: Error) => e.message === SENTINEL,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fetchViewCalls, 1, "reviewCommand must fetch the PR view exactly once — resolving criteria at head must not trigger a second gh/REST read");
  assert.ok(captured, "runReview must be reached");
  assert.ok((captured!.task.acceptance.length ?? 0) > 0, "a real, currently-declared task's criteria must actually resolve, proving the wiring engaged rather than silently falling through");
});
