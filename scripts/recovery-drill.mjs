#!/usr/bin/env node
/**
 * scripts/recovery-drill.mjs — drills the paths that carry this fleet past a failure, on a
 * schedule, against a throwaway fixture, so the first real exercise is not an emergency.
 *
 * Why: only running the code proves a recovery branch has ever executed for real — no static
 * check (unwired-code, proof rules, coverage) can reach that fact (the 2026-08-05 deploy-rollback
 * incident, 0-for-7, fleet down 53 minutes). The nine RECOVERY_PATHS below are four recovery
 * paths plus five guards (W1-T938) that keep a fault from becoming an incident, each qualified by
 * the same test: it exists to survive a failure, the ordinary success path never exercises it,
 * and it has an outcome this drill can observe independently. docs/forensics/recovery-drill.md#the-file-header.
 *
 * Invariant: every exercise runs twice, once healthy and once sabotaged, and PASSES only when
 * the healthy run reports healthy AND the sabotaged run reports unhealthy — a drill that always
 * reports "healthy" is worse than no drill. Falsifier: test/recovery-drill.test.ts.
 *
 * Invariant: a fixture that cannot even be built reports UNREACHABLE, distinct from one that ran
 * and found the path broken — "no output" must never read as success.
 *
 * Fixtures are always throwaway (a fresh git repo, ledger, lock file or keychain store under
 * os.tmpdir(), or a real killed child) and never touch a live fleet, host keychain, or daemon.
 *
 * Not a required check and not a PR trigger — see .github/workflows/recovery-drill.yml.
 */
import { execFileSync, spawn } from "node:child_process";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";
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
    // Why: W1-T2773 — the reapable RMD_TMP_PREFIX form lets tmp.ts's sweepStaleTempDirs reclaim
    // a dir orphaned by SIGKILL. docs/forensics/recovery-drill.md#withfixturedir-reapable-prefix
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
 * Proves a dead holder's lock gets reclaimed, against real bytes on a real filesystem. `isStale`
 * is sabotaged to misjudge a dead holder as live — the real fault class (pid reuse, or
 * `process.kill` throwing EPERM) that would otherwise wedge a crashed holder's lock forever.
 * docs/forensics/recovery-drill.md#exercisestalelockreclaim-fs-race-safets
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
 * Trips the real breaker with real ledger lines, then records real forward progress
 * (`pr.opened`), against a real ledger file on disk — never an in-memory stand-in. SABOTAGED by
 * injecting a `ledgerFs` whose read is torn (drops the trailing line, the W1-T206
 * rotation-truncation class) so the reset's evidence never reaches the breaker.
 * docs/forensics/recovery-drill.md#exercisecircuitbreakerreset-statusts
 */
export function exerciseCircuitBreakerReset(mode, opts = {}) {
  return withFixtureDir("recovery-drill-breaker-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "RECOVERY-DRILL-TASK";
    for (let i = 0; i < 5; i++) {
      appendLedger(ledgerPath, { run_id: `drill-run-${i}`, task_id: taskId, step: "run.start" });
    }
    const cache = createDispatchBreakerCache();
    // `opts.maxDispatches` (real calls never set it): lets a test arm the "fixture didn't trip"
    // guard below on demand. docs/forensics/recovery-drill.md#exercisecircuitbreakerreset-optsmaxdispatches
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
  return gitOrThrow(args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A throwaway origin + install checkout, built with real `git` — never the daemon's real one.
 * HEALTHY: a `daemon.boot` ledger line records the good sha before origin moves to a bad one;
 * `runDeployCycle` fast-forwards then rolls back with `git reset --hard`. SABOTAGED: reproduces
 * the 2026-08-05 incident — install is already on the bad sha with no good boot line recorded.
 * docs/forensics/recovery-drill.md#exercisedeployrollback-deployerts
 */
export function exerciseDeployRollback(mode) {
  return withFixtureDir("recovery-drill-deploy-", (dir) => {
    let goodSha, badSha, installDir;
    try {
      const originDir = join(dir, "origin.git");
      const seedDir = join(dir, "seed");
      gitOrThrow(["init", "--quiet", "--bare", originDir], { stdio: ["ignore", "pipe", "pipe"] });
      gitOrThrow(["init", "--quiet", "-b", "main", seedDir], { stdio: ["ignore", "pipe", "pipe"] });
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
      gitOrThrow(["clone", "--quiet", "-b", "main", originDir, installDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(installDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(installDir, ["config", "user.name", "recovery-drill"]);
      if (mode === "healthy") {
        git(installDir, ["reset", "--quiet", "--hard", goodSha]); // install starts one commit behind
      }
      // sabotaged: install stays at badSha — the observed 2026-08-05 shape.
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
 * A throwaway keychain store, provisioned through a fake `security(1)` runner — never the real
 * binary or the operator's real login keychain. HEALTHY: the fake runner answers as a real
 * provision would. SABOTAGED: `add-generic-password` throws, as the real command does on a
 * permissions failure; `ensureWorkerKeychain` must surface a named `WorkerKeychainError`, never a
 * silent "provisioned: true". docs/forensics/recovery-drill.md#exercisekeychainreprovision-worker-homets
 */
export function exerciseKeychainReprovision(mode, opts = {}) {
  // `opts.faultStep` picks which security(1) call fails (real calls never set it; default
  // `add-generic-password`). docs/forensics/recovery-drill.md#exercisekeychainreprovision-optsfaultstep
  const faultStep = opts.faultStep ?? "add-generic-password";
  return withFixtureDir("recovery-drill-keychain-", (dir) => {
    const paths = workerKeychainPaths(dir, "drill");
    const fakeAttrs = '    "acct"<blob>="drill-user"\n';
    const fakeSecret = JSON.stringify({ claudeAiOauth: { accessToken: "drill-token", expiresAt: 4102444800000 } });
    const runner = (argv) => {
      if (mode === "sabotaged" && argv[0] === faultStep) {
        // `find-generic-password` classifies as a locked login keychain, a different named
        // reason than the default `provision-failed` (worker-home.ts's `classifyLoginReadError`).
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

    // "healthy" means the goal was reached (a provisioned store), never "a failure was detected" —
    // same rule as every other exercise here. docs/forensics/recovery-drill.md#exercisekeychainreprovision-healthy-means-the-goal-was-reached
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
 * A real non-executable `claude` husk (mode 0o644), the sole resolvable candidate. Its `canExecute`
 * probe spawns the file (W1-T901): a non-executable one makes the OS refuse with `EACCES`.
 * HEALTHY: the probe names `EACCES`, distinguishing a husk from a binary that runs and crashes.
 * SABOTAGED: `canExecute` swapped for the pre-W1-T901 shape that swallows the errno into `false`.
 * docs/forensics/recovery-drill.md#exercisespawnpreflighthusk-workerts
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
 * W1-T206's count-REGRESSION branch — distinct from exerciseCircuitBreakerReset above, which
 * never lowers the count below its prior observation. This entry tears a real ledger file on disk
 * mid-line, so the fresh count REGRESSES with nothing to explain the drop. HEALTHY: the real
 * reader reports `"indeterminate"`, never a false `"clear"`. SABOTAGED: a stale reader masks it.
 * docs/forensics/recovery-drill.md#exercisetornledgerindeterminate-statusts-evaluatedispatchbreakerdetailed
 */
export function exerciseTornLedgerIndeterminate(mode, opts = {}) {
  // `opts.maxDispatches` mirrors exerciseCircuitBreakerReset's own escape hatch, for the
  // "fixture didn't first observe a tripped baseline" guard below.
  // docs/forensics/recovery-drill.md#exercisetornledgerindeterminate-optsmaxdispatches
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

    // Tear the ledger's real last line on disk — readLedgerLines' own JSON.parse catch handles it,
    // exactly as it would a real crash.
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
 * A hand-built `GitHub` gateway fed into `deriveStatus` — never a real `gh` call. HEALTHY: the
 * gateway genuinely reports the read failed, and `deriveStatus` must mark the projection
 * `indeterminate` with that named reason rather than a confirmed "no PR" (W1-T119). SABOTAGED:
 * the same outage arrives dressed as an empty success, so the read never surfaces as failed.
 * docs/forensics/recovery-drill.md#exercisegithubgatewaydegrade-statusts-derivestatus
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
    // sabotaged: must be caught — a disguised outage rendered as a confirmed "no PR" is the false
    // clean this drill exists to notice.
    const falseClean = proj.indeterminate !== true && proj.status === "queued" && proj.source === "none";
    return ran(!falseClean, `indeterminate=${proj.indeterminate} status=${proj.status} source=${proj.source}`);
  });
}

// ── 8. Dirty daemon tree proceeds (run-task.ts serviceFreshnessGate, self-sync.ts) ──────────

/**
 * A throwaway checkout, one tracked file dirtied, through the real `serviceFreshnessGate` — whose
 * invariant is the opposite of "refuse" (a crash-looping service was the #707 aftermath). HEALTHY:
 * LEDGERS `daemon.tree_dirty` and PROCEEDS. SABOTAGED: the predicate swapped for one that throws.
 * docs/forensics/recovery-drill.md#exercisedirtytreeproceeds-run-taskts-servicefreshnessgate-self-syncts
 */
export function exerciseDirtyTreeProceeds(mode) {
  return withFixtureDir("recovery-drill-dirty-tree-", (dir) => {
    let localDir;
    try {
      const originDir = join(dir, "origin.git");
      gitOrThrow(["init", "--quiet", "--bare", originDir], { stdio: ["ignore", "pipe", "pipe"] });
      const seedDir = join(dir, "seed");
      gitOrThrow(["init", "--quiet", "-b", "main", seedDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(seedDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(seedDir, ["config", "user.name", "recovery-drill"]);
      git(seedDir, ["remote", "add", "origin", originDir]);
      writeFileSync(join(seedDir, "marker.txt"), "clean\n");
      git(seedDir, ["add", "marker.txt"]);
      git(seedDir, ["commit", "--quiet", "-m", "seed"]);
      git(seedDir, ["push", "--quiet", "origin", "main"]);

      localDir = join(dir, "local");
      gitOrThrow(["clone", "--quiet", "-b", "main", originDir, localDir], { stdio: ["ignore", "pipe", "pipe"] });
      git(localDir, ["config", "user.email", "recovery-drill@example.invalid"]);
      git(localDir, ["config", "user.name", "recovery-drill"]);
      // Dirty ONE tracked file — the one shape checkServiceFreshness's `-uno` scan counts.
      writeFileSync(join(localDir, "marker.txt"), "dirtied by recovery-drill fixture\n");
    } catch (e) {
      return unreachable(`git unavailable or fixture init failed: ${String(e?.message ?? e)}`);
    }

    const ledgerPath = join(dir, "ledger.ndjson");
    const cmd = "recovery-drill";
    // `ensureInstallFresh` is a separate W1-T151 concern, stubbed in both modes so this fixture
    // stays git-and-fs-only. docs/forensics/recovery-drill.md#exercisedirtytreeproceeds-ensureinstallfresh-stubbed
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
    // sabotaged: the injected refusal must be caught — a refused service is the crash-loop shape.
    return ran(!thrown, thrown ? `caught the injected refusal: ${String(thrown.message ?? thrown)}` : "unexpectedly proceeded despite the injected refusal");
  });
}

// ── 9. Orphan sweep SIGKILL (worker-containment.ts sweepOrphanWorkers) ──────────────────────

/**
 * Bounded synchronous poll for a real pid's death, re-checking the OS directly rather than
 * trusting the report alone. Uses `listProcessGroupMembers` (a real `ps` scan) rather than
 * `isPidAlive`/`kill(pid, 0)`, which still succeeds against an unreaped zombie.
 * docs/forensics/recovery-drill.md#awaitprocessgroupgonesync-why-ps-not-killpid-0
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
 * A real throwaway child (`sleep 300`, detached), attributed to an ended run via seeded markers —
 * real termination is this entry's fault surface. HEALTHY: a real `SIGKILL`, re-polled dead.
 * SABOTAGED: `kill` swapped for a no-op — LEDGERS `worker_orphan_killed` but the process survives.
 * docs/forensics/recovery-drill.md#exerciseorphansweepsigkill-worker-containmentts-sweeporphanworkers
 */
export function exerciseOrphanSweepSigkill(mode, opts = {}) {
  return withFixtureDir("recovery-drill-orphan-", (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    // `opts.spawn` mirrors the husk entry's `opts.locations`: real calls never set it; a test uses
    // it to make the spawn itself throw. docs/forensics/recovery-drill.md#exerciseorphansweepsigkill-optsspawn
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
 * Drills every path, twice each (healthy + sabotaged), and classifies. A path PASSES only when
 * the healthy run reports healthy AND the sabotaged run reports unhealthy. Pure and total over
 * whatever `paths` it is given, so it is unit-testable with synthetic exercisers too.
 * docs/forensics/recovery-drill.md#rundrill-the-pass-rule
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

if (isMainModule(import.meta.url)) process.exit(main());
