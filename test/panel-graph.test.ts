import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildDrainPreviewRoute,
  buildFeedbackInboxRoute,
  buildPanelGraphRoutes,
  buildProposalDecisionRoute,
  buildSubmitFeedbackRoute,
  buildTraceRoute,
  draftedTaskSummaries,
  ratifyCliGateway,
  type PanelGraphDeps,
  type RatifyCliGateway,
} from "../src/lib/panel-graph.js";
import { bearerTokenId } from "../src/lib/panel-actions.js";
import { captureFeedback, feedbackEntryPath, readFeedbackEntry, setFeedbackStatus, type FeedbackEntry } from "../src/lib/feedback.js";
import { appendLedger } from "../src/lib/ledger.js";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";
import type { GitHub } from "../src/lib/status.js";
import {
  decideTriage,
  diffCitesFeedback,
  nonPlanFilesInDiff,
  parseTriageVerdict,
  triageCommitMessage,
  triagePrompt,
} from "../src/lib/triage.js";

// ── W3-T6: the plan→task→PR graph + interactive plan adjustment (MASTER-PLAN §7B) ──────────
//
// Acceptance (plan/tasks.yaml):
//   (1) "feedback submitted from the panel appears in the inbox with origin=ui and produces a
//       proposal PR" -- proven below TWO ways: the capture leg alone (POST /v1/feedback lands
//       a plan/feedback/<id>.yaml entry with origin=ui, ledgered panel.feedback_submitted), AND
//       an END-TO-END test that runs that SAME panel-captured entry through the REAL
//       lib/triage.ts deterministic decision pipeline (triagePrompt/parseTriageVerdict/
//       decideTriage/diffCitesFeedback/nonPlanFilesInDiff/triageCommitMessage -- the exact
//       calls run-task.ts's `triageCommand` makes; only the LLM verdict text and the `gh pr
//       create` network call are simulated, matching this repo's "the judge is code, the LLM
//       layer is advisory only" discipline, Standing rule 2) all the way to a `proposed` entry
//       carrying a real proposal_pr -- then reads it BACK through this task's own GET
//       /v1/feedback and GET /v1/trace routes, so "produces a proposal PR" is proven from the
//       panel's own read surface, not merely asserted against the filesystem.
//   (2) "the panel renders the plan→task→PR graph and allows accept/reject of a proposal" --
//       proven below: GET /v1/trace renders a feedback→task→run→PR chain (over a fixture
//       TraceGithub, mirroring test/trace.test.ts), and POST /v1/feedback/decision accepts a
//       `proposed` entry, ledgered with the panel's bearer as origin (the literal proof
//       artifact -- "paste the ledger line").
//
// Same discipline as test/panel-actions.test.ts: real createService()/fetch() plumbing, never a
// mock of either surface. Business logic (lib/feedback.ts, lib/trace.ts) is EXISTING and already
// covered by its own suite -- these tests exercise the WIRING (route registration, scope,
// request validation, ledger attribution).

const READ_TOKEN = "graph-read-token";
const WRITE_TOKEN = "graph-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-panel-graph-"));
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

function fakeGithub(byRef: Record<string, TracePrView> = {}): TraceGithub {
  return { prView: (ref) => byRef[String(ref)] ?? null };
}

/** Offline status.ts `GitHub` stub for `PanelGraphDeps.statusGithub` (GET /v1/drain/preview's merged-set derivation) — distinct shape from `fakeGithub`'s `TraceGithub` above (verified from source, not assumed). */
function fakeStatusGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

/** Writes a minimal plan/tasks.yaml with the given task lines and returns its path. */
function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

function emptyPlanPath(root: string): string {
  return writePlan(root, "[]\n");
}

/** Fake {@link RatifyCliGateway} — records calls rather than spawning a real `bin/rmd` child
 *  process (W1-T193). */
function fakeRatifyGateway(): RatifyCliGateway & { approved: string[]; reframed: Array<{ proposalId: string; feedback: string }> } {
  const approved: string[] = [];
  const reframed: Array<{ proposalId: string; feedback: string }> = [];
  return {
    approved,
    reframed,
    approve(proposalId: string) {
      approved.push(proposalId);
    },
    reframe(proposalId: string, feedback: string) {
      reframed.push({ proposalId, feedback });
    },
  };
}

function depsFor(root: string, planPath: string, github: TraceGithub = fakeGithub()): PanelGraphDeps {
  return { root, inboxRoot: root, planPath, ledgerPath: ledgerPathFor(root), github, statusGithub: fakeStatusGithub(), ratify: fakeRatifyGateway() };
}

async function withService<T>(deps: PanelGraphDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildPanelGraphRoutes(deps),
  });
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

function get(base: string, path: string, token: string) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

const writerId = bearerTokenId({ headers: { authorization: `Bearer ${WRITE_TOKEN}` } } as any);

// ── scope enforcement ────────────────────────────────────────────────────────

test("GET /v1/feedback, GET /v1/trace are read-scoped; POST /v1/feedback, POST /v1/feedback/decision are write-scoped", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    assert.equal((await get(base, "/v1/feedback", READ_TOKEN)).status, 200);
    assert.equal((await get(base, "/v1/trace?id=nope", READ_TOKEN)).status, 404);

    const readOnPost = await post(base, "/v1/feedback", READ_TOKEN, { text: "x" });
    assert.equal(readOnPost.status, 403);
    const readOnDecision = await post(base, "/v1/feedback/decision", READ_TOKEN, { id: "x", decision: "accept" });
    assert.equal(readOnDecision.status, 403);
  });
});

// ── GET /v1/feedback ─────────────────────────────────────────────────────────

test("GET /v1/feedback: empty inbox is an empty list", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/feedback", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { entries: [] });
  });
});

test("GET /v1/feedback: lists captured entries; ?status filters", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const a = captureFeedback(root, { raw: "one", origin: "cli" });
  const b = captureFeedback(root, { raw: "two", origin: "ui" });
  setFeedbackStatus(root, b.id, "proposed", { proposalPr: "https://github.com/o/r/pull/9" });

  await withService(depsFor(root, planPath), async (base) => {
    const all = (await (await get(base, "/v1/feedback", READ_TOKEN)).json()) as { entries: FeedbackEntry[] };
    assert.equal(all.entries.length, 2);
    assert.deepEqual(
      all.entries.map((e) => e.id).sort(),
      [a.id, b.id].sort(),
    );

    const proposedOnly = (await (await get(base, "/v1/feedback?status=proposed", READ_TOKEN)).json()) as {
      entries: FeedbackEntry[];
    };
    assert.deepEqual(proposedOnly.entries.map((e) => e.id), [b.id]);
  });
});

test("GET /v1/feedback: invalid ?status -> 400", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/feedback?status=bogus", READ_TOKEN);
    assert.equal(res.status, 400);
  });
});

// ── POST /v1/feedback (acceptance criterion 1) ───────────────────────────────

test("POST /v1/feedback: captures a plan/feedback/<id>.yaml entry with origin=ui (regardless of client input), ledgers panel.feedback_submitted", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const deps = depsFor(root, planPath);

  let entryId = "";
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "the drain retry banner overlaps the status pill" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: true; entry: FeedbackEntry };
    assert.equal(body.ok, true);
    assert.equal(body.entry.origin, "ui");
    assert.equal(body.entry.raw, "the drain retry banner overlaps the status pill");
    assert.equal(body.entry.status, "new");
    entryId = body.entry.id;
  });

  // "lands as plan/feedback/<id>" -- the acceptance criterion's literal proof artifact.
  assert.ok(existsSync(feedbackEntryPath(root, entryId)));
  const onDisk = readFileSync(feedbackEntryPath(root, entryId), "utf8");
  assert.match(onDisk, /origin: ui/);

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.feedback_submitted");
  assert.equal(lines[0].task_id, entryId);
  assert.equal(lines[0].origin, writerId);
  assert.equal(lines[0].origin_field, "ui");
  assert.equal(lines[0].reply_to, null);
});

test("POST /v1/feedback: origin in the request body is IGNORED -- always captured as ui", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", origin: "cli" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: FeedbackEntry };
    assert.equal(body.entry.origin, "ui");
  });
});

test("POST /v1/feedback: missing text -> 400, no capture, no ledger line", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const deps = depsFor(root, planPath);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, {});
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/feedback: a local-path attachment -> 400 (panel attachments must be http(s) links)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", attachments: ["/etc/passwd"] });
    assert.equal(res.status, 400);
  });
});

test("POST /v1/feedback: an http(s) attachment is accepted and stored verbatim", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", attachments: ["https://example.com/shot.png"] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: FeedbackEntry };
    assert.deepEqual(body.entry.attachments, ["https://example.com/shot.png"]);
  });
});

// ── POST /v1/feedback with replyTo ("answer a grill") ────────────────────────

test("POST /v1/feedback with replyTo: answers a grilling entry as a fresh feedback item, prefixed with the back-reference", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const parked = captureFeedback(root, { raw: "does this want a CLI flag or a config default?", origin: "cli" });
  setFeedbackStatus(root, parked.id, "grilling");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "a config default, please", replyTo: parked.id });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: FeedbackEntry };
    assert.equal(body.entry.origin, "ui");
    assert.match(body.entry.raw, new RegExp(`^\\[answer to feedback#${parked.id}\\] a config default, please$`));
  });
});

test("POST /v1/feedback with replyTo naming an unknown entry -> 400", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", replyTo: "fb-does-not-exist" });
    assert.equal(res.status, 400);
  });
});

test("POST /v1/feedback with replyTo naming a NON-grilling entry -> 400 (nothing to answer)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const notGrilling = captureFeedback(root, { raw: "already new", origin: "cli" });
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", replyTo: notGrilling.id });
    assert.equal(res.status, 400);
  });
});

// ── END-TO-END (acceptance criterion 1): panel capture -> REAL triage decision -> proposal PR,
// read back through the panel's OWN routes ──────────────────────────────────────────────────

test("END-TO-END: a panel-submitted feedback entry, run through the REAL lib/triage.ts decision pipeline, lands as a proposed entry with a proposal_pr -- visible via GET /v1/feedback and GET /v1/trace", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const deps = depsFor(root, planPath);

  // Step 1 -- THE PANEL SUBMITS. Real HTTP POST /v1/feedback, this task's own route.
  let submitted: FeedbackEntry;
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, {
      text: "the drain retry banner overlaps the status pill",
    });
    assert.equal(res.status, 200);
    submitted = ((await res.json()) as { entry: FeedbackEntry }).entry;
    assert.equal(submitted.origin, "ui");
  });
  const entry = submitted!;

  // Step 2 -- THE CAPTURED ENTRY IS A VALID TRIAGE INPUT. lib/triage.ts's REAL prompt builder,
  // fed the SAME entry the panel just captured (no adaptation needed).
  const prompt = triagePrompt(entry, `TRIAGE-${entry.id}`);
  assert.match(prompt, /the drain retry banner overlaps the status pill/);
  assert.match(prompt, /origin: ui/);

  // Step 3 -- THE REAL DETERMINISTIC DECISION (Standing rule 2: the judge is code). Only the
  // LLM's own verdict text is simulated; parseTriageVerdict/decideTriage are the REAL functions
  // run-task.ts's `triageCommand` calls.
  const workerOutput = `Grounded against MASTER-PLAN/plan/tasks.yaml -- no existing task covers this.\nPROPOSED: add W9-T900 (origin: feedback#${entry.id}) to fix the retry banner overlap`;
  const verdict = parseTriageVerdict(workerOutput);
  const changedFiles = ["plan/tasks.yaml"];
  const decision = decideTriage({ verdict, changedFiles });
  assert.equal(decision.action, "propose");

  // Step 4 -- THE PLAN-ONLY + PROVENANCE GUARDS (the same two checks triageCommand runs against
  // the real PR diff before trusting it).
  const fakeDiff = [
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "+- id: W9-T900",
    "+  title: fix the retry banner overlap",
    `+  origin: "feedback#${entry.id}"`,
  ].join("\n");
  assert.deepEqual(nonPlanFilesInDiff(fakeDiff), []);
  assert.equal(diffCitesFeedback(fakeDiff, entry.id), true);

  // Step 5 -- THE COMMIT MESSAGE (harness-authored, never LLM-authored) cites feedback#<id>.
  const commitMessage = triageCommitMessage({ decision, feedbackId: entry.id, taskId: `TRIAGE-${entry.id}` });
  assert.match(commitMessage, new RegExp(`feedback#${entry.id}`));

  // Step 6 -- THE HARNESS-OWNED DETERMINISTIC WRITES (run-task.ts's triageCommand, lines
  // ~4200/~4233): setFeedbackStatus first to `proposed`, then again with the real PR URL once
  // `gh pr create` returns it (the ONLY step this test cannot literally invoke -- opening a real
  // GitHub PR needs live network + a real repo checkout, unavailable to a headless unit test;
  // every deterministic step around it, above and below, is the REAL function).
  setFeedbackStatus(root, entry.id, decision.status);
  const proposalPr = "https://github.com/craigoley/remudero/pull/9001";
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr });

  // Step 7 -- READ IT BACK THROUGH THE PANEL'S OWN ROUTES. "produces a proposal PR" proven from
  // the panel's own read surface, not merely asserted against the filesystem.
  await withService(deps, async (base) => {
    const inbox = (await (await get(base, "/v1/feedback", READ_TOKEN)).json()) as { entries: FeedbackEntry[] };
    const inboxEntry = inbox.entries.find((e) => e.id === entry.id);
    assert.ok(inboxEntry, "the panel-submitted entry must still be in the inbox");
    assert.equal(inboxEntry!.status, "proposed");
    assert.equal(inboxEntry!.origin, "ui");
    assert.equal(inboxEntry!.proposal_pr, proposalPr);

    const traceRes = await get(base, `/v1/trace?id=${entry.id}`, READ_TOKEN);
    assert.equal(traceRes.status, 200);
    const traced = (await traceRes.json()) as { chain: { direction: string; feedback: { proposalPr?: string } } };
    assert.equal(traced.chain.direction, "forward");
    assert.equal(traced.chain.feedback.proposalPr, proposalPr);
  });

  // The literal on-disk entry (this test's "paste the inbox entry" artifact).
  const onDisk = readFeedbackEntry(root, entry.id);
  assert.equal(onDisk.status, "proposed");
  assert.equal(onDisk.origin, "ui");
  assert.equal(onDisk.proposal_pr, proposalPr);
});

// ── GET /v1/trace (acceptance criterion 2) ────────────────────────────────────

test("GET /v1/trace: no ?id -> 400", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/trace", READ_TOKEN);
    assert.equal(res.status, 400);
  });
});

test("GET /v1/trace: unknown id (neither a task nor a feedback entry) -> 404", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/trace?id=nope", READ_TOKEN);
    assert.equal(res.status, 404);
  });
});

test("GET /v1/trace?id=<feedback-id>: FORWARD chain -- feedback -> proposal PR -> task -> run -> PR", async () => {
  const root = tmpRoot();
  const entry = captureFeedback(root, { raw: "the drain retry banner overlaps the status pill", origin: "ui" });
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/50" });

  const planPath = writePlan(
    root,
    [
      "- id: W9-T1",
      "  title: fix the retry banner overlap",
      "  repo: remudero",
      "  type: implement",
      `  origin: "feedback#${entry.id}"`,
      "",
    ].join("\n"),
  );

  const github = fakeGithub({
    "https://github.com/o/r/pull/50": { number: 50, url: "https://github.com/o/r/pull/50", state: "MERGED", mergeCommitSha: "deadbeef" },
    "https://github.com/o/r/pull/51": { number: 51, url: "https://github.com/o/r/pull/51", state: "OPEN" },
  });
  const ledgerPath = ledgerPathFor(root);
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, github, statusGithub: fakeStatusGithub(), ratify: fakeRatifyGateway() };
  // seed the run's ledger lines directly (mirrors test/board.test.ts's convention).
  const { appendLedger } = await import("../src/lib/ledger.js");
  appendLedger(ledgerPath, { run_id: "W9-T1-1000", task_id: "W9-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/51" });

  await withService(deps, async (base) => {
    const res = await get(base, `/v1/trace?id=${entry.id}`, READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { chain: { direction: string; feedback: { id: string; proposalPr: string }; tasks: Array<{ id: string; runs: Array<{ prUrl: string }> }> }; rendered: string };
    assert.equal(body.chain.direction, "forward");
    assert.equal(body.chain.feedback.id, entry.id);
    assert.equal(body.chain.feedback.proposalPr, "https://github.com/o/r/pull/50");
    assert.equal(body.chain.tasks.length, 1);
    assert.equal(body.chain.tasks[0].id, "W9-T1");
    assert.equal(body.chain.tasks[0].runs[0].prUrl, "https://github.com/o/r/pull/51");
    assert.match(body.rendered, /feedback#/);
  });
});

test("GET /v1/trace?id=<task-id>: REVERSE chain -- task -> origin -> its feedback entry", async () => {
  const root = tmpRoot();
  const entry = captureFeedback(root, { raw: "some ask", origin: "cli" });
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/50" });
  const planPath = writePlan(
    root,
    ["- id: W9-T2", "  title: the task", "  repo: remudero", "  type: implement", `  origin: "feedback#${entry.id}"`, ""].join("\n"),
  );
  await withService(depsFor(root, planPath, fakeGithub()), async (base) => {
    const res = await get(base, "/v1/trace?id=W9-T2", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { chain: { direction: string; feedback?: { id: string } } };
    assert.equal(body.chain.direction, "reverse");
    assert.equal(body.chain.feedback?.id, entry.id);
  });
});

// ── POST /v1/feedback/decision (acceptance criterion 2) ──────────────────────

test("POST /v1/feedback/decision: accept moves a proposed entry to accepted, ledgers panel.proposal_accepted with the panel bearer as origin", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const entry = captureFeedback(root, { raw: "x", origin: "ui" });
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/7" });
  const deps = depsFor(root, planPath);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback/decision", WRITE_TOKEN, { id: entry.id, decision: "accept" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: entry.id, status: "accepted", proposalPr: "https://github.com/o/r/pull/7" });
  });

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.proposal_accepted");
  assert.equal(lines[0].task_id, entry.id);
  // "ledgered with the panel bearer as origin" -- the acceptance criterion's literal proof
  // artifact ("paste the ledger line").
  assert.equal(lines[0].origin, writerId);
  assert.equal(lines[0].proposal_pr, "https://github.com/o/r/pull/7");
});

test("POST /v1/feedback/decision: reject moves a proposed entry to rejected", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const entry = captureFeedback(root, { raw: "x", origin: "ui" });
  setFeedbackStatus(root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/8" });
  const deps = depsFor(root, planPath);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback/decision", WRITE_TOKEN, { id: entry.id, decision: "reject" });
    assert.equal(res.status, 200);
  });

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines[0].step, "panel.proposal_rejected");
});

test("POST /v1/feedback/decision: unknown id -> 404, no ledger line", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const deps = depsFor(root, planPath);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback/decision", WRITE_TOKEN, { id: "fb-nope", decision: "accept" });
    assert.equal(res.status, 404);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/feedback/decision: an entry not in `proposed` status -> 400, no side effect", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const entry = captureFeedback(root, { raw: "x", origin: "ui" }); // status: new
  const deps = depsFor(root, planPath);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/feedback/decision", WRITE_TOKEN, { id: entry.id, decision: "accept" });
    assert.equal(res.status, 400);
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("POST /v1/feedback/decision: invalid decision value -> 400", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const entry = captureFeedback(root, { raw: "x", origin: "ui" });
  setFeedbackStatus(root, entry.id, "proposed");
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback/decision", WRITE_TOKEN, { id: entry.id, decision: "maybe" });
    assert.equal(res.status, 400);
  });
});

// ── route builders are independently constructible (mirrors panel-actions.test.ts's style) ──

test("individual route builders each return their own exact-match route", () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const deps = depsFor(root, planPath);
  assert.equal(buildFeedbackInboxRoute(deps).path, "/v1/feedback");
  assert.equal(buildFeedbackInboxRoute(deps).method, "GET");
  assert.equal(buildSubmitFeedbackRoute(deps).method, "POST");
  assert.equal(buildTraceRoute(deps).path, "/v1/trace");
  assert.equal(buildProposalDecisionRoute(deps).path, "/v1/feedback/decision");
  assert.equal(buildDrainPreviewRoute(deps).path, "/v1/drain/preview");
  assert.equal(buildDrainPreviewRoute(deps).method, "GET");
});

// ── GET /v1/drain/preview (W1-T140: the drain preview + curation panel) ─────

function drainPreviewPlanPath(root: string): string {
  return writePlan(
    root,
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "- id: B",
      "  title: b",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: [A]",
      '  note: "b needs A first"',
      "- id: C",
      "  title: c",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: [B]",
      "",
    ].join("\n"),
  );
}

test("GET /v1/drain/preview: renders the would-drain queue as ordered task cards, each carrying dependency edges both ways", async () => {
  const root = tmpRoot();
  const planPath = drainPreviewPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/drain/preview", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cards: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.cards.map((c) => c.id),
      ["A", "B", "C"],
      "card order equals plannedSequence's natural DAG order",
    );
    const b = body.cards[1];
    assert.equal(b.title, "b");
    assert.equal(b.description, "b needs A first");
    assert.deepEqual(b.dependsOn, [{ id: "A", title: "a" }]);
    assert.deepEqual(b.dependents, [{ id: "C", title: "c" }]);
  });
});

test("GET /v1/drain/preview: re-derives merged status from GitHub (statusGithub) rather than trusting yaml -- a trailer-credited task drops off the queue", async () => {
  const root = tmpRoot();
  const planPath = drainPreviewPlanPath(root);
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === "A" ? { number: 9, url: "https://github.com/o/r/pull/9", state: "MERGED" } : null),
    headRefName: (prUrl) => (prUrl === "https://github.com/o/r/pull/9" ? "run-A-1730000000000" : undefined),
    prBody: (prUrl) => (prUrl === "https://github.com/o/r/pull/9" ? "Remudero-Task: A\n" : undefined),
  };
  await withService({ ...depsFor(root, planPath), statusGithub: github }, async (base) => {
    const res = await get(base, "/v1/drain/preview", READ_TOKEN);
    const body = (await res.json()) as { cards: Array<{ id: string }> };
    assert.deepEqual(body.cards.map((c) => c.id), ["B", "C"], "A is merged (GitHub-derived) -- it drops off the queue, unlike the yaml's decorative status");
  });
});

test("GET /v1/drain/preview: ?max and ?until bound the queue exactly like `rmd drain`'s own flags", async () => {
  const root = tmpRoot();
  const planPath = drainPreviewPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const maxed = (await (await get(base, "/v1/drain/preview?max=1", READ_TOKEN)).json()) as { cards: Array<{ id: string }> };
    assert.deepEqual(maxed.cards.map((c) => c.id), ["A"]);

    const until = (await (await get(base, "/v1/drain/preview?until=B", READ_TOKEN)).json()) as { cards: Array<{ id: string }> };
    assert.deepEqual(until.cards.map((c) => c.id), ["A", "B"]);
  });
});

test("GET /v1/drain/preview: a non-numeric or non-positive ?max -> 400, never a silent fallback", async () => {
  const root = tmpRoot();
  const planPath = drainPreviewPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    assert.equal((await get(base, "/v1/drain/preview?max=bogus", READ_TOKEN)).status, 400);
    assert.equal((await get(base, "/v1/drain/preview?max=0", READ_TOKEN)).status, 400);
    assert.equal((await get(base, "/v1/drain/preview?max=-1", READ_TOKEN)).status, 400);
  });
});

test("GET /v1/drain/preview: an empty plan -> an empty card list, not an error", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/drain/preview", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cards: [] });
  });
});

// ── GET /v1/inbox (W1-T190: a ratified proposal is never re-offered as READY) ──────────────

test("GET /v1/inbox: a proposal already ratified (ledger carries ratify.approved) is EXCLUDED from `ready`, even though the registry entry itself was never updated — the console never re-offers the ratify affordance on an already-ratified proposal (acceptance 1 + 4)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  // The registry entry is exactly the drifted P19 shape: a plain ACTIVE-looking proposal
  // record, nothing on it marking it ratified -- only the ledger line below knows.
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: "P19", summary: "already ratified", evidenceAnchors: [] }] }),
  );
  appendLedger(ledgerPathFor(root), {
    run_id: "APPROVE-P19-1",
    task_id: "P19",
    step: "ratify.approved",
    pr_url: "https://github.com/craigoley/remudero/pull/900",
    branch: "run-APPROVE-P19-1",
  });

  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ready: Array<{ proposalId: string }> };
    assert.ok(!body.ready.some((r) => r.proposalId === "P19"), "P19 must never appear in `ready` once the ledger says ratified");
  });
});

test("GET /v1/inbox: a P19-shaped drifted registry entry is CORRECTED on disk, not merely worked around in the response — one request heals state/inbox-proposals.json so any OTHER consumer of that file also sees the ratified proposal gone (acceptance 1: DETECTED and corrected, not trusted)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  const registryPath = join(root, "state", "inbox-proposals.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      proposals: [
        { id: "P19", summary: "already ratified", evidenceAnchors: [] },
        { id: "P20", summary: "still genuinely open", evidenceAnchors: [] },
      ],
    }),
  );
  appendLedger(ledgerPathFor(root), {
    run_id: "APPROVE-P19-1",
    task_id: "P19",
    step: "ratify.approved",
    pr_url: "https://github.com/craigoley/remudero/pull/900",
    branch: "run-APPROVE-P19-1",
  });

  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
  });

  const healed = JSON.parse(readFileSync(registryPath, "utf8")) as { proposals: Array<{ id: string }> };
  assert.deepEqual(
    healed.proposals.map((p) => p.id),
    ["P20"],
    "P19 is actually REMOVED from the registry file on disk -- corrected, not just masked in the response -- while the unrelated open P20 entry survives untouched",
  );
});

test("GET /v1/inbox: a genuinely un-ratified proposal with no drafted candidate yet is simply not in `ready` (the ordinary not-drafted case, unaffected by the ratified check)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: "P-NEW", summary: "no draft yet", evidenceAnchors: [] }] }),
  );

  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ready: Array<{ proposalId: string }> };
    assert.deepEqual(body.ready, []);
  });
});

// ── W1-T193: PROPOSAL CARDS MUST BE ACTIONABLE — draft summary, APPROVE/REFRAME wired through
// the write-token API, a DRAFTING tier carrying its spawn timestamp ──────────────────────────

/** A lint-clean, dep-clean, no-external-deps fragment -- mirrors test/inbox.test.ts's own
 *  CLEAN_FRAGMENT shape, but with `depends_on: []` so classifying it READY needs no merged-
 *  dependency fixture machinery, just an empty base plan. */
const READY_FRAGMENT = `
- id: W1-T900
  title: "drafted task one"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
- id: W1-T901
  title: "drafted task two"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance:
    - claim: "the candidate does the other thing"
      proof: "unit test: fixture Y -> observable Z"
`;

function seedReadyProposal(root: string, proposalId: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: proposalId, summary: "a ready proposal", evidenceAnchors: [] }] }));
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      [proposalId]: {
        proposalId,
        fragmentYaml: READY_FRAGMENT,
        stampLine: `- ${proposalId} (plan) — RATIFIED 2026-07-21 -> W1-T900, W1-T901.`,
        anchorFingerprint: "",
      },
    }),
  );
}

test("GET /v1/inbox: a READY item's draftedTasks carry each drafted task's REAL id and title (never just the opaque proposal id, acceptance 1)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P900");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ready: Array<{ proposalId: string; draftedTasks: Array<{ id: string; title: string }> }>; drafting: unknown[] };
    assert.equal(body.ready.length, 1);
    assert.equal(body.ready[0].proposalId, "P900");
    assert.deepEqual(body.ready[0].draftedTasks, [
      { id: "W1-T900", title: "drafted task one" },
      { id: "W1-T901", title: "drafted task two" },
    ]);
    assert.deepEqual(body.drafting, []);
  });
});

// draftedTaskSummaries backs the READY-item rendering above; its catch branch is
// defense-in-depth (see the function's own doc: a READY classification's fragment has ALREADY
// passed classifyProposal's own parse+lint checks, so the HTTP route above never reaches it in
// practice) — proven directly here rather than contorting a real /v1/inbox request into
// reaching an unreachable-by-design branch.
test("draftedTaskSummaries: a fragment that fails to re-parse (PlanError) yields [] rather than throwing — defense-in-depth, never trusting two derivations of the same text to agree forever", () => {
  assert.deepEqual(draftedTaskSummaries("not a valid task list", "P900"), []);
  assert.deepEqual(draftedTaskSummaries("- id: DUP\n  title: a\n- id: DUP\n  title: b\n", "P900"), []);
});

test("GET /v1/inbox: a proposal with an in-flight draft (state/inbox-draft-inflight.json) renders under `drafting`, carrying its spawn timestamp, and NEVER under `ready` (acceptance 5)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P901", summary: "mid-draft", evidenceAnchors: [] }] }));
  const spawnedAt = "2026-07-22T10:00:00.000Z";
  writeFileSync(join(root, "state", "inbox-draft-inflight.json"), JSON.stringify({ P901: spawnedAt }));

  await withService(depsFor(root, planPath), async (base) => {
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ready: unknown[]; drafting: Array<{ proposalId: string; spawnedAt: string }> };
    assert.deepEqual(body.ready, []);
    assert.deepEqual(body.drafting, [{ proposalId: "P901", summary: "mid-draft", spawnedAt }]);
  });
});

test("POST /v1/inbox/approve, POST /v1/inbox/reframe are write-scoped", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P900");
  await withService(depsFor(root, planPath), async (base) => {
    assert.equal((await post(base, "/v1/inbox/approve", READ_TOKEN, { proposalId: "P900" })).status, 403);
    assert.equal((await post(base, "/v1/inbox/reframe", READ_TOKEN, { proposalId: "P900", feedback: "x" })).status, 403);
  });
});

test("POST /v1/inbox/approve: a genuinely READY proposal hands off to RatifyCliGateway.approve and ledgers panel.proposal_approve_requested with the panel's bearer as origin (acceptance 2)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P900");
  const ratify = fakeRatifyGateway();

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    const res = await post(base, "/v1/inbox/approve", WRITE_TOKEN, { proposalId: "P900" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, proposalId: "P900", started: true });
    assert.deepEqual(ratify.approved, ["P900"]);
  });

  const lines = readLedgerLines(ledgerPathFor(root));
  const line = lines.find((l) => l.step === "panel.proposal_approve_requested");
  assert.ok(line, "must ledger panel.proposal_approve_requested");
  assert.equal(line!.task_id, "P900");
  assert.equal(line!.origin, writerId);
});

test("POST /v1/inbox/approve: a NOT-READY proposal is REFUSED with 409 naming why, and the gateway is NEVER called (acceptance 6 -- no action the backend would refuse)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  // no cached draft at all -> classifies not_ready ("no drafted candidate available yet").
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P902", summary: "no draft yet", evidenceAnchors: [] }] }));
  const ratify = fakeRatifyGateway();

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    const res = await post(base, "/v1/inbox/approve", WRITE_TOKEN, { proposalId: "P902" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_ready");
    assert.match(body.detail, /NOT READY/);
  });
  assert.deepEqual(ratify.approved, [], "the gateway must never be called for a non-ready proposal");
});

test("POST /v1/inbox/approve: an unknown proposal id -> 404, gateway never called", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [] }));
  const ratify = fakeRatifyGateway();

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    const res = await post(base, "/v1/inbox/approve", WRITE_TOKEN, { proposalId: "P-NOPE" });
    assert.equal(res.status, 404);
  });
  assert.deepEqual(ratify.approved, []);
});

test("POST /v1/inbox/reframe: valid for ANY registered proposal regardless of readiness -- captures feedback VERBATIM, hands off to RatifyCliGateway.reframe, ledgers panel.proposal_reframe_requested (acceptance 3)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  // not-ready (no draft) -- reframe must still be accepted; it is feedback, never a ratification.
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P903", summary: "needs feedback", evidenceAnchors: [] }] }));
  const ratify = fakeRatifyGateway();
  const feedback = "please cite the real evidence anchor, not a vibe";

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    const res = await post(base, "/v1/inbox/reframe", WRITE_TOKEN, { proposalId: "P903", feedback });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, proposalId: "P903", started: true });
    assert.deepEqual(ratify.reframed, [{ proposalId: "P903", feedback }]);
  });

  const lines = readLedgerLines(ledgerPathFor(root));
  const line = lines.find((l) => l.step === "panel.proposal_reframe_requested");
  assert.ok(line, "must ledger panel.proposal_reframe_requested");
  assert.equal(line!.task_id, "P903");
  assert.equal(line!.feedback, feedback);
  assert.equal(line!.origin, writerId);
});

test("POST /v1/inbox/reframe: empty/missing feedback -> 400, gateway never called", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P900");
  const ratify = fakeRatifyGateway();

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    assert.equal((await post(base, "/v1/inbox/reframe", WRITE_TOKEN, { proposalId: "P900" })).status, 400);
    assert.equal((await post(base, "/v1/inbox/reframe", WRITE_TOKEN, { proposalId: "P900", feedback: "   " })).status, 400);
  });
  assert.deepEqual(ratify.reframed, []);
});

test("POST /v1/inbox/reframe: an unknown proposal id -> 404, gateway never called", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [] }));
  const ratify = fakeRatifyGateway();

  await withService({ ...depsFor(root, planPath), ratify }, async (base) => {
    const res = await post(base, "/v1/inbox/reframe", WRITE_TOKEN, { proposalId: "P-NOPE", feedback: "x" });
    assert.equal(res.status, 404);
  });
  assert.deepEqual(ratify.reframed, []);
});

test("ratifyCliGateway: a REAL detached spawn of <repoRoot>/bin/rmd with the exact CLI args, cwd=repoRoot, stdout/stderr appended to a log file under logDir (never a synchronous git/gh pipeline)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "bin"), { recursive: true });
  const markerPath = join(root, "marker.txt");
  writeFileSync(join(root, "bin", "rmd"), `#!/usr/bin/env bash\necho "$@" > "${markerPath}"\necho "cwd=$(pwd)" >> "${markerPath}"\n`, { mode: 0o755 });
  const logDir = join(root, "state", "logs");

  const gateway = ratifyCliGateway(root, logDir);
  gateway.reframe("P900", "please cite a real anchor");

  // The spawn is detached/unref'd -- the whole point is the caller never awaits it (see
  // RatifyCliGateway's own doc: an HTTP response must not block on rmd approve/reframe's own
  // multi-minute tail). Poll briefly for the marker file rather than awaiting the child.
  const deadline = Date.now() + 5000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(markerPath), "the real bin/rmd script must actually have been spawned");
  const marker = readFileSync(markerPath, "utf8");
  assert.match(marker, /^reframe P900 --feedback please cite a real anchor/);
  // macOS's tmpdir() sits under a /var symlink to /private/var -- bash's own `pwd` builtin
  // resolves it, Node's raw path does not, so compare against the REAL (symlink-resolved)
  // path rather than asserting an exact string match against `root` itself.
  assert.match(marker, new RegExp(`cwd=${realpathSync(root)}`));

  assert.ok(existsSync(logDir), "the log directory must be created");
  const logFiles = readdirSync(logDir);
  assert.equal(logFiles.length, 1);
  assert.match(logFiles[0], /^reframe-P900-\d+\.log$/);
});

test("ratifyCliGateway.approve: the SAME real detached bin/rmd spawn, distinct CLI args from reframe's (`approve <id>`, no --feedback)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "bin"), { recursive: true });
  const markerPath = join(root, "marker.txt");
  writeFileSync(join(root, "bin", "rmd"), `#!/usr/bin/env bash\necho "$@" > "${markerPath}"\n`, { mode: 0o755 });
  const logDir = join(root, "state", "logs");

  const gateway = ratifyCliGateway(root, logDir);
  gateway.approve("P901");

  const deadline = Date.now() + 5000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(markerPath), "the real bin/rmd script must actually have been spawned");
  assert.match(readFileSync(markerPath, "utf8"), /^approve P901$/m);

  const logFiles = readdirSync(logDir);
  assert.equal(logFiles.length, 1);
  assert.match(logFiles[0], /^approve-P901-\d+\.log$/);
});

// bearerTokenId parity check (never the raw secret leaked as ledger origin).
test("panel-graph ledger origin is a stable hash, never the raw bearer token", () => {
  assert.doesNotMatch(writerId, new RegExp(WRITE_TOKEN));
  assert.equal(writerId, createHash("sha256").update(WRITE_TOKEN).digest("hex").slice(0, 12));
});
