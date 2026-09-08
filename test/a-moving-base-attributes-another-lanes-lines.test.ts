/**
 * test/a-moving-base-attributes-another-lanes-lines.test.ts — W1-T3060.
 *
 * SEVEN sites in `.github/workflows/ci.yml` diffed against `github.event.pull_request.base.sha` —
 * the base branch's tip AT THE MOMENT THE WEBHOOK FIRED — while `HEAD` in a `pull_request`
 * checkout is the MERGE COMMIT of the PR head into main's CURRENT tip. On a fleet that merges
 * several times an hour those are different points, and every commit that landed in between is
 * inside `HEAD` but outside `BASE_SHA`, so the diff reports it as this PR's own added lines.
 *
 * MEASURED 2026-09-07, four false reds in one afternoon. #4463's entire three-dot diff is two
 * `plan/*.yaml` files, and it was blocked by `diff-coverage` on `src/run-task.ts:18466-18469` —
 * lines byte-identical at its merge base, in a file it does not touch. A plan-only PR cannot add
 * source lines. #4455 was blocked the same way on the same file.
 *
 * THE FIX IS A DIFFERENT POINT, NOT A RETRY. On a `pull_request` event `HEAD` is a merge commit
 * whose FIRST PARENT is the base side, so `HEAD^1` is the exact point the merge was taken from and
 * is correct BY CONSTRUCTION however long the job waited in the queue. Nothing here detects drift
 * and re-runs; the diff is simply taken from the right place the first time.
 *
 * THE FALSIFIER IS A TWO-TREE COMPARISON, NOT AN ASSERTION ABOUT ONE. A test that only checked the
 * fixed form would pass against the unfixed workflow too, so every case below takes the diff BOTH
 * ways over the same fixture and asserts they DIFFER — the stale form seeing the intervening
 * commit is what makes the fixed form's silence meaningful.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

/** The REAL classifier the two fast-lane sites hand `changed-files.txt` to — imported, never
 *  restated, so criterion 2 is about the shipped predicate rather than a copy of it. */
const { classify, CLASSES } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-class.mjs")).href)) as {
  classify: (files: unknown) => { class: string; reason: string };
  CLASSES: { PLAN_ONLY: string; DOCS_ONLY: string; SOURCE: string };
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/**
 * THE SHAPE GITHUB ACTUALLY BUILDS. A base commit `b0`; a PR branch off it carrying a PLAN-ONLY
 * change; a SECOND commit `b1` landing on main afterwards and touching `src/run-task.ts`; and the
 * merge commit GitHub checks out for a `pull_request` event, whose FIRST parent is `b1`.
 *
 * `b0` is what the webhook payload's `base.sha` would carry — main's tip when the PR opened.
 */
function fixture(): { dir: string; b0: string; merge: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3060-`));
  git(dir, "init", "-q", "-b", "main", ".");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T1.yaml"), "- id: W1-T1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "b0: the base when the PR opened");
  const b0 = git(dir, "rev-parse", "HEAD").trim();

  // The PR: plan-only, branched from b0.
  git(dir, "checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T2.yaml"), "- id: W1-T2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "pr: file one shard");

  // ANOTHER LANE lands on main while the PR sits open.
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "b1: another lane's source change");

  // The merge commit a pull_request checkout receives: first parent is the CURRENT base.
  git(dir, "merge", "-q", "--no-ff", "-m", "merge pr into main", "pr");
  return { dir, b0, merge: git(dir, "rev-parse", "HEAD").trim() };
}

/** `git diff --name-only <base>...HEAD`, the exact three-dot form every rewritten site uses. */
function changedFiles(dir: string, base: string): string[] {
  return git(dir, "diff", "--name-only", `${base}...HEAD`).trim().split("\n").filter(Boolean);
}

// ── criterion 1: the two points disagree, and only one of them is this PR ──────────────────────

test("W1-T3060 criterion 1: the stale base attributes another lane's commit to this PR; HEAD^1 does not", () => {
  const { dir, b0, merge } = fixture();
  try {
    const stale = changedFiles(dir, b0);
    const fixed = changedFiles(dir, `${merge}^1`);

    // THE DEFECT, REPRODUCED. Without this half the assertion below proves nothing: a test that
    // only checked the fixed form would pass against the unfixed workflow too.
    assert.deepEqual(stale.sort(), ["plan/tasks.d/W1-T2.yaml", "src/run-task.ts"], "the webhook's base sees the intervening commit");
    assert.deepEqual(fixed, ["plan/tasks.d/W1-T2.yaml"], "the merge commit's first parent sees only this PR");
    assert.notDeepEqual(stale.sort(), fixed, "and the two points genuinely disagree on this fixture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3060 criterion 1: HEAD^1 is the point the merge was taken from, whatever the queue delay", () => {
  // `HEAD^1` is an ancestor of `HEAD`, so `HEAD^1...HEAD` and `HEAD^1..HEAD` name the same set —
  // the three-dot form is correct by construction here rather than by coincidence, and no later
  // merge onto main can move it.
  const { dir, merge } = fixture();
  try {
    const threeDot = git(dir, "diff", "--name-only", `${merge}^1...HEAD`).trim();
    const twoDot = git(dir, "diff", "--name-only", `${merge}^1..HEAD`).trim();
    assert.equal(threeDot, twoDot, "the first parent is an ancestor, so both forms agree");
    assert.equal(git(dir, "merge-base", `${merge}^1`, "HEAD").trim(), git(dir, "rev-parse", `${merge}^1`).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 2: the fast lane classifies a plan-only diff as PLAN_ONLY again ──────────────────

test("W1-T3060 criterion 2: a plan-only diff still classifies PLAN_ONLY once unrelated commits land on the base", () => {
  // MISCLASSIFICATION AND MISATTRIBUTION COMPOUND, which is why the block landed at all: with
  // another lane's `src/` file in `changed-files.txt` a genuinely plan-only diff classified as
  // SOURCE, the `CLASS != SOURCE` early exit never fired, and diff-coverage ran on a PR it was
  // designed to skip — then failed it on lines that PR never touched.
  const { dir, b0, merge } = fixture();
  try {
    assert.equal(classify(changedFiles(dir, b0)).class, CLASSES.SOURCE, "the stale list misclassifies — the defect");
    assert.equal(classify(changedFiles(dir, `${merge}^1`)).class, CLASSES.PLAN_ONLY, "the correct list classifies correctly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 3: the push path is unchanged ────────────────────────────────────────────────────

test("W1-T3060 criterion 3: every rewritten site is still unreachable on a push", () => {
  // `HEAD^1` does not name a base side on a push, exactly as `base.sha` was empty there, so the
  // push path must keep skipping rather than run wrong. Each job establishes that ONE of two ways
  // and this asserts the disjunction per job rather than assuming which — a job that lost both
  // would slip through a check that only looked for one.
  const raw = readFileSync(CI_YAML, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, { if?: string; steps?: Array<{ run?: string; env?: Record<string, string> }> }> };
  const rewritten = Object.entries(doc.jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => (s.run ?? "").includes("HEAD^1") || (s.env ?? {}).BASE_SHA === "HEAD^1"),
  );
  assert.ok(rewritten.length >= 5, `sanity: the rewritten jobs must be findable, got ${rewritten.length}`);
  for (const [id, job] of rewritten) {
    const prOnly = job.if === "github.event_name == 'pull_request'";
    const shellGuarded = (job.steps ?? []).some(
      (s) => (s.run ?? "").includes("HEAD^1") && /GITHUB_EVENT_NAME.*pull_request/s.test(s.run ?? ""),
    );
    assert.ok(prOnly || shellGuarded, `job '${id}' must be PR-only or shell-guarded, or a push runs it against a parent that is not a base`);
  }
});

test("W1-T3060 criterion 3: on a non-merge HEAD, HEAD^1 is an ordinary parent — which is why the guards matter", () => {
  // The reason the guards are load-bearing rather than ceremonial, shown rather than asserted
  // about: on a push HEAD^1 resolves to something, and that something is not a base side.
  const { dir } = fixture();
  try {
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "an ordinary push commit");
    assert.deepEqual(changedFiles(dir, "HEAD^1"), ["src/run-task.ts"], "HEAD^1 names the previous commit, not a PR base");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 4: all seven, not just the two loud ones ─────────────────────────────────────────

test("W1-T3060 criterion 4: no ci.yml step computes a diff from the event payload's base.sha", () => {
  // FIX ALL SEVEN OR THE DEFECT SURVIVES WHERE IT IS HARDEST TO SEE. The two diff-coverage sites
  // produce a loud red; lint-plan, mutation-ratchet, containment-probe and the §8A net-byte arm
  // produce a WIDER measurement that usually still passes, so they degrade silently.
  const raw = readFileSync(CI_YAML, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }> };
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
  const stale = steps.filter((s) => Object.values(s.env ?? {}).some((v) => String(v).includes("pull_request.base.sha")));
  assert.deepEqual(stale, [], "no step may still carry the event payload's base sha");
  assert.doesNotMatch(raw, /git diff[^\n]*BASE_SHA[^\n]*\.\.\.HEAD/, "and none may diff from it");
  // The count is asserted so a site added later cannot quietly reintroduce the stale point while
  // the two assertions above still pass on the six that were fixed.
  const usingFirstParent = steps.filter((s) => (s.run ?? "").includes("HEAD^1") || (s.env ?? {}).BASE_SHA === "HEAD^1");
  assert.ok(usingFirstParent.length >= 6, `every rewritten site must read HEAD^1, found ${usingFirstParent.length}`);
});
