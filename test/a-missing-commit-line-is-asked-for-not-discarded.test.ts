/**
 * W1-T4052 — A SHELL-LESS WORKER THAT OMITS ITS COMMIT_MESSAGE LINE LOSES ALL ITS EDITS.
 *
 * MEASURED 2026-09-22 from the ledger union: 188 `implement.harness_commit_refused` rows since
 * 2026-09-17 carried the reason "no anchored COMMIT_MESSAGE line in the report" — 82 distinct
 * runs, 112 distinct tasks — against 110 commits that landed. The worker did the work and saved it
 * to the worktree; one REPORT line was absent, and the run returned `no_pr` anyway.
 *
 * `harnessCommitForShellLessWorker` (test/the-harness-commits-for-a-worker-with-no-shell.test.ts)
 * is right to refuse: inventing a subject would attribute work to a run that never asked for it.
 * `resumeForMissingCommitLine` does not weaken that refusal — it resumes the SAME worker session
 * ONCE, asking for nothing but the missing line, and retries the commit through the unchanged
 * helper. These fixtures pin the recovery's four edges: it commits when the line finally arrives,
 * it refuses (without looping) when the line still does not, it never fires on a clean worktree,
 * and it never lets a resume smuggle in an invented subject.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { COMMIT_LINE_RESUME_PROMPT, commitLineResume, resumeForMissingCommitLine } from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
// The SHARED builder — see test/fixture-copy-census.test.ts, which refuses one more hand-rolled
// `git init` copy of this exact fixture.
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MISSING_LINE_REASON = "no anchored COMMIT_MESSAGE line in the report";

function harnessFixture(kind: string): { handle: GitRepo; root: string; head: () => string; before: string } {
  const handle = gitRepo({ kind });
  const root = handle.dir;
  // Own identity, not the ambient host/CI one — see test/helpers/git-repo.ts's own doc and the
  // sibling W1-T3696 suite, which hit "Author identity unknown" on CI without this.
  handle.git("config", "user.email", "harness@example.test");
  handle.git("config", "user.name", "harness fixture");
  handle.git("config", "commit.gpgsign", "false");
  const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { handle, root, head, before: head() };
}

test("W1-T4052: a missing commit line is asked for and the edits are committed", async () => {
  const { handle, root, head, before } = harnessFixture("missing-commit-line-recovered");
  try {
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/a.ts`, "export const a = 1;\n");

    const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const said: string[] = [];
    let resumeCalls = 0;
    const recovery = await resumeForMissingCommitLine(
      {
        commitCount: 0,
        refusalReason: MISSING_LINE_REASON,
        report: "REPORT\nfixed the thing, but forgot the anchored line",
        worktreePath: root,
        declaredPaths: ["src"],
        log: (step, extra) => lines.push({ step, extra }),
        say: (msg) => said.push(msg),
        resume: async () => {
          resumeCalls += 1;
          return {
            text: "REPORT\nCOMMIT_MESSAGE: feat(a): add a",
            costUsd: 0.02,
            sessionId: "s-resumed",
            numTurns: 1,
            subtype: "success",
          };
        },
      },
      {
        // A real `commitsAhead` needs `origin/main`, which this bare fixture never gets — the
        // count itself is `harnessCommitForShellLessWorker`'s own concern (already proven in
        // test/the-harness-commits-for-a-worker-with-no-shell.test.ts); this only needs it
        // RE-READ, which `commitCount: 1` below stands in for.
        ahead: () => 1,
      },
    );

    assert.equal(resumeCalls, 1, "the worker's own session must be resumed exactly once");
    assert.equal(recovery.commitCount, 1, "the resumed commit message must clear the no_pr guard");
    assert.equal(recovery.refusalReason, undefined, "a landed commit carries no refusal reason");
    assert.equal(recovery.resumed, true);
    assert.match(recovery.report, /COMMIT_MESSAGE: feat\(a\): add a/, "the resumed line rides the returned report");
    assert.notEqual(head(), before, "the harness must actually commit the worker's already-saved edits");

    assert.ok(
      lines.some((l) => l.step === "implement.commit_line_requested"),
      "every resume attempt must be ledgered, so the recovery rate is a ledger read",
    );
    const resumedRow = lines.find((l) => l.step === "implement.resumed");
    assert.ok(resumedRow, "the resumed turn's telemetry must be ledgered like any other resumed turn");
    assert.equal(resumedRow?.extra?.cost_usd, 0.02, "the resume's cost must ride implement.resumed");
    assert.equal(resumedRow?.extra?.session_id, "s-resumed");
    assert.equal(lines.at(-1)?.step, "implement.harness_commit", "the retried commit runs through the unchanged helper");
    assert.match(said.at(-1) ?? "", /had no shell of its own/);

    const named = execFileSync("git", ["-C", root, "show", "--name-only", "--format=%s", "HEAD"], { encoding: "utf8" });
    assert.match(named, /feat\(a\): add a/, "the worker's own resumed subject is what actually lands");
    assert.match(named, /src\/a\.ts/);
  } finally {
    handle.cleanup();
  }
});

test("W1-T4052: a second missing line is still refused", async () => {
  const { handle, root, head, before } = harnessFixture("missing-commit-line-twice");
  try {
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/a.ts`, "export const a = 1;\n");

    const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    let resumeCalls = 0;
    const recovery = await resumeForMissingCommitLine(
      {
        commitCount: 0,
        refusalReason: MISSING_LINE_REASON,
        report: "REPORT\nstill nothing anchored",
        worktreePath: root,
        declaredPaths: ["src"],
        log: (step, extra) => lines.push({ step, extra }),
        say: () => {},
        resume: async () => {
          resumeCalls += 1;
          return { text: "REPORT\nstill no anchored line in this reply either" };
        },
      },
    );

    assert.equal(resumeCalls, 1, "the recovery must not loop past its one resume");
    assert.equal(recovery.commitCount, 0, "no commit message ever arrived, so nothing can be committed");
    assert.match(
      recovery.refusalReason ?? "",
      /asked the worker's own session once/,
      "the second refusal must name that the resume was tried",
    );
    assert.equal(lines.at(-1)?.step, "implement.harness_commit_refused");
    assert.match(String(lines.at(-1)?.extra?.reason), /asked the worker's own session once/);
    assert.equal(head(), before, "a refusal must never move HEAD");
  } finally {
    handle.cleanup();
  }
});

test("W1-T4052: no edits means no resume", async () => {
  let resumeCalls = 0;
  const resume = async () => {
    resumeCalls += 1;
    return { text: "REPORT\nCOMMIT_MESSAGE: feat(a): b" };
  };

  // A REAL clean worktree, read by the real `git status`: the missing-line reason is present, but
  // there is nothing to commit even if the worker did name a subject — resuming it would only
  // relearn what committing already knows.
  const clean = harnessFixture("missing-commit-line-clean");
  try {
    const recovery = await resumeForMissingCommitLine({
      commitCount: 0,
      refusalReason: MISSING_LINE_REASON,
      report: "REPORT\nnothing changed",
      worktreePath: clean.root,
      declaredPaths: ["src"],
      log: () => {},
      say: () => {},
      resume,
    });
    assert.equal(resumeCalls, 0, "a clean worktree must never be resumed");
    assert.equal(recovery.resumed, false);
    assert.equal(recovery.commitCount, 0);
    assert.equal(clean.head(), clean.before, "a clean worktree is never committed");
  } finally {
    clean.handle.cleanup();
  }

  // AND THE CONTROL: a DIFFERENT refusal reason (the pre-existing "changed nothing" case, which
  // this task leaves untouched) must never resume either, even over a worktree that DOES hold
  // uncommitted edits — the reason alone gates the resume.
  const dirty = harnessFixture("missing-commit-line-other-reason");
  try {
    mkdirSync(`${dirty.root}/src`, { recursive: true });
    writeFileSync(`${dirty.root}/src/a.ts`, "export const a = 1;\n");
    const otherReason = await resumeForMissingCommitLine({
      commitCount: 0,
      refusalReason: "the worker changed nothing",
      report: "REPORT\nCOMMIT_MESSAGE: feat(a): b",
      worktreePath: dirty.root,
      declaredPaths: ["src"],
      log: () => {},
      say: () => {},
      resume,
    });
    assert.equal(resumeCalls, 0, "only the exact missing-line reason ever triggers a resume");
    assert.equal(otherReason.resumed, false);
    assert.equal(dirty.head(), dirty.before, "a non-missing-line refusal is left exactly as it was");
  } finally {
    dirty.handle.cleanup();
  }
});

test("W1-T4052: the harness never invents a subject", async () => {
  const { handle, root, head, before } = harnessFixture("missing-commit-line-no-invent");
  try {
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/a.ts`, "export const a = 1;\n");

    let committedWith: string | undefined;
    const recovery = await resumeForMissingCommitLine(
      {
        commitCount: 0,
        refusalReason: MISSING_LINE_REASON,
        report: "REPORT\nno subject anywhere in the original report either",
        worktreePath: root,
        declaredPaths: ["src"],
        log: () => {},
        say: () => {},
        resume: async () => ({ text: "REPORT\nstill nothing anchored" }),
      },
      {
        // If the recovery ever synthesized a subject, this spy would see it.
        commit: (_worktreePath, _declaredPaths, message) => {
          committedWith = message;
          return { committed: true, sha: "x".repeat(8), undeclared: [] };
        },
      },
    );

    assert.equal(committedWith, undefined, "no anchored message must mean no commit call — never an invented subject");
    assert.equal(recovery.commitCount, 0);
    assert.equal(head(), before, "HEAD must not move without a real, worker-named subject");
  } finally {
    handle.cleanup();
  }
});

test("W1-T4052: the resume spawns the worker's own session with only the commit-line prompt", async () => {
  const spawned: SpawnWorkerArgs[] = [];
  const accounted: WorkerResult[] = [];
  const result: WorkerResult = {
    sessionId: "s-resumed",
    costUsd: 0.03,
    numTurns: 2,
    text: "COMMIT_MESSAGE: feat(a): add a",
    blocks: ["REPORT"],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    compactionFailures: [],
    qualitySuspect: false,
  };
  const resume = commitLineResume(
    async (args) => {
      spawned.push(args);
      return result;
    },
    (r) => {
      accounted.push(r);
      return r;
    },
    {
      cwd: "/wt/run",
      permissionMode: "bypassPermissions",
      settingsFile: "/wt/settings.json",
      resumeSessionId: "s-original",
      maxBudgetUsd: 4,
    },
  );
  assert.equal(spawned.length, 0, "building the callback must not spawn anything");

  const reply = await resume();

  assert.equal(spawned.length, 1, "one resume, one spawn");
  assert.equal(spawned[0]?.resumeSessionId, "s-original", "the worker's OWN session is the one resumed");
  assert.equal(spawned[0]?.cwd, "/wt/run", "the resume runs in the worktree holding the saved edits");
  assert.equal(spawned[0]?.permissionMode, "bypassPermissions");
  assert.equal(spawned[0]?.maxBudgetUsd, 4, "the original spawn's mount rides the resume unchanged");
  assert.equal(spawned[0]?.prompt, COMMIT_LINE_RESUME_PROMPT, "the resume asks for the commit line and nothing else");
  assert.match(COMMIT_LINE_RESUME_PROMPT, /Make NO further edits/);
  assert.match(COMMIT_LINE_RESUME_PROMPT, /`COMMIT_MESSAGE: <type>\(<scope>\): <subject>`/);
  assert.deepEqual(accounted, [result], "the resumed turn is accounted against the run's budget");
  assert.deepEqual(reply, {
    text: "COMMIT_MESSAGE: feat(a): add a\nREPORT",
    costUsd: 0.03,
    sessionId: "s-resumed",
    numTurns: 2,
    subtype: "success",
  });
});
