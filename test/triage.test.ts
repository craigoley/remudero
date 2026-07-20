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
