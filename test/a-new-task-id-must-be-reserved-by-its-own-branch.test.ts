/**
 * test/a-new-task-id-must-be-reserved-by-its-own-branch.test.ts — W1-T4414.
 *
 * MEASURED 2026-09-23: remudero-console #1700 and #1701 each filed CONSOLE-T60 and each passed review
 * against a base that declared no CONSOLE-T60. Review now reads refs/rmd-id/<id> on the TARGET's origin
 * (a real local bare repo here, so the real git reader runs) and requires its anchor to name the PR head.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeReview, taskIdOwnershipFindings } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { formatReservationAnchorMessage, readReservationAnchors, reservationHolderBranch } from "../src/lib/task-id-reservation.js";
import { cloneTargetPlan, nextTaskIdCommand, runReview } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** W1-T4423: a plan-only PASS rests on the review's own lint-plan run; this is that run finding nothing. */
const CLEAN_PLAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };

const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "the widget renders" }];
const REPORT = "REPORT\n- the widget renders.\nPR_URL: https://github.com/o/r/pull/7";
const HEAD = "file/control-status-read-path";
const OTHER = "file/renumber-the-read-only-fix";

/** A console-shaped origin whose main declares CONSOLE-T57, cloned as the review's head checkout so
 *  `origin` is the TARGET. `reserved` maps an id to the holder branch its anchor records. */
function consoleReview(reserved: Record<string, string>, baseline?: string): { head: GitRepo; bare: GitRepo } {
  const bare = gitRepo({ bare: true, kind: "own-reservation-origin" });
  const work = gitRepo({ kind: "own-reservation-work" });
  const files: Record<string, string> = { "plan/tasks.d/CONSOLE-T57-x.yaml": "- id: CONSOLE-T57\n" };
  if (baseline !== undefined) files["plan/task-id-reservation-baseline.json"] = baseline;
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work.dir, rel)), { recursive: true });
    writeFileSync(join(work.dir, rel), text);
  }
  work.git("add", "plan");
  work.git("commit", "--quiet", "-m", "plan");
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  const tree = work.git("hash-object", "-t", "tree", "/dev/null");
  for (const [id, branch] of Object.entries(reserved)) {
    const anchor = work.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch, pid: 1, host: "h", startedAt: "2026-09-23T00:00:00.000Z", source: "automatic" }));
    work.git("push", "--quiet", "origin", `${anchor}:refs/rmd-id/${id}`);
  }
  const head = gitRepo({ cloneFrom: bare.dir, kind: "own-reservation-head" });
  return { head, bare };
}

const shardDiff = (file: string, lines: string[]) => [`diff --git a/${file} b/${file}`, `+++ b/${file}`, "@@", ...lines].join("\n");
const T60 = shardDiff("plan/tasks.d/CONSOLE-T60-control-status.yaml", ["+- id: CONSOLE-T60", '+  title: "t"']);

test("a pull request adding a shard whose id is reserved by another branch is refused and told to renumber", () => {
  const { head } = consoleReview({ "CONSOLE-T60": OTHER });
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.deepEqual(v.taskIdOwnership, [{ id: "CONSOLE-T60", file: "plan/tasks.d/CONSOLE-T60-control-status.yaml", kind: "foreign", holder: OTHER }]);
  assert.equal(v.state, "failure");
  assert.equal(v.floorState, "failure");
  assert.equal(v.summary, `remudero-review: FAIL — id CONSOLE-T60 is reserved by ${OTHER}, not this PR — renumber`);
  assert.equal(v.taskIdOwnershipWithheld, undefined, "a foreign holder is a verdict, never withheld");
});

test("a pull request adding a shard whose id is not reserved at all is refused with the mint command", () => {
  const { head } = consoleReview({});
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.deepEqual(v.taskIdOwnership?.map((f) => f.kind), ["unreserved"]);
  assert.equal(v.state, "failure");
  assert.equal(v.summary, "remudero-review: FAIL — id CONSOLE-T60 is not reserved — mint it with rmd next-task-id --prefix");
});

test("a shard id reserved by the pull request's own head branch passes", () => {
  const { head } = consoleReview({ "CONSOLE-T60": HEAD });
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  const control = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir });
  assert.deepEqual(v.taskIdOwnership, []);
  assert.equal(v.state, "success");
  assert.equal(v.state, control.state, "ownership adds nothing to a verdict whose holder is this head");
  assert.equal(v.summary, control.summary);
  assert.doesNotMatch(v.summary, /reserved|renumber/);
});

test("W1-T4414: two refused ids name the actionable one first and count the rest, and a long holder is clipped under the cap", () => {
  const long = `file/${"a-holder-branch-named-after-its-whole-rationale-".repeat(3)}end`;
  const { head } = consoleReview({ "CONSOLE-T60": long });
  const diff = [T60, shardDiff("plan/tasks.d/CONSOLE-T61-y.yaml", ["+- id: CONSOLE-T61"])].join("\n");
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.equal(v.taskIdOwnership?.length, 2);
  assert.match(v.summary, /^remudero-review: FAIL — id CONSOLE-T60 is reserved by file\/a-holder.*…, not this PR — renumber \(\+1 more\)$/);
  assert.equal(v.summary.length, 140, "clipped to exactly the commit-status cap");
});

test("W1-T4414: ids the base declares, baselined ids, suffixed ids and a recorded hand-off are exempt", () => {
  const baseline = JSON.stringify([
    { id: "CONSOLE-T62", reason: "pre-allocator filing, predates W1-T4388" },
    { id: "CONSOLE-T63", reason: "" },
  ]);
  const { head } = consoleReview({ "CONSOLE-T64": "unknown" }, baseline);
  const diff = [
    shardDiff("plan/tasks.d/CONSOLE-T57-x.yaml", ["-- id: CONSOLE-T57", "+- id: CONSOLE-T57"]),
    shardDiff("plan/tasks.d/CONSOLE-T62-y.yaml", ["+- id: CONSOLE-T62"]),
    shardDiff("plan/tasks.d/CONSOLE-T63-z.yaml", ["+- id: CONSOLE-T63"]),
    shardDiff("plan/tasks.d/W1-T1B-s.yaml", ["+- id: W1-T1B"]),
    shardDiff("plan/tasks.d/CONSOLE-T64-h.yaml", ["+- id: CONSOLE-T64", "+  note: |", `+    reservation hand-off: unknown -> ${HEAD}`]),
  ].join("\n");
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.deepEqual(v.taskIdOwnership, [{ id: "CONSOLE-T63", file: "plan/tasks.d/CONSOLE-T63-z.yaml", kind: "unreserved" }], "a baseline row with no reason exempts nothing");
  const noHandoff = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: shardDiff("plan/tasks.d/CONSOLE-T64-h.yaml", ["+- id: CONSOLE-T64"]), report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.deepEqual(noHandoff.taskIdOwnership, [{ id: "CONSOLE-T64", file: "plan/tasks.d/CONSOLE-T64-h.yaml", kind: "foreign", holder: "unknown" }], "control: without the note the unattributed holder is refused");
});

test("W1-T4414: an unreachable origin is UNKNOWN and withholds the verdict rather than passing it", () => {
  const { head } = consoleReview({ "CONSOLE-T60": HEAD });
  head.git("remote", "set-url", "origin", join(head.dir, "no-such-origin"));
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.equal(v.taskIdOwnership?.[0]?.kind, "unknown");
  assert.equal(v.state, "failure", "never a pass");
  assert.equal(v.taskIdOwnershipWithheld, v.summary);
  assert.equal(v.summary, "remudero-review: FAIL — id CONSOLE-T60 reservation unreadable (UNKNOWN) — verdict withheld");
  const noHead = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir });
  assert.deepEqual(noHead.taskIdOwnership, [], "no head ref means no holder to compare, so the check does not run");
});

test("W1-T4414: an UNKNOWN beside a certain failure posts the failure instead of withholding it", () => {
  const reads = new Map([["CONSOLE-T60", { status: "unknown" as const, reason: "x" }], ["CONSOLE-T61", { status: "absent" as const }]]);
  const added = [{ id: "CONSOLE-T60", file: "a.yaml" }, { id: "CONSOLE-T61", file: "b.yaml" }];
  const findings = taskIdOwnershipFindings("", added, [], HEAD, mkdtempSync(join(tmpdir(), "rmd-no-repo-")), () => reads);
  assert.deepEqual(findings.map((f) => f.kind), ["unknown", "unreserved"]);
  const { head } = consoleReview({});
  head.git("remote", "set-url", "origin", join(head.dir, "no-such-origin"));
  const v = judgeReview([], { planLint: CLEAN_PLAN_LINT, diff: T60, report: REPORT, headCheckoutDir: head.dir, headRefName: HEAD });
  assert.equal(v.taskIdOwnershipWithheld, undefined, "a review failing for another reason is not withheld");
});

test("W1-T4414: reservationHolderBranch percent-decodes the holder and refuses an unattributed anchor", () => {
  const real = "rmd-id holder branch=file%2Fstale-already-merged-latch pid=49049 host=Mac-mini started_at=2026-09-24T00%3A23%3A02.891Z source=automatic";
  assert.equal(reservationHolderBranch(real), "file/stale-already-merged-latch");
  assert.equal(reservationHolderBranch("rmd-id reservation 1@c 2026-09-01T00:00:00Z"), undefined, "a legacy anchor names no holder");
  assert.equal(reservationHolderBranch("rmd-id holder branch=unknown pid=1"), undefined);
});

test("W1-T4414: readReservationAnchors reads a present ref and reports a failed fetch as UNKNOWN", () => {
  const { head } = consoleReview({ "CONSOLE-T60": HEAD });
  const run = (args: string[]) => {
    if (args[0] === "fetch") return { status: 128, stdout: "", stderr: "fatal: fetch refused" };
    const r = head.git(...args);
    return { status: 0, stdout: r, stderr: "" };
  };
  assert.deepEqual(readReservationAnchors([], run), new Map());
  assert.deepEqual(readReservationAnchors(["CONSOLE-T60"], run).get("CONSOLE-T60"), { status: "unknown", reason: "fatal: fetch refused" });
});

test("a reservation minted with --branch names that branch as its holder", async () => {
  const { bare } = consoleReview({});
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = GIT_REPO_FIXTURE_IDENTITY.name;
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = GIT_REPO_FIXTURE_IDENTITY.email;
  const log = console.log;
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  let code: number;
  try {
    code = await nextTaskIdCommand(["--prefix", "CONSOLE", "--repo", "craigoley/remudero-console", "--branch", HEAD], {}, {
      openTargetRepo: () => cloneTargetPlan(`file://${bare.dir}`),
      openPrTexts: () => [],
      filingBranch: "the-checkout-this-mint-ran-from",
    });
  } finally {
    console.log = log;
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
  assert.equal(code, 0);
  assert.match(out.join("\n"), /^RESERVED CONSOLE-T58 /m);
  assert.equal(reservationHolderBranch(bare.git("log", "-1", "--format=%B", "refs/rmd-id/CONSOLE-T58")), HEAD);
});

test("W1-T4414: a default-family mint with --branch records that branch too", async () => {
  const { bare } = consoleReview({});
  const clone = gitRepo({ cloneFrom: bare.dir, kind: "own-reservation-w1" });
  const log = console.log;
  console.log = () => {};
  let code: number;
  try {
    code = await nextTaskIdCommand(["--branch", HEAD], {}, {
      runGit: (args: string[]) => {
        try {
          return { status: 0, stdout: clone.git(...args), stderr: "" };
        } catch (e) {
          return { status: 1, stdout: "", stderr: String(e) };
        }
      },
      holderOf: () => "unknown",
      openPrTexts: () => [],
    });
  } finally {
    console.log = log;
  }
  assert.equal(code, 0);
  const refs = bare.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/W1-T*").split("\n").filter(Boolean);
  assert.equal(refs.length, 1);
  assert.equal(reservationHolderBranch(bare.git("log", "-1", "--format=%B", refs[0])), HEAD);
});

test("W1-T4414: a withheld ownership verdict posts no terminal review status", async () => {
  const { head } = consoleReview({});
  head.git("remote", "set-url", "origin", join(head.dir, "no-such-origin"));
  const root = mkdtempSync(join(tmpdir(), "rmd-own-reservation-run-"));
  const sha = head.git("rev-parse", "HEAD");
  const gh = ghShim(
    [
      { when: "api repos/", stdout: JSON.stringify({ number: 1, html_url: "https://github.com/acme/console/pull/1", updated_at: "t", body: "", head: { ref: HEAD, sha }, state: "open" }) },
      { when: "pr diff", stdout: T60 },
      { when: "pr view", stdout: JSON.stringify({ state: "OPEN" }) },
    ],
    { kind: "own-reservation-run" },
  );
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${gh.dir}:${priorPath}`;
    const steps: string[] = [];
    const verdict = await runReview({
      lintPlanForReviewFn: async () => CLEAN_PLAN_LINT,
      owner: "acme",
      repo: "console",
      prUrl: "https://github.com/acme/console/pull/1",
      headRefName: HEAD,
      task: { id: "PR-1", acceptance: CRITERIA },
      report: REPORT,
      settingsFile: "",
      config: { root, claudeBin: "/bin/true" } as Config,
      log: (step) => steps.push(step),
      say: () => {},
      account: (result) => result,
      spawnReviewer: false,
      headCheckoutDir: head.dir,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "W1-T4414-withheld",
      arm: () => "no-task-id",
      disarm: () => "not-armed",
    });
    assert.match(verdict.verdictWithheld ?? "", /CONSOLE-T60 reservation unreadable \(UNKNOWN\)/);
    assert.ok(steps.includes("review.post_refused"));
    assert.ok(!steps.includes("review.posted"), "an unread reservation must not publish a terminal status");
    assert.ok(!gh.calls().some((c) => c.includes("statuses/")), "no commit status was written");
    assert.equal(readLedgerLines(join(root, "ledger.ndjson")).some((l) => l.step === "review.posted"), false);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
