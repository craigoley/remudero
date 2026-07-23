/**
 * lib/deployer.ts — the OUT-OF-PROCESS deploy supervisor's decision core.
 *
 * WHY THIS EXISTS. The daemon runs `tsx src/…` loaded once at start and dispatches
 * IN-PROCESS (daemon.ts awaits runTask), so a merged fix on origin/main is INERT
 * until a full restart — and `KeepAlive{SuccessfulExit:false}` makes a clean
 * self-restart impossible. Rather than drag the daemon into self-restart mechanics
 * it handles badly, a SEPARATE launchd job runs this supervisor: it fast-forwards
 * the daemon's own checkout and `launchctl kickstart -k`s the daemon — the exact
 * manual redeploy, automated, with the daemon itself NEVER modified.
 *
 * GOVERNANCE (why the defaults are conservative):
 *  - HUMAN-GATED by default: deploy only when an operator set a marker (`rmd deploy`
 *    → state/DEPLOY_REQUESTED) AND the install is behind origin/main. Craig gates
 *    MERGES today; auto-deploy-on-every-merge would silently collapse that gate, so
 *    it is an explicit opt-in (`auto`) and only ever runs behind the health check.
 *  - IDLE-GATED restart: the restart is the dangerous half (in-process dispatch ⇒ a
 *    mid-task restart SIGKILLs the worker — the #559/#581 orphan class). The pull is
 *    safe anytime; the kickstart runs ONLY at a verified idle gap, re-checked in the
 *    same breath as the kickstart to close the poll race.
 *  - HEALTH-CHECK + ROLLBACK: a bad merge CI didn't catch must degrade to "last-good
 *    daemon running + alert", never a restart-storm. After kickstart the supervisor
 *    confirms a healthy boot; on crash-loop it rolls the checkout back to the prior
 *    HEAD, restores the known-good daemon, and alerts.
 *
 * Every side effect (git, launchctl, process probes, clock, fs) is injected via
 * {@link DeployDeps} so the whole sequence is unit-testable WITHOUT touching the
 * live daemon, and the real kickstart is additionally gated behind `dryRun`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Pure decisions ─────────────────────────────────────────────────────────────

export interface TriggerInputs {
  /** state/DEPLOY_REQUESTED present (an operator asked for a deploy). */
  markerPresent: boolean;
  /** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
  autoMode: boolean;
  /** The install's current HEAD sha. */
  installHead: string;
  /** origin/main's sha after a fetch. */
  originMain: string;
  /** In auto mode only: the last HEAD that failed health-check + rolled back — never
   * auto-retried (a manual marker always retries; the operator asked explicitly). */
  lastFailedHead?: string;
}

export interface Decision {
  deploy: boolean;
  reason: string;
}

/** Deploy IFF a trigger is present AND the install is actually behind origin/main. */
export function decideDeployTrigger(i: TriggerInputs): Decision {
  const behind = i.installHead !== i.originMain;
  const alreadyFailed = i.lastFailedHead !== undefined && i.originMain === i.lastFailedHead;
  if (!behind) return { deploy: false, reason: "up-to-date (install HEAD == origin/main)" };
  if (i.markerPresent) return { deploy: true, reason: "operator marker present + install behind origin/main" };
  if (i.autoMode && alreadyFailed) return { deploy: false, reason: "auto: origin/main already failed health-check + rolled back — not retried" };
  if (i.autoMode) return { deploy: true, reason: "auto mode + install behind origin/main" };
  return { deploy: false, reason: "install behind origin/main but no operator marker (human-gated; run rmd deploy)" };
}

export interface IdleProbe {
  /** Live `claude --output-format` workers (build/review/probe). */
  workers: number;
  /** `*.lock` files under state/inflight/. */
  inflightLocks: number;
  /** `<name>.lock` files beside a run worktree (an active build). */
  worktreeLocks: number;
}

/**
 * The idle gap the manual deploy used: no worker mid-flight, no in-flight task. The
 * persistent drain loop staying alive is EXPECTED (the kickstart restarts it) — what
 * we must never interrupt is a WORKER or a claimed task.
 */
export function daemonIsIdle(p: IdleProbe): boolean {
  return p.workers === 0 && p.inflightLocks === 0 && p.worktreeLocks === 0;
}

export interface TreeFfInputs {
  /** Paths with uncommitted local modifications (git status --porcelain). */
  dirtyFiles: string[];
  /** Paths the incoming fast-forward would change (git diff HEAD..origin/main). */
  incomingFiles: string[];
}

export interface TreeFfResult {
  ok: boolean;
  /** The locally-modified paths the ff would also touch — the conflict. */
  conflicting: string[];
}

/** Fast-forward is safe IFF no locally-modified file is ALSO in the incoming diff.
 * A benign local mod the ff doesn't touch (e.g. DECISIONS.md) is preserved; a modified
 * file the ff wants to change would abort git, so we abort + alert first and NEVER
 * force/reset the operator's checkout. */
export function treeFfSafe(i: TreeFfInputs): TreeFfResult {
  const incoming = new Set(i.incomingFiles);
  const conflicting: string[] = [];
  for (const f of i.dirtyFiles) {
    if (incoming.has(f)) {
      conflicting.push(f);
    }
  }
  const ok = conflicting.length === 0;
  return { ok, conflicting };
}

export interface HealthInputs {
  /** A `daemon.boot` heartbeat was observed AFTER the kickstart instant. */
  bootObserved: boolean;
  /** Distinct non-zero daemon exits seen in the window (KeepAlive restart-storm). */
  crashCount: number;
}

export interface HealthOpts {
  /** Non-zero exits at/above this in the window ⇒ crash-loop. Default 3. */
  crashThreshold?: number;
}

export interface HealthResult {
  healthy: boolean;
  reason: string;
}

/**
 * Count `daemon.boot` ledger lines timestamped strictly after `sinceMs`. Extracted as a
 * standalone, exported, pure-over-the-file function (W1-T244) so a test can assert this
 * reads IDENTICALLY before and after a ledger rotation — the false-negative that rolled
 * back a healthy 7abe870 deploy at 00:19Z (feedback fb-1784769525147-13afc6) was exactly
 * this read silently going to zero because `daemon.boot` wasn't retained across rotation;
 * see `DECISION_RELEVANT_LEDGER_STEPS`'s companion health-window retention in ledger.ts.
 * A raw substring/regex scan, not JSON.parse + `.step ===` — matches this file's own
 * pre-existing read shape, kept unchanged by this extraction. Absent ledger ⇒ 0 boots.
 */
export function countLedgerBootsAfter(ledgerPath: string, sinceMs: number): number {
  let n = 0;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"ts":"([^"]+)"/);
      if (m && Date.parse(m[1]) > sinceMs) n++;
    }
  } catch {
    /* no ledger yet — 0 boots observed */
  }
  return n;
}

/** Healthy IFF a fresh boot was seen AND the daemon did not restart-storm. */
export function assessBootHealth(i: HealthInputs, opts: HealthOpts = {}): HealthResult {
  const threshold = opts.crashThreshold ?? 3;
  if (i.crashCount >= threshold) return { healthy: false, reason: `crash-loop: ${i.crashCount} non-zero exits in the window` };
  if (!i.bootObserved) return { healthy: false, reason: "no daemon.boot heartbeat within the health window" };
  return { healthy: true, reason: "fresh boot observed, no crash-loop" };
}

function short(sha: string): string {
  return sha.slice(0, 9);
}

// ── The orchestrated cycle (all side effects injected) ─────────────────────────

export interface DeployDeps {
  log: (step: string, data?: Record<string, unknown>) => void;
  now: () => number;
  /** git fetch origin (updates remote-tracking refs; never touches the working tree). */
  fetch: () => void;
  installHead: () => string;
  originMain: () => string;
  markerPresent: () => boolean;
  autoMode: () => boolean;
  lastFailedHead: () => string | undefined;
  dirtyFiles: () => string[];
  incomingFiles: (from: string, to: string) => string[];
  /** git pull --ff-only / merge --ff-only origin/main. Throws on a non-ff. */
  pullFf: () => void;
  /** git reset --hard <ref> — rollback only (recovery). */
  resetHard: (ref: string) => void;
  probeIdle: () => IdleProbe;
  /** launchctl kickstart -k the daemon job. */
  kickstart: () => void;
  /** Poll for boot health for the configured window; returns what was observed. */
  waitBootHealth: (sinceMs: number) => HealthInputs;
  /** Record a failure for the operator (state/DEPLOY_FAILED) + the failed HEAD. */
  alert: (message: string, failedHead: string) => void;
  /** Consume the operator marker after a terminal outcome (success or rollback). */
  clearMarker: () => void;
}

export interface DeployOpts {
  /** When true, run the WHOLE sequence but skip the real kickstart (validation). */
  dryRun?: boolean;
  health?: HealthOpts;
}

export interface DeployResult {
  deployed: boolean;
  reason: string;
  fromHead?: string;
  toHead?: string;
  rolledBackTo?: string;
  /** Files pulled but not yet restarted (idle vanished before kickstart) — retry next tick. */
  pulledPendingRestart?: boolean;
}

/**
 * Run ONE supervisor cycle. Safe to call on an interval: it no-ops unless a trigger
 * is present AND the install is behind AND the daemon is idle; it restarts only at a
 * verified idle gap; and it self-heals a bad deploy via rollback. Never throws for a
 * routine no-op — only a genuinely broken injected dep would propagate.
 */
export function runDeployCycle(deps: DeployDeps, opts: DeployOpts = {}): DeployResult {
  deps.fetch();
  const fromHead = deps.installHead();
  const origin = deps.originMain();

  const decision = decideDeployTrigger({
    markerPresent: deps.markerPresent(),
    autoMode: deps.autoMode(),
    installHead: fromHead,
    originMain: origin,
    lastFailedHead: deps.lastFailedHead(),
  });
  if (!decision.deploy) {
    deps.log("deploy.skip", { reason: decision.reason, install: short(fromHead), origin: short(origin) });
    return { deployed: false, reason: decision.reason, fromHead };
  }

  // Clean-tree guard — abort (never force) on a conflicting dirty tree.
  const tree = treeFfSafe({ dirtyFiles: deps.dirtyFiles(), incomingFiles: deps.incomingFiles(fromHead, origin) });
  if (!tree.ok) {
    const msg = `deploy aborted: locally-modified files conflict with the fast-forward: ${tree.conflicting.join(", ")}`;
    deps.log("deploy.abort_dirty_tree", { conflicting: tree.conflicting });
    deps.alert(msg, origin);
    return { deployed: false, reason: "dirty-tree-conflict", fromHead };
  }

  // Idle gate — the pull is safe anytime, but hold if a task is in flight so we don't
  // pull-then-fail-to-restart repeatedly; retry next interval.
  if (!daemonIsIdle(deps.probeIdle())) {
    deps.log("deploy.not_idle", { phase: "pre-pull" });
    return { deployed: false, reason: "not-idle (task in flight) — retry next interval", fromHead };
  }

  deps.pullFf();
  const toHead = deps.installHead();
  deps.log("deploy.pulled", { from: short(fromHead), to: short(toHead) });

  // RE-CHECK idle in the same breath as the kickstart (poll-race mitigation): a task
  // may have dispatched since the pre-pull check. The pull is already on disk but
  // INERT (daemon still on old code), so aborting here is safe — retry the restart
  // next tick.
  if (!daemonIsIdle(deps.probeIdle())) {
    deps.log("deploy.not_idle", { phase: "pre-kickstart", note: "pulled but NOT restarted — inert until a later idle tick" });
    return { deployed: false, reason: "not-idle-at-kickstart — pulled, restart deferred", fromHead, toHead, pulledPendingRestart: true };
  }

  if (opts.dryRun) {
    deps.log("deploy.dry_run", { would_kickstart: true, to: short(toHead) });
    return { deployed: false, reason: "dry-run (pulled; kickstart skipped)", fromHead, toHead };
  }

  const kickstartAt = deps.now();
  deps.kickstart();
  deps.log("deploy.kickstart", { to: short(toHead) });

  const health = assessBootHealth(deps.waitBootHealth(kickstartAt), opts.health);
  if (health.healthy) {
    deps.clearMarker();
    deps.log("deploy.ok", { to: short(toHead), reason: health.reason });
    return { deployed: true, reason: "deployed + healthy", fromHead, toHead };
  }

  // ROLLBACK — restore the known-good HEAD and daemon, alert, never leave a
  // crash-looping daemon live.
  deps.log("deploy.unhealthy_rollback", { failed: short(toHead), reason: health.reason, rolling_back_to: short(fromHead) });
  deps.resetHard(fromHead);
  deps.kickstart();
  deps.alert(`deploy of ${toHead} failed health-check (${health.reason}); rolled back to ${fromHead}`, toHead);
  deps.clearMarker();
  return { deployed: false, reason: `health-check-failed-rolled-back: ${health.reason}`, fromHead, toHead, rolledBackTo: fromHead };
}

// ── Marker + alert file paths (state/) ──────────────────────────────────────────

/** Operator "please deploy at the next idle gap" request (`rmd deploy` writes it). */
export function deployMarkerPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_REQUESTED");
}
/** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
export function deployAutoPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_AUTO");
}
/** Last HEAD that failed health-check + rolled back (auto mode never retries it). */
export function deployLastFailedPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_LAST_FAILED");
}
/** Operator-facing failure alert. */
export function deployFailedAlertPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_FAILED");
}

/** `rmd deploy` — request a deploy at the next idle gap. */
export function requestDeploy(stateRoot: string, reason: string | undefined): void {
  const p = deployMarkerPath(stateRoot);
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(p, JSON.stringify({ reason, requestedAt: new Date().toISOString() }, null, 2));
}

// ── Real, injected side effects ─────────────────────────────────────────────────

export interface RealDeployOpts {
  /** The daemon's git checkout to fast-forward (its install path / repoRoot). */
  installPath: string;
  /** `<config.root>` (holds state/). */
  stateRoot: string;
  /** launchd job label to kickstart (e.g. com.remudero.daemon). */
  daemonLabel: string;
  /** For `launchctl kickstart -k gui/<uid>/<label>`. */
  uid: number;
  ledgerPath: string;
  log: (step: string, data?: Record<string, unknown>) => void;
  /** Health window: total ms to watch the daemon after kickstart (default 45s). */
  healthWindowMs?: number;
  /** Poll pace within the window (default 3s). */
  healthPollMs?: number;
  /** Injected blocking sleep (tests fake it; real = a busy-wait-free sleep). */
  sleep?: (ms: number) => void;
  /** Injected subprocess runner (tests fake it; default = execFileSync, utf8, RAW —
   * callers trim, because `git status --porcelain`'s leading status column is
   * significant). Throws on a non-zero exit, exactly like execFileSync — callers catch
   * where a non-zero exit is expected (e.g. `pgrep` with no matches). */
  execFile?: (cmd: string, args: string[]) => string;
}

/**
 * Wire {@link runDeployCycle}'s side effects to the real world (every subprocess via
 * one injectable `execFile`, every file op via node:fs against `stateRoot`, so the
 * whole adapter is unit-testable without a real daemon/git/launchctl). The one
 * non-obvious bit is health: after kickstart we watch the ledger for `daemon.boot`
 * heartbeats newer than the kickstart instant — exactly ONE means a clean boot;
 * SEVERAL in the window means KeepAlive is restart-storming a broken daemon
 * (crashCount = extra boots). Absent-and-none means it never came up.
 */
export function realDeployDeps(o: RealDeployOpts): DeployDeps {
  const exec = o.execFile ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).toString());
  const git = (args: string[]): string => exec("git", ["-C", o.installPath, ...args]);
  const sleep = o.sleep ?? ((ms: number) => exec("sleep", [String(Math.ceil(ms / 1000))]));
  const windowMs = o.healthWindowMs ?? 45_000;
  const pollMs = o.healthPollMs ?? 3_000;

  const countBootsAfter = (sinceMs: number): number => countLedgerBootsAfter(o.ledgerPath, sinceMs);

  return {
    log: o.log,
    now: () => Date.now(),
    fetch: () => {
      git(["fetch", "origin", "--quiet"]);
    },
    installHead: () => git(["rev-parse", "HEAD"]).trim(),
    originMain: () => git(["rev-parse", "origin/main"]).trim(),
    markerPresent: () => existsSync(deployMarkerPath(o.stateRoot)),
    autoMode: () => existsSync(deployAutoPath(o.stateRoot)),
    lastFailedHead: () => {
      try {
        return readFileSync(deployLastFailedPath(o.stateRoot), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    dirtyFiles: () =>
      git(["status", "--porcelain"])
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    incomingFiles: (from, to) =>
      git(["diff", "--name-only", `${from}..${to}`]).split("\n").map((l) => l.trim()).filter(Boolean),
    pullFf: () => {
      git(["merge", "--ff-only", "origin/main"]);
    },
    resetHard: (ref) => {
      git(["reset", "--hard", ref]);
    },
    probeIdle: () => {
      let workers = 0;
      try {
        workers = exec("pgrep", ["-f", "claude --output-format"]).split("\n").filter(Boolean).length;
      } catch {
        workers = 0; // pgrep exits 1 when there are no matches
      }
      const countLocks = (dir: string): number => {
        try {
          return readdirSync(dir).filter((n) => n.endsWith(".lock")).length;
        } catch {
          return 0;
        }
      };
      return {
        workers,
        inflightLocks: countLocks(join(o.stateRoot, "state", "inflight")),
        worktreeLocks: countLocks(join(o.stateRoot, "worktrees")),
      };
    },
    kickstart: () => {
      exec("launchctl", ["kickstart", "-k", `gui/${o.uid}/${o.daemonLabel}`]);
    },
    waitBootHealth: (sinceMs) => {
      let waited = 0;
      let boots = 0;
      while (waited < windowMs) {
        sleep(pollMs);
        waited += pollMs;
        boots = countBootsAfter(sinceMs);
        // Keep watching for the whole window to catch a restart-storm; a single boot
        // that stays is confirmed only once the window has elapsed with boots === 1.
      }
      return { bootObserved: boots >= 1, crashCount: Math.max(0, boots - 1) };
    },
    alert: (message, failedHead) => {
      mkdirSync(join(o.stateRoot, "state"), { recursive: true });
      writeFileSync(
        deployFailedAlertPath(o.stateRoot),
        JSON.stringify({ message, failedHead, at: new Date().toISOString() }, null, 2),
      );
      writeFileSync(deployLastFailedPath(o.stateRoot), failedHead);
    },
    clearMarker: () => {
      try {
        unlinkSync(deployMarkerPath(o.stateRoot));
      } catch {
        /* already gone */
      }
    },
  };
}
