import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

// The optional index is generated locally; --check validates the corpus without a cache.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot();
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

test("generate-learnings-index --check: a valid corpus -> zero exit", () => {
  const result = runCheck(join(FIXTURES, "fresh"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- .*corpus builds an index/);
});

test("generate-learnings-index --check: a stale optional index does not invalidate the corpus", () => {
  const result = runCheck(join(FIXTURES, "stale"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /corpus builds an index/);
});

test("generate-learnings-index --check: a missing optional index is not written", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-index-missing-"));
  writeFileSync(join(dir, "a.yaml"), "- id: x\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n");
  const result = runCheck(dir, join(dir, "index.json"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /corpus builds an index/);
  assert.equal(existsSync(join(dir, "index.json")), false);
});

test("generate-learnings-index: a duplicate id ACROSS two shard files fails loud (non-zero exit, names the id)", () => {
  const result = runGenerate(join(FIXTURES, "dup"), join(tmpdir(), "should-not-be-written.json"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /duplicate learnings id 'dup-fixture'/);
});

test("generate-learnings-index: a shard whose 'symbols' is not a list fails loud rather than indexing it", () => {
  // The generator validates the same two selection fields lib/learnings.ts does, in its own
  // process — so its refusal arms need their own reach. A malformed shard that indexed silently
  // would hand selection a corpus it could never match against.
  const result = runGenerate(join(FIXTURES, "bad-symbols"), join(tmpdir(), "should-not-be-written.json"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /'symbols' must be a list of strings/);
});

test("generate-learnings-index: a shard whose 'error_signatures' carries a non-string fails loud", () => {
  const result = runGenerate(join(FIXTURES, "bad-error-signatures"), join(tmpdir(), "should-not-be-written.json"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /'error_signatures' must be a list of strings/);
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

// The real corpus remains split into legacy subsystem shards.

test("the real corpus builds a local index without a committed artifact", () => {
  const result = runCheck(join(REPO_ROOT, "learnings"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});

test("the real corpus is split by subsystem: learnings/{platform,architecture,ci,testing,failures}.yaml all exist and are indexed", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-real-learnings-index-"));
  const out = join(dir, "index.json");
  const result = runGenerate(join(REPO_ROOT, "learnings"), out);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const index = JSON.parse(readFileSync(out, "utf8"));
  for (const shard of ["platform.yaml", "architecture.yaml", "ci.yaml", "testing.yaml", "failures.yaml"]) {
    assert.ok(index.files[shard], `expected the index to carry shard '${shard}'`);
    assert.ok(index.files[shard].entries.length > 0, `expected shard '${shard}' to carry at least one entry`);
  }
});
