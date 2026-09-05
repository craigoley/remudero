import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attributableDirt, readPorcelain, trackedTreeDirtReport } from "./setup/tmp-hygiene.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HYGIENE = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");
// The probe child runs with its cwd INSIDE the throwaway repo — that is the whole point, since
// `readPorcelain(process.cwd())` must read that repo — so `--import tsx` cannot resolve by bare
// specifier from there. Resolve tsx's loader to an absolute path in THIS repo instead, which
// keeps the child's loader chain byte-identical to the suite's own.
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

/**
 * test/a-test-that-writes-the-tracked-tree-is-observed-by-every-other-worker.test.ts — W1-T2715.
 *
 * THREE INSTANCES IN ONE SESSION (2026-09-02), each found by accident rather than by a gate:
 *   1. the shipped-tree check ran the REAL source-size ratchet against the REAL baseline; that
 *      script RECORDS a newly-seen source file and writes, so it added an entry twice and left the
 *      tree dirty. Worse than debris — a test that writes a gate's own baseline MOVES the gate;
 *   2. a probe shard under test/fixtures/, removed only in a `finally`. A run killed mid-flight
 *      left it behind and the NEXT run failed that suite's own "the probe shard must not already
 *      exist" assertion — READING AS A REGRESSION: green on main, red on a branch. A session lost
 *      time diagnosing it as one, and separately came within one report of naming four failures
 *      that were artefacts of leftover state rather than of any diff;
 *   3. a fixture task file left modified after a run, in a different worktree again.
 *
 * The invariant was already written down — verbatim in
 * test/a-source-file-cannot-outgrow-its-baseline.test.ts's own header — and that file was itself
 * violator (1). This is the gate, not a fourth per-file repair.
 *
 * THE END-TO-END CASES BELOW RUN A REAL `node --test` CHILD with the real `--import` module,
 * inside a throwaway git repo, because the property under test is a property of the process exit
 * — not of a function called in-process. And the probe never writes into THIS repo's tracked tree:
 * a detector for tracked-tree mutation that mutates the tracked tree would be self-refuting.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/**
 * The probe child's env. `NODE_TEST_CONTEXT` is how `node --test` marks a test-file process, and a
 * child that inherits it refuses to run at all — "node:test run() is being called recursively
 * within a test file. skipping running files." — exiting 0 with nothing done, which reads exactly
 * like "the gate did not fire". Measured; stripping it is what makes these cases run.
 */
const PROBE_ENV: NodeJS.ProcessEnv = { ...GIT_ENV };
delete PROBE_ENV.NODE_TEST_CONTEXT;

/** A throwaway git repo carrying one committed file and a test that does `body`. */
function probeRepo(body: string, opts: { startDirty?: boolean } = {}): { root: string; run: () => { status: number | null; output: string } } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tracked-write-probe-`));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "tracked.txt"), "one\n");
  writeFileSync(
    join(root, "test", "probe.test.mjs"),
    // ESM, and `import fs` rather than `require` — the probe file is `.mjs`, so a CJS `require`
    // would throw before the body ever ran and the process would fail for the wrong reason.
    ["import { test } from 'node:test';", "import fs from 'node:fs';", "test('probe', () => {", body, "});", ""].join("\n"),
  );
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root, env: GIT_ENV });
  if (opts.startDirty) writeFileSync(join(root, "tracked.txt"), "already dirty before the run\n");
  return {
    root,
    run: () => {
      // The REAL hygiene module, loaded exactly as the suite loads it, in a child whose cwd is the
      // probe repo — so `readPorcelain(process.cwd())` reads that repo and not this one.
      const r = spawnSync(
        "node",
        ["--test", "--import", TSX_LOADER, "--import", HYGIENE, join(root, "test", "probe.test.mjs")],
        { cwd: root, encoding: "utf8", env: PROBE_ENV },
      );
      // BOTH STREAMS. `node --test` CAPTURES a test-file child's stderr and relays it inside its
      // own TAP stream as `#` comments, so the hygiene report lands on the runner's STDOUT even
      // though the module writes it to stderr. Asserting on stderr alone read as "no report" while
      // the mechanism was working — measured, and the reason this joins them.
      return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
    },
  };
}

// ── acceptance 1: a modified tracked file fails the process, and the failure names the path ────

test("W1-T2715 (acceptance 1): a test process that leaves a TRACKED file modified fails, and the failure names the path", () => {
  const probe = probeRepo("  fs.writeFileSync(process.cwd() + '/tracked.txt', 'rewritten by the test\\n');");
  try {
    const r = probe.run();
    assert.notEqual(r.status, 0, `the process must fail: ${r.output}`);
    assert.match(r.output, /left 1 change\(s\) in the tracked tree/);
    assert.match(r.output, /tracked\.txt/, "NAMES the path — a count alone costs the diagnosis the debris already costs");
    assert.match(r.output, /Write fixtures under mkdtemp/, "and says what to do instead");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 2: untracked debris counts too ─────────────────────────────────────────────────

test("W1-T2715 (acceptance 2): an UNTRACKED file left behind fails too — the probe-shard leak was untracked and still broke the next run", () => {
  const probe = probeRepo("  fs.writeFileSync(process.cwd() + '/leftover-probe.yaml', 'x\\n');");
  try {
    const r = probe.run();
    assert.notEqual(r.status, 0, `an untracked leak must fail too: ${r.output}`);
    assert.match(r.output, /leftover-probe\.yaml/);
    assert.match(r.output, /\?\?/, "reported as git reports it — untracked, which is what instance 2 was");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 3: pre-existing dirt is not attributed ─────────────────────────────────────────

test("W1-T2715 (acceptance 3): a tree ALREADY dirty when the process started does not fail it", () => {
  const probe = probeRepo("  void fs;", { startDirty: true });
  try {
    const r = probe.run();
    assert.equal(r.status, 0, `only paths this process introduced are attributable: ${r.output}`);
    assert.doesNotMatch(r.output, /left \d+ change\(s\) in the tracked tree/);
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test("W1-T2715 (acceptance 3b): and a process that dirties a tree that was ALREADY dirty is still caught for its OWN change", () => {
  const probe = probeRepo("  fs.writeFileSync(process.cwd() + '/its-own-leak.txt', 'x\\n');", { startDirty: true });
  try {
    const r = probe.run();
    assert.notEqual(r.status, 0, "pre-existing dirt is not a licence to add more");
    assert.match(r.output, /its-own-leak\.txt/);
    assert.doesNotMatch(r.output, /tracked\.txt/, "and the pre-existing modification is NOT blamed on this process");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 4: writes nothing, degrades to silence when git cannot be read ──────────────────

test("W1-T2715 (acceptance 4a): with git unreadable the check is SILENT — it never fails a suite for an environment fact", () => {
  // A directory that is not a git repo at all: `git status` exits non-zero, readPorcelain answers
  // null, and null on either side attributes nothing.
  const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tracked-write-nogit-`));
  try {
    assert.equal(readPorcelain(notARepo), null, "'could not look' is null, never []");
    assert.deepEqual(attributableDirt(null, ["?? x"]), [], "an unreadable BEFORE cannot make everything look new");
    assert.deepEqual(attributableDirt([], null), [], "nor can an unreadable AFTER");
    assert.equal(trackedTreeDirtReport([]), null, "and nothing to report reports nothing");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("W1-T2715 (acceptance 4b): the check itself WRITES NOTHING — its source spawns only a read-only git and creates no fixture", () => {
  const src = execFileSync("git", ["show", `HEAD:test/setup/tmp-hygiene.ts`], { cwd: REPO_ROOT, encoding: "utf8", env: GIT_ENV });
  void src; // committed copy read only to prove the file is tracked; the live one is asserted below.
  const live = execFileSync("cat", [HYGIENE], { encoding: "utf8" });
  const added = live.slice(live.indexOf("W1-T2715"));
  assert.match(added, /execFileSync\("git", \["status", "--porcelain"\]/, "one read-only git call");
  assert.doesNotMatch(added, /writeFileSync|appendFileSync|mkdirSync|renameSync/, "and no write of any kind");
  assert.doesNotMatch(added, /"-uno"/, "and it does NOT use -uno, which would be blind to instance 2's untracked leak");
});

test("W1-T2715: the attribution is a SET difference, so an unchanged tree attributes nothing and a new line attributes exactly itself", () => {
  assert.deepEqual(attributableDirt([" M a", "?? b"], [" M a", "?? b"]), []);
  assert.deepEqual(attributableDirt([" M a"], [" M a", "?? b"]), ["?? b"]);
  assert.deepEqual(attributableDirt([], [" M a"]), [" M a"]);
  // A line that DISAPPEARS is not dirt this process created — a fixture cleaning up after itself
  // must never be reported.
  assert.deepEqual(attributableDirt([" M a"], []), []);
  assert.match(trackedTreeDirtReport([" M a", "?? b"]) ?? "", /left 2 change\(s\)/);
});
