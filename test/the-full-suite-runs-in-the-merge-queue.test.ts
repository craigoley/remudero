/**
 * W1-T4406 — the full suite runs in the merge queue, not on every push.
 *
 * ci.yml registers required contexts on `merge_group`, the queue's own combination commit.
 * The accepted W1-T5940 selection checks its combined diff and every member, retaining a full
 * integration fallback. Member PRs retain their instrumented coverage owner. Push and PR
 * behavior are also covered by test/push-ci-on-main.test.ts, workflow-single-suite-run.test.ts
 * and the-slow-tier-runs-on-main.test.ts.
 *
 * W1-T5930 keeps SOURCE PR test ownership in coverage for either live-selection flag.
 * W1-T5940 selects the combined group in CI, with a full fallback, and skips duplicate PR coverage.
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const bashVersion = spawnSync("bash", ["--version"], { encoding: "utf8" }).stdout ?? "";
const BASH_3_MAPFILE_SHIM = /^GNU bash, version 3\./.test(bashVersion)
  ? `mapfile() {
  local target line
  if [ "\${1:-}" = "-t" ]; then target="$2"; else target="$1"; fi
  [ -n "$target" ] || return 2
  eval "$target=()"
  while IFS= read -r line; do eval "$target+=(\"\$line\")"; done
}`
  : "";

type Step = { name?: string; id?: string; run?: string };
type Job = { steps?: Step[]; strategy?: { matrix?: { shard?: unknown[] } } };
type CiDoc = { on: Record<string, unknown>; env?: Record<string, string>; jobs: Record<string, Job> };

const doc = parseYaml(readFileSync(CI_YAML_PATH, "utf8")) as CiDoc;
const CI_SHARD_COUNT = doc.jobs.ci!.strategy?.matrix?.shard?.length ?? 0;
assert.ok(CI_SHARD_COUNT > 0, "the ci matrix must declare at least one shard");

function findStep(jobId: string, name: string): Step {
  const found = doc.jobs[jobId]?.steps?.find((s) => s.name === name || s.name?.startsWith(`${name} (`));
  assert.ok(found?.run, `${jobId} must carry a run step named ${name}`);
  return found!;
}

const DEFAULT_NODE_STUB = `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  *--select-all*) printf '%s\\n' "test/x.test.ts" ;;
  *--select-candidates*) cat "$3"; echo "test-tier-manifest: plan-reading shard summary candidate_count=1" >&2 ;;
  *diff-class.mjs*) echo "SOURCE" ;;
  *) echo "# tests 1"; echo "# pass 1"; echo "# fail 0" ;;
esac
`;

/** Runs a real ci.yml step body through Actions' own shell, with a stub `node` that records every
 *  call it receives (readable back as `.calls`) and answers with a fake test summary by default,
 *  so a real, unstubbed invocation still exits 0 instead of hanging on a missing tool. */
function runStep(run: string, env: Record<string, string>, nodeStub: string = DEFAULT_NODE_STUB): { status: number | null; calls: string; out: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4406-`));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "x.test.ts"), "");
  const log = join(dir, "node-calls.log");
  writeFileSync(join(dir, "bin", "node"), nodeStub);
  chmodSync(join(dir, "bin", "node"), 0o755);
  // The GitHub runner uses Bash 5, while macOS ships Bash 3.2 without `mapfile`. Keep the
  // fixture's execution of the workflow body meaningful on the operator's host by providing the
  // Bash 4+ builtin's `-t` behavior only when the shell actually lacks it.
  writeFileSync(join(dir, "run.sh"), BASH_3_MAPFILE_SHIM ? `${BASH_3_MAPFILE_SHIM}\n${run}` : run);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "run.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      GITHUB_OUTPUT: join(dir, "outputs.txt"),
      RUNNER_TEMP: dir,
      CALL_LOG: log,
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { status: r.status, calls: read("node-calls.log"), out: r.stdout + r.stderr, dir };
}

// ── the merge group retains assurance without duplicating PR coverage ───────────────────────

test("W1-T4406/W1-T5940: the merge group retains required contexts without duplicating PR coverage", () => {
  assert.ok("merge_group" in doc.on, "ci.yml must declare a merge_group trigger");
  assert.equal(doc.on.merge_group, null, "merge_group must carry no types/path filter — INVARIANT 2");

  // Keep both registered event arms, and run the actual classifier before deciding whether
  // this group reaches coverage. Forcing SOURCE here would bypass the accepted skip policy.
  const coverageRun = findStep("coverage-ratchet", "Test with coverage").run!;
  assert.match(coverageRun, /"\$\{GITHUB_EVENT_NAME\}" = "pull_request" \]/, "the pull_request arm must survive untouched");
  assert.match(coverageRun, /"\$\{GITHUB_EVENT_NAME\}" = "merge_group" \]/, "merge_group must join it, not replace it");

  const classify = runStep(findStep("coverage-ratchet", "Determine this diff's coverage class").run!, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(classify.status, 0, classify.out);
  assert.match(readFileSync(join(classify.dir, "outputs.txt"), "utf8"), /^class=NO_SRC$/m);
  const coverageBody = coverageRun.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "NO_SRC");
  const merge = runStep(coverageBody, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(merge.status, 0, merge.out);
  assert.equal(merge.calls, "", "the real group's classification must skip a duplicate instrumented PR run");
  const sourcePrBody = coverageRun.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  const sourcePr = runStep(sourcePrBody, { GITHUB_EVENT_NAME: "pull_request" });
  // The recording stub reaches the real runner without producing LCOV, so the production
  // missing-coverage check still refuses. A source PR keeps its complete coverage owner.
  assert.notEqual(sourcePr.status, 0, sourcePr.out);
  assert.match(
    sourcePr.calls,
    new RegExp(`scripts\\/test-tier-manifest\\.mjs --select-all --shard 1/${CI_SHARD_COUNT} --base HEAD\\^1`),
    "a source PR must select its complete duration-balanced coverage shard",
  );
  assert.match(sourcePr.calls, /test-with-retry\.mjs --coverage-first-pass/, "a source PR must invoke the real instrumented test runner");

  // The control: an ordinary push still skips it — merge_group joined the guard, it did not
  // become "anything that is not pull_request".
  const push = runStep(coverageBody, { GITHUB_EVENT_NAME: "push" });
  assert.equal(push.status, 0, push.out);
  assert.equal(push.calls, "", "a plain push must still take the skip — it is not pull_request or merge_group");

  // coverage-ratchet-required's per-diff aggregation steps widen the same way: merge_group joins
  // pull_request, so the merge queue's own commit gets a real diff-coverage/ratchet verdict too.
  for (const name of [
    "Merge raw V8 coverage shards before assigning LCOV branch indexes",
    "Compute this PR's base...head diff (for the per-diff coverage check below)",
    "Diff coverage (blocks a PR that adds untested source lines, even when the aggregate floor below stays green)",
    "Coverage ratchet (blocks a PR whose branch coverage is below the absolute floor)",
  ]) {
    const run = findStep("coverage-ratchet-required", name).run!;
    assert.match(run, /"\$\{GITHUB_EVENT_NAME\}" = "pull_request" \]/, `${name} must keep its pull_request arm`);
    assert.match(run, /"\$\{GITHUB_EVENT_NAME\}" = "merge_group" \]/, `${name} must widen to merge_group`);
  }
  const artifactWhitelist = findStep("coverage-ratchet-required", "Require downloaded coverage shard artifacts").run!;
  assert.match(artifactWhitelist, /merge_group:SOURCE/, "the shard-class whitelist must accept a merge_group SOURCE marker");

  // test-slow carries no job-level `if:` at all (W1-T4396) and already treats "not pull_request"
  // as its full-suite lane — merge_group falls straight into that existing PUSH-shaped branch, so
  // the slow tier runs on the queue's own commit with no separate wiring or duplicated code.
  const establishRun = findStep("test-slow-shard", "Establish whether the exact plan-reading matrix owns this diff (W1-T3191)").run!;
  const established = runStep(establishRun, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(established.status, 0, established.out);
  const outputs = Object.fromEntries(
    readFileSync(join(established.dir, "outputs.txt"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.deepEqual(outputs, { class: "PUSH", established: "false" }, "merge_group falls into the same full-suite lane a push already takes");

  const runSlow = findStep("test-slow-shard", "Run the slow tier").run!.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.plan-reading.outputs.established }}", "false").replaceAll("${{ steps.plan-reading.outputs.class }}", "PUSH");
  const slow = runStep(runSlow, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(slow.status, 0, slow.out);
  assert.equal(
    slow.calls.trim(),
    "node scripts/test-with-retry.mjs node scripts/test-tier-manifest.mjs --run slow --shard 1/2 --base HEAD",
    "the merge queue's own commit must run the full slow tier through the failed-file retry, exactly like a push",
  );
});

// ── a pull request runs the selected suites ───────────────────────────────────────────────────

test("W1-T4406: a pull request runs the selected suites", () => {
  assert.equal(doc.env?.RMD_AFFECTED_SUITE_LIVE, "0", "the ONE FLAG must default off — no existing pull_request behavior may move yet");

  const testStep = findStep("ci", "Test").run!;
  const body = testStep.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");

  // Flag OFF (the default): byte-for-byte the pre-existing W1-T3207 skip, no live selection call.
  const off = runStep(body, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" });
  assert.equal(off.status, 0, off.out);
  assert.match(off.out, /W1-T3207: coverage-ratchet owns/);
  assert.doesNotMatch(off.calls, /--import tsx -e|--run fast|--run-candidates/, "flag off must reach neither the live selector nor a test runner");

  // W1-T5930: coverage owns both flag arms; CI does not add an uninstrumented floor.
  const on = runStep(body, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", RMD_AFFECTED_SUITE_LIVE: "1" });
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, /W1-T3207: coverage-ratchet owns/);
  assert.doesNotMatch(on.calls, /--import tsx -e|--run fast|--run-candidates/);

  // The live selector is a real, executable script (not a stub-only fiction): extract it from the
  // step body and run it for real against this very repo, proving it actually reaches
  // src/lib/affected-suites.ts's exported, shared selector (the same one `rmd preflight` uses).
  const script = /node --import tsx -e '\n([\s\S]*?)\n\s*' changed-files\.txt "\$\{RUNNER_TEMP\}\/affected\.diff" coverage-narrow-suites\.txt/.exec(findStep("squash-trailer-gate", "Pin one verified historical coverage floor before any narrowing").run!);
  assert.ok(script, "the live-selection step must invoke node --import tsx -e '<script>' changed-files.txt affected-suites-selected.txt");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4406-real-`));
  writeFileSync(join(dir, "changed.txt"), "docs/comment-standard.md\n");
  writeFileSync(join(dir, "diff.txt"), "");
  const real = spawnSync(process.execPath, ["--import", "tsx", "-e", script![1]!, join(dir, "changed.txt"), join(dir, "diff.txt"), join(dir, "out.txt")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: REPO_ROOT },
  });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /W1-T5705: live coverage selection ->/);
  assert.ok(existsSync(join(dir, "out.txt")), "the real selector must write its output file");
});
