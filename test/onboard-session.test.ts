import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Inventory } from "../src/lib/onboard/inventory.js";
import {
  DEFAULT_GAP_RULES,
  generateGapQuestions,
  generateGoalElicitationQuestions,
  generateOnboardQuestions,
  GOAL_ELICITATION_QUESTIONS,
  loadOnboardSessionState,
  parseSessionArgs,
  realSessionFsDeps,
  runOnboardSession,
  SESSION_PHASE,
  SessionError,
  validateQuestion,
  validateQuestions,
  type OnboardQuestion,
  type SessionFsDeps,
} from "../src/lib/onboard/session.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fully-resolved fixture Inventory — every GitHub fact known, at least one language/CI
 *  system detected — so {@link generateGapQuestions} over it yields ZERO gap questions
 *  (the "a repo with everything resolved gets no gap questions" edge). */
function resolvedInventory(): Inventory {
  return {
    generatedAt: "2026-07-23T00:00:00.000Z",
    target: { owner: "acme-corp", repo: "widget-fixture" },
    languages: ["typescript"],
    buildSystems: ["npm"],
    ciSystems: ["github-actions"],
    docs: { readme: true },
    testSignals: ["node:test"],
    github: { repoExists: true, defaultBranch: "main", branchProtected: true, openIssueCount: 3, milestoneCount: 1 },
  };
}

/** A fixture Inventory with every gap this module knows about present — every
 *  {@link DEFAULT_GAP_RULES} row applies. */
function gappyInventory(): Inventory {
  return {
    generatedAt: "2026-07-23T00:00:00.000Z",
    target: { owner: "unknown", repo: "unknown" },
    languages: [],
    buildSystems: [],
    ciSystems: [],
    docs: {},
    testSignals: [],
    github: { repoExists: "unknown", defaultBranch: "unknown", branchProtected: "unknown", openIssueCount: "unknown", milestoneCount: "unknown" },
  };
}

function writeInventory(targetDir: string, inventory: Inventory): void {
  mkdirSync(join(targetDir, "plan", "onboarding"), { recursive: true });
  writeFileSync(join(targetDir, "plan", "onboarding", "inventory.json"), JSON.stringify(inventory, null, 2));
}

function validQuestion(over: Partial<OnboardQuestion> = {}): OnboardQuestion {
  return {
    id: "q1",
    decision: "which flavor to ship",
    question: "chocolate or vanilla?",
    candidateAnswers: ["chocolate", "vanilla"],
    impactIfWrong: "low",
    ...over,
  };
}

// ── Acceptance 1: questions conform to the §2 contract shape, name a decision + candidates ─

test("acceptance 1: validateQuestion accepts a well-formed question naming its decision and >=2 candidate answers", () => {
  assert.doesNotThrow(() => validateQuestion(validQuestion()));
});

test("acceptance 1: a generic question with no named decision fails generation (throws SessionError)", () => {
  assert.throws(
    () => validateQuestion(validQuestion({ decision: "" })),
    (e: unknown) => e instanceof SessionError && /does not name a decision/.test((e as Error).message),
  );
});

test("acceptance 1: a question with fewer than two candidate answers fails validation", () => {
  assert.throws(
    () => validateQuestion(validQuestion({ candidateAnswers: ["only one"] })),
    (e: unknown) => e instanceof SessionError && /at least two candidate answers/.test((e as Error).message),
  );
  assert.throws(() => validateQuestion(validQuestion({ candidateAnswers: [] })), SessionError);
});

test("acceptance 1: a question with no id, no question text, or a bad impact_if_wrong fails validation", () => {
  assert.throws(() => validateQuestion(validQuestion({ id: "" })), SessionError);
  assert.throws(() => validateQuestion(validQuestion({ question: "  " })), SessionError);
  assert.throws(() => validateQuestion(validQuestion({ impactIfWrong: "high" as never })), SessionError);
});

test("acceptance 1: validateQuestions rejects a duplicate id across an otherwise-valid set", () => {
  assert.throws(
    () => validateQuestions([validQuestion({ id: "dup" }), validQuestion({ id: "dup" })]),
    (e: unknown) => e instanceof SessionError && /duplicate onboard question id/.test((e as Error).message),
  );
});

test("acceptance 1: generateGapQuestions yields one question per applicable DEFAULT_GAP_RULES row, all valid", () => {
  // gap-github-facts (repoExists unknown) and gap-branch-protection are mutually exclusive
  // by design (asking about branch protection when the repo's own existence is unresolved
  // would be a redundant second question) — a fully-unknown inventory applies 3 of the 4
  // rows: github-facts, ci-systems, languages.
  const questions = generateGapQuestions(gappyInventory());
  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((q) => q.id).sort(),
    ["gap-ci-systems", "gap-github-facts", "gap-languages"],
  );
  assert.doesNotThrow(() => validateQuestions(questions));
  for (const q of questions) assert.ok(q.decision && q.candidateAnswers.length >= 2, `question ${q.id} names a decision + candidates`);
});

test("acceptance 1: gap-branch-protection fires (and gap-github-facts does not) once the repo itself is resolved but branch protection is not", () => {
  const inventory: Inventory = {
    ...gappyInventory(),
    github: { repoExists: true, defaultBranch: "main", branchProtected: "unknown", openIssueCount: 0, milestoneCount: 0 },
  };
  const questions = generateGapQuestions(inventory);
  assert.deepEqual(
    questions.map((q) => q.id).sort(),
    ["gap-branch-protection", "gap-ci-systems", "gap-languages"],
  );
});

test("acceptance 1: DEFAULT_GAP_RULES covers all four rows across the two mutually-exclusive GitHub-gap fixtures", () => {
  const idsWhenRepoUnknown = new Set(generateGapQuestions(gappyInventory()).map((q) => q.id));
  const idsWhenRepoResolved = new Set(
    generateGapQuestions({
      ...gappyInventory(),
      github: { repoExists: true, defaultBranch: "main", branchProtected: "unknown", openIssueCount: 0, milestoneCount: 0 },
    }).map((q) => q.id),
  );
  const union = new Set([...idsWhenRepoUnknown, ...idsWhenRepoResolved]);
  assert.equal(union.size, DEFAULT_GAP_RULES.length);
});

test("acceptance 1: generateGapQuestions yields nothing for a fully-resolved inventory — no padded/generic questions", () => {
  assert.deepEqual(generateGapQuestions(resolvedInventory()), []);
});

test("acceptance 1: generateGoalElicitationQuestions returns the fixed elicitation set, every entry valid, and never mutates the shared constant", () => {
  const questions = generateGoalElicitationQuestions();
  assert.equal(questions.length, GOAL_ELICITATION_QUESTIONS.length);
  assert.doesNotThrow(() => validateQuestions(questions));
  questions[0]!.candidateAnswers.push("mutated");
  assert.notEqual(GOAL_ELICITATION_QUESTIONS[0]!.candidateAnswers.length, questions[0]!.candidateAnswers.length);
});

test("acceptance 1: generateOnboardQuestions from the fixture findings (a gappy inventory) validates against the contract shape end to end", () => {
  const questions = generateOnboardQuestions(gappyInventory());
  assert.equal(questions.length, 3 + GOAL_ELICITATION_QUESTIONS.length);
  // every id is unique and every question names a decision + >=2 candidates (re-asserts the
  // full contract over the GENERATED set, not just the two sources independently).
  const ids = new Set(questions.map((q) => q.id));
  assert.equal(ids.size, questions.length);
  for (const q of questions) {
    assert.ok(q.decision.trim().length > 0);
    assert.ok(q.candidateAnswers.length >= 2);
  }
});

// ── Acceptance 2: answers are ledgered with provenance ──────────────────────────────────

test("acceptance 2: an answered session writes answers.json and one matching onboard.answered ledger line per answer", async () => {
  const targetDir = tmpRoot("rmd-onboard-session-answered-");
  writeInventory(targetDir, gappyInventory());

  const questions = generateOnboardQuestions(gappyInventory());
  const canned = new Map(questions.map((q, i) => [q.id, `answer-${i}`]));

  const result = await runOnboardSession(targetDir, {
    fs: realSessionFsDeps,
    ask: async (q) => canned.get(q.id)!,
  });

  assert.equal(result.newlyAnswered.length, questions.length);
  assert.equal(result.unanswered.length, 0);

  const answersOnDisk = JSON.parse(readFileSync(result.answersPath, "utf8")) as Record<string, { answer: string; decision: string; question: string }>;
  assert.equal(Object.keys(answersOnDisk).length, questions.length);
  for (const q of questions) {
    assert.equal(answersOnDisk[q.id]!.answer, canned.get(q.id));
    assert.equal(answersOnDisk[q.id]!.decision, q.decision);
  }

  const ledgerLines = readFileSync(result.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledgerLines.length, questions.length, "append-only: one ledger line per answer");
  for (const line of ledgerLines) {
    assert.equal(line.step, "onboard.answered");
    assert.ok(typeof line.ts === "string" && line.ts.length > 0);
    assert.ok(answersOnDisk[line.id], "every ledger line's id resolves to a written answer (provenance)");
    assert.equal(line.answer, answersOnDisk[line.id].answer);
  }
});

test("acceptance 2: a blank reply is never recorded as an answer (skipped, not ledgered)", async () => {
  const targetDir = tmpRoot("rmd-onboard-session-blank-");
  writeInventory(targetDir, gappyInventory());

  const result = await runOnboardSession(targetDir, { fs: realSessionFsDeps, ask: async () => "   " });

  assert.equal(result.newlyAnswered.length, 0);
  assert.equal(result.unanswered.length, generateOnboardQuestions(gappyInventory()).length);
});

// ── Acceptance 3: the session is resumable ──────────────────────────────────────────────

test("acceptance 3: a second invocation with partial answers re-presents ONLY the unanswered set", async () => {
  const targetDir = tmpRoot("rmd-onboard-session-resume-");
  writeInventory(targetDir, gappyInventory());

  const allQuestions = generateOnboardQuestions(gappyInventory());
  const firstId = allQuestions[0]!.id;

  // First invocation: answer only the first question.
  const askedFirst: string[] = [];
  await runOnboardSession(targetDir, {
    fs: realSessionFsDeps,
    ask: async (q) => {
      askedFirst.push(q.id);
      return q.id === firstId ? "answered-first-round" : "";
    },
  });
  assert.deepEqual(askedFirst, allQuestions.map((q) => q.id), "first invocation is asked about every question once");

  // Second invocation: only the still-unanswered questions should be asked at all.
  const askedSecond: string[] = [];
  const result = await runOnboardSession(targetDir, {
    fs: realSessionFsDeps,
    ask: async (q) => {
      askedSecond.push(q.id);
      return "answered-second-round";
    },
  });

  assert.ok(!askedSecond.includes(firstId), "the already-answered question is never re-presented");
  assert.equal(askedSecond.length, allQuestions.length - 1);
  assert.equal(result.unanswered.length, 0);
  assert.equal(result.answers[firstId]!.answer, "answered-first-round", "the first round's answer survives, never overwritten");
});

test("acceptance 3: loadOnboardSessionState previews the unanswered backlog without ever calling ask", () => {
  const targetDir = tmpRoot("rmd-onboard-session-preview-");
  writeInventory(targetDir, gappyInventory());
  const state = loadOnboardSessionState(targetDir);
  assert.equal(state.unanswered.length, state.questions.length);
  assert.deepEqual(state.answers, {});
});

// ── Prerequisite / error-path discipline ────────────────────────────────────────────────

test("runOnboardSession refuses (throws SessionError) when the phase-1 inventory artifact is missing", async () => {
  const targetDir = tmpRoot("rmd-onboard-session-no-inventory-");
  await assert.rejects(
    () => runOnboardSession(targetDir, { ask: async () => "x" }),
    (e: unknown) => e instanceof SessionError && /--phase inventory/.test((e as Error).message),
  );
});

test("runOnboardSession refuses when answers.json exists but is not valid JSON — never silently overwritten as 'nothing answered'", async () => {
  const targetDir = tmpRoot("rmd-onboard-session-bad-answers-");
  writeInventory(targetDir, gappyInventory());
  mkdirSync(join(targetDir, "plan", "onboarding"), { recursive: true });
  writeFileSync(join(targetDir, "plan", "onboarding", "answers.json"), "{not json");

  await assert.rejects(
    () => runOnboardSession(targetDir, { ask: async () => "x" }),
    (e: unknown) => e instanceof SessionError && /not valid JSON/.test((e as Error).message),
  );
});

test("SessionError carries the standard Error name", () => {
  assert.equal(new SessionError("x").name, "SessionError");
});

// ── CLI arg parsing (pure) ───────────────────────────────────────────────────────────────

test("parseSessionArgs requires <target-dir> as the first positional argument", () => {
  const result = parseSessionArgs(["--phase", "session"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /<target-dir> is required/);
});

test("parseSessionArgs requires --phase to be exactly \"session\"", () => {
  const result = parseSessionArgs(["/some/dir", "--phase", "inventory"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /--phase must be "session"/);
});

test("parseSessionArgs rejects an unrecognized flag", () => {
  const result = parseSessionArgs(["/some/dir", "--phase", "session", "--bogus"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unrecognized argument/);
});

test("parseSessionArgs accepts the target dir + --phase session", () => {
  const result = parseSessionArgs(["/some/dir", "--phase", "session"]);
  assert.deepEqual(result, { ok: true, args: { targetDir: "/some/dir" } });
});

test("SESSION_PHASE is the literal \"session\"", () => {
  assert.equal(SESSION_PHASE, "session");
});

// ── Injected fs deps sanity (mirrors onboard-recon.test.ts's own realReconFsDeps checks) ──

test("realSessionFsDeps round-trips a write/read/rename through a real tmp dir", () => {
  const dir = tmpRoot("rmd-onboard-session-fsdeps-");
  const deps: SessionFsDeps = realSessionFsDeps;
  const tmpPath = join(dir, "x.tmp");
  const finalPath = join(dir, "x.json");
  deps.mkdirSync(dir, { recursive: true });
  deps.writeFileSync(tmpPath, "{}");
  deps.renameSync(tmpPath, finalPath);
  assert.equal(deps.existsSync(finalPath), true);
  assert.equal(deps.readFileSync(finalPath), "{}");
  deps.appendFileSync(finalPath, "\nmore");
  assert.equal(deps.readFileSync(finalPath), "{}\nmore");
});
