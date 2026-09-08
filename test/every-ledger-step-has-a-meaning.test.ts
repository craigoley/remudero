import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LEDGER_STEPS, meaningOfStep, stepFamily } from "../src/lib/ledger-steps.js";
import { makeTempDir } from "../src/lib/tmp.js";

// ── W1-T2764: THE LEDGER-STEP REGISTRY, RATCHET AND PAGE ────────────────────────────────────
//
// `LedgerLine.step` (src/lib/ledger.ts) is a free string with no registry -- this task adds one
// (src/lib/ledger-steps.ts's LEDGER_STEPS + meaningOfStep), a shrink-only ratchet over every step
// literal cited under src/ (scripts/ledger-steps-check.mjs, the task-id-existence-check.mjs
// shape), and a generated page (scripts/generate-ledger-steps.mjs, the generate-cli-reference.mjs
// shape). This suite proves all three, plus the one caller this task wires:
// `rmd ledger-grep` (run-task.ts's `ledgerGrepCommand`) prints a registered row's meaning beside
// a matched line.
//
// (scripts/ledger-steps-check.mjs and scripts/generate-ledger-steps.mjs are plain .mjs files
// outside tsconfig's `include`; the check script is exercised both via direct import (its scanner
// and evaluator are pure) and via its CLI surface, and the generator only via `spawnSync` under
// `node --import tsx`, mirroring test/cli-reference.test.ts's own convention.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CHECK_SCRIPT = join(REPO_ROOT, "scripts", "ledger-steps-check.mjs");
const GENERATE_SCRIPT = join(REPO_ROOT, "scripts", "generate-ledger-steps.mjs");
const REAL_BASELINE = join(REPO_ROOT, "scripts", "ledger-steps-baseline.json");
const REAL_REGISTRY = join(REPO_ROOT, "src", "lib", "ledger-steps.ts");

function mkTmp(prefix: string): string {
  return makeTempDir(`ledger-steps-${prefix}`);
}

function runCheck(args: string[]) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, ...args], { encoding: "utf8" });
}

function runGenerate(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", GENERATE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// ── acceptance 1 & 4: every registered step names a real writer, and the seam exists ────────

test("every LEDGER_STEPS row names a writer that exists in src/, a non-empty meaning, and at least one outcome", () => {
  // One concatenation of every src/ file, read once -- cheaper than a fresh grep per writer name,
  // and this suite already needs the whole tree for the "no step drifted from its family" check
  // below.
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", ".git", "coverage"].includes(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(abs);
    }
  })(join(REPO_ROOT, "src"));
  const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");

  assert.ok(LEDGER_STEPS.length > 0, "LEDGER_STEPS must not be empty -- an empty registry decodes nothing");

  for (const row of LEDGER_STEPS) {
    assert.ok(row.writer.length > 0, `${row.step}: writer must name at least one symbol`);
    for (const writer of row.writer) {
      const re = new RegExp(`\\b${writer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      assert.ok(
        re.test(corpus),
        `${row.step}: writer "${writer}" does not exist anywhere in src/ -- a renamed/deleted writer must not leave a stale claim in the registry`,
      );
    }
    assert.ok(row.outcomes.length > 0, `${row.step}: outcomes must name at least one value the writer can produce`);
    assert.ok(row.meaning.trim().length > 0, `${row.step}: meaning must not be empty`);
    assert.equal(
      row.family,
      stepFamily(row.step),
      `${row.step}: family must be derived from step via stepFamily, never hand-typed independently`,
    );
  }
});

test("meaningOfStep resolves a registered step and returns undefined for one this registry does not cover", () => {
  const known = LEDGER_STEPS[0];
  assert.deepEqual(meaningOfStep(known.step), known);
  assert.equal(meaningOfStep("never_registered.made_up_step"), undefined);
});

// ── acceptance 2: an unregistered literal added to src fails the ratchet by name ─────────────

test("ledger-steps-check: a step literal newly added to src, absent from both the registry and the baseline, fails the ratchet by name", () => {
  const dir = mkTmp("new-literal");
  try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "fixture.ts"), 'export function f() { log("fresh_thing.never_seen", {}); }\n');
    const registry = join(dir, "ledger-steps.ts");
    writeFileSync(registry, 'export const LEDGER_STEPS = [{ step: "already.registered" }];\n');
    const baseline = join(dir, "baseline.json");
    writeFileSync(baseline, "[]\n");

    const result = runCheck(["--cwd", dir, "--dir", "src", "--baseline", baseline, "--registry", "ledger-steps.ts"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /FAILED/);
    assert.match(result.stdout + result.stderr, /fresh_thing\.never_seen/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger-steps-check: the same literal passes once it is registered, and separately once it is baselined with a reason", () => {
  const dir = mkTmp("resolve");
  try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "fixture.ts"), 'export function f() { log("fresh_thing.never_seen", {}); }\n');
    const registry = join(dir, "ledger-steps.ts");
    const emptyBaseline = join(dir, "baseline-empty.json");
    writeFileSync(emptyBaseline, "[]\n");

    writeFileSync(registry, 'export const LEDGER_STEPS = [{ step: "fresh_thing.never_seen" }];\n');
    const registered = runCheck(["--cwd", dir, "--dir", "src", "--baseline", emptyBaseline, "--registry", "ledger-steps.ts"]);
    assert.equal(registered.status, 0, registered.stdout + registered.stderr);

    writeFileSync(registry, 'export const LEDGER_STEPS = [];\n');
    const baselinePath = join(dir, "baseline-filled.json");
    writeFileSync(
      baselinePath,
      JSON.stringify([{ step: "fresh_thing.never_seen", reason: "exercised only by this fixture" }]),
    );
    const baselined = runCheck(["--cwd", dir, "--dir", "src", "--baseline", baselinePath, "--registry", "ledger-steps.ts"]);
    assert.equal(baselined.status, 0, baselined.stdout + baselined.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger-steps-check: a baseline entry with no written reason is REJECTED, not silently accepted", () => {
  const dir = mkTmp("no-reason");
  try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "fixture.ts"), "export function f() {}\n");
    const registry = join(dir, "ledger-steps.ts");
    writeFileSync(registry, "export const LEDGER_STEPS = [];\n");
    const baseline = join(dir, "baseline.json");
    writeFileSync(baseline, JSON.stringify([{ step: "some.step" }]));

    const result = runCheck(["--cwd", dir, "--dir", "src", "--baseline", baseline, "--registry", "ledger-steps.ts"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /NO WRITTEN REASON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger-steps-check: the REAL committed registry + baseline currently resolve every step literal under src/ (this is what CI runs via `npm run ledger-steps:check`)", () => {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ledger-steps-check: OK/);
});

test("ledger-steps-check: every step registered in the real registry is actually found among the real baseline+registry's own literal population (no dead row)", () => {
  // Not a correctness requirement on its own (a row MAY describe a step the static census cannot
  // see, e.g. one logged via a named constant -- src/lib/ledger-steps.ts documents
  // panel.risk_override_recorded as exactly that case) -- this only proves the check script's
  // registry-literal scan finds every row's own `step` text, i.e. LEDGER_STEPS and the check's
  // reading of it never disagree on what a row's step IS.
  const registryText = readFileSync(REAL_REGISTRY, "utf8");
  for (const row of LEDGER_STEPS) {
    assert.ok(registryText.includes(`step: "${row.step}"`), `registry text must literally carry step: "${row.step}"`);
  }
});

test("ledger-steps-baseline.json: every entry carries a distinct step and a non-empty reason (the file the ratchet's own loader enforces)", () => {
  const doc = JSON.parse(readFileSync(REAL_BASELINE, "utf8"));
  assert.ok(Array.isArray(doc));
  const seen = new Set<string>();
  for (const entry of doc) {
    assert.equal(typeof entry.step, "string");
    assert.ok(entry.reason.trim().length > 0, `${entry.step}: reason must not be empty`);
    assert.ok(!seen.has(entry.step), `${entry.step}: listed more than once`);
    seen.add(entry.step);
    assert.ok(
      !LEDGER_STEPS.some((r) => r.step === entry.step),
      `${entry.step}: baselined AND registered -- register wins, drop the baseline entry`,
    );
  }
});

// ── acceptance 3: the generated page and the registry cannot drift ───────────────────────────

test("generate-ledger-steps: two independent regenerations are byte-identical (content-only, no timestamp)", () => {
  const dir = mkTmp("roundtrip");
  try {
    const outA = join(dir, "a.md");
    const outB = join(dir, "b.md");
    const genA = runGenerate(["--out", outA]);
    const genB = runGenerate(["--out", outB]);
    assert.equal(genA.status, 0, genA.stdout + genA.stderr);
    assert.equal(genB.status, 0, genB.stdout + genB.stderr);
    assert.equal(readFileSync(outA, "utf8"), readFileSync(outB, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-ledger-steps: every LEDGER_STEPS row's step/meaning/writer/outcomes appear verbatim in the generated doc", () => {
  const dir = mkTmp("coverage");
  try {
    const out = join(dir, "ledger-steps.md");
    const gen = runGenerate(["--out", out]);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const rendered = readFileSync(out, "utf8");
    for (const row of LEDGER_STEPS) {
      assert.ok(rendered.includes(`\`${row.step}\``), `generated page is missing a heading for ${row.step}`);
      assert.ok(rendered.includes(row.meaning), `generated page is missing ${row.step}'s full meaning text`);
      for (const writer of row.writer) {
        assert.ok(rendered.includes(writer), `generated page is missing ${row.step}'s writer "${writer}"`);
      }
      for (const outcome of row.outcomes) {
        assert.ok(rendered.includes(outcome), `generated page is missing ${row.step}'s outcome "${outcome}"`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-ledger-steps --check: the REAL committed docs/ledger-steps.md is NOT stale (this is what CI byte-compares on every PR via `npm test`)", () => {
  const result = runGenerate(["--check", "--out", join(REPO_ROOT, "docs", "ledger-steps.md")]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK -- .*ledger-steps\.md matches the current LEDGER_STEPS registry/);
});

test("generate-ledger-steps --check: a STALE committed file (hand-edited, deliberately wrong) -> non-zero exit, names the fix", () => {
  const dir = mkTmp("stale");
  try {
    const out = join(dir, "ledger-steps.md");
    writeFileSync(out, "# not what the generator would produce\n");
    const result = runGenerate(["--check", "--out", out]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /is STALE/);
    assert.match(result.stdout + result.stderr, /npm run ledger-steps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the one caller this task wires: `rmd ledger-grep` prints a registered meaning ───────────

test("ledgerGrepCommand: prints a registered step's meaning beside a matched row, and prints an unregistered row unchanged", async () => {
  const { stepFromRawLedgerLine } = await import("../src/run-task.js");
  const registeredStep = LEDGER_STEPS[0].step;
  const registeredLine = JSON.stringify({ run_id: "r", task_id: "t", step: registeredStep });
  assert.equal(stepFromRawLedgerLine(registeredLine), registeredStep);
  assert.deepEqual(meaningOfStep(stepFromRawLedgerLine(registeredLine)!), LEDGER_STEPS[0]);

  const unregisteredLine = JSON.stringify({ run_id: "r", task_id: "t", step: "never_registered.made_up_step" });
  assert.equal(meaningOfStep(stepFromRawLedgerLine(unregisteredLine)!), undefined);

  assert.equal(stepFromRawLedgerLine("not json at all"), undefined);
  assert.equal(stepFromRawLedgerLine(JSON.stringify({ run_id: "r" })), undefined);
});
