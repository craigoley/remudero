import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  judgeReview,
  TASK_ID_LINE_RE,
  taskIdDeclarationsAtRef,
  taskIdDeclarationsInDiff,
} from "../src/lib/review.js";
import { taskIdCollisions } from "../src/lib/task-id-reservation.js";

// W1-T4389 — MEASURED 2026-09-23: remudero-console #1695 added CONSOLE-T58 in a shard named unlike
// the one #1699 had merged it in, so git reported MERGEABLE. The review must refuse that collision
// against the base BRANCH's tip (origin/main), naming both files, and never refuse an edit of the
// base's own shard.

const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "the widget renders" }];
const REPORT = "REPORT\n- the widget renders.\nPR_URL: https://github.com/o/r/pull/7";

/** A real git repo whose `refs/remotes/origin/main` holds `files` — the base branch's tip. The
 *  identity rides env vars so the commit works on a CI runner with no git config at all. */
function baseRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reused-task-id-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env, stdio: "pipe" });
  git("init", "-q");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

const shardDiff = (file: string, lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `+++ b/${file}`, "@@", ...lines].join("\n");

const BASE = {
  "plan/tasks.yaml": "tasks:\n- id: W1-T100\n  title: mono\n",
  "plan/tasks.d/W1-T900-original.yaml": '- id: W1-T900\n  title: "t"\n  findings:\n    - id: nested\n',
  "plan/tasks.d/W1-T901-other.yaml": '- id: W1-T901\n  title: "t"\n',
};

test("a pull request adding a shard under an id its base already declares is refused with both files named", () => {
  const repo = baseRepo(BASE);
  const diff = shardDiff("plan/tasks.d/W1-T900-reissued.yaml", ["+- id: W1-T900", '+  title: "t"']);
  const v = judgeReview(CRITERIA, { diff, report: REPORT, headCheckoutDir: repo });
  assert.deepEqual(v.taskIdCollisions, [
    { id: "W1-T900", addedFile: "plan/tasks.d/W1-T900-reissued.yaml", baseFile: "plan/tasks.d/W1-T900-original.yaml" },
  ]);
  assert.equal(v.state, "failure");
  assert.match(v.summary, /W1-T900-reissued\.yaml/, "names the file THIS PR adds the id in");
  assert.match(v.summary, /W1-T900-original\.yaml/, "and the file the BASE already declares it in");
  assert.match(v.summary, /renumber the later one/);
  assert.ok(v.summary.length <= 140, `fits the commit-status cap: ${v.summary.length}`);
});

test("editing the base's own shard for an id is not a collision", () => {
  const repo = baseRepo(BASE);
  const diff = shardDiff("plan/tasks.d/W1-T900-original.yaml", ["-- id: W1-T900", "+- id: W1-T900", '+  title: "t2"']);
  assert.equal(taskIdDeclarationsInDiff(diff).added.length, 1, "control: the id line IS an added declaration");
  const v = judgeReview(CRITERIA, { diff, report: REPORT, headCheckoutDir: repo });
  assert.deepEqual(v.taskIdCollisions, []);
  assert.doesNotMatch(v.summary, /reused/);
});

test("W1-T4389: two colliding ids report the first and count the rest, and long shard names are clipped under the cap", () => {
  const long = "W1-T900-a-very-long-shard-name-that-names-a-whole-rationale-in-its-slug.yaml";
  const repo = baseRepo({ ...BASE, [`plan/tasks.d/${long}`]: "- id: W1-T902\n" });
  const diff = [
    shardDiff("plan/tasks.d/W1-T902-another-very-long-shard-name-that-cannot-fit-either.yaml", ["+- id: W1-T902"]),
    shardDiff("plan/tasks.yaml", ["+- id: W1-T901"]),
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff, report: REPORT, headCheckoutDir: repo });
  assert.equal(v.taskIdCollisions?.length, 2);
  assert.match(v.summary, /task id W1-T902 reused/);
  assert.match(v.summary, /\(\+1 more\)$/);
  assert.match(v.summary, /…/, "an over-long name is clipped, never sliced off the end by the status API");
  assert.ok(v.summary.length <= 140, `fits the commit-status cap: ${v.summary.length}`);
});

test("W1-T4389: a genuinely new id, or a review with no head checkout, is never a collision", () => {
  const repo = baseRepo(BASE);
  const fresh = shardDiff("plan/tasks.d/W1-T903-new.yaml", ["+- id: W1-T903"]);
  assert.deepEqual(judgeReview(CRITERIA, { diff: fresh, report: REPORT, headCheckoutDir: repo }).taskIdCollisions, []);
  const reused = shardDiff("plan/tasks.d/W1-T900-reissued.yaml", ["+- id: W1-T900"]);
  assert.deepEqual(judgeReview(CRITERIA, { diff: reused, report: REPORT }).taskIdCollisions, []);
});

test("W1-T4389: moving an id out of the file the base declares it in is not a collision", () => {
  const diff = [
    shardDiff("plan/tasks.yaml", ["-- id: W1-T100"]),
    shardDiff("plan/tasks.d/W1-T100-moved.yaml", ["+- id: W1-T100"]),
  ].join("\n");
  const { added, removed } = taskIdDeclarationsInDiff(diff);
  const base = [{ id: "W1-T100", file: "plan/tasks.yaml" }];
  assert.deepEqual(taskIdCollisions(added, base, removed), []);
  assert.deepEqual(taskIdCollisions(added, base), [
    { id: "W1-T100", addedFile: "plan/tasks.d/W1-T100-moved.yaml", baseFile: "plan/tasks.yaml" },
  ], "control: without the removal the same move IS a collision");
});

test("W1-T4389: taskIdCollisions reports one (id, file) pair once however many lines add it", () => {
  const added = [
    { id: "W1-T1", file: "plan/tasks.d/b.yaml" },
    { id: "W1-T1", file: "plan/tasks.d/b.yaml" },
  ];
  assert.equal(taskIdCollisions(added, [{ id: "W1-T1", file: "plan/tasks.d/a.yaml" }]).length, 1);
});

test("W1-T4389: TASK_ID_LINE_RE accepts a column-0 task header and refuses a nested or ordinary line", () => {
  assert.equal(TASK_ID_LINE_RE.test("- id: CONSOLE-T58"), true);
  assert.equal(TASK_ID_LINE_RE.test("    - id: nested"), false);
  assert.equal(TASK_ID_LINE_RE.test("  title: W1-T1"), false);
});

test("W1-T4389: taskIdDeclarationsAtRef reads every plan file at the ref, and an unreadable ref declares nothing", () => {
  const repo = baseRepo(BASE);
  assert.deepEqual(taskIdDeclarationsAtRef(repo, "origin/main"), [
    { id: "W1-T900", file: "plan/tasks.d/W1-T900-original.yaml" },
    { id: "W1-T901", file: "plan/tasks.d/W1-T901-other.yaml" },
    { id: "W1-T100", file: "plan/tasks.yaml" },
  ]);
  assert.deepEqual(taskIdDeclarationsAtRef(repo, "refs/remotes/origin/no-such-branch"), []);
  assert.deepEqual(taskIdDeclarationsAtRef(mkdtempSync(join(tmpdir(), "rmd-not-a-repo-")), "origin/main"), []);
});
