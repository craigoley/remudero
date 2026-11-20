import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftAttemptKey, draftInputKey,
  draftsDueOnDaemon, inboxDraftExampleFragmentYaml, MAX_DRAFT_LINT_ATTEMPTS, parseDraftAttemptCache, parseDraftCache,
  runDraftRung, type DraftLaneIdentity, type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { buildInboxDraftHook } from "#test/helpers/run-task-test.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Row = { step: string } & Record<string, unknown>;
const anchors = [{ pattern: "draft input", path: "README.md", description: "fixture anchor" }];
const proposal: Proposal = { id: "P13864", summary: "a clean draft is not redrafted", evidenceAnchors: anchors };
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: draft input`;
const dirty = "=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: draft input";
const laneA: DraftLaneIdentity = { leadDeployment: "gpt-oss-120b", effort: "high", escalationDeployment: "sonnet", escalationEffort: "medium" };
const laneB: DraftLaneIdentity = { leadDeployment: "gpt-6-luna", effort: "medium", escalationDeployment: "sonnet", escalationEffort: "medium" };

function worker(text: string): DraftWorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "cash", model: "gpt-oss-120b", servedModel: "gpt-oss-120b", effort: "high",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

const bare: Proposal = { ...proposal, evidenceAnchors: [] };
const cleanRow = (p: Proposal): Row => ({ step: "inbox.drafted", proposal_id: p.id, draft_input_key: draftInputKey(p), lint_clean: true });

function hookFixture(t: TestContext, proposals: Proposal[], rows: Row[]) {
  const root = ownedFixtureDir(t, "clean-draft-root").dir;
  const stateDir = join(root, "state");
  const ledgerPath = join(stateDir, LEDGER_FILENAME);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const setProposals = (current: Proposal[]) => writeFileSync(registryPath, JSON.stringify({ proposals: current }));
  mkdirSync(stateDir, { recursive: true });
  setProposals(proposals);
  const drafted: string[] = [];
  const logs: Row[] = [];
  const append = (row: Row) => appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  rows.forEach(append);
  const newHook = () => buildInboxDraftHook("o", "r", { root } as Config, "RUN-13864", (step, extra = {}) => {
    const row = { step, ...extra };
    logs.push(row);
    append(row);
  }, async (due) => {
    drafted.push(...due.map(p => p.id));
    return [];
  }, () => true, () => "fixture");
  return { stateDir, ledgerPath, setProposals, append, drafted, logs, newHook };
}

test("W1-T13864 criterion 1: draft_synthesized and drafted rows record draft_input_key without the lane", async t => {
  const rows: Row[] = [];
  const scope = { repository: "acme/remudero" };
  const outcomes = await runDraftRung([proposal], "- id: W1-T1\n", {
    causalScope: scope, spawn: async () => worker(clean), log: (step, extra) => rows.push({ step, ...extra }),
  }, "keys");
  const stateDir = ownedFixtureDir(t, "clean-draft-commit").dir;
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(proposal, scope)], outcomes, lane: laneA,
    log: (step, extra) => rows.push({ step, ...extra }) });
  const keyed = rows.filter(row => row.step === "inbox.draft_synthesized" || row.step === "inbox.drafted");
  assert.deepEqual(keyed.map(row => row.step), ["inbox.draft_synthesized", "inbox.drafted"]);
  for (const row of keyed) assert.equal(row.draft_input_key, "draft input::README.md::0");
  assert.equal(String(keyed[0].draft_input_key).includes(laneA.leadDeployment), false);
  assert.notEqual(draftAttemptKey(proposal, laneA), draftAttemptKey(proposal, laneB));
  assert.equal(draftInputKey(proposal), draftInputKey(structuredClone(proposal)));
});

test("W1-T13864 criterion 2: an archived clean draft blocks a duplicate and logs its cache miss once after restart", async t => {
  const fixture = hookFixture(t, [bare], [cleanRow(bare)]);
  for (let index = 0; index < 201; index++) fixture.append(cleanRow({ ...bare, id: `P-other-${index}` }));
  const rotation = rotateLedger(fixture.ledgerPath, { ceilingBytes: 1 });
  assert.equal(rotation.rotated, true);
  assert.match(rotation.archivePath ?? "", /\.ndjson\.gz$/);
  assert.ok(!readFileSync(fixture.ledgerPath, "utf8").includes(`"proposal_id":"${bare.id}"`));
  const poll = fixture.newHook();
  await poll();
  assert.deepEqual(fixture.drafted, []);
  const misses = () => fixture.logs.filter(row => row.step === "inbox.draft_cache_missing");
  assert.deepEqual(misses().map(row => [row.proposal_id, row.draft_input_key]), [[bare.id, draftInputKey(bare)]]);
  await poll();
  for (let index = 0; index < 201; index++) {
    fixture.append({ step: "inbox.draft_cache_missing", proposal_id: `P-other-${index}`, draft_input_key: draftInputKey(bare) });
  }
  const plainRotation = rotateLedger(fixture.ledgerPath, { ceilingBytes: 1, smoothingWindowMs: 0,
    archiveFsDeps: { gzipSync: () => { throw new Error("fixture compression failure"); } } });
  assert.equal(plainRotation.rotated, true);
  assert.match(plainRotation.archivePath ?? "", /\.ndjson$/);
  assert.ok(!readFileSync(fixture.ledgerPath, "utf8").includes(`"proposal_id":"${bare.id}"`));
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, []);
  assert.equal(misses().length, 1);

  const control = hookFixture(t, [bare], [{ ...cleanRow(bare), lint_clean: false }]);
  await control.newHook()();
  assert.deepEqual(control.drafted, [bare.id]);
  assert.equal(control.logs.some(row => row.step === "inbox.draft_cache_missing"), false);
});

test("W1-T13864 criterion 3: a clean completion clears its failure key and stays cached across deployment or effort changes", async t => {
  const { stateDir } = hookFixture(t, [proposal], []);
  const scope = { repository: "o/r" };
  const snapshots = [captureInboxDraftSnapshot(proposal, scope)];
  const attemptsPath = join(stateDir, "inbox-draft-attempts.json");
  const failed = { [proposal.id]: draftAttemptKey(proposal, laneA), other: "untouched" };
  writeFileSync(attemptsPath, JSON.stringify(failed));
  const outcomes = await runDraftRung([proposal], "- id: W1-T1\n", {
    causalScope: scope, spawn: async () => worker(clean), log: () => {},
  }, "clean");
  const rows: Row[] = [];
  commitInboxDraftOutcomes({ stateDir, scope, snapshots, outcomes, lane: laneA,
    log: (step, extra) => rows.push({ step, ...extra }) });
  const cached = parseDraftCache(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  assert.equal(cached[proposal.id]?.completion?.lintClean, true);
  const attempts = parseDraftAttemptCache(readFileSync(attemptsPath, "utf8"));
  assert.deepEqual(attempts, { other: "untouched" });
  for (const lane of [{ ...laneA, leadDeployment: laneB.leadDeployment }, { ...laneA, effort: laneB.effort }]) {
    assert.notEqual(draftAttemptKey(proposal, lane), failed[proposal.id]);
    assert.deepEqual(draftsDueOnDaemon([proposal], cached, attempts, 3, undefined, lane), []);
  }
  const reframed = { ...proposal, reframeHistory: [{ feedback: "narrow it" }] };
  assert.deepEqual(draftsDueOnDaemon([reframed], cached, attempts, 3, {
    isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set(), draftLedgerRows: rows,
  }, laneB), [reframed]);
});

test("W1-T13864 criterion 4: a proposal whose anchors changed or that got a new reframe round is still drafted", async t => {
  const moved: Proposal = { ...bare, evidenceAnchors: [{ pattern: "export function draftsDueOnDaemon", path: "src/lib/inbox.ts", description: "a live anchor" }] };
  const other = { ...bare, id: "P13864-R" };
  const reframed: Proposal = { ...other, reframeHistory: [{ feedback: "narrow it" }] };
  const fixture = hookFixture(t, [moved, reframed], [cleanRow(bare), cleanRow(other)]);
  const poll = fixture.newHook();
  await poll();
  assert.deepEqual(fixture.drafted, [moved.id, reframed.id]);
  fixture.append(cleanRow(moved));
  fixture.append(cleanRow(reframed));
  fixture.setProposals([bare, reframed]);
  await poll();
  assert.deepEqual(fixture.drafted, [moved.id, reframed.id, bare.id], "only the newest clean input is retired");
});

test("W1-T13864 criterion 2: a proposal returning to an older clean input after a newer clean draft is drafted again", () => {
  const moved: Proposal = { ...bare, evidenceAnchors: anchors };
  const rows: Row[] = [
    { ...cleanRow(bare), ts: "2026-11-20T00:00:00.000Z" },
    { ...cleanRow(moved), ts: "2026-11-20T00:00:01.000Z" },
  ];
  const ctx = { isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set<string>() };
  // The union reads the live file before the archives, so the newest row can come first.
  for (const draftLedgerRows of [rows, [...rows].reverse()]) {
    assert.deepEqual(draftsDueOnDaemon([bare], {}, {}, 3, { ...ctx, draftLedgerRows }, laneA), [bare]);
    assert.deepEqual(draftsDueOnDaemon([moved], {}, {}, 3, { ...ctx, draftLedgerRows }, laneA), []);
  }
});

test("W1-T13864 criterion 4: a new reframe round is drafted over a legacy cached draft that has no input snapshot", () => {
  const legacy = { [bare.id]: { proposalId: bare.id, fragmentYaml: "- id: NEW-1\n", stampLine: "STAMP", anchorFingerprint: "" } };
  const reframed: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  const priorAttempt = { [bare.id]: draftAttemptKey(bare, laneA) };
  assert.deepEqual(draftsDueOnDaemon([reframed], legacy, priorAttempt, 3, undefined, laneA), [reframed]);
  assert.deepEqual(draftsDueOnDaemon([reframed], legacy, {}, 3, undefined, laneA), [reframed]);
  assert.deepEqual(draftsDueOnDaemon([bare], legacy, priorAttempt, 3, undefined, laneB), [], "the legacy draft still covers its own input");
  assert.deepEqual(draftsDueOnDaemon([bare], legacy, {}, 3, undefined, laneB), []);
});

test("W1-T13864 criterion 5: a dirty attempt inside one run still redrafts up to MAX_DRAFT_LINT_ATTEMPTS", async t => {
  const { stateDir } = hookFixture(t, [proposal], []);
  const scope = { repository: "o/r" };
  let spawns = 0;
  const outcomes = await runDraftRung([proposal], "- id: W1-T1\n", {
    causalScope: scope, spawn: async () => { spawns++; return worker(dirty); }, log: () => {},
  }, "relint");
  assert.equal(spawns, MAX_DRAFT_LINT_ATTEMPTS);
  const [outcome] = outcomes;
  assert.ok(outcome.ok);
  assert.equal(outcome.candidate.completion?.lintClean, false);
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(proposal, scope)], outcomes, lane: laneA, log: () => {} });
  const attempts = parseDraftAttemptCache(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8"));
  assert.equal(attempts[proposal.id], draftAttemptKey(proposal, laneA));
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, laneA), []);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, laneB), [proposal]);
});

test("the daemon holds drafting until it can read the receipt archive", async t => {
  const fixture = hookFixture(t, [bare], []);
  const archive = join(fixture.stateDir, "ledger.2026-11-19T00-00-00-000Z.ndjson.gz");
  writeFileSync(archive, "unreadable gzip");
  const poll = fixture.newHook();
  await poll();
  assert.deepEqual(fixture.drafted, []);
  const error = fixture.logs.find(row => row.step === "inbox.draft_rung.error");
  assert.match(String(error?.error), /incomplete inbox draft history/);
  writeFileSync(archive, gzipSync(""));
  await poll();
  assert.deepEqual(fixture.drafted, [bare.id]);
});
