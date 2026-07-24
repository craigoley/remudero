import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import { alertOriginId, alertTaskId, priorEscalatedAlertIds, type AlertSeverity, type RawAlert } from "./ops.js";

/**
 * The alert-fix lane (W1-T90, MASTER-PLAN P20 — MASTER-PLAN.md:686, ratifies §5D lane 2).
 *
 * §5D lane 2 (W1-T55 surface -> W1-T56 triage, both SHIPPED — src/lib/ops.ts) ends at "every
 * open alert becomes a `plan/feedback/` entry `rmd triage` can ground"; every alert then waits
 * on a human, including trivial ones. The dep-review lane (W1-T54, SHIPPED — src/lib/dep-review.ts)
 * is the PRECEDENT this module mirrors exactly: a DETERMINISTIC policy (no LLM call, ever — rule 2)
 * decides act-vs-escalate with NO per-item `plan/tasks.yaml` write (rule 15) and no per-item human
 * ratification — the lane owns its run shape entirely outside the human-authored plan, exactly like
 * dep-review does.
 *
 * THE POLICY IS DATA ({@link AlertPolicy}, loaded from `plan/alert-policy.yaml` by
 * {@link loadAlertPolicy}): (severity x path) -> act | escalate, keyed off a NAMED
 * gate/containment-critical path set the policy file itself carries (review/gate/containment/
 * ledger/status — P20's own text names these five categories explicitly). Editing that file
 * alone changes what this lane does; {@link decideAlertDisposition} never hardcodes a path or a
 * severity threshold.
 *
 * THE PURE DECISION ({@link decideAlertDisposition}) mirrors dep-review's `decideDepReview` shape:
 * no I/O, one fixture per branch, fail-closed throughout —
 *   - "act"      — severity is medium/low (a KNOWN, policy-listed act-severity) AND the alert's
 *     path (when known) is OUTSIDE the policy's critical-path set.
 *   - "escalate" — severity is critical/high, OR severity is "unknown" (fail-closed — the SAME
 *     "unknown bump level -> escalate" convention dep-review.ts's overallSemverLevel documents),
 *     OR the path IS inside the critical-path set, regardless of severity.
 *
 * THE ORCHESTRATOR ({@link runAlertLane}) takes every dep as an injected effect (deps.escalate,
 * deps.dispatch — mirrors ops.ts's `OpsPollDeps` / dep-review's usage) so the whole rung is
 * unit-testable with fakes, no real spawn/gh/ledger I/O in the test suite:
 *   - "escalate" -> `deps.escalate(alert)`, the REAL wiring (run-task.ts's `alertFixCommand`)
 *     implements this via the SAME `escalate()` (lib/escalate.ts) + `buildAlertEscalation`
 *     (ops.ts, reused verbatim — class MANUAL, options fix/dismiss, recommendation fix) `rmd ops`'s
 *     own critical/high poll already uses, with `taskId = alertTaskId(alert)` — so escalate()'s own
 *     `escalation.issue_opened` ledger line becomes the SAME dedup entry {@link
 *     import("./ops.js").priorEscalatedAlertIds} already reads. The two lanes therefore share ONE
 *     escalation-ledger namespace: an alert `rmd ops` already escalated is never escalated again
 *     here, and vice versa — this orchestrator checks that SAME set before ever calling
 *     `deps.escalate`.
 *   - "act" -> DEDUP FIRST: an alert with a prior `alert-lane.dispatched` ledger line for its
 *     taskId is never re-dispatched (the W1-T80 discipline, lane-side — mirrors how the
 *     escalation dedup above reads prior ledger lines via an injectable `readLedger`). Only then
 *     `deps.dispatch(alert)` — the real wiring spawns an ephemeral, lane-owned fix-run worker
 *     (run-task.ts's `dispatchAlertFixRun`) — followed by exactly ONE `alert-lane.dispatched`
 *     ledger line carrying the alert's taskId/origin, so a re-poll of the SAME alert dispatches
 *     nothing.
 *
 * Every act/escalate DECISION (not just the dispatched/escalated ones) is also ledgered
 * (`alert-lane.decided`) — P20's own design note: "every act/escalate decision is a ledger line".
 *
 * This module NEVER writes `plan/tasks.yaml` anywhere (grep-provable: `grep -n "tasks.yaml"
 * src/lib/alert-lane.ts` finds nothing) — like dep-review, it owns its run shape entirely outside
 * the human-authored plan.
 */

// ── The alert shape this lane reasons over ──────────────────────────────────

/**
 * One alert, as this lane sees it: {@link RawAlert} (ops.ts) plus an OPTIONAL `path` for policy
 * purposes.
 *
 * FUTURE WORK, explicitly OUT OF SCOPE for W1-T90 (files: src/lib/alert-lane.ts, src/run-task.ts,
 * plan/alert-policy.yaml — never src/lib/ops.ts): `RawAlert` carries no `path` field today because
 * none of ops.ts's three normalizers (`normalizeCodeScanningAlert`/`normalizeDependabotAlert`/
 * `normalizeSecretScanningAlert`) extract one from the GitHub API response — a REAL, SEPARATE gap
 * a future task should close (code-scanning alerts DO carry `most_recent_instance.location.path` in
 * the raw API shape; dependabot/secret-scanning alerts have no single-file path to extract). Until
 * then, every alert this lane is handed has `path: undefined`, which {@link isCriticalPath} treats
 * as "outside the critical set" (see its own doc) — only severity can force escalate when the path
 * is unknown, never a silently-assumed "safe".
 */
export interface AlertLaneAlert extends RawAlert {
  path?: string;
}

// ── Policy, loaded as DATA (rule 2) ──────────────────────────────────────────

export interface AlertPolicy {
  /** Severities eligible for "act" — every other known severity, and any unknown one, escalates. */
  actSeverities: AlertSeverity[];
  /** category -> glob[] ("*" is the only wildcard, matched against the whole path). */
  criticalPaths: Record<string, string[]>;
}

export class AlertPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertPolicyError";
  }
}

const KNOWN_SEVERITIES: readonly AlertSeverity[] = ["critical", "high", "medium", "low", "unknown"];

/**
 * The five gate/containment-critical categories P20's own text names verbatim ("review, gate,
 * containment, ledger, and status paths are IN it") — every one MUST be present, with at least
 * one glob, for `plan/alert-policy.yaml` to load at all (validated by {@link validateAlertPolicy}).
 */
export const REQUIRED_CRITICAL_PATH_CATEGORIES = ["review", "gate", "containment", "ledger", "status"] as const;

/**
 * The GOLDEN fixture path P20's own text names explicitly ("a seeded medium alert touching
 * src/lib/review.ts... escalates"). The `review` category MUST include it verbatim, so this
 * lane's critical-path branch is provably exercised against the exact path the ratified
 * proposal cites, not merely "some path or other".
 */
export const GOLDEN_CRITICAL_PATH = "src/lib/review.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a raw (parsed-YAML) value into an {@link AlertPolicy}. Throws {@link AlertPolicyError}
 * on any structural or semantic violation — mirrors mounts.ts's `validateMounts`/`loadMounts`
 * load-and-validate shape (this repo's existing convention for a plan-level policy YAML), never a
 * second, ad hoc loader.
 */
export function validateAlertPolicy(raw: unknown): AlertPolicy {
  if (!isPlainObject(raw)) throw new AlertPolicyError("alert-policy.yaml must be a mapping.");

  const actRaw = raw.act_severities;
  if (!Array.isArray(actRaw) || actRaw.length === 0) {
    throw new AlertPolicyError("'act_severities' must be a non-empty array of severities.");
  }
  const actSeverities: AlertSeverity[] = actRaw.map((s) => {
    if (typeof s !== "string" || !(KNOWN_SEVERITIES as readonly string[]).includes(s)) {
      throw new AlertPolicyError(
        `'act_severities' entries must be one of ${KNOWN_SEVERITIES.join(", ")}, got ${JSON.stringify(s)}.`,
      );
    }
    return s as AlertSeverity;
  });

  const cpRaw = raw.critical_paths;
  if (!isPlainObject(cpRaw)) {
    throw new AlertPolicyError("'critical_paths' must be a mapping of category -> glob[].");
  }
  const criticalPaths: Record<string, string[]> = {};
  for (const [category, globs] of Object.entries(cpRaw)) {
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) {
      throw new AlertPolicyError(`'critical_paths.${category}' must be an array of glob strings.`);
    }
    criticalPaths[category] = globs as string[];
  }
  for (const required of REQUIRED_CRITICAL_PATH_CATEGORIES) {
    if (!criticalPaths[required] || criticalPaths[required].length === 0) {
      throw new AlertPolicyError(
        `'critical_paths' must define a non-empty '${required}' category (P20 names review/gate/` +
          `containment/ledger/status explicitly) — have: ${Object.keys(criticalPaths).join(", ") || "(none)"}.`,
      );
    }
  }
  if (!criticalPaths.review.includes(GOLDEN_CRITICAL_PATH)) {
    throw new AlertPolicyError(
      `'critical_paths.review' must include '${GOLDEN_CRITICAL_PATH}' — the GOLDEN fixture path P20's own text names.`,
    );
  }

  return { actSeverities, criticalPaths };
}

/** Load, parse, and validate `plan/alert-policy.yaml` (or any path) into an {@link AlertPolicy}. */
export function loadAlertPolicy(path: string): AlertPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AlertPolicyError(`alert-policy.yaml is not valid YAML (${path}): ${String(err)}`);
  }
  return validateAlertPolicy(raw);
}

// ── The pure decision ────────────────────────────────────────────────────────

export type AlertDisposition = "act" | "escalate";

/** `*` is the only supported wildcard (any run of characters); everything else matches literally. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function allCriticalPathGlobs(policy: AlertPolicy): string[] {
  return Object.values(policy.criticalPaths).flat();
}

/**
 * True iff `path` matches any glob in the policy's critical-path set. A `path` of `undefined`
 * (every alert this lane sees today — see {@link AlertLaneAlert}'s doc) is ALWAYS outside the
 * critical set: only severity can force escalate when no path is known — this half of the
 * predicate never assumes "critical" from silence, matching this codebase's "absence is never
 * proof of anything" doctrine (see e.g. ledger.ts's own comments) applied to the safe direction
 * here (a missing path cannot itself force an act it wouldn't otherwise reach either — severity
 * still gates independently).
 */
export function isCriticalPath(path: string | undefined, policy: AlertPolicy): boolean {
  if (path === undefined) return false;
  return allCriticalPathGlobs(policy).some((glob) => globToRegExp(glob).test(path));
}

/**
 * The pure verdict function, mirroring dep-review.ts's `decideDepReview` shape: no I/O, fail-closed
 * throughout. `severity <= medium` per the LOADED policy's `act_severities` (data — moving a
 * severity in/out of that list, or a path in/out of `critical_paths`, flips this function's
 * answer with ZERO code change) AND the path (when known) outside the critical-path set -> "act".
 * Anything else -> "escalate": critical/high, unknown severity (fail-closed — the SAME "unknown
 * bump level -> escalate" convention dep-review.ts's `overallSemverLevel` documents), or a
 * critical-path hit regardless of severity.
 */
export function decideAlertDisposition(alert: AlertLaneAlert, policy: AlertPolicy): AlertDisposition {
  if (!policy.actSeverities.includes(alert.severity)) return "escalate";
  if (isCriticalPath(alert.path, policy)) return "escalate";
  return "act";
}

/** Human-readable reason for a {@link decideAlertDisposition} verdict — ledgered on every decision. */
export function alertDispositionReason(alert: AlertLaneAlert, policy: AlertPolicy): string {
  if (!policy.actSeverities.includes(alert.severity)) {
    return `severity '${alert.severity}' is not a policy act-severity (${policy.actSeverities.join(", ")}) — fail-closed to escalate`;
  }
  if (isCriticalPath(alert.path, policy)) {
    return `path '${alert.path}' matches a policy-named critical path — escalate regardless of severity`;
  }
  return `severity '${alert.severity}', path outside the critical-path set — safe to dispatch an ephemeral fix run`;
}

// ── The orchestrator ──────────────────────────────────────────────────────────

export interface AlertLaneDeps {
  /**
   * Open a MANUAL escalation issue for an alert whose disposition is "escalate". The real wiring
   * (run-task.ts's `alertFixCommand`) implements this via `lib/escalate.ts`'s `escalate()` +
   * `buildAlertEscalation` (ops.ts, reused verbatim — see this module's own doc for why that
   * shares ONE dedup namespace with `rmd ops`'s own poll). Returns the issue URL.
   */
  escalate: (alert: AlertLaneAlert) => string | Promise<string>;
  /**
   * Dispatch ONE ephemeral, lane-owned fix run for an alert whose disposition is "act". The real
   * wiring (run-task.ts's `dispatchAlertFixRun`) spawns a worker on a fresh branch that opens its
   * own gated PR (`origin: alert#<id>` provenance). Fixture tests inject a call-counting fake.
   */
  dispatch: (alert: AlertLaneAlert) => void | Promise<void>;
  /** Ledger path this run reads (dedup source) and writes to (`alert-lane.decided`/`.dispatched`). */
  ledgerPath: string;
  runId: string;
  /** Injectable ledger reader (dedup source); defaults to {@link readLedgerLines}. */
  readLedger?: (path: string) => Array<Record<string, unknown>>;
}

export interface AlertLaneResult {
  dispatched: AlertLaneAlert[];
  escalated: AlertLaneAlert[];
  /** Act-disposition alerts skipped because a prior `alert-lane.dispatched` line already covers them. */
  skippedDuplicateDispatch: AlertLaneAlert[];
  /** Escalate-disposition alerts skipped because `escalation.issue_opened` already covers them (this lane OR `rmd ops`'s poll). */
  skippedDuplicateEscalate: AlertLaneAlert[];
}

/** Every alert taskId this lane has already dispatched — an `alert-lane.dispatched` ledger line. */
export function priorDispatchedAlertIds(lines: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.step === "alert-lane.dispatched" && typeof l.task_id === "string") ids.add(l.task_id);
  }
  return ids;
}

/**
 * Run the lane over a batch of OPEN alerts: decide, ledger the decision, then dedup-and-act on it.
 * See this module's own doc for the full escalate/dispatch dedup contract. Non-open alerts are
 * skipped entirely (mirrors ops.ts's `pollAlerts`, which only ever reasons over `state === "open"`).
 */
export async function runAlertLane(
  alerts: AlertLaneAlert[],
  policy: AlertPolicy,
  deps: AlertLaneDeps,
): Promise<AlertLaneResult> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const priorEscalated = priorEscalatedAlertIds(lines);
  const priorDispatched = priorDispatchedAlertIds(lines);

  const dispatched: AlertLaneAlert[] = [];
  const escalated: AlertLaneAlert[] = [];
  const skippedDuplicateDispatch: AlertLaneAlert[] = [];
  const skippedDuplicateEscalate: AlertLaneAlert[] = [];

  for (const alert of alerts) {
    if (alert.state !== "open") continue;
    const taskId = alertTaskId(alert);
    const disposition = decideAlertDisposition(alert, policy);
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: taskId,
      step: "alert-lane.decided",
      disposition,
      reason: alertDispositionReason(alert, policy),
      origin: `alert#${alertOriginId(alert)}`,
    });

    if (disposition === "escalate") {
      if (priorEscalated.has(taskId)) {
        skippedDuplicateEscalate.push(alert);
        continue;
      }
      await deps.escalate(alert);
      escalated.push(alert);
      continue;
    }

    // act
    if (priorDispatched.has(taskId)) {
      skippedDuplicateDispatch.push(alert);
      continue;
    }
    await deps.dispatch(alert);
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: taskId,
      step: "alert-lane.dispatched",
      origin: `alert#${alertOriginId(alert)}`,
    });
    dispatched.push(alert);
  }

  return { dispatched, escalated, skippedDuplicateDispatch, skippedDuplicateEscalate };
}
