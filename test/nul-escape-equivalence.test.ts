// test/nul-escape-equivalence.test.ts — W1-T438: the `\0` escape is a provable no-op.
//
// The fix rewrites each raw NUL BYTE in `criterionKey` (task-linter.ts), `hashToolCall`
// (flight-signals.ts), and the `taskId`/`headSha` composite key (verdict-calibration.ts) as the
// two-character `\0` ESCAPE. That is a spelling change in the source TEXT only if the runtime
// VALUE is unchanged — and for `hashToolCall` specifically this is load-bearing, not decorative:
// it hashes the composite key for repetition detection, so a fix that perturbed the digest would
// silently invalidate every historical comparison.
//
// These tests re-derive, at this HEAD, the four properties the task's design records as VERIFIED
// IN NODE at commit 0b9d564: the escaped and raw forms (1) compare equal as strings, (2) have the
// same byte length, (3) the same equality holds inside a template literal — the exact shape all
// three sites use — and (4) they hash to an identical sha256.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashToolCall } from "../src/lib/flight-signals.js";

/** Built with the `\0` escape — exactly how the three composite-key sites now spell it. */
function escapedKey(a: string, b: string): string {
  return `${a}\0${b}`;
}

/** Built from the actual NUL code point with no source-level escape at all, so this is
 *  independent of how a source FILE spells it — the ground truth the fix must reproduce. */
function trueRawByteKey(a: string, b: string): string {
  return a + String.fromCharCode(0) + b;
}

const CASES: [string, string][] = [
  ["", ""],
  ["taskId-123", "headSha-abcdef0"],
  ["W1-T438", "70d52c2"],
  ["claim text with spaces", "proof text: unit test"],
  ["unicode-😀-key", "tail"],
];

test("PROPERTY the \\0 escape and a true raw NUL byte produce the identical string", () => {
  for (const [a, b] of CASES) {
    const escaped = escapedKey(a, b);
    const raw = trueRawByteKey(a, b);
    assert.equal(escaped, raw, `string mismatch for (${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(escaped.length, raw.length, "code-unit length differs");
    assert.equal(Buffer.byteLength(escaped, "utf8"), Buffer.byteLength(raw, "utf8"), "byte length differs");
  }
});

test("PROPERTY the equality holds inside a template literal, the shape the three sites use", () => {
  for (const [a, b] of CASES) {
    // The exact expression shape `criterionKey`, `hashToolCall`, and verdict-calibration.ts's
    // map key all use: `${x}\0${y}` interpolated directly into a template literal.
    const viaTemplate = `${a}\0${b}`;
    const viaConcat = a + String.fromCharCode(0) + b;
    assert.equal(viaTemplate, viaConcat);
  }
});

test("PROPERTY the escaped and raw forms hash to an identical sha256", () => {
  for (const [a, b] of CASES) {
    const escapedDigest = createHash("sha256").update(escapedKey(a, b)).digest("hex");
    const rawDigest = createHash("sha256").update(trueRawByteKey(a, b)).digest("hex");
    assert.equal(escapedDigest, rawDigest);
  }
});

test("PROPERTY hashToolCall's live composite key matches a hand-built raw-NUL digest", () => {
  // A single-key-free (string) input so `stableStringify` takes its `typeof value !== "object"`
  // branch and reduces to plain `JSON.stringify`, keeping this independent of stableStringify's
  // (unexported) key-sorting behaviour for objects.
  const call = { name: "Bash", input: "echo hi" };
  const actual = hashToolCall(call);

  // Rebuilt independently of flight-signals.ts's own source spelling: name + a TRUE raw NUL byte
  // + JSON.stringify(input) — the pre-fix key shape — hashed the same way `hashToolCall` does.
  const raw = `${call.name}${String.fromCharCode(0)}${JSON.stringify(call.input)}`;
  const expected = createHash("sha256").update(raw).digest("hex");

  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{64}$/);
});
