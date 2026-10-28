// W1-T10919. MEASURED on the site instance, 2026-10-27 19:07Z-19:38Z: PORTAL-T45 was rebuilt five times on a base
// whose vitest include (`tests/**/*.test.ts`) could not collect its declared `.test.tsx` test. Each run printed the TAP
// plan `1..0`, check-proof answered exit 3 (no-match), and the pre-open gate refused that as a plain re-dispatchable
// `branch-gap` that the breaker counted as the worker's miss. A rebuild on the same base can never pass: the runner's
// scope, not the work, is what changed nothing. These cases drive the real check-proof, the real opener (through
// runTask's daemon entry), the real strike classifier and the real W1-T3959 hold reader.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkProofCommand, runnerLoadedNoTestFile } from "#src/lib/check-proof.js";
import { readBreakerStrikes } from "#src/lib/breaker-release.js";
import {
  preDispatchContractRevision,
  runnerConfigDigest,
  terminalPreDispatchRefusalRevisions,
  writePriorRefusal,
} from "#src/lib/dispatch-repair.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import { nonWorkerVerdictClass } from "#src/lib/stranded-task-detector.js";
import type { Task } from "#src/lib/plan.js";
import * as prOpen from "#src/lib/pr-open.js";
import * as runTask from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const BRANCH = "run-W1-T9-1";
const PROOF = "grep: marker in note.md";

/** A checkout on run branch run-W1-T9-1 whose plan files one proof, origin/main a commit behind HEAD, with a vitest config. */
function filedRunBranch(t: TestContext): string {
  const repo = gitRepo({ kind: "collected-nothing-open", scope: t });
  mkdirSync(join(repo.dir, "plan"));
  const plan = ["- id: W1-T9", "  title: fixture", "  repo: remudero", "  type: implement", "  acceptance:"];
  plan.push("    - claim: the fixture claim", `      proof: ${JSON.stringify(PROOF)}`);
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), `${plan.join("\n")}\n`);
  writeFileSync(join(repo.dir, "vitest.config.mjs"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  writeFileSync(join(repo.dir, "note.md"), "marker\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: change");
  return repo.dir;
}

/** An async proof runner that answers every call with check-proof's exit `status` and report `stdout`. */
const answering = (status: number, stdout: string): prOpen.AsyncOpenPullRequestProofRunner =>
  async () => ({ status, signal: null, stdout, stderr: "" });

const openAsDaemon = (dir: string, runner: prOpen.AsyncOpenPullRequestProofRunner) =>
  withLiveWritesAllowed(() => runTask.ghPrCreateFillCommandAsync(dir, "o", "r", BRANCH, "feat(x): a subject", runner, true));

/** A Vitest-shaped checkout whose include reaches only `.test.ts`, its one test a `.test.tsx` file, and a pinned
 *  runner that, like the real one, loads no file its include does not reach. */
function vitestCheckout(t: TestContext): string {
  const repo = gitRepo({ kind: "collected-nothing-vitest", scope: t });
  mkdirSync(join(repo.dir, "tests", "unit"), { recursive: true });
  mkdirSync(join(repo.dir, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(repo.dir, "vitest.config.mjs"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
  writeFileSync(join(repo.dir, "tests", "unit", "timeline.test.tsx"),
    'describe("X-T1", () => { it("leaf title", () => {}); });\n');
  writeFileSync(join(repo.dir, "node_modules", "vitest", "vitest.mjs"),
    'process.stdout.write("TAP version 13\\n1..0\\n");\n');
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  return repo.dir;
}

function runCheckProof(t: TestContext, dir: string, args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); });
  t.mock.method(process, "cwd", () => dir);
  const code = checkProofCommand(args, { pathStatus: () => "" });
  t.mock.restoreAll();
  return { code, out: lines.join("\n") };
}

test("W1-T10919: a proof whose title is in a head test file but collects zero tests refuses as proof-collected-nothing", async (t) => {
  const site = vitestCheckout(t);
  const { code, out } = runCheckProof(t, site, ["unit test:", "X-T1: leaf title", "--repo", "craigoley/remudero-console"]);
  assert.equal(code, 3, `check-proof keeps its no-match exit for every caller: ${out}`);
  assert.match(out, /^cause:\s+collected-nothing\b/m, out);
  assert.ok(out.includes("tests/unit/timeline.test.tsx"), `the cause names the file holding the title: ${out}`);
  assert.ok(out.includes("tests/**/*.test.ts"), `the cause names the runner's include: ${out}`);

  const dir = filedRunBranch(t);
  await assert.rejects(
    () => openAsDaemon(dir, answering(3, out)),
    (err: unknown) => {
      assert.ok(err instanceof prOpen.PrOpenRefusedError);
      assert.equal(err.refusalClass, "proof-collected-nothing");
      assert.ok(err.message.includes("tests/unit/timeline.test.tsx"), err.message);
      assert.ok(err.message.includes("tests/**/*.test.ts"), err.message);
      assert.match(err.runnerConfigDigest ?? "", /^[0-9a-f]{64}$/, "the refusal records what the runner read");
      assert.equal(err.runnerConfigDigest, runnerConfigDigest(dir, "HEAD"));
      return true;
    },
  );
});

test("W1-T10919: a zero-collected run is classified for both vitest and node --test", () => {
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..0\n"), true, "vitest TAP plan 1..0");
  assert.equal(runnerLoadedNoTestFile("", "No test files found, exiting with code 1\n"), true, "vitest's own words");
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n"), true, "node --test, no file");
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n# tests 0\n# pass 0\n"), true, "node --test, # tests 0 and no wrapper");
  // A runner that LOADED its file and matched no title still prints the file's wrapper: that is the worker's miss.
  assert.equal(runnerLoadedNoTestFile("TAP version 13\nok 1 - test/a.test.ts\n  ---\n  duration_ms: 1\n  ...\n1..1\n# tests 1\n"), false);
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..1\nok 1 - tests/unit/a.test.ts {\n    1..1\n    ok 1 - x # SKIP\n}\n"), false);
  assert.equal(runnerLoadedNoTestFile(""), false, "no output at all is not evidence of an empty scope");
});

test("W1-T10919: a proof whose title is in no file still refuses as branch-gap", async (t) => {
  const site = vitestCheckout(t);
  // The same empty-scope runner, but no file holds this title: nothing names a file the runner failed to reach.
  const { code, out } = runCheckProof(t, site, ["unit test:", "X-T9: no such leaf", "--repo", "craigoley/remudero-console"]);
  assert.equal(code, 3, out);
  assert.doesNotMatch(out, /^cause:\s+collected-nothing/m, out);
  const dir = filedRunBranch(t);
  await assert.rejects(
    () => openAsDaemon(dir, answering(3, out)),
    (err: unknown) => {
      assert.ok(err instanceof prOpen.PrOpenRefusedError);
      assert.equal(err.refusalClass, "branch-gap");
      assert.equal(err.runnerConfigDigest, undefined);
      return true;
    },
  );
});

function refusedRow(runId: string, taskId: string, refusalClass: string): Record<string, unknown> {
  return {
    ts: "2026-10-27T19:10:00Z", step: "verdict", task_id: taskId, run_id: runId, verdict: "failed",
    reason: "openPullRequestChecked: PORTAL-T45 proof did not pass against merge base", stage: "pr_open.refused",
    cause: "base-proof-refused", refusal_class: refusalClass,
  };
}

test("W1-T10919: a proof-collected-nothing refusal is a non-worker strike", () => {
  const taskId = "PORTAL-T45";
  const row = refusedRow("r1", taskId, "proof-collected-nothing");
  assert.equal(streakRefusal(row), "proof_collected_nothing");
  const reading = readBreakerStrikes([
    { ts: "2026-10-27T19:07:00Z", step: "run.start", task_id: taskId, run_id: "r1" },
    row,
  ], taskId);
  assert.deepEqual(reading.strikes, [{ runId: "r1", cause: "proof_collected_nothing" }]);
  assert.equal(reading.counted, 0, "the breaker does not count a refusal the runner's scope caused");
  assert.equal(nonWorkerVerdictClass(row), "proof_collected_nothing", "named as the runner's scope, never a toolchain fault");
  // A real miss is unchanged: still the worker's strike.
  assert.equal(streakRefusal(refusedRow("r2", taskId, "branch-gap")), undefined);
  assert.equal(streakRefusal({ ...row, stage: "implement.preopen_continued" }), undefined, "only the pr_open.refused stage is read");
});

const TASK: Task = {
  id: "PORTAL-T45", title: "a timeline", repo: "remudero-site", type: "implement", verify: "auto", risk: "medium",
  attempts: 0, depends_on: [], status: "queued",
} as Task;

test("W1-T10919: a collected-nothing task waits for a runner-config or shard change, then dispatches", (t) => {
  // The REAL digest: two commits on a real checkout, so the default `git ls-tree` seam is exercised, not faked.
  const site = gitRepo({ kind: "collected-nothing-digest", scope: t });
  writeFileSync(join(site.dir, "vitest.config.mjs"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
  writeFileSync(join(site.dir, "README.md"), "a\n");
  site.git("add", "-A");
  site.git("commit", "-q", "-m", "seed");
  const before = runnerConfigDigest(site.dir, "HEAD");
  assert.match(before ?? "", /^[0-9a-f]{64}$/);
  writeFileSync(join(site.dir, "README.md"), "b\n");
  site.git("commit", "-qam", "an unrelated merge");
  assert.equal(runnerConfigDigest(site.dir, "HEAD"), before, "an unrelated merge leaves the runner's scope unchanged");
  writeFileSync(join(site.dir, "vitest.config.mjs"), 'export default { test: { include: ["tests/**/*.test.{ts,tsx}"] } };\n');
  site.git("commit", "-qam", "widen the include, as PORTAL-T44 did");
  const after = runnerConfigDigest(site.dir, "HEAD");
  assert.notEqual(after, before, "a runner-config change moves the digest");
  assert.equal(runnerConfigDigest(site.dir, "no-such-rev"), undefined, "an unreadable tree is no reading");

  const state = gitRepo({ kind: "collected-nothing-state", scope: t, seedCommit: false }).dir;
  writePriorRefusal(state, TASK.id, {
    verdict: "proof-collected-nothing: tests/unit/timeline.test.tsx (tests/**/*.test.ts)",
    attempts: 1,
    escalated: true,
    preDispatchContractRevision: preDispatchContractRevision(TASK),
    runnerConfigDigest: before!,
  });
  let reads = 0;
  const reading = (digest: string | undefined) => () => { reads += 1; return digest; };
  const held = terminalPreDispatchRefusalRevisions(state, reading(before));
  assert.equal(held.get(TASK.id), preDispatchContractRevision(TASK), "held while the shard and runner scope are unchanged");
  assert.equal(reads, 1, "main's runner digest is read once per pass");
  assert.equal(terminalPreDispatchRefusalRevisions(state, reading(after)).has(TASK.id), false, "main moved the runner config: dispatchable");
  assert.equal(terminalPreDispatchRefusalRevisions(state, reading(undefined)).has(TASK.id), false, "an unreadable digest fails open");
  assert.equal(terminalPreDispatchRefusalRevisions(state).has(TASK.id), false, "no reader is no evidence the scope is unchanged");
  const amended = { ...TASK, title: "a timeline, amended" } as Task;
  assert.notEqual(held.get(TASK.id), preDispatchContractRevision(amended), "an amended shard is dispatchable");

  // A record with no digest (W1-T3959's own shape) is held exactly as before, without reading main at all.
  writePriorRefusal(state, TASK.id, {
    verdict: "[sizing] a refusal", attempts: 1, escalated: true, preDispatchContractRevision: preDispatchContractRevision(TASK),
  });
  reads = 0;
  assert.equal(terminalPreDispatchRefusalRevisions(state, reading(after)).get(TASK.id), preDispatchContractRevision(TASK));
  assert.equal(reads, 0, "no record carries a digest, so main is not read");
});
