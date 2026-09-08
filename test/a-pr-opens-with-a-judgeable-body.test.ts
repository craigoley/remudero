import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ghPrCreateFillCommand } from "../src/run-task.js";
import { bodyNeedsAcceptanceRepair } from "../src/lib/plan-pr-emitter.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * test/a-pr-opens-with-a-judgeable-body.test.ts — W1-T3066.
 *
 * `fillDerivedBody` derives a PR body from the commit, and a commit carries no Acceptance block, so
 * every PR opened through this seam reached `acceptance-author-gate` with nothing to judge and
 * failed closed. MEASURED 2026-09-07: six PRs (#4447, #4449, #4461, #4465, #4471, #4472) each paid a
 * full CI cycle for it before being repaired. The repair already existed — it just ran after the red.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A real repo with `origin/main` seeded — never a mock of git's own output. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-open-body-`));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed");
  git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "HEAD").trim());
  return dir;
}

function commit(dir: string, subject: string, body?: string): void {
  writeFileSync(join(dir, `f${Date.now()}.txt`), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", body ? `${subject}\n\n${body}` : subject);
}

/** The `body=` value the REST create call would actually send. */
function bodyOf(dir: string): string {
  // The builder refuses a live write under the test runner by design; this is the same opt-in
  // every other test of this seam uses, and it wraps ONLY the argv construction — nothing spawns.
  const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "o", "r", "run-W1-T1-1", "feat(x): a subject"));
  const at = built.args.findIndex((a) => a.startsWith("body="));
  assert.notEqual(at, -1, "the create argv must carry a body");
  return built.args[at].slice("body=".length);
}

test("a commit-derived body opens the PR with a block the gate can judge, not with nothing", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "A perfectly ordinary commit message. It carries no Acceptance block,\nbecause commit messages do not.");
  const body = bodyOf(dir);
  assert.equal(
    bodyNeedsAcceptanceRepair(body),
    false,
    `the opened PR must already parse judgeably; got:\n${body}`,
  );
  // The renderer emits the BARE `Acceptance:` header, which is one of the two shapes
  // ACCEPTANCE_HEADER_RE accepts — asserting the `##` spelling would pin a format the parser
  // never required and redden on a cosmetic change.
  assert.match(body, /^\s*#{0,6}\s*Acceptance\b/mi, "a judgeable body carries a header the parser resolves");
});

test("the auto-authored block says WHEN it was authored, and does not borrow the fix rung's story", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no block here");
  const body = bodyOf(dir);
  assert.match(body, /auto-authored when the PR was opened/, "it must say what actually happened");
  assert.doesNotMatch(
    body,
    /after acceptance-author-gate refused it/,
    "the gate has refused nothing at open time — a body that misreports its own provenance is the defect, not the fix",
  );
});

test("the block never claims the diff is correct — it claims only that the body parses", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no block here");
  assert.match(
    bodyOf(dir),
    /not a claim that the underlying diff is correct/,
    "an auto-authored criterion that implied review had happened would be worse than no block at all",
  );
});

test("a body that ALREADY parses judgeably is passed through untouched", () => {
  const dir = fixture();
  const authored = [
    "## Acceptance",
    "- the sweep reads the legacy prefix | grep: LEGACY in src/lib/tmp.ts",
  ].join("\n");
  commit(dir, "feat(x): a subject", authored);
  const body = bodyOf(dir);
  assert.match(body, /grep: LEGACY in src\/lib\/tmp\.ts/, "the author's own criterion must survive");
  assert.doesNotMatch(body, /auto-authored when the PR was opened/, "a healthy block must not be supplemented");
  assert.equal((body.match(/^\s*#{0,6}\s*Acceptance\b/gim) ?? []).length, 1, "exactly one Acceptance block");
});

test("an author's RECOVERABLE criteria beat the generic fallback rather than being discarded", () => {
  const dir = fixture();
  // A block defective in the way this repo keeps producing: an em dash where a pipe belongs, so the
  // bullet parses with NO proof. The claim is still real and must not be thrown away for boilerplate.
  commit(dir, "feat(x): a subject", ["## Acceptance", "- the reaper withholds an active branch — grep: withhold in src/lib/branch-reaper.ts"].join("\n"));
  const body = bodyOf(dir);
  assert.equal(bodyNeedsAcceptanceRepair(body), false, "the repaired body must parse");
  assert.match(body, /the reaper withholds an active branch/, "the author's own claim must be carried into the repair");
});
