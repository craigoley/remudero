// test/the-board-verb-distinguishes-empty-from-unreadable.test.ts — W1-T3685.
//
// No verb answered "what is open, and what is red" across the fleet's three repositories — the
// operator's substitute was a 20-line script rewritten from a container scratch directory three
// times in one day. `rmd board` (src/run-task.ts) and `surveyPullRequestBoard` (src/lib/pr-board.ts)
// are the fix. This suite pins the five falsifiers the task record names: a hardcoded repository
// list, a zero-open render for an unreachable queue, a per-PR follow-up call, a non-zero exit on a
// red board, and a module the CLI never actually dispatches.

import assert from "node:assert/strict";
import { test } from "node:test";

import { surveyPullRequestBoard, type PullRequestBoard } from "../src/lib/pr-board.js";
import { boardCommand, type BoardCommandDeps } from "../src/run-task.js";

/** A raw `gh pr list --json ...` row, minimal — only the fields the module reads. */
function row(
  number: number,
  opts: { title?: string; isDraft?: boolean; headRefName?: string; statusCheckRollup?: unknown[] } = {},
): unknown {
  return {
    number,
    title: opts.title ?? `pr ${number}`,
    isDraft: opts.isDraft ?? false,
    headRefName: opts.headRefName ?? `branch-${number}`,
    statusCheckRollup: opts.statusCheckRollup ?? [],
  };
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

// ── acceptance 1: the survey covers every configured repository, never a list written into the
//    code. Hardcoding the repo list inside surveyPullRequestBoard would make this fail — the
//    repos surveyed would not match the (arbitrary, non-default) list this test passes in.

test("the survey covers exactly the repositories it is given, never a list baked into the module", () => {
  const repos = ["acme/widgets", "acme/gadgets", "acme/gizmos"];
  const calledWith: string[][] = [];
  const board = surveyPullRequestBoard(repos, (args) => {
    calledWith.push(args);
    return [];
  });
  assert.deepEqual(
    board.repos.map((r) => r.repo),
    repos,
    "the survey must cover exactly the repos it was asked for, in order",
  );
  for (const args of calledWith) {
    assert.ok(
      repos.some((r) => args.includes(r)),
      `each gh call must name one of the requested repos, got ${JSON.stringify(args)}`,
    );
  }
});

// ── acceptance 2: a repository that cannot be read is reported unavailable, never rendered as an
//    empty queue — an empty board and an unreachable one are opposite facts.

test("an unreadable repository reads unavailable, never rendered as an empty queue", () => {
  const board = surveyPullRequestBoard(["acme/unreadable", "acme/empty"], (args) => {
    if (args.includes("acme/unreadable")) throw new Error("gh: could not resolve to a Repository");
    return [];
  });
  const unreadable = board.repos.find((r) => r.repo === "acme/unreadable");
  const empty = board.repos.find((r) => r.repo === "acme/empty");
  assert.ok(unreadable);
  assert.equal(unreadable!.available, false);
  if (!unreadable!.available) assert.match(unreadable!.error, /could not resolve/);

  assert.ok(empty);
  assert.equal(empty!.available, true);
  if (empty!.available) assert.deepEqual(empty!.pullRequests, [], "a genuinely empty queue stays []");
});

// ── acceptance 3: one gh call per repository — a wide board cannot trip the secondary rate limit.

test("a three-repository board makes exactly three gh calls, never a per-PR follow-up", () => {
  let calls = 0;
  surveyPullRequestBoard(["a/one", "a/two", "a/three"], () => {
    calls++;
    return [row(1), row(2), row(3)];
  });
  assert.equal(calls, 3, "one call per repository regardless of how many pull requests it holds");
});

// ── acceptance 4: a board containing failing pull requests still exits zero — report, never gate.

test("a board with failing checks still exits zero from boardCommand", () => {
  const failingBoard: PullRequestBoard = {
    repos: [
      {
        repo: "acme/widgets",
        available: true,
        pullRequests: [
          { number: 1, title: "red pr", isDraft: false, headRefName: "fix", failingChecks: ["ci"], pendingChecks: [] },
        ],
      },
    ],
  };
  const cap = capture();
  try {
    const code = boardCommand([], { survey: () => failingBoard, loadConfig: () => ({ fleetRepos: ["acme/widgets"] }) });
    assert.equal(code, 0, "a red board is still a REPORT — exit code never gates on content");
  } finally {
    cap.restore();
  }
});

test("an unavailable repository in the board still exits zero from boardCommand", () => {
  const board: PullRequestBoard = { repos: [{ repo: "acme/gone", available: false, error: "403" }] };
  const cap = capture();
  try {
    const code = boardCommand(["--repo", "acme/gone"], { survey: () => board });
    assert.equal(code, 0);
    assert.ok(cap.lines.some((l) => l.includes("UNAVAILABLE")));
  } finally {
    cap.restore();
  }
});

// ── CLI wiring: --repo narrows the survey; repeated --repo collects every value.

test("boardCommand surveys exactly the repos named by repeated --repo flags", () => {
  let surveyed: readonly string[] = [];
  const cap = capture();
  let code: number;
  try {
    code = boardCommand(["--repo", "x/one", "--repo", "x/two"], {
      survey: (repos) => {
        surveyed = repos;
        return { repos: repos.map((repo) => ({ repo, available: true as const, pullRequests: [] })) };
      },
    });
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.deepEqual(surveyed, ["x/one", "x/two"]);
});

// ── CLI wiring: default repository set comes from configuration, not a hardcoded literal in
//    run-task.ts — a differently-configured fleet is surveyed differently with no --repo given.

test("boardCommand's default repos, with no --repo given, come from config.fleetRepos", () => {
  let surveyed: readonly string[] = [];
  const configured = ["own/one", "own/two"];
  const cap = capture();
  let code: number;
  try {
    code = boardCommand([], {
      survey: (repos) => {
        surveyed = repos;
        return { repos: [] };
      },
      loadConfig: () => ({ fleetRepos: configured }),
    });
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.deepEqual(surveyed, configured);
});

test("boardCommand falls back to its default fleet, never crashing, when config is unreadable", () => {
  let surveyed: readonly string[] = [];
  const deps: BoardCommandDeps = {
    survey: (repos) => {
      surveyed = repos;
      return { repos: [] };
    },
    loadConfig: () => {
      throw new Error("unreadable config.json");
    },
  };
  const cap = capture();
  let code: number;
  try {
    code = boardCommand([], deps);
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.ok(surveyed.length > 0, "an unreadable config must not leave the board empty by construction");
});

test("boardCommand refuses an unrecognized argument rather than draining", () => {
  const cap = capture();
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const code = boardCommand(["--bogus"], { survey: () => ({ repos: [] }) });
    assert.equal(code, 2);
    assert.ok(errors.some((l) => l.includes("--bogus")));
  } finally {
    console.error = realError;
    cap.restore();
  }
});

// ── the check-name extraction real callers rely on: failing and pending are NAMED, not merely
//    counted, and a superseded attempt never outvotes its own later verdict.

test("failing and pending checks are named from the rollup, deduped to the latest attempt", () => {
  const board = surveyPullRequestBoard(["a/one"], () => [
    row(1, {
      statusCheckRollup: [
        { name: "ci", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-16T00:00:00Z" },
        { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-16T00:05:00Z" },
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-16T00:00:00Z" },
        { context: "remudero-review", state: "PENDING", startedAt: "2026-09-16T00:00:00Z" },
      ],
    }),
  ]);
  const [entry] = board.repos[0]!.available ? board.repos[0]!.pullRequests : [];
  assert.ok(entry);
  assert.deepEqual(entry!.failingChecks, ["lint"], "ci's SUCCESS attempt supersedes its own earlier CANCELLED");
  assert.deepEqual(entry!.pendingChecks, ["remudero-review"]);
});
