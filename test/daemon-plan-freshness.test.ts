import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonOpts } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { type MergedSet } from "../src/lib/drain.js";
import { planReloader } from "../src/run-task.js";
import { reasonAboutBlock, INITIAL_RETRY_STATE } from "../src/lib/block-reason.js";

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

// ── W1-T340: one plan snapshot per dispatch batch ─────────────────────────────────────
//
// `runDaemon` reloads the plan at most once per tick, at the TOP, before any dispatch decision.
// Everything below that point in the tick — the kick check, `nextRunnable`'s selection,
// `reasonAboutBlock`'s post-hoc judgment of whatever `runOne` returned — is now threaded through
// ONE `const planForBatch`, captured immediately after the reload settles, rather than each
// reading the mutable `plan` binding by name. `plan = fresh` reassigns that binding, not the Plan
// object itself, so at N=1 (today: one lane, one dispatch per tick) this makes no observable
// difference — nothing else in the tick body ever reassigns `plan`, so a bare read and a `const`
// snapshot always resolve to the identical object. The distinction becomes load-bearing the moment
// a batch holds more than one lane (W1-T343, out of scope here): a lane whose OWN later reasoning
// closed over `plan` by name would be judged against whatever the MOST RECENT reload produced,
// never necessarily the blob it was actually dispatched under.

test("W1-T340: a task's own post-hoc block judgment is judged against the SAME plan it was dispatched under, even though a mid-tick rewrite is real and detectable", async () => {
  // X has a genuine dependent, D, in the plan this tick dispatches from. `runOne` rewrites the
  // plan ON DISK — dropping D's dependency on X — DURING its own execution, and the reloader below
  // uses REAL content-hash change detection (mirrors `diskReloader` above), so that rewrite is not
  // vacuous: a reload consulted AFTER it would genuinely see X as dependent-free. The daemon must
  // still classify X as a GENUINE BLOCKER (dependents: ["D"]) — the value `reasonAboutBlock` is
  // judged against is the batch's OWN captured snapshot, taken before `runOne` ran, never a later
  // read of the (by-then-stale) live binding. This is exactly what "do not move the reload, do not
  // add a read barrier" (W1-T340's design) rules out as the fix: the invariant must hold from the
  // ORIGINAL top-of-tick reload alone.
  const dir = mkdtempSync(join(tmpdir(), "w1t340-batch-"));
  const file = join(dir, "tasks.yaml");
  const withDependent =
    "- id: X\n  title: x\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n" +
    "- id: D\n  title: d\n  repo: r\n  type: implement\n  depends_on: [X]\n  status: queued\n";
  const withoutDependent =
    "- id: X\n  title: x\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n" +
    "- id: D\n  title: d\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n";
  writeFileSync(file, withDependent);

  let last = "";
  const reloadPlan = (): Plan | null => {
    const fresh = loadPlan(file);
    const sig = JSON.stringify(fresh.tasks.map((t) => [t.id, t.depends_on]));
    if (sig === last) return null;
    last = sig;
    return fresh;
  };

  const merged = new Set<string>();
  let ticks = 0;
  const s = await runDaemon(
    loadPlan(file),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 3 ? "tick cap" : undefined),
      reloadPlan,
      runOne: async (id: string) => {
        // THE MID-TICK REWRITE. Real, on-disk, and the reloader above would genuinely observe it
        // — proven by the next test in this section, which drives the SAME reloader twice back to
        // back and shows the second call really does return a fresh, dependent-free plan.
        writeFileSync(file, withoutDependent);
        return { taskId: id, runId: "r1", merged: false, costUsd: 0, verdict: "blocked" } as never;
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 1 },
  );
  assert.equal(s.stopReason, "blocked", `expected a genuine-blocker halt, got ${JSON.stringify(s)}`);
  assert.ok(
    s.stopDetail?.includes("blocks D"),
    `X must still be judged as blocking D — its OWN batch's snapshot, not the rewritten plan — got ${s.stopDetail}`,
  );
});

test("W1-T340 FALSIFIER: reading a live/reloaded binding instead of the batch's own snapshot silently flips the verdict", () => {
  // This is the "must fail against a mutable-binding implementation" proof the design note asks
  // for, driven directly against an injected `reloadPlan` seam (disclosed per the design note's own
  // allowance) rather than through `runDaemon` itself: today's loop is still N=1, one dispatch per
  // tick, so it cannot by itself manifest two decisions straddling a reload — that hazard only
  // becomes REACHABLE once a batch holds more than one lane (W1-T343). What IS provable today,
  // without lanes, is the consequence: given the exact two plan blobs one lane's dispatch and a
  // LATER, mid-batch reload would produce, judging that lane's own post-hoc reasoning against its
  // OWN captured snapshot (the fix `runDaemon` now applies, `const planForBatch`) and against the
  // live/reloaded value (the bug a bare `plan` read reproduces) must disagree — otherwise the
  // snapshot buys nothing and this whole task is a no-op.
  const dir = mkdtempSync(join(tmpdir(), "w1t340-seam-"));
  const file = join(dir, "tasks.yaml");
  const withDependent =
    "- id: X\n  title: x\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n" +
    "- id: D\n  title: d\n  repo: r\n  type: implement\n  depends_on: [X]\n  status: queued\n";
  writeFileSync(file, withDependent);

  let last = "";
  const reloadPlan = (): Plan | null => {
    const fresh = loadPlan(file);
    const sig = JSON.stringify(fresh.tasks.map((t) => [t.id, t.depends_on]));
    if (sig === last) return null;
    last = sig;
    return fresh;
  };

  // Lane A's own batch snapshot — captured ONCE, at dispatch time, exactly as `const planForBatch`
  // does in `runDaemon`.
  const planForBatch = reloadPlan();
  assert.ok(planForBatch, "the first reload is never null — it is this batch's boot plan");

  // A reload "lands mid-batch": a sibling lane's own batch resolving (the N>1 case this task
  // exists for), or — proven immediately above — the SAME rewrite `runOne` performs mid-tick,
  // consulted a tick too early by a hypothetical "read barrier" implementation.
  writeFileSync(
    file,
    "- id: X\n  title: x\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n" +
      "- id: D\n  title: d\n  repo: r\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  const liveBinding = reloadPlan();
  assert.ok(liveBinding, "the mid-batch reload really did observe a change — not a vacuous rewrite");
  assert.notEqual(liveBinding, planForBatch, "and it is a genuinely different Plan object");

  const fixed = reasonAboutBlock(planForBatch!, "X", "blocked", INITIAL_RETRY_STATE);
  assert.equal(
    fixed.kind,
    "genuine_blocker",
    "judged against its OWN batch snapshot, X still names D as a dependent",
  );

  const buggy = reasonAboutBlock(liveBinding!, "X", "blocked", INITIAL_RETRY_STATE);
  assert.equal(
    buggy.kind,
    "independent_failure",
    "…and THIS is the silent divergence a mutable-binding (re-)read produces — proving the snapshot " +
      "is load-bearing, not a no-op",
  );
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

// ── W1-T331 acceptance 2: the daily cost ceiling is snapshotted ONCE PER TICK, at the SAME
// placement as the plan reload immediately above, and threaded through the tick — so two
// consultations within one tick can never disagree. Mirrors every "impl-FZ" test above exactly:
// same placement argument, same "REAL disk read, never two in-memory numbers" TRAP 3 discipline.

/** A real ceiling FILE that can be rewritten between ticks, plus a real disk-backed reader —
 *  mirrors `planOnDisk` above (a genuine `readFileSync` per call, never two in-memory numbers). */
function ceilingOnDisk(initial: number) {
  const dir = mkdtempSync(join(tmpdir(), "fz-ceiling-"));
  const file = join(dir, "ceiling.txt");
  writeFileSync(file, String(initial));
  return {
    dir,
    file,
    read: (): number => Number(readFileSync(file, "utf8")),
    rewrite: (next: number) => writeFileSync(file, String(next)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("W1-T331: a tick sees ONE consistent cost ceiling even if the policy value changes mid-tick", async () => {
  // W1-T342: the governor is now consulted TWICE per DISPATCHING tick — once tick-wide (before
  // retro/auto-triage/kicks/`nextRunnable`) and once again immediately before `runOne`, so a
  // future multi-lane batch can re-check per lane (see daemon.ts's `checkDispatchGovernors`
  // doc). Both consultations within the SAME tick must still agree — that is exactly what this
  // test proves. Two tasks (never one) keep BOTH ticks dispatching — with only one task, tick 2
  // goes idle the instant tick 1 merges it, and an idle tick makes no per-dispatch consultation
  // at all (there is nothing to dispatch), which would silently drop this test's tick-2 sample.
  const p = planOnDisk(["A", "B"]);
  const c = ceilingOnDisk(100);
  const merged = new Set<string>();
  const receivedByGovernor: Array<number | undefined> = [];
  let ticks = 0;
  await runDaemon(
    p.plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 2 ? "tick cap" : undefined),
      reloadDailyCostCeilingUsd: c.read,
      checkCostGovernor: (ceilingUsd?: number) => {
        receivedByGovernor.push(ceilingUsd);
        return undefined; // never defer — this test only observes WHAT ceiling was threaded in
      },
      runOne: async (id: string) => {
        merged.add(id);
        c.rewrite(999); // mutate the file DURING the tick's dispatch
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
  );
  assert.ok(
    receivedByGovernor.length >= 4,
    `expected 2 dispatching ticks x 2 consultations each — got ${JSON.stringify(receivedByGovernor)}`,
  );
  assert.deepEqual(
    receivedByGovernor.slice(0, 2),
    [100, 100],
    "tick 1's BOTH consultations saw the ceiling reloaded at the TOP of tick 1, before runOne ran",
  );
  assert.ok(
    receivedByGovernor.slice(2, 4).every((v) => v! >= 999),
    "the mid-tick rewrite is visible only from the NEXT tick's reload — no tick straddled two ceilings",
  );
  p.cleanup();
  c.cleanup();
});

test("W1-T331: a THROWING reloadDailyCostCeilingUsd is caught and never takes the fleet down", async () => {
  // Mirrors "impl-FZ: a THROWING reloadPlan is caught…" above exactly, for the ceiling reload.
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
      reloadDailyCostCeilingUsd: () => {
        throw new Error("plan/policy.yaml exploded");
      },
      log: (step: string) => logged.push(step),
      runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 1 },
  );
  assert.deepEqual(ran, ["A"], "the loop kept dispatching despite the ceiling reload failing");
  assert.equal(s.stopReason, "max_reached", "and returned normally rather than throwing");
  assert.ok(
    logged.includes("daemon.cost_ceiling_reload_failed"),
    `the failure is ledgered — got ${JSON.stringify(logged.slice(0, 8))}`,
  );
  p.cleanup();
});

// ── W1-T342 acceptance 3: a governed batch still defers as an in-process heartbeat and resumes
// on its own, never aborting the daemon or escalating. Mirrors the THROWING reloadDailyCostCeilingUsd
// test immediately above exactly, one layer further in: here it is `checkCostGovernor` ITSELF
// throwing (an unreadable observation, design (iv)) rather than the ceiling reload — proving the
// NEW fail-closed wrapping (`checkDispatchGovernors`, daemon.ts) degrades exactly like every
// other per-tick consultation in this loop, never propagating out and crashing the process the
// way a bare (pre-W1-T342) call used to.

test("W1-T342 acceptance 3: a THROWING checkCostGovernor fails CLOSED as an in-process heartbeat — never aborts the daemon, and resumes dispatch on its own once readable again", async () => {
  const p = planOnDisk(["A"]);
  const logged: string[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];
  let calls = 0;
  const s = await runDaemon(
    p.plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      // Terminates the otherwise-infinite loop right after the one real dispatch happens — the
      // SAME idiom the existing "runDaemon IDLES … dispatches the SAME real task" tests use.
      checkStop: () => (ran.length > 0 ? "test done" : undefined),
      checkCostGovernor: () => {
        calls++;
        // The first two consultations (this test's tick-wide AND per-dispatch call sites both
        // route through the SAME seam) are unreadable; the third recovers.
        if (calls <= 2) throw new Error("ledger read failed");
        return undefined;
      },
      log: (step: string) => logged.push(step),
      runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: async () => {},
    } as unknown as DaemonDeps,
  );
  assert.equal(s.stopReason, "stopped", "the throw never aborted or crashed the loop — it returned normally");
  assert.deepEqual(ran, ["A"], "dispatch resumed on its own the moment the governor stopped throwing");
  assert.ok(
    logged.filter((step) => step === "daemon.governor_check_failed").length >= 2,
    `each throw is ledgered as a heartbeat, never silently swallowed — got ${JSON.stringify(logged)}`,
  );
  assert.ok(
    !logged.includes("daemon.escalation.failed") && !logged.some((step) => step.includes("escalat")),
    "a governor fail-closed heartbeat is never an escalation — same discipline as a confirmed-over-ceiling deferral",
  );
  p.cleanup();
});

test("W1-T331 REACHABILITY: daemonCommand hands a reloadDailyCostCeilingUsd to the loop", async () => {
  const { daemonCommand } = await import("../src/run-task.js");
  const home = mkdtempSync(join(tmpdir(), "fz-ceiling-wiring-"));
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
  assert.equal(
    typeof captured!.reloadDailyCostCeilingUsd,
    "function",
    "daemonCommand must wire a live per-tick cost-ceiling reloader",
  );
  // Reads THIS checkout's real plan/policy.yaml (repoRoot-scoped, never config.root) — a genuine
  // number, proving it is a live read rather than a stub returning some fixed literal.
  assert.equal(typeof captured!.reloadDailyCostCeilingUsd!(), "number");
  rmSync(home, { recursive: true, force: true });
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

// ── recon-GM: the liveness heartbeat ────────────────────────────────────────────────
// `daemon.plan_reloaded` is legitimately 0 in production — the deploy supervisor restarts the
// daemon on any main move, so a plan change lands a fresh boot (+0.7min, +0.5min measured) before
// the next tick could observe a difference. But a zero could not be told apart from "never ran".
// Failures were already visible; success was not. These pin the signal that closes that gap.

test("recon-GM: the probe emits ONE liveness heartbeat per boot, carrying the plan tree sha", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const r = planReloader({ isSelf: true, planPath: "/x/plan/tasks.yaml" }, false,
    (step, extra) => logged.push({ step, extra }),
    { treeSha: () => "abcdef1234567890", load: () => ({ tasks: [] }) as unknown as Plan })!;

  assert.equal(r(), null, "first tick reloads nothing — the boot plan already came from this sha");
  const hb = logged.filter((l) => l.step === "daemon.plan_unchanged");
  assert.equal(hb.length, 1, "exactly one heartbeat on the first tick");
  assert.equal(hb[0].extra?.tree_sha, "abcdef123456", "it records WHICH plan the boot is pinned to");
});

test("recon-GM: the heartbeat is BOUNDED — repeated unchanged ticks do not re-emit", () => {
  // ~1,440 rows/day of "nothing happened" is the noise that gets a signal ignored. One per boot.
  const logged: string[] = [];
  const r = planReloader({ isSelf: true, planPath: "/x/plan/tasks.yaml" }, false,
    (step) => logged.push(step),
    { treeSha: () => "samesha0000", load: () => ({ tasks: [] }) as unknown as Plan })!;
  for (let i = 0; i < 25; i++) assert.equal(r(), null);
  assert.equal(
    logged.filter((s) => s === "daemon.plan_unchanged").length,
    1,
    "25 unchanged ticks must still produce exactly ONE heartbeat",
  );
});

test("recon-GM: a real change still reports plan_changed, and does not re-emit the heartbeat", () => {
  const logged: string[] = [];
  let sha = "first000000";
  const r = planReloader({ isSelf: true, planPath: "/x/plan/tasks.yaml" }, false,
    (step) => logged.push(step),
    { treeSha: () => sha, load: () => ({ tasks: [{ id: "NEW" }] }) as unknown as Plan })!;
  assert.equal(r(), null);
  sha = "second00000";
  assert.ok(r(), "a moved tree sha still yields a reload");
  assert.deepEqual(logged, ["daemon.plan_unchanged", "daemon.plan_changed"],
    "heartbeat once at boot, then the real change — the heartbeat never repeats");
});

// ── W1-T343: SHIP DARK — laneCount<=1 is BYTE-IDENTICAL to before this task existed ──────────
//
// The safety property that lets `runDaemon` adopt drain's lane machinery before an operator has
// raised `sweep.dispatchLanes`: at `laneCount` omitted (default 1) or explicit `1`, the tick's
// dispatch-set construction (`runnableCandidates(plan, isMerged, 1, …)` + `partitionByFileOverlap`
// on a <=1-length list) must select the SAME single task `nextRunnable` always did, and none of
// the NEW lane-only ledger steps this task adds may ever fire.

function overlappingTrioPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "fz-lane1-lock-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/shared.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/shared.ts]\n" +
      "- id: C\n  title: c\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  return loadPlan(f);
}

test("W1-T343 acceptance 1: laneCount omitted and laneCount:1 dispatch the IDENTICAL sequence, with ZERO lane-only ledger lines — even against tasks whose declared files overlap", async () => {
  const run = async (laneOpt: Pick<DaemonOpts, "laneCount">): Promise<{ ran: string[]; steps: string[] }> => {
    const merged = new Set<string>();
    const ran: string[] = [];
    const steps: string[] = [];
    let ticks = 0;
    await runDaemon(
      overlappingTrioPlan(),
      {
        refreshMerged: () => (id: string) => merged.has(id),
        checkStop: () => (++ticks > 8 ? "tick cap" : undefined),
        runOne: async (id: string) => {
          ran.push(id);
          merged.add(id);
          return okResult(id);
        },
        sleep: async () => {},
        log: (step: string) => steps.push(step),
      } as unknown as DaemonDeps,
      { max: 3, ...laneOpt },
    );
    return { ran, steps };
  };
  const omitted = await run({});
  const explicit1 = await run({ laneCount: 1 });

  assert.equal(omitted.ran.length, 3, "the comparison would be vacuous if nothing dispatched");
  assert.deepEqual(explicit1.ran, omitted.ran, "laneCount omitted and laneCount:1 must dispatch the identical sequence — A, B (overlapping files:) and C (no files:) never interact at N<=1");

  const laneOnlySteps = ["dispatch.concurrent_set", "dispatch.lane_governed", "dispatch.serialized", "dispatch.wip_deferred"];
  for (const steps of [omitted.steps, explicit1.steps]) {
    for (const s of laneOnlySteps) {
      assert.ok(!steps.includes(s), `laneCount<=1 must never emit '${s}' — that ledger step did not exist before W1-T343`);
    }
  }
});

test("W1-T343 REACHABILITY: daemonCommand hands the SAME sweep.dispatchLanes/wipLimit policy row rmd drain already reads, plus an openPrCount closure, to runDaemon", async () => {
  const { daemonCommand } = await import("../src/run-task.js");
  const { DEFAULT_SWEEP_POLICY } = await import("../src/lib/sweep.js");
  const home = mkdtempSync(join(tmpdir(), "fz-lanes-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let capturedDeps: DaemonDeps | undefined;
  let capturedOpts: DaemonOpts | undefined;
  try {
    await (daemonCommand as unknown as (a: string[], d: unknown) => Promise<number>)(
      ["--allow-self-target", "--plan", planPath, "--max", "0"],
      {
        runDaemon: async (_plan: unknown, deps: DaemonDeps, opts: DaemonOpts) => {
          capturedDeps = deps;
          capturedOpts = opts;
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
        },
      },
    );
  } finally {
    process.env.HOME = prevHome;
  }
  assert.ok(capturedOpts, "runDaemon was reached and its opts captured");
  assert.equal(
    capturedOpts!.laneCount,
    DEFAULT_SWEEP_POLICY.dispatchLanes,
    "ONE threshold home (sweep.dispatchLanes) — never a second constant duplicated here",
  );
  assert.equal(capturedOpts!.wipLimit, DEFAULT_SWEEP_POLICY.wipLimit, "the SAME wipLimit row a >=2-lane batch sizes itself against");
  assert.equal(typeof capturedDeps!.openPrCount, "function", "the lane budget's other input (openPrCount) is wired too, never a second GitHub read path");
  rmSync(home, { recursive: true, force: true });
});
