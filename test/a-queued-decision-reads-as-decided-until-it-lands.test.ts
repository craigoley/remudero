/**
 * W1-T5627 — A QUEUED DECISION READS AS DECIDED UNTIL IT LANDS.
 *
 * Since W1-T5460 a console accept or reject only QUEUES the flipped record under the state root; the
 * checkout keeps `status: proposed` until the daemon's landing sweep merges it. W1-T5524 decorated such an
 * entry `landing: "queued"`, but the GET still served the checkout's `proposed` beside it, `?status=proposed`
 * still returned it, and POST /v1/feedback/decision re-read the stale `proposed` and accepted a second —
 * even opposite — decision over the queued one. The queued record's fields now overlay the entry it
 * decorates, before the status filter, and the decision route reads through the same overlay; a queue it
 * cannot read refuses the decision (503) rather than deciding blind.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import * as feedback from "../src/lib/feedback.js";
import * as landing from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const QUEUE_DIR = join("state", "feedback-landing-pending", "plan", "feedback");

type Entry = { id: string; status: string; answered_by?: unknown; landing?: unknown; landingUnknown?: unknown };

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5627-${label}-`));
}

/** A checkout holding two `proposed` entries, a state root outside it, and the console's panel deps. */
function decisionFixture(label: string, wired = true) {
  const root = tmpDir(`${label}-root`);
  const stateRoot = tmpDir(`${label}-state`);
  const decided = feedback.captureFeedback(root, { raw: "a proposal the operator accepts", origin: "ui" });
  const other = feedback.captureFeedback(root, { raw: "a proposal nobody decided", origin: "ui" });
  for (const e of [decided, other]) feedback.setFeedbackStatus(root, e.id, "proposed", { proposalPr: "https://github.com/o/r/pull/7" });
  const logged: Array<[string, Record<string, unknown>]> = [];
  const gh = () => {
    throw new Error("the inbox read and the queued decision make no GitHub call");
  };
  const ledgerPath = join(tmpDir(`${label}-ledger`), "ledger.ndjson");
  const panel = {
    root,
    inboxRoot: stateRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    logProjection: (step: string, extra: Record<string, unknown>) => logged.push([step, extra]),
    ...(wired ? { feedbackLand: { gh } } : {}),
  };
  return { root, stateRoot, decided, other, panel, logged, ledgerPath };
}

async function withServer<T>(panel: unknown, run: (base: string) => Promise<T>): Promise<T> {
  const deps = panel as Parameters<typeof panelGraph.buildFeedbackInboxRoute>[0];
  const server = createService({
    tokens: { read: "r-token", write: "w-token" },
    routes: [panelGraph.buildFeedbackInboxRoute(deps), panelGraph.buildProposalDecisionRoute(deps)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function getEntries(base: string, query = ""): Promise<Map<string, Entry>> {
  const res = await fetch(`${base}/v1/feedback${query}`, { headers: { authorization: "Bearer r-token" } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return new Map((JSON.parse(text) as { entries: Entry[] }).entries.map((e) => [e.id, e]));
}

async function postDecision(base: string, id: string, decision: "accept" | "reject"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await withLiveWritesAllowed(() =>
    fetch(`${base}/v1/feedback/decision`, {
      method: "POST",
      headers: { authorization: "Bearer w-token", "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    }),
  );
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}

const queuedPath = (stateRoot: string, id: string) => join(stateRoot, QUEUE_DIR, `${id}.yaml`);
// ledger-read-intent: live
const decisionRows = (ledgerPath: string) =>
  readLedgerLines(ledgerPath).filter((r) => r.step === "panel.proposal_accepted" || r.step === "panel.proposal_rejected");

test("GET /v1/feedback serves a queued accept as accepted, status=proposed omits it, and a second decision is refused", async () => {
  const fx = decisionFixture("decided");
  await withServer(fx.panel, async (base) => {
    const first = await postDecision(base, fx.decided.id, "accept");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.landing, "queued", "the decision only queues (W1-T5460)");
    assert.equal(feedback.readFeedbackEntry(fx.root, fx.decided.id).status, "proposed", "the checkout still says proposed");

    const reloaded = await getEntries(base);
    assert.equal(reloaded.get(fx.decided.id)?.status, "accepted", "the queued decision's status, not the checkout's");
    assert.equal(reloaded.get(fx.decided.id)?.landing, "queued");
    assert.equal(reloaded.get(fx.other.id)?.status, "proposed", "an undecided entry keeps the checkout's status");

    const proposed = await getEntries(base, "?status=proposed");
    assert.equal(proposed.has(fx.decided.id), false, "the board no longer offers the queued decision");
    assert.equal(proposed.has(fx.other.id), true);
    const accepted = await getEntries(base, "?status=accepted");
    assert.equal(accepted.get(fx.decided.id)?.landing, "queued", "the filter answers the queued status");

    for (const decision of ["accept", "reject"] as const) {
      const again = await postDecision(base, fx.decided.id, decision);
      assert.equal(again.status, 400, `a second ${decision} is refused: ${JSON.stringify(again.body)}`);
      assert.match(String(again.body.detail), /not awaiting a decision \(status: accepted\)/);
    }
  });
  assert.match(readFileSync(queuedPath(fx.stateRoot, fx.decided.id), "utf8"), /^status: accepted$/m, "the first decision's record is not overwritten");
  assert.deepEqual(
    decisionRows(fx.ledgerPath).map((r) => r.step),
    ["panel.proposal_accepted"],
    "only the first decision is ledgered",
  );
});

test("GET /v1/feedback overlays a queued answer's status and answered_by onto the grilling entry it answers", async () => {
  const fx = decisionFixture("answered");
  const grill = feedback.captureFeedback(fx.root, { raw: "which lane?", origin: "ui" });
  feedback.setFeedbackStatus(fx.root, grill.id, "grilling");
  const answered = { ...feedback.readFeedbackEntry(fx.root, grill.id), status: "answered", answered_by: "1790000000000-abcdef" };
  mkdirSync(join(fx.stateRoot, QUEUE_DIR), { recursive: true });
  writeFileSync(queuedPath(fx.stateRoot, grill.id), JSON.stringify(answered));
  await withServer(fx.panel, async (base) => {
    const entry = (await getEntries(base)).get(grill.id);
    assert.equal(entry?.status, "answered");
    assert.equal(entry?.answered_by, "1790000000000-abcdef");
    assert.equal(entry?.landing, "queued");
    assert.equal((await getEntries(base, "?status=grilling")).has(grill.id), false);
  });
});

test("readQueuedFeedbackRecords parses each queued record and refuses one that is not a feedback entry", () => {
  const stateRoot = tmpDir("records");
  assert.deepEqual([...landing.readQueuedFeedbackRecords(stateRoot)], [], "an absent queue is empty");
  mkdirSync(join(stateRoot, QUEUE_DIR), { recursive: true });
  writeFileSync(join(stateRoot, QUEUE_DIR, "a.yaml"), "id: a\nstatus: rejected\nanswered_by: null\n");
  assert.deepEqual([...landing.readQueuedFeedbackRecords(stateRoot)], [["plan/feedback/a.yaml", { id: "a", status: "rejected", answered_by: null }]]);
  writeFileSync(join(stateRoot, QUEUE_DIR, "b.yaml"), "- not\n- an entry\n");
  assert.throws(() => landing.readQueuedFeedbackRecords(stateRoot), /queued plan\/feedback\/b\.yaml is not a feedback entry/);
});

test("an unparseable queued record marks the inbox landingUnknown and refuses the decision (503)", async () => {
  const fx = decisionFixture("unparseable");
  mkdirSync(join(fx.stateRoot, QUEUE_DIR), { recursive: true });
  writeFileSync(queuedPath(fx.stateRoot, fx.other.id), "status: [unterminated\n");
  await withServer(fx.panel, async (base) => {
    for (const e of (await getEntries(base)).values()) {
      assert.equal(e.landingUnknown, true, `${e.id} says the queue could not be read`);
      assert.equal(e.status, "proposed", `${e.id} keeps the checkout's status when the overlay is unknown`);
    }
    const refused = await postDecision(base, fx.decided.id, "accept");
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "landing_queue_unreadable");
    assert.match(String(refused.body.detail), /never decided blind/);
  });
  assert.equal(feedback.readFeedbackEntry(fx.root, fx.decided.id).status, "proposed");
  assert.throws(() => readFileSync(queuedPath(fx.stateRoot, fx.decided.id)), /ENOENT/, "nothing is queued");
  assert.deepEqual(decisionRows(fx.ledgerPath), [], "a refused decision is not ledgered");
  const refusals = fx.logged.filter(([step, extra]) => step === "serve.feedback_landing_queue_unreadable" && extra.route === "/v1/feedback/decision");
  assert.equal(refusals.length, 1, "the refusal is recorded with the read's own error");
  assert.match(String(refusals[0]?.[1].reason), /queued plan\/feedback\//);
});

test("POST /v1/feedback/decision refuses (503) when the landing queue directory cannot be read", async () => {
  const fx = decisionFixture("enotdir");
  mkdirSync(join(fx.stateRoot, "state", "feedback-landing-pending", "plan"), { recursive: true });
  writeFileSync(join(fx.stateRoot, QUEUE_DIR), "not a directory\n");
  await withServer(fx.panel, async (base) => {
    const refused = await postDecision(base, fx.decided.id, "reject");
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.match(String(refused.body.detail), /ENOTDIR/);
  });
  assert.deepEqual(decisionRows(fx.ledgerPath), []);
});

test("POST /v1/feedback/decision reads no landing queue when feedbackLand is not wired", async () => {
  const fx = decisionFixture("unwired", false);
  mkdirSync(join(fx.stateRoot, "state", "feedback-landing-pending", "plan"), { recursive: true });
  writeFileSync(join(fx.stateRoot, QUEUE_DIR), "not a directory\n");
  await withServer(fx.panel, async (base) => {
    const decided = await postDecision(base, fx.decided.id, "accept");
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.landing, undefined);
  });
  assert.equal(feedback.readFeedbackEntry(fx.root, fx.decided.id).status, "accepted", "the unwired route writes the checkout");
});

test("the openapi documents the queued overlay on landing and the decision route's 503", () => {
  const spec = parse(readFileSync(new URL("../openapi/daemon.yaml", import.meta.url), "utf8")) as {
    paths: Record<string, { post?: { responses?: Record<string, unknown> } }>;
    components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> };
  };
  const entry = Object.values(spec.components.schemas).find((s) => s.properties?.discharged && s.properties?.landingUnknown);
  assert.match(entry?.properties?.landing?.description ?? "", /W1-T5627/, "landing documents the status overlay");
  assert.ok(spec.paths["/v1/feedback/decision"]?.post?.responses?.["503"], "the decision route documents its 503");
});
