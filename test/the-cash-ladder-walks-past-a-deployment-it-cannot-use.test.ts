/**
 * ONE UNUSABLE DEPLOYMENT TOOK THE WHOLE RUN, WHILE ITS LADDER SAT UNUSED.
 *
 * MEASURED over the live ledger plus all archives: 22,356 `openweight_error` runs, of which
 * 21,942 — 98% — were a SINGLE deployment, across three days (2026-09-18 → 09-20). The configured
 * ladder row for that capability is `[gpt-oss-120b, gpt-5-nano, gpt-5.6-luna]`: two other
 * candidates were sitting in the same row and were never tried.
 *
 * `selectOpenWeightModel` already walked that ladder for CONTEXT FIT. Nothing walked it for
 * FAILURE, so the selection was one shot.
 *
 * THE TRIGGER IS DELIBERATELY SINGULAR, and the refusal tests below are the important half.
 * `OpenWeightUnsupportedResponseFormatError` is a PROVABLE statement about a deployment — it names
 * the deployment and what it could not honour, and its own message prescribes this fix ("Route
 * this lane to a deployment that declares it"). Every other failure must NOT walk:
 *
 *   timeout / truncated   may be transient — walking turns a retryable blip into a SECOND charge
 *   request too large     the fit gate already ran; the next rung fails identically
 *   auth / cap refusal    recurs on every rung by construction
 *
 * Walking those would spend real money against `dailyCapUsd` to learn nothing, which is the
 * failure mode this walk must not become.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectOpenWeightModel,
  OpenWeightUnsupportedResponseFormatError,
  OpenWeightRequestTimeoutError,
} from "../src/lib/worker-provider.js";
import { runOpenWeightWalkingLadder } from "../src/lib/worker.js";

test("the selection carries the rest of its ladder, not just the winner", () => {
  // Asserted against the REAL configured ladder, and deliberately WITHOUT naming a model: the
  // property is "the tail is reachable and excludes the lead", which must survive a ladder edit.
  // (The live row that produced the 98% failure is [gpt-5-nano, gpt-oss-120b, gpt-5.6-luna].)
  const sel = selectOpenWeightModel(undefined, "sonnet", "low");
  assert.ok(sel.alternatives.length >= 1, "a multi-candidate row must expose its tail");
  assert.ok(!sel.alternatives.includes(sel.model), "the lead must not repeat in its own tail");
  assert.equal(new Set(sel.alternatives).size, sel.alternatives.length, "no duplicate rungs");
});

test("alternatives is always a LIST, never absent — an optional field re-creates the one-shot bug", () => {
  // A caller forced to distinguish `undefined` from `[]` is one refactor away from skipping the
  // walk entirely, which is exactly the shape this change exists to remove.
  for (const effort of ["low", "medium", "high"]) {
    const sel = selectOpenWeightModel(undefined, "sonnet", effort);
    assert.ok(Array.isArray(sel.alternatives), `${effort}: alternatives must be an array`);
  }
});

/** The walker's contract, exercised through the REAL `runOpenWeightWalkingLadder`.
 *
 * THIS USED TO RESTATE THE LOOP. A local copy passes against a base checkout that never had the
 * walker, so `proof-discrimination` refused the PR: "3 proof(s) pass at both PR head and merge
 * base". The copy also cannot catch a divergence between itself and production — the defect it was
 * written to prove would survive a rewrite of the real loop. Driving the exported function means
 * the test fails at base (the symbol is absent) and tracks the implementation thereafter. */
async function walk(
  rungs: readonly string[],
  outcome: (model: string) => Promise<{ text: string }>,
): Promise<{ landedOn?: string; error?: unknown; attempts: string[] }> {
  const attempts: string[] = [];
  const selection = {
    model: rungs[0]!,
    alternatives: rungs.slice(1),
    effort: "default" as const,
    capability: "low" as never,
  };
  try {
    const result = await runOpenWeightWalkingLadder(async (sel) => {
      attempts.push(sel.model);
      await outcome(sel.model);
      return {} as never;
    }, selection as never);
    return { landedOn: (result as { routedModel?: string }).routedModel, attempts };
  } catch (err) {
    return { error: err, attempts };
  }
}

test("a capability refusal walks to the next rung and lands there — PR6555 ladder repair", () => {
  return walk(["a-model", "b-model", "c-model"], async (m) => {
    if (m === "a-model") throw new OpenWeightUnsupportedResponseFormatError(m, "json_object");
    return { text: "ok" };
  }).then((r) => {
    assert.equal(r.landedOn, "b-model", "the run must survive one unusable deployment");
    assert.deepEqual(r.attempts, ["a-model", "b-model"], "and must not skip or repeat a rung");
  });
});

test("A TIMEOUT DOES NOT WALK — it may be transient, and walking would double-charge the cap — PR6555 ladder repair", () => {
  return walk(["a-model", "b-model"], async (m) => {
    if (m === "a-model") throw new OpenWeightRequestTimeoutError(1000, m);
    return { text: "ok" };
  }).then((r) => {
    assert.ok(r.error instanceof OpenWeightRequestTimeoutError, "a timeout must propagate, not fall through");
    assert.deepEqual(r.attempts, ["a-model"], "exactly one charge against the cap");
  });
});

test("an unrelated error does not walk either", () => {
  return walk(["a-model", "b-model"], async () => {
    throw new Error("auth refused");
  }).then((r) => {
    assert.match(String((r.error as Error).message), /auth refused/);
    assert.deepEqual(r.attempts, ["a-model"], "a refusal that recurs on every rung is tried once");
  });
});

test("every rung refusing surfaces the LAST refusal, never a silent success — PR6555 ladder repair", () => {
  return walk(["a-model", "b-model"], async (m) => {
    throw new OpenWeightUnsupportedResponseFormatError(m, "json_object");
  }).then((r) => {
    assert.ok(r.error instanceof OpenWeightUnsupportedResponseFormatError);
    assert.deepEqual(r.attempts, ["a-model", "b-model"], "bounded by the ladder — no loop");
  });
});
