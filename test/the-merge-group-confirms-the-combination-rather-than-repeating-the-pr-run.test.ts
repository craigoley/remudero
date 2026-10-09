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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// @ts-expect-error — plain .mjs, no declaration file. A namespace import, so a tree without the
// export fails inside each test rather than at module load.
import * as tierManifest from "../scripts/test-tier-manifest.mjs";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
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

const mergeGroupSelection = (opts: Record<string, unknown>) => tierManifest.mergeGroupSelection(opts);

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
    assert.match(select!.run!, /writeMergeGroupSelection\(process\.argv\[1\], process\.argv\[2\], \{ load: \(p\) => import\(r \+ p\) \}\)/);
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

/** Runs a selection step's body with a stub `node` that writes one suite to the file it is handed. */
function runSelectStep(job: string, event: string) {
  const step = jobs[job]!.steps.find((s) => s.name?.startsWith("Select the merge group's suites (W1-T5940"))!;
  const dir = gitRepo({ kind: "merge-group-select" }).dir;
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "node"), '#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho test/picked.test.ts > "$last"\n', { mode: 0o755 });
  writeFileSync(join(dir, "select.sh"), step.run!.replaceAll("${{ steps.admission.outputs.setup }}", "true"));
  const r = spawnSync("bash", ["-eo", "pipefail", "select.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: event, GROUP_BASE: "a".repeat(40), GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  try { return readFileSync(join(dir, "merge-group-suites.txt"), "utf8"); } catch { return undefined; }
}

test("W1-T5940: each merge group selection step writes the group's suites on merge_group and nothing on a pull_request", () => {
  for (const job of ["ci", "test-slow-shard"]) {
    assert.equal(runSelectStep(job, "merge_group"), "test/picked.test.ts\n", `${job}'s selection step must run on a merge group`);
    assert.equal(runSelectStep(job, "pull_request"), undefined, `${job}'s selection step must stay inert on a pull_request`);
  }
});

test("W1-T5940: coverage-ratchet's merge group skip never fires on a pull_request", () => {
  const classify = jobs["coverage-ratchet"]!.steps.find((s) => s.id === "classify")!.run!;
  const dir = gitRepo({ kind: "merge-group-classify-pr" }).dir;
  writeFileSync(join(dir, "classify.sh"), classify);
  const r = spawnSync("bash", ["-o", "pipefail", "classify.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: join(dir, "out.txt") },
  });
  assert.doesNotMatch(r.stdout, /W1-T5940: merge group — coverage-ratchet skips/, "a pull_request must not take the merge group skip");
});

test("W1-T5940: tsx loads test-tier-manifest.mjs untransformed, so a deleted fixture copy cannot break the coverage report", () => {
  // A dynamic import makes tsx attach a source map; a-gate-run-leaves-the-tracked-tree-clean then
  // loads the script from a checkout it deletes, and the lcov writer dies (ERR_SOURCE_MAP_MISSING_SOURCE).
  const covDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5940-v8cov-`));
  try {
    const r = spawnSync(process.execPath, ["--enable-source-maps", "--import", "tsx", "-e", "await import(process.argv[1])", join(REPO_ROOT, "scripts/test-tier-manifest.mjs")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: covDir },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    type V8Report = { result: Array<{ url: string }>; "source-map-cache"?: Record<string, unknown> };
    const reports = readdirSync(covDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(covDir, f), "utf8")) as V8Report);
    const isScript = (url: string) => url.endsWith("/scripts/test-tier-manifest.mjs");
    assert.ok(reports.some((rep) => rep.result.some((s) => isScript(s.url))), "the child never loaded scripts/test-tier-manifest.mjs");
    const mapped = reports.flatMap((rep) => Object.keys(rep["source-map-cache"] ?? {}).filter(isScript));
    assert.deepEqual(mapped, [], "tsx attached a source map to scripts/test-tier-manifest.mjs");
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
});

/** Stub modules for writeMergeGroupSelection's `load`: the selector names `pick` and records what it read. */
function stubLoad(pick: string[], seen: { symbols?: string; changed: string[][] }) {
  const modules: Record<string, unknown> = {
    "src/lib/affected-suites.ts": {
      affectedSelectionOrFull: (changed: string[], read: () => unknown) => { seen.changed.push(changed); return read(); },
      changedSymbols: (diff: string, read: (p: string) => string) => { seen.symbols = read("src/feature.ts"); return diff.includes("feature") ? ["feature"] : []; },
      readAffectedSuitesInput: (_root: string, _changed: string[], opts: { symbolSuites: string[] }) =>
        ({ fullRun: false, suites: pick, narrow: [...pick, ...opts.symbolSuites], reasons: [] }),
    },
    "src/lib/ci-parity.ts": { callerReachableSuites: (symbols: string[]) => ({ suites: symbols.length > 0 ? ["test/reached.test.ts"] : [] }) },
    "src/lib/commit-message.ts": { defaultPreflightSpawn: () => undefined },
  };
  return async (p: string) => modules[p];
}

test("W1-T5940: writeMergeGroupSelection refuses to run without a module importer", async () => {
  await assert.rejects(() => tierManifest.writeMergeGroupSelection("HEAD", "unused.txt"), /needs a `load` module importer/);
});

test("W1-T5940: writeMergeGroupSelection writes the group's suites, padded to a full shard set with known suites", async () => {
  const tests = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h", "i", "reached"].map((n) => [`test/${n}.test.ts`, "// t\n"]));
  const { cwd, base } = queueBranch([{ ...tests, "src/feature.ts": "export const feature = 1;\n" }, { "src/other.ts": "export const other = 2;\n" }]);
  const seen: { symbols?: string; changed: string[][] } = { changed: [] };
  const out = join(cwd, "merge-group-suites.txt");
  const sel = await tierManifest.writeMergeGroupSelection(base, out, { load: stubLoad(["test/a.test.ts", "test/not-a-file.test.ts"], seen), root: cwd });
  assert.equal(sel.mode, "affected", sel.reason);
  const written = readFileSync(out, "utf8").trim().split("\n");
  assert.deepEqual(written, sel.suites);
  assert.equal(written.length, 8, "padded to the shard count");
  assert.ok(written.includes("test/a.test.ts") && written.includes("test/reached.test.ts"), "the selected and symbol-reached suites survive the padding");
  assert.ok(!written.includes("test/not-a-file.test.ts"), "an unknown suite is dropped, never handed to the candidate lane");
  assert.equal(seen.symbols, "export const feature = 1;\n", "symbols are read from the group's own tree");
  assert.equal(seen.changed.length, 3, "the combined diff and each member's diff are selected");
});

test("W1-T5940: writeMergeGroupSelection falls back to full when the tree has too few suites to shard", async () => {
  const { cwd, base } = queueBranch([{ "test/a.test.ts": "// t\n", "src/feature.ts": "export const feature = 1;\n" }]);
  const out = join(cwd, "merge-group-suites.txt");
  const sel = await tierManifest.writeMergeGroupSelection(base, out, { load: stubLoad(["test/a.test.ts"], { changed: [] }), root: cwd });
  assert.equal(sel.mode, "full");
  assert.equal(sel.reason, "too few suites to shard");
  assert.equal(readFileSync(out, "utf8"), "full\n");
});
