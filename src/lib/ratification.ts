import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * LAW 5's SIGNATURE (W1-T2694): binds an operator's ratification not to `plan/policy.yaml`'s
 * `enabled` row — a boolean and two numbers — but to the OPERATION that row arms, so a PR that
 * widens what a gated rung may do (or changes which candidates it acts on) cannot ride an
 * untouched policy row into an unattended tick.
 *
 * MODELED ON `verifyBundlePin` (src/lib/learnings.ts): a single declared hash, checked against
 * an operator-supplied pin, never recomputed except to compare — no re-derivation smuggled in
 * as "the real check". The pin file is PLAN STATE an operator commits by hand (`rmd ratify
 * <rung>` only prints the row; see {@link buildRatificationRow}), never written by this module.
 *
 * ABSENT FILE, OR ABSENT ROW FOR A RUNG, MEANS "NO PIN": {@link ratificationPinCheck} fires —
 * today's behaviour, byte-identical — so this ships inert until an operator ratifies a rung
 * (the W1-T2579 `armCalibrationBands` shape: empty ships safe).
 *
 * THE HASH COVERS TWO THINGS, DELIBERATELY NOT SOURCE TEXT: the rung's live policy block
 * (`plan/policy.yaml`'s own values for that rung) and a CONTRACT VERSION constant the rung's
 * module exports beside its entry point. A hash over source would fire on every comment edit and
 * get muted within a week (the W1-T2254 lesson); a constant fires only when an author says the
 * operation itself changed.
 */

/** One committed row of `plan/ratifications.yaml` — an operator's ratification of one rung's
 *  operation, at the hash `rmd ratify <rung>` printed when they ratified it. Deliberately FOUR
 *  fields, no snapshot of the policy values themselves (design (i)): the row is a POINTER an
 *  operator re-derives and re-commits, never a copy this module diffs field-by-field. */
export interface RatificationRow {
  rung: string;
  operationHash: string;
  ratifiedAt: string;
  ratifiedBy: string;
}

/** Every ratified row, keyed by rung name — {@link loadRatifications}'s return shape. */
export type Ratifications = ReadonlyMap<string, RatificationRow>;

/** Default location of the operator-committed pin table, under a repo root — same convention as
 *  {@link import("./policy.js").policyPath}, and deliberately the sibling `plan/policy.yaml`
 *  already lives beside (design (i)). */
export function ratificationsPath(root: string): string {
  return join(root, "plan", "ratifications.yaml");
}

/**
 * Load `plan/ratifications.yaml` (or any path) into {@link Ratifications}. ABSENT FILE, an
 * UNREADABLE/malformed file, or a row missing its `rung`/`operationHash` strings all degrade to
 * "no pin for that rung" rather than throwing — a corrupt pin file must never make an unattended
 * tick crash, and a rung with no readable row already gets the safe "fire" answer by construction
 * (see this module's own header). Never a WRITE path — `rmd ratify` only prints (Rule 15).
 */
export function loadRatifications(path: string): Ratifications {
  if (!existsSync(path)) return new Map();
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
  if (!Array.isArray(raw)) return new Map();
  const rows = new Map<string, RatificationRow>();
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).rung === "string" &&
      typeof (entry as Record<string, unknown>).operationHash === "string"
    ) {
      const e = entry as Record<string, unknown>;
      rows.set(e.rung as string, {
        rung: e.rung as string,
        operationHash: e.operationHash as string,
        ratifiedAt: typeof e.ratifiedAt === "string" ? e.ratifiedAt : "",
        ratifiedBy: typeof e.ratifiedBy === "string" ? e.ratifiedBy : "",
      });
    }
  }
  return rows;
}

/** The operation hash a rung's ratification pins: sha256 over its live policy block (as
 *  `plan/policy.yaml` resolves it) plus its declared contract version, canonicalized through
 *  `JSON.stringify` — the same "hash the resolved value, not the source text" shape
 *  {@link import("./learnings.js").computeArtifactHash} uses. */
export function computeOperationHash(policyBlock: unknown, contractVersion: string): string {
  return createHash("sha256").update(JSON.stringify({ policy: policyBlock, contractVersion })).digest("hex");
}

/** The outcome of one {@link ratificationPinCheck} call. `diff` is populated only on refusal —
 *  named evidence (both hashes, plus which two inputs feed them) rather than a bare boolean, so a
 *  ledgered refusal tells an operator what to go re-ratify. */
export type RatificationPinResult = { fire: true } | { fire: false; reason: string; diff: string };

/**
 * THE CHECK, AT THE TICK (design (ii)). `pins.get(rung)` absent ⇒ `{fire: true}` — no pin, no
 * opinion, today's behaviour. A pin present is compared by RECOMPUTING the live hash over
 * `policyBlock`/`contractVersion` and testing equality against the ratified `operationHash` —
 * never the other way around (this never trusts a caller-supplied "current" hash; it always
 * derives one). A mismatch refuses, naming both hashes so the diff is inspectable without this
 * module knowing which of the two ingredients moved (that IS the caller's next `rmd ratify` run).
 *
 * INVARIANT, mirroring {@link import("./learnings.js").verifyBundlePin}'s own: this never widens
 * what a rung may do — the only two outcomes are "fire, unopinionated" and "refuse, named" (design
 * (v)). Callers wire this AFTER their `enabled` read and BEFORE their cadence/action check, so a
 * refusal short-circuits before any candidate is read or any write is attempted.
 */
export function ratificationPinCheck(
  rung: string,
  policyBlock: unknown,
  contractVersion: string,
  pins: Ratifications,
): RatificationPinResult {
  const pin = pins.get(rung);
  if (!pin) return { fire: true };
  const liveHash = computeOperationHash(policyBlock, contractVersion);
  if (liveHash === pin.operationHash) return { fire: true };
  const diff =
    `rung '${rung}' operation hash drifted since its ${pin.ratifiedAt || "unknown"} ratification: ` +
    `ratified ${pin.operationHash}, live policy+contract "${contractVersion}" now computes ${liveHash} — ` +
    `its policy values or its contract version moved; re-run \`rmd ratify ${rung}\` and commit the new row to re-ratify`;
  return {
    fire: false,
    reason: `rung '${rung}' refused: ratified operation no longer matches what would fire — ${diff}`,
    diff,
  };
}

/**
 * `rmd ratify <rung>`'s pure core (design (i)): computes the row an operator commits into
 * `plan/ratifications.yaml` to ratify `rung` at its CURRENT policy block + contract version. Pure
 * — the CLI wrapper (`ratifyCommand`, src/run-task.ts) does the printing and touches no file;
 * this function itself never writes anything, by construction (it returns a value).
 */
export function buildRatificationRow(
  rung: string,
  policyBlock: unknown,
  contractVersion: string,
  ratifiedBy: string,
  now: Date,
): RatificationRow {
  return {
    rung,
    operationHash: computeOperationHash(policyBlock, contractVersion),
    ratifiedAt: now.toISOString(),
    ratifiedBy,
  };
}

/** Render one {@link RatificationRow} as the YAML list entry an operator pastes into
 *  `plan/ratifications.yaml` — the printed artifact `rmd ratify <rung>` never writes itself. */
export function renderRatificationRow(row: RatificationRow): string {
  return [
    `- rung: ${row.rung}`,
    `  operationHash: ${row.operationHash}`,
    `  ratifiedAt: "${row.ratifiedAt}"`,
    `  ratifiedBy: ${row.ratifiedBy}`,
  ].join("\n");
}
