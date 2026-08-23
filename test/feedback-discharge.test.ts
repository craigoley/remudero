import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plan, Task } from "../src/lib/plan.js";
import { captureFeedback, feedbackEntryPath, setFeedbackStatus, type FeedbackEntry } from "../src/lib/feedback.js";
import { feedbackDischargeState, feedbackOriginTag } from "../src/lib/trace.js";
import {
  buildFeedbackInboxRoute,
  decorateFeedbackDischarge,
  type PanelGraphDeps,
  type RatifyCliGateway,
  type ReconciledFeedbackEntry,
} from "../src/lib/panel-graph.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

// ── W1-T1257: the feedback inbox has no discharge path ──────────────────────────────────
//
// FEEDBACK_STATUSES (lib/feedback.ts) is a closed five-member enum and every member names a
// decision about the PROPOSAL -- none names the work SHIPPING. `feedbackDischargeState`
// (lib/trace.ts) derives, read-time-only and never stored, whether every task an entry filed
// (`origin: feedback#<id>`) is credited merged. `decorateFeedbackDischarge` (panel-graph.ts)
// layers that onto GET /v1/feedback's response without touching a single stored byte.
//
// Acceptance (plan/tasks.d/W1-T1257-*.yaml):
//   - an entry whose every filed task is credited merged is derived as discharged
//   - an entry that filed no task is never discharged
//   - an entry with one uncredited filed task is not discharged
//   - a failed or truncated merged-set read yields undecidable rather than not-discharged
//   - a task credited only by its head branch counts as merged for the predicate
//   - the derived view leaves every stored status byte unchanged
//   - the inbox read decorates a discharged entry instead of dropping it

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-feedback-discharge-"));
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T9001",
    title: "a task filed by triage",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function feedback(over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: "fb-1000-abc123",
    ts: "2026-07-18T00:00:00.000Z",
    raw: "the drain retry banner overlaps the status pill",
    attachments: [],
    origin: "cli",
    status: "proposed",
    proposal_pr: "https://github.com/o/r/pull/1",
    ...over,
  };
}

/** A minimal `PrRef` (status.ts), MERGED unless overridden. */
function merged(url: string, number: number, headRefName?: string): PrRef {
  return { number, url, state: "MERGED", headRefName };
}

/** A `GitHub` (status.ts) fixture: the four required methods stubbed inert, every merged-credit
 *  source (and read-health flag) the discharge predicate reads overridable per test -- mirrors
 *  test/panel-graph.test.ts's own `fakeStatusGithub`, but configurable rather than fixed inert. */
function fakeStatusGithub(over: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    ...over,
  };
}

// ── feedbackDischargeState (pure predicate) ─────────────────────────────────────────────

test("feedbackDischargeState: an entry whose every filed task is credited merged is derived as discharged", () => {
  const entry = feedback({ id: "fb-1" });
  const p = plan([
    task({ id: "W1-T10", origin: feedbackOriginTag("fb-1") }),
    task({ id: "W1-T11", origin: feedbackOriginTag("fb-1") }),
    task({ id: "W1-T12", origin: "architect" }), // must not be pulled into fb-1's task set
  ]);
  const github = fakeStatusGithub({
    findMergedByTrailer: (taskId) => (taskId === "W1-T10" ? merged("https://github.com/o/r/pull/10", 10) : null),
    findMergedByHeadBranch: (taskId) => (taskId === "W1-T11" ? [merged("https://github.com/o/r/pull/11", 11, "run-W1-T11-1785000000000")] : []),
  });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "discharged");
  assert.deepEqual([...result.taskIds].sort(), ["W1-T10", "W1-T11"]);
});

test("feedbackDischargeState: an entry that filed no task is never discharged", () => {
  const entry = feedback({ id: "fb-2" });
  const result = feedbackDischargeState(entry, plan([]), fakeStatusGithub());
  assert.equal(result.state, "not_discharged");
  assert.deepEqual(result.taskIds, []);
});

test("feedbackDischargeState: an entry that filed no task is not-discharged even when the read is failing -- the empty set answers on its own, no GitHub read needed", () => {
  const entry = feedback({ id: "fb-2b" });
  const github = fakeStatusGithub({ readFailed: () => true });
  const result = feedbackDischargeState(entry, plan([]), github);
  assert.equal(result.state, "not_discharged");
});

test("feedbackDischargeState: an entry with one uncredited filed task is not discharged", () => {
  const entry = feedback({ id: "fb-3" });
  const p = plan([
    task({ id: "W1-T20", origin: feedbackOriginTag("fb-3") }),
    task({ id: "W1-T21", origin: feedbackOriginTag("fb-3") }),
  ]);
  const github = fakeStatusGithub({
    findMergedByTrailer: (taskId) => (taskId === "W1-T20" ? merged("https://github.com/o/r/pull/20", 20) : null),
    findMergedByHeadBranch: () => [],
  });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "not_discharged");
});

test("feedbackDischargeState: a FAILED merged-set read yields undecidable rather than not-discharged", () => {
  const entry = feedback({ id: "fb-4" });
  const p = plan([task({ id: "W1-T30", origin: feedbackOriginTag("fb-4") })]);
  const github = fakeStatusGithub({ readFailed: () => true });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "undecidable");
});

test("feedbackDischargeState: a TRUNCATED merged-set read yields undecidable rather than not-discharged", () => {
  const entry = feedback({ id: "fb-5" });
  const p = plan([task({ id: "W1-T31", origin: feedbackOriginTag("fb-5") })]);
  const github = fakeStatusGithub({ readTruncated: () => true });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "undecidable");
});

test("feedbackDischargeState: a task credited only by its head branch counts as merged for the predicate", () => {
  const entry = feedback({ id: "fb-6" });
  const p = plan([task({ id: "W1-T40", origin: feedbackOriginTag("fb-6") })]);
  const github = fakeStatusGithub({
    findMergedByTrailer: () => null, // no anchored-trailer hit at all
    findMergedByHeadBranch: (taskId) => [merged("https://github.com/o/r/pull/40", 40, `run-${taskId}-1785000000000`)],
  });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "discharged");
});

test("feedbackDischargeState: a head-branch hit whose ref does NOT match run-<taskId>-<digits> does not credit (foreign branch, ownership not asserted)", () => {
  const entry = feedback({ id: "fb-7" });
  const p = plan([task({ id: "W1-T41", origin: feedbackOriginTag("fb-7") })]);
  const github = fakeStatusGithub({
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [merged("https://github.com/o/r/pull/41", 41, "some-unrelated-branch")],
  });
  const result = feedbackDischargeState(entry, p, github);
  assert.equal(result.state, "not_discharged");
});

// ── decorateFeedbackDischarge (the panel-graph.ts wiring, in isolation) ─────────────────

test("decorateFeedbackDischarge: leaves every stored status byte unchanged -- it decorates, it never calls setFeedbackStatus or touches disk", () => {
  const root = tmpRoot();
  const entry = captureFeedback(root, { raw: "the banner overlaps the pill", origin: "cli", id: "fb-status-1" });
  const proposed = setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/999" });
  const beforeBytes = readFileSync(feedbackEntryPath(root, entry.id), "utf8");

  const p = plan([task({ id: "W1-T50", origin: feedbackOriginTag(entry.id) })]);
  const github = fakeStatusGithub({ findMergedByTrailer: () => merged("https://github.com/o/r/pull/50", 50) });
  const [decorated] = decorateFeedbackDischarge([proposed], p, github);

  assert.equal(decorated.discharged, true);
  assert.equal(decorated.status, "proposed"); // the stored status byte -- untouched
  assert.equal(decorated.dischargeUndecidable, undefined);

  const afterBytes = readFileSync(feedbackEntryPath(root, entry.id), "utf8");
  assert.equal(afterBytes, beforeBytes); // not a single byte written by the discharge path
  assert.ok(!afterBytes.includes("discharged")); // never a new field on disk, never a 6th status
});

// ── GET /v1/feedback wiring (the route, not just the pure predicate) ───────────────────

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}

function writePlanFile(root: string, tasks: Task[]): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  const body = tasks
    .map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n  origin: "${t.origin}"\n`)
    .join("");
  writeFileSync(planPath, body || "[]\n");
  return planPath;
}

async function invokeInboxRoute(deps: PanelGraphDeps): Promise<{ status: number; entries: ReconciledFeedbackEntry[] }> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as unknown as ServerResponse;
  const req = { url: "/v1/feedback" } as unknown as IncomingMessage;
  await buildFeedbackInboxRoute(deps).handler(req, res, { params: {} });
  const parsed = JSON.parse(body) as { entries: ReconciledFeedbackEntry[] };
  return { status, entries: parsed.entries };
}

test("GET /v1/feedback: the inbox read decorates a discharged entry instead of dropping it", async () => {
  const root = tmpRoot();
  const entry = captureFeedback(root, { raw: "the banner overlaps the pill", origin: "cli", id: "fb-inbox-1" });
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/700" });
  const planPath = writePlanFile(root, [task({ id: "W1-T60", origin: feedbackOriginTag(entry.id) })]);

  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: fakeTraceGithub(),
    // proposal PR itself is still OPEN (never queried as merged) -- the entry stays `proposed`,
    // it is the FILED TASK's own merge that must decorate it discharged.
    statusGithub: fakeStatusGithub({
      prByRef: () => ({ number: 700, url: "https://github.com/o/r/pull/700", state: "OPEN" }),
      findMergedByTrailer: (taskId) => (taskId === "W1-T60" ? merged("https://github.com/o/r/pull/60", 60) : null),
    }),
    ratify: fakeRatifyGateway(),
  };

  const { status, entries } = await invokeInboxRoute(deps);
  assert.equal(status, 200);
  assert.equal(entries.length, 1); // NOT dropped
  assert.equal(entries[0].id, entry.id);
  assert.equal(entries[0].status, "proposed"); // stored status untouched
  assert.equal(entries[0].discharged, true); // decorated
});
