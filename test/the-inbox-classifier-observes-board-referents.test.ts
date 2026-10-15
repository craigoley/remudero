import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyAllProposalsMemo, classifyAllProposalsSliced, inboxClassificationEvidence, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { inboxBoardReferents } from "../src/lib/inbox-board-referents.js";
import type { StatusProjection } from "../src/lib/status.js";

test("the production Inbox classifier observes its own board referent without a second GitHub read", async t => {
  const root = makeTempDir("rmd-inbox-referents"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
  const url = "https://github.com/fixture/repository/pull/41";
  const plan = loadPlanFromYaml("- id: W1-T41\n  title: fixture open work\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n  pr: 41\n", "fixture");
  let prState = "OPEN";
  const github = fakeGitHub({ prByRef: ref => ref === 41 ? { number: 41, url, state: prState } : null });
  const proposalId = "board-review:stale:#41";
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: proposalId, summary: "Fixture board request", evidenceAnchors: [], originatingItemId: "#41" }] }));
  const ledgerPath = join(stateDir, "ledger.ndjson"); writeFileSync(ledgerPath, "");
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath: join(root, "tasks.yaml"), ledgerPath,
    github: { prView: () => null }, statusGithub: github, ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
  const first = classifyAllProposalsMemo(deps, () => plan);
  assert.equal(first.projection.get("W1-T41")?.prState, "OPEN", "positive control: the production projection really observed the referent");
  assert.equal(first.classifications[0]?.referentUnverified, undefined, "the real caller must pass the observed board evidence into readiness");
  assert.equal(first.classifications[0]?.state, "not_ready", "an open PR is not silently retired");
  assert.equal(inboxClassificationEvidence(first).complete, true);
  assert.equal(classifyAllProposalsMemo(deps, () => plan).classifications, first.classifications, "unchanged evidence still reuses its classification");
  const calls = github.calls.filter(c => c.method === "prByRef");
  assert(calls.every(c => c.args[0] === 41), "no per-proposal or differently scoped lookup was added");
  prState = "CLOSED";
  const closed = classifyAllProposalsMemo(deps, () => plan);
  assert.equal(closed.projection.get("W1-T41")?.prState, "CLOSED", "positive control: closing did not merge the task");
  assert.equal(closed.classifications[0]?.state, "retired", "PR state, not only task merge credit, invalidates the memo");
  assert.notEqual(closed.classifications, first.classifications);
  const sliced = await classifyAllProposalsSliced({ ...deps }, () => plan);
  assert.equal(sliced.classifications[0]?.state, "retired", "the real slow-lane caller shares the same evidence");
});

test("an Inbox referent absent from observed repository evidence stays unverified", () => {
  const root = makeTempDir("rmd-inbox-referent-missing");
  try {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
    const ledgerPath = join(stateDir, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "board-review:stale:#999", summary: "Unknown fixture referent", evidenceAnchors: [] }] }));
    const plan = loadPlanFromYaml("[]\n", "fixture");
    const deps: PanelGraphDeps = { root, inboxRoot: root, planPath: join(root, "tasks.yaml"), ledgerPath,
      github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40) };
    const read = classifyAllProposalsMemo(deps, () => plan);
    assert.equal(read.classifications[0]?.referentUnverified, true);
    assert.notEqual(read.classifications[0]?.state, "retired");
    assert.equal(inboxClassificationEvidence(read).complete, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("board referent evidence refuses unavailable conflicting and unobserved states", () => {
  const row = (prNumber: number | undefined, extra: Partial<StatusProjection> = {}): StatusProjection => ({
    taskId: "fixture", status: "running", source: "pr-field", merged: false, prNumber, prState: "OPEN", ...extra,
  });
  const rows = [row(undefined), row(0), row(1.5), row(1, { needsHuman: true }), row(1),
    row(2, { prState: "MERGED", escalationUnverified: true }), row(3, { prState: "CLOSED" }),
    row(4, { prState: undefined, merged: true }), row(5, { indeterminate: true }),
    row(6, { githubUnobservableSince: "2026-10-15T00:00:00Z" }), row(7, { escalationUnverified: true }),
    row(8), row(8, { prState: "MERGED" }), row(9), row(9, { prState: undefined })];
  const observed = inboxBoardReferents(new Map(rows.map((r, index) => [String(index), r])));
  assert.equal(observed.kind, "ok");
  assert.deepEqual([...observed.states], [["#1", { status: "open", unhandledEscalations: 1 }],
    ["#2", { status: "merged", unhandledEscalations: 0 }], ["#3", { status: "dead", unhandledEscalations: 0 }]]);
  assert.equal(inboxBoardReferents(new Map()).states.size, 0, "empty evidence retires nothing by absence");
});
