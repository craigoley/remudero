/**
 * W1-T5705 — the live suite selection narrows the COVERAGE lane, where the cost is.
 *
 * `RMD_AFFECTED_SUITE_LIVE` (ci.yml's top-level env, W1-T4406) used to reach only `ci`'s Test step,
 * which on a pull_request SOURCE diff already exits early (W1-T3207), so flipping it saved nothing
 * of coverage-shard's runner-hours. With the flag at 1, a pull_request SOURCE coverage shard now runs
 * the selector's `narrow` set (src/lib/affected-suites.ts) through `--select-candidates` instead of
 * `--select-all`; with the flag at 0, or on push and merge_group, it keeps `--select-all`. A
 * narrowed run cannot certify the ABSOLUTE floor, so the aggregator's ratchet step then reads the
 * newest nightly (W1-T5704) or merge-group lcov instead of the narrowed one.
 *
 * Every arm below is driven through the REAL step body with stub `node`/`gh`/`git` binaries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
  env?: Record<string, string>;
  jobs: Record<string, { strategy?: { matrix?: { shard?: unknown[] } }; steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
};
const SHARDS = doc.jobs["coverage-ratchet"]!.strategy?.matrix?.shard?.length ?? 0;
const bashVersion = spawnSync("bash", ["--version"], { encoding: "utf8" }).stdout ?? "";
const MAPFILE_SHIM = /^GNU bash, version 3\./.test(bashVersion)
  ? `mapfile() {
  local target line
  if [ "\${1:-}" = "-t" ]; then target="$2"; else target="$1"; fi
  eval "$target=()"
  while IFS= read -r line; do eval "$target+=(\"\$line\")"; done
}\n`
  : "";

function step(job: string, name: string) {
  const found = doc.jobs[job]?.steps?.find((s) => s.name === name || s.name?.startsWith(`${name} (`));
  assert.ok(found?.run, `${job} must carry a run step named ${name}`);
  return found!;
}

const NARROW = Array.from({ length: 10 }, (_, i) => `test/n${i}.test.ts`);

/** A stub `node`: the inline selector writes `selectorOut` to its last argument; the manifest
 *  answers `--select-all`/`--select-candidates`; the instrumented runner leaves a real-looking lcov. */
function nodeStub(selectorOut: string, candidatesExit = 0): string {
  return `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  *--import\\ tsx\\ -e*) for last; do :; done; printf '${selectorOut}' > "$last" ;;
  *--select-candidates*) [ ${candidatesExit} = 0 ] || exit ${candidatesExit}; head -n 1 "$3" ;;
  *--select-all*) echo "test/all.test.ts" ;;
  *test-with-retry.mjs*) mkdir -p coverage/raw; echo "SF:src/a.ts" > coverage/lcov.info; echo "{}" > coverage/raw/coverage-1.json; echo "# tests 1" ;;
  *) echo "# tests 1" ;;
esac
`;
}

/** Runs a step body under bash -e with stub `node`/`git` and the shared `gh` shim answering `ghRoutes`;
 *  `.calls` holds every node, git and gh invocation. */
function run(body: string, env: Record<string, string>, node: string, ghRoutes: GhShimRoute[] = []) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5705-`));
  const gh = ghShim(ghRoutes, { kind: "w1t5705-gh" });
  mkdirSync(join(dir, "bin"));
  for (const [name, text] of [["node", node], ["git", "#!/usr/bin/env bash\necho \"git $*\" >> \"$CALL_LOG\"\n"]]) {
    writeFileSync(join(dir, "bin", name!), text!);
    chmodSync(join(dir, "bin", name!), 0o755);
  }
  writeFileSync(join(dir, "changed-files.txt"), "src/a.ts\n");
  writeFileSync(join(dir, "run.sh"), MAPFILE_SHIM + body);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", join(dir, "run.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${gh.dir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? dir,
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      GITHUB_OUTPUT: join(dir, "outputs.txt"),
      RUNNER_TEMP: dir,
      CALL_LOG: join(dir, "calls.log"),
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const calls = read("calls.log") + gh.calls().map((c) => `gh ${c}\n`).join("");
  return { status: r.status, out: r.stdout + r.stderr, calls, read, dir };
}

const coverageBody = step("coverage-ratchet", "Test with coverage").run!
  .replaceAll("${{ matrix.shard }}", "1")
  .replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
const NARROW_OUT = NARROW.join("\\n") + "\\n";
const CANDIDATES = new RegExp(`test-tier-manifest\\.mjs --select-candidates coverage-narrow-suites\\.txt --shard 1/${SHARDS} --base HEAD\\^1`);
const SELECT_ALL = new RegExp(`test-tier-manifest\\.mjs --select-all --shard 1/${SHARDS} --base HEAD\\^1`);

test("W1-T5705: with the live flag at 1 a pull_request SOURCE coverage shard runs the narrow selection", () => {
  assert.equal(SHARDS, 8, "coverage-ratchet must keep its eight-shard matrix");
  const live = run(coverageBody, { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "1" }, nodeStub(NARROW_OUT));
  assert.equal(live.status, 0, live.out);
  assert.match(live.calls, /node --import tsx -e/, "the live flag must compute the selector's narrow set");
  assert.match(live.calls, CANDIDATES, "the narrow set must be sharded through --select-candidates");
  assert.doesNotMatch(live.calls, /--select-all/, "a narrowed shard must not also select the full suite");
  assert.equal(live.read("coverage-narrow-suites.txt"), NARROW.join("\n") + "\n");
  assert.equal(live.read("coverage-test-files.txt").trim(), NARROW[0], "the instrumented runner must receive the narrowed shard");
  assert.equal(live.read("coverage-selection.txt").trim(), "narrow");
});

test("W1-T5705: with the flag at 0, or on push and merge_group, the coverage shard keeps --select-all", () => {
  assert.equal(doc.env?.RMD_AFFECTED_SUITE_LIVE, "0", "the flip is a separate operator PR, made once the shadow reads ready");
  const envs: Array<Record<string, string>> = [
    { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "0" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "merge_group", RMD_AFFECTED_SUITE_LIVE: "1" },
  ];
  for (const env of envs) {
    const r = run(coverageBody, env, nodeStub(NARROW_OUT));
    assert.equal(r.status, 0, r.out);
    assert.match(r.calls, SELECT_ALL, `${JSON.stringify(env)} must select the full suite`);
    assert.doesNotMatch(r.calls, /--import tsx -e|--select-candidates/, `${JSON.stringify(env)} must not narrow`);
    assert.equal(r.read("coverage-selection.txt").trim(), "all");
  }
  const push = run(coverageBody, { GITHUB_EVENT_NAME: "push", RMD_AFFECTED_SUITE_LIVE: "1" }, nodeStub(NARROW_OUT));
  assert.equal(push.status, 0, push.out);
  assert.equal(push.calls, "", "a push still takes the W1-T1033 skip and narrows nothing");
});

test("W1-T5705: a full-run verdict or a refused narrow shard falls back to --select-all", () => {
  const full = run(coverageBody, { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "1" }, nodeStub("full\\n"));
  assert.equal(full.status, 0, full.out);
  assert.match(full.calls, SELECT_ALL);
  assert.doesNotMatch(full.calls, /--select-candidates/);
  assert.equal(full.read("coverage-selection.txt").trim(), "all");

  const refused = run(coverageBody, { GITHUB_EVENT_NAME: "pull_request", RMD_AFFECTED_SUITE_LIVE: "1" }, nodeStub(NARROW_OUT, 1));
  assert.equal(refused.status, 0, refused.out);
  assert.match(refused.calls, CANDIDATES);
  assert.match(refused.calls, SELECT_ALL, "a refused candidate selection must take the full shard, never an empty one");
  assert.equal(refused.read("coverage-selection.txt").trim(), "all");
});

test("W1-T5705: each shard stages its selection for the aggregator", () => {
  const stage = step("coverage-ratchet", "Stage this coverage shard for the required-check aggregator").run!
    .replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  const staged = run(`echo narrow > coverage-selection.txt\n${stage}`, { GITHUB_EVENT_NAME: "pull_request" }, nodeStub(""));
  assert.equal(staged.status, 0, staged.out);
  assert.equal(staged.read("coverage-artifact/selection").trim(), "narrow");
  const unstaged = run(stage, { GITHUB_EVENT_NAME: "push" }, nodeStub(""));
  assert.equal(unstaged.read("coverage-artifact/selection").trim(), "all", "a shard that never selected stages 'all'");
});

/** Seeds the eight downloaded shard artifacts' selection markers; shard `narrowShard` (0 = none) narrowed. */
const seed = (narrowShard: number) => Array.from({ length: SHARDS }, (_, i) =>
  `mkdir -p coverage-shards/coverage-shard-${i + 1}; echo ${i + 1 === narrowShard ? "narrow" : "all"} > coverage-shards/coverage-shard-${i + 1}/selection`).join("\n");

test("W1-T5705: when narrowed, the absolute-floor step reads the nightly artifact, and diff coverage reads the selection", () => {
  const ratchet = step("coverage-ratchet-required", "Coverage ratchet (blocks a PR whose branch coverage is below the absolute floor)");
  assert.equal(ratchet.env?.GH_TOKEN, "${{ github.token }}", "the floor lookup reads another run's artifact with the job token");
  const body = ratchet.run!.replaceAll("${{ steps.coverage-artifact.outputs.class }}", "SOURCE");
  const base = { GITHUB_EVENT_NAME: "pull_request" };
  const downloaded = "mkdir -p floor-111 floor-222; echo SF:src/a.ts > floor-111/lcov.info; echo SF:src/a.ts > floor-222/lcov.info";
  const narrowed = `${seed(3)}\n${downloaded}\n${body}`;
  const listed = (nightlyAt: string, queueAt?: string): GhShimRoute[] => [
    { when: "run list --workflow coverage-nightly.yml", stdout: `${nightlyAt} 111 coverage-nightly` },
    ...(queueAt ? [{ when: "run list --workflow ci.yml", stdout: `${queueAt} 222 coverage-merged` }] : []),
  ];

  const nightly = run(narrowed, base, nodeStub(""), listed("2026-10-05T04:52:00Z", "2026-10-04T01:00:00Z"));
  assert.equal(nightly.status, 0, nightly.out);
  assert.match(nightly.calls, /gh run list --workflow coverage-nightly\.yml --branch main/);
  assert.match(nightly.calls, /gh run download 111 -n coverage-nightly -D floor-111/, "the newest run is the nightly, so its artifact is read");
  assert.match(nightly.calls, /coverage-ratchet\.mjs --lcov floor-111\/lcov\.info --baseline scripts\/coverage-baseline\.json/);
  assert.doesNotMatch(nightly.calls, /--lcov coverage\/lcov\.info/, "a narrowed lcov must never be held to the absolute floor");

  const queue = run(narrowed, base, nodeStub(""), listed("2026-10-03T04:52:00Z", "2026-10-05T09:00:00Z"));
  assert.equal(queue.status, 0, queue.out);
  assert.match(queue.calls, /gh run download 222 -n coverage-merged -D floor-222/, "a newer merge-group run is read before an older nightly");
  assert.match(queue.calls, /coverage-ratchet\.mjs --lcov floor-222\/lcov\.info/);

  const expired = run(narrowed, base, nodeStub(""), [{ when: "run download 222", exit: 1 }, ...listed("2026-10-03T04:52:00Z", "2026-10-05T09:00:00Z")]);
  assert.equal(expired.status, 0, expired.out);
  assert.match(expired.calls, /coverage-ratchet\.mjs --lcov floor-111\/lcov\.info/, "an expired newest artifact falls to the next run");

  const none = run(narrowed, base, nodeStub(""), [{ when: "run download", exit: 1 }, ...listed("2026-10-05T04:52:00Z")]);
  assert.notEqual(none.status, 0, "no readable full-run lcov must refuse, never pass an unmeasured floor");
  assert.doesNotMatch(none.calls, /coverage-ratchet\.mjs/);

  for (const full of [run(`${seed(0)}\n${body}`, base, nodeStub("")), run(body, base, nodeStub(""))]) {
    assert.equal(full.status, 0, full.out);
    assert.match(full.calls, /coverage-ratchet\.mjs --lcov coverage\/lcov\.info --baseline/);
    assert.doesNotMatch(full.calls, /^gh /m, "a full selection reads its own lcov and calls no gh");
  }

  const diff = step("coverage-ratchet-required", "Diff coverage (blocks a PR that adds untested source lines, even when the aggregate floor below stays green)").run!;
  assert.match(diff, /diff-coverage\.mjs --lcov coverage\/lcov\.info --diff pr\.diff/, "diff coverage reads the merged (narrowed) selection");
});

test("W1-T5705: the inline narrow selector runs for real against this repo", () => {
  const script = /node --import tsx -e '\n([\s\S]*?)\n\s*' changed-files\.txt "\$\{RUNNER_TEMP\}\/affected\.diff" coverage-narrow-suites\.txt/.exec(coverageBody);
  assert.ok(script, "the coverage shard must invoke node --import tsx -e '<script>' changed-files.txt <diff> coverage-narrow-suites.txt");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5705-real-`));
  writeFileSync(join(dir, "changed.txt"), ".github/workflows/ci.yml\n");
  writeFileSync(join(dir, "affected.diff"), "");
  const real = spawnSync(process.execPath, ["--import", "tsx", "-e", script![1]!, join(dir, "changed.txt"), join(dir, "affected.diff"), join(dir, "out.txt")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: REPO_ROOT },
  });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "full\n", "a workflow change forces a full run");
  assert.match(real.stdout, /W1-T5705: live coverage selection -> FULL/);
});
