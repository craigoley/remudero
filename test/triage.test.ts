import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildGrillEscalation,
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
import { TRIAGE_WORKER_TOOLS } from "../src/run-task.js";
import { escalate, renderIssueBody, type IssueGateway } from "../src/lib/escalate.js";

function tempLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-triage-grill-")), "ledger.ndjson");
}

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

test("triagePrompt: the AMBIGUOUS branch demands OPTION:/RECOMMENDATION: lines and never mentions AskUserQuestion", () => {
  const prompt = triagePrompt(ENTRY, "r1");
  assert.match(prompt, /OPTION:/);
  assert.match(prompt, /RECOMMENDATION:/);
  assert.match(prompt, /HEADLESSLY/);
  assert.doesNotMatch(prompt, /AskUserQuestion/);
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

test("parseTriageVerdict: AMBIGUOUS with no OPTION:/RECOMMENDATION: lines yields empty options + empty recommendation", () => {
  const v = parseTriageVerdict("AMBIGUOUS: does this want a CLI flag or a config default?");
  assert.deepEqual(v, {
    kind: "ambiguous",
    question: "does this want a CLI flag or a config default?",
    options: [],
    recommendation: "",
  });
});

test("parseTriageVerdict: AMBIGUOUS parses OPTION:/RECOMMENDATION: lines into the grill's actionable choices", () => {
  const v = parseTriageVerdict(
    [
      "GROUND: no existing task covers this.",
      "OPTION: cli-flag|add a --foo flag to the relevant command",
      "OPTION: config-default|add a config default instead, no new flag",
      "RECOMMENDATION: cli-flag",
      "AMBIGUOUS: does this want a CLI flag or a config default?",
    ].join("\n"),
  );
  assert.deepEqual(v, {
    kind: "ambiguous",
    question: "does this want a CLI flag or a config default?",
    options: [
      { label: "cli-flag", detail: "add a --foo flag to the relevant command" },
      { label: "config-default", detail: "add a config default instead, no new flag" },
    ],
    recommendation: "cli-flag",
  });
});

test("parseTriageVerdict: an OPTION: line with no '|' detail parses to an empty detail", () => {
  const v = parseTriageVerdict("OPTION: bare-label\nRECOMMENDATION: bare-label\nAMBIGUOUS: what now?");
  assert.deepEqual((v as { options: unknown }).options, [{ label: "bare-label", detail: "" }]);
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

const GRILL_OPTIONS = [
  { label: "cli-flag", detail: "add a --foo flag" },
  { label: "config-default", detail: "add a config default instead" },
];

test("decideTriage: AMBIGUOUS with >=2 options + a matching recommendation ⇒ grill/grilling carrying both", () => {
  const d = decideTriage({
    verdict: { kind: "ambiguous", question: "flag or config?", options: GRILL_OPTIONS, recommendation: "cli-flag" },
    changedFiles: [],
  });
  assert.deepEqual(d, {
    action: "grill",
    status: "grilling",
    detail: "flag or config?",
    options: GRILL_OPTIONS,
    recommendation: "cli-flag",
  });
});

test("decideTriage: AMBIGUOUS with fewer than 2 OPTION: lines fails loud — a grill needs an actionable choice", () => {
  const d = decideTriage({
    verdict: { kind: "ambiguous", question: "flag or config?", options: [GRILL_OPTIONS[0]], recommendation: "cli-flag" },
    changedFiles: [],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /carries 1 OPTION: line\(s\)/);
});

test("decideTriage: AMBIGUOUS with zero OPTION: lines fails loud", () => {
  const d = decideTriage({
    verdict: { kind: "ambiguous", question: "flag or config?", options: [], recommendation: "" },
    changedFiles: [],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /carries 0 OPTION: line\(s\)/);
});

test("decideTriage: AMBIGUOUS whose RECOMMENDATION doesn't match any OPTION label fails loud", () => {
  const d = decideTriage({
    verdict: { kind: "ambiguous", question: "flag or config?", options: GRILL_OPTIONS, recommendation: "something-else" },
    changedFiles: [],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /RECOMMENDATION \("something-else"\) does not match any OPTION label/);
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
    verdict: { kind: "ambiguous", question: "?", options: GRILL_OPTIONS, recommendation: "cli-flag" },
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

const GRILL_DECISION: TriageDecision = {
  action: "grill",
  status: "grilling",
  detail: "flag or config?",
  options: [
    { label: "cli-flag", detail: "add a --foo flag" },
    { label: "config-default", detail: "add a config default instead" },
  ],
  recommendation: "cli-flag",
};

test("triageCommitMessage: grill carries the open question, the grilling status, and (when given) the grill issue URL", () => {
  const msg = triageCommitMessage({
    decision: GRILL_DECISION,
    feedbackId: ENTRY.id,
    taskId: `TRIAGE-${ENTRY.id}`,
    grillIssueUrl: "https://github.com/craigoley/remudero/issues/321",
  });
  assert.match(msg, /ambiguous, parked for the grill/);
  assert.match(msg, /flag or config\?/);
  assert.match(msg, /grilling/);
  assert.match(msg, /needs-human/);
  assert.match(msg, /(^|\s)https:\/\/github\.com\/craigoley\/remudero\/issues\/321(\s|$)/m);
  assert.match(msg, /2 options/);
  assert.match(msg, /recommends "cli-flag"/);
});

test("triageCommitMessage: grill without a grillIssueUrl still renders (never throws on the optional field)", () => {
  const msg = triageCommitMessage({ decision: GRILL_DECISION, feedbackId: ENTRY.id, taskId: `TRIAGE-${ENTRY.id}` });
  assert.match(msg, /ambiguous, parked for the grill/);
});

// ── buildGrillEscalation (W1-T42: the async needs-human issue IS the grill) ──────────────────

test("buildGrillEscalation: builds a GRILL-class Escalation carrying the feedback text, question, options, and recommendation", () => {
  const e = buildGrillEscalation({ entry: ENTRY, decision: GRILL_DECISION, taskId: `TRIAGE-${ENTRY.id}`, runId: "RUN-1" });
  assert.equal(e.class, "GRILL");
  assert.equal(e.taskId, `TRIAGE-${ENTRY.id}`);
  assert.equal(e.runId, "RUN-1");
  assert.match(e.summary, new RegExp(`feedback#${ENTRY.id}`));
  assert.match(e.detail, /can we get a --dry-run flag/); // ENTRY.raw
  assert.match(e.detail, /flag or config\?/);
  assert.deepEqual(e.options, GRILL_DECISION.action === "grill" ? GRILL_DECISION.options : []);
  assert.equal(e.recommendation, "cli-flag");
});

test("buildGrillEscalation -> escalate(): the issue the gateway receives carries BOTH options + the recommendation, labelled needs-human", () => {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/321";
    },
  };
  const escalation = buildGrillEscalation({ entry: ENTRY, decision: GRILL_DECISION, taskId: `TRIAGE-${ENTRY.id}`, runId: "RUN-1" });
  const url = escalate(escalation, { issues, ledgerPath: tempLedgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/321");
  const call = calls[0];
  assert.ok(call.labels.includes("needs-human"));
  assert.ok(call.labels.includes("escalation-grill"));
  assert.match(call.body, /\*\*cli-flag\*\* — add a --foo flag/);
  assert.match(call.body, /\*\*config-default\*\* — add a config default instead/);
  assert.match(call.body, /## Recommendation\ncli-flag/);
  console.log(renderIssueBody(escalation)); // the actual rendered issue body — pasteable proof
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

test("SEEDED: an AMBIGUOUS feedback item yields options/questions via a needs-human issue and NO proposal PR", () => {
  const entry: FeedbackEntry = {
    id: "fb-1700000300000-seed03",
    ts: "2026-07-19T00:03:00.000Z",
    raw: "the drain retries too aggressively, can we make it less noisy?",
    attachments: [],
    origin: "cli",
    status: "new",
    proposal_pr: null,
  };
  // A realistic Architect verdict: grounding turns up TWO live, mutually-exclusive designs and no
  // basis to pick between them alone — exactly the case this triage pass must not guess on.
  const workerOutputText = [
    "GROUND: grepped MASTER-PLAN.md and plan/tasks.yaml for drain retry policy — nothing settles",
    "whether 'less noisy' means a longer backoff or a lower notify threshold; both are live designs.",
    "RESEARCH: not needed — this is a product judgment call, not a platform fact.",
    "OPTION: longer-backoff|widen the retry backoff window so retries happen less often",
    "OPTION: quieter-notify|keep the retry cadence but raise the digest/ping threshold instead",
    "RECOMMENDATION: longer-backoff",
    "AMBIGUOUS: does 'less noisy' mean fewer retries (backoff) or fewer notifications (threshold)?",
  ].join("\n");

  const changedFiles: string[] = []; // the worker touched NOTHING while ambiguous
  const verdict = parseTriageVerdict(workerOutputText);
  const decision = decideTriage({ verdict, changedFiles });
  assert.equal(decision.action, "grill");
  assert.equal((decision as { status: string }).status, "grilling");

  const taskId = `TRIAGE-${entry.id}`;
  const runId = `${taskId}-1700000300000`;
  const escalation = buildGrillEscalation({
    entry,
    decision: decision as Extract<TriageDecision, { action: "grill" }>,
    taskId,
    runId,
  });
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/402";
    },
  };
  const issueUrl = escalate(escalation, { issues, ledgerPath: tempLedgerPath(), runId });
  assert.equal(issueUrl, "https://github.com/craigoley/remudero/issues/402");
  assert.ok(calls[0].labels.includes("needs-human"));
  assert.match(calls[0].body, /\*\*longer-backoff\*\* — widen the retry backoff window/);
  assert.match(calls[0].body, /\*\*quieter-notify\*\* — keep the retry cadence/);
  assert.match(calls[0].body, /## Recommendation\nlonger-backoff/);

  const commitMessage = triageCommitMessage({
    decision: decision as Exclude<TriageDecision, { action: "error" }>,
    feedbackId: entry.id,
    taskId,
    grillIssueUrl: issueUrl,
  });
  // NO proposal — never a plan/tasks.yaml claim, never a "proposed" status.
  assert.doesNotMatch(commitMessage, /origin: feedback#/);
  assert.doesNotMatch(commitMessage, /status is set to proposed/);
  assert.match(commitMessage, /grilling/);
  assert.match(commitMessage, new RegExp(issueUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const triageOutput = [
    "=== TRIAGE OUTPUT (seeded: ambiguous/grill) ===",
    `feedback#${entry.id}: "${entry.raw}"`,
    "",
    "--- worker verdict ---",
    workerOutputText,
    "",
    "--- deterministic decision (lib/triage.ts decideTriage) ---",
    JSON.stringify(decision, null, 2),
    "",
    "--- the needs-human issue (lib/escalate.ts renderIssueBody) ---",
    renderIssueBody(escalation),
    "",
    "--- harness-authored PR body (lib/triage.ts triageCommitMessage) ---",
    commitMessage,
  ].join("\n");
  console.log(triageOutput);
});

test("SEEDED: a NEEDLESS grill on an unambiguous item is a failure — clear cases proceed with ZERO grill events", () => {
  // Reuses the two already-clear SEEDED verdicts above (already-decided, novel/proposed): neither
  // ever produces `decision.action === "grill"`, so the harness's `if (decision.action ===
  // "grill") escalate(...)` branch (run-task.ts's triageCommand) is never taken for either — zero
  // needs-human issues opened on a clear item, in both directions clear can resolve.
  const alreadyDecidedVerdict = parseTriageVerdict("ALREADY_DECIDED: MASTER-PLAN.md §7B / PR #238");
  const proposedVerdict = parseTriageVerdict(`PROPOSED: add W1-T210 (origin: feedback#fb-x) — a --dry-run mode`);

  const alreadyDecidedDecision = decideTriage({ verdict: alreadyDecidedVerdict, changedFiles: [] });
  const proposedDecision = decideTriage({ verdict: proposedVerdict, changedFiles: ["plan/tasks.yaml"] });

  let grillEventsFired = 0;
  for (const decision of [alreadyDecidedDecision, proposedDecision]) {
    assert.notEqual(decision.action, "grill");
    if (decision.action === "grill") grillEventsFired++; // dead by construction — the assert above already failed if reached
  }
  assert.equal(grillEventsFired, 0);
});

// ── the triage worker's tool grant (the 2026-07-22 Edit-gap materialization fix) ──

test("the triage worker's tool grant includes Edit, so a triage-propose path can produce a non-empty plan-file change", () => {
  // The prompt (triage.ts) instructs the PROPOSED path to "Edit ONLY plan files",
  // and plan/tasks.yaml is ~11k lines — whole-file Write is not a viable way to
  // make a surgical change at that size. Without the Edit tool the worker emitted
  // PROPOSED with an EMPTY diff and decideTriage fail-closed it as inconsistent
  // (observed live: feedback 04eac2 and 728bc1). The grant is the fix; this test
  // pins it so a future grant edit cannot silently reopen the gap.
  assert.ok(TRIAGE_WORKER_TOOLS.includes("Edit"), "triage must be able to Edit plan files, not just Write whole files");
  for (const t of ["Read", "Write", "Grep", "Glob"]) {
    assert.ok(TRIAGE_WORKER_TOOLS.includes(t), `${t} stays granted — Edit is additive, not a swap`);
  }
});

// ── MASTER-PLAN.md is a plan file (the 728bc1 prompt/guard contradiction) ──

test("decideTriage: a PROPOSED verdict touching MASTER-PLAN.md is a plan-only proposal, not a non-plan inconsistency", () => {
  const d = decideTriage({
    verdict: { kind: "proposed", summary: "amend §7B per feedback" },
    changedFiles: ["MASTER-PLAN.md", "plan/tasks.yaml"],
  });
  assert.deepEqual(d, {
    action: "propose",
    status: "proposed",
    detail: "amend §7B per feedback",
    files: ["MASTER-PLAN.md", "plan/tasks.yaml"],
  });
});

test("decideTriage: src/test files are STILL non-plan — widening the guard to MASTER-PLAN.md loosens nothing else", () => {
  const d = decideTriage({
    verdict: { kind: "proposed", summary: "x" },
    changedFiles: ["MASTER-PLAN.md", "src/lib/triage.ts"],
  });
  assert.equal(d.action, "error");
  assert.match((d as { reason: string }).reason, /src\/lib\/triage\.ts/);
  assert.ok(!(d as { reason: string }).reason.includes("MASTER-PLAN.md"), "MASTER-PLAN.md is not named as the offender");
});

test("nonPlanFilesInDiff: MASTER-PLAN.md hunks are plan hunks, per this guard's own doc contract", () => {
  const diff = "--- a/MASTER-PLAN.md\n+++ b/MASTER-PLAN.md\n@@ -1 +1 @@\n-x\n+y\n--- a/src/lib/x.ts\n+++ b/src/lib/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  assert.deepEqual(nonPlanFilesInDiff(diff), ["src/lib/x.ts"]);
});
