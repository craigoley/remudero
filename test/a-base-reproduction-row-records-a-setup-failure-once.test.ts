import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { decideBaseReproduction, probeCacheFromLedger, type BaseProbeFile } from "../src/lib/base-reproduction.js";
import { buildBaseReproductionProbe, runFixRung } from "./helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { gitRepo } from "./helpers/git-repo.js";
import type { WorkerResult } from "../src/lib/worker.js";

const PROOF = "test/a-base-reproduction-row-records-a-setup-failure-once.test.ts";
const NOW = Date.now();
const SHA = "b".repeat(40);
const ERROR = "worktree add already exists: " + "x".repeat(299);
const files = (count: number) => Array.from({ length: count }, (_, i) => `test/file-${i}.test.ts`);
type ProbeResult = readonly BaseProbeFile[] & { setup_error?: string; reason?: string };
const pr: OpenPrView = {
  prNumber: 5653, prUrl: "https://github.com/acme/remudero/pull/5653", taskId: "W1-T5653",
  headSha: "a".repeat(40), headRefName: "run-W1-T5653-1", reviewState: "pending", checksState: "red",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(),
  autoMergeArmed: false,
};

function probeHarness(t: TestContext, overrides: Parameters<typeof buildBaseReproductionProbe>[4] = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-base-row-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const logs: Record<string, unknown>[] = [];
  const probe = buildBaseReproductionProbe({ root } as Config, join(root, "repo"), "unused",
    (step, detail) => logs.push({ step, ...detail }), {
      readLedger: () => [], git: async (args) => { calls.push(args); }, link: () => "linked",
      readFile: async () => "contents", execute: async () => "fail", timeout: () => 60_000,
      clock: fixedClock(NOW), ...overrides,
    });
  return { root, probe, calls, logs };
}

async function sweepRow(count: number, reproduce: NonNullable<SweepDeps["reproduceFailingTestsOnMain"]>,
  history: Record<string, unknown>[] = []) {
  const rows: Record<string, unknown>[] = [...history];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {}, dispatchFix: () => {},
    ledgerPath: "/dev/null/base-row.ndjson", runId: "W1-T5653-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => SHA,
    reproduceFailingTestsOnMain: reproduce,
  };
  await runSweep([{ ...pr, ciFailures: [{ name: "ci", logTail: files(count).join("\n") }] }], deps, DEFAULT_SWEEP_POLICY);
  const observations = rows.slice(history.length).filter((row) => row.step === "sweep.base_reproduction");
  assert.equal(observations.length, 1);
  return observations[0];
}

test(`${PROOF}: one setup_error survives in the row without per-file copies`, async (t) => {
  for (const count of [1, 64]) {
    const h = probeHarness(t, { git: async () => { throw new Error(ERROR); } });
    const row = await sweepRow(count, h.probe);
    assert.equal(row.setup_error, `Error: ${ERROR}`);
    assert.equal(row.verdict, "unrunnable");
    assert.ok((row.files as BaseProbeFile[]).every((file) => file.outcome === "unrunnable" && !("reason" in file)));
    const serialized = JSON.stringify(row);
    assert.equal(serialized.split(ERROR).length - 1, 1);
    assert.ok(Buffer.byteLength(serialized) < 10_000);
  }
});

test(`${PROOF}: 795-file and larger rows are bounded and spend no probe`, async (t) => {
  const h = probeHarness(t, { git: async () => { assert.fail("oversized probes cannot set up a worktree"); } });
  let invoked = 0;
  const sizes: number[] = [];
  for (const count of [795, 1590]) {
    const row = await sweepRow(count, async () => { invoked++; throw new Error(ERROR); });
    assert.equal(row.verdict, "unrunnable");
    assert.match(String(row.reason), /too many/);
    assert.deepEqual(row.files, []);
    sizes.push(Buffer.byteLength(JSON.stringify(row)));
    const direct = await h.probe(pr, files(count), SHA) as ProbeResult;
    assert.equal(direct.length, 0);
    assert.match(String(direct.reason), /too many/);
  }
  assert.equal(invoked, 0);
  assert.equal(sizes[0], sizes[1]);
  assert.ok(sizes[0] < 1000);
});

test(`${PROOF}: sweep exceptions record one bounded setup_error`, async () => {
  const row = await sweepRow(64, async () => { throw new Error("y".repeat(20_000)); });
  assert.equal(typeof row.setup_error, "string");
  assert.ok((row.setup_error as string).length <= 512);
  assert.ok((row.files as BaseProbeFile[]).every((file) => !("reason" in file)));
  assert.ok(Buffer.byteLength(JSON.stringify(row)) < 10_000);
});

test(`${PROOF}: per-file and cached reasons are capped`, async (t) => {
  const h = probeHarness(t, { execute: async () => { throw new Error("z".repeat(20_000)); } });
  const row = await sweepRow(1, h.probe);
  const result = (row.files as BaseProbeFile[])[0];
  assert.equal(result.outcome, "unrunnable");
  assert.ok(result.reason!.length <= 512);
  const old = { step: "sweep.base_reproduction", main_sha: SHA,
    files: [{ file: files(1)[0], outcome: "unrunnable", reason: "old".repeat(20_000) }] };
  const cachedRow = await sweepRow(1, async () => { assert.fail("ledger result should be cached"); }, [old]);
  assert.ok(((cachedRow.files as BaseProbeFile[])[0].reason as string).length <= 512);
  const injected = await sweepRow(1, async () => [{ ...result, reason: "fake".repeat(20_000) }]);
  assert.ok(((injected.files as BaseProbeFile[])[0].reason as string).length <= 512);
});

test(`${PROOF}: setup failures are not cached as completed probes`, async (t) => {
  let broken = true;
  const h = probeHarness(t, { link: () => broken ? "failed" : "linked" });
  const first = await h.probe(pr, files(1), SHA) as ProbeResult;
  assert.match(first.setup_error!, /failed/);
  assert.deepEqual(probeCacheFromLedger([{ step: "sweep.base_reproduction", main_sha: SHA,
    setup_error: first.setup_error, files: [...first] }]), new Map());
  broken = false;
  const second = await h.probe(pr, files(1), SHA);
  assert.equal(second[0].outcome, "fails");
  assert.equal(second[0].cached, false);
});

test(`${PROOF}: the limit admits 64 files and refuses 65 even if all were cached failures`, async (t) => {
  const h = probeHarness(t);
  const accepted = await sweepRow(64, h.probe);
  assert.equal(accepted.verdict, "reproduced");
  assert.equal((accepted.files as BaseProbeFile[]).length, 64);
  const outcomes = files(65).map((file): BaseProbeFile => ({ file, outcome: "fails", duration_ms: 0, cached: true }));
  assert.equal(decideBaseReproduction(files(65), outcomes), "unrunnable");
  const rejected = await sweepRow(65, async () => { assert.fail("oversized cached inputs still refuse probing"); },
    [{ step: "sweep.base_reproduction", main_sha: SHA, files: outcomes }]);
  assert.equal(rejected.verdict, "unrunnable");
  assert.deepEqual(rejected.files, []);
});

test(`${PROOF}: setup and cleanup failures keep their bounded diagnostics`, async (t) => {
  for (const over of [
    { link: () => "failed" as const },
    { readFile: async () => { throw new Error("missing tsx"); } },
    { git: async () => { throw new Error("checkout denied"); } },
  ]) {
    const h = probeHarness(t, over);
    const result = await h.probe(pr, files(1), SHA) as ProbeResult;
    assert.equal(result[0].outcome, "unrunnable");
    assert.equal(typeof result.setup_error, "string");
    assert.equal(result[0].reason, undefined);
  }
  const blocked = probeHarness(t, { remove: async () => { throw new Error("cannot remove stale"); } });
  const stale = join(blocked.root, "worktrees", `base-repro-${SHA.slice(0, 12)}`);
  mkdirSync(stale, { recursive: true });
  const failure = await blocked.probe(pr, files(1), SHA) as ProbeResult;
  assert.match(failure.setup_error!, /cannot remove stale/);
  assert.deepEqual(blocked.calls, []);
  assert.equal(blocked.logs[0].step, "sweep.base_reproduction.cleanup_failed");
  for (const over of [
    { git: async (args: string[]) => { if (args.includes("remove")) throw new Error(ERROR); } },
    { remove: async () => { throw new Error(ERROR); } },
  ]) {
    const h = probeHarness(t, over);
    const result = await h.probe(pr, files(1), SHA);
    assert.equal(result[0].outcome, "fails");
    assert.equal(h.logs[0].step, "sweep.base_reproduction.cleanup_failed");
    assert.match(String(h.logs[0].reason), /worktree add already exists/);
  }
});

test(`${PROOF}: absent, unreadable and unexecutable files retain distinct outcomes`, async (t) => {
  const h = probeHarness(t, { readFile: async (path) => {
    if (path.endsWith("package.json")) return "{}";
    throw Object.assign(new Error("r".repeat(20_000)), { code: path.endsWith("file-0.test.ts") ? "ENOENT" : "EACCES" });
  } });
  const result = await h.probe(pr, files(2), SHA);
  assert.equal(result[0].outcome, "absent");
  assert.equal(result[1].outcome, "unrunnable");
  assert.ok(result[1].reason!.length <= 512);
  for (const execute of [async () => "no-match" as const, async () => { throw new Error("proof timeout"); }]) {
    const next = probeHarness(t, { execute });
    const probe = await next.probe(pr, files(1), SHA);
    assert.equal(probe[0].outcome, "unrunnable");
    assert.ok(probe[0].reason);
  }
  const invalid = probeHarness(t);
  const invalidFile = await invalid.probe(pr, ["test/invalid?.test.ts"], SHA);
  assert.equal(invalidFile[0].outcome, "unrunnable");
  assert.match(invalidFile[0].reason!, /unexecutable test path/);
});

test(`${PROOF}: worker base verification also records setup_error and refuses oversized inputs`, async (t) => {
  for (const count of [1, 795]) {
    const repo = gitRepo({ kind: "base-row-fix" });
    t.after(() => repo.cleanup());
    const rows: Record<string, unknown>[] = [];
    const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
    const review = {
      state: "failure", criteria: [], testTheater: false, summary: "broken", floorDegraded: false,
      capped: false, keywordOnly: false, planOnly: false, headSha: pr.headSha, reviewerOutcome: "failure",
    } as Parameters<typeof runFixRung>[0]["initialReview"];
    const worker: WorkerResult = {
      sessionId: "base-row-fix", costUsd: 0, numTurns: 1, text: "REPORT\nFIX_OUTCOME: BASE_RED", blocks: [],
      stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
      model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
    };
    await runFixRung({
      taskId: "W1-T5653", runId: "base-row-fix", task: { id: "W1-T5653", title: "base row", files: ["src/fix.ts"] },
      prUrl: pr.prUrl, branch: "run-W1-T5653-1", worktreePath: repo.dir, initialSessionId: "initial", mount,
      settingsFile: join(repo.dir, "settings.json"), budgetUsd: 10, strikeCap: 2, initialReview: review,
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
      ciFailures: [{ name: "ci", logTail: files(count).join("\n") }],
      deps: {
        spawn: async () => worker, waitForCiGreen: async () => "green", runReview: async () => review,
        fetchPrBody: async () => "REPORT", push: () => { assert.fail("verification never pushes"); },
        issues: { create: () => "unused", listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (result) => result,
        readMainTip: () => SHA, reproduceFailingTestsOnMain: async () => {
          assert.equal(count, 1);
          return Object.assign([{ file: files(1)[0], outcome: "unrunnable" as const, duration_ms: 0, cached: false }],
            { setup_error: "e".repeat(20_000) });
        },
      },
    });
    const row = rows.find((item) => item.step === "sweep.base_reproduction");
    assert.ok(row);
    assert.equal(row.verdict, "unrunnable");
    if (count === 1) assert.equal((row.setup_error as string).length, 512);
    else {
      assert.match(String(row.reason), /too many/);
      assert.deepEqual(row.files, []);
    }
  }
});

test(`${PROOF}: stale directories and registered worktrees no longer fail the next probe`, async (t) => {
  const repo = gitRepo({ kind: "base-row-stale" });
  t.after(() => repo.cleanup());
  const root = mkdtempSync(join(tmpdir(), "rmd-base-row-stale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = repo.git("rev-parse", "HEAD");
  const stale = join(root, "worktrees", `base-repro-${sha.slice(0, 12)}`);
  const probe = buildBaseReproductionProbe({ root } as Config, repo.dir, "unused", () => {}, {
    readLedger: () => [], link: () => "linked", readFile: async () => "contents", execute: async () => "pass",
  });
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "leftover"), "stale");
  const first = await probe(pr, ["test/first.test.ts"], sha) as ProbeResult;
  assert.equal(first[0].outcome, "passes");
  assert.equal(first.setup_error, undefined);
  assert.equal(existsSync(stale), false);
  repo.git("worktree", "add", "--detach", stale, sha);
  const second = await probe(pr, ["test/second.test.ts"], sha);
  assert.equal(second[0].outcome, "passes");
  assert.equal(existsSync(stale), false);
  assert.equal(repo.git("worktree", "list", "--porcelain").includes(stale), false);
});
