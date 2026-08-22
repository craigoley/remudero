import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  armRunIdFromLedger,
  disposeDisarm,
  classifyDisarmFailure,
  disarmAutoMerge,
  disarmOutcomeWithdrawn,
  lostRaceEscalation,
  mergeShaNow,
} from "../src/run-task.js";

// ── W1-T1215: a risk-refused change MERGED UNATTENDED, and everything reported success ──────
//
// #2506: review success 16:12:25Z, the SWEEP armed 16:12:27Z, merged 16:12:52Z, the risk judge
// escalated 16:12:59Z, and the withdrawal it fired arrived after the merge it was withdrawing.
// GitHub answered `Can't disable auto-merge for this pull request.` — THE SAME STRING it returns
// for a PR that was never armed — so the failure classified benign, the return value was discarded
// at two of three call sites, and `automerge.disarmed` was logged unconditionally beside it.
//
// `runTask`'s arm ordering is NOT the subject: W1-T975 already deferred it, and these two calls
// were KEPT deliberately as best-effort defences against the documented residual sweep race. They
// lost. This suite pins that LOSING IS LOUD: the outcome is followed, the one ambiguous message is
// split on a FACT rather than a guess, and a refused verdict that merged escalates HARD_STOP.

const REAL_MESSAGE =
  "GraphQL: Can't disable auto-merge for this pull request. (disablePullRequestAutoMerge)";

/** A `disableAuto` that always throws, carrying `stderr` exactly as `execFileSync` does. */
function throwingDisableAuto(stderr: string): (prUrl: string) => void {
  return () => {
    throw Object.assign(new Error("gh exited 1"), { stderr });
  };
}

// ── acceptance 2 + 3: the one message, split on a fact; the unknown still fails closed ───────

test("classifyDisarmFailure: the SAME GitHub message means not-armed when the PR is unmerged and lost-race when it is merged", () => {
  assert.equal(
    classifyDisarmFailure(REAL_MESSAGE, false),
    "not-armed",
    "#2234's reading — nothing was armed, nothing to withdraw, benign",
  );
  assert.equal(
    classifyDisarmFailure(REAL_MESSAGE, true),
    "lost-race",
    "#2506's reading — the SAME string, but the PR had already merged",
  );
  // The falsifier that matters: one string must not decide this on its own.
  assert.notEqual(
    classifyDisarmFailure(REAL_MESSAGE, true),
    classifyDisarmFailure(REAL_MESSAGE, false),
    "the message alone cannot be what tells these two apart",
  );
});

test("classifyDisarmFailure: an unasked merge state reads exactly as it did before this task", () => {
  assert.equal(
    classifyDisarmFailure(REAL_MESSAGE),
    "not-armed",
    "undefined is 'not asked', not 'asked and false' — every pre-existing caller keeps its meaning",
  );
});

test("classifyDisarmFailure: an unrecognised failure fails towards failed even when the PR IS merged", () => {
  assert.equal(classifyDisarmFailure("connection reset by peer", false), "failed");
  assert.equal(
    classifyDisarmFailure("connection reset by peer", true),
    "failed",
    "merged-ness must not upgrade an unrecognised error into a lost race — the message gate comes first",
  );
});

// ── acceptance 1: a refused withdrawal is never recorded as a completed one ──────────────────

test("disarmAutoMerge: a refusal on an ALREADY-MERGED pull request returns lost-race, and lost-race is not a withdrawal", () => {
  const said: string[] = [];
  const outcome = disarmAutoMerge("https://github.com/o/r/pull/2506", {
    disableAuto: throwingDisableAuto(REAL_MESSAGE),
    say: (m) => said.push(m),
    isMerged: () => true,
  });
  assert.equal(outcome, "lost-race");
  assert.equal(
    disarmOutcomeWithdrawn(outcome),
    false,
    "the one predicate every call site branches on must refuse to call this a withdrawal",
  );
  assert.ok(said.some((m) => m.includes("automerge.disarm_failed")), "the failure is still narrated");
});

test("disarmAutoMerge: the same refusal on an UNMERGED pull request stays not-armed and stays benign", () => {
  const outcome = disarmAutoMerge("https://github.com/o/r/pull/2234", {
    disableAuto: throwingDisableAuto(REAL_MESSAGE),
    say: () => {},
    isMerged: () => false,
  });
  assert.equal(outcome, "not-armed");
  assert.equal(disarmOutcomeWithdrawn(outcome), false, "not-armed was never a withdrawal either");
});

// ── acceptance 7: the ordinary path costs nothing extra ──────────────────────────────────────

test("disarmAutoMerge: a SUCCESSFUL withdrawal never consults isMerged — no extra request on the ordinary path", () => {
  let isMergedCalls = 0;
  const outcome = disarmAutoMerge("https://github.com/o/r/pull/1", {
    disableAuto: () => {},
    say: () => {},
    isMerged: () => {
      isMergedCalls += 1;
      return true;
    },
  });
  assert.equal(outcome, "disarmed");
  assert.equal(disarmOutcomeWithdrawn(outcome), true);
  assert.equal(isMergedCalls, 0, "the seam is failure-path only — the success path must not pay for it");
});

test("disarmAutoMerge: a caller that omits isMerged keeps the pre-W1-T1215 classification", () => {
  const outcome = disarmAutoMerge("https://github.com/o/r/pull/1", {
    disableAuto: throwingDisableAuto(REAL_MESSAGE),
    say: () => {},
  });
  assert.equal(outcome, "not-armed", "omitting the optional seam must not change any existing fixture's answer");
});

// ── acceptance 4 + 5: the escalation, its class and its payload ──────────────────────────────

test("lostRaceEscalation: a refused verdict that merged anyway escalates HARD_STOP, not BLOCKED", () => {
  const esc = lostRaceEscalation({
    prUrl: "https://github.com/craigoley/remudero/pull/2506",
    taskId: "W1-T1206",
    runId: "RUN-1",
    refusal: "risk judge ESCALATED (high, confidence 0.85)",
  });
  assert.equal(
    esc.class,
    "HARD_STOP",
    "BLOCKED says 'cannot proceed until someone acts'; this already proceeded, and only HARD_STOP pages",
  );
  assert.match(esc.summary, /MERGED UNATTENDED/);
});

test("lostRaceEscalation: the escalation carries the merge sha, the confidence, the judge's reasons and the arm's run id", () => {
  const esc = lostRaceEscalation({
    prUrl: "https://github.com/craigoley/remudero/pull/2506",
    taskId: "W1-T1206",
    runId: "RUN-1",
    refusal: "risk judge ESCALATED (high, confidence 0.85)",
    mergeSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    confidence: 0.85,
    reasons: ["touches the clock-sweep effect table", "no falsifier for the added arm"],
    armRunId: "DAEMON-9",
  });
  assert.match(esc.detail, /deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/, "the merge sha a ruling would reason about");
  assert.match(esc.detail, /0\.85/, "the judge's own confidence");
  assert.match(esc.detail, /touches the clock-sweep effect table/, "the judge's own reasons, verbatim");
  assert.match(esc.detail, /no falsifier for the added arm/);
  assert.match(esc.detail, /DAEMON-9/, "WHICH lane armed it");
  assert.match(esc.detail, /risk judge ESCALATED \(high, confidence 0\.85\)/, "the refusing verdict itself");
});

test("lostRaceEscalation: an unresolvable merge sha and an unattributed arm are SAID, never silently omitted", () => {
  const esc = lostRaceEscalation({
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "T",
    runId: "R",
    refusal: "capped verdict refused auto-merge",
  });
  assert.match(esc.detail, /unresolved/, "an absent sha reads as unresolved rather than as a blank");
  assert.match(esc.detail, /unattributed/, "an absent arm row reads as unattributed rather than asserting a lane");
  assert.match(esc.detail, /none recorded/, "absent reasons say so");
});

// ── acceptance 6: it acts on nothing ─────────────────────────────────────────────────────────

test("lostRaceEscalation: nothing reverts, reopens or force-pushes — every option is a PERSON's action", () => {
  const esc = lostRaceEscalation({
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "T",
    runId: "R",
    refusal: "capped verdict refused auto-merge",
    mergeSha: "abc123",
  });
  assert.match(esc.detail, /NOTHING WAS REVERTED, REOPENED OR FORCE-PUSHED/);
  assert.ok(esc.options.length > 0, "an escalation with no options is unactionable");
  for (const o of esc.options) {
    assert.doesNotMatch(
      `${o.label} ${o.detail}`,
      /\b(automatically|on its own behalf)\b/i,
      `option ${o.label} must not promise the fleet will act`,
    );
  }
  assert.ok(
    esc.options.some((o) => /by-hand|manually|yourself/i.test(`${o.label} ${o.detail}`)),
    "the back-out option must name the operator as the actor",
  );
});

test("STRUCTURAL: neither lost-race call site performs a revert, a reopen or a force-push", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const idx = src.indexOf("export function lostRaceEscalation");
  assert.ok(idx > 0, "the helper must still exist under this name");
  // Every site that reacts to a lost race routes through this one helper, so proving the helper
  // and its call sites name no mutating verb is the whole surface.
  for (const [, call] of [...src.matchAll(/lostRaceEscalation\(\{[\s\S]{0,700}?\}\)/g)].entries()) {
    assert.doesNotMatch(String(call), /revert|reopen|force-push|--force/i, "a lost-race call site must not mutate");
  }
});

// ── the arm attribution and the merge sha readers ────────────────────────────────────────────

test("armRunIdFromLedger: the NEWEST automerge.armed row for THIS pull request wins, and a foreign row is ignored", () => {
  const lines = [
    { step: "automerge.armed", pr_url: "https://github.com/o/r/pull/1", run_id: "OLD" },
    { step: "automerge.armed", pr_url: "https://github.com/o/r/pull/9", run_id: "OTHER-PR" },
    { step: "automerge.disarmed", pr_url: "https://github.com/o/r/pull/1", run_id: "NOT-AN-ARM" },
    { step: "automerge.armed", pr_url: "https://github.com/o/r/pull/1", run_id: "NEW" },
  ];
  assert.equal(armRunIdFromLedger(lines, "https://github.com/o/r/pull/1"), "NEW");
  assert.equal(
    armRunIdFromLedger([], "https://github.com/o/r/pull/1"),
    undefined,
    "no arm row means undefined, never a guessed lane",
  );
});

test("mergeShaNow: reads merge_commit_sha off the single-PR REST row, and never throws on a failed read", () => {
  assert.equal(
    mergeShaNow("https://github.com/o/r/pull/1", () => ({ merge_commit_sha: "cafebabe" })),
    "cafebabe",
  );
  assert.equal(
    mergeShaNow("https://github.com/o/r/pull/1", () => ({})),
    undefined,
    "an unmerged row has no sha and must not invent one",
  );
  assert.equal(
    mergeShaNow("https://github.com/o/r/pull/1", () => {
      throw new Error("rate limited");
    }),
    undefined,
    "this runs while an escalation is being built — it must never throw and mask the escalation",
  );
});

test("STRUCTURAL: all THREE disarmAutoMerge call sites follow the outcome — none logs automerge.disarmed unconditionally", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  // TWO sites call it directly (the capped/irreversible branch and the risk-judge escalate dep);
  // the THIRD, `withdrawArmIfVerdictRefuses`, routes through its injectable `deps.disarm` seam, so
  // it does not match a bare-name call and is asserted by that shape instead.
  // TWO sites hand the outcome straight to `disposeDisarm`, which owns the whole decision; the
  // THIRD, `withdrawArmIfVerdictRefuses`, routes through its injectable `deps.disarm` seam.
  const direct = [...src.matchAll(/disposeDisarm\(disarmAutoMerge\(prUrl\)/g)];
  assert.equal(direct.length, 2, `expected the two direct call sites to dispose their outcome, found ${direct.length}`);
  assert.match(
    src,
    /\(deps\.disarm \?\? disarmAutoMerge\)\(ctx\.prUrl\)/,
    "the third site still routes through its injectable seam",
  );

  // Every one of the three must CAPTURE the return — a bare `disarmAutoMerge(prUrl);` statement is
  // precisely the shape that let #2506 record a refused withdrawal as a completed one.
  const bare = [...src.matchAll(/^\s*disarmAutoMerge\(prUrl\);\s*$/gm)];
  assert.equal(bare.length, 0, `a bare disarmAutoMerge(...) statement discards the outcome (found ${bare.length})`);

  // And none may log the completed-withdrawal row without asking the predicate first.
  const unconditional = [...src.matchAll(/log\(\s*"automerge\.disarmed"/g)];
  assert.equal(
    unconditional.length,
    0,
    "automerge.disarmed must only ever be reached through disarmOutcomeWithdrawn(...)",
  );
  assert.equal(
    [...src.matchAll(/disarmOutcomeWithdrawn\(/g)].length >= 3,
    true,
    "each of the three sites branches on the one shared predicate",
  );
});

// ── disposeDisarm: the whole decision, where a test can reach it ──────────────────────────────

test("disposeDisarm: a completed withdrawal writes automerge.disarmed, escalates nothing, and reads nothing extra", () => {
  let mergeShaCalls = 0;
  let ledgerCalls = 0;
  const d = disposeDisarm("disarmed", {
    prUrl: "https://github.com/o/r/pull/1", taskId: "T", runId: "R",
    ledgerPath: "/nonexistent/ledger.ndjson", reason: "capped verdict refused auto-merge", refusal: "refused",
  }, {
    mergeSha: () => { mergeShaCalls += 1; return "x"; },
    ledgerLines: () => { ledgerCalls += 1; return []; },
  });
  assert.equal(d.step, "automerge.disarmed");
  assert.equal(d.escalation, undefined, "a completed withdrawal is not an incident");
  assert.equal(mergeShaCalls, 0, "the ordinary path must cost no extra request");
  assert.equal(ledgerCalls, 0, "the ordinary path must cost no ledger read");
});

test("disposeDisarm: a not-armed refusal is a disarm_skipped row and STILL escalates nothing", () => {
  const d = disposeDisarm("not-armed", {
    prUrl: "https://github.com/o/r/pull/1", taskId: "T", runId: "R",
    ledgerPath: "/nonexistent/ledger.ndjson", reason: "capped verdict refused auto-merge", refusal: "refused",
  }, { mergeSha: () => "x", ledgerLines: () => [] });
  assert.equal(d.step, "automerge.disarm_skipped", "the row must not assert a withdrawal that did not happen");
  assert.equal(d.escalation, undefined, "benign — nothing was armed, so nothing merged behind a refusal");
});

test("disposeDisarm: a LOST RACE is a disarm_skipped row AND a HARD_STOP escalation carrying the resolved facts", () => {
  const d = disposeDisarm("lost-race", {
    prUrl: "https://github.com/craigoley/remudero/pull/2506", taskId: "W1-T1206", runId: "RUN-1",
    ledgerPath: "/nonexistent/ledger.ndjson",
    reason: "risk judge escalated — auto-merge refused",
    refusal: "risk judge ESCALATED (high, confidence 0.85)",
    confidence: 0.85,
    reasons: ["touches the clock-sweep effect table"],
  }, {
    mergeSha: () => "feedfacefeedfacefeedfacefeedfacefeedface",
    ledgerLines: () => [{ step: "automerge.armed", pr_url: "https://github.com/craigoley/remudero/pull/2506", run_id: "DAEMON-7" }],
  });
  assert.equal(d.step, "automerge.disarm_skipped");
  assert.ok(d.escalation, "a refused verdict that merged anyway MUST escalate");
  assert.equal(d.escalation.class, "HARD_STOP");
  assert.match(d.escalation.detail, /feedfacefeedfacefeedfacefeedfacefeedface/, "the merge sha it resolved");
  assert.match(d.escalation.detail, /DAEMON-7/, "the arm's run id, read off the ledger it was given");
  assert.match(d.escalation.detail, /touches the clock-sweep effect table/, "the judge's reasons");
  assert.match(d.escalation.detail, /0\.85/);
});

test("disposeDisarm: an undefined outcome (a pre-signature fake) still reads as a withdrawal — no lane regresses", () => {
  const d = disposeDisarm(undefined, {
    prUrl: "https://github.com/o/r/pull/1", taskId: "T", runId: "R",
    ledgerPath: "/nonexistent/ledger.ndjson", reason: "r", refusal: "refused",
  });
  assert.equal(d.step, "automerge.disarmed");
  assert.equal(d.escalation, undefined);
});
