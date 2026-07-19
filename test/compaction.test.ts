import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorReinjections,
  detectCompactionEvents,
  isQualitySuspect,
  outputContractLines,
  renderAnchorBlock,
} from "../src/lib/compaction.js";
import { renderImplementPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T36",
    title: "COMPACTION TELEMETRY + ANCHORING",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "high",
    verify: "auto",
    status: "queued",
    attempts: 0,
    prompt: "detect ${TASK_ID} compaction on run ${RUN_ID} and re-inject the anchor verbatim",
    acceptance: [
      { claim: "a compaction event is detected and ledgered", proof: "unit test over a recorded fixture" },
      { claim: "the anchor reappears byte-identical after compaction", proof: "fixture/transcript proof" },
    ],
    ...over,
  };
}

// ── A RECORDED stream fixture (MASTER-PLAN §8B / W1-T36 acceptance): the
// SDK's own `SDKCompactBoundaryMessage` shape (sdk.d.ts 0.3.210 ground
// truth) — an assistant turn, an auto compaction mid-run, then more work. ──
const RECORDED_STREAM_WITH_COMPACTION: unknown[] = [
  { type: "assistant", message: { content: [{ type: "text", text: "reading the repo…" }] } },
  {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 187342, post_tokens: 21004, duration_ms: 4381 },
    uuid: "boundary-1",
    session_id: "sess-compact",
  },
  { type: "assistant", message: { content: [{ type: "text", text: "continuing after compaction…" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/9",
    session_id: "sess-compact",
    total_cost_usd: 3.14,
    num_turns: 41,
    permission_denials: [],
  },
];

const RECORDED_STREAM_CLEAN: unknown[] = [
  { type: "assistant", message: { content: [{ type: "text", text: "no compaction here" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/10",
    session_id: "sess-clean",
    total_cost_usd: 0.41,
    num_turns: 6,
    permission_denials: [],
  },
];

// ── detectCompactionEvents ───────────────────────────────────────────────

test("detectCompactionEvents: a recorded stream with a compact_boundary message yields one event with the SDK's own fields", () => {
  const events = detectCompactionEvents(RECORDED_STREAM_WITH_COMPACTION);
  assert.deepEqual(events, [{ trigger: "auto", preTokens: 187342, postTokens: 21004, durationMs: 4381 }]);
});

test("detectCompactionEvents: a clean stream (no compact_boundary) yields zero events", () => {
  assert.deepEqual(detectCompactionEvents(RECORDED_STREAM_CLEAN), []);
});

test("detectCompactionEvents: a manual trigger and a bare compact_metadata (no post_tokens/duration_ms) are both handled", () => {
  const events = detectCompactionEvents([
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 50000 },
      uuid: "boundary-manual",
      session_id: "sess",
    },
  ]);
  assert.deepEqual(events, [{ trigger: "manual", preTokens: 50000 }]);
  assert.ok(!("postTokens" in events[0]), "unset post_tokens is omitted, not undefined-valued");
});

test("detectCompactionEvents: multiple compactions in one stream are all captured, in order", () => {
  const events = detectCompactionEvents([
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } },
    { type: "assistant", message: { content: [] } },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 2 } },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].trigger, "auto");
  assert.equal(events[1].trigger, "manual");
});

test("detectCompactionEvents: never throws on malformed/foreign messages (a partial recording is still safely scannable)", () => {
  assert.doesNotThrow(() => detectCompactionEvents([null, undefined, 42, "x", {}, { type: "system" }]));
});

// ── isQualitySuspect ──────────────────────────────────────────────────────

test("isQualitySuspect: false for zero events, true the moment one compaction fired", () => {
  assert.equal(isQualitySuspect([]), false);
  assert.equal(isQualitySuspect(detectCompactionEvents(RECORDED_STREAM_WITH_COMPACTION)), true);
});

// ── renderAnchorBlock: goal + acceptance criteria + hard constraints ────────

test("renderAnchorBlock: carries the GOAL (task prompt, with ${RUN_ID}/${TASK_ID} substituted) and the ACCEPTANCE CRITERIA", () => {
  const anchor = renderAnchorBlock(task(), "RUN-42");
  assert.ok(anchor.includes("detect W1-T36 compaction on run RUN-42"), "GOAL substitutes RUN_ID/TASK_ID");
  assert.ok(anchor.includes("a compaction event is detected and ledgered"), "acceptance claim present");
  assert.ok(anchor.includes("unit test over a recorded fixture"), "acceptance proof present");
});

test("renderAnchorBlock: the hard-constraints tail is BYTE-IDENTICAL to outputContractLines(task.id) — never paraphrased", () => {
  const t = task();
  const anchor = renderAnchorBlock(t, "RUN-1");
  const contract = outputContractLines(t.id).join("\n");
  assert.equal(anchor.slice(anchor.length - contract.length), contract);
});

test("renderAnchorBlock: the hard-constraints tail is ALSO byte-identical to the OUTPUT CONTRACT the worker saw in the ORIGINAL prompt (renderImplementPrompt) — the anchor is never a re-derived/summarized copy", () => {
  const t = task();
  const runId = "RUN-7";
  const original = renderImplementPrompt(t, "", runId, "");
  const anchor = renderAnchorBlock(t, runId);
  const contract = outputContractLines(t.id).join("\n");
  assert.equal(original.slice(original.length - contract.length), contract);
  assert.equal(anchor.slice(anchor.length - contract.length), contract);
});

test("renderAnchorBlock: deterministic — the SAME inputs always produce the SAME byte-identical string", () => {
  const t = task();
  assert.equal(renderAnchorBlock(t, "RUN-9"), renderAnchorBlock(t, "RUN-9"));
});

test("renderAnchorBlock: a task with no declared acceptance criteria still renders (never throws), with an explicit 'none declared' marker", () => {
  const anchor = renderAnchorBlock(task({ acceptance: undefined }), "RUN-1");
  assert.ok(anchor.includes("(none declared)"));
});

// ── anchorReinjections: the acceptance-criterion #2 proof surface ──────────

test("anchorReinjections: after a compaction event, the anchor reappears BYTE-IDENTICAL (not summarized) in the continued prompt", () => {
  const t = task();
  const runId = "RUN-COMPACT-1";
  const anchor = renderAnchorBlock(t, runId);
  const continuations = anchorReinjections(RECORDED_STREAM_WITH_COMPACTION, anchor);
  assert.equal(continuations.length, 1, "one compaction event ⇒ one continuation message");
  assert.equal(continuations[0], anchor, "byte-identical, never paraphrased/re-summarized");
});

test("anchorReinjections: a clean stream (no compaction) yields zero continuations", () => {
  const anchor = renderAnchorBlock(task(), "RUN-1");
  assert.deepEqual(anchorReinjections(RECORDED_STREAM_CLEAN, anchor), []);
});

test("anchorReinjections: N compactions in one stream yield N byte-identical entries, not N distinct summaries", () => {
  const anchor = "THE ANCHOR TEXT";
  const stream = [
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 2 } },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 3 } },
  ];
  assert.deepEqual(anchorReinjections(stream, anchor), [anchor, anchor, anchor]);
});
