/**
 * test/the-band-replay-re-offers-what-a-lint-change-clears.test.ts — W1-T9041.
 *
 * OBSERVED 2026-10-13 on the core host: the W1-T8714 band replay recorded a proposal `refiled` on
 * `approve.shards_written`, which the push preflight refused a minute later, and stored `redraft_not_ready` as final,
 * so the 6 of 12 not-ready drafts W1-T8828's composed stamp cleared were never offered again and nothing escalated
 * the other 6. Here `refiled` waits for the plan PR's `ratify.approved` receipt, only refiled and skipped_superseded
 * are final, and each pass re-lints an open entry's cached draft with no model call.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { escalateReplayStranded } from "#src/lib/escalation-catalogue.js";
import { readClassificationSnapshot, triageFleetLane, writeClassificationSnapshot } from "#src/lib/fleet-lane.js";
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

const PUSH_REFUSED = "followup:DAEMON-1790206008025:2026-09-24T00:25:49.881Z:0";
const OPENED = "followup:W1-T9101:opened";
const STAMP_ONLY = "flight-signals:burnRatePredicate";
const SIZING = "proof-debt:W1-T4464";
const SAME = "verify-human-automate:W1-T216";
const SUPERSEDED = "proof-debt:W1-T9102";

const STAMP_MESSAGE = 'the STAMP line must open with "- x (": it names the proposal being ratified';
const sizing = (message: string): DraftLintViolation => ({ check: "sizing", severity: "block", message });
const scope = (message: string): DraftLintViolation => ({ check: "proof-scope", severity: "block", message });

type Row = Record<string, unknown>;

interface Fixture {
  stateDir: string;
  ledgerPath: string;
  rows: () => Row[];
  append: (...rows: Row[]) => void;
  store: () => BandMeaningReplayStore;
  drafts: () => Record<string, unknown>;
  attempts: () => Record<string, unknown>;
  cacheDraft: (id: string, fragmentYaml?: string) => void;
  pass: (minutes: number, extra?: Partial<BandMeaningReplayInput>) => ReturnType<typeof replayBandMeaningRefusals>;
  lintFor: Map<string, DraftLintViolation[]>;
  linted: Array<{ id: string; stampLine: string }>;
}

/** A replay store as the live one stood after its seed, with the drafts the draft rung cached for each. */
function fixture(proposals: Record<string, BandMeaningReplayEntry>, opts: { rule?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9041-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const ids = Object.keys(proposals);
  const seedRows = ids.map((id) => ({ ts: BEFORE, task_id: id, step: "approve.error", error: `rmd approve: refusing to file ${id} — [sizing] risk:high with no band_meaning declared` }));
  writeFileSync(ledgerPath, seedRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const store: BandMeaningReplayStore = { seededAt: SEED, proposals, ...(opts.rule === false ? {} : { refiledRule: "ratify.approved" as const }) };
  writeFileSync(join(stateDir, BAND_MEANING_REPLAY_STORE), JSON.stringify(store, null, 2));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: ids.map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  writeFileSync(join(stateDir, "inbox-drafts.json"), "{}");
  writeFileSync(join(stateDir, "inbox-draft-attempts.json"), "{}");
  writeClassificationSnapshot(stateDir, ids.map((proposalId) => ({ proposalId, state: proposalId === SUPERSEDED ? "retired" : "not_ready" })));
  const json = (name: string) => JSON.parse(readFileSync(join(stateDir, name), "utf8")) as Record<string, unknown>;
  const lintFor = new Map<string, DraftLintViolation[]>();
  const linted: Fixture["linted"] = [];
  return {
    stateDir,
    ledgerPath,
    lintFor,
    linted,
    rows: () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row),
    append: (...rows) => writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8") + rows.map((r) => JSON.stringify(r) + "\n").join("")),
    store: () => json(BAND_MEANING_REPLAY_STORE) as unknown as BandMeaningReplayStore,
    drafts: () => json("inbox-drafts.json"),
    attempts: () => json("inbox-draft-attempts.json"),
    cacheDraft: (id, fragmentYaml = "[]") => {
      const drafts = json("inbox-drafts.json");
      drafts[id] = { proposalId: id, fragmentYaml, stampLine: "Ratified: NEW-1 raised to risk:high with band_meaning: span", anchorFingerprint: "" };
      writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(drafts));
      const attempts = json("inbox-draft-attempts.json");
      attempts[id] = `${id}::0`;
      writeFileSync(join(stateDir, "inbox-draft-attempts.json"), JSON.stringify(attempts));
    },
    pass: (minutes, extra = {}) => replayBandMeaningRefusals({
      stateDir,
      ledgerPath,
      clock: fixedClock(SEED_MS + minutes * 60_000),
      classificationStates: () => readClassificationSnapshot(stateDir)?.states,
      lint: (_fragment, id, stampLine) => {
        linted.push({ id, stampLine });
        return lintFor.get(id) ?? [];
      },
      ...extra,
    }),
  };
}

const replayed = (f: Fixture, id: string) => f.rows().filter((r) => r.step === "inbox.replayed" && r.proposal_id === id);
const escalatedRows = (f: Fixture, id: string) => f.rows().filter((r) => r.step === "inbox.replay_escalated" && r.proposal_id === id);
const notReady = (unresolved: string[]): BandMeaningReplayEntry => ({
  family: "x", invalidatedAt: SEED, outcome: { outcome: "redraft_not_ready", at: at(30), unresolved_violations: unresolved },
});

test("W1-T9041: a replayed proposal is refiled only when its plan PR opened", () => {
  const f = fixture({ [OPENED]: { family: "followup", invalidatedAt: SEED } });
  f.append({ ts: at(60), task_id: OPENED, step: "approve.shards_written", proposal_id: OPENED, paths: ["plan/tasks.d/W1-T9200-x.yaml"] });
  const first = f.pass(61);
  assert.deepEqual(first.recorded, [], "shards written are not a filing");
  assert.equal(f.store().proposals[OPENED].outcome, undefined);
  assert.equal(replayed(f, OPENED).length, 0);

  f.append({ ts: at(62), task_id: OPENED, step: "ratify.approved", pr_url: "https://github.com/o/r/pull/11400", pr_number: 11400, branch: "plan-ratify-x" });
  const second = f.pass(63);
  assert.deepEqual(second.recorded, [{ proposalId: OPENED, outcome: "refiled" }]);
  const rows = replayed(f, OPENED);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "refiled");
  assert.equal(second.complete, true, "a refiled proposal is final");

  // MIGRATION: an entry stored refiled under the old rule is re-judged once, by the receipt rule.
  const migrated = fixture({
    [PUSH_REFUSED]: { family: "followup", invalidatedAt: SEED, outcome: { outcome: "refiled", at: at(339) } },
    [OPENED]: { family: "followup", invalidatedAt: SEED, outcome: { outcome: "refiled", at: at(339) } },
  }, { rule: false });
  migrated.append(
    { ts: at(338), task_id: PUSH_REFUSED, step: "approve.shards_written", proposal_id: PUSH_REFUSED, paths: [] },
    { ts: at(339), task_id: PUSH_REFUSED, step: "approve.error", error: "plan-PR preflight refused the approve push" },
    { ts: at(338), task_id: OPENED, step: "approve.shards_written", proposal_id: OPENED, paths: [] },
    { ts: at(340), task_id: OPENED, step: "ratify.approved", pr_url: "https://github.com/o/r/pull/11401" },
  );
  const rejudged = migrated.pass(400);
  assert.deepEqual(rejudged.recorded, [{ proposalId: PUSH_REFUSED, outcome: "refused" }]);
  assert.equal(migrated.store().proposals[PUSH_REFUSED].outcome?.outcome, "refused");
  assert.equal(migrated.store().proposals[OPENED].outcome?.outcome, "refiled", "a refiled entry with its receipt stands");
  assert.equal(migrated.store().refiledRule, "ratify.approved");
  const rows2 = replayed(migrated, PUSH_REFUSED);
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].rejudged_from, "refiled");
  assert.equal(replayed(migrated, OPENED).length, 0, "a receipted refiled entry writes no second row");
  migrated.pass(401);
  assert.equal(replayed(migrated, PUSH_REFUSED).length, 1, "the re-judgement happens once");
});

test("W1-T9041: a push refused after its shards were written is not refiled", () => {
  const f = fixture({ [PUSH_REFUSED]: { family: "followup", invalidatedAt: SEED } });
  f.append(
    { ts: at(338), task_id: PUSH_REFUSED, step: "approve.shards_written", proposal_id: PUSH_REFUSED, paths: ["plan/tasks.d/W1-T9201-x.yaml"] },
    { ts: at(339), task_id: PUSH_REFUSED, step: "approve.error", error: "plan-PR preflight refused the approve push: lint-plan" },
  );
  const pass = f.pass(340);
  assert.deepEqual(pass.recorded, [{ proposalId: PUSH_REFUSED, outcome: "refused" }]);
  const rows = replayed(f, PUSH_REFUSED);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "refused");
  assert.match(String(rows[0].reason), /preflight refused the approve push/);
  assert.equal(pass.complete, false, "a refused proposal is still open");

  // A refused proposal whose cached draft lints clean is not re-offered: no lint change explains its refusal. Its
  // judgement is recorded once, so a later lint that dirties it is a change.
  const clean = fixture({ [PUSH_REFUSED]: { family: "followup", invalidatedAt: SEED, outcome: { outcome: "refused", at: at(339), reason: "push refused" } } });
  clean.cacheDraft(PUSH_REFUSED);
  assert.deepEqual(clean.pass(400).reoffered, []);
  assert.deepEqual(clean.store().proposals[PUSH_REFUSED].outcome?.judged?.checks, []);
  assert.deepEqual(clean.pass(401).reoffered, []);
  clean.lintFor.set(PUSH_REFUSED, [sizing("NEW-1 spans three subsystems")]);
  assert.deepEqual(clean.pass(402).reoffered, [{ proposalId: PUSH_REFUSED, reason: "violations changed" }]);
});

test("W1-T9041: a not-ready draft a lint change cleared is re-offered", () => {
  const f = fixture({ [STAMP_ONLY]: notReady([STAMP_MESSAGE]) });
  f.cacheDraft(STAMP_ONLY);
  const pass = f.pass(540);
  assert.deepEqual(pass.reoffered, [{ proposalId: STAMP_ONLY, reason: "cleared by a lint change" }]);
  const rows = replayed(f, STAMP_ONLY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "reoffered");
  assert.equal(rows[0].reason, "cleared by a lint change");
  const entry = f.store().proposals[STAMP_ONLY];
  assert.equal(entry.outcome, undefined, "the stored outcome is cleared");
  assert.equal(entry.reofferedAt, at(540));
  assert.ok(f.drafts()[STAMP_ONLY], "a clean draft is kept for the fleet lane to file");
  assert.ok(f.attempts()[STAMP_ONLY]);
  assert.equal(f.linted[0].id, STAMP_ONLY);
  assert.ok(f.linted[0].stampLine.startsWith(`- ${STAMP_ONLY} (`), `the lint sees the composed stamp: ${f.linted[0].stampLine}`);
  assert.equal(pass.complete, false);

  // An old not-ready row from before the re-offer answers nothing; the next pass writes no second row.
  f.append({ ts: at(30), task_id: STAMP_ONLY, step: "inbox.drafted", proposal_id: STAMP_ONLY, lint_clean: false, unresolved_violations: [STAMP_MESSAGE] });
  f.pass(541);
  assert.equal(replayed(f, STAMP_ONLY).length, 1);
  assert.equal(f.store().proposals[STAMP_ONLY].outcome, undefined);

  // A cached draft that does not parse is linted, never crashes the pass, and its parse failure is a violation set.
  const broken = fixture({ [STAMP_ONLY]: notReady([STAMP_MESSAGE]) });
  broken.cacheDraft(STAMP_ONLY, "- id: [unclosed");
  const real = broken.pass(540, { lint: undefined });
  assert.equal(real.deferred, undefined);
  assert.deepEqual(real.reoffered, [{ proposalId: STAMP_ONLY, reason: "violations changed" }], "the real lint reads the parse failure");
});

test("W1-T9041: a not-ready draft whose violations changed is re-drafted once", () => {
  let guidanceVersion = "g1";
  const guidance = (violations: ReadonlyArray<DraftLintViolation>) => [guidanceVersion, ...violations.map((v) => v.message)];
  const f = fixture({ [SIZING]: notReady(["[sizing] the old sizing message"]) });
  f.cacheDraft(SIZING);
  f.lintFor.set(SIZING, [sizing("NEW-1 spans three subsystems")]);
  const first = f.pass(540, { guidance });
  assert.deepEqual(first.reoffered, [{ proposalId: SIZING, reason: "violations changed" }]);
  assert.deepEqual(first.invalidated, [SIZING]);
  assert.equal(f.drafts()[SIZING], undefined, "the draft is dropped so the rung re-drafts it");
  assert.equal(f.attempts()[SIZING], undefined, "and its attempt key");
  assert.equal(f.store().proposals[SIZING].outcome, undefined);

  // The rung re-drafts it under today's guidance; it comes back dirty on another check.
  f.cacheDraft(SIZING);
  f.lintFor.set(SIZING, [scope("NEW-1 proof reads a file outside files:")]);
  f.append({ ts: at(560), task_id: SIZING, step: "inbox.drafted", proposal_id: SIZING, lint_clean: false, unresolved_violations: ["NEW-1 proof reads a file outside files:"] });
  const second = f.pass(570, { guidance });
  assert.deepEqual(second.recorded, [{ proposalId: SIZING, outcome: "redraft_not_ready" }]);

  // Unchanged lint and guidance: no pass re-drafts it again.
  for (const minute of [571, 572, 573]) {
    const quiet = f.pass(minute, { guidance });
    assert.deepEqual(quiet.reoffered, []);
    assert.deepEqual(quiet.invalidated, []);
  }
  assert.ok(f.drafts()[SIZING], "an unchanged draft is never dropped again");
  assert.equal(replayed(f, SIZING).filter((r) => r.outcome === "reoffered").length, 1, "re-drafted once");

  // The guidance it was judged on changes: re-drafted once more, and only once.
  guidanceVersion = "g2";
  const changed = f.pass(600, { guidance });
  assert.deepEqual(changed.reoffered, [{ proposalId: SIZING, reason: "guidance changed" }]);
  assert.equal(f.drafts()[SIZING], undefined);
  f.pass(601, { guidance });
  assert.equal(replayed(f, SIZING).filter((r) => r.outcome === "reoffered").length, 2);
});

test("W1-T9041: an unchanged not-ready draft escalates once by name", () => {
  const delivered: ReplayStranded[] = [];
  const escalate = (s: ReplayStranded) => void delivered.push(s);
  const f = fixture({ [SAME]: notReady(["[sizing] the old sizing message"]) });
  f.cacheDraft(SAME);
  const stuck = [sizing("NEW-1 spans three subsystems"), sizing("NEW-2 spans two subsystems"), scope("NEW-1 proof reads test/x.ts")];
  f.lintFor.set(SAME, stuck);
  assert.deepEqual(f.pass(540, { escalate }).reoffered, [{ proposalId: SAME, reason: "violations changed" }]);
  assert.equal(delivered.length, 0, "a re-offer is not an escalation");

  // The re-draft under today's guidance comes back with the same violation set it was offered on.
  f.cacheDraft(SAME);
  f.append({ ts: at(560), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: stuck.map((v) => v.message) });
  const pass = f.pass(570, { escalate });
  assert.deepEqual(pass.escalated, [SAME]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].proposalId, SAME);
  assert.equal(delivered[0].family, "x");
  assert.deepEqual(delivered[0].violations, {
    "proof-scope": ["NEW-1 proof reads test/x.ts"],
    sizing: ["NEW-1 spans three subsystems", "NEW-2 spans two subsystems"],
  });
  assert.equal(delivered[0].violationKey, "proof-scope,sizing");
  assert.equal(delivered[0].sameAsOffered, true);

  for (const minute of [571, 572, 573]) assert.deepEqual(f.pass(minute, { escalate }).escalated, []);
  assert.equal(delivered.length, 1, "delivered once per proposal per violation set");
  assert.ok(f.drafts()[SAME], "and never re-drafted while nothing changed");

  // A guidance change re-drafts it once more; the same violation set back is not a second escalation.
  const newGuidance = () => ["guidance after a relint.ts change"];
  assert.deepEqual(f.pass(600, { escalate, guidance: newGuidance }).reoffered, [{ proposalId: SAME, reason: "guidance changed" }]);
  f.cacheDraft(SAME);
  f.append({ ts: at(610), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: stuck.map((v) => v.message) });
  const again = f.pass(620, { escalate, guidance: newGuidance });
  assert.deepEqual(again.recorded, [{ proposalId: SAME, outcome: "redraft_not_ready" }]);
  assert.deepEqual(again.escalated, []);
  assert.equal(delivered.length, 1, "one escalation per proposal per violation set, across re-drafts");

  // ABSENT THE DEP, THE ROW IS STILL WRITTEN — once.
  const bare = fixture({ [SAME]: notReady(["[sizing] the old sizing message"]) });
  bare.cacheDraft(SAME);
  bare.lintFor.set(SAME, stuck);
  bare.pass(540);
  bare.cacheDraft(SAME);
  bare.append({ ts: at(560), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: [] });
  bare.pass(570);
  bare.pass(571);
  const rows = escalatedRows(bare, SAME);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delivered, false);
  assert.equal(rows[0].violation_key, "proof-scope,sizing");
  assert.deepEqual(rows[0].violations, delivered[0].violations);

  // A delivery that throws still leaves the row, and is not retried.
  const failing = fixture({ [SAME]: notReady(["[sizing] the old sizing message"]) });
  failing.cacheDraft(SAME);
  failing.lintFor.set(SAME, stuck);
  failing.pass(540);
  failing.cacheDraft(SAME);
  failing.append({ ts: at(560), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: [] });
  let calls = 0;
  const boom = () => {
    calls++;
    throw new Error("gh down");
  };
  assert.deepEqual(failing.pass(570, { escalate: boom }).escalated, [SAME]);
  failing.pass(571, { escalate: boom });
  assert.equal(calls, 1);
  const failed = escalatedRows(failing, SAME);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, "gh down");

  // A re-draft that leaves no cached draft is judged from its ledger row's messages.
  const uncached = fixture({ [SAME]: notReady(["[sizing] the old sizing message"]) });
  uncached.cacheDraft(SAME);
  uncached.lintFor.set(SAME, stuck);
  uncached.pass(540);
  uncached.append({ ts: at(560), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: ["a message with no check"] });
  uncached.pass(570);
  const fromRow = escalatedRows(uncached, SAME);
  assert.equal(fromRow.length, 1);
  assert.deepEqual(fromRow[0].violations, { unclassified: ["a message with no check"] });
});

test("W1-T9041: the replay is complete only when every outcome is final", () => {
  const f = fixture({
    [OPENED]: { family: "followup", invalidatedAt: SEED, outcome: { outcome: "refiled", at: at(10) } },
    [SUPERSEDED]: { family: "proof-debt", outcome: { outcome: "skipped_superseded", at: at(1), reason: "classified retired" } },
    [PUSH_REFUSED]: { family: "followup", invalidatedAt: SEED, outcome: { outcome: "refused", at: at(339), reason: "push refused" } },
    [SIZING]: notReady(["[sizing] x"]),
  });
  f.append({ ts: at(9), task_id: OPENED, step: "ratify.approved", pr_url: "https://github.com/o/r/pull/11402" });
  const open = f.pass(400);
  assert.equal(open.complete, false, "refused and redraft_not_ready are open outcomes");

  f.append({ ts: at(401), task_id: PUSH_REFUSED, step: "ratify.approved", pr_url: "https://github.com/o/r/pull/11403" });
  f.append({ ts: at(402), task_id: SIZING, step: "ratify.approved", pr_url: "https://github.com/o/r/pull/11404" });
  const done = f.pass(403);
  assert.deepEqual(done.recorded.sort((a, b) => a.proposalId.localeCompare(b.proposalId)), [
    { proposalId: PUSH_REFUSED, outcome: "refiled" },
    { proposalId: SIZING, outcome: "refiled" },
  ]);
  assert.equal(done.complete, true);
  assert.deepEqual(f.pass(404), { seeded: false, invalidated: [], recorded: [], reoffered: [], escalated: [], complete: true },
    "a complete store reads only itself");
});

test("W1-T9041: the fleet lane hands its replay the stranded escalation", () => {
  const f = fixture({ [SAME]: notReady(["[sizing] the old sizing message"]) });
  f.cacheDraft(SAME, "- id: [unclosed");
  const lane = (minutes: number, escalate: (s: ReplayStranded) => void) => triageFleetLane({
    stateDir: f.stateDir, ledgerPath: f.ledgerPath, mergedLastDay: () => 0, approve: () => undefined,
    clock: fixedClock(SEED_MS + minutes * 60_000), escalateReplayStranded: escalate,
  });
  const delivered: ReplayStranded[] = [];
  lane(540, (s) => void delivered.push(s));
  assert.equal(f.drafts()[SAME], undefined, "the lane's pass re-offered it under the real lint");
  f.cacheDraft(SAME, "- id: [unclosed");
  f.append({ ts: at(560), task_id: SAME, step: "inbox.drafted", proposal_id: SAME, lint_clean: false, unresolved_violations: [] });
  lane(570, (s) => void delivered.push(s));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].violationKey, "draft-parse");
});

test("W1-T9041: escalateReplayStranded delivers once per proposal and violation set", () => {
  const f = fixture({ [SAME]: notReady([]) });
  const created: string[] = [];
  const issues = { create: (title: string) => { created.push(title); return `https://github.com/o/r/issues/${created.length}`; } };
  const stranded = (key: string): ReplayStranded => ({
    proposalId: SAME, family: "verify-human-automate", violations: { sizing: ["NEW-1 spans three subsystems"] }, violationKey: key, sameAsOffered: true,
  });
  const ctx = { owner: "o", repo: "r", ledgerPath: f.ledgerPath, runId: "RUN-T9041", issues };
  escalateReplayStranded(stranded("sizing"), ctx);
  escalateReplayStranded(stranded("sizing"), ctx);
  assert.equal(created.length, 1, "the ledger row is the dedup key");
  assert.match(created[0], /verify-human-automate:W1-T216/);
  const rows = escalatedRows(f, SAME);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delivered, true);
  assert.equal(rows[0].issue_url, "https://github.com/o/r/issues/1");
  assert.deepEqual(rows[0].violations, { sizing: ["NEW-1 spans three subsystems"] });

  escalateReplayStranded(stranded("proof-scope,sizing"), ctx);
  assert.equal(created.length, 2, "a new violation set is a new escalation");

  // The row is written whether or not delivery succeeds.
  const down = { create: () => { throw new Error("gh down"); } };
  escalateReplayStranded(stranded("draft-parse"), { ...ctx, issues: down });
  const failed = escalatedRows(f, SAME).filter((r) => r.violation_key === "draft-parse");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].delivered, false);
});
