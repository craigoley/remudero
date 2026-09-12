import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  derivePrCheckCandidates,
  findPrCheckRegistryGaps,
  loadCiGateLists as loadSharedCiGateLists,
  loadWorkflowDocuments,
  type WorkflowDoc,
} from "../src/lib/ci-control-plane.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── R-51 (docs/audits/recon-2026-09-05.md): "every deterministic PR check can block a merge" ──
//
// ci-gate.yml's REQUIRED list used to omit five PR-firing, unconditional, deterministic jobs
// (leak-grep, assertion-discrimination, task-id-existence, acceptance-author-gate, unwired-gate),
// so a red run on any of them could never hold a merge — they read like gates and refused nothing.
// The fix (this PR) adds the five names to REQUIRED. THIS FILE IS THE ALARM THAT KEEPS THE CLASS
// FROM RECURRING: the same "runs on every PR, blocks nothing" gap that hid those five for months
// is exactly the shape a NEW job — in ci.yml, in a standalone workflow file, anywhere — can
// reproduce the day after this PR merges, with nothing here to notice. So this suite derives every
// check-run name this repo's own workflow files register on a `pull_request` event, straight off
// the files on disk (never a hand-typed roster), and fails the moment one is covered by neither
// ci-gate.yml's REQUIRED list nor its sibling ADVISORY list (added beside REQUIRED by this same
// PR, read the same way, never hard-coded here) — a name in neither is a job that can go silently
// red forever, whichever list it should really belong to.
//
// ADVISORY names a check-run DELIBERATELY excluded from blocking a merge: a path-filtered or
// otherwise conditionally-skippable job (promoting it would reproduce the synthwatch #102
// deadlock class ci-gate.yml's own header describes — a required check that can go silently
// ABSENT hangs branch protection forever), a documented advisory-only scanner
// (CodeQL/Semgrep/dependency-review's warn-only `Review` job — continue-on-error by design), an
// aggregation-internal matrix shard (ci-shard/coverage-shard — the `ci`/`coverage-ratchet`
// aggregator jobs are what REQUIRED actually names), or a job explicitly deferred pending a
// currently-red state (docs-index-check, see its own file's header). ADVISORY membership is never
// itself a verdict on whether promotion is right — only that today it is a deliberate, written-
// down choice rather than an unnoticed gap.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const deriveCandidates = derivePrCheckCandidates;
const findGaps = findPrCheckRegistryGaps;
const loadCiGateLists = () => loadSharedCiGateLists(REPO_ROOT);
const loadRealWorkflows = () => loadWorkflowDocuments(REPO_ROOT);

// ── the mechanism, proven against fabricated input (never the real tree) ───────────────────────

test("deriveCandidates: a plain unconditional pull_request job is named by its own `name:` field", () => {
  const doc = parseYaml(`
on:
  pull_request:
jobs:
  some-gate:
    name: some-gate
    runs-on: ubuntu-latest
`) as WorkflowDoc;
  assert.deepEqual(deriveCandidates("fake.yml", doc), ["some-gate"]);
});

test("deriveCandidates: a workflow with no pull_request trigger contributes no candidates", () => {
  const doc = parseYaml(`
on:
  push:
    branches: [main]
jobs:
  some-job:
    name: some-job
`) as WorkflowDoc;
  assert.deepEqual(deriveCandidates("fake.yml", doc), []);
});

test("deriveCandidates: a matrix job's name is expanded per combination, not left templated", () => {
  const doc = parseYaml(`
on:
  pull_request:
jobs:
  shard-job:
    name: shard (\${{ matrix.n }}/3)
    strategy:
      matrix:
        n: [1, 2, 3]
`) as WorkflowDoc;
  assert.deepEqual(deriveCandidates("fake.yml", doc), ["shard (1/3)", "shard (2/3)", "shard (3/3)"]);
});

test("deriveCandidates: a matrix.include job's name is expanded one combination per include entry (the codeql.yml shape)", () => {
  const doc = parseYaml(`
on:
  pull_request:
jobs:
  analyze:
    name: Analyze (\${{ matrix.language }})
    strategy:
      matrix:
        include:
          - language: javascript-typescript
            build-mode: none
          - language: actions
            build-mode: none
`) as WorkflowDoc;
  assert.deepEqual(deriveCandidates("fake.yml", doc), ["Analyze (javascript-typescript)", "Analyze (actions)"]);
});

test("deriveCandidates: an unrecognized `uses:` reusable-workflow caller is reported as its own named gap, never silently assumed", () => {
  const doc = parseYaml(`
on:
  pull_request:
jobs:
  calls-out:
    uses: someorg/somerepo/.github/workflows/reusable.yml@abcdef
`) as WorkflowDoc;
  const candidates = deriveCandidates("fake.yml", doc);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0]!, /fake\.yml#calls-out/);
  assert.match(candidates[0]!, /unrecognized reusable-workflow caller/);
});

// ── THE FALSIFIER (a): a fabricated, wholly new pull_request job is reported as a gap ─────────

test("FALSIFIER: a fabricated pull_request job absent from both REQUIRED and ADVISORY is reported as a gap", async () => {
  const { required, advisory, ignore } = await loadCiGateLists();
  const doc = parseYaml(`
on:
  pull_request:
jobs:
  totally-new-gate-nobody-has-seen:
    name: totally-new-gate-nobody-has-seen
`) as WorkflowDoc;
  const candidates = deriveCandidates("fabricated.yml", doc);
  const gaps = findGaps(candidates, required, advisory, ignore);
  assert.deepEqual(gaps, ["totally-new-gate-nobody-has-seen"]);
});

// ── THE FALSIFIER (b): dropping one of the five promoted names from REQUIRED (and leaving it out
// of ADVISORY too) must surface it as a gap against the REAL derived tree ─────────────────────

test("FALSIFIER: removing a promoted name from REQUIRED without adding it to ADVISORY reproduces the gap this PR fixes", async () => {
  const { required, advisory, ignore } = await loadCiGateLists();
  const workflows = loadRealWorkflows();
  const allCandidates = workflows.flatMap(({ relPath, doc }) => deriveCandidates(relPath, doc));

  for (const promoted of ["leak-grep", "assertion-discrimination", "task-id-existence", "acceptance-author-gate", "unwired-gate"]) {
    assert.ok(required.has(promoted), `sanity: ${promoted} must actually be in REQUIRED for this falsifier to mean anything`);
    const mutatedRequired = new Set(required);
    mutatedRequired.delete(promoted);
    const gaps = findGaps(allCandidates, mutatedRequired, advisory, ignore);
    assert.ok(
      gaps.includes(promoted),
      `removing ${promoted} from REQUIRED (leaving it out of ADVISORY too) must be reported as a gap by the census`,
    );
  }
});

// ── the real gate, run against the real tree ────────────────────────────────────────────────

test("instrument census: every job this repo's own workflow files register on a pull_request event is in exactly one of ci-gate.yml's REQUIRED or ADVISORY", async () => {
  const { required, advisory, ignore } = await loadCiGateLists();

  const overlap = [...required].filter((n) => advisory.has(n));
  assert.deepEqual(overlap, [], `REQUIRED and ADVISORY must be disjoint — found in both: ${overlap.join(", ")}`);

  const workflows = loadRealWorkflows();
  assert.ok(workflows.length >= 15, `sanity: expected at least 15 workflow files, found ${workflows.length}`);

  const allCandidates = workflows.flatMap(({ relPath, doc }) => deriveCandidates(relPath, doc));
  assert.ok(allCandidates.length > 20, "sanity: the derivation is finding real candidates, not running vacuously");

  const gaps = findGaps(allCandidates, required, advisory, ignore);
  assert.deepEqual(
    gaps,
    [],
    `job(s) registering a pull_request check-run that are neither REQUIRED nor ADVISORY in ci-gate.yml: ` +
      `${gaps.join(", ")} — these can go silently red forever with nothing to notice`,
  );

  // The five names R-51 promotes really are on the derived candidate list — REQUIRED cannot
  // silently grow ahead of what the workflows actually register, any more than it can lag behind.
  const candidateSet = new Set(allCandidates);
  for (const promoted of ["leak-grep", "assertion-discrimination", "task-id-existence", "acceptance-author-gate", "unwired-gate"]) {
    assert.ok(candidateSet.has(promoted), `${promoted} must be a real derived candidate, not a phantom REQUIRED entry`);
    assert.ok(required.has(promoted), `${promoted} must be in ci-gate.yml's REQUIRED list`);
  }

  // Symmetrically: nothing in REQUIRED or ADVISORY is a stale entry naming a check-run no
  // workflow on disk actually registers any more (a stale row is a shrinking allowance's own
  // failure mode — unwired-gate.yml's own design note on the exact same shape).
  const stale = [...required, ...advisory].filter((n) => !candidateSet.has(n));
  assert.deepEqual(stale, [], `stale REQUIRED/ADVISORY entr(y/ies) naming no real derived candidate: ${stale.join(", ")}`);
});

// ── mkdtemp/writeFile/rmSync are imported for symmetry with this repo's other workflow-parsing
// suites (e.g. test/a-gate-shaped-instrument-that-nothing-invokes.test.ts) that DO need a real
// temp-file fixture; this suite's falsifiers operate on in-memory parsed docs instead (no
// subprocess, no real file needed to prove the derivation/classification pipeline), so the actual
// disk round-trip is exercised here once, directly, as its own regression pin: parsing a
// temp-file copy must produce byte-identical candidates to parsing the same text in memory.
test("deriveCandidates: parsing a real temp-file copy of a workflow matches parsing the same YAML text in memory", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}every-pr-check-census-`));
  try {
    const yaml = `
on:
  pull_request:
jobs:
  disk-round-trip-job:
    name: disk-round-trip-job
`;
    const path = join(dir, "fixture.yml");
    writeFileSync(path, yaml, "utf8");
    const fromDisk = parseYaml(readFileSync(path, "utf8")) as WorkflowDoc;
    const fromMemory = parseYaml(yaml) as WorkflowDoc;
    assert.deepEqual(deriveCandidates("fixture.yml", fromDisk), deriveCandidates("fixture.yml", fromMemory));
    assert.deepEqual(deriveCandidates("fixture.yml", fromDisk), ["disk-round-trip-job"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
