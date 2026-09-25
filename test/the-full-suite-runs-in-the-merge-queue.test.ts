/**
 * W1-T4406 — the full suite runs in the merge queue, not on every push.
 *
 * ci.yml gained a THIRD trigger, `merge_group` (GitHub's merge-queue event, W1-T4405 made
 * auto-merge queue-aware): `coverage-ratchet` (the instrumented full suite) and `test-slow` now
 * run their real work on the queue's own commit — the exact tree about to land — alongside the
 * pre-existing `pull_request`/`push` behavior, unchanged and separately covered by
 * test/push-ci-on-main.test.ts, test/workflow-single-suite-run.test.ts and
 * test/the-slow-tier-runs-on-main.test.ts.
 *
 * A pull request runs the SELECTED suites through a flag this task also builds: `ci`'s Test step
 * can now run the live W1-T4404 selector (src/lib/affected-suites.ts) instead of deferring a
 * SOURCE diff to coverage-ratchet's full run. The switch is ONE FLAG
 * (`RMD_AFFECTED_SUITE_LIVE`, this workflow's own top-level env), default "0" per design note (iv)
 * — every pull_request behavior the tests above already pin stays byte-for-byte unchanged until
 * the W1-T4404 shadow record earns the flip. Both arms of that flag are driven here, through the
 * REAL step body, so a later default flip is a one-line change with no new test to write.
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

// ── the merge group runs the full instrumented suite ─────────────────────────────────────────

test("W1-T4406: the merge group runs the full instrumented suite", () => {
  assert.ok("merge_group" in doc.on, "ci.yml must declare a merge_group trigger");
  assert.equal(doc.on.merge_group, null, "merge_group must carry no types/path filter — INVARIANT 2");

  // coverage-ratchet's real work now fires for merge_group ALONGSIDE pull_request — never instead
  // of it, so every pull_request-scoped assertion elsewhere in the tree keeps holding.
  const coverageRun = findStep("coverage-ratchet", "Test with coverage").run!;
  assert.match(coverageRun, /"\$\{GITHUB_EVENT_NAME\}" = "pull_request" \]/, "the pull_request arm must survive untouched");
  assert.match(coverageRun, /"\$\{GITHUB_EVENT_NAME\}" = "merge_group" \]/, "merge_group must join it, not replace it");

  const coverageBody = coverageRun.replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  const merge = runStep(coverageBody, { GITHUB_EVENT_NAME: "merge_group" });
  // The stub never produces a real lcov, so the step still fails at its own "no lcov" check —
  // exactly like test/workflow-single-suite-run.test.ts's identical control for pull_request. A
  // non-zero exit here still proves the real instrumented runner was REACHED, not skipped.
  assert.notEqual(merge.status, 0, merge.out);
  assert.match(
    merge.calls,
    new RegExp(`scripts\\/test-tier-manifest\\.mjs --select-all --shard 1/${CI_SHARD_COUNT} --base HEAD\\^1`),
    "a merge_group SOURCE run must select its complete duration-balanced coverage shard, exactly like a pull_request run",
  );
  assert.match(merge.calls, /test-with-retry\.mjs --coverage-first-pass/, "a merge_group run must invoke the real instrumented test runner");

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
  const establishRun = findStep("test-slow", "Establish whether the exact plan-reading matrix owns this diff (W1-T3191)").run!;
  const established = runStep(establishRun, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(established.status, 0, established.out);
  const outputs = Object.fromEntries(
    readFileSync(join(established.dir, "outputs.txt"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.deepEqual(outputs, { class: "PUSH", established: "false" }, "merge_group falls into the same full-suite lane a push already takes");

  const runSlow = findStep("test-slow", "Run the slow tier").run!.replaceAll("${{ steps.plan-reading.outputs.established }}", "false").replaceAll("${{ steps.plan-reading.outputs.class }}", "PUSH");
  const slow = runStep(runSlow, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(slow.status, 0, slow.out);
  assert.equal(
    slow.calls.trim(),
    "node scripts/test-with-retry.mjs node scripts/test-tier-manifest.mjs --run slow --base HEAD",
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

  // Flag ON, selector narrows: the live selection is fed through the SAME candidate-shard
  // machinery the plan-reading lane already uses, and the old skip never fires.
  const narrowStub = `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  *--import\\ tsx\\ -e*) printf 'test/x.test.ts\\n' > affected-suites-selected.txt; echo "W1-T4406: live selection for 1 changed file(s) -> 1 suite(s)" ;;
  *--select-candidates*) cat "$3"; echo "test-tier-manifest: plan-reading shard summary candidate_count=1" >&2 ;;
  *) echo "# tests 1"; echo "# pass 1"; echo "# fail 0" ;;
esac
`;
  const narrow = runStep(body, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", RMD_AFFECTED_SUITE_LIVE: "1" }, narrowStub);
  assert.equal(narrow.status, 0, narrow.out);
  assert.doesNotMatch(narrow.out, /W1-T3207: coverage-ratchet owns/, "flag on must not take the coverage-owns-it skip");
  assert.match(narrow.calls, /--import tsx -e/, "flag on must invoke the live W1-T4404 selector");
  assert.equal(readFileSync(join(narrow.dir, "plan-reading-suites.txt"), "utf8").trim(), "test/x.test.ts", "the selector's own suite list must feed the candidate runner");
  assert.match(
    narrow.calls,
    new RegExp(`test-tier-manifest\\.mjs --run-candidates plan-reading-suites\\.txt --shard 1/${CI_SHARD_COUNT}`),
    "the selected suite(s) must run through the ci matrix's own shard denominator",
  );

  // Flag ON, selector says fullRun (a config/lockfile/workflow/helper change): CLASS stays SOURCE
  // and the ordinary full fast tier runs, exactly as design note (ii) requires.
  const fullStub = `#!/usr/bin/env bash
echo "node $*" >> "$CALL_LOG"
case "$*" in
  *--import\\ tsx\\ -e*) printf 'full\\n' > affected-suites-selected.txt; echo "W1-T4406: live selection -> FULL" ;;
  *) echo "# tests 1"; echo "# pass 1"; echo "# fail 0" ;;
esac
`;
  const full = runStep(body, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", RMD_AFFECTED_SUITE_LIVE: "1" }, fullStub);
  assert.equal(full.status, 0, full.out);
  assert.doesNotMatch(full.out, /W1-T3207: coverage-ratchet owns/);
  assert.match(full.calls, new RegExp(`test-tier-manifest\\.mjs --run fast --shard 1/${CI_SHARD_COUNT}`), "a fullRun verdict must still run the ordinary full fast tier, never a narrowed one");
  assert.doesNotMatch(full.calls, /--run-candidates/);

  // The live selector is a real, executable script (not a stub-only fiction): extract it from the
  // step body and run it for real against this very repo, proving it actually reaches
  // src/lib/affected-suites.ts's exported, shared selector (the same one `rmd preflight` uses).
  const script = /node --import tsx -e '\n([\s\S]*?)\n\s*' changed-files\.txt affected-suites-selected\.txt/.exec(testStep);
  assert.ok(script, "the live-selection step must invoke node --import tsx -e '<script>' changed-files.txt affected-suites-selected.txt");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4406-real-`));
  writeFileSync(join(dir, "changed.txt"), "docs/comment-standard.md\n");
  const real = spawnSync(process.execPath, ["--import", "tsx", "-e", script![1]!, join(dir, "changed.txt"), join(dir, "out.txt")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: REPO_ROOT },
  });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /W1-T4406: live selection for 1 changed file\(s\)/);
  assert.ok(existsSync(join(dir, "out.txt")), "the real selector must write its output file");
});
