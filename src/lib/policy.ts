import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * The fleet's operating-constants policy, loaded as data rather than scattered source literals
 * (P34/P37; W1-T252). Parses `plan/policy.yaml` and validates it into a typed {@link Policy},
 * throwing {@link PolicyError} on any violation — the same load-and-validate pattern
 * `src/lib/mounts.ts`/`src/lib/alert-lane.ts` use. Never add a second, ad hoc loader.
 *
 * Invariant: every field's origin and every numeric field's `[min, max]` bound travel with the
 * value in its YAML row and are checked here at load (see {@link EXPECTED_ORIGIN_KIND}, {@link
 * Policy.bounds}); a stale value re-committed below a raised bound is an ordinary refusal, never
 * a smaller tuning choice. Why: docs/forensics/policy.md#module-header.
 */

/** A single headroom-ceiling curve rung (`src/lib/daemon.ts`'s `buildDefaultHeadroomPolicy`
 *  shape) — `maxHoursToReset: null` is the catch-all last rung (mirrors `Infinity` in source). */
export interface PolicyHeadroomRung {
  maxHoursToReset: number | null;
  limitPct: number;
}

/**
 * One operator-ratified row of {@link PolicyValues.armCalibrationBands} (W1-T2579). `class`
 * names a `VerdictClass` (src/lib/review.ts) `decideAutoMergeArm` may band — only
 * `"full-pass"`/`"keyword-floor"` are consulted; `"degraded-arm"` never matches, by
 * construction. `verdict: "hold"` refuses the arm, `"notify"` arms with `note` in the reason.
 * A malformed row throws {@link PolicyError} at load. Why: docs/forensics/policy.md#armcalibrationbandrow.
 */
export interface ArmCalibrationBandRow {
  class: string;
  verdict: "hold" | "notify";
  note?: string;
}

/** The plain, consumer-facing values every W1-T253 read site will resolve against. */
export interface PolicyValues {
  proofTimeoutMs: number;
  pruneGraceMs: number;
  /** W1-T378: the CADENCE worktree reaper's age ceiling — separate from {@link
   *  PolicyValues.pruneGraceMs}, which `pruneStaleRuns` call sites consume. */
  worktreeReapGraceMs: number;
  pollIntervalMs: number;
  fixStrikeCap: number;
  /** W1-T943: how long a stalled run's newest `worker.state` row may age before `src/run-task.ts`'s
   *  `runWorkerStallDetectorRung` escalates it once. Net-new; derived in plan/policy.yaml. */
  workerStall: number;
  /** W1-T1045: how long a worker's SDK stream may go silent before `src/lib/worker.ts`'s
   *  clock-bound watchdog aborts it. Net-new; derived in plan/policy.yaml. */
  workerAbandon: number;
  /** W1-T1044: the wall-clock bound (ms) on one sweep poll tick (daemon.ts). Split from {@link
   *  PolicyValues.fixSpawnWallClockBoundMs} (W1-T1219) — different populations, never share one
   *  bound. Optional; absent uses {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}. Why:
   *  docs/forensics/policy.md#sweepwallclockboundms. */
  sweepWallClockBoundMs: number;
  /** W1-T1219: the wall-clock bound (ms) on one fix-rung worker spawn (`runFixRung`,
   *  run-task.ts) — split off {@link PolicyValues.sweepWallClockBoundMs}. Optional; absent uses
   *  {@link DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS}. Why: docs/forensics/policy.md#fixspawnwallclockboundms. */
  fixSpawnWallClockBoundMs: number;
  /** R-3: the wait deadline (ms) on `acquireKeychainProvisionLock` (worker-home.ts) — how long a
   *  synchronous (`Atomics.wait`) wait on a live lock holder may run before throwing
   *  `WorkerKeychainError`. Optional; absent uses {@link DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS}.
   *  Why: docs/forensics/policy.md#keychainprovisionlockwaitms. */
  keychainProvisionLockWaitMs: number;
  sweep: {
    staleDays: number;
    strikeCap: number;
    wipLimit: number;
    /** W1-T320: rmd's own temp-dir backstop's age ceiling (`tmp.ts`'s `sweepStaleTempDirs`). */
    tmpMaxAgeMs: number;
    /** W1-T325: the concurrent dispatch-lane count `rmd drain` fills per pass (W1-T172/P19). */
    dispatchLanes: number;
    /** W1-T330: the daily spend ceiling (W1-T148 cost governor). Why: docs/forensics/policy.md#sweep-block. */
    dailyCostCeilingUsd: number;
    /** W1-T516: gates arming a task-id-less session PR under the synthetic `PR-<n>` id. Default
     *  off. Why: docs/forensics/policy.md#sweep-block. */
    armSessionPrs: boolean;
    /** W1-T905: the recurrence count — this many distinct-PR `sweep.disposed acted: true` rows
     *  on one surface, inside {@link PolicyValues.sweep.repairFilingWindowDays}, files one
     *  `repair#<surface>` §7B entry. Net-new. */
    repairFilingThreshold: number;
    /** W1-T905: the recurrence window (days) the threshold above counts within. Net-new. */
    repairFilingWindowDays: number;
    /** W1-T920: gates the supersession disposition (`sweep.ts`'s `DISPOSITION_RULES`). Default
     *  off, same shape as `armSessionPrs`. Why: docs/forensics/policy.md#sweep-block. */
    supersessionDisposal: boolean;
    /** W1-T2847: ARMS the ad-hoc lane reap rung. `runAdhocLaneReapRung` shipped survey-first with
     *  `enabled` defaulting false and its doc calling arming "a separate operator decision" — but
     *  the call site passed no `enabled` at all, so there was nothing an operator could decide.
     *  This row is that decision, made settable. Same shape as `armSessionPrs`. */
    armAdhocLaneReap: boolean;
    /** W1-T1038: the dispatch-path `/proc/meminfo` `MemAvailable` floor (MiB); below it, new
     *  dispatch defers. Ships at 0. See {@link checkMemoryGovernor}. Why:
     *  docs/forensics/policy.md#sweepmemoryfloormib. */
    memoryFloorMib: number;
  };
  drain: {
    max: number;
  };
  /** The daemon's retro cadence trigger (W1-T264), lifted off `src/lib/retro.ts`'s
   *  `DEFAULT_RETRO_MERGES_THRESHOLD`/`DEFAULT_RETRO_DAYS_THRESHOLD`. */
  retro: {
    mergesThreshold: number;
    daysThreshold: number;
  };
  /** The daemon's auto-triage rung (recon-DC #2). Default off — spends unsupervised. Why:
   *  docs/forensics/policy.md#autotriage. */
  autoTriage: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
  };
  /** W1-T1259: the measurement-cadence rung (`rule-efficacy`, `verdict-calibration`,
   *  `autonomy-rate`). Optional, defaults ENABLED (read-only); `escalate` is the separate opt-in
   *  flag for `rule-efficacy`'s one write (Law 5). Why: docs/forensics/policy.md#measurementcadence. */
  measurementCadence: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
    escalate: boolean;
  };
  /** W1-T2277: the digest cadence rung — separate from {@link PolicyValues.measurementCadence}
   *  so neither drags the other. No `escalate`: the digest only reads and sends. Defaults to
   *  the safe always-on daily cadence. Why: docs/forensics/policy.md#digestcadence. */
  digestCadence: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
  };
  /** W1-T2304's board-review rung — its own row, separate from {@link
   *  PolicyValues.measurementCadence}/{@link PolicyValues.digestCadence}. `minIntervalMinutes`/
   *  `maxPerDay` are measured off the board's own behaviour. Defaults enabled (read-only).
   *  Why: docs/forensics/policy.md#boardreview. */
  boardReview: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
  };
  headroom: {
    curve: PolicyHeadroomRung[];
    reservePct: number;
    enabled: boolean;
  };
  launchd: {
    throttleIntervalS: number;
  };
  /** The boot-time abandoned-review-clone reap (impl-EK). Default off — it deletes. */
  scratchReap: {
    enabled: boolean;
    maxAgeHours: number;
  };
  /** W1-T406: the one-shot boot rung for {@link reapStaleWorktrees} — same ship-off posture as
   *  {@link PolicyValues.scratchReap} (it deletes). Reuses `worktreeReapGraceMs` above rather
   *  than its own age field. Why: docs/forensics/policy.md#worktreereapboot. */
  worktreeReapBoot: {
    enabled: boolean;
  };
  /** W1-T2568: the GitHub-event wake's bounded recent-delivery dedup window (`github-event-wake.ts`'s
   *  `createDeliveryDedupStore`) — distinct `X-GitHub-Delivery` ids remembered before eviction.
   *  Optional. Why: docs/forensics/policy.md#githubeventwake. */
  githubEventWake: {
    dedupCapacity: number;
    /** W1-T2741: trailing-edge quiet period for high-fanout check/status deliveries. */
    checkSettleMs: number;
  };
  /** W1-T2579 — the arm gate's operator-ratified band table. `decideAutoMergeArm`
   *  (src/lib/review.ts) consults this only on the already-arming `full-pass`/`keyword-floor`
   *  path; it can hold or annotate, never arm what today refuses. Ships empty — a figure reaches
   *  a band only through a merged plan PR, never measurement alone (test/arm-calibration-bands.test.ts).
   *  Why: docs/forensics/policy.md#policyvaluesarmcalibrationbands. */
  armCalibrationBands: ArmCalibrationBandRow[];
}

/** One field's provenance, as recorded on load — see this module's header. */
export type PolicyOriginKind = "lifted" | "net-new";

export interface PolicyFieldOrigin {
  /** Dotted field path, e.g. `"proofTimeoutMs"` or `"sweep.staleDays"`. */
  path: string;
  kind: PolicyOriginKind;
  /** The exact `origin:` string the YAML row carried (e.g. `"lifted:src/lib/review.ts:675 (...)"`). */
  raw: string;
}

/** One numeric field's committed `[min, max]`, as recorded on load. */
export interface PolicyFieldBounds {
  min: number;
  max: number;
}

/** The fully loaded/validated policy: plain values plus per-field provenance. */
export interface Policy {
  values: PolicyValues;
  /** Dotted field path -> its recorded origin. */
  origin: Record<string, PolicyFieldOrigin>;
  /** Dotted field path -> its committed `min`/`max` bounds — the one copy a runtime write
   *  (W1-T332's daily-cost-ceiling override) validates against. */
  bounds: Record<string, PolicyFieldBounds>;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Every field pinned to its required origin kind — `lifted` must cite a real source site,
 *  `net-new` must not — both enforced by {@link validatePolicy} (test/policy.test.ts). */
const EXPECTED_ORIGIN_KIND: Record<string, PolicyOriginKind> = {
  proofTimeoutMs: "lifted",
  pruneGraceMs: "lifted",
  worktreeReapGraceMs: "net-new",
  pollIntervalMs: "lifted",
  fixStrikeCap: "lifted",
  workerStall: "net-new",
  workerAbandon: "net-new",
  sweepWallClockBoundMs: "net-new",
  fixSpawnWallClockBoundMs: "net-new",
  keychainProvisionLockWaitMs: "net-new",
  "sweep.staleDays": "lifted",
  "sweep.strikeCap": "lifted",
  "sweep.wipLimit": "lifted",
  "sweep.tmpMaxAgeMs": "net-new",
  "sweep.dispatchLanes": "lifted",
  "sweep.dailyCostCeilingUsd": "lifted",
  "sweep.armSessionPrs": "net-new",
  "sweep.armAdhocLaneReap": "net-new",
  "sweep.repairFilingThreshold": "net-new",
  "sweep.repairFilingWindowDays": "net-new",
  "sweep.supersessionDisposal": "net-new",
  "sweep.memoryFloorMib": "net-new",
  "drain.max": "lifted",
  "autoTriage.enabled": "net-new",
  "autoTriage.minIntervalMinutes": "net-new",
  "autoTriage.maxPerDay": "net-new",
  "measurementCadence.enabled": "net-new",
  "measurementCadence.minIntervalMinutes": "net-new",
  "measurementCadence.maxPerDay": "net-new",
  "measurementCadence.escalate": "net-new",
  "digestCadence.enabled": "net-new",
  "digestCadence.minIntervalMinutes": "net-new",
  "digestCadence.maxPerDay": "net-new",
  "boardReview.enabled": "net-new",
  "boardReview.minIntervalMinutes": "net-new",
  "boardReview.maxPerDay": "net-new",
  "retro.mergesThreshold": "lifted",
  "retro.daysThreshold": "lifted",
  "headroom.curve": "lifted",
  "headroom.reservePct": "lifted",
  "headroom.enabled": "lifted",
  "launchd.throttleIntervalS": "net-new",
  "scratchReap.enabled": "net-new",
  "scratchReap.maxAgeHours": "lifted",
  "worktreeReapBoot.enabled": "net-new",
  "githubEventWake.dedupCapacity": "net-new",
  "githubEventWake.checkSettleMs": "net-new",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse+validate one `origin:` string into its {@link PolicyOriginKind}, by field path.
 *  Exported for the direct unrecognized-field guard test (validatePolicy only ever passes
 *  registered paths, so that defensive branch is unreachable through the public loader). */
export function parseOrigin(path: string, raw: unknown): PolicyFieldOrigin {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PolicyError(`policy.yaml: '${path}.origin' must be a non-empty string, got ${JSON.stringify(raw)}.`);
  }
  const expected = EXPECTED_ORIGIN_KIND[path];
  if (expected === undefined) {
    throw new PolicyError(`policy.yaml: '${path}' is not a recognized policy field.`);
  }
  let kind: PolicyOriginKind;
  if (raw === "net-new") {
    kind = "net-new";
  } else if (raw.startsWith("lifted:") && raw.slice("lifted:".length).trim().length > 0) {
    kind = "lifted";
  } else {
    throw new PolicyError(
      `policy.yaml: '${path}.origin' must be exactly "net-new" or "lifted:<src-site>" (non-empty site), got ${JSON.stringify(raw)}.`,
    );
  }
  if (kind !== expected) {
    throw new PolicyError(
      `policy.yaml: '${path}.origin' must be ${expected === "lifted" ? "lifted:<src-site>" : "net-new"} ` +
        `(got ${JSON.stringify(raw)}) — ${
          expected === "lifted"
            ? "this field's initial value was copied from a real source constant and must cite it"
            : "this field has no prior source literal and must never masquerade as lifted"
        }.`,
    );
  }
  return { path, kind, raw };
}

/** Read+validate one bounded numeric field's `{value, origin, min, max}` row. `bounds`, when
 *  passed, records the row's validated `[min, max]` under `path` — the projection {@link Policy}
 *  carries forward so a runtime write (the override store) reads the committed bound from here
 *  rather than a second, hand-copied literal. */
function numberField(
  path: string,
  raw: unknown,
  origins: Record<string, PolicyFieldOrigin>,
  bounds?: Record<string, PolicyFieldBounds>,
): number {
  if (!isPlainObject(raw)) {
    throw new PolicyError(`policy.yaml: '${path}' must be a mapping with 'value'/'origin'/'min'/'max'.`);
  }
  const { value, origin, min, max } = raw as Record<string, unknown>;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyError(`policy.yaml: '${path}.value' must be a finite number, got ${JSON.stringify(value)}.`);
  }
  // Finite, not merely `typeof === "number"`: a NaN/Infinity bound makes every comparison below
  // false, so an out-of-bounds value would silently be accepted. Why: docs/forensics/policy.md#numberfield--the-finite-bound-trap.
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new PolicyError(
      `policy.yaml: '${path}' must carry numeric 'min' and 'max' bounds — finite ones ` +
        `(got min=${JSON.stringify(min)}, max=${JSON.stringify(max)}); a NaN/Infinity bound would ` +
        "silently disable the bound check rather than widen it.",
    );
  }
  if (min > max) {
    throw new PolicyError(`policy.yaml: '${path}' has min (${min}) > max (${max}) — an unsatisfiable bound.`);
  }
  if (value < min || value > max) {
    throw new PolicyError(
      `policy.yaml: '${path}.value' (${value}) is out of its declared bound [${min}, ${max}].`,
    );
  }
  origins[path] = parseOrigin(path, origin);
  if (bounds) bounds[path] = { min, max };
  return value;
}

/** Read+validate a boolean field's `{value, origin}` row (no min/max — a boolean has no range). */
function booleanField(
  path: string,
  raw: unknown,
  origins: Record<string, PolicyFieldOrigin>,
): boolean {
  if (!isPlainObject(raw)) {
    throw new PolicyError(`policy.yaml: '${path}' must be a mapping with 'value'/'origin'.`);
  }
  const { value, origin } = raw as Record<string, unknown>;
  if (typeof value !== "boolean") {
    throw new PolicyError(`policy.yaml: '${path}.value' must be a boolean, got ${JSON.stringify(value)}.`);
  }
  origins[path] = parseOrigin(path, origin);
  return value;
}

function validateHeadroomCurve(
  raw: unknown,
  origins: Record<string, PolicyFieldOrigin>,
): PolicyHeadroomRung[] {
  const path = "headroom.curve";
  if (!isPlainObject(raw)) {
    throw new PolicyError(`policy.yaml: '${path}' must be a mapping with 'value'/'origin'.`);
  }
  const { value, origin } = raw as Record<string, unknown>;
  if (!Array.isArray(value) || value.length === 0) {
    throw new PolicyError(`policy.yaml: '${path}.value' must be a non-empty array of rungs.`);
  }
  const rungs: PolicyHeadroomRung[] = value.map((rung, i) => {
    if (!isPlainObject(rung)) {
      throw new PolicyError(`policy.yaml: '${path}.value[${i}]' must be a mapping of maxHoursToReset/limitPct.`);
    }
    const { maxHoursToReset, limitPct } = rung as Record<string, unknown>;
    // Number.isFinite, not `typeof === "number"`, for the same NaN-bypasses-every-comparison
    // reason numberField above needs it; Infinity is refused too since `null` is the only
    // spelling of the catch-all rung this schema accepts. Why:
    // docs/forensics/policy.md#validateheadroomcurve--the-naninfinity-rung-trap.
    if (maxHoursToReset !== null && (typeof maxHoursToReset !== "number" || !Number.isFinite(maxHoursToReset) || maxHoursToReset <= 0)) {
      throw new PolicyError(
        `policy.yaml: '${path}.value[${i}].maxHoursToReset' must be null or a finite positive number, got ${JSON.stringify(maxHoursToReset)}.`,
      );
    }
    if (typeof limitPct !== "number" || !Number.isFinite(limitPct) || limitPct < 0 || limitPct > 100) {
      throw new PolicyError(
        `policy.yaml: '${path}.value[${i}].limitPct' must be a finite number in [0, 100], got ${JSON.stringify(limitPct)}.`,
      );
    }
    return { maxHoursToReset: maxHoursToReset as number | null, limitPct };
  });
  if (rungs[rungs.length - 1].maxHoursToReset !== null) {
    throw new PolicyError(`policy.yaml: '${path}.value' must end with a catch-all rung (maxHoursToReset: null).`);
  }
  origins[path] = parseOrigin(path, origin);
  return rungs;
}

/**
 * Validate `armCalibrationBands` (W1-T2579) — optional, absent means `[]`, matching every other
 * optional row's absent-means-default shape. Unlike those, there is no `{value, origin}`
 * wrapper: this is a plain array of rows, each validated strictly at load (a malformed committed
 * row throws, same as any other policy field) — the fail-inert half of this feature lives at the
 * consult site ({@link import("./review.js").decideAutoMergeArm}), not here; see {@link
 * ArmCalibrationBandRow}'s own doc.
 */
function validateArmCalibrationBands(raw: unknown): ArmCalibrationBandRow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PolicyError("policy.yaml: 'armCalibrationBands' must be an array of band rows.");
  }
  return raw.map((row, i) => {
    const path = `armCalibrationBands[${i}]`;
    if (!isPlainObject(row)) {
      throw new PolicyError(`policy.yaml: '${path}' must be a mapping of class/verdict/note.`);
    }
    const { class: cls, verdict, note } = row as Record<string, unknown>;
    if (typeof cls !== "string" || cls.length === 0) {
      throw new PolicyError(`policy.yaml: '${path}.class' must be a non-empty string, got ${JSON.stringify(cls)}.`);
    }
    if (verdict !== "hold" && verdict !== "notify") {
      throw new PolicyError(`policy.yaml: '${path}.verdict' must be "hold" or "notify", got ${JSON.stringify(verdict)}.`);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new PolicyError(`policy.yaml: '${path}.note' must be a string when present, got ${JSON.stringify(note)}.`);
    }
    return { class: cls, verdict, ...(typeof note === "string" ? { note } : {}) };
  });
}

/**
 * Default constants below (`DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS` through
 * `DEFAULT_GITHUB_EVENT_WAKE_CHECK_SETTLE_MS`) share one shape: each mirrors its field's own
 * plan/policy.yaml row (derivation lives there) and is used only when that row is absent from
 * loaded YAML, so an existing policy.yaml fixture keeps loading clean instead of failing on a
 * missing mapping. The two that are exported are also a consumer's own fallback on a path where
 * the committed policy cannot be read at all. Why: docs/forensics/policy.md#default-constants--the-absent-means-default-shape.
 */
const DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS = 559_000;

/** See the shared doc above `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`. Exported: `run-task.ts`'s
 *  `spawnFixWorkerBounded` needs it as its own fallback when a caller supplies no
 *  `deps.spawnWallClockBoundMs`. */
export const DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS = 3_600_000;

/** See the shared doc above `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`. Exported: `worker-home.ts`'s
 *  `acquireKeychainProvisionLock` needs it as its own fallback on the daemon boot path, where the
 *  committed policy may not be readable at all. */
export const DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS = 120_000;

/** See the shared doc above `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`.
 *  PRIMARY CONTROL (W1-T1266): the replay ring evicts on ordinary traffic, with nothing failed
 *  when it does — this is the always-active bound on retained delivery ids, not a last resort. */
export const DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY = 500;

/** See the shared doc above `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`. */
export const DEFAULT_GITHUB_EVENT_WAKE_CHECK_SETTLE_MS = 10_000;

/**
 * Validate a raw (parsed-YAML) value into a {@link Policy}. Throws {@link PolicyError} on any
 * structural violation, out-of-bound value, or origin-kind mismatch — mirrors
 * `src/lib/mounts.ts`'s `validateMounts`/`src/lib/alert-lane.ts`'s `validateAlertPolicy`
 * load-and-validate shape (this repo's existing convention for a plan-level policy YAML).
 */
export function validatePolicy(raw: unknown): Policy {
  if (!isPlainObject(raw)) throw new PolicyError("policy.yaml must be a mapping.");

  const origin: Record<string, PolicyFieldOrigin> = {};
  // Populated only for `sweep.dailyCostCeilingUsd` today — the one field a runtime consumer
  // (W1-T332's override store) validates a write against; see numberField's/Policy.bounds's doc.
  const bounds: Record<string, PolicyFieldBounds> = {};

  const proofTimeoutMs = numberField("proofTimeoutMs", raw.proofTimeoutMs, origin);
  const pruneGraceMs = numberField("pruneGraceMs", raw.pruneGraceMs, origin);
  const worktreeReapGraceMs = numberField("worktreeReapGraceMs", raw.worktreeReapGraceMs, origin);
  const pollIntervalMs = numberField("pollIntervalMs", raw.pollIntervalMs, origin);
  const fixStrikeCap = numberField("fixStrikeCap", raw.fixStrikeCap, origin);
  const workerStall = numberField("workerStall", raw.workerStall, origin);
  const workerAbandon = numberField("workerAbandon", raw.workerAbandon, origin);
  // Optional, absent-means-default shape (see PolicyValues.sweepWallClockBoundMs's doc): only a
  // present row is validated, so a typo in an opted-in row still fails loud.
  const sweepWallClockBoundMsRaw = raw.sweepWallClockBoundMs as Record<string, unknown> | undefined;
  const sweepWallClockBoundMs = sweepWallClockBoundMsRaw
    ? numberField("sweepWallClockBoundMs", sweepWallClockBoundMsRaw, origin)
    : DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS;
  // Same optional shape as sweepWallClockBoundMs immediately above.
  const fixSpawnWallClockBoundMsRaw = raw.fixSpawnWallClockBoundMs as Record<string, unknown> | undefined;
  const fixSpawnWallClockBoundMs = fixSpawnWallClockBoundMsRaw
    ? numberField("fixSpawnWallClockBoundMs", fixSpawnWallClockBoundMsRaw, origin)
    : DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS;
  // Same optional shape as the two rows immediately above.
  const keychainProvisionLockWaitMsRaw = raw.keychainProvisionLockWaitMs as Record<string, unknown> | undefined;
  const keychainProvisionLockWaitMs = keychainProvisionLockWaitMsRaw
    ? numberField("keychainProvisionLockWaitMs", keychainProvisionLockWaitMsRaw, origin)
    : DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS;

  const sweepRaw = raw.sweep;
  if (!isPlainObject(sweepRaw)) throw new PolicyError("policy.yaml: 'sweep' must be a mapping.");
  const staleDays = numberField("sweep.staleDays", sweepRaw.staleDays, origin);
  const sweepStrikeCap = numberField("sweep.strikeCap", sweepRaw.strikeCap, origin);
  const wipLimit = numberField("sweep.wipLimit", sweepRaw.wipLimit, origin);
  const tmpMaxAgeMs = numberField("sweep.tmpMaxAgeMs", sweepRaw.tmpMaxAgeMs, origin);
  const dispatchLanes = numberField("sweep.dispatchLanes", sweepRaw.dispatchLanes, origin);
  const dailyCostCeilingUsd = numberField("sweep.dailyCostCeilingUsd", sweepRaw.dailyCostCeilingUsd, origin, bounds);
  const armSessionPrs = booleanField("sweep.armSessionPrs", sweepRaw.armSessionPrs, origin);
  const armAdhocLaneReap = booleanField("sweep.armAdhocLaneReap", sweepRaw.armAdhocLaneReap, origin);
  const repairFilingThreshold = numberField("sweep.repairFilingThreshold", sweepRaw.repairFilingThreshold, origin);
  const repairFilingWindowDays = numberField("sweep.repairFilingWindowDays", sweepRaw.repairFilingWindowDays, origin);
  const supersessionDisposal = booleanField("sweep.supersessionDisposal", sweepRaw.supersessionDisposal, origin);
  const memoryFloorMib = numberField("sweep.memoryFloorMib", sweepRaw.memoryFloorMib, origin);

  const drainRaw = raw.drain;
  if (!isPlainObject(drainRaw)) throw new PolicyError("policy.yaml: 'drain' must be a mapping.");
  const drainMax = numberField("drain.max", drainRaw.max, origin);

  const retroRaw = raw.retro;
  if (!isPlainObject(retroRaw)) throw new PolicyError("policy.yaml: 'retro' must be a mapping.");
  // Auto-triage is optional, and its absence means off (impl-DJ): a required block would break
  // every existing policy.yaml on load, and "not running" is the safe default for an
  // unsupervised-spend rung. Only a present block is validated, so a typo still fails loud.
  const autoTriageRaw = raw.autoTriage as Record<string, unknown> | undefined;
  const autoTriage = autoTriageRaw
    ? {
        enabled: booleanField("autoTriage.enabled", autoTriageRaw.enabled, origin),
        minIntervalMinutes: numberField("autoTriage.minIntervalMinutes", autoTriageRaw.minIntervalMinutes, origin),
        maxPerDay: numberField("autoTriage.maxPerDay", autoTriageRaw.maxPerDay, origin),
      }
    : { enabled: false, minIntervalMinutes: 60, maxPerDay: 4 };
  // Same optional shape as autoTriage, but defaults to the safe always-on mode (see
  // PolicyValues.measurementCadence's doc for why a read-only cadence's default differs).
  const measurementCadenceRaw = raw.measurementCadence as Record<string, unknown> | undefined;
  const measurementCadence = measurementCadenceRaw
    ? {
        enabled: booleanField("measurementCadence.enabled", measurementCadenceRaw.enabled, origin),
        minIntervalMinutes: numberField("measurementCadence.minIntervalMinutes", measurementCadenceRaw.minIntervalMinutes, origin),
        maxPerDay: numberField("measurementCadence.maxPerDay", measurementCadenceRaw.maxPerDay, origin),
        escalate: booleanField("measurementCadence.escalate", measurementCadenceRaw.escalate, origin),
      }
    : { enabled: true, minIntervalMinutes: 360, maxPerDay: 4, escalate: false };
  // The digest's own cadence row — deliberately separate from measurementCadence above (see
  // PolicyValues.digestCadence's doc). `bounds` is recorded for `minIntervalMinutes` because
  // digest.ts's `digestIntervalOptionsOutOfBounds` validates the console's offered intervals
  // against this same committed bound.
  const digestCadenceRaw = raw.digestCadence as Record<string, unknown> | undefined;
  const digestCadence = digestCadenceRaw
    ? {
        enabled: booleanField("digestCadence.enabled", digestCadenceRaw.enabled, origin),
        minIntervalMinutes: numberField("digestCadence.minIntervalMinutes", digestCadenceRaw.minIntervalMinutes, origin, bounds),
        maxPerDay: numberField("digestCadence.maxPerDay", digestCadenceRaw.maxPerDay, origin),
      }
    : { enabled: true, minIntervalMinutes: 1440, maxPerDay: 24 };
  // The board-review row — same optional, absent-means-default shape as the two cadences above;
  // see PolicyValues.boardReview's doc for where 120/6 come from.
  const boardReviewRaw = raw.boardReview as Record<string, unknown> | undefined;
  const boardReview = boardReviewRaw
    ? {
        enabled: booleanField("boardReview.enabled", boardReviewRaw.enabled, origin),
        minIntervalMinutes: numberField("boardReview.minIntervalMinutes", boardReviewRaw.minIntervalMinutes, origin, bounds),
        maxPerDay: numberField("boardReview.maxPerDay", boardReviewRaw.maxPerDay, origin),
      }
    : { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 };
  const retroMergesThreshold = numberField("retro.mergesThreshold", retroRaw.mergesThreshold, origin);
  const retroDaysThreshold = numberField("retro.daysThreshold", retroRaw.daysThreshold, origin);

  const headroomRaw = raw.headroom;
  if (!isPlainObject(headroomRaw)) throw new PolicyError("policy.yaml: 'headroom' must be a mapping.");
  const curve = validateHeadroomCurve(headroomRaw.curve, origin);
  const reservePct = numberField("headroom.reservePct", headroomRaw.reservePct, origin);
  const headroomEnabled = booleanField("headroom.enabled", headroomRaw.enabled, origin);

  const launchdRaw = raw.launchd;
  if (!isPlainObject(launchdRaw)) throw new PolicyError("policy.yaml: 'launchd' must be a mapping.");
  const throttleIntervalS = numberField("launchd.throttleIntervalS", launchdRaw.throttleIntervalS, origin);

  const scratchReapRaw = raw.scratchReap;
  if (!isPlainObject(scratchReapRaw)) throw new PolicyError("policy.yaml: 'scratchReap' must be a mapping.");
  const scratchReapEnabled = booleanField("scratchReap.enabled", scratchReapRaw.enabled, origin);
  const scratchReapMaxAgeHours = numberField("scratchReap.maxAgeHours", scratchReapRaw.maxAgeHours, origin);

  const worktreeReapBootRaw = raw.worktreeReapBoot;
  if (!isPlainObject(worktreeReapBootRaw)) {
    throw new PolicyError("policy.yaml: 'worktreeReapBoot' must be a mapping.");
  }
  const worktreeReapBootEnabled = booleanField("worktreeReapBoot.enabled", worktreeReapBootRaw.enabled, origin);

  // Optional, same absent-means-default shape as sweepWallClockBoundMs/fixSpawnWallClockBoundMs
  // above — only a present row is validated, so a typo in an opted-in row still fails loud.
  const githubEventWakeRaw = raw.githubEventWake as Record<string, unknown> | undefined;
  const githubEventWakeDedupCapacity = githubEventWakeRaw
    ? numberField("githubEventWake.dedupCapacity", githubEventWakeRaw.dedupCapacity, origin, bounds)
    : DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY;
  const githubEventWakeCheckSettleMs = githubEventWakeRaw?.checkSettleMs !== undefined
    ? numberField("githubEventWake.checkSettleMs", githubEventWakeRaw.checkSettleMs, origin, bounds)
    : DEFAULT_GITHUB_EVENT_WAKE_CHECK_SETTLE_MS;

  // W1-T2579: optional, absent means `[]` — see validateArmCalibrationBands's own doc for why
  // this row is stricter-at-load/inert-at-consult rather than the triplet shape above.
  const armCalibrationBands = validateArmCalibrationBands(raw.armCalibrationBands);

  return {
    values: {
      proofTimeoutMs,
      pruneGraceMs,
      worktreeReapGraceMs,
      pollIntervalMs,
      fixStrikeCap,
      workerStall,
      workerAbandon,
      sweepWallClockBoundMs,
      fixSpawnWallClockBoundMs,
      keychainProvisionLockWaitMs,
      sweep: {
        staleDays,
        strikeCap: sweepStrikeCap,
        wipLimit,
        tmpMaxAgeMs,
        dispatchLanes,
        dailyCostCeilingUsd,
        armSessionPrs,
        armAdhocLaneReap,
        repairFilingThreshold,
        repairFilingWindowDays,
        supersessionDisposal,
        memoryFloorMib,
      },
      drain: { max: drainMax },
      retro: { mergesThreshold: retroMergesThreshold, daysThreshold: retroDaysThreshold },
      autoTriage,
      measurementCadence,
      digestCadence,
      boardReview,
      headroom: { curve, reservePct, enabled: headroomEnabled },
      launchd: { throttleIntervalS },
      scratchReap: { enabled: scratchReapEnabled, maxAgeHours: scratchReapMaxAgeHours },
      worktreeReapBoot: { enabled: worktreeReapBootEnabled },
      githubEventWake: {
        dedupCapacity: githubEventWakeDedupCapacity,
        checkSettleMs: githubEventWakeCheckSettleMs,
      },
      armCalibrationBands,
    },
    origin,
    bounds,
  };
}

/** Default location of the table, under a repo/workspace root. */
export function policyPath(root: string): string {
  return join(root, "plan", "policy.yaml");
}

/** Load, parse, and validate `plan/policy.yaml` (or any path) into a {@link Policy}. Pure and
 *  deterministic — two loads of the same file yield identical values (test/policy.test.ts). */
export function loadPolicy(path: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new PolicyError(`policy.yaml is not valid YAML (${path}): ${String(err)}`);
  }
  return validatePolicy(raw);
}

/**
 * Absolute path to this installation's `plan/policy.yaml`, resolved from this module's own file
 * location, never `process.cwd()` — so a consumer with no `repoRoot` of its own still resolves
 * the same file `run-task.ts`'s `resolveRepoRoot` does. Why: docs/forensics/policy.md#installpolicypath.
 */
export function installPolicyPath(): string {
  return policyPath(join(fileURLToPath(new URL(".", import.meta.url)), "..", ".."));
}

let cachedDefaultPolicy: Policy | undefined;

/** The policy at {@link installPolicyPath}, loaded once and memoized for the process's lifetime
 *  (`src/lib/config.ts`'s `Config` uses the same shape). A caller or test can still inject its
 *  own value instead. */
export function loadDefaultPolicy(): Policy {
  if (!cachedDefaultPolicy) cachedDefaultPolicy = loadPolicy(installPolicyPath());
  return cachedDefaultPolicy;
}

// ── Daily-cost-ceiling override store (W1-T332) ─────────────────────────────────────────────
// A runtime-tunable value belongs in a store the console can write at runtime, not the committed
// `plan/policy.yaml` behind a PR and a deploy (operator ruling 2026-08-04) — reuses
// `fleet-control.ts`'s `state/PAUSE` precedent: a flag file under `<root>/state/`, outside git,
// surviving every `pull --ff-only`. One value, one store, one precedence rule: an override under
// `state/` wins; its absence means the committed default. A malformed/unreadable override falls
// back to the default and reports why via {@link EffectiveDailyCostCeiling.fallback} — never
// silently zero, unbounded, or absent-and-fine.
// Why: docs/forensics/policy.md#the-daily-cost-ceiling-override-store.

/** One provenance-carrying read of the daily cost ceiling. `"instance-share"` (W1-T408) is a
 *  third arm, not a layer over the other two — see that section below for why it wins outright. */
export type DailyCostCeilingProvenance = "overridden" | "default" | "instance-share";

/** Why a stored override was not used; present only when one existed but was refused. */
export interface DailyCostCeilingFallback {
  reason: string;
}

/** The daily cost ceiling as a live reader should use it: never the bare number. */
export interface EffectiveDailyCostCeiling {
  usd: number;
  provenance: DailyCostCeilingProvenance;
  /** `policy.values.sweep.dailyCostCeilingUsd`, carried alongside so an overridden reading
   *  shows what it was overridden FROM. */
  committedDefaultUsd: number;
  /** Set only when an on-disk override existed but was malformed/unreadable/out of bound. */
  fallback?: DailyCostCeilingFallback;
  /** W1-T408: set, equal to `usd`, only when `provenance === "instance-share"` — its own field
   *  so a reader never infers it from a string comparison. */
  instanceShareUsd?: number;
  /** W1-T408: the instance this reading belongs to, set alongside `instanceShareUsd`. */
  instanceLabel?: string;
}

/** One written override, as persisted under `state/`. */
export interface DailyCostCeilingOverrideRecord {
  usd: number;
  setAt: string;
}

/** `state/PAUSE`-shaped in location and lifetime (fleet-control.ts) — outside git, survives
 *  every `pull --ff-only`. Carries the daily cost ceiling only: this is not a general
 *  key-value store. */
export function dailyCostCeilingOverridePath(root: string): string {
  return join(root, "state", "DAILY_COST_CEILING_OVERRIDE");
}

/** Write the `state/`-resident override, validated against the committed
 *  `sweep.dailyCostCeilingUsd` bound — an out-of-bound (or non-finite) value is refused here, at
 *  write time, throwing {@link PolicyError} and performing no write. */
export function writeDailyCostCeilingOverride(root: string, usd: number, policy: Policy): DailyCostCeilingOverrideRecord {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new PolicyError(`daily cost ceiling override must be a finite number, got ${JSON.stringify(usd)}.`);
  }
  const bound = policy.bounds["sweep.dailyCostCeilingUsd"];
  if (!bound) {
    throw new PolicyError(
      "daily cost ceiling override: policy carries no 'sweep.dailyCostCeilingUsd' bound to validate against " +
        "(is this a Policy from validatePolicy(), not a hand-built object?).",
    );
  }
  if (usd < bound.min || usd > bound.max) {
    throw new PolicyError(
      `daily cost ceiling override ${usd} is out of the committed plan/policy.yaml bound ` +
        `[${bound.min}, ${bound.max}] — refused at write time, never clamped or accepted.`,
    );
  }
  const record: DailyCostCeilingOverrideRecord = { usd, setAt: new Date().toISOString() };
  const path = dailyCostCeilingOverridePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
  return record;
}

/** Clear a written override (revert to the committed default). Idempotent — clearing an
 *  already-absent override is not an error, mirroring fleet-control.ts's `clearFlag`. */
export function clearDailyCostCeilingOverride(root: string): boolean {
  const path = dailyCostCeilingOverridePath(root);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false; // another actor cleared it concurrently — treat as already-clear
  }
}

/** Resolve the effective daily cost ceiling: the `state/` override if it exists, is well-formed,
 *  and is within the committed bound; the committed default otherwise. The one function a live
 *  reader (daemon reload W1-T331; console render W1-T333) should call — never a raw file read. */
export function resolveDailyCostCeiling(root: string, policy: Policy): EffectiveDailyCostCeiling {
  const committedDefaultUsd = policy.values.sweep.dailyCostCeilingUsd;
  const path = dailyCostCeilingOverridePath(root);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No override was ever written (or the state/ root vanished) — the absence case: reads as
      // the committed default, no fallback report. Why: docs/forensics/policy.md#resolvedailycostceiling--the-enoent-case.
      return { usd: committedDefaultUsd, provenance: "default", committedDefaultUsd };
    }
    return {
      usd: committedDefaultUsd,
      provenance: "default",
      committedDefaultUsd,
      fallback: { reason: `override file at ${path} could not be read (${code ?? String(err)}) — falling back to the committed default` },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      usd: committedDefaultUsd,
      provenance: "default",
      committedDefaultUsd,
      fallback: { reason: `override file at ${path} is not valid JSON (${String(err)}) — falling back to the committed default` },
    };
  }

  const usd = isPlainObject(parsed) ? parsed.usd : undefined;
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    return {
      usd: committedDefaultUsd,
      provenance: "default",
      committedDefaultUsd,
      fallback: {
        reason: `override file at ${path} is malformed — 'usd' must be a finite number, got ${JSON.stringify(usd)} — falling back to the committed default`,
      },
    };
  }

  const bound = policy.bounds["sweep.dailyCostCeilingUsd"];
  if (bound && (usd < bound.min || usd > bound.max)) {
    return {
      usd: committedDefaultUsd,
      provenance: "default",
      committedDefaultUsd,
      fallback: {
        reason: `override ${usd} at ${path} is out of the committed bound [${bound.min}, ${bound.max}] — falling back to the committed default`,
      },
    };
  }

  return { usd, provenance: "overridden", committedDefaultUsd };
}

// ── Per-instance share (W1-T408) ────────────────────────────────────────────────────────────
// The daily ceiling above is per instance, not per fleet: two containers each reading
// `resolveDailyCostCeiling` independently both stop at the same committed figure, and the real
// bill is double it. A configured share wins outright over both the committed default and a
// written override, and does not merge with them; unset behaves exactly as before this feature
// existed (test/cost-ceiling-default-unchanged.test.ts). Why: docs/forensics/policy.md#the-per-instance-share-w1-t408.

/** The env var an operator sets, per container, to this instance's slice of the fleet's daily
 *  ceiling — e.g. two containers each at `250` divide a committed `500` in half. Validated
 *  against the same bound {@link writeDailyCostCeilingOverride} validates against. */
export const DAILY_COST_CEILING_SHARE_ENV_VAR = "REMUDERO_DAILY_COST_CEILING_SHARE_USD";

/** The env var naming this instance, carried alongside a configured share — see {@link
 *  EffectiveDailyCostCeiling.instanceLabel}. Defaults to `os.homedir()` when unset. */
export const DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR = "REMUDERO_INSTANCE_LABEL";

/** One instance's configured share of the fleet's daily ceiling — see the section header above. */
export interface DailyCostCeilingInstanceShare {
  usd: number;
  instanceLabel: string;
}

/** Read this instance's configured share, if any, from `env` (defaults to `process.env`).
 *  Returns `undefined` — resolve exactly as unset — when the var is absent/blank, non-numeric,
 *  or out of the committed bound; a malformed value is ignored, never thrown. */
export function resolveDailyCostCeilingInstanceShare(
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env,
): DailyCostCeilingInstanceShare | undefined {
  const raw = env[DAILY_COST_CEILING_SHARE_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return undefined;
  const usd = Number(raw);
  if (!Number.isFinite(usd)) return undefined;
  const bound = policy.bounds["sweep.dailyCostCeilingUsd"];
  if (bound && (usd < bound.min || usd > bound.max)) return undefined;
  const instanceLabel = env[DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR]?.trim() || homedir();
  return { usd, instanceLabel };
}

/** The daily cost ceiling as this instance should enforce it: {@link resolveDailyCostCeiling}'s
 *  reading, unless a configured share exists, in which case it wins and `provenance` reads
 *  `"instance-share"`. Pure — makes no ledger read and no dispatch decision itself;
 *  `run-task.ts`'s `dailyCostCeilingReloader` is the one place this becomes the live governor
 *  input (W1-T331). */
export function resolveDailyCostCeilingForInstance(
  root: string,
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveDailyCostCeiling {
  const base = resolveDailyCostCeiling(root, policy);
  const share = resolveDailyCostCeilingInstanceShare(policy, env);
  if (!share) return base;
  return {
    ...base,
    usd: share.usd,
    provenance: "instance-share",
    instanceShareUsd: share.usd,
    instanceLabel: share.instanceLabel,
  };
}
