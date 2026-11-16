/**
 * W1-T13188: a Console Decline ran 887 s inside serve on 2026-11-16 and blocked its loop, because every Inbox write
 * route re-classified all 2,343 proposals to act on one. A write now classifies only the proposal it names; the
 * registry stays whole for existence checks, and approve keeps its full read (W1-T2220).
 * Each proposal carries its own evidence anchor, so the anchor grep seam counts classifications.
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
const T0 = Date.parse("2026-11-16T15:00:00.000Z");
const WRITE_TOKEN = "classify-one-write-token";
const ids = Array.from({ length: 40 }, (_, i) => `verify-human:W9-T${i + 1}`);
const AGE = "board-review:stale:PR-7";

function world(t: TestCtx): { deps: PanelGraphDeps; grepped: string[] } {
  const repo = gitRepo({ seedCommit: false, kind: "inbox-classify-one" });
  const root = repo.dir;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const proposals = [
    ...ids.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [{ description: `anchor for ${id}`, pattern: `pattern-${id}` }] })),
    { id: AGE, originatingItemId: "PR-7", summary: "board-review: PR-7 has sat open 30.0h, past the 24h depth threshold", evidenceAnchors: [{ description: "age", pattern: `pattern-${AGE}` }] },
  ];
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals }));
  // A release draft per proposal: classification then greps the proposal's own anchor, which the seam counts.
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(proposals.map((p) =>
    [p.id, { releaseTaskId: p.id.split(":").at(-1), anchorFingerprint: anchorFingerprint(p.evidenceAnchors) }]))));
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", "plan");
  const grepped: string[] = [];
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: (_root: string, _ref: string, anchor: EvidenceAnchor) => (grepped.push(anchor.pattern), true),
    inboxClock: fixedClock(T0),
  };
  return { deps, grepped };
}

async function post(deps: PanelGraphDeps, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createService({ tokens: { read: "classify-one-read-token", write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const target = ids[17]!;
const cases: Array<[string, Record<string, unknown>]> = [
  ["/v1/inbox/decline", { proposalId: target, reason: "not now" }],
  ["/v1/inbox/restore", { proposalId: target, reason: "back again" }],
  ["/v1/inbox/keep", { proposalId: target, reason: "as it is" }],
  ["/v1/inbox/reframe", { proposalId: target, feedback: "smaller first" }],
  ["/v1/inbox/archive", { proposalId: target, archived: true }],
  ["/v1/inbox/snooze", { proposalId: target, until: "2026-11-17T09:00:00Z" }],
];

test("W1-T13188 criterion 1: each Inbox write route classifies at most the one proposal it names and answers as before", async (t) => {
  for (const [path, body] of cases) {
    const { deps, grepped } = world(t);
    if (path === "/v1/inbox/restore") {
      assert.equal((await post(deps, "/v1/inbox/decline", { proposalId: target, reason: "first" })).status, 200);
      grepped.length = 0;
    }
    const answer = await post(deps, path, body);
    assert.equal(answer.status, 200, `${path} answers 200: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.proposalId, target);
    assert.ok(grepped.every((pattern) => pattern === `pattern-${target}`), `${path} classified only ${target}: ${grepped.join(", ")}`);
    // A declined proposal classifies before its anchors are read, and the decline's own grep is cached, so restore greps none.
    assert.equal(grepped.length, path === "/v1/inbox/restore" ? 0 : 1, `${path} grepped at most the one proposal's anchor`);
  }
});

test("W1-T13188 criterion 2: an absent id is still 404 and an age observation still 409, with no other proposal classified", async (t) => {
  const absent = world(t);
  const missing = await post(absent.deps, "/v1/inbox/decline", { proposalId: "verify-human:W9-T999", reason: "x" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not_found");
  assert.equal(absent.grepped.length, 0, "nothing was classified for an id the registry lacks");
  const age = world(t);
  const informational = await post(age.deps, "/v1/inbox/decline", { proposalId: AGE, reason: "x" });
  assert.equal(informational.status, 409);
  assert.equal(informational.body.error, "informational_only");
  assert.deepEqual(age.grepped, [`pattern-${AGE}`], "only the age observation was classified");
});

test("W1-T13188 criterion 3: approve still classifies the whole registry through its full read", async (t) => {
  const { deps, grepped } = world(t);
  const answer = await post(deps, "/v1/inbox/approve", { proposalId: target });
  assert.equal(answer.status, 409, `positive control: approve read and judged the proposal: ${JSON.stringify(answer.body)}`);
  assert.equal(new Set(grepped).size, ids.length + 1, "approve classified every proposal, as W1-T2220 requires");
});
