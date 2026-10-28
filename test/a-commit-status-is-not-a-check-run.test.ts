import assert from "node:assert/strict";
import { test } from "node:test";
import { reportPrChecks } from "#src/run-task.js";
import { classifyCheckState, fetchPrChecks, summarizePrChecks } from "#src/lib/pr-checks.js";

// W1-T3083: two hand-rolled rollup queries read as confident wrong answers in opposite directions.
// (a) A commit status carries `state`, not `conclusion`, so a query on `conclusion` alone dropped
//     #4493's Standing-rule-25 refusal. (b) A SHA accumulates one entry per attempt, so without the
//     latest-attempt dedupe a superseded FAILURE outranked its own later SUCCESS (#4485).

const SHA = "a".repeat(40);

interface Head {
  runs?: unknown[];
  statuses?: unknown[];
  failOn?: RegExp;
}

function fetcherFor(head: Head) {
  return (args: string[]): unknown => {
    const url = args[1] ?? "";
    if (head.failOn?.test(url)) throw new Error("HTTP 502");
    if (/\/pulls\/\d+$/.test(url)) return { number: 7, html_url: "u", updated_at: "t", head: { sha: SHA } };
    if (url.includes("/check-runs")) return { check_runs: head.runs ?? [] };
    if (url.endsWith("/status")) return { statuses: head.statuses ?? [] };
    if (url.includes("/actions/runs")) return { workflow_runs: [] };
    throw new Error(`unexpected read ${url}`);
  };
}

const run = (name: string, conclusion: string | null, startedAt: string, id: number) => ({
  id,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  ...(conclusion === null ? {} : { conclusion }),
  started_at: startedAt,
});

function capture(rest: string[], fetch: ReturnType<typeof fetcherFor>): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = reportPrChecks(rest, { fetch, self: { owner: "o", repo: "r" } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("a commit status reaches the verdict, so a rule 25 refusal cannot read as no red checks", () => {
  const fetch = fetcherFor({
    runs: [run("ci-gate", "success", "2026-09-07T10:00:00Z", 1)],
    statuses: [{ context: "remudero-review", state: "failure", created_at: "2026-09-07T10:05:00Z", updated_at: "2026-09-07T10:05:00Z" }],
  });
  const report = fetchPrChecks("o", "r", 7, fetch);
  assert.deepEqual(report.red, ["remudero-review"]);
  assert.equal(report.exitCode, 1);
  const cli = capture(["7"], fetch);
  assert.equal(cli.code, 1);
  assert.match(cli.out, /1 red/);
  assert.match(cli.out, /remudero-review/);
});

test("a superseded attempt does not outrank its own later success", () => {
  const fetch = fetcherFor({
    runs: [
      run("source-size", "failure", "2026-09-07T10:00:00Z", 1),
      run("source-size", "success", "2026-09-07T10:30:00Z", 2),
    ],
  });
  const report = fetchPrChecks("o", "r", 7, fetch);
  assert.deepEqual(report.red, []);
  assert.deepEqual(report.rows.map((r) => [r.name, r.verdict]), [["source-size", "ok"]]);
  assert.equal(capture(["7"], fetch).code, 0);
});

test("a latest attempt that is itself a failure stays red", () => {
  const fetch = fetcherFor({
    runs: [
      run("source-size", "success", "2026-09-07T10:00:00Z", 1),
      run("source-size", "failure", "2026-09-07T10:30:00Z", 2),
    ],
  });
  assert.deepEqual(fetchPrChecks("o", "r", 7, fetch).red, ["source-size"]);
});

test("fail closed on a word we cannot name: an unknown or absent outcome is pending, never green", () => {
  assert.equal(classifyCheckState("SUCCESS"), "ok");
  assert.equal(classifyCheckState("skipped"), "ok");
  assert.equal(classifyCheckState("NEUTRAL"), "ok");
  assert.equal(classifyCheckState("TIMED_OUT"), "red");
  assert.equal(classifyCheckState("SOMETHING_GITHUB_ADDED_LATER"), "pending");
  assert.equal(classifyCheckState(""), "pending");
  const report = summarizePrChecks([{ name: "novel", status: "COMPLETED", conclusion: "BRAND_NEW" }, { name: "running", status: "IN_PROGRESS" }]);
  assert.deepEqual(report.pending, ["novel", "running"]);
  assert.deepEqual(report.red, []);
  assert.equal(report.rows.some((r) => r.verdict === "ok"), false);
});

test("a failed read exits 2 and never reads as no red checks", () => {
  for (const failOn of [/\/pulls\/7$/, /\/check-runs/, /\/status$/]) {
    const res = capture(["7"], fetcherFor({ failOn }));
    assert.equal(res.code, 2, String(failOn));
    assert.match(res.err, /could not read PR #7/);
    assert.equal(res.out, "");
  }
});

test("a head with no sha is a failed read, not an empty green", () => {
  const res = capture(["7"], () => ({ number: 7 }));
  assert.equal(res.code, 2);
  assert.match(res.err, /no head sha/);
});

test("bad usage exits 2", () => {
  assert.equal(capture([], fetcherFor({})).code, 2);
  assert.equal(capture(["--repo", "x"], fetcherFor({})).code, 2);
  assert.equal(capture(["abc"], fetcherFor({})).code, 2);
  assert.equal(capture(["7", "--bogus"], fetcherFor({})).code, 2);
});

test("a head with no checks at all reports so, exit 0", () => {
  const res = capture(["7"], fetcherFor({}));
  assert.equal(res.code, 0);
  assert.match(res.out, /no checks reported/);
});

test("a workflow identity listing is read only when one name spans two workflow runs", () => {
  const reads: string[] = [];
  const base = fetcherFor({
    runs: [
      { ...run("x", "success", "2026-09-07T10:00:00Z", 1), details_url: "https://github.com/o/r/actions/runs/11/job/1" },
      { ...run("x", "success", "2026-09-07T10:10:00Z", 2), details_url: "https://github.com/o/r/actions/runs/12/job/2" },
    ],
  });
  fetchPrChecks("o", "r", 7, (args) => {
    reads.push(args[1] ?? "");
    return base(args);
  });
  assert.ok(reads.some((u) => u.includes("/actions/runs")));
});
