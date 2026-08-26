import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decideAutoTriage, newFeedbackIdsOldestFirst, oldestFeedbackAgeMs, type AutoTriagePolicy } from "../src/lib/auto-triage.js";
import { evaluateRetroTrigger, saveMarker, type ShippedGithub } from "../src/lib/retro.js";
import { retroTriggerCheck } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2289 ──────────────────────────────────────────────────────────────────────────────────
//
// BOTH INTAKE RUNGS asked whether the FLEET needed work and neither asked how much was WAITING.
// `decideAutoTriage`'s trigger was `deferralPending || capacityUnfilled` — both describe THIS
// TICK's dispatch, not the feedback queue the rung exists to drain — and `evaluateRetroTrigger`'s
// was `mergesSinceMarker >= N || daysSinceMarker >= D` — both describe what the FLEET shipped,
// not what the retro itself still has to process. On 2026-08-25 sixteen operator-filed shards
// kept three lanes full for 33 hours; `decideAutoTriage` never fired once and 23 feedback entries
// sat unread, the oldest twenty days old. This file proves each trigger now also reads the DEPTH
// of its own input, widening (never replacing) what it already considered.
//
// W1-T2288 IS CITED, NOT RE-FILED (rationale (8)/note (x)): nothing here touches `shippedSince`,
// `gatherRuns` or `ownBranchOf` — the run-vs-merge counting cause is a different record.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const NOW = new Date("2026-08-25T12:00:00.000Z");
const POLICY: AutoTriagePolicy = { enabled: true, minIntervalMinutes: 15, maxPerDay: 24 };

/** THE INCIDENT SHAPE: three lanes full (`dispatchCount === laneBudget`), no deferral — the exact
 *  state `decideAutoTriage` could never distinguish from a healthy, fully-served fleet before this
 *  task, because neither existing signal can be made false by a growing backlog or true by one. */
const busyFleet = {
  policy: POLICY,
  deferralPending: false,
  dispatchCount: 3,
  laneBudget: 3,
  lockHeld: false,
  marker: { kind: "absent" as const },
  now: NOW,
};

// ── acceptance 1: each trigger can be declined by a shallow queue and admitted by a deep one ───

test("acceptance 1a — auto-triage: an EMPTY queue still declines on a busy-but-full fleet", () => {
  const d = decideAutoTriage({ ...busyFleet, candidates: [] });
  assert.equal(d.fire, false, "neither lane signal tripped, and the backlog is genuinely empty");
});

test("acceptance 1a — auto-triage: the SAME busy-but-full fleet, now with a nonempty queue, FIRES — the 2026-08-25 incident shape", () => {
  const d = decideAutoTriage({ ...busyFleet, candidates: ["fb-old", "fb-new"] });
  assert.equal(d.fire, true, "the depth of its own input must reach the decision even with both lane signals false");
  assert.equal((d as { feedbackId: string }).feedbackId, "fb-old", "still the oldest entry");
});

test("acceptance 1b — retro: below merges/days AND a shallow followups queue declines", () => {
  const now = new Date("2026-08-25T00:00:00.000Z");
  const markerTs = "2026-08-20T00:00:00.000Z"; // 5 days — under a 7-day daysThreshold
  const decision = evaluateRetroTrigger(3, markerTs, now, { mergesThreshold: 25, daysThreshold: 7 }, 0);
  assert.equal(decision.fire, false, "3 merges < 25, 5 days < 7, 0 followups pending");
});

test("acceptance 1b — retro: the SAME merges/days state, now with a deep followups queue, FIRES", () => {
  const now = new Date("2026-08-25T00:00:00.000Z");
  const markerTs = "2026-08-20T00:00:00.000Z";
  const decision = evaluateRetroTrigger(3, markerTs, now, { mergesThreshold: 25, daysThreshold: 7 }, 25);
  assert.equal(decision.fire, true, "the retro's own unharvested-followups depth admits a fire on its own");
  assert.equal((decision as { reason: string }).reason, "followups");
});

// ── acceptance 2: the auto-triage backlog is read off the SAME root the existing caller passes ─

test("acceptance 2 — the reservoir reader against an ABSENT plan/feedback dir (the config.root shape) answers empty, never throws", () => {
  const root = tmp("rmd-depth-badroot-");
  try {
    assert.deepEqual(newFeedbackIdsOldestFirst(root), [], "no plan/feedback dir here — must read empty, not throw");
    assert.equal(oldestFeedbackAgeMs(root, NOW), 0, "and the age reader agrees: nothing waiting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance 2 — the SAME reader against a real repoRoot-shaped plan/feedback dir finds real entries", () => {
  const root = tmp("rmd-depth-goodroot-");
  try {
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    writeFileSync(join(root, "plan", "feedback", "fb-old.yaml"), "id: fb-old\nts: 2026-08-05T22:35:38.000Z\nstatus: new\n");
    assert.deepEqual(newFeedbackIdsOldestFirst(root), ["fb-old"]);
    assert.ok(oldestFeedbackAgeMs(root, NOW) > 0, "a real entry has a real, nonzero age");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance 2 — run-task.ts's autoTriageCheck wires BOTH readers off repoRoot, never config.root", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const start = src.indexOf("export function autoTriageCheck(");
  const end = src.indexOf("export function buildRetroDaemonHooks(");
  assert.ok(start > 0 && end > start, "both anchors must be found, or this test proves nothing");
  const fn = src.slice(start, end);
  assert.match(fn, /candidates: newFeedbackIdsOldestFirst\(repoRoot\)/, "the count reader must read off repoRoot");
  assert.match(fn, /oldestCandidateAgeMs: oldestFeedbackAgeMs\(repoRoot, now\)/, "the age reader must read off the SAME repoRoot");
  assert.doesNotMatch(fn, /newFeedbackIdsOldestFirst\(config\.root\)/, "must never read the reservoir off config.root");
  assert.doesNotMatch(fn, /oldestFeedbackAgeMs\(config\.root/, "same rule for the age reader");
});

// ── acceptance 3: a deferred pairing / unfilled capacity still admit a fire on their own ───────
// (Candidates must be nonempty for ANY trigger to have something to fire on — that final "nothing
// to do" check is unrelated to and unchanged by this task. What acceptance 3 pins is that the
// TRIGGER gate itself still credits deferral/capacity, rather than requiring the new depth signal
// to be the one that admits it.)

test("acceptance 3 — a deferred pairing still admits a fire on its own, and is named as the trigger", () => {
  const d = decideAutoTriage({ ...busyFleet, deferralPending: true, candidates: ["fb-1"] });
  assert.equal(d.fire, true, "no existing trigger was removed by widening the OR");
  assert.match((d as { reason: string }).reason, /^a pairing deferred,/, "credited to deferral, not to depth");
});

test("acceptance 3 — unfilled capacity still admits a fire on its own, and is named as the trigger", () => {
  const d = decideAutoTriage({ ...busyFleet, dispatchCount: 0, laneBudget: 3, candidates: ["fb-1"] });
  assert.equal(d.fire, true);
  assert.match((d as { reason: string }).reason, /capacity went unfilled \(0\/3 lanes\)/, "credited to capacity, not to depth");
});

// ── acceptance 4: a depth refusal is named distinctly from a capacity/no-lane-budget refusal ───

test("acceptance 4 — the three refusal branches read as three distinct, independently-matchable substrings", () => {
  const noLanes = decideAutoTriage({ ...busyFleet, dispatchCount: 0, laneBudget: 0, candidates: [] });
  const lanesFilled = decideAutoTriage({ ...busyFleet, candidates: [] }); // dispatchCount === laneBudget === 3
  assert.equal(noLanes.fire, false);
  assert.equal(lanesFilled.fire, false);
  const rNoLanes = (noLanes as { reason: string }).reason;
  const rFilled = (lanesFilled as { reason: string }).reason;
  assert.match(rNoLanes, /no lane capacity to fill/);
  assert.match(rFilled, /filled all 3 available lane/);
  assert.match(rNoLanes, /no feedback is waiting at status: new/, "the depth branch is named too, even here");
  assert.match(rFilled, /no feedback is waiting at status: new/);
  assert.notEqual(rNoLanes, rFilled, "opposite lane conditions must never share a reason string");
});

// ── acceptance 5: the interval floor / daily cap still hold after a depth-admitted trigger ─────

test("acceptance 5 — a depth-admitted trigger still respects the interval floor", () => {
  const marker = { kind: "ok" as const, marker: { fires: [NOW.toISOString()] } };
  const d = decideAutoTriage({ ...busyFleet, candidates: ["fb-1"], marker, now: new Date(NOW.getTime() + 5 * 60_000) });
  assert.equal(d.fire, false, "5m since the last fire is inside the 15m floor, whatever the backlog says");
  assert.match((d as { reason: string }).reason, /since the last fire \(minInterval 15m\)/);
});

test("acceptance 5 — a depth-admitted trigger still respects the daily cap", () => {
  const fires = Array.from({ length: 24 }, (_, k) => new Date(NOW.getTime() - (61 + k * 55) * 60_000).toISOString());
  const d = decideAutoTriage({ ...busyFleet, candidates: ["fb-1"], marker: { kind: "ok", marker: { fires } }, now: NOW });
  assert.equal(d.fire, false, "24 fires already in the rolling window, whatever the backlog says");
  assert.match((d as { reason: string }).reason, /daily cap reached \(24\/24 in the last 24h\)/);
});

test("acceptance 5 — POSITIVE CONTROL: under both bounds, a depth-admitted trigger DOES fire", () => {
  // Without this, the two refusal tests above would pass against a rung that never fires at all.
  const d = decideAutoTriage({ ...busyFleet, candidates: ["fb-1"], marker: { kind: "absent" } });
  assert.equal(d.fire, true);
});

// ── acceptance 6: the age of the oldest waiting entry is a SEPARATE quantity from the count ────

test("acceptance 6 — identical candidate count, different oldest-entry age -> different fire reason text", () => {
  const shallowAge = decideAutoTriage({ ...busyFleet, candidates: ["fb-1"], oldestCandidateAgeMs: 2 * DAY_MS });
  const deepAge = decideAutoTriage({ ...busyFleet, candidates: ["fb-1"], oldestCandidateAgeMs: 20 * DAY_MS });
  assert.equal(shallowAge.fire, true);
  assert.equal(deepAge.fire, true);
  const rShallow = (shallowAge as { reason: string }).reason;
  const rDeep = (deepAge as { reason: string }).reason;
  assert.notEqual(rShallow, rDeep, "identical count, different age — the two numbers must not collapse into one");
  assert.match(rShallow, /oldest waiting 2\.0d/);
  assert.match(rDeep, /oldest waiting 20\.0d/);
  // ...and the COUNT portion is identical across both, proving age is not silently derived from it.
  assert.match(rShallow, /reached 1 at status: new/);
  assert.match(rDeep, /reached 1 at status: new/);
});

test("acceptance 6 — oldestFeedbackAgeMs and newFeedbackIdsOldestFirst read the SAME directory into two independent numbers", () => {
  const root = tmp("rmd-depth-age-");
  try {
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    const oldTs = new Date(NOW.getTime() - 20 * DAY_MS).toISOString();
    writeFileSync(join(root, "plan", "feedback", "fb-old.yaml"), `id: fb-old\nts: ${oldTs}\nstatus: new\n`);
    const ids = newFeedbackIdsOldestFirst(root);
    const age = oldestFeedbackAgeMs(root, NOW);
    assert.equal(ids.length, 1, "the COUNT");
    assert.ok(Math.abs(age - 20 * DAY_MS) < 60_000, `the AGE, independently — expected ~20 days, got ${age}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 7: the retro trigger reads its own depth from the parse it already performs ─────

test("acceptance 7 — retroTriggerCheck reads the ledger exactly ONCE, feeding both gatherRuns and mineFollowups", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const start = src.indexOf("export function retroTriggerCheck(");
  const end = src.indexOf("export function buildRetroDaemonHooks(");
  assert.ok(start > 0 && end > start, "both anchors must be found, or this test proves nothing");
  const fn = src.slice(start, end);
  const readCount = (fn.match(/readFileSync\(ledgerPath/g) ?? []).length;
  assert.equal(readCount, 1, "exactly one ledger read must feed both signals — never a second readFileSync");
  assert.match(fn, /mineFollowups\(records\)/, "mineFollowups must consume the SAME parsed records gatherRuns uses");
});

test("acceptance 7 — retroTriggerCheck fires reason=followups off real ledger rows, below both merges/days thresholds", () => {
  const root = tmp("rmd-depth-retro-followups-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const config: Config = { claudeBin: "/bin/true", root };
    const markerPath = join(root, "state", "last-retro.json");
    saveMarker(markerPath, { ts: "2026-08-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });

    // 25 unharvested `report.followups` candidates — the shipped mergesThreshold (25) is reused as
    // the followups floor by design (RetroTriggerPolicy.followupsThreshold's own doc: no new,
    // unmeasured policy number is invented for this task). No run.start/verdict rows at all, so
    // the MERGES signal credits zero and cannot be what fires this.
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(
        JSON.stringify({
          ts: "2026-08-20T06:00:00.000Z",
          run_id: `R${i}`,
          task_id: `T${i}`,
          step: "report.followups",
          entries: [{ type: "task", text: `distinct follow-up idea number ${i}, not a duplicate of the others` }],
        }),
      );
    }
    writeFileSync(join(root, "state", "ledger.ndjson"), lines.join("\n") + "\n");

    const now = new Date("2026-08-21T00:00:00.000Z"); // 1 day since marker — well under a 7-day daysThreshold
    const github: ShippedGithub = { findMergedByTrailer: () => null, headRefName: () => undefined, unavailable: () => undefined };
    const decision = retroTriggerCheck(now, { config, github });

    assert.ok(decision, "a healthy gateway and a readable marker must evaluate, never skip");
    assert.equal(decision.mergesSinceMarker, 0, "no merges credited — the merges signal is not what fired this");
    assert.equal(decision.fire, true);
    assert.equal((decision as { reason: string }).reason, "followups");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 8: no rung files a task or mints an id; nothing expires a feedback entry ────────

test("acceptance 8 — decideAutoTriage's source contains no task-filing, id-minting, or filesystem-write call", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "auto-triage.ts"), "utf8");
  const start = src.indexOf("export function decideAutoTriage(");
  const end = src.indexOf("\nfunction feedbackEntriesOldestFirst(");
  assert.ok(start > 0 && end > start, "both anchors must be found, or this test proves nothing");
  const fn = src.slice(start, end);
  assert.doesNotMatch(fn, /writeFileSync|unlinkSync|rmSync|mintTaskId|reserveTaskId|fileTask/i);
});

test("acceptance 8 — evaluateRetroTrigger's source contains no task-filing, id-minting, or filesystem-write call", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "retro.ts"), "utf8");
  const start = src.indexOf("export function evaluateRetroTrigger(");
  const end = src.indexOf("export interface RetroIntegrityResult");
  assert.ok(start > 0 && end > start, "both anchors must be found, or this test proves nothing");
  const fn = src.slice(start, end);
  assert.doesNotMatch(fn, /writeFileSync|unlinkSync|rmSync|mintTaskId|reserveTaskId|fileTask/i);
});

test("acceptance 8 — a twenty-day-old feedback entry is never expired out of the reservoir by the depth read itself", () => {
  const root = tmp("rmd-depth-noexpire-");
  try {
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    const veryOldTs = new Date(NOW.getTime() - 60 * DAY_MS).toISOString(); // far past any plausible bound
    writeFileSync(join(root, "plan", "feedback", "fb-ancient.yaml"), `id: fb-ancient\nts: ${veryOldTs}\nstatus: new\n`);
    assert.deepEqual(newFeedbackIdsOldestFirst(root), ["fb-ancient"], "still present — age is read, never used to filter it out");
    // ...and the file on disk is untouched, byte for byte.
    const bytes = readFileSync(join(root, "plan", "feedback", "fb-ancient.yaml"), "utf8");
    assert.match(bytes, /status: new/, "the reader never rewrites the entry's own status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
