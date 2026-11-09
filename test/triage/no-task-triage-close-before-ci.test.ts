import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { diffEmptyAgainstScope } from "#src/lib/review.js";
import { triageDeclaredScope, triageEmptyScopeDisposition } from "#src/lib/triage.js";
import { triageCommand } from "#src/run-task.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { WorkerResult } from "#src/lib/worker.js";

import { repoRoot } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
const REPO_ROOT = repoRoot();

// ── W1-T963: THE EMPTY-DIFF-TRIAGE-MERGE INCIDENT ────────────────────────────────────────────────
//
// Three triage PRs for the SAME feedback entry (#2075/#2077/#2078) merged and PASSED REVIEW
// despite changing nothing: `bodyContradictsDiff` (lib/review.js) is vacuously satisfied when
// there is no diff to contradict, and nothing else downstream ever asks "is this PR's diff empty
// against its own declared scope". `diffEmptyAgainstScope` + `triageEmptyScopeDisposition` are the
// fix — a purely structural check with no report/prose involved, wired ahead of the ordinary
// review/arm gate in run-task.ts's triageCommandLocked. For no_task/grill empty scopes, the
// live decision now runs after provenance checks and before CI, with an exact head/base re-read
// immediately before close. The post-CI check remains to catch sibling landings during the wait;
// both use a fresh git diff --name-only origin/main HEAD -- <scope>, never the PR's frozen gh pr diff.
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

// ── END TO END: the early no-task close precedes a red CI result ─────────────────────────────────
//
// Drives the real triage command through publication and live-scope classification. The mocked
// CI response is red, but a no-task PR with an already-empty declared scope must close before the
// command asks for that response. The sibling-landing-after-CI case remains covered by the
// existing W1-T963 fixture in test/empty-diff-merge-gate.test.ts.

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

test("W1-T963: an already-done triage PR is closed not merged — W1-T11781: a no-task empty scope resolves before a red CI wait", async () => {
  const runTimestamp = Date.now();
  const feedbackId = `fb-t963-${runTimestamp}`;
  const headRef = `run-TRIAGE-${feedbackId}-${runTimestamp}`;

  const bareRepo = gitRepo({ bare: true, kind: "t11781-origin" });
  const seedRepo = gitRepo({ seedCommit: false, kind: "t11781-seed" });
  const bare = bareRepo.dir;
  const seed = seedRepo.dir;
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(join(seed, "plan", "alert-policy.yaml"), "act_severities: []\n", "utf8");
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
  seedRepo.git("add", "-A");
  seedRepo.git("commit", "--quiet", "-m", "chore: seed plan");
  seedRepo.addRemote("origin", bare);
  seedRepo.git("push", "--quiet", "origin", "main");

  seedRepo.cleanup();

  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11781-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11781-root-`));
  const identityResponse = join(home, "pr-identity.json");
  writeFileSync(identityResponse, JSON.stringify({
    number: 998, state: "open", merged: false,
    head: { sha: "" }, base: { ref: "main", sha: "" },
  }));
  const postReceive = [
    "#!/bin/sh",
    "while IFS=' ' read -r old_oid new_oid ref; do",
    `  if [ "$ref" = "refs/heads/${headRef}" ]; then`,
    `    head=$(git rev-parse "$ref") || exit 1`,
    // Simulate a sibling landing the same deterministic no-task status commit before the
    // triage PR is classified, so its declared feedback scope is empty against live main.
    `    git update-ref refs/heads/main "$new_oid" || exit 1`,
    "    base=$(git rev-parse refs/heads/main) || exit 1",
    `    printf '{"number":998,"state":"open","merged":false,"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"}}\n' "$head" "$base" > ${JSON.stringify(identityResponse)}`,
    "  fi",
    "done",
    "",
  ].join("\n");
  writeFileSync(join(bare, "hooks", "post-receive"), postReceive, { mode: 0o755 });
  const shim = ghShim([
    { when: "pr list", stdout: "[]" },
    { when: "pulls?state=open", stdout: "[]" },
    { when: "api --method POST", stdout: JSON.stringify({ html_url: "https://github.com/craigoley/remudero/pull/998", number: 998 }) },
    { when: "--json headRefName", stdout: JSON.stringify({ headRefName: headRef }) },
    { when: "--json body", stdout: JSON.stringify({ body: "" }) },
    { when: "pr diff", stdout: "" },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
    { when: "/pulls/998", stdoutFile: identityResponse },
    { when: "/commits/", stdout: JSON.stringify({ statuses: [] }) },
    { when: "pr close", stdout: "" },
  ], { kind: "t11781-gh" });
  const shimDir = shim.dir;
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }, null, 2));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: T963_GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    process.env.PATH = `${shimDir}:${savedPath}`;

    const workerOutputText = [
      "GROUND: grepped plan/feedback and MASTER-PLAN.md — this exact alert class is already dispositioned.",
      "ALREADY_DECIDED: plan/alert-policy.yaml act_severities — this class is already rejected, no task needed",
    ].join("\n");

    let resolved: number | undefined;
    let rejected: unknown;
    const originalDateNow = Date.now;
    Date.now = () => runTimestamp;
    try {
      await withLiveWritesAllowed(() =>
        triageCommand([feedbackId], {
          spawn: async () => t963FakeWorker(workerOutputText),
        }),
      ).then(
        (code) => (resolved = code),
        (e) => (rejected = e),
      );
    } finally {
      Date.now = originalDateNow;
    }

    const argv = shim.calls().join("\n");
    assert.equal(rejected, undefined, `triageCommand must not throw (threw: ${String(rejected)}); argv log:\n${argv}`);
    assert.equal(resolved, 0, `an already-done triage PR must resolve success (0), not an error code; argv log:\n${argv}`);
    assert.match(
      argv,
      /pr close https:\/\/github\.com\/craigoley\/remudero\/pull\/998 --comment/,
      "the PR must be CLOSED via `gh pr close`",
    );
    assert.match(argv, /a sibling triage PR already landed this/, "the close comment must name WHY (W1-T963)");
    assert.match(argv, new RegExp(`plan/feedback/${feedbackId}\\.yaml`), "the close comment must name the declared scope path");

    // A closed no-op must terminalize before even one CI rollup request, and it must re-read exact
    // PR identity before close.
    const rollupPolls = argv.split("\n").filter((l) => l.includes("/check-runs")).length;
    assert.equal(rollupPolls, 0, `empty-scope no_task must close before CI is polled; argv log:\n${argv}`);
    const identityReads = argv.split("\n").filter((l) => l.includes("api repos/") && l.includes("/pulls/998")).length;
    assert.ok(identityReads >= 2, `PR identity must be read before classification and immediately before close; argv log:\n${argv}`);
    const finalIdentity = JSON.parse(readFileSync(identityResponse, "utf8")) as {
      head: { sha: string };
      base: { sha: string };
    };
    assert.equal(finalIdentity.head.sha, bareRepo.git("rev-parse", `refs/heads/${headRef}`));
    assert.equal(finalIdentity.base.sha, bareRepo.git("rev-parse", "refs/heads/main"));
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
    bareRepo.cleanup();
    seedRepo.cleanup();
  }
});
