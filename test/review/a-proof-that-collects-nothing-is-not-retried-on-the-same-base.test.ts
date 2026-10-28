// W1-T10919. MEASURED on the site instance, 2026-10-27 19:07Z-19:38Z: PORTAL-T45 was rebuilt five times on a base
// whose vitest include (`tests/**/*.test.ts`) could not collect its declared `.test.tsx` test. Each run printed the TAP
// plan `1..0`, check-proof answered exit 3 (no-match), and the pre-open gate refused that as a plain re-dispatchable
// `branch-gap` that the breaker counted as the worker's miss. A rebuild on the same base can never pass: the runner's
// scope, not the work, is what changed nothing. These cases drive the real check-proof, the real opener (through
// runTask's daemon entry), the real strike classifier and the real W1-T3959 hold reader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkProofCommand, runnerLoadedNoTestFile, vitestIncludeOf } from "#src/lib/check-proof.js";
import { readBreakerStrikes } from "#src/lib/breaker-release.js";
import {
  preDispatchContractRevision,
  RUNNER_CONFIG_PATHS,
  runnerConfigDigest,
  terminalPreDispatchRefusalRevisions,
  writePriorRefusal,
} from "#src/lib/dispatch-repair.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import { nonWorkerVerdictClass } from "#src/lib/stranded-task-detector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import * as prOpen from "#src/lib/pr-open.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const BRANCH = "run-W1-T9-1";
const PROOF = "grep: marker in note.md";

/** A checkout on run branch run-W1-T9-1 whose plan files one proof, origin/main a commit behind HEAD, with a vitest config. */
function filedRunBranch(t: TestContext): GitRepo {
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
  return repo;
}

/** gitRepo trims stdout; restore ls-tree's final newline before hashing its literal listing. */
function treeDigest(repo: GitRepo, ref: string): string {
  const listing = repo.git("ls-tree", ref, "--", ...RUNNER_CONFIG_PATHS);
  return createHash("sha256").update(listing ? `${listing}\n` : "").digest("hex");
}

/** An async proof runner that answers every call with check-proof's exit `status` and report `stdout`. */
const answering = (status: number, stdout: string): prOpen.AsyncOpenPullRequestProofRunner =>
  async () => ({ status, signal: null, stdout, stderr: "" });

/** The daemon's opener entry: the proofs pre-run off the loop, then the same synchronous checks. */
const openAsDaemon = (dir: string, runner: prOpen.AsyncOpenPullRequestProofRunner) =>
  withLiveWritesAllowed(() => prOpen.openPullRequestCheckedAsync("", BRANCH, dir, "origin/main", runner));

/** A Vitest-shaped checkout whose include reaches only `.test.ts`, its one test a `.test.tsx` file, and a pinned
 *  runner that, like the real one, loads no file its include does not reach. */
function vitestCheckout(t: TestContext): string {
  const repo = gitRepo({ kind: "collected-nothing-vitest", scope: t });
  mkdirSync(join(repo.dir, "tests", "unit"), { recursive: true });
  mkdirSync(join(repo.dir, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(repo.dir, "vitest.config.cts"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
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

  const repo = filedRunBranch(t);
  const dir = repo.dir;
  const expectedDigest = treeDigest(repo, "HEAD");
  writeFileSync(join(dir, "vitest.config.mjs"), 'export default { test: { include: ["dirty/**/*.test.tsx"] } };\n');
  await assert.rejects(
    () => openAsDaemon(dir, answering(3, out)),
    (err: unknown) => {
      assert.ok(err instanceof prOpen.PrOpenRefusedError);
      assert.equal(err.refusalClass, "proof-collected-nothing");
      assert.ok(err.message.includes("tests/unit/timeline.test.tsx"), err.message);
      assert.ok(err.message.includes("tests/**/*.test.ts"), err.message);
      assert.match(err.runnerConfigDigest ?? "", /^[0-9a-f]{64}$/, "the refusal records what the runner read");
      assert.equal(err.runnerConfigDigest, expectedDigest, "the refusal hashes HEAD's literal ls-tree output, not dirty files");
      return true;
    },
  );
});

test("W1-T10919: every vitest config and workspace variant can supply the include diagnostic", (t) => {
  for (const name of RUNNER_CONFIG_PATHS.filter((path) => path.startsWith("vitest."))) {
    const { dir } = ownedFixtureDir(t, "collected-nothing-config");
    writeFileSync(join(dir, name), 'export default { test: { include: ["tests/**/*.test.tsx"] } };\n');
    assert.equal(vitestIncludeOf(dir), '["tests/**/*.test.tsx"]', name);
  }
});

test("W1-T10919: a zero-collected run is classified for both vitest and node --test", () => {
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..0\n"), true, "vitest TAP plan 1..0");
  assert.equal(runnerLoadedNoTestFile("", "No test files found, exiting with code 1\n"), true, "vitest's own words");
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n"), true, "node --test, no file");
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n# tests 0\n# pass 0\n"), true, "node --test, # tests 0 and no wrapper");
  // A runner that LOADED its file and matched no title still prints the file's wrapper: that is the worker's miss.
  // Node 24's real zero-match report, captured 2026-10-28: the file's own empty `1..0` plan sits UNINDENTED above
  // its wrapper, so the wrapper, not the plan, is what tells a loaded file from an empty scope.
  const nodeZeroMatch = "TAP version 13\n1..0\n# Subtest: a.test.mjs\nok 1 - a.test.mjs\n  ---\n  duration_ms: 32.48\n" +
    "  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n";
  assert.equal(runnerLoadedNoTestFile(nodeZeroMatch), false);
  assert.equal(runnerLoadedNoTestFile("TAP version 13\n1..1\nok 1 - tests/unit/a.test.ts {\n    1..1\n    ok 1 - x # SKIP\n}\n"), false);
  assert.equal(runnerLoadedNoTestFile(""), false, "no output at all is not evidence of an empty scope");
});

test("W1-T10919: a proof whose title is in no file still refuses as branch-gap", async (t) => {
  const site = vitestCheckout(t);
  // The same empty-scope runner, but no file holds this title: nothing names a file the runner failed to reach.
  const { code, out } = runCheckProof(t, site, ["unit test:", "X-T9: no such leaf", "--repo", "craigoley/remudero-console"]);
  assert.equal(code, 3, out);
  assert.doesNotMatch(out, /^cause:\s+collected-nothing/m, out);
  const { dir } = filedRunBranch(t);
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
  const origin = gitRepo({ kind: "collected-nothing-origin", scope: t });
  const config = 'export default { test: { include: ["tests/**/*.test.ts"] } };\n';
  writeFileSync(join(origin.dir, "vitest.config.cts"), config);
  writeFileSync(join(origin.dir, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
  origin.git("add", "-A");
  origin.git("commit", "-qm", "chore: runner scope");
  const site = gitRepo({ kind: "collected-nothing-consumer", cloneFrom: origin.dir, scope: t });
  const before = runnerConfigDigest(site.dir);
  assert.equal(before, treeDigest(site, "HEAD"), "the identity is the SHA256 of the literal Git listing");

  const { dir: state } = ownedFixtureDir(t, "collected-nothing-state");
  const prior = {
    verdict: "proof-collected-nothing: tests/unit/timeline.test.tsx (tests/**/*.test.ts)",
    attempts: 1,
    escalated: true,
    preDispatchContractRevision: preDispatchContractRevision(TASK),
    runnerConfigDigest: before!,
  };
  const ids = [TASK.id, "PORTAL-T46"];
  for (const id of ids) writePriorRefusal(state, id, prior);
  let reads = 0;
  const reading = () => { reads += 1; return runnerConfigDigest(site.dir, "origin/main"); };
  const candidates = (held: ReadonlyMap<string, string>, task = TASK) => {
    const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) };
    const filtered: string[] = [];
    const tasks = runnableCandidates(plan, () => false, 1, {
      isTerminalPreDispatchRefusalHeld: (candidate) => held.get(candidate.id) === preDispatchContractRevision(candidate),
      onFiltered: (_task, reason) => { filtered.push(reason); },
    });
    return { tasks: tasks.map((candidate) => candidate.id), filtered };
  };
  const held = terminalPreDispatchRefusalRevisions(state, reading);
  assert.equal(held.get(TASK.id), preDispatchContractRevision(TASK), "held while the shard and runner scope are unchanged");
  assert.equal(reads, 1, "two records read main's runner digest once per pass");
  assert.deepEqual(candidates(held), { tasks: [], filtered: ["held-pre-dispatch-refusal"] });
  assert.deepEqual(candidates(held, { ...TASK, title: "a timeline, amended" }), { tasks: [TASK.id], filtered: [] },
    "an amended shard dispatches without operator release");

  writeFileSync(join(origin.dir, "README.md"), "unrelated merge\n");
  origin.git("add", "-A");
  origin.git("commit", "-qm", "docs: unrelated change");
  site.git("fetch", "-q", "origin");
  assert.equal(reading(), before, "an unrelated merge does not change runner scope");
  assert.deepEqual(candidates(terminalPreDispatchRefusalRevisions(state, reading)).tasks, []);

  writeFileSync(join(site.dir, "vitest.config.cts"), 'export default { test: { include: ["dirty/**/*.test.tsx"] } };\n');
  site.git("add", "vitest.config.cts");
  assert.equal(runnerConfigDigest(site.dir), before, "staged working files cannot change HEAD's refusal identity");
  assert.deepEqual(candidates(terminalPreDispatchRefusalRevisions(state, reading)).tasks, [],
    "local config edits cannot release a hold against unchanged main");
  site.git("reset", "--hard", "HEAD");

  writeFileSync(join(origin.dir, "vitest.config.cts"), 'export default { test: { include: ["tests/**/*.test.{ts,tsx}"] } };\n');
  origin.git("add", "-A");
  origin.git("commit", "-qm", "fix: widen runner scope");
  site.git("fetch", "-q", "origin");
  assert.equal(readFileSync(join(site.dir, "vitest.config.cts"), "utf8"), config, "fetch leaves the consumer's checkout stale");
  assert.equal(runnerConfigDigest(site.dir), before, "the run's HEAD still reads its original tree");
  assert.equal(reading(), treeDigest(site, "origin/main"));
  assert.notEqual(reading(), before, "the production reader sees the config-only main change");
  assert.deepEqual(candidates(terminalPreDispatchRefusalRevisions(state, reading)), { tasks: [TASK.id], filtered: [] },
    "the next selection dispatches without an operator release or checkout reset");

  const errors: string[] = [];
  t.mock.method(console, "error", (message: unknown) => { errors.push(String(message)); });
  site.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.deepEqual(candidates(terminalPreDispatchRefusalRevisions(state, reading)).tasks, [TASK.id], "a failed tree read fails open");
  assert.ok(errors.some((message) => message.includes("runner config tree unreadable (origin/main")), errors.join("\n"));
  assert.equal(runnerConfigDigest(join(site.dir, "no-such-dir")), undefined, "an unreadable checkout is no reading");
  assert.equal(terminalPreDispatchRefusalRevisions(state).has(TASK.id), false, "no reader is no evidence the scope is unchanged");

  // A record with no digest (W1-T3959's own shape) is held exactly as before, without reading main at all.
  for (const id of ids) writePriorRefusal(state, id, {
    verdict: "[sizing] a refusal", attempts: 1, escalated: true, preDispatchContractRevision: preDispatchContractRevision(TASK),
  });
  reads = 0;
  assert.equal(terminalPreDispatchRefusalRevisions(state, reading).get(TASK.id), preDispatchContractRevision(TASK));
  assert.equal(reads, 0, "no record carries a digest, so main is not read");
});
