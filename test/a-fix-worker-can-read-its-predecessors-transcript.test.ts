import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as runner from "./helpers/run-task-test.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";

const { archiveWorkerTranscript, runFixRung, TRANSCRIPT_EXCERPT_CAP, TRANSCRIPT_RETENTION_DEFAULT,
  withPredecessorTranscriptCopies } = runner;
const hook = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));
const taskId = "W1-T5682";
const runId = "current-run";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-readable-predecessor-"));
  const worktree = join(root, "worktree");
  const scratch = join(root, "provider-scratch");
  const home = join(root, "worker-home-test");
  for (const dir of [worktree, scratch, home]) mkdirSync(dir);
  const archive = (id: string, run: string, text: string, mtime: number) => {
    const result = archiveWorkerTranscript({ root, taskId: id, runId: run, rung: "implement", text,
      retention: 10 }, () => {});
    assert.ok(result);
    utimesSync(result.path, mtime, mtime);
    return result.path;
  };
  const older = archive(taskId, "older-run", "older attempt", 1);
  const newer = archive(taskId, "newer-run", "newer attempt", 2);
  const current = archive(taskId, runId, "current attempt", 3);
  const other = archive("W1-T9999", "other-run", "another task's private transcript", 4);
  return { root, worktree, scratch, home, older, newer, current, other };
}

function floor(fx: ReturnType<typeof fixture>, path: string, scratch: string) {
  return spawnSync("bash", [hook, "--confine-file-tools"], {
    input: JSON.stringify({ cwd: fx.worktree, tool_name: "Read", tool_input: { file_path: path } }),
    encoding: "utf8",
    env: { ...process.env, HOME: fx.home, TMPDIR: scratch, CLAUDE_PROJECT_DIR: fx.worktree },
  });
}

test("test/a-fix-worker-can-read-its-predecessors-transcript.test.ts: a fix rung copies readable predecessors while another task stays refused", async () => {
  const fx = fixture();
  const stopped = new Error("fixture stops after observing the worker dispatch");
  let copies: string[] = [];
  let dispatched = false;
  try {
    const observe = async (args: SpawnWorkerArgs): Promise<never> => {
      dispatched = true;
      copies = args.prompt.split("\n").filter((line) => line.startsWith("- /")).map((line) => line.slice(2));
      assert.equal(copies.length, 2, "only this task's earlier runs are offered");
      assert.equal(floor(fx, fx.newer, fx.scratch).status, 2, "control: raw archives are refused");
      for (const path of copies) {
        for (const scratch of [args.env?.TMPDIR ?? fx.scratch, fx.scratch]) {
          const result = floor(fx, path, scratch);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(floor(fx, fx.other, scratch).status, 2, "another task remains outside the floor");
        }
      }
      assert.equal(readFileSync(copies[0], "utf8"), readFileSync(fx.newer, "utf8"));
      assert.equal(readFileSync(copies[1], "utf8"), readFileSync(fx.older, "utf8"));
      const workerTmp = args.env?.TMPDIR;
      assert.ok(workerTmp);
      assert.ok(copies.every((path) => path.startsWith(`${workerTmp}/`)));
      assert.ok(!args.prompt.includes(fx.current));
      assert.ok(!args.prompt.includes(fx.other));
      throw stopped;
    };
    const criterion = { claim: "fix the defect", proof: "unit test: fixture", met: false,
      reason: "unmet", proof_exec: "executed_fail" as const };
    const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
    await assert.rejects(runFixRung({
      taskId, runId, task: { id: taskId, title: "read a predecessor", files: ["src/run-task.ts"] },
      prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T5682-1",
      worktreePath: fx.worktree, initialSessionId: "initial-session", mount,
      settingsFile: "unused", config: { root: fx.root } as never, budgetUsd: 1, strikeCap: 1,
      initialReview: { state: "failure", criteria: [criterion], testTheater: false, summary: "unmet",
        floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "deadbeef",
        reviewerOutcome: "success" },
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: fx.worktree, reviewerMount: mount },
      deps: {
        spawn: observe, waitForCiGreen: async () => "green", runReview: async () => assert.fail("no review"),
        push: () => assert.fail("no push"), issues: {} as never, account: (result) => result,
        ledgerPath: join(fx.root, "ledger.ndjson"), ledgerLines: () => [],
        fetchPrBody: async () => `Remudero-Task: ${taskId}`,
        fetchPrDiffFiles: async () => ["src/run-task.ts"], log: () => {}, say: () => {},
      },
    }), (error) => error === stopped);
    assert.equal(dispatched, true);
    assert.ok(copies.every((path) => !existsSync(path)), "copies are reaped after a rejected spawn");
    for (const path of [fx.older, fx.newer, fx.current, fx.other]) assert.ok(existsSync(path));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function argsFor(fx: ReturnType<typeof fixture>): SpawnWorkerArgs {
  return { cwd: fx.worktree, permissionMode: "bypassPermissions", settingsFile: "unused",
    prompt: "diagnose this failure", env: { LANG: "C", TMPDIR: fx.scratch } };
}

const pathsIn = (args: SpawnWorkerArgs) => args.prompt.split("\n")
  .filter((line) => line.startsWith("- /")).map((line) => line.slice(2));

test("predecessor copies cap bytes, preserve the newest-first limit and are removed on success", async () => {
  const fx = fixture();
  const opts = { root: fx.root, taskId, excludeRunId: runId, limit: 1 };
  let scratch = "";
  try {
    writeFileSync(fx.newer, "x".repeat(TRANSCRIPT_EXCERPT_CAP * 2));
    const returned = await withPredecessorTranscriptCopies(argsFor(fx), opts, async (args) => {
      scratch = args.env!.TMPDIR;
      assert.equal(args.env!.LANG, "C", "existing spawn environment survives");
      const paths = pathsIn(args);
      assert.equal(paths.length, 1);
      assert.match(paths[0], /newer-run\.implement\.md$/);
      assert.equal(statSync(paths[0]).size, TRANSCRIPT_EXCERPT_CAP);
      assert.equal(readFileSync(paths[0], "utf8"), "x".repeat(TRANSCRIPT_EXCERPT_CAP));
      assert.equal(statSync(paths[0]).mode & 0o777, 0o600);
      assert.equal(args.prompt.startsWith("diagnose this failure\n"), true);
      return "completed";
    }, () => assert.fail("unexpected copy failure"));
    assert.equal(returned, "completed");
    assert.equal(existsSync(scratch), false);
    assert.equal(statSync(fx.newer).size, TRANSCRIPT_EXCERPT_CAP * 2, "archive remains intact");
    utimesSync(fx.newer, 2, 2);
    for (let i = 0; i < TRANSCRIPT_RETENTION_DEFAULT + 1; i++) {
      const archived = archiveWorkerTranscript({ root: fx.root, taskId, runId: `extra-${i}`,
        rung: "fix", text: `${i}`, retention: 10 }, () => {});
      assert.ok(archived);
      utimesSync(archived.path, 10 + i, 10 + i);
    }
    await withPredecessorTranscriptCopies(argsFor(fx), { root: fx.root, taskId, excludeRunId: runId },
      async (args) => {
        const paths = pathsIn(args);
        assert.equal(paths.length, TRANSCRIPT_RETENTION_DEFAULT);
        assert.deepEqual(paths.map((path) => readFileSync(path, "utf8").trim().split("\n").at(-1)),
          ["5", "4", "3", "2", "1"]);
      }, () => assert.fail("unexpected copy failure"));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a task with no predecessors or a zero limit keeps its original prompt and environment", async () => {
  const fx = fixture();
  const args = argsFor(fx);
  try {
    for (const opts of [{ root: fx.root, taskId: "missing-task" }, { root: fx.root, taskId, limit: 0 }]) {
      await withPredecessorTranscriptCopies(args, opts, async (received) => assert.equal(received, args),
        () => assert.fail("absence is not a copy error"));
    }
    assert.deepEqual(readdirSync(fx.worktree), [], "absence creates no scratch directory");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("an unreadable predecessor is named in the log while readable siblings are still offered", async () => {
  const fx = fixture();
  const failures: Record<string, unknown>[] = [];
  try {
    rmSync(fx.newer);
    mkdirSync(fx.newer);
    await withPredecessorTranscriptCopies(argsFor(fx), { root: fx.root, taskId, excludeRunId: runId },
      async (args) => {
        const paths = pathsIn(args);
        assert.equal(paths.length, 1);
        assert.equal(readFileSync(paths[0], "utf8"), readFileSync(fx.older, "utf8"));
        assert.ok(!args.prompt.includes("newer-run"));
      }, (step, fields) => {
        assert.equal(step, "transcript.copy_error");
        failures.push(fields!);
      });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, fx.newer);
    assert.match(String(failures[0].reason), /not a regular file/);
    assert.deepEqual(readdirSync(join(fx.worktree, "state")), []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("symlinked transcripts cannot smuggle another task's archive into the worker scratch", async () => {
  const fx = fixture();
  const args = argsFor(fx);
  const failures: Record<string, unknown>[] = [];
  try {
    for (const path of [fx.older, fx.newer]) {
      rmSync(path);
      symlinkSync(fx.other, path);
    }
    await withPredecessorTranscriptCopies(args, { root: fx.root, taskId, excludeRunId: runId },
      async (received) => assert.equal(received, args), (step, fields) => {
        assert.equal(step, "transcript.copy_error");
        failures.push(fields!);
      });
    assert.equal(failures.length, 2);
    for (const failure of failures) assert.match(String(failure.reason), /ELOOP/);
    assert.deepEqual(readdirSync(join(fx.worktree, "state")), []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a failed scratch directory logs its reason and dispatches without dead transcript pointers", async () => {
  const fx = fixture();
  const args = argsFor(fx);
  try {
    for (const kind of ["file", "symlink"] as const) {
      const state = join(fx.worktree, "state");
      if (kind === "file") writeFileSync(state, "cannot create scratch here");
      else symlinkSync(fx.root, state);
      const failures: Record<string, unknown>[] = [];
      await withPredecessorTranscriptCopies(args, { root: fx.root, taskId, excludeRunId: runId },
        async (received) => assert.equal(received, args), (step, fields) => {
          assert.equal(step, "transcript.copy_error");
          failures.push(fields!);
        });
      assert.equal(failures.length, 1);
      assert.match(String(failures[0].reason), kind === "file" ? /EEXIST/ : /outside the assigned worktree/);
      rmSync(state);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("W1-T6434: runFixRung hands a preserved fix-owner patch at this head to the fix worker's prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t6434-wiring-"));
  const stopped = new Error("fixture stops after observing the worker dispatch");
  const head = "c".repeat(40);
  const recoveryRef = `refs/rmd-recovery/fix-dirty/run-W1-T6434-fixture/${head}/${"d".repeat(40)}`;
  let prompt = "";
  try {
    const criterion = { claim: "the fix lands", proof: "unit test: the fix lands", met: false,
      reason: "still blocked", proof_exec: "not_executable" as const };
    const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
    await assert.rejects(runFixRung({
      taskId: "W1-T6434", runId: "W1-T6434-run", task: { id: "W1-T6434", title: "preserved patch", files: ["src/lib/sweep.ts"] },
      prUrl: "https://github.com/acme/remudero/pull/6434", branch: "run-W1-T6434-1",
      worktreePath: root, initialSessionId: "", mount, settingsFile: "unused",
      config: { root } as never, budgetUsd: 1, strikeCap: 1,
      initialReview: { state: "failure", criteria: [criterion], testTheater: false, summary: "blocked",
        floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: head,
        reviewerOutcome: "failure" },
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
      priorPartialWork: { recoveryRef, stagedPaths: ["src/staged-fix.ts"], excerpt: "export const staged = 2;", excerptTruncated: false },
      deps: {
        spawn: async (args: SpawnWorkerArgs): Promise<never> => { prompt = args.prompt; throw stopped; },
        waitForCiGreen: async () => "green", runReview: async () => assert.fail("no review"),
        push: () => assert.fail("no push"), issues: {} as never, account: (result: unknown) => result,
        ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [],
        fetchPrBody: async () => "Remudero-Task: W1-T6434",
        fetchPrDiffFiles: async () => ["src/lib/sweep.ts"], log: () => {}, say: () => {},
      },
    } as never), (error) => error === stopped);
    assert.match(prompt, /PRIOR PARTIAL WORK/);
    assert.ok(prompt.includes(`RECOVERY REF: ${recoveryRef}`), "the rung carries the preserved patch into the worker prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
