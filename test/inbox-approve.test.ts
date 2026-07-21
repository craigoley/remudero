import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyFragmentToPlanYaml,
  applyStampToMasterPlan,
  approveCommitMessage,
  approveProposal,
  inboxDraftPrompt,
  invalidateDraft,
  ratifyTelemetry,
  refusalReason,
  reframeProposal,
  renderRatifyTelemetry,
  type DraftCache,
  type DraftedCandidate,
  type InboxClassification,
  type Proposal,
  type RatificationPayload,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import { buildPlanPrBody, filingAcceptanceCriteria, regeneratePlanIndexFile } from "../src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";

// ── commitlint (W1-T136 class) — same subprocess pattern as test/commit-message.test.ts,
// redefined locally per that file's own convention of not sharing a lint helper. ──────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const COMMITLINT_CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", COMMITLINT_CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-inbox-approve-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const CACHED_DRAFT: DraftedCandidate = {
  proposalId: "P-READY",
  fragmentYaml: "- id: W1-T900\n  title: candidate task\n  repo: remudero\n",
  stampLine: "- P-READY (plan) — RATIFIED 2026-07-20 -> W1-T900.",
  anchorFingerprint: "landed::MASTER-PLAN.md",
};

function readyClassification(): InboxClassification {
  return { proposalId: "P-READY", state: "ready", reasons: [], draft: CACHED_DRAFT, draftStale: false };
}

function depUnmetClassification(): InboxClassification {
  return {
    proposalId: "P-DEP-UNMET",
    state: "not_ready",
    reasons: [{ predicate: "deps_merged", detail: "dep-unmet: W1-T2 not merged" }],
    draftStale: false,
  };
}

function deferredClassification(): InboxClassification {
  return {
    proposalId: "P-DEFER",
    state: "deferred_with_trigger",
    reasons: [],
    trigger: { description: "ratify after the unbuilt consumer ships", fired: false },
  };
}

function fakeGateway(prUrl = "https://github.com/craigoley/remudero/pull/500"): RatifyGateway & {
  branchCalls: Array<{ proposalId: string; fragmentYaml: string; stampLine: string }>;
  prCalls: Array<{ branch: string; proposalId: string }>;
} {
  const branchCalls: Array<{ proposalId: string; fragmentYaml: string; stampLine: string }> = [];
  const prCalls: Array<{ branch: string; proposalId: string }> = [];
  return {
    branchCalls,
    prCalls,
    createRatificationBranch(payload) {
      branchCalls.push(payload);
      return `run-APPROVE-${payload.proposalId}`;
    },
    openPlanPr(branch, proposalId) {
      prCalls.push({ branch, proposalId });
      return prUrl;
    },
  };
}

// ── Acceptance #1: approve — one PR payload on READY, zero on refusal ──────────────────────

test("approveProposal: a READY classification produces exactly ONE branch call and ONE PR call, payload deepEquals the cached draft + stamp, plus a ledger line", () => {
  const gateway = fakeGateway();
  const path = ledgerPath();
  const result = approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls.length, 1);
  assert.equal(gateway.prCalls.length, 1);
  assert.deepEqual(gateway.branchCalls[0], {
    proposalId: "P-READY",
    fragmentYaml: CACHED_DRAFT.fragmentYaml,
    stampLine: CACHED_DRAFT.stampLine,
  });
  assert.equal(gateway.prCalls[0].branch, "run-APPROVE-P-READY");
  assert.equal(gateway.prCalls[0].proposalId, "P-READY");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.prUrl, "https://github.com/craigoley/remudero/pull/500");
    assert.deepEqual(result.payload, {
      proposalId: "P-READY",
      fragmentYaml: CACHED_DRAFT.fragmentYaml,
      stampLine: CACHED_DRAFT.stampLine,
    });
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approved");
  assert.equal(lines[0].task_id, "P-READY");
  assert.equal(lines[0].pr_url, "https://github.com/craigoley/remudero/pull/500");
});

test("approveProposal: a NOT-READY (dep-unmet) classification refuses, naming the state — ZERO gateway calls", () => {
  const gateway = fakeGateway();
  const path = ledgerPath();
  const result = approveProposal(depUnmetClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls.length, 0);
  assert.equal(gateway.prCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.state, "not_ready");
    assert.match(result.refusal, /NOT READY/);
    assert.match(result.refusal, /dep-unmet: W1-T2 not merged/);
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approve_refused");
  assert.equal(lines[0].state, "not_ready");
});

test("approveProposal: a DEFERRED-WITH-TRIGGER classification refuses naming the unfired trigger — never approvable", () => {
  const gateway = fakeGateway();
  const result = approveProposal(deferredClassification(), gateway, { ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(gateway.branchCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.refusal, /DEFERRED-WITH-TRIGGER/);
    assert.match(result.refusal, /ratify after the unbuilt consumer ships/);
  }
});

test("refusalReason names every failing predicate for a not_ready classification with multiple reasons", () => {
  const c: InboxClassification = {
    proposalId: "P-MULTI",
    state: "not_ready",
    reasons: [
      { predicate: "deps_merged", detail: "dep-unmet: W1-T2 not merged" },
      { predicate: "lint_clean", detail: "draft-unclean: violation X" },
    ],
  };
  const reason = refusalReason(c);
  assert.match(reason, /dep-unmet: W1-T2 not merged/);
  assert.match(reason, /draft-unclean: violation X/);
});

test("approveCommitMessage: carries the stamp (wrapped, never raw) and NO Remudero-Task trailer — a ratification PR is a plan-FILING PR", () => {
  // W1-T136 correctness rule: findMergedByTrailer (lib/status.ts) would credit a
  // Remudero-Task trailer's id as DONE on merge — a filing PR only ADDS the ratified
  // task(s), it does not implement them, so it must carry NO trailer at all (not even
  // the proposal id, which was #387's original, WRONG-id trailer).
  const msg = approveCommitMessage({ proposalId: "P25", fragmentYaml: "- id: W1-T900\n", stampLine: CACHED_DRAFT.stampLine });
  assert.match(msg, /rmd approve/);
  assert.ok(msg.includes(CACHED_DRAFT.stampLine), "the stamp line's TEXT must still be present");
  assert.doesNotMatch(msg, /Remudero-Task:/, "a filing PR must carry NO Remudero-Task trailer, named or otherwise");
  assert.equal(lint(msg).status, 0, `approveCommitMessage output must pass commitlint:\n${msg}`);
});

// Verbatim (verified 673 chars) from `git show 39f7955` — PR #387's ratification commit,
// which spliced this single-paragraph stamp line RAW into the commit body and blew
// commitlint's body-max-line-length. Hardcoded (not shelled out to `git show` at test
// time) so this survives a shallow checkout lacking that historical commit.
const REAL_387_STAMP_LINE =
  "- P19 (plan -> WS-2 addendum) — RATIFIED 2026-07-20 -> W1-T170/W1-T171/W1-T172 (per-run isolated worker HOMES · the deterministic file-overlap pre-dispatch check, rung 1 · N parallel dispatch lanes bounded by the queue-governor WIP limit, N=2). TRIGGER FIRED: both prerequisites built — W1-T121 (#385, queue governor) and W1-T122 (#386, plan sharding). Rung 2 (Tree-sitter symbol-touch locks) stays BANKED until a rung-1 escape is observed in the ledger; W1-T172's `dispatch.concurrent_set` line is what makes that trigger answerable. HONESTY BOUND CARRIED: files: is advisory metadata a worker can exceed — the check reduces collision probability and is never a guarantee.";

test("#387 regression: approveCommitMessage fed a stamp line of the REAL incident's length/shape passes the real commitlint CLI", () => {
  assert.equal(REAL_387_STAMP_LINE.length, 673, "fixture must reproduce the real incident's length");
  const msg = approveCommitMessage({ proposalId: "P19", fragmentYaml: "- id: W1-T170\n", stampLine: REAL_387_STAMP_LINE });
  for (const line of msg.split("\n")) {
    assert.ok(line.length <= 100, `over-long line (the #387 failure mode): ${JSON.stringify(line)}`);
  }
  const result = lint(msg);
  assert.equal(result.status, 0, `#387-shaped commit message must pass commitlint:\n${msg}\n${result.stdout}${result.stderr}`);
});

// ── Acceptance #2: reframe — feedback ledgers verbatim, invalidates the draft, rides the redraft ──

test("reframeProposal: ledgers ratify.reframed with the feedback verbatim, invalidates the draft, appends to reframeHistory — never opens a PR", () => {
  const proposal: Proposal = { id: "P25", summary: "the ratification inbox", evidenceAnchors: [] };
  const drafts: DraftCache = { P25: CACHED_DRAFT };
  const path = ledgerPath();

  const result = reframeProposal(proposal, "the drafted tasks miss the escalation transport — redo with W1-T8 wired in", drafts, {
    ledgerPath: path,
    runId: "RUN-1",
  });

  assert.deepEqual(result.proposal.reframeHistory, [
    { feedback: "the drafted tasks miss the escalation transport — redo with W1-T8 wired in" },
  ]);
  assert.equal(result.drafts.P25, undefined, "the cached draft for P25 is invalidated");

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.reframed");
  assert.equal(lines[0].task_id, "P25");
  assert.equal(lines[0].feedback, "the drafted tasks miss the escalation transport — redo with W1-T8 wired in");
});

test("reframeProposal accumulates a SECOND round onto an existing reframe history, oldest first", () => {
  const proposal: Proposal = {
    id: "P25",
    summary: "s",
    evidenceAnchors: [],
    reframeHistory: [{ feedback: "first objection" }],
  };
  const result = reframeProposal(proposal, "second objection", {}, { ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(result.proposal.reframeHistory, [{ feedback: "first objection" }, { feedback: "second objection" }]);
});

test("invalidateDraft drops only the named proposal's cached draft, leaving others untouched; a no-op when nothing is cached", () => {
  const drafts: DraftCache = { P1: CACHED_DRAFT, P2: { ...CACHED_DRAFT, proposalId: "P2" } };
  const next = invalidateDraft(drafts, "P1");
  assert.equal(next.P1, undefined);
  assert.deepEqual(next.P2, drafts.P2);
  assert.deepEqual(invalidateDraft({}, "P-NONE"), {});
});

test("inboxDraftPrompt: a proposal with NO reframe history renders no operator-feedback section", () => {
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [] };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1");
  assert.doesNotMatch(prompt, /OPERATOR FEEDBACK/);
});

test("inboxDraftPrompt: the NEXT draft-rung invocation's rendered prompt carries the reframe feedback verbatim, every round in order", () => {
  const proposal: Proposal = {
    id: "P25",
    summary: "the ratification inbox",
    evidenceAnchors: [],
    reframeHistory: [{ feedback: "first: missing the escalation transport" }, { feedback: "second: also wire the retro telemetry" }],
  };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-2");
  assert.match(prompt, /OPERATOR FEEDBACK/);
  assert.match(prompt, /1\. first: missing the escalation transport/);
  assert.match(prompt, /2\. second: also wire the retro telemetry/);
});

// ── Acceptance #3: approval-rate telemetry lands in the retro ──────────────────────────────

test("ratifyTelemetry: 3 approvals + 1 reframe yields a 75% approval rate with both counts", () => {
  const records = [
    { step: "ratify.approved" },
    { step: "ratify.approved" },
    { step: "ratify.approved" },
    { step: "ratify.reframed" },
    { step: "run.start" }, // unrelated ledger noise is ignored
  ];
  const t = ratifyTelemetry(records);
  assert.equal(t.approved, 3);
  assert.equal(t.reframed, 1);
  assert.equal(t.rate, 0.75);

  const rendered = renderRatifyTelemetry(t);
  assert.match(rendered, /Approved: 3/);
  assert.match(rendered, /Reframed: 1/);
  assert.match(rendered, /75%/);
});

test("ratifyTelemetry: no ratify activity yet is a named zero, not a bare 0%", () => {
  const t = ratifyTelemetry([]);
  assert.equal(t.approved, 0);
  assert.equal(t.reframed, 0);
  assert.equal(t.rate, 0);
  assert.match(renderRatifyTelemetry(t), /no ratify activity yet/);
});

// ── Real-world ratification writers (plain string composition) ─────────────────────────────

test("applyFragmentToPlanYaml appends the fragment to the end of the existing tasks.yaml text", () => {
  const base = "- id: W1-T1\n  title: existing\n";
  const out = applyFragmentToPlanYaml(base, "- id: W1-T900\n  title: new\n");
  assert.ok(out.startsWith(base.trimEnd()));
  assert.match(out, /- id: W1-T900\n  title: new/);
});

test("applyStampToMasterPlan replaces an existing proposal bullet in place", () => {
  const md = "# MASTER-PLAN\n\n- P25 (plan -> §7) — CAPTURED 2026-07-01.\n- P26 (plan) — CAPTURED 2026-07-02.\n";
  const out = applyStampToMasterPlan(md, "P25", "- P25 (plan -> §7) — RATIFIED 2026-07-20 -> W1-T900.");
  assert.match(out, /- P25 \(plan -> §7\) — RATIFIED 2026-07-20 -> W1-T900\./);
  assert.doesNotMatch(out, /CAPTURED 2026-07-01/);
  assert.match(out, /- P26 \(plan\) — CAPTURED 2026-07-02\./, "the unrelated P26 bullet is untouched");
});

test("applyStampToMasterPlan appends the stamp when no existing bullet matches the proposal id", () => {
  const md = "# MASTER-PLAN\n\n- P26 (plan) — CAPTURED 2026-07-02.\n";
  const out = applyStampToMasterPlan(md, "P25", "- P25 (plan) — RATIFIED 2026-07-20 -> W1-T900.");
  assert.match(out, /- P26 \(plan\) — CAPTURED 2026-07-02\./);
  assert.match(out, /- P25 \(plan\) — RATIFIED 2026-07-20 -> W1-T900\.\s*$/);
});

// ── Integration proof (the "dry-run" acceptance criterion, W1-T136) ─────────────────────────
//
// `approve` has no CLI dry-run flag and this task adds none. Instead: run approveProposal
// against a RatifyGateway whose two methods do REAL git operations (mirroring
// src/run-task.ts's approveCommand gateway, minus worktree/pruning machinery that needs no
// proving here) in an ISOLATED temp git repo — never this repo's own worktree state. `openPlanPr`
// just RECORDS the assembled body (gh has no network here) instead of calling the real `gh` CLI.
// End to end this proves: the resulting commit passes REAL commitlint, plan/plan-index.json
// matches a fresh REAL `--check` run, and the captured PR body has a judgeable Acceptance block
// with NO Remudero-Task trailer.

const GENERATE_PLAN_INDEX_SCRIPT = join(REPO_ROOT, "scripts", "generate-plan-index.mjs");

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
}

function makeApproveFixtureRepo(): string {
  // realpathSync: macOS's os.tmpdir() lives under a `/tmp` -> `/private/tmp` symlink, and
  // generate-plan-index.mjs's "run as main" guard compares a RESOLVED URL against argv[1]'s
  // literal path — an unresolved path never matches, so main() silently never runs. Resolve
  // once, up front (see test/plan-pr-emitter.test.ts's makeBareWorktree for the same fix).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-approve-integration-")));
  const env = gitEnv();
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(GENERATE_PLAN_INDEX_SCRIPT, join(dir, "scripts", "generate-plan-index.mjs"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "- id: W1-T1\n  title: existing task\n  repo: remudero\n");
  writeFileSync(
    join(dir, "MASTER-PLAN.md"),
    "# MASTER-PLAN\n\n## Proposals\n\n- P900 (plan) — CAPTURED 2026-07-19.\n",
  );
  const gen = spawnSync(process.execPath, [join(dir, "scripts", "generate-plan-index.mjs"), "--source", "MASTER-PLAN.md", "--out", "plan/plan-index.json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);

  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  return dir;
}

test("integration: approveProposal against a REAL git repo — commitlint-clean commit, fresh plan-index, judgeable no-trailer PR body", () => {
  const dir = makeApproveFixtureRepo();
  const env = gitEnv();
  const payload: RatificationPayload = {
    proposalId: "P900",
    fragmentYaml: "- id: W1-T900\n  title: candidate task\n  repo: remudero\n",
    stampLine: "- P900 (plan) — RATIFIED 2026-07-20 -> W1-T900.",
  };
  const draft: DraftedCandidate = { ...payload, anchorFingerprint: "landed::MASTER-PLAN.md" };
  const classification: InboxClassification = { proposalId: "P900", state: "ready", reasons: [], draft, draftStale: false };

  let filedTaskIds: string[] = [];
  let capturedBody: string | undefined;
  const gateway: RatifyGateway = {
    createRatificationBranch(p) {
      const branch = "run-approve-integration";
      execFileSync("git", ["-C", dir, "checkout", "--quiet", "-b", branch], { env });

      const tasksPath = join(dir, "plan", "tasks.yaml");
      writeFileSync(tasksPath, applyFragmentToPlanYaml(readFileSync(tasksPath, "utf8"), p.fragmentYaml), "utf8");
      const masterPlanPath = join(dir, "MASTER-PLAN.md");
      writeFileSync(masterPlanPath, applyStampToMasterPlan(readFileSync(masterPlanPath, "utf8"), p.proposalId, p.stampLine), "utf8");

      // The #287 fix: regenerate plan/plan-index.json BEFORE the single git-add below.
      regeneratePlanIndexFile({ worktreePath: dir });
      filedTaskIds = [...p.fragmentYaml.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);

      execFileSync("git", ["-C", dir, "add", "-A", "--", "plan/", "MASTER-PLAN.md"], { env });
      execFileSync("git", ["-C", dir, "commit", "-m", approveCommitMessage(p)], { env });
      return branch;
    },
    openPlanPr(_branch, id) {
      const intro = [
        classification.draft?.stampLine ?? "",
        "",
        "The operator's one-bit approve initiated this PR (MASTER-PLAN P25 ii, W1-T111). The",
        "gate still reviews (ci + remudero-review); nothing auto-merges without it.",
      ].join("\n");
      const ids = filedTaskIds.length > 0 ? filedTaskIds : [id];
      capturedBody = buildPlanPrBody({
        intro,
        criteria: filingAcceptanceCriteria(ids, ["plan/tasks.yaml", "MASTER-PLAN.md"]),
        // NO taskId — a ratification branch is a plan-FILING PR.
      });
      // No real `gh` here (no network in a test) — just record what WOULD be posted.
      return "https://github.com/example/example/pull/1";
    },
  };

  const path = ledgerPath();
  const result = approveProposal(classification, gateway, { ledgerPath: path, runId: "RUN-INTEGRATION" });
  assert.equal(result.ok, true);

  // 1. The resulting commit passes REAL commitlint.
  const message = execFileSync("git", ["-C", dir, "log", "-1", "--format=%B"], { encoding: "utf8" });
  const lintResult = lint(message);
  assert.equal(lintResult.status, 0, `integration commit must pass commitlint:\n${message}\n${lintResult.stdout}${lintResult.stderr}`);
  assert.doesNotMatch(message, /Remudero-Task:/, "a filing PR's commit carries no trailer");

  // 2. plan/plan-index.json matches a fresh, independent --check run.
  const check = spawnSync(
    process.execPath,
    [join(dir, "scripts", "generate-plan-index.mjs"), "--source", "MASTER-PLAN.md", "--out", "plan/plan-index.json", "--check"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);

  // 3. The captured PR body has a judgeable Acceptance block and NO Remudero-Task trailer.
  assert.ok(capturedBody, "openPlanPr must have run and recorded a body");
  const criteria = parseAcceptanceBlock(capturedBody!);
  assert.ok(criteria.length > 0, "the PR body must be judgeable (#387's fail-closed bug)");
  assert.doesNotMatch(capturedBody!, /Remudero-Task:/);
});
