// W1-T5939 — A GITHUB ACTIONS INCIDENT PAUSES THE LANES THAT SPEND CI. During the 2026-10-05 outage
// (19:15-21:45Z; githubstatus.com listed Actions degraded, then major_outage) jobs that never got a
// runner were cancelled after ~15 min and ci-gate timed out. The sweep acted on every one as an
// ordinary red: 200 job-requeue 403s, FLAKE fix workers, strikes and escalations. Nothing in src read
// GitHub's status. This suite pins the reader (each status, the cache, unreadable as its own state,
// the default seam against a LOCAL server — never githubstatus.com) and the sweep's hold: a red that
// is only cancelled or never-started checks is held during an incident, requeued once after it, and
// escalated once at the BACKSTOP, while a real test failure and a green PR are handled as before.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACTIONS_INCIDENT_HOLD_BACKSTOP_MS,
  ACTIONS_INCIDENT_HOLD_ESCALATED_STEP,
  ACTIONS_INCIDENT_HOLD_STEP,
  ACTIONS_STATUS_CACHE_MS,
  GITHUB_STATUS_SUMMARY_URL,
  actionsIncidentHoldDecision,
  actionsIncidentHoldsFromLedger,
  classifyActionsIncident,
  createActionsStatusReader,
  unreadableActionsIncident,
} from "../src/lib/actions-incident.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  CHECK_REQUEUE_DEFERRED_STEP,
  CHECK_REQUEUE_STEP,
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type CancelledRequiredCheck,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T20:50:00Z");
const HEAD = "c0ffee5939aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function summary(actions: string | undefined, incidents: unknown[] = []): unknown {
  const components: Array<Record<string, unknown>> = [{ name: "Git Operations", status: "operational" }];
  if (actions !== undefined) components.push({ name: "Actions", status: actions });
  return { page: { id: "kctbh9vrtdwd" }, components, incidents };
}

const ACTIONS_INCIDENT = { name: "Incident with Actions", status: "investigating", components: [{ name: "Actions" }] };

// ── the classifier ──────────────────────────────────────────────────────────────────────────────

test("classifyActionsIncident names each Actions status, and unreadable is never operational", () => {
  assert.equal(classifyActionsIncident(summary("operational")).state, "operational");
  assert.equal(classifyActionsIncident(summary("degraded_performance")).state, "degraded");
  assert.equal(classifyActionsIncident(summary("partial_outage")).state, "degraded");
  assert.equal(classifyActionsIncident(summary("under_maintenance")).state, "degraded");
  assert.equal(classifyActionsIncident(summary("major_outage")).state, "major_outage");
  const outage = classifyActionsIncident(summary("major_outage", [ACTIONS_INCIDENT]));
  assert.match(outage.detail, /major_outage/);
  assert.match(outage.detail, /Incident with Actions/, "the open incident is named");

  // An open incident naming Actions while the component still reads operational is an incident.
  const named = classifyActionsIncident(summary("operational", [{ name: "Incident with Actions", status: "identified" }]));
  assert.equal(named.state, "degraded");
  assert.match(named.detail, /Incident with Actions/);
  const byComponent = classifyActionsIncident(summary("operational", [{ name: "Delays", status: "monitoring", components: [{ name: "Actions" }] }]));
  assert.equal(byComponent.state, "degraded", "an incident listing the Actions component counts too");
  // A resolved incident, or one about another service, is not.
  assert.equal(classifyActionsIncident(summary("operational", [{ ...ACTIONS_INCIDENT, status: "resolved" }])).state, "operational");
  assert.equal(classifyActionsIncident(summary("operational", [{ name: "Incident with Codespaces", status: "investigating" }])).state, "operational");
  assert.equal(classifyActionsIncident(summary("operational", ["not an incident"])).state, "operational");

  for (const [why, payload] of [
    ["not an object", "<html>"],
    ["no components array", { incidents: [] }],
    ["no Actions component", summary(undefined)],
    ["an unknown status word", summary("melting")],
  ] as const) {
    const reading = classifyActionsIncident(payload);
    assert.equal(reading.state, "unreadable", why);
    assert.notEqual(reading.state, "operational", why);
  }
  assert.deepEqual(unreadableActionsIncident(new Error("HTTP 503")), { state: "unreadable", detail: "githubstatus.com unreadable: HTTP 503" });
  assert.equal(unreadableActionsIncident("socket hang up").detail, "githubstatus.com unreadable: socket hang up");
});

test("the hold decision: an incident holds, operational releases, unreadable only keeps an existing hold", () => {
  const incident = classifyActionsIncident(summary("major_outage"));
  const operational = classifyActionsIncident(summary("operational"));
  const unreadable = unreadableActionsIncident(new Error("timeout"));
  const held = { heldAtMs: T0, escalated: false };
  assert.equal(actionsIncidentHoldDecision(incident, undefined, T0), "hold");
  assert.equal(actionsIncidentHoldDecision(classifyActionsIncident(summary("degraded_performance")), undefined, T0), "hold");
  assert.equal(actionsIncidentHoldDecision(operational, undefined, T0), "proceed");
  assert.equal(actionsIncidentHoldDecision(operational, held, T0), "proceed", "the incident cleared");
  assert.equal(actionsIncidentHoldDecision(unreadable, undefined, T0), "proceed", "unreadable starts no hold");
  assert.equal(actionsIncidentHoldDecision(unreadable, held, T0), "hold", "unreadable never reads as operational");
  assert.equal(actionsIncidentHoldDecision(incident, held, T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS - 1), "hold");
  assert.equal(actionsIncidentHoldDecision(incident, held, T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS), "escalate");
  assert.equal(actionsIncidentHoldDecision(incident, { ...held, escalated: true }, T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS), "proceed");
});

test("actionsIncidentHoldsFromLedger folds holds, escalations and the fresh-requeue keys a later requeue spends", () => {
  const lines = [
    { step: CHECK_REQUEUE_STEP, head_sha: "h1", check_name: "test (1/8)" },
    { step: ACTIONS_INCIDENT_HOLD_STEP, pr_number: 1, head_sha: "h1", held_at_ms: T0, cancelled_checks: [{ name: "test (1/8)", run_attempt: 2 }, { name: "lint", run_attempt: null }, "junk"] },
    { step: ACTIONS_INCIDENT_HOLD_STEP, pr_number: 2, head_sha: "h2", held_at_ms: "not a number" },
    { step: ACTIONS_INCIDENT_HOLD_ESCALATED_STEP, pr_number: 3, head_sha: "h3" },
    { step: CHECK_REQUEUE_STEP, head_sha: "h1", check_name: "lint" },
    { step: ACTIONS_INCIDENT_HOLD_STEP, pr_number: 4, head_sha: "h4", held_at_ms: T0, cancelled_checks: [{ name: "ci", run_attempt: 1 }] },
    { step: CHECK_REQUEUE_STEP, head_sha: "h4", check_name: "ci" },
    { step: CHECK_REQUEUE_DEFERRED_STEP, head_sha: "h4", check_name: "ci", outcome: "deferred" },
    { step: CHECK_REQUEUE_DEFERRED_STEP, head_sha: "h1", check_name: "never-held", outcome: "deferred" },
  ];
  const { holds, fresh } = actionsIncidentHoldsFromLedger(lines, CHECK_REQUEUE_STEP, CHECK_REQUEUE_DEFERRED_STEP);
  assert.deepEqual(holds.get("1@h1"), { heldAtMs: T0, escalated: false });
  assert.deepEqual(holds.get("2@h2"), { heldAtMs: 0, escalated: false }, "an unreadable stamp ages to the BACKSTOP, never freezes");
  assert.deepEqual(holds.get("3@h3"), { heldAtMs: 0, escalated: true });
  assert.equal(fresh.get("h1@test (1/8)"), 2, "the pre-hold requeue is voided at the attempt the hold saw");
  assert.equal(fresh.has("h1@lint"), false, "a requeue after the hold spends the fresh one");
  assert.equal(fresh.get("h4@ci"), 1, "a W1-T5920 deferral (refused while in flight) gives the fresh requeue back");
  assert.equal(fresh.has("h1@never-held"), false);
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(ACTIONS_INCIDENT_HOLD_STEP), "the hold survives rotation");
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(ACTIONS_INCIDENT_HOLD_ESCALATED_STEP));
});

// ── the reader ──────────────────────────────────────────────────────────────────────────────────

test("the status reader caches one read for a few minutes, then reads again", async () => {
  let now = T0;
  const reads: number[] = [];
  const read = createActionsStatusReader({
    clock: clockFromMillisFn(() => now),
    fetchJson: async () => {
      reads.push(now);
      return summary(reads.length === 1 ? "major_outage" : "operational");
    },
  });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(reads.length, 1, "single-flight");
  assert.equal(classifyActionsIncident(a).state, "major_outage");
  assert.equal(a, b);
  now += ACTIONS_STATUS_CACHE_MS - 1;
  await read();
  assert.equal(reads.length, 1, "cached within the window");
  now += 1;
  assert.equal(classifyActionsIncident(await read()).state, "operational");
  assert.equal(reads.length, 2, "re-read once the window passes");
  assert.ok(ACTIONS_STATUS_CACHE_MS >= 60_000 && ACTIONS_STATUS_CACHE_MS <= 5 * 60_000, "at most once per few minutes");
});

test("a failed status read is cached too and surfaces as an error, never as a summary", async () => {
  let now = T0;
  let calls = 0;
  const read = createActionsStatusReader({
    clock: clockFromMillisFn(() => now),
    fetchJson: async () => {
      calls++;
      if (calls === 1) throw new Error("status request returned HTTP 503");
      return summary("operational");
    },
  });
  await assert.rejects(read(), /HTTP 503/);
  await assert.rejects(read(), /HTTP 503/, "the failure is cached, not retried every pass");
  assert.equal(calls, 1);
  now += ACTIONS_STATUS_CACHE_MS;
  assert.equal(classifyActionsIncident(await read()).state, "operational");
});

async function serve(status: number, body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/summary.json` };
}

test("the default status seam really fetches, against a local server and never githubstatus.com", async () => {
  assert.equal(GITHUB_STATUS_SUMMARY_URL, "https://www.githubstatus.com/api/v2/summary.json");
  const ok = await serve(200, JSON.stringify(summary("major_outage", [ACTIONS_INCIDENT])));
  try {
    const reading = classifyActionsIncident(await createActionsStatusReader({ url: ok.url })());
    assert.equal(reading.state, "major_outage");
  } finally {
    ok.server.close();
  }
  const down = await serve(503, "{}");
  try {
    await assert.rejects(createActionsStatusReader({ url: down.url })(), /HTTP 503/);
  } finally {
    down.server.close();
  }
  const hung = createServer(() => {});
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/`;
    await assert.rejects(createActionsStatusReader({ url, timeoutMs: 50 })(), "a hung read times out");
  } finally {
    hung.closeAllConnections();
    hung.close();
  }
});

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────

const CANCELLED: CancelledRequiredCheck[] = [{ name: "test (3/8)", jobId: "301", runAttempt: 1 }];

function cancelledPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9396,
    prUrl: "https://github.com/craigoley/remudero/pull/9396",
    taskId: "W1-T5900",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(T0 - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: "run-W1-T5900-1791230000000",
    autoMergeArmed: false,
    redRequiredChecks: ["test (3/8)"],
    ciFailures: [{ name: "test (3/8)", conclusion: "CANCELLED", jobId: "301", logTail: "" }],
    cancelledRequiredChecks: CANCELLED,
    ...over,
  };
}

const TIMEOUT_LINE =
  "ci-gate: TIMED OUT waiting for required check(s) to complete (this is NOT a check failure -- a NEW sha " +
  "is the only remedy, re-running this same sha will not help):";

function timedOutPr(): OpenPrView {
  return cancelledPr({
    prNumber: 9388,
    prUrl: "https://github.com/craigoley/remudero/pull/9388",
    redRequiredChecks: [],
    ciFailures: [{ name: "ci-gate", conclusion: "FAILURE", jobId: "900", logTail: `##[error]${TIMEOUT_LINE}\n  - rule-checks\n` }],
    cancelledRequiredChecks: [],
  });
}

function realFailurePr(): OpenPrView {
  const failure: CiFailure = { name: "test (5/8)", conclusion: "FAILURE", jobId: "501", logTail: "not ok 7 - real\n# fail 1" };
  return cancelledPr({ prNumber: 9415, prUrl: "https://github.com/craigoley/remudero/pull/9415", headSha: "beef9415", redRequiredChecks: ["test (5/8)"], ciFailures: [failure], cancelledRequiredChecks: [] });
}

function greenPr(): OpenPrView {
  return cancelledPr({
    prNumber: 9420,
    prUrl: "https://github.com/craigoley/remudero/pull/9420",
    headSha: "green9420",
    reviewState: "success",
    checksState: "green",
    redRequiredChecks: [],
    ciFailures: [],
    cancelledRequiredChecks: [],
    isPlanFiling: false,
  });
}

interface Harness {
  deps: SweepDeps;
  fixed: Array<{ pr: number; evidence: FixDispatchEvidence }>;
  requeued: string[];
  escalated: string[];
  cancelledEscalations: string[];
  updated: number[];
  armed: number[];
  statusReads: number;
}

function harness(ledgerPath: string, status: () => unknown, now: number): Harness {
  const h: Harness = { deps: undefined as unknown as SweepDeps, fixed: [], requeued: [], escalated: [], cancelledEscalations: [], updated: [], armed: [], statusReads: 0 };
  h.deps = {
    log: () => {},
    arm: (pr) => {
      h.armed.push(pr.prNumber);
      return "armed";
    },
    close: () => {},
    dispatchFix: (pr, evidence) => {
      h.fixed.push({ pr: pr.prNumber, evidence });
    },
    escalate: (_pr, reason) => {
      h.escalated.push(reason);
    },
    requeueCheck: (_pr, check) => {
      h.requeued.push(check.name);
      return true;
    },
    escalateCancelledCheck: (_pr, check, reason) => {
      h.cancelledEscalations.push(`${check.name}: ${reason}`);
    },
    updateBranch: (pr) => {
      h.updated.push(pr.prNumber);
      return "updated";
    },
    readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
    readActionsStatusSummary: async () => {
      h.statusReads++;
      return status();
    },
    ledgerPath,
    runId: "SWEEP-W1-T5939",
    now: () => now,
  };
  return h;
}

function ledger(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5939-${label}-`)), "ledger.ndjson");
}

function rows(path: string, step: string): Array<Record<string, unknown>> {
  return readLedgerLines(path).filter((line) => line.step === step);
}

function disposed(path: string, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(path).findLast((line) => line.step === "sweep.disposed" && line.pr_number === prNumber);
}

test("during an Actions incident a cancelled-only red is held: no requeue, fix dispatch, strike or escalation", async () => {
  const path = ledger("hold");
  for (let pass = 0; pass < 3; pass++) {
    const h = harness(path, () => summary("major_outage", [ACTIONS_INCIDENT]), T0 + pass * 60_000);
    await runSweep([cancelledPr()], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.requeued, [], "no job requeue into an outage (the 200 403s)");
    assert.deepEqual(h.fixed, [], "no FLAKE fix worker");
    assert.deepEqual(h.escalated, []);
    assert.deepEqual(h.cancelledEscalations, []);
    const row = disposed(path, 9396);
    assert.equal(row?.acted, false, "no strike is spent");
    assert.match(String(row?.stand_down_reason), /GitHub Actions major_outage/);
    assert.match(String(row?.stand_down_reason), /Incident with Actions/);
    assert.equal(row?.blocker, "awaiting-ci", "waiting on GitHub's CI, not the PR's own red");
  }
  const holds = rows(path, ACTIONS_INCIDENT_HOLD_STEP);
  assert.equal(holds.length, 1, "one hold row per PR and head");
  assert.equal(holds[0].pr_number, 9396);
  assert.equal(holds[0].head_sha, HEAD);
  assert.equal(holds[0].actions_status, "major_outage");
  assert.equal(holds[0].held_at_ms, T0);
  assert.deepEqual(holds[0].cancelled_checks, [{ name: "test (3/8)", run_attempt: 1 }]);
});

test("a ci-gate timeout on never-started checks is held too, with no update-branch until Actions recovers", async () => {
  const path = ledger("timeout");
  const during = harness(path, () => summary("degraded_performance"), T0);
  await runSweep([timedOutPr()], during.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(during.updated, []);
  assert.deepEqual(during.fixed, []);
  assert.deepEqual(during.escalated, []);
  assert.deepEqual(rows(path, ACTIONS_INCIDENT_HOLD_STEP)[0].not_ready_checks, ["rule-checks"]);

  const after = harness(path, () => summary("operational"), T0 + 60 * 60_000);
  await runSweep([timedOutPr()], after.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(after.updated, [9388], "W1-T5921's new head, once Actions is operational");
  assert.deepEqual(after.fixed, []);
});

test("a red with real test-failure evidence is handled as before during the incident, and a green PR is still armed", async () => {
  const path = ledger("unaffected");
  const h = harness(path, () => summary("major_outage", [ACTIONS_INCIDENT]), T0);
  const real = realFailurePr();
  const mixed = cancelledPr({ prNumber: 9416, prUrl: "https://github.com/craigoley/remudero/pull/9416", headSha: "beef9416",
    ciFailures: [...(cancelledPr().ciFailures ?? []), ...(real.ciFailures ?? [])], redRequiredChecks: ["test (3/8)", "test (5/8)"] });
  await runSweep([real, mixed, greenPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.fixed.map((f) => f.pr), [9415, 9416], "the ordinary fix rung, a cancellation beside a real failure included");
  assert.deepEqual(h.armed, [9420], "arming green PRs continues");
  assert.equal(rows(path, ACTIONS_INCIDENT_HOLD_STEP).length, 0);
  assert.equal(h.statusReads, 0, "the status is read only for a red the hold could apply to");
  assert.equal(disposed(path, 9420)?.acted, true);
});

test("once Actions is operational again a held PR gets ONE fresh requeue, even past a pre-incident requeue", async () => {
  const path = ledger("recover");
  // Before the incident was seen, the ordinary lane had already spent its one requeue on this head.
  appendLedger(path, { run_id: "SWEEP-early", task_id: "W1-T5900", step: CHECK_REQUEUE_STEP, pr_number: 9396, head_sha: HEAD, check_name: "test (3/8)" });
  const attempt2 = cancelledPr({ cancelledRequiredChecks: [{ ...CANCELLED[0], runAttempt: 2 }] });
  const during = harness(path, () => summary("major_outage"), T0);
  await runSweep([attempt2], during.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(during.cancelledEscalations, [], "the second cancellation is the outage's, not escalated");

  const after = harness(path, () => summary("operational"), T0 + 30 * 60_000);
  await runSweep([attempt2], after.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(after.requeued, ["test (3/8)"], "one fresh requeue");
  assert.deepEqual(after.cancelledEscalations, []);
  assert.deepEqual(after.fixed, []);

  // Cancelled AGAIN after the fresh requeue: the ordinary W1-T1223 bound applies, never a second requeue.
  const again = harness(path, () => summary("operational"), T0 + 60 * 60_000);
  await runSweep([cancelledPr({ cancelledRequiredChecks: [{ ...CANCELLED[0], runAttempt: 3 }] })], again.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(again.requeued, []);
  assert.equal(again.cancelledEscalations.length, 1);
});

test("an unreadable status neither starts a hold nor releases one", async () => {
  const fresh = ledger("unreadable-fresh");
  const cold = harness(fresh, () => {
    throw new Error("status request returned HTTP 503");
  }, T0);
  await runSweep([cancelledPr()], cold.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(cold.requeued, ["test (3/8)"], "no incident evidence: the ordinary bounded requeue");
  assert.equal(rows(fresh, ACTIONS_INCIDENT_HOLD_STEP).length, 0);

  const path = ledger("unreadable-held");
  await runSweep([cancelledPr()], harness(path, () => summary("major_outage"), T0).deps, DEFAULT_SWEEP_POLICY);
  const blind = harness(path, () => "<html>503</html>", T0 + 60_000);
  await runSweep([cancelledPr()], blind.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(blind.requeued, [], "an unreadable status is never read as operational");
  assert.match(String(disposed(path, 9396)?.stand_down_reason), /GitHub Actions unreadable/);
});

test("the hold is bounded: past the BACKSTOP it escalates once and then stops holding", async () => {
  const path = ledger("backstop");
  const outage = () => summary("major_outage", [ACTIONS_INCIDENT]);
  await runSweep([cancelledPr()], harness(path, outage, T0).deps, DEFAULT_SWEEP_POLICY);
  const late = harness(path, outage, T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS);
  await runSweep([cancelledPr()], late.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(late.escalated.length, 1, "the hold's own BACKSTOP, and no own-red stage stall for the held hours");
  assert.match(late.escalated[0], /BACKSTOP/);
  assert.deepEqual(late.requeued, []);
  assert.equal(rows(path, ACTIONS_INCIDENT_HOLD_ESCALATED_STEP).length, 1);

  const after = harness(path, outage, T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS + 60_000);
  await runSweep([cancelledPr()], after.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(after.escalated, [], "escalated once, never again");
  assert.deepEqual(after.requeued, ["test (3/8)"], "a stuck status read cannot freeze the fleet");
  assert.deepEqual(after.fixed, []);
});
