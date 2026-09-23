import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Task } from "../src/lib/plan.js";
import { ONE_TEST_SUITE_AT_A_TIME_LINE, renderFixPrompt, renderImplementPrompt } from "../src/lib/prompt-render.js";

// W1-T4106 — MEASURED 2026-09-23: a fix-rung worker backgrounded four coverage suites at once from its
// Bash tool (~28 test processes on a 15.6 GiB host) and the swap storm took the console down. The deny
// floor now refuses the shape. The live-run check reads /proc; RMD_DENY_FLOOR_PROC_ROOT points it at a
// fake one here, so the same assertions hold on macOS (no /proc) and on the Linux fleet.

const HOOK = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

interface Fixture { root: string; proc: string; worktree: string; sibling: string }

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-one-suite-")));
  const proc = join(root, "proc");
  const worktree = join(root, "wt-a");
  // A sibling whose name EXTENDS this worktree's: a bare prefix match would count its runs as ours.
  const sibling = join(root, "wt-a2");
  for (const dir of [proc, worktree, join(worktree, "src"), sibling]) mkdirSync(dir, { recursive: true });
  return { root, proc, worktree, sibling };
}

/** A fake /proc/<pid> whose cmdline is NUL-separated argv and whose cwd is a symlink, as on Linux. */
function liveProcess(f: Fixture, pid: number, argv: string[], cwd: string): void {
  const dir = join(f.proc, String(pid));
  mkdirSync(dir);
  writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
  symlinkSync(cwd, join(dir, "cwd"));
}

function run(command: string, cwd: string, procRoot: string): { status: number | null; stderr: string } {
  const cache = mkdtempSync(join(tmpdir(), "rmd-one-suite-cache-"));
  try {
    const r = spawnSync("bash", [HOOK], {
      cwd,
      input: JSON.stringify({ cwd, tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cache, RMD_DENY_FLOOR_PROC_ROOT: procRoot },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const FULL_SUITE = ["node", "--enable-source-maps", "--experimental-test-coverage", "--import", "tsx", "--test"];

const PARALLEL_SHAPES = [
  "node --import tsx --test & node --import tsx --test",
  // The recorded incident's shape: an eval body backgrounding coverage parents, each over a shard list.
  "eval 'mkdir -p /tmp/cov/raw1 /tmp/cov/raw2; " +
    "node --enable-source-maps --experimental-test-coverage --test-reporter=lcov " +
    "--test-reporter-destination=/tmp/cov/lcov_s1.info --test $(cat /tmp/cov/s1) & " +
    "node --enable-source-maps --experimental-test-coverage --test-reporter=lcov " +
    "--test-reporter-destination=/tmp/cov/lcov_s2.info --test $(cat /tmp/cov/s2) &'",
  "for s in 1 2 3 4; do node --import tsx --test $(cat shard$s) > /tmp/l$s 2>&1 & done; wait",
  "ls test/*.test.ts | xargs -P4 -n1 node --import tsx --test",
  "ls test/*.test.ts | xargs --max-procs=4 node --test",
  "ls test/*.test.ts | parallel node --import tsx --test {}",
];

test("W1-T4106: a command that starts two full test runs at once is refused", () => {
  const f = fixture();
  try {
    for (const command of PARALLEL_SHAPES) {
      const r = run(command, f.worktree, f.proc);
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /more than one `node --test` run at once/, command);
    }
    // Controls: the same suites one after another, or rejoined by `wait`, are not concurrent.
    for (const command of [
      "node --import tsx --test; node --import tsx --test",
      "node --import tsx --test && node --import tsx --test test/a.test.ts test/b.test.ts",
      "node --test > /tmp/one.log 2>&1 & wait; node --test",
      "ls test/*.test.ts | xargs -n1 node --import tsx --test",
      "ls test/*.test.ts | xargs -P1 node --import tsx --test",
      "node --test & node --import tsx --test test/one.test.ts",
      "echo node --test is mentioned, not run",
    ]) {
      assert.equal(run(command, f.worktree, f.proc).status, 0, command);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4106: a second full test run under the same worktree is refused while one is live", () => {
  const f = fixture();
  try {
    liveProcess(f, 4242, [...FULL_SUITE, "test/a.test.ts", "test/b.test.ts"], join(f.worktree, "src"));
    for (const command of ["node --import tsx --test", "cd src && node --test test/a.test.ts test/c.test.ts"]) {
      const r = run(command, f.worktree, f.proc);
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /already live in this worktree \(pid 4242/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4106: another worktree's live test run does not block this worker", () => {
  const f = fixture();
  try {
    liveProcess(f, 5151, FULL_SUITE, f.sibling);
    liveProcess(f, 5152, ["node", "--test"], f.root);
    assert.equal(run("node --import tsx --test", f.worktree, f.proc).status, 0);
    // No /proc at all (macOS): the live check degrades to allow, never to refuse.
    assert.equal(run("node --import tsx --test", f.worktree, join(f.root, "absent")).status, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4106: a single-file test run is allowed alongside a live suite", () => {
  const f = fixture();
  try {
    liveProcess(f, 6161, FULL_SUITE, f.worktree);
    for (const command of [
      "node --import tsx --test test/one.test.ts",
      "node --import tsx --test test/one.test.ts > /tmp/one.log 2>&1",
      "node --import tsx --test --test-name-pattern 'W1-T4106' test/*.test.ts",
      "node --import tsx --test --test-name-pattern=W1-T4106",
    ]) {
      assert.equal(run(command, f.worktree, f.proc).status, 0, command);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  // A live SCOPED run is not a suite: a full run may start beside it.
  const g = fixture();
  try {
    liveProcess(g, 7171, ["node", "--import", "tsx", "--test", "test/one.test.ts"], g.worktree);
    liveProcess(g, 7172, ["node", "--test", "--test-name-pattern", "x"], g.worktree);
    liveProcess(g, 7173, ["node", "server.js"], g.worktree);
    assert.equal(run("node --import tsx --test", g.worktree, g.proc).status, 0);
  } finally {
    rmSync(g.root, { recursive: true, force: true });
  }
});

test("W1-T4106: the parallel-suite refusal names the sequential preflight route", () => {
  const f = fixture();
  try {
    const parallel = run(PARALLEL_SHAPES[1]!, f.worktree, f.proc);
    assert.equal(parallel.status, 2);
    assert.match(parallel.stderr, /`rmd preflight --coverage`, which runs the shards sequentially/);
    liveProcess(f, 8181, FULL_SUITE, f.worktree);
    const live = run("node --import tsx --test", f.worktree, f.proc);
    assert.equal(live.status, 2);
    assert.match(live.stderr, /`rmd preflight --coverage`, which runs the shards sequentially/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  // The worker contract carries the same route, in the implement and the fix prompt alike.
  const task: Task = {
    id: "W1-T4106X", title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "high",
    verify: "auto", status: "queued", attempts: 0, context: [], prompt: "p", files: ["hooks/deny-floor.sh"],
  };
  assert.match(ONE_TEST_SUITE_AT_A_TIME_LINE, /`rmd preflight --coverage`/);
  assert.ok(renderImplementPrompt(task, "", "RUN-4106").includes(ONE_TEST_SUITE_AT_A_TIME_LINE));
  const fix = renderFixPrompt({
    task, round: 1, branch: "run-W1-T4106X-1", evidence: { review: { unmetCriteria: [], summary: "s" } },
  });
  assert.ok(fix.includes(ONE_TEST_SUITE_AT_A_TIME_LINE));
});
