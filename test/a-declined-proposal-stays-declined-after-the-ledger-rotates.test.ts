import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildPanelGraphRoutes, classifyAllProposalsSliced, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { registryThreadItems } from "#src/lib/inbox-responder.js";
import { createService } from "#src/lib/service.js";
// Imported per test, so this file still loads where the store does not exist and each test reports its own failure.
const receipts = () => import("#src/lib/inbox-verdict-receipts.js");
import { fakeGitHub } from "#test/helpers/fake-github.js";

const DECLINED = "verify-human:W1-T216";
const OPEN = "verify-human:W1-T217";

/** A core-shaped root whose operator decline survives only in an archived rotation, as verify-human:W3-T7's did. */
function rotatedFixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-rotated-decline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), planPath = join(root, "plan/tasks.yaml"), ledgerPath = join(stateDir, "ledger.ndjson");
  mkdirSync(stateDir); mkdirSync(join(root, "plan"));
  const task = (id: string) => `- id: ${id}
  title: "A parked operator ask"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/parked.test.ts]
  acceptance:
    - claim: "parked evidence"
      proof: "unit test: parked evidence"
`;
  writeFileSync(planPath, task("W1-T216") + task("W1-T217"));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [DECLINED, OPEN].map((id) => ({
    id, summary: "A parked operator ask", evidenceAnchors: [], conflictsWith: [],
  })) }));
  const declinedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const decline = { ts: declinedAt, run_id: "PANEL-1", task_id: DECLINED, step: "panel.proposal_declined", origin: "rmd-cli",
    reason: "operator-approved inbox clear; reversible with rmd restore" };
  writeFileSync(join(stateDir, `ledger.${declinedAt.replaceAll(":", "-")}.ndjson.gz`), gzipSync(JSON.stringify(decline) + "\n"));
  // The live file the rotation left: 200 newer fleet-lane folds of OTHER proposals, and none of the operator's decline.
  const folds = Array.from({ length: 200 }, (_, i) => ({ ts: new Date(Date.now() - 3600_000 + i).toISOString(), run_id: `PANEL-F${i}`,
    task_id: `followup:W1-T9-${i}`, step: "panel.proposal_declined", origin: "fleet-lane", reason: "Folded into an older finding" }));
  writeFileSync(ledgerPath, folds.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null },
    statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40) };
  return { root, stateDir, ledgerPath, deps, declinedAt };
}

async function post(deps: PanelGraphDeps, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createService({ tokens: { read: "decline-read", write: "decline-write" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: "POST", headers: { authorization: "Bearer decline-write", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  } finally { server.closeAllConnections(); server.close(); }
}

test("an operator decline that only an archived rotation holds keeps its proposal declined", async (t) => {
  const { deps } = rotatedFixture(t);
  const classified = await classifyAllProposalsSliced(deps);
  const byId = new Map(classified.classifications.map((c) => [c.proposalId, c]));
  assert.equal(byId.get(DECLINED)?.state, "declined");
  assert.equal(byId.get(DECLINED)?.declinedReason, "operator-approved inbox clear; reversible with rmd restore");
  assert.notEqual(byId.get(OPEN)?.state, "declined");
});

test("the slow lane stores the archived decline, so rmd restore's route can reverse it", async (t) => {
  const { readVerdictReceipts } = await receipts();
  const { stateDir, deps } = rotatedFixture(t);
  await refreshInboxClassification(deps, {});
  const stored = readVerdictReceipts(stateDir);
  assert.deepEqual(stored.map((r) => [r.task_id, r.step]), [[DECLINED, "panel.proposal_declined"]]);
  // A second decline is refused as already declined: the write route sees the stored receipt too.
  assert.equal((await post(deps, "/v1/inbox/decline", { proposalId: DECLINED, reason: "again" })).status, 409);
  const restored = await post(deps, "/v1/inbox/restore", { proposalId: DECLINED, reason: "operator restore" });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored, true);
  const after = await classifyAllProposalsSliced(deps);
  assert.notEqual(after.classifications.find((c) => c.proposalId === DECLINED)?.state, "declined");
});

test("the inbox responder reads a stored decline, so it never re-asks a declined item", async (t) => {
  const { writeVerdictReceipts } = await receipts();
  const { stateDir, ledgerPath, declinedAt } = rotatedFixture(t);
  writeVerdictReceipts(stateDir, [{ step: "panel.proposal_declined", task_id: DECLINED, ts: declinedAt, run_id: "PANEL-1", reason: "cleared" }], [DECLINED, OPEN]);
  const items = new Map(registryThreadItems(stateDir, ledgerPath).map((i) => [i.proposalId, i.state]));
  assert.equal(items.get(DECLINED), "declined");
  assert.equal(items.get(OPEN), "ready");
});

test("the newest receipt by time wins, whichever source carries it", async () => {
  const { mergeVerdictReceipts, proposalVerdictsWithReceipts } = await receipts();
  const at = (h: number) => new Date(Date.UTC(2026, 9, 13, h)).toISOString();
  const restore = { step: "panel.proposal_restored", task_id: DECLINED, ts: at(1), run_id: "PANEL-R", reason: "restore" };
  const decline = { step: "panel.proposal_declined", task_id: DECLINED, ts: at(2), run_id: "PANEL-D", reason: "decline" };
  // The live file kept the older restore and lost the newer decline (the cap counts the two steps apart).
  assert.equal(proposalVerdictsWithReceipts([restore], [decline]).isDeclined(DECLINED), "decline");
  // The live file still carries the decline; the archive also holds the newer restore.
  assert.equal(proposalVerdictsWithReceipts([decline], [decline, { ...restore, ts: at(3) }]).isDeclined(DECLINED), undefined);
  assert.equal(mergeVerdictReceipts([decline], [decline]).length, 1);
});

test("the stored receipts are bounded by the registry and rewritten only on a change", async (t) => {
  const { inboxVerdictReceiptsPath, readVerdictReceipts, writeVerdictReceipts } = await receipts();
  const root = mkdtempSync(join(tmpdir(), "rmd-verdict-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = (id: string) => ({ step: "panel.proposal_declined", task_id: id, ts: "2026-10-13T02:56:30.145Z", run_id: `PANEL-${id}` });
  assert.equal(writeVerdictReceipts(root, [r("gone"), r(DECLINED)], [DECLINED]), true);
  assert.deepEqual(readVerdictReceipts(root).map((x) => x.task_id), [DECLINED]);
  assert.equal(writeVerdictReceipts(root, [r(DECLINED)], [DECLINED]), false);
  writeFileSync(inboxVerdictReceiptsPath(root), "{torn");
  assert.deepEqual(readVerdictReceipts(root), []);
  assert.match(readFileSync(inboxVerdictReceiptsPath(root), "utf8"), /torn/);
});
