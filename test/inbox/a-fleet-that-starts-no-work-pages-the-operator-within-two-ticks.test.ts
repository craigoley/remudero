/**
 * W1-T13248 — A FLEET THAT STARTS NO WORK PAGES THE OPERATOR WITHIN TWO TICKS.
 *
 * On 2026-11-16 the fleet started no work from 14:42Z to 20:30Z: every tick's free slot went to a run refused before
 * spend because a dead hand session held its dispatch claim, and nothing alerted anyone. These suites drive the REAL
 * `runDaemon` (only the worker, the clock and the ledger reader are faked, through the seams the daemon already
 * injects) and the real catalogue entries with a fake issue gateway.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";

import {
  decideClaimStall, runDaemon, type ClaimRefusedRun, type ClaimStallClearedInfo, type ClaimStallInfo, type DaemonDeps,
} from "#src/lib/daemon.js";
import { escalateClaimStall, escalateClaimStallCleared } from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";

const T0 = Date.parse("2026-11-16T15:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Row = Record<string, unknown>;
const IDS = ["A1", "B2", "C3", "D4"];
const sha = (id: string) => `${id.toLowerCase().padEnd(2, "0")}c1e7490000000000000000000000000000abcd`.slice(0, 40).replace(/[^0-9a-f]/g, "a");
const ref = (id: string) => `refs/rmd-dispatch/${id}`;

function task(id: string): Task {
  return {
    id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low",
    status: "queued", attempts: 0, files: [`src/${id}.ts`],
  } as unknown as Task;
}
function plan(ids: readonly string[]): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

/** Ten earlier builds, each twelve minutes from claim to verdict: the claim-silence window is then 12 minutes. */
function measuredBuilds(): Row[] {
  return Array.from({ length: 10 }, (_, i) => {
    const at = T0 - 40 * 60 * MIN + i * 60 * MIN;
    return [
      { ts: iso(at), run_id: `old-${i}`, task_id: "OLD", step: "dispatch.claim", ref: ref("OLD"), outcome: "created" },
      { ts: iso(at + 12 * MIN), run_id: `old-${i}`, task_id: "OLD", step: "verdict", verdict: "merged" },
    ];
  }).flat();
}

interface FleetOpts {
  ids: readonly string[];
  ticks: number;
  tickMs: number;
  /** Ids whose claim another holder has (the rest pass their claim and merge). */
  held: ReadonlySet<string>;
  /** From this tick on no claim is held. */
  freeFromTick?: number;
  /** Age of the holder's newest sign of life when it was judged, at the time of each refusal. */
  signOfLifeAgeMs: number;
  seed?: readonly Row[];
}

async function fleet(opts: FleetOpts) {
  const ledger: Row[] = [...(opts.seed ?? measuredBuilds())];
  const merged = new Set<string>();
  const stalls: ClaimStallInfo[] = [];
  const clears: Array<{ tick: number; info: ClaimStallClearedInfo }> = [];
  const stallTicks: number[] = [];
  let tick = 0;
  let nowMs = T0;
  let runs = 0;
  const deps = {
    refreshMerged: () => (id: string) => merged.has(id),
    now: () => new Date(nowMs),
    sleep: async () => {},
    checkStop: () => (tick > opts.ticks ? "test tick cap" : undefined),
    log: (step: string, _extra: Row = {}) => {
      if (step === "daemon.tick") {
        tick++;
        nowMs = T0 + (tick - 1) * opts.tickMs;
      }
    },
    readLedgerLines: () => ledger.map((row) => JSON.stringify(row)),
    runOne: async (id: string): Promise<RunResult> => {
      const runId = `${id}-run-${++runs}`;
      const free = opts.freeFromTick !== undefined && tick >= opts.freeFromTick;
      if (opts.held.has(id) && !free) {
        const reason = `${id} is already claimed by another lane — ${ref(id)} (held by ${sha(id)}). Refusing before any spend.`;
        ledger.push(
          { ts: iso(nowMs), run_id: runId, task_id: id, step: "run.start" },
          { ts: iso(nowMs), run_id: runId, task_id: id, step: "dispatch.claim", ref: ref(id), outcome: "taken", proceed: false, reason },
          { ts: iso(nowMs), run_id: runId, task_id: id, step: "dispatch.claim_unrenewed", ref: ref(id), sha: sha(id),
            holder: "4242@hand-host", last_sign_of_life: iso(nowMs - opts.signOfLifeAgeMs), silence_ms: opts.signOfLifeAgeMs },
          { ts: iso(nowMs), run_id: runId, task_id: id, step: "verdict", verdict: "blocked_inflight", stage: "dispatch.claim", cost_usd: 0 },
        );
        return { taskId: id, runId, merged: false, costUsd: 0, verdict: "blocked_inflight" };
      }
      ledger.push({ ts: iso(nowMs), run_id: runId, task_id: id, step: "run.start" },
        { ts: iso(nowMs), run_id: runId, task_id: id, step: "dispatch.claim", ref: ref(id), outcome: "created" });
      merged.add(id);
      return { taskId: id, runId, merged: true, costUsd: 0.1, verdict: "merged", prUrl: `https://x/${id}` };
    },
    onClaimStall: (info: ClaimStallInfo) => { stalls.push(info); stallTicks.push(tick); },
    onClaimStallCleared: (info: ClaimStallClearedInfo) => { clears.push({ tick, info }); },
  } as unknown as DaemonDeps;
  await runDaemon(plan(opts.ids), deps, { max: 40, laneCount: 1 });
  return { stalls, stallTicks, clears, ledger };
}

const ALL_HELD = new Set(IDS);

function gateway() {
  const created: Array<{ title: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create: (title, body) => { created.push({ title, body }); return `https://github.com/o/r/issues/${created.length}`; },
    closeWithComment: (url, comment) => { closed.push({ url, comment }); },
  };
  return { issues, created, closed };
}

/** A throwaway ledger built with the shared fixture; `rows()` reads back what the catalogue appended. */
function scratch(): { path: string; rows: () => Row[]; append: (row: Row) => void; cleanup: () => void } {
  const fx = writeLedger([]);
  return {
    path: fx.path,
    rows: () => readFileSync(fx.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row),
    append: (row) => fx.append([row]),
    cleanup: () => rmSync(fx.dir, { recursive: true, force: true }),
  };
}

const INFO: ClaimStallInfo = {
  taskId: "B2", ref: ref("B2"), holder: "4242@hand-host", holderHost: "hand-host", claimAgeMs: 180 * MIN, boundMs: 12 * MIN,
  boundSource: "claim-silence-window", samples: 10, lastSignOfLife: iso(T0), refusedTicks: 2,
};

test("W1-T13248 criterion 1: two refused-only ticks past the claim-silence window open one needs-human issue naming the task, holder, age and release command", async () => {
  const run = await fleet({ ids: IDS, ticks: 4, tickMs: 15 * MIN, held: ALL_HELD, signOfLifeAgeMs: 180 * MIN });
  assert.equal(run.stalls.length, 1, "one page for the whole stall, not one per tick");
  assert.deepEqual(run.stallTicks, [2], "the second consecutive refused tick pages, never the first");
  const info = run.stalls[0]!;
  assert.equal(info.holder, "4242@hand-host");
  assert.equal(info.boundSource, "claim-silence-window");
  assert.equal(info.boundMs, 12 * MIN, "the fleet's own measured p90 claim-to-verdict window");
  assert.ok(info.claimAgeMs >= info.boundMs, `claim age ${info.claimAgeMs} is past the bound`);
  assert.equal(info.refusedTicks, 2);

  const fx = scratch();
  try {
    const gw = gateway();
    await escalateClaimStall(info, { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues });
    assert.equal(gw.created.length, 1);
    const text = `${gw.created[0]!.title}\n${gw.created[0]!.body}`;
    assert.ok(text.includes(info.taskId), "names the task");
    assert.ok(text.includes("4242@hand-host"), "names the holder");
    assert.ok(text.includes("180 min"), "names the claim's age");
    assert.ok(text.includes("claim-silence window"), "names the bound that fired");
    assert.ok(text.includes(`rmd claim ${info.taskId} --drop`), "names the release command");
    const marker = fx.rows().find((r) => r.step === "dispatch.claim_stall.escalated");
    assert.equal(marker?.issue_url, "https://github.com/o/r/issues/1");
    assert.equal(marker?.bound_source, "claim-silence-window");
  } finally { fx.cleanup(); }
});

test("W1-T13248 criterion 1: with no measured claim-to-verdict build the p90 of gaps between claim-passing runs is the bound, and the page says so", async () => {
  const created = Array.from({ length: 6 }, (_, i) => ({ ts: iso(T0 - (6 - i) * 20 * MIN), run_id: `p-${i}`, task_id: "P", step: "dispatch.claim", ref: ref("P"), outcome: "created" }));
  const taken = { ts: iso(T0 - 90 * MIN), run_id: "r1", task_id: "B2", step: "dispatch.claim", ref: ref("B2"), outcome: "taken",
    reason: `B2 is already claimed — ${ref("B2")} (held by ${sha("B2")}).` };
  const lines = [...created, taken].map((r) => JSON.stringify(r));
  const refused: ClaimRefusedRun[] = [{ taskId: "B2", runId: "r2", refusal: { ref: ref("B2"), refusedAtMs: T0, holder: sha("B2"), holderIdentity: "4242@hand-host" } }];
  const info = decideClaimStall(lines, refused, T0, 2);
  assert.equal(info?.boundSource, "claim-pass-gap-p90");
  assert.equal(info?.boundMs, 20 * MIN);
  assert.equal(info?.claimAgeMs, 90 * MIN);
  assert.equal(info?.holder, "4242@hand-host");
  const fx = scratch();
  try {
    const gw = gateway();
    await escalateClaimStall(info!, { owner: "o", repo: "r", ledgerPath: fx.path, runId: "d", issues: gw.issues });
    assert.ok(gw.created[0]!.body.includes("gaps between runs that passed their claim"), "the issue names the bound's source");
  } finally { fx.cleanup(); }
  assert.equal(decideClaimStall(lines.slice(0, 3), refused, T0, 2), undefined, "too few gaps is no bound, so no page");
});

test("W1-T13248 criterion 2: the issue is opened once per stall, deduped on the newest claim-passing run rather than run.start", async () => {
  const fx = scratch();
  try {
    const gw = gateway();
    const ctx = { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues };
    await escalateClaimStall(INFO, ctx);
    // Refused runs write a fresh run.start every tick; that must not re-arm the page.
    for (let i = 0; i < 3; i++) {
      fx.append({ ts: iso(T0 + i), run_id: `r${i}`, task_id: "B2", step: "run.start" });
      fx.append({ ts: iso(T0 + i), run_id: `r${i}`, task_id: "B2", step: "dispatch.claim", ref: ref("B2"), outcome: "taken" });
      await escalateClaimStall(INFO, ctx);
    }
    assert.equal(gw.created.length, 1, "run.start and refused claims never re-open the page");
    fx.append({ ts: iso(T0 + 10), run_id: "good", task_id: "C3", step: "dispatch.claim", ref: ref("C3"), outcome: "created" });
    await escalateClaimStall(INFO, ctx);
    assert.equal(gw.created.length, 2, "after a run passed its claim, a new stall opens its own issue");
  } finally { fx.cleanup(); }
});

test("W1-T13248 criterion 2: the first run that passes its claim after the page closes the issue, once", async () => {
  const run = await fleet({ ids: IDS, ticks: 5, tickMs: 15 * MIN, held: new Set(["A1", "B2"]), signOfLifeAgeMs: 180 * MIN });
  assert.equal(run.stalls.length, 1);
  assert.ok(run.clears.length >= 1, "a claim-passing run closes the page");
  assert.equal(run.clears.length, 1, "closed once, on the edge, not every later tick");
  assert.ok(run.clears[0]!.tick > run.stallTicks[0]!, "the close follows the page");
  assert.ok(run.clears[0]!.info.runId?.startsWith("C3") || run.clears[0]!.info.runId?.startsWith("D4"), "names the run that passed");

  const fx = scratch();
  try {
    const gw = gateway();
    const ctx = { owner: "o", repo: "r", ledgerPath: fx.path, runId: "daemon-run", issues: gw.issues };
    await escalateClaimStallCleared({ runId: "x" }, ctx);
    assert.equal(gw.closed.length, 0, "no open page, nothing to close");
    await escalateClaimStall(INFO, ctx);
    await escalateClaimStallCleared(run.clears[0]!.info, ctx);
    assert.deepEqual(gw.closed.map((c) => c.url), ["https://github.com/o/r/issues/1"]);
    assert.ok(gw.closed[0]!.comment.includes("passed its dispatch claim"));
    await escalateClaimStallCleared({ runId: "y" }, ctx);
    assert.equal(gw.closed.length, 1, "a second clear finds the issue already closed");
    assert.ok(fx.rows().some((r) => r.step === "dispatch.claim_stall.cleared" && r.delivered === true));
  } finally { fx.cleanup(); }
});

test("W1-T13248 criterion 2: a close that cannot be delivered leaves the issue open and records the failure, never throws", async () => {
  const throwingFx = scratch();
  const createOnlyFx = scratch();
  try {
    const gw = gateway();
    // The gateway's close throws: the daemon loop must never see it.
    const throwing: IssueGateway = { ...gw.issues, closeWithComment: () => { throw new Error("gh: 502 bad gateway"); } };
    const ctx = (path: string, issues: IssueGateway) => ({ owner: "o", repo: "r", ledgerPath: path, runId: "daemon-run", issues });
    await escalateClaimStall(INFO, ctx(throwingFx.path, gw.issues));
    await escalateClaimStallCleared({ runId: "x" }, ctx(throwingFx.path, throwing));
    const row = throwingFx.rows().findLast((r) => r.step === "dispatch.claim_stall.cleared");
    assert.equal(row?.delivered, false);
    assert.equal(row?.failure, "gh: 502 bad gateway");
    assert.equal(row?.issue_url, "https://github.com/o/r/issues/1");
    // A gateway with no close at all is the same outcome with its own reason.
    const createOnly: IssueGateway = { create: gw.issues.create };
    await escalateClaimStall(INFO, ctx(createOnlyFx.path, createOnly));
    await escalateClaimStallCleared({ runId: "y" }, ctx(createOnlyFx.path, createOnly));
    const second = createOnlyFx.rows().findLast((r) => r.step === "dispatch.claim_stall.cleared");
    assert.equal(second?.delivered, false);
    assert.equal(second?.failure, "issue gateway cannot close issues");
  } finally { throwingFx.cleanup(); createOnlyFx.cleanup(); }
});

test("W1-T13248 criterion 3: invariant a-live-holder-does-not-page — a holder alive inside the window opens no issue", async () => {
  const live = await fleet({ ids: IDS, ticks: 4, tickMs: 15 * MIN, held: ALL_HELD, signOfLifeAgeMs: 2 * MIN });
  assert.equal(live.stalls.length, 0, "a sign of life two minutes old is inside the 12-minute window");
  const floored = await fleet({ ids: IDS, ticks: 4, tickMs: 15 * MIN, held: ALL_HELD, signOfLifeAgeMs: 9 * MIN });
  assert.equal(floored.stalls.length, 0, "the window is floored at two renewal intervals, as the silence judge floors it");
  // A holder that renewed since the silence report holds a different anchor sha: the old report is not evidence.
  const lines = [...measuredBuilds(), { ts: iso(T0), run_id: "r", task_id: "B2", step: "dispatch.claim_unrenewed", ref: ref("B2"),
    sha: "f".repeat(40), holder: "4242@hand-host", last_sign_of_life: iso(T0 - 180 * MIN) }].map((r) => JSON.stringify(r));
  const refused: ClaimRefusedRun[] = [{ taskId: "B2", runId: "r2", refusal: { ref: ref("B2"), refusedAtMs: T0, holder: sha("B2") } }];
  assert.equal(decideClaimStall(lines, refused, T0, 2), undefined);
});

test("W1-T13248 criterion 3: a single refused tick, or a tick that admitted nothing, opens no issue", async () => {
  const single = await fleet({ ids: IDS, ticks: 1, tickMs: 15 * MIN, held: ALL_HELD, signOfLifeAgeMs: 180 * MIN });
  assert.equal(single.stalls.length, 0, "one refused tick is not a stall");
  // Refused, then a refused tick that did pass: not every run refused.
  const mixed = await fleet({ ids: ["A1", "C3"], ticks: 2, tickMs: 15 * MIN, held: new Set(["A1"]), signOfLifeAgeMs: 180 * MIN });
  assert.equal(mixed.stalls.length, 0);
  // Refused, an idle tick (the refused task sits out its six-hour deferral), then refused again: the idle tick breaks "consecutive".
  const idle = await fleet({ ids: ["A1"], ticks: 3, tickMs: 4 * 60 * MIN, held: new Set(["A1"]), signOfLifeAgeMs: 180 * MIN });
  assert.equal(idle.stalls.length, 0, "a tick that admitted nothing resets the streak");
});
