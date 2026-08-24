import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  COMMIT_BODY_MAX_LINE,
  assertProposedPlanLoads,
  fitAcceptanceBullet,
  wrapBodyLine,
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
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { TRIAGE_WORKER_TOOLS, triageCommand } from "../src/run-task.js";
import { escalate, renderIssueBody, type IssueGateway } from "../src/lib/escalate.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { workerTranscript, type WorkerResult } from "../src/lib/worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

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

test("triagePrompt: the HARNESS-MINTED id is handed over verbatim — the worker is told to use it, not to compute one", () => {
  const prompt = triagePrompt(ENTRY, "r1", "W1-T263");
  assert.match(prompt, /USE EXACTLY `W1-T263`/, "the minted id is stated as the id to use");
  assert.match(prompt, /number them upward from W1-T263/, "multi-task proposals are told where to continue");
  // The worker has NO Bash tool (TRIAGE_WORKER_TOOLS) — a prompt that tells it to run a grep
  // pipeline to find the highest id is an instruction it cannot execute, which is how id
  // selection degraded to eyeballing whichever file it happened to read.
  assert.doesNotMatch(prompt, /grep -h 'id: W1-T'/, "no shell pipeline survives in the minted-id branch");
});

test("triagePrompt: WITHOUT a minted id the fallback still names BOTH sources — monolith AND every shard", () => {
  const prompt = triagePrompt(ENTRY, "r1");
  assert.match(prompt, /plan\/tasks\.d\/\*\.yaml/);
  assert.match(prompt, /monolith AND every shard/);
  assert.doesNotMatch(prompt, /USE EXACTLY/, "no id was minted, so none is asserted");
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

// ── W1-T2205: the option parse is idempotent — belt AND braces alongside workerTranscript's
// join fix (worker.ts), because not every duplicate-OPTION source is transcript-shaped.

test("parseTriageVerdict: a REPEATED OPTION line (identical label AND detail) collapses to ONE option, order preserved", () => {
  const v = parseTriageVerdict(
    [
      "OPTION: cli-flag|add a --foo flag to the relevant command",
      "OPTION: config-default|add a config default instead, no new flag",
      "OPTION: cli-flag|add a --foo flag to the relevant command",
      "RECOMMENDATION: cli-flag",
      "AMBIGUOUS: does this want a CLI flag or a config default?",
    ].join("\n"),
  );
  assert.deepEqual((v as { options: unknown }).options, [
    { label: "cli-flag", detail: "add a --foo flag to the relevant command" },
    { label: "config-default", detail: "add a config default instead, no new flag" },
  ]);
});

test("parseTriageVerdict: OPTION lines that share a label but differ in detail are NOT collapsed — only the exact (label, detail) pair dedupes", () => {
  const v = parseTriageVerdict(
    [
      "OPTION: cli-flag|add a --foo flag",
      "OPTION: cli-flag|add a --bar flag instead",
      "RECOMMENDATION: cli-flag",
      "AMBIGUOUS: which flag name?",
    ].join("\n"),
  );
  assert.equal((v as { options: unknown[] }).options.length, 2, "distinct details under the same label are two real choices, not a duplicate");
});

test("decideTriage: a verdict genuinely offering ONE choice twice (identical OPTION line repeated, nothing else) still fails the < 2 guard", () => {
  const verdict = parseTriageVerdict(
    ["OPTION: cli-flag|add a --foo flag", "OPTION: cli-flag|add a --foo flag", "RECOMMENDATION: cli-flag", "AMBIGUOUS: only one real choice here?"].join(
      "\n",
    ),
  );
  const d = decideTriage({ verdict, changedFiles: [] });
  assert.deepEqual(d, {
    action: "error",
    reason: "AMBIGUOUS verdict carries 1 OPTION: line(s) — a grill needs at least 2 actionable choices",
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

// ── W1-T2205: the join-then-parse pipeline, end to end (the FAILURE this task fixes) ────────
//
// `run-task.ts`'s grill path never calls `parseTriageVerdict` on `worker.text` alone — it calls
// it on `workerTranscript(worker)`, the SAME joined shape a real dispatch parses. This proves the
// join and the parse TOGETHER stay idempotent even when the SDK's `text`/`blocks` overlap holds
// (measured true — see worker.test.ts's W1-T2205 tests and this task's PR body).

test("workerTranscript + parseTriageVerdict + decideTriage: an AMBIGUOUS verdict with exactly two OPTION lines, run through the SAME overlapping text/blocks shape a real worker result carries, yields exactly two options and takes the grill branch", () => {
  const verdictText = [
    "GROUND: no existing task covers this.",
    "OPTION: cli-flag|add a --foo flag to the relevant command",
    "OPTION: config-default|add a config default instead, no new flag",
    "RECOMMENDATION: cli-flag",
    "AMBIGUOUS: does this want a CLI flag or a config default?",
  ].join("\n");
  // The overlapping shape: `blocks`'s own last (only) entry IS `text` — exactly what a real
  // captured envelope carries (worker.test.ts), and exactly what `t348FakeWorker` reproduces.
  const transcript = workerTranscript({ text: verdictText, blocks: [verdictText] });
  const verdict = parseTriageVerdict(transcript);
  const decision = decideTriage({ verdict, changedFiles: [] });
  assert.equal(decision.action, "grill", "two genuinely distinct options must still reach the grill branch, not fail closed on an inflated count");
  assert.equal((decision as { options: unknown[] }).options.length, 2, "the join must not double the OPTION count");
});

test("workerTranscript + parseTriageVerdict + decideTriage: a verdict genuinely offering ONE choice twice, run through the same overlapping shape, still fails the two-choice guard", () => {
  const verdictText = ["OPTION: cli-flag|add a --foo flag", "OPTION: cli-flag|add a --foo flag", "RECOMMENDATION: cli-flag", "AMBIGUOUS: only one real choice?"].join(
    "\n",
  );
  const transcript = workerTranscript({ text: verdictText, blocks: [verdictText] });
  const decision = decideTriage({ verdict: parseTriageVerdict(transcript), changedFiles: [] });
  assert.equal(decision.action, "error", "a genuinely single choice, repeated, must still fail the < 2 guard — the fix must not paper over this case");
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

// ── assertProposedPlanLoads (the W1-T236 triple-mint id-collision guard) ─────

test("assertProposedPlanLoads: a minted id already owned by a tasks.d shard throws PlanError NAMING the duplicate — refused pre-push", () => {
  const root = mkdtempSync(join(tmpdir(), "triage-idguard-"));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      "- id: W1-T236\n  title: minted by the worker off the monolith max\n  repo: r\n  type: implement\n  verify: auto\n  status: queued\n",
    );
    writeFileSync(
      join(root, "plan", "tasks.d", "W1-T236-already-owned.yaml"),
      "- id: W1-T236\n  title: the shard that already owns the id\n  repo: r\n  type: implement\n  verify: auto\n  status: queued\n",
    );
    assert.throws(() => assertProposedPlanLoads(root), /duplicate task id 'W1-T236'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertProposedPlanLoads: a collision-free proposal loads clean — the guard adds no false refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "triage-idguard-ok-"));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      "- id: W1-T240\n  title: a fresh id\n  repo: r\n  type: implement\n  verify: auto\n  status: queued\n",
    );
    assert.doesNotThrow(() => assertProposedPlanLoads(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// ── commit-BODY line budget (the 2026-07-22 triage-lane commitlint outage) ──

const LONG_DETAIL =
  "rewrite the ten false-verdict criteria across W1-T7B and W1-T68 so the proof floor executes them " +
  "instead of walling on keyword coverage, citing the 2026-07-19 baseline and the operator screenshots";
const LONG_ID = "fb-1784732686356-8d739e";

test("triageCommitMessage: EVERY body line fits commitlint's 100-char budget, for all three decision shapes", () => {
  const messages = [
    triageCommitMessage({
      decision: { action: "no_task", status: "rejected", detail: LONG_DETAIL },
      feedbackId: LONG_ID,
      taskId: "TRIAGE-x",
    }),
    triageCommitMessage({
      decision: {
        action: "grill",
        status: "grilling",
        detail: LONG_DETAIL,
        options: [{ label: "a", detail: "aa" }, { label: "b", detail: "bb" }],
        recommendation: "a",
      },
      feedbackId: LONG_ID,
      taskId: "TRIAGE-x",
      grillIssueUrl: "https://github.com/craigoley/remudero/issues/9999",
    }),
    triageCommitMessage({
      decision: { action: "propose", status: "proposed", detail: LONG_DETAIL, files: ["plan/tasks.yaml"] },
      feedbackId: LONG_ID,
      taskId: "TRIAGE-x",
    }),
  ];
  for (const msg of messages) {
    const [, ...body] = msg.split("\n");
    for (const line of body) {
      assert.ok(
        line.length <= COMMIT_BODY_MAX_LINE,
        `body line blows the commitlint budget (${line.length} > ${COMMIT_BODY_MAX_LINE}): ${line}`,
      );
    }
  }
});

test("triageCommitMessage: the Acceptance block still parses as exactly ONE single-line criterion after budgeting", () => {
  const msg = triageCommitMessage({
    decision: { action: "propose", status: "proposed", detail: LONG_DETAIL, files: ["plan/tasks.yaml"] },
    feedbackId: LONG_ID,
    taskId: "TRIAGE-x",
  });
  const criteria = parseAcceptanceBlock(msg);
  assert.equal(criteria.length, 1, "a wrapped/orphaned bullet would break the PR-body gate parse");
  assert.ok(criteria[0].claim.includes(`feedback#${LONG_ID}`));
  assert.ok(criteria[0].proof.length > 0, "claim|proof split survives");
});

test("wrapBodyLine wraps prose to the budget; fitAcceptanceBullet caps a bullet to ONE line", () => {
  const wrapped = wrapBodyLine("word ".repeat(40).trim());
  assert.ok(wrapped.length >= 2);
  for (const l of wrapped) assert.ok(l.length <= COMMIT_BODY_MAX_LINE);
  const bullet = fitAcceptanceBullet("- " + "x".repeat(300) + " | proof");
  assert.equal(bullet.length, COMMIT_BODY_MAX_LINE);
  assert.ok(!bullet.includes("\n"));
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

// ── id selection sees the tasks.d shards (the W1-T236 re-mint stalemate) ────
// AMENDED (the 2/2 collision evidence, W1-T256->257 #770 / W1-T260->261 #775): the prompt no
// longer DESCRIBES a discovery command — the triage worker has no Bash tool, so the grep it
// used to be handed was never runnable, and selection degraded to eyeballing. The harness
// mints the id (lib/task-id.ts) and the prompt states it; the no-mint fallback keeps the
// shard-inclusive RULE without prescribing a shell pipeline.

test("the triage prompt instructs shard-inclusive id selection — max across plan/tasks.yaml AND plan/tasks.d, so a new id never collides with a shard-owned one", () => {
  const p = triagePrompt(ENTRY, "RUN-1");
  assert.match(p, /plan\/tasks\.d\/\*\.yaml/, "the id-selection rule must name the shards");
  assert.match(p, /highest id across the\s+monolith AND every shard/i);
  assert.match(p, /never the monolith alone/i);
});

// ── W1-T348: the triage-proposal wiring — proposeFeedbackWithSummary gets a REAL caller ──────
//
// FALSIFIER, both directions (the task's design note v): a triage PROPOSE that reaches the
// write below carries a validated decisionSummary on the feedback entry it proposes from —
// this MUST fail against pre-W1-T348 source, where the write is a bare `setFeedbackStatus`
// with no summarizer call at all. Drives the REAL `triageCommand` end to end (mirroring
// test/triage-plan-deps-seam.test.ts's "all the way to the git push" proof) with an injected
// `spawn` that plays BOTH roles a real run makes: the Architect worker (nonempty `tools`) and
// the decision-summary rung (`tools: []`, {@link buildDecisionSummarySpawnArgs}) — the SAME
// discriminator `realDecisionSummarizer`'s own spawn args use, so no new seam is invented here.

const T348_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function t348FakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T348-SESSION",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

/** The DECISION_SUMMARY JSON payload {@link buildDecisionSummaryPrompt} asks the rung for —
 *  distinct headline/decision text from the Architect's own PROPOSED verdict, so the test can
 *  tell the two spawn roles apart in its assertions, not just in the fake's own routing. */
const T348_SUMMARY_PAYLOAD = {
  headline: "File a new plan task from this feedback",
  what_happened: "The triage Architect proposed a plan-only change for the fixture feedback item.",
  decision: "Review and merge the proposal PR.",
  options: [
    { label: "merge", consequence: "the proposed task enters the plan" },
    { label: "reject", consequence: "the feedback is filed away with no new task" },
  ],
};

test("W1-T348: a triage PROPOSE writes a validated decisionSummary onto the feedback entry it proposes from", async () => {
  const feedbackId = `fb-t348-propose-${Date.now()}`;

  const bare = mkdtempSync(join(tmpdir(), "t348-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: T348_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t348-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: T348_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-05T00:00:00.000Z'", "raw: fixture entry for the W1-T348 proposal-summary wiring proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: T348_GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: T348_GIT_ENV });
  rmSync(seed, { recursive: true, force: true });

  const home = mkdtempSync(join(tmpdir(), "t348-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t348-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t348-ghshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T348_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // The gh shim plays a REAL PR round-trip far enough to reach the proposal write: `pr create`
    // succeeds with a URL, and `pr view --json headRefName` answers from the bare origin's OWN
    // pushed `run-*` branch (read live off disk, never hardcoded) so the run-ownership guard
    // (checkPrOwnership, W1-T62) passes for real rather than being bypassed.
    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        // W1-T1202: `pr create` (GraphQL) moved to `gh api --method POST repos/.../pulls`
        // (REST) — the url now comes back as `html_url` in a JSON response.
        '  *"api --method POST"*) echo \'{"html_url":"https://github.com/craigoley/remudero/pull/999","number":999}\' ;;',
        `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            // The decision-summary rung's own spawn shape (buildDecisionSummarySpawnArgs).
            return t348FakeWorker(JSON.stringify(T348_SUMMARY_PAYLOAD));
          }
          // The Architect triage worker: file a clean plan task under the RESERVED id and
          // return a PROPOSED verdict so decideTriage takes the propose branch.
          const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
          assert.ok(id, `triage prompt must name the reserved id; got: ${args.prompt.slice(0, 200)}`);
          const dir = join(args.cwd, "plan", "tasks.d");
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${id}-fixture.yaml`),
            [
              `- id: ${id}`,
              `  title: "a clean task filed for the W1-T348 proposal-summary wiring proof"`,
              "  repo: remudero",
              "  origin: architect",
              `  depends_on: []`,
              "  type: implement",
              "  verify: auto",
              "  status: queued",
              "  attempts: 0",
              "  files: [test/triage.test.ts]",
              "  acceptance:",
              '    - claim: "the thing holds"',
              '      proof: "unit test: test/triage.test.ts"',
              "",
            ].join("\n"),
          );
          return t348FakeWorker(`PROPOSED: file ${id} for feedback#${feedbackId}`);
        },
      }),
    ).catch(() => undefined); // the diff-provenance check after the write we care about has no real gh diff here

    // THE PROOF: read the PROPOSAL WRITE back off the bare origin's pushed run branch — the
    // second commit ("record proposal_pr") this task's write sits inside.
    const runBranch = execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    assert.ok(runBranch, "triageCommand pushed its own run branch to the bare origin");
    const entryYaml = execFileSync("git", ["-C", bare, "show", `${runBranch}:plan/feedback/${feedbackId}.yaml`], {
      encoding: "utf8",
    });
    assert.match(entryYaml, /status: proposed/);
    assert.match(entryYaml, /proposal_pr: https:\/\/github\.com\/craigoley\/remudero\/pull\/999/);
    assert.match(entryYaml, /headline: File a new plan task from this feedback/, "the WIRED summarizer's headline landed on the entry");
    assert.match(entryYaml, /decision: Review and merge the proposal PR\./);
    assert.match(entryYaml, /label: merge/, "the summary's options round-trip too");
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T348: a THROWING decision-summary rung still writes the `proposed` transition — fail-open, summary: null, never blocks the proposal", async () => {
  const feedbackId = `fb-t348-failopen-${Date.now()}`;

  const bare = mkdtempSync(join(tmpdir(), "t348-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: T348_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t348-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: T348_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-05T00:00:00.000Z'", "raw: fixture entry for the W1-T348 fail-open proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: T348_GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: T348_GIT_ENV });
  rmSync(seed, { recursive: true, force: true });

  const home = mkdtempSync(join(tmpdir(), "t348-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t348-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t348-ghshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T348_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        // W1-T1202: `pr create` (GraphQL) moved to `gh api --method POST repos/.../pulls`
        // (REST) — the url now comes back as `html_url` in a JSON response.
        '  *"api --method POST"*) echo \'{"html_url":"https://github.com/craigoley/remudero/pull/999","number":999}\' ;;',
        `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            throw new Error("decision-summary rung unavailable"); // the summarizer outage this proof exists for
          }
          const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
          assert.ok(id, `triage prompt must name the reserved id; got: ${args.prompt.slice(0, 200)}`);
          const dir = join(args.cwd, "plan", "tasks.d");
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${id}-fixture.yaml`),
            [
              `- id: ${id}`,
              `  title: "a clean task filed for the W1-T348 fail-open proof"`,
              "  repo: remudero",
              "  origin: architect",
              `  depends_on: []`,
              "  type: implement",
              "  verify: auto",
              "  status: queued",
              "  attempts: 0",
              "  files: [test/triage.test.ts]",
              "  acceptance:",
              '    - claim: "the thing holds"',
              '      proof: "unit test: test/triage.test.ts"',
              "",
            ].join("\n"),
          );
          return t348FakeWorker(`PROPOSED: file ${id} for feedback#${feedbackId}`);
        },
      }),
    ).catch(() => undefined);

    const runBranch = execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    assert.ok(runBranch, "triageCommand pushed its own run branch to the bare origin even though the summarizer threw");
    const entryYaml = execFileSync("git", ["-C", bare, "show", `${runBranch}:plan/feedback/${feedbackId}.yaml`], {
      encoding: "utf8",
    });
    assert.match(entryYaml, /status: proposed/, "the proposal transition itself is NEVER blocked by a summarizer outage");
    assert.match(entryYaml, /summary: null/, "fail-open — no half-written entry, no invented content");
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── W1-T348's OTHER wiring: the GRILL path ───────────────────────────────────────────────────
//
// WHY THIS EXISTS. This task wires the decision-summary rung at TWO places — proposal time and
// GRILL time — and only the proposal half was driven. CI's diff-coverage blocked the PR naming the
// two uncovered lines, both inside `if (decision.action === "grill")`: the `escalateWithSummary(...)`
// call and its `...summarizeDeps` spread. `escalateWithSummary` itself is covered in
// test/escalate.test.ts, but in ISOLATION — a leaf proven and a wiring never reached is this repo's
// documented "seam built but never called" hazard, and it is exactly what the gate caught.
//
// WHAT THIS DRIVES: `triageCommand` for real, with the same fixture the proposal test uses (real
// bare origin, real config root, real gh shim). The Architect spawn returns an AMBIGUOUS verdict
// with two OPTIONs and a matching RECOMMENDATION and changes NO files, which is what `decideTriage`
// requires to take the grill branch. The summarizer spawn is the same injected one. The PROOF is
// read off the gh shim's own recorded argv, so it asserts what actually reached `gh`.

test("W1-T348: a triage GRILL opens its needs-human issue WITH a validated decisionSummary in the body", async () => {
  const feedbackId = `fb-t348-grill-${Date.now()}`;

  const bare = mkdtempSync(join(tmpdir(), "t348g-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: T348_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t348g-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: T348_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-05T00:00:00.000Z'", "raw: fixture entry for the W1-T348 GRILL-summary wiring proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: T348_GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: T348_GIT_ENV });
  rmSync(seed, { recursive: true, force: true });

  const home = mkdtempSync(join(tmpdir(), "t348g-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t348g-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t348g-ghshim-"));
  const argvLog = join(shimDir, "argv.txt");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T348_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // Records EVERY argv so the assertion can read what really reached `gh`, rather than trusting a
    // return value. `issue create` answers with a URL so the grill path completes.
    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        '  *"issue create"*) echo "https://github.com/craigoley/remudero/issues/777" ;;',
        '  *"issue list"*) echo "[]" ;;',
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            // The decision-summary rung's own spawn shape — the SAME injected summarizer the
            // proposal test uses, so this proves the wiring and not a second summarizer.
            return t348FakeWorker(JSON.stringify(T348_SUMMARY_PAYLOAD));
          }
          // AMBIGUOUS + two OPTIONs + a matching RECOMMENDATION and NO changed files is exactly
          // what decideTriage requires to return { action: "grill" } — see its own guards.
          //
          // `blocks: []`, NOT `blocks: [text]`, and that is load-bearing: run-task.ts parses the
          // verdict from `[worker.text, worker.blocks.join("\n")].join("\n")`, so a fixture that
          // puts the SAME string in both makes every OPTION line appear TWICE. Four options exceeds
          // `DECISION_SUMMARY_MAX_OPTIONS` (3), `validateDecisionSummary` returns null, and the
          // grill fails open to a raw body — which looks exactly like the wiring being absent.
          // Measured while writing this test; the shared `t348FakeWorker` helper duplicates that way.
          const verdictText = [
            "GROUND: no existing task covers this.",
            "OPTION: cli-flag|add a --foo flag to the relevant command",
            "OPTION: config-default|add a config default instead, no new flag",
            "RECOMMENDATION: cli-flag",
            "AMBIGUOUS: does this want a CLI flag or a config default?",
          ].join("\n");
          // Reuse the shared helper (it supplies every WorkerResult field the run reads, `usage`
          // included) and override ONLY `blocks` — a hand-built literal is missing fields the run
          // dereferences.
          return { ...t348FakeWorker(verdictText), blocks: [] };
        },
      }),
    ).catch(() => undefined); // bookkeeping after the issue open is not what this asserts

    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /issue create/, "the grill path reached gh issue create");
    assert.match(argv, /--label needs-human/, "and filed it on the needs-human lane");
    // THE PROOF that `escalateWithSummary` — not the bare `escalate` — served this path: the
    // WIRED summarizer's own headline is in the issue body. A raw-body issue would not carry it.
    assert.match(
      argv,
      /File a new plan task from this feedback/,
      "the wired summarizer's headline reached the issue body, so escalateWithSummary served the grill path",
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── W1-T2205 (design note vi): THE FALSIFIER, in the direction that fails today ─────────────
//
// The test above deliberately overrides `blocks: []` — load-bearing there, per its own comment,
// because the doubled join used to inflate two real options into four and fail the grill open.
// This test does the OPPOSITE on purpose: it drives the SAME AMBIGUOUS-with-two-OPTIONS verdict
// through the FAITHFUL `t348FakeWorker(verdictText)` shape (`blocks: [text]`, NOT `blocks: []`),
// which is what a real captured envelope actually looks like (worker.test.ts's W1-T2205
// measurement: `SDKResultMessage.result` IS the last assistant text block). Before this task's
// fix, run-task.ts's hand-rolled `[worker.text, worker.blocks.join("\n")].join("\n")` doubled
// every OPTION line here too, `validateDecisionSummary` rejected the inflated 4-option list, and
// the grill fell back to a raw, untranslated body — this assertion (the wired summarizer's
// headline reaching the issue) is what MUST fail against pre-fix source and MUST pass now.

test("W1-T2205: a triage GRILL driven through the FAITHFUL overlapping fixture (blocks: [text], not blocks: []) still opens its needs-human issue WITH a validated decisionSummary — the join no longer inflates two real options into four", async () => {
  const feedbackId = `fb-w1t2205-grill-${Date.now()}`;

  const bare = mkdtempSync(join(tmpdir(), "w1t2205g-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: T348_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "w1t2205g-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: T348_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-05T00:00:00.000Z'", "raw: fixture entry for the W1-T2205 faithful-overlap GRILL proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: T348_GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: T348_GIT_ENV });
  rmSync(seed, { recursive: true, force: true });

  const home = mkdtempSync(join(tmpdir(), "w1t2205g-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "w1t2205g-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "w1t2205g-ghshim-"));
  const argvLog = join(shimDir, "argv.txt");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T348_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        '  *"issue create"*) echo "https://github.com/craigoley/remudero/issues/778" ;;',
        '  *"issue list"*) echo "[]" ;;',
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            return t348FakeWorker(JSON.stringify(T348_SUMMARY_PAYLOAD));
          }
          const verdictText = [
            "GROUND: no existing task covers this.",
            "OPTION: cli-flag|add a --foo flag to the relevant command",
            "OPTION: config-default|add a config default instead, no new flag",
            "RECOMMENDATION: cli-flag",
            "AMBIGUOUS: does this want a CLI flag or a config default?",
          ].join("\n");
          // THE FAITHFUL SHAPE, UNMODIFIED: `t348FakeWorker` already sets `blocks: [text]` —
          // no override here, unlike the sibling test above. This is exactly what a real
          // envelope carries (measured, worker.test.ts).
          return t348FakeWorker(verdictText);
        },
      }),
    ).catch(() => undefined); // bookkeeping after the issue open is not what this asserts

    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /issue create/, "the grill path reached gh issue create");
    assert.match(argv, /--label needs-human/, "and filed it on the needs-human lane");
    // THE PROOF: the wired summarizer's own headline reached the issue body. Pre-fix, the
    // doubled join inflated the two real options to four, DECISION_SUMMARY_MAX_OPTIONS (3)
    // rejected them, validateDecisionSummary returned null, and escalateWithSummary fell back
    // to the raw worker text — which never carries this headline string at all.
    assert.match(
      argv,
      /File a new plan task from this feedback/,
      "the wired summarizer's headline reached the issue body even through the faithful overlapping fixture",
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});
