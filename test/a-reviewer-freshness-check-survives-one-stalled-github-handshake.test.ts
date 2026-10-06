import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { AsyncGitRunner, GitRunner } from "../src/lib/git-fetch-retry.js";
import * as selfSync from "../src/lib/self-sync.js";
import { checkReviewerCodeFreshnessAsync, checkServiceFreshnessAsync, type ServiceFreshness } from "../src/lib/self-sync.js";
import { gitRepo } from "./helpers/git-repo.js";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const NOW_MS = 1_791_300_000_000;
const MINUTE_MS = 60_000;
const REMOTE_HTTPS = "git remote-https origin https://github.com/craigoley/remudero.git";

/** The 2026-10-06 shape: GitHub's ref advertisement never arrives, so git sits in fetch/remote_refs. */
const STALLED_IN_REMOTE_REFS = [
  { event: "region_enter", category: "fetch", label: "remote_refs" },
  { event: "child_start", sid: "s", child_id: 0, argv: REMOTE_HTTPS.split(" ") },
];
/** A stall whose last region is not remote_refs, but whose GitHub transport child never exited. */
const STALLED_WITH_REMOTE_HTTPS_RUNNING = [
  { event: "region_enter", category: "fetch", label: "fetch_refs" },
  { event: "child_start", sid: "s", child_id: 0, argv: REMOTE_HTTPS.split(" ") },
];
/** A stall elsewhere, with no transport child left running: not the handshake this task names. */
const STALLED_IN_NEGOTIATION = [{ event: "region_enter", category: "fetch", label: "negotiation" }];

/** Each call is one fetch attempt: the listed outcome in order, a trace means "hang until the bound kills it". */
function fetches(outcomes: Array<object[] | Error | "ok">): { gitAsync: AsyncGitRunner; attempts: () => number } {
  let attempts = 0;
  const gitAsync: AsyncGitRunner = (_args, signal, env) => {
    const outcome = outcomes[attempts++] ?? "ok";
    if (outcome === "ok") return Promise.resolve("");
    if (outcome instanceof Error) return Promise.reject(outcome);
    writeFileSync(env!.GIT_TRACE2_EVENT!, outcome.map((event) => JSON.stringify(event)).join("\n"));
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  return { gitAsync, attempts: () => attempts };
}

/** Local reads after the fetch: origin/main's reflog says when it last moved; `main` decides whether HEAD is behind. */
function local(opts: { reflog?: string | Error; main?: string } = {}): { git: GitRunner; reads: string[] } {
  const reads: string[] = [];
  const main = opts.main ?? HEAD;
  const git: GitRunner = (args) => {
    reads.push(args.join(" "));
    if (args[0] === "reflog") {
      if (opts.reflog instanceof Error) throw opts.reflog;
      return opts.reflog ?? "";
    }
    if (args.join(" ") === "rev-parse HEAD") return `${HEAD}\n`;
    if (args.join(" ") === "rev-parse origin/main") return `${main}\n`;
    if (args[0] === "status") return "";
    if (args[0] === "diff") return "docs/a.md\n";
    if (args[0] === "log") return `\x1e${main}\x1fdocs: a\n\ndocs/a.md\n`;
    if (args[0] === "merge-base") return `${HEAD}\n`;
    throw new Error(`unrouted git ${args.join(" ")}`);
  };
  return { git, reads };
}

const reflogAged = (ageMs: number): string => `origin/main@{${Math.floor((NOW_MS - ageMs) / 1000)}}\n`;

async function reviewerCheck(opts: { outcomes: Array<object[] | Error | "ok">; reflog?: string | Error; main?: string; optIn?: boolean }) {
  const fetch = fetches(opts.outcomes);
  const { git, reads } = local(opts);
  const service = await checkServiceFreshnessAsync("/repo", {}, {
    ignoreReentrancyGuard: true,
    git,
    gitAsync: fetch.gitAsync,
    fetchTimeoutMs: 10,
    clock: fixedClock(NOW_MS),
    ...(opts.optIn === false ? {} : { recentFetchFallback: true }),
  });
  const reviewer = await checkReviewerCodeFreshnessAsync("/repo", {}, { checkServiceFreshnessAsync: async () => service, git, resolveHeadSha: () => HEAD });
  return { service, reviewer, attempts: fetch.attempts(), reads };
}

test("test/a-reviewer-freshness-check-survives-one-stalled-github-handshake.test.ts", async (t) => {
  await t.test("a fetch stalled in fetch/remote_refs twice is assessed against a 2-minute-old origin/main, named as such", async () => {
    const { service, reviewer, attempts } = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(2 * MINUTE_MS) });
    assert.equal(attempts, 2, "the stalled handshake is retried exactly once");
    assert.equal(service.status, "assessed");
    assert.deepEqual(reviewer, { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none", source: "recent-fetch", refAgeMs: 2 * MINUTE_MS });
  });

  await t.test("a still-running git-remote-https qualifies too, and main's advance is judged against the recent ref", async () => {
    const { reviewer, attempts } = await reviewerCheck({
      outcomes: [STALLED_WITH_REMOTE_HTTPS_RUNNING, STALLED_WITH_REMOTE_HTTPS_RUNNING],
      reflog: reflogAged(90_000),
      main: MAIN,
    });
    assert.equal(attempts, 2);
    assert.equal(reviewer.status, "fresh", "a docs-only advance is immaterial to a reviewer");
    assert.equal((reviewer as { source?: string }).source, "recent-fetch");
    assert.equal((reviewer as { refAgeMs?: number }).refAgeMs, 90_000);
    assert.equal((reviewer as { originMainSha?: string }).originMainSha, MAIN);
  });

  await t.test("a retry that succeeds is an ordinary fetched assessment with no source mark", async () => {
    const { service, reviewer, attempts, reads } = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, "ok"], reflog: reflogAged(2 * MINUTE_MS) });
    assert.equal(attempts, 2);
    assert.deepEqual(service, { status: "assessed", dirty: false, behind: null });
    assert.deepEqual(reviewer, { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" });
    assert.equal(reads.some((read) => read.startsWith("reflog")), false, "a fetched ref needs no reflog");
  });

  await t.test("an old origin/main ref still reads unreadable, and the reason names its age and the bound", async () => {
    const { service, reviewer, attempts } = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(10 * MINUTE_MS) });
    assert.equal(attempts, 2);
    assert.equal(service.status, "degraded");
    assert.equal(reviewer.status, "unreadable");
    const reason = (reviewer as { reason: string }).reason;
    assert.match(reason, /last trace2 region: fetch\/remote_refs/);
    assert.match(reason, /retried once/);
    assert.match(reason, /origin\/main was last updated 600000 ms ago, outside [0-9]+ ms/);
  });

  await t.test("the recency bound admits its own edge and refuses a ref one second older, or one dated in the future", async () => {
    const bound = selfSync.RECENT_FETCH_MAX_AGE_MS; // a namespace read, so this file still loads where the export is absent
    assert.equal(bound, 240_000, "one daemon poll interval plus three fetch bounds");
    const edge = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(bound) });
    assert.equal(edge.reviewer.status, "fresh");
    const past = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(bound + 1_000) });
    assert.equal(past.reviewer.status, "unreadable");
    const future = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(-5_000) });
    assert.equal(future.reviewer.status, "unreadable");
    assert.match((future.reviewer as { reason: string }).reason, /last updated -5000 ms ago/);
  });

  await t.test("any other fetch failure is not retried and still reads unreadable with today's reason", async () => {
    for (const outcome of [STALLED_IN_NEGOTIATION, new Error("fatal: could not read from remote repository")]) {
      const { service, reviewer, attempts, reads } = await reviewerCheck({ outcomes: [outcome], reflog: reflogAged(MINUTE_MS) });
      assert.equal(attempts, 1, "no retry");
      assert.equal(service.status, "degraded");
      assert.equal(reviewer.status, "unreadable");
      assert.match((reviewer as { reason: string }).reason, /^git fetch origin failed in \/repo: Error: /);
      assert.doesNotMatch((reviewer as { reason: string }).reason, /retried once/);
      assert.equal(reads.length, 0, "no local read stands in for a failure that is not a stalled handshake");
    }
  });

  await t.test("an unreadable or empty reflog still reads unreadable, naming why", async () => {
    const thrown = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: new Error("fatal: bad reflog") });
    assert.equal(thrown.reviewer.status, "unreadable");
    assert.match((thrown.reviewer as { reason: string }).reason, /could not read origin\/main's reflog: Error: fatal: bad reflog/);
    const empty = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: "" });
    assert.equal(empty.reviewer.status, "unreadable");
    assert.match((empty.reviewer as { reason: string }).reason, /origin\/main has no reflog entry/);
  });

  await t.test("the daemon's own freshness read does not opt in, so its tick never waits on a second bound", async () => {
    const { service, attempts } = await reviewerCheck({ outcomes: [STALLED_IN_REMOTE_REFS, STALLED_IN_REMOTE_REFS], reflog: reflogAged(MINUTE_MS), optIn: false });
    assert.equal(attempts, 1);
    assert.equal(service.status, "degraded");
  });

  await t.test("the reviewer's freshness check opts in", async () => {
    let seen: Record<string, unknown> | undefined;
    const checkService = async (_repoDir: string, _env: unknown, deps?: Record<string, unknown>): Promise<ServiceFreshness> => {
      seen = deps;
      return { status: "degraded", reason: "x" };
    };
    await checkReviewerCodeFreshnessAsync("/repo", {}, { checkServiceFreshnessAsync: checkService as typeof checkServiceFreshnessAsync });
    assert.equal(seen?.recentFetchFallback, true);
  });

  await t.test("with the real git and clock, a hung transport falls back to the ref a real fetch just moved", async () => {
    const origin = gitRepo({ bare: true, kind: "stalled-handshake-origin" });
    const work = gitRepo({ kind: "stalled-handshake-work" });
    origin.git("fetch", "--quiet", work.dir, "main:main");
    work.addRemote("origin", origin.dir);
    work.git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
    work.git("remote", "set-url", "origin", "ssh://rmd-fixture.invalid/never.git");
    work.git("config", "ssh.variant", "simple");
    work.git("config", "core.sshCommand", "exec 2>/dev/null; exec sleep 2;:");
    const service = await checkServiceFreshnessAsync(work.dir, {}, {
      ignoreReentrancyGuard: true,
      fetchTimeoutMs: 300,
      recentFetchFallback: true,
    });
    assert.equal(service.status, "assessed", JSON.stringify(service));
    assert.equal((service as { source?: string }).source, "recent-fetch");
    assert.equal(typeof (service as { refAgeMs?: number }).refAgeMs, "number");
  });
});
