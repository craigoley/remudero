/**
 * W1-T5806 — A RED MAIN NAMES THE TWO MERGES THAT MET IN IT.
 *
 * 2026-10-05: #9213 (W1-T5649, merged 03:14Z as 22d52cfe) moved src/run-task.ts's retro gateway to
 * the batched fetch; #9219 (W1-T5650, merged 03:41Z as 7f2eff91) also changed src/run-task.ts, and
 * its CI ran on head 978e7f2c, whose merge-base with main predates 22d52cfe. Both were green alone;
 * together main read red, and every escalation was deduped into the older MAIN-HEALTH issue #9149,
 * which named neither PR. These fixtures replay that shape against the real rung.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderIssueBody, type AsyncIssueGateway, type OpenIssue } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  escalationFor,
  MAIN_HEALTH_MET_PR_LIMIT,
  type MainHealthMergeReader,
  type MainHealthRungDeps,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { mainHealthFromRollup } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OWNER = "o";
const REPO = "r";
const RED_MERGE = "7f2eff91".padEnd(40, "0"); // #9219's merge — main's red head
const RED_PARENT = "3c1d0a77".padEnd(40, "0"); // main just before #9219 merged
const PR_HEAD = "978e7f2c".padEnd(40, "0"); // #9219's head, the tree its green CI ran on
const CI_BASE = "b0a5e000".padEnd(40, "0"); // that head's merge-base with main
const RETRO_MERGE = "22d52cfe".padEnd(40, "0"); // #9213's merge, after CI_BASE
const FILES: Record<number, string[]> = {
  9219: ["src/run-task.ts", "test/no-daemon-loop-path-builds-the-unbatched-gateway.test.ts"],
  9213: ["src/run-task.ts", "src/lib/github-batched.ts"],
  9215: ["docs/operator-console.md"],
};

/** The open issue #9149 — opened earlier for another red, in the exact body today's rung renders. */
function olderMainHealthIssue(): OpenIssue {
  const older = mainHealthFromRollup("e1d3a000".padEnd(40, "0"), [{ name: "ci", conclusion: "FAILURE" }], ["ci"]);
  const e = escalationFor(older, "main");
  return {
    number: 9149,
    url: `https://github.com/${OWNER}/${REPO}/issues/9149`,
    title: `[${e.class}] ${e.taskId}: ${e.summary}`,
    body: renderIssueBody(e),
  };
}

function fakeGit(overrides: Partial<MainHealthMergeReader> = {}): MainHealthMergeReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prMerge: (sha) => {
      calls.push(`prMerge ${sha}`);
      return sha === RED_MERGE ? { number: 9219, headSha: PR_HEAD, parentSha: RED_PARENT } : undefined;
    },
    mergeBase: (a, b) => {
      calls.push(`mergeBase ${a} ${b}`);
      return CI_BASE;
    },
    prsMergedBetween: (base, tip) => {
      calls.push(`between ${base} ${tip}`);
      return [9215, 9213];
    },
    ...overrides,
  };
}

/** Main's head reads red on the per-commit tripwire, as #9219's merge did at 03:45Z. */
function observe(overrides: Partial<MainHealthRungDeps> = {}, routes: (path: string) => unknown = () => undefined) {
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: RED_MERGE };
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_MERGE}/check-runs?per_page=100`) {
      return {
        check_runs: [
          { name: "ci", status: "completed", conclusion: "success" },
          { name: "main-tripwire", status: "completed", conclusion: "failure" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_MERGE}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) return { workflow_runs: [] };
    const routed = routes(path);
    if (routed !== undefined) return routed;
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${9300 + created.length}`;
    },
    listOpen: async () => [olderMainHealthIssue()],
    comment: async (url, body) => {
      comments.push({ url, body });
    },
    closeWithComment: async () => {},
  };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5806-`));
  const ledgerPath = join(root, "ledger.ndjson");
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-T5806",
    log: (step, extra = {}) => logs.push({ step, extra }),
    readRequiredChecks: () => ["ci"],
    mergeReader: fakeGit(),
    readPrFiles: (n) => FILES[n],
    ...overrides,
  });
  const ledgerSteps = (): string[] => {
    try {
      return readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    } catch {
      return [];
    }
  };
  return {
    rung,
    created,
    comments,
    logs,
    ledgerSteps,
    observed: () => logs.filter((l) => l.step === "main.health.observed").map((l) => l.extra),
    escalated: () => logs.filter((l) => l.step === "main.health.escalated").map((l) => l.extra),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Today's escalation: no new issue, a dedup comment on #9149, no merge fields on either row. */
function assertEscalatesAsToday(h: ReturnType<typeof observe>, label: string): void {
  assert.equal(h.created.length, 0, `${label}: no issue is opened beside #9149`);
  assert.equal(h.comments.length, 1, `${label}: the red is folded into #9149, exactly as today`);
  assert.match(h.comments[0]!.url, /\/issues\/9149$/);
  assert.ok(h.ledgerSteps().includes("escalation.deduped"), label);
  for (const row of [...h.observed(), ...h.escalated()]) {
    for (const field of ["red_pr", "met_prs", "shared_paths"]) {
      assert.equal(field in row, false, `${label}: ${field} must be absent when no merge met: ${JSON.stringify(row)}`);
    }
  }
}

test("a red on the merge of a PR whose CI base predates another merged PR touching a shared path opens one escalation naming both PRs and the path", async () => {
  const h = observe();
  try {
    await h.rung();
    assert.equal(h.created.length, 1, "one escalation of its own, never deduped into the older #9149");
    assert.equal(h.comments.length, 0, "#9149 is not commented on");
    const { title, body } = h.created[0]!;
    assert.match(title, /PR #9219/);
    assert.match(title, /PR #9213/);
    assert.doesNotMatch(`${title}\n${body}`, /#9215/, "a merge that shares no path with #9219 is not named");
    assert.match(body, /`src\/run-task\.ts`/);
    assert.match(body, new RegExp(`\\*\\*Head:\\*\\* ${RED_MERGE}`), "keyed to #9219's merge");
    assert.match(body, new RegExp(CI_BASE), "names the base #9219's CI ran on");
    assert.doesNotMatch(body, /\/pull\/\d+/, "no PR URL: the reconciler would retire the issue as soon as it read a merged PR");
    const merged = { red_pr: 9219, met_prs: [9213], shared_paths: ["src/run-task.ts"] };
    const [observed] = h.observed();
    const [escalated] = h.escalated();
    for (const [field, value] of Object.entries(merged)) {
      assert.deepEqual(observed?.[field], value, `observed.${field}`);
      assert.deepEqual(escalated?.[field], value, `escalated.${field}`);
    }
  } finally {
    h.cleanup();
  }
});

test("the same red head re-observed reads git and the PR file lists once", async () => {
  let fileReads = 0;
  const git = fakeGit();
  const h = observe({
    mergeReader: git,
    readPrFiles: (n) => {
      fileReads++;
      return FILES[n];
    },
  });
  try {
    await h.rung();
    await h.rung();
    assert.equal(h.observed().length, 2);
    assert.deepEqual(h.observed()[1]?.met_prs, [9213], "the cached answer still rides the second observed row");
    assert.equal(git.calls.length, 3, git.calls.join("; "));
    assert.equal(fileReads, 3, "#9219, #9215 and #9213, once each");
  } finally {
    h.cleanup();
  }
});

test("a red with no such PR escalates as today", async () => {
  const disjoint = observe({ readPrFiles: (n) => (n === 9219 ? ["src/lib/escalate.ts"] : FILES[n]) });
  const unmet = observe({ mergeReader: fakeGit({ prsMergedBetween: () => [] }) });
  const notAMerge = observe({ mergeReader: fakeGit({ prMerge: () => undefined }) });
  const onlyItself = observe({ mergeReader: fakeGit({ prsMergedBetween: () => [9219] }) });
  try {
    for (const [label, h] of [
      ["no shared path", disjoint],
      ["nothing merged since the CI base", unmet],
      ["the head is not a PR merge", notAMerge],
      ["only the red PR itself", onlyItself],
    ] as const) {
      await h.rung();
      assertEscalatesAsToday(h, label);
      assert.equal("met_prs_unreadable" in h.observed()[0]!, false, label);
    }
  } finally {
    for (const h of [disjoint, unmet, notAMerge, onlyItself]) h.cleanup();
  }
});

test("a failed read leaves the escalation unchanged", async () => {
  const boom = () => {
    throw new Error("git: bad object 978e7f2c");
  };
  const cases = [
    ["merge-base throws", observe({ mergeReader: fakeGit({ mergeBase: boom }) }), /bad object/],
    ["PR merge lookup rejects", observe({ mergeReader: fakeGit({ prMerge: async () => Promise.reject(new Error("HTTP 502")) }) }), /HTTP 502/],
    ["merges-between throws", observe({ mergeReader: fakeGit({ prsMergedBetween: boom }) }), /bad object/],
    ["the red PR's files are unreadable", observe({ readPrFiles: (n) => (n === 9219 ? undefined : FILES[n]) }), /#9219/],
    ["a met PR's file read throws", observe({ readPrFiles: (n) => (n === 9213 ? boom() : FILES[n]) }), /bad object/],
    [
      "more merges than the bound",
      observe({
        mergeReader: fakeGit({ prsMergedBetween: () => Array.from({ length: MAIN_HEALTH_MET_PR_LIMIT + 1 }, (_, i) => 9000 + i) }),
      }),
      new RegExp(`more than ${MAIN_HEALTH_MET_PR_LIMIT}`),
    ],
  ] as const;
  try {
    for (const [label, h, reason] of cases) {
      await h.rung();
      assertEscalatesAsToday(h, label);
      assert.match(String(h.observed()[0]?.met_prs_unreadable), reason, `${label}: the unread half is named on the observed row`);
    }
  } finally {
    for (const [, h] of cases) h.cleanup();
  }
});

/** GitHub's own answers for the #9213/#9219 shape, as the production reader asks for them. */
function restRoutes(overrides: Record<string, unknown> = {}): (path: string) => unknown {
  const base = `repos/${OWNER}/${REPO}`;
  const routes: Record<string, unknown> = {
    [`${base}/commits/${RED_MERGE}`]: {
      sha: RED_MERGE,
      commit: { message: "feat(daemon): no daemon loop path builds the unbatched gateway (#9219)\n\nRemudero-Task: W1-T5650" },
      parents: [{ sha: RED_PARENT }],
    },
    [`${base}/pulls/9219`]: { number: 9219, head: { sha: PR_HEAD } },
    [`${base}/compare/${RED_PARENT}...${PR_HEAD}?per_page=1`]: { merge_base_commit: { sha: CI_BASE } },
    [`${base}/compare/${CI_BASE}...${RED_PARENT}?per_page=100`]: {
      total_commits: 3,
      commits: [
        { commit: { message: "fix(retro): move the retro gateway to the batched fetch (#9213)" } },
        { commit: { message: "chore: a direct push with no PR number" } },
        { commit: { message: "docs(console): operator console notes (#9215)" } },
      ],
    },
    ...Object.fromEntries(
      Object.entries(FILES).map(([n, files]) => [`${base}/pulls/${n}/files?per_page=100`, files.map((filename) => ({ filename }))]),
    ),
    ...overrides,
  };
  return (path) => routes[path];
}

test("the production reader answers the same question from GitHub's commits, compare and PR file lists", async () => {
  const h = observe({ mergeReader: undefined, readPrFiles: undefined }, restRoutes());
  const squashless = observe(
    { mergeReader: undefined, readPrFiles: undefined },
    restRoutes({ [`repos/${OWNER}/${REPO}/commits/${RED_MERGE}`]: { commit: { message: "Merge branch 'hotfix'" }, parents: [{ sha: RED_PARENT }] } }),
  );
  const truncated = observe(
    { mergeReader: undefined, readPrFiles: undefined },
    restRoutes({ [`repos/${OWNER}/${REPO}/compare/${CI_BASE}...${RED_PARENT}?per_page=100`]: { total_commits: 101, commits: [] } }),
  );
  const headless = observe({ mergeReader: undefined, readPrFiles: undefined }, restRoutes({ [`repos/${OWNER}/${REPO}/pulls/9219`]: {} }));
  const noFiles = observe(
    { mergeReader: undefined, readPrFiles: undefined },
    restRoutes({ [`repos/${OWNER}/${REPO}/pulls/9219/files?per_page=100`]: [] }),
  );
  try {
    await h.rung();
    assert.equal(h.created.length, 1);
    assert.match(h.created[0]!.title, /PR #9219.*PR #9213/);
    assert.deepEqual(h.observed()[0]?.met_prs, [9213]);
    assert.deepEqual(h.observed()[0]?.shared_paths, ["src/run-task.ts"]);

    await squashless.rung();
    assertEscalatesAsToday(squashless, "a merge subject with no (#N)");

    for (const [label, unread, reason] of [
      ["a truncated compare", truncated, /101 commits/],
      ["a PR with no head sha", headless, /PR #9219 head sha/],
      ["an empty file list", noFiles, /#9219/],
    ] as const) {
      await unread.rung();
      assertEscalatesAsToday(unread, label);
      assert.match(String(unread.observed()[0]?.met_prs_unreadable), reason, label);
    }
  } finally {
    for (const x of [h, squashless, truncated, headless, noFiles]) x.cleanup();
  }
});
