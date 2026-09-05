/**
 * test/setup/tmp-hygiene.ts — automatic per-process temp-dir sweep for the test suite
 * (W1-T131).
 *
 * INCIDENT: every fixture across the suite creates its own throwaway temp dir via
 * `mkdtempSync(join(tmpdir(), "<prefix>-"))` (~60 call sites across ~32 files) and none
 * of them remove it — the same shape of leak `src/lib/tmp.ts` (W1-T115) fixed for rmd's
 * own production runtime, just never applied to the test suite itself. Left unchecked,
 * mutation testing (Stryker) re-runs the suite once per mutant and multiplies the leak
 * into hundreds of thousands of dirs (202,830 dirs / 14G measured in one run).
 *
 * Fix: rather than touching every one of those ~60 call sites, wrap `fs.mkdtempSync`
 * once (propagated to every fixture's own `import { mkdtempSync } from "node:fs"` via
 * `syncBuiltinESMExports()` — see the comment below), record every dir it creates during
 * this process, and remove all of them from a `process.on("exit", ...)` handler.
 * `node --test` runs each matched test file in its own child process by default, and
 * `--import` modules load fresh in every one of those child processes (verified
 * empirically against this repo's actual `node --test --import tsx ...` invocation), so
 * this sweep is naturally scoped to exactly the dirs one test file's fixtures created
 * during its own run — no cross-file collision risk under parallel execution, and no
 * per-fixture cleanup discipline required, now or for any fixture added later.
 *
 * Loaded via a second `--import` flag on the `test` npm script, after `--import tsx` —
 * so this file, and the fixtures it instruments, both run through tsx's loader.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { reapableTmpPrefix } from "./reapable-prefix.js";

/**
 * DISABLE GIT'S AUTOMATIC BACKGROUND GC FOR EVERY GIT THIS SUITE SPAWNS (W1-T1217).
 *
 * INCIDENT: `realRepoFixture` (test/fix-dedup-seed.test.ts) pushes `main`, pushes a second
 * branch, and — six lines later — runs a plain local `git clone <bare> <dir>`. A local clone
 * HARDLINKS loose objects (measured: a cloned loose object reads a link count of 2, against a
 * link-count-1 control), so the clone depends on the source repo's loose objects still existing
 * on disk while it links them. `receive.autogc` and `gc.auto` are unset repo-wide, so git's own
 * defaults govern, and the earlier `push` can spawn a background `git gc --auto` that repacks —
 * and removes — those loose objects while the clone is still linking them: `fatal: failed to
 * copy file … No such file or directory`, in fixture SETUP, before any code under test runs, in
 * a file the failing PR never touched (one confirmed CI occurrence: run 32582765791 attempt 1,
 * job 97054511830).
 *
 * Fix: disable both halves of the race through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` (git >= 2.31) on `process.env`, set HERE rather than in a new setup
 * module a future invocation could forget to load, or a written config file a fresh clone
 * target has no `.git/config` of its own to hold yet. `gc.auto=0` stops the clone side from
 * ever running one; `receive.autogc=false` stops the earlier push from spawning one at all.
 * This module is already `--import`ed at every invocation site (see the module comment above),
 * so every git process this suite spawns that inherits `process.env` — either by spreading it
 * explicitly into its own env, or (Node's default) by receiving no `env` override at all —
 * picks these up with no per-fixture change and no new import anywhere.
 *
 * Reach: this reaches only a git process whose env derives from `process.env` — a fixture that
 * builds a REPLACEMENT env object which does not spread `...process.env` is outside it.
 * test/git-fixture-gc-hygiene.test.ts guards that residue so a future fixture regressing into
 * that shape fails a named test instead of silently reintroducing the race.
 */
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "gc.auto";
process.env.GIT_CONFIG_VALUE_0 = "0";
process.env.GIT_CONFIG_KEY_1 = "receive.autogc";
process.env.GIT_CONFIG_VALUE_1 = "false";

const created: Array<string | Buffer> = [];
const originalMkdtempSync = fs.mkdtempSync;

fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
  // Normalize a bare fixture prefix to a boot-sweep-reapable `rmd-test-` one, so a
  // SIGKILL'd test process (which skips the exit handler below) still leaves a dir
  // src/lib/tmp.ts's boot sweep can reclaim. No-op unless the prefix is a direct
  // child of os.tmpdir() and not already `rmd-` prefixed (see ./reapable-prefix.ts).
  if (typeof args[0] === "string") args[0] = reapableTmpPrefix(args[0]);
  const dir = (originalMkdtempSync as (...a: Parameters<typeof fs.mkdtempSync>) => string | Buffer)(...args);
  created.push(dir);
  return dir;
}) as typeof fs.mkdtempSync;

// Every fixture imports the NAMED binding (`import { mkdtempSync } from "node:fs"`), not
// the default-export object patched above — and Node bakes named ESM exports of core
// modules in at first-import time, so reassigning the property on the default object
// alone is invisible to that binding (verified empirically: without this call, a sibling
// process's `import { mkdtempSync } from "node:fs"` call never reaches the wrap above).
// `syncBuiltinESMExports()` is Node's own documented mechanism for propagating a builtin
// monkeypatch to its already-bound named ESM exports — the same trick fs-mocking
// libraries (e.g. mock-fs) rely on.
syncBuiltinESMExports();

/**
 * W1-T2715 — A TEST THAT WRITES INTO THE TRACKED TREE IS OBSERVED BY EVERY OTHER WORKER.
 *
 * MEASURED, THREE INSTANCES IN ONE SESSION (2026-09-02), each found by accident rather than by a
 * gate:
 *   1. the shipped-tree check ran the REAL source-size ratchet against the REAL baseline, and that
 *      script RECORDS a newly-seen source file and writes — twice adding an entry and leaving the
 *      tree dirty. That is worse than debris: a test that writes a gate's own baseline MOVES the
 *      gate, silently pre-approving growth the ratchet exists to make a human decide about;
 *   2. a probe shard under test/fixtures/, removed only in a `finally`. A run killed mid-flight
 *      left it behind and the NEXT run failed that suite's own "the probe shard must not already
 *      exist" assertion — which READS AS A REGRESSION: green on main, red on a branch, the exact
 *      signature of a real defect. One session lost time diagnosing it as one;
 *   3. a fixture task file left modified after a run, in a different worktree again.
 *
 * THE INVARIANT WAS ALREADY WRITTEN DOWN AND ALREADY UNENFORCED — stated verbatim in
 * test/a-source-file-cannot-outgrow-its-baseline.test.ts's own header, which was itself violator
 * (1). A rule stated only in a comment is the class this repo already knows gets violated silently
 * and repeatedly, so this is a gate rather than a fourth per-file repair.
 *
 * SNAPSHOT-AND-COMPARE, NEVER A BARE `git status`. The suite runs in parallel and against
 * worktrees that may legitimately be dirty when a run starts, so an absolute clean-tree assertion
 * would fire on state the process did not create. Only paths appearing in the AFTER set and not
 * the BEFORE set are attributable to this process.
 *
 * UNTRACKED DEBRIS COUNTS. Instance 2 was an untracked file and it still broke the next run, so
 * `??` entries are in scope — which is why the porcelain read cannot use `-uno` (measured 9ms
 * against 52ms, and blind to exactly the instance that cost the most time).
 *
 * IT MUST NOT BECOME THE FOURTH SELF-WRITING TEST: this reads git, writes nothing, creates no
 * fixture, and degrades to SILENCE when git cannot be read rather than failing a suite for an
 * environment fact.
 */
export type PorcelainReader = (cwd: string) => string[] | null;

/** `git status --porcelain` as a sorted line set, or `null` when git could not be read at all —
 *  not-a-repo, no git binary, a permission error. `null` is the silence case, never `[]`, because
 *  "could not look" and "looked and found nothing" must not be the same value here. */
export const readPorcelain: PorcelainReader = (cwd) => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
};

/**
 * The paths this process is ANSWERABLE FOR: porcelain lines present after and absent before.
 * `null` on either side ⇒ `[]`, because an unreadable snapshot cannot attribute anything and must
 * not be rendered as "everything is new".
 */
export function attributableDirt(before: string[] | null, after: string[] | null): string[] {
  if (before === null || after === null) return [];
  const seen = new Set(before);
  return after.filter((line) => !seen.has(line));
}

/** The message a leaking process prints, naming every path — a hygiene gate that reported only a
 *  count would cost the diagnosis the debris already costs. */
export function trackedTreeDirtReport(dirt: string[]): string | null {
  if (dirt.length === 0) return null;
  return (
    `tmp-hygiene (W1-T2715): this test process left ${dirt.length} change(s) in the tracked tree, ` +
    `which every other worker in a concurrent run observes and the NEXT run reads as a regression:\n` +
    dirt.map((d) => `  ${d}`).join("\n") +
    `\nWrite fixtures under mkdtemp, never into the tracked tree.`
  );
}

// Taken at LOAD, before any test body runs — the BEFORE half of the comparison. `process.cwd()` is
// the repo root for every `node --test` child this suite spawns.
const trackedTreeBefore = readPorcelain(process.cwd());

process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — a fixture may already have removed its own dir
    }
  }
  // W1-T2715: AFTER the temp sweep above, so a fixture's own temp dir under the repo (if any) is
  // already gone and cannot be misattributed as debris. `process.exitCode` rather than a thrown
  // error: an exit handler cannot fail an individual test, and a non-zero file-process exit is
  // what `node --test` surfaces as a file-level failure — which is the loudest thing available
  // here and is what makes the leak stop being invisible.
  const dirt = attributableDirt(trackedTreeBefore, readPorcelain(process.cwd()));
  const report = trackedTreeDirtReport(dirt);
  if (report !== null) {
    process.stderr.write(`${report}\n`);
    if (!process.exitCode) process.exitCode = 1;
  }
});
