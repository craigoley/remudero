// W1-T11374: auto-triage enumerates its status: new candidates from origin/main's plan/feedback, so an
// entry merged after the daemon booted is a candidate on the next pass, not after the next restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import {
  newFeedbackIdsOldestFirst,
  oldestFeedbackAgeMs,
  refreshFeedbackFromMain,
  type MainFeedbackGit,
} from "#src/lib/auto-triage.js";

function entry(id: string, ts: string, status: string): string {
  return `id: ${id}\nts: ${ts}\nstatus: ${status}\nsource: test\n`;
}

function commitEntry(repo: GitRepo, id: string, ts: string, status: string): void {
  mkdirSync(join(repo.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "feedback", `${id}.yaml`), entry(id, ts, status));
  repo.git("add", `plan/feedback/${id}.yaml`);
  repo.git("commit", "-q", "-m", `feedback ${id} ${status}`);
  repo.git("push", "-q", "origin", "HEAD:main");
}

/** A bare origin, a seed clone that lands feedback, and a daemon checkout booted at the first landing. */
function fleet(): { origin: GitRepo; seed: GitRepo; boot: GitRepo; cleanup: () => void } {
  const origin = gitRepo({ bare: true, branch: "main" });
  const seed = gitRepo({ cloneFrom: origin.dir });
  commitEntry(seed, "fb-old", "2026-11-01T00:00:00.000Z", "new");
  commitEntry(seed, "fb-triaged-on-main", "2026-11-02T00:00:00.000Z", "new");
  const boot = gitRepo({ cloneFrom: origin.dir });
  return { origin, seed, boot, cleanup: () => { boot.cleanup(); seed.cleanup(); origin.cleanup(); } };
}

function countingGit(): { git: MainFeedbackGit; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, git: (cwd, args, opts) => { calls.push([...args]); return hostWorktreeGitAsync(cwd, args, opts); } };
}

test("W1-T11374: a status new entry merged to origin/main after boot is a candidate on the first pass after the fetch, with no restart", async () => {
  const f = fleet();
  try {
    const bootHead = f.boot.git("rev-parse", "HEAD");
    commitEntry(f.seed, "fb-merged-after-boot", "2026-11-03T00:00:00.000Z", "new");
    f.boot.git("fetch", "-q", "origin");
    assert.deepEqual(newFeedbackIdsOldestFirst(f.boot.dir), ["fb-old", "fb-triaged-on-main"],
      "control: the boot checkout alone cannot see the merged entry; this is the defect");
    await refreshFeedbackFromMain(f.boot.dir);
    assert.deepEqual(newFeedbackIdsOldestFirst(f.boot.dir), ["fb-old", "fb-triaged-on-main", "fb-merged-after-boot"]);
    assert.equal(f.boot.git("rev-parse", "HEAD"), bootHead, "the checkout itself never moved; only origin/main was read");
    assert.equal(oldestFeedbackAgeMs(f.boot.dir, new Date("2026-11-04T00:00:00.000Z")), 3 * 86_400_000,
      "the age reader reads the same list");
  } finally {
    f.cleanup();
  }
});

test("W1-T11374 criterion 2: origin/main judges a tracked entry, and an untracked local capture stays a candidate", async () => {
  const f = fleet();
  try {
    writeFileSync(join(f.seed.dir, "plan", "feedback", "fb-triaged-on-main.yaml"),
      entry("fb-triaged-on-main", "2026-11-02T00:00:00.000Z", "triaged"));
    f.seed.git("commit", "-q", "-am", "triage fb-triaged-on-main");
    f.seed.git("push", "-q", "origin", "HEAD:main");
    writeFileSync(join(f.boot.dir, "plan", "feedback", "fb-local-capture.yaml"),
      entry("fb-local-capture", "2026-11-03T12:00:00.000Z", "new"));
    f.boot.git("fetch", "-q", "origin");
    assert.match(readFileSync(join(f.boot.dir, "plan", "feedback", "fb-triaged-on-main.yaml"), "utf8"), /^status: new$/m,
      "control: the stale checkout still says new");
    await refreshFeedbackFromMain(f.boot.dir);
    assert.deepEqual(newFeedbackIdsOldestFirst(f.boot.dir), ["fb-old", "fb-local-capture"]);
  } finally {
    f.cleanup();
  }
});

test("W1-T11374 criterion 3: the read is asynchronous and re-reads the tree only when origin/main's sha moves", async () => {
  const f = fleet();
  try {
    f.boot.git("fetch", "-q", "origin");
    const { git, calls } = countingGit();
    let loopTurned = false;
    setImmediate(() => { loopTurned = true; });
    const pending = refreshFeedbackFromMain(f.boot.dir, { git });
    assert.ok(pending instanceof Promise, "the refresh is awaited, never a synchronous walk of git");
    await pending;
    assert.ok(loopTurned, "the loop turned while the refresh's git children ran");
    assert.ok(calls.length > 0, "the first read spawns git for the tree");
    calls.length = 0;
    await refreshFeedbackFromMain(f.boot.dir, { git });
    newFeedbackIdsOldestFirst(f.boot.dir);
    assert.deepEqual(calls, [], "an unchanged origin/main pays no git spawn for candidates");
    commitEntry(f.seed, "fb-next", "2026-11-03T00:00:00.000Z", "new");
    f.boot.git("fetch", "-q", "origin");
    await refreshFeedbackFromMain(f.boot.dir, { git });
    assert.ok(calls.some((args) => args[0] === "ls-tree"), "a moved origin/main re-reads the tree");
    assert.ok(newFeedbackIdsOldestFirst(f.boot.dir).includes("fb-next"));
  } finally {
    f.cleanup();
  }
});

test("W1-T11374: an unreadable origin/main falls back to the checkout walk and ledgers why, once per reason", async () => {
  const lone = gitRepo({});
  try {
    mkdirSync(join(lone.dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(lone.dir, "plan", "feedback", "fb-here.yaml"), entry("fb-here", "2026-11-01T00:00:00.000Z", "new"));
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown>) => rows.push({ step, extra });
    await refreshFeedbackFromMain(lone.dir, { log });
    await refreshFeedbackFromMain(lone.dir, { log });
    assert.deepEqual(newFeedbackIdsOldestFirst(lone.dir), ["fb-here"], "the checkout walk governs, as before");
    assert.equal(rows.length, 1, "a main that stays unreadable is one row, not one per pass");
    assert.equal(rows[0].step, "auto_triage.candidates_fallback");
    assert.equal(typeof rows[0].extra.reason, "string");
  } finally {
    lone.cleanup();
  }
});

test("W1-T11374: the daemon's autoTriageCheck refreshes from origin/main before it builds both readers", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function autoTriageCheck("), src.indexOf("export function buildRetroDaemonHooks("));
  const refresh = fn.indexOf("await refreshFeedbackFromMain(feedbackRoot");
  assert.ok(refresh > 0, "autoTriageCheck awaits the refresh off its own feedbackRoot");
  assert.ok(refresh < fn.indexOf("candidates: newFeedbackIdsOldestFirst(feedbackRoot)"), "before the candidate read");
});
