// test/sre-governor.test.ts — W1-T4390: the SRE gardener answers to an independent governor.
//
// Acceptance (plan/tasks.d/W1-T4390-*.yaml):
//   - an incident that returns after a successful act moves its runbook to shadow
//   - two runbooks that re-fire each other are both stopped and the operator is escalated
//   - a new fast burn after an act shadows the runbook that acted
//   - a shadowed runbook returns to live once its shadow record is clean
//   - the emergency stop, a pause or quiet hours stop every runbook
//   - the daemon pauses the SRE lane when the governor stops it, even if the lane never checked
//   - the core daemon evaluates the governor every tick (a grep proof; driven below as behaviour too)

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Escalation } from "../src/lib/escalate.js";
import { SRE_GOVERNOR_GLOBAL_HOLD_TEXT, runDaemon, stepSreGovernor } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  NEW_RUNBOOK_VERDICT,
  SRE_GOVERNOR_BASE_BACKOFF_MS,
  SRE_GOVERNOR_MEMORY_MS,
  SRE_GOVERNOR_SHADOW_CLEAN_MS,
  governorIncidentFromLedgerRow,
  governorTiersFromLedger,
  sreGovernorVerdict,
  verdictFor,
  type SreGovernorIncident,
  type SreGovernorReceipt,
} from "../src/lib/sre-governor.js";
import {
  daemonSreGovernorEnforcer,
  fleetControlsBesideLedger,
  ledgerGovernorVerdict,
  receiptFromLedgerRow,
  runMatchingRunbook,
  type IncidentEvidence,
  type SreGovernorEnforcer,
  type SreRunbook,
} from "../src/lib/sre-runbooks.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const FA = "a".repeat(64);
const FB = "b".repeat(64);
const FC = "c".repeat(64);
const FD = "d".repeat(64);
const A = "catch-up-managed-checkout";
const B = "recycle-stale-container";

function receipt(id: string, fingerprint: string, outcome: string, ts_ms: number, mode: SreGovernorReceipt["mode"] = "live", seen_ms?: number): SreGovernorReceipt {
  return { id, fingerprint, mode, outcome, ts_ms, seen_ms };
}

function event(fingerprint: string, ts: number, kind = "invariant", name = "stale-managed-checkout"): SreGovernorIncident {
  return { fingerprint, ts, kind, name };
}

/** A fast burn: `n` user-visible 5xx events inside one hour starting at `startMs`. */
function burn(fingerprint: string, startMs: number, n = 40): SreGovernorIncident[] {
  return Array.from({ length: n }, (_, i) => event(fingerprint, startMs + Math.floor((i * HOUR) / n), "http_5xx", "GET /v1/board"));
}

/** A runbook that already earned live: a would_act three days ago whose incident then cleared. */
function earned(id: string, fingerprint: string, atMs: number): { receipts: SreGovernorReceipt[]; incidents: SreGovernorIncident[] } {
  return { receipts: [receipt(id, fingerprint, "would_act", atMs, "shadow")], incidents: [event(fingerprint, atMs - MIN)] };
}

function ledgerRow(step: string, tsMs: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { ts: new Date(tsMs).toISOString(), step, task_id: "SRE", ...extra };
}

function receiptRow(r: SreGovernorReceipt): Record<string, unknown> {
  return ledgerRow("sre.runbook", r.ts_ms as number, { id: r.id, fingerprint: r.fingerprint, mode: r.mode, outcome: r.outcome, ...(r.seen_ms ? { seen_ms: r.seen_ms } : {}) });
}

function incidentRow(e: SreGovernorIncident): Record<string, unknown> {
  return ledgerRow("incident.event", e.ts, { task_id: "INCIDENT", fingerprint: e.fingerprint, kind: e.kind, name: e.name });
}

/** An in-memory enforcer whose `log` appends to the same ledger it reads — two ticks agree on "from". */
function memoryEnforcer(rows: Record<string, unknown>[], opts: { escalate?: boolean; laneOff?: string } = {}) {
  const escalations: Escalation[] = [];
  let off: string | undefined = opts.laneOff;
  const enforcer: SreGovernorEnforcer = {
    readLedger: () => rows,
    laneOff: () => off,
    pauseLane: (text) => {
      off = text;
    },
    resumeLane: () => {
      off = undefined;
    },
    escalate:
      opts.escalate === false
        ? undefined
        : (e) => {
            escalations.push(e);
            return `https://github.com/craigoley/remudero/issues/${escalations.length}`;
          },
  };
  const logAt = (nowMs: number) => (step: string, extra: Record<string, unknown> = {}) => rows.push(ledgerRow(step, nowMs, extra));
  return { enforcer, escalations, logAt, off: () => off };
}

function incident(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    fingerprint: FA,
    kind: "invariant",
    name: "stale-managed-checkout",
    sampleMessages: ["behind=3"],
    firstSeenMs: NOW - 10 * MIN,
    lastSeenMs: NOW - MIN,
    count: 2,
    burnPerHour: 2,
    deployShas: [],
    instances: ["core"],
    ...overrides,
  };
}

function scriptedRunbook(calls: string[]): SreRunbook {
  return {
    id: A,
    reversible: true,
    blastRadius: "checkout",
    matches: () => true,
    precheck: async () => {
      calls.push("precheck");
      return { ok: true, observed: "behind=3" };
    },
    act: async () => {
      calls.push("act");
    },
    verify: async () => ({ ok: true, observed: "behind=0" }),
  };
}

// ── the verdict ──────────────────────────────────────────────────────────────────────────────

test("an incident that returns after a successful act moves its runbook to shadow", () => {
  const actAt = NOW - 30 * MIN;
  const base = earned(A, FC, NOW - 3 * DAY);
  const receipts = [...base.receipts, receipt(A, FA, "cleared", actAt)];
  const before = sreGovernorVerdict(receipts, [...base.incidents, event(FA, actAt - 2 * MIN)], {}, NOW);
  assert.equal(before[A].tier, "live", `a cleared act with no return keeps the runbook live: ${before[A].reason}`);

  const after = sreGovernorVerdict(receipts, [...base.incidents, event(FA, actAt - 2 * MIN), event(FA, actAt + 10 * MIN)], {}, NOW);
  assert.equal(after[A].tier, "shadow");
  assert.match(after[A].reason, /loop: aaaaaaaaaaaa re-fired after catch-up-managed-checkout cleared it/);
  assert.equal(after[A].escalate, undefined, "a loop shadows; it does not page");

  const late = sreGovernorVerdict(receipts, [...base.incidents, event(FA, actAt + 2 * HOUR)], {}, NOW + 2 * HOUR);
  assert.equal(late[A].tier, "live", "a return after the loop window is a new incident, not a loop");
});

test("two runbooks that re-fire each other are both stopped and the operator is escalated", async () => {
  const t1 = NOW - 40 * MIN;
  const receipts = [receipt(A, FA, "cleared", t1), receipt(B, FB, "cleared", t1 + 10 * MIN)];
  const incidents = [event(FA, t1 - MIN), event(FB, t1 + 5 * MIN), event(FA, t1 + 15 * MIN)];
  const verdicts = sreGovernorVerdict(receipts, incidents, {}, NOW);
  for (const id of [A, B]) {
    assert.equal(verdicts[id].tier, "stopped", `${id}: ${verdicts[id].reason}`);
    assert.equal(verdicts[id].escalate, true);
    assert.match(verdicts[id].reason, /flapping: catch-up-managed-checkout and recycle-stale-container re-fire each other/);
  }

  // The lane's own enforcer pages the operator on that stopped verdict, and does not act.
  const calls: string[] = [];
  const escalations: Escalation[] = [];
  const logged: string[] = [];
  const result = await runMatchingRunbook(
    incident(),
    [scriptedRunbook(calls)],
    (id) => verdictFor(verdicts, id),
    () => [],
    (e) => {
      escalations.push(e);
      return "https://github.com/craigoley/remudero/issues/9";
    },
    (step) => logged.push(step),
    () => NOW,
  );
  assert.deepEqual(calls, ["precheck"], "a stopped runbook never acts");
  assert.equal(result.outcome, "held");
  assert.equal(result.escalatedUrl, "https://github.com/craigoley/remudero/issues/9");
  assert.match(escalations[0]?.summary ?? "", /governor stopped catch-up-managed-checkout: flapping/);

  // The daemon's enforcer pages once per stopped runbook, from the ledger alone.
  const rows = [...receipts.map(receiptRow), ...incidents.map(incidentRow)];
  const mem = memoryEnforcer(rows);
  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW), NOW);
  assert.deepEqual(mem.escalations.map((e) => e.taskId).sort(), [`SRE-GOVERNOR-${A}`, `SRE-GOVERNOR-${B}`]);
  assert.match(mem.escalations[0].detail, /re-fire each other/);
  assert.equal(mem.escalations[0].recommendation, mem.escalations[0].options[0].label);
});

test("a new fast burn after an act shadows the runbook that acted", () => {
  const actAt = NOW - 50 * MIN;
  const base = earned(A, FC, NOW - 3 * DAY);
  const incidents = [...base.incidents, event(FA, actAt - MIN), ...burn(FB, actAt + 5 * MIN)];
  const verdicts = sreGovernorVerdict([...base.receipts, receipt(A, FA, "cleared", actAt)], incidents, {}, NOW);
  assert.equal(verdicts[A].tier, "shadow");
  assert.match(verdicts[A].reason, /harm: fast burn bbbbbbbbbbbb started after catch-up-managed-checkout acted on aaaaaaaaaaaa/);

  const quiet = sreGovernorVerdict([...base.receipts, receipt(A, FA, "cleared", actAt)], [...base.incidents, event(FA, actAt - MIN), ...burn(FB, actAt + 5 * MIN, 3)], {}, NOW);
  assert.equal(quiet[A].tier, "live", "a slow trickle of a new fingerprint is not a fast burn, so not harm");

  const before = sreGovernorVerdict([...base.receipts, receipt(A, FA, "cleared", actAt)], [...base.incidents, ...burn(FB, actAt - 2 * HOUR)], {}, NOW);
  assert.equal(before[A].tier, "live", "a burn that started before the act is not the act's harm");
});

test("harm seen twice stops the runbook and pages the operator", () => {
  const first = NOW - 5 * HOUR;
  const second = NOW - 50 * MIN;
  const receipts = [receipt(A, FA, "cleared", first), receipt(A, FC, "failed", second)];
  const verdicts = sreGovernorVerdict(receipts, [...burn(FB, first + 5 * MIN), ...burn(FD, second + 5 * MIN)], {}, NOW);
  assert.equal(verdicts[A].tier, "stopped");
  assert.equal(verdicts[A].escalate, true);
  assert.match(verdicts[A].reason, /^harm seen twice: /);
  assert.equal(verdicts[A].evidence?.length, 2);

  // SELF-HEALING: a week on, the stop has aged out of memory — into shadow, never straight to live.
  const later = sreGovernorVerdict(receipts, [...burn(FB, first + 5 * MIN), ...burn(FD, second + 5 * MIN)], {}, NOW + SRE_GOVERNOR_MEMORY_MS + HOUR);
  assert.equal(later[A].tier, "shadow", later[A].reason);
  assert.match(later[A].reason, /no shadow receipt yet/);
});

test("a shadowed runbook returns to live once its shadow record is clean", () => {
  const actAt = NOW - 2 * DAY;
  const loopAt = actAt + 10 * MIN;
  const wouldAt = loopAt + HOUR;
  const receipts = [receipt(A, FA, "cleared", actAt), receipt(A, FA, "would_act", wouldAt, "shadow")];
  const incidents = [event(FA, actAt - MIN), event(FA, loopAt), event(FA, wouldAt - MIN)];

  const young = sreGovernorVerdict(receipts, incidents, {}, loopAt + 2 * HOUR);
  assert.equal(young[A].tier, "shadow");
  assert.match(young[A].reason, /younger than 24h/);

  const everyFive = Array.from({ length: Math.floor((NOW - wouldAt) / (5 * MIN)) }, (_, i) => event(FA, wouldAt + (i + 1) * 5 * MIN));
  const burning = sreGovernorVerdict(receipts, [...incidents, ...everyFive], {}, NOW);
  assert.equal(burning[A].tier, "shadow", "an incident that keeps firing without the runbook has not cleared");

  const clean = sreGovernorVerdict(receipts, incidents, {}, loopAt + SRE_GOVERNOR_SHADOW_CLEAN_MS + MIN);
  assert.equal(clean[A].tier, "live", clean[A].reason);
  assert.match(clean[A].reason, /earned live after loop: .* 1 incident\(s\) it would have acted on cleared without it/);

  // A NEW runbook starts in shadow and earns live the same way.
  assert.deepEqual(sreGovernorVerdict([], [], {}, NOW, [B])[B], NEW_RUNBOOK_VERDICT);
  assert.deepEqual(verdictFor({}, B), NEW_RUNBOOK_VERDICT);
  const fresh = [receipt(B, FB, "precheck_refused", NOW - 2 * DAY)];
  assert.match(sreGovernorVerdict(fresh, [], {}, NOW)[B].reason, /^new runbook; no shadow receipt yet/);
  const earnedNew = sreGovernorVerdict([...fresh, receipt(B, FB, "would_act", NOW - DAY, "shadow")], [event(FB, NOW - DAY - MIN)], {}, NOW);
  assert.equal(earnedNew[B].tier, "live");
  assert.match(earnedNew[B].reason, /^earned live: /);
});

test("the emergency stop, a pause or quiet hours stop every runbook", () => {
  const receipts = [receipt(A, FA, "cleared", NOW - DAY)];
  for (const [controls, why] of [
    [{ emergencyStop: "STOP requested: drill" }, /^emergency stop holds: STOP requested: drill$/],
    [{ pause: "PAUSE requested: deploy" }, /^pause holds: PAUSE requested: deploy$/],
    [{ quietHours: "overnight" }, /^quiet hours hold: overnight$/],
  ] as const) {
    const verdicts = sreGovernorVerdict(receipts, [], controls, NOW, [B]);
    assert.deepEqual(Object.keys(verdicts).sort(), [A, B]);
    for (const v of Object.values(verdicts)) {
      assert.equal(v.tier, "stopped");
      assert.equal(v.global, true);
      assert.equal(v.escalate, undefined, "a global hold never pages");
      assert.match(v.reason, why);
    }
  }

  // The lane reads those holds from the files fleet-control.ts writes beside the ledger.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sre-governor-controls-`));
  mkdirSync(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.jsonl");
  writeFileSync(ledgerPath, JSON.stringify(receiptRow(receipt(A, FA, "would_act", NOW - DAY, "shadow"))) + "\n");
  assert.deepEqual(fleetControlsBesideLedger(ledgerPath), { emergencyStop: undefined, pause: undefined, quietHours: undefined });
  writeFileSync(join(root, "state", "QUIET_HOURS"), "{}");
  writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ requestedAt: "2026-09-25T00:00:00Z", reason: "deploy" }));
  assert.deepEqual(fleetControlsBesideLedger(ledgerPath), { emergencyStop: undefined, pause: "PAUSE requested: deploy", quietHours: "QUIET_HOURS set" });
  const lane = ledgerGovernorVerdict(ledgerPath, [A], () => NOW);
  assert.equal(lane(A).tier, "stopped");
  assert.match(lane(A).reason, /^pause holds: /);
});

test("a fingerprint acted on again inside its backoff slows the runbook", () => {
  const base = earned(A, FC, NOW - 3 * DAY);
  const first = NOW - 40 * MIN;
  const second = NOW - 20 * MIN;
  const receipts = [...base.receipts, receipt(A, FA, "failed", first), receipt(A, FA, "failed", second)];
  const slow = sreGovernorVerdict(receipts, base.incidents, {}, NOW);
  assert.equal(slow[A].tier, "slow");
  assert.match(slow[A].reason, /aaaaaaaaaaaa acted on again inside its backoff \(1 repeat\(s\)\); next act after 40m/);

  const later = sreGovernorVerdict(receipts, base.incidents, {}, second + 2 * SRE_GOVERNOR_BASE_BACKOFF_MS);
  assert.equal(later[A].tier, "live", "the doubled window has elapsed");

  const spaced = [...base.receipts, receipt(A, FA, "failed", NOW - 2 * DAY), receipt(A, FA, "failed", NOW - 10 * MIN)];
  assert.equal(sreGovernorVerdict(spaced, base.incidents, {}, NOW)[A].tier, "live", "acts days apart are not a repeat");
});

// ── the daemon's enforcer ────────────────────────────────────────────────────────────────────

test("the daemon pauses the SRE lane when the governor stops it, even if the lane never checked", () => {
  // Only the lane's live acts are in the ledger — no `held` receipt: the lane never asked its governor.
  const t1 = NOW - 40 * MIN;
  const rows = [
    receiptRow(receipt(A, FA, "cleared", t1)),
    receiptRow(receipt(B, FB, "cleared", t1 + 10 * MIN, "live", t1 + 5 * MIN)),
    incidentRow(event(FA, t1 - MIN)),
    incidentRow(event(FA, t1 + 15 * MIN)),
  ];
  const mem = memoryEnforcer(rows);
  const verdicts = stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW), NOW);
  assert.equal(verdicts[A].tier, "stopped");
  assert.match(mem.off() ?? "", /^sre-governor: (catch-up-managed-checkout|recycle-stale-container) stopped — flapping/);
  const changes = rows.filter((r) => r.step === "sre.governor");
  assert.deepEqual(changes.map((r) => [r.runbook, r.from, r.to]).sort(), [[A, "none", "stopped"], [B, "none", "stopped"]]);
  assert.ok((changes[0].evidence as string[]).length > 0, "each change row carries its evidence");
  assert.equal(mem.escalations.length, 2);

  // The next tick reads its own rows back: no second page, no second change row.
  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW + MIN), NOW + MIN);
  assert.equal(mem.escalations.length, 2);
  assert.equal(rows.filter((r) => r.step === "sre.governor").length, 2);

  // An operator resumes the lane; a lane that then acts anyway (skipping its own check) is re-paused.
  mem.enforcer.resumeLane();
  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW + 2 * MIN), NOW + 2 * MIN);
  assert.equal(mem.off(), undefined, "a resumed lane stays resumed while it holds still");
  rows.push(receiptRow(receipt(A, FC, "cleared", NOW + 3 * MIN)));
  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW + 4 * MIN), NOW + 4 * MIN);
  assert.match(mem.off() ?? "", /^sre-governor: catch-up-managed-checkout stopped/);
  assert.ok(rows.some((r) => r.step === "sre.governor.lane_paused" && r.bypassed === true));
  assert.equal(mem.escalations.length, 2, "a bypass re-pauses quietly — the operator was paged at the stop");
});

test("a global hold pauses the lane only while it holds, and never lifts anyone else's pause", () => {
  const rows = [receiptRow(receipt(A, FA, "would_act", NOW - HOUR, "shadow")), incidentRow(event(FA, NOW - HOUR))];
  const mem = memoryEnforcer(rows);
  stepSreGovernor(mem.enforcer, { pause: "PAUSE requested: deploy" }, mem.logAt(NOW), NOW);
  assert.equal(mem.off(), `${SRE_GOVERNOR_GLOBAL_HOLD_TEXT}\n`);
  assert.equal(mem.escalations.length, 0);
  const stop = rows.find((r) => r.step === "sre.governor");
  assert.deepEqual([stop?.from, stop?.to, stop?.global], ["none", "stopped", true]);

  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW + MIN), NOW + MIN);
  assert.equal(mem.off(), undefined, "the hold lifted, so the lane resumes by itself");
  assert.deepEqual(rows.filter((r) => r.step === "sre.governor").map((r) => r.to), ["stopped", "shadow"]);

  const operator = memoryEnforcer([...rows], { laneOff: "operator: investigating\n" });
  stepSreGovernor(operator.enforcer, {}, operator.logAt(NOW + 2 * MIN), NOW + 2 * MIN);
  assert.equal(operator.off(), "operator: investigating\n");
});

test("a stop with no repo to escalate under is ledgered, and an empty ledger does nothing", () => {
  const t1 = NOW - 40 * MIN;
  const rows = [receiptRow(receipt(A, FA, "cleared", t1)), receiptRow(receipt(B, FB, "cleared", t1 + 10 * MIN)), incidentRow(event(FB, t1 + 5 * MIN)), incidentRow(event(FA, t1 + 15 * MIN))];
  const mem = memoryEnforcer(rows, { escalate: false });
  stepSreGovernor(mem.enforcer, {}, mem.logAt(NOW), NOW);
  assert.equal(rows.filter((r) => r.step === "sre.governor.escalation_unwired").length, 2);
  assert.ok(mem.off());

  const empty = memoryEnforcer([incidentRow(event(FA, NOW))]);
  assert.deepEqual(stepSreGovernor(empty.enforcer, { pause: "held" }, empty.logAt(NOW), NOW), {});
  assert.equal(empty.off(), undefined);
});

test("the core daemon evaluates the governor every tick, and a governor that throws never stops the daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sre-governor-daemon-`));
  writeFileSync(join(dir, "tasks.yaml"), "- id: A\n  title: task A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
  const plan: Plan = loadPlan(join(dir, "tasks.yaml"));
  const t1 = NOW - 40 * MIN;
  const rows = [receiptRow(receipt(A, FA, "cleared", t1)), receiptRow(receipt(B, FB, "cleared", t1 + 10 * MIN)), incidentRow(event(FB, t1 + 5 * MIN)), incidentRow(event(FA, t1 + 15 * MIN))];
  const mem = memoryEnforcer(rows);
  const logged: string[] = [];
  const heapExit = { used_heap_size: 8e9, heap_size_limit: 8.2e9 };
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async () => {
      throw new Error("the heap exit must come before dispatch");
    },
    sleep: async () => {},
    heapStatistics: () => heapExit,
    now: () => new Date(NOW),
    sreGovernor: mem.enforcer,
    log: (step) => logged.push(step),
  });
  assert.equal(summary.stopReason, "heap_pressure");
  assert.ok(mem.off(), "one tick was enough to pause the lane");
  assert.ok(logged.indexOf("sre.governor") > logged.indexOf("daemon.tick"), "evaluated inside the tick");

  const failing: string[] = [];
  const again = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async () => {
      throw new Error("unreached");
    },
    sleep: async () => {},
    heapStatistics: () => heapExit,
    sreGovernor: { ...mem.enforcer, readLedger: () => { throw new Error("ledger unreadable"); } },
    log: (step, extra) => failing.push(`${step}:${String(extra?.reason ?? "")}`),
  });
  assert.equal(again.stopReason, "heap_pressure");
  assert.ok(failing.includes("sre.governor.failed:ledger unreadable"));
});

// ── the real ports ───────────────────────────────────────────────────────────────────────────

test("the daemon's governor port reads the real ledger and flips the real pause switch", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sre-governor-port-`));
  const ledgerPath = join(root, "ledger.jsonl");
  const laneOffPath = join(root, "SRE_LANE_OFF");
  const row = receiptRow(receipt(A, FA, "cleared", NOW - HOUR));
  writeFileSync(ledgerPath, JSON.stringify(row) + "\n");
  const port = daemonSreGovernorEnforcer({ ledgerPath, laneOffPath });
  assert.equal(port.readLedger().length, 1);
  assert.equal(receiptFromLedgerRow(port.readLedger()[0])?.ts_ms, NOW - HOUR, "a receipt carries its ledger instant");
  assert.equal(port.laneOff(), undefined);
  port.pauseLane("sre-governor: x stopped\n");
  assert.equal(readFileSync(laneOffPath, "utf8"), "sre-governor: x stopped\n");
  assert.equal(port.laneOff(), "sre-governor: x stopped\n");
  port.resumeLane();
  assert.equal(existsSync(laneOffPath), false);
  port.resumeLane(); // already gone: still resumed, never a throw
  mkdirSync(laneOffPath);
  mkdirSync(join(laneOffPath, "held"));
  assert.throws(() => port.resumeLane(), "an unlink that fails for any other reason is not swallowed");
});

test("ledger rows the governor reads: incidents, and the tier each runbook last moved to", () => {
  assert.deepEqual(governorIncidentFromLedgerRow(incidentRow(event(FA, NOW))), event(FA, NOW));
  assert.equal(governorIncidentFromLedgerRow({ step: "incident.sampled", fingerprint: FA, kind: "x", name: "y", ts: "garbage" }), undefined);
  assert.equal(governorIncidentFromLedgerRow({ step: "incident.event", fingerprint: FA }), undefined);
  assert.equal(governorIncidentFromLedgerRow({ step: "daemon.tick" }), undefined);

  const tiers = governorTiersFromLedger([
    ledgerRow("sre.governor", NOW - HOUR, { runbook: A, from: "none", to: "shadow" }),
    ledgerRow("sre.governor", NOW, { runbook: A, from: "shadow", to: "stopped", global: true }),
    { step: "sre.governor", runbook: B, to: "live" },
    ledgerRow("sre.governor", NOW, { runbook: B, to: "bogus" }),
    ledgerRow("sre.runbook", NOW, { runbook: A, to: "live" }),
  ]);
  assert.deepEqual(tiers.get(A), { tier: "stopped", atMs: NOW, global: true });
  assert.deepEqual(tiers.get(B), { tier: "live", atMs: 0, global: false });

  assert.equal(sreGovernorVerdict([{ id: A, fingerprint: FA, mode: "live", outcome: "cleared" }], [], {}, NOW)[A], undefined, "an untimed receipt is not evidence");
  assert.equal(sreGovernorVerdict([], [event(FA, NOW + HOUR)], {}, NOW, [A])[A].tier, "shadow", "a future row is ignored");
});
