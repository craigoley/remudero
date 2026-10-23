import assert from "node:assert/strict";
import {join} from "node:path";
import {test} from "node:test";
import {runDraftRung, parseDraftedCandidate, type Proposal} from "#src/lib/inbox.js";
import {workerTranscript, type WorkerResult} from "#src/lib/worker.js";
import {buildInboxDraftSpawnArgs} from "#src/run-task.js";
import type {Config} from "#src/lib/config.js";
import {REPO_ROOT} from "#test/helpers/repo-root.js";

const proposal: Proposal = {id: "machine-judge:W1-T1", summary: "Existing parked task", evidenceAnchors: []};
const plan = "- id: W1-T1\n  title: Existing parked task\n  verify: human\n  status: queued\n";
const release = "RELEASE: W1-T1\n\nNo different work was requested. This files no new task.";
function worker(text: string, blocks: string[] = [text]): WorkerResult {
  return {sessionId: "fixture-no-spawn", costUsd: 0, numTurns: 1, text, blocks, stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "claude", model: "sonnet", effort: "medium", tokens: {input: 0, output: 0, cacheRead: 0, cacheCreation: 0},
    modelUsage: {}, compactionEvents: [], qualitySuspect: false};
}
async function draft(result: WorkerResult, escalation?: WorkerResult) {
  const events: Array<{step: string} & Record<string, unknown>> = [];
  let escalations = 0;
  const [outcome] = await runDraftRung([proposal], plan, {spawn: async () => result,
    ...(escalation ? {escalate: async () => {escalations++; return escalation;}} : {}),
    log: (step, fields) => events.push({step, ...fields})}, "fixture-no-spawn");
  return {outcome, events, escalations};
}
function routing(currentPlanText = plan) {
  const args = buildInboxDraftSpawnArgs({cwd: REPO_ROOT, settingsFile: join(REPO_ROOT, "fixture-settings-not-read.json"),
    prompt: "fixture only; do not spawn", mount: {model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 8192},
    config: {root: REPO_ROOT, claudeBin: "/never-spawned"} as Config, disallowedTools: [],
    proposalId: proposal.id, proposal, currentPlanText, draftRoutingLog: () => {}});
  assert.ok(args.draftRouting);
  return args.draftRouting.evaluate;
}

test("a draft's initial worker counts an SDK-echoed final RELEASE once", async () => {
  const {outcome, events, escalations} = await draft(worker(release));
  assert.equal(outcome?.ok, true);
  assert.equal(outcome?.ok && outcome.candidate.releaseTaskId, "W1-T1");
  assert.equal(events.find(x => x.step === "inbox.drafted")?.lint_clean, true);
  assert.equal(escalations, 0);
});

test("a draft's subscription rescue counts an SDK-echoed final RELEASE once", async () => {
  const {outcome, escalations} = await draft(worker("No usable fragment.", []), worker(release));
  assert.equal(outcome?.ok, true);
  assert.equal(outcome?.ok && outcome.candidate.releaseTaskId, "W1-T1");
  assert.equal(escalations, 1);
});

test("draft routing judges an SDK-echoed final RELEASE as one clean candidate", () => {
  assert.deepEqual(routing()(worker(release)), {contractFailed: false, clean: true});
});

test("one-copy releases and explanatory prose retain the existing parser and rung behavior", async () => {
  assert.equal(parseDraftedCandidate(release, proposal, plan)?.releaseTaskId, "W1-T1");
  const {outcome} = await draft(worker(release, []));
  assert.equal(outcome?.ok, true);
  assert.deepEqual(routing()(worker(release, [])), {contractFailed: false, clean: true});
});

test("the real transcript helper keeps a distinct earlier message and genuine repeated releases", () => {
  assert.equal(workerTranscript(worker(release, ["Earlier context.", release])), release + "\nEarlier context.");
  assert.equal(parseDraftedCandidate(workerTranscript(worker(release, [release, release])), proposal, plan), null);
});

test("genuine multiple releases, another task and mixed fragments still fail the draft and routing contract", async () => {
  for (const text of [release + "\n" + release, "RELEASE: W1-T2", release + "\n=== FRAGMENT START ===\ninvalid\n=== FRAGMENT END ==="]) {
    const result = worker(text);
    assert.equal((await draft(result)).outcome?.ok, false);
    assert.deepEqual(routing()(result), {contractFailed: true, clean: false});
  }
});

test("a dispatch-held task stays refused even when its final message is echoed", () => {
  const held = plan + "  dispatch_hold: true\n";
  assert.equal(parseDraftedCandidate(workerTranscript(worker(release)), proposal, held), null);
  assert.deepEqual(routing(held)(worker(release)), {contractFailed: true, clean: false});
});

test("a genuinely repeated release from the rescue is not turned into approval", async () => {
  const {outcome, escalations} = await draft(worker("No usable fragment.", []), worker(release + "\n" + release));
  assert.equal(outcome?.ok, false);
  assert.equal(escalations, 1);
});

test("draft rejection telemetry counts the same final message that the parser read", async () => {
  const malformed = "No fragment or release markers.";
  const {outcome, events} = await draft(worker(malformed));
  assert.equal(outcome?.ok, false);
  assert.equal(events.find(x => x.step === "inbox.draft_error")?.output_chars, malformed.length);
});
