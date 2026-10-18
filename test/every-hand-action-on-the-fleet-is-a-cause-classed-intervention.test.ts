import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { fixLaneInventoryOf, interventionsFromPullRequest } from "#src/lib/fix-lane-gardener.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import {
  deriveControlInterventions,
  interventionFingerprint,
  interventionFromLedgerRow,
  interventionIncidentEvent,
  interventionKey,
  interventionLedgerLine,
  normalizeClassToken,
  prCauseClass,
} from "#src/lib/operator-interventions.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { runSreLanePass } from "#src/lib/sre-lane.js";

// The 2026-10-11 core ledger, replayed: a Codex supervisor paused core, and sessions resumed it by hand.
const NOW = Date.parse("2026-10-11T19:00:00Z");
const T = (hhmm: string) => `2026-10-11T${hhmm}:00.000Z`;

const REPLAY: Record<string, unknown>[] = [
  { ts: T("12:05"), step: "fleet.pause", scope: "instance", instance: "core", reason: "codex supervisor pausing for 3 tasks", actor: "operator_ai", run_id: "FLEET-1" },
  { ts: T("12:29"), step: "fleet.resume", scope: "instance", instance: "core", actor: "operator_human", run_id: "FLEET-2" },
  { ts: T("12:40"), step: "fleet.pause", scope: "instance", instance: "core", reason: "codex supervisor pausing for 4 tasks", actor: "operator_ai", run_id: "FLEET-3" },
  { ts: T("12:46"), step: "fleet.resume", scope: "instance", instance: "core", actor: "unknown", run_id: "FLEET-4" },
  { ts: T("13:00"), step: "fleet.pause", scope: "instance", instance: "core", reason: "recycle for deploy", actor: "daemon", run_id: "FLEET-5" },
  { ts: T("13:10"), step: "fleet.resume", scope: "instance", instance: "core", actor: "operator_human", run_id: "FLEET-6" },
  { ts: T("15:00"), step: "dispatch.circuit_broken", task: "W1-T7742", task_id: "W1-T7742", actor: "daemon", run_id: "R-1" },
  { ts: T("15:30"), step: "dispatch.circuit_broken.verified", task_id: "W1-T7742", disposition: "requeue", actor: "daemon", run_id: "R-2" },
  { ts: T("16:07"), step: "dispatch.breaker_released", task_id: "W1-T7742", task: "W1-T7742", reason: "hand", actor: "operator_ai", run_id: "RELEASE-1" },
];

test("W1-T8264: a hand resume is classed by the hold it ended", () => {
  const found = deriveControlInterventions(REPLAY);
  const resumes = found.filter((i) => i.action === "fleet.resume");
  assert.deepEqual(resumes.map((i) => [i.at, i.cause_class]), [
    [T("12:29"), "foreign-pause:codex-supervisor-pausing-for-tasks"],
    [T("12:46"), "foreign-pause:codex-supervisor-pausing-for-tasks"],
    [T("13:10"), "automation-pause:recycle-for-deploy"],
  ], "the 12:29 and 12:46 resumes each write one intervention, classed by the pause they ended, not by the action");
  assert.ok(resumes.every((i) => i.surface === "control" && i.source === "ledger"));
  // the hand pauses are interventions too, classed on their own reason
  assert.deepEqual(found.filter((i) => i.action === "fleet.pause").map((i) => i.cause_class),
    ["hand-pause:codex-supervisor-pausing-for-tasks", "hand-pause:codex-supervisor-pausing-for-tasks"]);
  // a release takes the breaker's verified disposition
  const released = found.find((i) => i.action === "dispatch.breaker_released")!;
  assert.equal(released.target, "W1-T7742");
  assert.equal(released.cause_class, "breaker:requeue");
  // a re-read of the same window gives the same rows, so nothing is minted twice
  assert.deepEqual(deriveControlInterventions([...REPLAY, ...REPLAY]), found);
  // a resume with no recorded hold names that absence, never the action
  const lone = deriveControlInterventions([{ ts: T("09:00"), step: "fleet.resume", scope: "fleet", actor: "operator_human" }]);
  assert.equal(lone[0]!.cause_class, "hold-ended:unrecorded-hold");
  // a state-changing cli verb is an intervention; pause/resume verbs are covered by their own rows
  const cli = deriveControlInterventions([
    { ts: T("14:00"), step: "cli.invoked", verb: "release", actor: "operator_human", run_id: "C1" },
    { ts: T("14:01"), step: "cli.invoked", verb: "resume", actor: "operator_human", run_id: "C2" },
    { ts: T("14:02"), step: "cli.invoked", verb: "status", actor: "operator_human", run_id: "C3" },
  ]);
  assert.deepEqual(cli.map((i) => [i.action, i.cause_class]), [["cli.release", "cli-release:no-recorded-cause"]]);
  // W1-T7839 actor evidence is carried when present
  const evidenced = deriveControlInterventions([{ ts: T("09:00"), step: "fleet.resume", scope: "fleet", actor: "operator_ai", actor_evidence: { session: "s-1" } }]);
  assert.deepEqual(evidenced[0]!.actor_evidence, { session: "s-1" });
  // a written row reads back as the same intervention
  assert.deepEqual(interventionFromLedgerRow(interventionLedgerLine(released) as Record<string, unknown>), released);
  assert.equal(interventionFromLedgerRow({ step: "operator.intervention", at: 1 }), undefined);
  assert.equal(interventionFromLedgerRow({ step: "other" }), undefined);
});

test("W1-T8264: a hand push is classed by the disposition it answered", () => {
  const disposed = (pr: number, ts: string, blocker: string, owner: string, reason: string): LedgerRecord =>
    ({ step: "sweep.disposed", pr_number: pr, ts, blocker, blocker_owner: owner, reason });
  const records: LedgerRecord[] = [
    disposed(10866, T("13:00"), "own-red", "fix-lane", "deferred to full sweep (run 1234, 12m)"),
    disposed(10866, T("15:00"), "awaiting-ci", "ci", "waiting"),
    disposed(10787, T("13:00"), "escalated", "NONE", ""),
  ];
  const pushed = (pr: number, at: string) => ({ pr, at, kind: "push" as const, actor: "craigoley", detail: "commit abc pushed to a fleet PR", ref: "abc" });
  const inventory = fixLaneInventoryOf(records, [], new Map(), {
    ok: true, interventions: [pushed(10866, T("14:00")), pushed(10787, T("14:05")), pushed(10842, T("14:10"))],
  }, NOW);
  assert.deepEqual([...inventory.interventions.byClass].sort(), [
    ["escalated:none", 1],
    ["own-red:fix-lane:deferred-to-full-sweep", 1],
    ["undisposed:none", 1],
  ], "the newest disposition AT the push answers it; the later awaiting-ci row does not");
  assert.equal([...inventory.interventions.byClass.keys()].some((k) => k.startsWith("operator-intervention:")), false);
  assert.deepEqual(inventory.priced.map((p) => p.key).sort(), ["escalated:none", "own-red:fix-lane:deferred-to-full-sweep", "undisposed:none"]);
  // each finding yields one operator.intervention row on the PR surface, deduped against rows already written
  assert.deepEqual(inventory.interventions.fresh.map((r) => [r.surface, r.action, r.target, r.cause_class]), [
    ["pr", "push", "pr#10866@abc", "own-red:fix-lane:deferred-to-full-sweep"],
    ["pr", "push", "pr#10787@abc", "escalated:none"],
    ["pr", "push", "pr#10842@abc", "undisposed:none"],
  ]);
  const again = fixLaneInventoryOf([...records, ...inventory.interventions.fresh.map((r) => ({ ...interventionLedgerLine(r) } as unknown as LedgerRecord))],
    [], new Map(), { ok: true, interventions: [pushed(10866, T("14:00"))] }, NOW);
  assert.deepEqual(again.interventions.fresh, []);
  assert.equal(prCauseClass(records, 10866, Date.parse(T("12:00"))), "undisposed:none", "nothing disposed yet at that moment");
  assert.equal(normalizeClassToken(undefined), "");
  assert.equal(normalizeClassToken("Retry in 45 min after deadbeef1234 on 7 hosts"), "retry-in-after-on-hosts");
});

test("W1-T8264: a hand update-branch and a hand merge are recognised", () => {
  const commit = (oid: string, committedDate: string, message: string, parents: number, login: string | null) =>
    ({ commit: { oid, committedDate, message, parents: { totalCount: parents }, author: { name: login ?? "x", user: login ? { login } : null } } });
  const node = {
    author: { login: "remudero-fleet[bot]" }, state: "MERGED", mergedAt: T("15:00"), mergedBy: { login: "craigoley" },
    commits: { nodes: [
      commit("1111111111", T("14:00"), "fix: bot work", 1, "remudero-fleet[bot]"),
      commit("2222222222", T("14:30"), "Merge branch 'main' into run-W1-T1-1", 2, "craigoley"),
      commit("3333333333", T("14:40"), "fix(ci): hand fix", 1, "craigoley"),
    ] },
  };
  const found = interventionsFromPullRequest(10829, node, Date.parse(T("00:00")));
  assert.deepEqual(found.map((i) => [i.kind, i.ref]), [["update-branch", "222222222"], ["push", "333333333"], ["merge", "merge"]]);
  // a merge by the fleet is not an intervention, and neither is one before the window
  assert.deepEqual(interventionsFromPullRequest(1, { ...node, mergedBy: { login: "remudero-fleet[bot]" }, commits: { nodes: [] } }, 0), []);
  assert.deepEqual(interventionsFromPullRequest(1, { ...node, commits: { nodes: [] } }, Date.parse(T("16:00"))), []);
});

test("W1-T8264: fleet automation is never an intervention", () => {
  const rows: Record<string, unknown>[] = [];
  for (const actor of ["daemon", "service", "worker", "test", "host_automation"]) {
    for (const step of ["fleet.pause", "fleet.resume", "dispatch.breaker_released", "automerge.hold_engaged", "automerge.hold_released", "cli.invoked"]) {
      rows.push({ ts: T("10:00"), step, verb: "release", actor, scope: "fleet", task_id: "W1-T1", run_id: `${actor}-${step}` });
    }
  }
  assert.deepEqual(deriveControlInterventions(rows), []);
  // the same rows from a hand are interventions: the actor is the only difference
  assert.equal(deriveControlInterventions(rows.map((r) => ({ ...r, actor: "operator_human" }))).length, 6 * 5);
  // a row with no actor at all is unknown, which is not fleet automation
  assert.equal(deriveControlInterventions([{ ts: T("10:00"), step: "fleet.pause", scope: "fleet" }]).length, 1);
  // a malformed timestamp is skipped, never guessed
  assert.deepEqual(deriveControlInterventions([{ ts: "nope", step: "fleet.pause", actor: "operator_human" }]), []);
});

test("W1-T8264: an intervention class is one incident fingerprint", async () => {
  const found = deriveControlInterventions(REPLAY);
  const resumes = found.filter((i) => i.action === "fleet.resume");
  const events = resumes.map((i) => interventionIncidentEvent(i, NOW));
  assert.equal(new Set(events.map((e) => e.fingerprint)).size, 2, "two resumes of one class share a fingerprint; the third class differs");
  assert.equal(events[0]!.fingerprint, events[1]!.fingerprint);
  assert.notEqual(events[0]!.fingerprint, events[2]!.fingerprint);
  assert.equal(events[0]!.kind, "intervention");
  assert.equal(events[0]!.name, resumes[0]!.cause_class);
  assert.equal(events[0]!.fingerprint, interventionFingerprint(resumes[0]!.cause_class));
  assert.equal(interventionKey(resumes[0]!), `control|fleet.resume|core|${T("12:29")}`);

  const stateDir = mkdtempSync(join(tmpdir(), "rmd-intervention-"));
  try {
    const pass = () => runSreLanePass({
      stateDir, root: stateDir, mergedLastDay: () => 1, clock: fixedClock(NOW), detectors: [],
      readFlowRows: () => REPLAY, readEvents: () => [], hasOpenTask: () => false, framesFor: () => [],
      mergedPrsSince: () => [], log: () => {},
    });
    await pass();
    const written = () => readFileSync(join(stateDir, LEDGER_FILENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const first = written();
    const rows = first.filter((r) => r.step === "operator.intervention");
    const incidents = first.filter((r) => r.step === "incident.event");
    assert.equal(rows.length, found.length, "one operator.intervention row per hand action");
    assert.equal(incidents.length, found.length, "and one routed incident.event each");
    assert.ok(incidents.every((e) => e.kind === "intervention" && e.name === rows.find((r) => r.cause_class === e.name)?.cause_class));
    assert.equal(new Set(incidents.map((e) => e.fingerprint)).size, new Set(found.map((i) => i.cause_class)).size);
    // a second pass over the same window writes nothing new
    await pass();
    assert.equal(written().length, first.length);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
