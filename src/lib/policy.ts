import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * The fleet's operating-constants policy, loaded as DATA (W1-T252, P37 SUBSTRATE — the P34
 * ruling that the operating envelope belongs in policy data, not scattered source literals).
 * SAME load-and-validate house pattern `src/lib/mounts.ts`/`src/lib/alert-lane.ts` already use:
 * parse with the `yaml` package, validate into a typed shape, throw a named error on any
 * structural or semantic violation — never a second, ad hoc loader.
 *
 * THIS MODULE IS THE SUBSTRATE ONLY (files: plan/policy.yaml, src/lib/policy.ts,
 * test/policy.test.ts — W1-T252). No consumer site reads from {@link loadPolicy} yet;
 * W1-T253 (P37 CONSUMERS, depends_on this task) rewires review.ts/worker.ts/daemon.ts/
 * sweep.ts/drain.ts/launchd.ts to read every field below instead of their current source
 * literals. `loadPolicy` is deterministic and pure (two loads of the same file yield
 * identical values) so that rewiring is a drop-in read, not a new I/O shape to design.
 *
 * PROVENANCE, per field (`origin`): every LIFTED field's YAML row carries `lifted:<src-site>`
 * naming the exact current-source constant it was copied from (verified against source at
 * authoring time, OPERATOR RULING 2026-07-23) — {@link EXPECTED_ORIGIN_KIND} pins each named
 * field to the kind (`lifted` or `net-new`) it is REQUIRED to carry, so a fixture cannot
 * silently relabel a lifted constant as net-new (hiding its real source) or a net-new field
 * as lifted (inventing a source that never existed) — both directions are checked, by name,
 * at load. `launchd.throttleIntervalS` is the ONE net-new field this file carries: no
 * `ThrottleInterval` literal exists in `src/lib/launchd.ts`'s daemon-unit generator today.
 *
 * BOUNDS: every numeric field's YAML row carries `min`/`max` traveling WITH the value — an
 * out-of-bounds `value` is refused at load, named by field, so a value change rides a
 * reviewed plan PR (the bound is legible in the diff) rather than an unbounded edit. THE 30000
 * REGRESSION (operator ruling, binding): `proofTimeoutMs.min` is pinned to 60000 — the value
 * already live at `src/lib/review.ts:675` — so a policy carrying the stale, pre-merge 30000
 * proof-timeout figure fails this ordinary bound check for exactly the reason it must: it is a
 * regression below the live source value, never a merely-smaller tuning choice.
 */

/** A single headroom-ceiling curve rung (`src/lib/daemon.ts`'s `buildDefaultHeadroomPolicy`
 *  shape) — `maxHoursToReset: null` is the catch-all last rung (mirrors `Infinity` in source). */
export interface PolicyHeadroomRung {
  maxHoursToReset: number | null;
  limitPct: number;
}

/**
 * One OPERATOR-RATIFIED row of {@link PolicyValues.armCalibrationBands} (W1-T2579) — see that
 * field's own doc for the seam this feeds. `class` names a {@link
 * import("./verdict-calibration.js").VerdictClass} `decideAutoMergeArm` (src/lib/review.ts) may
 * band: only `"full-pass"`/`"keyword-floor"` are ever consulted — `"degraded-arm"` (the CAPPED
 * class) is refused eligibility BY CONSTRUCTION, at the call site, never by validation here, so
 * a row naming it simply never matches anything. `verdict: "hold"` refuses the arm; `"notify"`
 * arms and carries `note` in the decision reason. Loaded STRICTLY (a row that fails this shape
 * check throws {@link PolicyError} at load, same as every other policy row) — the fail-INERT
 * half of this feature lives entirely in `decideAutoMergeArm`'s own runtime consult (a
 * shape-valid row naming a class the caller does not resolve, or a bands array injected directly
 * by a caller that bypassed this loader, is what stays inert there), not in tolerating a
 * malformed COMMITTED ratification.
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
   *  PolicyValues.pruneGraceMs}, which six run-start `pruneStaleRuns` call sites consume. */
  worktreeReapGraceMs: number;
  pollIntervalMs: number;
  fixStrikeCap: number;
  /** W1-T943: the WORKER-STALL detector's quiet threshold — how long a LIVE in-flight run's
   *  newest `worker.state` row (W1-T942) may age before that run is judged stalled and
   *  escalated once through §4 (src/run-task.ts's `runWorkerStallDetectorRung`). NET-NEW: no
   *  prior source literal ever measured this. See plan/policy.yaml's own row for why the
   *  default sits comfortably above the ~16-minute `--ci-parity` suite (W1-T463/W1-T465). */
  workerStall: number;
  /** W1-T1045: THE CLOCK BOUND — how long a dispatch worker's SDK stream may go silent (no
   *  observed `worker.state` activity) before `src/lib/worker.ts`'s clock-bound watchdog aborts
   *  it and `src/run-task.ts` ends the run with a terminal verdict. NET-NEW: no prior source
   *  literal ever measured this. See plan/policy.yaml's own row for why the default equals
   *  #2251's recycle kill predicate over the same measured population. */
  workerAbandon: number;
  /** W1-T1044: the WALL-CLOCK BOUND (ms) on `await deps.sweep()` (daemon.ts's poll loop) — see
   *  this field's plan/policy.yaml row for the measured healthy-vs-hung derivation. W1-T1219
   *  split ONE fix-rung worker spawn inside `runFixRung` (run-task.ts) OFF this field onto its
   *  own {@link PolicyValues.fixSpawnWallClockBoundMs} row — a sweep tick and an implement-class
   *  worker spawn are different populations (see that field's own doc), so retuning one must
   *  never move the other. OPTIONAL in the committed row (same absent-means-default shape as
   *  {@link PolicyValues.autoTriage}): an existing policy.yaml missing this row resolves to
   *  {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}. */
  sweepWallClockBoundMs: number;
  /** W1-T1219: the WALL-CLOCK BOUND (ms) on ONE fix-rung worker spawn inside `runFixRung`
   *  (run-task.ts) — split OFF {@link PolicyValues.sweepWallClockBoundMs}: a sweep tick (a
   *  poll-loop classification pass over an already-fetched rollup) and a fix-rung spawn (an
   *  implement-class Claude worker that reads a diff, edits source and commits) are different
   *  populations, so one policy row can no longer bound both. See this field's plan/policy.yaml
   *  row for why the committed value is INTERIM — the population needed to derive the real one
   *  could not be measured until this same task started recording it. OPTIONAL in the committed
   *  row (same absent-means-default shape as {@link PolicyValues.autoTriage}): an existing
   *  policy.yaml missing this row resolves to {@link DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS}. */
  fixSpawnWallClockBoundMs: number;
  sweep: {
    staleDays: number;
    strikeCap: number;
    wipLimit: number;
    /** W1-T320: the rmd-owned temp-dir backstop's age ceiling (src/lib/tmp.ts's
     *  sweepStaleTempDirs) — see this field's plan/policy.yaml row for the incident
     *  that made the ceiling policy data instead of a source literal. */
    tmpMaxAgeMs: number;
    /** W1-T325: the concurrent dispatch-lane count `rmd drain` fills per pass
     *  (W1-T172/P19) — a RELOCATION of the pre-existing source literal, not a retune. */
    dispatchLanes: number;
    /** W1-T330: the daily spend ceiling (W1-T148 COST GOVERNOR) — see this field's
     *  plan/policy.yaml row for the incident that made retuning it a plan PR instead of a
     *  src/ edit + CI + deploy. A RELOCATION of the pre-existing source literal, not a retune. */
    dailyCostCeilingUsd: number;
    /** W1-T516: gates whether the SWEEP arms a PR that carries no plan task id (a session
     *  filing) under the same synthetic `PR-<n>` id the review/escalation lanes already mint
     *  (`escalationTaskIdFor`). DEFAULT OFF — see this field's plan/policy.yaml row for what
     *  turning it on actually admits (a capped, plan-only PR merges on structural checks
     *  alone, with zero executed proofs). NET-NEW: no prior source literal ever gated this;
     *  the sweep's arm dep simply passed `pr.taskId` raw. */
    armSessionPrs: boolean;
    /** W1-T905: the RECURRENCE count — a classified surface (a `sweep.disposed` row's own
     *  `disposition`) that a `sweep.disposed acted: true` row names at least this many DISTINCT
     *  PRs for, inside {@link PolicyValues.sweep.repairFilingWindowDays}, is due for exactly ONE
     *  `repair#<surface>` §7B feedback entry — "one occurrence is a repair, a recurrence is a
     *  defect." NET-NEW: no prior source literal ever counted this. */
    repairFilingThreshold: number;
    /** W1-T905: the RECURRENCE window (days) {@link PolicyValues.sweep.repairFilingThreshold}
     *  counts distinct-PR repairs within — see that field's doc. NET-NEW. */
    repairFilingWindowDays: number;
    /** W1-T920: gates the SUPERSESSION disposition (lib/sweep.ts's `DISPOSITION_RULES`,
     *  the `pr.supersessionVerdict.status === "superseded"` row) — DEFAULT OFF, copying
     *  `armSessionPrs`'s own shape immediately above. See this field's plan/policy.yaml row
     *  for why the off path is byte-for-byte today's behaviour and why turning it on still
     *  changes nothing in production until a (separate, out-of-scope) detector populates
     *  `OpenPrView.supersessionVerdict`. NET-NEW: no prior source literal ever gated this. */
    supersessionDisposal: boolean;
    /** W1-T1038: the DISPATCH-PATH memory floor, in MiB of `/proc/meminfo`'s `MemAvailable` —
     *  below this figure, NEW dispatch is deferred; drainage is never gated (the same
     *  dispatch-only asymmetry every other field in this table already documents). SHIPS AT 0
     *  (see this field's own plan/policy.yaml row): `MemAvailable` can never read below zero, so
     *  the shipped default defers nothing until an operator raises it against a measured figure —
     *  the 2026-08-19 host stall's own rationale is explicit that no such figure exists yet.
     *  See {@link checkMemoryGovernor}, this row's consumer (sweep.ts). */
    memoryFloorMib: number;
  };
  drain: {
    max: number;
  };
  /** The daemon's retro cadence trigger (W1-T264) — {@link RetroTriggerPolicy}'s two
   *  fields, lifted off `src/lib/retro.ts`'s `DEFAULT_RETRO_MERGES_THRESHOLD`/
   *  `DEFAULT_RETRO_DAYS_THRESHOLD` source literals. */
  retro: {
    mergesThreshold: number;
    daysThreshold: number;
  };
  /** The daemon's auto-triage rung (recon-DC #2). DEFAULT OFF — it spends unsupervised.
   *  W1-T475 deleted the W1-T318 adaptive-cadence curve (`maxIntervalMinutes`/`depthFloor`/
   *  `depthCeiling`): it was a second, weaker governor on the quantity `maxPerDay` already bounds
   *  exactly, keyed to a depth proxy uncorrelated with capacity. `minIntervalMinutes` survives as
   *  the fixed floor — it used to reach the decision ONLY through that curve. */
  autoTriage: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
  };
  /** W1-T1259: the daemon's measurement-cadence rung — `rule-efficacy`, `verdict-calibration`
   *  and `autonomy-rate` were merged, host-side, and reachable only by an operator typing them.
   *  OPTIONAL, absent-means-default like {@link PolicyValues.autoTriage}, but the DEFAULT here
   *  is the SAFE mode already ON (`enabled: true`) — unlike autoTriage, which spends
   *  unsupervised, the base cadence runs only read-only reports (`verdict-calibration`/
   *  `autonomy-rate` carry no write symbol at all; `rule-efficacy` runs its `--no-escalate`
   *  form). `escalate` is the SEPARATE, opted-in flag for `rule-efficacy`'s ONE write (a
   *  promote-to-instrument proposal, never a filed task — Law 5) and ships OFF, mirroring
   *  `autoTriage.enabled`'s own off-by-default posture for anything that writes. */
  measurementCadence: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
    escalate: boolean;
  };
  /** W1-T2277: the daemon's digest cadence rung — its OWN row, deliberately separate from
   *  {@link PolicyValues.measurementCadence} above, so a short digest interval can never drag
   *  `rule-efficacy`/`verdict-calibration`/`autonomy-rate` to it (or vice versa). No `escalate`
   *  field: the digest only reads and sends, it never drafts a proposal. OPTIONAL, same
   *  absent-means-default shape as `measurementCadence`, defaulting to the SAFE always-on daily
   *  cadence (`enabled: true`, once per day) — sending a digest spends nothing and writes
   *  nothing (Law 5), so it is safe to run unattended from the start. */
  digestCadence: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxPerDay: number;
  };
  /** W1-T2304's board-review rung — its OWN row, deliberately separate from
   *  {@link PolicyValues.measurementCadence} and {@link PolicyValues.digestCadence}, so the three
   *  cadences can never drag one another. No `escalate` field: this rung drafts proposals through
   *  the registry unconditionally when it finds something, and drafting a proposal is the whole
   *  point of the rung rather than an opt-in side effect.
   *
   *  THE VALUES ARE DERIVED, not copied from a sibling. `minIntervalMinutes: 120` is read off the
   *  board's own behaviour: on 2026-08-26 the depth trigger was continuously satisfied for 2h26m
   *  (#2895 aged past the 8h bar at 08:55Z and stayed open until 16:20:51Z, with two reds landing
   *  inside the same stretch). At 120m that stretch yields TWO reports — one when the condition
   *  appears and one confirming it persisted — rather than one per poll, which for a condition an
   *  operator can only act on every hour or so is noise, not signal. `maxPerDay: 6` bounds a
   *  pathological day (a board red from morning to night) to twelve hours of coverage at that
   *  interval and caps the cost at six whole-board reads. Both sit deliberately between
   *  `measurementCadence` (360m / 4, a heavy ledger+git join over history that moves slowly) and a
   *  per-tick check: the board changes faster than the ledger's shape does, and slower than a poll.
   *
   *  ABSENT ⇒ the same safe defaults, matching every other cadence's absent-means-default shape.
   *  Defaults to ENABLED because the rung is read-only: it writes one report artifact and drafts
   *  registry proposals, and nothing it produces files a task ITSELF — the rung's own scope, not a
 *  rule forbidding it. W1-T2456: this said "Rule 15 still stands"; §12 rule 15 is the
 *  acceptance-criteria goalpost rule and rule 27 now PERMITS automatic filing. */
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
  /** The boot-time abandoned-review-clone reap (impl-EK). DEFAULT OFF — it DELETES, so the
   *  operator turns it on; until then the boot pass surveys and ledgers, removing nothing. */
  scratchReap: {
    enabled: boolean;
    maxAgeHours: number;
  };
  /** W1-T406: the one-shot `rmd run-task` boot rung for {@link reapStaleWorktrees} — same
   *  ship-off posture as {@link PolicyValues.scratchReap}, and for the same reason: it
   *  DELETES, so it begins OFF, surveying and ledgering what it would reclaim until an
   *  operator has read enough boots' worth of dispositions to arm it. No age field of its
   *  own — the rung reuses {@link DEFAULT_WORKTREE_REAP_GRACE_MS} (`worktreeReapGraceMs`
   *  above), the SAME ceiling the daemon poll / `rmd sweep` call sites already use. */
  worktreeReapBoot: {
    enabled: boolean;
  };
  /** W1-T2568: the GitHub-event wake's bounded recent-delivery dedup window (see
   *  `github-event-wake.ts`'s `createDeliveryDedupStore`) — how many distinct `X-GitHub-Delivery`
   *  ids the webhook route remembers before evicting the oldest. THE bounded row design (iv)
   *  calls for ("the debounce is a bounded plan/policy.yaml row, not a literal beside
   *  fs.watch"): a redelivery/replay burst is refused as a duplicate only while its delivery id
   *  is still in this window, so the bound is a real, reviewed tuning knob, not a source
   *  literal. OPTIONAL, absent-means-default like {@link PolicyValues.sweepWallClockBoundMs}. */
  githubEventWake: {
    dedupCapacity: number;
    /** W1-T2741: trailing-edge quiet period for high-fanout check/status deliveries. */
    checkSettleMs: number;
  };
  /**
   * W1-T2579 — THE ARM GATE'S OPERATOR-RATIFIED BAND TABLE. `decideAutoMergeArm`
   * (src/lib/review.ts) consults this AFTER its existing refusals, on the already-arming
   * `full-pass`/`keyword-floor` path only — it can hold or annotate what today arms, never
   * arm what today refuses (the CAPPED class and the operator-override path are evaluated
   * before this table and are untouchable by it). SHIPS EMPTY, deliberately (design (iv)):
   * `verdict-calibration.ts` (W1-T424) and `measurement_cadence` (W1-T1259) MEASURE per-class
   * outcomes but never WRITE this table — a figure reaches a band only through a plan PR an
   * operator merges. OPTIONAL, same absent-means-default shape as every other cadence row in
   * this file, but the default is `[]` (not a triplet) — an absent table and an empty table are
   * BYTE-IDENTICAL to no table at all, the fail-inert contract this row's whole existence rests
   * on (test/arm-calibration-bands.test.ts).
   */
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
  /**
   * Dotted field path -> its committed `min`/`max` bounds, for every bounded numeric field.
   * A CONSUMER (W1-T332's `state/`-resident daily-cost-ceiling override, currently the only
   * one) validates a runtime write against THESE, never a second, hand-copied `{min, max}` —
   * the committed row in `plan/policy.yaml` stays the one schema.
   */
  bounds: Record<string, PolicyFieldBounds>;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Every field this policy carries, pinned to the origin KIND it is REQUIRED to have.
 * `lifted` fields must cite a real source site; `net-new` fields must not. Both directions
 * are enforced by {@link validatePolicy} — a fixture that flips either FAILS (test/policy.test.ts).
 */
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
  "sweep.staleDays": "lifted",
  "sweep.strikeCap": "lifted",
  "sweep.wipLimit": "lifted",
  "sweep.tmpMaxAgeMs": "net-new",
  "sweep.dispatchLanes": "lifted",
  "sweep.dailyCostCeilingUsd": "lifted",
  "sweep.armSessionPrs": "net-new",
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
  // FINITE, not merely `typeof === "number"`: YAML's `.nan`/`.inf` parse to NaN/Infinity, and a
  // NaN bound makes EVERY comparison below false — `min > max`, `value < min`, `value > max` — so
  // the declared bound silently stops binding and any value is accepted. That is not a theoretical
  // hole: with `proofTimeoutMs.min: .nan` a policy carrying the stale 30000 proof timeout loads
  // clean, which is exactly the regression the operator's binding ruling says must be refused. A
  // bound that cannot bind is a malformed bound, so it is refused here by name.
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
    // Number.isFinite, not `typeof === "number"`, for the SAME reason numberField above needs it:
    // NaN passes every range test by failing every comparison. A `maxHoursToReset: .nan` rung would
    // load clean and then never match in resolveHeadroomLimitPct's `hoursToReset <= r.maxHours`
    // (a silently dead rung); a `limitPct: .nan` would load clean and yield a NaN CEILING, which
    // every headroom comparison then silently fails. Infinity is refused here too: `null` is the
    // only spelling of the catch-all rung this schema accepts (see the final-rung check below), so
    // an `Infinity` rung in a non-final position would swallow every rung after it.
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
 * Validate `armCalibrationBands` (W1-T2579) — OPTIONAL, absent means `[]`, matching every
 * other optional row's absent-means-default shape (`autoTriage` etc., above). UNLIKE those,
 * there is no single `{value, origin}` wrapper: this is a plain array of rows, each own its
 * own shape — so a PRESENT row is validated STRICTLY (a malformed COMMITTED row throws, same
 * as any other policy field) while the fail-INERT half of this feature lives at the consult
 * site ({@link import("./review.js").decideAutoMergeArm}), not here — see {@link
 * ArmCalibrationBandRow}'s own doc for why that split is deliberate.
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
 * W1-T1044: DEFAULT `sweepWallClockBoundMs` — mirrors plan/policy.yaml's own row (net-new;
 * derivation in that file's comment). Used ONLY when the row is ABSENT from the loaded YAML —
 * the SAME absent-means-default shape `autoTriage`'s optional block already uses just below,
 * so an existing `policy.yaml` fixture that predates this task keeps loading clean rather than
 * failing on a missing mapping.
 */
const DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS = 559_000;

/**
 * W1-T1219: DEFAULT `fixSpawnWallClockBoundMs` — mirrors plan/policy.yaml's own row (net-new;
 * derivation, and why it is INTERIM, in that file's comment). Used ONLY when the row is ABSENT
 * from the loaded YAML — the SAME absent-means-default shape {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}
 * above already uses, so an existing `policy.yaml` fixture that predates this task keeps loading
 * clean rather than failing on a missing mapping. EXPORTED (unlike the sibling constant above)
 * because `src/run-task.ts`'s `spawnFixWorkerBounded` — the ONE consumer of this bound — needs
 * it as its own fallback when a caller supplies no `deps.spawnWallClockBoundMs` at all, the same
 * role `daemon.ts`'s OWN `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS` plays for the sweep-tick bound.
 */
export const DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS = 3_600_000;

/**
 * W1-T2568: DEFAULT `githubEventWake.dedupCapacity` — mirrors plan/policy.yaml's own row
 * (net-new; derivation in that file's comment). Used ONLY when the row is ABSENT from the
 * loaded YAML, the SAME absent-means-default shape {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}
 * above already uses, so an existing `policy.yaml` fixture that predates this task keeps
 * loading clean rather than failing on a missing mapping.
 *
 * PRIMARY CONTROL (W1-T1266): the replay ring evicts on ordinary traffic, with nothing failed
 * when it does — this is the always-active bound on retained delivery ids, not a last resort.
 */
export const DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY = 500;

/**
 * W1-T2741: default trailing-edge quiet period for terminal check/status webhook bursts.
 * The committed policy row owns the derivation and bounds; this fallback preserves loading for
 * older policy fixtures that predate the row.
 */
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
  // Populated ONLY for `sweep.dailyCostCeilingUsd` today (the one field a runtime consumer,
  // W1-T332's override store, validates a write against) — see numberField's/Policy.bounds's
  // doc for why this is a projection of the committed row, not a second copy of it.
  const bounds: Record<string, PolicyFieldBounds> = {};

  const proofTimeoutMs = numberField("proofTimeoutMs", raw.proofTimeoutMs, origin);
  const pruneGraceMs = numberField("pruneGraceMs", raw.pruneGraceMs, origin);
  const worktreeReapGraceMs = numberField("worktreeReapGraceMs", raw.worktreeReapGraceMs, origin);
  const pollIntervalMs = numberField("pollIntervalMs", raw.pollIntervalMs, origin);
  const fixStrikeCap = numberField("fixStrikeCap", raw.fixStrikeCap, origin);
  const workerStall = numberField("workerStall", raw.workerStall, origin);
  const workerAbandon = numberField("workerAbandon", raw.workerAbandon, origin);
  // W1-T1044: OPTIONAL, same absent-means-default shape as `autoTriage` below — only a
  // PRESENT row is validated, so a typo in an opted-in row still fails loud, but an existing
  // policy.yaml missing this row entirely still loads clean.
  const sweepWallClockBoundMsRaw = raw.sweepWallClockBoundMs as Record<string, unknown> | undefined;
  const sweepWallClockBoundMs = sweepWallClockBoundMsRaw
    ? numberField("sweepWallClockBoundMs", sweepWallClockBoundMsRaw, origin)
    : DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS;
  // W1-T1219: OPTIONAL, same absent-means-default shape as `sweepWallClockBoundMs` immediately
  // above (and `autoTriage` below) — a fixture that predates this task's split still loads clean.
  const fixSpawnWallClockBoundMsRaw = raw.fixSpawnWallClockBoundMs as Record<string, unknown> | undefined;
  const fixSpawnWallClockBoundMs = fixSpawnWallClockBoundMsRaw
    ? numberField("fixSpawnWallClockBoundMs", fixSpawnWallClockBoundMsRaw, origin)
    : DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS;

  const sweepRaw = raw.sweep;
  if (!isPlainObject(sweepRaw)) throw new PolicyError("policy.yaml: 'sweep' must be a mapping.");
  const staleDays = numberField("sweep.staleDays", sweepRaw.staleDays, origin);
  const sweepStrikeCap = numberField("sweep.strikeCap", sweepRaw.strikeCap, origin);
  const wipLimit = numberField("sweep.wipLimit", sweepRaw.wipLimit, origin);
  const tmpMaxAgeMs = numberField("sweep.tmpMaxAgeMs", sweepRaw.tmpMaxAgeMs, origin);
  const dispatchLanes = numberField("sweep.dispatchLanes", sweepRaw.dispatchLanes, origin);
  const dailyCostCeilingUsd = numberField("sweep.dailyCostCeilingUsd", sweepRaw.dailyCostCeilingUsd, origin, bounds);
  const armSessionPrs = booleanField("sweep.armSessionPrs", sweepRaw.armSessionPrs, origin);
  const repairFilingThreshold = numberField("sweep.repairFilingThreshold", sweepRaw.repairFilingThreshold, origin);
  const repairFilingWindowDays = numberField("sweep.repairFilingWindowDays", sweepRaw.repairFilingWindowDays, origin);
  const supersessionDisposal = booleanField("sweep.supersessionDisposal", sweepRaw.supersessionDisposal, origin);
  const memoryFloorMib = numberField("sweep.memoryFloorMib", sweepRaw.memoryFloorMib, origin);

  const drainRaw = raw.drain;
  if (!isPlainObject(drainRaw)) throw new PolicyError("policy.yaml: 'drain' must be a mapping.");
  const drainMax = numberField("drain.max", drainRaw.max, origin);

  const retroRaw = raw.retro;
  if (!isPlainObject(retroRaw)) throw new PolicyError("policy.yaml: 'retro' must be a mapping.");
  // AUTO-TRIAGE IS OPTIONAL, AND ITS ABSENCE MEANS OFF (impl-DJ). Making the block REQUIRED would
  // break every existing policy.yaml on load until someone edited it — and the safe default for a
  // rung that spends unsupervised is "not running", which is exactly what absence should mean. Only
  // a PRESENT block is validated, so a typo in an opted-in table still fails loud.
  const autoTriageRaw = raw.autoTriage as Record<string, unknown> | undefined;
  const autoTriage = autoTriageRaw
    ? {
        enabled: booleanField("autoTriage.enabled", autoTriageRaw.enabled, origin),
        minIntervalMinutes: numberField("autoTriage.minIntervalMinutes", autoTriageRaw.minIntervalMinutes, origin),
        maxPerDay: numberField("autoTriage.maxPerDay", autoTriageRaw.maxPerDay, origin),
      }
    : { enabled: false, minIntervalMinutes: 60, maxPerDay: 4 };
  // MEASUREMENT CADENCE IS OPTIONAL TOO, same absent-means-default shape as autoTriage
  // immediately above — but the default here is the SAFE mode already ON (see PolicyValues'
  // own doc for why a read-only cadence's absent default differs from a spending rung's).
  const measurementCadenceRaw = raw.measurementCadence as Record<string, unknown> | undefined;
  const measurementCadence = measurementCadenceRaw
    ? {
        enabled: booleanField("measurementCadence.enabled", measurementCadenceRaw.enabled, origin),
        minIntervalMinutes: numberField("measurementCadence.minIntervalMinutes", measurementCadenceRaw.minIntervalMinutes, origin),
        maxPerDay: numberField("measurementCadence.maxPerDay", measurementCadenceRaw.maxPerDay, origin),
        escalate: booleanField("measurementCadence.escalate", measurementCadenceRaw.escalate, origin),
      }
    : { enabled: true, minIntervalMinutes: 360, maxPerDay: 4, escalate: false };
  // W1-T2277: THE DIGEST'S OWN CADENCE ROW — its OWN policy block, deliberately separate from
  // `measurementCadence` immediately above (see `PolicyValues.digestCadence`'s doc for why).
  // OPTIONAL, same absent-means-default shape — the default is the SAFE always-on daily
  // cadence, since sending a digest spends nothing and writes nothing. `bounds` is recorded for
  // `minIntervalMinutes` (unlike `measurementCadence`'s row, which no runtime consumer
  // currently validates a write against) because `digest.ts`'s
  // `digestIntervalOptionsOutOfBounds` is exactly that runtime consumer: it checks the
  // console's offered interval set against THIS committed bound, never a second hand-copied one.
  const digestCadenceRaw = raw.digestCadence as Record<string, unknown> | undefined;
  const digestCadence = digestCadenceRaw
    ? {
        enabled: booleanField("digestCadence.enabled", digestCadenceRaw.enabled, origin),
        minIntervalMinutes: numberField("digestCadence.minIntervalMinutes", digestCadenceRaw.minIntervalMinutes, origin, bounds),
        maxPerDay: numberField("digestCadence.maxPerDay", digestCadenceRaw.maxPerDay, origin),
      }
    : { enabled: true, minIntervalMinutes: 1440, maxPerDay: 24 };
  // W1-T2304's board-review row — same optional, absent-means-default shape as the two cadences
  // above. See `PolicyValues.boardReview`'s doc for where 120/6 come from; they are derived from
  // the board's measured behaviour, not copied from a sibling row.
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

  // W1-T2568: OPTIONAL, same absent-means-default shape as `sweepWallClockBoundMs`/
  // `fixSpawnWallClockBoundMs` above — an existing policy.yaml missing this row still loads
  // clean; only a PRESENT row is validated, so a typo in an opted-in row still fails loud.
  const githubEventWakeRaw = raw.githubEventWake as Record<string, unknown> | undefined;
  const githubEventWakeDedupCapacity = githubEventWakeRaw
    ? numberField("githubEventWake.dedupCapacity", githubEventWakeRaw.dedupCapacity, origin, bounds)
    : DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY;
  const githubEventWakeCheckSettleMs = githubEventWakeRaw?.checkSettleMs !== undefined
    ? numberField("githubEventWake.checkSettleMs", githubEventWakeRaw.checkSettleMs, origin, bounds)
    : DEFAULT_GITHUB_EVENT_WAKE_CHECK_SETTLE_MS;

  // W1-T2579: OPTIONAL, absent means `[]` — see validateArmCalibrationBands's own doc for why
  // this row's validation is stricter-at-load/inert-at-consult rather than the absent-means-
  // default TRIPLET shape every numeric/boolean cadence row above uses.
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
      sweep: {
        staleDays,
        strikeCap: sweepStrikeCap,
        wipLimit,
        tmpMaxAgeMs,
        dispatchLanes,
        dailyCostCeilingUsd,
        armSessionPrs,
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
 * Absolute path to THIS INSTALLATION's `plan/policy.yaml`, resolved from this module's own
 * file location — never from `process.cwd()` or an ambient repoRoot. `src/lib/policy.ts` sits
 * two directories under the repo root, so a leaf consumer with no `repoRoot` parameter of its
 * own (review.ts, worker.ts, daemon.ts, sweep.ts, drain.ts, launchd.ts — W1-T253's CONSUMER
 * sites) can still resolve the SAME `plan/policy.yaml` `rmd`'s own CLI entry point resolves
 * (`run-task.ts`'s `resolveRepoRoot`), regardless of the invoking shell's cwd. Mirrors that
 * same function's own `import.meta.url`-based install-root fallback — same technique, same
 * module-boundary reasoning, not a new pattern introduced by this file.
 */
export function installPolicyPath(): string {
  return policyPath(join(fileURLToPath(new URL(".", import.meta.url)), "..", ".."));
}

let cachedDefaultPolicy: Policy | undefined;

/**
 * The policy at {@link installPolicyPath}, loaded once and memoized for the process's
 * lifetime (the same "load once, hold it" shape `src/lib/config.ts`'s `Config` already uses).
 * Every W1-T253 consumer site's DEFAULT resolves through this rather than a source literal —
 * every site's default parameter/constant remains explicit and independently overridable by a
 * caller or test that wants a value other than the loaded policy's, so this never forecloses
 * direct injection for testing.
 */
export function loadDefaultPolicy(): Policy {
  if (!cachedDefaultPolicy) cachedDefaultPolicy = loadPolicy(installPolicyPath());
  return cachedDefaultPolicy;
}

// ── DAILY-COST-CEILING OVERRIDE STORE (W1-T332) ─────────────────────────────────────────────
//
// OPERATOR RULING 2026-08-04: a runtime-tunable value belongs in a store the console can write
// at runtime, not in `plan/policy.yaml` behind a PR and a deploy — a console write TO the
// committed file must commit to survive, which reintroduces the PR the ruling removes, and an
// UNCOMMITTED edit is actively destroyed by the deploy's `pull --ff-only` (it happened this
// week, and took an operator kill switch with it).
//
// THE PRECEDENT: `fleet-control.ts`'s `state/PAUSE` — a flag file under `<root>/state/`,
// outside git (`.gitignore` carries `state/`), surviving every `pull --ff-only`. This reuses
// that exact mechanism for one value: the daily cost ceiling.
//
// ONE VALUE, ONE STORE, ONE PRECEDENCE RULE: an override under `state/` wins; its ABSENCE means
// the committed `plan/policy.yaml` default — no merging, no partial objects. Bounds are never
// duplicated: a write is validated against `policy.bounds["sweep.dailyCostCeilingUsd"]`, the
// SAME committed row `validatePolicy` already parsed, never a second hand-copied `{min, max}`.
// A malformed/unreadable override (bad JSON, missing/non-numeric `usd`, or a value the
// committed row no longer bounds — the row itself can change bound on a later PR) FALLS BACK to
// the committed default and REPORTS why, via {@link EffectiveDailyCostCeiling.fallback} — never
// silently read as zero, unbounded, or absent-and-fine.
//
// THE DISAPPEARANCE CASE (design note v): `state/` is deliberately outside git, so a wiped
// state root reverts every override to its committed default with NO error and NO missing-file
// surprise — that is by design (absence IS the "at default" case). But it means "at default
// because never overridden" and "at default because a real override just vanished" are NOT
// representable by THIS store alone — both read back identically here, `provenance: "default"`
// with no `fallback`. Distinguishing them is deliberately W1-T333's job: THE LEDGER, not this
// file, is where "was this ever overridden" survives a `state/` wipe, because `state/` is
// exactly the thing that can disappear.

/** One provenance-carrying read of the daily cost ceiling — see this section's header.
 *  `"instance-share"` (W1-T408) is a THIRD arm, not a fourth precedence layer over the two
 *  above — see that field's own section below for why it wins outright rather than merging. */
export type DailyCostCeilingProvenance = "overridden" | "default" | "instance-share";

/** Why a stored override was not used; present only when one existed but was refused. */
export interface DailyCostCeilingFallback {
  reason: string;
}

/** The daily cost ceiling as a live reader should use it: never the bare number. */
export interface EffectiveDailyCostCeiling {
  usd: number;
  provenance: DailyCostCeilingProvenance;
  /** `policy.values.sweep.dailyCostCeilingUsd` — carried alongside so an overridden reading
   *  shows both the effective figure and what it was overridden FROM. */
  committedDefaultUsd: number;
  /** Set only when an on-disk override existed but was malformed/unreadable/out of bound —
   *  `usd`/`provenance` above already fell back to the committed default when this is set. */
  fallback?: DailyCostCeilingFallback;
  /** W1-T408: this reading's `usd` came from a configured PER-INSTANCE share (see
   *  {@link resolveDailyCostCeilingInstanceShare}) — set only when `provenance ===
   *  "instance-share"`, and then equal to `usd`. Carried as its own field (rather than making
   *  a caller infer it from `provenance`) so a reader can log/render it without a string
   *  comparison. */
  instanceShareUsd?: number;
  /** W1-T408: the instance this reading belongs to — set only alongside `instanceShareUsd`.
   *  Answers "visible before it trips": today the ceiling is written into the ledger only at
   *  the moment `logCostGovernorDeferral` fires; this field lets ANY caller ask "what is MY
   *  ceiling, and which instance is it" ahead of that, without reading the ledger at all. */
  instanceLabel?: string;
}

/** One written override, as persisted under `state/`. */
export interface DailyCostCeilingOverrideRecord {
  usd: number;
  setAt: string;
}

/** `state/PAUSE`-shaped in location and lifetime (fleet-control.ts) — outside git, survives
 *  every `pull --ff-only`. Carries the daily cost ceiling ONLY (design note (i)): this is not
 *  a general key-value store. */
export function dailyCostCeilingOverridePath(root: string): string {
  return join(root, "state", "DAILY_COST_CEILING_OVERRIDE");
}

/**
 * Write the `state/`-resident override. Validated against `policy.bounds`'s committed
 * `sweep.dailyCostCeilingUsd` row — an out-of-bound (or non-finite) value is REFUSED here,
 * at write time, throwing {@link PolicyError} and performing NO write, rather than being
 * clamped, accepted, or left to fail later at read time (design note (iii)).
 */
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

/**
 * Resolve the EFFECTIVE daily cost ceiling: the `state/` override if one exists, is
 * well-formed, and is within the committed row's CURRENT bound; the committed
 * `plan/policy.yaml` default otherwise. This is the one function a live reader (the daemon's
 * per-tick reload, W1-T331; the console render, W1-T333) should call — never a raw read of
 * the override file, so the fallback-and-report and provenance rules above cannot be bypassed.
 */
export function resolveDailyCostCeiling(root: string, policy: Policy): EffectiveDailyCostCeiling {
  const committedDefaultUsd = policy.values.sweep.dailyCostCeilingUsd;
  const path = dailyCostCeilingOverridePath(root);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No override was ever written (or one was written and the state/ root vanished) — the
      // ABSENCE case (design note ii): reads as the committed default, no fallback report,
      // because absence is not a malformed override — it is the precedence rule's other arm.
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

// ────────────────────────────────────────────────────────────────────────────────────────────
// W1-T408 — THE PER-INSTANCE SHARE (the daily ceiling is per instance, not per fleet). Two
// containers each reading `resolveDailyCostCeiling` independently both stop politely at the
// SAME committed 500, and the bill is 1000 — each is correct about its OWN ledger and neither
// can see the other (plan/tasks.d/W1-T408-…: "NOTHING LOOKS WRONG FROM INSIDE EITHER
// CONTAINER"). This is deliberately NOT cross-instance coordination (there is no shared dollar
// figure anywhere — see that task file's rationale for the two independent reasons the account
// usage surface cannot serve this ceiling) — it is a per-instance knob the OPERATOR divides:
// running N containers against one 500 ceiling, the operator sets each to a configured SHARE
// (e.g. 250 each) so the fleet's real total matches what one instance used to spend alone.
//
// ENV, NOT A FILE: `state/DAILY_COST_CEILING_OVERRIDE` (above) retunes what the ceiling IS,
// shared identically by every reader of the SAME `state/` directory. A share answers a
// different question — "what is THIS INSTANCE's portion" — and env is inherently
// per-process/per-container already, needing no new per-instance directory the way a file
// would (`state/` itself is already instance-scoped only because it is homed under HOME —
// see run-task.ts's `repoRoot`/`config.root` chain — an incidental fact of this deployment's
// layout, not something a share should depend on).
//
// A CONFIGURED SHARE WINS OUTRIGHT, over both the committed default AND a written override —
// it is the MOST specific, most local setting available, and the operator who sets an
// instance's share has already made the coarser two irrelevant to that instance's own
// enforcement. It does not merge with them (an instance's effective ceiling is one number).
//
// UNSET BEHAVES EXACTLY AS TODAY (acceptance: test/cost-ceiling-default-unchanged.test.ts):
// `resolveDailyCostCeilingInstanceShare` returns `undefined` when the env var is absent, blank,
// non-numeric, or out of the committed bound, and `resolveDailyCostCeilingForInstance` returns
// `resolveDailyCostCeiling`'s own result UNCHANGED whenever that happens — a single-instance
// operator who never sets the env var sees no change of any kind, byte for byte.
//
// WHAT THIS DOES NOT DO (recorded, not hidden): nothing stops an operator setting two
// instances to 500 each, and nothing detects that they did — there is still no shared figure,
// so there is nothing to check a share against. The fix makes the arithmetic CORRECT and
// VISIBLE when the operator divides it; it does not, and cannot, ENFORCE the division.
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The env var an operator sets, per container, to this instance's slice of the fleet's daily
 *  ceiling — e.g. two containers each at `250` divide a committed `500` in half. Validated
 *  against the SAME `sweep.dailyCostCeilingUsd` committed bound {@link writeDailyCostCeilingOverride}
 *  already validates against — never a second, hand-copied `{min, max}`. */
export const DAILY_COST_CEILING_SHARE_ENV_VAR = "REMUDERO_DAILY_COST_CEILING_SHARE_USD";

/** The env var naming THIS instance, carried alongside a configured share so a reading is never
 *  just a bare number — see {@link EffectiveDailyCostCeiling.instanceLabel}. Defaults to
 *  `os.homedir()` when unset: the isolation unit this fleet already keys separate containers
 *  off of (plan/tasks.d/W1-T408: "the unit of isolation is the INSTANCE, keyed off HOME"), so
 *  an operator who sets nothing but the share still gets a label that actually distinguishes
 *  one container from another. */
export const DAILY_COST_CEILING_INSTANCE_LABEL_ENV_VAR = "REMUDERO_INSTANCE_LABEL";

/** One instance's configured share of the fleet's daily ceiling — see the section header above. */
export interface DailyCostCeilingInstanceShare {
  usd: number;
  instanceLabel: string;
}

/**
 * Read this instance's configured share, if any, from `env` (defaults to `process.env` —
 * injectable so a test never has to mutate the real process environment). Returns `undefined`
 * — meaning "no share configured, resolve exactly as before this task" — when the env var is
 * absent/blank, non-numeric, or outside the committed `sweep.dailyCostCeilingUsd` bound; a
 * malformed value is IGNORED here, never thrown, because a bad env value must not crash the
 * process on boot (mirrors {@link resolveDailyCostCeiling}'s own "fall back and report" —
 * except a share has no ledger-worthy `fallback` slot of its own, since falling back here means
 * exactly "resolve as if unset", which the caller already does for the true unset case).
 */
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

/**
 * The daily cost ceiling AS THIS INSTANCE should enforce it: {@link resolveDailyCostCeiling}'s
 * committed-default/override reading, UNLESS this instance has a configured share (see the
 * section header above), in which case the share wins outright and `provenance` reads
 * `"instance-share"`.
 *
 * THIS IS THE VISIBILITY FIX (acceptance: test/cost-ceiling-visibility.test.ts): it is a pure
 * function of `root`/`policy`/`env`, callable at ANY time — before a single dispatch has been
 * deferred, before any ledger line exists at all — unlike `logCostGovernorDeferral`
 * (sweep.ts), which only ever writes the ceiling into the ledger AT THE MOMENT a consultation
 * defers. An operator (or a future console render) can call this pre-trip and see both the
 * effective figure and the instance it belongs to.
 *
 * `run-task.ts`'s `dailyCostCeilingReloader` is the ONE place this becomes the LIVE governor
 * input (W1-T331's "THE LIVE CEILING") — this function itself performs no ledger read and
 * makes no dispatch decision, exactly like {@link resolveDailyCostCeiling} before it.
 */
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
