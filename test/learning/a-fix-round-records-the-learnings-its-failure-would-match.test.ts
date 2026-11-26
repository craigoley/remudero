import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import {
  FIX_LEARNINGS_LOG_TAIL_CHARS,
  fixLearningsCiConclusion,
  fixLearningsDoneConclusion,
  fixLearningsOutcomeRow,
  recordFixLearningsShadow,
  summarizeFixLearningsShadow,
  type FixLearningsRound,
} from "#src/lib/fix-learnings-shadow.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type LiveRoundHandoff, type OpenPrView } from "#src/lib/sweep.js";
import { taskArmWithheld } from "#src/lib/task-arm.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { MERGE_UP_TO_DATE_REASON, pushFixRound, pushFixRoundPrechecked, runFixRung, runPlanScopedFixRound } from "#test/helpers/run-task-test.js";

// W1-T14138: each fix round records which learnings its failing checks would match, in a task-keyed arm, and
// injects nothing. These tests drive the real fix rung over a real git worktree holding a learnings corpus.

const withheld = (taskId: string): boolean =>
  taskArmWithheld({ taskId, unit: "fix-learnings", share: 0.25, epoch: "fix-learnings-shadow-v1" });
const taskIds = Array.from({ length: 64 }, (_, i) => `W1-T${9100 + i}`);
const OFFERED_TASK = taskIds.find((id) => !withheld(id))!;
const WITHHELD_TASK = taskIds.find((id) => withheld(id))!;

const lesson = (id: string, matcher: string): string =>
  `- id: ${id}\n  lifecycle: active\n  files: [src/changed.ts]\n${matcher}  fact: FACT-OF-${id}\n  src: operator-fleet\n`;
const CORPUS = [
  lesson("by-check-name", "  error_signatures: [unit-shadow-check]\n"),
  lesson("by-log-error", "  error_signatures: [ERR_SHADOW_BOOM]\n"),
  lesson("by-title-symbol", "  symbols: [wireProducer]\n"),
  lesson("by-path-only", ""),
  lesson("by-absent-error", "  error_signatures: [ERR_NEVER_PRINTED]\n"),
].join("\n");

const FIRST_RED: CiFailure[] = [{ name: "unit-shadow-check", title: "wireProducer failed", logTail: "ERR_SHADOW_BOOM" }];
const SECOND_RED: CiFailure[] = [{ name: "lint-shadow-check", logTail: "a different failure" }];
const FIRST_MATCHES = { "by-check-name": ["error"], "by-log-error": ["error"], "by-title-symbol": ["symbol"] };

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

type Row = Record<string, unknown> & { step: string };
interface Run { prompts: string[]; rows: Row[]; pushed: string[]; waits: number; reviews: number }

/** Drive the fix rung from a red CI dispatch; `ci[i]` is what CI concludes on the head round i+1 pushes. */
async function fixRung(opts: {
  taskId?: string;
  corpus?: string;
  ci?: Array<"green" | "red" | "timeout">;
  ciOnOtherHead?: boolean;
  checkHandoff?: "pushed-head" | "other-head";
  landed?: boolean;
  noCommit?: boolean;
  remoteAfterPush?: "advanced" | "missing" | "unreadable";
  leasedRefDeleted?: "before-push" | "after-push";
  mergeStart?: "fetch-fails" | "refused" | "up-to-date";
  reviewOnly?: boolean;
}): Promise<Run> {
  const taskId = opts.taskId ?? OFFERED_TASK;
  const ci = opts.ci ?? ["green"];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-`));
  const fixture = gitRepo({ kind: "fix-learnings" });
  const origin = opts.leasedRefDeleted && gitRepo({ bare: true, kind: "fix-learnings-origin" });
  const { dir: repo, git } = fixture;
  try {
    mkdirSync(join(repo, "learnings"), { recursive: true });
    if (opts.corpus !== undefined) writeFileSync(join(repo, "learnings", "ci.yaml"), opts.corpus);
    const base = git("rev-parse", "HEAD");
    const task = { id: taskId, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
    const runId = `${taskId}-1791151948510`;
    const branch = `run-${runId}`;
    const ref = `refs/heads/${branch}`;
    if (origin) {
      fixture.addRemote("origin", origin.dir);
      git("push", "-q", "origin", `${base}:${ref}`);
    }
    const initialReview = {
      state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: base, reviewerOutcome: "success",
    };
    const prompts: string[] = [];
    const rows: Row[] = [];
    const pushed: string[] = [];
    let publishedHead = base;
    let waits = 0;
    let reviews = 0;
    const ciPorts = {
      requiredContexts: [...FIRST_RED, ...SECOND_RED].map((failure) => failure.name),
      liveRoundHandoff: (): LiveRoundHandoff | undefined => waits === 1 && opts.checkHandoff
        ? { failure: "check", headSha: opts.checkHandoff === "pushed-head" ? pushed[0]! : base, ciFailures: SECOND_RED }
        : undefined,
    };
    await runFixRung({
      ...ciPorts,
      task, taskId, runId, prUrl: "https://github.com/acme/remudero/pull/7", branch,
      worktreePath: repo, initialSessionId: "", initialReview, ciFailures: opts.reviewOnly ? undefined : FIRST_RED,
      mount, settingsFile: join(root, "settings.json"),
      config: { root, ...(opts.mergeStart ? { workerProviders: { harnessCommitsFix: true } } : {}) } as Config,
      budgetUsd: 1, strikeCap: ci.length,
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
      ...(opts.mergeStart ? { mergeConflict: {
        files: [{ path: "src/changed.ts", oursDeleted: 1, theirsDeleted: 0 }], oursLog: "ours", theirsLog: "theirs",
      } } : {}),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo, reviewerMount: mount },
      deps: {
        approvedSkillsDir: join(root, "skills"),
        ledgerLines: () => rows.map((row) => ({ ...row, task_id: taskId })), ledgerPath: join(root, "ledger.ndjson"),
        spawn: async (args) => {
          prompts.push(args.prompt);
          if (!opts.noCommit) {
            writeFileSync(join(repo, `round-${prompts.length}.txt`), "fixed\n");
            git("add", `round-${prompts.length}.txt`);
            git("commit", "-q", "-m", `fix: round ${prompts.length}`);
          }
          return {
            sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        push: (_wt, _branch, expected) => {
          const head = git("rev-parse", "HEAD"); pushed.push(head);
          if (origin) {
            const log = (step: string, extra?: Record<string, unknown>) => rows.push({ ...extra, step });
            return withLiveWritesAllowed(() => pushFixRoundPrechecked(log, repo, branch, expected, {
              repo: "fixture", conflictMarkers: () => [],
            }, (wt, refBranch, sha, prior) => pushFixRound(wt, refBranch, sha, prior, {
              exec: (_file, args) => {
                if (opts.leasedRefDeleted === "before-push") origin.git("update-ref", "-d", ref);
                git(...args.slice(2));
                assert.equal(origin.git("rev-parse", ref), head, "the server accepted the exact commit");
                origin.git("update-ref", "-d", ref, head);
              },
            }), base));
          }
          if (opts.landed !== false) publishedHead = opts.remoteAfterPush === "advanced" ? "descendant-head" : head;
          return opts.landed === false ? undefined : { fixRoundPushedHead: head };
        },
        readRemoteBranchHead: async () => {
          if (pushed.length > 0 && opts.remoteAfterPush === "unreadable") throw new Error("origin unavailable after push");
          return pushed.length > 0 && opts.remoteAfterPush === "missing" ? undefined : publishedHead;
        },
        ...(opts.mergeStart === "up-to-date" || opts.mergeStart === "refused" ? {
          startShellLessMergeConflictMerge: () => opts.mergeStart === "up-to-date"
            ? { started: false, reason: MERGE_UP_TO_DATE_REASON } : { started: false },
        } : {}),
        waitForCiGreen: async () => ({ state: ci[waits++] ?? "green", sha: opts.ciOnOtherHead ? base : publishedHead }),
        readCiRollup: async () => (pushed.length === 0 ? FIRST_RED : SECOND_RED).map(({ name }) =>
          ({ name, status: "COMPLETED", conclusion: "FAILURE" })),
        fetchCiFailures: async () => SECOND_RED,
        runReview: async () => {
          reviews++;
          return opts.remoteAfterPush
            ? { ...initialReview, criteria: criteria.map((c) => ({ ...c, claim: "a new unmet claim" })), headSha: publishedHead }
            : { ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: publishedHead };
        },
        readHeadShaForProvenance: () => git("rev-parse", "HEAD"),
        fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
      },
    });
    return { prompts, rows, pushed, waits, reviews };
  } finally {
    if (origin) origin.cleanup();
    fixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

const of = (run: Run, step: string): Row[] => run.rows.filter((row) => row.step === step);
const matchedIds = (row: Record<string, unknown>): string[] => (row.matched as Array<{ id: string }>).map((m) => m.id).sort();
const matchedKinds = (row: Row) => Object.fromEntries((row.matched as Array<{ id: string; kinds: string[] }>).map((m) => [m.id, m.kinds]));

test("W1-T14138 criterion 1: a fix round writes one shadow row naming the matches, their kinds and the task's arm", async () => {
  for (const [taskId, arm] of [[OFFERED_TASK, "offered"], [WITHHELD_TASK, "withheld"]] as const) {
    const run = await fixRung({ taskId, corpus: CORPUS });
    const shadows = of(run, "fix.learnings_shadow");
    assert.equal(shadows.length, 1, "one row for the one round");
    const row = shadows[0]!;
    assert.equal(row.arm, arm);
    assert.deepEqual(matchedKinds(row), FIRST_MATCHES);
    assert.deepEqual(row.failing_checks, ["unit-shadow-check"]);
    assert.equal(row.task_id, taskId);
    assert.equal(row.run_id, `${taskId}-1791151948510`);
    assert.equal(row.pr_number, 7);
    assert.equal(row.attempt, 1);
    assert.equal(row.round, "resume");
    assert.equal(row.budget_chars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    assert.ok(run.rows.indexOf(row) < run.rows.indexOf(of(run, "fix.dispatch")[0]!), "written at prompt assembly");
  }
});

test("W1-T14138 criterion 2: a learning that would match only by file path is not recorded as a match", async () => {
  const run = await fixRung({ corpus: CORPUS });
  const row = of(run, "fix.learnings_shadow")[0]!;
  assert.deepEqual(matchedIds(row), ["by-check-name", "by-log-error", "by-title-symbol"]);
  assert.deepEqual(row.dropped_ids, [], "the path-only entry is not a dropped candidate either");
});

test("W1-T14138 criterion 1: counted merge-start refusals record the known CI matches under the refused round ID", async () => {
  for (const [mergeStart, taskId, arm] of [
    ["fetch-fails", OFFERED_TASK, "offered"], ["refused", WITHHELD_TASK, "withheld"],
  ] as const) {
    const run = await fixRung({ corpus: CORPUS, mergeStart, taskId });
    const [dispatch] = of(run, "fix.dispatch");
    assert.equal(dispatch?.mode, "merge-conflict");
    assert.equal(run.prompts.length, 0);
    const shadows = of(run, "fix.learnings_shadow");
    assert.equal(shadows.length, 1);
    const [shadow] = shadows;
    assert.equal(shadow!.round_id, dispatch!.round_id);
    assert.equal(shadow!.arm, arm);
    assert.deepEqual(shadow!.failing_checks, ["unit-shadow-check"]);
    assert.deepEqual(matchedKinds(shadow!), FIRST_MATCHES);
    assert.deepEqual(of(run, "fix.learnings_outcome").map((row) => [row.round_id, row.shadow_id, row.conclusion]),
      [[dispatch!.round_id, shadow!.shadow_id, "no_push"]]);
  }
});

test("an up-to-date merge retries the same strike with a single shadow row for the CI worker", async () => {
  const run = await fixRung({ corpus: CORPUS, mergeStart: "up-to-date" });
  assert.deepEqual(of(run, "fix.dispatch").map((row) => row.mode), ["ci-log"]);
  assert.equal(of(run, "fix.commit_refused").length, 0);
  const shadows = of(run, "fix.learnings_shadow");
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0]!.round_id, of(run, "fix.dispatch")[0]!.round_id);
  assert.equal(shadows[0]!.attempt, 1);
  assert.equal(run.prompts.length, 1);
});

test("W1-T14138 criterion 1: a fleet plan repair records hosted CI matches at dispatch", async (t) => {
  const head = "a".repeat(40);
  const next = "b".repeat(40);
  const path = "plan/tasks.d/W1-T5543-fixture.yaml";
  const body = `## Acceptance\n- the shard is filed | grep: id: W1-T5543 in ${path}`;
  const ciFailures = [{ ...FIRST_RED[0]!, name: "lint-plan" }];
  const rows: Row[] = [];
  for (const arm of ["offered", "withheld"] as const) {
    const root = ownedFixtureDir(t, `plan-shadow-${arm}`).dir;
    const prNumber = Array.from({ length: 64 }, (_, i) => i + 9000)
      .find((n) => withheld(`PR-${n}`) === (arm === "withheld"))!;
    const pr: OpenPrView = {
      prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, headSha: head,
      headRefName: "ci-friction-garden-1791084979333", checksState: "red", reviewState: "pending",
      isPlanFiling: true, unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    };
    mkdirSync(join(root, "learnings"));
    writeFileSync(join(root, "learnings", "ci.yaml"), CORPUS.replace("unit-shadow-check", "lint-plan"));
    const ledgerPath = join(root, "ledger.ndjson");
    const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ ...extra, step }); };
    const edits = arm === "offered";
    let committed = false;
    const effects = buildSweepEffects({
      owner: "acme", repo: "remudero", repoRoot: REPO_ROOT, config: { root } as Config, ledgerPath,
      runId: `plan-shadow-${arm}`, log, plan: { tasks: [] } as never, policy: DEFAULT_SWEEP_POLICY,
      dispatchFixPreflightStandDownImpl: async () => undefined,
      ghJsonImpl: () => ({ head: { ref: pr.headRefName, sha: head }, user: { login: "remudero-fleet[bot]" }, title: "chore(plan): fixture", body }),
      fetchPrDiffFilesImpl: async () => [path],
      fixBranchClaimKeyImpl: () => `plan-shadow-${prNumber}`,
      materializePlanRoundWorktreeImpl: () => ({ worktreePath: root }),
      worktreeRemoveImpl: () => {},
      restRollupForImpl: async () => [],
      fetchCiFailuresImpl: () => ciFailures,
      planPrPreflightImpl: async (_dir, sha) => ({
        ok: sha === next || !edits, failures: sha === head && edits ? [{ check: "lint-plan", firstLine: "plan red" }] : [], unreadable: [],
      }),
      spawnImpl: async (args) => {
        assert.equal(rows.at(-2)?.step, "fix.learnings_shadow");
        assert.match(args.prompt, /ERR_SHADOW_BOOM/);
        assert.doesNotMatch(args.prompt, /FACT-OF-/);
        return { text: edits ? "COMMIT_MESSAGE: fix(plan): repair the plan" : "PR_TITLE: chore(plan): correct metadata",
          blocks: [], subtype: "success" } as never;
      },
      runPlanScopedFixRoundImpl: (input) => runPlanScopedFixRound({
        ...input, deps: { ...input.deps, execProof: () => ({ hits: 1 }), runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return committed ? next : head;
          if (args[0] === "ls-tree") return path;
          if (args[0] === "status") return edits ? ` M ${path}\0` : "";
          if (args[0] === "commit") committed = true;
          return "";
        } },
      }),
      planRepairGitImpl: (_file, args) => args.includes("rev-parse") ? next : "",
    });
    const result = await withLiveWritesAllowed(() => effects.dispatchPlanGateRound!(pr));
    assert.equal(result.outcome, edits ? "pushed" : "metadata-repaired", result.reason);
    const shadow = rows.findLast((row) => row.step === "fix.learnings_shadow")!;
    const dispatch = rows.findLast((row) => row.step === "fix.dispatch")!;
    assert.equal(shadow.round_id, dispatch.round_id);
    assert.equal(shadow.task_id, `PR-${prNumber}`);
    assert.equal(shadow.arm, arm);
    assert.deepEqual(shadow.failing_checks, ["lint-plan"]);
    assert.deepEqual(matchedKinds(shadow), FIRST_MATCHES);
    assert.equal(rows.filter((row) => row.step === "fix.learnings_shadow" && row.pr_number === prNumber).length, 1);

    const sweep = (headSha: string, checksState: OpenPrView["checksState"]) =>
      runSweep([{ ...pr, headSha, checksState }], {
        runId: "next-sweep", ledgerPath, readLedger: () => rows,
        appendLine: (_path, row) => { rows.push(row); },
        arm() {}, close() {}, postReview: async () => {}, dispatchFix: async () => {}, escalate() {},
      }, DEFAULT_SWEEP_POLICY);
    const outcomes = () => rows.filter((row) => row.step === "fix.learnings_outcome" && row.shadow_id === shadow.shadow_id);
    if (edits) {
      await sweep(next, "pending");
      await sweep(head, "green");
      assert.deepEqual(outcomes(), []);
      await sweep(next, "green");
      await sweep(next, "green");
      assert.deepEqual(outcomes().map((row) => [row.conclusion, row.pushed_head_sha, row.rounds_to_green]), [["green", next, 1]]);
    } else {
      assert.deepEqual(outcomes().map((row) => [row.conclusion, row.pushed_head_sha]), [["no_push", undefined]]);
    }
  }
});

test("W1-T14138 criterion 3: the fix prompt is byte-identical in both arms whether or not learnings match", async () => {
  // An untrusted-data envelope draws a fresh random boundary per render, and commit ids carry a clock.
  const stable = (prompt: string): string => prompt.replace(/boundary="[^"]*"/g, 'boundary="B"')
    .replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(new RegExp(`${RMD_TMP_PREFIX}fix-learnings-[A-Za-z0-9]+`, "g"), "ROOT");
  for (const taskId of [OFFERED_TASK, WITHHELD_TASK]) {
    const matching = await fixRung({ taskId, corpus: CORPUS });
    const empty = await fixRung({ taskId });
    assert.equal(matchedIds(of(matching, "fix.learnings_shadow")[0]!).length, 3, "precondition: this corpus matches");
    assert.deepEqual(matchedIds(of(empty, "fix.learnings_shadow")[0]!), []);
    assert.equal(stable(matching.prompts[0]!), stable(empty.prompts[0]!));
    assert.ok(!matching.prompts[0]!.includes("FACT-OF-"), "no matched fact reaches the prompt");
  }
});

test("W1-T14138 criterion 3: both arms match the origin/main prompt baseline", async () => {
  // Captured from origin/main with the same fixture inputs; normalize only the renderer's random
  // envelope boundary, git commit ids, and fixture root before comparing bytes.
  const stable = (prompt: string): string => prompt.replace(/boundary="[^"]*"/g, 'boundary="B"')
    .replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(new RegExp(`${RMD_TMP_PREFIX}fix-learnings-[A-Za-z0-9]+`, "g"), "ROOT");
  const originMainPromptSha256: Record<string, string> = {
    [OFFERED_TASK]: "e911e923cf464303d1b921824501456e70dac66d8def9405c36aea4da7480f1e",
    [WITHHELD_TASK]: "84e58dd2b082dcdcfda8aff51a1885c0189e4d94941964463c810428fe6d6ece",
  };
  const { createHash } = await import("node:crypto");
  for (const taskId of [OFFERED_TASK, WITHHELD_TASK]) {
    const run = await fixRung({ taskId, corpus: CORPUS });
    assert.equal(createHash("sha256").update(stable(run.prompts[0]!)).digest("hex"), originMainPromptSha256[taskId],
      `${taskId} prompt must remain byte-identical to origin/main`);
  }
});

test("review-only rounds do not reuse CI checks from an earlier head", async () => {
  const run = await fixRung({ corpus: CORPUS, reviewOnly: true });
  const shadow = of(run, "fix.learnings_shadow")[0]!;
  assert.deepEqual(shadow.failing_checks, []);
  assert.deepEqual(matchedIds(shadow), []);
});

test("W1-T14138 criterion 4: the outcome row records CI on the pushed head, red then green with rounds to green", async () => {
  const run = await fixRung({ corpus: CORPUS, ci: ["red", "green"] });
  const shadows = of(run, "fix.learnings_shadow");
  const outcomes = of(run, "fix.learnings_outcome");
  assert.deepEqual(shadows.map((row) => row.attempt), [1, 2], JSON.stringify(run.rows.slice(-8)));
  assert.deepEqual(outcomes.map((row) => row.conclusion), ["red", "green"]);
  assert.deepEqual(outcomes.map((row) => row.shadow_id), shadows.map((row) => row.shadow_id));
  assert.deepEqual(outcomes.map((row) => row.pushed_head_sha), run.pushed);
  assert.deepEqual(outcomes.map((row) => row.round_id), of(run, "fix.dispatch").map((row) => row.round_id));
  assert.equal(outcomes[0]!.rounds_to_green, undefined);
  assert.equal(outcomes[1]!.rounds_to_green, 2);
  const summary = summarizeFixLearningsShadow(run.rows).offered;
  assert.deepEqual(summary.outcomes, { green: 1, red: 1, no_push: 0, unobserved: 0 });
  assert.deepEqual(summary.roundsToGreen, { [OFFERED_TASK]: 2 });
});

test("W1-T14138 criterion 4: a round whose push did not land records that it pushed nothing", async () => {
  const run = await fixRung({ corpus: CORPUS, landed: false });
  const outcomes = of(run, "fix.learnings_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.conclusion, "no_push");
  assert.equal(outcomes[0]!.pushed_head_sha, undefined);
  assert.equal(outcomes[0]!.shadow_id, of(run, "fix.learnings_shadow")[0]!.shadow_id);
});

test("W1-T14138 criterion 4: a successful no-op push does not claim the already-published head", async () => {
  const run = await fixRung({ corpus: CORPUS, noCommit: true });
  const done = of(run, "fix.done")[0]!;
  const outcome = of(run, "fix.learnings_outcome")[0]!;
  assert.equal(done.pushed_head_sha, run.pushed[0]);
  assert.equal(done.fix_learnings_no_push, true);
  assert.equal(outcome.conclusion, "no_push");
  assert.equal(outcome.rounds_to_green, undefined);
});

test("W1-T14138 criterion 3: a push receipt cannot extend the prompt sequence after failed remote verification", async () => {
  for (const taskId of [OFFERED_TASK, WITHHELD_TASK]) {
    for (const remoteAfterPush of ["unreadable", "advanced", "missing"] as const) {
      const run = await fixRung({ corpus: CORPUS, taskId, remoteAfterPush, ci: ["green", "green"] });
      assert.equal(run.prompts.length, 1, remoteAfterPush);
      assert.equal(run.waits, 0, remoteAfterPush);
      assert.equal(run.reviews, 0, remoteAfterPush);
      const done = of(run, "fix.done")[0]!;
      assert.equal(done.push_outcome, remoteAfterPush === "unreadable" ? "remote_unreadable" : "not_on_remote");
      assert.equal(done.pushed_head_sha, undefined);
      assert.equal(done.fix_learnings_pushed_head_sha, run.pushed[0]);
      assert.equal(of(run, "fix.learnings_outcome").length, 0, "the receipt has no observed CI conclusion");
    }
  }
});

test("W1-T14138 criterion 4: terminal CI on the pushed head takes precedence over a check handoff for measurement", async () => {
  const terminal = await fixRung({ corpus: CORPUS, ci: ["green", "green"], checkHandoff: "pushed-head" });
  const [outcome] = of(terminal, "fix.learnings_outcome");
  assert.equal(outcome?.conclusion, "green");
  assert.equal(outcome?.pushed_head_sha, terminal.pushed[0]);
  assert.equal(outcome?.rounds_to_green, 1);
  assert.equal(of(terminal, "fix.live_round_resumed")[0]?.failure, "check");
  assert.equal(of(terminal, "fix.ci_not_green")[0]?.ci, "red", "routing still follows the handoff");

  const timedOut = await fixRung({ corpus: CORPUS, ci: ["timeout"], checkHandoff: "pushed-head" });
  assert.deepEqual(of(timedOut, "fix.learnings_outcome").map((row) => row.conclusion), ["red"]);
  const foreign = await fixRung({ corpus: CORPUS, ciOnOtherHead: true, checkHandoff: "other-head" });
  assert.equal(of(foreign, "fix.learnings_outcome").length, 0);
});

test("W1-T14138 criterion 4: a leased push survives ref deletion in shadow attribution only after acceptance", async () => {
  for (const leasedRefDeleted of ["after-push", "before-push"] as const) {
    const run = await fixRung({ corpus: CORPUS, leasedRefDeleted });
    const [done] = of(run, "fix.done");
    assert.equal(done?.push_outcome, "failed");
    assert.equal(done?.pushed_head_sha, undefined);
    assert.equal(of(run, "fix.round_reapply_refused").length, 1);
    assert.equal(run.prompts.length, 1);
    assert.equal(run.waits, 0);
    assert.equal(run.reviews, 0);
    if (leasedRefDeleted === "after-push") {
      assert.equal(done?.fix_learnings_pushed_head_sha, run.pushed[0]);
      assert.deepEqual(of(run, "fix.learnings_outcome"), []);
    } else {
      assert.equal(done?.fix_learnings_pushed_head_sha, undefined);
      assert.deepEqual(of(run, "fix.learnings_outcome").map((row) => row.conclusion), ["no_push"]);
    }
  }
});

test("known CI failures remain selectable without CI evidence from the prompt", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-known-ci-`));
  try {
    mkdirSync(join(root, "learnings"));
    writeFileSync(join(root, "learnings", "ci.yaml"), CORPUS);
    const round = recordFixLearningsShadow({ taskId: OFFERED_TASK, runId: "known-ci", prNumber: 7, attempt: 1,
      round: "resume", roundId: "known-ci:1", repoDir: root, config: { root } as Config,
      evidence: {}, knownCiFailures: FIRST_RED, priorRows: [] });
    assert.deepEqual(round.row.failing_checks, ["unit-shadow-check"]);
    assert.deepEqual(matchedIds(round.row), ["by-check-name", "by-log-error", "by-title-symbol"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable corpus is recorded as a selection error, never as an empty match, and the round still runs", async () => {
  const run = await fixRung({ corpus: "- id: [unclosed\n" });
  const row = of(run, "fix.learnings_shadow")[0]!;
  assert.equal(row.matched, null);
  assert.match(String(row.selection_error), /not valid YAML/);
  assert.equal(run.prompts.length, 1);
  assert.equal(summarizeFixLearningsShadow(run.rows).offered.selectionErrors, 1);
});

test("selection reads unmet claims, findings and only the newest part of a log tail", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-text-`));
  try {
    mkdirSync(join(root, "learnings"));
    writeFileSync(join(root, "learnings", "ci.yaml"), [
      lesson("by-claim", "  error_signatures: [CLAIM-SIG]\n"),
      lesson("by-mechanism", "  error_signatures: [MECHANISM-SIG]\n"),
      lesson("by-remedy", "  error_signatures: [REMEDY-SIG]\n"),
      lesson("by-old-log", "  error_signatures: [OLD-LOG-SIG]\n"),
    ].join("\n"));
    const round = recordFixLearningsShadow({
      taskId: OFFERED_TASK, runId: "r", prNumber: undefined, attempt: 1, round: "resume", roundId: "r1", repoDir: root, config: { root } as Config,
      priorRows: [],
      evidence: {
        ciFailures: [{ name: "c", logTail: `OLD-LOG-SIG${"x".repeat(FIX_LEARNINGS_LOG_TAIL_CHARS)}` }],
        review: {
          unmetCriteria: [{ claim: "CLAIM-SIG" }],
          findings: [{ mechanism: "MECHANISM-SIG", remedy: "REMEDY-SIG" }],
        },
      },
    });
    assert.deepEqual(matchedIds(round.row), ["by-claim", "by-mechanism", "by-remedy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const openRound = (roundId = "r1", priorRows: Array<Record<string, unknown>> = []): FixLearningsRound =>
  ({ row: { shadow_id: "s", run_id: "r", task_id: "W1-T1", round_id: roundId, arm: "offered" }, priorRows });

test("only a push on a known head waits for CI, and only a conclusion on that head is recorded", () => {
  const unnamed = openRound();
  assert.equal(fixLearningsDoneConclusion(unnamed, { subtype: "commit_refused" }), undefined, "a row naming no round");
  assert.equal(fixLearningsDoneConclusion(unnamed, { round_id: "r1", push_outcome: "unverified" }), undefined);
  assert.deepEqual(unnamed.pushed, { head: undefined });
  assert.equal(fixLearningsCiConclusion(unnamed, "green", undefined), undefined);

  const unreadableRemote = openRound("r-remote-unreadable");
  assert.equal(fixLearningsDoneConclusion(unreadableRemote, {
    round_id: "r-remote-unreadable", push_outcome: "remote_unreadable",
  }), undefined, "a successful push with an unreadable remote is not a no-push outcome");
  assert.deepEqual(unreadableRemote.pushed, { head: undefined });
  assert.equal(fixLearningsCiConclusion(unreadableRemote, "green", undefined), undefined,
    "without a verifiable pushed head its CI result remains unobserved");

  const round = openRound();
  assert.equal(fixLearningsCiConclusion(round, "green", undefined), undefined, "nothing pushed yet");
  assert.equal(fixLearningsDoneConclusion(round, { round_id: "other-round", pushed_head_sha: "other-head" }), undefined);
  assert.equal(round.pushed, undefined, "another round cannot claim this measurement");
  assert.equal(fixLearningsDoneConclusion(round, { round_id: "r1", pushed_head_sha: "abc" }), undefined);
  assert.equal(fixLearningsDoneConclusion(round, { round_id: "r1" }), undefined, "a later row cannot undo the push");
  assert.equal(fixLearningsCiConclusion(round, "timeout", "abc"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "freshness_handoff", "abc"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "green", "def"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "red", "abc"), "red");
  assert.equal(fixLearningsCiConclusion(round, "green", "abc"), "green");
  assert.equal(fixLearningsCiConclusion(round, "green", undefined), undefined, "CI must identify the head it judged");
});

test("rounds to green joins this task's dispatched and pushed rounds from earlier runs and this one", () => {
  const earlier = [
    { step: "fix.dispatch", task_id: "W1-T1", round_id: "r1" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r1", pushed_head_sha: "a" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r2", pushed_head_sha: "b" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r3" },
    { step: "fix.done", task_id: "W1-T1", round_id: "unverified-after-receipt", fix_learnings_pushed_head_sha: "c" },
    { step: "fix.dispatch", task_id: "W1-T1", round_id: "no-op" },
    { step: "fix.done", task_id: "W1-T1", round_id: "no-op", pushed_head_sha: "c", fix_learnings_no_push: true },
    { step: "fix.dispatch", task_id: "W1-T2", round_id: "other" },
    { step: "fix.dispatch", task_id: "W1-T1" },
  ];
  const round = openRound("r4", earlier);
  const thisRung = [{ step: "fix.dispatch", task_id: "W1-T1", round_id: "r4" }];
  assert.equal(fixLearningsOutcomeRow(round, "green", thisRung).rounds_to_green, 4);
  assert.equal(fixLearningsOutcomeRow(round, "red", thisRung).rounds_to_green, undefined);
});

test("the summary reports match and outcome rates per arm, counting each round once", () => {
  const shadow = (id: string, arm: string, matched: unknown) => ({ step: "fix.learnings_shadow", shadow_id: id, task_id: id, arm, matched });
  const outcome = (id: string, conclusion: string) => ({ step: "fix.learnings_outcome", shadow_id: id, conclusion });
  const rows = [
    shadow("a", "offered", [{ id: "l", kinds: ["error"] }]),
    shadow("a", "offered", [{ id: "l", kinds: ["error"] }]),
    shadow("b", "offered", []),
    shadow("c", "offered", null),
    outcome("a", "red"), outcome("b", "no_push"),
  ];
  const summary = summarizeFixLearningsShadow(rows);
  assert.deepEqual(summary.offered, {
    rounds: 3, selectionErrors: 1, roundsWithMatch: 1, matchRate: { error: 0.5, symbol: 0 },
    outcomes: { green: 0, red: 1, no_push: 1, unobserved: 1 }, outcomeRates: { green: 0, red: 0.5, no_push: 0.5 },
    roundsToGreen: {},
  });
  assert.deepEqual(summary.withheld.matchRate, { error: null, symbol: null });
  assert.deepEqual(summary.withheld.outcomeRates, { green: null, red: null, no_push: null });
});
