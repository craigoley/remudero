import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inboxBoardReferents } from "#src/lib/inbox-board-referents.js";
import { updateProposalRegistry, type Proposal } from "#src/lib/inbox.js";
import { classifyAllProposalsMemo, projectInboxPlan, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { buildBatchedGithub, readLedgerLines, type PrRef } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const publicTaskId = "W1-T1";
const opsTaskId = "W1-T9";
const task = (id: string): Task => ({ id, title: `Task ${id}`, repo: "remudero", depends_on: [], type: "implement",
  risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const plan = (...tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map(t => [t.id, t])) });
const corePlan = plan(task(publicTaskId));
const combinedPlan = plan(...corePlan.tasks, task(opsTaskId), task("W1-T8"));
const prNumber = 77;
const proposalId = `board-review:escalation:#${prNumber}`;

const mergedPr = (number: number, headRefName: string, body?: string): PrRef => ({ number, headRefName, body,
  url: `https://github.com/craigoley/remudero/pull/${number}`, state: "MERGED" });
const ownedPr = mergedPr(prNumber, `run-${opsTaskId}-1795095230170`, `Fix.\n\nRemudero-Task: ${opsTaskId}\n`);

function fixture(t: TestContext, prs: PrRef[], opts: { catalogUnreadable?: boolean; ledger?: object[] } = {}) {
  const root = makeTempDir("rmd-merged-ops-referent");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const proposal: Proposal = { id: proposalId, summary: "Check a board escalation", evidenceAnchors: [] };
  updateProposalRegistry(join(state, "inbox-proposals.json"), () => [proposal]);
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, (opts.ledger ?? []).map(row => JSON.stringify(row)).join("\n"));

  const reads = { merged: 0, open: 0, catalog: 0, remote: 0 };
  const github = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => prs,
    commitTrailerIndex: () => new Map(),
    fetchAllIssues: () => [],
    exec: () => { reads.remote++; return assert.fail("unexpected GitHub call"); },
  });
  const statusGithub = { ...github,
    listMergedHeadBranches: () => { reads.merged++; return github.listMergedHeadBranches!(); },
    listOpenHeadBranches: () => { reads.open++; return github.listOpenHeadBranches!(); },
  };
  const deps: PanelGraphDeps = { root, inboxRoot: root, ledgerPath, planPath: join(root, "plan", "tasks.yaml"),
    statusGithub, github: { prView: () => assert.fail("unexpected PR trace") },
    ratify: { approve: () => assert.fail("unexpected approval"), reframe: () => assert.fail("unexpected reframe") },
    inboxMainSha: () => "fixture",
    inboxReferentPlan: () => { reads.catalog++; return opts.catalogUnreadable ? undefined : combinedPlan; },
  };
  return { deps, proposal, reads };
}

function classify(t: TestContext, prs: PrRef[], opts?: Parameters<typeof fixture>[2]) {
  const { deps, reads } = fixture(t, prs, opts);
  const result = classifyAllProposalsMemo(deps, () => corePlan);
  assert.deepEqual([...result.projection.keys()], [publicTaskId]);
  assert.equal(inboxBoardReferents(result.projection).states.has(`#${prNumber}`), false);
  assert.equal(result.classifications.length, 1);
  return { classification: result.classifications[0], reads };
}

test("W1-T14174 merged ops referent resolves with an ok catalog using the existing PR batches", (t) => {
  const { deps, proposal } = fixture(t, [ownedPr]);
  const { boardReferents } = projectInboxPlan(deps, corePlan, readLedgerLines(deps.ledgerPath), () => [proposal]);
  assert.deepEqual(boardReferents.states.get(`#${prNumber}`), { status: "merged" });
  const { classification, reads } = classify(t, [ownedPr]);
  assert.equal(classification.state, "retired");
  assert.equal(classification.referentUnverified, undefined);
  assert.deepEqual(reads, { merged: 1, open: 1, catalog: 1, remote: 0 });
});

test("W1-T14174 merged ops referent stays unverified with an unreadable catalog", (t) => {
  const { classification, reads } = classify(t, [ownedPr], { catalogUnreadable: true });
  assert.equal(classification.referentUnverified, true);
  assert.equal(reads.catalog, 1);
});

test("W1-T14174 merged ops referent stays unverified with ambiguous or missing trailer claims", (t) => {
  for (const pr of [
    { ...ownedPr, body: `${ownedPr.body}Remudero-Task: W1-T8` },
    { ...ownedPr, headRefName: "run-W1-T8-1795095230170" },
    { ...ownedPr, body: "This mentions Remudero-Task: W1-T9 in prose." },
    { ...ownedPr, body: undefined },
  ]) {
    assert.equal(classify(t, [pr]).classification.referentUnverified, true);
  }
  const duplicate = mergedPr(78, ownedPr.headRefName!, ownedPr.body);
  assert.equal(classify(t, [ownedPr, duplicate]).classification.referentUnverified, true);
  assert.equal(classify(t, [ownedPr, { ...duplicate, state: "OPEN" }]).classification.referentUnverified, true);
});

test("W1-T14174 merged ops referent stays unverified when the projected row names another PR", (t) => {
  const otherPr = mergedPr(78, "manual-fix", "");
  const ledger = [{ step: "pr.opened", task_id: opsTaskId, pr_url: otherPr.url }];
  assert.equal(classify(t, [ownedPr, otherPr], { ledger }).classification.referentUnverified, true);
});
