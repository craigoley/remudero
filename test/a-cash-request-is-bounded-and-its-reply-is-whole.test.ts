import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENWEIGHT_REQUEST_TIMEOUT_MS,
  OpenWeightRequestTimeoutError,
  OpenWeightTruncatedReplyError,
  openWeightReplyIsTruncated,
} from "../src/lib/worker-provider.js";

// Two transport gaps measured against synthwatch's production Azure adapter, which has run this
// shape for months: remudero's `fetch` carried NO `signal`, and `finish_reason` was never read.
//
// Both matter more now than they did as spillover. A hung request held a reservation for as long as
// the socket stayed open, and a budget-truncated reply was indistinguishable from a short answer --
// OPENWEIGHT_MAX_COMPLETION_TOKENS's own comment records a shard truncated mid-string at 1,500.

test("a `length` finish_reason is truncation, and the two complete outcomes are not", () => {
  assert.equal(openWeightReplyIsTruncated("length"), true);
  assert.equal(openWeightReplyIsTruncated("stop"), false);
  assert.equal(openWeightReplyIsTruncated("tool_calls"), false);
});

test("an ABSENT finish_reason reads as complete — a missing field must not invent a refusal", () => {
  // Not every OpenAI-compatible endpoint sets it. Failing closed here would break deployments that
  // work, which is a worse outcome than the gap this check exists to close.
  assert.equal(openWeightReplyIsTruncated(undefined), false);
  assert.equal(openWeightReplyIsTruncated(null), false);
  assert.equal(openWeightReplyIsTruncated(""), false);
});

test("the truncation refusal names the budget it hit, so the remedy is readable from the error", () => {
  const e = new OpenWeightTruncatedReplyError("length", 5000);
  assert.match(e.message, /TRUNCATED by the completion budget/);
  assert.match(e.message, /OPENWEIGHT_MAX_COMPLETION_TOKENS=5000/);
  assert.match(e.message, /shrink the request or raise the budget/);
  assert.match(e.message, /Refusing to return a partial answer as a whole one/);
});

test("the timeout refusal states that the reservation STAYS CHARGED, and why", () => {
  // The direction is deliberate: the endpoint may have served and billed an abandoned request, so
  // returning the allowance would let a timeout buy free authority against dailyCapUsd.
  const e = new OpenWeightRequestTimeoutError(OPENWEIGHT_REQUEST_TIMEOUT_MS, "gpt-5.6-luna");
  assert.match(e.message, /gpt-5\.6-luna/);
  assert.match(e.message, /stays CHARGED/);
  assert.match(e.message, /free authority/);
});

test("the deadline is generous, because a reasoning model on a large prompt is legitimately slow", () => {
  // A deadline that fires early refuses work the cap already paid to reserve. This asserts the
  // ORDER of magnitude, not a specific number, so tuning it does not redden the suite.
  assert.ok(OPENWEIGHT_REQUEST_TIMEOUT_MS >= 60_000, "a minute is the floor for a reasoning model");
  assert.ok(OPENWEIGHT_REQUEST_TIMEOUT_MS <= 600_000, "but an unbounded-in-practice deadline is the gap being closed");
});

// ── through the REAL spawn path, not just the classifier ───────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config-schema.js";

const fixedClock = (ms: number) => ({ now: () => ms, iso: () => new Date(ms).toISOString() });

function harness(root: string, body: unknown) {
  return [
    {
      cwd: root,
      workerHome: join(root, "worker-home"),
      prompt: "classify",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      clock: fixedClock(Date.parse("2026-09-16T12:00:00.000Z")),
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    },
    {
      claudeBin: "/unused/claude",
      root,
      dailyCapUsd: 5,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    } as Config,
    { model: "gpt-5-nano", effort: "low" },
  ] as const;
}

test("a budget-truncated reply is REFUSED by the adapter, not returned as an answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-truncated-"));
  try {
    const [args, config, selection] = harness(root, {
      id: "t",
      usage: { prompt_tokens: 100, completion_tokens: 5000 },
      choices: [{ message: { content: "a partial ans" }, finish_reason: "length" }],
    });
    // The adapter CATCHES a throw into `isError`, so the refusal surfaces as a failed result rather
    // than a rejection — which is what a caller actually sees, and therefore what to assert.
    const result = await spawnOpenWeightWorker(args as never, config, selection as never);
    assert.equal(result.isError, true, "a prefix must never reach a caller as a whole answer");
    assert.doesNotMatch(String(result.text ?? ""), /a partial ans/, "the truncated content must not be returned as the answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a COMPLETE reply still returns normally — the new check does not refuse healthy traffic", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-complete-"));
  try {
    const [args, config, selection] = harness(root, {
      id: "t",
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    });
    const result = await spawnOpenWeightWorker(args as never, config, selection as never);
    assert.equal(result.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the request carries an abort signal, so a hung endpoint cannot stall the loop forever", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-signal-"));
  try {
    let sawSignal = false;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-16T12:00:00.000Z")),
        fetchImpl: async (_input: unknown, init?: { signal?: unknown }) => {
          sawSignal = init?.signal instanceof AbortSignal;
          return new Response(
            JSON.stringify({ id: "t", usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      } as never,
      { claudeBin: "/unused/claude", root, dailyCapUsd: 5, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
      { model: "gpt-5-nano", effort: "low" } as never,
    );
    assert.equal(result.isError, false);
    assert.equal(sawSignal, true, "every cash request must be abortable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
