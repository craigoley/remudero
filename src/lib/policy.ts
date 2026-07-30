import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  };
  drain: {
    max: number;
  };
  headroom: {
    curve: PolicyHeadroomRung[];
    reservePct: number;
    enabled: boolean;
  };
  launchd: {
    throttleIntervalS: number;
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
  "drain.max": "lifted",
  "headroom.curve": "lifted",
  "headroom.reservePct": "lifted",
  "headroom.enabled": "lifted",
  "launchd.throttleIntervalS": "net-new",
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
  if (typeof min !== "number" || typeof max !== "number") {
    throw new PolicyError(`policy.yaml: '${path}' must carry numeric 'min' and 'max' bounds.`);
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
    if (maxHoursToReset !== null && (typeof maxHoursToReset !== "number" || maxHoursToReset <= 0)) {
      throw new PolicyError(
        `policy.yaml: '${path}.value[${i}].maxHoursToReset' must be null or a positive number, got ${JSON.stringify(maxHoursToReset)}.`,
      );
    }
    if (typeof limitPct !== "number" || limitPct < 0 || limitPct > 100) {
      throw new PolicyError(
        `policy.yaml: '${path}.value[${i}].limitPct' must be a number in [0, 100], got ${JSON.stringify(limitPct)}.`,
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

  const drainRaw = raw.drain;
  if (!isPlainObject(drainRaw)) throw new PolicyError("policy.yaml: 'drain' must be a mapping.");
  const drainMax = numberField("drain.max", drainRaw.max, origin);

  const headroomRaw = raw.headroom;
  if (!isPlainObject(headroomRaw)) throw new PolicyError("policy.yaml: 'headroom' must be a mapping.");
  const curve = validateHeadroomCurve(headroomRaw.curve, origin);
  const reservePct = numberField("headroom.reservePct", headroomRaw.reservePct, origin);
  const headroomEnabled = booleanField("headroom.enabled", headroomRaw.enabled, origin);

  const launchdRaw = raw.launchd;
  if (!isPlainObject(launchdRaw)) throw new PolicyError("policy.yaml: 'launchd' must be a mapping.");
  const throttleIntervalS = numberField("launchd.throttleIntervalS", launchdRaw.throttleIntervalS, origin);

  return {
    values: {
      proofTimeoutMs,
      pruneGraceMs,
      pollIntervalMs,
      fixStrikeCap,
      sweep: { staleDays, strikeCap: sweepStrikeCap, wipLimit },
      drain: { max: drainMax },
      headroom: { curve, reservePct, enabled: headroomEnabled },
      launchd: { throttleIntervalS },
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
