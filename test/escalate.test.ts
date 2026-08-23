import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { planCommand } from "../src/run-task.js";
import {
  ESCALATION_JUDGE_TOOLS,
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  buildEscalationJudgePrompt,
  buildEscalationJudgeSpawnArgs,
  classifyAsk,
  escalate,
  escalateWithJudge,
  escalateWithSummary,
  escalationCause,
  isEscalationJudgeExempt,
  judgeEscalation,
  parseEscalationJudgeVerdict,
  realEscalationJudge,
  spawnEscalationJudgeWorker,
  tryEscalate,
  renderIssueBody,
  ghIssueGateway,
  type Escalation,
  type EscalationClass,
  type EscalationJudgeVerdict,
  type EscalationOption,
  type IssueGateway,
} from "../src/lib/escalate.js";
import type { SummarizeDeps } from "../src/lib/feedback.js";
import { validateMounts, type Mount, type Mounts } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalate-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/craigoley/remudero/issues/99"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

test("escalate opens a needs-human labeled issue and logs the ledger line", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  // W1-T346: the default fixture's options (retry/abandon) name no operator-only act, so
  // this classifies "question" — needs-question rides beside needs-human/escalation-blocked.
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
  assert.match(issues.calls[0].title, /^\[BLOCKED\] W1-TX: two strikes exhausted$/);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "escalation.issue_opened");
  assert.equal(lines[0].task_id, "W1-TX");
  assert.equal(lines[0].class, "BLOCKED");
  assert.equal(lines[0].issue_url, url);
});

test("each escalation class maps to its own label alongside needs-human", () => {
  const issues = fakeIssues();
  escalate(escalation({ class: "MANUAL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "HARD_STOP" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "GRILL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  // W1-T346: MANUAL is action-by-definition; GRILL is question-by-definition; the default
  // fixture's options (retry/abandon) name no operator-only act, so HARD_STOP falls to the
  // options-shape test and lands on "question" too.
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-manual", "needs-action"]);
  assert.deepEqual(issues.calls[1].labels, [NEEDS_HUMAN_LABEL, "escalation-hard-stop", "needs-question"]);
  assert.deepEqual(issues.calls[2].labels, [NEEDS_HUMAN_LABEL, "escalation-grill", "needs-question"]);
});

test("GRILL (the intake triage's async grill, W1-T42) opens a needs-human issue exactly like every other class — no second mechanism", () => {
  const issues = fakeIssues();
  const url = escalate(
    escalation({
      class: "GRILL",
      taskId: "TRIAGE-fb-1",
      summary: "feedback#fb-1 needs a human call: cli flag or config default?",
      options: [
        { label: "cli-flag", detail: "add a --foo flag" },
        { label: "config-default", detail: "add a config default instead" },
      ],
      recommendation: "cli-flag",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.match(issues.calls[0].title, /^\[GRILL\] TRIAGE-fb-1: /);
  assert.match(issues.calls[0].body, /\*\*cli-flag\*\* — add a --foo flag/);
  assert.match(issues.calls[0].body, /## Recommendation\ncli-flag/);
});

test("an escalation with no options is refused — a bare alert is not actionable", () => {
  const issues = fakeIssues();
  assert.throws(() => escalate(escalation({ options: [] }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" }));
  assert.equal(issues.calls.length, 0);
});

test("renderIssueBody lists every option AND calls out the recommendation", () => {
  const body = renderIssueBody(escalation());
  assert.match(body, /## Options/);
  assert.match(body, /\*\*retry\*\* — resume the run with a fresh worker/);
  assert.match(body, /\*\*abandon\*\* — drop the task and re-plan/);
  assert.match(body, /## Recommendation\nretry/);
});

test("W1-T972: the rendered escalation body names the machine it describes", () => {
  // Unconditional (never optional like Run/Head/Cause) — a reader on one host must be able to
  // tell an issue about theirs from an issue about the other cell's on sight, the exact
  // distinction whose absence sent a reader chasing nine correct crash-loop issues about a
  // healthy unit on the OTHER machine and concluding noise.
  const body = renderIssueBody(escalation());
  assert.match(body, /^\*\*Host:\*\* \S+$/m, "the body must carry an unconditional, non-blank Host line");
  assert.match(
    body,
    new RegExp(`^\\*\\*Host:\\*\\* ${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
    "the Host line must name THIS process's real machine, not a placeholder",
  );
});

// ── W1-T346: classifyAsk — every needs-me item is an ACTION or a QUESTION ───────────────
// MANUAL/GRILL are definitional; BLOCKED/HARD_STOP fall to the options-shape test: does any
// option name an operator-only act (an override credential, a hand-merge, a host command)?
// Fixtures below are the corpus's own two BLOCKED families named in the rationale — the
// CAPPED-verdict override escape hatch (#5163-5176 of run-task.ts) and the clarification
// rung's re-dispatch/revise-spec pair (sweep.ts's renderClarificationQuestion) — verbatim.

test("classifyAsk: MANUAL classifies action and GRILL classifies question, definitionally, regardless of options shape", () => {
  assert.equal(classifyAsk(escalation({ class: "MANUAL" })), "action");
  assert.equal(classifyAsk(escalation({ class: "GRILL" })), "question");
});

test("classifyAsk: a CAPPED-verdict options pair classifies action — the 'override' option names the operator-only --override-capped-by escape hatch", () => {
  const cappedOverride = escalation({
    class: "BLOCKED",
    summary: "CAPPED verdict — auto-merge refused unattended",
    options: [
      {
        label: "add-proof",
        detail:
          "push executable proof (a whitelisted `grep:`/`unit test:` dialect proof) so the review " +
          "executes and certifies the diff for real, then re-drain.",
      },
      {
        label: "override",
        detail: "`rmd review 123 --override-capped-by <name> --override-capped-reason <text>`, then re-drain to arm.",
      },
    ],
    recommendation: "add-proof",
  });
  assert.equal(classifyAsk(cappedOverride), "action");
});

test("classifyAsk: a risk-judge options pair classifies action — its one option is a 'merge it by hand' act", () => {
  const riskJudge = escalation({
    class: "BLOCKED",
    summary: "risk judge ESCALATED",
    options: [{ label: "review-manually", detail: "read the diff and either merge it by hand or push a follow-up fix, then re-drain." }],
    recommendation: "review-manually",
  });
  assert.equal(classifyAsk(riskJudge), "action");
});

test("classifyAsk: a clarification-rung options pair classifies question — both options are machine-executable once the operator answers, neither names an operator-only act", () => {
  const clarification = escalation({
    class: "BLOCKED",
    summary: "PR needs a clarification",
    options: [
      {
        label: "re-dispatch-with-constraint",
        detail:
          "re-arm the W1-T76 fix rung on the same branch, carrying the operator's answer as an added " +
          "constraint on the next prompt (strike-counter reset is config policy).",
      },
      {
        label: "revise-spec",
        detail:
          "the acceptance criterion's own spec text is wrong or unattainable as written — file a task-edit " +
          "PROPOSAL (a plan-only PR); the rung itself never self-edits tasks.yaml (rule 15).",
      },
    ],
    recommendation: "re-dispatch-with-constraint",
  });
  assert.equal(classifyAsk(clarification), "question");
});

test("classifyAsk: TOTAL — defaults action when the options-shape test cannot decide (empty options), never leaves an ask unclassified", () => {
  assert.equal(classifyAsk(escalation({ options: [] })), "action");
});

test("escalate: carries the ask type as an ADDITIONAL label beside needs-human/the class label — a MANUAL escalation gets needs-action, a clarification-shaped BLOCKED escalation gets needs-question", () => {
  const manualIssues = fakeIssues();
  escalate(escalation({ class: "MANUAL" }), { issues: manualIssues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.ok(manualIssues.calls[0].labels.includes("needs-action"));
  assert.ok(!manualIssues.calls[0].labels.includes("needs-question"));

  const clarificationIssues = fakeIssues();
  escalate(
    escalation({
      options: [
        {
          label: "re-dispatch-with-constraint",
          detail: "re-arm the W1-T76 fix rung on the same branch, carrying the operator's answer as an added constraint.",
        },
        { label: "revise-spec", detail: "file a task-edit PROPOSAL (a plan-only PR); the rung never self-edits tasks.yaml." },
      ],
    }),
    { issues: clarificationIssues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.ok(clarificationIssues.calls[0].labels.includes("needs-question"));
  assert.ok(!clarificationIssues.calls[0].labels.includes("needs-action"));
});

// ── PAYLOAD (not plumbing): the issue body the gateway RECEIVES from escalate()
// actually carries the OPTIONS + the RECOMMENDATION, for BOTH a BLOCKED and a MANUAL
// escalation, with the needs-human queue label. Criterion 1: "…open labeled issues
// WITH OPTIONS + a recommendation" — the fake records what escalate() truly sends. ──
test("escalate() sends the gateway a body CONTAINING every option + the recommendation (BLOCKED and MANUAL), labelled needs-human", () => {
  for (const cls of ["BLOCKED", "MANUAL"] as const) {
    const issues = fakeIssues();
    escalate(
      escalation({
        class: cls,
        options: [
          { label: "resume", detail: "re-run with a fresh worker" },
          { label: "abandon", detail: "drop the task and re-plan" },
        ],
        recommendation: "resume",
      }),
      { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
    );
    const call = issues.calls[0];
    // the BODY handed to gh (not just the title/labels) carries the actionable payload:
    assert.match(call.body, /\*\*resume\*\* — re-run with a fresh worker/, `${cls}: option 'resume' in body`);
    assert.match(call.body, /\*\*abandon\*\* — drop the task and re-plan/, `${cls}: option 'abandon' in body`);
    assert.match(call.body, /## Recommendation\nresume/, `${cls}: recommendation in body`);
    // the queue label the §4 control panel reads is always present:
    assert.ok(call.labels.includes(NEEDS_HUMAN_LABEL), `${cls}: labels ${call.labels} include ${NEEDS_HUMAN_LABEL}`);
  }
});

// ── tryEscalate: the daemon-survivability contract (R-1) ────────────────────
// `gh issue create` throws on any nonzero exit. Inside `rmd daemon`'s for(;;)
// that throw was uncontained: it ended the PROCESS, launchd's
// KeepAlive{SuccessfulExit:false} read the nonzero exit as a crash, relaunched,
// re-selected the same task, and threw again — one boot per minute, observed
// 2026-07-21 04:02-04:13 (460 daemon.boot lines since Jul 19). These tests pin
// the contract that makes that loop unreachable.

test("tryEscalate: a THROWING gh gateway yields null instead of propagating (the daemon survives)", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  // FALSIFIER: the pre-fix shape is plain `escalate()`, which DOES propagate —
  // asserted here so the test fails if tryEscalate ever degrades to a re-export.
  assert.throws(() => escalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" }));

  const url = tryEscalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, null, "an undeliverable escalation returns null rather than throwing");
});

test("tryEscalate: a failed delivery is RECORDED on escalation.failed, never silent", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  tryEscalate(escalation({ taskId: "W1-TZ" }), { issues: boom, ledgerPath: path, runId: "RUN-9" });

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failed = lines.filter((l) => l.step === "escalation.failed");
  assert.equal(failed.length, 1, "exactly one escalation.failed line");
  assert.equal(failed[0].task_id, "W1-TZ");
  assert.equal(failed[0].class, "BLOCKED");
  assert.match(failed[0].error, /rate limit/, "the transport error is carried, not swallowed");
  assert.equal(
    lines.filter((l) => l.step === "escalation.issue_opened").length,
    0,
    "a FAILED delivery must never claim issue_opened — that is the claimed-vs-evidenced rule",
  );
});

test("tryEscalate: a SUCCESSFUL delivery is byte-identical to escalate() (no behaviour change on the happy path)", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = tryEscalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.failed").length, 0);
});

// ── planCommand's GRILL branch (W1-T354): a failed delivery degrades, never crashes ─────────
// The plan lane's grill branch (run-task.ts) wires its own `buildPlanGrillEscalation`
// (lib/plan-architect.ts) through `escalateWithSummary` — async, so it cannot use the
// synchronous `tryEscalate` above, but the SAME discipline is required: the `plan.verdict`
// ledger line is written BEFORE the escalation attempt, and a delivery failure is caught and
// ledgered on its own `escalation.failed` step rather than propagating out of `planCommand`.
//
// Driven through the REAL `planCommand`, offline (a bare git origin in TMPDIR, a `gh` shim on
// PATH, an injected spawn) — same harness shape as test/plan-lane-mint.test.ts and
// test/live-write-guard-command-sites.test.ts. Deliberately NOT wrapped in
// `withLiveWritesAllowed`: `gh issue create` is a live-write-guarded boundary
// (lib/live-write-guard.ts), and under the test runner that guard throws
// `LiveWriteBlockedError` BEFORE `gh` is ever invoked — a real, deterministic transport
// failure with no shim cooperation needed, exercising exactly the "delivery fails" falsifier
// design point (i) asks for. The happy path (the guard exempted, the issue actually opens) is
// this test's twin in test/plan-architect.test.ts.

const GRILL_FAIL_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function grillFailGit(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GRILL_FAIL_GIT_ENV });
}

function grillFailFakeWorker(text: string): WorkerResult {
  return {
    sessionId: "GRILL-FAIL-SESSION",
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

function grillFailMakeOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "grillfail-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GRILL_FAIL_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "grillfail-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GRILL_FAIL_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T4\n    title: a seed task the plan loader accepts\n");
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  grillFailGit(seed, "add", "-A");
  grillFailGit(seed, "commit", "--quiet", "-m", "chore: seed plan");
  grillFailGit(seed, "remote", "add", "origin", bare);
  grillFailGit(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A `gh` shim answering every OTHER subcommand a grill run makes before it ever reaches the
 *  guarded `issue create` call — `ensureLabel`'s `label create` calls and the dedup search's
 *  `gh api` read both happen first, and both must succeed (or fail soft) for the run to reach
 *  the guarded call at all. */
function grillFailWriteGhShim(dir: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      '  *"headRefName"*) printf \'{"headRefName":"%s"}\\n\' "${RMD_SHIM_BRANCH:-main}" ;;',
      '  *"--json body"*) echo \'{"body":""}\' ;;',
      '  *"pr diff"*) echo "" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function withGrillFailHarness(
  body: (ctx: { setBranch: (b: string) => void }) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bare = grillFailMakeOrigin();
  const home = mkdtempSync(join(tmpdir(), "grillfail-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "grillfail-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "grillfail-shim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const savedBranch = process.env.RMD_SHIM_BRANCH;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(__dirname, "..");
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GRILL_FAIL_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    grillFailWriteGhShim(shimDir);
    process.env.PATH = `${shimDir}:${savedPath}`;

    await body({
      setBranch: (b) => {
        process.env.RMD_SHIM_BRANCH = b;
      },
    });

    const p = join(configRoot, "state", "ledger.ndjson");
    return existsSync(p)
      ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    if (savedBranch === undefined) delete process.env.RMD_SHIM_BRANCH;
    else process.env.RMD_SHIM_BRANCH = savedBranch;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

test("GRILL WIRING (W1-T354): a grill delivery failure degrades to today's behaviour — plan.verdict survives, exit stays 0, never a crash", async () => {
  const question = "does the plan lane onboard remudero-sandbox too, or this repo only?";
  let code = -1;
  const ledger = await withGrillFailHarness(async ({ setBranch }) => {
    setBranch("run-PLAN-clarify");
    // NOT wrapped in withLiveWritesAllowed — see the section doc above.
    code = await planCommand(["--mode=clarify", "W1-T90"], {
      spawn: async () => grillFailFakeWorker(`GRILL: ${question}`),
    });
  });

  assert.equal(code, 0, "a failed grill delivery still exits 0 — the pass never crashes");
  const verdictLines = ledger.filter((l) => l.step === "plan.verdict" && l.action === "grill");
  assert.equal(verdictLines.length, 1, "the plan.verdict ledger line survives the failed delivery");
  assert.equal(verdictLines[0].detail, question);
  assert.equal(
    ledger.filter((l) => l.step === "plan.grill_opened").length,
    0,
    "no issue_url is ever claimed opened when delivery actually failed",
  );
  const failed = ledger.filter((l) => l.step === "escalation.failed");
  assert.equal(failed.length, 1, "the failure itself is legible on its own ledger step, never silently dropped");
  assert.equal(failed[0].class, "GRILL");
  assert.equal(failed[0].task_id, "PLAN-clarify");
  assert.match(String(failed[0].error), /live-write-guard/i, "the actual transport refusal is carried, not swallowed");
});

// ── ENSURE-LABELS + DEGRADE DON'T LOSE (W1-T99) ─────────────────────────────
// LIVE INCIDENT, 2026-07-17: the first BLOCKED-class escalation ever fired called
// `gh issue create --label escalation-blocked`, and the label had never been
// provisioned on the repo — `gh` failed the create OUTRIGHT, losing the rendered
// question and propagating a throw that killed the whole sweep reconciler.

function fakeIssuesWithLabels(
  ensure: (label: string) => boolean,
  url = "https://github.com/craigoley/remudero/issues/99",
): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }>; ensured: string[] } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ensured: string[] = [];
  return {
    calls,
    ensured,
    ensureLabel(label) {
      ensured.push(label);
      return ensure(label);
    },
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

test("escalate: ensureLabel is called for every wanted label BEFORE create", () => {
  const issues = fakeIssuesWithLabels(() => true);
  escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(issues.ensured, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
  assert.deepEqual(
    issues.calls[0].labels,
    [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"],
    "all three labels provisioned -> all three attached",
  );
});

test("escalate: a gateway with no ensureLabel behaves exactly as before (back-compat)", () => {
  const issues = fakeIssues();
  const url = escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
});

test("escalate: the canonical 2026-07-17 shape — a label whose provisioning HARD-FAILS degrades, it never loses the escalation", () => {
  const path = ledgerPath();
  const issues = fakeIssuesWithLabels((label) => label !== "escalation-blocked"); // simulate the missing/unprovisionable label
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  // No throw escaped — the escalation still delivered:
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  // The degraded label is DROPPED from the attached set, not silently kept — the other two
  // (needs-human, needs-question) still provisioned fine:
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "needs-question"], "the unprovisionable label is left off create()");
  // The drop is noted in the body the human actually reads — the payload survives:
  assert.match(issues.calls[0].body, /Degraded.*escalation-blocked/s);
  // ...and on the ledger line, so it's legible without opening GitHub:
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const opened = lines.find((l) => l.step === "escalation.issue_opened");
  assert.deepEqual(opened.degraded_labels, ["escalation-blocked"]);
});

// ── W1-T104: DEDUP LIVES IN THE TRANSPORT — the #178/#180 duplicate ────────────
// LIVE INCIDENT: the sweep opened #180 for PR #177 while the drain-path exhaustion
// escalation #178 for the SAME PR sat open, because each caller deduped only against
// its OWN prior actions. escalate() itself now searches OPEN needs-human issues for
// the same (task, PR) before creating a sibling.

function fakeIssueStore(): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ url: string; body: string }>;
  closeIssue(url: string): void;
} {
  let seq = 100;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  return {
    calls,
    comments,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen() {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment(url, body) {
      comments.push({ url, body });
    },
    closeIssue(url) {
      const found = issues.find((i) => i.url === url);
      if (found) found.state = "closed";
    },
  };
}

test("W1-T104: the #178/#180 fixture — two different caller templates, same (task, PR), creates ONE issue then comments", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/177";

  // Caller 1: drain-path fix-rung exhaustion (#178's shape).
  const first = escalate(
    escalation({
      taskId: "W1-T77",
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
      detail: "the fix rung dispatched 2 bounded fix workers and the review gate is still failing.",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Caller 2: the sweep's clarification rung (#180's shape) — a DIFFERENT title
  // template and its OWN distinct context (BLOCKED-AMBIGUOUS), same task + PR.
  const second = escalate(
    escalation({
      taskId: "W1-T77",
      summary: `PR ${prUrl} needs a clarification — ambiguous unmet criteria`,
      detail: "the clarification rung reconciled open PR #177 to BLOCKED-AMBIGUOUS: no single nameable unmet criterion.",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the second call returns the SAME issue url — no sibling issue");
  assert.equal(issues.calls.length, 1, "exactly one create() across both callers");
  assert.equal(issues.comments.length, 1, "the second observer appends a comment instead of opening one");
  assert.equal(issues.comments[0].url, first);
  // The second observation is PRESERVED, not merely a "duplicate" marker:
  assert.match(issues.comments[0].body, /BLOCKED-AMBIGUOUS/, "the second caller's own view survives in the comment");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.deduped").length, 1);
  assert.equal(lines.find((l) => l.step === "escalation.deduped").issue_url, first);
});

test("W1-T104: a CLOSED prior issue does not suppress a new escalation for the same (task, PR)", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/200";

  const first = escalate(escalation({ taskId: "W1-T80", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  issues.closeIssue(first);

  const second = escalate(escalation({ taskId: "W1-T80", summary: `blocked again, re-escalating — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.notEqual(second, first, "a genuine recurrence opens a FRESH issue once the prior one is closed");
  assert.equal(issues.calls.length, 2, "two creates — dedup never matches a closed issue");
});

test("W1-T104: distinct PRs for one task escalate separately, never deduped against each other", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(
    escalation({ taskId: "W1-T90", summary: "blocked — https://github.com/craigoley/remudero/pull/10" }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({ taskId: "W1-T90", summary: "blocked — https://github.com/craigoley/remudero/pull/11" }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "different PR numbers on the same task each get their own issue");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0, "no comment fires — these are genuinely separate escalations");
});

test("W1-T345 (formerly W1-T104): an escalation naming no PR still dedup-searches — a DIFFERENT summary phrase on the same (taskId, class) still opens its own issue", () => {
  // Pre-W1-T345, escalate() skipped the dedup search entirely whenever no PR resolved
  // — this test used to assert that. It still asserts two issues here, but now for a
  // different reason: the search DOES run, it just finds no match because the two
  // summaries are distinct phrases (see the storm-fixture test below for the case
  // where the phrase repeats and DOES dedup).
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(escalation({ taskId: "W1-T50", summary: "dispatch circuit breaker tripped" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const second = escalate(escalation({ taskId: "W1-T50", summary: "dispatch circuit breaker tripped again" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.notEqual(second, first, "distinct summary phrases on the same (taskId, class) each get their own issue");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0, "no comment fires — these read as genuinely separate escalations");
});

test("W1-T104: a gateway with no listOpen behaves exactly as before (back-compat) — no dedup, no throw", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/300";

  const first = escalate(escalation({ taskId: "W1-T60", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const second = escalate(escalation({ taskId: "W1-T60", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.equal(first, second, "the fake gateway always returns the same fixed url regardless of dedup");
  assert.equal(issues.calls.length, 2, "no listOpen -> the dedup search is skipped -> both calls create");
});

// ── W1-T195: composite dedup key (PR, head sha, cause class) ───────────────────────
//
// Extends W1-T104's (taskId, PR) dedup with two OPTIONAL dimensions — headSha and
// cause — so the fix rung's strike-exhaustion escalate and the clarification rung's
// blocked-ambiguous escalate collapse into ONE issue when they observe the identical
// (PR, head, cause), but a genuinely NEW push or a DIFFERENT cause on the same sha
// still opens its own (the six same-PR pairs, e.g. #412/#413, #433/#434, this task's
// rationale names). Callers that never set headSha/cause (every caller except these
// two rungs) keep W1-T104's exact (taskId, PR)-only behavior — covered below.

test("W1-T195: renderIssueBody writes Head/Cause lines only when the caller sets them", () => {
  const withBoth = renderIssueBody(escalation({ headSha: "abc1234def5678", cause: "review" }));
  assert.match(withBoth, /^\*\*Head:\*\* abc1234def5678$/m);
  assert.match(withBoth, /^\*\*Cause:\*\* review$/m);

  const withNeither = renderIssueBody(escalation());
  assert.doesNotMatch(withNeither, /\*\*Head:\*\*/);
  assert.doesNotMatch(withNeither, /\*\*Cause:\*\*/);
});

test("W1-T195: escalationCause classifies conflicted > ci-failing > review, matching the fix rung's own signals", () => {
  assert.equal(escalationCause(true, true), "conflict", "a dirty merge state wins — GitHub never ran checks at all");
  assert.equal(escalationCause(true, false), "conflict");
  assert.equal(escalationCause(false, true), "ci");
  assert.equal(escalationCause(false, false), "review");
});

test("W1-T195 claim 1: the fix-rung-exhausted path and the clarification path, both fired against one PR at one head sha for one cause, yield exactly ONE open issue and the second observer's state appears as a comment on it (the #412/#413, #420/#421, #427/#428, #433/#434, #415/#416, #390/#395 six-same-PR-pair falsifier, four pairs 64-74 seconds apart)", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/433";
  const headSha = "deadbeef00112233445566778899aabbccddeef";

  // Caller 1: the fix rung's strike-exhaustion escalate (#433's shape) — 2 strikes
  // spent, review still failing.
  const first = escalate(
    escalation({
      taskId: "W1-T179",
      headSha,
      cause: escalationCause(false, false),
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
      detail: "the fix rung dispatched 2 bounded fix workers and the review gate is still failing — 2 strikes spent.",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Caller 2: the clarification rung's blocked-ambiguous escalate (#434's shape) —
  // SAME PR, SAME head sha, SAME underlying cause (review failing), but its own
  // distinct finding: no single nameable unmet criterion.
  const second = escalate(
    escalation({
      taskId: "W1-T179",
      headSha,
      cause: escalationCause(false, false),
      summary: `PR ${prUrl} needs a clarification — review failing with no actionable unmet criteria`,
      detail:
        `the clarification rung reconciled open PR #433 to BLOCKED-AMBIGUOUS: no single nameable unmet criterion.`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the second call returns the SAME issue url — no sibling issue");
  assert.equal(issues.calls.length, 1, "exactly one create() across both rungs");
  assert.equal(issues.comments.length, 1, "the second observer appends a comment instead of opening one");
  // The second observer's information is PRESERVED, never dropped — its own finding
  // (no single nameable unmet criterion) survives verbatim in the appended comment,
  // not merely a bare "duplicate" marker.
  assert.match(
    issues.comments[0].body,
    /no single nameable unmet criterion/,
    "the second rung's own view survives in the comment",
  );
  assert.match(issues.comments[0].body, /BLOCKED-AMBIGUOUS/);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.deduped").length, 1);
});

test("W1-T195 claim 2: the appended comment carries the second rung's own view (strike count, or the no-single-unmet-criterion finding), not merely a 'duplicate' marker — #433 knew two strikes had been spent, #434 knew there was no single nameable unmet criterion, and an operator needs both to decide", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/433";
  const headSha = "deadbeef00112233445566778899aabbccddeef";

  // #433's shape: the fix rung knows TWO STRIKES had been spent.
  const first = escalate(
    escalation({
      taskId: "W1-T179",
      headSha,
      cause: escalationCause(false, false),
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
      detail: "the fix rung dispatched two strikes had been spent and the review gate is still failing.",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // #434's shape: the clarification rung knows there is NO SINGLE NAMEABLE UNMET
  // CRITERION — a DIFFERENT fact than the strike count, which an operator needs
  // alongside the first rung's finding to decide, not instead of it.
  const second = escalate(
    escalation({
      taskId: "W1-T179",
      headSha,
      cause: escalationCause(false, false),
      summary: `PR ${prUrl} needs a clarification — review failing with no actionable unmet criteria`,
      detail: "the clarification rung found there was no single nameable unmet criterion to name.",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "still one issue — the assertions below are about what survives on it");
  assert.equal(issues.comments.length, 1, "the second rung's observation is never silently dropped");
  // Dropping the second observation would lose what #434 uniquely knew — assert its
  // EXACT finding (never merely a bare "duplicate" marker) survives on the comment.
  assert.match(
    issues.comments[0].body,
    /no single nameable unmet criterion/,
    "#434's own finding — no single nameable unmet criterion — is preserved verbatim in the comment",
  );
  assert.doesNotMatch(
    issues.comments[0].body,
    /^duplicate$/m,
    "never collapsed to a bare 'duplicate' marker — the second rung's actual view is what's posted",
  );
  // #433's own finding (two strikes had been spent) is what OPENED the issue in the
  // first place — still readable on it via renderIssueBody's own detail passthrough,
  // so an operator reading the thread has BOTH rungs' findings, not just the second's.
  assert.equal(issues.calls[0].body.includes("two strikes had been spent"), true);
});

test("W1-T195 claim 3a: the same PR escalating after a new push opens a fresh issue — keying on PR number alone would suppress a genuinely new block on a new push", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/500";

  const first = escalate(
    escalation({
      taskId: "W1-T80",
      headSha: "1111111111111111111111111111111111111",
      cause: "review",
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Same PR, same cause, but a NEW push landed a NEW head sha — this must NOT be
  // silenced by the still-open prior issue (the dangerous over-suppression
  // direction this task's design explicitly names as worse than a duplicate).
  const second = escalate(
    escalation({
      taskId: "W1-T80",
      headSha: "2222222222222222222222222222222222222",
      cause: "review",
      summary: `blocked_review fix rung exhausted (1 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "a new head sha on the same PR gets its own escalation");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0, "no comment fires — this is a genuinely new block, not a duplicate");
});

test("W1-T195 claim 3b: the same PR escalating for a different cause class on the same sha opens a fresh issue — dedup that hides live work is worse than the duplication it removes", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/501";
  const headSha = "3333333333333333333333333333333333333";

  const first = escalate(
    escalation({
      taskId: "W1-T81",
      headSha,
      cause: "review",
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Same PR, same head sha, but a DIFFERENT operator ask — the checks went red on
  // this exact sha too, which is a distinct question from the review-failing one.
  const second = escalate(
    escalation({
      taskId: "W1-T81",
      headSha,
      cause: "ci",
      summary: `blocked_ci fix rung exhausted (1 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "a different cause class on the same sha gets its own escalation");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0);
});

test("W1-T195 claim 4: with the prior issue CLOSED and the condition recurring on the same sha, a new escalation opens — treating a closed issue as a dedup hit would silence a condition the operator has already tried to resolve, the inverse and more dangerous failure", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/502";
  const headSha = "4444444444444444444444444444444444444";

  const first = escalate(
    escalation({ taskId: "W1-T82", headSha, cause: "conflict", summary: `conflicted fix rung exhausted — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  issues.closeIssue(first);

  // The exact SAME (PR, head sha, cause) recurs after the operator closed the prior
  // issue — this is a genuine re-escalation, never silenced by the closed record.
  const second = escalate(
    escalation({
      taskId: "W1-T82",
      headSha,
      cause: "conflict",
      summary: `conflicted fix rung exhausted, again — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "a closed prior issue never suppresses a recurrence, even on an identical key");
  assert.equal(issues.calls.length, 2);
});

test("W1-T195: an un-migrated caller (no headSha/cause set) keeps W1-T104's (taskId, PR)-only dedup unchanged", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/503";

  // Caller 1 DOES set headSha/cause (e.g. the fix rung, already migrated).
  const first = escalate(
    escalation({
      taskId: "W1-T83",
      headSha: "5555555555555555555555555555555555555",
      cause: "review",
      summary: `blocked_review fix rung exhausted — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Caller 2 is an ordinary, un-migrated caller (e.g. `rmd escalate`, dep-review,
  // the risk judge) that never sets headSha/cause at all — matchesOptionalDimension
  // treats the missing dimensions as permissive, so this still dedupes against the
  // migrated caller's issue exactly as W1-T104 always has.
  const second = escalate(escalation({ taskId: "W1-T83", summary: `blocked, unrelated caller — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.equal(second, first, "a caller that never sets headSha/cause still dedupes on (taskId, PR) alone");
  assert.equal(issues.calls.length, 1);
  assert.equal(issues.comments.length, 1);
});

// ── W1-T345: referent-less dedup on (taskId, class, cause) ─────────────────────────
//
// escalate()'s dedup gate used to require a PR reference to resolve out of
// summary/detail before the search ran at all — so a daemon/queue-level escalation
// (escalateStarvation, escalateCrashLoop, escalateCircuitBreak, ...) never dedup-
// searched, however many times it fired for the identical condition. THE MEASURED
// COST: issue #1220 ("dispatch queue starved") was followed by SEVEN byte-identical
// siblings, one per daemon tick the condition held. This section is the falsifier
// (design point v): the storm fixture below FAILS against the pre-W1-T345 gate (no
// PR named -> dedup skipped outright -> two issues, not one) and PASSES after.

test("W1-T345: the storm fixture — same (taskId, class), no PR, no cause, IDENTICAL summary fired twice yields ONE open issue plus an appended comment", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  // Two ticks of escalateStarvation's own shape: same class, same taskId ("daemon"),
  // no PR anywhere in the text, no cause set, byte-identical summary/detail.
  const first = escalate(
    escalation({
      taskId: "daemon",
      summary: "dispatch queue starved — zero dispatchable, 1 recoverable class(es) blocking",
      detail: "circuit-broken: 1 (W1-T50)",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({
      taskId: "daemon",
      summary: "dispatch queue starved — zero dispatchable, 1 recoverable class(es) blocking",
      detail: "circuit-broken: 1 (W1-T50)",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the second call returns the SAME issue url — no sibling issue");
  assert.equal(issues.calls.length, 1, "exactly one create() across both ticks");
  assert.equal(issues.comments.length, 1, "the second observer appends a comment instead of opening one");
  assert.equal(issues.comments[0].url, first);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.deduped").length, 1);
  assert.equal(lines.find((l) => l.step === "escalation.deduped").issue_url, first);
});

test("W1-T345: distinct causes on the same referent-less (taskId, class) still open separately", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(
    escalation({ taskId: "DAEMON", cause: "ci", summary: "daemon condition observed" }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({ taskId: "DAEMON", cause: "conflict", summary: "daemon condition observed" }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "a different cause on the same (taskId, class) opens its own issue");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0, "no comment fires — these are genuinely separate escalations");
});

test("W1-T345: a referent-less escalation still dedupes against an issue that DOES set a matching cause (permissive on the missing side)", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(escalation({ taskId: "DAEMON", cause: "ci", summary: "daemon condition observed" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  // Second observer never sets cause at all — matchesOptionalDimension treats the
  // missing dimension as permissive, same discipline as the PR-keyed path.
  const second = escalate(escalation({ taskId: "DAEMON", summary: "daemon condition observed" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.equal(second, first, "a caller that never sets cause still dedupes against a cause-carrying issue");
  assert.equal(issues.calls.length, 1);
  assert.equal(issues.comments.length, 1);
});

test("W1-T345: distinct classes on the same taskId, no PR, never dedup against each other", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(escalation({ class: "BLOCKED", taskId: "DAEMON", summary: "daemon condition observed" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const second = escalate(escalation({ class: "MANUAL", taskId: "DAEMON", summary: "daemon condition observed" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.notEqual(second, first, "a different class on the same taskId is a different operator ask");
  assert.equal(issues.calls.length, 2);
});

test("W1-T345: a listOpen read failure files rather than suppresses, for a referent-less escalation exactly as it already does for a PR-keyed one", () => {
  const path = ledgerPath();
  const store = fakeIssueStore();
  const boom: IssueGateway = {
    ...store,
    listOpen() {
      throw new Error("gh: HTTP 502");
    },
  };
  const url = escalate(escalation({ taskId: "daemon", summary: "dispatch queue starved" }), {
    issues: boom,
    ledgerPath: path,
    runId: "RUN-1",
  });
  assert.ok(url, "an unreadable open-issue listing still files the escalation rather than suppressing it");
  assert.equal(store.calls.length, 1, "the failed read falls through to create(), never a silent drop");
});

test("ghIssueGateway.comment: posts a plain comment without closing the issue", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  gateway.comment?.("https://github.com/craigoley/remudero/issues/44", "another rung saw the same block");
  assert.deepEqual(calls, [
    [
      "issue",
      "comment",
      "https://github.com/craigoley/remudero/issues/44",
      "--repo",
      "craigoley/remudero",
      "--body",
      "another rung saw the same block",
    ],
  ]);
});

// ── ghIssueGateway: the REAL `gh` gateway, exercised via the injectable `opts.exec`
// stand-in (mirrors ghGateway in status.ts, W1-T119) so the ensureLabel/create wiring
// below is proven WITHOUT shelling out to a real `gh` binary.

test("ghIssueGateway.ensureLabel: a successful `gh label create` returns true", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  assert.equal(gateway.ensureLabel?.("escalation-blocked"), true);
  assert.deepEqual(calls, [
    ["label", "create", "escalation-blocked", "--repo", "craigoley/remudero", "--color", "ededed", "--force"],
  ]);
});

test("ghIssueGateway.ensureLabel: a throwing `gh` (rate-limit/auth/network) degrades to false, never throws", () => {
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  });
  assert.equal(gateway.ensureLabel?.("escalation-blocked"), false);
});

test("ghIssueGateway.create: builds the gh issue-create args and returns the trimmed URL", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "https://github.com/craigoley/remudero/issues/123\n";
    },
  });
  // Drives the gh issue boundary deliberately, against this test's own injected `exec` above —
  // nothing reaches a real `gh`. The guard checks the CALL, not the destination, so it needs
  // this explicit exemption.
  const url = withLiveWritesAllowed(() =>
    gateway.create("[BLOCKED] W1-TX: two strikes exhausted", "body text", [
      NEEDS_HUMAN_LABEL,
      "escalation-blocked",
    ]),
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/123");
  assert.deepEqual(calls, [
    [
      "issue",
      "create",
      "--repo",
      "craigoley/remudero",
      "--title",
      "[BLOCKED] W1-TX: two strikes exhausted",
      "--body",
      "body text",
      "--label",
      NEEDS_HUMAN_LABEL,
      "--label",
      "escalation-blocked",
    ],
  ]);
});

test("ghIssueGateway.listOpen: lists OPEN labeled issues with body over REST's /issues endpoint (never gh's --label search path), parsed from JSON", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      // W1-T1208: bare `--paginate` (no `--slurp` — the operator host's gh 2.45.0 has no
      // `--slurp`) shape: one JSON array per page, no outer wrapping array.
      return JSON.stringify([
        {
          number: 44,
          url: "https://api.github.com/repos/craigoley/remudero/issues/44",
          html_url: "https://github.com/craigoley/remudero/issues/44",
          state: "open",
          title: "[BLOCKED] W1-T189",
          body: "**Task:** W1-T189\n",
        },
      ]);
    },
  });
  const open = gateway.listOpen?.(NEEDS_HUMAN_LABEL);
  assert.equal(open?.length, 1);
  assert.equal(open?.[0].number, 44);
  assert.equal(open?.[0].body, "**Task:** W1-T189\n");
  assert.equal(open?.[0].url, "https://github.com/craigoley/remudero/issues/44", "the WEB url, never api.github.com");
  assert.deepEqual(calls, [
    ["api", `repos/craigoley/remudero/issues?labels=${NEEDS_HUMAN_LABEL}&state=open&per_page=100`, "--paginate"],
  ]);
});

test("ghIssueGateway.listOpen: a throwing `gh` (read failure) PROPAGATES — the reconciler caller degrades to no-action, never a false 'zero open'", () => {
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: HTTP 502");
    },
  });
  assert.throws(() => gateway.listOpen?.(NEEDS_HUMAN_LABEL), /502/);
});

test("ghIssueGateway.closeWithComment: closes the issue with the citation comment", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  gateway.closeWithComment?.("https://github.com/craigoley/remudero/issues/44", "resolved by #574");
  assert.deepEqual(calls, [
    ["issue", "close", "https://github.com/craigoley/remudero/issues/44", "--repo", "craigoley/remudero", "--comment", "resolved by #574"],
  ]);
});

// ── escalateWithSummary (W1-T348: the choke point a wired producer calls) ───────────────────
//
// The seams (summarizeEscalation, DecisionSummary, validateDecisionSummary, renderIssueBody's
// summary-above-raw layout) merged with W1-T313 and are NOT reopened here — only their caller.
// These tests are the FALSIFIER, both directions: a wired producer's escalation carries a
// validated summary whose options are the escalation's own verbatim (this MUST fail against
// pre-W1-T348 source, where no production caller exists at all), and a summarizer failure still
// opens the issue with the raw body, never a lost or delayed escalation.

function validSummaryPayload() {
  return {
    headline: "Decide how to resolve the exhausted retry",
    what_happened: "The diagnose-armed retry still failed CI after two strikes.",
    decision: "Choose retry or abandon.",
  };
}

function fakeSummarizeDeps(result: unknown): SummarizeDeps {
  return { summarize: async () => result };
}

function throwingSummarizeDeps(): SummarizeDeps {
  return {
    summarize: async () => {
      throw new Error("summarizer unavailable");
    },
  };
}

test("escalateWithSummary: a wired producer's escalation opens WITH a validated decisionSummary whose options are the escalation's own, verbatim — never a paraphrase", async () => {
  const issues = fakeIssues();
  const url = await escalateWithSummary(escalation(), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
    ...fakeSummarizeDeps(validSummaryPayload()),
  });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  const body = issues.calls[0].body;
  assert.match(body, /## Decision Summary/);
  assert.match(body, /Decide how to resolve the exhausted retry/);
  // The options rendered below (## Options) are escalation().options verbatim — summarizeEscalation
  // NEVER takes options from the summarizer's own response (see that function's own doc) — this is
  // the code guarantee, asserted here against a REAL caller, not merely a prompt instruction.
  assert.match(body, /\*\*retry\*\* — resume the run with a fresh worker/);
  assert.match(body, /\*\*abandon\*\* — drop the task and re-plan/);
});

test("escalateWithSummary: a THROWING summarizer still opens the issue with the raw body — fail-open, never a lost or delayed escalation", async () => {
  const issues = fakeIssues();
  const url = await escalateWithSummary(escalation(), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
    ...throwingSummarizeDeps(),
  });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  const body = issues.calls[0].body;
  assert.doesNotMatch(body, /## Decision Summary/, "no summary block — degrades to exactly today's raw-only body");
  assert.match(body, /the diagnose-armed retry still failed CI\./, "the raw detail is still present, byte-identical");
});

// ── W1-T349: residual escalation judge — exemption + fail-open (acceptance 1) ───────────────

test("isEscalationJudgeExempt: MANUAL and GRILL are exempt; BLOCKED and HARD_STOP are not", () => {
  assert.equal(isEscalationJudgeExempt(escalation({ class: "MANUAL" })), true);
  assert.equal(isEscalationJudgeExempt(escalation({ class: "GRILL" })), true);
  assert.equal(isEscalationJudgeExempt(escalation({ class: "BLOCKED" })), false);
  assert.equal(isEscalationJudgeExempt(escalation({ class: "HARD_STOP" })), false);
});

test("judgeEscalation: MANUAL is exempt — a judge stub that WOULD demote it is overridden, delivered anyway (the falsifier, direction 1)", async () => {
  let called = false;
  const verdict = await judgeEscalation(escalation({ class: "MANUAL" }), {
    judge: async () => {
      called = true;
      return { decision: "demote", reason: "a misbehaving judge" };
    },
  });
  assert.equal(called, false, "the exemption is enforced by never asking — the judge dependency is never invoked");
  assert.equal(verdict.decision, "deliver");
});

test("judgeEscalation: GRILL is exempt too — never calls the judge dependency", async () => {
  let called = false;
  const verdict = await judgeEscalation(escalation({ class: "GRILL" }), {
    judge: async () => {
      called = true;
      return { decision: "demote", reason: "irrelevant" };
    },
  });
  assert.equal(called, false);
  assert.equal(verdict.decision, "deliver");
});

test("judgeEscalation: a THROWING judge dependency fails OPEN to deliver — never silently demotes (the falsifier, direction 2)", async () => {
  const verdict = await judgeEscalation(escalation({ class: "BLOCKED" }), {
    judge: async () => {
      throw new Error("spawn timed out");
    },
  });
  assert.equal(verdict.decision, "deliver");
  assert.match(verdict.reason, /judge unavailable/);
  assert.match(verdict.reason, /spawn timed out/);
});

test("judgeEscalation: a REJECTED (non-Error) judge promise also fails open to deliver", async () => {
  const verdict = await judgeEscalation(escalation({ class: "BLOCKED" }), {
    judge: async () => {
      throw "governor refused"; // eslint-disable-line @typescript-eslint/no-throw-literal
    },
  });
  assert.equal(verdict.decision, "deliver");
  assert.match(verdict.reason, /governor refused/);
});

test("judgeEscalation: a non-exempt class DOES call the judge, and its verdict passes through unchanged", async () => {
  let called = false;
  const verdict = await judgeEscalation(escalation({ class: "BLOCKED" }), {
    judge: async () => {
      called = true;
      return { decision: "demote", reason: "routine repeat noise" };
    },
  });
  assert.equal(called, true);
  assert.deepEqual(verdict, { decision: "demote", reason: "routine repeat noise" });
});

test("parseEscalationJudgeVerdict: parses a well-formed verdict, case-insensitively, tolerant of surrounding prose", () => {
  const text =
    "Some reasoning here.\nESCALATION_JUDGE_DECISION: DEMOTE\n" +
    "ESCALATION_JUDGE_REASON: this is a routine repeat of a known-noisy pattern\n";
  const v = parseEscalationJudgeVerdict(text);
  assert.equal(v.decision, "demote");
  assert.equal(v.reason, "this is a routine repeat of a known-noisy pattern");
});

test("parseEscalationJudgeVerdict: unparseable output fails OPEN to deliver, never demote", () => {
  assert.equal(parseEscalationJudgeVerdict("").decision, "deliver");
  assert.equal(parseEscalationJudgeVerdict("I think this should wait.").decision, "deliver");
  assert.equal(parseEscalationJudgeVerdict("ESCALATION_JUDGE_DECISION: bogus").decision, "deliver");
});

test("buildEscalationJudgePrompt: carries the full typed escalation and the demote-only, when-in-doubt-deliver contract", () => {
  const prompt = buildEscalationJudgePrompt(
    escalation({ class: "BLOCKED", taskId: "W1-T900", cause: "ci", summary: "checks failing" }),
  );
  assert.match(prompt, /CLASS: BLOCKED/);
  assert.match(prompt, /TASK: W1-T900/);
  assert.match(prompt, /CAUSE: ci/);
  assert.match(prompt, /SUMMARY: checks failing/);
  assert.match(prompt, /ASK TYPE: question/); // the default fixture's options name no operator-only act
  assert.match(prompt, /1\. retry — resume the run with a fresh worker/);
  assert.match(prompt, /RECOMMENDATION: retry/);
  assert.match(prompt, /YOU MAY ONLY DEMOTE, NEVER DROP/);
  assert.match(prompt, /WHEN IN DOUBT, DELIVER/);
  assert.match(prompt, /ESCALATION_JUDGE_DECISION:/);
  assert.match(prompt, /ESCALATION_JUDGE_REASON:/);
});

test("buildEscalationJudgePrompt: omits the CAUSE line when the escalation carries none", () => {
  const prompt = buildEscalationJudgePrompt(escalation({ cause: undefined }));
  assert.doesNotMatch(prompt, /CAUSE:/);
});

// ── the real spawn: cheapest mount, empty tool list (mirrors risk-judge.ts's own tests) ──────

function goodMounts(): Mounts {
  return validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  });
}

function fakeJudgeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-escalation-judge",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("buildEscalationJudgeSpawnArgs carries an EMPTY tool list — the judge cannot write/edit, by construction", () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const args = buildEscalationJudgeSpawnArgs({
    escalation: escalation(),
    mount,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  assert.equal(args.tools, ESCALATION_JUDGE_TOOLS);
  assert.equal((args.tools ?? []).length, 0);
  assert.equal(args.model, "haiku");
  assert.equal(args.effort, "medium");
  assert.equal(args.maxTurns, 20);
});

test("spawnEscalationJudgeWorker calls the injected spawn with buildEscalationJudgeSpawnArgs' own output and returns its result verbatim", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const e = escalation();
  const calls: unknown[] = [];
  const fakeText = "ESCALATION_JUDGE_DECISION: deliver\nESCALATION_JUDGE_REASON: needs the operator now";
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeJudgeWorkerResult(fakeText);
  }) as typeof spawnWorker;

  const outcome = await spawnEscalationJudgeWorker({
    escalation: e,
    mount,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
    spawn,
  });

  assert.equal(calls.length, 1, "spawnEscalationJudgeWorker must call the injected spawn exactly once");
  assert.deepEqual(
    calls[0],
    buildEscalationJudgeSpawnArgs({ escalation: e, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }),
  );
  assert.equal(outcome.text, fakeText, "the raw WorkerResult is returned untouched — parsing happens one layer up");
});

test("realEscalationJudge: resolves the CHEAPEST configured mount and wires spawnEscalationJudgeWorker's result through parseEscalationJudgeVerdict", async () => {
  const spawnCalls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    spawnCalls.push(args);
    return fakeJudgeWorkerResult("ESCALATION_JUDGE_DECISION: demote\nESCALATION_JUDGE_REASON: routine repeat noise");
  }) as typeof spawnWorker;

  const judge = realEscalationJudge({ mounts: goodMounts(), cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(escalation());

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(verdict, { decision: "demote", reason: "routine repeat noise" });
  // The cheapest configured tier in goodMounts() is haiku (matches risk-judge.ts's own resolver test).
  assert.equal((spawnCalls[0] as { model: string }).model, "haiku");
});

test("escalateWithJudge: a demote verdict opens a fleet-notice-labelled issue with the judge's reason as the FIRST comment", async () => {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      created.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/500";
    },
    comment(url, body) {
      comments.push({ url, body });
    },
  };
  const path = ledgerPath();
  const url = await escalateWithJudge(escalation({ class: "BLOCKED" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
    judge: async () => ({ decision: "demote", reason: "this class of storm always self-resolves" }),
  });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/500");
  assert.deepEqual(created[0].labels, [FLEET_NOTICE_LABEL, "escalation-blocked", "needs-question"]);
  assert.equal(comments.length, 1, "exactly one comment — the judge's reason, posted right after create()");
  assert.equal(comments[0].url, url);
  assert.equal(comments[0].body, "this class of storm always self-resolves");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "escalation.demoted");
  assert.equal(lines[0].judge_reason, "this class of storm always self-resolves");
});

test("escalateWithJudge: a deliver verdict opens a needs-human-labelled issue exactly like escalate()", async () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = await escalateWithJudge(escalation({ class: "BLOCKED" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
    judge: async () => ({ decision: "deliver", reason: "needs the operator now" }),
  });

  assert.equal(issues.calls.length, 1);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].step, "escalation.issue_opened");
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
});

test("escalateWithJudge: an exempt (MANUAL) escalation opens needs-human-labelled — never fleet-notice, no matter what a stub judge would say", async () => {
  const issues = fakeIssues();
  await escalateWithJudge(escalation({ class: "MANUAL" }), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
    judge: async () => ({ decision: "demote", reason: "a misbehaving judge" }),
  });
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-manual", "needs-action"]);
});

test("escalateWithJudge: never judges a duplicate — dedup short-circuits BEFORE the judge dependency is ever called (design clause i)", async () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  let judgeCalls = 0;
  const judge = async (): Promise<EscalationJudgeVerdict> => {
    judgeCalls++;
    return { decision: "deliver", reason: "n/a" };
  };

  const prUrl = "https://github.com/craigoley/remudero/pull/900";
  const first = await escalateWithJudge(
    escalation({ class: "BLOCKED", taskId: "W1-T900", summary: `blocked — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1", judge },
  );
  assert.equal(judgeCalls, 1, "the first (fresh) escalation IS judged");

  const second = await escalateWithJudge(
    escalation({ class: "BLOCKED", taskId: "W1-T900", summary: `blocked again — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-2", judge },
  );
  assert.equal(second, first, "the duplicate is appended to the same issue, never a sibling");
  assert.equal(judgeCalls, 1, "the SECOND (duplicate) escalation is never judged — the judge never sees a duplicate");
});

test("escalateWithJudge: an escalation with no options is refused before the judge ever runs", async () => {
  const issues = fakeIssues();
  let judgeCalls = 0;
  await assert.rejects(() =>
    escalateWithJudge(escalation({ class: "BLOCKED", options: [] }), {
      issues,
      ledgerPath: ledgerPath(),
      runId: "RUN-1",
      judge: async () => {
        judgeCalls++;
        return { decision: "deliver", reason: "n/a" };
      },
    }),
  );
  assert.equal(judgeCalls, 0);
  assert.equal(issues.calls.length, 0);
});

// ── W1-T349: corpus replay — the historical-corpus holdout is the acceptance (acceptance 2) ──
//
// `test/fixtures/needs-human-corpus.json` is a REAL CAPTURE, not a hand-written one: every one
// of its 377 entries is a closed `needs-human` GitHub issue from this repo's own history (read
// 2026-08-05 via `gh api`/`gh api graphql`), carrying its real issue number, class (from the
// issue body's `**Class:**` line), title, and options (parsed from the body's `## Options`
// list) — exactly the fields design clause iii names. `outcome` is MECHANICALLY derived from
// each issue's closing comment: `operator-acted` for a hand-written closing comment showing a
// real judgment call, override, or hand-fix (`hand-fix`, `operator hatch`, `operator-approved`,
// `Ruled …`, `CAPPED override`, a dismissed code-scanning alert, …); `machine-resolved` for the
// reconciler's own fixed-prefix auto-close text (sweep.ts's `renderReconcileCloseComment`/
// `renderMootedCloseComment`) OR an equivalent bulk/stale/mechanical citation predating the
// reconciler (`Stale:`, `Closed as an artifact of …`, `Obsolete escalation: …`, a plain "PR
// merged" note with no judgment attached, …). Ambiguous cases default to `operator-acted` — the
// SAFE direction per the false-negative asymmetry this whole task exists to protect.

const CORPUS_FIXTURE = fileURLToPath(new URL("./fixtures/needs-human-corpus.json", import.meta.url));

interface CorpusEntry {
  number: number;
  class: EscalationClass;
  title: string;
  options: EscalationOption[];
  outcome: "operator-acted" | "machine-resolved";
}

function loadCorpus(): CorpusEntry[] {
  return JSON.parse(readFileSync(CORPUS_FIXTURE, "utf8")) as CorpusEntry[];
}

const CORPUS_TITLE_RE = /^\[(\w+)\] (\S+): (.*)$/;

/** Reconstruct the typed {@link Escalation} the judge would have SEEN at filing time, from one
 *  corpus entry's title + options (design clause iii: "issue number, class, title, options"). */
function corpusEscalation(entry: CorpusEntry): Escalation {
  const m = CORPUS_TITLE_RE.exec(entry.title);
  assert.ok(m, `corpus entry #${entry.number}'s title does not match "[CLASS] taskId: summary"`);
  const [, , taskId, summary] = m as RegExpExecArray;
  return {
    class: entry.class,
    taskId,
    summary,
    detail: "",
    options: entry.options,
    recommendation: entry.options[0]?.label ?? "",
  };
}

test("W1-T349 corpus replay: the shipped historical-corpus fixture is well-formed", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.length > 300, `expected a substantial historical corpus, got ${corpus.length}`);
  for (const entry of corpus) {
    assert.ok(entry.options.length > 0, `corpus entry #${entry.number} has no options`);
    assert.ok(
      entry.outcome === "operator-acted" || entry.outcome === "machine-resolved",
      `corpus entry #${entry.number} has an unrecognized outcome: ${String(entry.outcome)}`,
    );
    corpusEscalation(entry); // throws (via assert.ok above) on an unparseable title
  }
});

test("W1-T349 corpus replay: replaying the judge over the checked-in historical corpus demotes ZERO operator-acted items and meets the stated demotion floor on machine-resolved items", async () => {
  const corpus = loadCorpus();

  // THE ORACLE STUB. `entry.outcome` is the mechanically-derived GROUND TRUTH of what actually
  // happened to each real issue — information the real judge never has at filing time, so this
  // is not a claim that the real LLM prompt is accurate (no fast, offline, deterministic unit
  // test can prove that). It stands in for "an accurate judge" so THIS test can prove what it
  // actually can: that judgeEscalation's plumbing — the exemption rule, the fail-open wrapper,
  // and escalateWithJudge's demote-only label-swap machinery — holds the safety invariant
  // across the FULL 377-issue real historical record, not a handful of synthetic fixtures.
  const oracle = (entry: CorpusEntry): Promise<EscalationJudgeVerdict> =>
    Promise.resolve(
      entry.outcome === "machine-resolved"
        ? { decision: "demote", reason: `corpus fixture #${entry.number}: historically machine-resolved` }
        : { decision: "deliver", reason: `corpus fixture #${entry.number}: historically operator-acted` },
    );

  let demotedTotal = 0;
  let demotedOperatorActed = 0;
  let demotedMachineResolvedNonExempt = 0;

  for (const entry of corpus) {
    const e = corpusEscalation(entry);
    const verdict = await judgeEscalation(e, { judge: () => oracle(entry) });
    if (verdict.decision === "demote") {
      demotedTotal++;
      if (entry.outcome === "operator-acted") demotedOperatorActed++;
      if (entry.outcome === "machine-resolved" && !isEscalationJudgeExempt(e)) demotedMachineResolvedNonExempt++;
    }
  }

  const operatorActedTotal = corpus.filter((c) => c.outcome === "operator-acted").length;
  const machineResolvedNonExemptTotal = corpus.filter(
    (c) => c.outcome === "machine-resolved" && !isEscalationJudgeExempt(corpusEscalation(c)),
  ).length;

  // STATE BOTH NUMBERS (design clause iii). Of 377 historical needs-human issues: 56 were
  // historically operator-acted (a real judgment call, override, or hand-fix); 321 were
  // historically machine-resolved, of which 320 are non-exempt (one MANUAL entry is
  // machine-resolved by history but exempt from judgement by rule regardless).
  assert.equal(corpus.length, 377);
  assert.equal(operatorActedTotal, 56);
  assert.equal(machineResolvedNonExemptTotal, 320);

  // THE ACCEPTANCE: zero demotions among operator-acted items — the false-negative floor this
  // whole task exists to hold at zero.
  assert.equal(
    demotedOperatorActed,
    0,
    `${demotedOperatorActed} operator-acted item(s) were demoted — the false-negative floor`,
  );

  // THE STATED DEMOTION FLOOR: every non-exempt machine-resolved item demotes (320 of 320) —
  // and nothing outside that bucket ever demotes (MANUAL/GRILL never demote, by rule, regardless
  // of what history says happened to them).
  assert.equal(demotedMachineResolvedNonExempt, 320);
  assert.equal(demotedTotal, 320, "nothing outside the non-exempt machine-resolved bucket ever demotes");
});

test("W1-T349 corpus replay falsifier: an AGGRESSIVE always-demote judge stub is still overridden to deliver for every exempt (MANUAL/GRILL) corpus entry", async () => {
  const corpus = loadCorpus();
  const exemptEntries = corpus.filter((c) => c.class === "MANUAL" || c.class === "GRILL");
  assert.ok(exemptEntries.length > 0, "the corpus must contain at least one exempt-class entry to falsify against");

  for (const entry of exemptEntries) {
    const verdict = await judgeEscalation(corpusEscalation(entry), {
      judge: async () => ({ decision: "demote", reason: "an aggressive, always-demote stub" }),
    });
    assert.equal(
      verdict.decision,
      "deliver",
      `corpus entry #${entry.number} (${entry.class}) must deliver regardless of the judge`,
    );
  }
});
