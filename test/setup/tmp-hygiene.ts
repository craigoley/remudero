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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapableTmpPrefix } from "./reapable-prefix.js";

/**
 * W1-T3069 — REFUSE THE READ-ONLY ESCAPE BEFORE A SINGLE TEST RUNS.
 *
 * `RMD_SELF_SYNC_DONE=1` is what `rmd` itself tells an operator to set on a detached HEAD — "the
 * read-only escape" — and every worktree this fleet creates is detached, so every lane is told to
 * export it. It flips `checkCliFreshness` from `assessed` to `guarded`, which 26 suites assert on.
 *
 * MEASURED at origin/main over those suites: 644 tests, 48 FAIL with it set against 2 without. The
 * 46 differences surface as ordinary assertion errors — `expected: 'assessed', actual: 'guarded'` —
 * with nothing naming the cause. One of them cost a false "fails on a pristine main" claim in a PR
 * body, because a control that reverts the SOURCE and keeps the ENVIRONMENT reproduces the
 * contamination and calls it the baseline.
 *
 * ⚠ IT REFUSES; IT DOES NOT QUIETLY UNSET. Deleting the variable and proceeding would produce a
 * result the printed command cannot reproduce, which is a worse failure than the one being removed.
 *
 * ⚠ AND IT SAYS NOTHING WHEN THE VARIABLE IS ABSENT. That is the normal path and CI's path; the
 * guard costs one property read there and changes nothing.
 */
function refuseSelfSyncEscape(): void {
  if (process.env.RMD_SELF_SYNC_DONE === undefined) return;
  console.error(
    [
      "",
      "test setup REFUSED: RMD_SELF_SYNC_DONE is set in this environment.",
      "",
      "  WHAT IT DOES: it makes checkCliFreshness report 'guarded' instead of 'assessed'.",
      "  26 suites assert on that state, so the suite reports ~46 failures that are caused by the",
      "  variable and not by the code under test — as ordinary assertion errors, naming nothing.",
      "",
      "  WHY YOU HAVE IT: rmd's own refusal on a detached HEAD tells you to set it (the read-only",
      "  escape). That advice is correct FOR THE CLI. It is not correct for a test run.",
      "",
      "  FIX: run the suite without it, e.g.  env -u RMD_SELF_SYNC_DONE npm test",
      "",
      "  This refuses rather than unsetting the variable itself, so the command you re-run is the",
      "  command that produced this result.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

refuseSelfSyncEscape();

// Coverage runs execute each test file in a separate instrumented process. Those fixture reads
// never leave the test harness, so making every child wait on the production cross-process gap
// only turns the coverage timeout into a false transport failure. Keep the production default
// intact and opt the coverage harness into an explicit zero gap instead.
if (process.env.NODE_V8_COVERAGE !== undefined) {
  process.env.RMD_GH_SHARED_READ_GAP_MS ??= "0";
}

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
 * SHADOW `gh` ON PATH WITH A REFUSING STUB, FOR EVERY TEST PROCESS (W1-T4119).
 *
 * INCIDENT: `test/policy.test.ts` made a real `gh api repos/craigoley/remudero/pulls/6698/files`
 * call — a live PR number — and hung until it was killed; `test/review-command-plan-filing-provenance.test.ts`
 * (W1-T3115) is red on clean main for the same reason. Both reach a production module that shells
 * out to the real `gh` CLI on a code path that test happened to leave un-faked. A test that reads
 * live GitHub state spends the operator's API budget, depends on which PRs happen to be open that
 * day, and reads as flaky when it is actually deterministic on a machine with no `gh` at all.
 *
 * Fix: this module is `--import`ed by every `node --test` invocation (see the module comment
 * above), so it is the one place that can guarantee it for all of them. It prepends a per-process
 * directory holding a `gh` stub onto PATH. The stub REFUSES — it exits 1 and prints the argv it
 * was refused — so an accidental shell-out fails fast and names itself instead of hanging on the
 * real network or reading whichever PRs happen to be open. Made via `fs.mkdtempSync` (the wrapped
 * one, above) so this dir rides the same exit-time sweep as every fixture's own temp dir — no
 * separate cleanup path to forget.
 *
 * A test that genuinely needs a fake `gh` (e.g. test/helpers/gh-shim.ts) is unaffected: this
 * module runs at IMPORT time, before any test file's body executes, so a test that later does
 * `process.env.PATH = \`${shim.dir}:${originalPath}\`` (the existing, already-used convention)
 * prepends its own dir onto a PATH that already carries this one — putting the test's own stub
 * FIRST and this refusal second, exactly like today's "own stub wins" behaviour with no real
 * `gh` on PATH at all.
 */

// The refusal stub's own log of every argv it refused, in call order — the "visible" half of
// W1-T4226. Written by a SEPARATE process (the shelled-out `gh` shim script itself), so the
// only channel back to THIS process is the file; read once, synchronously, at exit (below).
let refusalsLogPath: string | undefined;

// W1-T4226: set by `allowGhRefusals` (exported below) when a test file's own PURPOSE is to
// exercise the shared refusal — e.g. test/no-test-reaches-the-real-github.test.ts. Checked at
// exit, alongside `refusalsLogPath`'s contents, before deciding whether an unexplained refusal
// turns the whole file red.
let optedIn = false;

/**
 * OPT IN BY NAME (W1-T4226): call this from a test file whose own job is to exercise the shared
 * `gh` refusal stub — the one already-legitimate reason a file should see a refusal recorded
 * against it. `reason` is never read back by this module; it exists so the opt-in reads as a
 * deliberate, reviewable choice at the call site, not a silent escape hatch.
 *
 * Every other caller of the refusing stub is UNEXPLAINED: the exit-time check below turns that
 * file red instead of letting whatever caught the shelled-out failure swallow it and report
 * green over the "GitHub unreachable" branch it never meant to exercise.
 */
export function allowGhRefusals(reason: string): void {
  void reason;
  optedIn = true;
}

/** The number of `gh` invocations the shared refusal stub has refused so far THIS process —
 *  the other half of "make the stub's refusal count visible" (W1-T4226): a test can assert on
 *  this directly, not just observe it as a file-level exit code. */
export function ghRefusalCount(): number {
  if (refusalsLogPath === undefined) return 0;
  try {
    return fs
      .readFileSync(refusalsLogPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function installGhRefusalStub(): void {
  const dir = fs.mkdtempSync(join(tmpdir(), "rmd-test-gh-refuse-"));
  const ghPath = join(dir, "gh");
  const refusalsPath = join(dir, "refusals.log");
  fs.writeFileSync(refusalsPath, "");
  refusalsLogPath = refusalsPath;
  fs.writeFileSync(
    ghPath,
    [
      "#!/bin/sh",
      // W1-T4226: record the refused argv BEFORE reporting it, so the exit-time check (below)
      // can see it even though this line runs in a separate `gh` child process — the file is
      // the only channel back to the parent test process.
      `printf '%s\\n' "$*" >> ${JSON.stringify(refusalsPath)}`,
      'echo "test setup REFUSED: a test shelled out to the real gh CLI with no stub of its own." 1>&2',
      'echo "  argv: gh $*" 1>&2',
      'echo "  FIX: give the test its own gh stub, prepended onto PATH ahead of this one" 1>&2',
      'echo "  (see test/helpers/gh-shim.ts) — no test should reach the real network." 1>&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

installGhRefusalStub();

process.on("exit", () => {
  // W1-T4226: read BEFORE the tmp-dir sweep below removes the stub's own dir (and the log
  // inside it) — this is the only point this process ever reads it.
  const refusals = ghRefusalCount();

  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — a fixture may already have removed its own dir
    }
  }

  // W1-T4226: about 80 test files across the suite shell out to `gh`, get refused by the stub
  // above, and let whatever catches that failure swallow it — a lint-plan test meant to exercise
  // credit scoping actually exercises "GitHub unreachable", and still reports green. Make the
  // refusal visible: an unexplained one now fails the WHOLE FILE, so the next silent caller is a
  // red test instead of a passed one.
  if (refusals > 0 && !optedIn) {
    console.error(
      [
        "",
        `test setup REFUSED: this test file triggered the shared gh refusal stub ${refusals} time(s) and did not opt in.`,
        "",
        "  WHAT HAPPENED: a shell-out to gh was refused (see the 'test setup REFUSED' line(s) above),",
        "  and whatever caught that failure let the file finish and report green anyway — exercising",
        "  the 'GitHub unreachable' branch instead of the one the test names.",
        "",
        "  FIX: give the call its own deps seam (e.g. offline: true plus a recording fake gateway —",
        "  see test/policy.test.ts's offlineLintDeps), or its own gh stub ahead of this one",
        "  (test/helpers/gh-shim.ts). If this file's own PURPOSE is to exercise the refusal itself,",
        "  opt in explicitly and say why:",
        '    import { allowGhRefusals } from "./setup/tmp-hygiene.js";',
        '    allowGhRefusals("<why this file deliberately triggers the shared refusal>");',
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
  }
});
