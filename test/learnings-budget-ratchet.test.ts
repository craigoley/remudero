import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T38: KNOWLEDGE BUDGET AS A CI RATCHET (MASTER-PLAN §8A) ──────────────────────────────────
//
// "Compression is a deliverable" stays aspirational unless a CI gate enforces it -- the same
// shape as the coverage ratchet, except this one is a CEILING on the total INJECTABLE weight of
// the ACTIVE learnings corpus (every `learnings/*.yaml` shard, summed, rendered exactly as
// src/lib/learnings.ts would inject it). Every test below drives the actual CLI
// (scripts/learnings-budget-ratchet.mjs) as a subprocess against a planted fixture, so the
// assertion is on the real exit code a CI job would see -- the falsifier fixture proves the gate
// is ACTIVE, not merely present.
//
// (scripts/learnings-budget-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it
// is exercised here only via its CLI surface, mirroring test/coverage-ratchet.test.ts and
// test/learnings-assert-check.test.ts's convention for their sibling scripts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "learnings-budget-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "learnings-budget-ratchet");

function run(dir: string, baseline: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", join(FIXTURES, dir), "--baseline", join(FIXTURES, baseline)], {
    encoding: "utf8",
  });
}

// ── Basic ceiling behavior: a single active entry, at/under vs over the cap ──────────────────────

test("learnings-budget-ratchet CLI: active corpus UNDER the cap -> zero exit (the gate ACCEPTS)", () => {
  const result = run("basic", "under-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /active corpus 41 chars \(cap 100 chars\)/);
  assert.match(result.stdout, /OK -- active corpus is at or under the knowledge budget cap/);
});

test("learnings-budget-ratchet CLI: active corpus OVER the cap -> non-zero exit, names the measured size vs cap (the gate BLOCKS)", () => {
  const result = run("basic", "over-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /active learnings corpus 41 chars > cap 40 chars/);
});

test("learnings-budget-ratchet CLI: baseline with no capChars at all -> no crash, no false block", () => {
  const result = run("basic", "baseline-no-cap.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /cap unset/);
});

// ── SUPERSEDED / QUARANTINED entries do NOT count (acceptance criterion 2) ───────────────────────
//
// Same beta bytes in every fixture below -- only its `lifecycle` differs. Marking it
// superseded/quarantined must reduce the counted size enough to pass a cap that the identical
// bytes, if active, would blow through.

test("learnings-budget-ratchet CLI: a SUPERSEDED entry contributes ZERO chars -- passes a cap only the sibling active entry fits", () => {
  const result = run("lifecycle-superseded", "tight-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /active corpus 41 chars \(cap 41 chars\)/);
  assert.match(result.stdout, /1 active \/ 2 total entries/);
});

test("learnings-budget-ratchet CLI: a QUARANTINED entry contributes ZERO chars -- passes the same tight cap", () => {
  const result = run("lifecycle-quarantined", "tight-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /active corpus 41 chars \(cap 41 chars\)/);
  assert.match(result.stdout, /1 active \/ 2 total entries/);
});

test("learnings-budget-ratchet CLI: the COUNTERFACTUAL -- the identical beta bytes, but ACTIVE -- blows the same cap the superseded/quarantined fixtures passed", () => {
  const result = run("lifecycle-both-active", "tight-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /active learnings corpus 168 chars > cap 41 chars/);
  assert.match(result.stderr, /BLOCKED/);
});

// ── Summation across multiple shard files ─────────────────────────────────────────────────────────

test("learnings-budget-ratchet CLI: sums active weight ACROSS shard files, not just within one", () => {
  const atCap = run("multi-shard", "multi-shard-baseline.json");
  assert.equal(atCap.status, 0, atCap.stdout + atCap.stderr);
  assert.match(atCap.stdout, /active corpus 82 chars \(cap 82 chars\)/);
  assert.match(atCap.stdout, /2 active \/ 2 total entries/);

  const overCap = run("multi-shard", "multi-shard-baseline-over.json");
  assert.notEqual(overCap.status, 0, overCap.stdout + overCap.stderr);
  assert.match(overCap.stderr, /active learnings corpus 82 chars > cap 81 chars/);
});

// ── loadCorpus / loadShardEntries validation: every malformed-shard branch names the failure ─────

test("an empty shard (parses to `undefined`, not a list) is zero entries, not an error", () => {
  const result = run("empty-doc", "empty-doc-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /active corpus 0 chars \(cap 0 chars\)/);
  assert.match(result.stdout, /0 active \/ 0 total entries/);
});

test("a shard that is a YAML mapping, not a list, is rejected", () => {
  const result = run("malformed-not-list", "under-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /must be a YAML list of entries/);
});

test("a list entry that is not a mapping is rejected", () => {
  const result = run("malformed-entry-not-object", "under-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /entry 0 must be a mapping/);
});

test("an entry missing the required 'id' field is rejected", () => {
  const result = run("malformed-missing-id", "under-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /missing string 'id'/);
});

test("an entry missing the required 'fact' field is rejected", () => {
  const result = run("malformed-missing-fact", "under-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /missing string 'fact'/);
});

test("an entry with an invalid 'lifecycle' value is rejected", () => {
  const result = run("malformed-invalid-lifecycle", "under-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /'lifecycle' must be 'active', 'superseded', or 'quarantined'/);
});

test("a missing corpus directory is zero entries, not an error", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--dir", join(FIXTURES, "does-not-exist"), "--baseline", join(FIXTURES, "under-baseline.json")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 active \/ 0 total entries/);
});

// ── The real learnings/ corpus + its committed baseline: currently within budget (what CI checks) ─

test("the REAL committed learnings/ corpus is currently within the recorded knowledge budget cap", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK -- active corpus is at or under the knowledge budget cap/);
});

test("the real corpus carries at least one SUPERSEDED entry (zdotdir-alone-isolates-shells, W1-T33) proving the exclusion is exercised on real data, not only fixtures", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // 35 total entries in the corpus at authoring time, 34 active (1 superseded) -- see
  // learnings/platform.yaml's zdotdir-alone-isolates-shells. This assertion is on the DELTA
  // (total > active), not the exact counts, so it survives future retro additions.
  const match = result.stdout.match(/(\d+) active \/ (\d+) total entries/);
  assert.ok(match, result.stdout);
  const active = Number(match![1]);
  const total = Number(match![2]);
  assert.ok(total > active, `expected at least one non-active entry in the real corpus (active=${active}, total=${total})`);
});

test("learnings-budget-ratchet module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});
