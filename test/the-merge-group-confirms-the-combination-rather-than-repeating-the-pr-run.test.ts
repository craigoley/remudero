/**
 * W1-T5940 — the merge group confirms the combination rather than repeating the PR run.
 *
 * GitHub's merge queue chains one squash commit per member PR onto the group base, so the group's
 * `HEAD^1...HEAD` is only the LAST member. The selection must be read from the combined diff AND
 * every member's own diff, never narrower than their union, and fall back to the full run when it
 * cannot be read. The fixtures are real git histories shaped like a queue branch.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// @ts-expect-error — plain .mjs, no declaration file.
import { mergeGroupSelection } from "../scripts/test-tier-manifest.mjs";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };
const jobs = (parseYaml(CI_YAML) as { jobs: Record<string, { steps: Step[] }> }).jobs;

/** A queue branch: a base commit, then one commit per member writing (or, for null, deleting) files. */
function queueBranch(members: Array<Record<string, string | null>>) {
  const repo = gitRepo({ kind: "merge-group" });
  const base = repo.git("rev-parse", "HEAD");
  for (const [i, files] of members.entries()) {
    for (const [path, body] of Object.entries(files)) {
      if (body === null) {
        rmSync(join(repo.dir, path));
        continue;
      }
      mkdirSync(join(repo.dir, path, ".."), { recursive: true });
      writeFileSync(join(repo.dir, path), body);
    }
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", `member ${i + 1}`);
  }
  return { cwd: repo.dir, base };
}

/** A fake selector: each src/<name>.ts is read by test/<name>.test.ts. */
const bySource = (changed: string[]) => ({
  fullRun: false,
  suites: changed.filter((f) => f.startsWith("src/")).map((f) => f.replace(/^src\/(.*)\.ts$/, "test/$1.test.ts")),
  narrow: changed.filter((f) => f.startsWith("src/")).map((f) => f.replace(/^src\/(.*)\.ts$/, "test/$1.test.ts")),
  reasons: [],
});

test("W1-T5940: a merge_group run selects the suites the first member affects, not only the last member's", () => {
  const { cwd, base } = queueBranch([{ "src/first.ts": "export const a = 1;\n" }, { "src/last.ts": "export const b = 2;\n" }]);
  const sel = mergeGroupSelection({ base, select: bySource, cwd });
  assert.equal(sel.mode, "affected", sel.reason);
  assert.equal(sel.members, 2);
  assert.deepEqual(sel.suites, ["test/first.test.ts", "test/last.test.ts"], "a suite only the first member affects must be selected");
});

test("W1-T5940: the selection is never fewer suites than the union of its member PRs' affected sets", () => {
  // Member 2 reverts member 1's file, so the COMBINED diff no longer names src/reverted.ts.
  const { cwd, base } = queueBranch([
    { "src/reverted.ts": "export const r = 1;\n", "src/kept.ts": "export const k = 1;\n" },
    { "src/reverted.ts": null },
  ]);
  const combined = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd, encoding: "utf8" }).stdout;
  assert.doesNotMatch(combined, /src\/reverted\.ts/, "sanity: the combined diff loses the reverted path's change");
  const union = new Set<string>();
  for (const sha of spawnSync("git", ["rev-list", `${base}..HEAD`], { cwd, encoding: "utf8" }).stdout.trim().split("\n")) {
    const own = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", `${sha}^1`, sha], { cwd, encoding: "utf8" }).stdout;
    for (const s of bySource(own.trim().split("\n")).suites) union.add(s);
  }
  const sel = mergeGroupSelection({ base, select: bySource, cwd });
  assert.equal(sel.mode, "affected", sel.reason);
  for (const suite of union) assert.ok(sel.suites.includes(suite), `${suite} is in a member's affected set but was not selected`);
});

test("W1-T5940: a merge_group selection falls back to the full run when it is unusable", () => {
  const { cwd, base } = queueBranch([{ "src/one.ts": "export const o = 1;\n" }]);
  const full = (sel: { mode: string; suites: string[] }) => {
    assert.equal(sel.mode, "full");
    assert.deepEqual(sel.suites, []);
  };
  full(mergeGroupSelection({ base, select: () => ({ fullRun: true, suites: [], reasons: ["full run: a config file"] }), cwd }));
  full(mergeGroupSelection({ base: "", select: bySource, cwd }));
  full(mergeGroupSelection({ base: "0".repeat(40), select: bySource, cwd }));
  full(mergeGroupSelection({ base, select: () => ({ fullRun: false, suites: [], narrow: [], reasons: [] }), cwd }));
  full(mergeGroupSelection({ base, select: () => { throw new Error("listing timed out"); }, cwd }));
});

test("W1-T5940: ci.yml wires the merge group's selection into ci-shard and test-slow and skips the instrumented re-run", () => {
  for (const job of ["ci", "test-slow-shard"]) {
    const select = jobs[job]!.steps.find((s) => s.name?.startsWith("Select the merge group's suites (W1-T5940"));
    assert.ok(select?.run, `${job} must select the merge group's suites`);
    assert.equal(select!.env?.GROUP_BASE, "${{ github.event.merge_group.base_sha }}", `${job} must read the group base from a step env`);
    assert.match(select!.run!, /writeMergeGroupSelection\(process\.argv\[1\], process\.argv\[2\]\)/);
  }
  const ciTest = jobs.ci!.steps.find((s) => s.name === "Test")!.run!;
  assert.match(ciTest, /"\$\{GITHUB_EVENT_NAME\}" = "merge_group" \] && .*\n\s+cp merge-group-suites\.txt affected-suites-selected\.txt\n\s+CLASS="AFFECTED"/);
  const slow = jobs["test-slow-shard"]!.steps.find((s) => s.name?.startsWith("Run the slow tier"))!.run!;
  assert.match(slow, /--select-candidates merge-group-suites\.txt --shard 1\/8 --base HEAD > \/dev\/null; then\n.*\n\s+exit 0/);

  const classify = jobs["coverage-ratchet"]!.steps.find((s) => s.id === "classify")!.run!;
  const dir = gitRepo({ kind: "merge-group-classify" }).dir;
  writeFileSync(join(dir, "classify.sh"), classify);
  const r = spawnSync("bash", ["-eo", "pipefail", "classify.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "merge_group", GITHUB_OUTPUT: join(dir, "out.txt") },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /^class=NO_SRC$/m, "a merge group must take coverage-ratchet's existing skip class");
});
