import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The fully loaded/validated policy: plain values plus per-field provenance. */
export interface Policy {
  values: PolicyValues;
  /** Dotted field path -> its recorded origin. */
  origin: Record<string, PolicyFieldOrigin>;
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

/** Read+validate one bounded numeric field's `{value, origin, min, max}` row. */
function numberField(
  path: string,
  raw: unknown,
  origins: Record<string, PolicyFieldOrigin>,
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
      sweep: { staleDays, strikeCap: sweepStrikeCap, wipLimit, tmpMaxAgeMs },
      drain: { max: drainMax },
      retro: { mergesThreshold: retroMergesThreshold, daysThreshold: retroDaysThreshold },
      autoTriage,
      headroom: { curve, reservePct, enabled: headroomEnabled },
      launchd: { throttleIntervalS },
      scratchReap: { enabled: scratchReapEnabled, maxAgeHours: scratchReapMaxAgeHours },
    },
    origin,
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
