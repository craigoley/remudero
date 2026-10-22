import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildPanelGraphRoutes, classifyAllProposalsSliced, inboxLanes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { declineLapse, currentDeclineState, observedStateKey, observedStateOfProposalSummary, shardsNeedingJudgement, type ShardUnderJudgement } from "#src/lib/verify-human-judge.js";
import { priorVerifyHumanVerdicts, rowsWithArchivedVerifyHumanVerdicts } from "#src/run-task.js";
import type { PrRef } from "#src/lib/status.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const PROPOSAL = "verify-human:W3-T7";
const STATE_BEFORE = "W3-T7:deps=0:cited=0";

const prUrl = (id: string) => `https://github.com/o/r/pull/${id === "W3-T2" ? 2 : 44}`;
const taskOfUrl = (url: string) => (url.endsWith("/2") ? "W3-T2" : "W1-T44");

const task = (id: string, status: string, dependsOn: string[] = [], verify = "auto") => `- id: ${id}
  title: "A task"
  repo: remudero
  depends_on: [${dependsOn.join(", ")}]
  type: implement
  verify: ${verify}
  risk: high
  status: ${status}
  attempts: 0
  files: [test/parked.test.ts]
  acceptance:
    - claim: "parked evidence"
      proof: "unit test: parked evidence"
`;

/** A core-shaped root: verify-human:W3-T7 declined on 2026-10-13, its dependencies W3-T2 and W1-T44 merged or not. */
function declinedFixture(t: { after: (fn: () => void) => void }, opts: { depsStatus: string; observedState?: string }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-decline-lapse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), planPath = join(root, "plan/tasks.yaml"), ledgerPath = join(stateDir, "ledger.ndjson");
  mkdirSync(stateDir); mkdirSync(join(root, "plan"));
  writeFileSync(planPath, task("W3-T2", opts.depsStatus) + task("W1-T44", opts.depsStatus) + task("W3-T7", "queued", ["W3-T2", "W1-T44"], "human"));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{
    id: PROPOSAL, summary: `W3-T7 was filed \`verify: human\`.\nJudge provenance: decision=needs_operator; observed_state=${STATE_BEFORE}.\n\nA parked ask.`,
    evidenceAnchors: [], conflictsWith: [],
  }] }));
  const decline = { ts: "2026-10-13T02:56:30.145Z", run_id: "PANEL-1", task_id: PROPOSAL, step: "panel.proposal_declined", origin: "rmd-cli",
    reason: "Later-wave design-review skill whose dependencies are unmerged", ...(opts.observedState ? { observed_state: opts.observedState } : {}) };
  writeFileSync(ledgerPath, [decline].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null },
    statusGithub: fakeGitHub({
      findMergedByTrailer: (id: string): PrRef | null => (opts.depsStatus === "merged" && id !== "W3-T7" ? { number: 7, url: prUrl(id), state: "MERGED" } : null),
      headRefName: (url: string) => (url.startsWith("https://github.com/o/r/pull/") ? `run-${taskOfUrl(url)}-1790000000000` : undefined),
      prBody: (url: string) => (url.startsWith("https://github.com/o/r/pull/") ? `Remudero-Task: ${taskOfUrl(url)}\n` : undefined),
    }), ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40) };
  return { root, stateDir, ledgerPath, deps };
}

const classificationOf = async (deps: PanelGraphDeps) => (await classifyAllProposalsSliced(deps)).classifications.find((c) => c.proposalId === PROPOSAL) as
  (Awaited<ReturnType<typeof classifyAllProposalsSliced>>["classifications"][number] & { reopenedBecause?: string }) | undefined;

const shard = (over: Partial<ShardUnderJudgement> = {}): ShardUnderJudgement =>
  ({ id: "W3-T7", title: "A parked ask", rationale: "", acceptance: [], ageDays: 4, depsAllMerged: false, citedInSrc: false, ...over });

test("W1-T10077: a settled verify-human verdict that only an archive holds is not judged again", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-judged-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const judged = { ts: "2026-10-01T00:00:00.000Z", run_id: "J-1", task_id: "W3-T7", step: "verify_human.judged", judge_decision: "needs_operator",
    judge_reason: "a real ask", observed_state: observedStateKey(shard()) };
  writeFileSync(join(root, "ledger.2026-10-01T01-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(judged) + "\n"));
  // The live file the rotation left holds 200 newer rows of other tasks and none for this shard.
  const live = Array.from({ length: 200 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(), run_id: `J-${i}`, task_id: `W9-T${i}`,
    step: "verify_human.judged", judge_decision: "backlog", judge_reason: "x", observed_state: `W9-T${i}:deps=0:cited=0` }));
  writeFileSync(ledgerPath, live.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Control: the live file alone, which is what the cadence read before, leaves the settled shard due.
  assert.equal(shardsNeedingJudgement([shard()], priorVerifyHumanVerdicts(live)).length, 1);
  const prior = priorVerifyHumanVerdicts(rowsWithArchivedVerifyHumanVerdicts(ledgerPath, live));
  assert.equal(prior.get(observedStateKey(shard()))?.decision, "needs_operator");
  assert.deepEqual(shardsNeedingJudgement([shard()], prior), []);
  // A material change still re-opens the question: the archive settled the OLD observed state only.
  assert.equal(shardsNeedingJudgement([shard({ depsAllMerged: true })], prior).length, 1);
});

test("W1-T10077: a decline holds while the observed state it recorded is unchanged", async (t) => {
  const { deps } = declinedFixture(t, { depsStatus: "queued", observedState: STATE_BEFORE });
  const c = await classificationOf(deps);
  assert.equal(c?.state, "declined");
  assert.equal(c?.reopenedBecause, undefined);
  const receipt = { ts: "2026-10-13T02:56:30.145Z", observed_state: STATE_BEFORE };
  assert.equal(declineLapse(receipt, currentDeclineState(STATE_BEFORE, false)), undefined);
});

test("W1-T10077: a dependency merging after a decline re-opens the item and says why", async (t) => {
  const { deps, root } = declinedFixture(t, { depsStatus: "merged", observedState: STATE_BEFORE });
  const classified = await classifyAllProposalsSliced(deps);
  const c = classified.classifications.find((x) => x.proposalId === PROPOSAL) as { state: string; reopenedBecause?: string };
  assert.notEqual(c.state, "declined");
  assert.equal(c.reopenedBecause, "W3-T2 and W1-T44 have merged since you declined this on 2026-10-13");
  const lanes = inboxLanes(classified, root);
  const item = [...lanes.ready, ...lanes.notReady].find((i) => i.proposalId === PROPOSAL);
  assert.equal(item?.reopenedBecause, c.reopenedBecause);
  assert.equal(lanes.declined.some((i) => i.proposalId === PROPOSAL), false);
});

test("W1-T10077: a decline with no recorded state never lapses", async (t) => {
  const { deps } = declinedFixture(t, { depsStatus: "merged" });
  const c = await classificationOf(deps);
  assert.equal(c?.state, "declined");
  assert.equal(c?.reopenedBecause, undefined);
  assert.equal(declineLapse({ ts: "2026-10-13T02:56:30.145Z" }, "W3-T7:deps=1:cited=0"), undefined);
  // A key of another shape cannot be re-read, so it cannot lapse either.
  assert.equal(currentDeclineState("custom-observation-key", true), undefined);
  assert.equal(declineLapse({ ts: "2026-10-13T02:56:30.145Z", observed_state: "custom-observation-key" }, currentDeclineState("custom-observation-key", true)), undefined);
});

test("W1-T10077: the decline route records the observed state the proposal was judged on", async (t) => {
  const { deps, ledgerPath } = declinedFixture(t, { depsStatus: "queued" });
  writeFileSync(ledgerPath, "");
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/decline`, {
      method: "POST", headers: { authorization: "Bearer w", "content-type": "application/json" }, body: JSON.stringify({ proposalId: PROPOSAL, reason: "not now" }),
    });
    assert.equal(res.status, 200);
  } finally { server.closeAllConnections(); server.close(); }
  const rows = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.find((r) => r.step === "panel.proposal_declined")?.observed_state, STATE_BEFORE);
  assert.equal(observedStateOfProposalSummary("no provenance here"), undefined);
});

test("W1-T10077: a lapse that changed something other than dependencies still says what changed", () => {
  const lapse = declineLapse({ ts: "2026-10-13T02:56:30.145Z", observed_state: "W3-T7:deps=1:cited=0" }, "W3-T7:deps=0:cited=0");
  assert.match(lapse?.because ?? "", /since you declined this on 2026-10-13/);
  assert.equal(declineLapse({ ts: "2026-10-13T02:56:30.145Z", observed_state: "W3-T7:deps=0:cited=0" }, "W3-T7:deps=1:cited=0")?.because, "its dependencies have merged since you declined this on 2026-10-13");
});
