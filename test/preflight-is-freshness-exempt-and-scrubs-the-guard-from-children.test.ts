/**
 * W1-T2769 — CLAUDE.md's OWN FIRST RULE WAS UNUSABLE ON A FEATURE BRANCH.
 *
 * `rmd preflight --ci-parity` is what CLAUDE.md prescribes running before a first push, on
 * whatever feature branch that push is from. Off-main is always "diverged", never "behind" (the
 * off-main arm `checkCliFreshness` refuses on), so `main()`'s entry gate refused the bare
 * invocation outright: "rmd has diverged from origin/main ... refusing to auto-sync". The
 * documented workaround, exporting `RMD_SELF_SYNC_DONE=1`, is deliberately "every call" for the
 * shell's session (self-sync.ts) — which crosses into `ci:test`'s own spawned suite and turns 45
 * of THAT suite's own self-sync tests red, because `alreadySelfSynced` (self-sync.ts) reads
 * `process.env` a second time regardless of the `env` object its caller constructed.
 *
 * TWO FIXES, BOTH REQUIRED, EACH PROVEN HERE:
 *   (A) `preflight` joins `READ_ONLY_FRESHNESS_EXEMPT_VERBS` (run-task.ts) — the bare invocation
 *       no longer needs the export at all.
 *   (B) `defaultPreflightSpawn` (lib/commit-message.ts) unconditionally deletes the guard var
 *       from every child's env — an operator's shell carrying it for an unrelated reason can no
 *       longer poison a spawned test suite either.
 * (A) alone would still leave (B)'s gap open for a shell where the var is set for some other
 * purpose; (B) alone would still leave the bare invocation refusing. Each guard below isolates
 * one half so a regression in either is caught by its own failure, not folded into the other's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultPreflightSpawn } from "../src/lib/commit-message.js";
import { main } from "../src/run-task.js";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** The exact shape `checkCliFreshness` returns for an off-main, behind checkout — the shape
 *  every feature branch produces, and the one the documented `preflight --ci-parity` invocation
 *  hit before this task. Mirrors `test/deploy-run-freshness-exempt.test.ts`'s own fixture shape
 *  so this suite's refusal text is provably the SAME refusal that gate produces, not a fixture
 *  drifted from the real one. */
const REFUSED_OFF_MAIN_BEHIND = () =>
  ({
    status: "refused" as const,
    reason: "off-main" as const,
    message:
      "rmd has diverged from origin/main (aebf442..7775b99) -- not a fast-forward, refusing to " +
      "auto-sync (never merging or rebasing on your behalf). Run `git pull --ff-only` yourself " +
      "-- it will fail cleanly if a fast-forward truly isn't possible, and you can resolve the " +
      "divergence from there.",
  });

/** Drives `main()` for one verb with the freshness check pinned to a refusal, and reports
 *  whether the gate's own refusal message fired (`reached: false`) or execution continued past
 *  it into the verb's own dispatch (`reached: true`). Same shape as
 *  `test/deploy-run-freshness-exempt.test.ts`'s `runVerbUnderRefusal`, independently built here
 *  so this file's evidence does not depend on that file's helper staying unchanged. */
async function runVerbUnderRefusal(
  t: { mock: { method: typeof import("node:test").mock.method } },
  argv: string[],
  checkFreshness: typeof checkCliFreshness = REFUSED_OFF_MAIN_BEHIND,
): Promise<{ reached: boolean; errs: string[] }> {
  const errs: string[] = [];
  t.mock.method(
    process,
    "exit",
    ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as typeof process.exit,
  );
  t.mock.method(console, "error", (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", ...argv];
  try {
    let caught: unknown;
    await main({ checkFreshness }).catch((e) => {
      caught = e;
    });
    const gateRefused = errs.some((e) => e.includes("refusing to auto-sync"));
    return { reached: !gateRefused, errs };
  } finally {
    process.argv = originalArgv;
  }
}

// ── (A) `preflight` reaches its own dispatch on the EXACT shape a feature branch produces ────

test("W1-T2769: `rmd preflight` on an off-main, diverged checkout is NOT refused by the entry gate", async (t) => {
  const r = await runVerbUnderRefusal(t, ["preflight", "--fast"]);
  assert.ok(
    r.reached,
    `the off-main refusal must not fire for preflight; stderr was ${JSON.stringify(r.errs)}`,
  );
});

test("W1-T2769 REGRESSION LOCK: a plan-reading verb still refuses on the same off-main shape", async (t) => {
  // The gate was narrowed to admit one more verb, not removed — the sibling regression lock
  // every prior widening of this set has carried (deploy-run-freshness-exempt.test.ts's own).
  const r = await runVerbUnderRefusal(t, ["lint-plan"]);
  assert.ok(!r.reached, "lint-plan must still hit the gate");
  assert.ok(r.errs.some((e) => e.includes("refusing to auto-sync")), "with the remedy message");
});

test("W1-T2769: the exempt set names exactly {doctor, status, preflight}, each with its own declared reason", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const match = src.match(
    /READ_ONLY_FRESHNESS_EXEMPT_VERBS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([^\]]*)\]\)/,
  );
  assert.ok(match, "the declaration must exist, unrenamed");
  const verbs = (match?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .sort();
  assert.deepEqual(verbs, ["doctor", "preflight", "status"]);
});

// ── (B) the guard var cannot cross into a child `defaultPreflightSpawn` launches ─────────────

test("W1-T2769: RMD_SELF_SYNC_DONE set in the CALLING shell is absent from the spawned child's own process.env", () => {
  const prior = process.env.RMD_SELF_SYNC_DONE;
  process.env.RMD_SELF_SYNC_DONE = "1";
  try {
    const r = defaultPreflightSpawn("node", [
      "-e",
      "process.stdout.write(process.env.RMD_SELF_SYNC_DONE === undefined ? 'ABSENT' : 'PRESENT:' + process.env.RMD_SELF_SYNC_DONE)",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      "ABSENT",
      "the child must never see the guard var, regardless of what this process's own env carries",
    );
  } finally {
    if (prior === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = prior;
  }
});

test("W1-T2769: an explicit opts.env passed by a caller does not resurrect the guard var either", () => {
  // A caller merging its own env forward (as ci-parity.ts's leaves sometimes do, e.g. the
  // coverage step's TMPDIR override) must not accidentally reintroduce the var by spreading a
  // copy of process.env that still carries it INTO opts.env — the scrub runs on the FINAL merged
  // env, after opts.env is folded in, not only on process.env's own copy.
  const prior = process.env.RMD_SELF_SYNC_DONE;
  process.env.RMD_SELF_SYNC_DONE = "1";
  try {
    const r = defaultPreflightSpawn(
      "node",
      ["-e", "process.stdout.write(process.env.RMD_SELF_SYNC_DONE === undefined ? 'ABSENT' : 'PRESENT')"],
      { env: { ...process.env, EXTRA_MARKER: "x" } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ABSENT");
  } finally {
    if (prior === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = prior;
  }
});

test("W1-T2769: unrelated environment (PATH) is unaffected by the scrub — only the one key is removed", () => {
  const r = defaultPreflightSpawn("node", ["-e", "process.stdout.write(process.env.PATH ? 'HAS_PATH' : 'NO_PATH')"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "HAS_PATH", "PATH inheritance must be exactly as before this change");
});

// ── (A)+(B) TOGETHER: the case this task exists for, through the REAL production entry point ─
//
// A literal nested `node --test` inside this suite's own `node --test` process hits Node's own
// recursive-run guard ("run() is being called recursively within a test file, skipping running
// files") — a real Node behavior, unrelated to this fix, that would make the test below always
// report zero tests rather than proving anything. So this drives `checkCliFreshness` itself —
// the exact function whose SECOND `process.env` read is what let the guard var cross into a
// child in the first place — inside a plain spawned script, with a fake `git` dep standing in
// for a real off-main repo (`SelfSyncDeps.git` is injectable for exactly this reason). That is
// the real integration point poisoned in the incident; node --test is merely how the incident
// was FIRST noticed, not what this guard needs to re-invoke to prove the fix.

test("W1-T2769: checkCliFreshness in a spawned child still REFUSES a diverged checkout, even though the parent process has RMD_SELF_SYNC_DONE=1 set", () => {
  const prior = process.env.RMD_SELF_SYNC_DONE;
  process.env.RMD_SELF_SYNC_DONE = "1";
  // A fake `git` dep standing in for a real diverged repo (`SelfSyncDeps.git` is injectable for
  // exactly this reason — see self-sync.ts). Calls in `checkCliFreshness`'s own order: `fetch`,
  // two `rev-parse`s (distinct shas => not up-to-date), `rev-parse --git-dir --git-common-dir`
  // (identical => not a worktree), `status --porcelain` (empty => clean), then `merge-base
  // --is-ancestor` THROWS — HEAD is not an ancestor of origin/main, `ffPossible = false`, and
  // the function refuses with `reason: "diverged"` before ever reaching the branch check. This
  // is the SAME diverged shape `REFUSED_OFF_MAIN_BEHIND` above quotes verbatim from a real run.
  const childScript = [
    'import { checkCliFreshness } from ' + JSON.stringify(join(REPO_ROOT, "src", "lib", "self-sync.ts")) + ';',
    "const git = (args) => {",
    '  if (args[0] === "rev-parse" && args.includes("--git-dir")) return "/r/.git\\n/r/.git";',
    '  if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);',
    '  if (args[0] === "rev-parse" && args[1] === "origin/main") return "b".repeat(40);',
    '  if (args[0] === "status") return "";',
    '  if (args[0] === "merge-base") throw new Error("not an ancestor");',
    '  return "";',
    "};",
    // Mirrors the REAL call site exactly (run-task.ts:35486): the injected env is `process.env`
    // itself, unmodified — the guard var's leak path is entirely `process.env`'s SECOND read
    // inside `alreadySelfSynced`, not this argument.
    'const r = checkCliFreshness("/r", process.env, { git, say: () => {}, warn: () => {} });',
    "process.stdout.write(r.status);",
  ].join("\n");
  try {
    // W1-T2769: CI/GITHUB_ACTIONS CLEARED in the child's env, deliberately. `checkCliFreshness`
    // checks `isCiEnv` BEFORE ever reading the guard var or touching `deps.git` — a correct,
    // unrelated short-circuit for the real production path (a CI checkout is always "diverged"
    // by design, see self-sync.ts). `defaultPreflightSpawn` merges `process.env` forward, so
    // running THIS test inside an actual GitHub Actions runner (as CI itself does) leaks real
    // `CI=true`/`GITHUB_ACTIONS=true` into the child and makes it return `guarded` off that
    // earlier check, never reaching the fake `git` dep this test constructs at all — masking the
    // one path this test exists to prove, only when run in CI. Clearing both here isolates the
    // guard-var behavior under test from that unrelated, already-correct short-circuit.
    const r = defaultPreflightSpawn("npx", ["tsx", "-e", childScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
    });
    assert.equal(r.status, 0, `child failed to run: ${r.stderr.slice(0, 800)}`);
    assert.equal(
      r.stdout.trim(),
      "refused",
      "the guard var in THIS process's env must not leak into the child and short-circuit its own refusal",
    );
  } finally {
    if (prior === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = prior;
  }
});

// ── the literal cannot drift from the canonical export ───────────────────────────────────────
//
// `defaultPreflightSpawn` scrubs the LITERAL `"RMD_SELF_SYNC_DONE"` rather than importing
// self-sync.ts's own `SELF_SYNC_GUARD_ENV` — importing it would close dozens of existing rings
// (self-sync.ts already reaches back to commit-message.ts transitively via daemon.ts) into NEW
// dependency-cruiser cycles (MEASURED: 13 -> 53 warnings against the cycle-ratchet ceiling).
// That means the two names are no longer tied together by the type checker, so this guard is
// what would catch either one being renamed without the other.
test("W1-T2769: the literal defaultPreflightSpawn scrubs matches self-sync.ts's own SELF_SYNC_GUARD_ENV", () => {
  assert.equal(
    SELF_SYNC_GUARD_ENV,
    "RMD_SELF_SYNC_DONE",
    "if this ever changes, commit-message.ts's inlined literal (kept separate to avoid a " +
      "dependency-cruiser cycle) must be updated to match",
  );
});
