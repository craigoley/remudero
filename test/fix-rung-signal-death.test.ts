/**
 * test/fix-rung-signal-death.test.ts — W1-T2402.
 *
 * THE DEFECT. A `sweep.fix.error` row (`dispatchFix`'s catch, run-task.ts) carries exactly six
 * fields — `error, pr_number, run_id, step, task_id, ts` — and none of them is `cost_usd`,
 * `signal`, `verdict`, or `num_turns`. A fix worker killed by a signal (this fleet's own
 * `killProcessGroup` default, `deployer.ts`'s forced-deploy kickstart, or W1-T1044's wall-clock
 * reclaim all send `SIGKILL`; an actual host OOM kill is indistinguishable from any of them by
 * signal alone) was recoverable only by string-matching the SDK's own free-text message
 * ("Claude Code process terminated by signal SIGKILL") inside the row's `error` field — and
 * because the kill necessarily lands AFTER the spawn, `dispatchStarted` (W1-T1127) is already
 * true, so the failure is swallowed and the strike seeds `runSweep`'s dedup gate exactly as an
 * ordinary fix failure would.
 *
 * THE FIX. `fixDispatchSignalDeath` (run-task.ts) reads a `signal` structurally off the caught
 * error object's own `.signal` property — the SAME property `@anthropic-ai/claude-agent-sdk`'s
 * `sdk.mjs` (`getProcessExitError`) already attaches directly onto the `Error` it rejects a
 * killed spawn with, verified by reading the installed package below — never by matching
 * `.message`'s free text. `dispatchFixCatchOutcome` composes that with W1-T1127's EXISTING
 * `dispatchStarted` rethrow rule, UNCHANGED: the signal is recorded on the ledger row, and never
 * once consulted when deciding whether to swallow or propagate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

import { buildSweepEffects, dispatchFixCatchOutcome, fixDispatchSignalDeath } from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

// ── ground truth: the installed SDK really does attach `.signal` to a killed spawn's Error ──────
//
// `dispatchFix`'s catch never re-derives this — it trusts it as read here — but a claim this load-
// bearing must be checked against the ACTUAL installed package rather than assumed. Standing rule
// 7: distrust the prompt over the installed version.

test("W1-T2402 ground truth: the installed claude-agent-sdk attaches signal/errorClass DIRECTLY onto the Error it rejects a killed spawn with", () => {
  // `require.resolve` on the package root (not a subpath — `./sdk.mjs` is the package's `main`,
  // not a name exposed by its own `exports` map) so this reads the ACTUAL installed file rather
  // than assuming a path.
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkSrc = readFileSync(sdkEntry, "utf8");
  assert.ok(
    /getProcessExitError/.test(sdkSrc) && /process_killed_by_signal/.test(sdkSrc),
    "the SDK's process-exit classifier still exists under this name — a rename here means the read below is stale",
  );
  assert.ok(
    /terminated by signal \$\{t\}/.test(sdkSrc.replace(/\s/g, "")) || /terminated by signal/.test(sdkSrc),
    "the SDK still renders a free-text 'terminated by signal' message — the very string a substring match would key on",
  );
  // The attach helper (`_n`) does `Object.assign` of `{signal, errorClass, telemetryMessage}`
  // onto the Error object it is given — i.e. `signal` really is a STRUCTURAL property on the
  // thrown Error, not something only recoverable from `.message`.
  assert.ok(/errorClass:"process_killed_by_signal",signal:/.test(sdkSrc.replace(/\s/g, "")), "signal is assigned as a field alongside errorClass, not embedded only in message text");
});

// ── acceptance 1/2: a signal termination records itself + its spend structurally ────────────────

test("W1-T2402: a signal-terminated error records `signal` as its own field, not only inside the free-text message", () => {
  const err = Object.assign(new Error("Claude Code process terminated by signal SIGKILL"), {
    signal: "SIGKILL",
    errorClass: "process_killed_by_signal",
  });
  const death = fixDispatchSignalDeath(err);
  assert.ok(death, "a signal death must be detected");
  assert.equal(death?.signal, "SIGKILL", "the signal is read off the STRUCTURAL field");
});

test("W1-T2402: a signal-terminated error records what is known about spend, so cost is not invisible", () => {
  const errUnknown = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL" });
  assert.equal(fixDispatchSignalDeath(errUnknown)?.costUsd, 0, "0 — never guessed higher — when no envelope ever arrived");

  const errKnown = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL", costUsd: 4.2 });
  assert.equal(fixDispatchSignalDeath(errKnown)?.costUsd, 4.2, "a real figure is threaded through when the caller does carry one");
});

test("W1-T2402: an ordinary error (no structural signal field) is never misread as a signal death, even if its MESSAGE mentions a signal", () => {
  // The exact substring-match trap this task closes: the free text can say the word without the
  // structural field being present (a worker's own report, a stderr tail quoting a log line, …).
  const proseErr = new Error("worker stderr mentioned: process terminated by signal SIGKILL somewhere in a log");
  assert.equal(fixDispatchSignalDeath(proseErr), undefined, "no `.signal` property ⇒ not a signal death, regardless of message text");

  const nonStringSignal = Object.assign(new Error("odd"), { signal: 9 });
  assert.equal(fixDispatchSignalDeath(nonStringSignal), undefined, "a non-string `.signal` is never coerced into one");

  assert.equal(fixDispatchSignalDeath("a bare string throw" as unknown), undefined, "a non-object thrown value is never a signal death");
  assert.equal(fixDispatchSignalDeath(null), undefined);
});

test("W1-T2402: dispatchFixCatchOutcome's ledger fields carry signal + cost_usd only when a signal death was found", () => {
  const signalErr = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL", costUsd: 1.5 });
  const withSignal = dispatchFixCatchOutcome(signalErr, true);
  assert.equal(withSignal.ledgerFields.signal, "SIGKILL");
  assert.equal(withSignal.ledgerFields.cost_usd, 1.5);
  assert.equal(withSignal.ledgerFields.error, "terminated by signal SIGKILL", "the free-text error field is kept too — additive, not a replacement");

  const ordinaryErr = new Error("git checkout -B failed: reference already exists");
  const withoutSignal = dispatchFixCatchOutcome(ordinaryErr, true);
  assert.equal(withoutSignal.ledgerFields.signal, undefined, "no signal field on an ordinary failure — the existing six-field shape is unchanged");
  assert.equal(withoutSignal.ledgerFields.cost_usd, undefined);
});

// ── acceptance 3/4: the rethrow decision is UNCHANGED — keyed on dispatchStarted alone ──────────

test("W1-T2402: an ordinary fix failure keeps consuming its strike exactly as it does today (swallowed once a strike was spent)", () => {
  const ordinaryErr = new Error("gh pr view failed: exit status 1");
  const outcome = dispatchFixCatchOutcome(ordinaryErr, /* dispatchStarted */ true);
  assert.equal(outcome.rethrow, false, "a strike already spent stays swallowed — runSweep keeps recording acted:true");
});

test("W1-T2402: a failure that struck before the worker ran still propagates rather than seeding the gate", () => {
  const ordinaryErr = new Error("git -C <missing-repo> fetch failed");
  const outcome = dispatchFixCatchOutcome(ordinaryErr, /* dispatchStarted */ false);
  assert.equal(outcome.rethrow, true, "no strike was ever spent — runSweep's own catch must see this, not a clean return");
});

// ── acceptance 5: the signal alone never decides attribution/the rethrow branch ─────────────────

test("W1-T2402: the SAME signal, under the two dispatchStarted states, rethrows/swallows EXACTLY as an ordinary error would — the signal never enters the decision", () => {
  const before = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL" });
  const after = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL" });

  const beforeOutcome = dispatchFixCatchOutcome(before, false);
  const afterOutcome = dispatchFixCatchOutcome(after, true);

  assert.equal(beforeOutcome.rethrow, true, "signal death before any strike: still propagates, same as an ordinary pre-strike failure");
  assert.equal(afterOutcome.rethrow, false, "signal death after a real strike: still swallowed, same as an ordinary post-strike failure");
  // Both rows still carry the signal structurally — recording it is orthogonal to the decision.
  assert.equal(beforeOutcome.ledgerFields.signal, "SIGKILL");
  assert.equal(afterOutcome.ledgerFields.signal, "SIGKILL");
});

// ── acceptance 6: nothing added paces, throttles, sleeps, or awaits ─────────────────────────────

test("W1-T2402: dispatchFixCatchOutcome and fixDispatchSignalDeath are synchronous — no pacing, no throttle, no sleep, no clock", () => {
  const err = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL" });
  // A synchronous function call returns a plain value, never a Promise/thenable — if either
  // function had grown an `await`/timer this assertion (not `instanceof Promise`) would fail.
  const deathResult = fixDispatchSignalDeath(err);
  assert.equal(typeof (deathResult as unknown as { then?: unknown })?.then, "undefined", "fixDispatchSignalDeath returns a plain value, not a Promise");
  const outcomeResult = dispatchFixCatchOutcome(err, true);
  assert.equal(typeof (outcomeResult as unknown as { then?: unknown }).then, "undefined", "dispatchFixCatchOutcome returns a plain value, not a Promise");
});

// ── integration: the REAL dispatchFix catch, wired through a REAL runSweep pass ─────────────────
//
// Reuses test/fix-dedup-seed.test.ts's own fixture shape (the sibling W1-T1127 test file for this
// exact catch block) — a real throwaway bare git repo as `origin`, `gh` stubbed on PATH, and an
// injected `spawnImpl` (buildSweepEffects' own seam) standing in for the SDK spawn. Drives the
// pre-strike case end to end: the spawn itself is what dies, so `dispatchStarted` is false and the
// row must both carry the structural signal AND still propagate to runSweep's `acted:false`.

function ghShim(dir: string, headRefName: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"headRefName"*) printf \'{"headRefName":"%s","body":""}\\n\' ' + JSON.stringify(headRefName) + " ;;",
      '  *"api"*"pulls/"*) echo \'{"state":"open","merged":false,"head":{"sha":"deadbeef"}}\' ;;',
      "  *) echo '{}' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/acme/w1t2402-repo/pull/1",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    headSha: "cafe0001",
    autoMergeArmed: false,
    ...over,
  } as OpenPrView;
}

test("W1-T2402 integration: a spawn killed by signal is ledgered with a structural `signal`/`cost_usd`, and — no strike yet spent — still propagates to acted:false", async () => {
  const owner = "acme";
  const repo = "w1t2402-live-repo";
  const branch = "run-W1T2402FIX-1786500000000";
  const bare = mkdtempSync(join(tmpdir(), "w1t2402-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "w1t2402-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(seed, "work.txt"), "work\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "work");
  git(seed, "push", "--quiet", "origin", branch);
  rmSync(seed, { recursive: true, force: true });

  const root = mkdtempSync(join(tmpdir(), "w1t2402-root-"));
  const bin = mkdtempSync(join(tmpdir(), "w1t2402-gh-"));
  const repoDir = join(root, "repos", repo);
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });
  ghShim(bin, branch);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    const TASK = "W1T2402FIX";
    const ledgerPath = join(root, "ledger.ndjson");
    const runId = "SWEEP-W1T2402-SIGNAL";
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, lane: "sweep", ...extra });
    const plan = {
      tasks: [{ id: TASK, title: "w1t2402 fixture", repo, type: "implement", risk: "low", verify: "auto", status: "queued", attempts: 0, depends_on: [] }],
      byId: new Map([[TASK, { id: TASK, title: "w1t2402 fixture" }]]),
    };
    const effects = buildSweepEffects(
      owner,
      repo,
      { claudeBin: "/usr/bin/true", root } as never,
      ledgerPath,
      runId,
      plan as never,
      log,
      DEFAULT_SWEEP_POLICY,
      undefined,
      // Stands in for the SDK spawn: rejects the way a killed subprocess really does — an Error
      // carrying `.signal` STRUCTURALLY (mirroring `@anthropic-ai/claude-agent-sdk`'s own
      // `getProcessExitError`), never a bare message a caller would have to grep.
      async () => {
        throw Object.assign(new Error("Claude Code process terminated by signal SIGKILL"), {
          signal: "SIGKILL",
          errorClass: "process_killed_by_signal",
        });
      },
    );

    const candidate = pr({
      prNumber: 88,
      prUrl: `https://github.com/${owner}/${repo}/pull/88`,
      taskId: TASK,
      headSha: "cafefeed88",
      ciFailures: [{ name: "ci", logTail: "build failed" }],
    });

    const summary = await withLiveWritesAllowed(() =>
      runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY),
    );

    assert.equal(summary.actions[0].acted, false, "no strike was ever spent — a signal death before dispatch must not seed the dedup gate");

    const lines = readLedgerLines(ledgerPath);
    const errorLines = lines.filter((l) => l.step === "sweep.fix.error");
    assert.equal(errorLines.length, 1, `exactly one sweep.fix.error row; got ${JSON.stringify(lines.map((l) => l.step))}`);
    assert.equal(errorLines[0].signal, "SIGKILL", "the row carries the signal as its OWN field");
    assert.equal(errorLines[0].cost_usd, 0, "the row carries cost_usd — present, not absent — even though nothing was measurable");
    assert.ok(
      typeof errorLines[0].error === "string" && /SIGKILL/.test(errorLines[0].error as string),
      "the free-text error field is kept too, unchanged",
    );
    assert.ok(!lines.some((l) => l.step === "fix.dispatch"), "no strike was recorded — the spawn itself is what died");

    const disposed = lines.filter((l) => l.step === "sweep.disposed" && l.pr_number === 88);
    assert.equal(disposed.length, 1);
    assert.equal(disposed[0].acted, false, "sweep.disposed carries acted:false — the signal is recorded, never used to forgive or spend a strike");
  } finally {
    process.env.PATH = savedPath;
    for (const d of [bare, root, bin]) rmSync(d, { recursive: true, force: true });
  }
});
