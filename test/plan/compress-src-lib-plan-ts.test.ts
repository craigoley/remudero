// @source-text-subject: plan.ts comment volume and executable-token preservation.
// @census-reads: src/lib/plan.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const tokens = parsed.tokens!.filter(token => typeof token.type !== "string")
    .map(token => [token.type.label, source.slice(token.start, token.end)]);
  const comments = parsed.comments!.map(comment => source.slice(comment.start!, comment.end!));
  return {
    tokens: digest(tokens),
    ast: digest(JSON.parse(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value))),
    commentLines: comments.reduce((sum, comment) => sum + comment.split("\n").length, 0),
    commentBytes: comments.reduce((sum, comment) => sum + Buffer.byteLength(comment), 0),
    comments,
  };
}

test("W1-T11190: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/plan.ts"), "utf8");
  const actual = snapshot(source);
  // One explanation's measured before-state keeps this proof discriminating after merge,
  // without imposing a comment ceiling or freezing future executable edits to the module.
  const releaseBefore = `/**
 * W1-T3206 — THE LEDGER STEP THAT RELEASES A PARKED TASK.
 *
 * \`verify: human\` was a ONE-WAY PARK: \`isDispatchEligible\` refuses it (drain.ts) and
 * {@link assertRunnable} throws, and NOTHING converted an operator's decision back into dispatch.
 * MEASURED 2026-09-08: 45 such shards queued, the oldest filed 2026-07-21 — seven weeks — and a
 * grep across src/ for any approve/release/unblock path keyed on \`verify: human\` returned zero.
 *
 * THE RELEASE IS NOT A PLAN EDIT. It is the row \`rmd approve\` ALREADY writes when an operator
 * spends his bit, so the plan record stays byte-identical, the decision is auditable, and no worker
 * ever rewrites a \`verify:\` field (which Standing rule 15 forbids anyway).
 */`;
  const release = actual.comments.find(comment => comment.includes("W1-T3206"));
  assert.ok(release, "retain the operator-release invariant and its citation");
  assert.ok(release.split("\n").length < releaseBefore.split("\n").length,
    "the release explanation has fewer comment lines than before compression");
  assert.ok(Buffer.byteLength(release) < Buffer.byteLength(releaseBefore),
    "the release explanation is shorter, not just rewrapped");

  const before = compressionPinBase("src/lib/plan.ts", import.meta.url);
  if (before === undefined) return;
  const base = snapshot(before);
  assert.equal(actual.tokens, base.tokens, "every executable token matches the pre-compression source");
  assert.equal(actual.ast, base.ast, "newline-sensitive syntax matches the pre-compression source");
  assert.ok(base.commentLines > 0 && actual.commentLines > 0, "both measurements see comments");
  assert.ok(actual.commentLines < base.commentLines, "whole-module comment lines decrease");
  assert.ok(actual.commentBytes < base.commentBytes, "whole-module comment bytes decrease");
});

test("plan compression snapshots preserve literals and detect executable and newline changes", () => {
  const source = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const original = snapshot(source);
  const commented = snapshot(`/** extra */\n${source}\n// extra`);
  assert.equal(commented.tokens, original.tokens);
  assert.equal(commented.ast, original.ast);
  assert.ok(commented.commentLines > original.commentLines);
  for (const changed of [source.replace("https?", "http"), source.replace("// kept", "// changed"),
    source.replace("${1}", "${2}")]) {
    assert.notEqual(snapshot(changed).tokens, original.tokens);
    assert.notEqual(snapshot(changed).ast, original.ast);
  }
  assert.notEqual(snapshot("function f() { return 1; }").ast,
    snapshot("function f() { return\n1; }").ast);
});
