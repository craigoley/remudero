// W1-T3302 — slow-tier evidence must remain a proposal, but must exist and expose material drift.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");
const WORKFLOW = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, {
    needs?: string[];
    steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
  }>;
};

const tier = (await import(pathToFileURL(SCRIPT).href)) as {
  durationStalenessWarnings: (
    manifest: { files: Record<string, number> },
    measured: Record<string, number>,
    factor?: number,
  ) => string[];
  mergeDurations: (
    manifest: { thresholdMs: number; files: Record<string, number> },
    measured: Record<string, number>,
  ) => { thresholdMs: number; files: Record<string, number> };
  tierFiles: (
    files: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
  ) => { fast: string[]; slow: string[] };
  main: (argv: string[]) => number;
};

function runs(job: string): string {
  return (WORKFLOW.jobs[job].steps ?? []).map((step) => step.run ?? "").join("\n");
}

test("W1-T3302: the slow harness writes evidence, uploads it, and the proposal collector reads it", () => {
  const slow = WORKFLOW.jobs["test-slow"];
  assert.match(runs("test-slow"), /RMD_TEST_DURATION_OUTPUT="\$\{RUNNER_TEMP\}\/test-duration\/slow\.json"/);
  assert.match(runs("test-slow"), /npm run --silent test:slow -- --base "origin\/\$\{GITHUB_BASE_REF\}"/);
  const upload = slow.steps?.find((step) => step.name === "Upload slow-tier duration evidence (structured Node test events, W1-T3302)");
  assert.match(upload?.uses ?? "", /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload?.with?.name, "test-duration-slow");
  assert.equal(upload?.with?.path, "${{ runner.temp }}/test-duration");
  const download = WORKFLOW.jobs["flake-retry-aggregate"].steps?.find(
    (step) => step.name === "Download every duration evidence artifact (best-effort)",
  );
  assert.equal(download?.with?.pattern, "test-duration-*");
  assert.deepEqual(
    WORKFLOW.jobs["flake-retry-aggregate"].needs,
    ["ci", "test-slow"],
    "the collector must wait for slow evidence before downloading artifacts",
  );
});

test("W1-T3302: a material disagreement names the file, both durations, and ratio; absent evidence stays unknown", () => {
  const manifest = { thresholdMs: 5000, files: { "test/slow.test.ts": 9042 } };
  const warnings = tier.durationStalenessWarnings(manifest, { "test/slow.test.ts": 172866 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test\/slow\.test\.ts/);
  assert.match(warnings[0], /recorded 9042ms, observed 172866ms/);
  assert.match(warnings[0], /19\.12x; threshold 2x/);

  const withoutEvidence = tier.mergeDurations(manifest, {});
  assert.equal(withoutEvidence.files["test/slow.test.ts"], 9042, "an absent observation must not become zero");
  assert.deepEqual(tier.tierFiles(["test/slow.test.ts"], withoutEvidence).slow, ["test/slow.test.ts"]);
  assert.deepEqual(tier.durationStalenessWarnings(manifest, {}), [], "an absent observation has no invented ratio");
});

test("W1-T3302: record-evidence writes only a next-manifest proposal", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slow-tier-evidence-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "slow.test.ts"), "import { test } from 'node:test';\ntest('slow', () => {});\n");
  const manifestPath = join(root, "scripts", "test-tier-manifest.json");
  writeFileSync(manifestPath, '{"thresholdMs":5000,"files":{"test/slow.test.ts":9042}}\n');
  const evidencePath = join(root, "slow.json");
  writeFileSync(evidencePath, '{"version":1,"files":{"test/slow.test.ts":172866}}\n');
  const before = readFileSync(manifestPath, "utf8");

  assert.equal(tier.main(["--root", root, "--record-evidence", evidencePath, "--output", "next.json"]), 0);
  assert.equal(readFileSync(manifestPath, "utf8"), before, "the tracked ledger is never auto-applied");
  assert.equal(JSON.parse(readFileSync(join(root, "next.json"), "utf8")).files["test/slow.test.ts"], 172866);
});
