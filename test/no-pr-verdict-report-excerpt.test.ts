// W1-T407 — acceptance #3: "the worker's own closing report rides the row as a capped excerpt,
// and is absent rather than empty when there is nothing to carry."
//
// Same discipline `workerFailureExcerpt`/`STDERR_EXCERPT_CAP` already apply to a FAILED spawn's
// stderr (W1-T238), applied here to a terminal-SUCCESS no-op's own report text instead: capped
// via `noPrReportExcerpt`/`REPORT_EXCERPT_CAP`, and `undefined` — never `""` — when there is
// nothing worth carrying, so a quiet worker's ledger row never grows a blank field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noPrVerdict } from "../src/run-task.js";
import { noPrReportExcerpt, REPORT_EXCERPT_CAP, type WorkerResult } from "../src/lib/worker.js";

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

// ── The helper, unit-tested directly ──────────────────────────────────────────────────────

test("noPrReportExcerpt: empty text AND empty blocks ⇒ undefined, never an empty string", () => {
  assert.equal(noPrReportExcerpt({ text: "", blocks: [] }), undefined);
});

test("noPrReportExcerpt: whitespace-only text/blocks ⇒ still undefined (nothing worth carrying)", () => {
  assert.equal(noPrReportExcerpt({ text: "   \n  ", blocks: ["\t"] }), undefined);
});

test("noPrReportExcerpt: non-empty text is carried verbatim when under the cap", () => {
  const excerpt = noPrReportExcerpt({ text: "REPORT\nnothing to change here.", blocks: [] });
  assert.equal(excerpt, "REPORT\nnothing to change here.");
});

test("noPrReportExcerpt: text AND blocks both contribute, joined — matching run-task.ts's own fullText shape", () => {
  const excerpt = noPrReportExcerpt({ text: "final text", blocks: ["block one", "block two"] });
  assert.equal(excerpt, "final text\nblock one\nblock two");
});

test("noPrReportExcerpt: text past REPORT_EXCERPT_CAP is truncated with a count of the cut chars, never silently dropped", () => {
  const long = "x".repeat(REPORT_EXCERPT_CAP + 250);
  const excerpt = noPrReportExcerpt({ text: long, blocks: [] });
  assert.ok(excerpt);
  assert.equal(excerpt!.length < long.length, true);
  assert.match(excerpt!, /…\[truncated, 250 more chars\]$/);
  assert.equal(excerpt!.startsWith("x".repeat(REPORT_EXCERPT_CAP)), true);
});

// ── Riding the no_pr ledger row ────────────────────────────────────────────────────────────

test("noPrVerdict: report_excerpt is ABSENT (key not present) on the ledger row when the worker said nothing", () => {
  const v = noPrVerdict(result({ text: "", blocks: [] }), 1, "implement", 0);
  assert.equal("report_excerpt" in v.ledger, false);
  assert.equal(v.ledger.report_excerpt, undefined);
});

test("noPrVerdict: report_excerpt carries the worker's report when it left one", () => {
  const v = noPrVerdict(result({ text: "REPORT\nI declined because X.", blocks: [] }), 1, "implement", 0);
  assert.equal(v.ledger.report_excerpt, "REPORT\nI declined because X.");
});

test("noPrVerdict: a long report is capped on the ledger row exactly as noPrReportExcerpt caps it standalone", () => {
  const long = "y".repeat(REPORT_EXCERPT_CAP + 10);
  const v = noPrVerdict(result({ text: long, blocks: [] }), 1, "implement", 0);
  assert.equal(v.ledger.report_excerpt, noPrReportExcerpt({ text: long, blocks: [] }));
});
