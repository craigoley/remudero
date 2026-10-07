/**
 * W1-T4574 — the GitHub half of the field-trials aggregate: paged, resumable, watermarked reads
 * behind one injectable page seam. Every test answers from a fixture; the one default-seam test
 * answers from the shared `gh` PATH shim, never the network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  authorClassOf, emptyRepoStore, ghApiFetch, GITHUB_PAGE_SIZE, ingestFieldTrialsGithub, observedCurrentHeadGreen, pageOf, parseGithubStore, pullOf,
  REVERTS_LINE_RE, revertedPrNumber, RUN_BRANCH_RE, summarizeChecks, TRAILER_LINE_RE, trailerTaskIds,
  type FieldTrialsGithubStore, type GithubPage,
} from "../src/lib/field-trials-github.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

type Fixture = {
  pulls?: unknown[]; commits?: unknown[]; deployments?: unknown[];
  reviews?: Record<number, unknown[]>; prCommits?: Record<number, unknown[]>;
  checkRuns?: Record<string, unknown[]>; statuses?: Record<number, unknown[]>;
  workflowRuns?: Record<number, unknown[]>; jobs?: Record<number, unknown[]>;
};

/** A fake page seam over per-repo fixture lists, paged exactly like the REST API. */
function githubFake(fixtures: Record<string, Fixture>, failing: (path: string) => boolean = () => false) {
  const calls: string[] = [];
  const fetch = async (path: string): Promise<GithubPage> => {
    calls.push(path);
    if (failing(path)) return { ok: false, reason: "github-read-failed" };
    const [, owner, name, ...rest] = path.split("?")[0]!.split("/");
    const fixture = fixtures[`${owner}/${name}`] ?? {};
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    const slice = (items: unknown[] = []) => ({ ok: true as const, items: items.slice((page - 1) * GITHUB_PAGE_SIZE, page * GITHUB_PAGE_SIZE) });
    if (rest[0] === "pulls" && rest.length === 1) return slice(fixture.pulls);
    if (rest[0] === "pulls" && rest[2] === "reviews") return slice(fixture.reviews?.[Number(rest[1])]);
    if (rest[0] === "pulls" && rest[2] === "commits") return slice(fixture.prCommits?.[Number(rest[1])]);
    if (rest[0] === "commits" && rest.length === 1) return slice(fixture.commits);
    if (rest[0] === "commits" && rest[2] === "check-runs") return slice(fixture.checkRuns?.[rest[1]!]);
    if (rest[0] === "deployments" && rest.length === 1) return slice(fixture.deployments);
    if (rest[0] === "deployments" && rest[2] === "statuses") return slice(fixture.statuses?.[Number(rest[1])]);
    if (rest[0] === "actions" && rest[1] === "runs") return slice(fixture.workflowRuns?.[Number(rest[2])]);
    if (rest[0] === "actions" && rest[1] === "jobs") return slice(fixture.jobs?.[Number(rest[2])]);
    return { ok: false, reason: "unrouted" };
  };
  return { fetch, calls };
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString();

function pr(number: number, updatedMinute: number, extra: Record<string, unknown> = {}) {
  return { node_id: `PR_${number}`, number, state: "closed", created_at: at(0), updated_at: at(updatedMinute),
    merged_at: at(updatedMinute), closed_at: at(updatedMinute), merge_commit_sha: `m${number}`,
    head: { ref: `run-T${number}-1`, sha: `h${number}` }, body: `Remudero-Task: T${number}`, user: { login: "remudero-fleet[bot]", type: "Bot" }, ...extra };
}

test("field trials github regexes accept a trailer, run branch and revert line and refuse near misses", () => {
  assert.equal(TRAILER_LINE_RE.test("Remudero-Task: W1-T4574"), true);
  assert.equal(TRAILER_LINE_RE.test("Remudero-Task: W1-T4574 and more"), false);
  assert.equal(RUN_BRANCH_RE.test("run-W1-T4574-1790536527462"), true);
  assert.equal(RUN_BRANCH_RE.test("fix/W1-T4574"), false);
  assert.equal(REVERTS_LINE_RE.test("Reverts craigoley/remudero#7490"), true);
  assert.equal(REVERTS_LINE_RE.test("Reverts the thing in #7490"), false);
  assert.deepEqual(trailerTaskIds("x\nRemudero-Task: A-1\nRemudero-Task: B-2\r\nRemudero-Task: A-1\n"), ["A-1", "B-2"]);
  assert.deepEqual(trailerTaskIds(null), []);
  assert.equal(revertedPrNumber("Reverts o/r#12\n\nbody"), 12);
  assert.equal(revertedPrNumber("no revert here"), null);
  assert.equal(revertedPrNumber(undefined), null);
  assert.equal(authorClassOf({ login: "dependabot[bot]" }), "bot");
  assert.equal(authorClassOf({ login: "fleet", type: "Bot" }), "bot");
  assert.equal(authorClassOf({ login: "a-person", type: "User" }), "human");
  assert.equal(authorClassOf(null), "unknown");
  assert.equal(pullOf({ number: 3 }), null, "a PR without a node id cannot be joined");
  assert.equal(pullOf({ ...pr(4, 1), merged_at: null })!.mergeCommitSha, null, "an unmerged PR carries no merge commit");
});

test("field trials github pages are lists and a rerun never outvotes its own latest attempt", () => {
  assert.deepEqual(pageOf("[1,2]"), { ok: true, items: [1, 2] });
  assert.deepEqual(pageOf('{"total_count":1,"check_runs":[{"id":1}]}'), { ok: true, items: [{ id: 1 }] });
  assert.deepEqual(pageOf('{"message":"Not Found"}'), { ok: false, reason: "github-page-not-a-list" });
  assert.deepEqual(pageOf("<html>"), { ok: false, reason: "github-page-unparseable" });
  const run = (id: number, name: string, conclusion: string | null, status = "completed") => ({ id, name, status, conclusion });
  assert.deepEqual(summarizeChecks("s", [run(1, "ci", "failure"), run(2, "ci", "success"), run(3, "lint", "skipped"), { id: 4 }]),
    { sha: "s", state: "green", distinctChecks: 2, reruns: 1 });
  assert.equal(summarizeChecks("s", [run(2, "ci", "success"), run(1, "ci", "failure")]).state, "green", "latest id wins regardless of order");
  assert.equal(summarizeChecks("s", [run(1, "ci", "failure")]).state, "red");
  assert.equal(summarizeChecks("s", [run(1, "ci", null, "in_progress")]).state, "pending");
  assert.equal(summarizeChecks("s", []).state, "none");
  assert.deepEqual(parseGithubStore({ version: "other" }), { version: "field-trials-github-v1", repos: {} });
  assert.deepEqual(parseGithubStore({ version: "field-trials-github-v1", repos: { "o/r": {} } }).repos, {});
  const kept = { version: "field-trials-github-v1" as const, repos: { "o/r": emptyRepoStore() } };
  assert.equal(parseGithubStore(kept), kept);
});

test("field trials github resumes a failed page and advances the watermark only when a sweep completes", async () => {
  const pulls = Array.from({ length: 150 }, (_, i) => pr(150 - i, 1000 - i));
  const commit = (sha: string, minute: number) => ({ sha, commit: { committer: { date: at(minute) } } });
  const fixture: Fixture = { pulls, commits: [commit("c2", 5), commit("c1", 1), { sha: "no-date" }],
    deployments: [{ id: 7, sha: "c2", created_at: at(6) }, { id: 8, sha: "c1", created_at: at(2) }, { id: 9, sha: "c1", created_at: at(1) }, { sha: "x" }],
    statuses: { 7: [{ state: "success", created_at: at(7) }], 8: [] },
    prCommits: Object.fromEntries(pulls.map((item) => [item.number, [commit(`f${item.number}`, 0), commit(`l${item.number}`, 3)]])),
    reviews: Object.fromEntries(pulls.map((item) => [item.number, [{ state: "CHANGES_REQUESTED", user: { login: "a", type: "User" } },
      { state: "APPROVED", user: { login: "b[bot]" } }]])),
    checkRuns: { f150: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }] } };
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  let failPage2 = true;
  const fake = githubFake({ "o/r": fixture }, (path) => (failPage2 && path.includes("/pulls?") && path.endsWith("page=2"))
    || path.includes("deployments/9/"));
  const first = await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, "2026-09-02T00:00:00.000Z", 10);
  const cursor = store.repos["o/r"]!.cursors.pulls;
  assert.equal(first.state, "partial");
  assert.deepEqual([cursor.state, cursor.resumePage, cursor.watermark, cursor.reason], ["partial", 2, null, "github-read-failed"]);
  assert.equal(Object.keys(store.repos["o/r"]!.pulls).length, 100, "page one is kept, not discarded");
  assert.equal(store.repos["o/r"]!.cursors.commits.state, "complete");
  assert.deepEqual(store.repos["o/r"]!.commits, { c2: at(5), c1: at(1) });
  assert.deepEqual(store.repos["o/r"]!.deployments["7"]!.status, { state: "success", at: at(7) });
  assert.deepEqual(store.repos["o/r"]!.deployments["8"]!.status, { state: "no-status", at: null });
  assert.deepEqual(store.repos["o/r"]!.deployments["9"]!.status, { state: "unavailable", reason: "github-read-failed" });
  assert.ok(first.repos["o/r"]!.detailsPending > 0, "the page budget left PR detail pending, and the pass says so");

  failPage2 = false;
  fake.calls.length = 0;
  const second = await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, "2026-09-03T00:00:00.000Z", 1000);
  assert.equal(fake.calls[0], "repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1", "recent updates are read while the history remains incomplete");
  assert.ok(fake.calls.includes("repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2"), "also resumes the stored historical page");
  assert.equal(second.state, "complete");
  assert.deepEqual([cursor.state, cursor.resumePage, cursor.watermark, cursor.asOf], ["complete", null, at(1000), "2026-09-03T00:00:00.000Z"]);
  assert.equal(Object.keys(store.repos["o/r"]!.pulls).length, 150);
  assert.equal(fake.calls.filter((path) => path.includes("/deployments/7/")).length, 0, "a terminal deployment status is not re-read");
  const detailed = store.repos["o/r"]!.pulls["PR_150"]!.detail;
  assert.equal(detailed.state, "observed");
  if (detailed.state !== "observed") return;
  assert.deepEqual(detailed.reviews, { total: 2, human: 1, changesRequested: 1, approvals: 1, truncated: false });
  assert.deepEqual(detailed.commits, { count: 2, firstSha: "f150", lastCommittedAt: at(3), truncated: false });
  assert.deepEqual(detailed.checks, { sha: "f150", state: "red", distinctChecks: 1, reruns: 0 });

  const edited = { ...pulls[5]!, updated_at: at(2000), state: "open", merged_at: null };
  fixture.pulls = [edited, ...pulls.filter((item) => item !== pulls[5])];
  fake.calls.length = 0;
  await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, "2026-09-04T00:00:00.000Z", 1000);
  assert.equal(fake.calls.filter((path) => path.includes("/pulls?")).length, 1, "an incremental sweep stops at the watermark");
  assert.equal(cursor.watermark, at(2000));
  const reread = store.repos["o/r"]!.pulls[edited.node_id]!;
  assert.equal(reread.detail.state === "observed" && reread.detail.readWhileOpen, true, "an edited PR's detail is re-read");
  assert.deepEqual(fake.calls.filter((path) => path.includes("/reviews")), [`repos/o/r/pulls/${edited.number}/reviews?per_page=100`],
    "only the edited PR's detail is re-read; unchanged PRs keep theirs");
  fake.calls.length = 0;
  await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, "2026-09-05T00:00:00.000Z", 1000);
  assert.equal(fake.calls.filter((path) => path.includes("/reviews")).length, 1, "open work is re-read every pass until it closes");
});

test("field trials github names unavailable detail, an exhausted budget and a repository it could not read", async () => {
  const fixture: Fixture = { pulls: [pr(1, 1), pr(2, 2), pr(3, 3)], prCommits: { 2: [{ sha: "f2" }], 3: [] }, reviews: { 1: [], 3: [] } };
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  const fake = githubFake({ "o/r": fixture }, (path) => path.includes("/pulls/1/commits") || path.includes("/pulls/2/reviews")
    || path.startsWith("repos/o/down/"));
  const pass = await ingestFieldTrialsGithub(fake.fetch, ["o/r", "o/down"], store, "2026-09-02T00:00:00.000Z", 40);
  const pulls = store.repos["o/r"]!.pulls;
  assert.deepEqual(pulls["PR_1"]!.detail, { state: "unavailable", reason: "github-read-failed" });
  assert.deepEqual(pulls["PR_2"]!.detail, { state: "unavailable", reason: "github-read-failed" });
  const noCommits = pulls["PR_3"]!.detail;
  assert.deepEqual(noCommits.state === "observed" && noCommits.checks, { state: "unavailable", reason: "no-commits-read" });
  assert.equal(pass.repos["o/r"]!.detailsUnavailable, 2);
  assert.deepEqual([store.repos["o/down"]!.cursors.pulls.state, store.repos["o/down"]!.cursors.pulls.reason], ["unavailable", "github-read-failed"]);
  assert.equal(pass.state, "partial");

  const tight: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  const exhausted = await ingestFieldTrialsGithub(githubFake({ "o/r": fixture }).fetch, ["o/r"], tight, "2026-09-02T00:00:00.000Z", 2);
  assert.deepEqual([tight.repos["o/r"]!.cursors.deployments.state, tight.repos["o/r"]!.cursors.deployments.reason, tight.repos["o/r"]!.cursors.deployments.resumePage],
    ["partial", "page-budget-exhausted", 1]);
  assert.equal(exhausted.repos["o/r"]!.detailsPending, 3);
  const none = await ingestFieldTrialsGithub(githubFake({}, () => true).fetch, ["o/a", "o/b"], { version: "field-trials-github-v1", repos: {} },
    "2026-09-02T00:00:00.000Z");
  assert.equal(none.state, "unavailable", "every repository unreadable is unavailable, never an empty complete history");
});

test("field trials github default seam shells gh api and turns a failed read into a reason", async () => {
  const shim = ghShim([
    { when: "repos/o/r/pulls", stdout: JSON.stringify([pr(1, 1)]) },
    { when: "repos/o/r/commits", stderr: "HTTP 502", exit: 1 },
  ]);
  const cache = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}field-trials-gh-cache-`));
  const saved = { PATH: process.env.PATH, RMD_GH_CACHE_HOME: process.env.RMD_GH_CACHE_HOME };
  process.env.PATH = `${shim.dir}:${saved.PATH}`;
  process.env.RMD_GH_CACHE_HOME = cache;
  try {
    const fetch = ghApiFetch();
    const ok = await fetch("repos/o/r/pulls?page=1");
    assert.equal(ok.ok && (ok.items[0] as { number: number }).number, 1);
    assert.deepEqual(await fetch("repos/o/r/commits?page=1"), { ok: false, reason: "github-read-failed" });
    assert.deepEqual(shim.calls(), ["api repos/o/r/pulls?page=1", "api repos/o/r/commits?page=1"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cache, { recursive: true, force: true });
  }
  const refused = ghApiFetch(async () => { throw new Error("read floor refused"); });
  assert.deepEqual(await refused("repos/o/r/pulls"), { ok: false, reason: "github-read-failed" }, "a refused read is a reason, not a crash");
  const injected = ghApiFetch(async (args) => JSON.stringify([{ args }]));
  assert.deepEqual(await injected("repos/o/r/pulls"), { ok: true, items: [{ args: ["api", "repos/o/r/pulls"] }] });
});


test("daily field trials read recent commits deployments and PR detail while a large history remains incomplete", async () => {
  const pulls = Array.from({ length: 1000 }, (_, i) => pr(1000 - i, 1000 - i));
  const fixture: Fixture = {
    pulls,
    commits: Array.from({ length: 1000 }, (_, i) => ({ sha: `c${1000 - i}`, commit: { committer: { date: at(1000 - i) } } })),
    deployments: Array.from({ length: 1000 }, (_, i) => ({ id: 1000 - i, sha: `c${1000 - i}`, created_at: at(1000 - i) })),
    statuses: { 1000: [{ state: "success", created_at: at(1001) }], 999: [{ state: "success", created_at: at(1001) }] },
    prCommits: { 1000: [{ sha: "first1000" }], 9000: [{ sha: "first9000" }] },
  };
  const fake = githubFake({ "o/r": fixture });
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  const first = await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, at(3000), 8);
  const saved = store.repos["o/r"]!;
  assert.equal(fake.calls.length, 8, "the transport remains inside the request bound");
  assert.equal(first.pagesRead, fake.calls.length, "successful status and detail pages are counted too");
  assert.equal(first.requestsMade, fake.calls.length, "the total includes every transport attempt");
  assert.equal(first.state, "partial", "unfinished history is not called complete");
  assert.equal(saved.commits.c1000, at(1000));
  assert.equal(saved.deployments["1000"]!.status.state, "success");
  assert.equal(saved.pulls.PR_1000!.detail.state, "observed");
  assert.equal(saved.cursors.pulls.watermark, null);
  assert.equal(saved.cursors.pulls.resumePage, 3);
  for (const cursor of Object.values(saved.cursors)) assert.deepEqual(cursor.head, { state: "observed", asOf: at(3000), reason: null });
  assert.ok((first.repos["o/r"]!.statusesPending ?? 0) > 0);

  fixture.pulls = [pr(9000, 2000), ...pulls];
  fake.calls.length = 0;
  await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, at(4000), 8);
  assert.ok(fake.calls.length <= 8);
  assert.equal(saved.pulls.PR_9000!.detail.state, "observed", "new work does not wait for the old PR backfill");
  assert.equal(saved.cursors.pulls.resumePage, 3, "refreshing page one does not discard a saved historical page");
  assert.equal(saved.cursors.commits.resumePage, 3, "the next historical page rotates to commits");
  assert.equal(saved.cursors.pulls.watermark, null, "a fresh head is not complete historical coverage");

  fake.calls.length = 0;
  await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, at(5000), 8);
  assert.ok(fake.calls.includes("repos/o/r/deployments?per_page=100&page=2"), "deployment history also receives its turn");
});

test("a failed recent field-trial head read preserves its history and reports unavailable freshness", async () => {
  const saved = emptyRepoStore();
  saved.commits.kept = at(1);
  saved.cursors.commits = { ...saved.cursors.commits, state: "partial", resumePage: 7, sweepHigh: at(4) };
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: { "o/r": saved } };
  const fake = githubFake({}, (path) => path.includes("/commits?"));
  const pass = await ingestFieldTrialsGithub(fake.fetch, ["o/r"], store, at(5), 8);
  assert.equal(pass.state, "partial");
  assert.equal(pass.requestsMade, fake.calls.length);
  assert.equal(pass.pagesRead, fake.calls.length - 1, "a failed read is an attempt rather than a page of evidence");
  assert.deepEqual(saved.commits, { kept: at(1) });
  assert.equal(saved.cursors.commits.resumePage, 7);
  assert.deepEqual(saved.cursors.commits.head, { state: "unavailable", asOf: at(5), reason: "github-read-failed" });
  assert.equal(fake.calls.filter((path) => path.includes("/commits?")).length, 1, "a failed resource is not polled again in the same pass");
});

test("a field-trial request bound smaller than the repository count is still a total bound", async () => {
  const fake = githubFake({});
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  const pass = await ingestFieldTrialsGithub(fake.fetch, ["o/a", "o/b", "o/c"], store, at(1), 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(pass.pagesRead, 1);
  assert.equal(pass.state, "partial");
  assert.equal(pass.repos["o/b"]!.pulls.reason, "page-budget-exhausted");
  assert.equal(pass.repos["o/c"]!.pulls.state, "partial");
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    await assert.rejects(ingestFieldTrialsGithub(fake.fetch, ["o/a"], store, at(1), invalid), RangeError);
  }
  assert.equal(fake.calls.length, 1, "invalid bounds issue no requests");
});

test("the daily field-trial budget observes every repository during backfill even with a damaged scheduler hint", async () => {
  const fixture: Fixture = {
    pulls: Array.from({ length: 1000 }, (_, i) => pr(1000 - i, 1000 - i)),
    commits: [{ sha: "latest", commit: { committer: { date: at(1000) } } }],
    deployments: [{ id: 1000, sha: "latest", created_at: at(1000) }],
    statuses: { 1000: [{ state: "success", created_at: at(1001) }] },
    prCommits: { 1000: [{ sha: "first" }] },
  };
  const repos = ["o/core", "o/site", "o/console"];
  const fake = githubFake(Object.fromEntries(repos.map((repo) => [repo, fixture])));
  const cached = { version: "field-trials-github-v1", repos: Object.fromEntries(repos.map((repo) =>
    [repo, { ...emptyRepoStore(), backfillResourceIndex: -1 }])) };
  const store = parseGithubStore(JSON.parse(JSON.stringify(cached)));
  const pass = await ingestFieldTrialsGithub(fake.fetch, repos, store, at(2000), 24);
  assert.ok(fake.calls.length <= 24);
  assert.equal(pass.requestsMade, fake.calls.length);
  for (const repo of repos) {
    const saved = store.repos[repo]!;
    assert.equal(saved.commits.latest, at(1000));
    assert.equal(saved.deployments["1000"]!.status.state, "success");
    assert.equal(saved.pulls.PR_1000!.detail.state, "observed");
    assert.equal(saved.cursors.pulls.state, "partial");
    assert.equal(saved.cursors.pulls.watermark, null);
    assert.ok((saved.backfillResourceIndex ?? -1) >= 0);
  }
});

function headGateFixture(repo = 'o/r', workflow = '.github/workflows/ci.yml') {
  const sha = 'a'.repeat(40);
  const pull = pr(1, 5, { head: { ref: 'feature', sha } });
  const check = { id: 11, name: 'ci-gate', head_sha: sha, status: 'completed', conclusion: 'success',
    completed_at: at(4), app: { slug: 'github-actions' }, check_suite: { id: 22 },
    details_url: `https://github.com/${repo}/actions/runs/33/job/44` };
  const run = { id: 33, head_sha: sha, check_suite_id: 22, repository: { full_name: repo },
    workflow_id: 55, path: workflow, event: 'pull_request', pull_requests: [{ number: 1, head: { sha } }] };
  const job = { id: 44, run_id: 33, head_sha: sha, name: 'ci-gate', status: 'completed', conclusion: 'success',
    completed_at: at(4), check_run_url: `https://api.github.com/repos/${repo}/check-runs/11` };
  const fixture: Fixture = { pulls: [pull], prCommits: { 1: [{ sha: 'first-commit' }] },
    checkRuns: { 'first-commit': [{ id: 99, name: 'ci-gate', status: 'completed', conclusion: 'success' }], [sha]: [check] },
    workflowRuns: { 33: [run] }, jobs: { 44: [job] } };
  return { sha, pull, check, run, job, fixture };
}

test('current-head green preserves successful producer identity and never claims first-ever history', async () => {
  for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/ci-gate.yml']) {
    const f = headGateFixture('o/r', workflow); const fake = githubFake({ 'o/r': f.fixture });
    const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
    const first = await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
    assert.ok(first.requestsMade! <= 8);
    const pull = store.repos['o/r']!.pulls.PR_1!;
    assert.equal(observedCurrentHeadGreen(pull, at(10)), null, 'producer metadata is pending, not successful work');
    const spent = fake.calls.length;
    await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(11), 8);
    assert.ok(fake.calls.length - spent <= 8);
    const found = observedCurrentHeadGreen(pull, at(11))!;
    assert.equal(found.completedAt, at(4)); assert.equal(found.firstReadAt, at(10)); assert.equal(found.validatedAt, at(11));
    assert.deepEqual([found.checkId, found.suiteId, found.runId, found.jobId, found.producer.path], [11, 22, 33, 44, workflow]);
    assert.equal(pull.headGreen!.firstEver, 'unavailable-retention-uncertified');
    assert.ok(fake.calls.includes(`repos/o/r/commits/${f.sha}/check-runs?check_name=ci-gate&filter=all&per_page=100&page=1`));
    assert.equal(pull.detail.state === 'observed' && pull.detail.checks.state, 'green', 'legacy first-commit classification stays separate');
  }
});

test('a first-commit success cannot describe a changed head even when updated-at does not change', async () => {
  const f = headGateFixture(); const fake = githubFake({ 'o/r': f.fixture });
  const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(11), 8);
  const old = store.repos['o/r']!.pulls.PR_1!; assert.ok(observedCurrentHeadGreen(old, at(11)));
  f.pull.head = { ref: 'feature', sha: 'b'.repeat(40) };
  const before = fake.calls.length;
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(12), 8);
  const next = store.repos['o/r']!.pulls.PR_1!;
  assert.equal(next.updatedAt, old.updatedAt); assert.notEqual(next.headSha, old.headSha);
  assert.equal(observedCurrentHeadGreen(next, at(12)), null);
  assert.notEqual(next.headGreen, old.headGreen);
  assert.ok(fake.calls.slice(before).includes('repos/o/r/pulls/1/commits?per_page=100'), 'the head change also invalidates cached detail');
});

test('a green check needs the actual PR workflow run and physical job identities', async () => {
  const mutations = [
    (f: ReturnType<typeof headGateFixture>) => { f.check.app.slug = 'other-app'; },
    (f: ReturnType<typeof headGateFixture>) => { f.check.head_sha = 'b'.repeat(40); },
    (f: ReturnType<typeof headGateFixture>) => { f.check.completed_at = at(30); },
    (f: ReturnType<typeof headGateFixture>) => { f.check.conclusion = 'neutral'; },
    (f: ReturnType<typeof headGateFixture>) => { f.check.details_url = 'https://github.com/foreign/repo/actions/runs/33/job/44'; },
    (f: ReturnType<typeof headGateFixture>) => { f.check.details_url = 'not a URL'; },
    (f: ReturnType<typeof headGateFixture>) => { Object.assign(f.check, { check_suite: undefined }); },
    (f: ReturnType<typeof headGateFixture>) => { f.check.check_suite.id = 0; },
    (f: ReturnType<typeof headGateFixture>) => { f.run.event = 'merge_group'; },
    (f: ReturnType<typeof headGateFixture>) => { f.run.path = '.github/workflows/spoof.yml'; },
    (f: ReturnType<typeof headGateFixture>) => { f.run.repository.full_name = 'foreign/repo'; },
    (f: ReturnType<typeof headGateFixture>) => { f.run.check_suite_id = 23; },
    (f: ReturnType<typeof headGateFixture>) => { f.run.pull_requests[0]!.head.sha = 'b'.repeat(40); },
    (f: ReturnType<typeof headGateFixture>) => { f.job.head_sha = 'b'.repeat(40); },
    (f: ReturnType<typeof headGateFixture>) => { f.job.run_id = 34; },
    (f: ReturnType<typeof headGateFixture>) => { f.job.check_run_url = 'https://api.github.com/repos/o/r/check-runs/12'; },
    (f: ReturnType<typeof headGateFixture>) => { f.job.completed_at = at(30); },
    (f: ReturnType<typeof headGateFixture>) => { f.job.conclusion = 'failure'; },
  ];
  for (const change of mutations) {
    const f = headGateFixture(); change(f); const fake = githubFake({ 'o/r': f.fixture });
    const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
    await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
    await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(11), 8);
    assert.equal(observedCurrentHeadGreen(store.repos['o/r']!.pulls.PR_1!, at(11)), null);
  }
});

test('the fixed daily budget keeps all repositories fresh while head identities resume privately', async () => {
  const repos = ['o/core', 'o/site', 'o/console'];
  const fixtures = Object.fromEntries(repos.map((repo) => [repo, headGateFixture(repo).fixture]));
  const fake = githubFake(fixtures); const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  for (const minute of [10, 11]) {
    const before = fake.calls.length;
    const pass = await ingestFieldTrialsGithub(fake.fetch, repos, store, at(minute), 24);
    assert.equal(pass.requestsMade, fake.calls.length - before); assert.ok(pass.requestsMade! <= 24);
    for (const repo of repos) for (const cursor of Object.values(store.repos[repo]!.cursors)) assert.equal(cursor.head?.asOf, at(minute));
  }
  for (const repo of repos) assert.ok(observedCurrentHeadGreen(store.repos[repo]!.pulls.PR_1!, at(11)));
});

test('a pending open head is re-read after checks finish without an updated-at bump', async () => {
  const f = headGateFixture(); f.pull.state = 'open'; f.fixture.checkRuns![f.sha] = [];
  const fake = githubFake({ 'o/r': f.fixture }); const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
  f.fixture.checkRuns![f.sha] = [f.check];
  for (const minute of [11, 12, 13]) await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(minute), 8);
  assert.ok(observedCurrentHeadGreen(store.repos['o/r']!.pulls.PR_1!, at(13)));
});

test('the existing default GitHub seam decodes real action objects and reports malformed responses', async () => {
  const f = headGateFixture();
  assert.deepEqual(pageOf(JSON.stringify(f.run)), { ok: true, items: [f.run] });
  assert.deepEqual(pageOf(JSON.stringify(f.job)), { ok: true, items: [f.job] });
  assert.equal(pageOf('{"id":33,"message":"unavailable"}').ok, false);
  const shim = ghShim([{ when: 'repos/o/r/actions/jobs/44', stdout: JSON.stringify(f.job) }]);
  const oldPath = process.env.PATH; process.env.PATH = shim.dir + ':' + oldPath;
  try { assert.deepEqual(await ghApiFetch()('repos/o/r/actions/jobs/44'), { ok: true, items: [f.job] }); }
  finally { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); }
});

test('head history pages and repeated checks keep one earliest observed physical success', async () => {
  const f = headGateFixture();
  f.fixture.checkRuns![f.sha] = Array.from({ length: 100 }, (_, n) => n === 0 ? f.check
    : { ...f.check, id: n + 100, conclusion: 'failure' });
  const earlier = { ...f.check, id: 12, completed_at: at(3), details_url: 'https://github.com/o/r/actions/runs/33/job/45' };
  f.fixture.checkRuns![f.sha]!.push(f.check, earlier);
  f.fixture.jobs![45] = [{ ...f.job, id: 45, completed_at: at(3), check_run_url: 'https://api.github.com/repos/o/r/check-runs/12' }];
  const fake = githubFake({ 'o/r': f.fixture }); const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  for (const minute of [10, 11, 12]) await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(minute), 8);
  const saved = store.repos['o/r']!.pulls.PR_1!;
  assert.equal(saved.headGreen!.history.state, 'complete'); assert.equal(saved.headGreen!.history.pagesRead, 2);
  assert.equal(observedCurrentHeadGreen(saved, at(12))!.completedAt, at(3));
  assert.equal(saved.headGreen!.seenCheckIds.length, 101, 'replayed physical check ids are counted once');
  assert.equal(saved.headGreen!.firstEver, 'unavailable-retention-uncertified');
});

test('an unavailable producer read is attempted once per pass and remains pending under the same budget', async () => {
  const f = headGateFixture(); const fake = githubFake({ 'o/r': f.fixture }, (path) => path.includes('/actions/runs/'));
  const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  for (const minute of [10, 11]) {
    const before = fake.calls.length;
    const pass = await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(minute), 8);
    const attempts = fake.calls.slice(before);
    assert.ok(attempts.length <= 8); assert.equal(attempts.filter((path) => path.includes('/actions/runs/')).length, 1);
    assert.equal(pass.state, 'partial'); assert.equal(pass.repos['o/r']!.headGreensPending, 1);
  }
  assert.equal(observedCurrentHeadGreen(store.repos['o/r']!.pulls.PR_1!, at(11)), null);
});

test('bounded head history and damaged cached producer identities stay unavailable rather than fabricated', async () => {
  const f = headGateFixture(); const fake = githubFake({ 'o/r': f.fixture });
  const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
  const pull = store.repos['o/r']!.pulls.PR_1!;
  pull.headGreen!.pending[0]!.runId = NaN;
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(11), 8);
  assert.equal(observedCurrentHeadGreen(pull, at(11)), null);
  const saved = store.repos['o/r']!.pulls.PR_1!; assert.ok(observedCurrentHeadGreen(saved, at(11)));
  saved.state = 'open'; saved.headGreen!.firstObserved = null; saved.headGreen!.state = 'pending';
  saved.headGreen!.pending = []; saved.headGreen!.history.nextPage = 11;
  saved.headGreen!.history.pagesRead = 10; saved.headGreen!.history.state = 'partial';
  saved.headGreen!.history.reason = 'head-check-history-page-bound-or-pending';
  const before = fake.calls.length;
  await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(12), 8);
  const next = store.repos['o/r']!.pulls.PR_1!;
  assert.equal(next.headGreen!.state, 'unavailable');
  assert.equal(next.headGreen!.history.state, 'partial');
  assert.equal(next.headGreen!.history.reason, 'head-check-history-page-bound-or-pending');
  assert.equal(fake.calls.slice(before).filter((path) => path.includes('filter=all')).length, 0);
  assert.equal(observedCurrentHeadGreen(next, 'invalid cutoff'), null);
});

test('a complete first-commit all-attempt response is reused when that commit is the current head', async () => {
  const f = headGateFixture(); f.fixture.prCommits![1] = [{ sha: f.sha }];
  const fake = githubFake({ 'o/r': f.fixture }); const store: FieldTrialsGithubStore = { version: 'field-trials-github-v1', repos: {} };
  const pass = await ingestFieldTrialsGithub(fake.fetch, ['o/r'], store, at(10), 8);
  assert.ok(observedCurrentHeadGreen(store.repos['o/r']!.pulls.PR_1!, at(10)));
  assert.equal(pass.requestsMade, 8);
  assert.equal(fake.calls.filter((path) => path.includes('/check-runs?')).length, 1, 'one actual all-attempt response serves both distinct signals');
  assert.ok(fake.calls.some((path) => path.endsWith('/check-runs?filter=all&per_page=100')));
  assert.equal(fake.calls.some((path) => path.includes('check_name=ci-gate')), false);
});
