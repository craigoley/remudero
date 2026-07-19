import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T33: the learnings INDEX generator (MASTER-PLAN §8A Tier 1) ──────────
//
// The learnings corpus is split into subsystem shards; the index (learnings/index.json) is what
// makes injection a LOOKUP instead of a full scan. This suite proves the generator is ACTIVE, not
// merely present: a FRESH index (matches a regeneration byte-for-byte) turns `--check` green; a
// STALE one (deliberately doesn't match) turns it RED and names the file to regenerate. It also
// proves a duplicate id across two shards fails loud, and that the REAL committed
// learnings/index.json is currently fresh (the same check CI runs, via `npm test`, on every PR).
//
// (scripts/generate-learnings-index.mjs is a plain .mjs file outside tsconfig's `include`, so its
// pure functions are exercised here only via `spawnSync` against its CLI surface, mirroring
// test/claims-check.test.ts's convention for scripts/claims-check.mjs.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-learnings-index.mjs");
const FIXTURES = join(__dirname, "fixtures", "learnings-index");

function runCheck(dir: string, out?: string) {
  const args = [SCRIPT, "--dir", dir, "--check"];
  if (out) args.push("--out", out);
  return spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function runGenerate(dir: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("generate-learnings-index --check: a FRESH index (matches a regeneration) -> zero exit", () => {
  const result = runCheck(join(FIXTURES, "fresh"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- .*index\.json matches the current corpus/);
});

test("generate-learnings-index --check: a STALE index (deliberately wrong entry id) -> non-zero exit, NAMES the file to regenerate", () => {
  const result = runCheck(join(FIXTURES, "stale"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /is STALE/);
  assert.match(output, /index\.json/);
  assert.match(output, /npm run learnings-index/);
});

test("generate-learnings-index --check: a MISSING committed index -> non-zero exit, tells the operator how to generate it", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-index-missing-"));
  writeFileSync(join(dir, "a.yaml"), "- id: x\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n");
  const result = runCheck(dir, join(dir, "index.json"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /does not exist/);
  assert.match(output, /npm run learnings-index/);
});

test("generate-learnings-index: a duplicate id ACROSS two shard files fails loud (non-zero exit, names the id)", () => {
  const result = runGenerate(join(FIXTURES, "dup"), join(tmpdir(), "should-not-be-written.json"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /duplicate learnings id 'dup-fixture'/);
});

test("generate-learnings-index (no --check) writes an index that a subsequent --check accepts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "learnings-index-roundtrip-"));
  try {
    writeFileSync(join(tmp, "x.yaml"), "- id: rt-one\n  files: [rt.ts]\n  fact: roundtrip fact.\n  src: PR#9\n");
    const genResult = runGenerate(tmp, join(tmp, "index.json"));
    assert.equal(genResult.status, 0, genResult.stdout + genResult.stderr);
    const written = JSON.parse(readFileSync(join(tmp, "index.json"), "utf8"));
    assert.deepEqual(written.files["x.yaml"].entries, ["rt-one"]);
    assert.deepEqual(written.files["x.yaml"].globs, ["rt.ts"]);

    const checkResult = runCheck(tmp, join(tmp, "index.json"));
    assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── The real learnings/ corpus: the index is currently fresh, and the split is real ─────────────

test("the REAL committed learnings/index.json is NOT stale (this is what CI checks on every PR via `npm test`)", () => {
  const result = runCheck(join(REPO_ROOT, "learnings"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});

test("the real corpus is split by subsystem: learnings/{platform,architecture,ci,testing,failures}.yaml all exist and are indexed", () => {
  const index = JSON.parse(readFileSync(join(REPO_ROOT, "learnings", "index.json"), "utf8"));
  for (const shard of ["platform.yaml", "architecture.yaml", "ci.yaml", "testing.yaml", "failures.yaml"]) {
    assert.ok(index.files[shard], `expected the index to carry shard '${shard}'`);
    assert.ok(index.files[shard].entries.length > 0, `expected shard '${shard}' to carry at least one entry`);
  }
});
