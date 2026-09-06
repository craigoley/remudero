import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertLintClean,
  deferredFollowUpViolations,
  DEFERRED_FOLLOW_UP_LEXICON,
  FILED_TASK_ID_IN_TEXT_RE,
  lintTask,
  sentenceAround,
} from "../src/lib/task-linter.js";
import { loadPlan, type Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture (mirrors test/task-linter.test.ts's own `task()`
 *  helper) — `files:`/the in-scope proof keep every OTHER check silent, so a test here isolates
 *  `deferredFollowUpViolations` and its wiring, never some unrelated check's opinion. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

// ── ACCEPTANCE 1: a deferral naming no filed id is reported, with the line quoted ──────────

test("ACCEPTANCE 1: 'lands in a follow-up' with no filed id is reported, quoting the exact sentence", () => {
  const t = task({
    id: "T-FOLLOWUP-NO-ID",
    rationale:
      "The wiring step is out of scope for this PR. The remainder of this work lands in a follow-up. " +
      "Nothing else in this rationale is relevant.",
  });
  const violations = deferredFollowUpViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, "deferred-follow-up");
  assert.equal(violations[0].severity, "warn");
  assert.match(violations[0].message, /The remainder of this work lands in a follow-up\./);
  // The line quoted is the SENTENCE, not the whole rationale blob — the sentence before/after is absent.
  assert.doesNotMatch(violations[0].message, /out of scope for this PR/);
  assert.doesNotMatch(violations[0].message, /Nothing else in this rationale/);
});

test("ACCEPTANCE 1: 'left to a second PR' with no filed id is reported, quoting the exact sentence", () => {
  const t = task({
    id: "T-SECONDPR-NO-ID",
    rationale: "The CI wiring is left to a second PR. That second PR does not exist yet.",
  });
  const violations = deferredFollowUpViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, "warn");
  assert.match(violations[0].message, /The CI wiring is left to a second PR\./);
});

test("ACCEPTANCE 1: fires from `note:` and `title:` too, not only `rationale:`", () => {
  const inNote = task({ id: "T-NOTE", note: "Follow-on validation is deferred to a follow-up." });
  assert.equal(deferredFollowUpViolations(inNote).length, 1);
  const inTitle = task({ id: "T-TITLE", title: "the second half ships in a follow-up" });
  assert.equal(deferredFollowUpViolations(inTitle).length, 1);
});

// ── ACCEPTANCE 2: a deferral naming a filed id is silent ───────────────────────────────────

test("ACCEPTANCE 2: 'lands in a follow-up (W1-T9001)' is silent — the id completes the deferral", () => {
  const t = task({
    id: "T-FOLLOWUP-WITH-ID",
    rationale: "The remainder of this work lands in a follow-up, filed as W1-T9001.",
  });
  assert.deepEqual(deferredFollowUpViolations(t), []);
});

test("ACCEPTANCE 2: 'left to a second PR (W1-T9002)' is silent — the id completes the deferral", () => {
  const t = task({
    id: "T-SECONDPR-WITH-ID",
    rationale: "The CI wiring is left to a second PR, W1-T9002, already queued.",
  });
  assert.deepEqual(deferredFollowUpViolations(t), []);
});

test("ACCEPTANCE 2: the id must be in the SAME sentence — a later sentence naming one does not clear an earlier bare deferral", () => {
  const t = task({
    id: "T-ID-WRONG-SENTENCE",
    rationale: "The remainder of this work lands in a follow-up. Unrelated to that, see W1-T1 for context.",
  });
  const violations = deferredFollowUpViolations(t);
  assert.equal(violations.length, 1, "the id in the SECOND sentence must not silence the deferral in the first");
});

// ── ACCEPTANCE 3: no exit code changes on any input — report-only by construction ──────────

test("ACCEPTANCE 3: every violation this check emits is severity 'warn', never 'block'", () => {
  const fixtures = [
    task({ id: "T-W1", rationale: "The remainder of this work lands in a follow-up." }),
    task({ id: "T-W2", rationale: "The CI wiring is left to a second PR." }),
    task({ id: "T-W3", title: "ships in a follow-up", note: "also deferred to a follow-up" }),
  ];
  for (const t of fixtures) {
    const violations = deferredFollowUpViolations(t);
    assert.ok(violations.length > 0, `expected ${t.id} to trip the check`);
    for (const v of violations) assert.equal(v.severity, "warn");
  }
});

test("ACCEPTANCE 3: lintTask.ok and assertLintClean are UNCHANGED by adding an unfiled deferral to an otherwise-clean task", () => {
  const clean = task({ id: "T-CLEAN" });
  const withDeferral = task({
    id: "T-CLEAN-PLUS-DEFERRAL",
    rationale: "The remainder of this work lands in a follow-up.",
  });
  const cleanResult = lintTask(clean);
  const deferralResult = lintTask(withDeferral);
  assert.equal(cleanResult.ok, true);
  assert.equal(deferralResult.ok, true, "a warn-only hit must never flip lintTask.ok to false");
  assert.ok(
    deferralResult.violations.some((v) => v.check === "deferred-follow-up"),
    "the deferral must actually be reported, not silently dropped",
  );
  assert.doesNotThrow(() => assertLintClean(clean));
  assert.doesNotThrow(
    () => assertLintClean(withDeferral),
    "assertLintClean only throws on a BLOCK; this check can never produce one",
  );
});

test("ACCEPTANCE 3: no knob anywhere demotes or promotes this check — the lexicon table itself carries no severity field", () => {
  // DeferredFollowUpMatcher has no `severity`/`block`/`fatal` field to flip; severity is hard-coded
  // "warn" at every push site in deferredFollowUpViolations, so there is no configuration surface
  // that could turn this into a blocking check without editing the function body itself.
  for (const entry of DEFERRED_FOLLOW_UP_LEXICON) {
    assert.ok(!("severity" in entry), `lexicon row "${entry.category}" must carry no severity knob`);
  }
});

// ── ACCEPTANCE 4: the hit count across the tracked shard corpus at head is MEASURED ────────

const REAL_PLAN = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

test("ACCEPTANCE 4: the detector's hit rate across the real, tracked plan corpus is measured and stated", () => {
  const hits = REAL_PLAN.tasks.filter((t) => deferredFollowUpViolations(t).length > 0);
  const total = REAL_PLAN.tasks.length;
  const rate = hits.length / total;
  // STATED, not assumed — printed so a human reviewing CI output sees the real, current number
  // rather than trusting a claim in this file's prose.
  // eslint-disable-next-line no-console
  console.log(
    `deferred-follow-up: ${hits.length}/${total} tracked shards (${(rate * 100).toFixed(2)}%) hit the ` +
      `detector: ${hits.map((t) => t.id).join(", ")}`,
  );
  assert.ok(total > 0, "the corpus must actually load — a zero-task plan would make this measurement vacuous");
  // THE FALSE-POSITIVE RATE IS THE MEASUREMENT THIS CHECK OWES (this task's own rationale): if the
  // detector fired on a large fraction of well-formed shards it would be noise, not signal, and
  // narrowing the pattern would be the deliverable instead of shipping it. Measured at this head:
  // 8 of 1429 tracked tasks (0.56%). 5% is a generous ceiling — an order of magnitude above the
  // measured rate — so this assertion fails loudly if a future lexicon change regresses precision,
  // without being so tight that ordinary corpus growth flakes it.
  assert.ok(
    rate < 0.05,
    `detector fired on ${(rate * 100).toFixed(2)}% of the tracked corpus — that is noise, not signal; narrow the lexicon`,
  );
  // And the detector is not a dead check either: it must actually fire on SOME real shard, proving
  // this isn't a check that only ever passes on synthetic fixtures.
  assert.ok(hits.length > 0, "expected the detector to fire on at least one real, tracked shard");
});

// ── ACCEPTANCE 5: a shard describing excluded scope, without promising a later PR, is silent ──

test("ACCEPTANCE 5: describing permanently-excluded scope (no promised PR) is silent", () => {
  const t = task({
    id: "T-EXCLUDED-SCOPE",
    rationale:
      "Tier three is explicitly out of scope for this shard; that exclusion is permanent, not deferred, " +
      "and no further PR follows it.",
  });
  assert.deepEqual(deferredFollowUpViolations(t), []);
});

test("ACCEPTANCE 5: real corpus — W1-T470 (this task's own plan_refs) splits into two PRs within " +
  "ITSELF and excludes a sibling rule's scope, naming neither an unfiled 'second PR' nor 'follow-up' " +
  "in the flagged shape, and stays silent", () => {
  const w1t470 = REAL_PLAN.tasks.find((t) => t.id === "W1-T470");
  assert.ok(w1t470, "expected W1-T470 in the tracked plan — it is this task's own plan_refs target");
  assert.deepEqual(deferredFollowUpViolations(w1t470 as Task), []);
});

test("ACCEPTANCE 5: a bare mention of 'follow-up' with no governing preposition does not fire (precision, not recall)", () => {
  const t = task({
    id: "T-BARE-MENTION",
    rationale: "No follow-up task exists for this yet, and none is promised — the note simply says so.",
  });
  assert.deepEqual(deferredFollowUpViolations(t), []);
});

// ── Supporting unit coverage for the two exported helpers this check is built from ─────────

test("FILED_TASK_ID_IN_TEXT_RE: matches an id, including the sub-shard letter-suffix shape already live in this plan", () => {
  assert.match("filed as W1-T9001", FILED_TASK_ID_IN_TEXT_RE);
  assert.match("see W1-T12a for context", FILED_TASK_ID_IN_TEXT_RE);
  assert.doesNotMatch("no id here at all", FILED_TASK_ID_IN_TEXT_RE);
});

test("sentenceAround: bounds on sentence-final punctuation and collapses wrapped whitespace to single spaces", () => {
  const text = "First sentence here.\nSecond sentence\nwraps across two lines. Third sentence.";
  const idx = text.indexOf("Second");
  assert.equal(sentenceAround(text, idx), "Second sentence wraps across two lines.");
});
