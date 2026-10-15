/**
 * test/an-unknown-reservation-names-the-git-read-that-failed.test.ts — W1-T9674.
 *
 * MEASURED 2026-10-15: #12011 was withheld twice with "id W1-T9645 reservation unreadable (UNKNOWN) — verdict
 * withheld" while refs/rmd-id/W1-T9645 existed and named its own branch. The reader knew which git call failed and
 * what git said; the status and the review.post_refused row dropped it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { failSummary, judgeReview, taskIdOwnershipFindings, type TaskIdOwnershipFinding } from "../src/lib/review.js";
import { readReservationAnchors, readReservationAnchorsAsync } from "../src/lib/task-id-reservation.js";
import { runReview } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const CLEAN_PLAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "the widget renders" }];
const REPORT = "REPORT\n- the widget renders.\nPR_URL: https://github.com/o/r/pull/7";
const HEAD = "plan-file-1792068079473";
const ID = "W1-T9645";
const SHARD = `plan/tasks.d/${ID}-a-baked-path-fix-is-recycled-in.yaml`;
const DIFF = [`diff --git a/${SHARD} b/${SHARD}`, `+++ b/${SHARD}`, "@@", `+- id: ${ID}`, '+  title: "t"'].join("\n");
const ANCHOR = "cbfc26fb6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GIT_SAID = `fatal: couldn't find remote ref refs/rmd-id/${ID}`;

type Answer = { status: number; stdout: string; stderr: string };
const listed: Answer = { status: 0, stdout: `${ANCHOR}\trefs/rmd-id/${ID}\n`, stderr: "" };
const holder = `rmd-id holder branch=${HEAD} pid=1 host=h started_at=2026-10-15T00%3A00%3A00.000Z source=automatic\n\0`;

/** A reservation reader whose ls-remote finds the anchor and whose `failing` verb answers with git's error. */
function gitAnswering(failing: "fetch" | "log" | "none") {
  return (args: string[]): Answer => {
    if (args[0] === "ls-remote") return listed;
    if (args[0] === failing) return { status: 128, stdout: "", stderr: `${GIT_SAID}\n` };
    return args[0] === "fetch" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: holder, stderr: "" };
  };
}

function verdictFor(failing: "fetch" | "log" | "none") {
  const reads = readReservationAnchors([ID], gitAnswering(failing));
  const noBaseline = mkdtempSync(join(tmpdir(), "rmd-t9674-"));
  try {
    const ownership = taskIdOwnershipFindings(DIFF, [{ id: ID, file: SHARD }], [], HEAD, noBaseline, () => reads);
    return judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: DIFF, report: REPORT, headRefName: HEAD, reservationOwnership: ownership, baseTaskIdDeclarations: [] });
  } finally {
    rmSync(noBaseline, { recursive: true, force: true });
  }
}

const summaryOf = (reason: string, more: TaskIdOwnershipFinding[] = []): string =>
  failSummary([], false, false, false, 0, [], undefined, [], [], [], [{ id: ID, file: SHARD, kind: "unknown", reason }, ...more]);

test("W1-T9674: a failed anchor fetch withholds the review naming the fetch and what git said", () => {
  const v = verdictFor("fetch");
  assert.equal(v.summary, `remudero-review: FAIL — id ${ID} reservation unreadable (UNKNOWN): fetch failed — verdict withheld`);
  assert.deepEqual(v.taskIdOwnership, [{ id: ID, file: SHARD, kind: "unknown", reason: `fetch failed: ${GIT_SAID}` }]);
  assert.equal(v.taskIdOwnershipWithheld, v.summary);
});

test("W1-T9674: an unknown reservation read still withholds the verdict", () => {
  const owned = verdictFor("none");
  assert.deepEqual(owned.taskIdOwnership, [], "control: the same anchor read cleanly is owned by this head");
  assert.equal(owned.state, "success");
  for (const [failing, step] of [["fetch", "fetch failed"], ["log", "anchor log failed"]] as const) {
    const v = verdictFor(failing);
    assert.equal(v.state, "failure", `${failing}: never a pass`);
    assert.deepEqual(v.taskIdOwnership?.map((f) => f.kind), ["unknown"], `${failing}: never judged owned or foreign`);
    assert.equal(v.taskIdOwnershipWithheld, v.summary, `${failing}: withheld, not posted`);
    assert.match(v.summary, new RegExp(`reservation unreadable \\(UNKNOWN\\): ${step} — verdict withheld$`));
  }
});

test("W1-T9674: every unknown reason the review records names its step inside the status cap", () => {
  const steps: Array<[string, string]> = [
    ["ls-remote failed: fatal: unable to access origin", "ls-remote failed"],
    ["ls-remote failed: git ls-remote timed out after 600000ms and was killed. git said: connecting", "ls-remote failed (timed out)"],
    ["log failed: fatal: bad object", "anchor log failed"],
    ["head-ref-unavailable", "no head ref"],
    ["head-checkout-unavailable", "no head checkout"],
    ["base-unreadable: git ls-tree timed out after 150ms and was killed", "base read timed out"],
    ["baseline-unreadable: git show timed out after 150ms and was killed", "baseline read timed out"],
    ["no read", "no read"],
    ["  ", "no reason recorded"],
  ];
  for (const [reason, step] of steps) {
    assert.equal(summaryOf(reason), `remudero-review: FAIL — id ${ID} reservation unreadable (UNKNOWN): ${step} — verdict withheld`, reason);
  }
  const long = summaryOf(`something new: ${"x".repeat(200)}`, [{ id: "W1-T9647", file: "b.yaml", kind: "unknown", reason: "no read" }]);
  assert.equal(long.length, 140, "clipped to exactly the commit-status cap");
  assert.match(long, /: something new: x+… — verdict withheld \(\+1 more\)$/, "the clip keeps the withheld tail");
});

test("W1-T9674: the awaited reader names the failed verb too, and an empty stderr names the exit", async () => {
  const run = (failing: "fetch" | "log") => async (args: string[]) => gitAnswering(failing)(args);
  assert.deepEqual((await readReservationAnchorsAsync([ID], run("fetch"))).get(ID), { status: "unknown", reason: `fetch failed: ${GIT_SAID}` });
  assert.deepEqual((await readReservationAnchorsAsync([ID], run("log"))).get(ID), { status: "unknown", reason: `log failed: ${GIT_SAID}` });
  const silent = readReservationAnchors([ID], (args) => (args[0] === "ls-remote" ? { status: 2, stdout: "", stderr: "" } : listed));
  assert.deepEqual(silent.get(ID), { status: "unknown", reason: "ls-remote failed: exited 2" });
});

test("W1-T9674: a withheld review's post_refused row carries each unknown read's id and what git said", async () => {
  const bare = gitRepo({ bare: true, kind: "t9674-origin" });
  const work = gitRepo({ kind: "t9674-work" });
  mkdirSync(dirname(join(work.dir, "plan/tasks.yaml")), { recursive: true });
  writeFileSync(join(work.dir, "plan/tasks.yaml"), "- id: W1-T57\n  title: seed\n");
  work.git("add", "plan");
  work.git("commit", "--quiet", "-m", "plan");
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  const head = gitRepo({ cloneFrom: bare.dir, kind: "t9674-head" });
  head.git("remote", "set-url", "origin", join(head.dir, "no-such-origin"));
  const root = mkdtempSync(join(tmpdir(), "rmd-t9674-run-"));
  const sha = head.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/craigoley/remudero/pull/12011";
  const gh = ghShim(
    [
      { when: "api repos/", stdout: JSON.stringify({ number: 12011, html_url: prUrl, updated_at: "t", body: "", head: { ref: HEAD, sha }, state: "open" }) },
      { when: "pr diff", stdout: DIFF },
      { when: "pr view", stdout: JSON.stringify({ state: "OPEN" }) },
    ],
    { kind: "t9674-run" },
  );
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${gh.dir}:${priorPath}`;
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const verdict = await runReview({
      lintPlanForReviewFn: async () => CLEAN_PLAN_LINT,
      owner: "craigoley",
      repo: "remudero",
      prUrl,
      headRefName: HEAD,
      task: { id: "PR-12011", acceptance: CRITERIA },
      report: REPORT,
      settingsFile: "",
      config: { root, claudeBin: "/bin/true" } as Config,
      log: (step, fields) => rows.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
      say: () => {},
      account: (result) => result,
      spawnReviewer: false,
      headCheckoutDir: head.dir,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "W1-T9674-withheld",
      arm: () => "no-task-id",
      disarm: () => "not-armed",
    });
    const refused = rows.filter((r) => r.step === "review.post_refused");
    assert.equal(refused.length, 1, "exactly one refusal row");
    assert.equal(refused[0].fields.reason, verdict.verdictWithheld);
    assert.match(String(refused[0].fields.reason), new RegExp(`id ${ID} reservation unreadable \\(UNKNOWN\\): ls-remote failed — verdict withheld`));
    const unknown = refused[0].fields.unknown_reservations as Array<{ id: string; reason: string }>;
    assert.deepEqual(unknown.map((u) => u.id), [ID]);
    assert.match(unknown[0].reason, /^ls-remote failed: .*no-such-origin/s, "git's own words ride the row in full");
    assert.ok(!rows.some((r) => r.step === "review.posted"), "still withheld: no terminal status");
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
