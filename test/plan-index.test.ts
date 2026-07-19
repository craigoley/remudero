import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadPlanIndex, renderPlanIndex, type PlanIndex } from "../src/lib/plan-index.js";

// ── W1-T37: the plan INDEX generator (MASTER-PLAN §8A Tier 2) ──────────────────────────────────
//
// The plan is RETRIEVED, not injected: instead of shipping MASTER-PLAN.md's ~1900 lines to every
// worker, a generated INDEX (plan/plan-index.json) carries just section headings + one-line
// summaries + a grep hint. This suite proves the generator is ACTIVE, not merely present: a FRESH
// index (matches a regeneration byte-for-byte) turns `--check` green; a STALE one turns it RED and
// names the file to regenerate — same discipline as scripts/generate-learnings-index.mjs (W1-T33).
// It also proves the REAL committed plan/plan-index.json is currently fresh (the same check CI
// runs, via `npm test`, on every PR).
//
// (scripts/generate-plan-index.mjs is a plain .mjs file outside tsconfig's `include`, so its pure
// functions are exercised here only via `spawnSync` against its CLI surface, mirroring
// test/learnings-index.test.ts's convention for scripts/generate-learnings-index.mjs.)

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
    assert.match(output, /npm run plan-index/);
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
    assert.match(output, /npm run plan-index/);
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

// ── The real plan/: the index is currently fresh ────────────────────────────────────────────────

test("the REAL committed plan/plan-index.json is NOT stale (this is what CI checks on every PR via `npm test`)", () => {
  // Relative paths + cwd: REPO_ROOT, matching the exact invocation `npm run plan-index:check`
  // uses (no --source/--out overrides) — an absolute --source would change the recorded
  // `source` field and produce a false-positive STALE result unrelated to real drift.
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});

test("the real plan/plan-index.json carries every MASTER-PLAN.md '## ' section heading, in document order", () => {
  const masterPlan = readFileSync(join(REPO_ROOT, "MASTER-PLAN.md"), "utf8");
  const expectedHeadings = masterPlan
    .split("\n")
    .filter((l) => /^## /.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
  const index = JSON.parse(readFileSync(join(REPO_ROOT, "plan", "plan-index.json"), "utf8"));
  assert.deepEqual(
    index.entries.map((e: { heading: string }) => e.heading),
    expectedHeadings,
  );
});

// ── src/lib/plan-index.ts — the runtime loader/renderer ─────────────────────────────────────────

test("loadPlanIndex: a missing file is non-fatal — returns null (a fresh checkout before the first generation)", () => {
  assert.equal(loadPlanIndex(join(tmpdir(), "does-not-exist-plan-index.json")), null);
});

test("loadPlanIndex: malformed JSON / wrong shape is non-fatal — returns null, never throws", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-malformed-"));
  try {
    const badJson = join(tmp, "bad.json");
    writeFileSync(badJson, "{ not valid json");
    assert.equal(loadPlanIndex(badJson), null);

    const wrongShape = join(tmp, "wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ source: "x.md" })); // missing 'entries'
    assert.equal(loadPlanIndex(wrongShape), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadPlanIndex: a well-formed index round-trips through renderPlanIndex", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-index-roundtrip2-"));
  try {
    const path = join(tmp, "plan-index.json");
    const index: PlanIndex = {
      source: "MASTER-PLAN.md",
      entries: [{ heading: "4A. Workspace containment (fleet-wide)", line: 760, summary: "The sandbox story." }],
    };
    writeFileSync(path, JSON.stringify(index));
    const loaded = loadPlanIndex(path);
    assert.deepEqual(loaded, index);
    const rendered = renderPlanIndex(loaded!);
    assert.match(rendered, /"4A\. Workspace containment \(fleet-wide\)" \(line 760\): The sandbox story\./);
    assert.match(rendered, /grep/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("renderPlanIndex: an index with NO entries renders '' — a caller can safely omit the whole block", () => {
  assert.equal(renderPlanIndex({ source: "MASTER-PLAN.md", entries: [] }), "");
});
