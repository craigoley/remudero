import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { archiveWorkerTranscript, runFixRung, TRANSCRIPT_EXCERPT_CAP, TRANSCRIPT_RETENTION_DEFAULT, transcriptPathFor, withPredecessorTranscriptCopies } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";

test("test/a-fix-worker-can-read-its-predecessors-transcript.test.ts: fix prompt paths allow Read while another task remains refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-predecessor-read-"));
  const scratch = join(root, "scratch");
  const worktree = join(root, "worktree");
  const home = join(root, "worker-home-test");
  for (const dir of [scratch, worktree, home]) mkdirSync(dir);
  const parentTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
  const stopped = new Error("fixture stops after inspecting the dispatched prompt");
  const copiedPaths: string[] = [];
  try {
    const predecessor = archiveWorkerTranscript({ root, taskId: "W1-T5682", runId: "prior", rung: "implement", text: "prior failed attempt" }, () => {});
    const other = archiveWorkerTranscript({ root, taskId: "W1-T9999", runId: "other", rung: "implement", text: "another task" }, () => {});
    assert.ok(predecessor && other);
    const floor = (path: string) => spawnSync("bash", ["hooks/deny-floor.sh", "--confine-file-tools"], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: path }, cwd: worktree }),
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch, HOME: home, CLAUDE_PROJECT_DIR: worktree, XDG_CACHE_HOME: join(root, "cache") },
    });
    assert.equal(floor(join(worktree, "allowed.md")).status, 0, "positive control: the floor allows this worktree");
    assert.equal(floor(predecessor.path).status, 2, "the original archive remains outside the floor");
    assert.equal(floor(other.path).status, 2, "another task's archive remains refused");
    await assert.rejects(runFixRung({
      taskId: "W1-T5682", runId: "current", task: { id: "W1-T5682", title: "repair predecessor access" },
      prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T5682-1", worktreePath: worktree,
      initialSessionId: "", mount, settingsFile: join(root, "settings.json"), config: { root } as Config,
      budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree, reviewerMount: mount },
      initialReview: { state: "failure", criteria: [], testTheater: false, summary: "ci failed", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "fixture-head", reviewerOutcome: "sweep-reconstructed-ci-log" },
      ciFailures: [{ name: "ci", logTail: "build failed" }],
      deps: {
        spawn: async (args) => {
          copiedPaths.push(...args.prompt.split("\n").filter((line) => line.startsWith("- ") && line.endsWith(".md")).map((line) => line.slice(2)));
          assert.equal(copiedPaths.length, 1);
          assert.equal(floor(copiedPaths[0]).status, 0, "the actual fix prompt names a readable scratch copy");
          assert.notEqual(copiedPaths[0], predecessor.path);
          assert.equal(readFileSync(copiedPaths[0], "utf8"), readFileSync(predecessor.path, "utf8"));
          throw stopped;
        },
        waitForCiGreen: async () => "green", runReview: async () => { throw stopped; }, push: () => {},
        issues: { create: () => "", listOpen: () => [], comment: () => {} },
        ledgerPath: join(root, "ledger.ndjson"), log: () => {}, say: () => {}, account: (result) => result,
      },
    }), (error) => error === stopped);
    assert.equal(copiedPaths.length, 1, "the fix rung really dispatched");
    assert.equal(existsSync(dirname(copiedPaths[0])), false, "copies are removed when spawn rejects");
  } finally {
    if (parentTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = parentTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test("predecessor copies preserve newest-first ordering, exclusion, limits and byte caps, then clean up", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-predecessor-bounds-"));
  try {
    const taskId = "W1-T5682";
    const newest = TRANSCRIPT_RETENTION_DEFAULT + 1;
    for (let i = 0; i <= newest; i++) {
      const path = transcriptPathFor(root, taskId, `prior-${i}`, "implement");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(TRANSCRIPT_EXCERPT_CAP + 10, 65 + i));
      utimesSync(path, i + 1, i + 1);
    }
    const copied: string[] = [];
    await withPredecessorTranscriptCopies(root, taskId, { excludeRunId: `prior-${newest}`, limit: 2 }, () => {}, (paths) => {
      copied.push(...paths);
      assert.equal(paths.length, 2);
      assert.deepEqual(paths.map((path) => readFileSync(path)), [Buffer.alloc(TRANSCRIPT_EXCERPT_CAP, 65 + newest - 1), Buffer.alloc(TRANSCRIPT_EXCERPT_CAP, 65 + newest - 2)]);
    });
    assert.ok(copied.every((path) => !existsSync(path)));
    await withPredecessorTranscriptCopies(root, taskId, {}, () => {}, (paths) => assert.equal(paths.length, TRANSCRIPT_RETENTION_DEFAULT));
    await withPredecessorTranscriptCopies(root, taskId, { limit: 0 }, () => {}, (paths) => assert.deepEqual(paths, []));
    await withPredecessorTranscriptCopies(root, "never-archived", {}, () => {}, (paths) => assert.deepEqual(paths, []));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predecessor copy errors carry a reason and omit unreadable or linked archives from the prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-predecessor-error-"));
  try {
    const archive = archiveWorkerTranscript({ root, taskId: "W1-T5682", runId: "valid", rung: "implement", text: "readable predecessor" }, () => {});
    assert.ok(archive);
    const directory = transcriptPathFor(root, "W1-T5682", "directory", "implement");
    mkdirSync(directory);
    const other = archiveWorkerTranscript({ root, taskId: "other-task", runId: "private", rung: "implement", text: "other task" }, () => {});
    assert.ok(other);
    symlinkSync(other.path, transcriptPathFor(root, "W1-T5682", "linked", "implement"));
    const errors: Array<Record<string, unknown> | undefined> = [];
    await withPredecessorTranscriptCopies(root, "W1-T5682", {}, (step, fields) => {
      assert.equal(step, "transcript.copy_error");
      errors.push(fields);
    }, (paths) => {
      assert.equal(paths.length, 1);
      assert.equal(readFileSync(paths[0], "utf8"), readFileSync(archive.path, "utf8"));
    });
    assert.equal(errors.length, 2);
    assert.ok(errors.every((error) => error?.task_id === "W1-T5682" && String(error?.reason).includes("not a regular file")));
    rmSync(archive.path);
    await withPredecessorTranscriptCopies(root, "W1-T5682", {}, () => {}, (paths) => {
      assert.deepEqual(paths, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
