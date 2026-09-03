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
 * THE POPULATION WIDENED (W1-T938): four RECOVERY paths were never the whole claim — a fleet
 * also survives on its GUARDS, the refusals and degrades that never let a fault become an
 * incident in the first place, and none of those had ever run on a cadence either, only in the
 * incidents that discovered them. So this instrument's honest name is no longer "recovery
 * paths" — it is THE PATHS THAT CARRY A FLEET PAST A FAILURE, recovery and guard alike, and the
 * five entries below join the table on the SAME (a)/(b)/(c) qualification, never a second
 * scheduler or a second drill:
 *
 *   5. SPAWN PREFLIGHT HUSK — worker.ts `resolveClaudeExecutable`'s executability probe (W1-T901).
 *      (a) refuses cleanly, naming the EACCES reason, rather than crashing deep inside the SDK's
 *          own spawn on a `claude` binary that exists but cannot run.
 *      (b) the ordinary success path never probes a candidate that fails to execute at all.
 *      (c) the thrown `ClaudeToolchainBlockedError`'s `searched[].cause.code` — independently
 *          readable from the refusal itself, never re-derived.
 *   6. TORN LEDGER TAIL -> INDETERMINATE — status.ts `evaluateDispatchBreakerDetailed`'s
 *      count-REGRESSION branch (W1-T206), distinct from path 2's reset (see that exerciser's own
 *      doc for why this is not a second copy of the same coverage).
 *      (a) refuses to trust a freshly-computed count that fell with nothing in the ledger to
 *          explain it, rather than reporting a false `"clear"` off a torn read.
 *      (b) the ordinary success path only ever sees a count that holds or grows.
 *      (c) the tri-state `"indeterminate"` verdict, re-derived fresh from a real ledger file torn
 *          on disk mid-line.
 *   7. GITHUB GATEWAY DEGRADE — status.ts `deriveStatus`'s W1-T119 fork: a genuinely failed
 *      GitHub read must say the read could not decide, never a confirmed "no PR".
 *      (a) marks the projection `indeterminate` with a named `unavailableReason`, rather than
 *          silently rendering a gateway outage as ordinary absence.
 *      (b) the ordinary success path never sets `readFailed()`.
 *      (c) `indeterminate`/`unavailableReason`/`source`, read straight off the returned
 *          projection.
 *   8. DIRTY DAEMON TREE PROCEEDS — run-task.ts `serviceFreshnessGate` + self-sync.ts
 *      `checkServiceFreshness` (W1-T255): the opposite of a recovery path, on purpose — the
 *      service must LEDGER `daemon.tree_dirty` and keep running, never refuse.
 *      (a) exists to survive the daemon's own uncommitted runtime exhaust without crash-looping
 *          on every launchd restart (the #707 aftermath).
 *      (b) the ordinary clean-tree success path never writes `daemon.tree_dirty` at all.
 *      (c) the ledger line, independently re-read off disk, plus whether the call returned
 *          (proceeded) or threw (refused).
 *   9. ORPHAN SWEEP SIGKILL — worker-containment.ts `sweepOrphanWorkers` (W1-T117), driven
 *      against a REAL spawned-then-SIGKILLed child, never a mocked process.
 *      (a) terminates a stray survivor of an ended run so it cannot run unbounded past it.
 *      (b) the ordinary success path never reaches an ended run's stray child at all.
 *      (c) the pid's real liveness, independently re-polled with `isPidAlive` — never merely
 *          trusted from the report's own `killed` list.
 *
 * SIGKILL MID-RUN's live/unattended twin (the crash-loop detector reacting to a daemon that
 * itself got killed) is NOT built here — `detectDaemonCrashLoop` is already a pure function over
 * `daemon.boot` timestamps with its own ledger-only wiring proof (test/daemon-crashloop-wiring.
 * test.ts), so a real kill adds no coverage there, and the unattended live version is W1-T147's,
 * not this one's.
 *
 * NEVER TOUCHES A LIVE FLEET. Every exercise below runs against fixtures created fresh under
 * `os.tmpdir()` and torn down immediately after: a throwaway git repo pair (never the daemon's
 * real checkout) for the deploy rollback AND the dirty-tree-proceeds entry, a throwaway ledger
 * file for the circuit breaker AND the torn-ledger entry, a throwaway lock file for the
 * stale-lock reclaim, a throwaway keychain store + a FAKE `security(1)` runner (never the real
 * binary, never the operator's real login keychain) for the worker keychain, a real non-
 * executable husk binary under a throwaway `$HOME` for the spawn preflight, a hand-built fake
 * `GitHub` gateway for the degrade path, and a real throwaway child process (killed with a real
 * `SIGKILL`, never a live daemon worker) for the orphan sweep. `launchctl`/`security`/network
 * calls that would touch the real host are always faked; git, the filesystem, and the process
 * table, which the fixture itself owns, are always real — "a rollback covered only by tests that
 * inject their own git seam proves the bookkeeping and not the recovery" is this task's own
 * rationale, so the git/fs/process half here is never mocked.
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
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reclaimStaleLock } from "../src/lib/fs-race-safe.ts";
import { createDispatchBreakerCache, deriveStatus, evaluateDispatchBreaker } from "../src/lib/status.ts";
import { appendLedger } from "../src/lib/ledger.ts";
import { ensureWorkerKeychain, workerKeychainPaths, WorkerKeychainError } from "../src/lib/worker-home.ts";
import { readLastGoodBootSha, runDeployCycle } from "../src/lib/deployer.ts";
import { ClaudeToolchainBlockedError, createClaudeExecutableCache, resolveClaudeExecutable } from "../src/lib/worker.ts";
import { killProcessGroup, listProcessGroupMembers, sweepOrphanWorkers } from "../src/lib/worker-containment.ts";
import { serviceFreshnessGate } from "../src/run-task.ts";

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
    // W1-T2773: normalize the variable prefix to the reapable RMD_TMP_PREFIX form so the boot
    // sweep in src/lib/tmp.ts's sweepStaleTempDirs can reclaim a dir this drill leaves behind on
    // SIGKILL — the exact defect W1-T2773's lint rule refuses at callsite authoring time.
    const reapablePrefix = prefix.startsWith("rmd-") ? prefix : "rmd-" + prefix;
    dir = mkdtempSync(join(tmpdir(), reapablePrefix));
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

// ── 5. Spawn preflight husk (worker.ts) ─────────────────────────────────────────────────────

/**
 * A real non-executable `claude` husk — the exact shape test/toolchain-refusal-errno.test.ts
 * already builds (a real file, mode 0o644, no exec bit, regardless of umask) — pointed at as the
 * ONLY resolvable candidate via `resolveClaudeExecutable`'s own injectable `locations`/`which`
 * deps (env override and PATH both silenced so the fixture's husk is the sole candidate).
 * `resolveClaudeExecutable`'s real `canExecute` probe is a genuine `execFileSync(path,
 * ["--version"])` spawn (W1-T901): a non-executable file makes the OS itself refuse `execve` with
 * `EACCES`, caught and named. HEALTHY: the real probe names `EACCES` on the thrown
 * `ClaudeToolchainBlockedError`'s `searched[].cause.code`, distinguishing this husk from a binary
 * that runs and crashes. SABOTAGED: `canExecute` swapped for the pre-W1-T901 `catch { return
 * false }` shape — swallows the errno into a bare `false` — so the guard still refuses (the husk
 * genuinely cannot run either way) but the refusal's reason class is lost, rendering a husk and a
 * crasher indistinguishably, exactly the regression W1-T901 was filed to end.
 */
export function exerciseSpawnPreflightHusk(mode, opts = {}) {
  return withFixtureDir("recovery-drill-husk-", (dir) => {
    const huskPath = join(dir, "claude");
    writeFileSync(huskPath, "#!/bin/sh\n# frozen mid-swap launcher, never finished writing\n".repeat(10));
    chmodSync(huskPath, 0o644); // explicit: no exec bit, regardless of umask

    const swallowingCanExecute = (path) => {
      try {
        execFileSync(path, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
        return true;
      } catch {
        return false; // the pre-W1-T901 shape: swallows the errno, loses the reason class
      }
    };

    const deps = {
      env: {},
      home: dir,
      which: () => undefined, // never a real PATH lookup finding an unrelated real claude
      // `opts.locations` is a fault-injection escape hatch (mirrors keychain-reprovision's own
      // `opts.faultStep`) — the real RECOVERY_PATHS call site never passes it, so the drill's own
      // scheduled run always exercises the genuine husk-vs-crasher distinction below. A test uses
      // it to make a candidate's own `resolve` throw a RAW error, proving the "threw, but not the
      // expected ClaudeToolchainBlockedError" branch is reported unhealthy rather than crashing
      // the whole drill — distinct from the husk refusal itself, which always throws the named
      // class.
      locations: opts.locations ?? [{ label: "husk", resolve: () => huskPath }],
      ...(mode === "sabotaged" ? { canExecute: swallowingCanExecute } : {}),
    };

    try {
      resolveClaudeExecutable(createClaudeExecutableCache(), deps);
      return ran(false, "resolveClaudeExecutable unexpectedly succeeded against a non-executable husk");
    } catch (e) {
      if (!(e instanceof ClaudeToolchainBlockedError)) {
        return ran(false, `threw, but not the expected ClaudeToolchainBlockedError: ${String(e)}`);
      }
      const entry = e.searched?.find((s) => s.path === huskPath);
      const namedEACCES = entry?.cause?.code === "EACCES";
      return ran(namedEACCES, `existed=${entry?.existed} ran=${entry?.ran} cause.code=${entry?.cause?.code ?? "none"}`);
    }
  });
}

// ── 6. Torn ledger tail -> indeterminate (status.ts evaluateDispatchBreakerDetailed) ───────

/**
 * W1-T206's count-REGRESSION branch specifically (`evaluateDispatchBreakerDetailed`,
 * status.ts:1540-1543) — checked against duplication with path 2 above (design's own
 * requirement) and found DISTINCT, not a second copy: `exerciseCircuitBreakerReset`'s sabotage
 * only ever drops the ledger's trailing `pr.opened` line, which never lowers `freshCount` below
 * the cache's prior observation (it stays at the same tripped count), so that entry only ever
 * proves "a torn read never falsely clears an already-tripped breaker" — the literal
 * `"indeterminate"` verdict is never produced there. This entry drives the OTHER branch: a real
 * ledger file torn on disk mid-line (a genuine crash-mid-write shape — see ledger.ts's own
 * `appendLedger` doc), whose freshly-computed count REGRESSES below a real prior observation with
 * no `pr.opened` in the fresh read to explain the drop. HEALTHY: the real (default) `ledgerFs`
 * reads the genuinely shorter file and correctly reports `"indeterminate"` — DO NOT ACT, never a
 * false `"clear"`. SABOTAGED: a `ledgerFs` whose read never observed the tear (a stale-reader
 * class fault: it always returns the pre-tear bytes) so the regression the real bytes on disk
 * would show is masked from the evaluator and the count never drops — the read silently missing
 * the torn line, exactly the seam-misjudgment this entry exists to catch.
 */
export function exerciseTornLedgerIndeterminate(mode, opts = {}) {
  // `opts.maxDispatches` defaults to evaluateDispatchBreaker's own DEFAULT_MAX_TASK_DISPATCHES
  // (5) — the seven run.start lines below always trip it in real use. A test can override this
  // to exercise the "fixture didn't first observe a tripped baseline" guard below
  // deterministically, mirroring exerciseCircuitBreakerReset's own opts.maxDispatches escape
  // hatch, without that guard ever firing in the drill's own real, unopinionated call.
  const evalOpts = opts.maxDispatches !== undefined ? { maxDispatches: opts.maxDispatches } : {};
  return withFixtureDir("recovery-drill-ledger-tear-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "RECOVERY-DRILL-TORN-TASK";
    for (let i = 0; i < 7; i++) {
      appendLedger(ledgerPath, { run_id: `drill-torn-${i}`, task_id: taskId, step: "run.start" });
    }
    const cache = createDispatchBreakerCache();
    const baseline = evaluateDispatchBreaker(ledgerPath, taskId, cache, evalOpts);
    if (baseline !== "tripped") {
      return unreachable(`fixture did not first observe a tripped baseline (got "${baseline}") — cannot exercise the regression check`);
    }

    // Tear the ledger's real last line ON DISK — a genuine crash-mid-write shape, never a
    // reimplementation of the guard's own torn-line detection (readLedgerLines' real JSON.parse
    // catch does that work, exactly as it would for a real crash).
    const pristine = readFileSync(ledgerPath, "utf8");
    const lastLine = pristine.split("\n").filter((l) => l.length > 0).at(-1) ?? "";
    const torn = pristine.slice(0, pristine.length - Math.ceil(lastLine.length / 2));
    writeFileSync(ledgerPath, torn);

    const ledgerFs =
      mode === "healthy"
        ? undefined // real fs: sees the genuinely torn tail on disk
        : {
            existsSync: (p) => existsSync(p),
            readFileSync: () => pristine, // sabotaged: a stale reader that never observed the tear
          };
    const verdict = evaluateDispatchBreaker(ledgerPath, taskId, cache, { ...evalOpts, ...(ledgerFs ? { ledgerFs } : {}) });
    return ran(verdict === "indeterminate", `post-tear verdict=${verdict} (want "indeterminate")`);
  });
}

// ── 7. GitHub gateway degrade (status.ts deriveStatus) ──────────────────────────────────────

function fakeGithub(overrides = {}) {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

/**
 * A hand-built `GitHub` gateway (the same fixture idiom test/status-blockers-live.test.ts already
 * uses) fed straight into `deriveStatus` — never a real `gh` call. HEALTHY: the gateway genuinely
 * reports the read failed (`readFailed() => true`, `readFailureReason() => "transport"`, the 500
 * class), and `deriveStatus` must mark the projection `indeterminate` with that NAMED reason
 * rather than resolve it as a confirmed "no PR" (W1-T119). SABOTAGED: the identical underlying
 * outage arrives dressed as success — `readFailed() => false` with every lookup answering empty —
 * so the read never surfaces as failed at all; the fault is the gateway failure "arriving as an
 * empty-but-successful result", exactly the incident shape this guard exists to prevent (an
 * outage silently rendered as "no PR" fact).
 */
export function exerciseGithubGatewayDegrade(mode) {
  return withFixtureDir("recovery-drill-gh-gateway-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson"); // never written — an absent ledger reads fine
    const task = {
      id: "RECOVERY-DRILL-GH",
      title: "recovery drill fixture task",
      repo: "remudero",
      depends_on: [],
      type: "implement",
      risk: "medium",
      verify: "auto",
      status: "queued",
      attempts: 0,
      pr: 999999,
    };

    const github =
      mode === "healthy"
        ? fakeGithub({ readFailed: () => true, readFailureReason: () => "transport" })
        : fakeGithub({ readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null });

    const proj = deriveStatus(task, { ledgerPath, github });
    if (mode === "healthy") {
      const healthy = proj.indeterminate === true && proj.unavailableReason === "transport" && proj.source !== "none";
      return ran(healthy, `indeterminate=${proj.indeterminate} unavailableReason=${proj.unavailableReason} status=${proj.status} source=${proj.source}`);
    }
    // sabotaged: must be caught — a projection that renders the disguised outage as an ordinary,
    // confirmed "no PR" (queued, source none, no indeterminate flag) is exactly the false clean
    // this drill exists to notice.
    const falseClean = proj.indeterminate !== true && proj.status === "queued" && proj.source === "none";
    return ran(!falseClean, `indeterminate=${proj.indeterminate} status=${proj.status} source=${proj.source}`);
  });
}

// ── 8. Dirty daemon tree proceeds (run-task.ts serviceFreshnessGate, self-sync.ts) ──────────

/**
 * A throwaway git checkout, one TRACKED file dirtied (the exact `-uno`-scoped shape
 * `checkServiceFreshness` counts — test/self-sync.test.ts's own fixture idiom), driven through
 * the REAL `serviceFreshnessGate`. This is a GUARD's opposite shape on purpose: the invariant is
 * not "refuse", it is "never refuse" — a service crash-looping on its own uncommitted runtime
 * exhaust was the #707 aftermath (self-sync.ts's own doc). HEALTHY: the real (unoverridden)
 * `checkServiceFreshness` sees the genuine dirt, the gate LEDGERS `daemon.tree_dirty` (re-read
 * off disk, never merely trusted from a non-throw), and — because the call returns rather than
 * throwing — PROCEEDS. SABOTAGED: `checkServiceFreshness` swapped for a fixture that answers the
 * way a regressed predicate would if it "refused" instead of assessing (throws) — a refusal here
 * is exactly the nonzero exit `KeepAlive{SuccessfulExit:false}` turns into a crash loop, and this
 * entry's job is to prove that regression would be caught, not silently pass.
 *
 * SCOPE FENCE: this entry owns ONE tracked-dirt shape exercised on a cadence; it does not rebuild
 * W1-T924/W1-T925/W1-T926's operator-dirt topology/table and never edits
 * scripts/operator-dirt-drill.mjs.
 */
export function exerciseDirtyTreeProceeds(mode) {
  return withFixtureDir("recovery-drill-dirty-tree-", (dir) => {
    let localDir;
    try {
      const originDir = join(dir, "origin.git");
      execFileSync("git", ["init", "--quiet", "--bare", originDir], { stdio: ["ignore", "pipe", "pipe"] });
      const seedDir = join(dir, "seed");
      execFileSync("git", ["init", "--quiet", "-b", "main", seedDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(seedDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(seedDir, ["config", "user.name", "recovery-drill"]);
      git(seedDir, ["remote", "add", "origin", originDir]);
      writeFileSync(join(seedDir, "marker.txt"), "clean\n");
      git(seedDir, ["add", "marker.txt"]);
      git(seedDir, ["commit", "--quiet", "-m", "seed"]);
      git(seedDir, ["push", "--quiet", "origin", "main"]);

      localDir = join(dir, "local");
      execFileSync("git", ["clone", "--quiet", "-b", "main", originDir, localDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(localDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(localDir, ["config", "user.name", "recovery-drill"]);
      // Dirty ONE tracked file — the one shape checkServiceFreshness's `-uno` scan counts.
      writeFileSync(join(localDir, "marker.txt"), "dirtied by recovery-drill fixture\n");
    } catch (e) {
      return unreachable(`git unavailable or fixture init failed: ${String(e?.message ?? e)}`);
    }

    const ledgerPath = join(dir, "ledger.ndjson");
    const cmd = "recovery-drill";
    // `ensureInstallFresh` is a DIFFERENT W1-T151 concern (real npm install freshness) this entry
    // is not about — stubbed out (in BOTH modes) so the fixture stays git-and-fs-only, like every
    // other exercise in this file, and never shells out to a real `npm ci` against a bare fixture
    // checkout with no package.json.
    const deps = {
      ledgerPath,
      ensureInstallFresh: () => false,
      ...(mode === "sabotaged"
        ? {
            checkServiceFreshness: () => {
              throw new Error("simulated predicate refusal (recovery-drill fixture: the seam made to refuse rather than proceed)");
            },
          }
        : {}),
    };
    let thrown;
    try {
      serviceFreshnessGate(
        cmd,
        localDir,
        {}, // never real process.env — an empty env keeps isCiEnv/SELF_SYNC_GUARD_ENV both unset
        deps,
      );
    } catch (e) {
      thrown = e;
    }

    if (mode === "healthy") {
      const lines = existsSync(ledgerPath)
        ? readFileSync(ledgerPath, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l))
        : [];
      const ledgered = lines.some((l) => l.step === "daemon.tree_dirty" && l.task_id === cmd.toUpperCase());
      const healthy = !thrown && ledgered;
      return ran(healthy, thrown ? `unexpectedly refused: ${String(thrown.message ?? thrown)}` : `ledgered=${ledgered}`);
    }
    // sabotaged: the injected refusal MUST be caught (a refused service is the crash-loop shape
    // the daemon's freshness gate exists to avoid producing).
    return ran(!thrown, thrown ? `caught the injected refusal: ${String(thrown.message ?? thrown)}` : "unexpectedly proceeded despite the injected refusal");
  });
}

// ── 9. Orphan sweep SIGKILL (worker-containment.ts sweepOrphanWorkers) ──────────────────────

/**
 * Synchronous poll for a real pid's death — `sweepOrphanWorkers`'s exercisers below never trust
 * the report alone, so this re-checks the OS directly, bounded, never a fixed sleep.
 *
 * Deliberately `listProcessGroupMembers` (a real `ps` scan, ZOMBIE-EXCLUDING per its own doc)
 * rather than `isPidAlive` (`kill(pid, 0)`): `kill(pid, 0)` still succeeds against a zombie —
 * exited, but not yet reaped — and reaping is Node's OWN async SIGCHLD handling, which a
 * SYNCHRONOUS `Atomics.wait` busy-loop starves by construction (this drill's exercise functions
 * are sync, matching the orchestrator's un-awaited `p.exercise(mode)` call). Polling via `ps`
 * sidesteps that deadlock entirely: a zombie already reads as gone.
 */
function awaitProcessGroupGoneSync(pid, timeoutMs = 5000) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (listProcessGroupMembers(pid).length > 0 && Date.now() < deadline) {
    Atomics.wait(buf, 0, 0, 25);
  }
  return listProcessGroupMembers(pid).length === 0;
}

/**
 * A REAL throwaway child process (`sleep 300`, detached so its own pid is its own process-group
 * leader — the shape `killProcessGroup`'s `-pid` signal targets), attributed as belonging to an
 * ENDED run via seeded (never `ps`-scanned) `listCandidates`/`readMarkers` — `ps` output parsing
 * is not this entry's fault surface, real termination is. HEALTHY: the real `killProcessGroup`
 * sends a real `SIGKILL`; the report names the pid killed AND the process group is independently
 * re-polled empty via a real `ps` scan — never merely trusted from the report's own `killed`
 * list. SABOTAGED: `kill` swapped for a no-op — the sweep's attribution logic still runs and
 * still LEDGERS `worker_orphan_killed` as if termination happened, but the real process
 * survives: a false clean, exactly the shape this entry exists to catch (a sweep that reports
 * success without actually ending the stray). The real child is unconditionally reaped in a
 * `finally`, regardless of mode, so a sabotaged run never leaks a live process past this drill.
 */
export function exerciseOrphanSweepSigkill(mode, opts = {}) {
  return withFixtureDir("recovery-drill-orphan-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    // `opts.spawn` is a fault-injection escape hatch (mirrors the husk entry's own
    // `opts.locations`) — the real RECOVERY_PATHS call site never passes it, so the drill's own
    // scheduled run always spawns a genuine throwaway child. A test uses it to make the spawn
    // itself throw, proving the "could not spawn a real throwaway child" UNREACHABLE branch is
    // reported rather than crashing the whole drill.
    const spawnFn = opts.spawn ?? spawn;
    let child;
    try {
      child = spawnFn("/bin/sh", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
    } catch (e) {
      return unreachable(`could not spawn a real throwaway child: ${String(e?.message ?? e)}`);
    }
    const pid = child.pid;
    if (!pid) return unreachable("spawned child reported no pid");
    child.unref();

    try {
      const runId = "recovery-drill-orphan-run";
      const taskId = "RECOVERY-DRILL-ORPHAN";
      const report = sweepOrphanWorkers({
        listCandidates: () => [{ pid, cmdline: "sleep 300 (recovery-drill fixture)" }],
        readMarkers: (p) => (p === pid ? { runId, taskId } : undefined),
        isRunActive: () => false, // the run this pid belongs to has already ended
        kill: mode === "healthy" ? (p) => killProcessGroup(p) : () => {}, // sabotaged: reports killed, never actually signals
        ledger: (line) =>
          appendLedger(ledgerPath, {
            run_id: line.run_id,
            task_id: line.task_id,
            step: "worker_orphan_killed",
            pid: line.pid,
            cmdline: line.cmdline,
          }),
      });

      const reportedKilled = report.killed.some((k) => k.pid === pid);
      const actuallyDead = awaitProcessGroupGoneSync(pid, mode === "healthy" ? 5000 : 500);
      if (mode === "healthy") {
        return ran(reportedKilled && actuallyDead, `reported-killed=${reportedKilled} actually-dead=${actuallyDead}`);
      }
      const falseClean = reportedKilled && !actuallyDead;
      return ran(!falseClean, `reported-killed=${reportedKilled} actually-dead=${actuallyDead}`);
    } finally {
      killProcessGroup(pid); // best-effort real cleanup, regardless of mode or outcome above
    }
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
  {
    key: "spawn-preflight-husk",
    label: "spawn preflight husk (worker.ts resolveClaudeExecutable, real non-executable husk fixture)",
    exercise: exerciseSpawnPreflightHusk,
  },
  {
    key: "torn-ledger-indeterminate",
    label: "torn ledger tail -> indeterminate (status.ts evaluateDispatchBreakerDetailed, real torn ledger fixture)",
    exercise: exerciseTornLedgerIndeterminate,
  },
  {
    key: "github-gateway-degrade",
    label: "GitHub gateway degrade (status.ts deriveStatus, fixture gateway)",
    exercise: exerciseGithubGatewayDegrade,
  },
  {
    key: "dirty-tree-proceeds",
    label: "dirty daemon tree proceeds (run-task.ts serviceFreshnessGate, real throwaway git fixture)",
    exercise: exerciseDirtyTreeProceeds,
  },
  {
    key: "orphan-sweep-sigkill",
    label: "orphan sweep SIGKILL (worker-containment.ts sweepOrphanWorkers, real killed child fixture)",
    exercise: exerciseOrphanSweepSigkill,
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
