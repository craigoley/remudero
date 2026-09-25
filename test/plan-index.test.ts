import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadPlanIndex, renderPlanIndex, type PlanIndex } from "../src/lib/plan-index.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T4432: runtime readers derive the plan index from MASTER-PLAN.md instead of maintaining
// plan/plan-index.json as a committed PR artifact. Generator CLI coverage below remains explicit
// and isolated; runtime tests prove missing-file reads build/cache the projection without writes.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-plan-index.mjs");

function runCheck(source: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--source", source, "--out", out, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runGenerate(source: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--source", source, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("generate-plan-index (no --check) writes an index that a subsequent --check accepts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-roundtrip-"));
  try {
    const source = join(tmp, "PLAN.md");
    writeFileSync(source, "# Title\n\n## Section One\n\nSome prose about section one.\n\n## Section Two\n\nMore prose.\n");
    const out = join(tmp, "plan-index.json");
    const genResult = runGenerate(source, out);
    assert.equal(genResult.status, 0, genResult.stdout + genResult.stderr);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      written.entries.map((e: { heading: string }) => e.heading),
      ["Section One", "Section Two"],
    );
    assert.equal(written.entries[0].summary, "Some prose about section one.");

    const checkResult = runCheck(source, out);
    assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr);
    assert.match(checkResult.stdout + checkResult.stderr, /OK -- .*plan-index\.json matches/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-plan-index --check: a STALE index (source changed since generation) -> non-zero exit, NAMES the file to regenerate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-stale-"));
  try {
    const source = join(tmp, "PLAN.md");
    const out = join(tmp, "plan-index.json");
    writeFileSync(source, "# Title\n\n## Section One\n\nOriginal prose.\n");
    assert.equal(runGenerate(source, out).status, 0);

    writeFileSync(source, "# Title\n\n## Section One\n\nEDITED prose that no longer matches.\n");
    const result = runCheck(source, out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /plan-index\.json/);
    assert.match(output, /node scripts\/generate-plan-index\.mjs/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-plan-index --check: a MISSING committed index -> non-zero exit, tells the operator how to generate it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-missing-"));
  try {
    const source = join(tmp, "PLAN.md");
    writeFileSync(source, "# Title\n\n## Section One\n\nProse.\n");
    const result = runCheck(source, join(tmp, "does-not-exist.json"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
    assert.match(output, /node scripts\/generate-plan-index\.mjs/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-plan-index: a heading with NO body prose (immediately followed by another heading) gets an empty summary, never crashes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-empty-summary-"));
  try {
    const source = join(tmp, "PLAN.md");
    writeFileSync(source, "# Title\n\n## Empty Section\n\n## Next Section\n\nProse under next.\n");
    const out = join(tmp, "plan-index.json");
    const result = runGenerate(source, out);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.entries[0].heading, "Empty Section");
    assert.equal(written.entries[0].summary, "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-plan-index: a NESTED (### ) subheading right under a section is skipped as markup, not mistaken for prose — the summary is the first REAL prose line after it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-nested-"));
  try {
    const source = join(tmp, "PLAN.md");
    writeFileSync(source, "# Title\n\n## Section\n\n### Subsection\n\nSub prose.\n");
    const out = join(tmp, "plan-index.json");
    runGenerate(source, out);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.entries.length, 1); // only the ## heading is indexed, not the ### one
    assert.equal(written.entries[0].summary, "Sub prose."); // never the literal "### Subsection" line
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── src/lib/plan-index.ts — derived at read time ───────────────────────────────────────────

test("loadPlanIndex: builds from MASTER-PLAN.md when no JSON index exists", () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-index-derived-`));
  try {
    mkdirSync(join(tmp, "plan"));
    const artifact = join(tmp, "plan", "plan-index.json");
    const source = join(tmp, "MASTER-PLAN.md");
    const contents = "# Plan\n\n## Current section\n\nDerived summary.\n";
    writeFileSync(source, contents);
    assert.equal(existsSync(artifact), false);
    const index = loadPlanIndex(source);
    const canonicalArtifact = join(tmp, "canonical-plan-index.json");
    const generated = runGenerate(source, canonicalArtifact);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.deepEqual(index?.entries, JSON.parse(readFileSync(canonicalArtifact, "utf8")).entries, "the runtime reader matches the generator parser output");
    assert.deepEqual(index?.entries, [{ heading: "Current section", line: 3, summary: "Derived summary." }]);
    assert.equal(existsSync(artifact), false, "reading must not create a committed index file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadPlanIndex: changed MASTER-PLAN.md content invalidates the cached result", () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-index-cache-`));
  try {
    mkdirSync(join(tmp, "plan"));
    const artifact = join(tmp, "plan", "plan-index.json");
    const source = join(tmp, "MASTER-PLAN.md");
    writeFileSync(source, "# Plan\n\n## Before\n\nFirst summary.\n");
    const before = loadPlanIndex(source);
    assert.strictEqual(loadPlanIndex(source), before, "identical content reuses the content-hash cache entry");
    writeFileSync(source, "# Plan\n\n## After\n\nSecond summary.\n");
    const after = loadPlanIndex(source);
    assert.notStrictEqual(after, before);
    assert.deepEqual(after?.entries, [{ heading: "After", line: 3, summary: "Second summary." }]);
    assert.equal(existsSync(artifact), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadPlanIndex: a missing MASTER-PLAN.md is non-fatal", () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-index-missing-source-`));
  try {
    mkdirSync(join(tmp, "plan"));
    assert.equal(loadPlanIndex(join(tmp, "MASTER-PLAN.md")), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("renderPlanIndex: an index with NO entries renders '' — a caller can safely omit the whole block", () => {
  assert.equal(renderPlanIndex({ source: "MASTER-PLAN.md", entries: [] }), "");
});
