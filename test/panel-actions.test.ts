import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import {
  bearerTokenId,
  DRAIN_FEEDBACK_VERDICTS,
  type IssueCloser,
  type PanelActionDeps,
} from "../src/lib/panel-actions.js";
import type { GitHub } from "../src/lib/status.js";
import { consumeDrainNow, isPaused, isQuietHours, isStopped, kickFilePath, pauseDetail, pendingKicks, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── W3-T5: human-in-the-loop panel actions (MASTER-PLAN §7) ────────────────────────────────
//
// Acceptance (plan/tasks.yaml):
//   (1) "an escalation answered FROM the panel appears in the ledger with the panel's bearer
//       token as origin=<panel bearer token id>; the answer flows to the Architect" — proven
//       below by POSTing /v1/questions/answer and reading the resulting ledger line back.
//   (2) "STOP from the panel halts the fleet within one tick" — proven by POSTing
//       /v1/control/stop and asserting fleet-control.ts's `isStopped`/`stopDetail` (the SAME
//       predicate drain.ts checks first, every tick) flips synchronously.
//
// Same discipline as test/board.test.ts: real server/fetch() plumbing, never a mock of either.
// Business logic (fleet-control.ts flag files, the ledger) is EXISTING and already covered by its
// own suite — these tests exercise scope, request validation and ledger attribution, not
// fleet-control.ts's flag semantics again.
//
// CORRECTION, and it is why `withService` was migrated: this paragraph used to claim these tests
// covered "route registration". They did not. The helper built its own service from ten
// hand-listed builders, so the suite could not see the console's registration at all — proven by
// unmounting `buildDrainFeedbackRoute` in serve.ts, against which the old harness passed 37/37
// while the six /v1/drain/feedback tests below were exercising a route no operator could reach.
// The helper now assembles through `buildServeServer`, so that same mutation fails exactly those
// six. Registration COVERAGE is still test/route-registration.test.ts's job, and which root each
// route reads is test/route-wiring.test.ts's; what changed here is that this suite is no longer
// blind to either.

const READ_TOKEN = "panel-read-token";
const WRITE_TOKEN = "panel-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-panel-actions-"));
}

function ledgerPathFor(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function depsFor(root: string, issues: IssueCloser = fakeIssueCloser()): PanelActionDeps {
  return { root, ledgerPath: ledgerPathFor(root), issues };
}

/**
 * Stand the console up THE WAY `rmd serve` DOES — `buildServeServer`, the same assembler
 * `src/run-task.ts` calls — instead of hand-listing the route builders.
 *
 * WHY THIS CHANGED. This helper used to build its own service from ten hand-listed builders. That
 * is a SECOND registration list, and a suite driven from it is blind to the real one: every test
 * below passed in full while `POST /v1/drain/feedback` was declared, aggregated, exercised here —
 * and never mounted on the console, because `serve.ts` imported ten builders and the aggregator
 * returned eleven. Six tests in this file stood up a real HTTP server, made real requests and
 * asserted real 200s against a route no operator could reach. impl-EQ measured the same contrast
 * from the other side: "my route-level suite fails 6 of 7; the pre-existing handler suite passes
 * 15/15, completely blind."
 *
 * Routing every test through the production assembler removes the second list. Deleting a route's
 * line from `serve.ts` now turns this suite red.
 *
 * ONE ROOT, DELIBERATELY. Production gives `buildServeServer` two different roots
 * (`fleetControlRoot: config.root`, `questionsRoot: repoRoot`) and this helper points both at the
 * caller's single `deps.root`, preserving every existing test's semantics exactly. That is the
 * right split of duties, not an omission: which route reads WHICH root is asserted by
 * test/route-wiring.test.ts, using two distinct directories. This file's job is handler behaviour
 * — validation, scope, ledger attribution — on a correctly assembled server.
 */
function serveDepsFor(deps: PanelActionDeps): ServeDeps {
  mkdirSync(join(deps.root, "plan"), { recursive: true });
  const planPath = join(deps.root, "plan", "tasks.yaml");
  if (!existsSync(planPath)) writeFileSync(planPath, "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: deps.ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root: deps.root,
      planPath,
      ledgerPath: deps.ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath: deps.ledgerPath,
    issues: deps.issues,
    fleetControlRoot: deps.root,
    questionsRoot: deps.root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

async function withService<T>(deps: PanelActionDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(serveDepsFor(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── bearerTokenId ────────────────────────────────────────────────────────────

test("bearerTokenId: same token -> same id; different tokens -> different ids; never the raw token", () => {
  const req1 = { headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any;
  const req2 = { headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any;
  const req3 = { headers: { authorization: "Bearer some-other-token" } } as any;
  const id1 = bearerTokenId(req1);
  const id2 = bearerTokenId(req2);
  const id3 = bearerTokenId(req3);
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.doesNotMatch(id1, new RegExp(WRITE_TOKEN));
  assert.equal(id1, createHash("sha256").update(WRITE_TOKEN).digest("hex").slice(0, 12));
});

test("bearerTokenId: no Authorization header -> 'unknown', never throws", () => {
  const req = { headers: {} } as any;
  assert.equal(bearerTokenId(req), "unknown");
});

// ── scope enforcement (write-scoped, mirrors test/service.test.ts's generic proof) ──────────

test("every panel action route is write-scoped: a read-only token gets 403", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/control/pause", READ_TOKEN, {});
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; required_scope: string };
    assert.equal(body.error, "forbidden");
    assert.equal(body.required_scope, "write");
  });
});

// ── W1-T404: every route this module declares carries its ruled WriteTier ───────────────────

test("every panel-actions.ts write route carries its design-(i)-ruled tier", () => {
  const root = tmpRoot();
  const routes = buildServeRoutes(serveDepsFor(depsFor(root)));
  const tierOf = (path: string) => routes.find((r) => r.method === "POST" && r.path === path)?.tier;
  assert.equal(tierOf("/v1/control/pause"), "middle");
  assert.equal(tierOf("/v1/control/resume"), "middle");
  assert.equal(tierOf("/v1/control/stop"), "middle");
  assert.equal(tierOf("/v1/quiet-hours"), "middle");
  assert.equal(tierOf("/v1/questions/answer"), "low");
  assert.equal(tierOf("/v1/escalation/mark-handled"), "low");
  assert.equal(tierOf("/v1/drain/feedback"), "low");
  assert.equal(tierOf("/v1/manual/approve"), "high");
  assert.equal(tierOf("/v1/drain/kick"), "high");
  assert.equal(tierOf("/v1/drain/run"), "high");
});

test("no bearer token at all -> 401", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await fetch(`${base}/v1/control/stop`, { method: "POST" });
    assert.equal(res.status, 401);
  });
});

// ── POST /v1/control/pause ───────────────────────────────────────────────────

test("POST /v1/control/pause: writes the PAUSE flag and ledgers panel.pause_requested with origin", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/control/pause", WRITE_TOKEN, { reason: "operator break" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { paused: true, reason: "operator break" });
  });
  assert.equal(isPaused(root), true);
  assert.match(pauseDetail(root) ?? "", /operator break/);

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.pause_requested");
  assert.equal(lines[0].task_id, "PANEL");
  assert.equal(lines[0].origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
});

test("POST /v1/control/pause: reason omitted is valid (optional field)", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/control/pause", WRITE_TOKEN, {});
    assert.equal(res.status, 200);
  });
  assert.equal(isPaused(root), true);
});

test("POST /v1/control/pause: non-string reason -> 400, no flag written, no ledger line (fail loud, no side effect)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/control/pause", WRITE_TOKEN, { reason: 123 });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });
  assert.equal(isPaused(root), false);
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/control/pause: malformed JSON body -> 400, no side effect", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await fetch(`${base}/v1/control/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: "not json{{{",
    });
    assert.equal(res.status, 400);
  });
  assert.equal(isPaused(root), false);
});

// ── POST /v1/control/resume ──────────────────────────────────────────────────

test("POST /v1/control/resume: clears STOP + PAUSE, ledgers panel.resume_requested, reports what cleared", async () => {
  const root = tmpRoot();
  requestStop(root, "a");
  requestPause(root, "b");
  const deps = depsFor(root);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/control/resume", WRITE_TOKEN, {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { clearedStop: true, clearedPause: true });
  });

  assert.equal(isStopped(root), false);
  assert.equal(isPaused(root), false);
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines[0].step, "panel.resume_requested");
  assert.equal(lines[0].task_id, "PANEL");
});

// ── POST /v1/control/stop (acceptance criterion 2) ───────────────────────────

test("POST /v1/control/stop: STOP flips synchronously (the SAME predicate drain.ts checks first, every tick), ledgered with origin", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  assert.equal(isStopped(root), false);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/control/stop", WRITE_TOKEN, { reason: "panel STOP" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: true, reason: "panel STOP" });
  });

  // "halts the fleet within one tick" -- the exact gate drain.ts calls first, every iteration.
  assert.equal(isStopped(root), true);
  assert.match(stopDetail(root) ?? "", /panel STOP/);

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.stop_requested");
  assert.equal(lines[0].task_id, "PANEL");
  assert.ok(typeof lines[0].origin === "string" && (lines[0].origin as string).length > 0);
  assert.doesNotMatch(String(lines[0].origin), new RegExp(WRITE_TOKEN)); // never the raw secret
});

test("POST /v1/control/stop: no body at all is valid (reason is optional)", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await fetch(`${base}/v1/control/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    });
    assert.equal(res.status, 200);
  });
  assert.equal(isStopped(root), true);
});

// ── POST /v1/quiet-hours ──────────────────────────────────────────────────────

test("POST /v1/quiet-hours: {enabled:true} sets the flag, ledgers panel.quiet_hours_toggled", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/quiet-hours", WRITE_TOKEN, { enabled: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { quietHours: true });
  });
  assert.equal(isQuietHours(root), true);
  assert.equal(readLedgerLines(deps.ledgerPath)[0].step, "panel.quiet_hours_toggled");
});

test("POST /v1/quiet-hours: {enabled:false} clears the flag", async () => {
  const root = tmpRoot();
  requestPause(root); // unrelated flag — quiet-hours toggle must not touch PAUSE
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/quiet-hours", WRITE_TOKEN, { enabled: false });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { quietHours: false });
  });
  assert.equal(isQuietHours(root), false);
  assert.equal(isPaused(root), true, "quiet-hours toggle must not touch PAUSE");
});

test("POST /v1/quiet-hours: missing `enabled` -> 400, no side effect", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/quiet-hours", WRITE_TOKEN, {});
    assert.equal(res.status, 400);
  });
  assert.equal(isQuietHours(root), false);
});

test("POST /v1/quiet-hours: enabled as a string -> 400 (fail loud, not a truthy coerce)", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/quiet-hours", WRITE_TOKEN, { enabled: "true" });
    assert.equal(res.status, 400);
  });
  assert.equal(isQuietHours(root), false);
});

// ── POST /v1/questions/answer (acceptance criterion 1) ────────────────────────

test("POST /v1/questions/answer: ledgers panel.question_answered against the task, origin = panel bearer token id", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/questions/answer", WRITE_TOKEN, {
      taskId: "W1-T78",
      answer: "use approach X",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: "W1-T78", answer: "use approach X" });
  });

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  const entry = lines[0];
  // "appears in the ledger with the panel's bearer token as origin" -- the acceptance
  // criterion's literal proof artifact ("paste the ledger entry").
  assert.equal(entry.step, "panel.question_answered");
  assert.equal(entry.task_id, "W1-T78");
  assert.equal(entry.answer, "use approach X");
  assert.equal(entry.origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
  assert.equal(entry.flows_to, "plan/questions.ndjson");
  assert.equal(entry.recorded_to_question_store, true);
  assert.ok(typeof entry.ts === "string" && entry.ts.length > 0);
});

test("POST /v1/questions/answer: THE ANSWER FLOWS TO THE ARCHITECT -- recorded into plan/questions.ndjson, the SAME durable store the QUESTION contract writes into", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/questions/answer", WRITE_TOKEN, {
      taskId: "W1-T78",
      answer: "use approach X",
    });
    assert.equal(res.status, 200);
  });

  const questionsPath = join(root, "plan", "questions.ndjson");
  assert.ok(existsSync(questionsPath), "plan/questions.ndjson must exist after an answer is submitted");
  const stored = readFileSync(questionsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, "W1-T78");
  assert.equal(stored[0].answer, "use approach X");
  assert.equal(stored[0].origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
  assert.ok(typeof stored[0].ts === "string" && (stored[0].ts as string).length > 0);
});

test("POST /v1/questions/answer: missing taskId -> 400, no ledger line", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/questions/answer", WRITE_TOKEN, { answer: "x" });
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/questions/answer: empty answer -> 400", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/questions/answer", WRITE_TOKEN, { taskId: "W1-T78", answer: "   " });
    assert.equal(res.status, 400);
  });
});

// ── POST /v1/manual/approve ────────────────────────────────────────────────────

test("POST /v1/manual/approve: closes the GitHub issue, then ledgers panel.manual_approved", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, issues);
  const issueUrl = "https://github.com/craigoley/remudero/issues/42";

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/manual/approve", WRITE_TOKEN, { taskId: "W2-T3", issueUrl });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: "W2-T3", issueUrl });
  });

  assert.deepEqual(issues.closed, [issueUrl]);
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines[0].step, "panel.manual_approved");
  assert.equal(lines[0].task_id, "W2-T3");
  assert.equal(lines[0].issue_url, issueUrl);
});

test("POST /v1/manual/approve: issues.close throwing -> 500, no ledger line (never a false approval)", async () => {
  const root = tmpRoot();
  const throwing: IssueCloser = {
    close() {
      throw new Error("gh issue close: not found");
    },
  };
  const deps = depsFor(root, throwing);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/manual/approve", WRITE_TOKEN, {
      taskId: "W2-T3",
      issueUrl: "https://github.com/craigoley/remudero/issues/999",
    });
    assert.equal(res.status, 500);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/manual/approve: missing issueUrl -> 400, issues.close never called", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  await withService(depsFor(root, issues), async (base) => {
    const res = await post(base, "/v1/manual/approve", WRITE_TOKEN, { taskId: "W2-T3" });
    assert.equal(res.status, 400);
  });
  assert.deepEqual(issues.closed, []);
});

// ── POST /v1/escalation/mark-handled (W1-T182) ──────────────────────────────────

test("POST /v1/escalation/mark-handled: closes the GitHub issue, then ledgers panel.escalation_marked_handled — NOT panel.manual_approved", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, issues);
  const issueUrl = "https://github.com/craigoley/remudero/issues/393";

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", WRITE_TOKEN, { taskId: "W1-T50", issueUrl });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: "W1-T50", issueUrl });
  });

  assert.deepEqual(issues.closed, [issueUrl]);
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines[0].step, "panel.escalation_marked_handled");
  assert.equal(lines[0].task_id, "W1-T50");
  assert.equal(lines[0].issue_url, issueUrl);
});

test("POST /v1/escalation/mark-handled: issues.close throwing -> 500, no ledger line (never a false handled)", async () => {
  const root = tmpRoot();
  const throwing: IssueCloser = {
    close() {
      throw new Error("gh issue close: not found");
    },
  };
  const deps = depsFor(root, throwing);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", WRITE_TOKEN, {
      taskId: "W1-T50",
      issueUrl: "https://github.com/craigoley/remudero/issues/999",
    });
    assert.equal(res.status, 500);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/escalation/mark-handled: missing issueUrl -> 400, issues.close never called", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  await withService(depsFor(root, issues), async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", WRITE_TOKEN, { taskId: "W1-T50" });
    assert.equal(res.status, 400);
  });
  assert.deepEqual(issues.closed, []);
});

// ── POST /v1/drain/feedback (W1-T141: post-drain rundown + feedback hook) ─────────────────
//
// Acceptance (plan/tasks.yaml):
//   "each outcome line's one-tap verdict (good | wrong | needs-follow-up) writes an
//   operator_feedback ledger record" -- proven by POSTing /v1/drain/feedback and reading the
//   resulting ledger line back; "an invalid verdict value is rejected (400)" -- proven below.
//   "the operator_feedback record is in the shape the learning limb (W1-T87/88) consumes"
//   {taskId, verdict, ts, drain ref} -- asserted field-by-field on the ledger entry.

test("POST /v1/drain/feedback: writes an operator_feedback ledger record {taskId, verdict, drain_run_id, ts, origin}, readable back from the ledger", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, {
      taskId: "W1-T100",
      verdict: "wrong",
      drainRunId: "DRAIN-1730000000000",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: "W1-T100", verdict: "wrong" });
  });

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.equal(entry.step, "operator_feedback");
  assert.equal(entry.task_id, "W1-T100");
  assert.equal(entry.verdict, "wrong");
  assert.equal(entry.drain_run_id, "DRAIN-1730000000000");
  assert.equal(entry.origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
  assert.ok(typeof entry.ts === "string" && entry.ts.length > 0);
});

test("POST /v1/drain/feedback: every verdict in the closed set (good | wrong | needs-follow-up) is accepted", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    for (const verdict of DRAIN_FEEDBACK_VERDICTS) {
      const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "T", verdict, drainRunId: "DRAIN-1" });
      assert.equal(res.status, 200, `verdict ${verdict} should be accepted`);
    }
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, DRAIN_FEEDBACK_VERDICTS.length);
});

test("POST /v1/drain/feedback: an invalid verdict value is rejected (400), no ledger line (the falsifier)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "T", verdict: "meh", drainRunId: "DRAIN-1" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/drain/feedback: missing taskId -> 400, no side effect", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { verdict: "good", drainRunId: "DRAIN-1" });
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/drain/feedback: missing drainRunId -> 400, no side effect", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "T", verdict: "good" });
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/drain/feedback: write-scoped -- a read-only token gets 403", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await post(base, "/v1/drain/feedback", READ_TOKEN, { taskId: "T", verdict: "good", drainRunId: "DRAIN-1" });
    assert.equal(res.status, 403);
  });
});

// ── W1-T435: the STEERING NOTE — quoted verbatim into the fix rung's next dispatch by
// operatorVerdictEvidence (lib/sweep.ts) when the verdict is wrong/needs-follow-up.

test("POST /v1/drain/feedback: an optional `note` is ledgered VERBATIM alongside the verdict", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const note = "the retry loop never backs off — see the flaky assertion at line 88";
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, {
      taskId: "W1-T100",
      verdict: "wrong",
      drainRunId: "DRAIN-1",
      note,
    });
    assert.equal(res.status, 200);
  });
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].note, note, "the note's own words must land unedited — never paraphrased");
});

test("POST /v1/drain/feedback: `note` omitted -> the ledger line carries no `note` key at all (never an empty-string stand-in)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "W1-T100", verdict: "good", drainRunId: "DRAIN-1" });
    assert.equal(res.status, 200);
  });
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal("note" in lines[0], false);
});

test("POST /v1/drain/feedback: a non-string `note` -> 400, no ledger line", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "T", verdict: "wrong", drainRunId: "DRAIN-1", note: 42 });
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/drain/feedback: a `note` over the character ceiling -> 400, no ledger line (never a silent truncation)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, {
      taskId: "T",
      verdict: "wrong",
      drainRunId: "DRAIN-1",
      note: "x".repeat(2001),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/drain/feedback: a `note` AT the character ceiling is accepted (the boundary is inclusive)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const note = "x".repeat(2000);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/feedback", WRITE_TOKEN, { taskId: "T", verdict: "wrong", drainRunId: "DRAIN-1", note });
    assert.equal(res.status, 200);
  });
  assert.equal(readLedgerLines(deps.ledgerPath)[0].note, note);
});

// ── INTEGRATION: "STOP from the panel halts the fleet within one tick" (acceptance 2) ──────
//
// Drives the REAL drain loop (src/lib/drain.ts's `runDrain`) wired to the REAL fleet-control
// predicate (`stopDetail`) drain.ts's own header documents as "checked FIRST, every tick" --
// the SAME gate `rmd drain`/the daemon use. A two-task plan (A then B, both runnable
// immediately, no interdependency): while task A is "running" (inside its `runOne`), the
// PANEL issues a real HTTP POST /v1/control/stop, mirroring an operator hitting STOP mid-run.
// A still finishes (drain-and-hold -- an in-flight task always reaches its verdict), but the
// very NEXT loop tick sees the panel's STOP and returns before task B is ever attempted --
// "no further spawns" literally means no second `drain.iteration`/`attempted` entry for B.

function planTask(id: string): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
  };
}

function twoTaskPlan(): Plan {
  const tasks = [planTask("A"), planTask("B")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("INTEGRATION: a panel STOP mid-run halts the drain within one tick -- ledger shows panel.stop_requested then drain.stop, and NO further dispatch", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const merged = new Set<string>();

  await withService(deps, async (base) => {
    const runOne = async (taskId: string): Promise<RunResult> => {
      if (taskId === "A") {
        // The operator, watching the panel while A runs, hits STOP -- a REAL HTTP call
        // through the SAME route the panel's UI calls, not a direct fleet-control write.
        const res = await post(base, "/v1/control/stop", WRITE_TOKEN, { reason: "panel STOP mid-run" });
        assert.equal(res.status, 200);
      }
      merged.add(taskId);
      return { taskId, runId: `r-${taskId}`, merged: true, costUsd: 0.01, verdict: "merged" };
    };

    const drainLedgerPath = join(root, "state", "drain-ledger.ndjson");
    const drainLog = (step: string, extra: Record<string, unknown> = {}) => {
      appendLedger(drainLedgerPath, { run_id: "DRAIN-test", task_id: "DRAIN", step, ...extra });
    };
    const drainDeps: DrainDeps = {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne,
      checkStop: () => stopDetail(root), // the SAME predicate rmd drain / the daemon check first, every tick
      checkPause: () => undefined,
      log: drainLog,
    };

    const summary = await runDrain(twoTaskPlan(), drainDeps);

    // Drain-and-hold: A (already in flight when STOP landed) reaches its verdict; B is NEVER
    // attempted -- the very next tick after A returns sees STOP and halts first.
    assert.deepEqual(summary.attempted, ["A"]);
    assert.deepEqual(summary.merged, ["A"]);
    assert.equal(summary.stopReason, "stopped");
    assert.match(summary.stopDetail ?? "", /panel STOP mid-run/);
  });

  // ── Ledger evidence: the panel-originated STOP, immediately followed by no further spawn ──
  const panelLines = readLedgerLines(deps.ledgerPath);
  assert.equal(panelLines.length, 1);
  assert.equal(panelLines[0].step, "panel.stop_requested");
  assert.equal(panelLines[0].task_id, "PANEL");
  assert.equal(panelLines[0].reason, "panel STOP mid-run");
  assert.ok(typeof panelLines[0].origin === "string" && (panelLines[0].origin as string).length > 0);

  const drainLines = readLedgerLines(join(root, "state", "drain-ledger.ndjson"));
  const steps = drainLines.map((l) => l.step);
  // Exactly ONE drain.iteration (A's dispatch) -- B is never spawned; drain.stop is the very
  // next tick's entry (drain.summary is just runDrain's own terminal bookkeeping line, logged
  // AFTER drain.stop as it returns), proving the halt happened on the FIRST tick after the
  // panel's STOP landed -- "no further spawns" is literal: no second drain.iteration exists.
  assert.deepEqual(steps, ["drain.iteration", "drain.stop", "drain.summary"]);
});

// ── UP NEXT write-actions: Run kick + Drain now (fb-1784988460437-9daa9b) ──────

test("POST /v1/drain/kick writes a KICK_REQUESTED-<taskId> marker AND ledgers console.kick_requested with the bearer origin (console named as actor at birth)", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-kick-"));
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/kick", WRITE_TOKEN, { taskId: "W1-T259" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { armed: true, taskId: "W1-T259" });
  });
  // the marker the daemon will consume, carrying the console origin
  const pending = pendingKicks(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].taskId, "W1-T259");
  assert.equal(pending[0].origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
  // the ledger birth line
  const lines = readLedgerLines(deps.ledgerPath);
  const kick = lines.find((l) => l.step === "console.kick_requested");
  assert.ok(kick, "console.kick_requested ledgered");
  assert.equal(kick!.task_id, "W1-T259");
  assert.equal(kick!.origin, pending[0].origin, "same console-actor origin on the ledger and in the marker");
});

test("POST /v1/drain/kick with a missing/unsafe taskId is a 400 with NO marker written (fail loud before any side effect)", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-kick-bad-"));
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    for (const bad of [{}, { taskId: "" }, { taskId: "../evil" }, { taskId: "a/b" }]) {
      const res = await post(base, "/v1/drain/kick", WRITE_TOKEN, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });
  assert.equal(pendingKicks(root).length, 0, "no marker for any rejected id");
  assert.equal(existsSync(kickFilePath(root, "../evil")), false);
});

test("POST /v1/drain/run writes the DRAIN_REQUESTED marker AND ledgers console.drain_requested with the bearer origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-drain-"));
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/drain/run", WRITE_TOKEN, {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { armed: true });
  });
  const drain = consumeDrainNow(root);
  assert.ok(drain, "DRAIN_REQUESTED marker present");
  assert.equal(drain!.origin, bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any));
  const lines = readLedgerLines(deps.ledgerPath);
  const d = lines.find((l) => l.step === "console.drain_requested");
  assert.ok(d, "console.drain_requested ledgered");
  assert.equal(d!.origin, drain!.origin);
});

test("both /v1/drain/kick and /v1/drain/run are write-scoped: a read token gets 403 and writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-kick-scope-"));
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    assert.equal((await post(base, "/v1/drain/kick", READ_TOKEN, { taskId: "W1-T259" })).status, 403);
    assert.equal((await post(base, "/v1/drain/run", READ_TOKEN, {})).status, 403);
  });
  assert.equal(pendingKicks(root).length, 0);
  assert.equal(consumeDrainNow(root), null);
});

// The console MOUNTS the UP NEXT Run + Drain-now routes (fb-…9daa9b). This used to read
// `buildPanelActionRoutes(deps)` — the aggregator comparing itself to itself, which is true of a
// list `serve.ts` never imports and says nothing about what an operator can reach. Asserting it
// against `buildServeRoutes` keeps the original regression (those two routes must exist) and makes
// it mean what its title always claimed.
test("the console's real route table registers the UP NEXT Run + Drain-now routes (fb-…9daa9b)", () => {
  const deps = depsFor(mkdtempSync(join(tmpdir(), "panel-routes-")));
  const paths = buildServeRoutes(serveDepsFor(deps)).map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes("POST /v1/drain/kick"), "the per-row Run kick route is mounted on the console");
  assert.ok(paths.includes("POST /v1/drain/run"), "the Drain-now route is mounted on the console");
});
