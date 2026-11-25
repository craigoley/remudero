/**
 * W1-T14778: the refresh stopped every GitHub pass at a 24-page budget, so core's PR list never
 * completed and every snapshot read observed-partial. A pass now reads until its work is done,
 * and waits out the installation's rate limit instead of failing or draining it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  emptyRepoStore, ghApiFetch, GITHUB_PAGE_SIZE, ingestFieldTrialsGithub, pacedGhApiFetch, pullOf, rateLimitPacer,
  type FieldTrialsGithubStore, type GithubPage,
} from "#src/lib/field-trials-github.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1) + minute * 60_000).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, "a");

function pull(number: number, extra: Record<string, unknown> = {}) {
  return { node_id: `PR_${number}`, number, state: "closed", created_at: at(0), updated_at: at(number), merged_at: at(number),
    closed_at: at(number), merge_commit_sha: `m${number}`, head: { ref: `run-T${number}-1`, sha: `h${number}` },
    body: `Remudero-Task: T${number}`, user: { login: "remudero-fleet[bot]", type: "Bot" }, ...extra };
}

/** A page seam over one repository, paged like REST; every other repo and path answers an empty list. */
function fake(items: { pulls: unknown[]; checkRuns?: Record<string, unknown[]> }) {
  const calls: string[] = [];
  const fetch = async (path: string): Promise<GithubPage> => {
    calls.push(path);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    const slice = (list: unknown[] = []) => ({ ok: true as const, items: list.slice((page - 1) * GITHUB_PAGE_SIZE, page * GITHUB_PAGE_SIZE) });
    const rest = path.split("?")[0]!.split("/").slice(3);
    if (rest[0] === "pulls" && rest.length === 1) return slice(items.pulls);
    if (rest[0] === "commits" && rest[2] === "check-runs") return slice(items.checkRuns?.[rest[1]!]);
    return slice([]);
  };
  return { fetch, calls };
}

test("W1-T14778: a field trials github pass reads until its work is done", async () => {
  // 40 pages of pulls; 30 of them changed and need a detail read, 12 carry a real head to read.
  const count = 40 * GITHUB_PAGE_SIZE - 10;
  const pulls = Array.from({ length: count }, (_, i) => pull(count - i, i < 12 ? { head: { ref: `run-T${count - i}-1`, sha: sha(i + 1) } } : {}));
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: { "o/r": emptyRepoStore() } };
  const seeded = store.repos["o/r"]!;
  const observed = { state: "observed", reviews: { total: 0, human: 0, bot: 0 }, commits: { firstCommittedAt: null, lastCommittedAt: null },
    readWhileOpen: false } as unknown as NonNullable<ReturnType<typeof pullOf>>["detail"];
  for (const item of pulls.slice(30)) seeded.pulls[item.node_id] = { ...pullOf(item)!, detail: observed };
  const github = fake({ pulls });
  let checkpoints = 0;
  const pass = await ingestFieldTrialsGithub(github.fetch, ["o/r"], store, at(5000), undefined, () => { checkpoints += 1; });
  const repo = pass.repos["o/r"]!;
  assert.equal(repo.pulls.state, "complete", JSON.stringify(repo.pulls));
  assert.equal(repo.pulls.reason, null);
  assert.equal(repo.pulls.pagesRead, 40);
  assert.equal(repo.commits.state, "complete");
  assert.equal(repo.deployments.state, "complete");
  assert.equal(repo.detailsPending, 0);
  assert.equal(repo.workAllocation.requests.details, 30 * 3, "exactly the 30 changed pulls were read in detail");
  assert.equal(repo.headGreensPending, 0);
  assert.equal(github.calls.filter((path) => path.includes("/check-runs?")).length, 12, "every head was read in this pass");
  assert.equal(pass.state, "complete");
  assert.ok(checkpoints > 0, "a long pass checkpoints as it goes");
});

test("W1-T14778: a rate limited field trials read waits and retries the same page", async () => {
  const pulls = [pull(2), pull(1)];
  const github = fake({ pulls });
  const reads: string[][] = [];
  const sleeps: number[] = [];
  let limited = 2;
  const read = async (args: string[]) => {
    reads.push(args);
    if (args[1]!.includes("/pulls?") && limited-- > 0) {
      throw Object.assign(new Error("gh: API rate limit exceeded"), { stderr: limited === 1 ? "HTTP 403: API rate limit exceeded\nRetry-After: 7" : "secondary rate limit" });
    }
    const page = await github.fetch(args[1]!);
    return JSON.stringify(page.ok ? page.items : { message: "unrouted" });
  };
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  const pass = await ingestFieldTrialsGithub(ghApiFetch(read, { sleep: async (ms) => { sleeps.push(ms); } }), ["o/r"], store, at(10));
  assert.deepEqual(sleeps, [7_000, 60_000], "Retry-After first, then the one-minute secondary-limit wait");
  const pullReads = reads.filter((args) => args[1]!.includes("/pulls?"));
  assert.equal(new Set(pullReads.map((args) => args.join(" "))).size, 1, "the same page is retried");
  assert.equal(pass.repos["o/r"]!.pulls.state, "complete");
  assert.ok(!JSON.stringify(pass).includes("github-read-failed"));
  const other = await ghApiFetch(async () => { throw new Error("HTTP 404: Not Found"); })("repos/o/r/pulls");
  assert.deepEqual(other, { ok: false, reason: "github-read-failed" }, "a non-rate-limit failure keeps today's reason");
});

test("W1-T14778: a pending head is read once per field trials pass", async () => {
  const head = sha(99);
  const open = pull(5, { state: "open", merged_at: null, closed_at: null, head: { ref: "run-T5-1", sha: head } });
  const github = fake({ pulls: [open], checkRuns: { [head]: [{ id: 1, name: "ci-gate", status: "in_progress", conclusion: null,
    head_sha: head, app: { slug: "github-actions" }, check_suite: { id: 2 } }] } });
  const store: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {} };
  await ingestFieldTrialsGithub(github.fetch, ["o/r"], store, at(10));
  assert.equal(github.calls.filter((path) => path.includes(`/commits/${head}/check-runs`)).length, 1);
  await ingestFieldTrialsGithub(github.fetch, ["o/r"], store, at(11));
  assert.equal(github.calls.filter((path) => path.includes(`/commits/${head}/check-runs`)).length, 2, "once more on the next pass, never a loop");
});

test("W1-T14778: the field trials refresh script passes no page bound", () => {
  const script = readFileSync(join(REPO_ROOT, "deploy", "field-trials-refresh.sh"), "utf8");
  assert.doesNotMatch(script, /--max-pages/);
  assert.doesNotMatch(script, /RMD_FIELD_TRIALS_MAX_PAGES/);
});

test("W1-T14778: the rate limit pacer waits out the reserve and resumes", async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const answers = [{ limit: 5000, remaining: 400, reset: (clock + 120_000) / 1000 }, { limit: 5000, remaining: 5000, reset: 0 }];
  const probes: string[][] = [];
  const read = async (args: string[]) => {
    probes.push(args);
    if (args[1] === "rate_limit") return JSON.stringify({ resources: { core: answers.shift() } });
    return "[]";
  };
  const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
  const fetch = pacedGhApiFetch(read, { now: () => clock, sleep });
  assert.deepEqual(await fetch("repos/o/r/pulls"), { ok: true, items: [] });
  assert.deepEqual(sleeps, [121_000], "under the 10% reserve, wait for the reset plus a second");
  assert.deepEqual(probes.map((args) => args[1]), ["rate_limit", "rate_limit", "repos/o/r/pulls"]);
  await fetch("repos/o/r/commits");
  assert.equal(probes.filter((args) => args[1] === "rate_limit").length, 2, "no second probe inside the same minute");
  const unreadable = rateLimitPacer(async () => { throw new Error("offline"); }, { now: () => clock, sleep });
  await unreadable();
  const unparsed = rateLimitPacer(async () => "{}", { now: () => clock, sleep });
  await unparsed();
  assert.deepEqual(sleeps, [121_000], "an unreadable or unparsed probe never waits");
});
