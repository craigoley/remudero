import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** The plain, consumer-facing values every W1-T253 read site will resolve against. */
export interface PolicyValues {
  proofTimeoutMs: number;
  pruneGraceMs: number;
  pollIntervalMs: number;
  fixStrikeCap: number;
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
   *  `minIntervalMinutes`/`maxIntervalMinutes`/`depthFloor`/`depthCeiling` are the W1-T318
   *  adaptive-cadence curve; `maxPerDay` remains the untouched ceiling that curve spends against. */
  autoTriage: {
    enabled: boolean;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    depthFloor: number;
    depthCeiling: number;
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
  pollIntervalMs: "lifted",
  fixStrikeCap: "lifted",
  "sweep.staleDays": "lifted",
  "sweep.strikeCap": "lifted",
  "sweep.wipLimit": "lifted",
  "sweep.tmpMaxAgeMs": "net-new",
  "sweep.dispatchLanes": "lifted",
  "sweep.dailyCostCeilingUsd": "lifted",
  "drain.max": "lifted",
  "autoTriage.enabled": "net-new",
  "autoTriage.minIntervalMinutes": "net-new",
  "autoTriage.maxIntervalMinutes": "net-new",
  "autoTriage.depthFloor": "net-new",
  "autoTriage.depthCeiling": "net-new",
  "autoTriage.maxPerDay": "net-new",
  "retro.mergesThreshold": "lifted",
  "retro.daysThreshold": "lifted",
  "headroom.curve": "lifted",
  "headroom.reservePct": "lifted",
  "headroom.enabled": "lifted",
  "launchd.throttleIntervalS": "net-new",
  "scratchReap.enabled": "net-new",
  "scratchReap.maxAgeHours": "lifted",
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
  const pollIntervalMs = numberField("pollIntervalMs", raw.pollIntervalMs, origin);
  const fixStrikeCap = numberField("fixStrikeCap", raw.fixStrikeCap, origin);

  const sweepRaw = raw.sweep;
  if (!isPlainObject(sweepRaw)) throw new PolicyError("policy.yaml: 'sweep' must be a mapping.");
  const staleDays = numberField("sweep.staleDays", sweepRaw.staleDays, origin);
  const sweepStrikeCap = numberField("sweep.strikeCap", sweepRaw.strikeCap, origin);
  const wipLimit = numberField("sweep.wipLimit", sweepRaw.wipLimit, origin);
  const tmpMaxAgeMs = numberField("sweep.tmpMaxAgeMs", sweepRaw.tmpMaxAgeMs, origin);
  const dispatchLanes = numberField("sweep.dispatchLanes", sweepRaw.dispatchLanes, origin);
  const dailyCostCeilingUsd = numberField("sweep.dailyCostCeilingUsd", sweepRaw.dailyCostCeilingUsd, origin, bounds);

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
        maxIntervalMinutes: numberField("autoTriage.maxIntervalMinutes", autoTriageRaw.maxIntervalMinutes, origin),
        depthFloor: numberField("autoTriage.depthFloor", autoTriageRaw.depthFloor, origin),
        depthCeiling: numberField("autoTriage.depthCeiling", autoTriageRaw.depthCeiling, origin),
        maxPerDay: numberField("autoTriage.maxPerDay", autoTriageRaw.maxPerDay, origin),
      }
    : { enabled: false, minIntervalMinutes: 60, maxIntervalMinutes: 60, depthFloor: 0, depthCeiling: 10, maxPerDay: 4 };
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

  return {
    values: {
      proofTimeoutMs,
      pruneGraceMs,
      pollIntervalMs,
      fixStrikeCap,
      sweep: { staleDays, strikeCap: sweepStrikeCap, wipLimit, tmpMaxAgeMs, dispatchLanes, dailyCostCeilingUsd },
      drain: { max: drainMax },
      retro: { mergesThreshold: retroMergesThreshold, daysThreshold: retroDaysThreshold },
      autoTriage,
      headroom: { curve, reservePct, enabled: headroomEnabled },
      launchd: { throttleIntervalS },
      scratchReap: { enabled: scratchReapEnabled, maxAgeHours: scratchReapMaxAgeHours },
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

/** One provenance-carrying read of the daily cost ceiling — see this section's header. */
export type DailyCostCeilingProvenance = "overridden" | "default";

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
