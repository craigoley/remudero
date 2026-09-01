// W1-T2564: a session-limit refusal was recorded as a successful worker run and permanently
// retired the work it refused.
//
// THE MECHANISM. The SDK emits a `result` envelope (subtype "success") and THEN throws its
// post-error signal. `collectWorkerResult`'s catch swallows that throw — correctly, the envelope
// is real — and sets `isError`, but nothing rewrites `subtype`. So `workerLedgerFields`'s
// `r.isError ? r.subtype : "success"` resolved BOTH arms to "success". MEASURED over the
// three-form ledger union: 793 rows across five rungs recorded `verdict: "success"` for runs the
// account had refused, 775 of them `inbox.draft_synthesized`.
//
// THE SEVERITY was downstream: `buildInboxDraftHook` writes a `DraftAttemptCache` key for every
// outcome, win or lose (W1-T192, deliberately). A refusal is not an attempt — 267 of 353
// proposals were keyed with no cached draft, never once really drafted, and could never become
// due again because a routed follow-up's key is the literal `::0`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUsageLimitRefusal } from "../src/lib/classify.js";
import { collectWorkerResult, workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import {
  evictRefusalPoisonedKeys,
  runDraftRung,
  type DraftAttemptCache,
  type DraftCache,
  type DraftedCandidate,
} from "../src/lib/inbox.js";

/** The stderr the fleet actually recorded, verbatim from ledger.ndjson at 2026-09-01T10:15:55.352Z. */
const REAL_SWALLOWED =
  "\n[collectWorkerResult] error-result throw swallowed: Claude Code returned an error result: " +
  "You've hit your session limit · resets 11:50am (UTC)\n\nYou've hit your session limit · resets 11:50am (UTC)";

/** A worker result shaped exactly as the swallow leaves one: isError set, subtype still "success"
 *  from the pre-throw envelope, zero cost, zero tokens. */
function refusedResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s1",
    costUsd: 0,
    numTurns: 0,
    maxTurns: 400,
    text: "",
    blocks: [],
    stderr: REAL_SWALLOWED,
    subtype: "success",
    isError: true,
    apiError: false,
    usageRefusal: { matched: "You've hit your session limit", resetsAtText: "11:50am (UTC)", resetsAtMs: Date.parse("2026-09-01T11:50:00.000Z") },
    permissionDenials: [],
    childEnvKeys: [],
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: 0,
    compactionFailures: 0,
    ...over,
  } as WorkerResult;
}

// ── The shared seam: a refusal is not a success ──────────────────────────────────────────────

test("a session-limit refusal is recorded as a refusal, not as verdict success", () => {
  const f = workerLedgerFields(refusedResult()) as Record<string, unknown>;
  assert.notEqual(
    f.verdict,
    "success",
    "the exact defect: isError was true and subtype said 'success', so both ternary arms rendered success",
  );
  assert.equal(f.verdict, "usage_refused");
  assert.equal(f.usage_refused, true, "and it is greppable as its own field, not only inside a verdict string");
});

test("the refusal carries the reset the API stated — more accurate than the governor believed", () => {
  const f = workerLedgerFields(refusedResult()) as Record<string, unknown>;
  assert.equal(f.usage_resets_at, "2026-09-01T11:50:00.000Z", "the API's own stated reset");
  assert.notEqual(
    f.usage_resets_at,
    "2026-09-01T12:00:00.000Z",
    "daemon.headroom believed 12:00:00Z at that same instant — the refusal text is the better signal",
  );
  assert.equal(f.usage_refusal_matched, "You've hit your session limit");
});

test("the refusal is recognised by the EXISTING detector, not a second classifier", () => {
  const hit = detectUsageLimitRefusal(REAL_SWALLOWED, Date.parse("2026-09-01T10:15:55.352Z"));
  assert.ok(hit, "detectUsageLimitRefusal (W1-T2515) must match the real stderr — this fix adds a caller, not a classifier");
  assert.equal(hit.matched, "You've hit your session limit");
  assert.equal(hit.resetsAtMs, Date.parse("2026-09-01T11:50:00.000Z"));
  // NEGATIVE CONTROL: ordinary worker output must not be classified as a refusal.
  assert.equal(
    detectUsageLimitRefusal("the worker emitted a FRAGMENT block and a STAMP line as asked", Date.now()),
    undefined,
    "a control that matched everything would make every one of these assertions vacuous",
  );
});

test("every OTHER verdict path is byte-identical — a real error subtype and a clean run are untouched", () => {
  // recon.done's measured shape: the envelope named its own error, so that name must survive.
  const realError = workerLedgerFields(
    refusedResult({ subtype: "error_max_turns", usageRefusal: undefined }),
  ) as Record<string, unknown>;
  assert.equal(realError.verdict, "error_max_turns", "an envelope that DID name its error still names it");
  assert.equal(realError.usage_refused, undefined, "and carries no refusal fields");

  const clean = workerLedgerFields(
    refusedResult({ isError: false, subtype: "success", usageRefusal: undefined, costUsd: 4.2 }),
  ) as Record<string, unknown>;
  assert.equal(clean.verdict, "success", "a genuine success is still a success");
  assert.equal(clean.usage_refused, undefined);
});

// ── The attempt cache: a refusal must not retire the work ────────────────────────────────────

const CAND: DraftedCandidate = {
  proposalId: "p-drafted",
  fragmentYaml: "- id: X\n",
  stampLine: "stamp",
  anchorFingerprint: "",
};

test("the migration frees a key that never produced a draft, so a refused proposal becomes due again", () => {
  // The measured shape: keyed with the literal `::0`, no cached draft, still live in the registry.
  const attempts: DraftAttemptCache = { "followup:a": "::0", "followup:b": "::0" };
  const drafts: DraftCache = {};
  const freed = evictRefusalPoisonedKeys(attempts, drafts, new Set(["followup:a", "followup:b"]));
  assert.deepEqual(freed.sort(), ["followup:a", "followup:b"]);
  assert.deepEqual(attempts, {}, "the keys are gone, so draftsDueOnDaemon's comparison can be true again");
});

test("a proposal that HAS a cached draft keeps its key — the migration is not a blanket wipe", () => {
  const attempts: DraftAttemptCache = { "p-drafted": "::0", "p-refused": "::0" };
  const drafts: DraftCache = { "p-drafted": CAND };
  const freed = evictRefusalPoisonedKeys(attempts, drafts, new Set(["p-drafted", "p-refused"]));
  assert.deepEqual(freed, ["p-refused"]);
  assert.equal(attempts["p-drafted"], "::0", "real work must not be re-attempted and re-paid for");
});

test("a key whose proposal has left the registry is left alone — re-opening it could schedule nothing", () => {
  const attempts: DraftAttemptCache = { "gone:1": "::0", "live:1": "::0" };
  const freed = evictRefusalPoisonedKeys(attempts, {}, new Set(["live:1"]));
  assert.deepEqual(freed, ["live:1"]);
  assert.equal(attempts["gone:1"], "::0", "a dead proposal's key is inert, and removing it only churns the file");
});

test("the migration is IDEMPOTENT, which is what lets it run every poll instead of behind a one-shot marker", () => {
  const attempts: DraftAttemptCache = { "followup:a": "::0" };
  const live = new Set(["followup:a"]);
  assert.deepEqual(evictRefusalPoisonedKeys(attempts, {}, live), ["followup:a"]);
  assert.deepEqual(evictRefusalPoisonedKeys(attempts, {}, live), [], "a second pass must free nothing");
});

test("the migration re-opens genuine no-output failures too — the cost this task priced rather than denied", () => {
  // A worker that RAN and emitted unparseable output is keyed by W1-T192 with no draft, and is
  // therefore indistinguishable on disk from a refusal. The honest claim is that it gets ONE more
  // attempt, not that it is untouched.
  const attempts: DraftAttemptCache = { "p-malformed": "::0" };
  const freed = evictRefusalPoisonedKeys(attempts, {}, new Set(["p-malformed"]));
  assert.deepEqual(
    freed,
    ["p-malformed"],
    "if this ever returns [] the doc is lying about what it re-opens; the bound is one retry, not zero",
  );
});

// ── The REAL paths, not just the seams ───────────────────────────────────────────────────────
// The three tests above drive `workerLedgerFields` and `evictRefusalPoisonedKeys` with hand-built
// inputs, which proves the derivations but never executes the two places the refusal is actually
// DETECTED and LABELLED. Those are the lines that would silently stop working.

/** The measured production shape: a SUCCESS result envelope, and only then the SDK's throw. That
 *  ordering is the whole defect — `subtype` is already "success" when `isError` gets set. */
async function* refusedStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "starting" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "s1",
    total_cost_usd: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
  };
  throw new Error("Claude Code returned an error result: You've hit your session limit · resets 11:50am (UTC)");
}

test("collectWorkerResult detects the refusal from the SDK's own post-envelope throw", async () => {
  const r = await collectWorkerResult(refusedStream(), { childEnvKeys: [] });
  assert.equal(r.subtype, "success", "the envelope really does say success — this is the input the defect fed on");
  assert.equal(r.isError, true);
  assert.ok(r.usageRefusal, "the refusal must survive the swallow, where the message still exists");
  assert.equal(r.usageRefusal?.matched, "You've hit your session limit");
  assert.equal(r.usageRefusal?.resetsAtMs !== undefined, true, "and carry the reset the API stated");
  // End to end through the same seam every rung uses.
  assert.equal((workerLedgerFields(r) as Record<string, unknown>).verdict, "usage_refused");
});

test("an ordinary post-envelope throw is NOT a refusal — the swallow still works as it did", async () => {
  async function* otherThrow(): AsyncGenerator<unknown> {
    yield { type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: "s", total_cost_usd: 1.5, num_turns: 3 };
    throw new Error("socket hang up");
  }
  const r = await collectWorkerResult(otherThrow(), { childEnvKeys: [] });
  assert.equal(r.usageRefusal, undefined, "a non-limit throw must not be relabelled a refusal");
  assert.equal((workerLedgerFields(r) as Record<string, unknown>).verdict, "error_during_execution");
});

test("runDraftRung labels a refused draft by its cause, not as malformed output", async () => {
  const proposal = { id: "followup:x", summary: "s", evidenceAnchors: [] };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const outcomes = await runDraftRung(
    [proposal],
    "plan text",
    {
      spawn: async () => await collectWorkerResult(refusedStream(), { childEnvKeys: [] }),
      log: (step, extra) => logs.push({ step, extra: extra as Record<string, unknown> }),
    },
    "RUN-1",
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.ok(
    outcomes[0].ok === false && outcomes[0].refused,
    "the outcome must carry `refused` — that field is what stops buildInboxDraftHook writing an attempt key",
  );
  assert.match(
    outcomes[0].ok === false ? outcomes[0].error : "",
    /refused by the account/,
    "the old string sent every reader toward the prompt; the marker absence was only a symptom",
  );
  const err = logs.find((l) => l.step === "inbox.draft_error");
  assert.equal(err?.extra.usage_refused, true, "and the ledger row says so too");
  // TIME-INDEPENDENT BY CONSTRUCTION: `detectUsageLimitRefusal` resolves "11:50am" against the
  // CURRENT clock and correctly rolls to the next day when that hour has already passed, so
  // pinning a literal date here would be the fixed-constant time bomb this repo has shipped before
  // (it failed exactly that way when first written). Assert the wall-clock time, not the date.
  assert.match(String(err?.extra.usage_resets_at), /T11:50:00\.000Z$/);
});

test("runDraftRung still reports genuinely malformed output as malformed — the relabel is refusal-only", async () => {
  const outcomes = await runDraftRung(
    [{ id: "p", summary: "s", evidenceAnchors: [] }],
    "plan text",
    {
      spawn: async () =>
        ({ ...refusedResult({ isError: false, subtype: "success", usageRefusal: undefined }), text: "no markers here", blocks: [] }) as never,
      log: () => {},
    },
    "RUN-1",
  );
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[0].ok === false && outcomes[0].refused, undefined, "no refusal field, so W1-T192 still keys it");
  assert.match(outcomes[0].ok === false ? outcomes[0].error : "", /no FRAGMENT\/STAMP markers/);
});
