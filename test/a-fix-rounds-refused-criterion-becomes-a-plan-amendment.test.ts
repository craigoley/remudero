import { test } from "node:test";
import assert from "node:assert/strict";
import {
  noPrVerdictRowsFromLedger,
  REFUSAL_AMENDMENT_STEP,
  extractRefusal,
  refusalExcerptFromFixReport,
} from "#src/lib/refusal-amendment.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";

const NOW = Date.parse("2026-10-16T02:00:00.000Z");
const HEAD = "3134b3bbf23ad92f29c055e93cc598d23c012392";

/** #12043's round 2, as the fix worker would report it under this task's footer. */
const ROUND_REPORT = [
  "drain.ts never runs a retro; the synthesis pass is retroCommand in src/run-task.ts.",
  "REFUSED:",
  "2. [proof-unexecutable-at-head] drain.ts never calls the serializer or runs retro synthesis; the proof must name src/run-task.ts",
  "",
  "FIX_OUTCOME: NEEDS_DESIGN claim-mismatch: drain.ts never calls the serializer or runs retro synthesis",
].join("\n");

function needsDesignRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-10-16T01:42:22.977Z",
    run_id: "DAEMON-1792112356081",
    task_id: "W1-T9363",
    step: "fix.needs_design",
    reason: "claim-mismatch: drain.ts never calls the serializer or runs retro synthesis",
    head_sha: HEAD,
    ...extra,
  };
}

test("W1-T9792: a fix round that refuses its criterion is nominated for a plan amendment", () => {
  const excerpt = refusalExcerptFromFixReport(ROUND_REPORT);
  assert.ok(excerpt !== undefined, "a categorized REFUSED block yields an excerpt");
  assert.doesNotMatch(excerpt!, /FIX_OUTCOME/, "the excerpt is the refusal block, not the whole report");
  const rows = noPrVerdictRowsFromLedger([needsDesignRow({ report_excerpt: excerpt })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.taskId, "W1-T9363");
  assert.equal(rows[0]!.runId, `DAEMON-1792112356081@${HEAD}`, "one source per round: the run and the head it judged");
  const refusals = extractRefusal(rows[0]!.reportExcerpt);
  assert.deepEqual(refusals.map((r) => [r.criterion, r.refusalClass]), [[2, "proof-unexecutable-at-head"]]);
});

test("W1-T9792: an uncategorized needs-design row keeps its escalation", () => {
  assert.equal(refusalExcerptFromFixReport("FIX_OUTCOME: NEEDS_DESIGN the shard timeouts have no verified cause"), undefined);
  assert.equal(refusalExcerptFromFixReport(undefined), undefined);
  assert.deepEqual(noPrVerdictRowsFromLedger([needsDesignRow()], NOW), [], "a row with no excerpt is never a candidate");
  // A later round at another head that ended differently supersedes the refusal.
  const later = { ts: "2026-10-16T01:50:00.000Z", run_id: "DAEMON-1792112999999", task_id: "W1-T9363", step: "fix.done",
    fix_outcome: "FIXED", head_sha: "d8104b0b9191d245ac1c31f98175927a349cdd39" };
  assert.deepEqual(noPrVerdictRowsFromLedger([needsDesignRow({ report_excerpt: refusalExcerptFromFixReport(ROUND_REPORT) }), later], NOW), []);
  // A stale row is history, exactly as for a no_pr verdict.
  const stale = needsDesignRow({ ts: "2026-10-01T00:00:00.000Z", report_excerpt: refusalExcerptFromFixReport(ROUND_REPORT) });
  assert.deepEqual(noPrVerdictRowsFromLedger([stale], NOW), []);
});

test("W1-T9792: a drafted fix-round refusal is not drafted again", () => {
  const row = needsDesignRow({ report_excerpt: refusalExcerptFromFixReport(ROUND_REPORT) });
  // The same round's own fix.done (outcome NEEDS_DESIGN) does not supersede it.
  const done = { ...row, step: "fix.done", fix_outcome: "NEEDS_DESIGN", report_excerpt: undefined };
  assert.equal(noPrVerdictRowsFromLedger([row, done], NOW).length, 1);
  const drafted = { task_id: "W1-T9363", step: REFUSAL_AMENDMENT_STEP, source_run_id: `DAEMON-1792112356081@${HEAD}`, outcome: "opened" };
  assert.deepEqual(noPrVerdictRowsFromLedger([row, done, drafted], NOW), []);
});

test("W1-T9792: the fix footer asks for the categorized refusal block on an unmeetable criterion", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-T9363", title: "t", files: ["src/lib/retro.ts"] },
    round: 1,
    branch: "run-W1-T9363-1",
    evidence: { review: { unmetCriteria: [{ claim: "c", proof: "grep: x in src/lib/drain.ts", met: false, reason: "r" } as never], summary: "s" } },
  });
  assert.match(prompt, /cannot be met as written/);
  assert.match(prompt, /REFUSED:/);
  assert.match(prompt, /proof-unexecutable-at-head/);
});
