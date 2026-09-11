/**
 * test/a-decline-can-be-taken-back.test.ts — W1-T3407.
 *
 * A DECLINE WAS IRREVERSIBLE. `declinedReasonInLedger` knew exactly one step, so any
 * `panel.proposal_declined` row meant declined forever — and a decline entered on reasoning that
 * later proved WRONG could not be taken back by any means short of editing an append-only ledger.
 *
 * MEASURED 2026-09-11: 16 proposals were declined on a claim about `proofQueueAudit` that the
 * source refuted (`review.ts:2156` gates the forward-reference carve-out on `!nameFiltered`
 * DELIBERATELY, and `:2255` grades a title matching nothing as test theater). The only remedy
 * available was to append a SECOND decline whose reason said the first was wrong, which left all
 * sixteen declined.
 *
 * THE SHAPE IS `automergeHoldFromLedger`'s (lib/review.ts), deliberately: one pass over the same
 * lines, an engage row setting state and a release row clearing it, latest wins. Both steps are
 * registered in `DECISION_RELEVANT_LEDGER_STEPS` for the SAME reason — rotating either half away
 * inverts the answer, in one direction or the other.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createService } from "../src/lib/service.js";
import { declinedReasonInLedger } from "../src/lib/inbox.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { buildPanelGraphRoutes, type PanelGraphDeps, type RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

const ID = "proof-debt:W1-T965";
const decline = (reason: string, task_id = ID) => ({ step: "panel.proposal_declined", task_id, reason });
const restore = (reason: string, task_id = ID) => ({ step: "panel.proposal_restored", task_id, reason });
const READ_TOKEN = "restore-read-token";
const WRITE_TOKEN = "restore-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inbox-restore-"));
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

function traceGateway(): TraceGithub {
  return { prView: () => null };
}

function statusGateway(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => undefined, reframe: () => undefined };
}

function emptyPlanPath(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return planPath;
}

function depsFor(root: string, planPath: string): PanelGraphDeps {
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: ledgerPathFor(root),
    github: traceGateway(),
    statusGithub: statusGateway(),
    ratify: fakeRatifyGateway(),
  };
}

async function withService<T>(deps: PanelGraphDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
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
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

function seedReadyProposal(root: string, proposalId: string, summary: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: proposalId, summary, evidenceAnchors: [] }] }));
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      [proposalId]: {
        proposalId,
        fragmentYaml: READY_FRAGMENT,
        stampLine: `- ${proposalId} (plan) — RATIFIED 2026-09-02 -> W1-T900.`,
        anchorFingerprint: "",
      },
    }),
  );
}

test("W1-T3407: a restore CLEARS a decline, so a proposal wrongly refused can be taken back", () => {
  const reason = declinedReasonInLedger([decline("declined on reasoning the source refuted"), restore("that reasoning was wrong")], ID);
  assert.equal(reason, undefined, "a restored proposal must read as not-declined");
});

test("W1-T3407: LATEST WINS in both directions — a decline after a restore refuses it again", () => {
  assert.equal(
    declinedReasonInLedger([decline("first"), restore("reopened"), decline("refused again, on better evidence")], ID),
    "refused again, on better evidence",
    "an operator must be able to change their mind twice",
  );
});

test("W1-T3407: the two can alternate as many times as an operator needs", () => {
  const lines = [decline("a"), restore("b"), decline("c"), restore("d"), decline("e"), restore("f")];
  assert.equal(declinedReasonInLedger(lines, ID), undefined);
});

test("W1-T3407: a restore is SCOPED to its own proposal and never clears a sibling's decline", () => {
  const lines = [decline("sibling stays declined", "proof-debt:W1-T968"), restore("only this one", ID), decline("mine", ID)];
  assert.equal(declinedReasonInLedger(lines, "proof-debt:W1-T968"), "sibling stays declined");
  assert.equal(declinedReasonInLedger(lines, ID), "mine");
});

test("W1-T3407: a restore with no prior decline is simply not-declined, never a crash", () => {
  assert.equal(declinedReasonInLedger([restore("nothing to undo")], ID), undefined);
});

test("W1-T3407: an ordinary decline still reads exactly as before — the reader is not weakened", () => {
  assert.equal(declinedReasonInLedger([decline("a real refusal")], ID), "a real refusal");
  assert.equal(
    declinedReasonInLedger([{ step: "panel.proposal_declined", task_id: ID }], ID),
    "declined by an operator",
    "a reasonless decline still falls back to the standing phrase",
  );
});

test("W1-T3407: BOTH halves are retention-protected — rotating either away would invert the answer", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("panel.proposal_declined"));
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("panel.proposal_restored"),
    "losing a restore silently RE-DECLINES a proposal an operator deliberately re-opened",
  );
});

test("POST /v1/inbox/restore: a declined READY proposal returns to the ready queue and ledgers why", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P910", "a proposal declined on stale reasoning");

  await withService(depsFor(root, planPath), async (base) => {
    const declineRes = await post(base, "/v1/inbox/decline", WRITE_TOKEN, {
      proposalId: "P910",
      reason: "source text looked wrong",
    });
    assert.equal(declineRes.status, 200);

    const declined = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as { ready: unknown[] };
    assert.deepEqual(declined.ready, []);

    const restoreRes = await post(base, "/v1/inbox/restore", WRITE_TOKEN, {
      proposalId: "P910",
      reason: "the source refuted the decline",
    });
    assert.equal(restoreRes.status, 200);
    assert.deepEqual(await restoreRes.json(), { ok: true, proposalId: "P910", restored: true });

    const restored = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as {
      ready: Array<{ proposalId: string }>;
    };
    assert.deepEqual(
      restored.ready.map((r) => r.proposalId),
      ["P910"],
      "restoring clears the declined state on the panel's own read surface",
    );
  });

  const lines = readLedgerLines(ledgerPathFor(root));
  const restoreLine = lines.find((l) => l.step === "panel.proposal_restored");
  assert.ok(restoreLine, "must ledger panel.proposal_restored");
  assert.equal(restoreLine!.task_id, "P910");
  assert.equal(restoreLine!.reason, "the source refuted the decline");
  assert.ok(typeof restoreLine!.origin === "string" && (restoreLine!.origin as string).length > 0);
});

test("POST /v1/inbox/restore: read token is refused with 403, matching the write-scoped decline", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P911", "a ready proposal");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/restore", READ_TOKEN, { proposalId: "P911", reason: "x" });
    assert.equal(res.status, 403);
  });
});

test("POST /v1/inbox/restore: an unknown proposal id -> 404, no ledger line written", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [] }));

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/restore", WRITE_TOKEN, { proposalId: "P912", reason: "x" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_found");
  });
  assert.deepEqual(readLedgerLines(ledgerPathFor(root)), []);
});

test("POST /v1/inbox/restore: a proposal that is not declined is refused 409", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P913", "a ready proposal");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/restore", WRITE_TOKEN, { proposalId: "P913", reason: "x" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_declined");
    assert.match(body.detail, /state: ready/);
  });
  assert.deepEqual(readLedgerLines(ledgerPathFor(root)), []);
});

test("POST /v1/inbox/restore: an already-RATIFIED proposal is refused 409", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P914", "a ready proposal");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPathFor(root), `${JSON.stringify({ run_id: "APPROVE-P914-1", task_id: "P914", step: "ratify.approved" })}\n`);

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/restore", WRITE_TOKEN, { proposalId: "P914", reason: "too late" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "already_ratified");
    assert.match(body.detail, /cannot un-file/);
  });
});
