import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, resolveFleetControlHold, type DaemonDeps } from "../src/lib/daemon.js";
import { checkSharedPause, isRecyclePauseDetail, pauseDetail, requestPause, requestStop, stopDetail, type SharedPauseGitDeps } from "../src/lib/fleet-control.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5804 — LIVE 2026-10-05: deploy/recycle-container.sh wrote state/PAUSE at 05:10:24Z and then
// waited up to RMD_RECYCLE_WAIT_S=3000 s for in-flight workers. The daemon's PAUSE branch only slept,
// so for that whole wait no full sweep ran and no green reviewed PR was armed or merged. A recycle's
// own PAUSE now holds only worker-spawning work; an operator PAUSE with any other reason is unchanged.

const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";
const NOW = Date.parse("2026-10-05T05:20:00Z");
const RECENT = "2026-10-05T05:00:00Z";

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-pause-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixturePlan(root: string): Plan {
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: W1-QUEUED\n  title: would dispatch\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

/** The recycle script's own PAUSE body, written exactly as deploy/recycle-container.sh writes it. */
function engageRecyclePause(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ reason: RECYCLE_REASON, requestedAt: "2026-10-05T05:10:24.000Z", pid: 2822260, host: "Remudero" }));
}

function pr(over: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "url/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** A green PR with a posted PASS, one awaiting its first review, and one a fix rung would repair. */
const openPrs = (): OpenPrView[] => [
  pr({ prNumber: 9217, prUrl: "url/9217", taskId: "W1-GREEN", reviewState: "success", checksState: "green", headSha: "green01" }),
  pr({ prNumber: 9218, prUrl: "url/9218", taskId: "W1-UNREVIEWED", reviewState: "none", checksState: "green", headSha: "unrev01" }),
  pr({
    prNumber: 9219,
    prUrl: "url/9219",
    taskId: "W1-FIXABLE",
    reviewState: "failure",
    checksState: "green",
    headSha: "fixable1",
    unmetCriteria: [{ claim: "criterion one", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" }],
    reviewSummary: "one criterion unmet",
  }),
];

interface Observed {
  sweeps: number;
  armed: number[];
  merged: number[];
  fixed: number[];
  reviewed: number[];
  dispatched: string[];
  lines: Array<{ step: string; extra: Record<string, unknown> }>;
  sweepLedger: string;
}

/** Runs the daemon through a few paused ticks, its sweep hook the REAL `runSweep` over fake effects
 *  wired the way production wires them: the daemon's gate is the review and worker admission check. */
async function runPaused(
  root: string,
  opts: { wireWorkerAdmissionHold: boolean; checkPause?: () => string | undefined },
): Promise<Observed> {
  const seen: Observed = { sweeps: 0, armed: [], merged: [], fixed: [], reviewed: [], dispatched: [], lines: [], sweepLedger: join(root, "sweep-ledger.ndjson") };
  const checkStop = (): string | undefined => stopDetail(root);
  const checkPause = opts.checkPause ?? ((): string | undefined => pauseDetail(root));
  let sleeps = 0;
  const deps: DaemonDeps = {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      seen.dispatched.push(id);
      throw new Error(`runOne(${id}) — a paused daemon must dispatch nothing`);
    },
    sweep: async (gate) => {
      seen.sweeps++;
      await runSweep(
        openPrs(),
        {
          arm: (p) => {
            seen.armed.push(p.prNumber);
            seen.merged.push(p.prNumber); // a green head with a full PASS merges on its arm
          },
          close: () => {},
          dispatchFix: (p) => {
            seen.fixed.push(p.prNumber);
          },
          escalate: () => {},
          postReview: (candidate) => {
            seen.reviewed.push(candidate.prNumber);
          },
          ledgerPath: seen.sweepLedger,
          runId: "DAEMON-W1-T5804",
          now: () => NOW,
          continueReviewAdmissions: gate,
          workerAdmissionHold: gate?.workerAdmissionHold,
        },
        DEFAULT_SWEEP_POLICY,
      );
    },
    checkStop,
    checkPause,
    ...(opts.wireWorkerAdmissionHold ? { workerAdmissionHold: () => resolveFleetControlHold({ checkStop, checkPause }) } : {}),
    sleep: async () => {
      sleeps++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (sleeps >= 3) requestStop(root, "test done — the PAUSE was never lifted");
    },
    log: (step, extra = {}) => seen.lines.push({ step, extra }),
  };
  const summary = await runDaemon(fixturePlan(root), deps, { pollIntervalMs: 1 });
  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(summary.attempted, [], "no task was attempted while paused");
  return seen;
}

test("W1-T5804: a recycle PAUSE runs the sweep — the green reviewed PR is armed and merged, nothing is dispatched, no fix or review worker starts", async (t) => {
  for (const wireWorkerAdmissionHold of [true, false]) {
    const root = tempRoot(t);
    engageRecyclePause(root);
    assert.equal(isRecyclePauseDetail(pauseDetail(root)), true, "the script's PAUSE body reads as the recycle's own");
    const seen = await runPaused(root, { wireWorkerAdmissionHold });
    const label = wireWorkerAdmissionHold ? "production wiring" : "no workerAdmissionHold dep";

    assert.ok(seen.sweeps >= 1, `${label}: the full sweep ran during the recycle PAUSE`);
    assert.ok(seen.armed.includes(9217), `${label}: the green reviewed PR was armed`);
    assert.ok(seen.merged.includes(9217), `${label}: and merged`);
    assert.deepEqual(seen.dispatched, [], `${label}: dispatch stayed withheld`);
    assert.deepEqual(seen.fixed, [], `${label}: no fix worker started`);
    assert.deepEqual(seen.reviewed, [], `${label}: no new review child started`);

    const dispatchHeld = seen.lines.filter((l) => l.step === "daemon.admission_held" && l.extra.surface === "dispatch");
    assert.ok(dispatchHeld.length >= 1, `${label}: the withheld dispatch logs a row`);
    assert.equal(dispatchHeld[0].extra.detail, `PAUSE requested: ${RECYCLE_REASON}`, `${label}: naming the recycle hold`);
    const fullSweepHeld = seen.lines.filter((l) => l.step === "daemon.admission_held" && l.extra.surface === "full-sweep");
    assert.ok(fullSweepHeld.length >= 1, `${label}: the sweep's withheld worker admission logs a row`);
    assert.match(String(fullSweepHeld[0].extra.detail), /container recycle/, `${label}: naming the recycle hold`);
    const fixRow = readLedgerLines(seen.sweepLedger).find((l) => l.step === "sweep.disposed" && l.pr_number === 9219);
    assert.equal(fixRow?.acted, false, `${label}: the fix rung stood down`);
    assert.match(String(fixRow?.stand_down_reason), /fleet PAUSE hold: PAUSE requested: container recycle/);
  }
});

test("W1-T5804: an operator PAUSE with any other reason runs no sweep, arms nothing and dispatches nothing, as before", async (t) => {
  for (const reason of ["investigating an incident", "hold during deploy/recycle-container.sh review"]) {
    const root = tempRoot(t);
    requestPause(root, reason);
    assert.equal(isRecyclePauseDetail(pauseDetail(root)), false, `"${reason}" is an operator hold`);
    const seen = await runPaused(root, { wireWorkerAdmissionHold: true });

    assert.equal(seen.sweeps, 0, `"${reason}": an operator PAUSE runs no full sweep`);
    assert.deepEqual(seen.armed, [], `"${reason}": nothing is armed`);
    assert.deepEqual(seen.dispatched, [], `"${reason}": nothing is dispatched`);
    assert.ok(seen.lines.some((l) => l.step === "daemon.pause"), `"${reason}": the ordinary pause row is still written`);
    assert.equal(
      seen.lines.some((l) => l.step === "daemon.admission_held" && l.extra.surface === "dispatch"),
      false,
      `"${reason}": no recycle hold row is written for an operator PAUSE`,
    );
  }
});

/** The shared cross-host hold's git reads, faked: `ls-remote` reports `ref` (held, absent or
 *  unreachable) and an attributable anchor, so production's `checkSharedPause` composes it with the local flag. */
function sharedHold(ref: "held" | "absent" | "unreachable"): SharedPauseGitDeps & { lsRemotes: number } {
  const git = {
    lsRemotes: 0,
    run: (args: string[]): { status: number; stdout: string } => {
      if (args[0] === "ls-remote") {
        git.lsRemotes++;
        if (ref === "unreachable") return { status: 128, stdout: "" };
        return { status: 0, stdout: ref === "held" ? "0123abcd\trefs/rmd-pause/hold\n" : "" };
      }
      if (args[0] === "cat-file") return { status: 0, stdout: "rmd-pause hold 4242@operator-host 2026-10-05T05:00:00.000Z\nreason: operator maintenance\n" };
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    mintAnchor: () => "0123abcd",
  };
  return git;
}

test("W1-T5804: a recycle PAUSE never masks an operator's shared hold — with both set, no sweep runs and nothing is armed or merged", async (t) => {
  for (const ref of ["held", "unreachable"] as const) {
    const root = tempRoot(t);
    engageRecyclePause(root);
    const git = sharedHold(ref);
    const checkPause = (): string | undefined => checkSharedPause(root, git);
    assert.equal(isRecyclePauseDetail(checkPause()), false, `${ref}: the operator's shared hold wins over the local recycle PAUSE`);
    const seen = await runPaused(root, { wireWorkerAdmissionHold: true, checkPause });

    assert.ok(git.lsRemotes > 0, `${ref}: the shared ref was read beside the local recycle PAUSE`);
    assert.equal(seen.sweeps, 0, `${ref}: no full sweep runs under the operator's hold`);
    assert.deepEqual(seen.armed, [], `${ref}: nothing is armed`);
    assert.deepEqual(seen.merged, [], `${ref}: nothing is merged`);
    assert.deepEqual(seen.dispatched, [], `${ref}: nothing is dispatched`);
  }
});

test("W1-T5804: a recycle PAUSE with no shared hold set still arms and merges through production's composed PAUSE read", async (t) => {
  const root = tempRoot(t);
  engageRecyclePause(root);
  const git = sharedHold("absent");
  const checkPause = (): string | undefined => checkSharedPause(root, git);
  assert.equal(checkPause(), `PAUSE requested: ${RECYCLE_REASON}`, "an absent shared hold leaves the recycle's own detail");
  const seen = await runPaused(root, { wireWorkerAdmissionHold: true, checkPause });

  assert.ok(seen.sweeps >= 1, "the full sweep ran");
  assert.ok(seen.merged.includes(9217), "the green reviewed PR was armed and merged");
  assert.deepEqual(seen.dispatched, [], "nothing is dispatched");
  assert.deepEqual(seen.fixed, [], "no fix worker started");
});

test("W1-T5804: no PAUSE at all is not a recycle PAUSE", () => {
  assert.equal(isRecyclePauseDetail(undefined), false);
  assert.equal(isRecyclePauseDetail(`PAUSE requested: ${RECYCLE_REASON}`), true);
  assert.equal(isRecyclePauseDetail(`PAUSE requested: ${RECYCLE_REASON} (operator)`), false);
});
