import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// The DEFAULT export — see synthesize.ts's own header comment for why: `t.mock.method` cannot
// intercept ESM named bindings off `node:fs` (non-configurable), so the write-scope test below
// spies on the REAL module, the same way test/onboard-synthesize.test.ts already does.
import fsDefault from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  loadLearningsCorpus,
  loadLearningsForTaskFiles,
  loadLearningsIndex,
  PROJECT_LEARNINGS_SHARD_NAMES,
  projectLearningsHome,
  seedProjectLearningsHomeFiles,
} from "../src/lib/learnings.js";
import type { Inventory } from "../src/lib/onboard/inventory.js";
import { generateOnboardQuestions, type OnboardAnswer } from "../src/lib/onboard/session.js";
import {
  realSynthesizeFsDeps,
  runOnboardSynthesize,
  type SynthesizeDraft,
  type SynthesizeDraftFn,
  type SynthesizeGhGateway,
  type SynthesizeGitGateway,
} from "../src/lib/onboard/synthesize.js";

// This repo's own committed learnings/ home — the ground truth "same shard split" claims are
// checked against, and the real generator CLI these tests shell out to, mirroring
// test/learnings-index.test.ts's own convention for exercising scripts/generate-learnings-index.mjs
// (a plain .mjs outside tsconfig's `include`) only via its CLI surface.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GENERATE_INDEX_SCRIPT = join(REPO_ROOT, "scripts", "generate-learnings-index.mjs");

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureInventory(): Inventory {
  return {
    generatedAt: "2026-07-23T00:00:00.000Z",
    target: { owner: "acme-corp", repo: "widget-fixture" },
    languages: ["typescript"],
    buildSystems: ["npm"],
    ciSystems: ["github-actions"],
    docs: { readme: true },
    testSignals: ["node:test"],
    github: { repoExists: true, defaultBranch: "main", branchProtected: true, openIssueCount: 3, milestoneCount: 1 },
  };
}

function completeAnswers(): Record<string, OnboardAnswer> {
  const questions = generateOnboardQuestions(fixtureInventory());
  return Object.fromEntries(
    questions.map((q, i) => [q.id, { id: q.id, decision: q.decision, question: q.question, answer: `fixture-answer-${i}` }]),
  );
}

function writeOnboardingArtifacts(targetDir: string): void {
  const dir = join(targetDir, "plan", "onboarding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), JSON.stringify(fixtureInventory(), null, 2));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(completeAnswers(), null, 2));
  writeFileSync(join(dir, "candidates.json"), "[]");
  writeFileSync(join(dir, "findings.md"), "");
}

const CLEAN_TASKS_YAML = `
- id: T-1
  title: "Ship the widget catalog search"
  repo: widget-fixture
  type: implement
  verify: auto
  risk: medium
  origin: "onboard:elicit-priorities"
  files: [src/catalog/search.ts]
  acceptance:
    - claim: "the widget catalog search ships"
      proof: "unit test: widget catalog search returns results"
`.trim();

function cleanDraft(): SynthesizeDraft {
  return {
    masterPlan: "# MASTER-PLAN.md\n\nMission: ship the widget catalog.\n",
    tasksYaml: CLEAN_TASKS_YAML,
    agentsMd: "# AGENTS.md\n\nFollow the conventions found in this repo.\n",
  };
}

const CLEAN_DRAFT_FN: SynthesizeDraftFn = async () => cleanDraft();

function recordingGit(): SynthesizeGitGateway {
  return { exec: () => "" };
}

function recordingGh(prUrl = "https://github.com/acme-corp/widget-fixture/pull/1"): SynthesizeGhGateway {
  return { openPr: () => prUrl };
}

/** Run the full happy-path synthesize flow against a fresh fixture target dir, returning the
 *  result plus the target dir it ran in. Every claim below exercises this same real flow —
 *  never a hand-rolled seed — so the tests prove what `runOnboardSynthesize` actually does. */
async function runSynthesizeFixture(targetDir: string) {
  writeOnboardingArtifacts(targetDir);
  return runOnboardSynthesize(targetDir, {
    fs: realSynthesizeFsDeps,
    git: recordingGit(),
    gh: recordingGh(),
    draft: CLEAN_DRAFT_FN,
  });
}

// ── Acceptance 1: synthesize creates a learnings home in the target repo ──────────────────

test("acceptance 1: runOnboardSynthesize creates <target-dir>/learnings/, matching projectLearningsHome", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-home-created-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  assert.equal(learningsDir, join(targetDir, "learnings"));
  assert.ok(fsDefault.existsSync(learningsDir), "the learnings home directory must exist after synthesize");
  const written = readdirSync(learningsDir).sort();
  assert.deepEqual(written, Object.keys(seedProjectLearningsHomeFiles()).sort());
});

// ── Acceptance 2: the seeded home carries the same shard split this repo's corpus uses ────

test("acceptance 2: the seeded shard names are exactly this repo's own committed learnings/*.yaml basenames", () => {
  const realShardNames = readdirSync(join(REPO_ROOT, "learnings"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
  assert.deepEqual([...PROJECT_LEARNINGS_SHARD_NAMES].sort(), realShardNames);
});

test("acceptance 2: the seeded home writes exactly those shard files (plus index.json) into the target repo", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-shard-split-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  const expected = [...PROJECT_LEARNINGS_SHARD_NAMES.map((n) => `${n}.yaml`), "index.json"].sort();
  assert.deepEqual(readdirSync(learningsDir).sort(), expected);
});

// ── Acceptance 3: the seeded home contains no invented learning entry ─────────────────────

test("acceptance 3: loadLearningsCorpus over the freshly seeded home returns zero entries", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-no-invented-entry-");
  await runSynthesizeFixture(targetDir);

  const entries = loadLearningsCorpus(projectLearningsHome(targetDir));
  assert.deepEqual(entries, [], "onboarding seeds a HOME, never a fact — an onboarded repo has zero learnings entries");
});

test("acceptance 3: every seeded shard file parses to an empty YAML list", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-shards-are-empty-lists-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  for (const name of PROJECT_LEARNINGS_SHARD_NAMES) {
    const text = readFileSync(join(learningsDir, `${name}.yaml`), "utf8");
    assert.match(text.trim(), /\[\]\s*$/, `${name}.yaml must end in an empty list, carrying no invented entry`);
  }
});

// ── Acceptance 4: the existing corpus loader reads the seeded home without change ─────────

test("acceptance 4: loadLearningsForTaskFiles over the seeded home does not throw and yields nothing to inject", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-loader-unchanged-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  assert.doesNotThrow(() => loadLearningsForTaskFiles(learningsDir, undefined));
  assert.deepEqual(loadLearningsForTaskFiles(learningsDir, undefined), []);
  assert.deepEqual(loadLearningsForTaskFiles(learningsDir, ["src/anything.ts"]), []);
});

test("acceptance 4: loadLearningsIndex parses the seeded index.json, and it is already fresh per the real generator's own --check", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-index-fresh-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  const index = loadLearningsIndex(join(learningsDir, "index.json"));
  assert.ok(index, "the seeded index.json must parse");
  assert.deepEqual(Object.keys(index!.files).sort(), PROJECT_LEARNINGS_SHARD_NAMES.map((n) => `${n}.yaml`).sort());
  for (const shard of Object.values(index!.files)) assert.deepEqual(shard, { entries: [], globs: [] });
  assert.deepEqual(index!.bySubsystem, {});

  // The SAME check `npm run learnings-index:check` runs against this repo's own committed
  // index, run here against the freshly seeded target — proves the index this task writes is
  // not merely well-formed but byte-identical to what the real generator would produce today.
  const result = spawnSync(process.execPath, [GENERATE_INDEX_SCRIPT, "--dir", learningsDir, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ── Acceptance 5: the three files synthesize wrote before are written unchanged ───────────

test("acceptance 5: MASTER-PLAN.md, plan/tasks.yaml and AGENTS.md still carry exactly the drafted content", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-three-files-unchanged-");
  const result = await runSynthesizeFixture(targetDir);
  const draft = cleanDraft();

  assert.equal(readFileSync(result.masterPlanPath, "utf8"), draft.masterPlan);
  assert.equal(readFileSync(result.tasksYamlPath, "utf8"), draft.tasksYaml);
  assert.equal(readFileSync(result.agentsMdPath, "utf8"), draft.agentsMd);
  assert.equal(result.masterPlanPath, join(targetDir, "MASTER-PLAN.md"));
  assert.equal(result.tasksYamlPath, join(targetDir, "plan", "tasks.yaml"));
  assert.equal(result.agentsMdPath, join(targetDir, "AGENTS.md"));
});

// ── Acceptance 6: no path outside the declared write scope is written ─────────────────────

test("acceptance 6: every write/rename lands under exactly the three drafted files or the seeded learnings home, nothing else", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-learnings-write-scope-");
  writeOnboardingArtifacts(targetDir);
  const onboardingPrefix = join(targetDir, "plan", "onboarding");

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");

  const result = await runOnboardSynthesize(targetDir, {
    fs: realSynthesizeFsDeps,
    git: recordingGit(),
    gh: recordingGh(),
    draft: CLEAN_DRAFT_FN,
  });

  const learningsDir = projectLearningsHome(targetDir);
  const expectedRenamed = [
    result.masterPlanPath,
    result.tasksYamlPath,
    result.agentsMdPath,
    ...Object.keys(seedProjectLearningsHomeFiles()).map((f) => join(learningsDir, f)),
  ].sort();

  const renameTargets = renameSpy.mock.calls.map((c) => c.arguments[1] as string).sort();
  assert.deepEqual(renameTargets, expectedRenamed, "no path outside the declared write scope is ever renamed into place");

  for (const target of [...writeSpy.mock.calls.map((c) => c.arguments[0] as string), ...renameTargets]) {
    assert.ok(target.startsWith(targetDir), `"${target}" must live under the target dir`);
    assert.ok(!target.startsWith(onboardingPrefix), `"${target}" must never land under plan/onboarding/`);
  }
});

// ── Acceptance 7: a target repo that already has a learnings home is left untouched ───────

test("acceptance 7: a pre-existing learnings/ home is left byte-for-byte untouched, and no seed file is added to it", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-learnings-preexisting-untouched-");
  const learningsDir = join(targetDir, "learnings");
  mkdirSync(learningsDir, { recursive: true });
  const sentinel = "# a real, hand-authored shard — must survive synthesize untouched\n- id: sentinel\n  fact: x\n";
  writeFileSync(join(learningsDir, "custom.yaml"), sentinel);

  writeOnboardingArtifacts(targetDir);
  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");

  await runOnboardSynthesize(targetDir, {
    fs: realSynthesizeFsDeps,
    git: recordingGit(),
    gh: recordingGh(),
    draft: CLEAN_DRAFT_FN,
  });

  assert.deepEqual(readdirSync(learningsDir), ["custom.yaml"], "no shard/index seed file is added to an existing home");
  assert.equal(readFileSync(join(learningsDir, "custom.yaml"), "utf8"), sentinel, "the pre-existing shard's content is untouched");

  const touchedLearnings = [
    ...writeSpy.mock.calls.map((c) => c.arguments[0] as string),
    ...renameSpy.mock.calls.map((c) => c.arguments[1] as string),
  ].filter((p) => p.startsWith(learningsDir));
  assert.deepEqual(touchedLearnings, [], "the seeding step never writes/renames anything once a learnings/ home already exists");
});

// ── Acceptance 8: removing the seed leaves the corpus loader with no directory to read ────

test("acceptance 8: deleting the seeded home returns the corpus loader to its no-directory-yet state", async () => {
  const targetDir = tmpRoot("rmd-onboard-learnings-removed-seed-");
  await runSynthesizeFixture(targetDir);

  const learningsDir = projectLearningsHome(targetDir);
  assert.notDeepEqual(readdirSync(learningsDir), [], "sanity: the seed actually wrote something first");

  rmSync(learningsDir, { recursive: true, force: true });

  assert.equal(fsDefault.existsSync(learningsDir), false);
  assert.deepEqual(loadLearningsCorpus(learningsDir), [], "same missing-directory convention as a repo onboarding never reached");
  assert.deepEqual(loadLearningsForTaskFiles(learningsDir, undefined), []);
});
