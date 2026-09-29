import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { withTempDir } from "../src/lib/tmp.js";
// @ts-expect-error — plain .mjs script with no type declarations
import { attest, groupPullNumbers, main, prFromQueueRef, prFromSquashSubject } from "../scripts/merge-queue-review-attest.mjs";

// The merge queue evaluates branch protection's required `remudero-review` context on its own group
// commit, which the orchestrator never reviews. merge-queue-review-attest.yml reports it there, and
// passes only when every PR in the group carries a successful remudero-review status on its head.
// The workflow is a REVIEW BYPASS if it ever runs (or is skipped) on a PR head, so its triggers are
// pinned here against the real file on disk.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");
const ATTEST_FILE = "merge-queue-review-attest.yml";

type Job = { name?: string; if?: unknown };
type Workflow = { on?: unknown; true?: unknown; jobs?: Record<string, Job> };

function load(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
}

/** The trigger names a workflow declares: `on:` can be a string, a list or a map. */
function triggers(doc: Workflow): string[] {
  const on = doc.on ?? doc.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys((on ?? {}) as Record<string, unknown>);
}

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const GROUP = {
  merge_group: {
    head_sha: HEAD,
    base_sha: BASE,
    head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${"d".repeat(40)}`,
  },
};

/** A fake GitHub REST API: compare returns `subjects` as group commits, each PR's head is `h<N>`,
 *  and `h<N>`'s combined status carries `reviews[N]` (omitted = no status at all). */
function fakeApi(subjects: string[], reviews: Record<number, string>, failPath?: string) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (failPath && path.startsWith(failPath)) return reply({}, 502);
    if (path.startsWith("/repos/o/r/compare/")) {
      return reply({ commits: subjects.map((message, i) => ({ sha: `s${i}`, commit: { message } })) });
    }
    const pull = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (pull) return reply({ head: { sha: `h${pull[1]}` } });
    const status = /^\/repos\/o\/r\/commits\/h(\d+)\/status/.exec(path);
    if (status) {
      const state = reviews[Number(status[1])];
      return reply({ statuses: state ? [{ context: "remudero-review", state }] : [{ context: "ci-gate", state: "success" }] });
    }
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

test("the review attestation workflow triggers on merge_group only", () => {
  assert.deepEqual(triggers(load(ATTEST_FILE)), ["merge_group"]);
});

test("the review attestation job carries no if guard that could skip it", () => {
  const jobs = load(ATTEST_FILE).jobs ?? {};
  assert.deepEqual(Object.keys(jobs), ["remudero-review"]);
  assert.equal(jobs["remudero-review"].name, "remudero-review");
  assert.equal(jobs["remudero-review"].if, undefined);
});

test("no other workflow defines a job named remudero-review", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 10, `expected the real workflow directory, read ${files.length} files`);
  const owners = files.filter((f) =>
    Object.entries(load(f).jobs ?? {}).some(([id, job]) => id === "remudero-review" || job?.name === "remudero-review"),
  );
  assert.deepEqual(owners, [ATTEST_FILE]);
});

test("the queue ref and squash subjects name the group pull requests", () => {
  assert.equal(prFromQueueRef(GROUP.merge_group.head_ref), 12);
  assert.equal(prFromQueueRef("refs/heads/main"), null);
  assert.equal(prFromSquashSubject("fix(x): a title (#7) (#11)\n\nbody"), 11);
  assert.equal(prFromSquashSubject("a title with no number"), null);
  const r = groupPullNumbers(GROUP.merge_group, [
    { sha: "a", commit: { message: "one (#11)" } },
    { sha: "z", commit: { message: "unattributed" } },
  ]);
  assert.deepEqual(r, { numbers: [11, 12], unattributed: ["z"], own: 12 });
});

test("attests a group whose every pull request has a successful review", async () => {
  const api = fakeApi(["first (#11)", "second (#12)"], { 11: "success", 12: "success" });
  const r = await attest({ event: GROUP, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(api.calls.includes("/repos/o/r/commits/h11/status?per_page=100"));
  assert.ok(api.calls.includes("/repos/o/r/commits/h12/status?per_page=100"));
});

test("refuses a group where one pull request has no review status", async () => {
  const api = fakeApi(["first (#11)", "second (#12)"], { 12: "success" });
  const r = await attest({ event: GROUP, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l: string) => l.includes("#11") && l.includes("absent")), r.lines.join("\n"));
});

test("refuses a group whose review status is a failure", async () => {
  const api = fakeApi(["second (#12)"], { 12: "failure" });
  const r = await attest({ event: GROUP, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
});

test("refuses a group commit it cannot attribute to a pull request", async () => {
  const api = fakeApi(["second (#12)", "a direct push"], { 12: "success" });
  const r = await attest({ event: GROUP, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l: string) => l.includes("no (#N)")), r.lines.join("\n"));
});

test("refuses a queue ref that names no pull request", async () => {
  const api = fakeApi(["second (#12)"], { 12: "success" });
  const event = { merge_group: { ...GROUP.merge_group, head_ref: "refs/heads/main" } };
  const r = await attest({ event, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
});

test("refuses an event that is not a merge group", async () => {
  const api = fakeApi([], {});
  const r = await attest({ event: { pull_request: { number: 1 } }, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(api.calls.length, 0);
});

test("refuses when the GitHub API is unreadable", async () => {
  const api = fakeApi(["second (#12)"], { 12: "success" }, "/repos/o/r/pulls/");
  const r = await attest({ event: GROUP, repo: "o/r", token: "t", fetchImpl: api.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l: string) => l.includes("HTTP 502")), r.lines.join("\n"));
});

test("main reads the event file and exits by the verdict", async () => {
  await withTempDir("mq-attest", async (dir: string) => {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(GROUP));
    const logged: string[] = [];
    const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "o/r", GH_TOKEN: "t" };
    const pass = fakeApi(["second (#12)"], { 12: "success" });
    assert.equal(await main({ env, fetchImpl: pass.fetchImpl, log: (l: string) => logged.push(l) }), 0);
    const fail = fakeApi(["second (#12)"], {});
    assert.equal(await main({ env, fetchImpl: fail.fetchImpl, log: (l: string) => logged.push(l) }), 1);
    assert.ok(logged.includes("remudero-review NOT attested"));
  });
});
