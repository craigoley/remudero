/**
 * test/fix-error-class-field.test.ts — W1-T2444.
 *
 * THE DEFECT. `sweep.fix.error` is one step name that, across 135 historical rows, actually
 * splits 55/42/38 into three unrelated defects with DISJOINT windows: a shared worker home
 * (W1-T2441), a shared `.git/config` lock contended by concurrent `checkout -B`s, and GitHub
 * GraphQL rate-limit exhaustion. `checkout-B` stopped firing on 2026-08-22 and `sigkill` did not
 * start until 2026-08-25 — they never overlap — so any rate quoted off the bare step name
 * averages a class over days it emitted nothing, describing no process that ever ran. The row
 * carried no field that survived a message reword; only the free-text `error` string said which
 * of the three fired.
 *
 * THE FIX. `fixDispatchErrorClass` (run-task.ts) classifies a caught `dispatchFix` failure into
 * `"sigkill"` / `"checkout_b"` / `"gh_pr_view"` off the SAME message `dispatchFixCatchOutcome`
 * already builds for the `error` field, using the signal death structurally (never a "SIGKILL"
 * substring match) for the first predicate. `dispatchFixCatchOutcome` spreads a `class` field
 * into `ledgerFields` conditionally — the same shape `signal`/`cost_usd` already established —
 * ONLY when a class is recognised; an unrecognised failure carries no `class` field at all rather
 * than a forced `"unclassified"` string. No new ledger step: this is still written under
 * `sweep.fix.error`, so `DECISION_RELEVANT_LEDGER_STEPS` (lib/ledger.ts) is untouched, and the 135
 * existing historical rows are not rewritten.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchFixCatchOutcome, fixDispatchErrorClass } from "../src/run-task.js";

// ── acceptance 1: the class is recorded structurally, not only in the free-text `error` prose ───

test("W1-T2444: a signal-terminated failure classifies as sigkill, read STRUCTURALLY off signalDeath, never off a message substring", () => {
  const signalDeath = { signal: "SIGKILL", costUsd: 0 };
  assert.equal(fixDispatchErrorClass("some unrelated message with no signal words at all", signalDeath), "sigkill");

  const err = Object.assign(new Error("Claude Code process terminated by signal SIGKILL"), {
    signal: "SIGKILL",
    errorClass: "process_killed_by_signal",
  });
  const outcome = dispatchFixCatchOutcome(err, true);
  assert.equal(outcome.ledgerFields.class, "sigkill", "the row itself carries the structural class");
});

test("W1-T2444: a checkout -B config-lock failure classifies as checkout_b", () => {
  const message =
    "Command failed: git -C /home/node/Remudero/worktrees/sweep-W1T9999-1786500000000 checkout -B " +
    "run-W1T9999-1786500000000 origin/run-W1T9999-1786500000000\n" +
    "error: could not lock config file /home/node/Remudero/remudero/.git/config: File exists\n" +
    "error: unable to write upstream branch configuration";
  assert.equal(fixDispatchErrorClass(message, undefined), "checkout_b");

  const err = new Error(message);
  const outcome = dispatchFixCatchOutcome(err, true);
  assert.equal(outcome.ledgerFields.class, "checkout_b");
});

test("W1-T2444: a gh pr view failure classifies as gh_pr_view, whether GraphQL-budget or a bare HTTP 503", () => {
  const rateLimited = "Command failed: gh pr view 88 --json headRefName\nGraphQL: API rate limit already exceeded for user ID 12345 (rateLimited)";
  assert.equal(fixDispatchErrorClass(rateLimited, undefined), "gh_pr_view");

  const unavailable = "Command failed: gh pr view 88 --json headRefName\nHTTP 503: No server is currently available to service your request";
  assert.equal(fixDispatchErrorClass(unavailable, undefined), "gh_pr_view");

  const err = new Error(rateLimited);
  const outcome = dispatchFixCatchOutcome(err, true);
  assert.equal(outcome.ledgerFields.class, "gh_pr_view");
});

// ── acceptance 2: existing signal/cost_usd fields are unchanged and still conditional ────────────

test("W1-T2444: signal/cost_usd stay conditional and unaffected by the new class field", () => {
  const signalErr = Object.assign(new Error("terminated by signal SIGKILL"), { signal: "SIGKILL", costUsd: 1.5 });
  const withSignal = dispatchFixCatchOutcome(signalErr, true);
  assert.equal(withSignal.ledgerFields.signal, "SIGKILL");
  assert.equal(withSignal.ledgerFields.cost_usd, 1.5);
  assert.equal(withSignal.ledgerFields.class, "sigkill");

  const ordinaryErr = new Error("some ordinary failure with no signal, no checkout -B, no gh pr view");
  const withoutSignal = dispatchFixCatchOutcome(ordinaryErr, true);
  assert.equal(withoutSignal.ledgerFields.signal, undefined, "no signal field on an ordinary failure — unchanged");
  assert.equal(withoutSignal.ledgerFields.cost_usd, undefined, "no cost_usd field on an ordinary failure — unchanged");
});

// ── acceptance 3: an unrecognised failure is left unclassified, never forced into a class ────────

test("W1-T2444: an unrecognised failure carries no class field at all — never a forced 'unclassified' string", () => {
  assert.equal(fixDispatchErrorClass("some novel failure nobody has classified yet", undefined), undefined);

  const err = new Error("npm install failed: ENOTFOUND registry.npmjs.org");
  const outcome = dispatchFixCatchOutcome(err, true);
  assert.equal(outcome.ledgerFields.class, undefined, "left absent, not forced into any of the three known classes");
  assert.ok(!("class" in outcome.ledgerFields), "the key itself is absent, matching the signal/cost_usd conditional-spread precedent");
});

test("W1-T2444: a message that merely mentions checkout/gh prose without the exact predicate shape stays unclassified", () => {
  // Guards the same substring-match trap fixDispatchSignalDeath's own doc warns about: a worker's
  // own report or stderr tail quoting these words in passing must not misclassify.
  assert.equal(fixDispatchErrorClass("worker log mentioned it tried a checkout -B once, unrelated to this failure", undefined), undefined);
  assert.equal(fixDispatchErrorClass("something about gh pr view being flaky in general", undefined), undefined);
});

// ── acceptance 4: no new ledger step — the row is still written under sweep.fix.error ────────────

test("W1-T2444: the class field rides on the existing sweep.fix.error shape — dispatchFixCatchOutcome introduces no new step name", () => {
  // dispatchFixCatchOutcome returns ledgerFields to be spread into a `log("sweep.fix.error", ...)`
  // call at the one write site (run-task.ts); it has no notion of a step name at all, so there is
  // nothing here that could introduce one.
  const err = new Error("Command failed: gh pr view 1 --json headRefName");
  const outcome = dispatchFixCatchOutcome(err, false);
  assert.deepEqual(Object.keys(outcome).sort(), ["ledgerFields", "rethrow"]);
  assert.equal(outcome.ledgerFields.class, "gh_pr_view");
});

// ── ordering: signal death wins even when the message text ALSO matches a later predicate ────────

test("W1-T2444: predicate order is first-match-wins — a signal death classifies as sigkill even if the message also mentions checkout -B", () => {
  const err = Object.assign(new Error("Command failed: git checkout -B foo origin/foo, then terminated by signal SIGKILL"), {
    signal: "SIGKILL",
    costUsd: 0,
  });
  const outcome = dispatchFixCatchOutcome(err, true);
  assert.equal(outcome.ledgerFields.class, "sigkill", "signal death is checked first, structurally, regardless of message content");
});
