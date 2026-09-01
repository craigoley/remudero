import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createPlanSyncCoalescer,
  runTask,
  syncPlanFromOrigin,
  syncPlanOrRefuse,
  type SyncedPlan,
} from "../src/run-task.js";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";

// ── W1-T2513: EVERY DISPATCH LANE RE-FETCHES ORIGIN AND RE-LOADS THE WHOLE PLAN BEFORE IT
// YIELDS. `runTask` carries ZERO `await` across its whole preamble (see that function's own
// doc), so `Promise.allSettled(admitted.map((t) => deps.runOne(t.id)))` (drain.ts/daemon.ts)
// invokes every lane of ONE tick SYNCHRONOUSLY, back-to-back, before any of them can suspend.
// `createPlanSyncCoalescer` exploits exactly that: the first lane's call computes the real
// fetch+load and caches it; every lane invoked in that same synchronous stretch reuses it; the
// cache self-clears on the very next microtask, which cannot fire until every lane of THIS tick
// has already read it, and cannot survive to answer the NEXT tick's first call either. These
// tests exercise the mechanism with REAL, throwaway git repos (no mocking of git itself) —
// same style as test/run-task.test.ts's gitFixture()/self-sync.test.ts's gitFixture().

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A tiny real "origin" repo + a real clone of it, both with a committed plan/tasks.yaml. */
function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-tick-sync-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

function publishNewCommit(originDir: string, title: string): void {
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml(title), "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", title], { cwd: originDir });
}

/** A fresh gitFixture whose origin remote is already broken -- syncPlanFromOrigin's fetch
 *  fails, exactly the fail-closed shape test/run-task.test.ts's syncPlanOrRefuse tests use. */
function brokenOriginFixture(): { planPath: string; config: Config } {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "remote", "set-url", "origin", "/no/such/path"]);
  const config: Config = { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-tick-sync-root-")) };
  return { planPath: join(localDir, "plan", "tasks.yaml"), config };
}

function readLedgerLinesFor(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Wraps the REAL syncPlanFromOrigin with a call counter -- every assertion below proves the
 *  coalescer against genuine git fetch/parse mechanics, never a faked outcome. */
function countingSync(): { calls: () => number; syncFn: typeof syncPlanFromOrigin } {
  let n = 0;
  return {
    calls: () => n,
    syncFn: (repoDir, relPath, opts) => {
      n += 1;
      return syncPlanFromOrigin(repoDir, relPath, opts);
    },
  };
}

/** Three independent {log, say} recorders, one per simulated lane. */
function threeLanes() {
  return [0, 1, 2].map(() => ({
    logged: [] as Array<{ step: string; extra?: Record<string, unknown> }>,
    said: [] as string[],
  }));
}

// ── AC1/AC2: three lanes of one tick share exactly ONE origin fetch and ONE plan load ───────

test("createPlanSyncCoalescer: three lanes of one tick share exactly one fetch+load, never one each", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED");
  const planPath = join(localDir, "plan", "tasks.yaml");
  const { calls, syncFn } = countingSync();
  const coalescer = createPlanSyncCoalescer(planPath, syncFn);

  // Simulate drain.ts's `admitted.map((t) => deps.runOne(t.id))`: three lane calls issued
  // SYNCHRONOUSLY, back to back, in the same tick -- exactly how runTask's own zero-await
  // preamble is entered for the concurrent lanes of one dispatch pass.
  const r1 = coalescer.sync({ allowStale: false });
  const r2 = coalescer.sync({ allowStale: false });
  const r3 = coalescer.sync({ allowStale: false });

  assert.equal(calls(), 1, "three lanes of one tick must share exactly one underlying fetch+load");
  assert.equal(r1.plan.tasks[0].title, "PUBLISHED", "the shared result reflects a REAL fetch, not a stub");
  assert.equal(r2, r1, "every lane gets the identical cached result object, not merely equal content");
  assert.equal(r3, r1);
});

// ── AC5: the shared snapshot never crosses a tick boundary ──────────────────────────────────

test("createPlanSyncCoalescer: the shared snapshot never crosses a tick boundary -- the next tick re-fetches and re-loads", async () => {
  const { originDir, localDir } = gitFixture();
  const planPath = join(localDir, "plan", "tasks.yaml");
  const { calls, syncFn } = countingSync();
  const coalescer = createPlanSyncCoalescer(planPath, syncFn);

  coalescer.sync({ allowStale: false });
  coalescer.sync({ allowStale: false });
  assert.equal(calls(), 1, "tick 1: two lane calls share one fetch+load");

  // The async gap that separates two real ticks (drain.ts/daemon.ts await
  // Promise.allSettled(...) between them) -- never present WITHIN one tick's synchronous
  // admitted.map(...). Lets the coalescer's own self-clearing microtask actually run.
  await Promise.resolve();
  await Promise.resolve();

  publishNewCommit(originDir, "TICK-2-PUBLISHED");
  const r3 = coalescer.sync({ allowStale: false });
  assert.equal(calls(), 2, "tick 2 must re-fetch and re-load -- tick 1's cache must not survive");
  assert.equal(r3.plan.tasks[0].title, "TICK-2-PUBLISHED", "tick 2's lane must see the FRESH origin content");
});

// ── AC8 (falsifiability): the shared-count assertion above is not vacuous ───────────────────

test("negative control: three UNCOALESCED calls (today's pre-fix shape) really do cost three fetches -- proving the shared-count assertions above are falsifiable", () => {
  const { localDir } = gitFixture();
  const repoDir = localDir;
  const relPath = "plan/tasks.yaml";
  const { calls, syncFn } = countingSync();

  // No coalescer in the loop at all -- three "lanes" each call syncPlanFromOrigin directly,
  // exactly as runTask's preamble did before this task existed.
  syncFn(repoDir, relPath, { allowStale: false });
  syncFn(repoDir, relPath, { allowStale: false });
  syncFn(repoDir, relPath, { allowStale: false });

  assert.equal(
    calls(),
    3,
    "three independent per-lane calls cost three fetches -- restoring this shape would fail a `calls() === 1` assertion",
  );
});

// ── AC3: a fetch failure refuses every lane of the tick identically, never just the first ───

test("syncPlanOrRefuse + createPlanSyncCoalescer: a fetch failure refuses EVERY lane of the tick identically, off exactly one shared attempt", () => {
  const { planPath } = brokenOriginFixture();
  const { calls, syncFn } = countingSync();
  const coalescer = createPlanSyncCoalescer(planPath, syncFn);

  const lanes = threeLanes();
  const results = lanes.map((lane) =>
    syncPlanOrRefuse(planPath, {
      allowStale: false,
      log: (step, extra) => lane.logged.push({ step, extra }),
      say: (msg) => lane.said.push(msg),
      planSnapshot: coalescer.sync,
    }),
  );

  assert.equal(calls(), 1, "three lanes of one tick must share exactly one underlying fetch attempt");
  results.forEach((result, i) => {
    assert.ok("error" in result, `lane ${i} must refuse -- never proceed on a shared fetch failure`);
    assert.ok(
      lanes[i].logged.some((l) => l.step === "git_fetch_failed"),
      `lane ${i} must ledger its OWN git_fetch_failed row, not rely on lane 0's`,
    );
    assert.ok(
      lanes[i].said.some((m) => m.startsWith("REFUSED:")),
      `lane ${i} must print its OWN refusal, exactly as if it had fetched for itself`,
    );
  });
});

// ── AC4: a stale dispatch under --allow-stale is announced to every lane, as it is today ────

test("syncPlanOrRefuse + createPlanSyncCoalescer: a stale --allow-stale dispatch is announced to EVERY lane, off exactly one shared attempt", () => {
  const { originDir, localDir } = gitFixture();
  // Break the remote AFTER the clone's own fetch already resolved origin/main once, so
  // --allow-stale has a last-known ref to fall back to (mirrors test/run-task.test.ts's
  // identical syncPlanFromOrigin --allow-stale fixture).
  execFileSync("git", ["-C", localDir, "remote", "set-url", "origin", "/no/such/path"]);
  const planPath = join(localDir, "plan", "tasks.yaml");
  const { calls, syncFn } = countingSync();
  const coalescer = createPlanSyncCoalescer(planPath, syncFn);

  const lanes = threeLanes();
  const results = lanes.map((lane) =>
    syncPlanOrRefuse(planPath, {
      allowStale: true,
      log: (step, extra) => lane.logged.push({ step, extra }),
      say: (msg) => lane.said.push(msg),
      planSnapshot: coalescer.sync,
    }),
  );

  assert.equal(calls(), 1, "three lanes of one tick must share exactly one underlying fetch attempt");
  results.forEach((result, i) => {
    assert.ok(!("error" in result), `lane ${i} must proceed (allowStale) rather than refuse`);
    if (!("error" in result)) {
      assert.equal((result as SyncedPlan).staleDispatch, true, `lane ${i} must see the shared staleDispatch=true`);
      assert.equal(
        (result as SyncedPlan).plan.tasks[0].title,
        "origin-title",
        `lane ${i} dispatches from the last-known ref, same content originDir had at clone time`,
      );
    }
    assert.ok(
      lanes[i].logged.some((l) => l.step === "git.stale_dispatch" && l.extra?.stale_dispatch === true),
      `lane ${i} must ledger its OWN stale-dispatch row -- announced to every lane, not just the first`,
    );
    assert.ok(
      lanes[i].said.some((m) => m.startsWith("WARNING: dispatching from a STALE origin/main ref")),
      `lane ${i} must print its OWN stale warning`,
    );
  });
});

// ── AC6/AC7: runTask's own wiring -- with/without opts.planSnapshot ─────────────────────────

const FAKE_SNAPSHOT_PLAN_YAML = [
  "- id: T-MERGED",
  "  title: already-merged fake-snapshot probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  depends_on: []",
  "  status: queued",
  "",
].join("\n");

const MERGED_PR_URL = "https://github.com/acme/remudero/pull/491";

/** A GitHub gateway reporting T-MERGED already merged -- the cheapest verdict runTask can
 *  reach (it returns right after the already-merged check, before assertRunnable, the §5C
 *  linter, the inflight lock, worktree materialization, or any spawn), so no other fixture is
 *  needed downstream of the plan sync this test is actually about. */
function mergedGithubFixture(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === "T-MERGED" ? { number: 491, url: MERGED_PR_URL, state: "MERGED" } : null),
    headRefName: (url) => (url === MERGED_PR_URL ? "run-T-MERGED-1700000000000" : undefined),
    prBody: (url) => (url === MERGED_PR_URL ? "REPORT\n\nRemudero-Task: T-MERGED\n" : undefined),
  };
}

test("runTask: opts.planSnapshot, when supplied, answers the sync directly -- the real git path (which would throw against this nonexistent repoDir) is never touched", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtask-snapshot-seam-root-"));
  const config: Config = { claudeBin: "/bin/true", root };
  // A planPath under a repoDir that doesn't exist at all -- syncPlanFromOrigin against it would
  // throw immediately (no such git repo). If opts.planSnapshot truly replaces that call, this
  // must never matter.
  const planPath = join(root, "no", "such", "repo", "plan", "tasks.yaml");
  const planTmpDir = mkdtempSync(join(tmpdir(), "runtask-snapshot-fake-plan-"));
  writeFileSync(join(planTmpDir, "tasks.yaml"), FAKE_SNAPSHOT_PLAN_YAML, "utf8");
  const fakePlan = loadPlan(join(planTmpDir, "tasks.yaml"));

  let snapshotCalls = 0;
  const planSnapshot = (_o: { allowStale?: boolean }): SyncedPlan => {
    snapshotCalls += 1;
    return { plan: fakePlan, staleDispatch: false };
  };

  const res = await runTask("T-MERGED", { planPath, config, github: mergedGithubFixture(), planSnapshot });

  assert.equal(snapshotCalls, 1, "the injected snapshot must be the ONLY source of the plan sync");
  assert.equal(
    res.verdict,
    "task_already_merged",
    "dispatch proceeds NORMALLY off the injected snapshot -- same shape as the skipGitSync:true equivalent",
  );
});

test("runTask: with no opts.planSnapshot, it still fetches and loads for itself -- a broken origin still refuses via blocked_git_fetch, unchanged", async () => {
  const { planPath, config } = brokenOriginFixture();

  const res = await runTask("T1", { planPath, config });

  assert.equal(res.verdict, "blocked_git_fetch", "the real sync ran and failed -- no snapshot was supplied to bypass it");
  const ledger = readLedgerLinesFor(config.root);
  assert.ok(
    ledger.some((l) => l.step === "git_fetch_failed"),
    "the default (uninjected) syncPlanOrRefuse path ledgered its own refusal, exactly as before this task",
  );
});

test("runTask: a single-lane dispatch wired through the coalescer produces the SAME verdict and step sequence as the default (no-snapshot) path", async () => {
  const baseline = brokenOriginFixture();
  const viaCoalescer = brokenOriginFixture();
  const coalescer = createPlanSyncCoalescer(viaCoalescer.planPath);

  const baselineRes = await runTask("T1", { planPath: baseline.planPath, config: baseline.config });
  const coalescedRes = await runTask("T1", {
    planPath: viaCoalescer.planPath,
    config: viaCoalescer.config,
    planSnapshot: coalescer.sync,
  });

  assert.equal(coalescedRes.verdict, baselineRes.verdict, "a solo lane through the coalescer reaches the identical verdict");
  const baselineSteps = readLedgerLinesFor(baseline.config.root).map((l) => l.step);
  const coalescedSteps = readLedgerLinesFor(viaCoalescer.config.root).map((l) => l.step);
  assert.deepEqual(
    coalescedSteps,
    baselineSteps,
    "a solo lane wired through the coalescer must log the identical step sequence, in the identical order",
  );
});
