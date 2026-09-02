import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUsageLimitRefusal } from "../src/lib/classify.js";

// ── W1-T2567: the Codex ROLLING-QUOTA-WINDOW refusal, pinned by a REAL captured string ──────
//
// THE GAP THIS CLOSES: `USAGE_LIMIT_TEXT_PATTERNS` (src/lib/classify.ts) held five patterns —
// two Claude-shaped generics plus three Codex-specific HARD refusals (out-of-credits, spend
// cap, plan-upgrade). None of the three Codex-specific patterns is the high-frequency ROLLING
// quota window (the true analogue of Claude's "You've hit your session limit · resets …"), so
// that case was caught only if Codex happened to phrase it with the generic "usage limit"
// wording — coverage nobody had verified.
//
// WHY THIS FIXTURE IS NOT A GUESS: this task is explicit that inventing the regex from a
// guessed string is the one thing it must not do, and Remudero's own log corpus (measured
// 2026-09-01) holds zero Codex refusal rows to capture one from — no codex binary exists on
// this host or in the daemon container either. So the string below is captured from the
// AUTHORITATIVE alternative: the `codex` CLI's own upstream source, which is what literally
// produces the text `codex exec --json` projects as `event.error.message` (see the comment at
// worker-provider.ts's `parseCodexJsonl`, which already cites this exact code path). Pinned at
// openai/codex commit a876a9e49415beee2c7283b6f715cee6e81d4181:
//
//   codex-rs/protocol/src/error.rs — `UsageLimitReachedError`'s `Display` impl: EVERY branch
//   that is not one of the three hard-refusal `RateLimitReachedType` variants (workspace out of
//   credits / spend cap, already pinned in test/classify.test.ts) falls through to text starting
//   "You've hit your usage limit" — including `RateLimitReachedType::RateLimitReached` itself,
//   the rolling-window case's own enum member (see `usage_limit_reached_error_formats_rate_
//   limit_reached_types` in the file below, which asserts RateLimitReached formats identically
//   to a plan with no override type at all).
//
//   codex-rs/protocol/src/error_tests.rs, `usage_limit_reached_error_formats_default_when_none`
//   (lines 310-323): the codex team's OWN pinned fixture for a rolling-quota refusal carrying no
//   plan-specific upsell copy and no stated reset time — `err.to_string()` asserted verbatim as:
//
//       "You've hit your usage limit. Try again later."
//
// This is captured text from the real client's own test suite, not an approximation of what
// Codex might say.
const CAPTURED_ROLLING_QUOTA_REFUSAL = "You've hit your usage limit. Try again later.";

test("detectUsageLimitRefusal: the captured Codex rolling-quota-window refusal is recognised", () => {
  const refusal = detectUsageLimitRefusal(CAPTURED_ROLLING_QUOTA_REFUSAL, Date.now());
  assert.ok(refusal, CAPTURED_ROLLING_QUOTA_REFUSAL);
  // The matched span is evidence, never re-derived — assert it is the captured string itself,
  // not merely that SOMETHING in USAGE_LIMIT_TEXT_PATTERNS fired.
  assert.equal(refusal?.matched, "You've hit your usage limit");
});

test("detectUsageLimitRefusal: the rolling-quota refusal survives being embedded in worker/CLI evidence", () => {
  // A real caller never sees the bare string in isolation — parseCodexJsonl reads it out of a
  // `turn.failed`/`error` event's `error.message` field, which the adapter then appends to
  // ParsedCodexEvents.errors verbatim. Confirm the pattern still fires with realistic surrounding
  // text rather than only against the trimmed fixture.
  const embedded = `Codex exec failed: ${CAPTURED_ROLLING_QUOTA_REFUSAL}`;
  assert.ok(detectUsageLimitRefusal(embedded, Date.now()), embedded);
});

test("detectUsageLimitRefusal: ordinary provider/CLI prose is NOT read as a rolling-quota refusal", () => {
  const controls = [
    // Named explicitly in this task's own rationale as a required negative control: a GitHub
    // REST API rate limit is a DIFFERENT resource than a Codex provider quota window, and must
    // never be conflated with one.
    "rate limit exceeded on the GitHub REST API",
    // Codex discussing usage limits as part of the task's own subject matter, not reporting that
    // this run's account was refused.
    "Codex noted the workspace's usage limit resets nightly, then continued the task successfully.",
    // A turn that failed for an unrelated reason and merely mentions Codex/limits in passing.
    "Codex exec failed: command exited 1 (unrelated compile error), no rate limit involved.",
  ];
  for (const control of controls) {
    assert.equal(detectUsageLimitRefusal(control, Date.now()), undefined, control);
  }
});
