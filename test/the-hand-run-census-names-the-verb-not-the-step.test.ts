/**
 * test/the-hand-run-census-names-the-verb-not-the-step.test.ts — W1-T3683: `hand-run-census.ts`
 * used to keep only a `cli.invoked` row's constant `step`, so a session of hand-typed commands
 * reported as `cli.invoked -> cli.invoked` no matter which verbs were actually run. These four
 * tests are the task's own falsifier, each proving one design note directly against the
 * exported readers rather than against a live ledger corpus.
 *
 * Kept out of `plan/tasks.d/W1-T3683-...yaml`'s `files:` for the reason W1-T3680 records.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHandRunSessions,
  handRunSequenceSignature,
  parseOperatorLedgerRows,
  alreadyProposedForSignature,
  HAND_RUN_SEQUENCE_SCHEMA_VERSION,
} from "../src/lib/hand-run-census.js";

/** One raw `cli.invoked` ledger line, `verb` omitted entirely when `undefined` — never written
 *  as a literal `null`/placeholder, matching how a real pre-verb-field row (or a torn one) would
 *  actually be missing the key rather than carrying a guessed value for it. */
function cliLine(ts: string, actorPid: number, verb: string | undefined): string {
  const raw: Record<string, unknown> = { ts, actor: "operator", actor_pid: actorPid, step: "cli.invoked" };
  if (verb !== undefined) raw.verb = verb;
  return JSON.stringify(raw);
}

// ── acceptance 1: a session of CLI invocations reports the verbs that were run ──────────────

test("a session of cli invocations reports its verbs, not the constant cli.invoked step", () => {
  const rows = parseOperatorLedgerRows([
    cliLine("2026-09-01T10:00:00.000Z", 111, "check-acceptance"),
    cliLine("2026-09-01T10:01:00.000Z", 111, "merge"),
  ]);
  const sessions = buildHandRunSessions(rows);
  assert.equal(sessions.length, 1);
  // Falsifier: keep collecting `step` here and this reads ["cli.invoked", "cli.invoked"] instead.
  assert.deepEqual(sessions[0].sequence, ["check-acceptance", "merge"]);
});

// ── acceptance 2: two sessions of different verbs produce different signatures ──────────────

test("two sessions running different verbs produce different signatures", () => {
  const rowsA = parseOperatorLedgerRows([
    cliLine("2026-09-01T10:00:00.000Z", 111, "check-acceptance"),
    cliLine("2026-09-01T10:01:00.000Z", 111, "merge"),
  ]);
  const rowsB = parseOperatorLedgerRows([
    cliLine("2026-09-01T11:00:00.000Z", 222, "status"),
    cliLine("2026-09-01T11:01:00.000Z", 222, "triage"),
  ]);
  const signatureA = handRunSequenceSignature(buildHandRunSessions(rowsA)[0].sequence);
  const signatureB = handRunSequenceSignature(buildHandRunSessions(rowsB)[0].sequence);
  // Falsifier: collapse both to `step` and both signatures read "cli.invoked|cli.invoked" — equal.
  assert.notEqual(signatureA, signatureB);
});

// ── acceptance 3: a cli.invoked row with no verb is skipped, never guessed at ───────────────

test("a cli row with no verb is skipped", () => {
  const rows = parseOperatorLedgerRows([
    cliLine("2026-09-01T10:00:00.000Z", 111, undefined),
    cliLine("2026-09-01T10:01:00.000Z", 111, "merge"),
  ]);
  // Falsifier: substitute a placeholder for the missing verb and this reads length 2, rows[0]
  // being the verb-less row rather than the one real verb that followed it.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verb, "merge");
});

// ── acceptance 4: a pre-change proposal signature is not read as agreement with a new one ──

test("a pre-change proposal signature is not read as agreement with a same-text new-era signature", () => {
  const signature = "check-acceptance|merge";
  const stalePreChangeProposal = JSON.stringify({ step: "hand_run.census_proposed", signature });
  const currentEraProposal = JSON.stringify({
    step: "hand_run.census_proposed",
    signature,
    sequence_schema_version: HAND_RUN_SEQUENCE_SCHEMA_VERSION,
  });

  // Falsifier: match an old signature against a new one and this reads true.
  assert.equal(alreadyProposedForSignature([stalePreChangeProposal], signature), false);
  // Confirms the discrimination is about the ERA marker, not about the signature text itself —
  // the identical signature filed under the current era IS read as agreement.
  assert.equal(alreadyProposedForSignature([currentEraProposal], signature), true);
});
