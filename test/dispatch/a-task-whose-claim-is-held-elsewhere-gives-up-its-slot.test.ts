/**
 * W1-T13242 — A TASK WHOSE DISPATCH CLAIM ANOTHER HOLDER HAS GIVES UP ITS SLOT.
 *
 * On 2026-11-16 the fleet started no new work from 14:42Z to 20:30Z. Every tick's one free slot went
 * to W1-T12114, the highest-priority task, whose `refs/rmd-dispatch/W1-T12114` claim a dead hand
 * session held: the run refused it before spend (`blocked_inflight`, stage `dispatch.claim`) and the
 * daemon settled that as a plain continue, so the next tick's selection offered the same task first
 * again. These suites drive the REAL `runDaemon`; only the worker (`runOne`), the clock, the ledger
 * reader and the merged projection are faked, through the seams the daemon already injects.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { gitClaimRunnerAsync, gitDispatchClaimReserverAsync, releaseLandedDispatchClaims, type DispatchClaimReserverAsync } from "#src/lib/dispatch-claim.js";
import { runnableCandidates } from "#src/lib/drain.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { ENVIRONMENTAL_BLOCK_COOLDOWN_MS } from "#src/lib/status.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const T0 = Date.parse("2026-11-16T15:00:00.000Z");
const HELD = "W1-T12114";
const REF = `refs/rmd-dispatch/${HELD}`;
const HOLDER = "f9c1e7490000000000000000000000000000abcd";
const OTHERS = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12"];
const iso = (ms: number) => new Date(ms).toISOString();
type Row = Record<string, unknown>;

function task(id: string): Task {
  return {
    id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low",
    status: "queued", attempts: 0, files: [`src/${id}.ts`],
  } as unknown as Task;
}

function plan(): Plan {
  const tasks = [HELD, ...OTHERS].map(task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

interface FleetOpts {
  ticks: number;
  tickMs: number;
  /** The tick from which the claim is gone and the next run takes the claim. */
  claimGoneAtTick?: number;
  dropWithoutLedger?: () => void;
  claimSweep?: Pick<DaemonDeps, "claimSweepSettled" | "releaseLandedClaims">;
  /** Rows the refusing run writes besides its own `dispatch.claim` and `verdict` rows. */
  extraRunRows?: (runId: string, atMs: number) => Row[];
  /** `throws`: the ledger reads fine at boot and fails once a run has started, so only the deferral's read meets it. */
  readLedger?: "lines" | "throws" | "absent";
  laneCount?: number;
}

/** A fleet at one lane (the incident's single free slot) whose top task's claim another holder has. */
async function fleet(opts: FleetOpts) {
  const rows: Array<{ step: string; extra: Row }> = [];
  const ledger: Row[] = [];
  const merged = new Set<string>();
  const dispatches: Array<{ tick: number; id: string }> = [];
  const counts = { escalations: 0, breakers: 0, fixes: 0 };
  let tick = 0;
  let nowMs = T0;
  let runs = 0;
  let sweepSettled: Promise<void> | undefined;
  const claimHeld = () => opts.claimGoneAtTick === undefined || tick < opts.claimGoneAtTick;
  const readLedger = opts.readLedger ?? "lines";
  const refreshMerged = () => (id: string) => merged.has(id);
  const releaseLandedClaims = opts.claimSweep?.releaseLandedClaims;
  const deps = {
    refreshMerged,
    now: () => new Date(nowMs),
    sleep: async () => {},
    checkStop: () => (tick > opts.ticks ? "test tick cap" : undefined),
    log: (step: string, extra: Row = {}) => {
      if (step === "daemon.tick") {
        tick++;
        nowMs = T0 + (tick - 1) * opts.tickMs;
        if (opts.claimGoneAtTick === tick && opts.dropWithoutLedger) {
          opts.dropWithoutLedger();
        } else if (opts.claimGoneAtTick === tick) {
          // The holder's own release through run-task records the successful drop.
          ledger.push({ ts: iso(nowMs), run_id: "holder-run", task_id: HELD, step: "dispatch.claim_released", ref: REF,
            arm: "holder", release: true, dropped: true });
        }
      }
      rows.push({ step, extra });
    },
    ...(releaseLandedClaims === undefined ? {} : {
      claimSweepSettled: opts.claimSweep?.claimSweepSettled,
      refreshMergedAsync: async () => {
        // Fixture ticks run back-to-back, so let the preceding sweep finish before starting a new one.
        await sweepSettled;
        return refreshMerged();
      },
      releaseLandedClaims: (isMerged: (id: string) => boolean) => {
        const sweep = releaseLandedClaims(isMerged);
        sweepSettled = sweep.then(() => {}, () => {});
        return sweep;
      },
    }),
    ...(readLedger === "absent" ? {} : {
      readLedgerLines: () => {
        if (readLedger === "throws" && runs > 0) throw new Error("ledger read failed: EIO");
        return ledger.map((row) => JSON.stringify(row));
      },
    }),
    runOne: async (id: string): Promise<RunResult> => {
      dispatches.push({ tick, id });
      const runId = `${id}-run-${++runs}`;
      if (id === HELD && claimHeld()) {
        const reason = `${HELD} is already claimed by another lane — ${REF} (held by ${HOLDER}). Refusing before any spend: ` +
          "a second dispatch of one task either duplicates work already in flight or races it to a conflicting PR.";
        ledger.push(
          { ts: iso(nowMs), run_id: runId, task_id: HELD, step: "run.start" },
          { ts: iso(nowMs), run_id: runId, task_id: HELD, step: "dispatch.claim", ref: REF, outcome: "taken", proceed: false, reason },
          { ts: iso(nowMs), run_id: runId, task_id: HELD, step: "dispatch.claim_released", ref: REF, arm: "operator",
            release: false, dropped: false, reason: `${REF} is held by another lane with no landed work observed yet — leaving it.` },
          ...(opts.extraRunRows?.(runId, nowMs) ?? []),
          { ts: iso(nowMs), run_id: runId, task_id: HELD, step: "verdict", verdict: "blocked_inflight", stage: "dispatch.claim",
            reason, cost_usd: 0 },
        );
        return { taskId: id, runId, merged: false, costUsd: 0, verdict: "blocked_inflight" };
      }
      // Other work takes a moment, so a lane the refusal freed refills while a sibling still runs.
      await new Promise((settle) => setTimeout(settle, 2));
      merged.add(id);
      return { taskId: id, runId, merged: true, costUsd: 0.1, verdict: "merged", prUrl: `https://x/${id}` };
    },
    escalateBlock: async () => { counts.escalations++; },
    onCircuitBreak: () => { counts.breakers++; },
    dispatchFix: async () => { counts.fixes++; },
  } as unknown as DaemonDeps;
  const summary = await runDaemon(plan(), deps, { max: 40, laneCount: opts.laneCount ?? 1 });
  await sweepSettled;
  const deferrals = rows.filter((r) => r.step === "dispatch.claim_held_deferred");
  const heldTicks = dispatches.filter((d) => d.id === HELD).map((d) => d.tick);
  const ticksWith = (n: number) => dispatches.filter((d) => d.tick === n).map((d) => d.id);
  return { summary, rows, ledger, dispatches, counts, deferrals, heldTicks, ticksWith };
}

function claimSweepFor(reserver: DispatchClaimReserverAsync): NonNullable<FleetOpts["claimSweep"]> {
  const { listHeld } = reserver;
  assert.ok(listHeld, "the sweep fixture requires a held-claims reader");
  return {
    claimSweepSettled: Promise.resolve(),
    releaseLandedClaims: (isMerged) => {
      // Give the scheduler and sweep the same origin read, including any read failure.
      const listing = Promise.resolve().then(() => listHeld.call(reserver));
      const sweep = releaseLandedDispatchClaims({ ...reserver, listHeld: () => listing }, {
        isMerged, isIndeterminate: () => false, log: () => {},
      });
      return Object.assign(sweep, { listing });
    },
  };
}

const FIFTEEN_MIN = 15 * 60_000;

test("W1-T13242 criterion 1: a task refused because another holder has its claim gives the free slot to the next candidate on the same tick and the next", async () => {
  assert.equal(runnableCandidates(plan(), () => false, 1)[0]?.id, HELD, "the fixture's premise: the held task heads the frontier");
  // The same tick: at two lanes the refused task's lane refills from the next candidate while its sibling runs.
  const wide = await fleet({ ticks: 3, tickMs: FIFTEEN_MIN, laneCount: 2 });
  const tick1 = wide.ticksWith(1);
  assert.equal(tick1.filter((id) => id === HELD).length, 1, `the phase offers the held task once (tick 1: ${tick1.join(",")})`);
  assert.ok(tick1.length >= 3, `the freed lane refills from the next candidates on the same tick (tick 1: ${tick1.join(",")})`);
  assert.deepEqual(wide.heldTicks, [1]);

  // The next ticks: at one lane, the incident's single free slot, every later tick starts other work.
  const run = await fleet({ ticks: 5, tickMs: FIFTEEN_MIN });
  assert.ok(run.dispatches.length >= 5, `the fixture must dispatch work at all (got ${run.dispatches.length})`);
  assert.deepEqual(run.heldTicks, [1], "the held task is offered once, then left out of selection for the deferral");
  assert.equal(run.ticksWith(1)[0], HELD, "the held task is still the first candidate before any refusal");
  for (const n of [2, 3, 4, 5]) {
    const started = run.ticksWith(n);
    assert.ok(started.length >= 1, `tick ${n} starts work instead of idling behind the held task`);
    assert.ok(!started.includes(HELD), `tick ${n} does not offer the held task again (started ${started.join(",")})`);
  }
});

test("W1-T13242 criterion 2: each deferral writes one row naming the task, the holder and when the task is offered again", async () => {
  // Fifteen-minute ticks inside one deferral: one row, not one per tick.
  const within = await fleet({
    ticks: 5,
    tickMs: FIFTEEN_MIN,
    extraRunRows: (runId, atMs) => [{ ts: iso(atMs), run_id: runId, task_id: HELD, step: "dispatch.claim_unrenewed", ref: REF,
      sha: HOLDER, holder: "3861824@Remudero", minted: "2026-11-11T09:14:13.758Z" }],
  });
  assert.equal(within.deferrals.length, 1, "one row for one deferral, however many ticks it spans");
  const row = within.deferrals[0]!.extra;
  assert.equal(row.task, HELD);
  assert.equal(row.ref, REF);
  assert.equal(row.holder, HOLDER, "the holder is the anchor the refusal met");
  assert.equal(row.holder_identity, "3861824@Remudero", "the anchor's decoded holder, when the run's own rows carry it");
  assert.equal(row.run_id, `${HELD}-run-1`);
  assert.equal(row.deferred_until, iso(T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS));
  assert.equal(row.bound_ms, ENVIRONMENTAL_BLOCK_COOLDOWN_MS);
  assert.equal(row.bound_basis, "environmental_cooldown", "the row says which bound it used");

  // Two-hour ticks over twelve hours: the deferral passes at tick 4, the task is refused again, a second row.
  const across = await fleet({ ticks: 6, tickMs: 2 * 60 * 60_000 });
  assert.deepEqual(across.heldTicks, [1, 4]);
  assert.equal(across.deferrals.length, 2, "one row per deferral");
  assert.deepEqual(across.deferrals.map((d) => d.extra.deferred_until),
    [iso(T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS), iso(T0 + 3 * 2 * 60 * 60_000 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS)]);
  assert.ok(!("holder_identity" in across.deferrals[0]!.extra), "no identity is invented when the run's rows carry none");
});

test("W1-T13242 criterion 3: a claim-refused task gets no strike, breaker count or escalation, and is offered again once the deferral passes or its claim is gone", async () => {
  const gone = await fleet({ ticks: 5, tickMs: FIFTEEN_MIN, claimGoneAtTick: 3 });
  assert.deepEqual(gone.heldTicks, [1, 3], "the task returns on the first tick after its claim is released, long before the deferral passes");
  assert.equal(gone.ticksWith(3)[0], HELD, "and it is offered first again, as its priority says");
  assert.ok(gone.summary.merged.includes(HELD), "the run that meets no claim builds it");

  const passed = await fleet({ ticks: 6, tickMs: 2 * 60 * 60_000 });
  assert.deepEqual(passed.heldTicks, [1, 4], "the task returns once the deferral passes");

  for (const run of [gone, passed]) {
    assert.deepEqual(run.counts, { escalations: 0, breakers: 0, fixes: 0 }, "no escalation, breaker or fix dispatch");
    const struck = run.rows.filter((r) => ["dispatch.blocked_independent", "daemon.block.independent_failure",
      "daemon.block.transient_retry", "daemon.block.fixable_dispatch", "daemon.blocked", "daemon.block.parked"].includes(r.step));
    assert.deepEqual(struck, [], "a deferral is never a strike or a block");
    assert.ok(run.rows.some((r) => r.step === "daemon.block.inflight_contention"), "the contention row is still written");
  }
});

test("W1-T13242: a refusal whose own run dropped the claim, or that names no claim, is not deferred", async () => {
  const dropped = await fleet({
    ticks: 3,
    tickMs: FIFTEEN_MIN,
    extraRunRows: (runId, atMs) => [{ ts: iso(atMs), run_id: runId, task_id: HELD, step: "dispatch.claim_reclaimed", ref: REF,
      sha: HOLDER, holder: "3861824@Remudero", dropped: true }],
  });
  assert.equal(dropped.deferrals.length, 0, "a claim this run already dropped is gone: nothing to defer");
  assert.deepEqual(dropped.heldTicks, [1, 2, 3]);

  const unwired = await fleet({ ticks: 3, tickMs: FIFTEEN_MIN, readLedger: "absent" });
  assert.equal(unwired.deferrals.length, 0, "without the run's own rows there is no evidence of a claim refusal");
  assert.deepEqual(unwired.heldTicks, [1, 2, 3]);
});

test("W1-T13242: an unreadable ledger leaves the refusal a plain continue and says why", async () => {
  const run = await fleet({ ticks: 2, tickMs: FIFTEEN_MIN, readLedger: "throws" });
  assert.equal(run.deferrals.length, 0);
  const unreadable = run.rows.filter((r) => r.step === "dispatch.claim_held_evidence_unreadable");
  assert.ok(unreadable.length >= 1, "the failed read is ledgered, never swallowed");
  assert.equal(unreadable[0]!.extra.task, HELD);
  assert.match(String(unreadable[0]!.extra.error), /EIO/);
  assert.deepEqual(run.heldTicks, [1, 2]);
});

test("W1-T13356 criterion 1: a ref dropped from origin without a ledger row is offered on that tick", async (t) => {
  for (const unrelatedClaim of [false, true]) {
    await t.test(unrelatedClaim ? "another claim is still listed" : "the held-claims listing is empty", async (t) => {
      const origin = gitRepo({ bare: true, scope: t });
      const work = gitRepo({ scope: t });
      work.addRemote("origin", origin.dir);
      work.git("push", "--quiet", "origin", `HEAD:${REF}`);
      if (unrelatedClaim) work.git("push", "--quiet", "origin", "HEAD:refs/rmd-dispatch/unrelated");
      const reserver = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(work.dir) });

      const run = await fleet({
        ticks: 4,
        tickMs: FIFTEEN_MIN,
        claimGoneAtTick: 3,
        dropWithoutLedger: () => { work.git("push", "--quiet", "origin", `:${REF}`); },
        claimSweep: claimSweepFor(reserver),
      });
      assert.deepEqual(run.heldTicks, [1, 3]);
      assert.equal(run.ticksWith(3)[0], HELD);
      assert.ok(run.summary.merged.includes(HELD));
      assert.ok(!run.ledger.some((row) => row.ref === REF && row.dropped === true));
      const lifts = run.rows.filter((row) => row.step === "daemon.block.rearmed");
      assert.deepEqual(lifts.map((row) => row.extra), [
        { task: HELD, ref: REF, reason: "absent from origin's held-claims listing" },
      ]);
    });
  }
});

test("W1-T13356 criterion 2: an unreadable listing and a still-listed ref preserve the deferral", async () => {
  let reads = 0;
  const reserver = gitDispatchClaimReserverAsync({
    run: async (args) => {
      assert.deepEqual(args, ["ls-remote", "origin", "refs/rmd-dispatch/*"]);
      reads++;
      if (reads === 2) return { status: 1, stdout: "", stderr: "origin is unreachable" };
      if (reads === 3) throw new Error("listing failed");
      return { status: 0, stdout: `${"a".repeat(40)}\t${REF}\n`, stderr: "" };
    },
  });
  const run = await fleet({ ticks: 5, tickMs: ENVIRONMENTAL_BLOCK_COOLDOWN_MS / 4, claimSweep: claimSweepFor(reserver) });
  assert.ok(reads >= 4, "the reader returned both failures and a subsequent still-listed ref");
  assert.deepEqual(run.heldTicks, [1, 5], "a listed ref, including one at a different SHA, holds until the cooldown");
  assert.ok(run.rows.some((row) => row.step === "dispatch.claim_sweep_failed" &&
    row.extra.error === "listing failed"), "the rejected listing is reported");
  assert.ok(!run.rows.some((row) => row.step === "daemon.block.rearmed"));
});
