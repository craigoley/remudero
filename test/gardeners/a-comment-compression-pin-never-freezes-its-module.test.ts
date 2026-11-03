import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { renderCommentCompressionShard } from "#src/lib/gate-gardener.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// #16082 (operator ruling 2026-11-01) moved the comment-compression pins to a base-relative shape, because a
// pin that froze its module's whole token stream failed every later feature edit to the module. Eleven pins
// merged while it was open and still froze a digest, and src/lib/risk-judge.ts's pin then failed the first
// feature edit to that module. 48 queued compression shards will mint more pins. Every pin must read its base through compressionPinBase (or the sweep pin's own merge-base read) and
// carry no frozen 64-hex digest, and the shard the gardener mints must say so.

const FROZEN_DIGEST = /["'`][0-9a-f]{64}["'`]/;
const BASE_RELATIVE = /compressionPinBase\(|"merge-base"/;

function compressionPins(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...compressionPins(path));
    else if (/^compress-src-.*\.test\.ts$/.test(entry.name)) found.push(relative(REPO_ROOT, path));
  }
  return found;
}

test("PR-pins: every comment-compression pin compares against its PR base and freezes no digest", () => {
  const pins = compressionPins(join(REPO_ROOT, "test"));
  // Positive control: the census sees the population it governs.
  assert.ok(pins.length >= 30, `expected the 30+ compression pins on main, found ${pins.length}`);
  assert.ok(pins.includes("test/review/compress-src-lib-risk-judge-ts.test.ts"));
  const frozen = pins.filter((pin) => {
    const text = readFileSync(join(REPO_ROOT, pin), "utf8");
    return FROZEN_DIGEST.test(text) || !BASE_RELATIVE.test(text);
  });
  assert.deepEqual(frozen, [], "a compression pin froze its module; use compressionPinBase from #test/helpers/compression-pin.js");

  // The detector's own controls: a frozen pin is caught, a base-relative one passes.
  assert.ok(FROZEN_DIGEST.test('assert.equal(actual.tokenDigest, "d38b7cb74e533ff3b75bf855332b77871ba243b7f5b73d1becb9a490aac2defb");'));
  assert.ok(!FROZEN_DIGEST.test('const before = compressionPinBase("src/lib/x.ts", import.meta.url);'));
  assert.ok(BASE_RELATIVE.test('const before = compressionPinBase("src/lib/x.ts", import.meta.url);'));
});

test("PR-pins: the compression shard the gardener mints names compressionPinBase", () => {
  const rendered = renderCommentCompressionShard({ file: "src/subject.ts", comments: 900 }, "W1-T999903");
  assert.equal(rendered.refused, undefined);
  assert.match(rendered.text, /compressionPinBase from #test\/helpers\/compression-pin\.js, never a frozen digest/);
});
