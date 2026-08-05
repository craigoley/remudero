// test/sweep-pass-heartbeat.test.ts
//
// THE DEFECT: A BLIND SWEEP AND A QUIET FLEET ARE INDISTINGUISHABLE.
//
// `sweep.disposed` writes a decision for every PR every tick, so its ABSENCE across a window is the
// only signal available today — and absence is exactly what a healthy quiet period looks like.
// Measured over the live ledger unioned with every rotation, on 2026-08-05 (a day the daemon was
// continuously up, 24 boots): `sweep.disposed` had gaps of 66.3, 53.0 and 46.7 minutes that were
// entirely healthy, so no threshold over that step can separate the two.
//
// `sweep.summary` is the near-miss. It DOES fire on an empty pass — there is no early return
// between the loop and it, and the union carries 9,302 summaries against 6,653 disposeds — but it
// sits AFTER the loop. The 13:06:57 -> 13:30:28 window on 2026-08-05 is a 23.5-minute gap in
// `sweep.summary` that CONTAINS four `sweep.disposed` rows: passes were starting and not finishing,
// and PR #1348 opened and closed entirely inside it. `deriveDisposition` runs at the top of each
// iteration, OUTSIDE the per-action try/catch, so a throw there escapes `runSweep` and no summary
// is ever written.
//
// Hence a heartbeat written BEFORE the loop. Its POSITION is the entire point, so the test that
// matters most here is the one that throws mid-loop — a suite that only exercised a clean pass
// would prove nothing about the case the row exists for.
//
// WHAT IS REAL: `runSweep` is the production function, called directly. Only its injected effect
// deps are fakes, which is the seam the existing sweep suite already uses; the heartbeat write and
// its position are production code.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-08-05T13:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-sweep-heartbeat-")), "ledger.ndjson");
}

/** A PR whose disposition is `mergeable`, which is what reaches `deps.actionable` — the
 *  loop-top call that sits OUTSIDE the per-action try/catch. A `pending/pending` PR disposes
 *  `wait` and never gets there, so it cannot exercise the mid-loop throw. */
function actionablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ reviewState: "success", checksState: "green", ...over });
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
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

/** Records every `log(step, extra)` the pass emits; effects are inert. */
function deps(over: Partial<SweepDeps> = {}): { deps: SweepDeps; logged: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const d: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-HB-1",
    now: () => NOW,
    log: (step, extra) => logged.push({ step, extra }),
    ...over,
  };
  return { deps: d, logged };
}

function heartbeats(logged: Array<{ step: string; extra?: Record<string, unknown> }>) {
  return logged.filter((l) => l.step === "sweep.pass");
}

test("a clean pass writes exactly one heartbeat carrying the enumerated count", async () => {
  const { deps: d, logged } = deps();
  await runSweep([pr({ prNumber: 1 }), pr({ prNumber: 2 }), pr({ prNumber: 3 })], d, DEFAULT_SWEEP_POLICY);

  const hb = heartbeats(logged);
  assert.equal(hb.length, 1, "one heartbeat per pass, not one per PR");
  assert.equal(hb[0]?.extra?.enumerated, 3, "the count is the PRs the pass enumerated");
  assert.ok(
    logged.some((l) => l.step === "sweep.summary"),
    "a clean pass still summarises — the heartbeat does not replace the summary",
  );
});

test("THE POSITION TEST — a pass that THROWS mid-loop still leaves its heartbeat", async () => {
  // `deps.actionable` is consulted at the top of each iteration, OUTSIDE the per-action try/catch,
  // so throwing from it reproduces the real shape: a pass that starts, disposes some PRs, and dies
  // before it can summarise. This is the case the row exists for; a heartbeat written after the
  // loop would be absent here, which is precisely the 23.5-minute blind window.
  let seen = 0;
  const { deps: d, logged } = deps({
    actionable: () => {
      seen++;
      if (seen === 2) throw new Error("mid-loop explosion");
      return true;
    },
  });

  await assert.rejects(
    async () => {
      await runSweep(
        [actionablePr({ prNumber: 1 }), actionablePr({ prNumber: 2 }), actionablePr({ prNumber: 3 })],
        d,
        DEFAULT_SWEEP_POLICY,
      );
    },
    /mid-loop explosion/,
    "the throw must still propagate — the heartbeat must not swallow it",
  );

  const hb = heartbeats(logged);
  assert.equal(hb.length, 1, "the heartbeat survives a throw inside the loop");
  assert.equal(hb[0]?.extra?.enumerated, 3, "and still reports what the pass set out to do");
  assert.ok(
    !logged.some((l) => l.step === "sweep.summary"),
    "no summary is written — which is exactly why the summary cannot serve as the heartbeat",
  );
});

test("an EMPTY pass is distinguishable from a blind one — enumerated 0, and it still summarises", async () => {
  const { deps: d, logged } = deps();
  await runSweep([], d, DEFAULT_SWEEP_POLICY);

  const hb = heartbeats(logged);
  assert.equal(hb.length, 1, "a pass with nothing to do still reports that it ran");
  assert.equal(hb[0]?.extra?.enumerated, 0, "enumerated 0 — the fleet was quiet, not blind");
  assert.ok(logged.some((l) => l.step === "sweep.summary"), "and an empty pass completes normally");
});

test("enumerated-12-and-died reads differently from enumerated-0-and-finished — the counts separate them", async () => {
  // The distinction the brief names: a bare pulse would make these identical.
  const many = Array.from({ length: 12 }, (_, i) => actionablePr({ prNumber: i + 1 }));
  const dying = deps({
    actionable: () => {
      throw new Error("died on the first PR");
    },
  });
  await assert.rejects(async () => {
    await runSweep(many, dying.deps, DEFAULT_SWEEP_POLICY);
  }, /died on the first PR/);

  const quiet = deps();
  await runSweep([], quiet.deps, DEFAULT_SWEEP_POLICY);

  const a = heartbeats(dying.logged)[0];
  const b = heartbeats(quiet.logged)[0];
  assert.equal(a?.extra?.enumerated, 12);
  assert.equal(b?.extra?.enumerated, 0);
  assert.ok(!dying.logged.some((l) => l.step === "sweep.summary"), "the dying pass never summarised");
  assert.ok(quiet.logged.some((l) => l.step === "sweep.summary"), "the quiet pass did");
  assert.notEqual(a?.extra?.enumerated, b?.extra?.enumerated, "a bare pulse could not tell these apart");
});

test("the heartbeat records dry-run passes as such, so a preview is not read as a real pass", async () => {
  const { deps: d, logged } = deps({ dryRun: true });
  await runSweep([pr()], d, DEFAULT_SWEEP_POLICY);
  assert.equal(heartbeats(logged)[0]?.extra?.dry_run, true);

  const live = deps();
  await runSweep([pr()], live.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(heartbeats(live.logged)[0]?.extra?.dry_run, false, "a real pass is marked false, not left undefined");
});

test("the heartbeat is emitted before any disposition, so it cannot depend on the loop making progress", async () => {
  const order: string[] = [];
  const { deps: d } = deps({ log: (step) => order.push(step) });
  await runSweep([pr()], d, DEFAULT_SWEEP_POLICY);
  const first = order.indexOf("sweep.pass");
  const firstDispose = order.findIndex((s) => s.startsWith("sweep.dispose"));
  assert.equal(first, 0, "the heartbeat is the pass's first ledger word");
  if (firstDispose >= 0) assert.ok(first < firstDispose, "and precedes every disposition");
});

/** Keeps the temp dirs from accumulating across the run. */
test("fixture hygiene: temp ledgers are removable", () => {
  const p = ledgerPath();
  rmSync(join(p, ".."), { recursive: true, force: true });
  assert.ok(true);
});
