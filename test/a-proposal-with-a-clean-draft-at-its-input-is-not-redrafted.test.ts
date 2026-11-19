import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, cleanDraftInputKeys, commitInboxDraftOutcomes, draftAttemptKey, draftInputKey,
  draftsDueOnDaemon, inboxDraftExampleFragmentYaml, MAX_DRAFT_LINT_ATTEMPTS, runDraftRung, type DraftCache,
  type DraftLaneIdentity, type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
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

/** Seed a daemon root whose ledger holds `rows`, with an empty drafts cache, and run the production hook once. */
async function hookPoll(t: TestContext, proposals: Proposal[], rows: Row[]) {
  const root = ownedFixtureDir(t, "clean-draft-root").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeFileSync(join(root, "state", LEDGER_FILENAME), rows.map(row => JSON.stringify({ ts: "2026-11-19T00:00:00.000Z", ...row })).join("\n") + "\n");
  const drafted: string[] = [];
  const logs: Row[] = [];
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-13864", (step, extra = {}) => logs.push({ step, ...extra }), async (due) => {
    drafted.push(...due.map(p => p.id));
    return [];
  });
  await hook();
  return { drafted, logs };
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

test("W1-T13864 criterion 2: a proposal with a clean ledger draft at its input is not due when the cache lost it", async t => {
  const { drafted } = await hookPoll(t, [bare], [cleanRow(bare)]);
  assert.deepEqual(drafted, []);
  // Control: the same poll with no clean row drafts it.
  const control = await hookPoll(t, [bare], []);
  assert.deepEqual(control.drafted, [bare.id]);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, {}, 3, undefined, laneA).map(p => p.id), [proposal.id]);
});

test("W1-T13864 criterion 3: a lane change does not make a proposal with a clean draft at its input due", () => {
  const ctx = { isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set<string>(),
    draftLedgerRows: [cleanRow(proposal)] };
  const cached: DraftCache = { [proposal.id]: { proposalId: proposal.id, fragmentYaml: "- id: X\n", stampLine: "s",
    anchorFingerprint: "an older anchor set" } };
  // The attempt key names lane A; the daemon now runs lane B, which made old lanes due once.
  const attempts = { [proposal.id]: draftAttemptKey(proposal, laneA) };
  assert.deepEqual(draftsDueOnDaemon([proposal], cached, attempts, 3, ctx, laneB), []);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, ctx, laneB), []);
  assert.deepEqual(draftsDueOnDaemon([proposal], cached, attempts, 3, { ...ctx, draftLedgerRows: [] }, laneB).map(p => p.id), [proposal.id]);
});

test("W1-T13864 criterion 4: a proposal whose anchors changed or that got a new reframe round is still drafted", async t => {
  const moved: Proposal = { ...bare, evidenceAnchors: [{ pattern: "export function draftsDueOnDaemon", path: "src/lib/inbox.ts", description: "a live anchor" }] };
  const reframed: Proposal = { ...bare, reframeHistory: [{ feedback: "narrow it" }] };
  const { drafted } = await hookPoll(t, [moved, { ...reframed, id: "P13864-R" }], [cleanRow(bare), { ...cleanRow(bare), proposal_id: "P13864-R" }]);
  assert.deepEqual(drafted.sort(), [moved.id, "P13864-R"].sort());
  // A dirty newest row at the input is not a clean draft either.
  const keys = cleanDraftInputKeys([{ ...cleanRow(proposal), lint_clean: false }]);
  assert.equal(keys.has(proposal.id), false);
});

test("W1-T13864 criterion 5: a dirty attempt inside one run still redrafts up to MAX_DRAFT_LINT_ATTEMPTS", async () => {
  let spawns = 0;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => { spawns++; return worker(dirty); }, log: () => {},
  }, "relint");
  assert.equal(spawns, MAX_DRAFT_LINT_ATTEMPTS);
  assert.equal(outcome.ok, true);
});
