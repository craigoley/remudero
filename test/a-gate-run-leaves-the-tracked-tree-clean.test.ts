import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAST_GATE_STEPS } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RATCHET = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");

/**
 * test/a-gate-run-leaves-the-tracked-tree-clean.test.ts — W1-T2791.
 *
 * THE RECORDING FORM STILL EXITS 0 WHILE MUTATING, and W1-T2650 removed the only thing that made
 * that observable. `SCOPE_EXEMPT_GENERATED_ARTIFACTS` (src/lib/review.ts) names
 * `scripts/source-size-baseline.json` and is subtracted by BOTH `scopeGuardOutOfScopeFiles` and
 * `scopeViolationFiles` — which correctly stopped the blocked_review that cost issue #3843, and in
 * doing so removed the guard that used to REFUSE a stray baseline write by name. Nothing objects
 * now.
 *
 * RE-MEASURED BEFORE BUILDING, as this shard's own falsifier demands (it has already been
 * overtaken once, by #3871). On origin/main, over a throwaway root carrying one unrecorded
 * TypeScript source file under `src/`:
 *
 *     recording form (`--baseline <file>`) : exit 0, baseline MUTATED
 *     gate-path form (`source-size-signal`): exit 1, baseline UNCHANGED
 *
 * So the premise holds: the mutation is silent and exit-code-invisible, which is exactly why the
 * assertion below compares `git status --porcelain` BEFORE and AFTER rather than trusting a status.
 *
 * THE DETECTOR MUST NOT BE VACUOUS. Run against the gate path in a tree where nothing would drift,
 * the check passes trivially and forever — the exact vacuity this shard's filing warned against.
 * So it is falsified in the POSITIVE direction too: pointed at the recording form with an
 * unrecorded source file present, it must FAIL and NAME the dirtied path.
 *
 * AND THE PROBE NEVER WRITES INTO THE TRACKED TREE. A detector for tracked-tree mutation that
 * itself mutates the tracked tree is self-refuting; the positive case runs entirely inside a
 * throwaway git repo it creates.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** `git status --porcelain` for `dir`, as a set of lines — the tree's observable state. */
function porcelain(dir: string): string[] {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", env: GIT_ENV })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/**
 * THE DETECTOR. Snapshot the tree, run `step`, snapshot again, and return the paths that changed
 * — IN PROCESS and by comparison, never by reading the step's exit code, because the defect being
 * guarded is a mutation that exits 0.
 */
function dirtiedBy(dir: string, step: () => void): string[] {
  const before = new Set(porcelain(dir));
  step();
  return porcelain(dir).filter((line) => !before.has(line));
}

// ── acceptance 1: the fast gate's own source-size step leaves the tracked tree byte-identical ──

test("W1-T2791 (acceptance 1): running the fast gate's OWN source-size step leaves the tracked tree byte-identical", () => {
  // THE STEP IS READ FROM THE GATE'S OWN TABLE, never hardcoded — if the `source-size` job is ever
  // re-pointed at a writing form, this test follows it there instead of guarding a name that moved.
  const entry = FAST_GATE_STEPS.find((s) => s.job === "source-size");
  assert.ok(entry, "the fast gate still carries a source-size step");
  assert.equal(entry.script, "source-size-signal", "and it is the non-writing form");

  const dirtied = dirtiedBy(REPO_ROOT, () => {
    const r = spawnSync("npm", ["run", "--silent", entry.script], { cwd: REPO_ROOT, encoding: "utf8" });
    // The exit code is NOT the assertion — it is recorded only so a failure here is diagnosable.
    assert.ok(r.status === 0 || r.status === 1, `the step ran (status ${r.status}): ${r.stderr}`);
  });
  assert.deepEqual(dirtied, [], "a gate run must leave the tracked tree exactly as it found it");
});

// ── acceptance 3: the SAME assertion, over EVERY step the fast gate runs ──────────────────────

/**
 * Acceptance 1 guards ONE step by name. `comment-load-ratchet` was added to FAST_GATE_STEPS
 * afterwards pointing at its RECORDING form, and nothing objected: every suite run spawned it
 * through `preflight --fast` (test/preflight-is-freshness-exempt-and-scrubs-the-guard-from-
 * children.test.ts drives the real verb), it rewrote scripts/comment-load-baseline.json, and
 * scripts/test-with-retry.mjs reddened the shard as TRACKED-TREE DIRT. Intermittently: the retry
 * re-snapshots a tree the first run already dirtied, so the second pass sees no NEW dirt and
 * passes. A guard scoped to one step cannot see the next step that escapes it, so this one is
 * derived from the table.
 */
test("W1-T2791 (acceptance 3): EVERY step the fast gate runs leaves the tracked tree byte-identical, not just the one guarded by name", () => {
  const offenders: string[] = [];
  for (const entry of FAST_GATE_STEPS) {
    let status: number | null = null;
    const dirtied = dirtiedBy(REPO_ROOT, () => {
      status = spawnSync("npm", ["run", "--silent", entry.script], { cwd: REPO_ROOT, encoding: "utf8" }).status;
    });
    // A step that never RAN dirties nothing and would pass this loop for the wrong reason — the
    // vacuity acceptance 1 guards with the same assertion. Exit code is otherwise not the subject.
    assert.ok(status === 0 || status === 1, `${entry.script} ran (status ${status})`);
    if (dirtied.length > 0) offenders.push(`${entry.job} (npm run ${entry.script}) dirtied: ${dirtied.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `a gate run must leave the tracked tree exactly as it found it, for every step in the table:\n${offenders.join("\n")}`,
  );
});

// ── acceptance 2: the SAME detector, falsified in the positive direction ───────────────────────

test("W1-T2791 (acceptance 2): pointed at the RECORDING form with an unrecorded source file present, the detector FAILS and names the dirtied path", () => {
  // A throwaway git repo, so the probe's fixture never touches the tracked tree — the shard's own
  // falsifier calls a detector that mutates what it guards self-refuting.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-clean-`));
  try {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "source-size-baseline.json"), "{}\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root, env: GIT_ENV });

    // The unrecorded file. Committed, so it is part of the tree the ratchet measures and NOT itself
    // the dirt the detector reports — otherwise the assertion below would pass on the fixture.
    writeFileSync(join(root, "src", "lib", "brand-new-unrecorded.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "add an unrecorded source file"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(porcelain(root), [], "fixture: the probe tree starts clean");

    const baseline = join(root, "scripts", "source-size-baseline.json");
    let status: number | null = null;
    const dirtied = dirtiedBy(root, () => {
      const r = spawnSync("node", [RATCHET, "--root", root, "--baseline", baseline], { cwd: root, encoding: "utf8" });
      status = r.status;
    });

    // THE WHOLE POINT, IN TWO ASSERTIONS THAT MUST BOTH HOLD:
    assert.equal(status, 0, "the recording form exits ZERO — which is why an exit code cannot detect this");
    assert.deepEqual(
      dirtied,
      [" M scripts/source-size-baseline.json"],
      "and it mutated a tracked file while doing so — the detector names the path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2791 (acceptance 2b): the CONTROL — the same probe tree, the gate-path form, leaves it clean", () => {
  // Without this, acceptance 2 could pass because the probe tree is dirty for some reason of its
  // own. Same fixture, same detector, the non-writing form: no dirt.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-control-`));
  try {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "source-size-baseline.json"), "{}\n");
    writeFileSync(join(root, "src", "lib", "brand-new-unrecorded.ts"), "export const x = 1;\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "same fixture, no --baseline"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(porcelain(root), []);

    const dirtied = dirtiedBy(root, () => {
      spawnSync("node", [RATCHET, "--root", root], { cwd: root, encoding: "utf8" });
    });
    assert.deepEqual(dirtied, [], "the form the fast gate actually runs never writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2791: the detector itself is not blind — it reports a mutation made by anything, not only by the ratchet", () => {
  // A detector that only ever reads [] is indistinguishable from one that works. Drive it against
  // a deliberate write so its POSITIVE direction is proven independently of the subject under test.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-tree-selftest-`));
  try {
    writeFileSync(join(root, "tracked.txt"), "one\n");
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root, env: GIT_ENV });
    assert.deepEqual(dirtiedBy(root, () => {}), [], "a no-op step dirties nothing");
    assert.deepEqual(
      dirtiedBy(root, () => writeFileSync(join(root, "tracked.txt"), "two\n")),
      [" M tracked.txt"],
      "and a write is seen, named by path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
