#!/usr/bin/env node
/**
 * scripts/recovery-drill.mjs — drill each recovery path on a schedule, against a THROWAWAY
 * fixture, before an emergency forces the first real exercise.
 *
 * WHY. The deploy rollback (lib/deployer.ts's `runDeployCycle`) ran 0-for-7 the first time it
 * mattered, after 130 successful deploys never needed it (2026-08-05, seven consecutive
 * `deploy.unhealthy_rollback` ledger rows, the fleet down 53 minutes). Every static instrument
 * this repo has — SHIPS-UNWIRED ("does anything call this?"), W1-T365's proof rule ("does
 * production decline to use it?"), coverage itself ("did a test run this line?") — answered YES
 * the whole time. "This branch has never executed in production" is a RUNTIME FACT ABOUT
 * PRODUCTION, not a property of any changeset, so no static proof rule reaches it. Only running
 * the code, on a cadence, closes the gap — the same reasoning `clock-sweep.mjs` already
 * establishes for wall-clock drift, followed here rather than re-invented.
 *
 * THE POPULATION (established from source, not copied from a note). A path qualifies when it
 * (a) exists to recover from a failure, (b) is not exercised by the ordinary success path, and
 * (c) has an observable outcome that can be asserted. All four confirmed against every clause:
 *
 *   1. DEPLOY ROLLBACK — lib/deployer.ts `runDeployCycle`'s unhealthy-rollback branch.
 *      (a) restores a known-good sha after a bad deploy fails its health check.
 *      (b) the ordinary success path never calls `resetHard` at all.
 *      (c) the resulting git HEAD, independently re-read with `git rev-parse` — never merely
 *          trusted from the function's own return value.
 *   2. DISPATCH CIRCUIT BREAKER RESET — lib/status.ts `evaluateDispatchBreaker`'s reset-on-
 *      forward-progress branch (`dispatchesWithoutNewOwnedPr` zeroing on a `pr.opened` line).
 *      (a) un-sticks a task the breaker parked after repeated no-op dispatches, once real
 *          progress resumes.
 *      (b) the steady state (a task dispatched once or twice) never approaches the breaker at
 *          all, let alone its reset.
 *      (c) the tri-state verdict (`tripped`/`clear`/`indeterminate`), re-derived fresh from a
 *          real ledger file on disk.
 *   3. STALE-LOCK RECLAIM — lib/fs-race-safe.ts `reclaimStaleLock`, whose own comment records
 *      an ext4 inode-reuse TOCTOU it had to close.
 *      (a) clears a lock abandoned by a dead holder so a later acquirer is not wedged forever.
 *      (b) a live process's own lock is never reclaimed by the ordinary path — only a genuinely
 *          dead holder's is, which is rare by construction.
 *      (c) the lock file's real on-disk presence/absence after the call, independently checked.
 *   4. WORKER KEYCHAIN RE-PROVISION — lib/worker-home.ts `ensureWorkerKeychain`'s provisioning
 *      branch (absent / identity-changed / credential-expired).
 *      (a) restores a headless spawn's ability to authenticate after the copied credential goes
 *          stale, without which every spawn on the host fails "Not logged in" at $0.
 *      (b) the steady-state read (present, identity-matching, unexpired store) is the path
 *          nearly every call takes, and never touches provisioning at all.
 *      (c) `provisioned`/`reason` in the returned summary, plus the store file's real presence.
 *
 * No candidate fails (c) — none is dropped from this drill.
 *
 * NEVER TOUCHES A LIVE FLEET. Every exercise below runs against fixtures created fresh under
 * `os.tmpdir()` and torn down immediately after: a throwaway git repo pair (never the daemon's
 * real checkout) for the deploy rollback, a throwaway ledger file for the circuit breaker, a
 * throwaway lock file for the stale-lock reclaim, and a throwaway keychain store + a FAKE
 * `security(1)` runner (never the real binary, never the operator's real login keychain) for the
 * worker keychain. `launchctl`/`security`/network calls that would touch the real host are always
 * faked; git and the filesystem, which the fixture itself owns, are always real — "a rollback
 * covered only by tests that inject their own git seam proves the bookkeeping and not the
 * recovery" is this task's own rationale, so the git half here is never mocked.
 *
 * DISCRIMINATES, ON PURPOSE (the falsifier this whole instrument exists to satisfy). Each
 * exercise runs TWICE per path: once against a HEALTHY fixture (the recovery precondition holds
 * and every dependency works) and once against a SABOTAGED one (the precondition holds but a
 * real dependency the recovery needs is broken — a security command failing, a torn ledger read,
 * a staleness judgment answering wrong, no known-good sha ever having been observed). A path only
 * reports PASS when the healthy run reports healthy AND the sabotaged run reports unhealthy. A
 * drill that reported "healthy" regardless of input would be a false clean — worse than no drill,
 * because it reads as coverage that does not exist.
 *
 * LOUD WHEN IT CANNOT RUN. A drill whose fixture setup itself fails (e.g. no `git` on PATH)
 * reports UNREACHABLE, rendered and counted distinctly from a drill that ran and found the path
 * unhealthy — "no output" must never be the success signal, and "ran and failed" must never be
 * confused with "could not even try".
 *
 * NOT A REQUIRED CHECK, AND NOT A PR TRIGGER — see `.github/workflows/recovery-drill.yml`'s own
 * header for the polarity argument (mirrors clock-sweep.yml/mutation-nightly.yml).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reclaimStaleLock } from "../src/lib/fs-race-safe.ts";
import { createDispatchBreakerCache, evaluateDispatchBreaker } from "../src/lib/status.ts";
import { appendLedger } from "../src/lib/ledger.ts";
import { ensureWorkerKeychain, workerKeychainPaths, WorkerKeychainError } from "../src/lib/worker-home.ts";
import { readLastGoodBootSha, runDeployCycle } from "../src/lib/deployer.ts";

/** One exercise's outcome: either it RAN (and is healthy or not), or it could not run at all —
 *  two shapes on purpose, so "ran and failed" is never confused with "could not even try". */
function ran(healthy, detail) {
  return { ran: true, healthy, detail };
}
function unreachable(reason) {
  return { ran: false, reason };
}

/** Make a fresh throwaway directory under the OS tmp root, or report why it could not. Every
 *  exercise below tears its own directory down in a `finally`, so a drill that runs a thousand
 *  times never accumulates fixtures. */
export function withFixtureDir(prefix, body) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), prefix));
  } catch (e) {
    return unreachable(`could not create the fixture directory: ${String(e?.message ?? e)}`);
  }
  try {
    return body(dir);
  } catch (e) {
    return unreachable(`fixture setup or exercise threw unexpectedly: ${String(e?.stack ?? e)}`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; never let a teardown failure mask the exercise's own result */
    }
  }
}

// ── 1. Stale-lock reclaim (fs-race-safe.ts) ─────────────────────────────────────────────────

/**
 * A dead holder's lock, real bytes on a real filesystem. `isStale` is the one seam every real
 * caller (inflight-lock.ts, drain-lock.ts, review.ts, worker-home.ts) supplies for itself,
 * usually backed by a pid-liveness check — SABOTAGED here by making it misjudge a genuinely
 * dead holder as live (the real fault class: pid reuse, or `process.kill` throwing EPERM and
 * being read as "alive"), which is exactly the shape that would leave a crashed holder's lock
 * wedged forever.
 */
export function exerciseStaleLockReclaim(mode) {
  return withFixtureDir("recovery-drill-lock-", (dir) => {
    const lockPath = join(dir, "fixture.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z" }));
    const isStale = mode === "healthy" ? () => true : () => false; // sabotaged: misjudges dead as live
    const result = reclaimStaleLock(lockPath, {
      parseHolder: (raw) => JSON.parse(raw),
      isStale,
    });
    const clearedOnDisk = !existsSync(lockPath); // observable outcome, re-read from the real fs
    const healthy = result.outcome === "reclaimed" && clearedOnDisk;
    return ran(healthy, `outcome=${result.outcome} lock-cleared=${clearedOnDisk}`);
  });
}

// ── 2. Dispatch circuit breaker reset (status.ts) ───────────────────────────────────────────

/**
 * Trip the real breaker with five real `run.start` ledger lines, then record real forward
 * progress (`pr.opened`), all via the real `appendLedger`/`evaluateDispatchBreaker` against a
 * real ledger file on disk — never an in-memory stand-in for the ledger. SABOTAGED by injecting
 * a `ledgerFs` whose read is torn (drops the trailing line) — the exact W1-T206 rotation-
 * truncation class this module's own doc names — so the reset's evidence never reaches the
 * breaker.
 */
export function exerciseCircuitBreakerReset(mode, opts = {}) {
  return withFixtureDir("recovery-drill-breaker-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "RECOVERY-DRILL-TASK";
    for (let i = 0; i < 5; i++) {
      appendLedger(ledgerPath, { run_id: `drill-run-${i}`, task_id: taskId, step: "run.start" });
    }
    const cache = createDispatchBreakerCache();
    // `opts.maxDispatches` defaults to evaluateDispatchBreaker's own DEFAULT_MAX_TASK_DISPATCHES
    // (5) — the five run.start lines above always trip it in real use. A test can override this
    // to exercise the "fixture didn't trip" guard below deterministically, without that guard
    // ever firing in the drill's own real, unopinionated call.
    const trippedVerdict = evaluateDispatchBreaker(ledgerPath, taskId, cache, { maxDispatches: opts.maxDispatches });
    if (trippedVerdict !== "tripped") {
      return unreachable(`fixture did not trip the breaker (got "${trippedVerdict}") — cannot exercise its reset`);
    }
    appendLedger(ledgerPath, {
      run_id: "drill-run-pr",
      task_id: taskId,
      step: "pr.opened",
      pr_url: "https://example.invalid/pull/1",
    });
    const ledgerFs =
      mode === "healthy"
        ? undefined
        : {
            existsSync: (p) => existsSync(p),
            // Torn read: drops the last (non-empty) line — the pr.opened line this reset depends
            // on — simulating a rotation caught mid-write. Real reads (mode "healthy") see it.
            readFileSync: (p, enc) => {
              const lines = readFileSync(p, enc).split("\n").filter((l) => l.length > 0);
              return lines.slice(0, -1).join("\n");
            },
          };
    const verdict = evaluateDispatchBreaker(ledgerPath, taskId, cache, ledgerFs ? { ledgerFs } : {});
    return ran(verdict === "clear", `post-progress verdict=${verdict}`);
  });
}

// ── 3. Deploy rollback (deployer.ts) ────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A throwaway origin + install checkout pair, built with REAL `git` — never the daemon's real
 * checkout, never a mocked git seam. HEALTHY: install is cloned while origin still points at the
 * good commit, a real `daemon.boot` ledger line records that sha as observed-runnable, then
 * origin moves to a bad commit — the ordinary "behind, then unhealthy, then roll back" shape.
 * `runDeployCycle` fast-forwards install with a real `git merge --ff-only`, and its rollback
 * branch restores the good sha with a real `git reset --hard`. SABOTAGED: reproduces the actual
 * 2026-08-05 incident this task's rationale names — install is ALREADY on the bad sha (a second,
 * unlogged writer got there first) and NO boot line for any good sha was ever recorded, so the
 * rollback's anchor (`readLastGoodBootSha`) has nothing to return and falls back to `fromHead` —
 * which is the bad sha itself. `launchctl`/health-polling are always faked (never the real
 * daemon); only the git/fs half — the part that was undertested — is real.
 */
export function exerciseDeployRollback(mode) {
  return withFixtureDir("recovery-drill-deploy-", (dir) => {
    let goodSha, badSha, installDir;
    try {
      const originDir = join(dir, "origin.git");
      const seedDir = join(dir, "seed");
      execFileSync("git", ["init", "--quiet", "--bare", originDir], { stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["init", "--quiet", "-b", "main", seedDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(seedDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(seedDir, ["config", "user.name", "recovery-drill"]);
      git(seedDir, ["remote", "add", "origin", originDir]);
      writeFileSync(join(seedDir, "marker.txt"), "good\n");
      git(seedDir, ["add", "marker.txt"]);
      git(seedDir, ["commit", "--quiet", "-m", "good"]);
      git(seedDir, ["push", "--quiet", "origin", "main"]);
      goodSha = git(seedDir, ["rev-parse", "HEAD"]);
      writeFileSync(join(seedDir, "marker.txt"), "bad\n");
      git(seedDir, ["add", "marker.txt"]);
      git(seedDir, ["commit", "--quiet", "-m", "bad"]);
      git(seedDir, ["push", "--quiet", "origin", "main"]);
      badSha = git(seedDir, ["rev-parse", "HEAD"]);

      installDir = join(dir, "install");
      execFileSync("git", ["clone", "--quiet", "-b", "main", originDir, installDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(installDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(installDir, ["config", "user.name", "recovery-drill"]);
      if (mode === "healthy") {
        git(installDir, ["reset", "--quiet", "--hard", goodSha]); // install starts one commit behind
      }
      // sabotaged: install stays at the clone's tip, badSha — already fast-forwarded, as if a
      // second writer beat this cycle to it (the observed 2026-08-05 shape).
    } catch (e) {
      return unreachable(`git unavailable or fixture init failed: ${String(e?.message ?? e)}`);
    }

    const ledgerPath = join(dir, "ledger.ndjson");
    if (mode === "healthy") {
      appendLedger(ledgerPath, { run_id: "drill", task_id: "DEPLOY", step: "daemon.boot", head_sha: goodSha });
    }
    // sabotaged: no boot line recorded for ANY sha — nothing for the rollback to anchor to.

    const deps = {
      log: () => {},
      now: () => 0,
      fetch: () => git(installDir, ["fetch", "origin", "--quiet"]),
      installHead: () => git(installDir, ["rev-parse", "HEAD"]),
      originMain: () => git(installDir, ["rev-parse", "origin/main"]),
      markerPresent: () => true, // operator-requested deploy — the ordinary trigger, not auto mode
      autoMode: () => false,
      lastFailedHead: () => undefined,
      runningHead: () => undefined, // "unknown" — fail-eager, exactly as an unmigrated daemon reads
      dirtyFiles: () => [],
      incomingFiles: (from, to) =>
        git(installDir, ["diff", "--name-only", `${from}..${to}`])
          .split("\n")
          .filter(Boolean),
      pullFf: () => git(installDir, ["merge", "--ff-only", "--quiet", "origin/main"]),
      resetHard: (ref) => git(installDir, ["reset", "--quiet", "--hard", ref]),
      lastGoodBootSha: (excludeSha) => readLastGoodBootSha(ledgerPath, excludeSha),
      probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
      kickstart: () => {}, // NEVER the real launchctl
      waitBootHealth: () => ({ bootObserved: false, crashCount: 0 }), // force the rollback branch
      alert: () => {},
      clearMarker: () => {},
      kickstartConsole: () => {},
      consolePid: () => undefined,
      waitConsoleUp: () => false,
      alertConsoleOnly: () => {},
    };

    const result = runDeployCycle(deps);
    const headAfter = git(installDir, ["rev-parse", "HEAD"]); // independently re-read, never trusted from the result alone
    if (mode === "healthy") {
      const healthy = result.rolledBackTo !== undefined && headAfter === goodSha;
      return ran(
        healthy,
        `head-after=${headAfter.slice(0, 9)} good=${goodSha.slice(0, 9)} rolledBackTo=${result.rolledBackTo?.slice(0, 9) ?? "none"}`,
      );
    }
    const stillBroken = headAfter === badSha;
    return ran(
      !stillBroken,
      `head-after=${headAfter.slice(0, 9)} bad=${badSha.slice(0, 9)} rolledBackTo=${result.rolledBackTo?.slice(0, 9) ?? "none"}`,
    );
  });
}

// ── 4. Worker keychain re-provision (worker-home.ts) ────────────────────────────────────────

/**
 * A throwaway keychain store under a fixture directory, provisioned through a FAKE `security(1)`
 * runner — never the real binary, never the operator's real login keychain (`loginKeychainPath`
 * points at a path that does not exist). HEALTHY: the fake runner answers every `security` call
 * as a real login keychain read + provision would. SABOTAGED: `add-generic-password` — the step
 * that actually writes the copied credential — throws, exactly as the real command does on a
 * permissions/interaction failure; `ensureWorkerKeychain` must surface that as a named
 * `WorkerKeychainError`, never a silent "provisioned: true".
 */
export function exerciseKeychainReprovision(mode, opts = {}) {
  // `opts.faultStep` names WHICH security(1) call fails in sabotaged mode — defaults to
  // `add-generic-password` (the step that actually writes the copied credential; the drill's
  // own real, unopinionated call). A test can point this at `find-generic-password` instead to
  // exercise the "surfaced, but not the reason class this drill expects" branch below, which the
  // default fault never reaches.
  const faultStep = opts.faultStep ?? "add-generic-password";
  return withFixtureDir("recovery-drill-keychain-", (dir) => {
    const paths = workerKeychainPaths(dir, "drill");
    const fakeAttrs = '    "acct"<blob>="drill-user"\n';
    const fakeSecret = JSON.stringify({ claudeAiOauth: { accessToken: "drill-token", expiresAt: 4102444800000 } });
    const runner = (argv) => {
      if (mode === "sabotaged" && argv[0] === faultStep) {
        // `find-generic-password` failing classifies as a LOCKED login keychain (a different
        // named reason than the default fault's `provision-failed`) — worker-home.ts's own
        // `classifyLoginReadError` keys on this exact phrase. Any other fault step keeps the
        // default `add-generic-password` write-failure wording (-> `provision-failed`).
        throw new Error(
          faultStep === "find-generic-password"
            ? "security: user interaction is not allowed (recovery-drill fixture: simulated locked login keychain)"
            : `security: simulated failure at ${faultStep} (recovery-drill fixture)`,
        );
      }
      if (argv[0] === "find-generic-password") {
        return argv.includes("-w") ? fakeSecret : fakeAttrs;
      }
      if (argv[0] === "create-keychain") {
        writeFileSync(paths.keychainPath, "fixture-keychain-bytes"); // real fs write — the observable outcome
        return "";
      }
      return "";
    };

    let summary;
    let thrown;
    try {
      summary = ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: join(dir, "login.keychain-db"), // never the real login keychain
        runner,
        grantApps: [],
      });
    } catch (e) {
      thrown = e;
    }

    // "healthy" means the SAME thing in both modes, matching every other path in this file: did
    // the recovery actually accomplish its goal (a provisioned, working store) — never "was a
    // failure detected". Under sabotage the goal is genuinely unreachable, so `succeeded` is
    // false there by construction; what the detail line calls out is WHETHER that unreachability
    // was surfaced loudly (a named `WorkerKeychainError`) or silently (any other outcome) —
    // silent would be a second, worse defect layered on top of the sabotage itself.
    const succeeded = !thrown && summary?.provisioned === true && existsSync(paths.keychainPath);
    if (mode === "healthy") {
      return ran(
        succeeded,
        thrown ? `threw unexpectedly: ${String(thrown.message ?? thrown)}` : `provisioned=${summary?.provisioned} reason=${summary?.reason}`,
      );
    }
    const surfacedLoudly = thrown instanceof WorkerKeychainError && thrown.reasonClass === "provision-failed";
    return ran(
      succeeded,
      surfacedLoudly
        ? `correctly threw ${thrown.name}(${thrown.reasonClass}): ${String(thrown.message).slice(0, 100)}`
        : thrown
          ? `threw, but not the expected named class: ${String(thrown)}`
          : `unexpectedly succeeded despite the broken security runner: ${JSON.stringify(summary)}`,
    );
  });
}

// ── The drill orchestrator ──────────────────────────────────────────────────────────────────

export const RECOVERY_PATHS = [
  {
    key: "stale-lock-reclaim",
    label: "stale lock reclaim (fs-race-safe.ts reclaimStaleLock, real fs fixture)",
    exercise: exerciseStaleLockReclaim,
  },
  {
    key: "circuit-breaker-reset",
    label: "dispatch circuit breaker reset (status.ts evaluateDispatchBreaker, real ledger fixture)",
    exercise: exerciseCircuitBreakerReset,
  },
  {
    key: "deploy-rollback",
    label: "deploy rollback (deployer.ts runDeployCycle, real throwaway git fixture)",
    exercise: exerciseDeployRollback,
  },
  {
    key: "keychain-reprovision",
    label: "worker keychain re-provision (worker-home.ts ensureWorkerKeychain, fixture security runner)",
    exercise: exerciseKeychainReprovision,
  },
];

/**
 * Drill every path, twice each (healthy + sabotaged), and classify. A path PASSES only when it
 * both ran healthy-and-reported-healthy AND ran sabotaged-and-reported-unhealthy — anything else
 * (either run couldn't even execute, or the sabotaged run wasn't caught) is NOT a pass. Pure and
 * total over whatever `paths` it is given, so it is directly unit-testable with synthetic
 * exercisers, never only through the four real ones.
 */
export function runDrill(paths = RECOVERY_PATHS) {
  const results = paths.map((p) => {
    const safeRun = (mode) => {
      try {
        return p.exercise(mode);
      } catch (e) {
        return unreachable(`exercise threw: ${String(e?.stack ?? e)}`);
      }
    };
    const healthyRun = safeRun("healthy");
    const sabotagedRun = safeRun("sabotaged");
    const bothRan = healthyRun.ran && sabotagedRun.ran;
    const discriminates = bothRan && healthyRun.healthy === true && sabotagedRun.healthy === false;
    return { key: p.key, label: p.label, healthyRun, sabotagedRun, bothRan, discriminates };
  });
  return { results, ok: results.every((r) => r.discriminates) };
}

/** Render the drill's report — the thing an operator reads months later with no context. */
export function renderReport(outcome, log) {
  log("recovery-drill — per-path health, drilled against a throwaway fixture (healthy + sabotaged)");
  for (const r of outcome.results) {
    log(`\n  ${r.key}`);
    log(`    ${r.label}`);
    if (!r.bothRan) {
      // LOUD AND DISTINCT: never rendered as "FAIL" — a drill that could not run says so, rather
      // than reading as a recovery path that ran and was found broken.
      log(`    UNREACHABLE — this drill could not run`);
      if (!r.healthyRun.ran) log(`      healthy fixture   : ${r.healthyRun.reason}`);
      if (!r.sabotagedRun.ran) log(`      sabotaged fixture : ${r.sabotagedRun.reason}`);
      continue;
    }
    log(`    healthy fixture   : ${r.healthyRun.healthy ? "healthy" : "UNEXPECTEDLY UNHEALTHY"} — ${r.healthyRun.detail}`);
    log(
      `    sabotaged fixture : ${!r.sabotagedRun.healthy ? "caught (reported unhealthy, as expected)" : "NOT CAUGHT — sabotage went undetected"} — ${r.sabotagedRun.detail}`,
    );
    log(`    verdict           : ${r.discriminates ? "PASS" : "FAIL"}`);
  }
  const passing = outcome.results.filter((r) => r.discriminates).length;
  log(`\n${outcome.ok ? "PASS" : "FAIL"} — ${passing}/${outcome.results.length} recovery path(s) drilled and discriminating.`);
}

export function main({ log = console.log } = {}) {
  const outcome = runDrill();
  renderReport(outcome, log);
  return outcome.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
