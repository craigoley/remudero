/**
 * W1-T6107 — main builds the test impact map the PR shadow selector reads.
 *
 * PRODUCER: coverage-nightly's merge job builds the map from the same eight COMPACT shards it merges
 * (compaction keeps each report's suite; ci.yml's premapped PR shards do not) and uploads it as
 * `test-impact-map`. CONSUMER: ci.yml's coverage shard fetches the newest nightly map on a SOURCE pull
 * request and hands it to the shadow selector with `--base`; with none it passes neither flag.
 *
 * The step bodies run for real under bash with stub `npm`/`node` and the shared gh shim on PATH. The
 * builder control runs the real merger over a real coverage run of a one-suite fixture tree.
 *
 * NODE_V8_COVERAGE: that fixture runner is given a coverage directory of its OWN on purpose — the
 * directory is the thing under test. The merger children inherit this process's coverage.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = import.meta.resolve("tsx");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");

type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { name?: string; steps: Step[] };
const workflow = (file: string) => parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8")) as { jobs: Record<string, Job> };
const NIGHTLY = workflow("coverage-nightly.yml").jobs.merge!;
const CI = workflow("ci.yml");
const SHARD_JOB = Object.values(CI.jobs).find((job) => job.name === "coverage-shard (${{ matrix.shard }}/8)")!;

function step(job: Job, prefix: string): Step {
  const hit = job.steps.find((s) => s.name?.startsWith(prefix));
  assert.ok(hit, `step "${prefix}" must exist`);
  return hit;
}
const at = (job: Job, prefix: string) => job.steps.findIndex((s) => s.name?.startsWith(prefix));
const BUILD = "Build the test impact map from the compact shards (W1-T6107";
const FETCH = "Fetch the newest nightly test impact map for the shadow selector (W1-T6107)";
const SHARD_DIRS = Array.from({ length: 8 }, (_, k) => `coverage-shards/coverage-shard-${k + 1}/raw`);

/** A throwaway dir holding stub executables, prepended to PATH. Each stub logs "$@" and exits `code`. */
function stubs(entries: Record<string, { code: number; body?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6107-stubs-"));
  for (const [name, { code, body }] of Object.entries(entries)) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/${name}.log"\n${body ?? ""}\nexit ${code}\n`, { mode: 0o755 });
  }
  return { dir, log: (name: string) => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8") : "") };
}

/** Run a workflow step's `run:` body under bash -e, as a runner's default shell does. */
function bash(body: string, opts: { cwd: string; path: string[]; env: Record<string, string> }) {
  return spawnSync("bash", ["-e", "-c", body], {
    cwd: opts.cwd, encoding: "utf8",
    env: { ...process.env, ...opts.env, PATH: [...opts.path, process.env.PATH].join(":") },
  });
}

test("W1-T6107: coverage-nightly builds the impact map from the eight compact shards it merges, with the run's sha, before the gates that can fail the job", () => {
  const build = step(NIGHTLY, BUILD).run!;
  assert.match(build, /--impact-map test-impact-map\.json/);
  assert.match(build, /--sha "\$GITHUB_SHA"/);
  assert.match(build, /--shard-count 8/);
  assert.match(build, /node --import tsx scripts\/coverage-merge-ratchet\.mjs/);
  const merge = step(NIGHTLY, "Merge raw V8 coverage shards into one lcov").run!;
  for (const dir of SHARD_DIRS) {
    assert.ok(merge.includes(dir), `the merge reads ${dir}`);
    assert.ok(build.includes(dir), `the map is built from ${dir}, the same compact shard`);
  }
  assert.ok(at(NIGHTLY, "Merge raw V8 coverage shards") < at(NIGHTLY, BUILD));
  assert.ok(at(NIGHTLY, BUILD) < at(NIGHTLY, "Coverage ratchet (main's absolute floor)"), "a red floor must not skip the map");
  assert.ok(at(NIGHTLY, BUILD) < at(NIGHTLY, "Fail the run if any shard's instrumented suite was red"), "a red shard must not skip the map");
  assert.equal(step(NIGHTLY, BUILD).if, undefined, "the nightly reads no event and guards no step");
});

test("W1-T6107: the nightly map is uploaded as test-impact-map for at least seven days, and only when it exists", () => {
  const upload = step(NIGHTLY, "Upload the test impact map");
  assert.match(upload.uses ?? "", /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload.with?.name, "test-impact-map");
  assert.equal(upload.with?.path, "test-impact-map.json");
  assert.ok(Number(upload.with?.["retention-days"]) >= 7, "the PR side reads maps up to a week old");
  assert.equal(upload.with?.["if-no-files-found"], "ignore", "a failed build uploads nothing and fails nothing");
  assert.ok(at(NIGHTLY, BUILD) < at(NIGHTLY, "Upload the test impact map"));
  assert.ok(at(NIGHTLY, "Upload the test impact map") < at(NIGHTLY, "Coverage ratchet (main's absolute floor)"));
});

test("W1-T6107: an install or builder failure never fails the nightly and leaves no map", () => {
  const body = step(NIGHTLY, BUILD).run!;
  const writesMap = 'for a in "$@"; do if [ "$prev" = "--impact-map" ]; then printf "{}" > "$a"; fi; prev="$a"; done';
  for (const [label, npm, node, built] of [
    ["builder succeeds", 0, 0, true],
    ["builder fails", 0, 1, false],
    ["install fails", 1, 0, false],
  ] as const) {
    const cwd = mkdtempSync(join(tmpdir(), "rmd-t6107-nightly-"));
    const bin = stubs({ npm: { code: npm }, node: { code: node, body: node === 0 ? writesMap : "printf '{}' > test-impact-map.json" } });
    try {
      const summary = join(cwd, "summary.md");
      const r = bash(body, { cwd, path: [bin.dir], env: { GITHUB_SHA: "abc1234", GITHUB_STEP_SUMMARY: summary } });
      assert.equal(r.status, 0, `${label}: the step never fails the job (${r.stderr})`);
      assert.equal(existsSync(join(cwd, "test-impact-map.json")), built, `${label}: a map exists only after a successful build`);
      assert.match(readFileSync(summary, "utf8"), built ? /built the test impact map for abc1234/ : /impact-map build FAILED/);
      if (npm !== 0) assert.equal(bin.log("node"), "", "no build runs without an install");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(bin.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T6107: the real builder makes a map from compact shards and cannot from premapped ones", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-t6107-builder-")));
  try {
    mkdirSync(join(dir, "test"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    copyFileSync(join(REPO_ROOT, ".nvmrc"), join(dir, ".nvmrc"));
    writeFileSync(join(dir, "src", "add.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
    writeFileSync(join(dir, "test", "mini.test.ts"), 'import { test } from "node:test";\nimport { add } from "../src/add.mjs";\ntest("mini", () => { if (add(1, 2) !== 3) throw new Error("add"); });\n');
    const run = spawnSync(process.execPath, [
      "--enable-source-maps", "--experimental-test-coverage", "--test-coverage-exclude=test/**",
      "--test", "--import", TSX, "test/mini.test.ts",
    ], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: join(dir, "raw"), NODE_TEST_CONTEXT: undefined } });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const merger = (node: string[], args: string[]) => spawnSync(process.execPath, [...node, MERGER, ...args], { cwd: dir, encoding: "utf8" });
    const compact = merger(["--expose-internals"], ["--compact-output", "compact", "raw"]);
    assert.equal(compact.status, 0, compact.stderr);
    const built = merger(["--import", TSX], ["--impact-map", "map.json", "--sha", "abc1234", "compact"]);
    assert.equal(built.status, 0, built.stderr);
    const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf8")) as { format: string; sha: string; suites: string[]; files: Record<string, { loadedBy: number[] }> };
    assert.equal(map.format, "rmd-test-impact-map-v1");
    assert.equal(map.sha, "abc1234");
    assert.deepEqual(map.suites, ["test/mini.test.ts"], "compaction kept the suite each report ran");
    assert.deepEqual(map.files["src/add.mjs"]?.loadedBy, [0], "and the map credits the source it loaded to that suite");
    const premapped = merger(["--expose-internals"], ["--premap-output", "premapped", "raw"]);
    assert.equal(premapped.status, 0, premapped.stderr);
    const refused = merger(["--import", TSX], ["--impact-map", "map2.json", "--sha", "abc1234", "premapped"]);
    assert.notEqual(refused.status, 0, "a premapped shard carries no suite identity to build from");
    assert.match(refused.stderr, /contains no V8 coverage files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run ci.yml's fetch step body with `RUNNER_TEMP`, the event and the class it reads. */
function fetch(routes: Parameters<typeof ghShim>[0], env: { event: string; klass: string }, seedStale = false) {
  const temp = mkdtempSync(join(tmpdir(), "rmd-t6107-fetch-"));
  const shim = ghShim(routes, { kind: "t6107-gh" });
  if (seedStale) {
    mkdirSync(join(temp, "impact-map"), { recursive: true });
    writeFileSync(join(temp, "impact-map", "test-impact-map.json"), '{"stale":true}');
  }
  const r = bash(step(SHARD_JOB, FETCH).run!, {
    cwd: temp, path: [shim.dir],
    env: { RUNNER_TEMP: temp, GITHUB_EVENT_NAME: env.event, CLASS: env.klass, GH_TOKEN: "t", GH_REPO: "o/r" },
  });
  const mapPath = join(temp, "impact-map", "test-impact-map.json");
  const map = existsSync(mapPath) ? readFileSync(mapPath, "utf8") : undefined;
  const calls = shim.calls();
  rmSync(temp, { recursive: true, force: true });
  rmSync(shim.dir, { recursive: true, force: true });
  return { r, map, calls };
}

test("W1-T6107: on a SOURCE pull request the fetch step downloads the newest nightly run's map that has one", () => {
  assert.equal(step(SHARD_JOB, FETCH).if, undefined, "the coverage shard job takes no step-level if: (W1-T1033)");
  assert.equal(step(SHARD_JOB, FETCH).env?.CLASS, "${{ steps.classify.outputs.class }}");
  assert.ok(at(SHARD_JOB, FETCH) < at(SHARD_JOB, "Test with coverage"), "the map is in place before the shadow selector runs");
  // The route writes where `gh run download -D` would, inside the RUNNER_TEMP this run is given.
  const temp = mkdtempSync(join(tmpdir(), "rmd-t6107-fetch-ok-"));
  const shim = ghShim([
    { when: "run list", stdout: "111\n222" },
    { when: "run download 222", writes: { path: join(temp, "impact-map", "test-impact-map.json"), content: '{"format":"rmd-test-impact-map-v1"}' } },
    { when: "run download 111", exit: 1, stderr: "no artifact named test-impact-map" },
  ], { kind: "t6107-gh" });
  try {
    const r = bash(step(SHARD_JOB, FETCH).run!, {
      cwd: temp, path: [shim.dir],
      env: { RUNNER_TEMP: temp, GITHUB_EVENT_NAME: "pull_request", CLASS: "SOURCE", GH_TOKEN: "t", GH_REPO: "o/r" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /reads coverage-nightly run 222's impact map/);
    assert.equal(readFileSync(join(temp, "impact-map", "test-impact-map.json"), "utf8"), '{"format":"rmd-test-impact-map-v1"}');
    const calls = shim.calls();
    assert.match(calls[0]!, /^run list --workflow coverage-nightly\.yml --branch main --status completed --limit 5/);
    assert.deepEqual(calls.slice(1).map((c) => c.split(" -D ")[0]), ["run download 111 -n test-impact-map", "run download 222 -n test-impact-map"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T6107: with no nightly map, or off a SOURCE pull request, the fetch step leaves no map and says why", () => {
  const none = fetch([{ when: "run list", stdout: "" }], { event: "pull_request", klass: "SOURCE" }, true);
  assert.equal(none.r.status, 0);
  assert.equal(none.map, undefined, "a map left by an earlier step never survives a failed fetch");
  assert.match(none.r.stdout, /no coverage-nightly impact map could be fetched; the shadow selector records no impact arm/);
  const failing = fetch([{ when: "run list", stdout: "7" }, { when: "run download", exit: 1 }], { event: "pull_request", klass: "SOURCE" });
  assert.equal(failing.r.status, 0);
  assert.equal(failing.map, undefined);
  for (const env of [{ event: "push", klass: "SOURCE" }, { event: "merge_group", klass: "SOURCE" }, { event: "pull_request", klass: "PLAN_ONLY" }]) {
    const off = fetch([{ when: "run list", stdout: "7" }], env, true);
    assert.equal(off.r.status, 0);
    assert.equal(off.map, undefined, `${env.event} ${env.klass}: no map`);
    assert.deepEqual(off.calls, [], `${env.event} ${env.klass}: gh is never called`);
    assert.match(off.r.stdout, /no impact map is fetched/);
  }
});

/** The shadow selector's lines from the coverage test step: the flags block through its fallback echo. */
function selectorBlock(): string {
  const lines = step(SHARD_JOB, "Test with coverage").run!.split("\n");
  const start = lines.findIndex((l) => l.trim() === "IMPACT_FLAGS=()");
  const end = lines.findIndex((l, i) => i > start && l.includes('|| echo "W1-T4404: the shadow selector itself failed'));
  assert.ok(start >= 0 && end > start, "the flags block sits directly above the shadow selector call");
  return lines.slice(start, end + 1).join("\n");
}

test("W1-T6107: the shadow selector passes --impact-map with --base only when a map was fetched", () => {
  const fixture = gitRepo({ kind: "t6107-repo" });
  const repo = fixture.dir;
  const bin = stubs({ node: { code: 0 } });
  try {
    fixture.git("commit", "--quiet", "--allow-empty", "-m", "head");
    const base = fixture.git("rev-parse", "HEAD^1");
    assert.match(base, /^[0-9a-f]{40}$/);
    const run = () => bash(selectorBlock(), { cwd: repo, path: [bin.dir], env: { RUNNER_TEMP: repo } });

    assert.equal(run().status, 0);
    const without = bin.log("node");
    assert.match(without, /scripts\/select-affected-suites\.mjs --changed-files changed-files\.txt --diff /);
    assert.doesNotMatch(without, /--impact-map|--base/, "no map: neither flag");

    mkdirSync(join(repo, "impact-map"));
    writeFileSync(join(repo, "impact-map", "test-impact-map.json"), "{}");
    rmSync(join(bin.dir, "node.log"));
    assert.equal(run().status, 0);
    const withMap = bin.log("node").trim();
    assert.ok(withMap.endsWith(`--impact-map ${join(repo, "impact-map", "test-impact-map.json")} --base ${base}`), withMap);
  } finally {
    fixture.cleanup();
    rmSync(bin.dir, { recursive: true, force: true });
  }
});

test("W1-T6107: the map reaches only the shadow selector, so no other event's selection changes", () => {
  const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const users = SHARD_JOB.steps.filter((s) => (s.run ?? "").includes("impact-map")).map((s) => s.name);
  assert.deepEqual(users, [FETCH, step(SHARD_JOB, "Test with coverage").name]);
  assert.equal(text.split("impact-map").length - 1, (step(SHARD_JOB, FETCH).run!.split("impact-map").length - 1) + (selectorBlock().split("impact-map").length - 1),
    "every impact-map mention in ci.yml is the fetch step or the shadow selector block");
});
