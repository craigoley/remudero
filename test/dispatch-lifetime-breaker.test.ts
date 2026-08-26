import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  nextRunnable,
  runnableCandidates,
  type DrainDeps,
  type DrainSummary,
  type MergedSet,
} from "../src/lib/drain.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import {
  DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  dispatchesEver,
  dispatchesWithoutNewOwnedPr,
  isLifetimeDispatchCapExceeded,
  type GitHub,
} from "../src/lib/status.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import type { Config } from "../src/lib/config.js";
import { drainCommand, daemonCommand, escalateLifetimeCapExceeded } from "../src/run-task.js";
import { parseWhitelistedProof, narrowNameFilteredArgs } from "../src/lib/review.js";

// W1-T271 — THE LOOP THAT SUCCEEDS: dispatchesWithoutNewOwnedPr (the existing streak
// breaker) resets to 0 on every pr.opened line, so a task that re-dispatches forever
// while merging a genuine no-op PR each time (W1-T254, OBSERVED 2026-07-31: five
// dispatches in eighty minutes) never trips it. dispatchesEver / isLifetimeDispatchCapExceeded
// are the sibling, never-reset counter this task adds.

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto — mirrors
// drain.test.ts's own fixture so this file needs no shared import.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-lifetime-breaker-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;

// ── dispatchesEver: the raw counter ─────────────────────────────────────────

test("dispatchesEver: counts every run.start line for a task across its whole history", () => {
  const lines = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "OTHER", step: "run.start" }, // a different task must never contribute
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "run.start" },
  ];
  assert.equal(dispatchesEver(lines, "W1-T254"), 3);
});

test("dispatchesEver: a task never dispatched at all counts zero", () => {
  assert.equal(dispatchesEver([], "W1-T254"), 0);
});

// ── THE ACTUAL BUG THIS TASK FIXES: pr.opened must NOT reset this counter,
// unlike the existing streak counter it sits alongside ────────────────────

test("dispatchesEver: UNAFFECTED by pr.opened lines that reset the sibling streak counter to 0", () => {
  const lines = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/1" },
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/2" },
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/3" },
  ];
  // The streak breaker sees 0 (reset by the LAST pr.opened) — this is the exact
  // shape (dispatch, merge, dispatch, merge, ...) that let W1-T254 evade it.
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T254"), 0, "sanity: the streak counter IS reset by each pr.opened");
  // The lifetime counter must see all THREE run.start lines regardless.
  assert.equal(dispatchesEver(lines, "W1-T254"), 3, "the lifetime counter must survive every pr.opened line");
});

// ── isLifetimeDispatchCapExceeded ────────────────────────────────────────────

test("isLifetimeDispatchCapExceeded: trips at exactly N lifetime dispatches, not N-1, even with a pr.opened between every dispatch", () => {
  const dispatchThenMerge = (taskId: string, n: number) => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
      out.push({ task_id: taskId, step: "run.start" });
      out.push({ task_id: taskId, step: "pr.opened", pr_url: `u/${i}` });
    }
    return out;
  };
  const nMinus1 = dispatchThenMerge("W1-T254", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES - 1);
  const n = dispatchThenMerge("W1-T254", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES);
  assert.equal(isLifetimeDispatchCapExceeded(nMinus1, "W1-T254"), false, "N-1 lifetime dispatches must not trip the cap yet");
  assert.equal(isLifetimeDispatchCapExceeded(n, "W1-T254"), true, "the Nth lifetime dispatch trips it, even though every one of them opened its own PR");
  // The streak breaker, by contrast, sees this exact ledger as perpetually clear —
  // this is the whole reason the lifetime cap exists.
  assert.equal(dispatchesWithoutNewOwnedPr(n, "W1-T254"), 0, "the streak breaker alone would never trip on this shape");
});

test("isLifetimeDispatchCapExceeded: a policy-data override (rule 2) changes the cap with zero code changes", () => {
  const twoDispatches = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "run.start" },
  ];
  assert.equal(isLifetimeDispatchCapExceeded(twoDispatches, "W1-T254"), false, "under the default cap, 2 dispatches is not tripped");
  assert.equal(isLifetimeDispatchCapExceeded(twoDispatches, "W1-T254", 2), true, "an overridden cap of 2 trips at exactly 2");
});

// ── wired into isDispatchEligible (via nextRunnable/runnableCandidates, its two
// exported callers) — mirrors the existing isCircuitTripped tests in drain.test.ts ──

test("W1-T271: a task past the lifetime cap is refused by isDispatchEligible (nextRunnable), with a legible callback naming it", () => {
  const plan = fixturePlan(); // A, D — both independent and otherwise runnable
  const capped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(capped, ["A"]);
  assert.equal(next?.id, "D", "A is skipped for its lifetime cap; D is the next runnable task");
});

test("W1-T271: the lifetime cap is independent of the streak breaker — both may be wired, either can halt a task on its own", () => {
  const plan = fixturePlan();
  const capped: string[] = [];
  const broken: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: () => false, // streak breaker clear
    onCircuitBreak: (t) => broken.push(t.id),
    isLifetimeCapExceeded: (id) => id === "A", // lifetime cap alone halts A
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(broken, [], "the streak breaker never fires when it reports clear");
  assert.deepEqual(capped, ["A"], "the lifetime cap halts A on its own, independent of the streak breaker's verdict");
  assert.equal(next?.id, "D");
});

test("W1-T271: runnableCandidates applies the exact same lifetime-cap gate as nextRunnable", () => {
  const plan = fixturePlan();
  const capped: string[] = [];
  const candidates = runnableCandidates(plan, NONE_MERGED, 5, {
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(capped, ["A"]);
  assert.deepEqual(candidates.map((t) => t.id), ["D"], "A is excluded from the concurrent candidate list too");
});

test("W1-T271: no isLifetimeCapExceeded wired at all ⇒ nextRunnable behaves exactly as before this cap existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
});

// ── W1-T316: THE PREDICATE/CALLBACK ABOVE ARE REAL AND TESTED (W1-T271's own scope) — but
// nothing in the repo ever SUPPLIED them to a production dep object: `isLifetimeCapExceeded in
// src/run-task.ts` grepped empty, and neither drainCommand's nor daemonCommand's dep object
// carried it. THE TESTS ABOVE PIN isDispatchEligible's OWN CONSULTATION, which was never the
// gap — a hand-built NextRunnableOpts fixture (exactly what every test above uses) passes just
// as happily on the unwired code. THESE TESTS DRIVE THE REAL drainCommand/daemonCommand and
// assert on the dep object each ACTUALLY hands runDrain/runDaemon — mirroring
// test/auto-triage-wiring.test.ts's identical "these tests drive the REAL daemonCommand"
// discipline, the same class of gap (#1066: consumer wired, producer never) this task's own
// rationale names as its closest sibling.

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** N `run.start` lines for `taskId`, nothing else — the raw shape `dispatchesEver` counts. */
function seedLifetimeLedger(ledgerPath: string, taskId: string, n: number): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const lines = Array.from({ length: n }, () => JSON.stringify({ run_id: "SEED", task_id: taskId, step: "run.start" }));
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
}

function drainFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-lifetime-drain-")) } as Config;
}

function emptyPlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lifetime-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return planPath;
}

/** Drives the REAL drainCommand, capturing the DrainDeps it hands to runDrain via the
 *  W1-T316 `deps.runDrain` seam (mirrors daemonCommand's pre-existing `runDaemon` seam). */
async function captureDrainDeps(config: Config, planPath: string): Promise<DrainDeps> {
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0, "the injected runDrain returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDrain was reached and its DrainDeps captured");
  return captured;
}

test("W1-T316 REACHABILITY: drainCommand wires isLifetimeCapExceeded/onLifetimeCapExceeded into the DrainDeps it hands runDrain", async () => {
  const config = drainFixtureConfig();
  try {
    const deps = await captureDrainDeps(config, emptyPlanPath());
    assert.equal(typeof deps.isLifetimeCapExceeded, "function", "drainCommand must wire the lifetime-cap predicate");
    assert.equal(typeof deps.onLifetimeCapExceeded, "function", "drainCommand must wire the lifetime-cap escalation hook");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T316: drainCommand's WIRED isLifetimeCapExceeded tracks a REAL ledger, past and under the cap", async () => {
  const config = drainFixtureConfig();
  try {
    const ledgerPath = join(config.root, "state", "ledger.ndjson");
    seedLifetimeLedger(ledgerPath, "W1-CAPPED", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES);
    const deps = await captureDrainDeps(config, emptyPlanPath());
    assert.equal(
      deps.isLifetimeCapExceeded!("W1-CAPPED"),
      true,
      "a task with >= the cap's run.start lines must read as capped through the REAL command wiring, not a hand-built fixture",
    );
    assert.equal(deps.isLifetimeCapExceeded!("W1-UNDER"), false, "a task with zero dispatches must not read as capped");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

function daemonFixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-lifetime-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

/** Drives the REAL daemonCommand, capturing the DaemonDeps it hands to runDaemon via its
 *  pre-existing (W1-T160) `deps.runDaemon` coverage seam. */
async function captureDaemonDeps(planPath: string): Promise<DaemonDeps> {
  let captured: DaemonDeps | undefined;
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  return captured;
}

test("W1-T316 REACHABILITY: daemonCommand wires isLifetimeCapExceeded/onLifetimeCapExceeded into the DaemonDeps it hands runDaemon", async () => {
  const { home, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDaemonDeps(planPath);
    assert.equal(typeof deps.isLifetimeCapExceeded, "function", "daemonCommand must wire the lifetime-cap predicate");
    assert.equal(typeof deps.onLifetimeCapExceeded, "function", "daemonCommand must wire the lifetime-cap escalation hook");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T316: daemonCommand's WIRED isLifetimeCapExceeded tracks a REAL ledger, past and under the cap", async () => {
  const { home, root, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    seedLifetimeLedger(ledgerPath, "W1-CAPPED", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES);
    const deps = await captureDaemonDeps(planPath);
    assert.equal(
      deps.isLifetimeCapExceeded!("W1-CAPPED"),
      true,
      "the daemon's real wiring must read the actual ledger, not a stub that always says clear",
    );
    assert.equal(deps.isLifetimeCapExceeded!("W1-UNDER"), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the exclusion is ledgered and escalated ONCE, never a silent skip (design step ii) ────

test("W1-T316: a task excluded by isLifetimeCapExceeded is ledgered via a legible callback, not a silent skip", () => {
  const plan = fixturePlan(); // A, D
  const seen: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => seen.push(t.id),
  });
  assert.deepEqual(seen, ["A"], "the exclusion callback fires exactly once, naming the excluded task");
  assert.equal(next?.id, "D");
});

test("escalateLifetimeCapExceeded: dedups on its own ledger step, and writes the marker whether or not delivery succeeds", () => {
  // Mirrors run-task.test.ts's identical FALSIFIER for escalateCircuitBreak — the marker must
  // be written BEFORE knowing whether `gh issue create` succeeded, or a throwing gateway leaves
  // nothing behind and every future boot retries the same escalation forever (the W1-T206 shape
  // escalateCircuitBreak's own doc names, ~130 dispatches / ~10h on one task).
  const dir = mkdtempSync(join(tmpdir(), "rmd-lifetime-escalate-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const task = { id: "W1-TCAP", title: "t", repo: "remudero", type: "implement", depends_on: [], status: "queued" };
    const boom = {
      create() {
        throw new Error("gh: HTTP 403 rate limit exceeded");
      },
    };

    assert.doesNotThrow(() =>
      escalateLifetimeCapExceeded(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "RUN-1", issues: boom }),
    );
    const afterFirst = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const markers = afterFirst.filter((l) => l.step === "dispatch.lifetime_capped.escalated");
    assert.equal(markers.length, 1, "the marker must be written even though delivery threw");
    assert.equal(markers[0].delivered, false, "and it records that delivery did NOT happen");

    let calls = 0;
    const counting = {
      create() {
        calls += 1;
        throw new Error("gh: HTTP 403 rate limit exceeded");
      },
    };
    escalateLifetimeCapExceeded(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "RUN-2", issues: counting });
    assert.equal(calls, 0, "a second boot over the SAME ledger dedups on the marker and never re-attempts delivery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── design step (iv): a new decision-reading ledger step must be registered so a rotation
// cannot drop it and silently re-arm the escalation ─────────────────────────────────────────

test("W1-T316: DECISION_RELEVANT_LEDGER_STEPS carries dispatch.lifetime_capped.escalated, so a rotation cannot re-arm the escalation", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("dispatch.lifetime_capped.escalated"),
    "escalateLifetimeCapExceeded's own dedup marker must survive ledger rotation, exactly like dispatch.circuit_broken.escalated",
  );
});

// ── W1-T951 DELIVERABLE B, THE CONSUMPTION SIDE: `isDispatchEligible`'s `already-merged`
// decline (this file's own reason for being named in the shard -- see its `files:` note on why
// `runnableCandidates`/`nextRunnable` are the highest exercisers of the selection path) now
// carries an OPTIONAL, purely-observational single-path-credit signal alongside it. See
// test/open-pr-corroboration.test.ts for the status.ts-side durable store the signal reads from.
// ──────────────────────────────────────────────────────────────────────────────────────────

test("W1-T951: a single-path-credited merged task fires onSinglePathCredit ALONGSIDE the already-merged decline, never in place of it", () => {
  const plan = fixturePlan(); // tasks "A" and "D", both otherwise runnable
  const isMerged: MergedSet = (id) => id === "A";
  const filtered: Array<{ id: string; reason: string }> = [];
  const singlePath: string[] = [];

  const picked = nextRunnable(plan, isMerged, {
    isSinglePathCredit: (id) => id === "A",
    onSinglePathCredit: (t) => singlePath.push(t.id),
    onFiltered: (t, reason) => filtered.push({ id: t.id, reason }),
  });

  assert.equal(picked?.id, "D", "A is still declined and D is still offered -- pure observation, eligibility is unchanged");
  assert.deepEqual(filtered, [{ id: "A", reason: "already-merged" }], "the existing decline is untouched");
  assert.deepEqual(singlePath, ["A"], "and the single-path signal fired for the task the durable store flagged");
});

test("W1-T951: a task credited by BOTH paths never fires onSinglePathCredit", () => {
  const plan = fixturePlan();
  const isMerged: MergedSet = (id) => id === "A";
  const singlePath: string[] = [];

  nextRunnable(plan, isMerged, {
    isSinglePathCredit: () => false, // the durable store says A is credited by trailer AND head-branch
    onSinglePathCredit: (t) => singlePath.push(t.id),
  });

  assert.deepEqual(singlePath, [], "double-path credit must never trip the signal");
});

test("W1-T951: omitting isSinglePathCredit behaves byte-identically to before this existed", () => {
  const plan = fixturePlan();
  const isMerged: MergedSet = (id) => id === "A";
  const filtered: Array<{ id: string; reason: string }> = [];

  const picked = nextRunnable(plan, isMerged, { onFiltered: (t, reason) => filtered.push({ id: t.id, reason }) });

  assert.equal(picked?.id, "D");
  assert.deepEqual(filtered, [{ id: "A", reason: "already-merged" }]);
});

test("W1-T951: runnableCandidates carries the SAME onSinglePathCredit observation as nextRunnable", () => {
  const plan = fixturePlan();
  const isMerged: MergedSet = (id) => id === "A";
  const singlePath: string[] = [];

  const candidates = runnableCandidates(plan, isMerged, 5, {
    isSinglePathCredit: (id) => id === "A",
    onSinglePathCredit: (t) => singlePath.push(t.id),
  });

  assert.deepEqual(candidates.map((t) => t.id), ["D"], "A stays excluded from the concurrent candidate set too");
  assert.deepEqual(singlePath, ["A"]);
});

// ── W1-T951 DESIGN (v): THE FILE-SHA-BRACKETED MUTATION CHECK ───────────────────────────────
//
// "A positive test alone proves nothing here, and this is the trap. An implementation that
// credits EVERYTHING satisfies 'credit is found for a branch-only id' perfectly... The check
// is: read the sha256 of the edited file, remove the durable-credit lookup, read the sha256
// again and require it to DIFFER, run the suite and require the positive test to FAIL, restore,
// and require the sha to return to the original." (design note (v), verbatim.)
//
// This test mutates the REAL, checked-out `src/lib/status.ts` on disk (restored in a `finally`,
// verified byte-identical by its own sha256 afterward), then spawns a REAL child `node --test`
// process -- the SAME house-dialect proof-execution shape `remudero-review`'s own
// `parseWhitelistedProof`/`narrowNameFilteredArgs` build for a bare `unit test: <name>` acceptance
// proof (see test/proof-exec-tmp-hygiene.test.ts) -- narrowed to ONLY
// test/open-pr-corroboration.test.ts's "a branch-only id is credited from the durable record"
// test. That test's `w951Github({ forbidReads: true })` fixture throws on every PR-record read,
// so once the durable lookup is gone the derivation falls through to a live rung and the test
// throws -- a real, mechanically-produced failure, not an assumption.
//
// Deliberately spawned from THIS file, targeting a DIFFERENT one: spawning
// open-pr-corroboration.test.ts from inside itself would re-enter this very mutation test
// recursively (the target file would spawn itself spawning itself...).

// ISOLATION (W1-T2291): THIS CHECK NO LONGER WRITES THE SHARED WORKSPACE. NOT A COVERAGE FIX.
// It used to write the REAL, checked-out `src/lib/status.ts` for the duration of a child spawn,
// restoring it in a `finally`. The restore always worked; the hazard was the WINDOW -- `node
// --test` runs files in parallel by default, so any other worker that read or instrumented
// `src/lib/status.ts` inside that window saw the durable-credit lookup already removed. A test
// must not edit its own subject in a workspace it shares with concurrent readers, whatever it
// restores afterwards. The mutation now lands on a COPY in a temp root and the child is pointed
// at that -- the exact shape test/ledger-rotation.test.ts's own W1-T964 check uses (fixed by
// #2881), reproduced here rather than re-derived.
test("W1-T951: removing the durable credit lookup fails the positive test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const statusTsRelPath = join("src", "lib", "status.ts");
  const statusTsPath = join(repoRoot, statusTsRelPath);
  const targetTestFile = "test/open-pr-corroboration.test.ts";
  const positiveTestName = "W1-T951: a branch-only id is credited from the durable record";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(statusTsPath, "utf8");
  const originalSha = sha256(original);

  const needle = "  const durableCredit = creditStore[task.id];\n";
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: the durable-credit lookup must appear EXACTLY once in status.ts, or this mutation is not targeting the real rung",
  );
  const mutated = original.replace(needle, "  const durableCredit = undefined; // W1-T951 MUTATION: durable-credit lookup removed\n");

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  // `src/`, `plan/` (loadDefaultPolicy's plan/policy.yaml, self-located from a copied module's
  // own install path -- see ledger-rotation.test.ts's identical note) and `test/setup/` are
  // copied into a temp sandbox; `node_modules` is symlinked so `tsx` resolves exactly as it does
  // in the real tree. The child runs with `cwd` set to the sandbox, so its own
  // `../src/lib/status.js` resolves to the MUTATED COPY while every concurrently-running worker
  // in the real tree keeps reading the committed file.
  const sandbox = mkdtempSync(join(tmpdir(), "w1-t951-mutation-sandbox-"));
  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    cpSync(join(repoRoot, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(repoRoot, "plan"), join(sandbox, "plan"), { recursive: true });
    cpSync(join(repoRoot, "test", "setup"), join(sandbox, "test", "setup"), { recursive: true });
    copyFileSync(join(repoRoot, targetTestFile), join(sandbox, targetTestFile));
    for (const f of ["package.json", "tsconfig.json"]) copyFileSync(join(repoRoot, f), join(sandbox, f));
    symlinkSync(join(repoRoot, "node_modules"), join(sandbox, "node_modules"));

    writeFileSync(join(sandbox, statusTsRelPath), mutated);
    const mutatedSha = sha256(readFileSync(join(sandbox, statusTsRelPath), "utf8"));
    assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the sandbox copy's bytes");
    assert.equal(
      sha256(readFileSync(statusTsPath, "utf8")),
      originalSha,
      "the CHECKED-OUT status.ts must be untouched while the mutated child runs -- a concurrent " +
        "worker instrumenting it must never observe the durable-credit lookup already removed",
    );

    // `NODE_TEST_CONTEXT` (set by node's OWN test runner on the process running THIS test) is
    // inherited by a plain `spawnSync` env by default -- and node's test runner treats its
    // presence as "this is a recursive `run()` call" and SKIPS running any files at all,
    // exiting 0 having executed nothing. Strip it so the child is a genuinely independent
    // `node --test` invocation, not a no-op that would make this check pass for the wrong
    // reason (a silently-skipped child looks identical to a clean exit).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: sandbox, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    // The sandbox goes away regardless of what the child did. There is nothing to RESTORE: the
    // checked-out tree was never written, so a throw or a timeout cannot leave it mutated -- the
    // failure mode the old restore-in-finally existed to bound is now structurally absent.
    rmSync(sandbox, { recursive: true, force: true });
  }

  assert.equal(
    sha256(readFileSync(statusTsPath, "utf8")),
    originalSha,
    "the checked-out status.ts must be byte-identical after the check -- it is never written at all",
  );
  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `removing the durable-credit lookup must fail the positive test -- child exited ${childResult!.status}\n` +
      `stdout:\n${childResult!.stdout}\nstderr:\n${childResult!.stderr}`,
  );
});
