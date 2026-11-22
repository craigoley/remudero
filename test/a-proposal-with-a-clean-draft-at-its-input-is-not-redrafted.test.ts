import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { anchorFingerprint, captureInboxDraftSnapshot, cleanDraftInputKeys, commitInboxDraftOutcomes, draftAttemptKey, draftInputKey,
  draftsDueOnDaemon, inboxDraftExampleFragmentYaml, indexInboxDraftReceipts, MAX_DRAFT_LINT_ATTEMPTS, parseDraftAttemptCache, parseDraftCache,
  reframeProposal, runDraftRung, type DraftLaneIdentity, type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
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
  const newHook = (complete = false, owner = "o", repo = "r") => buildInboxDraftHook(owner, repo, { root } as Config, "RUN-13864", (step, extra = {}) => {
    const row = { step, ...extra };
    logs.push(row);
    append(row);
  }, async (due, _config, _owner, _repo, runId, log) => {
    drafted.push(...due.map(p => p.id));
    return complete ? runDraftRung(due, "- id: W1-T1\n", {
      causalScope: { repository: "o/r" }, spawn: async () => worker(clean), log,
    }, runId) : [];
  }, () => true, () => "fixture");
  return { root, stateDir, ledgerPath, setProposals, append, drafted, logs, newHook };
}

function corruptReceiptIndex(stateDir: string) {
  const dir = join(stateDir, "inbox-draft-receipts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "o%2Fr.json");
  writeFileSync(path, "{");
  return path;
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

test("manual force publishes its clean draft with a malformed daemon receipt index", async t => {
  const scope = { repository: "o/r" };
  const { stateDir, logs } = hookFixture(t, [bare], []);
  const indexPath = corruptReceiptIndex(stateDir);
  const attemptsPath = join(stateDir, "inbox-draft-attempts.json");
  const attempts = { [bare.id]: draftAttemptKey(bare, laneA) };
  writeFileSync(attemptsPath, JSON.stringify(attempts));
  const outcomes = await runDraftRung([bare], "- id: W1-T1\n", {
    causalScope: scope, spawn: async () => worker(clean), log: () => {},
  }, "manual");
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, ...extra });
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(bare, scope)], outcomes, log });
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [], outcomes: [], log });

  assert.deepEqual(logs.filter(row => row.step === "inbox.drafted").map(row => [row.proposal_id, row.draft_input_key, row.lint_clean]),
    [[bare.id, draftInputKey(bare), true]]);
  assert.deepEqual(logs.filter(row => row.step === "inbox.draft_history_partial").map(row => row.unread), [[indexPath]]);
  assert.equal(parseDraftCache(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"))[bare.id].completion?.lintClean, true);
  assert.deepEqual(parseDraftAttemptCache(readFileSync(attemptsPath, "utf8")), attempts);
  assert.equal(readFileSync(indexPath, "utf8"), "{");
});

test("the daemon uses readable ledger receipts when its receipt index is malformed", async t => {
  const fresh = { ...bare, id: "P-FRESH" };
  const fixture = hookFixture(t, [bare, fresh], [cleanRow(bare)]);
  const indexPath = corruptReceiptIndex(fixture.stateDir);
  await fixture.newHook()();
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [fresh.id, fresh.id]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_cache_missing").map(row => row.proposal_id), [bare.id]);
  assert.ok(fixture.logs.some(row => row.step === "inbox.draft_history_partial" && (row.unread as string[]).includes(indexPath)));
});

test("W1-T13864 criterion 6: a clean ledger receipt covers a null cached proposal while fresh work proceeds", async t => {
  const fresh = { ...bare, id: "P-FRESH" };
  const fixture = hookFixture(t, [bare, fresh], [cleanRow(bare)]);
  const snapshot = captureInboxDraftSnapshot(bare, { repository: "o/r" });
  writeFileSync(join(fixture.stateDir, "inbox-drafts.json"), JSON.stringify({
    [bare.id]: { proposalId: bare.id, fragmentYaml: inboxDraftExampleFragmentYaml(), stampLine: "STAMP: draft input",
      anchorFingerprint: anchorFingerprint(bare.evidenceAnchors),
      completion: { snapshot: { ...snapshot, proposal: null }, lintClean: true, violations: [] } },
  }));

  await fixture.newHook()();

  assert.deepEqual(fixture.drafted, [fresh.id]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_cache_missing")
    .map(row => [row.proposal_id, row.draft_input_key]), [[bare.id, draftInputKey(bare)]]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_rung.error"), []);
});

test("malformed completions leave a proposal due when there is no clean receipt", () => {
  const snapshot = captureInboxDraftSnapshot(proposal, { repository: "o/r" });
  const malformedInputs = [
    { ...proposal, id: "P-OTHER" },
    { ...proposal, evidenceAnchors: null },
    { ...proposal, evidenceAnchors: [null] },
    { ...proposal, evidenceAnchors: [{ ...anchors[0], path: ["README.md"] }] },
    { ...proposal, reframeHistory: { length: 0 } },
  ];
  const completions = malformedInputs.map(input => ({ snapshot: { ...snapshot, proposal: input }, lintClean: true, violations: [] }));
  for (const completion of [null, ...completions]) {
    const drafts = parseDraftCache(JSON.stringify({
      [proposal.id]: { proposalId: proposal.id, fragmentYaml: inboxDraftExampleFragmentYaml(), stampLine: "STAMP: draft input",
        anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors), completion },
    }));
    assert.deepEqual(draftsDueOnDaemon([proposal], drafts, {}, 3, undefined, laneB), [proposal]);
  }
});

test("W1-T13864 criterion 2: a transient live-ledger EIO does not hide a clean receipt after cache loss", async t => {
  const fresh = { ...bare, id: "P-FRESH" };
  const fixture = hookFixture(t, [bare, fresh], [cleanRow(bare)]);
  const readFileSyncBeforeMock = fs.readFileSync;
  let injected = false;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFileSync>) => {
    if (args[0] === fixture.ledgerPath && !injected) {
      injected = true;
      throw Object.assign(new Error("injected live ledger read failure"), { code: "EIO" });
    }
    return readFileSyncBeforeMock(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  await fixture.newHook()();
  assert.equal(injected, true);
  assert.deepEqual(fixture.drafted, [fresh.id]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_cache_missing").map(row => row.proposal_id), [bare.id]);
  assert.equal(fixture.logs.some(row => row.step === "inbox.draft_history_partial"), false);
});

test("the daemon selects fresh work when both live ledger reads fail", async t => {
  const archived = { ...bare, id: "P-ARCHIVED" };
  const fresh = { ...bare, id: "P-FRESH" };
  const fixture = hookFixture(t, [bare], []);
  await fixture.newHook(true)();
  assert.deepEqual(fixture.drafted.splice(0), [bare.id]);
  writeFileSync(join(fixture.stateDir, "inbox-drafts.json"), "{}");
  writeFileSync(join(fixture.stateDir, "ledger.2026-11-19T00-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(cleanRow(archived)) + "\n"));
  fixture.setProposals([bare, archived, fresh]);

  const readSync = fs.readFileSync;
  const readAsync = fs.promises.readFile;
  const unread = Object.assign(new Error("injected persistent ledger read failure"), { code: "EIO" });
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readSync>) => {
    if (args[0] === fixture.ledgerPath) throw unread;
    return readSync(...args);
  });
  t.mock.method(fs.promises, "readFile", async (...args: Parameters<typeof readAsync>) => {
    if (args[0] === fixture.ledgerPath) throw unread;
    return readAsync(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [fresh.id]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_history_partial").map(row => [row.unread, row.error]),
    [[[fixture.ledgerPath], String(unread)]]);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_cache_missing").map(row => row.proposal_id), [bare.id, archived.id]);
});

test("W1-T13864 criterion 4: new anchors and reframes draft once, and returning to an earlier clean input skips drafting", async t => {
  const moved: Proposal = { ...bare, evidenceAnchors: [{ pattern: "export function draftsDueOnDaemon", path: "src/lib/inbox.ts", description: "a live anchor" }] };
  const other = { ...bare, id: "P13864-R" };
  const reframed: Proposal = { ...other, reframeHistory: [{ feedback: "narrow it" }] };
  const fixture = hookFixture(t, [bare, other], [cleanRow(other)]);
  const poll = fixture.newHook();
  await poll();
  assert.deepEqual(fixture.drafted, [bare.id]);
  fixture.append(cleanRow(bare));

  fixture.setProposals([moved, reframed]);
  await poll();
  assert.deepEqual(fixture.drafted, [bare.id, moved.id, reframed.id]);
  fixture.append(cleanRow(moved));
  fixture.append(cleanRow(reframed));

  // Every clean input stays retired: going back to the earlier `bare` input after a restart does not draft it again.
  fixture.setProposals([bare, reframed]);
  const restartedPoll = fixture.newHook();
  await restartedPoll();
  assert.deepEqual(fixture.drafted, [bare.id, moved.id, reframed.id]);
  fixture.setProposals([moved, reframed]);
  await restartedPoll();
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [bare.id, moved.id, reframed.id]);
  // Each retired input's cache miss is logged once, however many polls and restarts see it.
  const misses = fixture.logs.filter(row => row.step === "inbox.draft_cache_missing" && row.proposal_id === bare.id);
  assert.deepEqual(misses.map(row => row.draft_input_key), [draftInputKey(bare), draftInputKey(moved)]);
});

test("W1-T13864 criterion 2: all clean inputs stay retired regardless of receipt order or drafting lane", () => {
  const moved: Proposal = { ...bare, evidenceAnchors: anchors };
  const dirtyInput: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  const rows: Row[] = [
    { ...cleanRow(bare), ts: "2026-11-20T00:00:00.000Z" },
    { ...cleanRow(moved), ts: "2026-11-20T00:00:01.000Z" },
    { ...cleanRow(bare), lint_clean: false, ts: "2026-11-20T00:00:02.000Z" },
    { ...cleanRow(dirtyInput), lint_clean: false, ts: "2026-11-20T00:00:03.000Z" },
  ];
  const ctx = { isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set<string>() };
  // The index may have found an older receipt after it had already recorded a newer one.
  for (const draftLedgerRows of [rows, [...rows].reverse()]) {
    assert.deepEqual(draftsDueOnDaemon([bare], {}, {}, 3, { ...ctx, draftLedgerRows }, laneB), []);
    assert.deepEqual(draftsDueOnDaemon([moved], {}, {}, 3, { ...ctx, draftLedgerRows }, laneB), []);
    assert.deepEqual(draftsDueOnDaemon([dirtyInput], {}, {}, 3, { ...ctx, draftLedgerRows }, laneB), [dirtyInput]);
    assert.deepEqual(cleanDraftInputKeys(draftLedgerRows), new Map([[bare.id, new Set([draftInputKey(bare), draftInputKey(moved)])]]));
  }
  // A row without a readable ts counts like any other clean row.
  assert.deepEqual(cleanDraftInputKeys([cleanRow(bare)]), new Map([[bare.id, new Set([draftInputKey(bare)])]]));
});

test("W1-T13864 criterion 2: a clean draft published before a reframe keeps its older input retired after the cache is lost", async t => {
  const scope = { repository: "o/r" };
  const stateDir = ownedFixtureDir(t, "clean-draft-reframed").dir;
  const ledgerPath = join(stateDir, LEDGER_FILENAME);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, ...extra });
  const publish = async (p: Proposal) => {
    writeFileSync(registryPath, JSON.stringify({ proposals: [p] }));
    const outcomes = await runDraftRung([p], "- id: W1-T1\n", { causalScope: scope, spawn: async () => worker(clean), log: () => {} }, "publish");
    commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(p, scope)], outcomes, lane: laneA, log });
  };
  await publish(bare);
  const drafts = parseDraftCache(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  // The reframe operation `rmd reframe` calls moves the proposal to its next input.
  const reframed = reframeProposal(bare, "narrow it", drafts, { ledgerPath, runId: "REFRAME-13864" }).proposal;
  await publish(reframed);
  const published = rows.filter(row => row.step === "inbox.drafted").map(row => [row.draft_input_key, row.lint_clean]);
  assert.deepEqual(published, [[draftInputKey(bare), true], [draftInputKey(reframed), true]]);
  assert.deepEqual([draftInputKey(bare), draftInputKey(reframed)].map(key => key.slice(-3)), ["::0", "::1"]);

  // The drafts cache is lost; the daemon reads its receipts through the receipt index.
  const draftLedgerRows = indexInboxDraftReceipts(stateDir, scope.repository, rows, log);
  const ctx = { isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set<string>(), draftLedgerRows };
  assert.deepEqual(draftsDueOnDaemon([bare], {}, {}, 3, ctx, laneB), [], "the older clean input ::0 stays retired");
  assert.deepEqual(draftsDueOnDaemon([reframed], {}, {}, 3, ctx, laneB), [], "the newer clean input ::1 is retired");
  assert.deepEqual(cleanDraftInputKeys(draftLedgerRows), new Map([[bare.id, new Set([draftInputKey(bare), draftInputKey(reframed)])]]));
});

test("W1-T13864 criterion 2: after a clock rollback the current input's earlier-stamped clean receipt still retires it once its cache is lost", async t => {
  const reframed: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  // The host clock went back between the two drafts: the current input ::1 was receipted with the EARLIER ts.
  const fixture = hookFixture(t, [reframed], [
    { ...cleanRow(bare), ts: "2026-11-20T12:00:00.000Z" },
    { ...cleanRow(reframed), ts: "2026-11-20T11:00:00.000Z" },
  ]);
  await fixture.newHook()();
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, []);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_cache_missing").map(row => row.draft_input_key),
    [draftInputKey(reframed)]);
});

test("W1-T13864 criterion 4: a proposal retired and recreated at reframe count 0 after clean drafts at 0 and 1 is not drafted, while a new round still drafts", async t => {
  const reframed: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  const fixture = hookFixture(t, [bare], [
    { ...cleanRow(bare), ts: "2026-11-20T11:00:00.000Z" },
    { ...cleanRow(reframed), ts: "2026-11-20T12:00:00.000Z" },
  ]);
  // Reconciliation retired the unratified proposal and recreated its stable id at the same anchors and count 0.
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, []);
  assert.equal(draftInputKey(bare).slice(-3), "::0");
  // A new reframe round and a new anchor set are new inputs, and each still drafts.
  const twice: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }, { feedback: "narrower" }] };
  fixture.setProposals([twice]);
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [twice.id]);
  fixture.setProposals([{ ...bare, evidenceAnchors: anchors }]);
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [twice.id, bare.id]);
});

test("W1-T13864 criterion 3: a legacy clean draft for an already reframed proposal survives both lane changes", () => {
  const reframed: Proposal = { ...proposal, reframeHistory: [{ feedback: "narrow it" }] };
  const legacy = { [reframed.id]: { proposalId: reframed.id, fragmentYaml: inboxDraftExampleFragmentYaml(),
    stampLine: "STAMP: draft input", anchorFingerprint: anchorFingerprint(reframed.evidenceAnchors) } };
  for (const lane of [{ ...laneA, leadDeployment: laneB.leadDeployment }, { ...laneA, effort: laneB.effort }]) {
    assert.deepEqual(draftsDueOnDaemon([reframed], legacy, {}, 3, undefined, lane), []);
  }
});

test("W1-T13864 criterion 4: a subsequent operator reframe invalidates a legacy draft", t => {
  const reframed: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  const legacy = { [bare.id]: { proposalId: bare.id, fragmentYaml: inboxDraftExampleFragmentYaml(), stampLine: "STAMP", anchorFingerprint: "" } };
  const { ledgerPath } = hookFixture(t, [reframed], []);
  const next = reframeProposal(reframed, "share the proof", legacy, { ledgerPath, runId: "REFRAME-13864" });
  assert.deepEqual(draftsDueOnDaemon([next.proposal], next.drafts, {}, 3, undefined, laneB), [next.proposal]);
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
  const drafts = { [proposal.id]: outcome.candidate };
  assert.deepEqual(draftsDueOnDaemon([proposal], drafts, attempts, 3, undefined, laneA), []);
  assert.deepEqual(draftsDueOnDaemon([proposal], drafts, attempts, 3, undefined, laneB), [proposal]);
});

test("W1-T13864 criterion 4: a corrupt archive and invalid attempt values leave unseen inputs due after restart", async t => {
  const archived = { ...bare, id: "P-ARCHIVED" };
  const fresh = { ...bare, id: "P-FRESH" };
  const changed = { ...archived, reframeHistory: [{ feedback: "draft the new input" }] };
  const fixture = hookFixture(t, [bare], []);
  await fixture.newHook(true)();
  assert.deepEqual(fixture.drafted.splice(0), [bare.id]);
  assert.equal(fixture.logs.find(row => row.step === "inbox.drafted")?.lint_clean, true);

  const brokenArchive = join(fixture.stateDir, "ledger.2026-11-19T00-00-00-000Z.ndjson.gz");
  const compressed = gzipSync(readFileSync(fixture.ledgerPath));
  writeFileSync(brokenArchive, compressed.subarray(0, -8));
  writeFileSync(fixture.ledgerPath, "");
  const readableArchive = join(fixture.stateDir, "ledger.2026-11-20T00-00-00-000Z.ndjson.gz");
  writeFileSync(readableArchive, gzipSync(JSON.stringify(cleanRow(archived)) + "\n"));
  writeFileSync(join(fixture.stateDir, "inbox-drafts.json"), "{}");
  writeFileSync(join(fixture.stateDir, "inbox-draft-attempts.json"), JSON.stringify({ [bare.id]: null, [fresh.id]: 42 }));
  writeFileSync(join(fixture.stateDir, "inbox-reopened-keys.json"), JSON.stringify({ [bare.id]: "seen", [fresh.id]: "seen" }));
  fixture.setProposals([bare, archived, fresh]);

  await fixture.newHook()();
  assert.deepEqual(fixture.drafted.splice(0), [fresh.id], "keep the indexed and readable archived receipts");
  fixture.setProposals([bare, changed]);
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [changed.id], "the prior receipt leaves the new reframe due");
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_rung.error"), []);
  assert.deepEqual(fixture.logs.filter(row => row.step === "inbox.draft_history_partial").map(row => row.unread),
    [[brokenArchive], [brokenArchive]]);
  const misses = fixture.logs.filter(row => row.step === "inbox.draft_cache_missing");
  assert.deepEqual(misses.map(row => row.proposal_id).sort(), [archived.id, bare.id].sort());
});

test("W1-T13864 criterion 4: malformed attempt entries do not prevent unrelated drafting", async t => {
  const fresh = { ...bare, id: "P-FRESH" };
  const fixture = hookFixture(t, [bare, fresh], [cleanRow(bare)]);
  writeFileSync(join(fixture.stateDir, "inbox-draft-attempts.json"), JSON.stringify({ [bare.id]: null, [fresh.id]: 42 }));
  writeFileSync(join(fixture.stateDir, "inbox-reopened-keys.json"), JSON.stringify({ [bare.id]: "seen", [fresh.id]: "seen" }));
  await fixture.newHook()();
  assert.deepEqual(fixture.drafted, [fresh.id]);
});

test("W1-T13864 criterion 2: a clean receipt logged under Owner/target still retires the draft after a restart as owner/target", async t => {
  const fixture = hookFixture(t, [bare], [{ ...cleanRow(bare), repository: "Owner/target" }]);
  const misses = () => fixture.logs.filter(row => row.step === "inbox.draft_cache_missing");
  // The ledger row names the repository as the earlier daemon's --repo spelled it.
  await fixture.newHook(false, "owner", "target")();
  assert.deepEqual(fixture.drafted, [], "the ledger receipt is read whatever the owner's casing");
  assert.deepEqual(misses().map(row => [row.proposal_id, row.repository]), [[bare.id, "owner/target"]]);

  // Only the receipt index remains: the ledger and its archives are gone.
  for (const name of fs.readdirSync(fixture.stateDir)) if (name.startsWith("ledger")) fs.rmSync(join(fixture.stateDir, name), { force: true });
  await fixture.newHook(false, "Owner", "Target")();
  assert.deepEqual(fixture.drafted, [], "the receipt index is found whatever the owner's casing");
  assert.equal(misses().length, 1, "the cache miss is reported once across the casings");
  assert.deepEqual(fs.readdirSync(join(fixture.stateDir, "inbox-draft-receipts")), ["owner%2Ftarget.json"]);

  // Positive control: another repository's receipt does not retire this one's draft.
  const other = hookFixture(t, [bare], [{ ...cleanRow(bare), repository: "owner/other" }]);
  await other.newHook(false, "owner", "target")();
  assert.deepEqual(other.drafted, [bare.id]);
});
