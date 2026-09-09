/**
 * W1-T3231 — a pull request that ADDS a task's plan record must not also carry that task's
 * `Remudero-Task:` trailer.
 *
 * THE DEFECT. `reviewCommand` resolves criteria from the trailered task's shard. On a filing PR
 * those criteria describe the IMPLEMENTATION — source files not in the diff, test files that do
 * not exist yet — so the filing is judged against work it cannot contain and fails closed. Made
 * three times in one session (2026-09-09), a full CI cycle each.
 *
 * WHY THE PREDICATE IS NARROW, AND WHY THAT IS THE POINT. W1-T1004 (merged; it fixed the other
 * half of this mistake, the false merge credit) forbids inferring "this is a filing" from a
 * plan-only diff, having MEASURED 15 plan-only credits of which TWO were CORRECT — those tasks
 * deliver plan text. So the refusal keys on identity instead: does this diff introduce the record
 * for the very task it credits? The second and third cases below are the halves a blanket
 * plan-only rule would break, and they run in the same file as the refusal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { filingSelfCreditCheck } from "../src/lib/review.js";
// @ts-expect-error — `scripts/**` sits outside tsconfig's `include`, so this executable .mjs has
// no declaration output (TS7016). The seam this suite consumes is declared immediately below
// rather than left as `any`, the same idiom test/a-ci-skip-guard-can-fire-unconditionally.test.ts
// uses for its own script.
import * as authorGate from "../scripts/acceptance-author-gate.mjs";

const evaluateGate = authorGate.evaluateGate as (input: {
  body: string;
  authorLogin?: string;
  trailerResolves?: (taskId: string) => boolean;
  introducedTaskIds?: readonly string[];
}) => { ok: boolean; defect?: string; message: string };

const introducedShardTaskIds = authorGate.introducedShardTaskIds as (opts: {
  baseSha?: string;
  headSha?: string;
  root?: string;
  git?: (args: readonly string[]) => string;
}) => string[];

const FILING_BODY = [
  "Plan-only. Files W1-T3231.",
  "",
  "## Acceptance",
  "- claim: the shard says what it says | grep: something in plan/tasks.d/W1-T3231-x.yaml",
  "",
  "Remudero-Task: W1-T3231",
].join("\n");

const IMPLEMENTATION_BODY = ["Implements W1-T3231.", "", "Remudero-Task: W1-T3231"].join("\n");

// ── The refusal ─────────────────────────────────────────────────────────────────────────────

test("W1-T3231: a pull request that adds the shard it credits is refused", () => {
  const r = filingSelfCreditCheck(FILING_BODY, ["W1-T3231"]);
  assert.equal(r.ok, false);
  assert.equal(r.taskId, "W1-T3231");
  // The message must name BOTH consequences, because an author who only hears "review will fail"
  // fixes it by re-running review rather than by removing the trailer.
  assert.match(r.message, /fails closed/);
  assert.match(r.message, /credited as built so the implementation is never dispatched/);
  assert.match(r.message, /REMOVE THE TRAILER/);

  // ...and the gate itself refuses, with its own defect name — the predicate being right is not
  // the same as the gate reaching it.
  const gate = evaluateGate({ body: FILING_BODY, introducedTaskIds: ["W1-T3231"] });
  assert.equal(gate.ok, false);
  assert.equal(gate.defect, "files-and-credits-the-same-task");
});

// ── The two halves a blanket plan-only rule would break ─────────────────────────────────────

test("W1-T3231: an implementation pull request carrying a trailer is not refused", () => {
  // The shard already exists on main, so this diff introduces no record.
  const r = filingSelfCreditCheck(IMPLEMENTATION_BODY, []);
  assert.equal(r.ok, true);
  assert.match(r.message, /does not introduce that task's record/);

  const gate = evaluateGate({ body: IMPLEMENTATION_BODY, introducedTaskIds: [] });
  assert.equal(gate.ok, true);
});

test("W1-T3231: a plan-only pull request that does not add its own shard is allowed", () => {
  // W1-T1004's two correct cases: the task's declared deliverable IS plan text, and its shard was
  // filed earlier by a different PR. A plan-only-ness rule refuses this; identity does not.
  const body = ["Records the ruling in MASTER-PLAN.", "", "Remudero-Task: W1-T426"].join("\n");
  assert.equal(filingSelfCreditCheck(body, ["W1-T9999"]).ok, true, "another task's shard in the diff is irrelevant");
  assert.equal(filingSelfCreditCheck(body, []).ok, true);
});

test("W1-T3231: a body with no trailer is never refused, whatever the diff introduces", () => {
  const r = filingSelfCreditCheck("Plan-only. Files W1-T3231.\n\n## Acceptance\n- a | grep: b in c", ["W1-T3231"]);
  assert.equal(r.ok, true);
  assert.match(r.message, /nothing to self-credit/);
});

// ── Failing OPEN, in every direction it can fail ────────────────────────────────────────────

test("W1-T3231: a diff the gate cannot read introduces nothing — it never refuses on an unknown", () => {
  const threw = () => {
    throw new Error("fatal: bad object (a shallow clone, or a sha this checkout does not have)");
  };
  assert.deepEqual(introducedShardTaskIds({ baseSha: "aaa", headSha: "bbb", git: threw }), []);
  // Missing shas — an older event shape, or a hand-built fixture — read the same way.
  assert.deepEqual(introducedShardTaskIds({ git: threw }), []);
  assert.deepEqual(introducedShardTaskIds({ baseSha: "aaa", git: threw }), []);
  // ...and that empty set is what makes the gate pass, not merely not-crash.
  assert.equal(evaluateGate({ body: FILING_BODY, introducedTaskIds: [] }).ok, true);
});

test("W1-T3231: an added shard's declared id is read from the head blob, and one unreadable shard costs only itself", () => {
  const calls: string[][] = [];
  const git = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args[0] === "diff") {
      return "A\tplan/tasks.d/W1-T3231-a-thing.yaml\nA\tplan/tasks.d/W1-T3232-torn.yaml\nA\tplan/tasks.d/notes.md\n";
    }
    if (args[1] === "head:plan/tasks.d/W1-T3232-torn.yaml") throw new Error("unreadable");
    return "- id: W1-T3231\n  title: x\n";
  };
  const ids = introducedShardTaskIds({ baseSha: "base", headSha: "head", git });
  assert.deepEqual(ids, ["W1-T3231"], "the torn shard is skipped; the readable one is still read");

  // The diff is scoped to the shard directory and to ADDITIONS only — a MODIFIED shard is not an
  // introduction, and scoping it here is what keeps an ordinary plan edit out of this check.
  const diffArgs = calls.find((c) => c[0] === "diff")!;
  assert.ok(diffArgs.includes("--diff-filter=A"), "only additions count as introducing a record");
  assert.ok(diffArgs.includes("plan/tasks.d"), "scoped to the shard directory");
  assert.ok(diffArgs.includes("base...head"), "three-dot: what this branch added, not what main moved");
});
