// W1-T5939 — a GitHub Actions incident pauses the lanes that spend CI. During the 2026-10-05 outage
// jobs that never got a runner were cancelled, and the sweep spent requeues, FLAKE fix workers,
// strikes and escalations on each one. This suite pins that, while githubstatus reports an Actions
// incident, a red made only of cancelled/never-started checks is HELD (one hold row per PR and
// head, no fix, no strike, no requeue, no escalation), that it gets ONE fresh requeue when Actions
// is operational again, that a real test failure is handled exactly as before, that an unreadable
// status is named and never read as operational, and that the hold is bounded by a BACKSTOP.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";

import {
  ACTIONS_INCIDENT_BACKSTOP_MS,
  actionsIncidentHoldState,
  cancelledOnlyRedChecks,
  classifyActionsIncident,
  createActionsStatusReader,
  fetchActionsStatusJson,
  type ActionsStatusRead,
} from "../src/lib/actions-incident.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  buildSweepEffects,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

const HEAD = "c0ffee00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T0 = Date.parse("2026-10-05T20:00:00Z");

function summary(actions: string, incidents: unknown[] = []): ActionsStatusRead {
  return {
    ok: true,
    fetchedAtMs: T0,
    body: {
      components: [
        { name: "Git Operations", status: "operational" },
        { name: "Actions", status: actions },
      ],
      incidents,
    },
  };
}
const MAJOR = summary("major_outage", [{ name: "Incident with Actions", status: "investigating", components: [{ name: "Actions" }] }]);
const OPERATIONAL = summary("operational");
const UNREADABLE: ActionsStatusRead = { ok: false, error: "getaddrinfo ENOTFOUND www.githubstatus.com", fetchedAtMs: T0 };

// The outage shape: test shards cancelled before a runner, and the `ci` aggregate CANCELLED with an
// empty tail — which the ordinary path reads as a ci-log red and hands to a paid fix worker.
const CANCELLED_AGGREGATE: CiFailure = { name: "ci", conclusion: "CANCELLED", jobId: "501", logTail: "" };

function subject(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9391,
    prUrl: "https://github.com/craigoley/remudero/pull/9391",
    taskId: "W1-T5900",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T19:50:00Z", // expiring-fixture: exempt -- every runSweep below injects `now` (harness), so the age comparison never reads the wall clock
    headSha: HEAD,
    headRefName: "run-W1-T5900-1791200000000",
    autoMergeArmed: false,
    redRequiredChecks: ["ci", "test (1/8)"],
    ciFailures: [CANCELLED_AGGREGATE],
    cancelledRequiredChecks: [{ name: "test (1/8)", jobId: "71" }],
    ...overrides,
  };
}

interface Harness {
  d: SweepDeps;
  requeued: string[];
  fixed: FixDispatchEvidence[];
  escalated: string[];
  updated: string[];
  statusReads: number;
}

function harness(ledgerPath: string, status: ActionsStatusRead | undefined, nowMs = T0): Harness {
  const h: Harness = { d: undefined as unknown as SweepDeps, requeued: [], fixed: [], escalated: [], updated: [], statusReads: 0 };
  h.d = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      h.fixed.push(evidence);
    },
    escalate: (_pr, reason) => {
      h.escalated.push(reason);
    },
    escalateCancelledCheck: (_pr, check, reason) => {
      h.escalated.push(`${check.name}: ${reason}`);
    },
    requeueCheck: (_pr, check) => {
      h.requeued.push(check.name);
      return true;
    },
    updateBranch: (pr) => {
      h.updated.push(pr.headSha);
      return "updated";
    },
    readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
    ...(status
      ? {
          readActionsStatus: () => {
            h.statusReads += 1;
            return status;
          },
        }
      : {}),
    ledgerPath,
    runId: "SWEEP-W1-T5939",
    now: () => nowMs,
  };
  return h;
}

function ledger(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5939-${label}-`)), "ledger.ndjson");
}

const rows = (path: string, step: string) => readLedgerLines(path).filter((line) => line.step === step);
const disposed = (path: string) => readLedgerLines(path).findLast((line) => line.step === "sweep.disposed" && line.head_sha === HEAD);

test("classifyActionsIncident: degraded, outage and an open Actions incident are incidents; only a clean read is operational", () => {
  assert.equal(classifyActionsIncident(OPERATIONAL).state, "operational");
  assert.equal(classifyActionsIncident(summary("degraded_performance")).state, "incident");
  const major = classifyActionsIncident(MAJOR);
  assert.equal(major.state, "incident");
  assert.equal(major.componentStatus, "major_outage");
  assert.equal(major.incident, "Incident with Actions");
  // The component can lag the incident: an unresolved incident naming Actions is an incident.
  assert.equal(classifyActionsIncident(summary("operational", [{ name: "Incident with Actions", status: "identified" }])).state, "incident");
  // A resolved one, or one about another component, is not.
  assert.equal(classifyActionsIncident(summary("operational", [{ name: "Incident with Actions", status: "resolved" }])).state, "operational");
  assert.equal(
    classifyActionsIncident(summary("operational", [{ name: "Incident with Pages", status: "investigating", components: [{ name: "Pages" }] }])).state,
    "operational",
  );
});

test("classifyActionsIncident: an unreadable status is named and never read as operational", () => {
  const cases: ActionsStatusRead[] = [
    UNREADABLE,
    { ok: true, fetchedAtMs: T0, body: "<html>rate limited</html>" },
    { ok: true, fetchedAtMs: T0, body: { components: [{ name: "Pages", status: "operational" }] } },
    { ok: true, fetchedAtMs: T0, body: { components: [{ name: "Actions", status: "melting" }] } },
    { ok: true, fetchedAtMs: T0, body: { components: [{ name: "Actions" }] } },
    { ok: true, fetchedAtMs: T0, body: { components: [{ name: "Actions", status: "operational" }], incidents: {} } },
  ];
  for (const read of cases) {
    const obs = classifyActionsIncident(read);
    assert.equal(obs.state, "unreadable", JSON.stringify(read));
    assert.match(obs.reason, /githubstatus/);
  }
  assert.match(classifyActionsIncident(UNREADABLE).reason, /ENOTFOUND/);
});

test("createActionsStatusReader: one fetch per TTL window, and a thrown fetch is an unreadable read, never a throw", async () => {
  let at = T0;
  let fetches = 0;
  let fail = false;
  const read = createActionsStatusReader({
    now: () => at,
    freshMs: 60_000,
    fetchJson: async (signal) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      fetches += 1;
      if (fail) throw new Error("HTTP 503");
      return OPERATIONAL.ok ? OPERATIONAL.body : undefined;
    },
  });
  assert.equal(classifyActionsIncident(await read()).state, "operational");
  at += 30_000;
  await read();
  assert.equal(fetches, 1, "cached inside the window");
  at += 30_000;
  fail = true;
  const failed = await read();
  assert.equal(fetches, 2);
  assert.equal(failed.ok, false);
  assert.equal(classifyActionsIncident(failed).state, "unreadable");
  assert.equal(failed.fetchedAtMs, at, "the shared time seam stamps the read at the TTL boundary");
  at += 30_000;
  assert.equal(await read(), failed, "unreadable reads are cached inside the same window");
  assert.equal(fetches, 2);
});

test("cancelledOnlyRedChecks: only a red made wholly of cancelled or never-started checks qualifies", () => {
  assert.deepEqual(cancelledOnlyRedChecks(subject()), ["test (1/8)", "ci"]);
  const real: CiFailure = { name: "test (3/8)", conclusion: "FAILURE", logTail: "not ok 4 - real\n# fail 1" };
  assert.equal(cancelledOnlyRedChecks(subject({ ciFailures: [CANCELLED_AGGREGATE, real] })), undefined);
  assert.equal(
    cancelledOnlyRedChecks(subject({ ciFailures: [{ name: "rule-checks", conclusion: "FAILURE", logTail: "rule 15" }] })),
    undefined,
    "a FAILURE with no cancellation signal is evidence",
  );
  assert.equal(cancelledOnlyRedChecks(subject({ redRequiredChecks: ["ci", "test (1/8)", "typecheck"] })), undefined,
    "a red check with no cancellation evidence is not proven verdict-free");
  assert.equal(cancelledOnlyRedChecks({ redRequiredChecks: [], ciFailures: [], cancelledRequiredChecks: [] }), undefined);
});

test("test/a-github-actions-incident-pauses-the-lanes-that-spend-ci.test.ts: during an Actions incident a cancelled-only red is held: no fix dispatch, strike, requeue or escalation", async () => {
  const path = ledger("hold");
  const h = harness(path, MAJOR);
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(h.fixed.length, 0, "no paid fix worker for a red the outage made");
  assert.deepEqual(h.requeued, [], "no job requeue into an outage");
  assert.deepEqual(h.escalated, []);
  const holds = rows(path, "sweep.actions_incident_hold");
  assert.equal(holds.length, 1);
  assert.equal(holds[0].pr_number, 9391);
  assert.equal(holds[0].head_sha, HEAD);
  assert.equal(holds[0].actions_state, "incident");
  assert.equal(holds[0].component_status, "major_outage");
  assert.equal(holds[0].held_since, "2026-10-05T20:00:00.000Z", "the hold uses the injected sweep time");
  const row = disposed(path);
  assert.equal(row?.acted, false, "nothing seeds prior.fixed, and no strike is spent");
  assert.equal(row?.actions_state, "incident");
  assert.match(String(row?.stand_down_reason), /GitHub Actions incident/);

  // Next pass, still in the incident: still held, and still ONE hold row per PR and head.
  const again = harness(path, MAJOR);
  await runSweep([subject()], again.d, DEFAULT_SWEEP_POLICY);
  assert.equal(again.fixed.length, 0);
  assert.deepEqual(again.requeued, []);
  assert.deepEqual(again.escalated, []);
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 1);
});

test("without the incident gate the same red dispatches a fix worker (the falsifier)", async () => {
  const path = ledger("ungated");
  const h = harness(path, OPERATIONAL);
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.requeued, ["test (1/8)"], "the ordinary cancelled-check requeue");
  assert.equal(h.fixed.length, 1, "the ordinary path spends a fix worker on the cancelled aggregate");
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 0);
});

test("a strike-exhausted cancelled-only red is not escalated during the incident", async () => {
  const path = ledger("exhausted");
  const h = harness(path, MAJOR);
  await runSweep([subject({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap })], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.escalated, []);
  assert.equal(h.fixed.length, 0);
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 1);
  assert.equal(rows(path, "sweep.actions_incident_hold")[0].disposition, "blocked-ambiguous");
});

test("a PR with real test-failure evidence is handled as before during the incident", async () => {
  const path = ledger("genuine");
  const h = harness(path, MAJOR);
  const real: CiFailure = { name: "test (3/8)", conclusion: "FAILURE", jobId: "33", logTail: "not ok 7 - real\n# fail 1" };
  await runSweep([subject({ redRequiredChecks: ["test (3/8)"], ciFailures: [real], cancelledRequiredChecks: [] })], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(h.fixed.length, 1, "the ordinary fix rung");
  assert.equal(h.statusReads, 0, "a real failure never waits on the status read");
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 0);
});

test("when Actions is operational again a held PR gets exactly one fresh requeue, and no fix strike", async () => {
  const path = ledger("recover");
  await runSweep([subject()], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  const back = harness(path, OPERATIONAL, T0 + 90 * 60_000);
  await runSweep([subject()], back.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(back.requeued.sort(), ["ci", "test (1/8)"], "every held check is requeued once");
  assert.equal(back.fixed.length, 0);
  assert.deepEqual(back.escalated, []);
  const requeue = rows(path, "sweep.actions_incident_requeue");
  assert.equal(requeue.length, 1);
  assert.equal(requeue[0].route, "job_requeue");
  assert.match(String(disposed(path)?.stand_down_reason), /operational again: one fresh requeue/);
  assert.equal(actionsIncidentHoldState(readLedgerLines(path), { prNumber: 9391, headSha: HEAD }).open, false);

  // The recovery requeue is spent: a still-cancelled snapshot next pass is never requeued again.
  const after = harness(path, OPERATIONAL, T0 + 100 * 60_000);
  await runSweep([subject()], after.d, DEFAULT_SWEEP_POLICY);
  assert.equal(rows(path, "sweep.actions_incident_requeue").length, 1);
  assert.ok(!after.requeued.includes("test (1/8)"), "no second requeue of the held check");
});

test("a held ci-gate timeout recovers through W1-T5921's new head, not a same-sha requeue", async () => {
  const path = ledger("timeout");
  const gate: CiFailure = {
    name: "ci-gate",
    conclusion: "FAILURE",
    jobId: "900",
    logTail: "##[error]ci-gate: TIMED OUT waiting for required check(s) to complete (a NEW sha is the only remedy):\n  - rule-checks",
  };
  const pr = subject({ redRequiredChecks: ["ci-gate"], ciFailures: [gate], cancelledRequiredChecks: [] });
  const held = harness(path, MAJOR);
  await runSweep([pr], held.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(held.updated, [], "no refresh into the outage");
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 1);
  const back = harness(path, OPERATIONAL, T0 + 60 * 60_000);
  await runSweep([pr], back.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(back.updated, [HEAD], "the new head is the remedy");
  assert.deepEqual(back.requeued, []);
  assert.equal(back.fixed.length, 0);
  assert.equal(rows(path, "sweep.actions_incident_requeue")[0]?.route, "ci_timeout_refresh");
});

test("an unreadable status keeps an existing hold, is named, and never triggers the recovery requeue", async () => {
  const path = ledger("unreadable");
  await runSweep([subject()], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  const blind = harness(path, UNREADABLE, T0 + 30 * 60_000);
  await runSweep([subject()], blind.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(blind.requeued, [], "unreadable is not operational");
  assert.equal(blind.fixed.length, 0);
  assert.equal(rows(path, "sweep.actions_incident_requeue").length, 0);
  const row = disposed(path);
  assert.equal(row?.actions_state, "unreadable");
  assert.match(String(row?.stand_down_reason), /unreadable/);
  assert.match(String(row?.stand_down_reason), /never read as operational/);
});

test("an unreadable status with no hold names itself on the disposed row and opens no hold", async () => {
  const path = ledger("unreadable-fresh");
  const h = harness(path, UNREADABLE);
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 0, "no positive incident, no hold");
  assert.equal(disposed(path)?.actions_state, "unreadable");
  assert.match(String(disposed(path)?.actions_reason), /ENOTFOUND/);
});

test("a reader that throws is classified unreadable, never a crashed pass", async () => {
  const path = ledger("throws");
  const h = harness(path, MAJOR);
  h.d.readActionsStatus = () => {
    throw new Error("socket hang up");
  };
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(disposed(path)?.actions_state, "unreadable");
  assert.match(String(disposed(path)?.actions_reason), /socket hang up/);
});

test("the BACKSTOP: a hold older than the bound escalates ONCE and ordinary handling resumes", async () => {
  const path = ledger("backstop");
  await runSweep([subject()], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  const stuck = harness(path, MAJOR, T0 + ACTIONS_INCIDENT_BACKSTOP_MS + 60_000);
  await runSweep([subject()], stuck.d, DEFAULT_SWEEP_POLICY);
  assert.equal(stuck.escalated.length, 1);
  assert.match(stuck.escalated[0], /BACKSTOP/);
  assert.equal(stuck.fixed.length, 0);
  assert.deepEqual(stuck.requeued, []);
  assert.equal(rows(path, "sweep.actions_incident_backstop").length, 1);

  const later = harness(path, MAJOR, T0 + ACTIONS_INCIDENT_BACKSTOP_MS + 10 * 60_000);
  await runSweep([subject()], later.d, DEFAULT_SWEEP_POLICY);
  assert.equal(rows(path, "sweep.actions_incident_backstop").length, 1, "escalated once per (PR, head)");
  assert.ok(!later.escalated.some((reason) => /BACKSTOP/.test(reason)));
  assert.deepEqual(later.requeued, ["test (1/8)"], "the hold no longer freezes this head");
});

test("an operational observation releases an old hold instead of escalating a recovered incident", async () => {
  const path = ledger("late-recovery");
  await runSweep([subject()], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  const recovered = harness(path, OPERATIONAL, T0 + ACTIONS_INCIDENT_BACKSTOP_MS + 60_000);
  await runSweep([subject()], recovered.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(recovered.escalated, []);
  assert.deepEqual(recovered.requeued.sort(), ["ci", "test (1/8)"]);
  assert.equal(rows(path, "sweep.actions_incident_requeue").length, 1);
  assert.equal(rows(path, "sweep.actions_incident_backstop").length, 0);
});

test("a new head is not held by the old head's hold", () => {
  const lines = [{ step: "sweep.actions_incident_hold", pr_number: 9391, head_sha: HEAD, held_since: "2026-10-05T20:00:00.000Z" }];
  assert.equal(actionsIncidentHoldState(lines, { prNumber: 9391, headSha: HEAD }).open, true);
  assert.equal(actionsIncidentHoldState(lines, { prNumber: 9391, headSha: "pushed" }).open, false);
  assert.equal(actionsIncidentHoldState(lines, { prNumber: 1, headSha: HEAD }).open, false);
});

test("the hold, requeue and backstop rows survive rotation, because the gate reads them back", () => {
  for (const step of ["sweep.actions_incident_hold", "sweep.actions_incident_requeue", "sweep.actions_incident_backstop"]) {
    assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), step);
  }
});

test("concurrent status reads share one fetch and cache its failure", async () => {
  let fetches = 0;
  const read = createActionsStatusReader({ fetchJson: async () => {
    fetches += 1;
    throw new Error("HTTP 503");
  } });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(fetches, 1);
  assert.equal(first, second);
  assert.equal(classifyActionsIncident(await read()).state, "unreadable");
  assert.equal(fetches, 1);
});

test("a missing incident list is unreadable even when the Actions component says operational", () => {
  assert.equal(classifyActionsIncident({ ok: true, fetchedAtMs: T0,
    body: { components: [{ name: "Actions", status: "operational" }] } }).state, "unreadable");
});

test("real failure evidence wins over a cancellation with the same check name", () => {
  assert.equal(cancelledOnlyRedChecks(subject({ redRequiredChecks: ["test (1/8)"], ciFailures: [
    { name: "test (1/8)", conclusion: "CANCELLED", logTail: "not ok 1 - failed before cancellation\n# fail 1" },
  ] })), undefined);
});

test("incident recovery retries a deferred current attempt without repeating an accepted requeue", async () => {
  const path = ledger("deferred-recovery");
  const pr = subject({ cancelledRequiredChecks: [{ name: "test (1/8)", jobId: "71", runAttempt: 2 }] });
  await runSweep([pr], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  const first = harness(path, OPERATIONAL, T0 + 60_000);
  first.d.requeueCheck = (_pr, check) => {
    first.requeued.push(check.name);
    return check.name === "test (1/8)"
      ? { kind: "deferred", refusal: "already_running", error: "workflow run already running (HTTP 403)" }
      : { kind: "dispatched" };
  };
  await runSweep([pr], first.d, DEFAULT_SWEEP_POLICY);
  assert.equal(actionsIncidentHoldState(readLedgerLines(path), pr).open, true);
  assert.equal(rows(path, "sweep.actions_incident_requeue").length, 0);
  const retry = harness(path, OPERATIONAL, T0 + 120_000);
  retry.d.readCiGateRollup = () => [{ name: "test (1/8)", conclusion: "CANCELLED", status: "COMPLETED", jobId: "72" }];
  const jobs: Array<string | undefined> = [];
  retry.d.requeueCheck = (_pr, check) => { jobs.push(check.jobId); retry.requeued.push(check.name); return true; };
  await runSweep([pr], retry.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(retry.requeued, ["test (1/8)"]);
  assert.deepEqual(jobs, ["72"]);
  assert.deepEqual(retry.escalated, []);
  assert.equal(retry.fixed.length, 0);
  assert.equal(rows(path, "sweep.actions_incident_requeue").length, 1);
  assert.equal(actionsIncidentHoldState(readLedgerLines(path), pr).open, false);
});

test("the incident gate precedes a paid plan repair round", async () => {
  const path = ledger("plan-round");
  const h = harness(path, MAJOR);
  let rounds = 0;
  h.d.readPlanRepairFacts = () => ({ authorLogin: "remudero-fleet[bot]" });
  h.d.repairPlanPr = () => ({ outcome: "unwired" });
  h.d.dispatchPlanGateRound = async () => { rounds += 1; return { outcome: "refused", reason: "test round" }; };
  await runSweep([subject({ isPlanFiling: true, headRefName: "ci-friction-garden-1790927000000" })], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(rounds, 0);
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 1);
  assert.deepEqual(h.escalated, []);
});

test("incident recovery carries the requeue deferral backstop reason and escalates it once", async () => {
  const path = ledger("recovery-backstop");
  const pr = subject();
  await runSweep([pr], harness(path, MAJOR).d, DEFAULT_SWEEP_POLICY);
  for (let attempt = 0; attempt < CHECK_REQUEUE_DEFERRAL_BACKSTOP; attempt += 1) {
    const h = harness(path, OPERATIONAL, T0 + (attempt + 1) * 60_000);
    h.d.requeueCheck = (_pr, check) => check.name === "ci" ? { kind: "dispatched" }
      : { kind: "deferred", refusal: "already_running", error: "already running (HTTP 403)" };
    await runSweep([pr], h.d, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.escalated, []);
    assert.equal(h.fixed.length, 0);
  }
  const capped = harness(path, OPERATIONAL, T0 + 10 * 60_000);
  await runSweep([pr], capped.d, DEFAULT_SWEEP_POLICY);
  assert.equal(capped.escalated.length, 1);
  assert.match(capped.escalated[0], /BACKSTOP/);
  assert.match(capped.escalated[0], /already_running/);
  assert.deepEqual(capped.requeued, []);
  const later = harness(path, OPERATIONAL, T0 + 11 * 60_000);
  await runSweep([pr], later.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(later.escalated, []);
  assert.deepEqual(later.requeued, []);
});

test("an incident holds cancelled reds while green PRs arm and reviews continue", async () => {
  const path = ledger("other-lanes");
  const h = harness(path, MAJOR);
  const armed: number[] = [];
  const reviewed: number[] = [];
  h.d.arm = pr => { armed.push(pr.prNumber); };
  h.d.postReview = async pr => { reviewed.push(pr.prNumber); };
  const green: Partial<OpenPrView> = { checksState: "green", ciFailures: [], cancelledRequiredChecks: [], redRequiredChecks: [] };
  await runSweep([subject(), subject({ prNumber: 9392 }),
    subject({ ...green, prNumber: 9393, reviewState: "success", unmetCriteria: [] }),
    subject({ ...green, prNumber: 9394, reviewState: "none" })], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(armed, [9393]);
  assert.deepEqual(reviewed, [9394]);
  assert.equal(h.statusReads, 1);
  assert.equal(rows(path, "sweep.actions_incident_hold").length, 2);
});

test("the default status transport reads bounded JSON and names HTTP and malformed-response failures", async t => {
  const server = createServer((request, response) => {
    if (request.url === "/error") { response.writeHead(503).end("unavailable"); return; }
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/malformed" ? "{" : JSON.stringify(OPERATIONAL.ok ? OPERATIONAL.body : {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal(classifyActionsIncident({ ok: true, fetchedAtMs: T0, body: await fetchActionsStatusJson(url) }).state, "operational");
  await assert.rejects(fetchActionsStatusJson(`${url}/error`), /HTTP 503/);
  await assert.rejects(fetchActionsStatusJson(`${url}/malformed`), /JSON/);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => realFetch(url, init));
  assert.equal(classifyActionsIncident(await createActionsStatusReader()()).state, "operational");
  const testContext = process.env.NODE_TEST_CONTEXT;
  const input = { owner: "craigoley", repo: "remudero", config: { root: tmpdir() } as Config,
    ledgerPath: ledger("effects"), runId: "W1-T5939", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {} };
  assert.equal(buildSweepEffects(input).readActionsStatus, undefined);
  try {
    delete process.env.NODE_TEST_CONTEXT;
    const effects = buildSweepEffects(input);
    assert.ok(effects.readActionsStatus);
    assert.equal(classifyActionsIncident(await effects.readActionsStatus()).state, "operational");
  } finally {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
  }
});
