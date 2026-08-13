/**
 * W1-T462 — THE ALERT POLLER EXISTED AND NOTHING RAN IT.
 *
 * MEASURED across all three ledger forms (666 gz / 4 plain / 1 live): `ops.alerts_polled` had TWO
 * rows in the entire corpus, both in archives from 2026-07-21 and 2026-08-02, while its sibling
 * `ops.feedback_reconciled` had 88 including 11 live — so `rmd ops` ran and its ALERT half did not.
 * `alert-fix.*` had never run at all (positive control: `sweep.pass` = 1,897 over the same corpus).
 * Nothing scheduled `opsCommand`: no daemon hook, no workflow, no launchd unit. Ten OSV advisories
 * accumulated until a human asked.
 *
 * THE GAP WAS CADENCE, NOT CAPABILITY, so this suite tests the CADENCE DECISION and the DEDUPE —
 * never a re-implementation of the poller, which `lib/ops.ts` already owns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideAlertPoll } from "../src/lib/daemon.js";
import { priorEscalatedAlertIds } from "../src/lib/ops.js";
import { opsCommand } from "../src/run-task.js";
import { readLedgerLines, readLedgerUnionBounded } from "../src/lib/status.js";

const base = {
  enabled: true,
  idle: true,
  now: new Date("2026-08-13T20:00:00.000Z"),
  minIntervalMinutes: 60,
};

// ── DIRECTION 1: it fires on a cadence rather than only when a human invokes it ────────────────

test("a poll that has NEVER run fires — the state ten advisories accumulated in", () => {
  const d = decideAlertPoll({ ...base, lastPollIso: undefined });
  assert.equal(d.fire, true);
  assert.match(d.reason, /first run/);
});

test("a poll whose interval has elapsed fires, so the cadence is real", () => {
  const d = decideAlertPoll({ ...base, lastPollIso: "2026-08-13T18:30:00.000Z" });
  assert.equal(d.fire, true, "90 minutes against a 60-minute interval must fire");
});

// ── DIRECTION 2: it is not a noise source ─────────────────────────────────────────────────────

test("a poll inside its interval does NOT fire — the cadence is not a per-tick poller", () => {
  // THE TRAP THIS GUARDS: a hook that fired every tick would poll three `gh api` endpoints on every
  // daemon iteration. The fix rung dispatched two workers for zero failing checks today; a bound
  // firing on a healthy condition is this repo's most-measured defect class.
  const d = decideAlertPoll({ ...base, lastPollIso: "2026-08-13T19:30:00.000Z" });
  assert.equal(d.fire, false, "30 minutes against a 60-minute interval must not fire");
  assert.match(d.reason, /under the 60m interval/);
});

test("a non-idle daemon does NOT poll — the same gate decideAutoTriage applies, for the same reason", () => {
  const d = decideAlertPoll({ ...base, idle: false, lastPollIso: undefined });
  assert.equal(d.fire, false);
  assert.match(d.reason, /not idle/);
});

test("disabled means disabled, whatever the interval says", () => {
  const d = decideAlertPoll({ ...base, enabled: false, lastPollIso: undefined });
  assert.equal(d.fire, false);
  assert.match(d.reason, /disabled/);
});

test("an UNREADABLE last-poll timestamp fails CLOSED, never open", () => {
  // W1-T119's law in the cadence's own terms: a marker we cannot parse is not a marker that said
  // "go". Failing open here would poll every tick — the exact noise the interval exists to stop.
  const d = decideAlertPoll({ ...base, lastPollIso: "not-a-timestamp" });
  assert.equal(d.fire, false);
  assert.match(d.reason, /unreadable — failing closed/);
});

// ── DIRECTION 3: THE TRAP — an already-escalated alert must NOT escalate again ─────────────────

test("an alert escalated ONLY in a rotation is still seen as escalated — the union read", () => {
  // THE DEFECT A CADENCE WOULD HAVE AMPLIFIED. `pollAlerts` defaults its dedupe to
  // `readLedgerLines`, which opens ONE file, while its key `escalation.issue_opened` is capped by
  // rotation at MAX_RETAINED_LINES_PER_STEP (200). MEASURED on this host: the live file exposed 107
  // distinct escalated ids against 207 across the union — 100 already-escalated alerts invisible,
  // each of which a re-poll would have escalated a second time.
  const dir = mkdtempSync(join(tmpdir(), "w1t462-"));
  const path = join(dir, "ledger.ndjson");
  const row = (id: string) => JSON.stringify({ ts: "2026-08-12T00:00:00.000Z", step: "escalation.issue_opened", task_id: id });
  try {
    // live file carries ONLY the newest; the older escalation lives in a rotation
    writeFileSync(path, row("alert#code-scanning-999") + "\n");
    writeFileSync(join(dir, "ledger.2026-08-11T00-00-00-000Z.ndjson"), row("alert#code-scanning-111") + "\n");
    writeFileSync(join(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(row("alert#dependabot-222") + "\n")));

    // the DEFECT, reproduced: the one-file reader cannot see the older two
    const oneFile = priorEscalatedAlertIds(readLedgerLines(path));
    assert.equal(oneFile.has("alert#code-scanning-111"), false, "this is the bug");
    assert.equal(oneFile.has("alert#dependabot-222"), false, "and the gzipped half too");

    // the FIX: the union reader the caller now injects
    const union = priorEscalatedAlertIds(
      readLedgerUnionBounded(path),
    );
    assert.equal(union.has("alert#code-scanning-999"), true, "the live one is still seen");
    assert.equal(union.has("alert#code-scanning-111"), true, "the rotated one must be seen — else it re-escalates");
    assert.equal(union.has("alert#dependabot-222"), true, "including the gzipped rotation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an alert that was NEVER escalated is still absent — the union does not invent credit", () => {
  // The falsifier for the test above: a reader that returned every id would pass it while silently
  // suppressing every genuine new escalation, which is the opposite and worse failure.
  const dir = mkdtempSync(join(tmpdir(), "w1t462-neg-"));
  const path = join(dir, "ledger.ndjson");
  try {
    writeFileSync(path, JSON.stringify({ ts: "2026-08-12T00:00:00.000Z", step: "escalation.issue_opened", task_id: "alert#a" }) + "\n");
    const union = priorEscalatedAlertIds(
      readLedgerUnionBounded(path),
    );
    assert.equal(union.has("alert#a"), true);
    assert.equal(union.has("alert#never-escalated"), false, "a new alert must still be escalatable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("WIRING: opsCommand passes a readLedger that SEES A ROTATION, proved by executing it", async () => {
  // This replaced a source-text assertion. The regex version passed while the falsifier stayed
  // GREEN, because nothing executed the injected lambda — the wiring-vs-reader defect #1688 caught
  // on the status board. Driving opsCommand with a fake pollAlerts captures the REAL readLedger and
  // runs it against a corpus whose only escalation lives in a rotation.
  const dir = mkdtempSync(join(tmpdir(), "w1t462-wire-"));
  const path = join(dir, "ledger.ndjson");
  const row = (id: string) => JSON.stringify({ ts: "2026-08-12T00:00:00.000Z", step: "escalation.issue_opened", task_id: id });
  let captured: ((p: string) => Array<Record<string, unknown>>) | undefined;
  try {
    writeFileSync(path, row("alert#live-one") + "\n");
    writeFileSync(join(dir, "ledger.2026-08-11T00-00-00-000Z.ndjson"), row("alert#rotated-one") + "\n");

    const SENTINEL = "stop-after-capture";
    await assert.rejects(
      () => opsCommand([], {
      loadConfig: (() => ({ root: dir })) as unknown as typeof import("../src/lib/config.js").loadConfig,
      resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
      pollAlerts: ((_o: string, _r: string, d: { readLedger?: (p: string) => Array<Record<string, unknown>> }) => {
          captured = d.readLedger;
          // Throw once the dep is captured: the real downstream would render a summary this fake
          // has no business constructing, and a fake that returns a wrong shape fails AFTER the
          // test ends as an unhandled rejection rather than as an assertion.
          throw new Error(SENTINEL);
        }) as never,
      }),
      (e: Error) => e.message === SENTINEL,
      "opsCommand must reach pollAlerts",
    );

    assert.ok(captured, "opsCommand must pass a readLedger — the default opens ONE file");
    const ids = priorEscalatedAlertIds(captured!(path));
    assert.equal(ids.has("alert#live-one"), true, "the live escalation is seen");
    assert.equal(
      ids.has("alert#rotated-one"),
      true,
      "the ROTATED escalation must be seen — 100 of 207 ids were invisible to the one-file default, and each would re-escalate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
