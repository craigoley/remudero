// @source-text-subject: the cash served-model comments in worker-provider.ts and attempt-outcome-attribution.ts.
// @census-reads: src/lib/worker-provider.ts src/lib/attempt-outcome-attribution.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { attributeAttemptOutcome } from "#src/lib/attempt-outcome-attribution.js";
import { CASH_SERVED_MODEL_REASONS, cashServedModel } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

interface SourceComment { text: string; start: number; end: number }

function sourceComments(path: string): { source: string; comments: SourceComment[] } {
  const source = readFileSync(join(REPO_ROOT, path), "utf8");
  const parsed = parse(source, { sourceType: "module", plugins: ["typescript"], attachComment: false });
  const comments = parsed.comments!.map((c) => ({ text: source.slice(c.start!, c.end!), start: c.start!, end: c.end! }));
  return { source, comments };
}

/** The last comment that ends before the first match of `anchor` in the source. */
function commentBefore(file: { source: string; comments: SourceComment[] }, anchor: string): string {
  const at = file.source.indexOf(anchor);
  assert.ok(at >= 0, `anchor ${anchor} is in the source`);
  const before = file.comments.filter((c) => c.end <= at);
  assert.ok(before.length > 0, `a comment precedes ${anchor}`);
  return before[before.length - 1]!.text;
}

/** The comment that sits on the same line as the first match of `anchor`, after it. */
function trailingComment(file: { source: string; comments: SourceComment[] }, anchor: string): string | undefined {
  const at = file.source.indexOf(anchor);
  const lineEnd = file.source.indexOf("\n", at);
  return file.comments.find((c) => c.start > at && c.start < lineEnd)?.text;
}

test("W1-T14389 criterion 1: cashServedModel gives the latest named model, the unnamed reason only when none named one, and noResponse for an empty list", () => {
  assert.deepEqual(cashServedModel(["model-a", "model-b"]), { servedModel: "model-b" });
  assert.deepEqual(cashServedModel(["model-a", undefined]), { servedModel: "model-a" });
  assert.deepEqual(cashServedModel([undefined, "model-b", undefined]), { servedModel: "model-b" });
  assert.deepEqual(cashServedModel([undefined, undefined]),
    { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.unnamed });
  assert.deepEqual(cashServedModel([]), { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.noResponse });
  assert.equal(CASH_SERVED_MODEL_REASONS.noResponse, "no cash response was received, so none named the model that served it");
  assert.equal(CASH_SERVED_MODEL_REASONS.unnamed, "a cash response named no model id");
  // The function takes only what responses named, so a served model is always one of those names.
  for (const named of [["model-a"], ["model-a", "model-b"], [undefined, "model-c"]]) {
    const { servedModel } = cashServedModel(named);
    assert.ok(servedModel !== null && named.includes(servedModel), `${String(servedModel)} is a name a response gave`);
  }
});

test("W1-T14389 criterion 2: an older attempt row with the mixed reason still counts as a provider reply", () => {
  const row = {
    success: false,
    served_model: null,
    served_model_reason: `${CASH_SERVED_MODEL_REASONS.mixed}: model-a, model-b`,
  };
  assert.deepEqual(attributeAttemptOutcome(row), { outcome: "model", signal: "provider-invoked" });
  assert.deepEqual(attributeAttemptOutcome({ success: false, served_model: null }),
    { outcome: "unknown", signal: "no-attribution-signal" }, "the same row without the reason has no reply evidence");
});

test("W1-T14389 criterion 3: the served-model comments say what the code does and the provider stays under its comment-byte cap", () => {
  const provider = sourceComments("src/lib/worker-provider.ts");
  const docblock = commentBefore(provider, "export function cashServedModel(");
  assert.match(docblock, /latest response that named a model wins/);
  assert.doesNotMatch(docblock, /SAME one|every response received named one|never a pick of first or last/);
  assert.match(docblock, /unnamed reason applies only when none named one/);
  assert.match(docblock, /noResponse reason when no response came/);
  assert.match(docblock, /Never the requested deployment/);
  const body = provider.source.slice(provider.source.indexOf("export function cashServedModel("));
  const bodyEnd = body.indexOf("\n}\n");
  assert.doesNotMatch(body.slice(0, bodyEnd), /\/\/ W1-T13868/, "the inline note inside the function is gone");

  const noResponse = commentBefore(provider, "  noResponse: ");
  assert.doesNotMatch(noResponse, /not that no reply ever came/);
  assert.match(noResponse, /after the deadline aborted the attempt/);

  const mixedNote = /no longer produced; kept so that older rows still read/i;
  assert.match(trailingComment(provider, "  mixed: ") ?? "", mixedNote);
  const attribution = sourceComments("src/lib/attempt-outcome-attribution.ts");
  assert.match(commentBefore(attribution, "CASH_SERVED_MODEL_REASONS.mixed}"), mixedNote);

  const commentBytes = provider.comments.reduce((n, c) => n + Buffer.byteLength(c.text), 0);
  assert.ok(commentBytes < 104858, `worker-provider.ts comment bytes ${commentBytes} stay below 104858`);
});
