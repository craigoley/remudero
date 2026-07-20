import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideTriage,
  diffCitesFeedback,
  nonPlanFilesInDiff,
  parseTriageArgs,
  parseTriageVerdict,
  triageCommitMessage,
  triagePrompt,
  type TriageDecision,
} from "../src/lib/triage.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";

const ENTRY: FeedbackEntry = {
  id: "fb-1700000000000-abc123",
  ts: "2026-07-19T00:00:00.000Z",
  raw: "can we get a --dry-run flag on rmd triage",
  attachments: [],
  origin: "cli",
  status: "new",
  proposal_pr: null,
};

// ── parseTriageArgs ─────────────────────────────────────────────────────────

test("parseTriageArgs: a bare feedback id parses", () => {
  const parsed = parseTriageArgs(["fb-1700000000000-abc123"]);
  assert.deepEqual(parsed, { feedbackId: "fb-1700000000000-abc123" });
});

test("parseTriageArgs: no args fails loud", () => {
  const parsed = parseTriageArgs([]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /no feedback id given/);
});

test("parseTriageArgs: an unrecognized flag fails loud", () => {
  const parsed = parseTriageArgs(["fb-1", "--bogus"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /unrecognized flag '--bogus'/);
});

test("parseTriageArgs: extra positional arguments fail loud", () => {
  const parsed = parseTriageArgs(["fb-1", "fb-2"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /too many arguments/);
});

// ── triagePrompt ─────────────────────────────────────────────────────────────

test("triagePrompt: carries the feedback id, raw text, and all three verdict markers", () => {
  const prompt = triagePrompt(ENTRY, "TRIAGE-fb-1700000000000-abc123-1700000001000");
  assert.match(prompt, new RegExp(ENTRY.id));
  assert.match(prompt, /can we get a --dry-run flag/);
  assert.match(prompt, /ALREADY_DECIDED:/);
  assert.match(prompt, /AMBIGUOUS:/);
  assert.match(prompt, /PROPOSED:/);
  // No Bash tool ⇒ the worker must never be told to commit/push/PR itself.
  assert.doesNotMatch(prompt, /git push|gh pr create/);
});

test("triagePrompt: notes when there are no attachments and lists them when present", () => {
  assert.match(triagePrompt(ENTRY, "r1"), /attachments: \(none\)/);
  const withAttachment = { ...ENTRY, attachments: ["plan/feedback/attachments/fb-1/shot.png"] };
  assert.match(triagePrompt(withAttachment, "r1"), /attachments: plan\/feedback\/attachments\/fb-1\/shot\.png/);
});

// ── parseTriageVerdict ────────────────────────────────────────────────────────

test("parseTriageVerdict: ALREADY_DECIDED", () => {
  const v = parseTriageVerdict("Some reasoning here.\nALREADY_DECIDED: MASTER-PLAN.md §7B / PR #238");
  assert.deepEqual(v, { kind: "already_decided", citation: "MASTER-PLAN.md §7B / PR #238" });
});

test("parseTriageVerdict: AMBIGUOUS", () => {
  const v = parseTriageVerdict("AMBIGUOUS: does this want a CLI flag or a config default?");
  assert.deepEqual(v, { kind: "ambiguous", question: "does this want a CLI flag or a config default?" });
});

test("parseTriageVerdict: PROPOSED", () => {
  const v = parseTriageVerdict("PROPOSED: add W1-T200 (origin: feedback#fb-1) for the requested flag");
  assert.deepEqual(v, { kind: "proposed", summary: "add W1-T200 (origin: feedback#fb-1) for the requested flag" });
});

test("parseTriageVerdict: no marker anywhere returns null", () => {
  assert.equal(parseTriageVerdict("I looked around and did nothing in particular."), null);
});

test("parseTriageVerdict: a marker mentioned mid-sentence (not line-anchored) does not count", () => {
  assert.equal(parseTriageVerdict("The contract requires one of ALREADY_DECIDED: ..., not a real verdict."), null);
});

test("parseTriageVerdict: the LAST marker line wins when more than one appears", () => {
  const v = parseTriageVerdict("AMBIGUOUS: first guess\nOn reflection:\nPROPOSED: actually this is clear");
  assert.deepEqual(v, { kind: "proposed", summary: "actually this is clear" });
});

// ── decideTriage ──────────────────────────────────────────────────────────────

test("decideTriage: ALREADY_DECIDED with no file changes ⇒ no_task/rejected", () => {
  const d = decideTriage({ verdict: { kind: "already_decided", citation: "§7B / PR #238" }, changedFiles: [] });
  assert.deepEqual(d, { action: "no_task", status: "rejected", detail: "§7B / PR #238" });
});

test("decideTriage: AMBIGUOUS with no file changes ⇒ grill/grilling", () => {
  const d = decideTriage({ verdict: { kind: "ambiguous", question: "flag or config?" }, changedFiles: [] });
  assert.deepEqual(d, { action: "grill", status: "grilling", detail: "flag or config?" });
});

test("decideTriage: PROPOSED with plan file changes ⇒ propose/proposed", () => {
  const d = decideTriage({
    verdict: { kind: "proposed", summary: "add W1-T200" },
    changedFiles: ["plan/tasks.yaml"],
  });
  assert.deepEqual(d, { action: "propose", status: "proposed", detail: "add W1-T200", files: ["plan/tasks.yaml"] });
});

test("decideTriage: no verdict at all fails loud", () => {
  const d = decideTriage({ verdict: null, changedFiles: [] });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /no ALREADY_DECIDED/);
});

test("decideTriage: ALREADY_DECIDED but files WERE changed is an inconsistency ⇒ error", () => {
  const d = decideTriage({
    verdict: { kind: "already_decided", citation: "§7B" },
    changedFiles: ["plan/tasks.yaml"],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /ALREADY_DECIDED but files were changed/);
});

test("decideTriage: AMBIGUOUS but files WERE changed is an inconsistency ⇒ error", () => {
  const d = decideTriage({
    verdict: { kind: "ambiguous", question: "?" },
    changedFiles: ["plan/tasks.yaml"],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /AMBIGUOUS but files were changed/);
});

test("decideTriage: PROPOSED but NO files changed is an inconsistency ⇒ error", () => {
  const d = decideTriage({ verdict: { kind: "proposed", summary: "x" }, changedFiles: [] });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /no plan files were changed/);
});

test("decideTriage: any file outside plan/ fails loud regardless of verdict (the plan-only floor)", () => {
  const d = decideTriage({
    verdict: { kind: "proposed", summary: "x" },
    changedFiles: ["plan/tasks.yaml", "src/lib/triage.ts"],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /touched non-plan file\(s\): src\/lib\/triage\.ts/);
});

// ── nonPlanFilesInDiff / diffCitesFeedback ────────────────────────────────────

const PLAN_ONLY_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "index 111..222 100644",
  "--- a/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@ -1,2 +1,3 @@",
  "+- id: W1-T200",
  "+  origin: feedback#fb-1700000000000-abc123",
].join("\n");

const CODE_TOUCHING_DIFF = [
  PLAN_ONLY_DIFF,
  "diff --git a/src/lib/triage.ts b/src/lib/triage.ts",
  "--- a/src/lib/triage.ts",
  "+++ b/src/lib/triage.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

test("nonPlanFilesInDiff: a plan-only diff yields []", () => {
  assert.deepEqual(nonPlanFilesInDiff(PLAN_ONLY_DIFF), []);
});

test("nonPlanFilesInDiff: a diff touching src/ names it", () => {
  assert.deepEqual(nonPlanFilesInDiff(CODE_TOUCHING_DIFF), ["src/lib/triage.ts"]);
});

test("diffCitesFeedback: true when the diff carries the provenance token", () => {
  assert.equal(diffCitesFeedback(PLAN_ONLY_DIFF, "fb-1700000000000-abc123"), true);
});

test("diffCitesFeedback: false when the diff does not cite the feedback id", () => {
  assert.equal(diffCitesFeedback(PLAN_ONLY_DIFF, "fb-9999999999999-zzzzzz"), false);
});

// ── triageCommitMessage ───────────────────────────────────────────────────────

test("triageCommitMessage: no_task carries the Acceptance block + trailer, cites the id, no task claim", () => {
  const decision: TriageDecision = { action: "no_task", status: "rejected", detail: "§7B / PR #238" };
  const msg = triageCommitMessage({ decision, feedbackId: ENTRY.id, taskId: `TRIAGE-${ENTRY.id}` });
  assert.match(msg, /already decided, no task/);
  assert.match(msg, /Acceptance:/);
  assert.match(msg, /adds NO redundant task/);
  assert.match(msg, new RegExp(`Remudero-Task: TRIAGE-${ENTRY.id}`));
});

test("triageCommitMessage: grill carries the open question and the grilling status", () => {
  const decision: TriageDecision = { action: "grill", status: "grilling", detail: "flag or config?" };
  const msg = triageCommitMessage({ decision, feedbackId: ENTRY.id, taskId: `TRIAGE-${ENTRY.id}` });
  assert.match(msg, /ambiguous, parked for the grill/);
  assert.match(msg, /flag or config\?/);
  assert.match(msg, /grilling/);
});

test("triageCommitMessage: propose cites origin: feedback#<id> and the proposed status", () => {
  const decision: TriageDecision = {
    action: "propose",
    status: "proposed",
    detail: "add W1-T200 for the requested flag",
    files: ["plan/tasks.yaml"],
  };
  const msg = triageCommitMessage({ decision, feedbackId: ENTRY.id, taskId: `TRIAGE-${ENTRY.id}` });
  assert.match(msg, new RegExp(`origin: feedback#${ENTRY.id}`));
  assert.match(msg, /proposed/);
  assert.match(msg, /^chore\(plan\):/);
});

// ── SEEDED END-TO-END SCENARIOS ──────────────────────────────────────────────
// W1-T41 acceptance proof. `rmd triage`'s only non-deterministic step is the Architect
// worker's GROUND/RESEARCH judgment call (an LLM); everything downstream of its verdict —
// the three-way decision, the PLAN-ONLY + provenance guards, and the harness-authored
// commit/PR body — is the pure, deterministic code these two tests seed with a REALISTIC
// worker verdict (grounded in facts that are actually true of this repo: rmd feedback's
// --attach flag really shipped in W1-T40) and run for real. `console.log` prints the
// resulting artifacts (the triage output / the PR diff) so a reviewer can read them
// straight off a `node --test` run, not just trust an assertion.

test("SEEDED: an ALREADY-DECIDED feedback item yields 'already decided, see §X' and NO redundant task", () => {
  const entry: FeedbackEntry = {
    id: "fb-1700000100000-seed01",
    ts: "2026-07-19T00:01:00.000Z",
    raw: "can we capture operator feedback asynchronously with a screenshot attached, without blocking on chat?",
    attachments: [],
    origin: "cli",
    status: "new",
    proposal_pr: null,
  };
  // A realistic Architect verdict after grounding against MASTER-PLAN.md/LEARNINGS.md: this
  // exact capability already shipped as `rmd feedback --attach` (W1-T40, merged #238) — see
  // MASTER-PLAN.md §7B and src/lib/feedback.ts's module doc.
  const workerOutputText = [
    "GROUND: grepped MASTER-PLAN.md §7B and LEARNINGS.md.",
    "MASTER-PLAN.md §7B: \"plan/feedback/ is a durable, diffable inbox ... captured async by",
    "`rmd feedback` (W1-T40) ... never lost in a chat scrollback.\" `rmd feedback <text> --attach",
    "<path>` (merged PR #238, LEARNINGS.md \"Agent SDK tools & the feedback front door\") already",
    "captures async, multimodal (screenshot) feedback with no chat round-trip required.",
    "RESEARCH: not needed — grounding already answers this.",
    "ALREADY_DECIDED: MASTER-PLAN.md §7B / rmd feedback --attach (W1-T40, PR #238) already ships async, multimodal capture",
  ].join("\n");

  const changedFiles: string[] = []; // the worker touched NOTHING — the ground truth signal
  const verdict = parseTriageVerdict(workerOutputText);
  const decision = decideTriage({ verdict, changedFiles });
  assert.equal(decision.action, "no_task");
  assert.equal((decision as { status: string }).status, "rejected");

  const taskId = `TRIAGE-${entry.id}`;
  const commitMessage = triageCommitMessage({
    decision: decision as Exclude<TriageDecision, { action: "error" }>,
    feedbackId: entry.id,
    taskId,
  });
  // No plan/tasks.yaml entry is ever mentioned/added — the whole point of grounding.
  assert.doesNotMatch(commitMessage, /plan\/tasks\.yaml.*(add|new task)/i);
  assert.match(commitMessage, /adds NO redundant task/);
  assert.match(commitMessage, /rejected/);

  const triageOutput = [
    "=== TRIAGE OUTPUT (seeded: already-decided) ===",
    `feedback#${entry.id}: "${entry.raw}"`,
    "",
    "--- worker verdict ---",
    workerOutputText,
    "",
    `--- deterministic decision (lib/triage.ts decideTriage) ---`,
    JSON.stringify(decision, null, 2),
    "",
    "--- harness-authored PR body (lib/triage.ts triageCommitMessage) ---",
    commitMessage,
  ].join("\n");
  console.log(triageOutput);
});

test("SEEDED: a NOVEL feedback item produces a plan-only PR diff citing feedback#<id> as origin", () => {
  const entry: FeedbackEntry = {
    id: "fb-1700000200000-seed02",
    ts: "2026-07-19T00:02:00.000Z",
    raw: "add a --dry-run flag to rmd triage so an operator can preview the ground/research verdict without spawning a worker or opening a PR",
    attachments: [],
    origin: "cli",
    status: "new",
    proposal_pr: null,
  };
  const workerOutputText = [
    "GROUND: grepped MASTER-PLAN.md §7B, plan/tasks.yaml, LEARNINGS.md, DECISIONS.md — no existing",
    "task covers a preview-only / --dry-run mode for `rmd triage`.",
    "RESEARCH: not needed — this is a local CLI ergonomics ask, no platform fact turns on it.",
    "This is clear and novel: adding a new plan/tasks.yaml task, origin: feedback#" + entry.id + ".",
    `PROPOSED: add W1-T210 (origin: feedback#${entry.id}) — a --dry-run mode for rmd triage`,
  ].join("\n");

  // The synthetic PR diff a real `gh pr diff` would show for this proposal — touches ONLY
  // plan/tasks.yaml, and the new task carries the origin: feedback#<id> provenance token.
  const prDiff = [
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "index 1111111..2222222 100644",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1920,6 +1920,22 @@",
    "+",
    "+- id: W1-T210",
    "+  title: rmd triage --dry-run — preview the ground/research verdict, no worker spawn, no PR",
    "+  repo: remudero",
    "+  depends_on: [W1-T41]",
    "+  type: implement",
    "+  verify: auto",
    "+  principles: {tdd: strict}",
    "+  budget_usd: 100.00",
    "+  risk: low",
    `+  origin: feedback#${entry.id}`,
    '+  plan_refs: ["§7B"]',
    "+  rationale: \"Operators want to see what the triage Architect WOULD decide before it commits/",
    '+    pushes/opens a PR."',
    "+  design: |",
    "+    `--dry-run` runs GROUND+RESEARCH+the verdict step and prints the would-be decision without",
    "+    spawning the commit/push/PR machinery.",
    "+  acceptance:",
    "+    - claim: \"--dry-run prints a verdict and writes nothing\"",
    '+      proof: "a seeded feedback run with --dry-run prints ALREADY_DECIDED/AMBIGUOUS/PROPOSED and',
    '        leaves the working tree clean — paste the output + `git status --porcelain`"',
    "+  status: queued",
    "+  attempts: 0",
  ].join("\n");

  const changedFiles = ["plan/tasks.yaml"]; // the worker's own diff --name-only
  const verdict = parseTriageVerdict(workerOutputText);
  const decision = decideTriage({ verdict, changedFiles });
  assert.equal(decision.action, "propose");
  assert.equal((decision as { status: string }).status, "proposed");

  // The two deterministic guards `triageCommand` runs against the REAL `gh pr diff` output.
  const strayFiles = nonPlanFilesInDiff(prDiff);
  assert.deepEqual(strayFiles, []); // touches ONLY plan/ — never src/ or test/
  assert.equal(diffCitesFeedback(prDiff, entry.id), true); // carries origin: feedback#<id>

  const taskId = `TRIAGE-${entry.id}`;
  const commitMessage = triageCommitMessage({
    decision: decision as Exclude<TriageDecision, { action: "error" }>,
    feedbackId: entry.id,
    taskId,
  });
  assert.match(commitMessage, new RegExp(`origin: feedback#${entry.id}`));

  const output = [
    "=== TRIAGE PR DIFF (seeded: novel/proposed) ===",
    `feedback#${entry.id}: "${entry.raw}"`,
    "",
    "--- worker verdict ---",
    workerOutputText,
    "",
    "--- deterministic decision (lib/triage.ts decideTriage) ---",
    JSON.stringify(decision, null, 2),
    "",
    "--- plan-only guard (lib/triage.ts nonPlanFilesInDiff) ---",
    `stray non-plan files: ${JSON.stringify(strayFiles)}`,
    "",
    "--- provenance guard (lib/triage.ts diffCitesFeedback) ---",
    `cites feedback#${entry.id}: ${diffCitesFeedback(prDiff, entry.id)}`,
    "",
    "--- the PR diff itself ---",
    prDiff,
    "",
    "--- harness-authored PR body (lib/triage.ts triageCommitMessage) ---",
    commitMessage,
  ].join("\n");
  console.log(output);
});
