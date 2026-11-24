/**
 * W1-T14747 — A held rebuild or held follow-up the sweep files never carries its source record's moved_from line.
 *
 * Every test drives the production entry path, takeParkedPrRemedy, with a recording ParkedPrHost. The source record
 * is an ops copy: the catalog mover's one moved_from line sits after its id line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";

import type { TaskFileInput } from "#src/lib/feedback-landing.js";
import { PARKED_PR_REMEDY_STEP, takeParkedPrRemedy, type ParkedPrContext, type ParkedPrDecision, type ParkedPrHost,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";

type Row = { step: string } & Record<string, unknown>;

const ID = "W1-T900747";
const REL = `plan/tasks.d/${ID}-a-fixture-ops-copy.yaml`;
const PR_URL = "https://github.com/o/remudero/pull/20694";
const HEAD = "2069400".padEnd(40, "0");
const MOVED_LINE = `  moved_from: remudero@${"f0901b68dd82".padEnd(40, "0")}\n`;
const INVARIANT = "invariant:keeps-the-key — the parent keeps the key it carries";
const FIRST = "the first criterion holds";
const NEEDS_INPUT = "the third criterion needs a design answer";
const RULING = { verdict: "proceed", action: "proceed", confidence: 0.9, reasons: ["a fixture reason"],
  judged_at: "2026-11-24T00:00:00.000Z", pin: "a".repeat(64) };

/** An ops copy shaped like W1-T11073: the mover's moved_from line after the id line, a risk ruling and a hold. */
const SOURCE = [`- id: ${ID}`, MOVED_LINE.trimEnd(), "  title: Fixture shaped like an ops copy", "  repo: remudero",
  "  depends_on: [W1-T900001]", "  priority: 0", "  type: implement", "  verify: auto", "  risk: medium # a fixture risk",
  "  files:", "    - src/x.ts", "    - test/x.test.ts", "  status: queued", "  attempts: 0", "  dispatch_hold: true",
  "  risk_ruling:", `    verdict: ${RULING.verdict}`, `    action: ${RULING.action}`, `    confidence: ${RULING.confidence}`,
  "    reasons:", `      - ${RULING.reasons[0]}`, `    judged_at: "${RULING.judged_at}"`, `    pin: "${RULING.pin}"`,
  "  acceptance:", `    - claim: "${FIRST}"`, `      proof: "grep: ${FIRST} in src/x.ts"`,
  `    - claim: "${INVARIANT}"`, `      proof: "grep: keeps the key in test/x.test.ts"`,
  `    - claim: "${NEEDS_INPUT}"`, `      proof: "grep: ${NEEDS_INPUT} in src/x.ts"`,
  "  rationale: |", "    WHY: a fixture.", "  design: |", "    INVARIANT keeps-the-key: the parent keeps the key it carries.",
  "    1. Keep the key.", "  note: |", "    A fixture note.", ""].join("\n");
/** The same record before the move: the source text less its one moved_from line. */
const UNMOVED = SOURCE.replace(MOVED_LINE, "");

const rebuild: ParkedPrDecision = { remedy: "close-and-rebuild", reason: "no part can merge without operator input",
  inputCriteria: [FIRST, INVARIANT, NEEDS_INPUT].map(claim => ({ claim, needsInput: true, ladderSpent: true })) };
const split: ParkedPrDecision = { remedy: "split-follow-up", reason: "one criterion needs operator input",
  inputCriteria: [{ claim: NEEDS_INPUT, needsInput: true, ladderSpent: true }] };
const subject: ParkedPrSubject = { prNumber: 20694, prUrl: PR_URL, headSha: HEAD, taskId: ID,
  unmetCriteria: [{ claim: NEEDS_INPUT, reason: "it needs a design answer" }] };

/** Runs one remedy on `text` with a host that records what it reserves, lands and closes. */
async function run(text: string, decision: ParkedPrDecision) {
  const landed: TaskFileInput[][] = [], closed: string[] = [], rows: Row[] = [];
  const host: ParkedPrHost = {
    readTaskShard: async taskId => taskId === ID
      ? { outcome: "read", shard: { relPath: REL, text }, target: { owner: "o", repo: "remudero-ops", checkoutDir: "/unused" } }
      : { outcome: "refused", reason: "task-absent" },
    reserveTaskId: () => "W1-T990001",
    landTaskFiles: async files => { landed.push([...files]); return { prUrl: "https://github.com/o/remudero-ops/pull/672",
      staged: files.map(f => f.relPath) }; },
    closePr: async prUrl => { closed.push(prUrl); },
  };
  const ctx: ParkedPrContext = { runId: "t14747", ledgerTaskId: ID, nowIso: "2026-11-24T21:00:00.000Z", cause: "needs-design",
    text: "which store?", append: row => { rows.push(row); } };
  const out = await takeParkedPrRemedy(subject, decision, [], host, ctx);
  assert.equal(out.error, undefined, out.reason);
  assert.equal(landed.length, 1, "the remedy lands its task files once");
  const files = landed[0]!;
  const held = files.find(f => f.newFile === true)!;
  assert.ok(held, "the remedy files a new held record");
  const record = (parse(held.content) as Record<string, unknown>[])[0]!;
  const row = rows.find(r => r.step === PARKED_PR_REMEDY_STEP)!;
  return { out, files, held, record, amended: files.find(f => f.relPath === REL), closed, row };
}

test("W1-T14747 criterion 1: the held rebuild and the held follow-up filed from an ops copy carry no moved_from key", async () => {
  assert.match(SOURCE, /^ {2}moved_from: remudero@[0-9a-f]{40}$/m, "the source record is an ops copy the mover wrote");
  for (const decision of [rebuild, split]) {
    const w = await run(SOURCE, decision);
    assert.equal(w.row.outcome, "taken", `${decision.remedy}: ${String(w.row.reason)}`);
    assert.equal(w.record.id, "W1-T990001");
    assert.equal(Object.hasOwn(w.record, "moved_from"), false, `the ${decision.remedy} held record carries no moved_from key`);
    assert.doesNotMatch(w.held.content, /moved_from/, `the ${decision.remedy} held file has no moved_from line`);
  }
});

test("W1-T14747 criterion 2: a split keeps the source record's own moved_from line byte for byte; only the held record drops it", async () => {
  const w = await run(SOURCE, split);
  const amended = w.amended!;
  assert.ok(amended, "a split lands the amended source record");
  assert.notEqual(amended.newFile, true, "the amended source record is an edit");
  assert.ok(amended.content.includes(`- id: ${ID}\n${MOVED_LINE}`), "the moved_from line stays after the id line, byte for byte");
  assert.equal(amended.content.split("\n").filter(line => /^\s+moved_from:/.test(line)).length, 1, "one moved_from line");
  const before = await run(UNMOVED, split);
  assert.equal(amended.content.replace(MOVED_LINE, ""), before.amended!.content,
    "apart from its moved_from line, the amended source record is as for the same record before the move");
  assert.equal(Object.hasOwn(w.record, "moved_from"), false, "the new held record drops it");
});

test("W1-T14747 criterion 3: invariant:held-record-contract-unchanged, every other key of the held record is as for the same record without moved_from", async () => {
  const expectedKeys = ["id", "title", "repo", "depends_on", "priority", "type", "verify", "risk", "files", "status", "attempts",
    "dispatch_hold", "risk_ruling", "acceptance", "rationale", "design", "needs_input"];
  for (const decision of [rebuild, split]) {
    const moved = await run(SOURCE, decision);
    const unmoved = await run(UNMOVED, decision);
    assert.equal(moved.held.relPath, unmoved.held.relPath);
    assert.equal(moved.held.content, unmoved.held.content, `the ${decision.remedy} held file is byte for byte as without moved_from`);
    const r = moved.record;
    assert.deepEqual(Object.keys(r), expectedKeys, `the ${decision.remedy} held record keeps every other key, in order`);
    const isSplit = decision.remedy === "split-follow-up";
    assert.equal(r.title, `Fixture shaped like an ops copy (${isSplit ? "held follow-up" : "held rebuild"})`);
    assert.deepEqual(r.depends_on, isSplit ? [ID, "W1-T900001"] : ["W1-T900001"]);
    assert.deepEqual([r.repo, r.priority, r.type, r.verify, r.risk, r.status, r.attempts], ["remudero", 0, "implement", "auto",
      "medium", "queued", 0]);
    assert.deepEqual(r.files, ["src/x.ts", "test/x.test.ts"]);
    assert.equal(r.dispatch_hold, true, "the source's dispatch_hold stays as on origin/main");
    assert.deepEqual(r.risk_ruling, RULING, "the source's risk_ruling stays as on origin/main");
    assert.deepEqual((r.acceptance as { claim: string }[]).map(c => c.claim), isSplit ? [NEEDS_INPUT] : [FIRST, INVARIANT, NEEDS_INPUT]);
    const needsInput = r.needs_input as { question: string; source_pr: string; asked_at: string };
    assert.deepEqual([needsInput.source_pr, needsInput.asked_at], [PR_URL, "2026-11-24T21:00:00.000Z"]);
    assert.match(String(r.rationale), new RegExp(`^${isSplit ? "FOLLOW-UP" : "REBUILD"} of ${ID}, filed by the sweep`));
    assert.match(String(r.rationale), /WHY: a fixture\./);
    assert.match(String(r.design), isSplit ? /^NO-INVARIANTS: this held follow-up of /m : /INVARIANT keeps-the-key:/m);
    assert.deepEqual(moved.closed, isSplit ? [] : [PR_URL]);
  }
});
