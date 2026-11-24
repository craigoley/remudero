/**
 * W1-T13196: a Console Decline answered "not confirmed" after 5 s was recorded by core 15 minutes later. A decision
 * that carries an idempotencyKey acts once and a repeat answers the first outcome; a request with no key is unchanged.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type Answer = { status: number; body: Record<string, unknown> };
const T0 = Date.parse("2026-11-24T04:00:00.000Z");
const WRITE_TOKEN = "decision-key-write-token";
const ids = ["verify-human:W9-T1", "verify-human:W9-T2"];

function world(t: TestCtx, clock = fixedClock(T0)): { deps: PanelGraphDeps; root: string; reframed: string[]; rows: (step: string) => number } {
  const repo = gitRepo({ seedCommit: false, kind: "inbox-decision-key" });
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
  const reframed: string[] = [];
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: (id: string, feedback: string) => { reframed.push(`${id}|${feedback}`); } },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: (_root: string, _ref: string, _anchor: EvidenceAnchor) => true,
    inboxClock: clock,
  };
  const rows = (step: string) => readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.includes(`"${step}"`)).length;
  return { deps, root, reframed, rows };
}

async function post(deps: PanelGraphDeps, path: string, body: unknown): Promise<Answer> {
  const server = createService({ tokens: { read: "decision-key-read-token", write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const decline = (deps: PanelGraphDeps, extra: Record<string, unknown>, proposalId = ids[0]!, reason = "not now"): Promise<Answer> =>
  post(deps, "/v1/inbox/decline", { proposalId, reason, ...extra });
const reframe = (deps: PanelGraphDeps, extra: Record<string, unknown>, proposalId = ids[0]!, feedback = "narrower"): Promise<Answer> =>
  post(deps, "/v1/inbox/reframe", { proposalId, feedback, ...extra });

test("W1-T13196 criterion 1: two declines with one key write one row and the second answers duplicate", async (t) => {
  const { deps, rows } = world(t);
  const [first, second] = await Promise.all([decline(deps, { idempotencyKey: "dec-1" }), decline(deps, { idempotencyKey: "dec-1" })]);
  const answers = [first, second].sort((a, b) => Number("duplicate" in a.body) - Number("duplicate" in b.body));
  assert.equal(answers[0]!.status, 200, `positive control: the decline itself took: ${JSON.stringify(answers[0]!.body)}`);
  assert.equal(answers[0]!.body.declined, true);
  assert.equal(answers[0]!.body.duplicate, undefined);
  assert.equal(answers[1]!.status, 200);
  assert.equal(answers[1]!.body.duplicate, true);
  assert.equal(answers[1]!.body.declined, true, "the repeat carries the first outcome");
  assert.equal(rows("panel.proposal_declined"), 1);
  const later = await decline(deps, { idempotencyKey: "dec-1" });
  assert.equal(later.status, 200, "a later repeat still answers the stored outcome, not already_declined");
  assert.equal(later.body.duplicate, true);
  assert.equal(rows("panel.proposal_declined"), 1);
});

test("W1-T13196 criterion 2: two reframes with one key hand off once and write one row", async (t) => {
  const { deps, reframed, rows } = world(t);
  const first = await reframe(deps, { idempotencyKey: "ref-1" });
  const second = await reframe(deps, { idempotencyKey: "ref-1" });
  assert.equal(first.status, 200, `positive control: the reframe itself took: ${JSON.stringify(first.body)}`);
  assert.equal(first.body.started, true);
  assert.equal(first.body.duplicate, undefined);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.started, true);
  assert.deepEqual(reframed, [`${ids[0]}|narrower`]);
  assert.equal(rows("panel.proposal_reframe_requested"), 1);
});

test("W1-T13196 criterion 3: a key reused for another proposal, decision or text is 409 and records nothing", async (t) => {
  const { deps, reframed, rows } = world(t);
  assert.equal((await decline(deps, { idempotencyKey: "reuse" })).status, 200);
  for (const [name, answer] of [
    ["proposal", await decline(deps, { idempotencyKey: "reuse" }, ids[1])],
    ["text", await decline(deps, { idempotencyKey: "reuse" }, ids[0], "another reason")],
    ["decision", await reframe(deps, { idempotencyKey: "reuse" })],
    ["restore", await post(deps, "/v1/inbox/restore", { proposalId: ids[0], reason: "not now", idempotencyKey: "reuse" })],
  ] as const) {
    assert.equal(answer.status, 409, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error, "idempotency_key_reused", name);
  }
  assert.equal(rows("panel.proposal_declined"), 1);
  assert.equal(rows("panel.proposal_reframe_requested"), 0);
  assert.equal(rows("panel.proposal_restored"), 0);
  assert.deepEqual(reframed, []);
  const store = JSON.parse(readFileSync(join(deps.inboxRoot, "state", "inbox-decision-keys.json"), "utf8")) as Record<string, { at: number }>;
  assert.deepEqual(Object.keys(store), ["reuse"]);
});

test("W1-T13196 criterion 3: a stored key is dropped after seven days and the decision runs again", async (t) => {
  const { deps, rows } = world(t);
  assert.equal((await decline(deps, { idempotencyKey: "old" })).status, 200);
  const later = { ...deps, inboxClock: fixedClock(T0 + 8 * 24 * 60 * 60 * 1000) };
  const again = await decline(later, { idempotencyKey: "old" });
  assert.equal(again.status, 409, "the key is forgotten, so today's already_declined answers");
  assert.equal(again.body.error, "already_declined");
  assert.equal(rows("panel.proposal_declined"), 1);
});

test("W1-T13196 criterion 4: a decision without a key is unchanged and a bad key is a 400", async (t) => {
  const { deps, root, reframed, rows } = world(t);
  const first = await decline(deps, {});
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, proposalId: ids[0], declined: true });
  const second = await decline(deps, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "already_declined");
  assert.equal((await decline(deps, {}, "verify-human:W9-T999")).status, 404);
  assert.equal((await post(deps, "/v1/inbox/restore", { proposalId: ids[1], reason: "x" })).body.error, "not_declined");
  const plain = await reframe(deps, {}, ids[1]);
  assert.deepEqual(plain.body, { ok: true, proposalId: ids[1], started: true });
  assert.equal((await reframe(deps, {}, ids[1])).status, 200, "a keyless reframe repeats as it always did");
  assert.equal(reframed.length, 2);
  assert.equal(rows("panel.proposal_declined"), 1);
  assert.equal(rows("panel.proposal_reframe_requested"), 2);
  assert.throws(() => readFileSync(join(root, "state", "inbox-decision-keys.json"), "utf8"), /ENOENT/, "no key, no store");
  for (const bad of ["", "x".repeat(201), "has space", "a/b", 7, null]) {
    for (const answer of [await decline(deps, { idempotencyKey: bad }, ids[1]), await reframe(deps, { idempotencyKey: bad }, ids[1])]) {
      assert.equal(answer.status, 400, `key ${JSON.stringify(bad)}`);
      assert.equal(answer.body.error, "invalid_request");
    }
  }
  assert.equal((await decline(deps, { idempotencyKey: "x".repeat(200) }, ids[1])).status, 200, "200 characters is the longest accepted key");
  assert.equal(rows("panel.proposal_declined"), 2);
  assert.equal(reframed.length, 2, "a refused key hands off nothing");
});
