import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  baseReproductionFiles, decideBaseReproduction, probeCacheFromLedger, probeCacheKey,
  strikesToRefund, type BaseProbeFile,
} from "../src/lib/base-reproduction.js";
import {
  BASE_RED_REFRESH_STEP, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";
import { buildBaseReproductionProbe, deriveStrikeHistory, priorStrikesFor } from "../src/run-task.js";

const NOW = Date.now();
const MAIN = "b".repeat(40);
const NEXT = "c".repeat(40);
const FILE = "test/example.test.ts";
type Row = Record<string, unknown>;

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5528, prUrl: "https://github.com/acme/remudero/pull/5528", taskId: "W1-T5528",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: "a".repeat(40),
    headRefName: "run-W1-T5528-1", autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: `not ok 1 - ${FILE}` }], ...over,
  };
}

function peer(): OpenPrView {
  return redPr({ prNumber: 6000, taskId: "W1-T6000", checksState: "green", reviewState: "success", ciFailures: [] });
}

function harness(rows: Row[] = [{ step: "main.health.observed", sha: MAIN, state: "undetermined" }]) {
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
      rows.push({ step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 });
    },
    updateBranch: (pr) => { refreshed.push(pr.prNumber); return "updated"; },
    ledgerPath: "/dev/null/base-reproduction.ndjson", runId: "W1-T5528-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => MAIN,
  };
  return { rows, fixed, refreshed, deps, sweep: (prs = [redPr(), peer()]) => runSweep(prs, deps, DEFAULT_SWEEP_POLICY) };
}

test("W1-T5528: a failing test file that also fails at main tip stands down with no strike", async () => {
  const h = harness();
  h.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) => {
    assert.equal(sha, MAIN);
    return files.map((file) => ({ file, outcome: "fails", duration_ms: 17, cached: false }));
  };
  const summary = await h.sweep();
  assert.deepEqual(h.fixed, []);
  assert.equal(priorStrikesFor(h.rows, "W1-T5528", "keyword_only", redPr().headSha), 0);
  assert.equal(summary.actions.find((a) => a.prNumber === 5528)?.acted, false);
  const row = h.rows.find((r) => r.step === "sweep.base_reproduction");
  assert.equal(row?.verdict, "reproduced");
  assert.equal(row?.main_sha, MAIN);
  assert.equal(row?.head_sha, redPr().headSha);
  assert.deepEqual(row?.files, [{ file: FILE, outcome: "fails", duration_ms: 17, cached: false }]);
  const disposed = h.rows.find((r) => r.step === "sweep.disposed" && r.pr_number === 5528);
  assert.match(String(disposed?.stand_down_reason), new RegExp(MAIN));
  assert.ok(String(disposed?.stand_down_reason).includes(FILE));
});

test("W1-T5528: a failing test file that passes at main tip still dispatches the fix", async () => {
  for (const outcome of ["passes", "absent", "unrunnable"] as const) {
    const h = harness();
    h.deps.reproduceFailingTestsOnMain = async (_pr, files) =>
      files.map((file) => ({ file, outcome, duration_ms: 0, cached: false }));
    await h.sweep();
    assert.deepEqual(h.fixed, [5528], outcome);
    assert.equal(priorStrikesFor(h.rows, "W1-T5528", "keyword_only", redPr().headSha), 1);
  }
});

test("W1-T5528: a strike spent on a head whose red later reproduces at main is refunded", async () => {
  const pr = redPr();
  const h = harness([
    { step: "main.health.observed", sha: MAIN, state: "undetermined" },
    { step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1, ci_failures: [{ check: "ci", signature: FILE }] },
    { step: "fix.review", task_id: pr.taskId, head_sha: pr.headSha, strike: 1, state: "failure" },
  ]);
  assert.equal(priorStrikesFor(h.rows, pr.taskId, "keyword_only", pr.headSha), 1);
  h.deps.reproduceFailingTestsOnMain = async (_pr, files) =>
    files.map((file) => ({ file, outcome: "fails", duration_ms: 0, cached: false }));
  await h.sweep();
  assert.deepEqual(h.fixed, []);
  assert.equal(priorStrikesFor(h.rows, pr.taskId, "keyword_only", pr.headSha), 0);
  assert.equal(priorStrikesFor(h.rows, pr.taskId), 0);
  assert.deepEqual(deriveStrikeHistory(h.rows, pr.taskId, pr.headSha), []);
  const refunds = h.rows.filter((r) => r.step === "fix.strike_refunded");
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0]?.strike, 1);
  assert.equal(refunds[0]?.reason, "base-red-reproduced");
  await h.sweep();
  assert.equal(h.rows.filter((r) => r.step === "fix.strike_refunded").length, 1);
});

test("W1-T5528: the probe runs once per main tip and file across pull requests", async () => {
  const h = harness();
  const calls: string[] = [];
  h.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) => {
    calls.push(...files.map((file) => `${sha}:${file}`));
    return files.map((file) => ({ file, outcome: "fails", duration_ms: 5, cached: false }));
  };
  const prs = [redPr(), redPr({ prNumber: 5529, taskId: "W1-T5529", headSha: "d".repeat(40) }), peer()];
  await h.sweep(prs);
  await h.sweep(prs);
  assert.deepEqual(calls, [`${MAIN}:${FILE}`]);
  const observations = h.rows.filter((r) => r.step === "sweep.base_reproduction");
  assert.equal(observations.length, 4);
  assert.equal((observations[1]?.files as Row[])[0]?.cached, true);
  h.deps.readMainTip = () => NEXT;
  await h.sweep(prs);
  assert.deepEqual(calls, [`${MAIN}:${FILE}`, `${NEXT}:${FILE}`]);
});

test("W1-T5528: a reproduced head that clears at a newer tip is refreshed once", async () => {
  const h = harness();
  h.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) =>
    files.map((file) => ({ file, outcome: sha === MAIN ? "fails" : "passes", duration_ms: 0, cached: false }));
  await h.sweep();
  h.deps.readMainTip = () => NEXT;
  await h.sweep();
  assert.deepEqual(h.fixed, []);
  assert.deepEqual(h.refreshed, [5528]);
  const refresh = h.rows.find((r) => r.step === BASE_RED_REFRESH_STEP);
  assert.equal(refresh?.main_sha, NEXT);
  assert.equal(refresh?.outcome, "updated");
  await h.sweep();
  assert.deepEqual(h.refreshed, [5528]);
  assert.deepEqual(h.fixed, [5528]);
});

test("W1-T5528: partial, unreadable, and missing probes never stand down a fix", async () => {
  for (const other of ["passes", "absent", "unrunnable"] as const) {
    const h = harness();
    h.deps.reproduceFailingTestsOnMain = async () => [
      { file: FILE, outcome: "fails", duration_ms: 0, cached: false },
      { file: "test/other.test.ts", outcome: other, duration_ms: 0, cached: false },
    ];
    await h.sweep([redPr({ ciFailures: [{ name: "ci", logTail: `${FILE}\ntest/other.test.ts` }] }), peer()]);
    assert.deepEqual(h.fixed, [5528], other);
    assert.equal(h.rows.find((r) => r.step === "sweep.base_reproduction")?.verdict, "partial");
  }
  for (const probe of [async () => [], async () => { throw new Error("worktree failed"); }]) {
    const h = harness();
    h.deps.reproduceFailingTestsOnMain = probe;
    await h.sweep();
    assert.deepEqual(h.fixed, [5528]);
    assert.equal(h.rows.find((r) => r.step === "sweep.base_reproduction")?.verdict, "unrunnable");
  }
});

test("W1-T5528: a PR with no test evidence or no readable main tip follows the existing lane", async () => {
  const h = harness();
  h.deps.reproduceFailingTestsOnMain = async () => { assert.fail("probe must not run"); };
  await h.sweep([redPr({ ciFailures: [{ name: "ci", logTail: "error TS2322" }] }), peer()]);
  h.deps.readMainTip = () => undefined;
  await h.sweep([redPr({ headSha: "new-head" }), peer()]);
  assert.deepEqual(h.fixed, [5528, 5528]);
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_reproduction").length, 0);
});

test("W1-T5528: refreshes share the existing per-pass bound and record a thrown request", async () => {
  const prs = [redPr(), redPr({ prNumber: 5529, taskId: "W1-T5529", headSha: "other-head" }), peer()];
  const h = harness();
  h.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) =>
    files.map((file) => ({ file, outcome: sha === MAIN ? "fails" : "passes", duration_ms: 0, cached: false }));
  await h.sweep(prs);
  h.deps.readMainTip = () => NEXT;
  h.deps.updateBranch = (pr) => { h.refreshed.push(pr.prNumber); throw new Error("update denied"); };
  await h.sweep(prs);
  assert.equal(h.refreshed.length, 1);
  assert.deepEqual(h.fixed, []);
  assert.match(String(h.rows.find((r) => r.step === BASE_RED_REFRESH_STEP)?.outcome), /update denied/);
  await h.sweep(prs);
  assert.equal(h.refreshed.length, 2);
  assert.deepEqual(h.fixed, [5528]);
});

test("W1-T5528: an unwired refresh holds a previously reproduced head without a worker", async () => {
  const h = harness();
  h.deps.reproduceFailingTestsOnMain = async (_pr, files, sha) =>
    files.map((file) => ({ file, outcome: sha === MAIN ? "fails" : "passes", duration_ms: 0, cached: false }));
  await h.sweep();
  h.deps.readMainTip = () => NEXT;
  h.deps.updateBranch = undefined;
  await h.sweep();
  assert.deepEqual(h.fixed, []);
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_REFRESH_STEP).length, 0);
});

test("W1-T5528: path extraction normalizes checkout prefixes and deduplicates safe test paths", () => {
  assert.deepEqual(baseReproductionFiles([
    { name: "ci", logTail: `file:///checkout/${FILE}:12\nC:\\checkout\\test\\example.test.ts\n${FILE}` },
    { name: "test/nested/../other.test.ts", logTail: "test/../../escaped.test.ts tests/other.test.ts" },
  ]), [FILE, "test/other.test.ts"]);
  assert.deepEqual(baseReproductionFiles([{ name: "ci", logTail: "error TS2322" }]), []);
});

test("W1-T5528: pure verdicts require a nonempty set of entirely failing files", () => {
  const files = [FILE, "test/other.test.ts"];
  const probes = (a: BaseProbeFile["outcome"], b: BaseProbeFile["outcome"]) =>
    files.map((file, i) => ({ file, outcome: i === 0 ? a : b, duration_ms: 0, cached: false }));
  assert.equal(decideBaseReproduction(files, probes("fails", "fails")), "reproduced");
  assert.equal(decideBaseReproduction(files, probes("fails", "unrunnable")), "partial");
  assert.equal(decideBaseReproduction(files, probes("passes", "absent")), "clear");
  assert.equal(decideBaseReproduction(files, probes("passes", "unrunnable")), "unrunnable");
  assert.equal(decideBaseReproduction(files, []), "unrunnable");
  assert.equal(decideBaseReproduction([], []), "clear");
});

test("W1-T5528: cache folds validate rows and keep outcomes distinct for each main sha", () => {
  const rows: Row[] = [
    { step: "unrelated", main_sha: MAIN, files: [{ file: FILE, outcome: "fails" }] },
    { step: "sweep.base_reproduction", main_sha: MAIN, files: [{ file: FILE, outcome: "fails", duration_ms: 5 }, null, { file: FILE, outcome: "unknown" }] },
    { step: "sweep.base_reproduction", main_sha: NEXT, files: [{ file: FILE, outcome: "passes", reason: "cached detail" }] },
    { step: "sweep.base_reproduction", files: [{ file: FILE, outcome: "fails" }] },
  ];
  const cache = probeCacheFromLedger(rows);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get(probeCacheKey(MAIN, FILE)), { file: FILE, outcome: "fails", duration_ms: 5, cached: true });
  assert.deepEqual(cache.get(probeCacheKey(NEXT, FILE)), { file: FILE, outcome: "passes", duration_ms: 0, cached: true, reason: "cached detail" });
});

test("W1-T5528: refunds require every dispatch check and exact task, head, and strike identity", () => {
  const pr = redPr();
  const eligible = { step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1, ci_failures: [{ check: "ci" }] };
  const rows = [eligible, { ...eligible },
    { ...eligible, strike: 2, ci_failures: [{ check: "ci" }, { check: "typecheck" }] },
    { ...eligible, strike: 3, ci_failures: [] }, { ...eligible, strike: 4, ci_failures: [{ check: null }] },
    { ...eligible, strike: 5, kind: "proof_amendment" }, { ...eligible, head_sha: "old-head" },
    { ...eligible, task_id: "other-task" }, { ...eligible, strike: undefined },
  ];
  assert.deepEqual(strikesToRefund(rows, pr.taskId, pr.headSha, ["ci"]), [eligible]);
  assert.deepEqual(strikesToRefund(rows, undefined, pr.headSha, ["ci"]), []);
  const refund = { step: "fix.strike_refunded", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 };
  assert.deepEqual(strikesToRefund([...rows, refund], pr.taskId, pr.headSha, ["ci"]), []);
  assert.equal(priorStrikesFor([eligible, { ...refund, head_sha: "old-head" }], pr.taskId, "keyword_only", pr.headSha), 1);
  assert.equal(priorStrikesFor([eligible, { ...refund, task_id: "other-task" }], pr.taskId, "keyword_only", pr.headSha), 1);
});

function probeHarness(t: TestContext, over: Parameters<typeof buildBaseReproductionProbe>[4] = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-base-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const logs: Row[] = [];
  const execute: NonNullable<Parameters<typeof buildBaseReproductionProbe>[4]>["execute"] = async (_proof, _cwd, timeout) => {
    assert.equal(timeout, 60_000);
    return "fail";
  };
  const probe = buildBaseReproductionProbe({ root } as Config, join(root, "repo"), join(root, "ledger.ndjson"),
    (step, extra) => { logs.push({ step, ...extra }); }, {
      git: async (args) => { calls.push(args); }, link: () => "linked", readFile: async () => "test file",
      readLedger: () => [], execute, timeout: () => 60_000, clock: fixedClock(NOW), ...over,
    });
  return { root, probe, calls, logs };
}

test("W1-T5528: production probing materializes the observed tip and cleans up under worktrees", async (t) => {
  const h = probeHarness(t);
  const files = await h.probe(redPr(), [FILE], MAIN);
  const path = join(h.root, "worktrees", `base-repro-${MAIN.slice(0, 12)}`);
  assert.deepEqual(h.calls, [["-C", join(h.root, "repo"), "worktree", "add", "--detach", path, MAIN],
    ["-C", join(h.root, "repo"), "worktree", "remove", "--force", path]]);
  assert.deepEqual(files, [{ file: FILE, outcome: "fails", duration_ms: 0, cached: false }]);
});

test("W1-T5528: a worktree-add or dependency-link failure returns unrunnable for every file", async (t) => {
  const addFailed = probeHarness(t, { git: async () => { throw new Error("add failed"); } });
  const files = await addFailed.probe(redPr(), [FILE, "test/other.test.ts"], MAIN);
  assert.equal(files.setup_error, "Error: add failed");
  assert.deepEqual([...files], [FILE, "test/other.test.ts"].map((file) =>
    ({ file, outcome: "unrunnable", duration_ms: 0, cached: false })));
  for (const link of ["failed", "no-source", "linked-lockfile-mismatch"] as const) {
    const h = probeHarness(t, { link: () => link });
    const result = await h.probe(redPr(), [FILE], MAIN);
    assert.equal(result.setup_error, `Error: probe node_modules: ${link}`);
    assert.deepEqual([...result], [{ file: FILE, outcome: "unrunnable", duration_ms: 0, cached: false }]);
    assert.equal(h.calls.length, 2);
  }
});

test("W1-T5528: absent files and unreadable files retain different production outcomes", async (t) => {
  const h = probeHarness(t, { readFile: async (path) => {
    if (path.endsWith("package.json")) return "{}";
    throw Object.assign(new Error("cannot read"), { code: path.endsWith("absent.test.ts") ? "ENOENT" : "EACCES" });
  } });
  const files = await h.probe(redPr(), ["test/absent.test.ts", FILE], MAIN);
  assert.equal(files[0]?.outcome, "absent");
  assert.equal(files[1]?.outcome, "unrunnable");
  assert.match(files[1]?.reason ?? "", /cannot read/);
  assert.equal(h.calls.length, 2);
});

test("W1-T5528: missing dependencies, no-match, invalid proof paths, and timeouts are unrunnable", async (t) => {
  const missingDeps = probeHarness(t, { readFile: async () => { throw new Error("missing tsx"); } });
  const missing = await missingDeps.probe(redPr(), [FILE], MAIN);
  assert.equal(missing.setup_error, "Error: missing tsx");
  assert.deepEqual([...missing], [{ file: FILE, outcome: "unrunnable", duration_ms: 0, cached: false }]);
  assert.equal(missingDeps.calls.length, 2);
  for (const execute of [async () => "no-match" as const, async () => { throw new Error("proof timeout"); }]) {
    const h = probeHarness(t, { execute });
    const result = await h.probe(redPr(), [FILE], MAIN);
    assert.equal(result[0]?.outcome, "unrunnable");
    assert.ok(result[0]?.reason);
    assert.equal(h.calls.length, 2);
  }
  const invalid = probeHarness(t);
  assert.equal((await invalid.probe(redPr(), ["test/invalid?.test.ts"], MAIN))[0]?.outcome, "unrunnable");
});

test("W1-T5528: cleanup failure reports its reason without replacing a test verdict", async (t) => {
  const h = probeHarness(t, { git: async (args) => {
    if (args.includes("remove")) throw new Error("cleanup denied");
  } });
  assert.equal((await h.probe(redPr(), [FILE], MAIN))[0]?.outcome, "fails");
  assert.match(String(h.logs[0]?.reason), /cleanup denied/);
});

test("W1-T5528: production probes serialize across builders and reuse completed and ledgered results", async (t) => {
  let active = 0;
  let peak = 0;
  let executions = 0;
  const h = probeHarness(t, { execute: async () => {
    active++; peak = Math.max(peak, active); executions++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--; return "pass";
  } });
  const other = buildBaseReproductionProbe({ root: h.root } as Config, join(h.root, "repo"), "unused", () => {}, {
    readLedger: () => [], git: async () => { assert.fail("completed result must be cached"); },
  });
  const first = h.probe(redPr(), [FILE], MAIN);
  const second = other(redPr(), [FILE], MAIN);
  const results = await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(executions, 1);
  assert.equal(results[1][0]?.cached, true);
  const ledgered = probeHarness(t, { readLedger: () => [
    { step: "sweep.base_reproduction", main_sha: NEXT, files: [{ file: FILE, outcome: "fails", duration_ms: 2 }] },
  ] });
  assert.equal((await ledgered.probe(redPr(), [FILE], NEXT))[0]?.cached, true);
  assert.deepEqual(ledgered.calls, []);
});

test("W1-T5528: a failed queue read preserves its error and allows the next probe", async (t) => {
  const broken = probeHarness(t, { readLedger: () => { throw new Error("ledger unreadable"); } });
  await assert.rejects(broken.probe(redPr(), [FILE], MAIN), /ledger unreadable/);
  assert.match(String(broken.logs[0]?.reason), /ledger unreadable/);
  const healthy = probeHarness(t);
  assert.equal((await healthy.probe(redPr(), [FILE], MAIN))[0]?.outcome, "fails");
});

test("W1-T5528: default production probing executes real passing and failing tests at a detached tip", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-real-base-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = gitRepo({ kind: "real-base-probe", seedCommit: false });
  t.after(() => fixture.cleanup());
  const repo = fixture.dir;
  mkdirSync(join(repo, "test", "setup"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) writeFileSync(join(repo, file), readFileSync(join(process.cwd(), file)));
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  writeFileSync(join(repo, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(repo, "test/pass.test.ts"), 'import test from "node:test"; import assert from "node:assert/strict"; test("pass", () => assert.equal(1, 1));\n');
  writeFileSync(join(repo, "test/fail.test.ts"), 'import test from "node:test"; import assert from "node:assert/strict"; test("fail", () => assert.equal(1, 2));\n');
  writeFileSync(join(repo, "test/broken.test.ts"), 'import "./missing-module.js";\n');
  fixture.git("add", "package.json", "package-lock.json", "test");
  fixture.git("commit", "-m", "fixture");
  const sha = fixture.git("log", "-1", "--format=%H");
  const probe = buildBaseReproductionProbe({ root } as Config, repo, join(root, "ledger.ndjson"), () => {});
  const result = await probe(redPr(), ["test/pass.test.ts", "test/fail.test.ts", "test/absent.test.ts", "test/broken.test.ts"], sha);
  assert.deepEqual(result.map((file) => file.outcome), ["passes", "fails", "absent", "unrunnable"]);
  assert.ok(result.every((file) => file.cached === false && file.duration_ms >= 0));
  assert.equal(existsSync(join(root, "worktrees", `base-repro-${sha.slice(0, 12)}`)), false);
});
