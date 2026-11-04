/**
 * W1-T5930 — A SOURCE PR HAS ONE TEST VERDICT.
 *
 * W1-T5705 moved RMD_AFFECTED_SUITE_LIVE's narrowing into coverage-shard, where the cost is. The
 * older W1-T4406 arm in ci-shard's Test step still read the same flag: at "1" it ran the live
 * selector and turned CLASS into AFFECTED, so a SOURCE pull request got a broad uninstrumented
 * test run beside coverage's narrow instrumented one, and shards 2-8 kept their installs for it.
 *
 * Each case drives the REAL step bodies from .github/workflows/ci.yml through bash with stub
 * node/npm/npx that log every call, at both flag values, and runs the real admission CLI.
 *
 * FALSIFIER: restore the ci-shard live arm, so flag 1 reaches the selector and a runner — the
 * no-second-runner case fails. Drop the TEST_ONLY or helper-full branch — its positive control
 * fails. Restore `live !== '0'` in requiresSetup — the admission case fails at flag 1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; id?: string; run?: string };
type Job = { needs?: string | string[]; steps?: Step[] };
const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const testStep = doc.jobs.ci?.steps?.find((s) => s.name === "Test")?.run ?? "";
const FLAGS = ["0", "1"] as const;

// A node stub that answers each selector the Test step may call, so a reached runner is logged
// rather than refused: the assertions read the call log, never the stub's exit code.
const NODE_STUB = `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  *--import\\ tsx\\ -e*) printf 'test/x.test.ts\\n' > affected-suites-selected.txt ;;
  *--select-candidates*) cat "$3"; echo "test-tier-manifest: plan-reading shard summary candidate_count=1" >&2 ;;
  *) echo "# tests 1"; echo "# pass 1"; echo "# fail 0" ;;
esac
`;

function runTest(shard: string, env: Record<string, string>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-one-test-verdict-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "x.test.ts"), "");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "bin", "node"), NODE_STUB);
  for (const name of ["npm", "npx"]) writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\necho "${name} $*" >> "$CALL_LOG"\n`);
  for (const name of ["node", "npm", "npx"]) chmodSync(join(dir, "bin", name), 0o755);
  writeFileSync(join(dir, "changed-files.txt"), "src/lib/leaf.ts\n");
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  const body = testStep.replaceAll("${{ matrix.shard }}", shard).replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      CALL_LOG: log,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      RUNNER_TEMP: dir,
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("W1-T5930: SOURCE PR CI delegates its test verdict to coverage with either live flag without a second selector or test harness", () => {
  assert.ok(testStep, "ci must carry a Test step");
  for (const flag of FLAGS) {
    for (const shard of ["1", "2", "8"]) {
      const r = runTest(shard, { RMD_AFFECTED_SUITE_LIVE: flag });
      assert.equal(r.status, 0, r.out);
      assert.equal(r.calls, "", `flag ${flag}, shard ${shard}: a SOURCE PR must reach neither the live selector nor a test runner`);
      assert.match(r.out, /W1-T3207: coverage-ratchet owns the single instrumented test verdict/);
    }
  }
});

test("W1-T5930: changed-test and helper-full paths still execute at either live flag", () => {
  for (const flag of FLAGS) {
    const files = runTest("1", { RMD_AFFECTED_SUITE_LIVE: flag }, { "test-only-run.txt": "files\ntest/x.test.ts\n" });
    assert.equal(files.status, 0, files.out);
    assert.match(files.calls, /--select-candidates plan-reading-suites\.txt --shard 1\/8/, `flag ${flag}: a changed test must be selected`);
    assert.match(files.calls, /--run-candidates plan-reading-suites\.txt --shard 1\/8/, `flag ${flag}: a changed test must run`);
    assert.doesNotMatch(files.calls, /--import tsx -e/, `flag ${flag}: a changed test needs no live selector`);

    const full = runTest("1", { RMD_AFFECTED_SUITE_LIVE: flag }, { "test-only-run.txt": "full\n" });
    assert.equal(full.status, 0, full.out);
    assert.match(full.calls, /test-tier-manifest\.mjs --run fast --shard 1\/8/, `flag ${flag}: a helper change must run the full fast tier`);
    assert.doesNotMatch(full.out, /W1-T3207: coverage-ratchet owns/);
  }
});

test("W1-T5930: a push and a merge group keep their own runners at either live flag", () => {
  for (const flag of FLAGS) {
    const push = runTest("1", { RMD_AFFECTED_SUITE_LIVE: flag, GITHUB_EVENT_NAME: "push", GITHUB_BASE_REF: "" });
    assert.match(push.calls, /test-tier-manifest\.mjs --run fast --shard 1\/8/, `flag ${flag}: main's push lane must still run its shard`);

    const group = runTest("1", { RMD_AFFECTED_SUITE_LIVE: flag, GITHUB_EVENT_NAME: "merge_group", GITHUB_BASE_REF: "" }, {
      "merge-group-suites.txt": "test/x.test.ts\n",
    });
    assert.equal(group.status, 0, group.out);
    assert.match(group.calls, /--run-candidates plan-reading-suites\.txt --shard 1\/8/, `flag ${flag}: the merge group must run its selection`);
  }
});

test("W1-T5930: the real admission CLI keeps shards 2-8 idle on a SOURCE PR at either live flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-one-test-verdict-admission-"));
  const cli = join(REPO_ROOT, "scripts/ci-shard-admission.mjs");
  const admit = (files: string, shard: string, flag: string, event = "pull_request") => {
    writeFileSync(join(dir, "changed"), files);
    const r = spawnSync(process.execPath, [cli, "--changed-files", join(dir, "changed"), "--shard", shard], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: event, RMD_AFFECTED_SUITE_LIVE: flag },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  for (const flag of FLAGS) {
    for (let shard = 2; shard <= 8; shard++) assert.equal(admit("src/lib/leaf.ts\n", String(shard), flag), "false", `flag ${flag}, shard ${shard}`);
    assert.equal(admit("src/lib/leaf.ts\n", "1", flag), "true", `flag ${flag}: shard 1 keeps setup for typecheck and guard mutation`);
    assert.equal(admit("test/a.test.ts\n", "2", flag), "true", `flag ${flag}: a test diff is real work`);
    assert.equal(admit("test/setup/helper.ts\n", "2", flag), "true", `flag ${flag}: a helper diff is real work`);
    assert.equal(admit("src/lib/leaf.ts\n", "2", flag, "push"), "true", `flag ${flag}: a push runs every shard`);
  }
});

test("W1-T5930: the stable required aggregators stay present", () => {
  assert.deepEqual(doc.jobs["coverage-ratchet-required"]?.needs, ["coverage-ratchet", "coverage-ledger"]);
  assert.ok(doc.jobs["ci-required"], "ci-required must stay the ci matrix's required name");
  assert.ok(doc.jobs["ci-gate"], "ci-gate must stay");
});
