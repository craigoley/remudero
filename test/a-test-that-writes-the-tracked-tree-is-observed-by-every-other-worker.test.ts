import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(REPO_ROOT, "scripts", "test-with-retry.mjs");

/**
 * test/a-test-that-writes-the-tracked-tree-is-observed-by-every-other-worker.test.ts — W1-T2715.
 *
 * THREE INSTANCES IN ONE SESSION (2026-09-02), each found by accident rather than by a gate:
 *   1. the shipped-tree check ran the REAL source-size ratchet against the REAL baseline; that
 *      script RECORDS a newly-seen source file, so it wrote twice and left the tree dirty. Worse
 *      than debris — a test that writes a gate's own baseline MOVES the gate;
 *   2. a probe shard under test/fixtures/, removed only in a `finally`. A killed run left it
 *      behind and the NEXT run failed that suite's own "the probe shard must not already exist"
 *      assertion — READING AS A REGRESSION: green on main, red on a branch;
 *   3. a fixture task file left modified after a run, in a third worktree.
 *
 * THE CHECK LIVES AROUND THE WHOLE SUITE, NOT INSIDE EACH TEST PROCESS, AND THAT IS A MEASUREMENT
 * RATHER THAN A PREFERENCE. The per-process design the shard first described was built and driven
 * over the full 13,961-test suite: it fired three times and EVERY ONE WAS A MISATTRIBUTION.
 * `node --test` runs files in parallel, so a per-process before/after snapshot sees other workers'
 * in-flight fixtures and blames whoever exits while they exist; run alone, all four files involved
 * were clean. The shard's own falsifier names that outcome as grounds to re-design. One wrapper
 * process means one BEFORE, one AFTER, no concurrent writer — and it SEES CHILD-PROCESS WRITES,
 * which is what instance 1 was and what no in-process `fs` wrapper could observe.
 *
 * The probe below never writes into THIS repo's tracked tree: a detector for tracked-tree mutation
 * that mutates the tracked tree is self-refuting.
 */

// `scripts/**` sits outside tsconfig's `include`, so a static import is a TS7016 — reached through
// a runtime import, the same route test/a-source-file-cannot-outgrow-its-baseline.test.ts takes,
// leaving no shadow copy that could drift from the real wrapper.
const { main, newTrackedTreeDirt, readTrackedTreeState, trackedTreeDirtReport } = (await import(
  pathToFileURL(WRAPPER).href
)) as {
  main: (argv: string[]) => Promise<number>;
  newTrackedTreeDirt: (before: string[] | null, after: string[] | null) => string[];
  readTrackedTreeState: (cwd?: string, runGit?: (cwd: string) => string) => string[] | null;
  trackedTreeDirtReport: (dirt: string[]) => string | null;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** A throwaway git repo with one committed file, and a `node` one-liner the wrapper will run as
 *  its "suite". Returns the repo root and a runner that drives the REAL wrapper inside it. */
function probeRepo(body: string, opts: { startDirty?: boolean; exitCode?: number } = {}): {
  root: string;
  run: () => Promise<{ code: number; stderr: string }>;
} {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tracked-tree-probe-`));
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(join(root, "tracked.txt"), "one\n");
  // git tracks no empty directory, and `git status --porcelain` COLLAPSES a wholly-untracked one
  // to a single `?? fixtures/` line — which would hide the filename the probe writes. Commit a
  // placeholder so `fixtures/` exists in the tracked tree and git reports the full path.
  writeFileSync(join(root, "fixtures", ".gitkeep"), "");
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root, env: GIT_ENV });
  if (opts.startDirty) writeFileSync(join(root, "tracked.txt"), "already dirty before the run\n");
  return {
    root,
    run: async () => {
      const cwd = process.cwd();
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        process.chdir(root); // the wrapper snapshots `process.cwd()`
        const code = await main(["node", "-e", `${body}; process.exit(${opts.exitCode ?? 0});`]);
        return { code, stderr: stderrChunks.join("") };
      } finally {
        process.stderr.write = origWrite;
        process.chdir(cwd);
      }
    },
  };
}

// ── acceptance 1: a modified tracked file fails the run, and the failure names the path ────────

test("W1-T2715 (acceptance 1): a suite that leaves a TRACKED file modified fails, and the failure names the path", async () => {
  const probe = probeRepo(`require('node:fs').writeFileSync('tracked.txt','rewritten by the suite\\n')`);
  try {
    const r = await probe.run();
    assert.equal(r.code, 1, "a green suite that dirtied the tree must go red");
    assert.match(r.stderr, /TRACKED-TREE DIRT: the suite left 1 change\(s\)/);
    assert.match(r.stderr, /tracked\.txt/, "NAMES the path — a count alone costs the diagnosis the debris already costs");
    assert.match(r.stderr, /Write fixtures under mkdtemp/);
    assert.match(r.stderr, /git grep -n/, "and hands over the one command that finds the writer");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 2: untracked debris counts too ─────────────────────────────────────────────────

test("W1-T2715 (acceptance 2): an UNTRACKED file left behind fails too — the probe-shard leak was untracked and still broke the next run", async () => {
  const probe = probeRepo(`require('node:fs').writeFileSync('fixtures/leftover-probe.yaml','x\\n')`);
  try {
    const r = await probe.run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /leftover-probe\.yaml/);
    assert.match(r.stderr, /\?\?/, "reported as git reports it — untracked, which is what instance 2 was");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test("W1-T2715 (acceptance 2b): a CHILD PROCESS's write is caught — instance 1 was a spawned ratchet, invisible to any in-process fs wrapper", async () => {
  const probe = probeRepo(
    `require('node:child_process').execFileSync(process.execPath,['-e',"require('node:fs').writeFileSync('tracked.txt','written by a grandchild\\\\n')"])`,
  );
  try {
    const r = await probe.run();
    assert.equal(r.code, 1, "the whole reason the check reads git rather than wrapping fs");
    assert.match(r.stderr, /tracked\.txt/);
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 3: pre-existing dirt is not attributed ─────────────────────────────────────────

test("W1-T2715 (acceptance 3): a tree ALREADY dirty when the run started does not fail it", async () => {
  const probe = probeRepo(`void 0`, { startDirty: true });
  try {
    const r = await probe.run();
    assert.equal(r.code, 0, "an operator's own edits are not the suite's doing");
    assert.doesNotMatch(r.stderr, /TRACKED-TREE DIRT/);
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test("W1-T2715 (acceptance 3b): a run that dirties an ALREADY-dirty tree is still caught for its OWN change only", async () => {
  const probe = probeRepo(`require('node:fs').writeFileSync('fixtures/its-own-leak.txt','x\\n')`, { startDirty: true });
  try {
    const r = await probe.run();
    assert.equal(r.code, 1, "pre-existing dirt is not a licence to add more");
    assert.match(r.stderr, /its-own-leak\.txt/);
    assert.doesNotMatch(r.stderr, /tracked\.txt/, "and the pre-existing modification is NOT blamed on the run");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── the exit code is never LOWERED: a red suite keeps its own code and still reports dirt ─────

test("W1-T2715: a FAILING suite keeps its own exit code and still reports the dirt — the two are independent facts", async () => {
  const probe = probeRepo(`require('node:fs').writeFileSync('tracked.txt','dirty AND red\\n')`, { exitCode: 3 });
  try {
    const r = await probe.run();
    assert.equal(r.code, 3, "the test failure's own code survives — this gate never masks a real break");
    assert.match(r.stderr, /TRACKED-TREE DIRT/, "and a red suite must not hide a leak");
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test("W1-T2715: a clean, green run is untouched — exit 0 and nothing printed", async () => {
  const probe = probeRepo(`void 0`);
  try {
    const r = await probe.run();
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /TRACKED-TREE DIRT/);
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

// ── acceptance 4: writes nothing, degrades to silence when git cannot be read ──────────────────

test("W1-T2715 (acceptance 4a): with git unreadable the check is SILENT — it never fails a run for an environment fact", async () => {
  const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tracked-tree-nogit-`));
  try {
    assert.equal(readTrackedTreeState(notARepo), null, "'could not look' is null, never []");
    assert.deepEqual(newTrackedTreeDirt(null, ["?? x"]), [], "an unreadable BEFORE cannot make everything look new");
    assert.deepEqual(newTrackedTreeDirt([], null), [], "nor can an unreadable AFTER");
    assert.equal(trackedTreeDirtReport([]), null, "and nothing to report reports nothing");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("W1-T2715 (acceptance 4b): the check WRITES NOTHING — its own source spawns one read-only git and creates no fixture", () => {
  const src = readFileSync(WRAPPER, "utf8");
  const added = src.slice(src.indexOf("W1-T2715"));
  assert.match(added, /execFileSync\("git", \["status", "--porcelain"\]/, "one read-only git call");
  assert.doesNotMatch(added, /writeFileSync|mkdirSync|renameSync|rmSync/, "and no write of any kind");
  assert.doesNotMatch(added, /"-uno"/, "and NOT -uno, which would be blind to instance 2's untracked leak");
});

test("W1-T2715: the attribution is a SET difference — an unchanged tree attributes nothing, a vanished line is not dirt", () => {
  assert.deepEqual(newTrackedTreeDirt([" M a", "?? b"], [" M a", "?? b"]), []);
  assert.deepEqual(newTrackedTreeDirt([" M a"], [" M a", "?? b"]), ["?? b"]);
  assert.deepEqual(newTrackedTreeDirt([], [" M a"]), [" M a"]);
  assert.deepEqual(newTrackedTreeDirt([" M a"], []), [], "a fixture cleaning up after itself is the healthy case");
  assert.match(trackedTreeDirtReport([" M a", "?? b"]) ?? "", /left 2 change\(s\)/);
});

// ── the wiring: the gate is on the command CI actually runs ────────────────────────────────────

test("W1-T2715 (wiring): `test:ci` — the command CI's required job runs — goes through this wrapper", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts["test:ci"],
    /scripts\/test-with-retry\.mjs/,
    "a gate in a wrapper nothing runs is dead code — this is what puts it on the required path",
  );
  // CONTROL: the wrapper still forwards the suite command it is given, so the gate rides ALONGSIDE
  // the tests rather than replacing them.
  assert.match(pkg.scripts["test:ci"], /node --test/);
});
