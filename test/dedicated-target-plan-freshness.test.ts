import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand, dedicatedTargetPlanReloader, planReloader } from "../src/run-task.js";

// ── W1-T3554 ─────────────────────────────────────────────────────────────────────────────────
//
// A dedicated instance launched with `--repo <target>` (a non-self target, no explicit `--plan`)
// froze that target's plan tree at boot forever: `planReloader` returns `undefined` whenever
// `target.isSelf` is false, and `checkFreshness` only watches the daemon's OWN engine checkout —
// so nothing in the running process ever re-read the target's `plan/tasks.yaml` after boot. A
// merged target-plan change (a task's status flipping, a `needs-human` gate resolving) never
// reached dispatch eligibility for the daemon's whole lifetime (the CONSOLE-T1 incident this
// task's rationale reports).
//
// `dedicatedTargetPlanReloader` is the fix: the non-self counterpart to `planReloader`, wired at
// exactly the same `deps.reloadPlan` seam `runDaemon` already consults once per tick, at the top,
// before any dispatch decision — so "never mid-batch" is inherited from the SAME caller discipline
// `planReloader`'s own tests already pin, with no new gate needed here.

const okResult = (id: string) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0 }) as never;

// ── the reloader's own change detection (mirrors planReloader's unit tests exactly) ────────────

test("dedicatedTargetPlanReloader: a SELF target gets no reloader — that arm belongs to planReloader alone", () => {
  assert.equal(
    dedicatedTargetPlanReloader({ isSelf: true, planPath: "/x" }, () => {}, { treeSha: () => "s" }),
    undefined,
    "this function exists ONLY for the non-self arm planReloader refuses",
  );
});

test("dedicatedTargetPlanReloader: returns null on the FIRST tick — the boot plan already came from that sha", () => {
  const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: "/x" }, () => {}, {
    fetch: () => {},
    treeSha: () => "sha-boot",
    load: () => ({ tasks: [] }) as unknown as Plan,
  });
  assert.ok(r, "a non-self dedicated target gets a reloader");
  assert.equal(r!(), null, "no reload is reported for the sha the boot already loaded");
});

test("dedicatedTargetPlanReloader: null while the tree sha is unchanged, a fresh plan when it moves", () => {
  let sha = "sha-1";
  let loads = 0;
  let resets = 0;
  const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: "/x" }, () => {}, {
    fetch: () => {},
    treeSha: () => sha,
    resetWorkingTree: () => {
      resets += 1;
    },
    load: () => {
      loads += 1;
      return { tasks: [{ id: "NEW" }] } as unknown as Plan;
    },
  })!;
  assert.equal(r(), null); // first tick records the sha
  assert.equal(r(), null, "unchanged sha must not re-parse the plan");
  assert.equal(loads, 0, "the common path costs no parse at all");
  sha = "sha-2";
  const fresh = r();
  assert.ok(fresh, "a moved tree sha yields a fresh plan");
  assert.equal(loads, 1);
  assert.equal(resets, 1, "the working tree is reset to origin/main exactly once per genuine change, before the parse");
  assert.equal(r(), null, "and it settles again on the new sha");
  assert.equal(loads, 1, "exactly one parse per genuine change");
  assert.equal(resets, 1, "and exactly one reset — an unchanged tick resets nothing");
});

test("dedicatedTargetPlanReloader: fetches EVERY call, unlike planReloader — nothing else keeps a non-self target's origin/main current between dispatches", () => {
  let fetches = 0;
  const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: "/x" }, () => {}, {
    fetch: () => {
      fetches++;
    },
    treeSha: () => "same-sha",
    load: () => ({ tasks: [] }) as unknown as Plan,
  })!;
  r();
  r();
  r();
  assert.equal(fetches, 3, "every tick fetches for itself — this reloader has no free ride from checkFreshness");
});

test("dedicatedTargetPlanReloader: a THROWING fetch propagates — the SAME generic daemon.plan_reload_failed catch planReloader already relies on, never a swallowed error here", () => {
  const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: "/x" }, () => {}, {
    fetch: () => {
      throw new Error("git fetch origin failed");
    },
    treeSha: () => "s",
  })!;
  assert.throws(() => r(), /git fetch origin failed/);
});

test("dedicatedTargetPlanReloader: resets the WORKING TREE before parsing — a fetched origin/main ref alone is not enough", () => {
  // THE BUG THIS PINS: `load` is a plain filesystem read of `target.planPath`, never a `git show
  // <ref>:<path>`. A self target gets away with reading a possibly-stale working tree because the
  // deploy supervisor restarts the whole process on any main move (see the function's own doc); a
  // dedicated non-self daemon has no such restart, so `resetWorkingTree` MUST run — and run AFTER
  // `fetch`/`treeSha`, BEFORE `load` — or a genuine origin/main move would silently re-parse the
  // SAME stale content forever, which is worse than never reloading at all: it would look fixed.
  const order: string[] = [];
  let sha = "sha-1";
  const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: "/x" }, () => {}, {
    fetch: () => order.push("fetch"),
    treeSha: () => {
      order.push("treeSha");
      return sha;
    },
    resetWorkingTree: () => order.push("resetWorkingTree"),
    load: () => {
      order.push("load");
      return { tasks: [] } as unknown as Plan;
    },
  })!;
  r(); // first tick: records the boot sha
  assert.deepEqual(order, ["fetch", "treeSha"], "no reset and no parse on the boot-recording tick");
  order.length = 0;
  r(); // unchanged
  assert.deepEqual(order, ["fetch", "treeSha"], "an unchanged tick resets nothing — only a genuine move earns the cost");
  order.length = 0;
  sha = "sha-2";
  r(); // genuine move
  assert.deepEqual(
    order,
    ["fetch", "treeSha", "resetWorkingTree", "load"],
    "a genuine move fetches, detects it, resets the checkout to origin/main, THEN parses — in that order",
  );
});

// ── W1-T3554 acceptance 2: a merged non-self target plan change flips dispatch eligibility ─────
// WITHOUT a manual restart. Mirrors test/daemon-plan-freshness.test.ts's "impl-FZ: a task filed
// ON DISK during a boot becomes visible within that same boot" exactly, one directory over: the
// reloader under test here is `dedicatedTargetPlanReloader`, not a hand-rolled disk reloader.

function taskYaml(ids: string[]): string {
  return ids
    .map((id) => `- id: ${id}\n  title: task ${id}\n  repo: remudero-console\n  type: implement\n  depends_on: []\n  status: queued\n`)
    .join("");
}

test("W1-T3554 acceptance 2: a target plan change merged to origin/main changes dispatch eligibility on the running daemon, with no restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-target-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, taskYaml(["A"]));

  // "origin/main" here is a plain string sha stand-in — the git plumbing itself is proven by the
  // REAL DEFAULT test below; this test proves the CONSEQUENCE (dispatch eligibility) through the
  // real runDaemon loop, exactly as impl-FZ's own tests do for the self-target arm.
  let originSha = "boot-sha";
  const reloadPlan = dedicatedTargetPlanReloader({ isSelf: false, planPath }, () => {}, {
    fetch: () => {},
    treeSha: () => originSha,
    // No-op: this test's "origin/main" is a plain sha stand-in, so there is no real checkout to
    // reset — the REAL DEFAULT test below proves the genuine `git reset --hard` default works.
    resetWorkingTree: () => {},
    load: (pp) => loadPlan(pp),
  })!;

  const merged = new Set<string>();
  const ran: string[] = [];
  let ticks = 0;
  const s = await runDaemon(
    loadPlan(planPath),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      reloadPlan,
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        // THE MERGE, on origin/main — an operator resolving a gate or filing a task, exactly like
        // the CONSOLE-T1 scenario this task's rationale reports.
        if (ran.length === 1) {
          writeFileSync(planPath, taskYaml(["A", "B-MERGED-TO-TARGET-PLAN"]));
          originSha = "new-sha";
        }
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2 },
  );
  assert.ok(ran.includes("A"), "the boot-time task still dispatches");
  assert.ok(
    ran.includes("B-MERGED-TO-TARGET-PLAN"),
    `a task merged to the target's origin/main mid-boot must dispatch in the SAME boot, with no restart — saw ${JSON.stringify(ran)}`,
  );
  assert.deepEqual(s.merged, ran);
  rmSync(dir, { recursive: true, force: true });
});

// ── W1-T3554 acceptance 3: never fires mid-batch ────────────────────────────────────────────
// Mirrors "impl-FZ: a tick sees ONE consistent plan even if the file changes mid-tick" exactly —
// the reload is observed ONLY at the top of a tick (runDaemon's own placement, lib/daemon.ts),
// so a target-plan rewrite while a worker is in flight cannot change what that same tick decides.

test("W1-T3554 acceptance 3: the reload is observed only BETWEEN workers, never mid-batch", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-batch-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, taskYaml(["A"]));
  let sha = "boot-sha";
  const observed: number[] = [];
  const reloadPlan = dedicatedTargetPlanReloader({ isSelf: false, planPath }, () => {}, {
    fetch: () => {},
    treeSha: () => sha,
    resetWorkingTree: () => {},
    load: (pp) => {
      const pl = loadPlan(pp);
      observed.push(pl.tasks.length);
      return pl;
    },
  })!;

  const merged = new Set<string>();
  let ticks = 0;
  await runDaemon(
    loadPlan(planPath),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      reloadPlan,
      runOne: async (id: string) => {
        merged.add(id);
        // Mutate the TARGET's origin/main mid-tick, while this worker is "in flight" — the
        // reloader must not observe this until the NEXT top-of-tick call.
        writeFileSync(planPath, taskYaml(["A", "X1", "X2", "X3"]));
        sha = "mid-batch-sha";
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2 },
  );
  assert.ok(observed.length >= 1, `the reloader ran at least once — got ${JSON.stringify(observed)}`);
  assert.ok(
    observed[0] >= 4,
    "the reload it DID observe already reflects the full 4-task rewrite — proving no tick straddled a partial mid-batch state",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── THE REAL DEFAULT: no injection, against a real git repo with a real origin remote ─────────
// Mirrors "planReloader REAL DEFAULT: resolves the plan tree sha from the checkout, not the cwd"
// exactly — the gap that let the self-target `-C` bug ship in the first place. This is the ONE
// difference from that precedent: this reloader ALSO fetches (see its own doc for why), so the
// test proves the fetch really does pick up a commit pushed to a real local "origin" remote AFTER
// boot, never merely a working-tree edit.

test("dedicatedTargetPlanReloader REAL DEFAULT: fetches origin and resolves the plan tree sha from the checkout, not the cwd", () => {
  const bareDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-bare-`));
  const workDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-work-`));
  const cloneDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-clone-`));
  const g = (root: string, ...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const prevCwd = process.cwd();
  try {
    // The "origin": an independent bare repo, fetched over a real (local) transport — proving the
    // reloader's own `git fetch` is what picks up the change, not a shared working tree.
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareDir], { encoding: "utf8" });

    g(workDir, "init", "-q", "-b", "main");
    g(workDir, "config", "user.email", "t@t");
    g(workDir, "config", "user.name", "t");
    mkdirSync(join(workDir, "plan"), { recursive: true });
    writeFileSync(join(workDir, "plan", "tasks.yaml"), "- id: A\n  title: a\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n");
    g(workDir, "add", "-A");
    g(workDir, "commit", "-q", "-m", "seed");
    g(workDir, "remote", "add", "origin", bareDir);
    g(workDir, "push", "-q", "origin", "main");

    // The daemon's own checkout of the target — cloned from the SAME "origin" the test pushes to.
    rmSync(cloneDir, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", bareDir, cloneDir], { encoding: "utf8" });

    // Run from a directory that is NOT a git repo — exactly the daemon's situation.
    const outside = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-outside-`));
    process.chdir(outside);

    const r = dedicatedTargetPlanReloader({ isSelf: false, planPath: join(cloneDir, "plan", "tasks.yaml") }, () => {})!;
    assert.ok(r, "a non-self dedicated target gets a reloader");
    assert.equal(r(), null, "first tick records the boot sha without reporting a reload");
    assert.equal(r(), null, "unchanged tree ⇒ still null, and crucially NO THROW");

    // Push a plan change to the TARGET's origin/main from the SEPARATE working checkout — never
    // touching the daemon's own clone directly, exactly like a merged PR would.
    writeFileSync(
      join(workDir, "plan", "tasks.yaml"),
      "- id: A\n  title: a\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n- id: B-NEW\n  title: b\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n",
    );
    g(workDir, "add", "-A");
    g(workDir, "commit", "-q", "-m", "filed");
    g(workDir, "push", "-q", "origin", "main");

    const fresh = r();
    assert.ok(fresh, "a moved target plan tree yields a reload, picked up by the reloader's OWN fetch");
    assert.deepEqual(fresh!.tasks.map((t) => t.id), ["A", "B-NEW"], "and it is the NEW plan");
    rmSync(outside, { recursive: true, force: true });
  } finally {
    process.chdir(prevCwd);
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

// ── REACHABILITY: the production wiring, not just the helper ───────────────────────────────
// Every test above drives the reloader (or runDaemon) directly, so all of them would still pass
// if `daemonCommand` never handed `dedicatedTargetPlanReloader` to the real loop for a non-self
// target. Mirrors test/daemon-plan-freshness.test.ts's own "REACHABILITY: daemonCommand hands a
// reloadPlan to the loop" test, one directory over: a REAL non-self target, pre-seeded as a real
// git checkout with a real local "origin" so boot's own git-sync succeeds with no network.

test("W1-T3554 REACHABILITY: daemonCommand wires dedicatedTargetPlanReloader (not planReloader) for a non-self --repo target with no explicit --plan", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-wiring-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });

  const bareDir = join(home, "target-origin.git");
  const targetRepoDir = join(root, "repos", "dedicated-target-repo");
  const g = (repoRoot: string, ...a: string[]) => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareDir], { encoding: "utf8" });

  const seedDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3554-seed-`));
  g(seedDir, "init", "-q", "-b", "main");
  g(seedDir, "config", "user.email", "t@t");
  g(seedDir, "config", "user.name", "t");
  mkdirSync(join(seedDir, "plan"), { recursive: true });
  writeFileSync(join(seedDir, "plan", "tasks.yaml"), "[]\n");
  g(seedDir, "add", "-A");
  g(seedDir, "commit", "-q", "-m", "seed");
  g(seedDir, "remote", "add", "origin", bareDir);
  g(seedDir, "push", "-q", "origin", "main");

  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", bareDir, targetRepoDir], { encoding: "utf8" });

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await (daemonCommand as unknown as (a: string[], d: unknown) => Promise<number>)(
      ["--repo", "dedicated-target-repo", "--max", "0"],
      {
        runDaemon: async (_plan: unknown, deps: DaemonDeps) => {
          captured = deps;
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
        },
      },
    );
  } finally {
    process.env.HOME = prevHome;
  }
  assert.ok(captured, "runDaemon was reached and its deps captured");
  assert.equal(typeof captured!.reloadPlan, "function", "a non-self dedicated target must NOT be frozen-at-boot");
  // Distinguishes WHICH reloader was wired: a bare `planReloader({isSelf:false}, …)` always
  // returns `undefined` (test/daemon-plan-freshness.test.ts's own regression lock), so a defined
  // function here can only be `dedicatedTargetPlanReloader`'s — proving the wiring branch, not
  // merely that SOME function was supplied.
  assert.equal(
    planReloader({ isSelf: false, planPath: "/x" }, false, () => {}),
    undefined,
    "sanity: planReloader itself still refuses a non-self target",
  );
  rmSync(home, { recursive: true, force: true });
  rmSync(bareDir, { recursive: true, force: true });
  rmSync(seedDir, { recursive: true, force: true });
});
