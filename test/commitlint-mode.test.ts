import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T129: commitlint lints the ARTIFACT THAT PERSISTS ────────────────────
//
// This repo squash-merges every PR. #220 (W1-T31) wired `commitlint` to lint the base..head
// BRANCH-COMMIT range, but branch commits never reach main under a squash merge -- only the
// squash commit does, and (per this repo's `squash_merge_commit_title: COMMIT_OR_PR_TITLE`
// setting, and the plain `gh pr merge --squash` call sites in src/run-task.ts / src/lib/worker.ts
// that pass no `--subject` override) that squash commit's subject defaults to the PR TITLE for
// any multi-commit PR. The old wiring therefore failed PRs over commits that would never exist
// post-merge (#234/#238/#251 each had to be collapsed to one conventional commit -- a
// message-only rewrite that changed nothing but the gate's verdict) while leaving the artifact
// that actually lands on main -- the PR title -- completely unchecked.
//
// This suite proves the relocation two ways: (1) reading .github/workflows/ci.yml to show the
// `commitlint` job now feeds the PR title, not a git commit range, into the same commitlint CLI
// + config that test/commitlint-config.test.ts already proves is ACTIVE; and (2) driving that
// real CLI against fixture titles/commit messages to prove the accept/reject behavior actually
// relocated rather than merely being described as relocated.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

async function commitlintJobBody(): Promise<string> {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("\n  commitlint:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a commitlint job");
  const nextJobStart = ciYml.indexOf("\n  leak-grep:", jobStart);
  assert.notEqual(nextJobStart, -1, "commitlint job body must be findable in ci.yml (bounded by the next job)");
  return ciYml.slice(jobStart, nextJobStart);
}

// ── CI wiring: the linted object is now the PR title, not the branch-commit range ──

test("commitlint CI wiring: the job lints github.event.pull_request.title, not a base..head commit range", async () => {
  const jobBody = await commitlintJobBody();
  assert.match(
    jobBody,
    /PR_TITLE:\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/,
    "the commitlint job must feed the PR title into the linter",
  );
  assert.doesNotMatch(
    jobBody,
    /--from\b/,
    "the job must no longer lint a base..head commit range -- branch commits must not gate the PR",
  );
  assert.doesNotMatch(
    jobBody,
    /pull_request\.base\.sha/,
    "the job must no longer reference the base sha -- that was the base..head range's other half",
  );
});

test("commitlint CI wiring: the job still runs commitlint against this repo's own commitlint.config.mjs", async () => {
  const jobBody = await commitlintJobBody();
  assert.match(
    jobBody,
    /commitlint --config commitlint\.config\.mjs/,
    "relocating the linted object must not relax which config governs it",
  );
});

test("commitlint CI wiring: the checkout no longer requests full git history -- title-only linting needs no commit log", async () => {
  const jobBody = await commitlintJobBody();
  assert.doesNotMatch(
    jobBody,
    /fetch-depth:\s*0/,
    "fetch-depth: 0 existed only to walk the base..head commit range; title-only linting needs no history",
  );
});

test("commitlint CI wiring: no gh pr merge --squash call site overrides --subject away from the PR title", async () => {
  const runTaskTs = await readFile(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const workerTs = await readFile(join(REPO_ROOT, "src", "lib", "worker.ts"), "utf8");
  for (const [name, src] of [
    ["src/run-task.ts", runTaskTs],
    ["src/lib/worker.ts", workerTs],
  ] as const) {
    const squashCalls = src.match(/execFileSync\("gh",\s*\[[^\]]*"--squash"[^\]]*\]/g) ?? [];
    assert.ok(squashCalls.length > 0, `${name} must call gh pr merge --squash somewhere`);
    for (const call of squashCalls) {
      assert.doesNotMatch(
        call,
        /--subject/,
        `${name}: a --subject override would substitute something other than the linted PR title as ` +
          `the squash commit subject, breaking the "linted object == artifact that persists" guarantee: ${call}`,
      );
    }
  }
});

// ── CLI behavior: a conventional TITLE passes regardless of non-conventional branch commits ──

// Representative of the #234/#238 collapse class (MASTER-PLAN#6A / W1-T129 rationale): real
// pre-gate worker commit messages, verbatim from plan/tasks.yaml's W1-T129 rationale, which are
// NOT Conventional Commits. Under the OLD base..head wiring these blocked the merge outright;
// under the relocated wiring they are simply never fed to the linter.
const NON_CONVENTIONAL_BRANCH_COMMITS = [
  "KNOWLEDGE BUDGET AS A CI RATCHET - active learnings corpus size is capped (W1-T38)",
  "COMMITLINT LINTS THE ARTIFACT THAT PERSISTS - the repo squash-merges everything (W1-T129)",
];

test("commitlint gate: representative pre-gate branch-commit messages FAIL if linted directly (the cost the old wiring imposed)", () => {
  for (const message of NON_CONVENTIONAL_BRANCH_COMMITS) {
    const result = lint(`${message}\n`);
    assert.notEqual(result.status, 0, `expected the gate to reject: ${message}`);
  }
});

test("commitlint gate: a PR with those non-conventional branch commits but a conventional TITLE now PASSES", () => {
  // The relocated gate never sees NON_CONVENTIONAL_BRANCH_COMMITS at all (proved by the CI-wiring
  // tests above) -- it sees only this title. Both facts together are the acceptance claim: a
  // branch whose commits are non-conventional merges cleanly as long as its title is.
  const title = "fix(ci): lint the PR title instead of every branch commit (W1-T129)\n";
  const result = lint(title);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("commitlint gate: a non-conventional TITLE still FAILS -- the falsifier proving the standard was relocated, not removed", () => {
  const badTitles = [
    "Add fuzzy search to the board",
    "COMMITLINT LINTS THE ARTIFACT THAT PERSISTS",
    "wibble: made up type",
  ];
  for (const title of badTitles) {
    const result = lint(`${title}\n`);
    assert.notEqual(result.status, 0, `expected the gate to reject title: ${title}`);
  }
});

test("commitlint gate: the #234/#238 collapse fixture merges WITHOUT history rewriting -- multiple non-conventional commits, one conventional title", () => {
  // Simulates the exact #234/#238 shape: several non-conventional branch commits (never
  // individually rewritten) landing under one conventional PR title. Every branch commit fails
  // on its own (proving a rewrite would still have been needed under the old base..head wiring);
  // the title alone is what the relocated gate actually evaluates, and it passes.
  for (const message of NON_CONVENTIONAL_BRANCH_COMMITS) {
    assert.notEqual(lint(`${message}\n`).status, 0, `branch commit must still fail if linted directly: ${message}`);
  }
  const collapseTitle = "chore(plan): file the #234/#238 collapse regression fixture (W1-T129)\n";
  assert.equal(lint(collapseTitle).status, 0, lint(collapseTitle).stdout + lint(collapseTitle).stderr);
});
