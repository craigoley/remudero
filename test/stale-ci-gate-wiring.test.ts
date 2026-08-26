/**
 * W1-T2300 (blocker one, rationale (2)) — THE STALE-CI-GATE DETECTOR IS WIRED TO THE CLI.
 *
 * `staleCiGateTransition` (lib/sweep.ts, W1-T1275) and the ledgered bound around it were real and
 * correct, but unreachable: `SweepDeps.readCiGateRollup`/`.reaggregateCiGate` were declared,
 * documented, and read by `runSweep` — yet `buildSweepEffects` (run-task.ts), the ONE place every
 * `rmd sweep`/daemon/`rmd fix` call site gets its real `SweepDeps` from, never implemented either
 * one. `deps.readCiGateRollup` was therefore always `undefined` in production, `runSweep` always
 * skipped straight past the stale-gate lane, and the whole detector sat dark since it shipped.
 *
 * This suite drives the REAL `buildSweepEffects` output — never a hand-rolled fake — against a
 * stubbed async JSON reader (`readJsonImpl`, the same non-blocking seam `pollToGate`/
 * `waitForCiGreen` already use) and a stubbed `gh` argv recorder (`ghRunImpl`, the SAME seam
 * `requeueCheck`'s own wiring test already uses), so no live `gh` process or network call is
 * exercised. Four acceptance criteria, each proven below:
 *   1. the producer is reachable from the CLI's own `buildSweepEffects`, and the detector fires on
 *      a rollup where a required sibling started after the gate concluded and read success.
 *   2. the recompute stays bounded to at most once per (head, sibling-transition) — no retry loop
 *      is introduced on top of `runSweep`'s own ledgered bound.
 *   3. the real re-drive targets a single job by id, never a whole-run re-run.
 *   4. wiring the lane relaxes no required-context judgement — a genuinely-red gate with no stale
 *      transition still dispatches the fix rung exactly as before, and the sweep never arms/merges.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CI_GATE_CHECK_NAME,
  CI_GATE_REAGGREGATE_STEP,
  DEFAULT_SWEEP_POLICY,
  reaggregatedCiGateKeysFromLedger,
  runSweep,
  staleCiGateTransition,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { checkRunsRestArgs, combinedStatusRestArgs } from "../src/lib/open-prs-rest.js";
import { buildSweepEffects } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";

const OWNER = "craigoley";
const REPO = "remudero";
const SHA = "e97690b0e97690b0e97690b0e97690b0e97690b0";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-stale-gate-wiring-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2612,
    prUrl: "https://github.com/craigoley/remudero/pull/2612",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-26T18:15:00Z",
    headSha: SHA,
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

/** An async `gh api` fetcher: routes by argv[1], records every call, throws on an unrouted path. */
function fakeReadJson(routes: Record<string, unknown>): ((args: string[]) => Promise<unknown>) & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const path = args[1];
    if (!(path in routes)) throw new Error(`unrouted gh api path: ${path}`);
    return routes[path];
  }) as ((args: string[]) => Promise<unknown>) & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const CHECK_RUNS_PATH = checkRunsRestArgs(OWNER, REPO, SHA)[1];
const COMBINED_STATUS_PATH = combinedStatusRestArgs(OWNER, REPO, SHA)[1];

/** The #2612 fixture (W1-T1275's own incident), over REST's snake_case wire shape: `ci-gate`
 *  concluded FAILURE, `coverage-ratchet` was cancelled then reached a LATER success. */
const STALE_ROUTES = {
  [CHECK_RUNS_PATH]: {
    check_runs: [
      {
        name: CI_GATE_CHECK_NAME,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-08-26T14:27:16Z",
        details_url: "https://github.com/craigoley/remudero/actions/runs/999999/job/555555",
      },
      { name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-26T14:27:00Z" },
      { name: "coverage-ratchet", status: "completed", conclusion: "cancelled", started_at: "2026-08-26T14:27:16Z" },
      { name: "coverage-ratchet", status: "completed", conclusion: "success", started_at: "2026-08-26T17:03:13Z" },
    ],
  },
  [COMBINED_STATUS_PATH]: { statuses: [] },
};

/** The SAME head, but coverage-ratchet never recovered — a genuinely still-red gate. */
const STILL_RED_ROUTES = {
  [CHECK_RUNS_PATH]: {
    check_runs: [
      {
        name: CI_GATE_CHECK_NAME,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-08-26T14:27:16Z",
        details_url: "https://github.com/craigoley/remudero/actions/runs/999999/job/555555",
      },
      { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-08-26T14:27:16Z" },
    ],
  },
  [COMBINED_STATUS_PATH]: { statuses: [] },
};

/** `buildSweepEffects` with every optional dep left at its default EXCEPT `log`, `ghRunImpl`
 *  (param 18) and `readJsonImpl` (param 22, the newest — W1-T2300) — the exact positional gap
 *  `test/cancelled-required-check-requeue.test.ts`'s own GUARDED SITE tests already drive. */
function buildEffects(
  ghRunImpl: (file: string, args: readonly string[]) => void,
  readJsonImpl: (args: string[]) => Promise<unknown>,
  log: (step: string, extra?: Record<string, unknown>) => void = () => {},
) {
  return buildSweepEffects(
    OWNER,
    REPO,
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t2300-stale-gate-root-")) } as never,
    ledgerPath(),
    "SWEEP-STALEGATE-1",
    { tasks: [] } as never,
    log,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    ghRunImpl,
    undefined, undefined, undefined,
    readJsonImpl,
  );
}

// ── acceptance 1 — reachable from the CLI's own buildSweepEffects, and the detector fires ───────

test("GUARDED SITE stale-ci-gate wiring: buildSweepEffects wires readCiGateRollup/reaggregateCiGate — both are callable, not undefined", () => {
  const effects = buildEffects(() => {}, fakeReadJson(STALE_ROUTES));
  assert.equal(typeof effects.readCiGateRollup, "function", "readCiGateRollup must be reachable from the real gateway builder");
  assert.equal(typeof effects.reaggregateCiGate, "function", "reaggregateCiGate must be reachable from the real gateway builder");
});

test("GUARDED SITE stale-ci-gate wiring: readCiGateRollup's fresh REST read composes into a rollup the detector fires on — a required sibling started after the gate concluded and read success", async () => {
  const effects = buildEffects(() => {}, fakeReadJson(STALE_ROUTES));
  const rollup = await effects.readCiGateRollup!(pr());
  const transition = staleCiGateTransition(rollup);
  assert.ok(transition, "expected the composed REST rollup to carry a stale transition");
  assert.equal(transition!.siblingName, "coverage-ratchet");
  assert.equal(transition!.siblingStartedAt, "2026-08-26T17:03:13Z");
});

test("readCiGateRollup degrades to undefined (never throws out of runSweep's own loop) when the REST read fails", async () => {
  const effects = buildEffects(
    () => {},
    async () => {
      throw new Error("gh: rate limited");
    },
  );
  const rollup = await effects.readCiGateRollup!(pr());
  assert.equal(rollup, undefined);
});

// ── acceptance 3 — the real re-drive targets a single job by id, never a whole-run re-run ───────

test("GUARDED SITE stale-ci-gate wiring: reaggregateCiGate targets ci-gate's OWN job id via the single-job rerun endpoint, never rerun-failed-jobs or a whole-run rerun", async () => {
  const readJson = fakeReadJson(STALE_ROUTES);
  const captured: string[][] = [];
  const effects = buildEffects((file, args) => captured.push([file, ...args]), readJson);
  const transition = staleCiGateTransition(await effects.readCiGateRollup!(pr()))!;

  await effects.reaggregateCiGate!(pr(), transition);

  assert.equal(captured.length, 1, `expected exactly one gh invocation, got ${JSON.stringify(captured)}`);
  const argv = captured[0].join(" ");
  assert.match(argv, /actions\/jobs\/555555\/rerun/, `must target ci-gate's own job — argv was ${argv}`);
  assert.doesNotMatch(argv, /rerun-failed-jobs/, `must never target the whole-run rerun-failed-jobs endpoint — argv was ${argv}`);
  assert.doesNotMatch(argv, /actions\/runs\/[^/]+\/rerun(?!-)/, `must never re-run the whole workflow run — argv was ${argv}`);
});

test("reaggregateCiGate is a NAMED no-op when ci-gate's own rollup entry carries no resolvable job id — never a guessed target", async () => {
  const noJobIdRoutes = {
    [CHECK_RUNS_PATH]: {
      check_runs: [
        { name: CI_GATE_CHECK_NAME, status: "completed", conclusion: "failure", started_at: "2026-08-26T14:27:16Z" },
        { name: "coverage-ratchet", status: "completed", conclusion: "success", started_at: "2026-08-26T17:03:13Z" },
      ],
    },
    [COMBINED_STATUS_PATH]: { statuses: [] },
  };
  const captured: string[][] = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildEffects(
    (file, args) => captured.push([file, ...args]),
    fakeReadJson(noJobIdRoutes),
    (step, extra) => logged.push({ step, extra }),
  );

  await effects.reaggregateCiGate!(pr(), { siblingName: "coverage-ratchet", siblingStartedAt: "2026-08-26T17:03:13Z" });

  assert.equal(captured.length, 0, "no job id — no gh call at all");
  assert.ok(logged.some((l) => l.step === "sweep.ci_gate_reaggregate.no_job_id"), "the stand-down is legible on the ledger log, never a silent no-op");
});

// ── acceptance 1+2+4 — end to end through runSweep, using the REAL wired effects ─────────────────

test("runSweep END TO END with the REAL buildSweepEffects wiring: a PR red only because ci-gate's own verdict went stale re-drives its job exactly once, ledgered, and never arms/fixes", async () => {
  const readJson = fakeReadJson(STALE_ROUTES);
  const captured: string[][] = [];
  const armed: unknown[] = [];
  const fixed: unknown[] = [];
  const effects = buildEffects((file, args) => captured.push([file, ...args]), readJson);
  const ledger = ledgerPath();
  const subject = pr();
  const summary = await runSweep(
    [subject],
    {
      ...effects,
      arm: (p: OpenPrView) => {
        armed.push(p);
      },
      close: () => {},
      dispatchFix: (p: OpenPrView) => {
        fixed.push(p);
      },
      escalate: () => {},
      // Overridden to avoid a REAL `gh pr view` network call against `effects`'s own default
      // `readLiveState` (`ghLiveState`) — this suite proves the stale-gate lane in isolation,
      // never a live GitHub read of an unrelated fixture PR number.
      readLiveState: undefined,
      ledgerPath: ledger,
      runId: "SWEEP-STALEGATE-E2E-1",
      log: () => {},
    },
    DEFAULT_SWEEP_POLICY,
  );

  // acceptance 1 — the detector fired through the REAL, CLI-reachable wiring.
  assert.equal(captured.length, 1, `expected exactly one real gh rerun call, got ${JSON.stringify(captured)}`);
  assert.match(captured[0].join(" "), /actions\/jobs\/555555\/rerun/);
  assert.equal(summary.actions[0].disposition, "blocked-fixable", "the disposition itself is untouched");
  assert.equal(summary.actions[0].acted, false, "standing down while GitHub re-evaluates, not a completed action");

  // acceptance 4 — nothing about the gate's own judgement is relaxed: no arm, no fix-rung spend.
  assert.equal(armed.length, 0, "this lane never arms/merges — it only asks GitHub to re-evaluate");
  assert.equal(fixed.length, 0, "a stale rollup carries no diff defect — the fix rung never spends a strike on it");

  const line = readLedgerLines(ledger).find((l) => l.step === CI_GATE_REAGGREGATE_STEP);
  assert.ok(line, "the re-drive must be ledgered before it can be repeated");
  assert.equal(line!.sibling_name, "coverage-ratchet");
});

test("runSweep END TO END with the REAL buildSweepEffects wiring: a SECOND pass over the SAME head sha and transition does NOT re-drive again — the bound holds through the real wiring too", async () => {
  const readJson = fakeReadJson(STALE_ROUTES);
  const captured: string[][] = [];
  const effects = buildEffects((file, args) => captured.push([file, ...args]), readJson);
  const ledger = ledgerPath();
  const subject = pr();
  const commonDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    log: () => {},
    // Same override as the previous test — no real `gh pr view` network call.
    readLiveState: undefined,
  };

  await runSweep([subject], { ...effects, ...commonDeps, ledgerPath: ledger, runId: "SWEEP-STALEGATE-E2E-2A" }, DEFAULT_SWEEP_POLICY);
  assert.equal(captured.length, 1, "first pass re-drives once");

  // A second buildSweepEffects (a fresh "process"), same ledger, same head, same rollup — exactly
  // what the next real sweep tick would observe while GitHub's own re-run is still settling.
  const effects2 = buildEffects((file, args) => captured.push([file, ...args]), fakeReadJson(STALE_ROUTES));
  await runSweep([subject], { ...effects2, ...commonDeps, ledgerPath: ledger, runId: "SWEEP-STALEGATE-E2E-2B" }, DEFAULT_SWEEP_POLICY);

  assert.equal(captured.length, 1, "bounded — no second real gh call for the same (head, transition) pair; no retry loop introduced");
  const keys = reaggregatedCiGateKeysFromLedger(readLedgerLines(ledger));
  assert.equal(keys.size, 1, "exactly one (head, sibling-transition) key was ever recorded");
});

test("runSweep END TO END with the REAL buildSweepEffects wiring: a genuinely still-red gate (no stale transition) is untouched by this lane — it still dispatches the fix rung, the gate still holds the merge", async () => {
  const readJson = fakeReadJson(STILL_RED_ROUTES);
  const captured: string[][] = [];
  const armed: unknown[] = [];
  const fixed: unknown[] = [];
  const effects = buildEffects((file, args) => captured.push([file, ...args]), readJson);
  const ledger = ledgerPath();
  const subject = pr();

  await runSweep(
    [subject],
    {
      ...effects,
      arm: (p: OpenPrView) => {
        armed.push(p);
      },
      close: () => {},
      dispatchFix: (p: OpenPrView) => {
        fixed.push(p);
      },
      escalate: () => {},
      // Overridden to avoid a REAL `gh pr view` network call against `effects`'s own default
      // `readLiveState` (`ghLiveState`) — this suite proves the stale-gate lane in isolation,
      // never a live GitHub read of an unrelated fixture PR number.
      readLiveState: undefined,
      ledgerPath: ledger,
      runId: "SWEEP-STALEGATE-E2E-3",
      log: () => {},
    },
    DEFAULT_SWEEP_POLICY,
  );

  assert.equal(captured.length, 0, "no stale transition observed — the real gateway never issues a gh rerun call");
  assert.equal(fixed.length, 1, "a genuinely still-red gate still routes to the fix rung, unchanged by this task");
  assert.equal(armed.length, 0, "a red required check must never be armed/merged — the gate still holds");
  assert.equal(readLedgerLines(ledger).find((l) => l.step === CI_GATE_REAGGREGATE_STEP), undefined, "nothing was re-driven — nothing to ledger");
});
