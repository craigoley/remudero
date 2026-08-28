/**
 * W1-T2449 — THE OFF-MAIN REFUSAL OFFERED ONLY THE MUTATING REMEDY.
 *
 * The off-main arm of `checkCliFreshness` (the branch/DETACHED-HEAD refusal W1-T445 added) ended
 * its message `Run \`git pull --ff-only\` yourself if that is really what you want.` -- the one
 * thing a reader on a DETACHED checkout must NOT do, per the guard's own preceding sentence
 * ("fast-forwarding here would move your work's base out from under it"). `RMD_SELF_SYNC_DONE=1`
 * -- {@link SELF_SYNC_GUARD_ENV}, already the first branch `checkCliFreshness` consults, already
 * documented as the loop-guard/bypass escape -- appeared NOWHERE in that message, or in any
 * refusal message. A human at a shell (the only population that ever reaches this arm off
 * `main`/`status`/`doctor` -- see the task's rationale) was told the mutating remedy and never
 * told the read-only one that actually answers "I don't want this checkout synced."
 *
 * THIS TASK'S SCOPE IS ONE SENTENCE OF TEXT IN THE OFF-MAIN ARM ONLY:
 *   - NOT the guard predicate (`checkCliFreshness`'s branching logic) -- W1-T446's.
 *   - NOT `READ_ONLY_FRESHNESS_EXEMPT_VERBS` (`src/run-task.ts`) -- W1-T1134's, and correctly
 *     sized already; this task adds no verb to it.
 *   - NOT the dirty or diverged arms' own remedy text -- each keeps exactly what it had.
 *
 * EVERY TEST HERE DRIVES REAL GIT REPOS, same style as the sibling self-sync-*.test.ts suites --
 * a message-text change proven only against a stubbed runner would say nothing about whether the
 * guard's actual refuse/proceed decision moved.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV, type GitRunner } from "../src/lib/self-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A real origin + a real clone, the clone one commit BEHIND -- mirrors the sibling suites'
 *  own gitFixture()/behindFixture() so this test exercises real git plumbing, not a double. */
function behindFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-refusal-names-guard-env-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("newer-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "newer"]);
  return { originDir, localDir };
}

const headSha = (dir: string): string => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function spies(localDir: string) {
  const warnCalls: string[] = [];
  const gitCalls: string[][] = [];
  let reexecCalls = 0;
  const runner: GitRunner = (args) => {
    gitCalls.push(args);
    return execFileSync("git", ["-C", localDir, ...args], { encoding: "utf8" });
  };
  return {
    warnCalls,
    gitCalls,
    reexecCount: () => reexecCalls,
    deps: {
      git: runner,
      say: () => {},
      warn: (m: string) => void warnCalls.push(m),
      reexec: () => void reexecCalls++,
    },
  };
}

// ── AC1: the off-main refusal names the read-only escape AS WELL AS the mutating remedy ─────

test("the off-main refusal on a feature branch names RMD_SELF_SYNC_DONE=1 alongside git pull --ff-only", () => {
  const { localDir } = behindFixture();
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "-b", "fix/some-work"]);

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  const message = result.status === "refused" ? result.message : "";
  assert.equal(result.status === "refused" ? result.reason : undefined, "off-main");
  assert.match(
    message,
    new RegExp(`${SELF_SYNC_GUARD_ENV}=1`),
    "the read-only escape hatch must be named by its real env var, not a hardcoded/drifted spelling",
  );
  assert.match(message, /git pull --ff-only/, "the mutating remedy must still be offered, not replaced");
});

test("the off-main refusal on a DETACHED HEAD also names RMD_SELF_SYNC_DONE=1 -- the exact reader the mutating remedy was wrong for", () => {
  const { localDir } = behindFixture();
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "--detach", "HEAD"]);

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  const message = result.status === "refused" ? result.message : "";
  assert.match(message, /DETACHED HEAD/);
  assert.match(message, new RegExp(`${SELF_SYNC_GUARD_ENV}=1`));
});

// ── AC2: the escape named in the message is the SAME mechanism that actually short-circuits ──

test("the env var the off-main message now names is the one that actually guards -- setting it skips the check entirely, read-only", () => {
  const { localDir } = behindFixture();
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "-b", "fix/some-work"]);
  const before = headSha(localDir);

  const { deps, gitCalls, warnCalls } = spies(localDir);
  const result = checkCliFreshness(localDir, { [SELF_SYNC_GUARD_ENV]: "1" }, deps);

  assert.equal(result.status, "guarded");
  assert.deepEqual(gitCalls, [], "not even a fetch -- the escape the message points to is genuinely read-only");
  assert.equal(warnCalls.length, 0);
  assert.equal(headSha(localDir), before);
});

// ── AC2 (cont'd): the guard's predicate and its refusal decision are unchanged ───────────────

test("the guard's decision is unchanged -- off-main still refuses and the ref still does not move", () => {
  const { localDir } = behindFixture();
  execFileSync("git", ["-C", localDir, "checkout", "--quiet", "-b", "run-W1-T2449-checkpoint"]);
  const before = headSha(localDir);

  const { deps, reexecCount } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  assert.equal(result.status === "refused" ? result.reason : undefined, "off-main");
  assert.equal(headSha(localDir), before, "a message-text change must never let the ff-merge through");
  assert.equal(reexecCount(), 0);
});

test("the guard's decision is unchanged -- ON MAIN still fast-forwards exactly as before", () => {
  const { localDir } = behindFixture();
  const before = headSha(localDir);
  assert.equal(execFileSync("git", ["-C", localDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), "main");

  const { deps, reexecCount } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "synced", "the healthy path this module exists for must stay untouched");
  assert.notEqual(headSha(localDir), before);
  assert.equal(reexecCount(), 1);
});

// ── AC3: no verb is added to the read-only exempt set by this task ──────────────────────────

test("READ_ONLY_FRESHNESS_EXEMPT_VERBS (src/run-task.ts) is unchanged -- still exactly {doctor, status}", () => {
  const runTaskSrc = readFileSync(join(__dirname, "..", "src", "run-task.ts"), "utf8");
  const match = runTaskSrc.match(
    /READ_ONLY_FRESHNESS_EXEMPT_VERBS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([^\]]*)\]\)/,
  );
  assert.ok(match, "the exempt-set declaration must still exist, unrenamed, in src/run-task.ts");
  const verbs = (match?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  assert.deepEqual(
    verbs.sort(),
    ["doctor", "status"],
    "this task widens no verb into the exempt set -- that axis is W1-T1134's, untouched here",
  );
});

// ── AC4: the dirty and diverged arms keep their own remedies unchanged ──────────────────────

test("the DIRTY refusal's remedy text is untouched -- no mention of the guard env, same git pull --ff-only guidance", () => {
  const { originDir, localDir } = behindFixture();
  // Uncommitted local edit on the same path origin just published -- a real dirty-and-conflicting tree.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("DIRTY-LOCAL"), "utf8");
  void originDir;

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  const message = result.status === "refused" ? result.message : "";
  assert.equal(result.status === "refused" ? result.reason : undefined, "dirty");
  assert.match(message, /git pull --ff-only/);
  assert.doesNotMatch(
    message,
    new RegExp(SELF_SYNC_GUARD_ENV),
    "the dirty arm is explicitly out of this task's scope -- it must not have gained the env mention",
  );
});

test("the DIVERGED refusal's remedy text is untouched -- no mention of the guard env, same git pull --ff-only guidance", () => {
  const { originDir, localDir } = behindFixture();
  // Local makes its OWN unpublished commit on top of the already-published origin commit --
  // clean tree, but HEAD is no longer an ancestor of origin/main: a real non-ff divergence.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("LOCAL-ONLY-COMMIT"), "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "local work"]);
  void originDir;

  const { deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  const message = result.status === "refused" ? result.message : "";
  assert.equal(result.status === "refused" ? result.reason : undefined, "diverged");
  assert.match(message, /git pull --ff-only/);
  assert.doesNotMatch(
    message,
    new RegExp(SELF_SYNC_GUARD_ENV),
    "the diverged arm is explicitly out of this task's scope -- it must not have gained the env mention",
  );
});
