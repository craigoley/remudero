/**
 * W1-T13605: after a serve cold start on 2026-11-18, one Console Approve ran the full Inbox classification on serve's
 * main thread: every proposal's anchor grep as a synchronous git child, a 123 s event-loop stall. Approve now
 * classifies only the proposal it names, like every other Inbox write (W1-T13188), and still reads the plan at its
 * ref (W1-T2220). Each proposal carries its own evidence anchor, so the anchor grep seam counts classifications.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { anchorFingerprint, type EvidenceAnchor } from "#src/lib/inbox.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type TestCtx = { after: (fn: () => void) => void };
const T0 = Date.parse("2026-11-18T04:00:00.000Z");
const WRITE_TOKEN = "approve-one-write-token";
const ids = Array.from({ length: 30 }, (_, i) => `verify-human:W9-T${i + 1}`);
const target = ids[11]!;

function world(t: TestCtx): { deps: PanelGraphDeps; grepped: string[]; approved: string[]; planPath: string } {
  const repo = gitRepo({ seedCommit: false, kind: "inbox-approve-one" });
  const root = repo.dir;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const proposals = ids.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [{ description: `anchor for ${id}`, pattern: `pattern-${id}` }] }));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(proposals.map((p) =>
    [p.id, { releaseTaskId: p.id.split(":").at(-1), anchorFingerprint: anchorFingerprint(p.evidenceAnchors) }]))));
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", "plan");
  const grepped: string[] = [];
  const approved: string[] = [];
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: (id: string) => { approved.push(id); }, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: (_root: string, _ref: string, anchor: EvidenceAnchor) => (grepped.push(anchor.pattern), true),
    inboxClock: fixedClock(T0),
  };
  return { deps, grepped, approved, planPath };
}

async function approve(deps: PanelGraphDeps, proposalId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createService({ tokens: { read: "approve-one-read-token", write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/approve`,
      { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ proposalId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test("W1-T13605 criterion 1: approve greps only the named proposal's anchor, never the other 29", async (t) => {
  const { deps, grepped, approved } = world(t);
  const answer = await approve(deps, target);
  assert.equal(answer.status, 409, `positive control: approve read and judged the proposal: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.error, "not_ready");
  assert.match(String(answer.body.detail), /W9-T12/, "the refusal names the proposal approve judged");
  assert.deepEqual(grepped, [`pattern-${target}`]);
  assert.deepEqual(approved, [], "a refused approve spawns nothing");
});

test("W1-T13605 criterion 2: approve of an id the registry lacks answers 404 and classifies nothing", async (t) => {
  const { deps, grepped } = world(t);
  const answer = await approve(deps, "verify-human:W9-T999");
  assert.equal(answer.status, 404);
  assert.equal(answer.body.error, "not_found");
  assert.deepEqual(grepped, []);
});

test("W1-T13605 criterion 3: approve still reads the committed plan, not the working tree (W1-T2220)", async (t) => {
  const { deps, grepped, planPath } = world(t);
  writeFileSync(planPath, "- id: [torn\n");
  const answer = await approve(deps, target);
  assert.equal(answer.status, 409, `the torn working-tree plan was not read: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(grepped, [`pattern-${target}`]);
});
