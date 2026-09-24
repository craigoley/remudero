/**
 * W1-T4450 — a fix round that did the work lands it.
 *
 * MEASURED 2026-09-24: 62 of 65 fix rounds in a day ended `commit_refused`. Three causes, each pinned here:
 * the harness refused the regenerable baseline edit a failing census asks for (the fix prompt and the
 * scope guard both allow it), the fix lane never re-asked for a missing COMMIT_MESSAGE line the way
 * implement does (W1-T4052), and every fix round in a daemon run was archived as `fix-1`, so each one
 * overwrote the last round's evidence.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { COMMIT_LINE_RESUME_PROMPT, commitWorkerEdits, harnessCommitForShellLessWorker, runFixRung } from "../src/run-task.js";
import { REGENERABLE_ARTIFACT_GENERATORS } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const BASELINE = "scripts/comment-load-baseline.json";

function worker(text: string, over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 1,
    numTurns: 2,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = { claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" };
  return { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

/** A fix rung whose worker leaves edits but no COMMIT_MESSAGE line, with every seam recorded. */
function fixRung(opts: { root?: string; runId?: string; answer?: string; edits?: boolean }) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "rmd-w1-t4450-"));
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  const spawns: SpawnWorkerArgs[] = [];
  const reports: string[] = [];
  const run = {
    taskId: "W1-T4450X",
    runId: opts.runId ?? "W1-T4450X-run",
    task: { id: "W1-T4450X", title: "the fix lands", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/4450",
    branch: "run-W1-T4450X-1",
    worktreePath: process.cwd(),
    initialSessionId: "initial-session",
    mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10,
    strikeCap: 1,
    initialReview: failedReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    deps: {
      spawn: async (args: SpawnWorkerArgs) => {
        spawns.push(args);
        return spawns.length === 1 ? worker("REPORT\nthe edit is saved; checking one more thing") : worker(opts.answer ?? "COMMIT_MESSAGE: fix(ci): record the missing baseline row");
      },
      waitForCiGreen: async () => "green" as const,
      runReview: async () => failedReview(),
      fetchPrBody: async () => "REPORT",
      push: () => {},
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
      say: () => {},
      account: (result: WorkerResult) => result,
      worktreeHasUncommittedChanges: () => opts.edits ?? true,
      harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) => {
        reports.push(input.report);
        // The real parse, over a fake commit: the line either is or is not in what the harness read.
        return harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: "new-head", undeclared: [] }), ahead: () => 1 });
      },
    },
  };
  return { run, lines, spawns, reports, root };
}

test("W1-T4450: a fix round's regenerable baseline edit is committed", () => {
  assert.ok(Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, BASELINE), "the baseline is a registered regenerable artifact");
  const repo = gitRepo({ kind: "w1t4450", seedCommit: true });
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, BASELINE), "{}\n");
  writeFileSync(join(repo.dir, "scripts/other.json"), "{}\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  // The worker did exactly what the failing census asked: it recorded the missing row, and nothing else.
  writeFileSync(join(repo.dir, BASELINE), '{ "src/new.ts": 500 }\n');
  const landed = commitWorkerEdits(repo.dir, ["src/new.ts"], "fix(ci): record the missing baseline row");
  assert.equal(landed.committed, true, landed.reason);
  assert.deepEqual(landed.regenerable, [BASELINE]);
  assert.equal(repo.git("show", "--name-only", "--format=", "HEAD").trim(), BASELINE);
  // The control: an undeclared path that is NOT registered is still refused, never staged.
  writeFileSync(join(repo.dir, "scripts/other.json"), '{ "x": 1 }\n');
  const refused = commitWorkerEdits(repo.dir, ["src/new.ts"], "fix(ci): touch something else");
  assert.equal(refused.committed, false);
  assert.equal(refused.reason, "every change the worker made is outside its declared files");
  assert.deepEqual(refused.undeclared, ["scripts/other.json"]);
});

test("W1-T4450: the fix lane re-asks once for a missing commit line", async () => {
  const asked = fixRung({});
  await runFixRung(asked.run);
  assert.equal(asked.spawns.length, 2, "one fix round, then one re-ask");
  assert.equal(asked.spawns[1]!.prompt, COMMIT_LINE_RESUME_PROMPT);
  assert.equal(asked.spawns[1]!.resumeSessionId, "fix-session", "the SAME session is asked");
  assert.ok(asked.lines.some((l) => l.step === "fix.commit_line_requested"));
  assert.equal(asked.lines.some((l) => l.step === "fix.commit_refused"), false, "the answered line lands the round");
  assert.match(asked.reports[1]!, /the edit is saved[\s\S]*COMMIT_MESSAGE: fix\(ci\)/, "the answer is appended to the original report");
  // Still absent after the one ask: refused once, never looped, and the parsed tail is ledgered.
  const silent = fixRung({ answer: "still no line" });
  await runFixRung(silent.run);
  assert.equal(silent.spawns.length, 2);
  const refusal = silent.lines.find((l) => l.step === "fix.commit_refused");
  assert.equal(refusal?.reason, "no anchored COMMIT_MESSAGE line in the report");
  assert.match(String(silent.lines.filter((l) => l.step === "implement.harness_commit_refused").at(-1)?.report_tail), /still no line/);
  // The control: a round that left no edits is not asked for a line it has nothing to commit.
  const idle = fixRung({ edits: false });
  await runFixRung(idle.run);
  assert.equal(idle.spawns.length, 1);
});

test("W1-T4450: each fix round keeps its own transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4450-archive-"));
  // Two fix invocations inside one daemon run: the second used to overwrite the first's `fix-1`.
  await runFixRung(fixRung({ root, runId: "DAEMON-4450" }).run);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await runFixRung(fixRung({ root, runId: "DAEMON-4450" }).run);
  const archived = readdirSync(join(root, "state", "transcripts", "W1-T4450X")).filter((f) => f.startsWith("DAEMON-4450.fix-1-"));
  assert.equal(archived.length, 2, archived.join(", "));
});
