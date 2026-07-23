import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { captureFeedback, feedbackEntryPath, readFeedbackEntry } from "../src/lib/feedback.js";
import { LANDING_BRANCH, LANDING_PR_TITLE, findPendingLandingPr, landFeedback } from "../src/lib/feedback-landing.js";
import { missingFeedbackMessage } from "../src/lib/triage.js";

// commitlint (W1-T136 class) — same subprocess pattern as test/orientation.test.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const COMMITLINT_CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", COMMITLINT_CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

// W1-T243 — THE DURABLE-INBOX COMMIT BRIDGE. `captureFeedback()` used to be a pure filesystem
// write with no path onto `origin/main`, so `rmd triage` (which deliberately reads from a FRESH
// origin/main worktree, never a possibly-stale repoRoot) exited 2 "no such feedback entry" for
// every real capture until a human hand-landed it via `git add`+commit+PR (the precedent
// `chore(feedback): land ...` PRs #591/#609/#611). These tests drive the shipped bridge
// (feedback-landing.ts) against a REAL git remote (a local bare "origin", no network) end to end,
// with ONLY the `gh` CLI half faked (no real GitHub calls) — proving the git plumbing for real
// while keeping the test hermetic.

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

/** A bare "origin" remote, seeded with one commit on `main` — no network involved anywhere. */
function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A real clone of `bareOrigin` — this is the "operator checkout" `captureFeedback` writes into. */
function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      return `Creating pull request for ${LANDING_BRANCH} into main in o/r\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return "";
    }
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount };
}

// ── Acceptance claim 1: capture -> gated landing PR -> merged -> triage resolves ────────────

test("W1-T243 END-TO-END: a captured entry is invisible on origin/main until landed, then triage's OWN read mechanism resolves it after merge", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh, calls, createCount } = fakeGh("https://github.com/o/r/pull/1");

  const entry = captureFeedback(root, { raw: "the drain loop hangs on a stale lock", origin: "cli", land: { gh } });

  // The local write is durable the instant captureFeedback returns (§7B's promise, unchanged).
  assert.ok(existsSync(feedbackEntryPath(root, entry.id)));

  // FALSIFIER (the live 2026-07-22 repro this task fixes): origin/main does NOT have the entry
  // yet — it only has an open landing branch, not a merge. `rmd triage` reading a fresh
  // origin/main worktree at this point would still exit 2, exactly as observed live.
  assert.throws(() => execFileSync("git", ["--git-dir", bareOrigin, "show", `main:plan/feedback/${entry.id}.yaml`], { encoding: "utf8" }));

  // But the bridge DID land it — for real, via git plumbing — onto the shared landing branch,
  // through a gated PR (never a direct push to main): the branch exists on the remote...
  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${entry.id}.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /the drain loop hangs on a stale lock/);
  // ...and gh was asked to open exactly one PR for it (never a `git push` straight to main).
  assert.equal(createCount(), 1);
  assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "create" && c.includes(LANDING_BRANCH) && c.includes("main")));
  assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "merge"), "auto-merge is armed — GitHub does the merging, not this code");

  // Simulate the gate merging the PR (ci + remudero-review green) — a real fast-forward, since
  // the landing commit's parent IS origin/main's prior tip.
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`]);

  // NOW `rmd triage`'s OWN mechanism (a fresh worktree of origin/main, readFeedbackEntry) works —
  // proven by actually running it, not describing it.
  const freshWorktree = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-triage-read-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, freshWorktree], { encoding: "utf8", env: GIT_ENV });
  const resolved = readFeedbackEntry(freshWorktree, entry.id);
  assert.equal(resolved.id, entry.id);
  assert.equal(resolved.raw, "the drain loop hangs on a stale lock");
  assert.equal(resolved.status, "new", "landing never touches status — data-only, no triage");
});

// ── Acceptance claim 2: ONE choke point covers a caller never named in the implementation ──

test("W1-T243 CHOKE POINT: captureFeedback lands ANY caller's entry — this test calls neither rmd feedback, ops, issues-intake, nor the panel routes, and it still lands", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/2");

  // A fixture "sixth caller" — an origin shape none of the five named call sites use verbatim
  // for THIS test, proving the bridge is keyed to captureFeedback()/the inbox directory, not to
  // per-caller wiring that a new caller would have to remember to add.
  const entry = captureFeedback(root, { raw: "fixture caller feedback", origin: "alert#code-scanning-999", land: { gh } });

  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${entry.id}.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /fixture caller feedback/);
  assert.equal(createCount(), 1);
});

// ── Acceptance claim 3: capture NEVER fails when landing is unavailable ─────────────────────

test("W1-T243 OFFLINE: captureFeedback still succeeds when root isn't even a git checkout — the local write is the durable buffer", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-notgit-"));
  const entry = captureFeedback(root, { raw: "captured with no git repo at all" });
  assert.equal(entry.raw, "captured with no git repo at all");
  assert.ok(existsSync(feedbackEntryPath(root, entry.id)));
});

test("W1-T243 OFFLINE: captureFeedback still succeeds when root IS a git repo but has no origin remote", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-noorigin-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", root], { encoding: "utf8", env: GIT_ENV });
  const entry = captureFeedback(root, { raw: "captured with a repo but no origin remote configured" });
  assert.equal(entry.raw, "captured with a repo but no origin remote configured");
  assert.ok(existsSync(feedbackEntryPath(root, entry.id)));
});

test("W1-T243 OFFLINE: landFeedback pushes fine even when `gh pr create` fails (no auth/no network) — reports landed:true with the failure named, never throws", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    throw Object.assign(new Error("gh: not authenticated"), { status: 4 });
  };

  const result = landFeedback(root, { gh });
  assert.equal(result.landed, true, "the push itself already succeeded — only PR-open failed");
  assert.deepEqual(result.files, ["plan/feedback/fb-1.yaml"]);
  assert.match(result.error ?? "", /gh pr create.*failed/i);

  // And it really is pushed — a later, gh-healthy call (or a human) can pick the PR up from here.
  const onBranch = execFileSync("git", ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/fb-1.yaml`], {
    encoding: "utf8",
  });
  assert.match(onBranch, /id: fb-1/);
});

// ── landFeedback: idempotency + PR reuse (no spam) ──────────────────────────────────────────

/** Simulate the gate merging the open landing PR — fast-forwards bare `main` to the branch tip. */
function simulateMerge(bareOrigin: string): void {
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`]);
}

test("landFeedback: once its PR has merged, a later call with nothing NEW lands nothing (idempotent, no empty commit/PR)", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/3");
  const first = landFeedback(root, { gh });
  assert.equal(first.landed, true);
  assert.equal(createCount(), 1);

  simulateMerge(bareOrigin); // the gate merges — fb-1.yaml is now really on origin/main

  const second = landFeedback(root, { gh });
  assert.deepEqual(second, { landed: false, files: [] });
  assert.equal(createCount(), 1, "no spurious re-push/re-PR once the content is already on origin/main");
});

test("landFeedback: while a landing PR is still OPEN, a second batch of new files reuses the SAME PR — never opens a second one (no per-capture PR spam)", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/4");
  const first = landFeedback(root, { gh });
  assert.equal(first.landed, true);
  assert.equal(createCount(), 1);

  // No merge yet — the PR from `first` is still open. A second, unrelated new file shows up
  // (e.g. another capture on this same machine before the gate has gotten to the first PR).
  writeFileSync(join(root, "plan", "feedback", "fb-2.yaml"), "id: fb-2\nraw: y\n");
  const second = landFeedback(root, { gh });
  assert.equal(second.landed, true);
  // fb-1.yaml is STILL unlanded too (nothing merged it), so this batch rebuilds the branch with
  // both files — never a second PR for fb-2 alone.
  assert.deepEqual(second.files.sort(), ["plan/feedback/fb-1.yaml", "plan/feedback/fb-2.yaml"]);
  assert.equal(createCount(), 1, "the second batch reused the already-open PR — no second PR opened");

  // Both files are on the branch now (the branch always carries everything still unlanded).
  const tree = execFileSync("git", ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", LANDING_BRANCH], { encoding: "utf8" });
  assert.match(tree, /plan\/feedback\/fb-1\.yaml/);
  assert.match(tree, /plan\/feedback\/fb-2\.yaml/);
});

// ── findPendingLandingPr: best-effort, never throws ─────────────────────────────────────────

test("findPendingLandingPr: returns the open PR's url when gh reports one", () => {
  const gh = (args: string[]) => (args[1] === "list" ? JSON.stringify([{ url: "https://github.com/o/r/pull/9" }]) : "[]");
  assert.equal(findPendingLandingPr({ gh }), "https://github.com/o/r/pull/9");
});

test("findPendingLandingPr: gh unavailable/unauthenticated resolves to undefined, never throws", () => {
  const gh = () => {
    throw new Error("gh: command not found");
  };
  assert.equal(findPendingLandingPr({ gh }), undefined);
});

// ── Acceptance claim 4: the exit-2 message distinguishes pending-landing from genuinely unknown ──

test("missingFeedbackMessage: a genuinely unknown id keeps the original, unambiguous wording", () => {
  const msg = missingFeedbackMessage("fb-does-not-exist", { existsLocally: false });
  assert.equal(msg, "no such feedback entry: fb-does-not-exist");
});

test("missingFeedbackMessage: FALSIFIER FIXED — an id captured locally but not yet landed gets a DISTINCT message from a genuinely unknown one", () => {
  const unknown = missingFeedbackMessage("fb-x", { existsLocally: false });
  const pending = missingFeedbackMessage("fb-x", { existsLocally: true });
  assert.notEqual(unknown, pending, "before W1-T243 both cases printed the byte-identical string");
  assert.match(pending, /has not landed on origin\/main yet/);
  assert.match(pending, /durable-inbox commit bridge/);
});

test("missingFeedbackMessage: names the pending landing PR url when known", () => {
  const msg = missingFeedbackMessage("fb-x", { existsLocally: true, landingPrUrl: "https://github.com/o/r/pull/42" });
  assert.match(msg, /pending landing PR https:\/\/github\.com\/o\/r\/pull\/42/);
});

// ── The landing commit message passes the REAL commitlint CLI (W1-T136 class) ──────────────

test("landFeedback's commit header passes the REAL commitlint CLI", () => {
  const result = lint(LANDING_PR_TITLE);
  assert.equal(result.status, 0, `landing commit header must pass commitlint:\n${LANDING_PR_TITLE}\n${result.stdout}${result.stderr}`);
});

test("landFeedback's full commit message (header + body) passes the REAL commitlint CLI", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");
  const { gh } = fakeGh("https://github.com/o/r/pull/5");
  landFeedback(root, { gh });

  const message = execFileSync("git", ["--git-dir", bareOrigin, "log", "-1", "--format=%B", LANDING_BRANCH], { encoding: "utf8" });
  const result = lint(message);
  assert.equal(result.status, 0, `landing commit message must pass commitlint:\n${message}\n${result.stdout}${result.stderr}`);
});
