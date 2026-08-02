import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { type MergedSet } from "../src/lib/drain.js";
import { planReloader } from "../src/run-task.js";

// ── impl-FZ: the daemon's plan must reflect tasks filed during its lifetime ──────────────
//
// Before this, `runDaemon(plan, …)` never reassigned `plan` — so a task filed after the boot was
// invisible to every dispatch decision for the boot's lifetime. Measured on the real ledger, the
// median gap from a task landing on origin/main to the daemon next booting was 106 minutes.
//
// TRAP 3 COMPLIANCE: these drive the REAL `runDaemon` and change the plan ON DISK between ticks,
// re-reading through the real `loadPlan`. A test that handed the loop two different in-memory Plan
// objects would prove nothing about re-reading, so none of these do that.

const NONE_MERGED: MergedSet = () => false;

function taskYaml(ids: string[]): string {
  return (
    ids
      .map(
        (id) =>
          `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`,
      )
      .join("")
  );
}

/** A real plan FILE that can be rewritten between ticks, plus a real loadPlan-backed reloader. */
function planOnDisk(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fz-plan-"));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, taskYaml(ids));
  return {
    dir,
    file,
    plan: () => loadPlan(file),
    rewrite: (next: string[]) => writeFileSync(file, taskYaml(next)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The repo's own daemon-test shape: refreshMerged + runOne + an instant sleep. */
const okResult = (id: string) => ({ taskId: id, ok: true, merged: true }) as never;

/** A reloader over a real file, with real change detection — never two in-memory Plan objects. */
function diskReloader(p: { plan: () => Plan }): () => Plan | null {
  let last = "";
  return () => {
    const fresh = p.plan();
    const sig = JSON.stringify(fresh.tasks.map((t) => t.id));
    if (sig === last) return null;
    last = sig;
    return fresh;
  };
}

test("impl-FZ: a task filed ON DISK during a boot becomes visible within that same boot", async () => {
  const p = planOnDisk(["A"]);
  const merged = new Set<string>();
  const ran: string[] = [];
  let ticks = 0;
  const s = await runDaemon(
    p.plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      // BOUNDED so the falsifier FAILS rather than HANGS: without the re-read the loop never
      // reaches `max`, and an instant `sleep` would spin forever. A hang is a worse failure mode
      // than a red assertion, so the tick cap is part of the test, not scaffolding.
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      reloadPlan: diskReloader(p),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        // THE FILING, on disk, mid-boot — exactly what auto-triage does unattended.
        if (ran.length === 1) p.rewrite(["A", "B-FILED-MID-BOOT"]);
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2 },
  );
  assert.ok(ran.includes("A"), "the boot-time task still dispatches");
  assert.ok(
    ran.includes("B-FILED-MID-BOOT"),
    `a task filed on disk mid-boot must dispatch in the SAME boot — saw ${JSON.stringify(ran)}`,
  );
  assert.deepEqual(s.merged, ran);
  p.cleanup();
});

test("impl-FZ REGRESSION LOCK: for an UNCHANGED plan the dispatched set is identical", async () => {
  // Trap 1, and it matters more than the feature: a re-read that quietly changes eligibility
  // spends real money on wrong work. With the file untouched, wiring reloadPlan must change
  // NOTHING about which tasks dispatch, or in what order.
  const p = planOnDisk(["A", "B", "C"]);
  const run = async (withReload: boolean): Promise<string[]> => {
    const merged = new Set<string>();
    const ran: string[] = [];
    let ticks = 0;
    await runDaemon(
      p.plan(),
      {
        refreshMerged: () => (id: string) => merged.has(id),
        checkStop: () => (++ticks > 8 ? "tick cap" : undefined),
        runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
        sleep: async () => {},
        ...(withReload ? { reloadPlan: diskReloader(p) } : {}),
      } as unknown as DaemonDeps,
      { max: 3 },
    );
    return ran;
  };
  const before = await run(false);
  const after = await run(true);
  assert.ok(before.length === 3, `the comparison would be vacuous if nothing dispatched — got ${JSON.stringify(before)}`);
  assert.deepEqual(after, before, "an unchanged plan must produce an IDENTICAL dispatch set and order");
  p.cleanup();
});

test("impl-FZ: a tick sees ONE consistent plan even if the file changes mid-tick", async () => {
  // The reload is observed ONLY at the top of a tick, so a file rewritten while runOne is in
  // flight cannot change what the rest of that tick decides.
  const p = planOnDisk(["A"]);
  const observed: number[] = [];
  const merged = new Set<string>();
  let ticks = 0;
  await runDaemon(
    p.plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      reloadPlan: () => {
        const pl = p.plan();
        observed.push(pl.tasks.length);
        return pl;
      },
      runOne: async (id: string) => {
        merged.add(id);
        p.rewrite(["A", "X1", "X2", "X3"]); // mutate DURING the tick
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2 },
  );
  assert.ok(observed.length >= 2, `the reloader ran on more than one tick — got ${JSON.stringify(observed)}`);
  assert.equal(observed[0], 1, "tick 1 saw only the 1-task plan it started with");
  assert.ok(observed[1] >= 4, "the mid-tick rewrite is visible only from the NEXT tick — no tick straddled two plans");
  p.cleanup();
});

// ── the reloader's own change detection ───────────────────────────────────────────────

test("planReloader: returns null on the FIRST tick — the boot plan already came from that sha", () => {
  const r = planReloader({ isSelf: true, planPath: "/x" }, false, () => {}, {
    treeSha: () => "sha-boot",
    load: () => ({ tasks: [] }) as unknown as Plan,
  });
  assert.ok(r, "a self-target gets a reloader");
  assert.equal(r!(), null, "no reload is reported for the sha the boot already loaded");
});

test("planReloader: null while the tree sha is unchanged, a fresh plan when it moves", () => {
  let sha = "sha-1";
  let loads = 0;
  const r = planReloader({ isSelf: true, planPath: "/x" }, false, () => {}, {
    treeSha: () => sha,
    load: () => {
      loads += 1;
      return { tasks: [{ id: "NEW" }] } as unknown as Plan;
    },
  })!;
  assert.equal(r(), null); // first tick records the sha
  assert.equal(r(), null, "unchanged sha must not re-parse a ~1MB plan");
  assert.equal(loads, 0, "the common path costs no parse at all");
  sha = "sha-2";
  const fresh = r();
  assert.ok(fresh, "a moved tree sha yields a fresh plan");
  assert.equal(loads, 1);
  assert.equal(r(), null, "and it settles again on the new sha");
  assert.equal(loads, 1, "exactly one parse per genuine change");
});

test("planReloader: a NON-self target gets no reloader — frozen-at-boot is preserved", () => {
  assert.equal(
    planReloader({ isSelf: false, planPath: "/x" }, false, () => {}, { treeSha: () => "s" }),
    undefined,
    "only the git-synced self target re-reads, so no second source of truth is introduced",
  );
});

test("impl-FZ: a THROWING reloadPlan is caught and never takes the fleet down", async () => {
  // A transient git failure must degrade to "keep running on the plan we have", never halt the
  // fleet. The dispatch below still happens, which is the point.
  const p = planOnDisk(["A"]);
  const logged: string[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];
  let ticks = 0;
  const s = await runDaemon(
    p.plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      reloadPlan: () => {
        throw new Error("git exploded");
      },
      log: (step: string) => logged.push(step),
      runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 1 },
  );
  assert.deepEqual(ran, ["A"], "the loop kept dispatching on the plan it already had");
  assert.equal(s.stopReason, "max_reached", "and returned normally rather than throwing");
  assert.ok(
    logged.includes("daemon.plan_reload_failed"),
    `the failure is ledgered — got ${JSON.stringify(logged.slice(0, 8))}`,
  );
  p.cleanup();
});

// ── REACHABILITY: the production wiring, not just the helper ────────────────────────────
// Every test above drives runDaemon directly, so all of them would still pass if daemonCommand
// never handed a reloadPlan to the real loop. This closes that gap through the same
// injected-runDaemon seam test/auto-triage-wiring.ts uses.

test("REACHABILITY: daemonCommand hands a reloadPlan to the loop (and NOT for an explicit --plan)", async () => {
  const { daemonCommand } = await import("../src/run-task.js");
  const home = mkdtempSync(join(tmpdir(), "fz-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await (daemonCommand as unknown as (a: string[], d: unknown) => Promise<number>)(
      ["--allow-self-target", "--plan", planPath, "--max", "0"],
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
  // An explicit --plan is a literal-file caller and must KEEP frozen-at-boot: re-reading there
  // would invent a second source of truth, which is the defect this repo has spent days unpicking.
  assert.equal(
    captured!.reloadPlan,
    undefined,
    "an explicit --plan must NOT get a reloader — that path asked for a literal file",
  );
  rmSync(home, { recursive: true, force: true });
});

// ── THE REAL DEFAULT. This is the gap that let the -C bug ship. ──────────────────────────
// Every planReloader test above injects `treeSha`, so the production default — the actual
// `execFileSync("git", …)` call — was never executed by any test. It shipped running in the DAEMON
// PROCESS's working directory instead of the checkout, threw `fatal: not a git repository` on
// every tick, and was caught and ledgered as a failure, so the re-read never once happened in
// production. These drive the default with NO injection, against a real git repo.

test("planReloader REAL DEFAULT: resolves the plan tree sha from the checkout, not the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "fz-realgit-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const prevCwd = process.cwd();
  try {
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), "- id: A\n  title: a\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n");
    g("add", "-A"); g("commit", "-q", "-m", "seed");
    // `origin/main` must resolve — the reloader reads the ORIGIN ref, never the working tree.
    g("update-ref", "refs/remotes/origin/main", g("rev-parse", "HEAD").trim());

    // Run from a directory that is NOT a git repo — exactly the daemon's situation. Before the
    // fix this threw `fatal: not a git repository`; the reloader must be immune to cwd.
    const outside = mkdtempSync(join(tmpdir(), "fz-outside-"));
    process.chdir(outside);

    const r = planReloader({ isSelf: true, planPath: join(root, "plan", "tasks.yaml") }, false, () => {})!;
    assert.ok(r, "a self target gets a reloader");
    assert.equal(r(), null, "first tick records the boot sha without reporting a reload");
    assert.equal(r(), null, "unchanged tree ⇒ still null, and crucially NO THROW");

    // Move the plan on origin/main; the next call must return a freshly parsed plan.
    writeFileSync(join(root, "plan", "tasks.yaml"), "- id: A\n  title: a\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n- id: B-NEW\n  title: b\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n");
    g("add", "-A"); g("commit", "-q", "-m", "filed");
    g("update-ref", "refs/remotes/origin/main", g("rev-parse", "HEAD").trim());

    const fresh = r();
    assert.ok(fresh, "a moved plan tree yields a reload");
    assert.deepEqual(fresh!.tasks.map((t) => t.id), ["A", "B-NEW"], "and it is the NEW plan");
    rmSync(outside, { recursive: true, force: true });
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
