import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GARDEN_FILING_ESCALATE_AT, freshMergedPlanLint, freshMergedPlanLintAsync, gardenStatePath, lintMergedPlanChange, runGarden, runGardenAsync, type GardenAction, type GardenSpec, type GardenerDeps } from "../src/lib/gardener.js";
import { makeTempDir, RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const task = (id: string, extra = "") => `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n${extra}`;
const SHARD = "plan/tasks.d/W1-T1-a.yaml";
const BASE = { [SHARD]: task("W1-T1", "  priority: 2\n") };

test("W1-T5457: a change that parses alone but duplicates a key against fresh main is refused", () => {
  // The change parses alone; layered on main's record it carries `priority` twice.
  const changes = { [SHARD]: task("W1-T1", "  priority: 2\n  priority: 3\n") };
  const refused = lintMergedPlanChange({ base: BASE, changes });
  assert.equal(refused?.file, SHARD);
  assert.match(refused?.message ?? "", /priority|duplicate/i);
  const twin = lintMergedPlanChange({ base: BASE, changes: { "plan/tasks.d/W1-T2-b.yaml": task("W1-T1") } });
  assert.match(twin?.message ?? "", /duplicate task id 'W1-T1'/);
});

test("W1-T5457: a clean change lands unchanged", () => {
  const changes = { "plan/tasks.d/W1-T2-b.yaml": task("W1-T2") };
  assert.equal(lintMergedPlanChange({ base: BASE, changes }), undefined);
  assert.equal(lintMergedPlanChange({ base: BASE, changes: { [SHARD]: task("W1-T1", "  priority: 1\n") } }), undefined);
});

function harness(t: { after: (fn: () => void) => void }, lint: GardenerDeps["mergedPlanLint"]) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}landing-lint-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"));
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const landed: string[] = [];
  const spec: GardenSpec<"a", null, GardenAction<"a">, { root: string; land: () => string; dispose: () => void }> = {
    name: "probe",
    classes: ["a"],
    cheapFingerprint: () => "c",
    inventory: () => null,
    fingerprint: () => "f",
    candidates: () => [{ class: "a", target: "t", reason: "r" }],
    scorecard: () => ({}),
    apply: () => ({ paths: [SHARD], title: "chore(plan): t", body: "b" }),
  };
  const deps = {
    stateDir: join(dir, "state"),
    repoRoot: dir,
    seed: 1,
    openWorkspace: () => ({ root: dir, land: () => (landed.push("x"), "https://github.com/o/r/pull/1"), dispose: () => {} }),
    log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra }),
    mergedPlanLint: lint,
  } as unknown as GardenerDeps<{ root: string; land: () => string; dispose: () => void }>;
  return { dir, rows, landed, run: () => runGarden(spec as never, deps as never), runAsync: () => runGardenAsync(spec as never, deps as never) };
}

test("W1-T5457: a refused landing is ledgered and is not a filing failure", (t) => {
  const h = harness(t, () => ({ file: SHARD, message: "duplicate key priority" }));
  for (let i = 0; i < GARDEN_FILING_ESCALATE_AT + 1; i++) h.run();
  assert.deepEqual(h.landed, [], "nothing landed");
  const refused = h.rows.filter((r) => r.step === "probe.landing_refused");
  assert.ok(refused.length >= 1, "ledgered as landing_refused");
  assert.equal(refused[0]!.extra?.file, SHARD);
  assert.equal(h.rows.filter((r) => r.step === "probe.garden_filing_failed").length, 0, "not a filing failure");
  let state: { filingFailures?: unknown; lastPass?: unknown } = {};
  try {
    state = JSON.parse(readFileSync(gardenStatePath(join(h.dir, "state"), "probe"), "utf8"));
  } catch {
    /* no state file: no streak either */
  }
  assert.equal(state.filingFailures, undefined);
  assert.equal(state.lastPass, undefined, "no fingerprint recorded, so the next pass rebuilds on fresh main");
});

test("W1-T5457: the async gardener awaits a refused landing lint before it can land", async (t) => {
  let settled = false;
  const h = harness(t, async () => {
    await Promise.resolve();
    settled = true;
    return { file: SHARD, message: "duplicate key priority" };
  });
  await h.runAsync();
  assert.equal(settled, true);
  assert.deepEqual(h.landed, [], "the asynchronous refusal is observed before landing");
  assert.equal(h.rows.filter((r) => r.step === "probe.landing_refused").length, 1);
});

test("W1-T5457: async default lint sees a duplicate added to fresh origin/main", async () => {
  const origin = gitRepo({ bare: true, branch: "main", kind: "merged-plan-origin" });
  const repo = gitRepo({ kind: "merged-plan-client" });
  repo.addRemote("origin", origin.dir);
  repo.git("push", "--quiet", "--set-upstream", "origin", "main");

  const base = "plan/tasks.d/W1-T1-base.yaml";
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, base), task("W1-T1"));
  repo.git("add", base);
  repo.git("commit", "--quiet", "-m", "add base plan task");
  repo.git("push", "--quiet", "origin", "main");

  const feature = repo.addWorktree(join(makeTempDir("merged-plan-feature"), "tree"), "feature");
  const duplicateOnMain = "plan/tasks.d/W1-T2-main.yaml";
  writeFileSync(join(repo.dir, duplicateOnMain), task("W1-T1"));
  repo.git("add", duplicateOnMain);
  repo.git("commit", "--quiet", "-m", "add task on fresh main");
  repo.git("push", "--quiet", "origin", "main");

  const incoming = "plan/tasks.d/W1-T3-incoming.yaml";
  writeFileSync(join(feature.dir, incoming), task("W1-T1"));
  const refusal = await freshMergedPlanLintAsync(feature.dir, [incoming]);
  assert.match(refusal?.message ?? "", /duplicate task id 'W1-T1'/);
});

test("W1-T5457: both default lints three-way merge a record edited on both sides, and tolerate a new file", async () => {
  const origin = gitRepo({ bare: true, branch: "main", kind: "merged-plan-origin" });
  const repo = gitRepo({ kind: "merged-plan-client" });
  repo.addRemote("origin", origin.dir);
  repo.git("push", "--quiet", "--set-upstream", "origin", "main");

  const shared = "plan/tasks.d/W1-T1-shared.yaml";
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, shared), task("W1-T1", "  priority: 2\n"));
  repo.git("add", shared);
  repo.git("commit", "--quiet", "-m", "add shared plan task");
  repo.git("push", "--quiet", "origin", "main");

  const feature = repo.addWorktree(join(makeTempDir("merged-plan-feature"), "tree"), "feature");
  // Fresh main edits the title; the feature edits the priority: distant hunks, so the merge is clean.
  writeFileSync(join(repo.dir, shared), task("W1-T1", "  priority: 2\n").replace("title: t", "title: from-main"));
  repo.git("add", shared);
  repo.git("commit", "--quiet", "-m", "retitle on fresh main");
  repo.git("push", "--quiet", "origin", "main");
  writeFileSync(join(feature.dir, shared), task("W1-T1", "  priority: 3\n"));
  const fresh = "plan/tasks.d/W1-T9-new.yaml";
  writeFileSync(join(feature.dir, fresh), task("W1-T9"));

  assert.equal(freshMergedPlanLint(feature.dir, [shared, fresh]), undefined);
  assert.equal(await freshMergedPlanLintAsync(feature.dir, [shared, fresh]), undefined);

  // A conflicting edit of the same line is reported as a merge conflict by both.
  writeFileSync(join(feature.dir, shared), task("W1-T1", "  priority: 2\n").replace("title: t", "title: from-feature"));
  assert.match(freshMergedPlanLint(feature.dir, [shared])?.message ?? "", /merge conflict/);
  assert.match((await freshMergedPlanLintAsync(feature.dir, [shared]))?.message ?? "", /merge conflict/);
});

test("W1-T5457: a path outside the plan is not checked", (t) => {
  const outside = { "src/lib/x.ts": "this: is: not [yaml", "docs/a.md": "- id: a\n  id: b\n" };
  assert.equal(lintMergedPlanChange({ base: BASE, changes: outside }), undefined);
  // The real landing lint touches no git for a source-only landing (the root here is not a repository).
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}landing-lint-src-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(freshMergedPlanLint(dir, ["src/lib/x.ts", "docs/a.md"]), undefined);
});
