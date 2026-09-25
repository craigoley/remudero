import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acceptanceGateBodyRepair, appendTaskTrailerToCommit, ghPrCreateFillCommand } from "../src/run-task.js";
import { bodyNeedsAcceptanceRepair } from "../src/lib/plan-pr-emitter.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { openPullRequestChecked, type OpenPullRequestCheckedDeps } from "../src/lib/pr-open.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href;
const { evaluateGate } = (await import(GATE_URL)) as {
  evaluateGate: (input: { body: string; authorLogin?: string }) => { ok: boolean; defect?: string; message: string };
};

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

test("W1-T3508 open-time fallback: the rendered body passes the production author-time proof-shape gate", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no Acceptance block in this commit message");
  const result = evaluateGate({ body: bodyOf(dir), authorLogin: "a-human" });
  assert.equal(result.ok, true, result.message);
});

test("W1-T3508 fallback proof target: both fallbacks retain the single-line grep proof for acceptanceAuthorTimeCheck", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no Acceptance block in this commit message");
  const repaired = acceptanceGateBodyRepair("no Acceptance block in this live PR body");
  assert.ok(repaired, "the no-header fixture must take the fallback path");
  for (const body of [bodyOf(dir), repaired.repairedBody]) {
    assert.match(
      body,
      /grep: \^export function acceptanceAuthorTimeCheck in src\/lib\/review\.ts/,
      "both renderers must carry the same executable, single-line proof",
    );
  }
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

// ── W1-T4420 — the shared checked seam every automated opener now routes through ────────────

const BRANCH = "run-W1-T1-1";

/** `openPullRequestChecked`'s deps, bound to a fixture — `pushRunBranch` records whether it was
 *  called rather than pushing for real (the fixture has no reachable remote). */
function checkedDeps(dir: string, pushed: { count: number } = { count: 0 }): OpenPullRequestCheckedDeps {
  return {
    buildCreate: (title, bodyOverride) =>
      withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "o", "r", BRANCH, title, bodyOverride)),
    ensureTrailerOnCommit: (id) => appendTaskTrailerToCommit(dir, id),
    pushRunBranch: () => {
      pushed.count += 1;
    },
    localDiff: () => git(dir, "diff", "origin/main", "HEAD"),
  };
}

function bodyOfChecked(create: ReturnType<typeof ghPrCreateFillCommand>): string {
  const at = create.args.findIndex((a) => a.startsWith("body="));
  assert.notEqual(at, -1, "the create argv must carry a body");
  return create.args[at].slice("body=".length);
}

test("run branches receive the Remudero-Task body trailer before REST pull creation", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no Acceptance block in this commit message");
  const pushed = { count: 0 };
  const result = openPullRequestChecked("W1-T9001", checkedDeps(dir, pushed), { title: "feat(x): a subject" });
  assert.ok(result.ok, "a healthy, trailered build PR must not be refused");
  // The trailer landed on the branch's tip commit BEFORE the create argv (what a REST pull-create
  // call would actually POST) was ever read back — never only in the PR body afterward.
  const tip = git(dir, "log", "-1", "--format=%B");
  assert.match(tip, /^Remudero-Task: W1-T9001\s*$/m, "the tip commit must carry the trailer before the create argv is built");
  assert.equal(pushed.count, 1, "an amended tip must be re-pushed before the create argv is trusted");
});

test("an already-trailered commit is left alone and the create argv is still built", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "Acceptance:\n- carries a real block | grep: real in x.ts\n\nRemudero-Task: W1-T9002");
  const pushed = { count: 0 };
  const result = openPullRequestChecked("W1-T9002", checkedDeps(dir, pushed), { title: "feat(x): a subject" });
  assert.ok(result.ok);
  assert.equal(pushed.count, 0, "an already-trailered tip must not be re-amended or re-pushed");
});

test("the shared PR opener refuses a stale or plan-divergent acceptance block before POST — stale generic fallback, no diff-derived proof available", () => {
  const dir = fixture();
  // An EMPTY commit: no file changed at all, so the diff against origin/main carries no line a
  // proof could ever be derived from. `fillDerivedBody` derives nothing from the commit body
  // either, so `ghPrCreateFillCommand` installs the generic open-time fallback, whose own proof
  // predates this diff and so cannot discriminate it.
  git(dir, "commit", "--allow-empty", "-q", "-m", "chore: touch nothing");
  const result = openPullRequestChecked(undefined, checkedDeps(dir), {});
  assert.equal(result.ok, false, "a body carrying only the non-discriminating fallback must be refused before POST");
  if (!result.ok) {
    assert.match(result.refused, /discriminates nothing/, "the refusal must name why: the fallback proof cannot discriminate this diff");
  }
});

test("the shared PR opener refuses a stale or plan-divergent acceptance block before POST — plan-divergent bodyOverride", () => {
  const dir = fixture();
  // The diff below files NOTHING under plan/ at all — a bare README touch — so the bodyOverride's
  // own claimed id (W1-T9999) can never be one this diff actually files.
  commit(dir, "chore(plan): file a task");
  const bodyOverride = ["Acceptance:", "- W1-T9999 is filed as a well-formed plan task shard by this PR | grep: id: W1-T9999 in plan/tasks.d/W1-T9999-x.yaml"].join("\n");
  const result = openPullRequestChecked(undefined, checkedDeps(dir), { bodyOverride });
  assert.equal(result.ok, false, "a bodyOverride citing an id this diff's plan/ additions never file must be refused");
  if (!result.ok) {
    assert.match(result.refused, /plan-divergent/, "the refusal must name the plan-divergent defect");
  }
});

test("a bodyOverride whose cited id genuinely IS filed by this diff's plan/ additions is not refused", () => {
  const dir = fixture();
  execFileSync("mkdir", ["-p", join(dir, "plan", "tasks.d")]);
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T9999-x.yaml"), "- id: W1-T9999\n  title: x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore(plan): file W1-T9999");
  const bodyOverride = ["Acceptance:", "- W1-T9999 is filed as a well-formed plan task shard by this PR | grep: id: W1-T9999 in plan/tasks.d/W1-T9999-x.yaml"].join("\n");
  const result = openPullRequestChecked(undefined, checkedDeps(dir), { bodyOverride });
  assert.ok(result.ok, "a bodyOverride whose cited id the diff genuinely files must not be refused");
});

test("openPullRequestChecked substitutes a diff-derived proof when the diff itself can supply one", () => {
  const dir = fixture();
  writeFileSync(join(dir, "new-file.ts"), "export const marker = \"a genuinely new line\";\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat(x): a subject");
  const result = openPullRequestChecked(undefined, checkedDeps(dir), { title: "feat(x): a subject" });
  assert.ok(result.ok, "a diff that adds a groppable line must not be refused");
  if (result.ok) {
    const body = bodyOfChecked(result.create);
    assert.doesNotMatch(
      body,
      /grep: \^export function acceptanceAuthorTimeCheck in src\/lib\/review\.ts/,
      "the stale generic proof must be replaced, not left in place",
    );
    assert.match(body, /grep: .*new-file\.ts/, "the substituted proof must cite the diff's own added file");
  }
});
