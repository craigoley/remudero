import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { censusMembershipCommand } from "../src/run-task.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");

/**
 * test/prepush-gates-refuse.test.ts — W1-T3059.
 *
 * The pre-push route can REFUSE: what it checks, how each check reports a result it did not
 * reach, and how it reports what it could not enumerate. `core.hooksPath=hooks` means this file
 * reaches every worker worktree the moment it merges — a mistake here does not redden a PR, it
 * stops the fleet pushing. Whether the switch defaults on or off is no longer this file's claim;
 * W1-T3222 moved that to test/the-prepush-gates-ship-armed.test.ts.
 */

/** A spawn whose stdout is fixed, so census candidate discovery is decided by the test, not the tree. */
function spawnReturning(stdout: string): PreflightSpawn {
  return (() => ({ status: 0, stdout, stderr: "" })) as unknown as PreflightSpawn;
}

function captureVerb(rest: string[], changedPaths: readonly string[], discovery = ""): {
  code: number;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    const code = censusMembershipCommand(rest, {
      repoRoot: REPO_ROOT,
      changedPaths,
      spawn: spawnReturning(discovery),
    });
    return { code, out, err };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

test("--files emits TEST FILE PATHS a caller can run, not the job names only a human reads", () => {
  const { code, out } = captureVerb(["--files"], ["src/run-task.ts"]);
  assert.equal(code, 0);
  assert.ok(out.length > 0, "src/run-task.ts joins censuses, so the list cannot be empty");
  assert.ok(
    out.includes("test/help-renders-a-summary-not-a-paragraph.test.ts"),
    `command-registry-census walks src/run-task.ts; got ${JSON.stringify(out)}`,
  );
  for (const line of out) assert.match(line, /^test\/.+\.test\.ts$/, `not a runnable path: ${line}`);
});

test("a suite two changed paths both join is listed ONCE — a caller splicing this runs it once", () => {
  const { out } = captureVerb(["--files"], ["src/lib/review.ts", "src/lib/status.ts"]);
  const seen = out.filter((l) => l === "test/authority-ratchet.test.ts");
  assert.equal(seen.length, 1, `deduped list expected, got ${JSON.stringify(out)}`);
  assert.deepEqual([...out].sort(), out, "sorted, so the list is stable across runs");
});

test("--files prints NO report header, so stdout splices as a bare file list", () => {
  const { out } = captureVerb(["--files"], ["src/run-task.ts"]);
  for (const line of out) {
    assert.doesNotMatch(line, /changed path\(s\) against/, "the human report must not reach stdout here");
    assert.doesNotMatch(line, /^\s/, "no indented suite lines: this stream is consumed, not read");
  }
});

test("a diff joining no census prints nothing at all rather than a reassuring line", () => {
  const { code, out } = captureVerb(["--files"], ["README.md"]);
  assert.equal(code, 0);
  assert.deepEqual(out, []);
});

test("an UNMODELLED suite goes to stderr and never silently shortens the runnable list", () => {
  const ghost = "test/a-census-the-model-has-never-heard-of.test.ts";
  const { out, err } = captureVerb(["--files"], ["src/run-task.ts"], ghost);
  assert.ok(!out.includes(ghost), "an unplaceable suite must not enter the list a caller runs");
  assert.ok(
    err.some((l) => l === `unmodelled: ${ghost}`),
    `incompleteness must be NAMED on stderr; got ${JSON.stringify(err)}`,
  );
});

test("--files is a declared flag, not an argument the verb silently ignores", () => {
  const { code } = captureVerb(["--not-a-flag"], ["src/run-task.ts"]);
  assert.equal(code, 2, "an undeclared flag is still refused, so --files was declared not waved through");
});

/** A scratch repo the hook can run in, holding only what each case is about — plus the one thing
 *  every real worktree already has. `spawnWorker` symlinks node_modules into each worktree it
 *  creates, and the hook's checks run under the tsx loader, so a fixture without it would test a
 *  shape that never occurs and would fail for a reason the hook is not responsible for. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prepush-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runHook(cwd: string, env: Record<string, string>): { status: number; stderr: string } {
  // spawnSync, NOT execFileSync: the latter RETURNS stdout and surfaces stderr only by throwing, so
  // a hook that exits 0 while naming a skip on stderr would read here as having said nothing — the
  // exact case two of these tests exist to pin.
  const res = spawnSync("sh", [HOOK], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, ...env },
  });
  assert.equal(res.error, undefined, `the hook itself failed to launch: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

// The SHIPS-OFF-by-default tests that lived here (W1-T3059) are replaced, not deleted, by
// W1-T3222: the default they pinned is exactly what that task changes. Their successor,
// asserting the new fail-armed default plus the mirror property it adds, lives in
// test/the-prepush-gates-ship-armed.test.ts — see that file's own header for why a new suite
// rather than an edit to this one.

test("ARMED: a refusing precheck blocks the push and the message names the way out", () => {
  const dir = scratch();
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(1)\n");
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "1" });
  assert.equal(status, 1, "a real violation must stop the push");
  assert.match(stderr, /pre-push REFUSED/);
  assert.match(stderr, /RMD_PREPUSH_GATES=0 git push/, "a hook with no escape hatch is its own hazard");
});

test("an UNREADABLE diff (exit 2) is not a violation — the bound must not fire on a healthy tree", () => {
  const dir = scratch();
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(2)\n");
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "1" });
  assert.equal(status, 0, "exit 2 is 'could not read', which is not 'you violated rule 15'");
  assert.match(stderr, /could not read the diff/);
});

test("a MISSING check is named as skipped, never reported as cleared", () => {
  const dir = scratch();
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "1" });
  assert.equal(status, 0, "a missing entry point is not a violation");
  assert.match(stderr, /rule15-precheck\.mjs absent — skipped, NOT passed/);
  assert.match(stderr, /bin\/rmd absent — census suites not enumerated, NOT cleared/);
});

test("the hook is executable, or git silently ignores it and every claim here is vacuous", () => {
  // `ls-tree`, deliberately, and the choice is load-bearing rather than stylistic.
  // `discoverCensusCandidates` (src/lib/ci-parity.ts) classifies a test file as a population-walking
  // census by TEXT MATCH on the name of git's index-listing subcommand — the one pairing `ls` with
  // the plural of "file". Any file containing that literal registers as an undisclosed census and
  // reddens test/census-discovery-is-blind-to-a-second-idiom.test.ts, which is why this comment
  // does not spell it either: naming the hazard reintroduced it, MEASURED, on the first attempt.
  // This file walks no population, so the detection is a false positive; `ls-tree` reads the same
  // recorded mode out of HEAD with no such collision.
  const mode = execFileSync("git", ["-C", REPO_ROOT, "ls-tree", "HEAD", "--", "hooks/pre-push"], { encoding: "utf8" });
  assert.match(mode, /^100755 /, `git must record the exec bit; got ${mode.trim()}`);
  chmodSync(HOOK, 0o755);
});

test("the hook runs census suites with the loaders package.json uses, not a bare `node --test`", () => {
  // MEASURED while building this: under a bare `node --test`, test/authority-ratchet.test.ts
  // reported a failure it does not have (6/6 under the real invocation). A runner that
  // manufactures failures is worse than one that runs nothing — it teaches the author to distrust
  // the gate, which is how the gate ends up switched off.
  const hook = readFileSync(HOOK, "utf8");
  const invocation = /node --test [^\n]*\$census_files/.exec(hook);
  assert.ok(invocation, "the hook must run the enumerated suites");
  assert.match(invocation[0], /--import tsx/, `bare node --test cannot load these .ts suites: ${invocation[0]}`);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const loader of pkg.scripts.test.match(/--import \S+/g) ?? []) {
    assert.ok(invocation[0].includes(loader), `package.json's test script uses ${loader}; the hook must too`);
  }
});

test("an unmodelled FLOOD is counted, not echoed — 119 lines a push is how a gate gets turned off", () => {
  const dir = scratch();
  mkdirSync(join(dir, "bin"), { recursive: true });
  const fake = join(dir, "bin", "rmd");
  // Names many suites it cannot place and emits no runnable file: the real tree's shape today.
  writeFileSync(fake, "#!/bin/sh\ni=0\nwhile [ $i -lt 119 ]; do echo \"unmodelled: t$i\" >&2; i=$((i+1)); done\n");
  chmodSync(fake, 0o755);
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "1" });
  assert.equal(status, 0, "incompleteness is not a violation");
  assert.match(stderr, /119 census suite\(s\) are unmodelled and were NOT run/);
  assert.ok(!/unmodelled: t7\b/.test(stderr), "the individual lines must not be echoed");
  assert.match(stderr, /joins no MODELLED census suite/, "and silence must not read as coverage");
});

test("an UNMAPPABLE suite is shown in full — it is a table defect, not routine incompleteness", () => {
  const dir = scratch();
  mkdirSync(join(dir, "bin"), { recursive: true });
  const fake = join(dir, "bin", "rmd");
  writeFileSync(fake, "#!/bin/sh\necho 'unmapped: some-census' >&2\n");
  chmodSync(fake, 0o755);
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "1" });
  assert.equal(status, 0);
  assert.match(stderr, /unmapped: some-census/, "a suite the table cannot map must stay visible");
});

test("rule15-precheck is invoked through the tsx loader, or its exit code means something else", () => {
  // MEASURED: the script imports `src/lib/review.js`, which exists only under tsx. Run bare, it
  // exits 1 with ERR_MODULE_NOT_FOUND — and the hook's arms would read that 1 as "you violated
  // rule 15". A check that cannot run must never be able to masquerade as a check that failed,
  // which is the same defect as the bare `node --test` above and the reason both are pinned.
  const hook = readFileSync(HOOK, "utf8");
  const invocation = /node [^\n]*rule15-precheck\.mjs/.exec(hook);
  assert.ok(invocation, "the hook must run the precheck");
  assert.match(invocation[0], /--import tsx/, `bare node cannot load it: ${invocation[0]}`);
});
