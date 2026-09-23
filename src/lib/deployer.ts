/**
 * lib/deployer.ts — the OUT-OF-PROCESS deploy supervisor's decision core.
 *
 * The daemon dispatches every task IN-PROCESS and cannot cleanly self-restart, so a
 * separate launchd job runs this supervisor instead: it fast-forwards the daemon's own
 * checkout and kickstarts it — the same manual redeploy, automated, the daemon itself
 * never modified.
 *
 * INVARIANT — HUMAN-GATED BY DEFAULT, EXCEPT A PUBLISHED IMAGE: deploy only when an operator
 * marker is set (`rmd deploy`) AND the install is behind origin/main; auto-deploy-on-every-merge is
 * an explicit opt-in ({@link TriggerInputs.autoMode}). The watchdog tick recycles image drift itself
 * once the new image is published (operator ruling 2026-09-22; state/DEPLOY_IMAGE_MANUAL opts out).
 * INVARIANT — IDLE-GATED RESTART: the pull is safe anytime; the kickstart — the dangerous
 * half, since an in-process restart mid-task SIGKILLs the worker — runs only at a
 * verified idle gap, re-checked immediately before it fires.
 * INVARIANT — HEALTH-CHECK + ROLLBACK: a bad merge degrades to "last-good daemon running
 * + alert", never a restart storm. After kickstart, an unhealthy boot rolls the checkout
 * back to a known-good sha and alerts.
 * INVARIANT — THE RESTART SEAM ADAPTS TO ITS HOST (W1-T3200): the kickstart step selects a
 * {@link RestartBackend} by PROBED capability, never a hard-coded platform string — launchctl on
 * a host that has it, `deploy/recycle-container.sh` on a host that only has docker + the
 * checkout. A host with neither refuses loudly and reports it; see {@link selectRestartBackend}.
 *
 * Every side effect (git, launchctl/recycle-container, process probes, clock, fs) is injected
 * via {@link DeployDeps}, so the whole sequence is unit-testable without a live daemon; the real
 * restart is additionally gated behind `dryRun`.
 */
// Why: the full design rationale and every measured incident this module was built to
// fix — docs/forensics/deployer.md#file-header

import { resolveRepoLayout } from "./repo-layout.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeAtomic } from "./fs-race-safe.js";
import { isAbsolute, join } from "node:path";
import { stopDetail } from "./fleet-control.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import {
  DEPLOY_RESTART_PRESSURE_STEP,
  DEPLOY_RESTART_RATE_CEILING_MS,
  DEPLOY_RESTART_RATE_LIMITED_STEP,
  DEPLOY_RESTART_SCORE_THRESHOLD,
  IMAGE_BAKED_PATHS,
  accumulateDeployRestartPressure,
  judgeDeployWorth,
  resetDeployRestartPressure,
  type DeployRestartPressureState,
  type DeployWorthChange,
  type DeployWorthJudge,
  type RecordedDeployRestartThreshold,
} from "./deploy-judge.js";

// ── Pure decisions ─────────────────────────────────────────────────────────────

export interface TriggerInputs {
  /** state/DEPLOY_REQUESTED present (an operator asked for a deploy). */
  markerPresent: boolean;
  /** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
  autoMode: boolean;
  /** Auto-mode restart pressure, when the deployer has scored the pending mounted-code changes.
   *  Omitted preserves the pre-accumulator behavior for callers that have not wired the scorer. */
  autoRestartPressure?: { restart: boolean; reason: string; total: number; threshold: number };
  /** The install's current HEAD sha. */
  installHead: string;
  /** origin/main's sha after a fetch. */
  originMain: string;
  /** In auto mode only: the last HEAD whose deploy FAILED — never auto-retried (a manual marker
   * always retries; the operator asked explicitly). */
  lastFailedHead?: string;
  /** Why that head failed, so the skip line states the real cause instead of assuming a
   *  health-check (a dirty-tree stall once misread as one — docs/forensics/deployer.md#triggerinputslastfailedkind).
   *  Undefined for records written before this field shipped. */
  lastFailedKind?: DeployFailureKind;
  /** Actual daemon liveness; `undefined` = not observed. Only an explicit `false` can trigger
   *  the liveness restart below — a caller that cannot probe degrades to today's behaviour. */
  daemonAlive?: boolean;
  /** Is a STOP marker set? `undefined` reads as PRESENT (fail-safe) — see
   *  {@link decideDeployTrigger}. A halted fleet must never restart into its own refusal. */
  stopPresent?: boolean;
  /** The sha the DAEMON PROCESS actually booted on, captured at ITS boot — never re-read from
   *  the checkout at comparison time, which always matches (see {@link decideDeployTrigger}).
   *  `undefined` for a daemon that booted before this field shipped. */
  runningHead?: string;
  /** W1-T3240: how many BAKED-PATH commits the running IMAGE predates — see
   *  {@link bakedPathCommitsBehind}. THE FOURTH QUANTITY. `installHead`, `originMain` and
   *  `runningHead` are all read off the bind-mounted checkout, so all three can agree while the
   *  image is months old; on 2026-09-09 they did, and the `core.bare` repair that had merged,
   *  built and published that morning was not running.
   *
   *  `undefined` is UNKNOWN, never zero — the image sha is unreadable exactly when the container
   *  is down, which is the crash-loop case this whole class of fix exists for. Unknown leaves
   *  every decision byte-identical to before this field existed. */
  imageBakedCommitsBehind?: number;
  /** W1-T3245: read as the watchdog's RECYCLE question — image drift only, mount staleness ignored
   *  because the daemon's own freshness restart already owns it. Absent ⇒ today's full reading. */
  imageDriftOnly?: boolean;
  /** W1-T4267: expected-versus-live Docker limits read by the watchdog tick. Undefined is
   *  UNKNOWN (an unreadable inspect or policy), never drift. */
  resourcePolicyDrift?: ResourcePolicyDrift[];
  /** Is the image built for the newest image-input commit published? `undefined` is UNKNOWN,
   *  which never recycles automatically — a recycle before the build lands would pull the old one. */
  imagePublished?: boolean;
  /** The newest commit on origin/main touching {@link IMAGE_BAKED_PATHS}, named in the reason. */
  newestBakedSha?: string;
  /** state/DEPLOY_IMAGE_MANUAL present: the operator put image recycles back behind `rmd deploy`. */
  imageRecycleManual?: boolean;
  /** When the last recorded deploy failure happened; an automatic image recycle waits an hour after one. */
  lastFailedAtMs?: number;
  /** The decision's clock, for the failure back-off above. */
  nowMs?: number;
}

export interface ResourcePolicyDrift {
  field: "Memory" | "MemorySwap" | "CpuShares" | "MemoryReservation";
  expected: number;
  actual: number;
}

const POLICY_FIELD_BY_FLAG = {
  memory: "Memory",
  "memory-swap": "MemorySwap",
  "cpu-shares": "CpuShares",
  "memory-reservation": "MemoryReservation",
} as const;

/** W1-T4267: the policy's `docker run` flags (one per line) against `docker inspect`'s HostConfig
 *  JSON. A flag the policy omits expects Docker's own 0; unparseable JSON or a non-numeric field is
 *  UNKNOWN (`undefined`), never drift. */
export function resourcePolicyDriftFrom(expectedArgs: string, hostConfigJson: string): ResourcePolicyDrift[] | undefined {
  const expected: Record<ResourcePolicyDrift["field"], number> = { Memory: 0, MemorySwap: 0, CpuShares: 0, MemoryReservation: 0 };
  for (const arg of expectedArgs.split("\n")) {
    const m = /^--(memory|memory-swap|cpu-shares|memory-reservation)=(\d+)(m?)$/.exec(arg.trim());
    if (m) expected[POLICY_FIELD_BY_FLAG[m[1] as keyof typeof POLICY_FIELD_BY_FLAG]] = Number(m[2]) * (m[3] ? 1024 * 1024 : 1);
  }
  let hostConfig: Record<string, unknown>;
  try {
    hostConfig = JSON.parse(hostConfigJson) as Record<string, unknown>;
  } catch {
    return undefined; // not a HostConfig at all — UNKNOWN, the same no-storm rule as a failed inspect
  }
  const drift: ResourcePolicyDrift[] = [];
  for (const field of Object.values(POLICY_FIELD_BY_FLAG)) {
    const actual = hostConfig?.[field];
    if (typeof actual !== "number") return undefined;
    if (actual !== expected[field]) drift.push({ field, expected: expected[field], actual });
  }
  return drift;
}

/** An automatic image recycle does not follow a recorded deploy failure sooner than this. */
export const IMAGE_RECYCLE_FAILURE_BACKOFF_MS = 60 * 60_000;

export interface Decision {
  deploy: boolean;
  reason: string;
  /** Set ONLY on the `up-to-date` skip, from data rather than re-derived from `reason` text.
   *  `true` iff the checkout matches origin/main AND liveness was OBSERVED alive — a request
   *  satisfied by that state is safe to consume. Unobserved liveness leaves this `undefined`,
   *  so a dead-or-stopped daemon's marker is never silently discarded; see runDeployCycle's
   *  skip branch. */
  satisfied?: boolean;
  /** W1-T3694 — present when the WATCHDOG TICK (`imageDriftOnly`) observed a stale-running
   *  daemon (its boot sha behind the checkout) and, per W1-T3245's separation of actors,
   *  deliberately did not restart on it. Named here as DATA — not only folded into `reason`'s
   *  prose — so a caller (the ledger row, a future status row) can render it as a standing
   *  blocker naming both shas without re-parsing text. */
  blocker?: StaleRunningDaemonBlocker;
}

/** W1-T3694's own blocker shape — see {@link Decision.blocker}. */
export interface StaleRunningDaemonBlocker {
  kind: "stale_running_daemon";
  /** The sha the DAEMON PROCESS actually booted on — {@link TriggerInputs.runningHead}. */
  runningHead: string;
  /** origin/main's sha at comparison time — the checkout is already current with this; only the
   *  daemon process is not. */
  originMain: string;
  /** Why the tick did not act — names W1-T3245 so a reader is not left to guess. */
  note: string;
}

/** Same commit, tolerating a short-vs-full sha on either side — a format mismatch would read
 *  as STALE and restart the daemon every cycle, so the comparison is explicitly
 *  prefix-tolerant rather than left to luck. */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

/** The BAKED paths — the only files whose change can make a running image stale. Everything else
 *  under `src/`, `test/`, `plan/` and `scripts/` reaches the fleet through the bind mount the
 *  instant it merges, so counting ANY commit here would fire on tens of mounted-source merges a
 *  day and train an operator to ignore the signal. Mirrors `acr-build.yml`'s own `paths:` filter,
 *  which is what decides whether a new image is even built. */
export { IMAGE_BAKED_PATHS };

/** W1-T3732 — the instance registry's BASENAME. Its directory comes from
 *  `resolveRepoLayout(root).stateDir`, never an inline state-directory literal: `repo-layout.test.ts`
 *  ratchets how many non-test src files assume the house layout inline, and one more would be one
 *  more place a repo that overrides its layout silently reads the wrong file.
 *  `recycle-container.sh` resolves the SAME path from its own `${SCRIPT_DIR%/deploy}`, so the
 *  script and its only automated caller cannot disagree about which registry is in force. */
export const DAEMON_INSTANCE_REGISTRY_BASENAME = "daemon-instances.yaml";

/** The registry on a given deploy checkout, resolved through the house layout. */
export function daemonInstanceRegistryPath(installPath: string): string {
  return join(resolveRepoLayout(installPath).stateDir, DAEMON_INSTANCE_REGISTRY_BASENAME);
}

/**
 * W1-T3732 — each declared instance mapped to the `state_dir` the registry records for it.
 *
 * DELIBERATELY NOT A YAML PARSER. It reads the two lines it needs out of the `instances:` block —
 * the instance name and its `state_dir` — exactly as `recycle-container.sh`'s own
 * `read_instance_registry` does with shell. A general parser would accept shapes the script
 * refuses, and the two must agree about what is declared or the supervisor names an instance the
 * script then rejects. Anything it cannot read is simply absent from the map: the caller treats an
 * empty map and an unreadable file identically (see {@link instanceForStateRoot}).
 */
export function daemonInstanceStateDirs(text: string): Map<string, string> {
  return new Map([...daemonInstanceRows(text)].map(([name, row]) => [name, row.stateDir]));
}

/** W1-T3733 — the two fields the deploy path needs from one instance's registry row. */
export interface DaemonInstanceRow {
  stateDir: string;
  /** The container that instance runs, as `docker inspect` reported it when the registry was written. */
  containerName?: string;
  /** The `registry/name:tag` image the instance is recycled onto. */
  image?: string;
}

/** W1-T3733 — every declared instance's `state_dir` AND `container_name`, from one pass. See
 *  {@link daemonInstanceStateDirs} for why this is not a YAML parser. */
export function daemonInstanceRows(text: string): Map<string, DaemonInstanceRow> {
  const out = new Map<string, DaemonInstanceRow>();
  /** Fields seen before this instance's `state_dir`, folded in when that arrives. */
  const partial = new Map<string, Omit<DaemonInstanceRow, "stateDir">>();
  let inInstances = false;
  let current: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (/^instances:\s*$/.test(raw)) {
      inInstances = true;
      continue;
    }
    if (!inInstances) continue;
    // Any further top-level key ends the block — never read a sibling section's fields as an
    // instance's, which is how a hand-rolled reader silently widens.
    if (/^\S/.test(raw)) break;
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(raw);
    if (name) {
      current = name[1];
      continue;
    }
    if (current === undefined) continue;
    // ACCUMULATE BOTH FIELDS REGARDLESS OF ORDER. The live registry writes `container_name` BEFORE
    // `state_dir`, and an earlier draft dropped the container whenever it arrived first — a
    // field-order dependency is exactly the silent widening a hand-rolled reader invites.
    const stateDir = /^ {4}state_dir:\s*(\S+)\s*$/.exec(raw);
    if (stateDir) out.set(current, { ...partial.get(current), ...out.get(current), stateDir: stateDir[1] });
    const container = /^ {4}container_name:\s*(\S+)\s*$/.exec(raw);
    if (container) {
      const row = out.get(current);
      if (row) out.set(current, { ...row, containerName: container[1] });
      else partial.set(current, { ...partial.get(current), containerName: container[1] });
    }
    const image = /^ {4}image:\s*(\S+)\s*$/.exec(raw);
    if (image) {
      const row = out.get(current);
      if (row) out.set(current, { ...row, image: image[1] });
      else partial.set(current, { ...partial.get(current), image: image[1] });
    }
  }
  // A row that never named a `state_dir` is an instance this deployment can never match, so it is
  // dropped rather than carried with an empty directory that could compare equal to something.
  return out;
}

/** Trailing separators are not identity: `/a/b` and `/a/b/` are one directory. */
function normalisedDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/**
 * W1-T3732 — the instance whose recorded `state_dir` IS this deployment's state root.
 *
 * MATCHED ON THE STATE DIRECTORY, NOT THE CONTAINER NAME, and that is the whole safety argument:
 * W1-T3596 exists because the unscoped default recycled core against a state directory that was
 * not core's own. Two instances can be renamed onto one container; they cannot share one state
 * mount. `undefined` on no match AND on an ambiguous one — the caller then invokes the script
 * exactly as it does today, and the registry's refusal stands unchanged.
 */
/**
 * W1-T3733 — the container whose `/etc/rmd-build-sha` this deployment's image drift must be read
 * from. MEASURED 2026-09-17: `IMAGE_SHA_CONTAINER` was the literal `remudero-daemon` at its only
 * call site, so the site and console recycle ticks read CORE's image, saw its 0 baked-path commits
 * behind, and declined — while their own images sat 24 hours and one baked-path commit stale.
 *
 * Resolved through the SAME state-root match `--instance` uses, so one lookup answers both and
 * they cannot disagree about which daemon is being deployed. No match, no recorded
 * `container_name`, or an unreadable registry all fall back to {@link IMAGE_SHA_CONTAINER} — the
 * literal this replaces — so the core deployment is byte-for-byte unchanged and no fault can point
 * the read at nothing.
 */
export function imageShaContainerFor(registryText: string, stateRoot: string): string {
  const name = instanceForStateRoot(registryText, stateRoot);
  return (name !== undefined ? daemonInstanceRows(registryText).get(name)?.containerName : undefined) ?? IMAGE_SHA_CONTAINER;
}

/** The image this deployment's instance is recycled onto, from its registry row. */
export function imageRefFor(registryText: string, stateRoot: string): string | undefined {
  const name = instanceForStateRoot(registryText, stateRoot);
  return name === undefined ? undefined : daemonInstanceRows(registryText).get(name)?.image;
}

export function instanceForStateRoot(registryText: string, stateRoot: string): string | undefined {
  const want = normalisedDir(stateRoot);
  const matches = [...daemonInstanceStateDirs(registryText)].filter(([, dir]) => normalisedDir(dir) === want);
  return matches.length === 1 ? matches[0][0] : undefined;
}

/** Where the image writes its own build sha. The SAME file `scripts/fleet-heartbeat.sh` reads to
 *  publish `image_build_sha` (W1-T496) — one path, so the beat and the deploy trigger can never
 *  disagree about which image is running. */
export const IMAGE_BUILD_SHA_PATH = "/etc/rmd-build-sha";

/** The daemon container the image sha is read out of, matching the heartbeat's own default. */
export const IMAGE_SHA_CONTAINER = "remudero-daemon";

/**
 * W1-T3240 — how many BAKED-PATH commits `origin/main` has that the running image does not.
 *
 * `> 0` means a merged change to a file that only reaches the fleet through an image rebuild is
 * published and not running. MEASURED 2026-09-09: exactly 1, and it was the `core.bare` repair
 * for that morning's 7h32m outage.
 *
 * RETURNS `undefined` FOR UNKNOWN, AND THE CALLER MUST NOT COERCE THAT TO ZERO. The image sha is
 * read via `docker exec <container> cat /etc/rmd-build-sha`, which fails precisely when the
 * container is down — the case this exists for. Unknown must leave the decision unchanged rather
 * than read as "current" (the silence being fixed) or "stale" (a restart storm against a host
 * that may be fine). `scripts/fleet-heartbeat.sh` already models this, recording an
 * `IMAGE_BUILD_SHA_SOURCE` naming why a read failed instead of blanking the field.
 */
export function bakedPathCommitsBehind(
  imageBuildSha: string | undefined,
  runGit: (args: readonly string[]) => string,
): number | undefined {
  const sha = imageBuildSha?.trim();
  if (!sha) return undefined;
  let out: string;
  try {
    out = runGit(["rev-list", "--count", `${sha}..origin/main`, "--", ...IMAGE_BAKED_PATHS]);
  } catch {
    return undefined; // an unknown sha, a shallow clone, no git — UNKNOWN, never zero
  }
  const n = Number.parseInt(String(out).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * W1-T4061 — the ROOT lockfile, deliberately NOT in {@link IMAGE_BAKED_PATHS}: it changed 12
 * times in the 30 days to 2026-09-22, almost all unrelated dependency bumps, so watching the
 * whole file the way IMAGE_BAKED_PATHS does would rebuild and recycle about a dozen times a
 * month for nothing. Only a change to the pinned playwright-core version — the exact field
 * `deploy/Dockerfile` resolves PW_VERSION from (its REQ 15) — is real image drift.
 */
export const ROOT_LOCKFILE_PATH = "package-lock.json";

/** The npm-lockfile key `deploy/Dockerfile` itself reads to pick the image's Chromium build, so
 *  the workflow guard and this drift check can never disagree about which field is authoritative. */
const PLAYWRIGHT_CORE_LOCKFILE_KEY = "node_modules/playwright-core";

/** Pulls the pinned playwright-core version out of a `package-lock.json`'s TEXT. Returns
 *  undefined for anything that does not parse as JSON or does not carry the key — never throws,
 *  so a caller can fail closed ("can't tell" -> "no drift") instead of crashing the trigger. */
export function extractPlaywrightCoreVersion(lockfileText: string): string | undefined {
  try {
    const parsed = JSON.parse(lockfileText) as { packages?: Record<string, { version?: string }> };
    return parsed.packages?.[PLAYWRIGHT_CORE_LOCKFILE_KEY]?.version;
  } catch {
    return undefined; // not parseable JSON — unreadable, never a false "no version present"
  }
}

/**
 * True IFF the pinned playwright-core version differs between two `package-lock.json` texts —
 * the one change in that file W1-T4061 exists to catch. An unparseable or version-less lockfile
 * on EITHER side answers false: fail-closed against building on noise, the same "unknown never
 * reads as stale" rule {@link bakedPathCommitsBehind} keeps for the image sha it takes.
 */
export function playwrightCoreVersionChanged(
  oldLockfileText: string | undefined,
  newLockfileText: string | undefined,
): boolean {
  const oldVersion = oldLockfileText === undefined ? undefined : extractPlaywrightCoreVersion(oldLockfileText);
  const newVersion = newLockfileText === undefined ? undefined : extractPlaywrightCoreVersion(newLockfileText);
  if (oldVersion === undefined || newVersion === undefined) return false;
  return oldVersion !== newVersion;
}

/**
 * W1-T4061 — how many playwright-core VERSION commits the image is behind, read off
 * {@link ROOT_LOCKFILE_PATH} rather than {@link IMAGE_BAKED_PATHS}. Compares the pinned version
 * at the running image's build sha against the version at `origin/main`: a version CHANGE counts
 * as one drift commit, an unrelated edit to the same file (a dependency bump the Playwright
 * pin never moved) counts as zero — so the recycle tick fires for a Playwright bump and for
 * nothing else in that file (the task's own falsifier).
 *
 * UNKNOWN (undefined) when either side cannot be read, never coerced to zero — the same contract
 * {@link bakedPathCommitsBehind} keeps.
 */
export function playwrightCoreVersionCommitsBehind(
  imageBuildSha: string | undefined,
  runGit: (args: readonly string[]) => string,
): number | undefined {
  const sha = imageBuildSha?.trim();
  if (!sha) return undefined;
  let oldLockfile: string;
  let newLockfile: string;
  try {
    oldLockfile = runGit(["show", `${sha}:${ROOT_LOCKFILE_PATH}`]);
    newLockfile = runGit(["show", `origin/main:${ROOT_LOCKFILE_PATH}`]);
  } catch {
    return undefined; // an unknown sha, a shallow clone, no git — UNKNOWN, never zero
  }
  return playwrightCoreVersionChanged(oldLockfile, newLockfile) ? 1 : 0;
}

/**
 * W1-T4061 — the newest `origin/main` commit that actually MOVED the pinned playwright-core
 * version, walking {@link ROOT_LOCKFILE_PATH}'s own history newest-first rather than reading the
 * newest commit that merely TOUCHED the file (which is very often an unrelated bump that never
 * changed the pin, and would misname itself as "the" image input). Mirrors the walk
 * `acr-build.yml`'s own guard step does over the same two fields, so the sha this reports is
 * exactly the sha that workflow tags when it decides to build.
 */
export function newestPlaywrightVersionChangeSha(
  runGit: (args: readonly string[]) => string,
): string | undefined {
  let touchingShas: string[];
  try {
    touchingShas = runGit(["log", "--format=%H", "origin/main", "--", ROOT_LOCKFILE_PATH])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return undefined; // no git answer at all — UNKNOWN, same contract as bakedPathCommitsBehind
  }
  for (const sha of touchingShas) {
    let after: string;
    try {
      after = runGit(["show", `${sha}:${ROOT_LOCKFILE_PATH}`]);
    } catch {
      continue; // an unreadable blob for this commit — skip it, never treat as a change
    }
    let before: string | undefined;
    try {
      before = runGit(["show", `${sha}^:${ROOT_LOCKFILE_PATH}`]);
    } catch {
      before = undefined; // the commit that first added the file
    }
    const addedWithVersion = before === undefined && extractPlaywrightCoreVersion(after) !== undefined;
    if (addedWithVersion || playwrightCoreVersionChanged(before, after)) return sha;
  }
  return undefined;
}

/**
 * Deploy IFF a trigger is present AND the fleet is not already running the checkout's code.
 * Either of two independent reasons suffices: BEHIND (fast-forward + restart) or RUNNING STALE
 * (checkout current, daemon not on it yet — restart only). Comparing the checkout alone used to
 * miss the second case and left a stale daemon running silently, indefinitely (2026-08-01). An
 * UNKNOWN running sha reads as STALE (fail-eager): costs at most one extra restart and
 * self-corrects once that restart records a sha.
 */
// Why: docs/forensics/deployer.md#decidedeploytrigger
export function decideDeployTrigger(i: TriggerInputs): Decision {
  const behind = !sameCommit(i.installHead, i.originMain);
  const runningStale = !sameCommit(i.runningHead, i.installHead);
  // W1-T3240: the fourth quantity. `behind` and `runningStale` are BOTH read off the bind-mounted
  // checkout, so both can read healthy — correctly — while the running image is months old. UNKNOWN
  // (`undefined`) is deliberately NOT stale: an unreadable image sha means the container is down,
  // which is the crash-loop case, and restarting on it would be a storm.
  const imageStale = (i.imageBakedCommitsBehind ?? 0) > 0;
  const resourcePolicyDrift = i.resourcePolicyDrift ?? [];
  // W1-T3245 — TWO DECISIONS, NOT ONE SCORE. `imageDriftOnly` is the WATCHDOG TICK's reading: it
  // asks whether a RECYCLE is due and is deliberately blind to mount-side staleness, because that
  // is a different event with a different cost and it is ALREADY HANDLED — the daemon's own
  // freshness check exits 75 and the entrypoint re-fetches, tens of times a day, in seconds.
  // Having the tick also act on `behind`/`runningStale` would put a second actor on the daemon's
  // own job and race it. The operator's `rmd deploy` keeps today's full reading.
  const restartReasons = i.imageDriftOnly === true ? false : behind || runningStale;
  // W1-T3694 — THE TICK'S OWN BLOCKER. `restartReasons` above DISCARDS `runningStale` whenever
  // `imageDriftOnly` is true; that discard is correct (W1-T3245) but must not be reported as
  // "up-to-date" below, which is what let a stale-running daemon read healthy for over an hour on
  // 2026-09-16. `undefined` `runningHead` still reads STALE (fail-eager, per this function's own
  // header) but there is no sha to name in a blocker, so that case is left to the reason text alone.
  const runningStaleIgnoredByTick = i.imageDriftOnly === true && runningStale;
  const staleDaemonBlocker: StaleRunningDaemonBlocker | undefined =
    runningStaleIgnoredByTick && i.runningHead !== undefined
      ? {
          kind: "stale_running_daemon",
          runningHead: i.runningHead,
          originMain: i.originMain,
          note:
            "the recycle tick does not restart on mount staleness — that is the daemon's own " +
            "freshness check's job (W1-T3245)",
        }
      : undefined;
  const alreadyFailed = i.lastFailedHead !== undefined && i.originMain === i.lastFailedHead;
  // W1-T3245: in the tick's reading the REASON must name the image too. `behind` can be true while
  // the tick is deliberately ignoring it, and reporting "install behind origin/main" for a recycle
  // sends the reader to the checkout — which is exactly the misattribution W1-T3240 fixed.
  const why = i.imageDriftOnly === true
    ? `running image predates ${i.imageBakedCommitsBehind} baked-path commit(s) — a merged change to ` +
      `${IMAGE_BAKED_PATHS.join(" or ")} is published and not running (mount staleness is the daemon's own restart)`
    : behind
    ? "install behind origin/main"
    : runningStale
      ? "daemon running stale code (install is current)"
      : `running image predates ${i.imageBakedCommitsBehind} baked-path commit(s) — a merged change to ` +
        `${IMAGE_BAKED_PATHS.join(" or ")} is published and not running (install and daemon are current)`;

  // Liveness is checked BEFORE the sha short-circuit: a dead daemon's last boot sha still
  // equals the checkout, so that branch alone would report "running it" over a corpse. Restarts
  // on liveness only when no STOP marker is set — unknown counts as SET (fail-safe), since
  // relaunching into a live STOP refusal is a storm this repo has already paid for twice.
  // Why: docs/forensics/deployer.md#decidedeploytrigger-liveness
  const stopUnknownOrSet = i.stopPresent !== false;
  if (i.daemonAlive === false && !stopUnknownOrSet) {
    return { deploy: true, reason: "daemon is not running and no STOP is set — restarting it" };
  }
  if (i.imageDriftOnly === true && resourcePolicyDrift.length > 0) {
    const details = resourcePolicyDrift
      .map(({ field, expected, actual }) => `${field} expected=${expected} actual=${actual}`)
      .join(", ");
    if (stopUnknownOrSet) {
      return { deploy: false, reason: `resource policy drift (${details}), but STOP is set or unknown — no automatic recycle` };
    }
    const recentFailure = i.lastFailedAtMs !== undefined && i.nowMs !== undefined &&
      i.nowMs - i.lastFailedAtMs < IMAGE_RECYCLE_FAILURE_BACKOFF_MS;
    if (recentFailure) {
      return { deploy: false, reason: `resource policy drift (${details}); a deploy failed under an hour ago — the automatic recycle backs off` };
    }
    return { deploy: true, reason: `automatic resource-policy recycle: ${details}` };
  }
  if (!restartReasons && !imageStale) {
    // W1-T3694: the tick computed `runningStale` and is deliberately ignoring it (W1-T3245) —
    // that is NOT "up-to-date", it is a daemon known to be running old code. Name it, and never
    // consume an operator's request over a fleet that is not actually current.
    if (runningStaleIgnoredByTick) {
      return {
        deploy: false,
        reason:
          i.runningHead !== undefined
            ? `daemon running stale code (install HEAD == origin/main; running head ${i.runningHead} ` +
              "predates it) — the recycle tick does not restart on mount staleness, which is the " +
              "daemon's own freshness check's job (W1-T3245)"
            : "daemon running head not recorded (install HEAD == origin/main) — mount staleness " +
              "cannot be ruled out, and the recycle tick does not restart on it either way (W1-T3245)",
        satisfied: undefined,
        ...(staleDaemonBlocker ? { blocker: staleDaemonBlocker } : {}),
      };
    }
    // Claim the daemon is running it only when liveness was actually OBSERVED — an unmeasured
    // quantity is never reported "up-to-date" (W1-T3694): that word is reserved for the one case
    // both the checkout AND the daemon's liveness were actually confirmed.
    return {
      deploy: false,
      reason:
        i.daemonAlive === true
          ? "up-to-date (install HEAD == origin/main, daemon alive and running it)"
          : "daemon liveness not observed (install HEAD == origin/main) — cannot confirm the " +
            "running code is actually current",
      // Only `daemonAlive === true` counts as OBSERVED — `false`/`undefined` both mean "not
      // observed" (see the reason wording above) and must not consume a request out from under a
      // fleet that might not even be running.
      satisfied: i.daemonAlive === true ? true : undefined,
    };
  }
  if (i.markerPresent) return { deploy: true, reason: `operator marker present + ${why}` };
  // IMAGE DRIFT RECYCLES ITSELF (operator ruling 2026-09-22: restarts that big changes need happen
  // automatically). Mounted source already goes live through the daemon's own freshness restart, so
  // the human gate below was holding back only the rarest and most necessary recycle. Still
  // bounded: the watchdog tick only, the new image PUBLISHED, STOP respected (above), an hour's
  // back-off after a failure, the idle gate and health check in runDeployCycle, and an opt-out.
  // DEPLOY_AUTO keeps its own older path below; this is the default fleet's.
  if (i.imageDriftOnly === true && imageStale && !i.autoMode && i.imageRecycleManual !== true) {
    if (stopUnknownOrSet) return { deploy: false, reason: `${why}, but STOP is set or unknown — no automatic recycle` };
    const image = i.newestBakedSha ? `the image for ${i.newestBakedSha.slice(0, 9)}` : "the new image";
    const recentFailure = i.lastFailedAtMs !== undefined && i.nowMs !== undefined &&
      i.nowMs - i.lastFailedAtMs < IMAGE_RECYCLE_FAILURE_BACKOFF_MS;
    if (recentFailure) {
      return { deploy: false, reason: `${why}; a deploy failed under an hour ago — the automatic image recycle backs off` };
    }
    if (i.imagePublished === true) {
      return { deploy: true, reason: `automatic image recycle: ${why}, and ${image} is published` };
    }
    return {
      deploy: false,
      reason: `${why}, but ${image} is ${i.imagePublished === false ? "not published yet" : "of unknown publication"} — waiting for the build`,
    };
  }
  if (i.autoMode && alreadyFailed) {
    return { deploy: false, reason: `auto: origin/main already failed to deploy (${describeFailureKind(i.lastFailedKind)}) — not retried; see state/DEPLOY_FAILED` };
  }
  // Source-change pressure decides MOUNTED staleness; it never vetoes an image the tick found stale.
  if (i.autoMode && i.autoRestartPressure && !(i.imageDriftOnly === true && imageStale)) {
    if (i.autoRestartPressure.restart) {
      return {
        deploy: true,
        reason: `auto mode + ${why}; ${i.autoRestartPressure.reason}`,
      };
    }
    return {
      deploy: false,
      reason: `${why} but ${i.autoRestartPressure.reason}`,
    };
  }
  if (i.autoMode) return { deploy: true, reason: `auto mode + ${why}` };
  return { deploy: false, reason: `${why} but no operator marker (human-gated; run rmd deploy)` };
}

export interface IdleProbe {
  /** Live Claude or Codex workers (build/review/probe). */
  workers: number;
  /** `*.lock` files under state/inflight/. */
  inflightLocks: number;
  /** `<name>.lock` files beside a run worktree (an active build). */
  worktreeLocks: number;
  /** Which of the three probe reads FAILED, named — never folded into the counts above.
   *  This repo's law: "a read failure degrades to UNKNOWN, never to zero" (`buildShellRoute`);
   *  a probe that cannot see the daemon must not report it quiet. Optional — absent means every
   *  read succeeded, so an existing {@link IdleProbe} literal is unaffected. */
  unreadable?: readonly string[];
}

/**
 * The idle gap the manual deploy used: no worker mid-flight, no in-flight task. The
 * persistent drain loop staying alive is EXPECTED (the kickstart restarts it) — what
 * we must never interrupt is a WORKER or a claimed task.
 */
export function daemonIsIdle(p: IdleProbe): boolean {
  // UNKNOWN is not idle: deferring is bounded by DEPLOY_IDLE_DEFER_CEILING_MS, so an
  // unreadable signal can never wedge the fleet — the alternative, an in-place restart, costs a
  // SIGKILLed worker.
  if (p.unreadable !== undefined && p.unreadable.length > 0) return false;
  return p.workers === 0 && p.inflightLocks === 0 && p.worktreeLocks === 0;
}

/** Does this `pgrep` failure mean a TRUE zero (exit 1, no processes matched) rather than a read
 *  that produced no answer — the binary ABSENT (ENOENT/127) or one of pgrep's own fatal exits
 *  (2 = syntax, 3 = fatal)? Those must never be counted as zero workers. */
export function pgrepFailureMeansZero(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 1;
}

/** Does this `readdirSync` failure mean the directory genuinely holds no locks? ENOENT does — a
 *  directory never created holds none. EACCES, ENOTDIR, EIO and EMFILE do not: the directory may
 *  be full of locks nobody could count. */
export function lockReadFailureMeansZero(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

/**
 * W1-T341 — the ceiling on how long the idle gate may defer a deploy. `daemonIsIdle` conjoins
 * GLOBAL fleet counters, so a common quiet window can become arbitrarily rare under enough
 * concurrent lanes; this bounds the wait rather than leaving it unbounded, at 30 minutes —
 * comfortably above a typical single-lane run. A forced deploy SIGKILLs whatever is still
 * running, survivable only because daemon.ts's crash-recovery pass re-dispatches any orphaned
 * run on every boot; this ceiling is correct only BECAUSE that path already exists.
 */
// Why: the sizing argument in full — docs/forensics/deployer.md#deploy_idle_defer_ceiling_ms
export const DEPLOY_IDLE_DEFER_CEILING_MS = 30 * 60_000;

export interface IdleGateResult {
  /** The raw {@link daemonIsIdle} reading this cycle. */
  idle: boolean;
  /** The deploy should proceed now — either genuinely idle, or the ceiling elapsed. */
  proceed: boolean;
  /** `proceed && !idle`: the ceiling fired over a fleet that is still busy. */
  forced: boolean;
  /** ms since this deferral began; 0 when nothing is tracked yet (a fresh deferral, or a
   *  caller that never wired persistence — see {@link DeployDeps.deferredSince}). */
  waitedMs: number;
}

/** {@link daemonIsIdle} with a ceiling: `proceed: true` once idle, or once `waitedMs` reaches
 *  `ceilingMs` (`forced: true`). `deferredSinceMs === undefined` — including an unwired
 *  {@link DeployDeps.deferredSince} — reads as a fresh deferral (`waitedMs = 0`), so an
 *  unwired caller degrades to today's unbounded wait, never a surprise forced deploy. */
export function evaluateIdleGate(
  p: IdleProbe,
  deferredSinceMs: number | undefined,
  nowMs: number,
  ceilingMs: number = DEPLOY_IDLE_DEFER_CEILING_MS,
): IdleGateResult {
  const idle = daemonIsIdle(p);
  const waitedMs = deferredSinceMs === undefined ? 0 : Math.max(0, nowMs - deferredSinceMs);
  if (idle) return { idle: true, proceed: true, forced: false, waitedMs };
  const forced = waitedMs >= ceilingMs;
  return { idle: false, proceed: forced, forced, waitedMs };
}

/**
 * ONE WAY THIS HOST MIGHT RESTART THE DAEMON — launchd's `launchctl kickstart -k` on macOS,
 * `deploy/recycle-container.sh` on the container fleet, or any future mechanism. Declared so
 * {@link selectRestartBackend} can pick between them WITHOUT ever reading `process.platform`
 * (W1-T3200 design (i)): what a host CAN DO decides, not what it calls itself.
 */
export interface RestartBackend {
  /** Stable, human-legible name for logs/alerts (e.g. "launchctl", "recycle-container"). */
  name: string;
  /** Is this backend usable on THIS host, right now? MUST NOT throw — an unusable backend
   *  probes false, it does not except; a throwing probe would wrongly abort selection over
   *  every backend declared after it. */
  probe: () => boolean;
  /** What a restart via this backend would do, in words. Dry-run calls this — NEVER `restart()`
   *  — on every registered backend, so dry-run means "describe, change nothing" identically
   *  whichever backend would have been selected live (design (v)). */
  describe: () => string;
  /** Perform the real restart. A script's own refusal (workers past the wait, a failed pull, an
   *  image-id mismatch) THROWS; the caller reports it verbatim and never retries past it,
   *  suppresses it, or falls back to a different backend or a bare `docker restart`
   *  (design (iii)). */
  restart: () => void;
}

/** The outcome of probing a set of {@link RestartBackend}s: which one (if any) is usable, and
 *  why — so an unsupported host can SAY SO on the surface an operator reads (design (ii))
 *  instead of declining invisibly, which is today's actual defect on a launchctl-less host. */
export interface RestartSelection {
  backend?: RestartBackend;
  reason: string;
}

/**
 * Pick the first backend that PROBES available, in declaration order — CAPABILITY decides,
 * never `process.platform` or any other host label (design (i); the falsifier explicitly refuses
 * a platform-string branch). No usable backend is itself a loud, reported outcome (design (ii)),
 * never a silent no-op: the caller logs/alerts `reason` and the cycle reports it as a refusal
 * rather than pretending nothing needed restarting.
 */
export function selectRestartBackend(backends: readonly RestartBackend[]): RestartSelection {
  for (const backend of backends) {
    if (backend.probe()) return { backend, reason: `${backend.name} probed available` };
  }
  const tried = backends.map((b) => b.name);
  return {
    backend: undefined,
    reason:
      tried.length > 0
        ? `no usable restart backend on this host — probed and unavailable: ${tried.join(", ")}`
        : "no restart backends registered",
  };
}

/** The three ways a deploy can fail and poison the auto-retry — a checkout-state problem the
 *  operator fixes locally, bad code that was rolled back, or a pull that landed with no usable
 *  way to restart onto it — never interchangeable. */
export type DeployFailureKind = "dirty-tree-conflict" | "health-check-rollback" | "restart-refused";

/** Render a recorded failure kind for the skip line. An unrecorded kind is stated as unknown
 *  rather than assumed — assuming is exactly the defect this replaced. */
export function describeFailureKind(kind: DeployFailureKind | undefined): string {
  if (kind === "dirty-tree-conflict") return "dirty-tree conflict — local files block the fast-forward";
  if (kind === "health-check-rollback") return "failed health-check, rolled back";
  if (kind === "restart-refused") return "pulled but not restarted — no usable restart backend, or the backend refused";
  return "reason not recorded";
}

export interface TreeFfInputs {
  /** Paths with uncommitted local modifications (git status --porcelain). */
  dirtyFiles: string[];
  /** Paths the incoming fast-forward would change (git diff HEAD..origin/main). */
  incomingFiles: string[];
  /** True when local `path` is BYTE-IDENTICAL to the incoming blob. Optional: omitted ⇒ nothing
   *  is ever discardable, the pre-existing abort-on-any-overlap behaviour, so an unwired caller
   *  cannot regress. */
  sameAsIncoming?: (path: string) => boolean;
}

export interface TreeFfResult {
  ok: boolean;
  /** The locally-modified paths the ff would also touch AND whose content differs — a real conflict. */
  conflicting: string[];
  /** Paths that overlap the incoming diff but whose local bytes ALREADY EQUAL what the ff would
   *  write — lossless to discard, since the fast-forward reproduces them exactly. */
  discardable: string[];
}

/**
 * Fast-forward is safe IFF no locally-modified file is ALSO in the incoming diff with different
 * content; a genuinely divergent file aborts, never forced or reset. A file that is locally
 * modified but byte-identical to the incoming blob is discardable, never a conflict — this
 * closes a deadlock where the daemon's own exhaust blocked it from pulling the very commit that
 * contained that exhaust, sticking the install for ~2 hours (2026-08-02 —
 * docs/forensics/deployer.md#treeffsafe).
 */
// Why: docs/forensics/deployer.md#treeffsafe
export function treeFfSafe(i: TreeFfInputs): TreeFfResult {
  const incoming = new Set(i.incomingFiles);
  const conflicting: string[] = [];
  const discardable: string[] = [];
  for (const f of i.dirtyFiles) {
    if (!incoming.has(f)) continue;
    if (i.sameAsIncoming?.(f)) discardable.push(f);
    else conflicting.push(f);
  }
  const ok = conflicting.length === 0;
  return { ok, conflicting, discardable };
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

/** Count `daemon.boot` ledger lines timestamped strictly after `sinceMs`. Extracted standalone
 *  (W1-T244) so a test can assert this reads IDENTICALLY across a ledger rotation — a
 *  false negative here once rolled back a healthy deploy by silently reading zero boots
 *  (docs/forensics/deployer.md#countledgerbootsafter). Absent ledger ⇒ 0. */
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

/** The `head_sha` on the MOST RECENT `daemon.boot` line — the sha the running daemon loaded at
 *  its boot. Scans forward and keeps the last hit (the ledger is append-only). `undefined` when
 *  no boot line carries one (a daemon that booted before this field shipped), which
 *  {@link decideDeployTrigger} treats as stale. */
export function readLatestBootSha(ledgerPath: string): string | undefined {
  let sha: string | undefined;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"head_sha":"([0-9a-fA-F]{7,40})"/);
      if (m) sha = m[1];
    }
  } catch {
    /* no ledger yet — nothing recorded */
  }
  return sha;
}

/**
 * The newest `daemon.boot` `head_sha` that is NOT `excludeSha` — the rollback target for
 * {@link runDeployCycle}. NEVER `installHead()`: self-sync.ts can fast-forward the checkout to
 * a broken head before this cycle runs, which is exactly what left seven consecutive rollbacks
 * resetting a broken head onto itself, 53 minutes down (2026-08-05 —
 * docs/forensics/deployer.md#readlastgoodbootsha). A boot line is the strongest evidence a sha
 * is runnable; `excludeSha` guards the failed sha having written one before dying. `undefined`
 * when nothing qualifies — callers MUST fall back to `installHead()`, never treat that as "roll
 * back to nothing". Reads the LIVE ledger only, so a boot older than the 15-minute
 * health-window retention can age out, degrading to `undefined`, never to a worse target.
 */
export function readLastGoodBootSha(ledgerPath: string, excludeSha?: string): string | undefined {
  let sha: string | undefined;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"head_sha":"([0-9a-fA-F]{7,40})"/);
      if (m && !(excludeSha && sameCommit(m[1], excludeSha))) sha = m[1];
    }
  } catch {
    /* no ledger yet — nothing recorded */
  }
  return sha;
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

/** Console-up poll: how many probes, and the gap between them. ~30s total — long enough for a
 *  normal tsx boot, short enough that a 120s supervisor cycle never overlaps itself. */
const CONSOLE_UP_ATTEMPTS = 15;
const CONSOLE_UP_DELAY_MS = 2000;

/** The deploy tick's transient ref-lock retry budget. Keep this separate from the entrypoint's
 * boot budget: the tick is a bounded supervisor attempt, not an indefinite fetch loop. */
const FETCH_LOCK_RETRY_MAX = 3;
const FETCH_LOCK_RETRY_PAUSE_MS = 250;

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
  /** The recorded reason `lastFailedHead` failed, so the skip line can state it. */
  lastFailedKind?: () => DeployFailureKind | undefined;
  /** Is the daemon process alive? Omitted ⇒ liveness is simply not observed (today's behaviour). */
  daemonAlive?: () => boolean | undefined;
  /** Is a STOP marker set? Omitted ⇒ unknown, which the trigger treats as PRESENT (fail-safe). */
  stopPresent?: () => boolean | undefined;
  /** Local bytes at `path` == the blob `ref` would write there. Optional: absent ⇒ no discards. */
  sameAsIncoming?: (path: string, ref: string) => boolean;
  /** Drop a local file proven byte-identical to the incoming blob (checkout if tracked, else rm). */
  discardLocal?: (path: string) => void;
  /** The sha the running daemon recorded at ITS boot; undefined if none has. */
  runningHead: () => string | undefined;
  /** W1-T3240: how many BAKED-PATH commits the running IMAGE predates, via
   *  {@link bakedPathCommitsBehind} over `/etc/rmd-build-sha`. {@link runningHead} above cannot
   *  substitute for it — that one is read off the bind-mounted checkout and is current whenever
   *  the checkout is. OPTIONAL: omitted leaves the decision byte-identical to before image drift
   *  was consulted, which is what every pre-existing test does. `undefined` from a supplied
   *  reader is UNKNOWN (the container is down — the crash-loop case), never "current". */
  imageBakedCommitsBehind?: () => number | undefined;
  /** W1-T4267: compare policy arguments with Docker HostConfig. Undefined means UNKNOWN. */
  resourcePolicyDrift?: () => ResourcePolicyDrift[] | undefined;
  /** The newest origin/main commit touching {@link IMAGE_BAKED_PATHS}. */
  newestBakedSha?: () => string | undefined;
  /** Is an image tagged with that sha published? `undefined` = could not tell. Asked only on drift. */
  imagePublished?: (sha: string) => boolean | undefined;
  /** state/DEPLOY_IMAGE_MANUAL present. */
  imageRecycleManual?: () => boolean;
  /** When the recorded deploy failure happened, from state/DEPLOY_FAILED. */
  lastFailedAtMs?: () => number | undefined;
  dirtyFiles: () => string[];
  incomingFiles: (from: string, to: string) => string[];
  /** Each merged change whose daemon impact can contribute restart pressure. Optional only for
   *  backwards-compatible tests/callers; realDeployDeps wires it. */
  pendingChanges?: (from: string, to: string) => DeployWorthChange[];
  /** Persisted accumulator for scored-but-not-yet-restarted merged changes. */
  restartPressureState?: () => DeployRestartPressureState;
  /** Store the accumulator after scoring, and reset it after a completed restart. */
  setRestartPressureState?: (state: DeployRestartPressureState) => void;
  /** Optional uplift judge. Omitted means deterministic path scoring only. */
  restartWorthJudge?: DeployWorthJudge;
  /** Recorded, tunable threshold with its rationale. */
  restartScoreThreshold?: () => RecordedDeployRestartThreshold;
  /** Hard ceiling on restart frequency, distinct from the score threshold. */
  restartRateCeilingMs?: () => number;
  /** git pull --ff-only / merge --ff-only origin/main. Throws on a non-ff. */
  pullFf: () => void;
  /** git reset --hard <ref> — rollback only (recovery). */
  resetHard: (ref: string) => void;
  /** The newest sha the daemon is OBSERVED to have booted on, excluding `excludeSha` — the
   *  rollback target (wired to {@link readLastGoodBootSha}). Optional: omitted ⇒ the rollback
   *  falls back to `installHead()`, the previous behaviour, never to no rollback at all. */
  lastGoodBootSha?: (excludeSha: string) => string | undefined;
  probeIdle: () => IdleProbe;
  /** launchctl kickstart -k the daemon job. RETAINED as the fallback backend when
   *  `restartBackends` below is omitted, and for direct callers/tests that already exercise it. */
  kickstart: () => void;
  /** OPTIONAL — the restart backends usable on THIS host, tried in probe order (see
   *  {@link RestartBackend}, {@link selectRestartBackend}; W1-T3200). Omitted ⇒ a single
   *  fallback backend wrapping `kickstart` above, unconditionally "available" — today's
   *  launchctl-only behaviour, unchanged. Scoped to the DAEMON restart only: the console
   *  kickstart below is a separate concern this task leaves untouched. */
  restartBackends?: () => readonly RestartBackend[];
  /** Poll for boot health for the configured window; returns what was observed. */
  waitBootHealth: (sinceMs: number) => HealthInputs;
  /** Record a failure for the operator (state/DEPLOY_FAILED) + the failed HEAD. */
  alert: (message: string, failedHead: string, kind: DeployFailureKind) => void;
  /** Consume the operator marker after a terminal outcome (success or rollback). */
  clearMarker: () => void;

  // ── DEFERRAL CEILING (W1-T341) ── each cycle is a fresh launchd one-shot with no in-memory
  // continuity, so the idle-gate wait needs its own persisted clock. All three OPTIONAL: an
  // omitting caller degrades to `waitedMs` always 0 (see {@link evaluateIdleGate}) — today's
  // unbounded wait, never a surprise forced deploy.
  /** When this deploy attempt's deferral began, or `undefined` if none is tracked. */
  deferredSince?: () => number | undefined;
  /** Record the start of a new deferral (only called when none is tracked yet). */
  setDeferredSince?: (ms: number) => void;
  /** Clear the deferral clock once it stops applying (no trigger, a conflict abort, or the
   *  idle gate — genuinely or by ceiling — let the deploy proceed). */
  clearDeferredSince?: () => void;

  // ── CONSOLE RESTART ── `rmd serve` loads its code once via tsx, so the running console
  // keeps executing whatever was on disk when it last started until something restarts it —
  // it once served stale code through two days of merges before an operator noticed
  // (impl-BW/impl-BX — docs/forensics/deployer.md#deploydeps--the-console-restart-fields).
  /** launchctl kickstart -k the CONSOLE job (same mechanism as `kickstart`, serve label). */
  kickstartConsole: () => void;
  /** The console job's current pid, for before/after evidence in the ledger. */
  consolePid: () => number | undefined;
  /** Poll the configured port for a listener; true once the console is serving again. A
   *  socket-listen probe needs no service token (impl-BZ rejected an authenticated check). */
  waitConsoleUp: () => boolean;
  /** Operator-visible alert that does NOT write the failed-HEAD marker — deliberately separate
   *  from {@link DeployDeps.alert}, which also poisons auto-retry. A console that fails to come
   *  back must never freeze the pipeline for a sha the DAEMON deployed healthily. */
  alertConsoleOnly: (message: string) => void;
}

export interface DeployOpts {
  /** When true, run the WHOLE sequence but skip the real kickstart (validation). */
  dryRun?: boolean;
  /** W1-T3245: the watchdog tick's RECYCLE-only reading — see {@link TriggerInputs.imageDriftOnly}. */
  imageDriftOnly?: boolean;
  health?: HealthOpts;
  /** Override {@link DEPLOY_IDLE_DEFER_CEILING_MS} (tests only; production always uses the
   *  named default). */
  idleDeferCeilingMs?: number;
}

export interface DeployResult {
  deployed: boolean;
  reason: string;
  fromHead?: string;
  toHead?: string;
  rolledBackTo?: string;
  /** Files pulled but not yet restarted (idle vanished before kickstart) — retry next tick. */
  pulledPendingRestart?: boolean;
  /** The console was kickstarted this cycle (only ever after the daemon verified healthy). */
  consoleRestarted?: boolean;
  /** The console returned to listening within its window. `false` = loud failure, NOT a rollback. */
  consoleHealthy?: boolean;
  /** W1-T3694 — carried through unchanged from {@link Decision.blocker} on a skip, so a caller
   *  (the ledger row, `rmd deploy-run`'s own stdout) can render the standing state without
   *  re-parsing `reason`'s prose. */
  blocker?: StaleRunningDaemonBlocker;
}

/**
 * Restart the console AFTER a deploy is verified healthy — ordering is the whole safety
 * argument: `assessBootHealth` never calls a deploy healthy before `daemon.boot` fires, and
 * that heartbeat only follows a finished install, so `node_modules` can't be mid-install under
 * a running service (a past crash-loop class) and a console can't be left on soon-to-be-rolled-
 * back code. A CONSOLE FAILURE NEVER ROLLS BACK MAIN — the daemon is already healthy on the new
 * code — so the operator gets NOISE instead: a loud alert that skips the failed-HEAD marker
 * (see {@link DeployDeps.alertConsoleOnly}).
 */
// Why: docs/forensics/deployer.md#restartconsole
export function restartConsole(deps: DeployDeps, toHead: string): { restarted: boolean; healthy: boolean } {
  const oldPid = deps.consolePid();
  deps.kickstartConsole();
  deps.log("deploy.console_kickstart", { to: short(toHead), old_pid: oldPid ?? null });

  if (deps.waitConsoleUp()) {
    const newPid = deps.consolePid();
    deps.log("deploy.console_ok", {
      to: short(toHead),
      old_pid: oldPid ?? null,
      new_pid: newPid ?? null,
      listening: true,
    });
    return { restarted: true, healthy: true };
  }

  const msg =
    `console did not return to listening after the deploy of ${short(toHead)} — the daemon is ` +
    `healthy on this sha and was NOT rolled back. launchd (KeepAlive) keeps retrying; if it stays ` +
    `down, check the serve log and kickstart it by hand.`;
  deps.log("deploy.console_unhealthy", { to: short(toHead), old_pid: oldPid ?? null, listening: false, rolled_back: false });
  deps.alertConsoleOnly(msg);
  return { restarted: true, healthy: false };
}

/** Run ONE supervisor cycle. No-ops unless a trigger fires AND the daemon is idle; restarts
 *  only at a verified idle gap; self-heals a bad deploy via rollback. Never throws on a
 *  routine no-op. */
export function runDeployCycle(deps: DeployDeps, opts: DeployOpts = {}): DeployResult {
  deps.fetch();
  const fromHead = deps.installHead();
  const origin = deps.originMain();
  const ceilingMs = opts.idleDeferCeilingMs ?? DEPLOY_IDLE_DEFER_CEILING_MS;

  const markerWasPresent = deps.markerPresent();
  const autoMode = deps.autoMode();
  const lastFailedHead = deps.lastFailedHead();
  const runningHead = deps.runningHead();
  let autoRestartPressure: TriggerInputs["autoRestartPressure"];
  const mountedStale = !sameCommit(fromHead, origin) || !sameCommit(runningHead, fromHead);
  const alreadyFailed = lastFailedHead !== undefined && origin === lastFailedHead;
  if (
    !markerWasPresent &&
    autoMode &&
    !alreadyFailed &&
    mountedStale &&
    deps.pendingChanges &&
    deps.restartPressureState &&
    deps.setRestartPressureState
  ) {
    const pressureNow = deps.now();
    try {
      const scoreFrom = runningHead && !sameCommit(runningHead, fromHead) ? runningHead : fromHead;
      const pressure = accumulateDeployRestartPressure(
        deps.pendingChanges(scoreFrom, origin),
        deps.restartPressureState(),
        {
          threshold: deps.restartScoreThreshold?.() ?? DEPLOY_RESTART_SCORE_THRESHOLD,
          nowMs: pressureNow,
          rateCeilingMs: deps.restartRateCeilingMs?.() ?? DEPLOY_RESTART_RATE_CEILING_MS,
          scoreChange: (change) => judgeDeployWorth(change, { judge: deps.restartWorthJudge }),
        },
      );
      for (const row of pressure.scoreRows) {
        const { step: _step, ...data } = row;
        deps.log(row.step, data);
      }
      deps.log(pressure.rateLimited ? DEPLOY_RESTART_RATE_LIMITED_STEP : DEPLOY_RESTART_PRESSURE_STEP, {
        decision: pressure.decision,
        reason: pressure.reason,
        total: pressure.total,
        threshold: pressure.threshold,
        threshold_reason: pressure.thresholdReason,
        scored_changes: pressure.scoreRows.length,
      });
      deps.setRestartPressureState(pressure.state);
      autoRestartPressure = {
        restart: pressure.wantRestart,
        reason: pressure.reason,
        total: pressure.total,
        threshold: pressure.threshold,
      };
    } catch (err) {
      const reason =
        `pending deploy changes unreadable (${err instanceof Error ? err.message : String(err)}) — ` +
        "failing closed to no automatic restart";
      deps.log(DEPLOY_RESTART_PRESSURE_STEP, {
        decision: "defer",
        reason,
        total: deps.restartPressureState().total,
        threshold: (deps.restartScoreThreshold?.() ?? DEPLOY_RESTART_SCORE_THRESHOLD).value,
        judge_failed: true,
      });
      autoRestartPressure = {
        restart: false,
        reason,
        total: deps.restartPressureState().total,
        threshold: (deps.restartScoreThreshold?.() ?? DEPLOY_RESTART_SCORE_THRESHOLD).value,
      };
    }
  }
  const imageBakedCommitsBehind = deps.imageBakedCommitsBehind?.();
  const resourcePolicyDrift = opts.imageDriftOnly === true ? deps.resourcePolicyDrift?.() : undefined;
  const imageDrift = opts.imageDriftOnly === true && (imageBakedCommitsBehind ?? 0) > 0;
  const newestBakedSha = imageDrift ? deps.newestBakedSha?.() : undefined;
  const decision = decideDeployTrigger({
    markerPresent: markerWasPresent,
    autoMode,
    autoRestartPressure,
    installHead: fromHead,
    originMain: origin,
    lastFailedHead,
    lastFailedKind: deps.lastFailedKind?.(),
    daemonAlive: deps.daemonAlive?.(),
    stopPresent: deps.stopPresent?.(),
    runningHead,
    // PRODUCER AND CONSUMER TOGETHER. A field the decision reads and nothing supplies is the
    // #1066 shape this repo has paid for eleven times; `imageBuildSha` omitted yields `undefined`
    // here, which reads UNKNOWN and changes nothing.
    imageBakedCommitsBehind,
    resourcePolicyDrift,
    imageDriftOnly: opts.imageDriftOnly,
    ...(newestBakedSha ? { newestBakedSha, imagePublished: deps.imagePublished?.(newestBakedSha) } : {}),
    imageRecycleManual: deps.imageRecycleManual?.(),
    lastFailedAtMs: deps.lastFailedAtMs?.(),
    nowMs: deps.now(),
  });
  if (!decision.deploy) {
    deps.clearDeferredSince?.(); // nothing being deferred — no active deploy attempt
    // W1-T1239: the `up-to-date` skip is the one outcome no later tick revisits, so a request it
    // satisfies must be CONSUMED here or it strands as a level trigger that pre-authorises the
    // next deploy. Gated on `decision.satisfied` — DATA from decideDeployTrigger — rather than
    // re-derived by matching `reason` text.
    const request: "consumed" | "retained" | "none" = !markerWasPresent
      ? "none"
      : decision.satisfied
        ? "consumed"
        : "retained";
    if (request === "consumed") deps.clearMarker();
    // W1-T3694: the blocker rides the SAME skip row as `reason` — a stale-running daemon is
    // legible off this one line, naming both shas, rather than requiring a second read.
    deps.log("deploy.skip", {
      reason: decision.reason,
      install: short(fromHead),
      origin: short(origin),
      request,
      ...(decision.blocker ? { blocker: decision.blocker } : {}),
    });
    return { deployed: false, reason: decision.reason, fromHead, ...(decision.blocker ? { blocker: decision.blocker } : {}) };
  }

  // Clean-tree guard — abort (never force) on a conflicting dirty tree.
  const tree = treeFfSafe({
    dirtyFiles: deps.dirtyFiles(),
    incomingFiles: deps.incomingFiles(fromHead, origin),
    sameAsIncoming: deps.sameAsIncoming ? (p) => deps.sameAsIncoming!(p, origin) : undefined,
  });
  if (!tree.ok) {
    deps.clearDeferredSince?.(); // blocked by the tree, not the idle gate — a distinct condition
    const msg = `deploy aborted: locally-modified files conflict with the fast-forward: ${tree.conflicting.join(", ")}`;
    deps.log("deploy.abort_dirty_tree", { conflicting: tree.conflicting });
    deps.alert(msg, origin, "dirty-tree-conflict");
    return { deployed: false, reason: "dirty-tree-conflict", fromHead };
  }
  // Lossless unblock: these overlap the incoming diff but already hold exactly the bytes the ff
  // would write (see treeFfSafe). Logged by name so a silent discard is never mistaken for the
  // force-reset this deliberately is not.
  if (tree.discardable.length > 0 && deps.discardLocal) {
    for (const f of tree.discardable) deps.discardLocal(f);
    deps.log("deploy.discarded_identical", { paths: tree.discardable, count: tree.discardable.length });
  }

  // Idle gate, WITH A DEFERRAL CEILING (W1-T341): the pull is safe anytime, but hold if a task
  // is in flight — unless the deferral has outlasted `ceilingMs`, in which case proceed anyway
  // rather than defer indefinitely (see evaluateIdleGate).
  const probe1 = deps.probeIdle();
  const deferredSince1 = deps.deferredSince?.();
  const nowMs1 = deps.now();
  const gate1 = evaluateIdleGate(probe1, deferredSince1, nowMs1, ceilingMs);
  const gate1Fields = {
    waited_ms: gate1.waitedMs,
    ceiling_ms: ceilingMs,
    workers: probe1.workers,
    inflight_locks: probe1.inflightLocks,
    worktree_locks: probe1.worktreeLocks,
    unreadable: probe1.unreadable,
  };
  if (!gate1.proceed) {
    if (deferredSince1 === undefined) deps.setDeferredSince?.(nowMs1); // start the clock, once
    deps.log("deploy.not_idle", { phase: "pre-pull", ...gate1Fields });
    return { deployed: false, reason: "not-idle (task in flight) — retry next interval", fromHead };
  }
  if (gate1.forced) {
    // Not a quiet fleet — the ceiling fired. The kickstart below will SIGKILL any in-flight
    // worker; see DEPLOY_IDLE_DEFER_CEILING_MS's doc for why that is survivable.
    deps.log("deploy.idle_ceiling_forced", { phase: "pre-pull", ...gate1Fields });
  }

  deps.pullFf();
  const toHead = deps.installHead();
  deps.log("deploy.pulled", { from: short(fromHead), to: short(toHead) });

  // RE-CHECK idle in the same breath as the kickstart (poll-race mitigation): a task may have
  // dispatched since the pre-pull check. The pull is already on disk but INERT, so aborting
  // here is safe — retry next tick, on the same persisted clock.
  const probe2 = deps.probeIdle();
  const deferredSince2 = deps.deferredSince?.();
  const nowMs2 = deps.now();
  const gate2 = evaluateIdleGate(probe2, deferredSince2, nowMs2, ceilingMs);
  const gate2Fields = {
    waited_ms: gate2.waitedMs,
    ceiling_ms: ceilingMs,
    workers: probe2.workers,
    inflight_locks: probe2.inflightLocks,
    worktree_locks: probe2.worktreeLocks,
    unreadable: probe2.unreadable,
  };
  if (!gate2.proceed) {
    if (deferredSince2 === undefined) deps.setDeferredSince?.(nowMs2); // start the clock, once
    deps.log("deploy.not_idle", {
      phase: "pre-kickstart",
      note: "pulled but NOT restarted — inert until a later idle tick",
      ...gate2Fields,
    });
    return { deployed: false, reason: "not-idle-at-kickstart — pulled, restart deferred", fromHead, toHead, pulledPendingRestart: true };
  }
  if (gate2.forced) {
    deps.log("deploy.idle_ceiling_forced", { phase: "pre-kickstart", ...gate2Fields });
  }

  // THE RESTART SEAM (W1-T3200): probed CAPABILITIES decide which backend restarts the daemon,
  // never a hard-coded platform string — a host with launchctl uses it, a host with only the
  // container scripts uses those, and either can be the sole backend a caller registers. Omitted
  // ⇒ a single fallback wrapping `kickstart` below, unconditionally "available" — today's
  // launchctl-only behaviour, unchanged (Rule 25: this supplies a second implementation of the
  // existing seam, not a rewrite of every caller).
  const restartBackends: readonly RestartBackend[] = deps.restartBackends?.() ?? [
    {
      name: "kickstart",
      probe: () => true,
      describe: () => "the injected kickstart() dependency",
      restart: deps.kickstart,
    },
  ];

  // W1-T380: a deferral episode ends ONLY on a cycle that actually restarts, so this branch
  // keeps the persisted clock INTACT — clearing it here once let a forced dry-run reset the
  // clock while the daemon sat stale for over an hour (docs/forensics/deployer.md#rundeploycycle--the-dry-run-deferral-bug).
  if (opts.dryRun) {
    // DRY-RUN SURVIVES ON EVERY BACKEND (design (v)): `describe()` is read from EACH registered
    // backend — `restart()` is called on NONE of them — so a dry run means the same thing
    // whichever backend would have been selected live.
    deps.log("deploy.dry_run", {
      would_kickstart: true,
      to: short(toHead),
      retained_wait_ms: gate2.waitedMs,
      restart_backends: restartBackends.map((b) => ({ name: b.name, available: b.probe(), description: b.describe() })),
    });
    return { deployed: false, reason: "dry-run (pulled; kickstart skipped)", fromHead, toHead };
  }

  // Genuinely idle, or the ceiling carried it — and THIS cycle is restarting, so the episode
  // ends. Kept ABOVE the restart call: a real cycle must clear unconditionally, or the clock
  // never resets and every later tick forces a SIGKILL restart.
  deps.clearDeferredSince?.();

  const selection = selectRestartBackend(restartBackends);
  if (!selection.backend) {
    // NO USABLE BACKEND: refuse LOUDLY (design (ii)) rather than the silent decline this
    // replaces — today, an absent launchctl just never restarts, indistinguishable from "nothing
    // needed restarting". The pull already happened and is inert on disk; the marker is left in
    // place (never consumed) so a later tick — on this host or once a backend becomes usable —
    // retries automatically, exactly like the idle-gate deferrals above.
    deps.log("deploy.no_restart_backend", { to: short(toHead), reason: selection.reason });
    deps.alert(`deploy of ${toHead} was pulled but could not be restarted: ${selection.reason}`, toHead, "restart-refused");
    return { deployed: false, reason: `restart-refused: ${selection.reason}`, fromHead, toHead, pulledPendingRestart: true };
  }

  const kickstartAt = deps.now();
  try {
    selection.backend.restart();
  } catch (err) {
    // A BACKEND'S OWN REFUSAL IS AUTHORITATIVE AND NEVER SECOND-GUESSED (design (iii)) —
    // recycle-container.sh refusing on workers past its wait, a failed pull, or an image-id
    // mismatch throws exactly like this. Reported verbatim; never retried past, suppressed, or
    // replaced by a different backend or a bare `docker restart`.
    const message = err instanceof Error ? err.message : String(err);
    deps.log("deploy.restart_refused", { to: short(toHead), backend: selection.backend.name, message });
    deps.alert(`deploy of ${toHead} was pulled but ${selection.backend.name} refused the restart: ${message}`, toHead, "restart-refused");
    return { deployed: false, reason: `restart-refused: ${message}`, fromHead, toHead, pulledPendingRestart: true };
  }
  deps.log("deploy.kickstart", { to: short(toHead), backend: selection.backend.name });

  const health = assessBootHealth(deps.waitBootHealth(kickstartAt), opts.health);
  if (health.healthy) {
    deps.clearMarker();
    deps.log("deploy.ok", { to: short(toHead), reason: health.reason });
    deps.setRestartPressureState?.(
      resetDeployRestartPressure(deps.restartPressureState?.() ?? { total: 0, scoredShas: [] }, deps.now()),
    );
    // Restart the console ONLY here: the daemon is verified healthy, so no path can still roll
    // this sha back (see restartConsole's doc). ONLY where the console is a launchd job: on the
    // container fleet it is its own container, and a launchctl call there threw ENOENT after every
    // healthy recycle (measured 2026-09-22T21:49:58Z, `deploy.ok` then `spawnSync launchctl ENOENT`).
    if (selection.backend.name === "recycle-container") {
      deps.log("deploy.console_skipped", { to: short(toHead), reason: `no launchd console job under the ${selection.backend.name} backend` });
      return { deployed: true, reason: "deployed + healthy", fromHead, toHead, consoleRestarted: false };
    }
    const con = restartConsole(deps, toHead);
    return {
      deployed: true,
      reason: "deployed + healthy",
      fromHead,
      toHead,
      consoleRestarted: con.restarted,
      consoleHealthy: con.healthy,
    };
  }

  // ROLLBACK — restore a head the daemon is OBSERVED to have booted on. NOT `fromHead`: it can
  // itself already be the bad head (see {@link readLastGoodBootSha}); it is only the fallback.
  const bootedSha = deps.lastGoodBootSha?.(toHead);
  const rollbackTo = bootedSha ?? fromHead;
  deps.log("deploy.unhealthy_rollback", {
    failed: short(toHead),
    reason: health.reason,
    rolling_back_to: short(rollbackTo),
    // Distinguishes a rollback aimed by observed evidence from one that fell back to the install's
    // own head — the latter is the shape that silently did nothing, so it must be legible in the
    // ledger rather than inferred from two shas happening to match.
    anchor: bootedSha ? "booted" : "install-head",
  });
  deps.resetHard(rollbackTo);
  // The SAME backend selected above, not the raw `kickstart` field — this host may have no
  // launchctl at all, and the rollback restart must use whichever backend just proved itself
  // usable (design (i)/(iii): capability decided once this cycle, and a script's earlier success
  // is never second-guessed by falling back to a different mechanism here).
  selection.backend.restart();
  deps.alert(`deploy of ${toHead} failed health-check (${health.reason}); rolled back to ${rollbackTo}`, toHead, "health-check-rollback");
  deps.clearMarker();
  return { deployed: false, reason: `health-check-failed-rolled-back: ${health.reason}`, fromHead, toHead, rolledBackTo: rollbackTo };
}

// ── Marker + alert file paths (state/) ──────────────────────────────────────────

/** Operator "please deploy at the next idle gap" request (`rmd deploy` writes it). */
export function deployMarkerPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_REQUESTED");
}
/** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
/** The operator's opt-out: present, image drift waits for `rmd deploy` like everything else. */
export function deployImageManualPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_IMAGE_MANUAL");
}

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
/** W1-T341: since when THIS deploy attempt has been deferred by the idle gate — the
 *  cross-cycle clock {@link evaluateIdleGate}'s ceiling measures against (each `deploy-run`
 *  cycle is a fresh launchd one-shot, so this cannot live in memory). */
export function deployIdleDeferredSincePath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_IDLE_DEFERRED_SINCE");
}
/** Accumulated daemon-impact score for merged changes not yet picked up by a healthy restart. */
export function deployRestartPressurePath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_RESTART_PRESSURE");
}

/** `rmd deploy` — request a deploy at the next idle gap. */
export function requestDeploy(stateRoot: string, reason: string | undefined): void {
  const p = deployMarkerPath(stateRoot);
  writeAtomic(p, JSON.stringify({ reason, requestedAt: new Date().toISOString() }, null, 2));
}

// ── Real, injected side effects ─────────────────────────────────────────────────

export interface RealDeployOpts {
  /** The daemon's git checkout to fast-forward (its install path / repoRoot). */
  installPath: string;
  /** `<config.root>` (holds state/). */
  stateRoot: string;
  /** launchd job label to kickstart (e.g. com.remudero.daemon). */
  daemonLabel: string;
  /** launchd job label for the console (e.g. com.remudero.serve). */
  serveLabel: string;
  /** TCP port the console listens on — the no-auth health signal. */
  servePort: number;
  /** For `launchctl kickstart -k gui/<uid>/<label>`. */
  uid: number;
  ledgerPath: string;
  /** OPTIONAL since impl-EP — omitted ⇒ {@link buildDeployLogger} against `ledgerPath`, which writes
   *  to BOTH stdout and the ledger. Supplied only by tests that want to observe the calls. */
  log?: (step: string, data?: Record<string, unknown>) => void;
  /** Health window: total ms to watch the daemon after kickstart (default 45s). */
  healthWindowMs?: number;
  /** Poll pace within the window (default 3s). */
  healthPollMs?: number;
  /** Injected blocking sleep (tests fake it; real = a busy-wait-free sleep). */
  sleep?: (ms: number) => void;
  /** W1-T3732 — the daemon instance this deployment is for, passed to `recycle-container.sh` as
   *  `--instance`. OMITTED ⇒ derived from the registry by matching {@link RealDeployOpts.stateRoot}
   *  against each declared `state_dir` ({@link instanceForStateRoot}); still undefined ⇒ the script
   *  is invoked exactly as before this field existed, and refuses exactly as it does today. */
  instance?: string;
  /** Injected subprocess runner (tests fake it; default = execFileSync, utf8, RAW — callers
   *  trim, since `git status --porcelain`'s leading status column is significant). Throws on
   *  a non-zero exit, like execFileSync — callers catch where that is expected (e.g. `pgrep`
   *  with no matches). */
  execFile?: (cmd: string, args: string[]) => string;
}

/** Resolve the deploy supervisor's ledger from the state root it is operating on.
 *
 * The caller's legacy `ledgerPath` is deliberately not consulted here: a supervisor can be
 * launched from a checkout whose default config points at another instance's state. A relative
 * or empty root is a refusal, never permission to fall back to that default; the state directory
 * may be created later by the ledger writer.
 */
export function deployLedgerPath(stateRoot: string): string {
  const validRoot =
    typeof stateRoot === "string" &&
    stateRoot.trim().length > 0 &&
    isAbsolute(stateRoot);
  if (!validRoot) {
    throw new Error(`cannot resolve deploy ledger — state root refused: ${String(stateRoot)}`);
  }
  return join(stateRoot, "state", LEDGER_FILENAME);
}

function parseDeployRestartPressureState(raw: string): DeployRestartPressureState {
  const parsed = JSON.parse(raw) as {
    total?: unknown;
    scoredShas?: unknown;
    lastRestartAtMs?: unknown;
  };
  const total = typeof parsed.total === "number" && Number.isFinite(parsed.total) && parsed.total > 0
    ? Math.floor(parsed.total)
    : 0;
  const scoredShas = Array.isArray(parsed.scoredShas)
    ? parsed.scoredShas.filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
    : [];
  const lastRestartAtMs = typeof parsed.lastRestartAtMs === "number" && Number.isFinite(parsed.lastRestartAtMs)
    ? parsed.lastRestartAtMs
    : undefined;
  return {
    total,
    scoredShas,
    ...(lastRestartAtMs === undefined ? {} : { lastRestartAtMs }),
  };
}

/**
 * The deploy cycle's logger — stdout AND the ledger (impl-EP). It used to write only to
 * `console.log`, so 107 dirty-tree aborts across 663 rotations left zero ledger rows and the
 * defect survived eleven days and six investigations
 * (docs/forensics/deployer.md#builddeploylogger). Not added to
 * `DECISION_RELEVANT_LEDGER_STEPS`: `deploy.*` is already retained through rotation by
 * ledger.ts's health-window prefix rule, the correct retention for an observability step.
 * Best-effort — a deploy must never fail because its own logging could not write.
 */
export function buildDeployLogger(
  ledgerPath: string,
  deps: { append?: typeof appendLedger; out?: (line: string) => void; now?: () => number } = {},
): (step: string, data?: Record<string, unknown>) => void {
  const append = deps.append ?? appendLedger;
  const out = deps.out ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  return (step, data) => {
    out(`### [deploy] ${step}${data ? " " + JSON.stringify(data) : ""}`);
    try {
      append(ledgerPath, { run_id: `DEPLOY-${now()}`, task_id: "DEPLOY", step, ...(data ?? {}) });
    } catch {
      // stdout already carries it; a ledger write failure must not abort the deploy cycle.
    }
  };
}

/**
 * Wire {@link runDeployCycle}'s side effects to the real world: every subprocess through one
 * injectable `execFile`, every file op via node:fs against `stateRoot` — so the whole adapter
 * is unit-testable without a real daemon/git/launchctl. Health after kickstart is judged by
 * watching the ledger for `daemon.boot` heartbeats newer than the kickstart instant: exactly
 * one is a clean boot, several means KeepAlive is restart-storming a broken daemon.
 */
export function realDeployDeps(o: RealDeployOpts): DeployDeps {
  const ledgerPath = deployLedgerPath(o.stateRoot);
  const exec = o.execFile ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).toString());
  const git = (args: string[]): string => exec("git", ["-C", o.installPath, ...args]);
  const sleep = o.sleep ?? ((ms: number) => exec("sleep", [String(Math.ceil(ms / 1000))]));
  const log = o.log ?? buildDeployLogger(ledgerPath);
  const windowMs = o.healthWindowMs ?? 45_000;
  const pollMs = o.healthPollMs ?? 3_000;

  const isRefLockFailure = (error: unknown): boolean => {
    const e = error as { stderr?: unknown; message?: unknown } | null;
    return /cannot lock ref|unable to update local ref/i.test(`${String(e?.stderr ?? "")}\n${String(e?.message ?? error)}`);
  };

  const fetchWithRefLockRetry = (): void => {
    for (let attempt = 1; attempt <= FETCH_LOCK_RETRY_MAX; attempt += 1) {
      try {
        git(["fetch", "origin", "--quiet"]);
        if (attempt > 1) {
          log("deploy.fetch_recovered", { attempt, max_attempts: FETCH_LOCK_RETRY_MAX, reason: "ref-lock" });
        }
        return;
      } catch (error) {
        if (!isRefLockFailure(error) || attempt === FETCH_LOCK_RETRY_MAX) throw error;
        log("deploy.fetch_retry", { attempt, max_attempts: FETCH_LOCK_RETRY_MAX, reason: "ref-lock" });
        sleep(FETCH_LOCK_RETRY_PAUSE_MS);
      }
    }
  };

  const countBootsAfter = (sinceMs: number): number => countLedgerBootsAfter(ledgerPath, sinceMs);

  // ── THE RESTART SEAM'S TWO REAL BACKENDS (W1-T3200) ── selected by PROBED capability, never by
  // `process.platform`: a host with launchctl uses it (today's only path, macOS); a host with only
  // `deploy/recycle-container.sh` on its checkout and a docker client on PATH uses that instead
  // (the fleet's only host, Linux, has no launchctl at all — see this module's file header). See
  // {@link selectRestartBackend} for the probe-in-order selection itself.
  const isBinaryAbsent = (err: unknown): boolean =>
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
  const kickstartDaemon = () => {
    exec("launchctl", ["kickstart", "-k", `gui/${o.uid}/${o.daemonLabel}`]);
  };
  const launchctlBackend: RestartBackend = {
    name: "launchctl",
    // Probes the BINARY, not this particular job: `launchctl list` (no label) runs cleanly on any
    // macOS host regardless of whether THIS job happens to be loaded right now, so only ENOENT —
    // the binary genuinely absent, as measured on this task's Linux fleet host — reads as
    // unavailable. Any other failure still means launchctl ran, which is all "usable" asks here.
    probe: () => {
      try {
        exec("launchctl", ["list"]);
        return true;
      } catch (err) {
        // Anything OTHER than ENOENT still means launchctl RAN (a bad arg, a permission error,
        // whatever it was) — "present but errored" and "present" coincide for this probe's only
        // consumer, which asks nothing finer than usable/not; only genuine absence reads false.
        return !isBinaryAbsent(err);
      }
    },
    describe: () => `launchctl kickstart -k gui/${o.uid}/${o.daemonLabel}`,
    restart: kickstartDaemon,
  };
  const recycleContainerScript = join(o.installPath, "deploy", "recycle-container.sh");
  // W1-T3732: resolved ONCE per deps object, from the registry on the checkout being deployed.
  // An unreadable or absent registry is NOT a match — it leaves `recycleInstance` undefined and the
  // invocation byte-identical to before this task, which is the fail-closed direction: a fault must
  // never select a daemon, and must never restore the unscoped default the registry exists to forbid.
  // W1-T3733: read ONCE, and reused for both the `--instance` flag and the image-sha container.
  const registryText = (() => {
    try {
      return readFileSync(daemonInstanceRegistryPath(o.installPath), "utf8");
    } catch {
      return undefined; // absent or unreadable — every consumer below keeps its pre-registry default
    }
  })();
  const imageShaContainer = registryText === undefined ? IMAGE_SHA_CONTAINER : imageShaContainerFor(registryText, o.stateRoot);
  const recycleInstance =
    o.instance ??
    (() => {
      try {
        return registryText === undefined ? undefined : instanceForStateRoot(registryText, o.stateRoot);
      } catch {
        // An absent or unreadable registry does not name an instance; preserve the script's
        // fail-closed unscoped refusal instead of inferring one from unrelated host state.
        return undefined;
      }
    })();
  const recycleContainerBackend: RestartBackend = {
    name: "recycle-container",
    // Usable only when the SCRIPT is on this checkout AND a docker client is on PATH — everything
    // past that is the script's own authority (design (iii)): a daemon it cannot reach, a failed
    // pull, an image-id mismatch all surface as ITS OWN refusal (a thrown, non-zero exit), never
    // second-guessed here.
    probe: () => {
      if (!existsSync(recycleContainerScript)) return false;
      try {
        exec("docker", ["version", "--format", "{{.Client.Version}}"]);
        return true;
      } catch {
        return false; // docker absent, or unreachable — the script needs a working docker to run
      }
    },
    describe: () =>
      `${recycleContainerScript}${recycleInstance ? ` --instance ${recycleInstance}` : ""} ` +
      `(pause, drain, pull and replace the ${o.daemonLabel} container)`,
    restart: () => {
      // W1-T3732 — NAME THE INSTANCE. `recycle-container.sh` REFUSES an unscoped invocation whenever
      // the registry declares instances (W1-T3596), and this call site passed nothing — so every
      // automated restart on this fleet was a refusal. MEASURED 2026-09-17T13:07:36Z:
      // `deploy.restart_refused`, "Declared: core site console", after the image had already been
      // pulled. An unresolved instance still invokes the script bare, so the refusal stands wherever
      // there is no answer rather than being replaced by a guess.
      exec("bash", recycleInstance ? [recycleContainerScript, "--instance", recycleInstance] : [recycleContainerScript]);
    },
  };

  return {
    log,
    now: () => Date.now(),
    fetch: () => {
      fetchWithRefLockRetry();
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
    lastFailedKind: () => {
      try {
        const k = (JSON.parse(readFileSync(deployFailedAlertPath(o.stateRoot), "utf8")) as { kind?: string }).kind;
        return k === "dirty-tree-conflict" || k === "health-check-rollback" || k === "restart-refused" ? k : undefined;
      } catch {
        return undefined; // absent/legacy/corrupt ⇒ "reason not recorded", never a guess
      }
    },
    // Byte-identity via BLOB SHA, compared through the injected `git` helper.
    //
    // Two rejected alternatives, both unsafe here. Comparing decoded strings can false-MATCH on
    // binary content, because invalid UTF-8 collapses to U+FFFD and two different blobs can decode
    // alike — and a false match discards a file that actually differs. `git diff --quiet <ref> --
    // <path>` is worse: it ignores UNTRACKED files entirely, so it reports "no difference" for
    // precisely the alert-intake exhaust this fix exists to handle. Hashing the working file
    // covers tracked and untracked identically, and git's hash is byte-exact.
    //
    // ANY failure (path absent from the ref, unreadable file, git error) answers false, so the
    // conservative abort remains the default and only a positive match can unblock a deploy.
    sameAsIncoming: (path, ref) => {
      try {
        const local = git(["hash-object", "--", path]).trim();
        const incoming = git(["rev-parse", `${ref}:${path}`]).trim();
        return local.length > 0 && local === incoming;
      } catch {
        return false;
      }
    },
    // Tracked ⇒ restore from HEAD (leaves a clean path the ff can advance); untracked ⇒ remove.
    // Never `reset --hard`: this touches ONLY paths already proven byte-identical to the incoming
    // blob, one at a time.
    discardLocal: (path) => {
      const tracked = (() => {
        try {
          git(["ls-files", "--error-unmatch", "--", path]);
          return true;
        } catch {
          return false;
        }
      })();
      if (tracked) git(["checkout", "--", path]);
      else unlinkSync(join(o.installPath, path));
    },
    runningHead: () => readLatestBootSha(ledgerPath),
    // W1-T3240 — THE PRODUCER, shipped with its consumer. `/etc/rmd-build-sha` is written into
    // the image at build time and is the ONLY sha on this host not read off the bind mount,
    // which is why `runningHead` above cannot stand in for it. Read through `docker exec`,
    // exactly as scripts/fleet-heartbeat.sh already does to publish `image_build_sha` (W1-T496);
    // a failure there means the container is down, and that becomes UNKNOWN, never a restart.
    imageBakedCommitsBehind: () => {
      let sha: string | undefined;
      try {
        sha = exec("docker", ["exec", imageShaContainer, "cat", IMAGE_BUILD_SHA_PATH]).trim();
      } catch {
        return undefined; // container down / no docker — UNKNOWN, never "current"
      }
      const baked = bakedPathCommitsBehind(sha, (args) => git([...args]));
      // W1-T4061 — a playwright-core version bump is image drift too, even though it lands only
      // in the root lockfile (never in IMAGE_BAKED_PATHS). UNKNOWN only when BOTH readings are:
      // one known signal must never be swallowed by the other going unreadable.
      const playwright = playwrightCoreVersionCommitsBehind(sha, (args) => git([...args]));
      if (baked === undefined && playwright === undefined) return undefined;
      return (baked ?? 0) + (playwright ?? 0);
    },
    resourcePolicyDrift: () => {
      // W1-T4267: the launcher names the container and role it owns; the policy is evaluated by the
      // SAME sourced shell file recycle-container.sh applies. Either side unreadable ⇒ UNKNOWN.
      const container = process.env.RMD_RESOURCE_POLICY_CONTAINER || imageShaContainer;
      const role = process.env.RMD_RESOURCE_POLICY_ROLE === "serve" ? "serve" : "build";
      try {
        const expectedArgs = exec("bash", [
          "-c",
          'source "$1" || exit 2; if [ "$2" = serve ]; then resource_policy_serve_args; a=("${RESOURCE_POLICY_SERVE_ARGS[@]}"); ' +
            'else resource_policy_build_args; a=("${RESOURCE_POLICY_BUILD_ARGS[@]}"); fi; printf "%s\\n" "${a[@]}"',
          "resource-policy",
          join(o.installPath, "deploy", "resource-policy.sh"),
          role,
        ]);
        return resourcePolicyDriftFrom(expectedArgs, exec("docker", ["inspect", container, "--format", "{{json .HostConfig}}"]));
      } catch {
        return undefined; // no policy file, no bash, or no such container — never a recycle trigger
      }
    },
    newestBakedSha: () => {
      let newestBaked: string | undefined;
      try {
        newestBaked = git(["log", "-1", "--format=%H", "origin/main", "--", ...IMAGE_BAKED_PATHS]).trim() || undefined;
      } catch {
        newestBaked = undefined; // no git answer — the tick treats the image's publication as UNKNOWN and waits
      }
      // W1-T4061 — the newest commit that actually MOVED the playwright-core pin, not merely the
      // newest commit that touched the root lockfile (an unrelated bump landing after it would
      // otherwise misname itself as "the" image input, and imagePublished would look up a tag
      // acr-build.yml's own guard never created for that commit).
      const newestPlaywright = newestPlaywrightVersionChangeSha((args) => git([...args]));
      if (!newestPlaywright) return newestBaked;
      if (!newestBaked) return newestPlaywright;
      try {
        const bakedDistance = Number.parseInt(git(["rev-list", "--count", `${newestBaked}..origin/main`]).trim(), 10);
        const playwrightDistance = Number.parseInt(git(["rev-list", "--count", `${newestPlaywright}..origin/main`]).trim(), 10);
        if (Number.isFinite(bakedDistance) && Number.isFinite(playwrightDistance)) {
          return playwrightDistance <= bakedDistance ? newestPlaywright : newestBaked;
        }
      } catch {
        // fall through to the baked-path reading below
      }
      return newestBaked;
    },
    // The build tags each image with the commit that triggered it (acr-build.yml), so a tag for
    // the newest image-input commit exists exactly when that image is published.
    imagePublished: (sha) => {
      const image = registryText === undefined ? undefined : imageRefFor(registryText, o.stateRoot);
      if (!image) return undefined;
      try {
        exec("docker", ["manifest", "inspect", `${image.replace(/:[^:/]+$/, "")}:${sha}`]);
        return true;
      } catch (err) {
        // Only a registry that answered "no such tag" is a no; auth or network trouble is unknown.
        return /no such manifest|manifest unknown|not found/i.test(String((err as Error)?.message ?? err)) ? false : undefined;
      }
    },
    imageRecycleManual: () => existsSync(deployImageManualPath(o.stateRoot)),
    lastFailedAtMs: () => {
      try {
        const at = Date.parse((JSON.parse(readFileSync(deployFailedAlertPath(o.stateRoot), "utf8")) as { at?: string }).at ?? "");
        return Number.isFinite(at) ? at : undefined;
      } catch {
        return undefined; // no failure recorded (or unreadable) — no back-off applies
      }
    },
    // Same ledger, same live-file-only read as `runningHead` directly above — the rollback anchor
    // (see runDeployCycle's rollback branch for why it is not `installHead()`).
    lastGoodBootSha: (excludeSha) => readLastGoodBootSha(ledgerPath, excludeSha),
    dirtyFiles: () =>
      git(["status", "--porcelain"])
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    incomingFiles: (from, to) =>
      git(["diff", "--name-only", `${from}..${to}`]).split("\n").map((l) => l.trim()).filter(Boolean),
    pendingChanges: (from, to) => {
      if (sameCommit(from, to)) return [];
      const shas = git(["rev-list", "--reverse", `${from}..${to}`]).split("\n").map((l) => l.trim()).filter(Boolean);
      return shas.map((sha) => ({
        sha,
        subject: git(["log", "-1", "--format=%s", sha]).trim(),
        files: git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      }));
    },
    restartPressureState: () => {
      try {
        return parseDeployRestartPressureState(readFileSync(deployRestartPressurePath(o.stateRoot), "utf8"));
      } catch {
        /* Missing or corrupt pressure state means no score has been durably observed. */
        return { total: 0, scoredShas: [] };
      }
    },
    setRestartPressureState: (state) => {
      writeAtomic(deployRestartPressurePath(o.stateRoot), JSON.stringify(state, null, 2));
    },
    restartScoreThreshold: () => DEPLOY_RESTART_SCORE_THRESHOLD,
    restartRateCeilingMs: () => DEPLOY_RESTART_RATE_CEILING_MS,
    pullFf: () => {
      git(["merge", "--ff-only", "origin/main"]);
    },
    resetHard: (ref) => {
      git(["reset", "--hard", ref]);
    },
    probeIdle: () => {
      // ALL THREE READS DISCRIMINATE a true zero from a read that did not happen; see
      // {@link IdleProbe.unreadable}. Every one of them used to catch into 0, and 0 on all three
      // is precisely what {@link daemonIsIdle} calls quiet.
      const unreadable: string[] = [];
      let workers = 0;
      try {
        workers = exec("pgrep", ["-f", "claude --output-format|codex exec"]).split("\n").filter(Boolean).length;
      } catch (err) {
        if (!pgrepFailureMeansZero(err)) unreadable.push("workers");
        workers = 0; // pgrep exits 1 when there are no matches
      }
      const countLocks = (dir: string, signal: string): number => {
        try {
          return readdirSync(dir).filter((n) => n.endsWith(".lock")).length;
        } catch (err) {
          if (!lockReadFailureMeansZero(err)) unreadable.push(signal);
          return 0;
        }
      };
      return {
        workers,
        inflightLocks: countLocks(join(o.stateRoot, "state", "inflight"), "inflightLocks"),
        worktreeLocks: countLocks(join(o.stateRoot, "worktrees"), "worktreeLocks"),
        unreadable,
      };
    },
    kickstartConsole: () => {
      // The SAME mechanism as the daemon kickstart below — one way to restart a service,
      // only the label differs. Both labels live in the same gui/<uid> domain.
      exec("launchctl", ["kickstart", "-k", `gui/${o.uid}/${o.serveLabel}`]);
    },
    // Mirrors `consolePid` below — same launchctl query, same domain, only the label differs. A
    // job that is loaded but not running reports no PID, which is precisely the corpse state.
    daemonAlive: () => {
      try {
        const out = exec("launchctl", ["list", o.daemonLabel]);
        const m = out.match(/"PID"\s*=\s*(\d+)/);
        return m ? Number(m[1]) > 0 : false;
      } catch {
        return undefined; // not loaded / query failed — NOT observed, never asserted as dead
      }
    },
    // No try/catch: `stopDetail` is existsSync + a swallowing read, so it cannot throw — a
    // defensive catch here would be unreachable code, which diff-coverage correctly refuses. The
    // trigger still treats `undefined` as PRESENT, which covers any caller that omits this dep.
    stopPresent: () => stopDetail(o.stateRoot) !== undefined,
    consolePid: () => {
      try {
        const out = exec("launchctl", ["list", o.serveLabel]);
        const m = out.match(/"PID"\s*=\s*(\d+)/);
        return m ? Number(m[1]) : undefined;
      } catch {
        return undefined; // not loaded / not running — reported as null in the ledger
      }
    },
    waitConsoleUp: () => {
      // A LISTENING SOCKET, not an authenticated request: the deployer holds no service token
      // and must not learn one. Bounded poll; the serve job's ThrottleInterval is 60s, so a
      // crash-then-relaunch can legitimately take a while — we report, we do not roll back.
      for (let i = 0; i < CONSOLE_UP_ATTEMPTS; i++) {
        try {
          exec("lsof", ["-nP", `-iTCP:${o.servePort}`, "-sTCP:LISTEN"]);
          return true; // exit 0 => something is listening
        } catch {
          /* nothing listening yet */
        }
        sleep(CONSOLE_UP_DELAY_MS);
      }
      return false;
    },
    alertConsoleOnly: (message) => {
      // The operator-visible alert WITHOUT deployLastFailedPath — see the dep's doc for why
      // poisoning the failed-HEAD marker on a console fault would freeze the pipeline.
      writeAtomic(
        deployFailedAlertPath(o.stateRoot),
        JSON.stringify({ message, scope: "console", at: new Date().toISOString() }, null, 2),
      );
    },
    kickstart: kickstartDaemon,
    restartBackends: () => [launchctlBackend, recycleContainerBackend],
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
    alert: (message, failedHead, kind) => {
      // `kind` is persisted so the NEXT poll's skip line can state the real cause. Without it the
      // record and the message that cites it can disagree, which is how a dirty-tree stall spent
      // an investigation being read as a health-check failure.
      writeAtomic(
        deployFailedAlertPath(o.stateRoot),
        JSON.stringify({ message, failedHead, kind, at: new Date().toISOString() }, null, 2),
      );
      writeAtomic(deployLastFailedPath(o.stateRoot), failedHead);
    },
    clearMarker: () => {
      try {
        unlinkSync(deployMarkerPath(o.stateRoot));
      } catch {
        /* already gone */
      }
    },
    // W1-T341's ceiling clock, persisted because a fresh process cannot remember it between
    // `deploy-run` cycles (see this file's banner). A missing/unparseable record reads as
    // "no deferral tracked" (undefined), which evaluateIdleGate treats as a fresh deferral —
    // never as an already-elapsed one.
    deferredSince: () => {
      try {
        const raw = readFileSync(deployIdleDeferredSincePath(o.stateRoot), "utf8").trim();
        const ms = Number(raw);
        return Number.isFinite(ms) ? ms : undefined;
      } catch {
        return undefined;
      }
    },
    setDeferredSince: (ms) => {
      writeAtomic(deployIdleDeferredSincePath(o.stateRoot), String(ms));
    },
    clearDeferredSince: () => {
      try {
        unlinkSync(deployIdleDeferredSincePath(o.stateRoot));
      } catch {
        /* already gone */
      }
    },
  };
}
