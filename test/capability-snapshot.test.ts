import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T383: the MASTER-PLAN.md CAPABILITY SNAPSHOT generator + drift gate ─────────────────────
//
// MASTER-PLAN's hand-written "lanes sentence" changed truth FOUR TIMES in one day
// (2026-08-05) and was still false the next morning. This suite proves the generate-cli-
// reference.mjs mold (W1-T48) closes that class of drift for a first four-claim tranche: a FRESH
// regeneration matches the committed MASTER-PLAN.md block + plan/plan-index.json byte-for-byte
// (this IS the byte-compare CI runs, via `npm test` -> the `ci` job, already a REQUIRED check,
// same discipline as test/cli-reference.test.ts / test/plan-index.test.ts); a hand edit inside
// the markers turns `--check` red and names the fix; an unresolvable claim renders
// `UNDETERMINED(<reason>)` rather than being silently dropped (LAW-1/P48).
//
// (scripts/generate-capability-snapshot.mjs is a plain .mjs file outside tsconfig's `include`
// that also imports from .ts modules, so -- mirroring test/cli-reference.test.ts's convention for
// scripts/generate-cli-reference.mjs -- it is exercised here only via `spawnSync` against its CLI
// surface, run under `node --import tsx` the same way `npm run capability-snapshot` /
// `capability-snapshot:check` invoke it via the `tsx` bin.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-capability-snapshot.mjs");

const CLAIM_LABELS = ["Daemon dispatch lanes", "Daily cost ceiling", "Recon turn cap", "ci-gate REQUIRED checks"];

// A minimal fixture carrying the markers this generator owns, plus a second heading so
// plan-index co-regeneration (design note ii) has something to shift.
const FIXTURE_MASTER_PLAN = `# Title

## NET STATE

### CAPABILITY SNAPSHOT

<!-- CAPABILITY SNAPSHOT:BEGIN -->
placeholder
<!-- CAPABILITY SNAPSHOT:END -->

Some hand-written prose about NET STATE.

## Other Section

More prose under the other section.
`;

function run(args: string[], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function extractBlock(masterPlanText: string) {
  const begin = masterPlanText.indexOf("<!-- CAPABILITY SNAPSHOT:BEGIN -->");
  const end = masterPlanText.indexOf("<!-- CAPABILITY SNAPSHOT:END -->");
  return masterPlanText.slice(begin, end);
}

test("generate-capability-snapshot: two independent regenerations are byte-identical (content-only, no timestamp)", () => {
  // cwd stays REPO_ROOT (both `--import tsx` and the four claim resolvers need it) -- only the
  // --master-plan/--plan-index OUTPUT paths differ between the two runs, which means plan-
  // index.json's embedded `source` field (the exact --master-plan string) legitimately differs
  // too; that is the same input-echoing behavior generate-plan-index.mjs's own `--source` already
  // has; it is compared separately from (and excluded from) the byte-identity check below, whose
  // job is proving the two runs' CONTENT -- MASTER-PLAN.md verbatim, plan-index.json's `entries`
  // -- agree, not that two different file paths render as the same string.
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-roundtrip-"));
  try {
    const mpA = join(dir, "a.md");
    const idxA = join(dir, "a-index.json");
    const mpB = join(dir, "b.md");
    const idxB = join(dir, "b-index.json");
    writeFileSync(mpA, FIXTURE_MASTER_PLAN);
    writeFileSync(mpB, FIXTURE_MASTER_PLAN);
    const genA = run(["--master-plan", mpA, "--plan-index", idxA]);
    const genB = run(["--master-plan", mpB, "--plan-index", idxB]);
    assert.equal(genA.status, 0, genA.stdout + genA.stderr);
    assert.equal(genB.status, 0, genB.stdout + genB.stderr);
    assert.equal(readFileSync(mpA, "utf8"), readFileSync(mpB, "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(idxA, "utf8")).entries, JSON.parse(readFileSync(idxB, "utf8")).entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot: the generated block carries exactly the four registered claims, each resolved (no UNDETERMINED against the real repo's own sources)", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-claims-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    const idx = join(dir, "plan-index.json");
    writeFileSync(mp, FIXTURE_MASTER_PLAN);
    const gen = run(["--master-plan", mp, "--plan-index", idx]);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const block = extractBlock(readFileSync(mp, "utf8"));
    for (const label of CLAIM_LABELS) {
      assert.ok(block.includes(`**${label}**`), `generated block is missing the '${label}' claim line:\n${block}`);
    }
    assert.ok(!block.includes("UNDETERMINED"), `unexpected UNDETERMINED against the real repo's own sources:\n${block}`);
    const lines = block.split("\n").filter((l) => l.trim().startsWith("- **"));
    assert.equal(lines.length, CLAIM_LABELS.length, `expected one line per registered claim:\n${block}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot: regenerating the block shifts later section line numbers, and plan/plan-index.json is co-regenerated to match (design note ii)", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-index-coregen-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    const idx = join(dir, "plan-index.json");
    writeFileSync(mp, FIXTURE_MASTER_PLAN);
    const gen = run(["--master-plan", mp, "--plan-index", idx]);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);

    const masterPlanLines = readFileSync(mp, "utf8").split("\n");
    const expectedLine = masterPlanLines.findIndex((l) => l === "## Other Section") + 1;
    assert.ok(expectedLine > 0, "fixture setup: expected an '## Other Section' heading to exist");

    const writtenIndex = JSON.parse(readFileSync(idx, "utf8"));
    const otherSection = writtenIndex.entries.find((e: { heading: string }) => e.heading === "Other Section");
    assert.ok(otherSection, "plan-index.json is missing the 'Other Section' entry");
    assert.equal(otherSection.line, expectedLine, "plan-index.json's line number was not co-regenerated with the block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot: an unresolvable claim renders UNDETERMINED(<reason>) rather than being silently dropped (LAW-1/P48, design note vi falsifier)", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-undetermined-"));
  try {
    // A --root with a real plan/policy.yaml but NO .github/workflows/ci-gate.yml: the
    // dispatch-lanes, daily-cost-ceiling and recon-turn-cap claims resolve normally; ONLY the
    // ci-gate REQUIRED-roster claim's source file is absent, so ONLY that resolver throws.
    mkdirSync(join(dir, "plan"), { recursive: true });
    writeFileSync(join(dir, "plan", "policy.yaml"), readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8"));
    const mp = join(dir, "MASTER-PLAN.md");
    const idx = join(dir, "plan-index.json");
    writeFileSync(mp, FIXTURE_MASTER_PLAN);

    const result = run(["--root", dir, "--master-plan", mp, "--plan-index", idx]);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const block = extractBlock(readFileSync(mp, "utf8"));
    assert.match(block, /\*\*ci-gate REQUIRED checks\*\*: UNDETERMINED\(/);
    for (const label of ["Daemon dispatch lanes", "Daily cost ceiling", "Recon turn cap"]) {
      assert.ok(!block.includes(`**${label}**: UNDETERMINED`), `expected '${label}' to resolve normally, got:\n${block}`);
    }
    // No claim's line vanished: count parity holds even with one UNDETERMINED among the four.
    const lines = block.split("\n").filter((l) => l.trim().startsWith("- **"));
    assert.equal(lines.length, CLAIM_LABELS.length, block);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot: a MASTER-PLAN.md with no BEGIN/END markers -> non-zero exit, names the missing markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-no-markers-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    writeFileSync(mp, "# Title\n\n## NET STATE\n\nNo markers here at all.\n");
    const result = run(["--master-plan", mp, "--plan-index", join(dir, "plan-index.json")]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is missing the/);
    assert.match(output, /CAPABILITY SNAPSHOT:BEGIN/);
    assert.match(output, /CAPABILITY SNAPSHOT:END/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot --check: a hand edit INSIDE the markers -> non-zero exit, names the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-stale-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    const idx = join(dir, "plan-index.json");
    writeFileSync(mp, FIXTURE_MASTER_PLAN);
    const gen = run(["--master-plan", mp, "--plan-index", idx]);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);

    const original = readFileSync(mp, "utf8");
    const tampered = original.replace("Daemon dispatch lanes", "HAND-EDITED DRIFT");
    assert.notEqual(tampered, original, "fixture setup: the dispatch-lanes claim line must actually exist to tamper");
    writeFileSync(mp, tampered);

    const result = run(["--check", "--master-plan", mp, "--plan-index", idx]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /npm run capability-snapshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot --check: a MISSING MASTER-PLAN.md -> non-zero exit, tells the operator how to generate it", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-missing-"));
  try {
    const result = run([
      "--check",
      "--master-plan",
      join(dir, "does-not-exist.md"),
      "--plan-index",
      join(dir, "plan-index.json"),
    ]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-capability-snapshot --check: the REAL committed MASTER-PLAN.md block and plan/plan-index.json are NOT stale (this is what CI checks on every PR via `npm test`)", () => {
  const result = run(["--check"]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- MASTER-PLAN\.md and plan\/plan-index\.json match a fresh regeneration/);
});

test("the REAL committed MASTER-PLAN.md carries the CAPABILITY SNAPSHOT block, and the generated block replaced the hand-written lane-count literals it used to carry", () => {
  const text = readFileSync(join(REPO_ROOT, "MASTER-PLAN.md"), "utf8");
  assert.match(text, /### CAPABILITY SNAPSHOT/);
  assert.match(text, /<!-- CAPABILITY SNAPSHOT:BEGIN -->/);
  assert.match(text, /<!-- CAPABILITY SNAPSHOT:END -->/);
  for (const label of CLAIM_LABELS) {
    assert.ok(text.includes(`**${label}**`), `MASTER-PLAN.md is missing the '${label}' claim line`);
  }
  // The hand-prose seam (design note v): the surrounding NET STATE narrative no longer asserts
  // the lane count as a bare present-tense literal -- it points at the generated block instead.
  assert.ok(!text.includes("`sweep.dispatchLanes` flipped 1 → 2"));
  assert.ok(!text.includes("`sweep.dispatchLanes` is 2 (T344)"));
});

// ── Failure arms ──────────────────────────────────────────────────────────────────────────────
//
// The tests above prove the happy paths. Every arm below is a guard that only fires on bad input,
// and each was flagged by diff-coverage as an added source line with zero covering tests. They are
// driven through `spawnSync` like the rest of this suite (the script is a plain .mjs outside
// tsconfig's include that imports .ts modules), and each asserts the MESSAGE the guard emits, not
// merely that the exit code moved -- a guard whose text is wrong is a guard nobody can act on.

/** A synthetic --root carrying only a crafted ci-gate.yml. The other three claim resolvers read
 *  the real repo, so under this root they render UNDETERMINED -- one line each, which keeps the
 *  claim-count parity check satisfied and isolates the ci-gate resolver's own arms. */
function rootWithCiGate(dir: string, ciGateYaml: string): string {
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci-gate.yml"), ciGateYaml);
  return dir;
}

function generateInto(dir: string, rootArgs: string[]) {
  const mp = join(dir, "MASTER-PLAN.md");
  const idx = join(dir, "plan-index.json");
  writeFileSync(mp, FIXTURE_MASTER_PLAN);
  return { mp, idx, res: run([...rootArgs, "--master-plan", mp, "--plan-index", idx]) };
}

test("ci-gate claim: a ci-gate.yml with no jobs.ci-gate.env.REQUIRED string renders UNDETERMINED naming that key, never a silent omission", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-noreq-"));
  try {
    rootWithCiGate(dir, "name: CI gate\njobs:\n  ci-gate:\n    env: {}\n");
    const { mp, res } = generateInto(dir, ["--root", dir]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const block = extractBlock(readFileSync(mp, "utf8"));
    assert.match(block, /has no jobs\.ci-gate\.env\.REQUIRED string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci-gate claim: a REQUIRED that is not JSON renders UNDETERMINED naming the parse failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-badjson-"));
  try {
    rootWithCiGate(dir, "name: CI gate\njobs:\n  ci-gate:\n    env:\n      REQUIRED: 'not json at all'\n");
    const { mp, res } = generateInto(dir, ["--root", dir]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(extractBlock(readFileSync(mp, "utf8")), /did not parse as JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci-gate claim: a REQUIRED that parses to JSON but not to a string array renders UNDETERMINED naming that", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-notstrings-"));
  try {
    rootWithCiGate(dir, "name: CI gate\njobs:\n  ci-gate:\n    env:\n      REQUIRED: '[1, 2, 3]'\n");
    const { mp, res } = generateInto(dir, ["--root", dir]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(extractBlock(readFileSync(mp, "utf8")), /did not parse to a string array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: a resolved value spanning two lines trips the claim-count parity guard and exits non-zero — a silently dropped claim is refused", () => {
  // The parity guard's whole purpose: one rendered line per registered claim. A REQUIRED entry
  // carrying an embedded newline makes one claim render TWO lines, which is the only way the
  // block's line count can disagree with CLAIMS.length from outside the module.
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-parity-"));
  try {
    rootWithCiGate(dir, 'name: CI gate\njobs:\n  ci-gate:\n    env:\n      REQUIRED: \'["first\\nsecond"]\'\n');
    const { res } = generateInto(dir, ["--root", dir]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /capability line\(s\) but .* claim\(s\) are registered/);
    assert.match(res.stderr, /a claim was silently dropped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: a master plan carrying TWO marker pairs is refused, naming the counts rather than splicing the wrong one", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-dupemarkers-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    writeFileSync(mp, `${FIXTURE_MASTER_PLAN}\n${FIXTURE_MASTER_PLAN}`);
    const res = run(["--master-plan", mp, "--plan-index", join(dir, "plan-index.json")]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /must carry exactly one BEGIN\/END marker pair, found 2\/2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: an END marker preceding its BEGIN is refused rather than slicing a negative range", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-reversed-"));
  try {
    const mp = join(dir, "MASTER-PLAN.md");
    writeFileSync(mp, "# Title\n\n<!-- CAPABILITY SNAPSHOT:END -->\n\n<!-- CAPABILITY SNAPSHOT:BEGIN -->\n");
    const res = run(["--master-plan", mp, "--plan-index", join(dir, "plan-index.json")]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /END marker precedes its BEGIN marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: an ABSENT plan index is red and names the command that creates it, never silently green", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-noindex-"));
  try {
    const { mp, idx, res: gen } = generateInto(dir, []);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    rmSync(idx, { force: true });
    const res = run(["--master-plan", mp, "--plan-index", idx, "--check"]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /does not exist -- run 'npm run capability-snapshot'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: a STALE plan index is red and names it as stale relative to a fresh regeneration", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-snapshot-staleindex-"));
  try {
    const { mp, idx, res: gen } = generateInto(dir, []);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    // A committed index that parses but no longer matches what a fresh run would emit.
    writeFileSync(idx, JSON.stringify({ source: "MASTER-PLAN.md", entries: [] }, null, 2));
    const res = run(["--master-plan", mp, "--plan-index", idx, "--check"]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /is STALE relative to a fresh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
