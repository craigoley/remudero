// test/config-reader-seams.test.ts — the structural check recon-EJ specified
// (state/recon-EJ-test-config-coupling.md §6/§7).
//
// THE DEFECT CLASS. `run-task.ts`'s `repoRoot` is a MODULE-LEVEL CONST evaluated once at import:
// under `node --test` the `--repo-root` branch cannot fire (the runner's argv holds test paths), so
// it falls to `git rev-parse --show-toplevel` from the test process's cwd. NO TEST CAN PASS A ROOT —
// not by chdir after import, not by env, not by a fixture, because it is captured before any test
// body runs. `loadDefaultPolicy` is worse still: it resolves from `import.meta.url` (where the code
// physically lives) and memoizes for the process lifetime.
//
// So a test can build a config fixture, drive code that ignores it, and assert something the SHIPPED
// value happens to satisfy. It passes for the wrong reason and cannot catch the regression it names.
// That is exactly what `test/auto-triage-wiring.test.ts` did: it asserted an unconditional refusal
// under a title claiming the policy block was ABSENT, its fixture wrote no policy file at all, and it
// was really pinning "the shipped default is false" (#1093, #1095).
//
// WHY A STRUCTURAL CHECK AND NOT A RUNTIME GUARD. recon-EJ ruled the obvious fix out and the reasoning
// is not repeated here beyond its conclusion: unlike the write side, where the forbidden boundaries are
// few and always wrong, reading these files is something tests do legitimately all day — an exemption
// needed at nearly every call site is not a guard. And the two worst readers resolve DURING IMPORT,
// before any per-test guard could arm. This check runs at build time, costs nothing at runtime, and
// cannot be switched off by an env var.
//
// THE CONTRACT. Every unredirectable POLICY reader must either offer an injection seam, or carry an
// allowlist entry with a specific reason. Both directions are enforced: a reader with neither fails,
// and a reader that GAINS a seam while staying allowlisted ALSO fails — otherwise the list rots into a
// lie (the discipline PR #996's mounts-row check established).
//
// READ WITH readFileSync, NOT grep. Two source files carry raw NUL bytes
// (`src/lib/flight-signals.ts`, `src/lib/task-linter.ts`) and are invisible to `grep` without `-a`.
// A reader living in either would be silently missed and this file would report a false clean. Using
// Node's own reader means there is no `-a` to forget — the same choice PR #1083 made for the same
// reason.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/**
 * A POLICY read. Scoped to policy deliberately: it is the class recon-EJ measured end to end, and the
 * one with a demonstrated silent-pass instance. The wider set of checked-in-config readers reached the
 * same way — mounts, worker settings, the plan, feedback — is real and reported in that recon, but no
 * measurement found a test coupled to any of them, and allowlisting twenty-nine sites on the day the
 * check ships is how a structural check becomes decoration.
 */
const POLICY_READ = /\b(loadPolicy|loadDefaultPolicy)\s*\(/;

/**
 * UNREDIRECTABLE: the file's location comes from the module-level `repoRoot` const, or from the
 * install path via `loadDefaultPolicy`/`installPolicyPath`. The negative lookarounds matter — a
 * PARAMETER named `repoRootDir` is caller-supplied and must not count (`run-task.ts`'s
 * `resolveRunMounts` takes one).
 */
const UNREDIRECTABLE = /(?<![A-Za-z0-9_])repoRoot(?![A-Za-z0-9_])|loadDefaultPolicy\s*\(|installPolicyPath\s*\(/;

/** An injection seam: a `??` fallback, so a caller-supplied value wins over the file read. */
const HAS_SEAM = /\?\?\s*(loadPolicy|loadDefaultPolicy)\s*\(/;

/**
 * The ALLOWLIST. Every entry states a SPECIFIC reason; "TODO" is not one. An entry is a promise that
 * the site was looked at and found not to need a seam — so a site that later GAINS one is removed by
 * the stale-entry test below, not left to rot.
 */
const ALLOWED: ReadonlyArray<{ file: string; symbol: string; reason: string }> = [
  {
    file: "src/lib/policy.ts",
    symbol: "cachedDefaultPolicy",
    reason:
      "This IS loadDefaultPolicy's own body — the mechanism, not a consumer of it. A seam here would " +
      "be a seam on the seam; every consumer's own override (or its allowlist entry below) is where " +
      "the decision belongs.",
  },
  {
    file: "src/run-task.ts",
    symbol: "drainMax",
    reason:
      "drainCommand's drain.max. MEASURED SAFE (recon-EJ): poisoning drain.max left every suite " +
      "driving drainCommand green, so no test asserts on its output. A seam nothing injects is the " +
      "PR #1066 shape — that PR shipped a daemon rung whose producer was never supplied, with 18 " +
      "passing tests and a green review.",
  },
  {
    file: "src/run-task.ts",
    symbol: "daemonCommandPolicy",
    reason:
      "daemonCommand's pollIntervalMs + headroom curve. MEASURED SAFE (recon-EJ): poisoning " +
      "pollIntervalMs left every daemon suite green. Allowlisted for the same reason as drainMax — " +
      "do not plumb a parameter nothing injects.",
  },
  {
    file: "src/lib/review.ts",
    symbol: "proofTimeoutMs",
    reason:
      "The DEFAULT only: execWhitelistedProof takes an explicit timeout parameter, so a caller that " +
      "wants another value passes one. The read is the fallback, not the sole source.",
  },
  {
    file: "src/lib/sweep.ts",
    symbol: "POLICY_SWEEP",
    reason:
      "Evaluated at MODULE LOAD, so no per-call seam could arm in time. Already passed as an argument " +
      "at its call sites (DEFAULT_SWEEP_POLICY), which is how a test hands in its own value. recon-EJ " +
      "rated conversion zero-value: it touches every consumer to fix a problem no measurement found.",
  },
  {
    file: "src/lib/worker.ts",
    symbol: "DEFAULT_PRUNE_GRACE_MS",
    reason:
      "Evaluated at MODULE LOAD, same as POLICY_SWEEP. Already passed as an argument — " +
      "test/worker-run-lock.test.ts drives pruneStaleRuns with an explicit graceMs, which is the seam " +
      "that actually matters here.",
  },
  {
    file: "src/lib/worker.ts",
    symbol: "DEFAULT_WORKTREE_REAP_GRACE_MS",
    reason:
      "W1-T378, and allowlisted for exactly its sibling DEFAULT_PRUNE_GRACE_MS's reason: evaluated at " +
      "MODULE LOAD, so no per-call seam could arm in time, and already passed as an argument — " +
      "reapStaleWorktrees takes opts.maxAgeMs, which test/worktree-reap-liveness.test.ts drives " +
      "explicitly (and also asserts the shipped default's VALUE, so a silent policy drift still fails).",
  },
];

interface Reader {
  file: string;
  line: number;
  text: string;
  hasSeam: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every unredirectable policy read under `src/`, found by reading bytes rather than shelling out. */
export function findUnredirectablePolicyReaders(srcDir: string = SRC, root: string = REPO_ROOT): Reader[] {
  const out: Reader[] = [];
  for (const file of walk(srcDir).sort()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!POLICY_READ.test(line)) return;
      if (/^\s*(\*|\/\/)/.test(line)) return; // doc comment or line comment
      if (/^import |^\} from /.test(line)) return; // import statement
      if (/^\s*export function (loadPolicy|loadDefaultPolicy)\b/.test(line)) return; // the declarations themselves
      if (!UNREDIRECTABLE.test(line)) return;
      out.push({ file: relative(root, file), line: i + 1, text: line.trim(), hasSeam: HAS_SEAM.test(line) });
    });
  }
  return out;
}

/** Which allowlist entry, if any, claims this reader. Matched on file + a symbol on the line. */
function allowedEntryFor(r: Reader): (typeof ALLOWED)[number] | undefined {
  return ALLOWED.find((a) => a.file === r.file && r.text.includes(a.symbol));
}

// `daemonCommand`'s reader carries no distinctive symbol of its own (`const policy = loadPolicy(…)`),
// and `run-task.ts` has two such lines. Disambiguate by line ordinal within the file: the LAST bare
// `const policy = loadPolicy(policyPath(repoRoot))` is daemonCommand's.
function symbolise(readers: Reader[]): Reader[] {
  const bare = readers.filter((r) => /^const policy = loadPolicy\(/.test(r.text));
  if (bare.length > 0) {
    const last = bare[bare.length - 1];
    last.text = `${last.text} /*daemonCommandPolicy*/`;
  }
  return readers;
}

test("CALIBRATION: the detection finds the readers recon-EJ measured, and no more", () => {
  const readers = findUnredirectablePolicyReaders();
  // recon-EJ enumerated eight CONSUMER sites; this detection also sees loadDefaultPolicy's own body,
  // which that recon counted as the mechanism rather than a reader. Eight consumers + one definition.
  // TEN since `checkProofTimeoutMs` (run-task.ts) landed — a NINTH consumer, and a SEAMED one: it
  // is counted here because the detector counts every unredirectable READ, seamed or not, and the
  // seam question is test 2's job. ELEVEN since `dailyCostCeilingReloader` (run-task.ts, W1-T331)
  // landed — a TENTH consumer, also SEAMED (`deps.policy ?? loadPolicy(...)`), so it passes test 2
  // the same way. TWELVE since `buildAccountUsageRoute` (account-usage.ts, W1-T333) landed — an
  // ELEVENTH consumer, also SEAMED (`deps.policy ?? loadDefaultPolicy()`), reading the daily cost
  // ceiling's committed default for the ACCOUNT strip's provenance render. Raising this number is
  // the correct response to a new reader ONLY when that reader also passes test 2; a bare new
  // reader must fail there first. THIRTEEN since `DEFAULT_WORKTREE_REAP_GRACE_MS` (worker.ts,
  // W1-T378) landed — a TWELFTH consumer, module-load and therefore UNSEAMED, so it is ALLOWLISTED
  // rather than seamed, for its sibling DEFAULT_PRUNE_GRACE_MS's reason (the argument seam that
  // matters is reapStaleWorktrees' own `opts.maxAgeMs`). It failed test 2 first, as this comment
  // requires, and was allowlisted only after. FOURTEEN since `ceilingPolicy` (panel-graph.ts,
  // W1-T364) landed — a THIRTEENTH consumer, also SEAMED (`deps.policy ?? loadDefaultPolicy()`),
  // backing the console's OWN write control over the daily cost ceiling override (POST
  // /v1/policy/daily-cost-ceiling(/clear)) — the same bound `buildAccountUsageRoute`'s reader
  // already reads for the ACCOUNT strip's render, now also consulted at write time so a write
  // never validates against a hardcoded copy of the committed row. ONE line, shared by both
  // routes, rather than the seam appearing twice. FIFTEEN since `buildSweepEffects`'s
  // `armSessionPrs` (run-task.ts, W1-T516) landed — a FOURTEENTH consumer, also SEAMED
  // (`armSessionPrsOverride ?? loadDefaultPolicy()`), gating whether the sweep arms a session
  // PR (no plan task id) under the review lane's own PR-<n> synthetic id. SIXTEEN since
  // `runTask`'s own `workerAbandonMs` (run-task.ts, W1-T1045) landed — a FIFTEENTH consumer,
  // also SEAMED (`opts.workerAbandonMs ?? loadDefaultPolicy()`), resolving the clock bound
  // threaded into every real dispatch spawn's `clockBound` — see worker.ts's
  // `createWorkerClockBoundWatchdog`.
  //
  // Then W1-T1044 added TWO more, both SEAMED and both reading the SAME `sweepWallClockBoundMs`
  // row: `runTask`'s `opts.spawnWallClockBoundMs ?? loadDefaultPolicy()` at its single
  // `runFixRung` call site, and `buildSweepEffects`'s
  // `spawnWallClockBoundMsOverride ?? loadDefaultPolicy()` at the sweep's own `dispatchFix` call
  // site — the two placements that task requires (daemon-side + worker-spawn-side), one policy
  // row read at two seamed sites. W1-T1045 and W1-T1044 landed independently, so the count is
  // the sum of both, not either branch's own figure.
  //
  // NINETEEN since `policyFor` (run-task.ts, W1-T1259) landed — a SIXTEENTH consumer, also SEAMED
  // (`deps.policy ?? loadPolicy(policyPath(repoRoot))`), resolving the measurement cadence rows that
  // give rule-efficacy, verdict-calibration and autonomy-rate their own schedule. It is a THUNK
  // rather than a `const`, so the read happens per call instead of once at command entry — the
  // detector counts it the same way, because it counts every unredirectable READ and the seam
  // question is test 2's job. IT PASSED TEST 2 BEFORE THIS NUMBER MOVED, which is the order this
  // comment requires: the calibration failed at 19-vs-18 while test 2 stayed green, so the reader
  // arrived already seamed and is NOT allowlisted — adding it to ALLOWED would fail test 3's
  // STALE-ENTRY LOCK and test 5, both of which refuse a seamed reader an allowlist entry.
  //
  // TWENTY since `buildDigestCadenceDaemonHooks`'s own `policyFor` (run-task.ts, W1-T2277) landed —
  // a SEVENTEENTH consumer, also SEAMED (`deps.policy ?? loadPolicy(policyPath(repoRoot))`),
  // resolving the `digestCadence` rows that give the fleet digest its own daemon schedule. It is a
  // STRUCTURAL SIBLING of the nineteenth above, not a second kind of thing: the same thunk shape,
  // reading a sibling row, in the hook builder next to it — `buildMeasurementCadenceDaemonHooks`
  // reads `values.measurementCadence`, this one reads `values.digestCadence`. Two hook builders,
  // two rows, two seamed reads, and the detector counts reads rather than builders.
  // IT PASSED TEST 2 BEFORE THIS NUMBER MOVED, which is the order this comment requires: the
  // calibration failed at 20-vs-19 while test 2 stayed green, so the reader arrived already seamed
  // and is NOT allowlisted — adding it to ALLOWED would fail test 3's STALE-ENTRY LOCK and test 5.
  // The file set is UNCHANGED by it (`src/run-task.ts` already carried the nineteenth), so the
  // `files` assertion below needed no edit — which is itself the check that this reader landed
  // where its sibling lives rather than opening a new unredirectable surface.
  // TWENTY-ONE since `buildBoardReviewDaemonHooks`'s own `policyFor` (run-task.ts, W1-T2304's
  // wiring) landed — an EIGHTEENTH consumer, also SEAMED (`deps.policy ?? loadPolicy(policyPath(
  // repoRoot))`), resolving the `boardReview` row that gives the whole-board rung its own daemon
  // schedule. It is the THIRD structural sibling of the shape above, not a new kind of thing: the
  // same thunk, a sibling row, in the hook builder next to the other two —
  // `buildMeasurementCadenceDaemonHooks` reads `values.measurementCadence`,
  // `buildDigestCadenceDaemonHooks` reads `values.digestCadence`, this one reads
  // `values.boardReview`. Three hook builders, three rows, three seamed reads.
  // IT PASSED TEST 2 BEFORE THIS NUMBER MOVED, which is the order this comment requires: the
  // calibration failed at 21-vs-20 while test 2 stayed green, so the reader arrived already seamed
  // and is NOT allowlisted — adding it to ALLOWED would fail test 3's STALE-ENTRY LOCK and test 5.
  // The file set is UNCHANGED by it (`src/run-task.ts` already carried the other two), so the
  // `files` assertion below needed no edit — itself the check that this reader landed where its
  // siblings live rather than opening a new unredirectable surface.
  // TWENTY-TWO since `serveCommand`'s own `githubEventWakePolicy` (run-task.ts, W1-T2568) landed —
  // a NINETEENTH consumer, also SEAMED (`deps.policy ?? loadPolicy(policyPath(repoRoot))`),
  // resolving the `githubEventWake` row that sizes the signed-webhook replay ring. It is NOT a
  // fourth hook-builder sibling: it reads once at command entry, like the older `const` readers
  // above, not per call.
  // ⚠ AND IT IS THE FIRST READER ON A PATH THAT MAY NOT REFUSE TO START. `loadPolicy` THROWS on an
  // absent or malformed plan/policy.yaml, and serveCommand's SERVICE POSTURE paragraph (W1-T152,
  // W1-T255, #726) forbids a startup refusal there — under launchd it is a KeepAlive crash-loop. So
  // this read is wrapped and RECORDED (`serve.policy_unreadable`), and the wake falls back to
  // DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY, which `createService` already defaults to when the
  // field is absent. The seam alone would have satisfied test 2 while still killing the console on
  // a checkout with no policy.yaml; test/install-symlink-refusal.test.ts is what caught that.
  // IT PASSED TEST 2 BEFORE THIS NUMBER MOVED, which is the order this comment requires: the
  // calibration failed at 22-vs-21 while test 2 stayed green, so the reader arrived already seamed
  // and is NOT allowlisted — adding it to ALLOWED would fail test 3's STALE-ENTRY LOCK and test 5.
  // The file set is UNCHANGED by it (`src/run-task.ts` already carried the other three).
  // TWENTY-THREE since `decideAutoMergeArm`'s `resolvedBands` (review.ts, W1-T2579) landed —
  // a TWENTIETH consumer, also SEAMED (`bands ?? loadDefaultPolicy()`), resolving the committed
  // operator-ratified arm-calibration table only when the caller did not inject one. It passed
  // test 2 before this number moved, so it is not allowlisted; adding it to ALLOWED would fail
  // test 3's STALE-ENTRY LOCK and test 5. The task's file declaration names this calibration
  // lock because adding a policy consumer without updating its measured corpus is incomplete.
  assert.equal(readers.length, 23, `expected 23 unredirectable policy reads; saw:\n${readers.map((r) => `  ${r.file}:${r.line} ${r.text}`).join("\n")}`);

  // `symbolise` labels the LAST bare `const policy = loadPolicy(...)` as daemonCommand's, because that
  // reader carries no distinctive identifier of its own. Today exactly ONE such line survives —
  // autoTriageCheck's gained a `?? ` seam in #1095 — so the label is unambiguous. PIN THE COUNT: if a
  // second bare reader appears, this fails and whoever added it must disambiguate, rather than the
  // ordinal silently shifting the allowlist entry onto the wrong line.
  const bare = readers.filter((r) => /^const policy = loadPolicy\(/.test(r.text));
  assert.equal(
    bare.length,
    1,
    `symbolise() labels the last bare reader and needs exactly 1; saw ${bare.length}:\n${bare.map((r) => `  ${r.file}:${r.line}`).join("\n")}`,
  );

  const files = [...new Set(readers.map((r) => r.file))].sort();
  assert.deepEqual(files, [
    "src/lib/account-usage.ts",
    "src/lib/launchd.ts",
    "src/lib/panel-graph.ts",
    "src/lib/policy.ts",
    "src/lib/review.ts",
    "src/lib/sweep.ts",
    "src/lib/worker.ts",
    "src/run-task.ts",
  ]);

  // The NUL-carrying files are walked, not skipped — the whole reason this reads bytes.
  const walked = walk(SRC).map((f) => relative(REPO_ROOT, f));
  assert.ok(walked.includes("src/lib/task-linter.ts"), "the NUL-carrying task-linter.ts is walked");
  assert.ok(walked.includes("src/lib/flight-signals.ts"), "the NUL-carrying flight-signals.ts is walked");
});

test("every unredirectable policy reader has a seam or a reasoned allowlist entry", () => {
  const readers = symbolise(findUnredirectablePolicyReaders());
  const unexplained = readers.filter((r) => !r.hasSeam && !allowedEntryFor(r));

  assert.deepEqual(
    unexplained.map((r) => `${r.file}:${r.line}`),
    [],
    "a config reader with no injection seam and no allowlist entry:\n" +
      unexplained.map((r) => `  ${r.file}:${r.line}  ${r.text}`).join("\n") +
      "\nGive it a `?? ` override so a test can inject, or add a reviewed ALLOWED entry that names the " +
      "CONCRETE, checkable EVIDENCE making a seam unnecessary — a test file that already drives the value " +
      "(test/*.test.ts), the call-site argument that already injects it, a measurement pinning the shipped " +
      "default as inert, or (only for loadDefaultPolicy's own body) that this IS the mechanism. A reason a " +
      "reviewer cannot check by opening a named file is not an entry, it is a free pass — see " +
      "test/a-check-that-names-its-own-escape-hatch-gets-escaped.test.ts (W1-T2596).",
  );
});

test("STALE-ENTRY LOCK: an allowlisted reader that has gained a seam fails", () => {
  const readers = symbolise(findUnredirectablePolicyReaders());
  const stale = readers.filter((r) => r.hasSeam && allowedEntryFor(r));

  assert.deepEqual(
    stale.map((r) => `${r.file}:${r.line}`),
    [],
    "these readers now have a seam but are still allowlisted — remove their ALLOWED entry:\n" +
      stale.map((r) => `  ${r.file}:${r.line}  ${r.text}`).join("\n"),
  );

  // ...and no entry may claim a site that no longer exists, which is the other way a list rots.
  const orphans = ALLOWED.filter((a) => !readers.some((r) => r.file === a.file && r.text.includes(a.symbol)));
  assert.deepEqual(orphans.map((a) => `${a.file}:${a.symbol}`), [], "allowlist entries matching no reader");
});

test("every allowlist entry states a specific reason", () => {
  for (const a of ALLOWED) {
    assert.ok(a.reason.length >= 60, `${a.file}:${a.symbol} — a reason must be specific, not a placeholder`);
    assert.doesNotMatch(a.reason, /\bTODO\b|\bFIXME\b|\bfor now\b/i, `${a.file}:${a.symbol} — placeholder reason`);
  }
});

test("a reader WITH a seam passes, so the common case is not a false positive", () => {
  const readers = findUnredirectablePolicyReaders();
  const seamed = readers.filter((r) => r.hasSeam);

  assert.ok(seamed.length >= 3, `expected the seamed readers to be found; saw ${seamed.length}`);
  for (const r of seamed) {
    assert.equal(allowedEntryFor(r), undefined, `${r.file}:${r.line} has a seam and must not be allowlisted`);
  }
  // The two that carry the seam this whole class exists for.
  assert.ok(seamed.some((r) => r.text.includes("deps.policy ??")), "retroTriggerCheck's seam is recognised");
  assert.ok(seamed.some((r) => r.text.includes("opts.policy ??")), "autoTriageCheck's seam is recognised");
});
