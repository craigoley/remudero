// W1-T12713: a CI job log that cannot be fetched is retried after a rate limit or a server error, and
// a log GitHub does not hold (or a check with no Actions job id) is read from the check run's own output.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LOG_FETCH_BACKOFF_FIRST_MS, LOG_FETCH_BACKOFF_MAX_MS, logFetchRetryAtMs, readCiIncidentJobLog } from "#src/lib/ci-incidents.js";
import { failureEvidenceOf } from "#src/lib/fix-progress-judge.js";
import { describeCiLogUnavailable, DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { classifyLogFetchFailure, fetchCiFailures, fetchCiFailuresAsync } from "#src/lib/tick-read-worker.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const RATE_LIMIT = "gh: API rate limit exceeded for installation ID 1. (HTTP 403)";
const FAR_RESET_S = 4_102_444_800; // 2100-01-01T00:00:00Z
const jobUrl = (id: number) => `https://github.com/craigoley/remudero/actions/runs/1/job/${id}`;
const jobCheck = (id: number) => ({ name: `coverage-shard (${id % 8}/8)`, conclusion: "FAILURE", detailsUrl: jobUrl(id) });
const logs = (id: number) => `api repos/craigoley/remudero/actions/jobs/${id}/logs`;
const checkRun = (id: number) => `api repos/craigoley/remudero/check-runs/${id}`;
const output = (title: string, summary: string, text = "") => JSON.stringify({ id: 1, output: { title, summary, text } });

/** The real gh read path, answered by a PATH shim. Each test uses its own job ids, so no back-off entry is shared. */
async function withGh<T>(routes: GhShimRoute[], fn: (shim: GhShim) => T | Promise<T>): Promise<T> {
  const shim = ghShim([{ when: "/annotations", stdout: "[]" }, ...routes], { kind: "w1-t12713" });
  const prior = process.env.PATH;
  process.env.PATH = `${shim.dir}:${prior ?? ""}`;
  try {
    return await fn(shim);
  } finally {
    process.env.PATH = prior;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}
const one = (rollup: object[]): CiFailure => {
  const failures = fetchCiFailures("craigoley", "remudero", rollup);
  assert.equal(failures.length, 1);
  return failures[0]!;
};
/** The daemon's read path: the async producer, which reads the check run's output over the async transport. */
const oneAsync = async (rollup: object[]): Promise<CiFailure> => {
  const failures = await fetchCiFailuresAsync("craigoley", "remudero", rollup);
  assert.equal(failures.length, 1);
  return failures[0]!;
};

test("W1-T12713 criterion 1: classifyLogFetchFailure sorts a failed log read into rate-limit, transient or absent", () => {
  const err = (text: string) => new Error(`gh api failed with exit code 1\n${text}`);
  const limited = classifyLogFetchFailure(err(`${RATE_LIMIT}\nx-ratelimit-reset: ${FAR_RESET_S}`));
  assert.deepEqual(limited, { kind: "rate-limit", resetAtMs: FAR_RESET_S * 1000 });
  assert.equal(classifyLogFetchFailure(err("gh: HTTP 429")).kind, "rate-limit");
  assert.equal(classifyLogFetchFailure(err("gh: Resource not accessible by integration (HTTP 403)")).kind, "unknown",
    "a 403 that names no rate limit is not a rate limit");
  assert.equal(classifyLogFetchFailure(err("gh: HTTP 502")).kind, "transient");
  assert.equal(classifyLogFetchFailure(err("gh: Service Unavailable (HTTP 503)")).kind, "transient");
  assert.equal(classifyLogFetchFailure(Object.assign(new Error("spawn"), { code: "ETIMEDOUT" })).kind, "transient");
  assert.equal(classifyLogFetchFailure(err("gh: Not Found (HTTP 404)")).kind, "absent");
  assert.equal(classifyLogFetchFailure(err("gh: something else"), { steps: [] }).kind, "absent", "a job with no steps has no log");
  assert.equal(classifyLogFetchFailure(err("denied by proxy")).kind, "unknown");
});

test("W1-T12713 criterion 2: a rate-limited read is deferred to its reset time, and is not read again before it", async () => {
  await withGh([{ when: logs(9101), stderr: `${RATE_LIMIT}\nx-ratelimit-reset: ${FAR_RESET_S}`, exit: 1 }], (shim) => {
    const first = one([jobCheck(9101)]);
    assert.equal(first.logUnavailable?.kind, "deferred");
    const text = describeCiLogUnavailable(first.logUnavailable!);
    assert.equal(text, "log read deferred (rate-limit, retry at 2100-01-01T00:00:00.000Z)");
    assert.doesNotMatch(text, /NOT read/);
    const second = one([jobCheck(9101)]);
    assert.deepEqual(second.logUnavailable, first.logUnavailable, "while it waits, the pass keeps the same retry time");
    assert.equal(shim.calls().filter((c) => c === logs(9101)).length, 1, "no read is made before the retry time");
  });
});

test("W1-T12713 criterion 2: a server error backs off from 60 s, doubling to 15 min, and a due read is retried", async () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(logFetchRetryAtMs({ kind: "transient" }, 1, now) - now, LOG_FETCH_BACKOFF_FIRST_MS);
  assert.equal(logFetchRetryAtMs({ kind: "transient" }, 2, now) - now, 2 * LOG_FETCH_BACKOFF_FIRST_MS);
  assert.equal(logFetchRetryAtMs({ kind: "transient" }, 9, now) - now, LOG_FETCH_BACKOFF_MAX_MS);
  assert.equal(logFetchRetryAtMs({ kind: "rate-limit", retryAfterMs: 5_000 }, 1, now) - now, 5_000);
  // A reset time already past makes the next pass's read due at once: the second pass retries and reads the log.
  await withGh([{ when: logs(9102), stderr: `${RATE_LIMIT}\nx-ratelimit-reset: 1000000000`, exit: 1 }], (shim) => {
    assert.equal(one([jobCheck(9102)]).logUnavailable?.kind, "deferred");
    shim.addRoute({ when: logs(9102), stdout: "not ok 1 - the real failing test" });
    const retried = one([jobCheck(9102)]);
    assert.equal(retried.logUnavailable, undefined);
    assert.equal(retried.tailSource, "log");
    assert.match(retried.logTail, /the real failing test/);
    assert.equal(shim.calls().filter((c) => c === logs(9102)).length, 2);
  });
});

test("W1-T12713 criterion 2: a pass before a deferred log's retry time does not dispatch a fix round", async () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const until = "2026-11-14T12:01:00.000Z";
  const pr: OpenPrView = {
    prNumber: 18550, prUrl: "https://github.com/acme/remudero/pull/18550", taskId: "W1-T12713", headSha: "d".repeat(40),
    headRefName: "run-W1-T12713-1", checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
    ciFailures: [{ name: "coverage-shard (6/8)", logTail: "", conclusion: "FAILURE", jobId: "9103",
      logUnavailable: { kind: "deferred", cause: "rate-limit", until, detail: RATE_LIMIT } }],
  };
  const rows: Record<string, unknown>[] = [];
  const dispatched: number[] = [];
  const deps = (at: number): SweepDeps => ({
    ledgerPath: "/unused/w1-t12713-ledger", runId: "w1-t12713", now: () => at,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    dispatchFix: (p) => { dispatched.push(p.prNumber); },
    arm: () => "armed", escalate: () => {}, close: () => {},
  });
  const held = await runSweep([pr], deps(now), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(dispatched, []);
  assert.match(held.actions[0]!.reason, /log read deferred \(rate-limit, retry at 2026-11-14T12:01:00\.000Z\)/);
  await runSweep([pr], deps(Date.parse(until) + 1), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(dispatched, [18550], "after the retry time the round goes ahead with what it has");
});

test("W1-T12713 criterion 3: an absent log and a check run with no job id are read from the check run's own output", async () => {
  const policy = "claims: setup did not succeed (classify=skipped install=skipped), so no gate ran";
  await withGh([
    { when: logs(9104), stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: checkRun(9104), stdout: output("claims", policy) },
    { when: checkRun(9105), stdout: output("remudero-review", "2 criteria unmet", "criterion 3: no proof") },
  ], async (shim) => {
    const absent = await oneAsync([jobCheck(9104)]);
    assert.equal(absent.tailSource, "check-output");
    assert.equal(absent.logTail, `claims\n${policy}`);
    assert.equal(absent.logUnavailable, undefined);
    const noJob = await oneAsync([{ name: "remudero-review", conclusion: "FAILURE", checkRunId: 9105 }]);
    assert.equal(noJob.tailSource, "check-output");
    assert.equal(noJob.logTail, "remudero-review\n2 criteria unmet\ncriterion 3: no proof");
    const status = await oneAsync([{ context: "security-merge-policy", state: "ERROR", description: "unknown: codeql result missing" }]);
    assert.equal(status.statusDescription, "unknown: codeql result missing", "a commit status keeps its own description");
    assert.equal(status.logTail, "");
    const injected = (await fetchCiFailuresAsync("craigoley", "remudero", [jobCheck(9104)], 60,
      { fetchAnnotations: () => [], fetchJobLog: () => { throw new Error("gh: Not Found (HTTP 404)"); } }))[0]!;
    assert.equal(injected.logUnavailable?.kind, "fetch-failed", "an injected log read starts no real check-run read");
    const inline = one([{ name: "claims", conclusion: "FAILURE", checkRunId: 9110, title: "claims", outputSummary: "no gate ran" }]);
    assert.equal(inline.logTail, "claims\nno gate ran", "the sync path reads the inline REST output and spawns no read");
    assert.equal(shim.calls().includes(checkRun(9110)), false);
    assert.ok(shim.calls().includes(checkRun(9104)) && shim.calls().includes(checkRun(9105)));
  });
});

test("W1-T12713 criterion 3: a read that fails twice more after its retry time uses the check run's output", async () => {
  await withGh([
    { when: logs(9106), stderr: `${RATE_LIMIT}\nx-ratelimit-reset: 1000000000`, exit: 1 },
    { when: checkRun(9106), stdout: output("coverage-shard (2/8)", "the runner lost its connection") },
  ], async () => {
    assert.equal((await oneAsync([jobCheck(9106)])).logUnavailable?.kind, "deferred");
    assert.equal((await oneAsync([jobCheck(9106)])).logUnavailable?.kind, "deferred", "the first failed retry still waits");
    const fallback = await oneAsync([jobCheck(9106)]);
    assert.equal(fallback.tailSource, "check-output", "the second failed retry reads the check run's output");
    assert.match(fallback.logTail, /lost its connection/);
  });
});

test("W1-T12713 criterion 4: invariant never-blind-when-output-exists — the fix round's excerpt is never empty", async () => {
  await withGh([
    { when: logs(9107), stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: checkRun(9107), stdout: output("depcruise", "no-circular: src/lib/a.ts -> src/lib/b.ts") },
    { when: checkRun(9108), stdout: output("security-merge-policy", "source-size: setup did not succeed") },
  ], async () => {
    const failures = await fetchCiFailuresAsync("craigoley", "remudero",
      [jobCheck(9107), { name: "security-merge-policy", conclusion: "FAILURE", checkRunId: 9108 }]);
    const evidence = failureEvidenceOf(failures);
    assert.equal(evidence.checks?.length, 2);
    for (const check of evidence.checks ?? []) {
      assert.ok((check.excerpt ?? "").trim() !== "", `${check.check} reaches the fix round with text`);
      assert.equal(check.tail_source, "check-output");
    }
  });
});

test("W1-T12713 criterion 5: serve reads an absent log from the check run's output and writes no unreadable row", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12713-serve-`));
  const gh = ghShim([
    { when: "actions/jobs/321/logs", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "check-runs/321", stdout: output("claims", "setup did not succeed, so no gate ran") },
    { when: "actions/jobs/322/logs", stderr: RATE_LIMIT, exit: 1 },
  ], { kind: "w1-t12713-serve" });
  const moduleUrl = pathToFileURL(join(REPO_ROOT, "src/lib/ci-incidents.ts")).href;
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { readCiIncidentJobLog } from ${JSON.stringify(moduleUrl)};
       const rows = []; const log = (step, extra) => rows.push({ step, cause: extra?.cause });
       const absent = await readCiIncidentJobLog("craigoley/remudero", 321, undefined, log);
       const limited = await readCiIncidentJobLog("craigoley/remudero", 322, undefined, log);
       process.stdout.write(JSON.stringify({ absent, limited, rows }));`],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH ?? ""}`, HOME: root,
      RMD_GH_CACHE_HOME: root, RMD_GH_TRANSPORT_FLOOR: "advisory" } });
    assert.deepEqual(JSON.parse(out), { absent: "claims\nsetup did not succeed, so no gate ran", limited: "",
      rows: [{ step: "serve.ci_incidents.job_log_unreadable", cause: "rate-limit" }] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});

test("W1-T12713 criterion 5: serve keeps its unreadable row for an error it cannot classify", async () => {
  const rows: Array<Record<string, unknown>> = [];
  assert.equal(await readCiIncidentJobLog("craigoley/remudero", 323, () => { throw new Error("fixture transport failure"); },
    (step, extra) => rows.push({ step, ...extra })), "");
  assert.deepEqual(rows, [{ step: "serve.ci_incidents.job_log_unreadable", reason: "fixture transport failure",
    repository: "craigoley/remudero", jobId: 323 }]);
});

test("W1-T12713 criterion 6: a log that reads today is read the same way, with the same tail and tail_source", async () => {
  const log = ["##[group]Run npm test", "ok 1 - passes", "not ok 2 - the failing test", "##[error]Process completed with exit code 1."];
  await withGh([{ when: logs(9109), stdout: log.join("\n") }, { when: checkRun(9109), stdout: output("unused", "unused") }],
    async (shim) => {
      const sync = one([jobCheck(9109)]);
      const async = (await fetchCiFailuresAsync("craigoley", "remudero", [jobCheck(9109)]))[0]!;
      for (const read of [sync, async]) {
        assert.equal(read.tailSource, "log");
        assert.equal(read.logUnavailable, undefined);
        assert.match(read.logTail, /not ok 2 - the failing test/);
      }
      assert.equal(shim.calls().some((c) => c === checkRun(9109)), false, "a readable log never reads the check output");
    });
});
