import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  commitsNamingIssue, isAbsenceOnlyCitation, parseMainCommitLog, productionIssueRevalidationPorts,
  type ProductionIssueRevalidationOpts, type RevalidationIssue,
} from "#src/lib/issue-revalidation-garden.js";

const NOW = Date.UTC(2026, 9, 13, 21);
const clock = fixedClock(NOW);

/** #8429's shape: a hand-filed issue whose fix names it in its squash subject. */
const issue = (number: number, createdAt: string): RevalidationIssue => ({
  number, url: `https://github.com/acme/remudero/issues/${number}`, title: "Serve supervisor cold start stalls",
  body: "board_computed stayed false.", labels: [], createdAt, updatedAt: createdAt,
});

const LOG = [
  "a1b2c3d\t2026-10-13T20:03:18Z\tchore(plan): file W1-T9283, a promise owed for #8429 (#11455)",
  "10d1b5c\t2026-10-13T12:00:00Z\tfix(serve): say why board_computed is false in standby readiness (#8429) (#11264)",
  "e4f5a6b\t2026-10-12T09:00:00Z\tfix(serve): an unrelated change (#84290)",
  "0c0ffee\t2026-09-30T09:00:00Z\tfix(serve): before the issue opened (#8429)",
  "",
].join("\n");

function ports(runGit: (args: string[]) => string, issues: RevalidationIssue[]) {
  const opts: ProductionIssueRevalidationOpts = {
    owner: "acme", repo: "remudero", stateDir: "/nonexistent", repoRoot: "/nonexistent", log: () => {}, clock,
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
    policy: () => ({ mode: "shadow", maxClosesPerPass: 5 }),
    readText: async () => JSON.stringify(issues.map((i) => ({
      number: i.number, html_url: i.url, title: i.title, body: i.body, labels: [], created_at: i.createdAt, updated_at: i.updatedAt,
    }))),
    runGit, readLedgerRows: () => [], issues: {},
  };
  return productionIssueRevalidationPorts(opts);
}

test("W1-T9308: the revalidation judge sees the commits that name an issue", async () => {
  const logs: string[][] = [];
  const p = ports((args) => (args[0] === "log" ? (logs.push(args), LOG) : ""),
    [issue(8429, "2026-10-01T10:00:00Z"), issue(9587, "2026-10-05T10:00:00Z")]);
  const [i8429, i9587] = await p.listOpenIssues();

  // 1. The fix that names #8429 is a present fact; a filing, #84290 and a commit before the issue opened are not.
  const facts = p.evidence(i8429!).facts.filter((f) => /commit/.test(f));
  assert.deepEqual(facts, ["commit 10d1b5c on origin/main names #8429: fix(serve): say why board_computed is false in standby readiness (#8429) (#11264)"]);
  assert.equal(isAbsenceOnlyCitation(facts[0]!), false, "a commit citation names something present");

  // 2. No commit naming the issue is told as absence only, so it can never close the issue.
  const none = p.evidence(i9587!).facts.filter((f) => /commit/.test(f));
  assert.deepEqual(none, ["no origin/main commit since the issue opened names #9587 in its subject — absence only"]);
  assert.equal(isAbsenceOnlyCitation(none[0]!), true);

  // 3. Main's log is read once per pass, from the oldest listed issue.
  assert.deepEqual(logs, [["log", "origin/main", "--since=2026-10-01T10:00:00Z", "--format=%h%x09%cI%x09%s"]]);
  await p.listOpenIssues();
  p.evidence(i8429!);
  assert.equal(logs.length, 2, "a new pass reads the log again");
});

test("an unreadable commit log is told to the judge as unread, never as no commit", async () => {
  const p = ports((args) => { if (args[0] === "log") throw new Error("git log: bad object origin/main"); return ""; }, [issue(8429, "2026-10-01T10:00:00Z")]);
  const [listed] = await p.listOpenIssues();
  assert.ok(p.evidence(listed!).facts.includes("main's commit log could not be read (git log: bad object origin/main)"));
});

test("a commit log line keeps a subject's tabs and skips a malformed line", () => {
  assert.deepEqual(parseMainCommitLog("abc1234\t2026-10-13T00:00:00Z\ta\tb\nbroken\n"), [{ sha: "abc1234", committedAt: "2026-10-13T00:00:00Z", subject: "a\tb" }]);
  const many = Array.from({ length: 7 }, (_, n) => ({ sha: `c${n}`, committedAt: "2026-10-13T00:00:00Z", subject: `fix: part ${n} (#7)` }));
  assert.equal(commitsNamingIssue({ number: 7, createdAt: "2026-10-01T00:00:00Z" }, many).length, 5, "bounded per issue");
});
