/**
 * W1-T4391: pure TAP parsing, test fingerprinting and failure-to-flake state transitions.
 * serve.ts is the effectful caller: it reads failed job logs and writes events through
 * W1-T4383's `incident.event` ledger schema for the W1-T4385 SRE lane.
 * Fingerprints use only test file+title; a same-sha/same-check pass resolves failure, except
 * tests already observed failing on `main`, which are never mislabeled as flakes.
 *
 * FALSIFIER: test/ci-incidents.test.ts.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LedgerLine } from "./ledger.js";

// ── (i) PARSE — TAP `not ok N - <title>` plus its `location:` diagnostic field ──────────────────
//
// The exact shape this repo's own CI already emits (`node --test`'s default TAP reporter — see
// scripts/test-with-retry.mjs's `parseFailingTestNames`/`parseFailingTestFiles`, which this reuses
// the same two-regex approach as, independently, so ci-incidents.ts never imports a `scripts/`
// module into `src/lib/`). A nested subtest's own `not ok` line carries no indentation in Node's
// TAP output (verified against a real failing run), and its diagnostic block's `location:` field
// is the one place the FILE — never inferable from the title alone — is named.

const TAP_NOT_OK_RE = /^not ok \d+ - (.+)$/;
const TAP_LOCATION_RE = /location:\s*['"](.+?\.test\.(?:[cm]?[jt]s))(?::\d+:\d+)?['"]/;

/** One failing test, as TAP names it: the exact file `location:` points at, and the title on its
 *  `not ok` line. Titles alone are not identities (two files may share one), which is why every
 *  reader here carries both. */
export interface CiFailingTest {
  file: string;
  title: string;
}

/** Extract every distinct `(file, title)` failing test from a TAP log. DEDUPED: a retried or
 *  re-emitted `not ok` for the SAME file+title yields one entry, never two, so a caller never
 *  double-posts one test's failure from a single log. Best-effort and total: a log matching
 *  neither pattern yields `[]` rather than throwing. */
export function parseCiFailingTests(log: string): CiFailingTest[] {
  const seen = new Map<string, CiFailingTest>();
  let pendingTitle: string | undefined;
  let inFailure = false;
  for (const rawLine of log.split(/\r?\n/)) {
    const notOk = rawLine.match(TAP_NOT_OK_RE);
    if (notOk) {
      pendingTitle = notOk[1].trim();
      inFailure = true;
      continue;
    }
    if (inFailure) {
      const location = rawLine.match(TAP_LOCATION_RE);
      if (location && pendingTitle !== undefined) {
        let file = location[1];
        if (file.startsWith("file://")) file = fileURLToPath(file);
        const key = `${file}\u0000${pendingTitle}`;
        if (!seen.has(key)) seen.set(key, { file, title: pendingTitle });
      }
      if (rawLine.trim() === "...") {
        inFailure = false;
        pendingTitle = undefined;
      }
    }
  }
  return [...seen.values()];
}

// ── (ii) FINGERPRINT — by test identity alone, never by run ─────────────────────────────────────

/** sha256 of the test's file and title ONLY — no sha, no run id, no timestamp — so the SAME test
 *  fingerprints alike across every PR and every re-run it ever fails or flakes on. */
export function fingerprintCiTest(file: string, title: string): string {
  return createHash("sha256").update(`test_failure\u0000${file}\u0000${title}`, "utf8").digest("hex");
}

// ── (iii) EVENTS — the design's exact wire shape ─────────────────────────────────────────────────

export interface CiIncidentEventFrame {
  file: string;
  fn: string;
}

/** Design's shape: `{source:"ci", kind, name:<test file>, message:<title>, frames:[{file, fn}],
 *  sha}`, plus the fingerprint every reader needs to group occurrences. */
export interface CiIncidentEvent {
  source: "ci";
  kind: "test_failure" | "flake";
  name: string;
  message: string;
  frames: CiIncidentEventFrame[];
  sha: string;
  fingerprint: string;
}

/** One `test_failure` event per DISTINCT failing test in `log`, fingerprinted by test — a
 *  from-scratch reparse of the same log always yields the same fingerprints, which is exactly
 *  what lets a later pass's `recordCheckRunOutcome` call recognise a resolved one as a flake. */
export function ciIncidentEventsFromLog(log: string, meta: { sha: string }): CiIncidentEvent[] {
  return parseCiFailingTests(log).map((t) => ({
    source: "ci",
    kind: "test_failure",
    name: t.file,
    message: t.title,
    frames: [{ file: t.file, fn: t.title }],
    sha: meta.sha,
    fingerprint: fingerprintCiTest(t.file, t.title),
  }));
}

// ── (iv) STATE MACHINE — failure -> pending -> flake, unless it also breaks main ────────────────

export const DEFAULT_CI_INCIDENT_MAIN_BRANCH = "main";

interface CiIncidentPendingFailure {
  fingerprint: string;
  sha: string;
  checkName: string;
  file: string;
  title: string;
}

/** Threaded explicitly by the caller (serve.ts) across `check_run` deliveries — never a module
 *  singleton, so a test can drive two independent histories side by side. `pending` is every
 *  fingerprint currently failing, keyed by fingerprint+sha+check so overlapping runs cannot
 *  overwrite one another; `knownBrokenOnMain` is
 *  NEVER cleared here — once a fingerprint is seen failing on `mainBranch` it can never again
 *  resolve as a flake, on any sha, on any check. */
export interface CiIncidentState {
  pending: Record<string, CiIncidentPendingFailure>;
  knownBrokenOnMain: Record<string, true>;
}

export function createCiIncidentState(): CiIncidentState {
  return { pending: {}, knownBrokenOnMain: {} };
}

/** One completed check run — the fields `recordCheckRunOutcome` needs, already extracted (and,
 *  for `sha`/`name`/`conclusion`, already signature-verified) by the webhook path before this is
 *  called. `log` is read only when `conclusion === "failure"`; a passing check needs no log at
 *  all to resolve a pending fingerprint. */
export interface CheckRunOutcome {
  sha: string;
  branch: string;
  name: string;
  conclusion: string;
  log?: string;
  /** Defaults to {@link DEFAULT_CI_INCIDENT_MAIN_BRANCH}. */
  mainBranch?: string;
}

/**
 * On `conclusion: "failure"`: parse `check.log` and post one `test_failure` event per failing
 * test (via {@link ciIncidentEventsFromLog}), recording each fingerprint as PENDING at this sha —
 * and, when `check.branch` is the main branch, permanently in `knownBrokenOnMain` too.
 *
 * On `conclusion: "success"`: every PENDING fingerprint recorded against this EXACT sha and check
 * name resolves. One whose fingerprint is in `knownBrokenOnMain` resolves silently — it also
 * fails on main, so this pass was never evidence of a flake. Every other one posts a `flake`
 * event: the same test, at the same commit, failed and then passed with nothing else changing.
 *
 * Any other conclusion (`cancelled`, `neutral`, `skipped`, ...) is a no-op: neither a failure nor
 * a resolving pass, so it changes no state and posts no event.
 *
 * PURE: returns a NEW state, never mutates `state`.
 */
export function recordCheckRunOutcome(
  state: CiIncidentState,
  check: CheckRunOutcome,
): { state: CiIncidentState; events: CiIncidentEvent[] } {
  const mainBranch = check.mainBranch ?? DEFAULT_CI_INCIDENT_MAIN_BRANCH;
  const isMain = check.branch === mainBranch;
  const pending = { ...state.pending };
  const knownBrokenOnMain = { ...state.knownBrokenOnMain };
  const events: CiIncidentEvent[] = [];

  if (check.conclusion === "failure") {
    for (const event of ciIncidentEventsFromLog(check.log ?? "", { sha: check.sha })) {
      events.push(event);
      const pendingKey = `${event.fingerprint}\u0000${check.sha}\u0000${check.name}`;
      pending[pendingKey] = {
        fingerprint: event.fingerprint,
        sha: check.sha,
        checkName: check.name,
        file: event.name,
        title: event.message,
      };
      if (isMain) knownBrokenOnMain[event.fingerprint] = true;
    }
  } else if (check.conclusion === "success") {
    for (const [pendingKey, failure] of Object.entries(pending)) {
      if (failure.sha !== check.sha || failure.checkName !== check.name) continue;
      delete pending[pendingKey];
      if (knownBrokenOnMain[failure.fingerprint]) continue; // also broken on main: a real break, not a flake.
      events.push({
        source: "ci",
        kind: "flake",
        name: failure.file,
        message: failure.title,
        frames: [{ file: failure.file, fn: failure.title }],
        sha: check.sha,
        fingerprint: failure.fingerprint,
      });
    }
  }

  return { state: { pending, knownBrokenOnMain }, events };
}

// ── (v) LEDGER — incident-events.ts's own step, never a second schema ───────────────────────────

/** Reuses W1-T4383's `incident.event` step (incident-events.ts's `buildIncidentEventsRoute`
 *  ledgers the identical step for its own console/gateway/daemon events) so the SRE lane's reader
 *  never special-cases a CI-sourced row. */
export const CI_INCIDENT_STEP = "incident.event";

/** One {@link CiIncidentEvent} as the `incident.event` ledger row serve.ts's `onCheckRunCompleted`
 *  hook appends. */
export function ciIncidentEventLedgerLine(event: CiIncidentEvent, nowMs: number): LedgerLine {
  return {
    run_id: `CI-INCIDENT-${nowMs}-${event.fingerprint.slice(0, 12)}`,
    task_id: "INCIDENT",
    step: CI_INCIDENT_STEP,
    fingerprint: event.fingerprint,
    source: event.source,
    kind: event.kind,
    name: event.name,
    message: event.message,
    sha: event.sha,
  };
}
