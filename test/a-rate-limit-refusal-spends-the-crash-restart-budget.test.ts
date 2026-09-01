// test/a-rate-limit-refusal-spends-the-crash-restart-budget.test.ts — W1-T2546.
//
// OBSERVED, not argued. The operator's own daemon log, 2026-08-31 18:42-18:44 UTC:
//
//   stopped   : error — W1-T2508: Command failed: gh api repos/craigoley/remudero/pulls/3428
//   gh: API rate limit exceeded for user ID <id> ... (HTTP 403)
//   rmd-entrypoint: exited 1 — sleeping 120s before exiting so the restart is rate-limited
//
// Two PRs had ALREADY been opened successfully; the pass died reading one back. Nothing about the
// tree, the plan or the code was wrong, and the correct response was to WAIT — but it surfaced as
// `stopReason: "error"`, mapped to 1, and docker's `on-failure` budget counted the restart. That
// is the same category error W1-T2537 already won for `blocked`, one category over: a budget
// sized for crashes consumed by an outage that resolves itself. During a lockout window (this
// account has seen a ~90-minute secondary limit) EVERY pass can die this way, so the budget drains
// at the rate the limiter refuses and the fleet ends up dead with a red board and no failing check
// to explain it.
//
// WHAT THE SHARD GOT WRONG, CORRECTED HERE. Its rationale (4) says the discriminator should be
// "the HTTP status plus the refusing endpoint, both of which the failing call has." It does not:
// `runDaemon` captures a fatal error as `String((err as Error)?.message ?? err)` and the summary
// carries `${taskId}: ${message}`, so by the time ANY exit code is computed the exception has been
// stringified — no status object, no headers, no endpoint. The text is genuinely all there is.
//
// SO THE DECISION IS DELEGATED RATHER THAN RE-DERIVED. `classifyFailure` (src/lib/classify.ts) is
// this repo's ONE failure classifier and already reads rate-limit backpressure, 5xx, transport
// faults and runner loss as "transient". Asking it — instead of hand-rolling a fourth copy of
// those signatures beside `TRANSIENT_TEXT_PATTERNS`, `armFailureIsRateLimited` and
// `armFailureAction` — is what makes this NOT a rate-limit special case, and what the last test
// below proves: an entirely different transient signature gets the same code, so the arm cannot be
// a bespoke match on one provider's current wording.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DAEMON_EXIT_BLOCKED,
  DAEMON_EXIT_ENVIRONMENTAL,
  DAEMON_EXIT_STALE,
  daemonExitCode,
  daemonExitCodeForSummary,
} from "../src/lib/daemon.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The VERBATIM failure the daemon summary carried, as pasted from the operator's log. */
const OBSERVED =
  "W1-T2508: Command failed: gh api repos/craigoley/remudero/pulls/3428\n" +
  "gh: API rate limit exceeded for user ID 4397075. If you reach out to GitHub Support for help, " +
  "please include the request ID AF1E:17F718:175B5A3F:4D82564E:6A95CB31 and timestamp " +
  "2026-08-31 18:42:57 UTC. For more on scraping GitHub and how it may affect your rights, please " +
  "review our Terms of Service (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) (HTTP 403)";

test("W1-T2546 criterion 1: a rate-limit refusal is classified as environmental rather than as a crash", () => {
  const code = daemonExitCodeForSummary({ stopReason: "error", stopDetail: OBSERVED });
  assert.equal(code, DAEMON_EXIT_ENVIRONMENTAL);
  assert.notEqual(code, 1, "1 is the crash code docker's on-failure budget counts — this must not be it");
});

test("W1-T2546 criterion 2: an environmental refusal exits with its own code, distinct from every other stop", () => {
  // A distinct number is the whole mechanism: the entrypoint dispatches on it, so sharing a code
  // with `blocked` or `stale` would route this into the wrong retry arm with the wrong pause.
  const codes = [DAEMON_EXIT_STALE, DAEMON_EXIT_BLOCKED, DAEMON_EXIT_ENVIRONMENTAL, 0, 1];
  assert.equal(new Set(codes).size, codes.length, "every daemon exit code must be distinct");
  // And the three non-crash reasons still resolve exactly as they did before this task.
  assert.equal(daemonExitCodeForSummary({ stopReason: "stopped" }), 0);
  assert.equal(daemonExitCodeForSummary({ stopReason: "max_reached" }), 0);
  assert.equal(daemonExitCodeForSummary({ stopReason: "stale" }), DAEMON_EXIT_STALE);
  assert.equal(daemonExitCodeForSummary({ stopReason: "blocked" }), DAEMON_EXIT_BLOCKED);
});

test("W1-T2546 criterion 3: an unrecognised failure still exits as a crash, so this can only ever NARROW what counts as one", () => {
  // A real defect — the population the crash budget exists to bound.
  for (const detail of [
    "W1-T1: TypeError: Cannot read properties of undefined (reading 'id')",
    "W1-T2: AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
    "W1-T3: SyntaxError: Unexpected end of input",
  ]) {
    assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: detail }), 1, detail);
  }
  // And the fail-closed default: no detail at all is a crash, never an assumed refusal.
  assert.equal(daemonExitCodeForSummary({ stopReason: "error" }), 1);
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: "" }), 1);
});

test("W1-T2546 criterion 4: the classifier keys on the refusal itself, not on this provider's current wording", () => {
  // THE DISCRIMINATING TEST. If this arm were a bespoke match on GitHub's rate-limit phrasing,
  // these other environmental refusals — nothing to do with a rate limit, and carrying none of its
  // words — would still read as crashes. They do not, because the decision is delegated to the
  // repo's one classifier rather than re-derived here.
  for (const detail of [
    "W1-T1: Command failed: git fetch origin main\nfatal: unable to access ...: Could not resolve host: github.com",
    "W1-T2: Command failed: gh api ...\nread ECONNRESET",
    "W1-T3: Command failed: gh api ...\nHTTP/2 503 Service Unavailable",
    "W1-T4: The runner has received a shutdown signal",
  ]) {
    assert.equal(
      daemonExitCodeForSummary({ stopReason: "error", stopDetail: detail }),
      DAEMON_EXIT_ENVIRONMENTAL,
      `an environmental refusal with no rate-limit wording must still be environmental: ${detail.slice(0, 40)}`,
    );
  }
  // The corollary, stated as its own assertion: the pure reason -> code map is UNCHANGED, so a
  // caller that has no detail (including the point-free `reasons.map(daemonExitCode)` callers this
  // task deliberately did not widen) behaves exactly as it did before.
  assert.equal(daemonExitCode("error"), 1);
  assert.deepEqual((["stopped", "blocked", "stale", "error"] as const).map(daemonExitCode), [
    0,
    DAEMON_EXIT_BLOCKED,
    DAEMON_EXIT_STALE,
    1,
  ]);
});

test("W1-T2546: the entrypoint's environmental code is the SAME NUMBER as DAEMON_EXIT_ENVIRONMENTAL, not a drifting literal", () => {
  // Same parity guard W1-T490 and W1-T2537 already established for their own codes: the shell
  // script cannot import a TypeScript constant, so the duplication is deliberate and this test is
  // what makes a drift a red test rather than a silent mis-route.
  const script = readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8");
  const m = script.match(/^DAEMON_EXIT_ENVIRONMENTAL=(\d+)$/m);
  assert.ok(m, "the entrypoint must define DAEMON_EXIT_ENVIRONMENTAL as a plain assignment this test can read");
  assert.equal(Number(m![1]), DAEMON_EXIT_ENVIRONMENTAL, "entrypoint and daemon.ts disagree about the environmental exit code");
  // And it is actually DISPATCHED on, not merely declared — a constant nothing branches on would
  // leave the budget spent exactly as before while looking fixed.
  assert.match(script, /if \[ "\$rc" -eq "\$DAEMON_EXIT_ENVIRONMENTAL" \] && \[ "\$environmental_restarts" -lt "\$ENVIRONMENTAL_RESTART_MAX" \]; then/);
  assert.match(script, /environmental_restarts=\$\(\(environmental_restarts \+ 1\)\)/);
  assert.match(script, /^environmental_restarts=0$/m, "the counter must be initialised before the loop");
});

test("W1-T2546: the in-container retry is BOUNDED, so a bound is replaced rather than removed", () => {
  const script = readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8");
  // Past the cap it must fall through to the crash throttle, which is what keeps docker's
  // on-failure budget as the outer bound rather than leaving the container to spin forever.
  assert.match(script, /ENVIRONMENTAL_RESTART_MAX="\$\{RMD_ENVIRONMENTAL_RESTART_MAX:-100\}"/);
  assert.match(script, /exited \$rc \(environmental\) — but \$\{ENVIRONMENTAL_RESTART_MAX\} in-container restarts are already spent/);
  // The pause is deliberately LONGER than the blocked one: waiting is the entire remedy here, and
  // a primary limit resets on the hour while a secondary has held this account for ~90 minutes.
  assert.match(script, /ENVIRONMENTAL_RESTART_PAUSE_S="\$\{RMD_ENVIRONMENTAL_RESTART_PAUSE_S:-300\}"/);
});
