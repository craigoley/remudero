import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error — this executable .mjs intentionally has no declaration output; the seam this
// suite consumes is declared immediately below rather than left as `any`, the same shape
// test/a-ci-skip-guard-can-fire-unconditionally.test.ts already uses for a sibling script.
import * as manifestScript from "../scripts/test-tier-manifest.mjs";

type Manifest = { thresholdMs?: number; files?: Record<string, number> };
const mergeDurations = manifestScript.mergeDurations as (m: Manifest, measured: Record<string, number>) => Required<Manifest>;
const placeholderPopulation = manifestScript.placeholderPopulation as (m: Manifest) => { zero: number; total: number };

// ── W1-T3724 — THE DURATION PROPOSAL HAD NO CONSUMER ─────────────────────────────────────────
//
// MEASURED 2026-09-17. CI's wall clock is `worst_coverage_shard + coverage-ratchet`; everything
// else lands inside 3 minutes. The shards are unbalanced because 338 of 1,604 manifest files
// record `durationMs: 0` and pack as FREE — worst shard 16.6 min against an ideal of 12.75.
//
// The fix was already computed on every run: `--record-evidence` builds a corrected manifest from
// real per-shard evidence and uploads it as a 7-day artifact NOTHING CONSUMES. The zeros are
// self-sustaining — W1-T3205 seeds a new test file at 0 so its PR is not born red, and the
// script's own words are that "a real number replaces the placeholder on the next
// --record-evidence pass". There was no next pass that landed.

test("measured durations from a run land in the manifest", () => {
  const manifest = { thresholdMs: 5000, files: { "test/a.test.ts": 0, "test/b.test.ts": 900 } };
  const merged = mergeDurations(manifest, { "test/a.test.ts": 1200, "test/b.test.ts": 1500 });
  assert.deepEqual(merged.files, { "test/a.test.ts": 1200, "test/b.test.ts": 1500 });
  assert.equal(merged.thresholdMs, 5000, "the threshold is not this task's business");
});

test("an unmeasured run never resets a file already carrying a real duration", () => {
  // THE ASSERTION THE WHOLE TASK RESTS ON. `readDurationEvidence` rejects only `< 0`, so a `0`
  // reading passes its filter — and a file back at 0 packs as free, which is how a fifth of the
  // corpus came to shard as costless.
  const merged = mergeDurations({ thresholdMs: 5000, files: { "test/a.test.ts": 4200 } }, { "test/a.test.ts": 0 });
  assert.equal(merged.files["test/a.test.ts"], 4200, "a placeholder must not erase a measurement");
});

test("a file with no measurement yet still takes the placeholder", () => {
  // The protection is against ERASURE, not against seeding: W1-T3205's seed must still work.
  const merged = mergeDurations({ thresholdMs: 5000, files: {} }, { "test/new.test.ts": 0 });
  assert.equal(merged.files["test/new.test.ts"], 0);
});

test("a duration may fall as well as rise — this is not a ratchet", () => {
  // A suite genuinely getting faster must be recorded, or the split packs against a cost that no
  // longer exists. Only the placeholder is refused, never a real number in either direction.
  const manifest = { thresholdMs: 5000, files: { "test/a.test.ts": 9000 } };
  assert.equal(mergeDurations(manifest, { "test/a.test.ts": 1200 }).files["test/a.test.ts"], 1200);
  assert.equal(mergeDurations(manifest, { "test/a.test.ts": 12000 }).files["test/a.test.ts"], 12000);
});

test("partial shard evidence lands for the shards that reported", () => {
  // A run where one shard died produces evidence for three. Those three land; the fourth keeps its
  // previous numbers. Refusing the whole update is what keeps the corpus at zero.
  const manifest = { thresholdMs: 5000, files: { "test/a.test.ts": 0, "test/b.test.ts": 0, "test/c.test.ts": 700 } };
  const merged = mergeDurations(manifest, { "test/a.test.ts": 1100 });
  assert.equal(merged.files["test/a.test.ts"], 1100, "the shard that reported lands");
  assert.equal(merged.files["test/b.test.ts"], 0, "the shard that did not keeps what it had");
  assert.equal(merged.files["test/c.test.ts"], 700, "and an untouched real number is untouched");
});

test("the zero-duration population is reported, so the measure of success is visible", () => {
  // If this number does not fall, nothing landed — and nobody can tell without it.
  assert.deepEqual(placeholderPopulation({ files: { a: 0, b: 0, c: 900 } }), { zero: 2, total: 3 });
  const after = mergeDurations({ thresholdMs: 5000, files: { a: 0, b: 0, c: 900 } }, { a: 1200 });
  assert.deepEqual(placeholderPopulation(after), { zero: 1, total: 3 });
});

test("a manifest with no files reports an empty population rather than throwing", () => {
  assert.deepEqual(placeholderPopulation({}), { zero: 0, total: 0 });
});
