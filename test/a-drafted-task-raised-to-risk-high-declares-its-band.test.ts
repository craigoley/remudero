/**
 * test/a-drafted-task-raised-to-risk-high-declares-its-band.test.ts — W1-T8714.
 *
 * OBSERVED 2026-10-12: the inbox drafter raised verify-human-automate:W1-T8502 to risk:high on the relint's own
 * advice, the draft lint (no `riskTransition`) called it clean, and `rmd approve` (with one) refused it: "[sizing]
 * risk:high with no band_meaning declared". 40 READY proposals were lost that way. Here the draft floor and the
 * approve floor share one lint contract, the redraft guidance names the band, the approve repair declares it on an
 * already-high draft, and a one-shot replay sends the lost proposals back through the ordinary inbox path.
 */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { fixedClock } from "../src/lib/clock.js";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import { readClassificationSnapshot, triageFleetLane, writeClassificationSnapshot } from "../src/lib/fleet-lane.js";
import * as inbox from "../src/lib/inbox.js";
import {
  inboxDraftRelintPrompt,
  lintDraftedFragment,
  MAX_DRAFT_LINT_ATTEMPTS,
  relintRatificationFragment,
  runDraftRung,
  writeRatificationShards,
  type Proposal,
} from "../src/lib/inbox.js";
import { BAND_MEANING_REPLAY_STORE, readBandMeaningReplayStore, replayBandMeaningRefusals, type BandMeaningReplayStore } from "../src/lib/inbox-replay.js";
import { relintGuidanceLines } from "../src/lib/relint.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";

const W8502 = "verify-human-automate:W1-T8502";

/** The shape of W1-T8502's attempt-3 draft: two subsystems, raised to risk:high, no band_meaning. */
function highDraft(extra: string[] = [], id = "NEW-1"): string {
  return [
    `- id: ${id}`,
    '  title: "Apply the judged automate remedy for a blocked verify-human task"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: high",
    ...extra,
    "  status: queued",
    "  attempts: 0",
    "  files:",
    "    - src/lib/verify-human-judge.ts",
    "    - src/lib/inbox.ts",
    "  acceptance:",
    '    - claim: "the judged automate remedy is applied without an operator"',
    '      proof: "unit test: the judged automate remedy is applied without an operator"',
    '  origin: "architect"',
    "",
  ].join("\n");
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "S-1", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "m", routedModel: "m", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T8714: the draft lint blocks a risk high task with no band", async () => {
  const violations = lintDraftedFragment(highDraft(), W8502);
  const sizing = violations.filter((v) => v.check === "sizing");
  assert.equal(sizing.length, 1, `the draft floor must see the approve floor's band block: ${JSON.stringify(violations)}`);
  assert.equal(sizing[0].severity, "block");
  assert.match(sizing[0].message, /risk:high with no band_meaning declared/);
  assert.deepEqual(lintDraftedFragment(highDraft(["  band_meaning: span"]), W8502), [], "control: a declared band lints clean");
  assert.deepEqual(inbox.DRAFT_FILING_LINT_OPTIONS, { riskTransition: { baseTask: undefined }, proofSelfPath: "block" });

  // The rung's bounded self-lint: a drafter that never declares the band ends NOT-READY, with the refusal named.
  const proposal = { id: W8502, summary: "automate W1-T8502", evidenceAnchors: [] } as unknown as Proposal;
  const stamp = `- ${W8502} (automate the verify-human remedy) — RATIFIED 2026-10-12 -> NEW-1.`;
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async (_p, prompt) => {
      prompts.push(prompt);
      return worker(`=== FRAGMENT START ===\n${highDraft()}=== FRAGMENT END ===\nSTAMP: ${stamp}`);
    },
    log: (step, extra) => events.push({ step, extra }),
  }, "run-8714");
  assert.equal(outcome.ok, true, "a still-dirty draft is cached, NOT-READY");
  assert.equal(prompts.length, MAX_DRAFT_LINT_ATTEMPTS, "the existing bound is the bound");
  assert.match(prompts[1], /band_meaning: span/, "the redraft carries the band declaration");
  const drafted = events.find((e) => e.step === "inbox.drafted")?.extra;
  assert.equal(drafted?.lint_clean, false);
  assert.ok((drafted?.unresolved_violations as string[]).some((m) => /no band_meaning declared/.test(m)), JSON.stringify(drafted));
});

test("W1-T8714: the approve repair declares the band on an already high draft", () => {
  const fragment = highDraft([], "W1-T8595");
  const repaired = relintRatificationFragment(fragment, W8502);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.ok(repaired.ok && repaired.fragmentYaml.includes("  risk: high\n  band_meaning: span\n"), "inserted after the risk line");
  assert.equal(repaired.ok && repaired.fragmentYaml, fragment.replace("  risk: high\n", "  risk: high\n  band_meaning: span\n"), "nothing else changes");

  const written: Array<{ path: string; data: string }> = [];
  const paths = writeRatificationShards("/wt", fragment, W8502, {
    mkdirSync: () => undefined,
    writeFileSync: (path, data) => void written.push({ path, data }),
  }, (...parts) => parts.join("/"));
  assert.equal(paths.length, 1, "it files instead of throwing approve.error");
  assert.match(written[0].data, /^ {2}band_meaning: span$/m);
});

test("W1-T8714: a declared band is left unchanged", () => {
  for (const band of ["blast-radius", "span"]) {
    const fragment = highDraft([`  band_meaning: ${band}`], "W1-T8595");
    const repaired = relintRatificationFragment(fragment, W8502);
    assert.deepEqual(repaired, { ok: true, fragmentYaml: fragment }, `band_meaning: ${band} is the author's, byte for byte`);
  }
});

test("W1-T8714: the sizing guidance names band_meaning", () => {
  const sizing = { check: "sizing", severity: "block" as const, message: "spans 2 distinct subsystems/concerns at risk:low" };
  const lines = relintGuidanceLines([sizing]).join("\n");
  assert.match(lines, /raise that task to risk:high AND declare band_meaning: span/);
  assert.match(lines, /band_meaning: blast-radius/, "the alternative is named");
  const prompt = inboxDraftRelintPrompt({ id: W8502 } as Proposal, highDraft(), [sizing]);
  assert.match(prompt, /band_meaning: span/, "the inbox redraft prompt carries the shared guidance");
});

// ── the one-shot replay ──────────────────────────────────────────────────────────────────────────────

const BAND = "[sizing] risk:high with no band_meaning declared — W1-T2503: a task this diff files or promotes to high";
const refusal = (id: string) => `rmd approve: refusing to file ${id} — ${BAND}`;
const SEED_MS = Date.parse("2026-10-12T16:00:00.000Z");
const BEFORE = "2026-10-01T10:00:00.000Z";
const AFTER = "2026-10-12T17:00:00.000Z";

const REFILE = "followup:W1-T9001:research";
const RETIRED = "proof-debt:W1-T9002";
const LATER_FILED = "adoption:export-no-caller:src/lib/plan.ts:x";
const ONCE_FILED = "proof-debt:W1-T9003";
const GONE = "followup:W1-T9004:gone";
const REFUSED = "verify-human-automate:W1-T9005";
const DUPLICATE = "verify-human-automate:W1-T9006";
const NOT_READY = "adoption:field-no-writer:src/lib/inbox.ts:y";
const OTHER_ERROR = "followup:W1-T9007:other";
const BATCHED = "followup:W1-T9008:batched";

const POPULATION = [REFILE, RETIRED, GONE, REFUSED, DUPLICATE, NOT_READY, BATCHED].sort();

interface Fixture {
  stateDir: string;
  ledgerPath: string;
  rows: () => Array<Record<string, unknown>>;
  append: (...rows: Array<Record<string, unknown>>) => void;
  store: () => BandMeaningReplayStore;
  drafts: () => Record<string, unknown>;
  attempts: () => Record<string, unknown>;
  pass: (ms?: number) => ReturnType<typeof replayBandMeaningRefusals>;
}

function fixture(opts: { approveRows?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t8714-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const approveRows: Array<Record<string, unknown>> = opts.approveRows === false ? [] : [
    { ts: BEFORE, task_id: REFILE, step: "approve.error", error: refusal(REFILE) },
    { ts: BEFORE, task_id: RETIRED, step: "approve.error", error: refusal(RETIRED) },
    { ts: BEFORE, task_id: LATER_FILED, step: "approve.error", error: refusal(LATER_FILED) },
    { ts: "2026-10-02T10:00:00.000Z", task_id: "BATCH", step: "approve.shards_written", proposal_ids: [LATER_FILED], paths: [] },
    { ts: "2026-09-20T10:00:00.000Z", task_id: ONCE_FILED, step: "approve.shards_written", proposal_id: ONCE_FILED, paths: [] },
    { ts: BEFORE, task_id: ONCE_FILED, step: "approve.error", error: refusal(ONCE_FILED) },
    { ts: BEFORE, task_id: GONE, step: "approve.error", error: refusal(GONE) },
    { ts: BEFORE, task_id: REFUSED, step: "approve.error", error: refusal(REFUSED) },
    { ts: BEFORE, task_id: DUPLICATE, step: "approve.error", error: refusal(DUPLICATE) },
    { ts: BEFORE, task_id: NOT_READY, step: "approve.error", error: refusal(NOT_READY) },
    { ts: BEFORE, task_id: OTHER_ERROR, step: "approve.error", error: "rmd approve: refusing to file followup:W1-T9007:other — [proof-dialect] bare" },
    { ts: BEFORE, task_id: "BATCH", step: "approve.error", error: refusal(BATCHED) },
  ];
  writeFileSync(ledgerPath, [{ ts: BEFORE, task_id: "W1-T1", step: "run.start" }, ...approveRows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const live = [REFILE, RETIRED, LATER_FILED, ONCE_FILED, REFUSED, DUPLICATE, NOT_READY, OTHER_ERROR, BATCHED];
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: live.map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  const draft = (id: string) => ({ proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" });
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(live.map((id) => [id, draft(id)]))));
  writeFileSync(join(stateDir, "inbox-draft-attempts.json"), JSON.stringify(Object.fromEntries(live.map((id) => [id, `${id}::0`]))));
  writeClassificationSnapshot(stateDir, live.map((proposalId) => ({ proposalId, state: proposalId === RETIRED ? "retired" : "ready" })));
  const json = (name: string) => JSON.parse(readFileSync(join(stateDir, name), "utf8")) as Record<string, unknown>;
  return {
    stateDir,
    ledgerPath,
    rows: () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
    append: (...rows) => writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8") + rows.map((r) => JSON.stringify(r) + "\n").join("")),
    store: () => json(BAND_MEANING_REPLAY_STORE) as unknown as BandMeaningReplayStore,
    drafts: () => json("inbox-drafts.json"),
    attempts: () => json("inbox-draft-attempts.json"),
    pass: (ms = SEED_MS) => replayBandMeaningRefusals({ stateDir, ledgerPath, clock: fixedClock(ms), classificationStates: () => readClassificationSnapshot(stateDir)?.states }),
  };
}

const replayed = (f: Fixture) => f.rows().filter((r) => r.step === "inbox.replayed");

test("W1-T8714: the replay population is the proposals whose latest approve outcome is the band refusal", () => {
  const f = fixture();
  f.pass();
  const store = f.store();
  assert.deepEqual(Object.keys(store.proposals).sort(), POPULATION,
    "a proposal that later reached approve.shards_written, or ever did, or failed on another refusal, is not lost");
  assert.equal(store.proposals[BATCHED].family, "followup", "a BATCH error is attributed by the id its text names");
  assert.equal(store.proposals[REFUSED].family, "verify-human-automate");
  assert.equal(store.seededAt, new Date(SEED_MS).toISOString());
  assert.equal(f.rows().filter((r) => r.step === "inbox.replay_deferred").length, 0);
});

test("W1-T8714: a replayed proposal is re-drafted and filed through the inbox path", () => {
  const f = fixture();
  f.pass();
  assert.equal(f.drafts()[REFILE], undefined, "the cached draft is dropped, so the draft rung re-drafts it");
  assert.equal(f.attempts()[REFILE], undefined, "and its attempt key, or the rung would never retry it");
  assert.ok(f.drafts()[OTHER_ERROR], "a proposal outside the population keeps its draft");
  assert.equal(replayed(f).some((r) => r.proposal_id === REFILE), false, "not refiled until an approve files it");
  assert.equal(f.store().proposals[REFILE].invalidatedAt, new Date(SEED_MS).toISOString());

  // The draft rung re-drafts it READY; the fleet lane's FILE step hands it to the ordinary approve.
  writeFileSync(join(f.stateDir, "inbox-drafts.json"), JSON.stringify({ [REFILE]: { proposalId: REFILE, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" } }));
  writeClassificationSnapshot(f.stateDir, [{ proposalId: REFILE, state: "ready" }]);
  const approved: string[] = [];
  triageFleetLane({ stateDir: f.stateDir, ledgerPath: f.ledgerPath, mergedLastDay: () => 5, approve: (id) => void approved.push(id), clock: fixedClock(SEED_MS + 1000) });
  assert.deepEqual(approved, [REFILE]);
  assert.equal(replayed(f).some((r) => r.proposal_id === REFILE), false, "handing it to approve is not filing it");

  f.append({ ts: AFTER, task_id: REFILE, step: "approve.shards_written", proposal_id: REFILE, paths: ["plan/tasks.d/W1-T9100-x.yaml"] });
  f.pass(SEED_MS + 7_200_000);
  const rows = replayed(f).filter((r) => r.proposal_id === REFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "refiled");
  assert.equal(rows[0].family, "followup");
  assert.equal(f.store().proposals[REFILE].outcome?.outcome, "refiled");

  // The fleet lane's own pass runs the replay: no new timer, no other wiring.
  const lane = fixture();
  triageFleetLane({ stateDir: lane.stateDir, ledgerPath: lane.ledgerPath, mergedLastDay: () => 0, approve: () => undefined, clock: fixedClock(SEED_MS) });
  assert.deepEqual(Object.keys(lane.store().proposals).sort(), POPULATION);
  assert.equal(lane.drafts()[REFILE], undefined);
});

test("W1-T8714: each later outcome is recorded once with its reason", () => {
  const f = fixture();
  f.pass();
  f.append(
    { ts: AFTER, task_id: REFUSED, step: "approve.error", error: "rmd approve: refusing to file verify-human-automate:W1-T9005 — [proof-dialect] bare" },
    { ts: AFTER, task_id: DUPLICATE, step: "ratify.approve_refused", reason: "would file ...", duplicate_of: "plan/tasks.d/W1-T100-x.yaml" },
    { ts: AFTER, task_id: NOT_READY, step: "inbox.drafted", proposal_id: NOT_READY, lint_clean: false, unresolved_violations: ["[sizing] still dirty"] },
    { ts: AFTER, task_id: BATCHED, step: "inbox.drafted", proposal_id: BATCHED, lint_clean: true, unresolved_violations: [] },
  );
  f.pass(SEED_MS + 7_200_000);
  const by = new Map(replayed(f).map((r) => [r.proposal_id, r]));
  assert.equal(by.get(REFUSED)?.outcome, "refused");
  assert.match(String(by.get(REFUSED)?.reason), /proof-dialect/);
  assert.equal(by.get(DUPLICATE)?.outcome, "skipped_superseded");
  assert.match(String(by.get(DUPLICATE)?.reason), /W1-T100/);
  assert.equal(by.get(NOT_READY)?.outcome, "redraft_not_ready");
  assert.deepEqual(by.get(NOT_READY)?.unresolved_violations, ["[sizing] still dirty"]);
  assert.equal(by.has(BATCHED), false, "a clean redraft waits for its approve");
});

test("W1-T8714: a superseded proposal is recorded skipped_superseded and not re-drafted", () => {
  const f = fixture();
  f.pass();
  assert.ok(f.drafts()[RETIRED], "a proposal the classification retired is never re-drafted");
  assert.ok(f.attempts()[RETIRED]);
  const by = new Map(replayed(f).map((r) => [r.proposal_id, r]));
  assert.equal(by.get(RETIRED)?.outcome, "skipped_superseded");
  assert.match(String(by.get(RETIRED)?.reason), /retired/);
  assert.equal(by.get(GONE)?.outcome, "skipped_superseded", "a proposal no longer in the registry is not replayed");
  assert.match(String(by.get(GONE)?.reason), /registry/);
  assert.equal(f.store().proposals[RETIRED].invalidatedAt, undefined);
});

test("W1-T8714: a second replay pass writes no second row", () => {
  const f = fixture();
  f.pass();
  f.append(
    { ts: AFTER, task_id: REFILE, step: "approve.shards_written", proposal_id: REFILE, paths: [] },
    { ts: AFTER, task_id: REFUSED, step: "approve.error", error: "rmd approve: transient" },
  );
  f.pass(SEED_MS + 1000);
  const first = replayed(f).length;
  assert.ok(first >= 4, `fixture: outcomes were recorded (${first})`);
  const seededAt = f.store().seededAt;

  // The live ledger rotates away; the replay's memory is its own store, never the ledger.
  renameSync(f.ledgerPath, join(f.stateDir, "ledger.2026-10-12T18-00-00-000Z.ndjson"));
  writeFileSync(f.ledgerPath, "");
  f.pass(SEED_MS + 2000);
  f.pass(SEED_MS + 3000);
  const after = [
    ...readFileSync(join(f.stateDir, "ledger.2026-10-12T18-00-00-000Z.ndjson"), "utf8").split("\n"),
    ...readFileSync(f.ledgerPath, "utf8").split("\n"),
  ].filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === "inbox.replayed");
  assert.equal(after.length, first, "no proposal gets a second inbox.replayed row");
  assert.equal(new Set(after.map((r) => r.proposal_id)).size, after.length);
  assert.equal(f.store().seededAt, seededAt, "a store that exists is never re-seeded");
});

test("W1-T8714: an incomplete ledger read seeds no replay", () => {
  const broken = fixture();
  writeFileSync(join(broken.stateDir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), Buffer.from("not gzip"));
  const pass = broken.pass();
  assert.equal(existsSync(join(broken.stateDir, BAND_MEANING_REPLAY_STORE)), false, "an ok:false union seeds nothing");
  assert.equal(pass.seeded, false);
  const deferred = broken.rows().filter((r) => r.step === "inbox.replay_deferred");
  assert.equal(deferred.length, 1);
  assert.match(String(deferred[0].reason), /incomplete/);
  assert.ok(broken.drafts()[REFILE], "nothing is invalidated on a partial read");

  // The next pass tries again, and seeds once the corpus reads whole.
  writeFileSync(join(broken.stateDir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), gzipSync(""));
  broken.pass();
  assert.deepEqual(Object.keys(broken.store().proposals).sort(), POPULATION);

  const empty = fixture({ approveRows: false });
  empty.pass();
  assert.equal(existsSync(join(empty.stateDir, BAND_MEANING_REPLAY_STORE)), false, "zero approve rows is a failed control, not an empty population");
  const none = empty.rows().filter((r) => r.step === "inbox.replay_deferred");
  assert.equal(none.length, 1);
  assert.match(String(none[0].reason), /no approve/);
});

test("W1-T8714: a malformed replay store defers without reseeding and retries after repair", () => {
  const f = fixture();
  const storePath = join(f.stateDir, BAND_MEANING_REPLAY_STORE);
  const malformed = JSON.stringify({ seededAt: SEED_MS, proposals: {} });
  writeFileSync(storePath, malformed);
  const message = `inbox-replay: ${storePath} is not a replay store`;
  assert.throws(() => readBandMeaningReplayStore(f.stateDir), { message });
  const drafts = f.drafts();
  const attempts = f.attempts();
  const expected = { seeded: false, invalidated: [], recorded: [], deferred: `error: ${message}`, complete: false };
  assert.deepEqual(f.pass(), expected);
  assert.deepEqual(f.pass(SEED_MS + 1000), expected);
  assert.equal(readFileSync(storePath, "utf8"), malformed);
  assert.deepEqual(f.drafts(), drafts);
  assert.deepEqual(f.attempts(), attempts);
  const rows = f.rows().filter((r) => r.step === "inbox.replay_deferred");
  assert.equal(rows.length, 1, "an unchanged failure is recorded once");
  assert.equal(rows[0].reason, expected.deferred);

  rmSync(storePath);
  assert.equal(f.pass(SEED_MS + 2000).seeded, true);
  assert.equal(f.drafts()[REFILE], undefined);
});

test("W1-T8714: an approve duplicate refusal records the filed task or the fallback reason", () => {
  for (const [text, reason] of [
    ["a task record already on origin/main against W1-T100 — same subject", "duplicate of W1-T100"],
    ["a task record already on origin/main", "duplicate of a filed task"],
  ]) {
    const f = fixture();
    f.pass();
    f.append({ ts: AFTER, task_id: DUPLICATE, step: "approve.error", error: text });
    const pass = f.pass(SEED_MS + 7_200_000);
    assert.deepEqual(pass.recorded, [{ proposalId: DUPLICATE, outcome: "skipped_superseded" }]);
    assert.deepEqual(f.store().proposals[DUPLICATE].outcome, {
      outcome: "skipped_superseded", at: new Date(SEED_MS + 7_200_000).toISOString(), reason,
    });
    const rows = replayed(f).filter((r) => r.proposal_id === DUPLICATE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "skipped_superseded");
    assert.equal(rows[0].reason, reason);
    assert.deepEqual(f.pass(SEED_MS + 7_200_001).recorded, []);
  }
});

test("W1-T8714: colliding registry shards cannot declare a proposal absent", () => {
  const f = fixture();
  const shardDir = join(f.stateDir, "inbox-proposals.d");
  mkdirSync(shardDir);
  const proposal = JSON.stringify({ id: REFILE, summary: "collision", evidenceAnchors: [] });
  writeFileSync(join(shardDir, "one.json"), proposal);
  writeFileSync(join(shardDir, "two.json"), proposal);
  assert.throws(() => inbox.loadProposalRegistry(join(f.stateDir, "inbox-proposals.json")), /duplicate proposal id/);
  const pass = f.pass();
  assert.equal(pass.deferred, undefined);
  assert.ok(pass.invalidated.includes(GONE), "a faulted registry cannot prove GONE was superseded");
  assert.equal(f.store().proposals[GONE].outcome, undefined);
  assert.equal(replayed(f).some((r) => r.proposal_id === GONE), false);
  assert.equal(f.drafts()[REFILE], undefined, "live proposals still get re-drafted");

  rmSync(join(shardDir, "two.json"));
  assert.deepEqual(f.pass(SEED_MS + 1000).recorded, [{ proposalId: GONE, outcome: "skipped_superseded" }]);
  assert.equal(f.store().proposals[GONE].outcome?.reason, "no longer in the registry");
});

test("W1-T8714: a live draft lock leaves caches intact until the next pass", () => {
  const f = fixture();
  const drafts = f.drafts();
  const attempts = f.attempts();
  const lock = acquireDrainLock(join(f.stateDir, "inbox-draft.lock"));
  try {
    const pass = f.pass();
    assert.equal(pass.seeded, true);
    assert.equal(pass.deferred, undefined);
    assert.deepEqual(pass.invalidated, []);
    assert.equal(f.store().proposals[REFILE].invalidatedAt, undefined);
    assert.deepEqual(f.drafts(), drafts);
    assert.deepEqual(f.attempts(), attempts);
    assert.equal(existsSync(lock.path), true, "the replay must not release another holder's lock");
  } finally {
    lock.release();
  }
  assert.ok(f.pass(SEED_MS + 1000).invalidated.includes(REFILE));
  assert.equal(f.drafts()[REFILE], undefined);
  assert.equal(f.attempts()[REFILE], undefined);
  assert.equal(existsSync(lock.path), false, "the real default releases its lock after invalidating");
});

test("W1-T8714: a draft lock io failure defers with its reason and retries", (t) => {
  const f = fixture();
  const drafts = f.drafts();
  const attempts = f.attempts();
  const lockPath = join(f.stateDir, "inbox-draft.lock");
  const original = fs.openSync;
  const failure = Object.assign(new Error("draft lock io failure"), { code: "EIO" });
  let failedCalls = 0;
  const mocked = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === lockPath) {
      failedCalls++;
      throw failure;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(f.pass(), {
      seeded: false, invalidated: [], recorded: [], deferred: "error: draft lock io failure", complete: false,
    });
    assert.equal(failedCalls, 1, "the replay reached the failing lock dependency");
    assert.equal(f.store().proposals[REFILE].invalidatedAt, undefined);
    assert.deepEqual(f.drafts(), drafts);
    assert.deepEqual(f.attempts(), attempts);
    const rows = f.rows().filter((r) => r.step === "inbox.replay_deferred");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "error: draft lock io failure");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const retry = f.pass(SEED_MS + 1000);
  assert.equal(retry.seeded, false, "the population saved before the failure is reused");
  assert.ok(retry.invalidated.includes(REFILE));
  assert.equal(f.drafts()[REFILE], undefined);
  assert.equal(f.attempts()[REFILE], undefined);
});
