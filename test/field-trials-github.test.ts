/**
 * W1-T4574 — the GitHub half of the field-trials aggregate: paged, resumable, watermarked reads
 * behind one injectable page seam. Every test answers from a fixture; the one default-seam test
 * answers from the shared `gh` PATH shim, never the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorClassOf, emptyRepoStore, ghApiFetch, GITHUB_PAGE_SIZE, ingestFieldTrialsGithub, pageOf, parseGithubStore, pullOf,
  REVERTS_LINE_RE, revertedPrNumber, RUN_BRANCH_RE, summarizeChecks, TRAILER_LINE_RE, trailerTaskIds,
  type FieldTrialsGithubStore, type GithubPage,
} from "../src/lib/field-trials-github.js";
import { ghShim } from "./helpers/gh-shim.js";

type Fixture = {
  pulls?: unknown[]; commits?: unknown[]; deployments?: unknown[];
  reviews?: Record<number, unknown[]>; prCommits?: Record<number, unknown[]>;
  checkRuns?: Record<string, unknown[]>; statuses?: Record<number, unknown[]>;
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
  assert.equal(fake.calls[0], "repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2", "resumes at the stored page");
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
  const fetch = ghApiFetch({ ...process.env, PATH: `${shim.dir}:${process.env.PATH}` });
  const ok = await fetch("repos/o/r/pulls?page=1");
  assert.equal(ok.ok && (ok.items[0] as { number: number }).number, 1);
  assert.deepEqual(await fetch("repos/o/r/commits?page=1"), { ok: false, reason: "github-read-failed" });
  assert.deepEqual(shim.calls(), ["api repos/o/r/pulls?page=1", "api repos/o/r/commits?page=1"]);
});
