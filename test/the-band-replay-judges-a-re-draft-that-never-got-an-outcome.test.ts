/**
 * test/the-band-replay-judges-a-re-draft-that-never-got-an-outcome.test.ts — W1-T9324.
 *
 * OBSERVED 2026-10-13 on the core host: 14 band replay proposals sat ~22 h with `invalidatedAt`, a cached re-draft and
 * NO outcome. `replayPass` re-linted only entries that carried an outcome, so 10 whose re-draft today's lint calls
 * dirty never moved and nothing escalated them; and the fleet lane held 4 clean re-drafts for a day on a `file`
 * decision made about the draft the replay had dropped.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { fleetLaneStorePath, readClassificationSnapshot, triageFleetLane, writeClassificationSnapshot } from "#src/lib/fleet-lane.js";
import type { DraftLintViolation } from "#src/lib/inbox.js";
import {
  BAND_MEANING_REPLAY_STORE,
  replayBandMeaningRefusals,
  type BandMeaningReplayEntry,
  type BandMeaningReplayInput,
  type BandMeaningReplayStore,
  type ReplayStranded,
} from "#src/lib/inbox-replay.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SEED = "2026-10-13T00:10:45.000Z";
const SEED_MS = Date.parse(SEED);
const BEFORE = "2026-10-01T10:00:00.000Z";
const at = (minutes: number) => new Date(SEED_MS + minutes * 60_000).toISOString();

const DIRTY_NEW = "proof-debt:W1-T9301";
const DIRTY_SAME = "proof-debt:W1-T9302";
const CLEAN = "proof-debt:W1-T9303";

const callSite = (message: string): DraftLintViolation => ({ check: "call-site", severity: "block", message });

type Row = Record<string, unknown>;

interface Fixture {
  stateDir: string;
  ledgerPath: string;
  rows: () => Row[];
  store: () => BandMeaningReplayStore;
  drafts: () => Record<string, unknown>;
  attempts: () => Record<string, unknown>;
  lintFor: Map<string, DraftLintViolation[]>;
  pass: (minutes: number, extra?: Partial<BandMeaningReplayInput>) => ReturnType<typeof replayBandMeaningRefusals>;
}

/** A replay store as the live one stood: entries re-offered at the seed, each with a cached re-draft and no outcome. */
function fixture(proposals: Record<string, BandMeaningReplayEntry>): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9324-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const ids = Object.keys(proposals);
  const seedRows = ids.map((id) => ({ ts: BEFORE, task_id: id, step: "approve.error", error: `rmd approve: refusing to file ${id} — [sizing] risk:high with no band_meaning declared` }));
  writeFileSync(ledgerPath, seedRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const store: BandMeaningReplayStore = { seededAt: SEED, refiledRule: "ratify.approved", proposals };
  writeFileSync(join(stateDir, BAND_MEANING_REPLAY_STORE), JSON.stringify(store, null, 2));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: ids.map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  const drafts = Object.fromEntries(ids.map((id) => [id, { proposalId: id, fragmentYaml: "[]", stampLine: "Ratified: NEW-1 raised to risk:high with band_meaning: span", anchorFingerprint: "" }]));
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(drafts));
  writeFileSync(join(stateDir, "inbox-draft-attempts.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id, `${id}::0`]))));
  writeClassificationSnapshot(stateDir, ids.map((proposalId) => ({ proposalId, state: "not_ready" })));
  const json = (name: string) => JSON.parse(readFileSync(join(stateDir, name), "utf8")) as Record<string, unknown>;
  const lintFor = new Map<string, DraftLintViolation[]>();
  return {
    stateDir,
    ledgerPath,
    lintFor,
    rows: () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row),
    store: () => json(BAND_MEANING_REPLAY_STORE) as unknown as BandMeaningReplayStore,
    drafts: () => json("inbox-drafts.json"),
    attempts: () => json("inbox-draft-attempts.json"),
    pass: (minutes, extra = {}) => replayBandMeaningRefusals({
      stateDir,
      ledgerPath,
      clock: fixedClock(SEED_MS + minutes * 60_000),
      classificationStates: () => readClassificationSnapshot(stateDir)?.states,
      lint: (_fragment, id) => lintFor.get(id) ?? [],
      guidance: (violations) => violations.map((v) => v.message),
      ...extra,
    }),
  };
}

const replayed = (f: Fixture, id: string) => f.rows().filter((r) => r.step === "inbox.replayed" && r.proposal_id === id);
const escalatedRows = (f: Fixture, id: string) => f.rows().filter((r) => r.step === "inbox.replay_escalated" && r.proposal_id === id);

test("W1-T9324: a no-outcome re-draft that lints dirty on a new judgement is re-drafted once", () => {
  const f = fixture({ [DIRTY_NEW]: { family: "proof-debt", invalidatedAt: SEED } });
  f.lintFor.set(DIRTY_NEW, [callSite("NEW-1 names a function with no call site")]);
  const first = f.pass(540);
  assert.deepEqual(first.reoffered, [{ proposalId: DIRTY_NEW, reason: "violations changed" }]);
  assert.deepEqual(first.invalidated, [DIRTY_NEW]);
  assert.equal(f.drafts()[DIRTY_NEW], undefined, "the dirty draft is dropped so the rung re-drafts it");
  assert.equal(f.attempts()[DIRTY_NEW], undefined, "and its attempt key");
  const entry = f.store().proposals[DIRTY_NEW];
  assert.deepEqual(entry.offered?.checks, ["call-site"], "the judgement it was re-offered on is stored");
  assert.equal(entry.reofferedAt, at(540));
  assert.equal(entry.invalidatedAt, at(540));
  const rows = replayed(f, DIRTY_NEW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "reoffered");
  assert.equal(rows[0].reason, "violations changed");

  // No draft is cached any more: the re-draft is due, so later passes wait and write nothing.
  for (const minute of [541, 542]) {
    const quiet = f.pass(minute);
    assert.deepEqual(quiet.reoffered, []);
    assert.deepEqual(quiet.recorded, []);
  }
  assert.equal(replayed(f, DIRTY_NEW).length, 1, "re-drafted once");
});

test("W1-T9324: a no-outcome re-draft dirty on its offered judgement escalates once", () => {
  const delivered: ReplayStranded[] = [];
  const escalate = (s: ReplayStranded) => void delivered.push(s);
  const stuck = [callSite("NEW-1 names a function with no call site")];
  const f = fixture({ [DIRTY_SAME]: { family: "proof-debt", invalidatedAt: SEED } });
  f.lintFor.set(DIRTY_SAME, stuck);
  // The first judgement is a new one; the re-draft the rung then writes comes back with the same violations.
  f.pass(540, { escalate });
  assert.equal(delivered.length, 0, "a re-offer is not an escalation");
  writeFileSync(join(f.stateDir, "inbox-drafts.json"), JSON.stringify({
    [DIRTY_SAME]: { proposalId: DIRTY_SAME, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" },
  }));

  const pass = f.pass(570, { escalate });
  assert.deepEqual(pass.recorded, [{ proposalId: DIRTY_SAME, outcome: "redraft_not_ready" }]);
  assert.deepEqual(pass.escalated, [DIRTY_SAME]);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].violations, { "call-site": ["NEW-1 names a function with no call site"] });
  assert.equal(delivered[0].sameAsOffered, true);
  const outcome = f.store().proposals[DIRTY_SAME].outcome;
  assert.equal(outcome?.outcome, "redraft_not_ready");
  assert.deepEqual(outcome?.unresolved_violations, ["NEW-1 names a function with no call site"]);
  assert.deepEqual(outcome?.judged?.checks, ["call-site"]);

  for (const minute of [571, 572, 573]) assert.deepEqual(f.pass(minute, { escalate }).escalated, []);
  assert.equal(delivered.length, 1, "delivered once per proposal per violation set");
  assert.equal(replayed(f, DIRTY_SAME).filter((r) => r.outcome === "redraft_not_ready").length, 1);
  assert.ok(f.drafts()[DIRTY_SAME], "and never re-drafted while nothing changed");

  // ABSENT THE DEP, THE ROW IS STILL WRITTEN — once.
  const bare = fixture({ [DIRTY_SAME]: { family: "proof-debt", invalidatedAt: SEED, offered: { checks: ["call-site"], guidance: "" } } });
  bare.lintFor.set(DIRTY_SAME, stuck);
  const probe = bare.pass(540);
  assert.equal(probe.reoffered?.[0]?.reason, "guidance changed", "an equal check set with another guidance is a change");
});

test("W1-T9324: a no-outcome re-draft that lints clean is left to the fleet lane", () => {
  const f = fixture({ [CLEAN]: { family: "proof-debt", invalidatedAt: SEED } });
  const pass = f.pass(540);
  assert.deepEqual(pass.reoffered, []);
  assert.deepEqual(pass.recorded, []);
  assert.deepEqual(pass.invalidated, []);
  assert.deepEqual(pass.escalated, []);
  assert.ok(f.drafts()[CLEAN], "a clean draft is kept for the lane to file");
  assert.ok(f.attempts()[CLEAN]);
  assert.equal(f.store().proposals[CLEAN].outcome, undefined);
  assert.equal(replayed(f, CLEAN).length, 0);
  assert.equal(escalatedRows(f, CLEAN).length, 0);

  // No cached draft at all: the re-draft is still due, so it waits as it did.
  const none = fixture({ [CLEAN]: { family: "proof-debt", invalidatedAt: SEED } });
  writeFileSync(join(none.stateDir, "inbox-drafts.json"), "{}");
  none.lintFor.set(CLEAN, [callSite("never read: there is no draft")]);
  assert.deepEqual(none.pass(540).reoffered, []);
  assert.equal(replayed(none, CLEAN).length, 0);
});

test("W1-T9324: a re-offer releases the fleet lane hold from the draft it replaced", () => {
  const OLDER = "followup:W1-T9311:research";
  const NEWER = "followup:W1-T9312:research";
  const f = fixture({
    // A store entry the replay finished with: only its re-offer time matters to the lane.
    [OLDER]: { family: "followup", invalidatedAt: at(0), reofferedAt: at(600), outcome: { outcome: "skipped_superseded", at: at(1) } },
    [NEWER]: { family: "followup", invalidatedAt: at(0), reofferedAt: at(600), outcome: { outcome: "skipped_superseded", at: at(1) } },
  });
  writeClassificationSnapshot(f.stateDir, [OLDER, NEWER].map((proposalId) => ({ proposalId, state: "ready" })));
  // OLDER was decided on the draft the replay dropped (before the re-offer); NEWER was decided after it.
  writeFileSync(fleetLaneStorePath(f.stateDir), JSON.stringify({
    [OLDER]: { decision: "file", ts: at(540) },
    [NEWER]: { decision: "file", ts: at(620) },
  }));
  const approved: string[] = [];
  const lane = triageFleetLane({
    stateDir: f.stateDir, ledgerPath: f.ledgerPath, mergedLastDay: () => 10, approve: (id) => void approved.push(id),
    clock: fixedClock(SEED_MS + 640 * 60_000),
  });
  assert.deepEqual(lane.filed, [OLDER], "the older decision no longer holds; the newer one still does");
  assert.deepEqual(approved, [OLDER]);

  // A proposal outside the replay store is held by its decision exactly as before.
  const outside = "followup:W1-T9313:research";
  const g = fixture({ [OLDER]: { family: "followup", invalidatedAt: at(0), reofferedAt: at(600), outcome: { outcome: "skipped_superseded", at: at(1) } } });
  writeFileSync(join(g.stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [OLDER, outside].map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  writeFileSync(join(g.stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries([OLDER, outside].map((id) => [id, { proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" }]))));
  writeClassificationSnapshot(g.stateDir, [OLDER, outside].map((proposalId) => ({ proposalId, state: "ready" })));
  writeFileSync(fleetLaneStorePath(g.stateDir), JSON.stringify({ [outside]: { decision: "file", ts: at(540) } }));
  const held = triageFleetLane({
    stateDir: g.stateDir, ledgerPath: g.ledgerPath, mergedLastDay: () => 10, approve: () => undefined,
    clock: fixedClock(SEED_MS + 640 * 60_000),
  });
  assert.deepEqual(held.filed, [OLDER]);
});

test("W1-T9324: an unreadable replay store releases nothing — the lane holds the decision as before", () => {
  const ID = "followup:W1-T9314:research";
  const f = fixture({ [ID]: { family: "followup", invalidatedAt: at(0), reofferedAt: at(600), outcome: { outcome: "skipped_superseded", at: at(1) } } });
  writeClassificationSnapshot(f.stateDir, [{ proposalId: ID, state: "ready" }]);
  writeFileSync(fleetLaneStorePath(f.stateDir), JSON.stringify({ [ID]: { decision: "file", ts: at(540) } }));
  // Not JSON: reading the replay store throws, so no re-offer time is known for the proposal.
  writeFileSync(join(f.stateDir, BAND_MEANING_REPLAY_STORE), "{ not json");
  const approved: string[] = [];
  const lane = triageFleetLane({
    stateDir: f.stateDir, ledgerPath: f.ledgerPath, mergedLastDay: () => 10, approve: (id) => void approved.push(id),
    clock: fixedClock(SEED_MS + 640 * 60_000),
  });
  assert.deepEqual(lane.filed, [], "the day-old-in-minutes file decision still holds without a readable re-offer time");
  assert.deepEqual(approved, []);
});
