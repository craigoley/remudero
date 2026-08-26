import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { diffEmptyAgainstScope } from "../src/lib/review.js";
import { triageDeclaredScope, triageEmptyScopeDisposition } from "../src/lib/triage.js";
import { setFeedbackStatus } from "../src/lib/feedback.js";
import { triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── W1-T963: THE EMPTY-DIFF-TRIAGE-MERGE INCIDENT ────────────────────────────────────────────────
//
// Three triage PRs for the SAME feedback entry (#2075/#2077/#2078) merged and PASSED REVIEW
// despite changing nothing: `bodyContradictsDiff` (lib/review.js) is vacuously satisfied when
// there is no diff to contradict, and nothing else downstream ever asks "is this PR's diff empty
// against its own declared scope". `diffEmptyAgainstScope` + `triageEmptyScopeDisposition` are the
// fix — a purely structural check with no report/prose involved, wired ahead of the ordinary
// review/arm gate in run-task.ts's `triageCommandLocked` (right after CI goes green, against a
// FRESH `git diff --name-only origin/main HEAD -- <scope>` read, never the PR's own frozen
// `gh pr diff`).
//
// "A refusal test alone proves nothing… An implementation that refuses EVERY PR satisfies 'an
// empty-diff PR is refused' perfectly." (design note (vi)) — so EVERY test below carries its own
// positive AND negative control in the SAME test body, never relying on a sibling test to supply
// the other direction.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPE = ["plan/feedback/fb-1787140000000-abcdef.yaml"];

test("W1-T963: an empty-diff PR is refused", () => {
  // The empty case: the LIVE diff (against origin/main, fetched fresh) touches NONE of this PR's
  // declared scope — a sibling already landed the same change. Must be refused.
  assert.equal(diffEmptyAgainstScope([], SCOPE), true, "an empty diff list must be refused");
  assert.equal(diffEmptyAgainstScope(["plan/feedback/some-other-entry.yaml"], SCOPE), true, "a diff touching only UNRELATED paths must be refused");

  // The control, in the SAME test: a diff that DOES touch the declared scope must NOT be refused
  // — otherwise this "refuses empty diffs" claim is satisfied by an implementation that refuses
  // everything, which is exactly the trap design note (vi) warns about.
  assert.equal(diffEmptyAgainstScope(SCOPE, SCOPE), false, "a diff touching the declared scope must NOT be refused");
});

test("W1-T963: a non-empty diff still passes in the same run", () => {
  // The positive control: a real diff against the declared scope passes.
  assert.equal(diffEmptyAgainstScope(SCOPE, SCOPE), false);
  assert.equal(
    diffEmptyAgainstScope([...SCOPE, "plan/feedback/an-unrelated-entry.yaml"], SCOPE),
    false,
    "extra, unrelated touched files must not spoil a real touch of the declared scope",
  );

  // Its own refusal, in the SAME run: an implementation that always answers "not empty" would
  // pass this test vacuously without ever refusing anything — assert the refusal case too.
  assert.equal(diffEmptyAgainstScope([], SCOPE), true, "an empty diff must still be refused in this same run");

  // No declared scope at all ⇒ nothing to check ⇒ never a false refusal (an ordinary PR with no
  // declared scope must never be caught by this mechanism).
  assert.equal(diffEmptyAgainstScope([], []), false, "an undeclared scope must never manufacture a refusal");
});

test("W1-T963: an already-done triage PR is closed not merged", () => {
  const feedbackId = "fb-1787140000000-abcdef";
  const scope = triageDeclaredScope(feedbackId);
  assert.deepEqual(scope, [`plan/feedback/${feedbackId}.yaml`], "sanity: the declared scope is the feedback entry itself");

  // ALREADY DONE — the live diff against origin/main touches none of the declared scope (a
  // sibling triage PR already landed this exact change): the disposition must be CLOSE, never
  // "proceed to the ordinary review/arm gate" — merging an empty PR credits work twice and
  // pollutes history (rationale (4)); leaving it open forever is not a terminal outcome either
  // (design (v)).
  const alreadyDone = triageEmptyScopeDisposition([], scope);
  assert.equal(alreadyDone.action, "close", "already-done work must be CLOSED, not left open or merged");
  assert.ok(alreadyDone.comment && alreadyDone.comment.length > 0, "a close disposition must carry a comment explaining why");
  assert.ok(alreadyDone.comment!.includes(scope[0]!), "the close comment must name the declared scope path");

  // GENUINELY NEW WORK, in the SAME run: the live diff DOES touch the declared scope (this PR
  // itself is the one that flipped it — no sibling raced ahead) — must PROCEED to the ordinary
  // merge gate, never be closed. Without this control, "closes already-done work" would be
  // satisfied by a disposition that closes every triage PR unconditionally.
  const genuinelyNew = triageEmptyScopeDisposition(scope, scope);
  assert.equal(genuinelyNew.action, "proceed", "genuinely new work must PROCEED to the ordinary review/arm gate");
  assert.equal(genuinelyNew.comment, undefined, "a proceed disposition carries no close comment");
});

// ── END TO END: the race REPRODUCED, not merely described ──────────────────────────────────────
//
// #2075/#2077/#2078 merged and PASSED REVIEW despite changing nothing: a SIBLING triage PR for
// the SAME feedback entry landed the identical fix on `origin/main` in the gap between this PR's
// own branch forking (from the pre-flip state) and its CI going green, and nothing before this
// task ever re-checked the LIVE default branch at that later point — `gh pr diff`/
// `nonPlanFilesInDiff` compare against this branch's OWN (frozen, fork-point) merge-base and never
// see it.
//
// Drives the REAL `triageCommand` end to end (the SAME harness shape as test/triage.test.ts's own
// W1-T348 tests): a bare origin seeded at `status: new`, a SEPARATE sibling clone holding a
// READY-TO-PUSH commit that flips the SAME entry to `status: rejected`, and a `gh` shim that
// pushes the sibling's commit to the bare origin AT THE EXACT MOMENT `waitForCiGreen` polls —
// reproducing the race rather than merely describing it. This run's OWN worktree still forks from
// the pre-flip state (its own commit must be REAL work, or `git commit` below has nothing to
// stage and throws before ever reaching the code this test proves).

const T963_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function t963FakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T963-SESSION",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

test("W1-T963: end-to-end — a sibling's landed fix closes an already-done triage PR, never merges it", async () => {
  const feedbackId = `fb-t963-${Date.now()}`;

  const bare = mkdtempSync(join(tmpdir(), "t963-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: T963_GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t963-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: T963_GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join(
      "\n",
    ),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [
      `id: ${feedbackId}`,
      "ts: '2026-08-17T00:00:00.000Z'",
      "raw: fixture entry for the W1-T963 empty-diff-triage-merge race",
      "attachments: []",
      "origin: cli",
      "status: new",
      "proposal_pr: null",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: T963_GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: T963_GIT_ENV });

  // THE SIBLING: a SEPARATE clone holding one commit, ready to push, that flips the SAME entry to
  // `status: rejected` — withheld until the shim triggers it below. Written via the REAL
  // `setFeedbackStatus` (never a hand-typed fixture): this run's OWN worktree writes its status
  // flip the SAME way, and the empty-diff check this test proves is BYTE-level (`git diff`), so
  // anything less than byte-identical serialization would manufacture a spurious non-empty diff
  // that has nothing to do with the defect under test.
  const siblingDir = mkdtempSync(join(tmpdir(), "t963-sibling-"));
  execFileSync("git", ["clone", "--quiet", bare, siblingDir], { encoding: "utf8", env: T963_GIT_ENV });
  setFeedbackStatus(siblingDir, feedbackId, "rejected");
  execFileSync("git", ["-C", siblingDir, "commit", "-am", "chore(triage): sibling PR flips the feedback entry to rejected"], {
    encoding: "utf8",
    env: T963_GIT_ENV,
  });
  rmSync(seed, { recursive: true, force: true });

  const home = mkdtempSync(join(tmpdir(), "t963-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t963-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t963-ghshim-"));
  const argvLog = join(shimDir, "argv.txt");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T963_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view --json
    // statusCheckRollup`. The single-PR read (`repos/…/pulls/…`) is `waitForCiGreen`'s OWN
    // poll — the shim pushes the sibling's READY commit to the bare origin right THERE,
    // reproducing the exact window the incident PRs raced in: this run's branch has already
    // forked (pre-flip) and its own commit already pushed, but `origin/main` only advances to
    // the SAME post-flip state while THIS run is waiting on CI.
    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        // W1-T1202: `pr create` (GraphQL) moved to `gh api --method POST repos/.../pulls`
        // (REST) — the url now comes back as `html_url` in a JSON response.
        '  *"api --method POST"*) echo \'{"html_url":"https://github.com/craigoley/remudero/pull/998","number":998}\' ;;',
        `  *"--json headRefName"*) git -C ${JSON.stringify(bare)} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        '  *"/check-runs"*) echo \'{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\' ;;',
        '  *"/commits/"*"/status"*) echo \'{"statuses":[]}\' ;;',
        `  *"api repos/"*"/pulls/"*) git -C ${JSON.stringify(siblingDir)} push --quiet origin main; echo '{"number":998,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}' ;;`,
        '  *"pr close"*) exit 0 ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    const workerOutputText = [
      "GROUND: grepped plan/feedback and MASTER-PLAN.md — this exact alert class is already dispositioned.",
      "ALREADY_DECIDED: plan/alert-policy.yaml act_severities — this class is already rejected, no task needed",
    ].join("\n");

    let resolved: number | undefined;
    let rejected: unknown;
    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async () => t963FakeWorker(workerOutputText),
      }),
    ).then(
      (code) => (resolved = code),
      (e) => (rejected = e),
    );

    const argv = readFileSync(argvLog, "utf8");
    assert.equal(rejected, undefined, `triageCommand must not throw (threw: ${String(rejected)}); argv log:\n${argv}`);
    assert.equal(resolved, 0, `an already-done triage PR must resolve success (0), not an error code; argv log:\n${argv}`);
    assert.match(
      argv,
      /pr close https:\/\/github\.com\/craigoley\/remudero\/pull\/998 --comment/,
      "the PR must be CLOSED via `gh pr close`",
    );
    assert.match(argv, /a sibling triage PR already landed this/, "the close comment must name WHY (W1-T963)");
    assert.match(argv, new RegExp(`plan/feedback/${feedbackId}\\.yaml`), "the close comment must name the declared scope path");

    // NEVER MERGED: `reviewCommand`/`armAndLogOutcome` are only reached AFTER the `if` this task
    // adds `return`s from (see run-task.ts's `triageCommandLocked`) — so CI is polled exactly
    // ONCE. A second poll would mean the close path fell through to a real re-review/arm attempt.
    // W1-T2268: one `waitForCiGreen` iteration is now THREE REST reads (the PR row, then the
    // composed rollup's own check-runs + combined-status) rather than one GraphQL call — count
    // the check-runs read specifically, the one call unique to a single iteration.
    const rollupPolls = argv.split("\n").filter((l) => l.includes("/check-runs")).length;
    assert.equal(rollupPolls, 1, `CI must be polled exactly once, not fall through to a real review/arm; argv log:\n${argv}`);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, siblingDir, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});
