import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T351: commitlint must read the PR title LIVE, not the opened-event payload snapshot ──
//
// `.github/workflows/ci.yml`'s commitlint job used to feed `github.event.pull_request.title`
// straight into commitlint. That expression is a SNAPSHOT of the webhook payload captured at
// `opened`/`synchronize`/`reopened` (the workflow has no `types:` override, so `edited` is
// excluded) -- a title corrected after `opened` was invisible to the linter, and re-running the
// job replayed the identical stale payload (PRs #1249, #1312: clean locally, failed in CI with
// BOTH "subject may not be empty" and "type may not be empty" together -- the signature of an
// empty string reaching the linter). The only thing that cleared it was a push.
//
// The fix relocates the read to job time via `gh pr view --json title`, and treats an empty read
// (API/auth failure) as a distinct failure mode from a non-conventional title, surfaced BEFORE
// commitlint ever sees the string. This suite proves both halves: (1) statically, that the job
// is wired to the live read and no longer trusts the event payload; (2) behaviorally, by
// extracting the job's actual run script from ci.yml and executing it against a stubbed `gh`
// binary for three scenarios -- a corrected/live title, an empty read, and a non-conventional
// title -- to prove the distinction is real, not just described.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function loadCommitlintStep() {
  const ciYmlText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const doc = parseYaml(ciYmlText);
  const job = doc.jobs.commitlint;
  assert.ok(job, "ci.yml must declare a commitlint job");
  const step = job.steps.find((s: any) => typeof s.name === "string" && /commitlint/i.test(s.name) && s.run);
  assert.ok(step, "commitlint job must have a step running commitlint");
  return { job, step, ciYmlText };
}

// ── Static wiring: the live read replaces the stale event-payload snapshot ──

test("commitlint CI wiring: the title is read live via `gh pr view --json title`, not the opened-event payload", () => {
  const { step } = loadCommitlintStep();
  assert.match(
    step.run,
    /gh pr view .*--json title/,
    "the commitlint step must query the PR title live via `gh pr view --json title`",
  );
  assert.doesNotMatch(
    JSON.stringify(step.env ?? {}),
    /github\.event\.pull_request\.title/,
    "the step must not feed the linted title from the opened-event payload snapshot anymore",
  );
});

test("commitlint CI wiring: the job grants pull-requests: read so `gh pr view` can authenticate", () => {
  const { job } = loadCommitlintStep();
  assert.equal(
    job.permissions?.["pull-requests"],
    "read",
    "the commitlint job needs pull-requests: read for `gh pr view` to succeed against a private-by-default GITHUB_TOKEN",
  );
});

test("commitlint CI wiring: an empty read is checked and reported BEFORE the string ever reaches commitlint", () => {
  const { step } = loadCommitlintStep();
  const emptyCheckIdx = step.run.search(/-z\s+"?\$PR_TITLE"?/);
  const commitlintCallIdx = step.run.search(/npx commitlint/);
  assert.notEqual(emptyCheckIdx, -1, "the script must check whether the live-read title came back empty");
  assert.notEqual(commitlintCallIdx, -1, "the script must still invoke commitlint on a non-empty title");
  assert.ok(
    emptyCheckIdx < commitlintCallIdx,
    "the empty-title check must run before commitlint is invoked, so an empty read never reaches the linter as a blank string",
  );
  assert.match(
    step.run,
    /exit 1/,
    "the empty-title branch must fail the job (not silently continue)",
  );
});

// ── Behavioral: drive the ACTUAL extracted run script against a stubbed `gh` ──

function runCommitlintScript(runScript: string, stubbedGhTitle: string | null) {
  const workdir = mkdtempSync(join(tmpdir(), "ci-title-lint-"));
  try {
    // A stub `gh` on PATH ahead of the real one: `gh pr view <n> --repo <r> --json title --jq .title`
    // prints the scenario's title (or nothing, for the empty-read scenario) and exits 0 -- it
    // never fails the gh CALL itself, only the CONTENT differs, matching what an empty API read
    // looks like in practice (a successful call, empty field) as opposed to a call error.
    const ghStub = join(workdir, "gh");
    writeFileSync(
      ghStub,
      `#!/bin/sh\n${stubbedGhTitle === null ? 'printf ""' : `printf '%s' ${JSON.stringify(stubbedGhTitle)}`}\n`,
    );
    chmodSync(ghStub, 0o755);

    const scriptPath = join(workdir, "run.sh");
    writeFileSync(scriptPath, `#!/bin/sh\nset -e\n${runScript}\n`);
    chmodSync(scriptPath, 0o755);

    const result = spawnSync("sh", [scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${workdir}:${process.env.PATH}`,
        PR_NUMBER: "1234",
        GITHUB_REPOSITORY: "craigoley/remudero",
        GH_TOKEN: "stub-token",
      },
      encoding: "utf8",
    });
    return result;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("commitlint script: a valid, live title (as if corrected after `opened`) is linted and PASSES", () => {
  const { step } = loadCommitlintStep();
  const result = runCommitlintScript(step.run, "fix(ci): read the PR title live via gh pr view (W1-T351)");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /empty (title|read)/i,
    "a real title must not trigger the empty-read branch",
  );
});

test("commitlint script: an EMPTY live read fails distinctly from a non-conventional title, and never reaches commitlint", () => {
  const { step } = loadCommitlintStep();
  const result = runCommitlintScript(step.run, null);
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /empty/i, "an empty read must be reported as an empty read");
  assert.doesNotMatch(
    output,
    /subject may not be empty/,
    "an empty read must be caught before reaching commitlint -- it must not surface commitlint's own per-rule messages",
  );
  assert.doesNotMatch(
    output,
    /type may not be empty/,
    "an empty read must be caught before reaching commitlint -- it must not surface commitlint's own per-rule messages",
  );
});

test("commitlint script: a non-conventional but non-empty title still FAILS -- via commitlint itself, not the empty-read branch", () => {
  const { step } = loadCommitlintStep();
  const result = runCommitlintScript(step.run, "this title has no conventional-commit type prefix");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.doesNotMatch(
    output,
    /empty (title|read)/i,
    "a non-conventional, non-empty title must fail via commitlint's own rules, not be misreported as an empty read",
  );
  assert.match(
    output,
    /type may not be empty/,
    "commitlint itself must be the one rejecting a title with no recognized type",
  );
});
