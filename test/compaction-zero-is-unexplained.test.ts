import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectWorkerResult, workerLedgerFields } from "../src/lib/worker.js";

// ── W1-T2245: the compaction ledger row cannot tell DISABLED from NEVER-NEEDED from
// FAILED. `quality_suspect`/`compaction_events` fire ONLY off a real `compact_boundary`
// message, so a call that never enabled compaction reads byte-identical to one that
// enabled it and simply never needed it, AND to one that ATTEMPTED compaction and had
// it fail (the SDK's own `compact_result: 'failed'` channel, sdk.d.ts:4684, was never
// read at all). This file proves the three causes are now distinguishable on ONE row,
// without changing what `compaction_events`/`quality_suspect` themselves mean, and
// without this task adding, changing, or enabling any SDK option on the spawn path.

const workerSrc = readFileSync(fileURLToPath(new URL("../src/lib/worker.ts", import.meta.url)), "utf8");

/** A clean stream: no `system` message of any kind. */
async function* cleanStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/1",
    session_id: "sess-clean",
    total_cost_usd: 0.1,
    num_turns: 4,
    permission_denials: [],
  };
}

/**
 * A RECORDED stream fixture carrying an SDK `SDKStatusMessage` (sdk.d.ts:4679-4688 ground
 * truth: `{type:"system", subtype:"status", compact_result:"failed", compact_error:"..."}`) —
 * a compaction that was ATTEMPTED and FAILED. It emits NO `compact_boundary` message, which
 * is exactly the shape that used to leave no trace at all.
 */
async function* compactionFailedStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
  yield {
    type: "system",
    subtype: "status",
    status: "compacting",
    compact_result: "failed",
    compact_error: "context window exceeded during summarization",
    uuid: "status-1",
    session_id: "sess-compact-fail",
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/2",
    session_id: "sess-compact-fail",
    total_cost_usd: 3.5,
    num_turns: 40,
    permission_denials: [],
  };
}

/** A real compact_boundary — the pre-existing, still-working path. */
async function* compactionBoundaryStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
  yield {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 18000, duration_ms: 3900 },
    uuid: "boundary-1",
    session_id: "sess-boundary",
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/3",
    session_id: "sess-boundary",
    total_cost_usd: 2.71,
    num_turns: 38,
    permission_denials: [],
  };
}

// ── Acceptance 1: a zero compaction count records whether compaction was possible ──

test("collectWorkerResult: a call with no compactionConfigured input records compactionConfigured=false, never guessed true", async () => {
  const r = await collectWorkerResult(cleanStream(), { childEnvKeys: [] });
  assert.equal(r.compactionConfigured, false);
  assert.deepEqual(r.compactionEvents, []);
  assert.equal(r.qualitySuspect, false);
});

test("collectWorkerResult: compactionConfigured is a CONFIGURED input, mirrored verbatim — never re-derived from the stream", async () => {
  const r = await collectWorkerResult(cleanStream(), { childEnvKeys: [], compactionConfigured: true });
  assert.equal(r.compactionConfigured, true, "a zero events count on a CONFIGURED call reads as never-needed");
});

test("workerLedgerFields: compaction_configured rides the same line as quality_suspect/compaction_events, distinguishing not-enabled from never-needed", async () => {
  const notEnabled = workerLedgerFields(await collectWorkerResult(cleanStream(), { childEnvKeys: [] }));
  assert.equal(notEnabled.compaction_configured, false);
  assert.equal(notEnabled.quality_suspect, false);
  assert.deepEqual(notEnabled.compaction_events, []);

  const neverNeeded = workerLedgerFields(
    await collectWorkerResult(cleanStream(), { childEnvKeys: [], compactionConfigured: true }),
  );
  assert.equal(neverNeeded.compaction_configured, true);
  assert.equal(neverNeeded.quality_suspect, false);
  assert.deepEqual(neverNeeded.compaction_events, []);
  // Same quality_suspect/compaction_events shape as `notEnabled` above — ONLY
  // compaction_configured tells the two apart, which is the whole point of this field.
  assert.notDeepEqual(notEnabled, neverNeeded);
});

// ── Acceptance 2: a compaction that failed is recorded, not read as one that never happened ──

test("collectWorkerResult: a compact_result:'failed' status message is recorded on compactionFailures, WITHOUT a compaction_events entry", async () => {
  const r = await collectWorkerResult(compactionFailedStream(), { childEnvKeys: [] });
  assert.deepEqual(r.compactionFailures, [{ error: "context window exceeded during summarization" }]);
  // The failure produced NO compact_boundary message — compactionEvents/qualitySuspect are
  // untouched by it, exactly as they were before this task (acceptance 3/5).
  assert.deepEqual(r.compactionEvents, []);
  assert.equal(r.qualitySuspect, false);
});

test("workerLedgerFields: a failed compaction attempt carries compaction_failures on the SAME line, distinguishing it from a call that never attempted one", async () => {
  const failed = workerLedgerFields(await collectWorkerResult(compactionFailedStream(), { childEnvKeys: [] }));
  const neverAttempted = workerLedgerFields(await collectWorkerResult(cleanStream(), { childEnvKeys: [] }));
  assert.deepEqual(failed.compaction_failures, [{ error: "context window exceeded during summarization" }]);
  assert.deepEqual(neverAttempted.compaction_failures, []);
  // Both read quality_suspect:false, compaction_events:[] — identical on those two fields, which
  // is exactly the ambiguity this task removes: compaction_failures is what tells them apart.
  assert.equal(failed.quality_suspect, neverAttempted.quality_suspect);
  assert.deepEqual(failed.compaction_events, neverAttempted.compaction_events);
  assert.notDeepEqual(failed.compaction_failures, neverAttempted.compaction_failures);
});

test("collectWorkerResult: a compact_result:'failed' status message with no compact_error still records an entry, with error left undefined (never guessed)", async () => {
  const stream = (async function* (): AsyncGenerator<unknown> {
    yield {
      type: "system",
      subtype: "status",
      status: "compacting",
      compact_result: "failed",
      uuid: "status-2",
      session_id: "sess-no-error-text",
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      session_id: "sess-no-error-text",
      total_cost_usd: 0.2,
      num_turns: 5,
      permission_denials: [],
    };
  })();
  const r = await collectWorkerResult(stream, { childEnvKeys: [] });
  assert.deepEqual(r.compactionFailures, [{}]);
});

// ── Acceptance 3: a real compaction boundary still sets quality_suspect exactly as today ──

test("collectWorkerResult: a real compact_boundary message still sets qualitySuspect=true and compactionEvents, byte-identical to before this task", async () => {
  const r = await collectWorkerResult(compactionBoundaryStream(), { childEnvKeys: [] });
  assert.deepEqual(r.compactionEvents, [{ trigger: "auto", preTokens: 190000, postTokens: 18000, durationMs: 3900 }]);
  assert.equal(r.qualitySuspect, true);
  // A real boundary is not itself a FAILURE — compactionFailures stays empty.
  assert.deepEqual(r.compactionFailures, []);
});

test("workerLedgerFields: a compacted call's line still carries quality_suspect=true and compaction_events, alongside the new fields", async () => {
  const fields = workerLedgerFields(await collectWorkerResult(compactionBoundaryStream(), { childEnvKeys: [] }));
  assert.equal(fields.quality_suspect, true);
  assert.deepEqual(fields.compaction_events, [
    { trigger: "auto", preTokens: 190000, postTokens: 18000, durationMs: 3900 },
  ]);
  assert.deepEqual(fields.compaction_failures, []);
});

// ── Acceptance 4: no sdk option is added, changed or enabled on the spawn path ──

test("spawnWorker's Options construction never assigns autoCompactEnabled/precomputeCompactionEnabled/betas — this task reads an existing channel, it does not turn one on", () => {
  const start = workerSrc.indexOf("const options: Options = {");
  const end = workerSrc.indexOf("const runQuery = args.queryFn");
  assert.ok(start > -1 && end > start, "expected the Options-construction region to be found in worker.ts");
  const optionsRegion = workerSrc.slice(start, end);
  assert.doesNotMatch(
    optionsRegion,
    /autoCompactEnabled|precomputeCompactionEnabled|betas\s*:/i,
    "the Options object/its conditional assignments must set no compaction/beta key",
  );
});

test("worker.ts's only autoCompactEnabled reference is a READ (comparison), never a write, and it feeds a WorkerResult field rather than an Options key", () => {
  const writeForm = /\.autoCompactEnabled\s*=(?!=)/; // an assignment, e.g. `options.autoCompactEnabled = true`
  assert.doesNotMatch(workerSrc, writeForm);
  assert.match(
    workerSrc,
    /\(options as Record<string, unknown>\)\.autoCompactEnabled === true/,
    "expected a read-only check feeding WorkerResult.compactionConfigured",
  );
});

// ── Acceptance 5: the existing compaction fields keep their current names and meanings ──

test("WorkerResult/workerLedgerFields still expose compactionEvents/qualitySuspect and compaction_events/quality_suspect under their original names", async () => {
  const r = await collectWorkerResult(compactionBoundaryStream(), { childEnvKeys: [] });
  assert.ok("compactionEvents" in r);
  assert.ok("qualitySuspect" in r);
  const fields = workerLedgerFields(r);
  assert.ok("compaction_events" in fields);
  assert.ok("quality_suspect" in fields);
  // isQualitySuspect's meaning is unchanged: it fires off compactionEvents.length > 0 alone,
  // never off compactionFailures — a failed-but-unfired attempt must NOT flip it (acceptance 2/3).
  const failedOnly = await collectWorkerResult(compactionFailedStream(), { childEnvKeys: [] });
  assert.equal(failedOnly.qualitySuspect, false, "quality_suspect's meaning ('a boundary fired') is untouched");
});
