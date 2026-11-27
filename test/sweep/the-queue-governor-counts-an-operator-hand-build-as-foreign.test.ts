import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatchedGithub, type PrRef } from "#src/lib/status.js";
import {
  checkQueueGovernor,
  DEFAULT_SWEEP_POLICY,
  isFleetOwnedOpenPr,
  isFleetOwnedRunBranch,
  splitOpenPrOwnership,
} from "#src/lib/sweep.js";

// W1-T15170: an operator building a FILED task names its branch run-<task>-<ms>, exactly like a fleet run, so the
// queue governor's owned count read the head name alone and counted every hand build as the fleet's own WIP. On
// 2026-11-27 its 15:56Z row read owned 17 (3 fleet, 14 operator hand builds), foreign 2, limit 6, tier growing,
// and it held every fleet build for about a day. The author login now rides the same open-board read.

const FLEET = "remudero-fleet[bot]";
const OPERATOR = "an-operator";
const OWNER = "o";
const REPO = "r";

interface OpenRow {
  number: number;
  html_url: string;
  state: "open";
  title: string;
  body: string;
  head: { ref: string; sha: string };
  updated_at: string;
  created_at: string;
  user?: { login?: unknown; type?: string };
}

function openRow(number: number, head: string, user?: OpenRow["user"]): OpenRow {
  return {
    number,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    state: "open",
    title: `pr ${number}`,
    body: "",
    head: { ref: head, sha: String(number).padEnd(40, "0") },
    updated_at: "2026-11-27T15:50:00Z",
    created_at: "2026-11-27T10:00:00Z",
    ...(user === undefined ? {} : { user }),
  };
}

/** The production board gateway over an injected REST transport: the open list answers `rows`, everything else
 *  answers an empty page. Returns the open rows exactly as the governor's observation receives them, and how many
 *  open-list reads that took, so the author is shown to ride the SAME read. */
function openBoard(rows: OpenRow[]): { prs: PrRef[]; openReads: number } {
  let openReads = 0;
  const github = buildBatchedGithub(OWNER, REPO, {
    exec: (args) => {
      const path = args.find((a) => a.startsWith(`repos/${OWNER}/${REPO}/pulls?`)) ?? "";
      if (path.includes("state=open")) {
        openReads += 1;
        return JSON.stringify(path.includes("page=1&") || path.endsWith("page=1") ? rows : []);
      }
      return "[]";
    },
  });
  const prs = github.listOpenHeadBranches?.();
  assert.ok(prs, "the open board read succeeded");
  return { prs, openReads };
}

/** The 2026-11-27 15:56Z board: 3 fleet runs, 14 operator hand builds of filed tasks, 2 operator/human heads. */
function incidentBoard(): OpenRow[] {
  const rows: OpenRow[] = [];
  let n = 21000;
  for (let i = 0; i < 3; i++) rows.push(openRow(n++, `run-W1-T${15000 + i}-1795797802670`, { login: FLEET, type: "Bot" }));
  for (let i = 0; i < 14; i++) rows.push(openRow(n++, `run-W1-T${15100 + i}-1795797802670`, { login: OPERATOR, type: "User" }));
  rows.push(openRow(n++, "run-unfiled-1795797802670", { login: OPERATOR, type: "User" }));
  rows.push(openRow(n++, "dependabot/npm_and_yarn/x-1.2.3", { login: "dependabot[bot]", type: "Bot" }));
  return rows;
}

test("W1-T15170 criterion 1: a run-<task> head an operator authored is foreign, the same head the fleet authored is owned", () => {
  const head = "run-W1-T15170-1795797802670";
  const { prs, openReads } = openBoard([openRow(1, head, { login: OPERATOR, type: "User" }), openRow(2, head, { login: FLEET, type: "Bot" })]);
  assert.equal(openReads, 1, "the author rides the one open-board read; no second GitHub read");
  assert.deepEqual(prs.map((pr) => [pr.number, pr.authorLogin]), [[2, FLEET], [1, OPERATOR]], "the batch carries each author onto PrRef");

  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  assert.equal(isFleetOwnedOpenPr(byNumber.get(1)!), false, "an operator hand build on a filed task's run head is foreign");
  assert.equal(isFleetOwnedOpenPr(byNumber.get(2)!), true, "the fleet's own run on that head is owned");
  // What origin/main did: the head name alone, which cannot tell the two apart.
  assert.equal(isFleetOwnedRunBranch(head), true, "by head name alone both read owned, the defect");
  assert.deepEqual(splitOpenPrOwnership(prs), { owned: 1, foreign: 1, ownedPrNumbers: [2] });
});

test("W1-T15170 criterion 2: 3 fleet and 14 operator run-<task> PRs feed the governor owned 3, which admits under limit 6", () => {
  const policy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 6 };
  const { prs } = openBoard(incidentBoard());
  assert.equal(prs.length, 19);

  const split = splitOpenPrOwnership(prs);
  assert.equal(split.owned, 3, "only the three fleet-authored runs are the fleet's WIP");
  assert.equal(split.foreign, 16);
  const result = checkQueueGovernor(split.owned, policy, { foreignOpenCount: split.foreign });
  assert.equal(result.deferred, false, "the governor admits the next fleet build");
  assert.equal(result.tier, "under_limit");

  // The origin/main reading of the same batch reproduces the 15:56Z row: owned 17, foreign 2, growing, deferred.
  const headOnlyOwned = prs.filter((pr) => isFleetOwnedRunBranch(pr.headRefName)).length;
  assert.equal(headOnlyOwned, 17);
  const before = checkQueueGovernor(headOnlyOwned, policy, { foreignOpenCount: prs.length - headOnlyOwned });
  assert.deepEqual([before.deferred, before.tier, before.observedForeignCount], [true, "growing", 2]);
});

test("W1-T15170 criterion 3: a run-<task> PR whose author the batch did not carry is counted owned", () => {
  const head = "run-W1-T15170-1795797802670";
  // An authorless REST row, a row whose login is not a string, and an empty login: none is evidence of a human.
  const { prs } = openBoard([openRow(1, head), openRow(2, head, { type: "User" }), openRow(3, head, { login: 42 }), openRow(4, head, { login: "" })]);
  assert.equal(prs.length, 4);
  for (const pr of prs) assert.equal(isFleetOwnedOpenPr(pr), true, `#${pr.number} with an unread author fails closed (owned)`);
  // Direct inputs the board never emits but a cached or hand-built row could carry.
  assert.equal(isFleetOwnedOpenPr({ headRefName: head, authorLogin: "   " }), true);
  assert.equal(isFleetOwnedOpenPr({ headRefName: head, authorLogin: null }), true);
  assert.equal(isFleetOwnedOpenPr({ headRefName: undefined }), true, "an unresolvable head with no author still fails closed");
  assert.deepEqual(splitOpenPrOwnership(prs), { owned: 4, foreign: 0, ownedPrNumbers: prs.map((pr) => pr.number) });
});

test("W1-T15170 criterion 4: every fleet-authored PR is classified exactly as the head-only rule did", () => {
  const cases: Array<[string | undefined, boolean]> = [
    ["run-W1-T15170-1795797802670", true],
    ["run-RETRO-1795797802670", true],
    ["run-RETRO-weekly-1795797802670", true],
    ["run-TRIAGE-x-1795797802670", true],
    ["run-PLAN-fb-1795797802670", true],
    ["run-APPROVE-W1-T1-1795797802670", true],
    ["run-unfiled-1795797802670", false],
    ["plan-file-W1-T15170", false],
    ["fix/some-human-branch", false],
    ["dependabot/npm_and_yarn/x-1.2.3", false],
    [undefined, true],
  ];
  // The fleet App's login in each spelling the codebase already accepts (REST, gh, GraphQL).
  for (const login of [FLEET, "app/remudero-fleet", "remudero-fleet"]) {
    for (const [head, expected] of cases) {
      assert.equal(isFleetOwnedRunBranch(head), expected, `head-only rule for ${String(head)}`);
      assert.equal(isFleetOwnedOpenPr({ headRefName: head, authorLogin: login }), expected, `${login} on ${String(head)}`);
    }
  }
  // An operator author never turns a foreign head owned.
  for (const [head, expected] of cases) if (!expected) assert.equal(isFleetOwnedOpenPr({ headRefName: head, authorLogin: OPERATOR }), false);
});
