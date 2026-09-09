/**
 * W1-T2993 — a CANCELLED preflight suite is reported as cancelled and NAMED, never folded into
 * `failing_tests`.
 *
 * THE INCIDENT. `test/entrypoint-boot.test.ts` blocked at file scope inside the daemon container
 * (an inherited `RMD_RESTART_THROTTLE_S` sent `deploy/entrypoint.sh` down its supervised branch).
 * The runner cancelled it and every other in-flight subtest. The preflight reported
 * `exit_class: tests_failed` with a `failing_tests` list clustered in self-sync/freshness/deploy —
 * every one of which passes on origin/main — and did not name the file that actually hung at all.
 * Three days of diagnosis went to four innocent files.
 *
 * TWO FACTS, NOT ONE. A cancelled suite and a failed assertion are different, and conflating them
 * is not merely imprecise: a cancelled run's failure set is a SUBSET BY CONSTRUCTION, so the
 * shorter list reads as "fewer problems" when it means "less was seen". Both halves are pinned
 * here — the classifier that separates them, and the escalation notice that renders them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyPreflightOutput, ordinaryTestFailureClass } from "../src/lib/retro-preflight.js";
import { escalateRetroPublicationFailure } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW_MS = Date.parse("2026-09-09T02:30:00.000Z");

function tmp(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

/** The runner's real shape when one file blocks: the hung file reports a timeout, the subtests it
 *  took down report `cancelledByParent`, and one genuine assertion failure sits alongside. */
const HUNG_RUN = [
  "TAP version 13",
  "# Subtest: test/entrypoint-boot.test.ts",
  "not ok 1 - test/entrypoint-boot.test.ts",
  "  ---",
  "  duration_ms: 45000.1",
  "  type: 'test'",
  "  failureType: 'testTimeoutFailure'",
  "  error: 'test timed out after 45000ms'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "not ok 2 - the self-sync refuses a stale checkout",
  "  ---",
  "  duration_ms: 12.5",
  "  failureType: 'cancelledByParent'",
  "  error: 'test did not finish before its parent pool was terminated'",
  "  ...",
  "not ok 3 - the freshness gate names the behind-count",
  "  ---",
  "  duration_ms: 3.1",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "  code: 'ERR_ASSERTION'",
  "  ...",
  "1..3",
  "# tests 3",
  "# pass 0",
  "# fail 1",
  "# cancelled 2",
  "",
].join("\n");

// ── The classifier ──────────────────────────────────────────────────────────────────────────

test("W1-T2993: a cancelled suite is named as cancelled rather than reported as failing tests", () => {
  const c = classifyPreflightOutput(HUNG_RUN);

  // The file that actually hung is NAMED, and named as cancelled.
  assert.deepEqual(c.cancelledTests, ["test/entrypoint-boot.test.ts", "the self-sync refuses a stale checkout"]);

  // ...and it is NOT in the failing list, which carries only the test that really asserted and
  // failed. This is the whole defect: the pre-fix reader put all three here.
  assert.deepEqual(c.failingTests, ["the freshness gate names the behind-count"]);
  assert.ok(
    !c.failingTests.includes("test/entrypoint-boot.test.ts"),
    "the hung file must never appear as a failing test",
  );

  // The runner's own total is carried, so a reader can tell 2 cancelled from 0.
  assert.equal(c.cancelledCount, 2);
  assert.equal(c.hasSummary, true);

  // And the exit class says what happened. `tests_failed` on this run is the claim that sent three
  // days of diagnosis to the wrong files.
  assert.equal(ordinaryTestFailureClass(c), "tests_cancelled");
});

test("W1-T2993: a clean assertion failure is still tests_failed — the new class must not swallow the ordinary case", () => {
  const c = classifyPreflightOutput(
    [
      "not ok 1 - the freshness gate names the behind-count",
      "  ---",
      "  failureType: 'testCodeFailure'",
      "  code: 'ERR_ASSERTION'",
      "  ...",
      "1..1",
      "# tests 1",
      "# fail 1",
      "# cancelled 0",
      "",
    ].join("\n"),
  );
  assert.deepEqual(c.failingTests, ["the freshness gate names the behind-count"]);
  assert.deepEqual(c.cancelledTests, []);
  assert.equal(c.cancelledCount, 0);
  assert.equal(ordinaryTestFailureClass(c), "tests_failed");
});

test("W1-T2993: a run with NO summary is tests_no_summary — its failure list is a subset, not a total", () => {
  // A killed or timed-out runner prints every assertion it reached and no totals. Reporting that as
  // `tests_failed` presents a subset as a complete result.
  const c = classifyPreflightOutput(
    ["not ok 1 - something that did fail", "  ---", "  code: 'ERR_ASSERTION'", "  ...", ""].join("\n"),
  );
  assert.equal(c.hasSummary, false);
  assert.equal(c.cancelledCount, undefined);
  assert.equal(ordinaryTestFailureClass(c), "tests_no_summary");
});

test("W1-T2993: the spec reporter's ✖ lines still parse, and count as failures not cancellations", () => {
  const c = classifyPreflightOutput(["  ✖ a spec-reported failure (3.2ms)", "# tests 1", ""].join("\n"));
  assert.deepEqual(c.failingTests, ["a spec-reported failure"]);
  assert.deepEqual(c.cancelledTests, []);
});

// ── The escalation notice, which is where a human actually reads it ─────────────────────────

test("W1-T2993: the escalation notice names the cancelled suite FIRST and says the failing list is a subset", () => {
  const root = tmp("retro-preflight-notice-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const ledgerPath = join(stateDir, "ledger.ndjson");
    writeFileSync(ledgerPath, "");

    const rows = [
      { ts: new Date(NOW_MS - 60 * 60_000).toISOString(), step: "retro.preflight_failed", run_id: "R1", task_id: "RETRO" },
      { ts: new Date(NOW_MS - 40 * 60_000).toISOString(), step: "retro.preflight_failed", run_id: "R2", task_id: "RETRO" },
      {
        ts: new Date(NOW_MS - 20 * 60_000).toISOString(),
        step: "retro.preflight_failed",
        run_id: "R3",
        task_id: "RETRO",
        exit_class: "tests_cancelled",
        failing_tests: ["the freshness gate names the behind-count"],
        cancelled_tests: ["test/entrypoint-boot.test.ts"],
        has_summary: true,
      },
    ];

    // A create-only gateway: no network, records what it was asked to raise.
    const raisedIssues: Array<{ title: string; body: string }> = [];
    const decision = escalateRetroPublicationFailure(
      { attempts: 3 },
      {
        owner: "o",
        repo: "r",
        ledgerPath,
        runId: "RETRO-TEST",
        nowMs: NOW_MS,
        readLedger: () => rows,
        issues: {
          create: (title: string, body: string) => (raisedIssues.push({ title, body }), "https://example.invalid/issues/1"),
        },
      } as unknown as Parameters<typeof escalateRetroPublicationFailure>[1],
    );

    assert.equal(decision.escalate, true, "the strike cap in one episode must escalate, or this case proves nothing");
    assert.equal(raisedIssues.length, 1, "the notice must actually reach the operator");
    const body = raisedIssues[0]!.body;
    assert.match(body, /START HERE/, "the notice must lead with the cancelled suite");
    assert.match(body, /test\/entrypoint-boot\.test\.ts/, "the suite that hung must be named");
    assert.match(body, /SUBSET BY CONSTRUCTION/, "the notice must say the failing list is incomplete");
    // The cancelled suite is named ABOVE the failing list, not appended after it.
    assert.ok(
      body.indexOf("test/entrypoint-boot.test.ts") < body.indexOf("Failing tests reported by"),
      "the cancelled suite must appear before the failing list, not after it",
    );

    // The row really landed, with the class the classifier chose.
    const written = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const escalated = written.find((r) => r.step === "retro.publication.escalated");
    assert.equal(escalated?.exit_class, "tests_cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
