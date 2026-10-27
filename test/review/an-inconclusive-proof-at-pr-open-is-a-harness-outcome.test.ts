// W1-T10742. MEASURED on the console instance: four CONSOLE-T127 runs ended `verdict failed` at
// `pr_open.refused` because check-proof answered exit 4 (exec_error: "could not even look") and the
// pre-open gate refused that as `branch-gap`, while a CONCLUSIVE failing proof (exit 1) was opened with the
// proof named. The strike classifiers then counted those refusals as the worker's and tripped the breaker.
// These cases drive the real opener (`openPullRequestCheckedAsync`, the daemon's
// `ghPrCreateFillCommandAsync`), the real `checkProofCommand`, and the real strike classifiers.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkProofCommand } from "#src/lib/check-proof.js";
import { readBreakerStrikes } from "#src/lib/breaker-release.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import { nonWorkerVerdictClass } from "#src/lib/stranded-task-detector.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import * as prOpen from "#src/lib/pr-open.js";
import * as runTask from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const BRANCH = "run-W1-T9-1";
const PROOF = "grep: marker in note.md";

/** A checkout on run branch run-W1-T9-1 whose plan files one proof, with origin/main a commit behind HEAD. */
function filedRunBranch(t: TestContext): string {
  const repo = gitRepo({ kind: "inconclusive-proof-open", scope: t });
  mkdirSync(join(repo.dir, "plan"));
  const plan = ["- id: W1-T9", "  title: fixture", "  repo: remudero", "  type: implement", "  acceptance:"];
  plan.push("    - claim: the fixture claim", `      proof: ${JSON.stringify(PROOF)}`);
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), `${plan.join("\n")}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  writeFileSync(join(repo.dir, "note.md"), "marker\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: change");
  return repo.dir;
}

const EXEC_ERROR_OUTPUT =
  "exit:       1\nhits:       0\nhead output:\n(no output captured)\n" +
  "verdict:    exec_error — name-filtered Vitest proof run was truncated before its TAP plan count completed";

/** An async proof runner answering each call from `statuses` in order (the last repeats), counting its calls. */
function scriptedRunner(statuses: readonly number[]): { run: prOpen.AsyncOpenPullRequestProofRunner; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)]!;
      calls += 1;
      return { status, signal: null, stdout: status === 0 ? "verdict:    pass\n" : EXEC_ERROR_OUTPUT, stderr: "" };
    },
  };
}

const bodyOf = (command: { args: string[] }): string => command.args.find((arg) => arg.startsWith("body=")) ?? "";
const stepsOf = (command: { diagnostics?: ReadonlyArray<{ step: string }> }): string[] =>
  (command.diagnostics ?? []).map((d) => d.step);

const openAsDaemon = (dir: string, runner: prOpen.AsyncOpenPullRequestProofRunner, openOnFailingProof = true) =>
  withLiveWritesAllowed(() =>
    runTask.ghPrCreateFillCommandAsync(dir, "o", "r", BRANCH, "feat(x): a subject", runner, openOnFailingProof),
  );

test("W1-T10742: an inconclusive proof at pr open is re-run and then opens the pr with the proof named", async (t) => {
  const dir = filedRunBranch(t);
  const runner = scriptedRunner([4, 4]);
  const command = await openAsDaemon(dir, runner.run);
  assert.equal(runner.calls(), 2, "the inconclusive proof was re-run exactly once through the same runner");
  const body = bodyOf(command);
  assert.match(body, /## Pre-open proof inconclusive/);
  assert.ok(body.includes(PROOF), "the proof is named in the section");
  assert.match(body, /verdict:\s+exec_error/, "the bounded tail of the inconclusive run is carried");
  assert.doesNotMatch(body, /## Pre-open proof failure/);
  assert.match(body, /Remudero-Task: W1-T9$/, "the task trailer stays the body's last paragraph");
  const opened = (command.diagnostics ?? []).find((d) => d.step === "pr.opened_with_inconclusive_proof");
  assert.deepEqual(opened?.extra, { branch: BRANCH, proof: PROOF, attempts: 2 });
  assert.ok(!stepsOf(command).includes("pr.opened_with_failing_proof"));
});

test("W1-T10742: an inconclusive proof refuses the open with an inconclusiveProof payload when the caller cannot open red", async (t) => {
  const dir = filedRunBranch(t);
  const runner = scriptedRunner([4, 4]);
  await assert.rejects(
    () => prOpen.openPullRequestCheckedAsync("", BRANCH, dir, "origin/main", runner.run),
    (err: unknown) => {
      assert.ok(err instanceof prOpen.PrOpenRefusedError);
      assert.equal(err.refusalClass, "branch-gap");
      assert.equal(err.failingProof, undefined);
      assert.equal(err.inconclusiveProof?.proof, PROOF);
      assert.equal(err.inconclusiveProof?.attempts, 2);
      assert.match(err.inconclusiveProof?.detail ?? "", /exec_error/);
      return true;
    },
  );
  await assert.rejects(() => openAsDaemon(dir, runner.run, false), prOpen.PrOpenRefusedError);
});

test("W1-T10742: an inconclusive proof that is conclusive on the re-run opens with the plain checked body", async (t) => {
  const dir = filedRunBranch(t);
  const runner = scriptedRunner([4, 0]);
  const command = await openAsDaemon(dir, runner.run);
  assert.equal(runner.calls(), 2, "the runner saw the second call");
  const body = bodyOf(command);
  assert.doesNotMatch(body, /Pre-open proof/);
  assert.match(body, /Remudero-Task: W1-T9$/);
  assert.deepEqual(stepsOf(command).filter((s) => s.startsWith("pr.opened_with")), []);
});

test("W1-T10742: a proof that fails conclusively on the re-run opens as a failing proof", async (t) => {
  const dir = filedRunBranch(t);
  const runner = scriptedRunner([4, 1]);
  const command = await openAsDaemon(dir, runner.run);
  assert.equal(runner.calls(), 2);
  assert.match(bodyOf(command), /## Pre-open proof failure/);
  assert.doesNotMatch(bodyOf(command), /Pre-open proof inconclusive/);
  assert.ok(stepsOf(command).includes("pr.opened_with_failing_proof"));
});

test("W1-T10742: a conclusive proof result is never re-run and keeps its refusal class", async (t) => {
  const dir = filedRunBranch(t);
  const failing = scriptedRunner([1]);
  const command = await openAsDaemon(dir, failing.run);
  assert.equal(failing.calls(), 1, "an exit-1 proof opens red on its first answer");
  assert.ok(stepsOf(command).includes("pr.opened_with_failing_proof"));
  for (const [status, refusalClass] of [[5, "stale-proof"], [3, "branch-gap"]] as const) {
    const runner = scriptedRunner([status]);
    await assert.rejects(
      () => openAsDaemon(dir, runner.run),
      (err: unknown) => {
        assert.ok(err instanceof prOpen.PrOpenRefusedError);
        assert.equal(err.refusalClass, refusalClass);
        assert.equal(err.inconclusiveProof, undefined);
        return true;
      },
      `exit ${status}`,
    );
    assert.equal(runner.calls(), 1, `exit ${status} is conclusive and is not re-run`);
  }
});

/** A Vitest-shaped checkout: tests/unit/{a,b}.test.ts and a pinned runner that echoes the files it was given. */
function vitestCheckout(t: TestContext): string {
  const repo = gitRepo({ kind: "vitest-leaf-narrowing", scope: t });
  mkdirSync(join(repo.dir, "tests", "unit"), { recursive: true });
  mkdirSync(join(repo.dir, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(repo.dir, "tests", "unit", "a.test.ts"),
    'describe("X-T1", () => { it("leaf title", () => {}); });\n');
  writeFileSync(join(repo.dir, "tests", "unit", "b.test.ts"),
    'describe("X-T2", () => { it("another leaf", () => {}); });\n');
  writeFileSync(join(repo.dir, "node_modules", "vitest", "vitest.mjs"), `
const files = process.argv.slice(process.argv.indexOf("-t") + 2);
let out = "TAP version 13\\n1.." + files.length + "\\n";
files.forEach((f, i) => { out += "ok " + (i + 1) + " - " + f + " # time=1ms {\\n    1..1\\n    ok 1 - leaf title # time=1ms\\n}\\n"; });
process.stdout.write(out);
`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  return repo.dir;
}

function runCheckProof(t: TestContext, dir: string, args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); });
  t.mock.method(process, "cwd", () => dir);
  const code = checkProofCommand(args, { pathStatus: () => "" });
  return { code, out: lines.join("\n") };
}

test("W1-T10742: a name-filtered vitest proof runs only the files that contain its leaf title", async (t) => {
  const dir = vitestCheckout(t);
  const { code, out } = runCheckProof(t, dir, ["unit test:", "X-T1: leaf title", "--repo", "craigoley/remudero-console"]);
  assert.equal(code, 0, out);
  assert.match(out, /candidates: 1 file\(s\) — tests\/unit\/a\.test\.ts/);
  const argv = /^argv:.*$/m.exec(out)?.[0] ?? "";
  assert.ok(argv.includes("tests/unit/a.test.ts"), argv);
  assert.ok(!argv.includes("b.test.ts"), argv);
  assert.ok(!/\btests\/\s*$/.test(argv), `the argv no longer names the whole root: ${argv}`);
});

test("W1-T10742: a name-filtered vitest proof with no file naming its title keeps the root-wide run", async (t) => {
  const dir = vitestCheckout(t);
  const { out } = runCheckProof(t, dir, ["unit test:", "X-T9: no such leaf", "--repo", "craigoley/remudero-console"]);
  assert.match(out, /candidates: delegated to the registered Vitest suite root/);
  assert.match(/^argv:.*$/m.exec(out)?.[0] ?? "", /-t X-T9: no such leaf tests\/$/);
});

// The four CONSOLE-T127 verdict rows' exact shape: `failed` at `pr_open.refused`, cause `base-proof-refused`,
// refusal_class `branch-gap`, the reason being check-proof's own report for an exec_error proof.
const INCIDENT_REASON =
  "openPullRequestChecked: W1-T9 proof did not pass against merge base (unit test: CONSOLE-T127: needs-you " +
  "without a filter redirects to now with its repository scope): proof: unit test: CONSOLE-T127: needs-you\n" +
  "argv:       node vitest.mjs run --reporter=tap -t CONSOLE-T127: needs-you tests/\nexit:       1\nhits:       0\n" +
  "head output:\n(no output captured)\nverdict:    exec_error — name-filtered Vitest proof run was truncated";

function refusalRow(runId: string, taskId: string, extra: Record<string, unknown>, reason = INCIDENT_REASON, ts = "2026-10-13T16:02:50Z") {
  return {
    ts, step: "verdict", task_id: taskId, run_id: runId, verdict: "failed", reason, stage: "pr_open.refused",
    cause: "base-proof-refused", refusal_class: "branch-gap", ...extra,
  };
}

test("W1-T10742: an inconclusive-proof refusal is a non-worker strike", async () => {
  const taskId = "CONSOLE-T127";
  const shapes: Array<Record<string, unknown>> = [{ proof_exec: "exec_error" }, {}];
  for (const extra of shapes) {
    const row = refusalRow("r1", taskId, extra);
    assert.equal(streakRefusal(row), "proof_inconclusive", JSON.stringify(extra));
    assert.equal(nonWorkerVerdictClass(row), "proof_inconclusive", JSON.stringify(extra));
    const ledger: Array<Record<string, unknown>> = [
      { ts: "2026-10-13T16:00:00Z", step: "run.start", task_id: taskId, run_id: "r1" },
      row,
      { ts: "2026-10-15T12:17:33Z", step: "dispatch.circuit_broken", task: taskId, task_id: taskId, count: 4 },
    ];
    const reading = readBreakerStrikes(ledger, taskId);
    assert.deepEqual(reading.strikes, [{ runId: "r1", cause: "proof_inconclusive" }], JSON.stringify(extra));
    assert.equal(reading.counted, 0, "the breaker no longer counts an inconclusive proof refusal");
  }
});

test("W1-T10742: a conclusive pr_open.refused verdict is still the worker's strike", async () => {
  const taskId = "CONSOLE-T127";
  const conclusive = refusalRow("r2", taskId, {}, "openPullRequestChecked: proof did not pass\nexit:       1\nverdict:    fail");
  assert.equal(streakRefusal(conclusive), undefined);
  assert.equal(nonWorkerVerdictClass(conclusive), undefined);
  const otherStage = { ...refusalRow("r3", taskId, { proof_exec: "exec_error" }), stage: "implement.preopen_continued" };
  assert.equal(streakRefusal(otherStage), undefined, "only the pr_open.refused stage is read");
  const reading = readBreakerStrikes([
    { ts: "2026-10-13T16:00:00Z", step: "run.start", task_id: taskId, run_id: "r2" },
    conclusive,
  ], taskId);
  assert.deepEqual(reading.strikes, [{ runId: "r2", cause: undefined }]);
});
