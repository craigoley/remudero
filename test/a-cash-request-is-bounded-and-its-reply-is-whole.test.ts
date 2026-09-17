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

test("the deadline's own catch arm names a TIMEOUT, and every other transport failure is rethrown untouched", async () => {
  // BOTH ARMS OF THE CATCH, because they are the same two lines and they mean opposite things: one
  // says "we ran out of time and the reservation stands", the other says "the network said no".
  // A test that only injects a healthy `fetch` reaches neither, which is what `diff-coverage`
  // refused by name.
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-catch-"));
  try {
    const cfg = {
      claudeBin: "/unused/claude", root, dailyCapUsd: 5,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    } as Config;
    const args = (fetchImpl: typeof fetch) => ({
      cwd: root, workerHome: join(root, "worker-home"), prompt: "classify",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      clock: fixedClock(Date.parse("2026-09-16T12:00:00.000Z")),
      fetchImpl,
    });

    // (a) ABORTED — the deadline fired. The refusal must name the timeout, not the raw abort, so a
    //     reader of the ledger can tell a deadline from a dead network.
    const timedOut = await spawnOpenWeightWorker(
      { ...args(((_u: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        })) as unknown as typeof fetch), requestTimeoutMs: 25 } as never,
      cfg,
      { model: "gpt-5-nano", effort: "low" } as never,
    );
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.stderr, /timed out|timeout/i, `expected a timeout refusal, got: ${timedOut.stderr}`);

    // (b) NOT ABORTED — an ordinary transport failure is rethrown UNCHANGED, so a DNS or TLS fault
    //     is never mislabelled as "we ran out of time".
    const refused = await spawnOpenWeightWorker(
      args((async () => { throw new Error("ECONNREFUSED example.test"); }) as unknown as typeof fetch) as never,
      cfg,
      { model: "gpt-5-nano", effort: "low" } as never,
    );
    assert.equal(refused.isError, true);
    assert.match(refused.stderr, /ECONNREFUSED/, "a non-deadline failure must survive with its own message");
    assert.doesNotMatch(refused.stderr, /timed out/i, "and must not be relabelled as a timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the allowance a REFUSED request leaves behind (the $25-is-not-$25 defect) ───────────────────
// `openWeightCommittedUsd` charges `settledUsd ?? reservedUsd`, so a row that never settles counts
// at its conservative CEILING for the rest of the UTC day. Measured on the live fleet allowance for
// 2026-09-15: $2.6771 committed against $0.9270 actually spent, 32 of 104 rows never settled — a
// cap that refused work after roughly a third of the money it names.

import { readFileSync } from "node:fs";
import { openWeightAllowancePath, openWeightCommittedUsd } from "../src/lib/worker-provider.js";

function committedAfter(config: Config): number {
  return openWeightCommittedUsd(JSON.parse(readFileSync(openWeightAllowancePath(config), "utf8")));
}

test("an HTTP-REFUSED request releases its reservation — the day's cap is not spent on an unbilled call", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-429-"));
  try {
    const [args, config, selection] = harness(root, {});
    const refused = await spawnOpenWeightWorker(
      { ...args, fetchImpl: async () => new Response("rate limited", { status: 429 }) } as never,
      config,
      selection as never,
    );
    assert.equal(refused.isError, true, "a 429 is still a failed run");

    // THE ASSERTION THAT MATTERS is the money, not the message: Azure meters nothing for a 429, so
    // the ceiling reserved before the send must be handed back in full.
    assert.equal(committedAfter(config), 0, "a refused request must commit $0 against dailyCapUsd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the released row is SETTLED to zero, never deleted — a refusal stays auditable", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-audit-"));
  try {
    const [args, config, selection] = harness(root, {});
    await spawnOpenWeightWorker(
      { ...args, fetchImpl: async () => new Response("bad request", { status: 400 }) } as never,
      config,
      selection as never,
    );
    const state = JSON.parse(readFileSync(openWeightAllowancePath(config), "utf8")) as {
      reservations: Record<string, { reservedUsd: number; settledUsd: number | null }>;
    };
    const rows = Object.values(state.reservations);
    assert.equal(rows.length, 1, "the attempt is still on the record");
    assert.ok(rows[0].reservedUsd > 0, "and still names what it had reserved, so the release is visible");
    assert.equal(rows[0].settledUsd, 0, "settled to zero, which is what makes it free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 5xx KEEPS its charge, so only a client refusal is released", async () => {
  // THE BOUNDARY, AND IT IS THE REASON THIS FIX IS NARROW. A 500 may have been served and billed
  // before the server fell over, which is the ruling `an-open-weight-provider-rides-the-capability-
  // ladder` already pins. A 429 cannot have been: it is refused before the model runs. Releasing
  // both would hand a flapping endpoint free authority against the cap.
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-5xx-"));
  try {
    const [args, config, selection] = harness(root, {});
    const failed = await spawnOpenWeightWorker(
      { ...args, fetchImpl: async () => new Response("upstream exploded", { status: 500 }) } as never,
      config,
      selection as never,
    );
    assert.equal(failed.isError, true);
    assert.ok(committedAfter(config) > 0, "a server fault keeps its conservative charge");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a TIMEOUT still keeps its charge — the asymmetry with a refusal is deliberate", async () => {
  // THE CONTROL FOR THE TWO ABOVE. An abandoned request may have been served and billed where we
  // cannot see it; a 400/429 is a receipt that says nothing was. Releasing BOTH would let a hung
  // endpoint buy unlimited free authority against the cap, so this must stay red if anyone
  // "consistently" applies the release to the deadline path.
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-timeout-charge-"));
  try {
    const [args, config, selection] = harness(root, {});
    const timedOut = await spawnOpenWeightWorker(
      {
        ...args,
        requestTimeoutMs: 25,
        fetchImpl: ((_u: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
          })) as unknown as typeof fetch,
      } as never,
      config,
      selection as never,
    );
    assert.equal(timedOut.isError, true);
    assert.ok(committedAfter(config) > 0, "an abandoned request keeps its conservative charge");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
