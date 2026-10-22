import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL(".github/workflows/ci.yml", __workspaceRootUrl), "utf8"));
const body = workflow.jobs.ci.steps.find((step: { name: string }) => step.name === "Test").run
  .replaceAll("${{ matrix.shard }}", "2").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");

function run(flag: string, event = "pull_request", testOnly = "", runnerExit = 0, mergeSelection?: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-single-verdict-"));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/a.test.ts"), "");
    writeFileSync(join(root, "test/first.test.ts"), "");
    writeFileSync(join(root, "test/last.test.ts"), "");
    writeFileSync(join(root, "changed-files.txt"), "src/a.ts\n");
    writeFileSync(join(root, "test-only-run.txt"), testOnly);
    if (mergeSelection !== undefined) writeFileSync(join(root, "merge-group-suites.txt"), mergeSelection);
    const node = join(root, "bin/node");
    writeFileSync(node, `#!/usr/bin/env bash
echo "$*" >> "$CALL_LOG"
case "$*" in
  *--import\\ tsx\\ -e*) echo test/a.test.ts > affected-suites-selected.txt ;;
  *--select-candidates*) cat "$3"; echo 'test-tier-manifest: plan-reading shard summary candidate_count=1' >&2 ;;
  *) echo '# tests 1'; echo '# pass 1'; echo '# fail 0'; exit ${runnerExit} ;;
esac
`);
    chmodSync(node, 0o755);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALL_LOG: join(root, "calls"),
        GITHUB_EVENT_NAME: event, GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: join(root, "summary"),
        RUNNER_TEMP: root, RMD_AFFECTED_SUITE_LIVE: flag, RENAME_ONLY: "false" },
    });
    return { status: result.status, output: result.stdout + result.stderr,
      selectedCandidates: existsSync(join(root, "plan-reading-suites.txt")) ? readFileSync(join(root, "plan-reading-suites.txt"), "utf8") : "",
      calls: existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("test/ci/parity/a-source-pr-has-one-test-verdict.test.ts: W1-T5930: SOURCE PRs keep one instrumented test owner with either flag", () => {
  for (const flag of ["0", "1"]) {
    const result = run(flag);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /W1-T3207: coverage-ratchet owns/);
    assert.equal(result.calls, "", "SOURCE CI must invoke neither a second selector nor a test harness");
  }
  assert.equal(workflow.env.RMD_AFFECTED_SUITE_LIVE, "0", "qualification stays a separate change");
  assert.equal(workflow.jobs["ci-required"].name, "ci");
  assert.equal(workflow.jobs["coverage-ratchet-required"].name, "coverage-ratchet");
  assert.deepEqual(workflow.jobs["coverage-ratchet-required"].needs, ["coverage-ratchet", "coverage-ledger"],
    "the required aggregator retains both the instrumented shards and the immutable ledger producer");
  assert.match(workflow.jobs["coverage-ratchet-required"].steps[0].run, /case .*SHARD_RESULT/);
});

test("W1-T5930: test-only and helper-full work survives single ownership", () => {
  for (const flag of ["0", "1"]) {
    const changedTest = run(flag, "pull_request", "files\ntest/a.test.ts\n");
    assert.equal(changedTest.status, 0, changedTest.output);
    assert.match(changedTest.calls, /--select-candidates plan-reading-suites.txt/);
    assert.match(changedTest.calls, /test-with-retry.mjs node scripts\/test-tier-manifest.mjs --run-candidates/);
    const helper = run(flag, "pull_request", "full\n");
    assert.equal(helper.status, 0, helper.output);
    assert.match(helper.calls, /test-with-retry.mjs node scripts\/test-tier-manifest.mjs --run fast/);
    assert.equal(run(flag, "pull_request", "full\n", 7).status, 7, "the helper suite's failure must propagate");
    const queue = run(flag, "merge_group");
    assert.equal(queue.status, 0, queue.output);
    assert.match(queue.calls, /--run fast/, "merge-group integration retains its full test path");
  }
});

test("W1-T5930: accepted merge-group candidates survive single source ownership", () => {
  const selected = "test/first.test.ts\ntest/last.test.ts\n";
  for (const flag of ["0", "1"]) {
    const group = run(flag, "merge_group", "", 0, selected);
    assert.equal(group.status, 0, group.output);
    assert.equal(group.selectedCandidates, selected, "the actual candidate lane must consume the accepted group's complete selection");
    assert.match(group.calls, /--select-candidates plan-reading-suites\.txt/);
    assert.match(group.calls, /--run-candidates plan-reading-suites\.txt/);
    assert.doesNotMatch(group.calls, /--list-plan-reading-suites|--run fast/);
    assert.equal(run(flag, "merge_group", "", 7, selected).status, 7, "selected integration failures must propagate");
    for (const fallback of [undefined, "", "full\n"]) {
      const full = run(flag, "merge_group", "", 0, fallback);
      assert.equal(full.status, 0, full.output);
      assert.match(full.calls, /--run fast/, "an unusable group selection retains the complete fast-tier fallback");
    }
  }
});

test("W1-T5930: the real admission CLI keeps idle source setup off with either coverage flag", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-single-owner-admission-"));
  try {
    const files = join(root, "files");
    const source = "src/lib/leaf.ts\n";
    const script = new URL("scripts/ci-shard-admission.mjs", __workspaceRootUrl).pathname;
    const runAdmission = (shard: string, event: string, flag: string) => spawnSync(process.execPath,
      [script, "--changed-files", files, "--shard", shard], { encoding: "utf8", timeout: 10_000,
        env: { ...process.env, GITHUB_EVENT_NAME: event, RMD_AFFECTED_SUITE_LIVE: flag } });
    for (const flag of ["0", "1"]) {
      writeFileSync(files, source);
      for (let shard = 1; shard <= 8; shard++) {
        const result = runAdmission(String(shard), "pull_request", flag);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), shard === 1 ? "true" : "false", "shard 1 retains typecheck; idle shards install nothing");
      }
      for (const event of ["push", "merge_group"]) {
        assert.equal(runAdmission("2", event, flag).stdout.trim(), "true");
      }
      for (const input of ["test/a.test.ts\n", "test/helpers/a.ts\n", ""]) {
        writeFileSync(files, input);
        const result = runAdmission("2", "pull_request", flag);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "true", `real work and uncertain input keep setup: ${input}`);
      }
      writeFileSync(files, ".github/workflows/ci.yml\n");
      assert.equal(runAdmission("1", "pull_request", flag).stdout.trim(), "true", "shard 1 keeps workflow guard tests");
      assert.equal(runAdmission("2", "pull_request", flag).stdout.trim(), "false", "the workflow diff keeps its existing single CI guard owner");
      rmSync(files);
      assert.equal(runAdmission("2", "pull_request", flag).stdout.trim(), "true", "unreadable input keeps setup");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
