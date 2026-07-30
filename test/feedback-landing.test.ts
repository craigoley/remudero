import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { captureFeedback, feedbackEntryPath, readFeedbackEntry, setFeedbackStatus } from "../src/lib/feedback.js";
import {
  DECISIONS_LANDING_BRANCH,
  DECISIONS_LANDING_PR_TITLE,
  LANDING_BRANCH,
  LANDING_PR_TITLE,
  decisionRecordContent,
  decisionRecordRelPath,
  findPendingLandingPr,
  landFeedback,
  recordDecision,
} from "../src/lib/feedback-landing.js";
import { checkCliFreshness } from "../src/lib/self-sync.js";
import { missingFeedbackMessage } from "../src/lib/triage.js";
import { triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── Why every landFeedback()/captureFeedback({land}) call below is wrapped ──────────────
// This whole suite exercises the durable-inbox commit bridge, which commits and PUSHES for
// real. It does so entirely offline, against a `git init --quiet --bare` origin created in
// TMPDIR by this file's own fixture, with an injected fake `gh`; nothing reaches the live
// repo. The live-write guard cannot see that, because it checks the CALL, not the
// DESTINATION — so each such call is exempted individually, at the call site, rather than
// by any file- or env-level switch. The two `captureFeedback()` calls that deliberately have
// NO repo / NO origin are left unwrapped: they never reach the boundary, and leaving them
// bare keeps the guard live on them.
//
// NOTE for anyone re-measuring this: `landFeedback` is best-effort and SWALLOWS the guard's
// throw, so before this change the failures here surfaced downstream as
// `fatal: invalid object name 'feedback-landing'` and reported ZERO `LiveWriteBlockedError`.
// Counting this defect by grepping for the error name undercounts it.

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

  const entry = withLiveWritesAllowed(() => captureFeedback(root, { raw: "the drain loop hangs on a stale lock", origin: "cli", land: { gh } }));

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
  // The FIVE real captureFeedback() call sites this bridge must cover, by construction, at ONE
  // choke point — never per-caller wiring: (1) cli — run-task.ts's feedbackCommand (`rmd
  // feedback`); (2) panel ui — panel-graph.ts's POST /v1/feedback route; (3) ops alerts —
  // ops.ts's pollAlerts(); (4) issues intake — issues-intake.ts's pollIssues(); (5) panel grill —
  // panel-skill-run.ts's clarify skill route. This test deliberately calls NONE of those five
  // wrapper functions — it calls captureFeedback() directly, as a "fixture caller not named in
  // the implementation" would — proving the landing mechanism keys off the inbox
  // directory/capture primitive itself (feedback.ts's plan/feedback/, via captureFeedback()),
  // not off per-caller wiring a sixth real caller would otherwise have to remember to add.
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/2");

  // A fixture "sixth caller" — an origin shape none of the five named call sites use verbatim
  // for THIS test, proving the bridge is keyed to captureFeedback()/the inbox directory, not to
  // per-caller wiring that a new caller would have to remember to add.
  const entry = withLiveWritesAllowed(() => captureFeedback(root, { raw: "fixture caller feedback", origin: "alert#code-scanning-999", land: { gh } }));

  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${entry.id}.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /fixture caller feedback/);
  assert.equal(createCount(), 1, "landed WITHOUT any of cli/panel-ui/ops-alerts/issues-intake/panel-grill being called in this test");
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

test("W1-T243 STRANDED-ENTRY SWEEP: captureFeedback with the landing path STUBBED TO FAIL still writes the entry and returns success — a LATER bridge pass picks the stranded entry up", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);

  // Stub the git half of THIS capture's landing attempt to fail outright (simulating offline,
  // no origin reachable, whatever) — captureFeedback must still write the entry and RETURN
  // SUCCESS regardless.
  const failingGit = (): string => {
    throw new Error("simulated network failure — git fetch origin unreachable");
  };
  const entry = withLiveWritesAllowed(() =>
    captureFeedback(root, {
      raw: "stranded while offline, must not be lost",
      land: { git: failingGit },
    }),
  );
  assert.equal(entry.raw, "stranded while offline, must not be lost", "captureFeedback still returns success");
  assert.ok(
    existsSync(feedbackEntryPath(root, entry.id)),
    "the local write is the durable buffer — it happened despite the stubbed landing failure",
  );

  // Confirm the entry really is STRANDED right now (nothing pushed) — the falsifier this
  // failure-path must not silently paper over.
  assert.throws(() =>
    execFileSync("git", ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${entry.id}.yaml`], { encoding: "utf8" }),
  );

  // A LATER bridge pass — e.g. the NEXT real capture on this machine, or a future manual sweep —
  // this time with a real, un-stubbed git, picks the stranded entry up and lands it. Nothing
  // about this entry was dropped; it was only ever DEFERRED.
  const { gh } = fakeGh("https://github.com/o/r/pull/99");
  const laterPass = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(laterPass.landed, true, "the later bridge pass lands the previously-stranded entry");
  assert.deepEqual(laterPass.files, [`plan/feedback/${entry.id}.yaml`]);

  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${entry.id}.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /stranded while offline, must not be lost/);
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

  const result = withLiveWritesAllowed(() => landFeedback(root, { gh }));
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
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(first.landed, true);
  assert.equal(createCount(), 1);

  simulateMerge(bareOrigin); // the gate merges — fb-1.yaml is now really on origin/main

  const second = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.deepEqual(second, { landed: false, files: [] });
  assert.equal(createCount(), 1, "no spurious re-push/re-PR once the content is already on origin/main");
});

test("landFeedback: while a landing PR is still OPEN, a second batch of new files reuses the SAME PR — never opens a second one (no per-capture PR spam)", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/4");
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(first.landed, true);
  assert.equal(createCount(), 1);

  // No merge yet — the PR from `first` is still open. A second, unrelated new file shows up
  // (e.g. another capture on this same machine before the gate has gotten to the first PR).
  writeFileSync(join(root, "plan", "feedback", "fb-2.yaml"), "id: fb-2\nraw: y\n");
  const second = withLiveWritesAllowed(() => landFeedback(root, { gh }));
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

// ── Acceptance claim 5: the WIRING itself, not just the two helper functions in isolation ──
//
// missingFeedbackMessage() and findPendingLandingPr() are proven above in isolation — but the
// actual falsifier this task fixes is run-task.ts's `triageCommand` catch branch, the one real
// call site that stitches them together (existsSync(feedbackEntryPath(...)) -> the conditional
// findPendingLandingPr() call -> the ledgered log() -> the say() the operator actually reads).
// Drive `triageCommand` itself, for real, end to end: a REAL git worktree (a local bare "origin",
// no network — same fixture helpers as claim 1 above), a REAL `loadConfig()` (HOME overridden to
// an throwaway fixture directory so nothing here touches the operator's real ~/.config/remudero
// or ~/Remudero), and the REAL module-level `repoRoot` (this actual checkout) — the only thing
// this test controls is WHERE `config.root/repos/<repo>` points, by pre-seeding it as a fresh
// clone with no `plan/feedback/<id>.yaml` on `main`, so `readFeedbackEntry` genuinely throws and
// the catch branch this task added is the one that actually runs.
/**
 * Everything `triageCommand` needs before it reaches the catch branch this task added: a real
 * `config.root/repos/<repo>` (pre-seeded so the real `gh repo clone` is skipped) sitting at
 * exactly the path `resolveOwnerRepo()` (THIS checkout's real origin url) resolves, and a real
 * `loadConfig()` (HOME overridden to a throwaway fixture dir so nothing here ever touches the
 * operator's real `~/.config/remudero` or `~/Remudero`). Caller must restore `process.env.HOME`
 * and rm the two returned dirs in a `finally`.
 */
function setupTriageWiringFixture(): { home: string; configRoot: string; savedHome: string | undefined } {
  const bareOrigin = makeBareOrigin(); // plan/feedback/<id>.yaml genuinely absent from `main`
  const home = mkdtempSync(join(tmpdir(), "rmd-triage-wiring-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-triage-wiring-root-"));
  const savedHome = process.env.HOME;

  // Seed a complete config.json up front so loadConfig() takes its EEXIST/read path (no
  // `which claude` shell-out, no write race) — same fixture discipline as test/config.test.ts's
  // "EEXIST fallback READS the existing config" test.
  const configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
  process.env.HOME = home;

  // `triageCommand` resolves `repo` from THIS actual checkout's real origin url
  // (resolveOwnerRepo() shells `git -C repoRoot config --get remote.origin.url`) — replicate
  // that same resolution so the fixture repo lands exactly where it will look, at
  // `config.root/repos/<repo>`, pre-existing so it skips the real `gh repo clone`.
  const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoMatch = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  assert.ok(repoMatch, "sanity: this checkout must have a parseable origin url");
  const repoName = repoMatch![2];
  const destRepoDir = join(configRoot, "repos", repoName);
  mkdirSync(dirname(destRepoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bareOrigin, destRepoDir], { encoding: "utf8", env: GIT_ENV });

  return { home, configRoot, savedHome };
}

function teardownTriageWiringFixture(f: { home: string; configRoot: string; savedHome: string | undefined }): void {
  if (f.savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = f.savedHome;
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.configRoot, { recursive: true, force: true });
}

test("W1-T243 TRIAGE WIRING: triageCommand's real catch branch runs end-to-end (real worktree, real loadConfig) and exits 2 — genuinely unknown id", async () => {
  const fixture = setupTriageWiringFixture();
  try {
    const feedbackId = `fb-w1t243-wiring-${Date.now()}-nonexistent`;
    assert.ok(
      !existsSync(feedbackEntryPath(REPO_ROOT, feedbackId)),
      "sanity: this made-up id must not already exist locally in the real checkout either",
    );

    const exitCode = await triageCommand([feedbackId]);
    assert.equal(exitCode, 2, "a genuinely-missing feedback id still exits 2, exactly as before this task");
  } finally {
    teardownTriageWiringFixture(fixture);
  }
});

test("W1-T243 TRIAGE WIRING: triageCommand's real catch branch runs end-to-end — id captured locally but not yet landed", async () => {
  const fixture = setupTriageWiringFixture();
  const feedbackId = `fb-w1t243-wiring-pending-${Date.now()}`;
  const entryPath = feedbackEntryPath(REPO_ROOT, feedbackId);
  try {
    // Write a REAL entry into THIS checkout's own plan/feedback/ (repoRoot is a module-level
    // constant `triageCommand` cannot be handed a fixture path for) — the exact "captured
    // locally, not yet landed on origin/main" shape this task's catch branch distinguishes.
    // Cleaned up in `finally` regardless of outcome; the fresh worktree it reads from (a clone
    // of `bareOrigin`) never sees it either, so `readFeedbackEntry` still genuinely throws.
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(
      entryPath,
      [
        `id: ${feedbackId}`,
        "ts: '2026-07-23T00:00:00.000Z'",
        "raw: fixture entry for the triage-wiring existsLocally:true branch",
        "attachments: []",
        "origin: cli",
        "status: new",
        "proposal_pr: null",
        "",
      ].join("\n"),
    );
    assert.ok(existsSync(entryPath), "sanity: the fixture entry really is on disk in this checkout");

    // `findPendingLandingPr()` here runs through the REAL default `gh` (`defaultGh()` in
    // feedback-landing.ts) — the same call triageCommand itself makes in production, with no
    // injection point. A REAL `gh` binary's success/auth state differs unpredictably between a
    // sandboxed local shell and a CI runner (network-reachable/authenticated or not), which
    // would make this test's OWN coverage non-deterministic across environments. Pin it: shadow
    // `gh` on PATH with a deterministic shim for the duration of this call only, so the exact
    // same branch (a successful `pr list --json url` reporting one open PR) fires everywhere.
    const shimDir = mkdtempSync(join(tmpdir(), "rmd-triage-wiring-ghshim-"));
    const shimPath = join(shimDir, "gh");
    writeFileSync(shimPath, '#!/bin/sh\necho \'[{"url":"https://github.com/o/r/pull/424242"}]\'\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
    let exitCode: number;
    try {
      exitCode = await triageCommand([feedbackId]);
    } finally {
      process.env.PATH = savedPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
    assert.equal(exitCode, 2, "captured-but-unlanded still exits 2 — only the message text distinguishes it");
  } finally {
    rmSync(entryPath, { force: true });
    teardownTriageWiringFixture(fixture);
  }
});

// ── landFeedback: the remaining edge branches (dir-absent, ids-empty, non-Error throws) ────

test("landFeedback: a root that never captured anything (plan/feedback/ doesn't even exist) lands nothing, without ever creating it", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  assert.ok(!existsSync(join(root, "plan", "feedback")), "sanity: nothing captured here yet");

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/10");
  const result = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.deepEqual(result, { landed: false, files: [] });
  assert.equal(createCount(), 0, "an absent plan/feedback/ dir must never open a PR");
});

test("landFeedback: an unlanded file that isn't a plan/feedback/*.yaml entry (e.g. a stray non-yaml file) still lands, via the non-ids PR body branch", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  // Written directly, bypassing captureFeedback — a file plan/feedback/** carries that is not
  // itself a top-level `<id>.yaml` entry (missingFeedbackMessage's `ids` filter excludes it), so
  // the PR-body ternary's OTHER branch (unlanded.map, not ids.map) is the one that must fire.
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "NOTES.md"), "not a feedback entry, just a stray file\n");

  const { gh, calls } = fakeGh("https://github.com/o/r/pull/11");
  const result = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(result.landed, true);
  assert.deepEqual(result.files, ["plan/feedback/NOTES.md"]);
  const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
  assert.ok(createCall, "sanity: a PR-create call happened");
  const body = createCall![createCall!.indexOf("--body") + 1];
  assert.match(body, /plan\/feedback\/NOTES\.md lands durably on origin\/main/, "the non-ids fallback body line named the file directly");
});

test("landFeedback: captured entries nested under plan/feedback/attachments/<id>/ are walked recursively (a real local-file attachment)", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const attachmentSrc = join(mkdtempSync(join(tmpdir(), "rmd-feedback-landing-attach-")), "screenshot.png");
  writeFileSync(attachmentSrc, "not really a png, just fixture bytes");

  const { gh } = fakeGh("https://github.com/o/r/pull/12");
  const entry = withLiveWritesAllowed(() => captureFeedback(root, { raw: "see the attached screenshot", attachments: [attachmentSrc], land: { gh } }));
  assert.equal(entry.attachments.length, 1);
  assert.match(entry.attachments[0], /^plan\/feedback\/attachments\//);

  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", LANDING_BRANCH],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /plan\/feedback\/attachments\/.*\/screenshot\.png/, "the nested attachment file landed too — the walk recursed into its directory");
});

test("landFeedback: `gh pr create` throwing a NON-Error value (no `.message`) still reports landed:true, folding the raw value into `error`", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    // eslint-disable-next-line no-throw-literal -- deliberately a non-Error, proving the `?? e`
    // fallback in `String((e as Error)?.message ?? e)` (a real Error always has `.message`).
    throw "gh: command not found, no message property at all";
  };

  const result = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(result.landed, true, "the push already succeeded — only PR-open failed");
  assert.match(result.error ?? "", /gh: command not found, no message property at all/);
});

test("landFeedback: `gh pr merge` throwing is swallowed (best-effort auto-merge arm) — still landed:true with the PR url", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), "id: fb-1\nraw: x\n");

  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "Creating pull request\nhttps://github.com/o/r/pull/13\n";
    if (args[0] === "pr" && args[1] === "merge") throw new Error("simulated: auto-merge arming failed");
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };

  const result = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(result.landed, true, "a failed best-effort auto-merge arm must never turn a successful push+PR into a failure");
  assert.equal(result.prUrl, "https://github.com/o/r/pull/13");
});

test("landFeedback: a git failure that throws a NON-Error value still resolves to landed:false, folding the raw value into `error` (the outer catch's `?? e` fallback)", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-nonerror-git-")); // never even a git repo
  const failingGit = (): string => {
    // eslint-disable-next-line no-throw-literal
    throw "totally not a git repo, and this is a bare string, not an Error";
  };
  const result = withLiveWritesAllowed(() => landFeedback(root, { git: failingGit }));
  assert.deepEqual(result.files, []);
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /totally not a git repo, and this is a bare string/);
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
  withLiveWritesAllowed(() => landFeedback(root, { gh }));

  const message = execFileSync("git", ["--git-dir", bareOrigin, "log", "-1", "--format=%B", LANDING_BRANCH], { encoding: "utf8" });
  const result = lint(message);
  assert.equal(result.status, 0, `landing commit message must pass commitlint:\n${message}\n${result.stdout}${result.stderr}`);
});

// ── W1-T191: TWO WRITE PATHS DIRTY THE DAEMON'S OWN CHECKOUT ───────────────────────────────
//
// decision.autochoose used to `appendFileSync(join(repoRoot, "DECISIONS.md"), ...)` — a real
// working-tree write in the checkout `run-task`/`drain` themselves run from, which
// `checkCliFreshness` (self-sync.ts) then reads as "dirty" on every subsequent non-exempt
// `rmd` invocation. `recordDecision` replaces that append with a per-resolution shard
// (`plan/decisions.d/<taskId>-<runId>.md`) landed via the SAME commit-bridge mechanism
// W1-T243 already proved for `plan/feedback/**` — DELIBERATELY never written to `root`'s real
// working tree at all (not just "cleaned up after" — never put there), so `root` never picks
// up so much as an untracked file from this call.

test("landContent carry-forward: a pending file whose blob will not resolve is SKIPPED, never fatal", () => {
  // Covers the `continue` in landContent's carry-forward rev-parse catch. `ls-tree` lists a path on
  // the landing branch, then the per-file `rev-parse origin/<branch>:<path>` fails — the ref moved
  // between the two reads, or the entry is not a resolvable blob. That file must simply be dropped
  // from the carry-forward set: the batch still lands. A throw here would take the whole bridge down
  // on a benign race, and the bridge's contract is NEVER-THROWS.
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/101");

  const first = withLiveWritesAllowed(() => recordDecision(
    root,
    { taskId: "T1", runId: "T1-111", options: ["a", "b"], chosen: "a", band: "medium", reason: "first" },
    { gh },
  ));
  assert.equal(first.landed, true, "the first record is on the decisions-landing branch");

  // Second record. Real git for everything EXCEPT the carry-forward blob lookup, which throws the
  // way git does when the path is not resolvable in that ref.
  let skipped = 0;
  const racingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    if (args[0] === "rev-parse" && String(args[1]).startsWith(`origin/${DECISIONS_LANDING_BRANCH}:`)) {
      skipped++;
      throw new Error(`fatal: path does not exist in 'origin/${DECISIONS_LANDING_BRANCH}'`);
    }
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const second = withLiveWritesAllowed(() => recordDecision(
    root,
    { taskId: "T2", runId: "T2-222", options: ["a", "b"], chosen: "b", band: "medium", reason: "second" },
    { gh, git: racingGit },
  ));

  assert.ok(skipped > 0, "the unresolvable-blob branch was actually taken");
  assert.equal(second.landed, true, "the batch still lands — a skipped carry-forward file is not fatal");
  assert.equal(second.error, undefined, "and it is not reported as an error");
  assert.deepEqual(
    second.files,
    [decisionRecordRelPath("T2", "T2-222")],
    "only the new record is landed; the pending one whose blob would not resolve was skipped",
  );
});

test("W1-T191 acceptance 1: a decision record reaches a committed artifact, not only the working tree — recordDecision on origin, never root's working tree", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/100");

  const result = withLiveWritesAllowed(() => recordDecision(
    root,
    { taskId: "T1", runId: "T1-111", options: ["a", "b"], chosen: "a", band: "medium", reason: "medium-risk signal" },
    { gh },
  ));

  assert.equal(result.landed, true);
  const rel = decisionRecordRelPath("T1", "T1-111");
  assert.deepEqual(result.files, [rel]);

  // Never touched root's real working tree — no local file, no directory, at all.
  assert.equal(existsSync(join(root, rel)), false, "recordDecision must never write plan/decisions.d/ to root's real working tree");
  assert.equal(existsSync(join(root, "plan", "decisions.d")), false);
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    "",
    "root's own working tree must stay CLEAN — this is the checkCliFreshness dirt this task removes",
  );

  // But the record IS on the shared decisions-landing branch, as a real git-durable commit.
  const onBranch = execFileSync("git", ["--git-dir", bareOrigin, "show", `${DECISIONS_LANDING_BRANCH}:${rel}`], {
    encoding: "utf8",
  });
  assert.match(onBranch, /Chosen \(RECOMMENDED, auto\): a/);
  assert.match(onBranch, /Risk: medium \(medium-risk signal\)/);
});

test("W1-T191 acceptance 3: no decision record exists solely as an uncommitted modification — it survives root's checkout being destroyed by an ordinary git hygiene command", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/101");
  const result = withLiveWritesAllowed(() => recordDecision(
    root,
    { taskId: "T2", runId: "T2-222", options: ["x"], chosen: "x", band: "high", reason: "irreversible" },
    { gh },
  ));
  assert.equal(result.landed, true);

  // The FALSIFIER this replaces: `git checkout -- .` / `git reset --hard` in the operator
  // checkout used to silently destroy every unrescued DECISIONS.md entry. Since recordDecision
  // never put anything in root's working tree to begin with, there is nothing there for a
  // hygiene command to destroy — the record already lives only on the landing branch.
  execFileSync("git", ["-C", root, "reset", "--hard", "HEAD"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "clean", "-fdx"], { encoding: "utf8" });

  const rel = decisionRecordRelPath("T2", "T2-222");
  const stillThere = execFileSync("git", ["--git-dir", bareOrigin, "show", `${DECISIONS_LANDING_BRANCH}:${rel}`], {
    encoding: "utf8",
  });
  assert.match(stillThere, /Chosen \(RECOMMENDED, auto\): x/);
});

test("W1-T191 acceptance 2: two concurrent decision records both land without a conflict — neither's PR has merged yet when the second resolves", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/102");

  // Neither PR has merged yet when the second decision resolves — the exact "concurrent"
  // shape criterion 2 falsifies a naive shared-file append against.
  const first = withLiveWritesAllowed(() => recordDecision(root, { taskId: "T3", runId: "T3-1", options: ["a"], chosen: "a", band: "medium", reason: "r1" }, { gh }));
  const second = withLiveWritesAllowed(() => recordDecision(root, { taskId: "T4", runId: "T4-1", options: ["b"], chosen: "b", band: "medium", reason: "r2" }, { gh }));
  assert.equal(first.landed, true);
  assert.equal(second.landed, true);

  const tree = execFileSync("git", ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", DECISIONS_LANDING_BRANCH], {
    encoding: "utf8",
  });
  assert.match(tree, /T3-T3-1\.md/, "the FIRST decision's record must still be present after the SECOND lands");
  assert.match(tree, /T4-T4-1\.md/, "the SECOND decision's record must be present too");
});

test("W1-T191: recordDecision is idempotent — a decision whose content already matches what's on origin/main lands nothing", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const params = { taskId: "T5", runId: "T5-1", options: ["a"], chosen: "a", band: "low" as const, reason: "r", ts: "2026-01-01T00:00:00.000Z" };
  const rel = decisionRecordRelPath("T5", "T5-1");

  // Seed origin/main with the EXACT bytes recordDecision would itself produce.
  const seed = mkdtempSync(join(tmpdir(), "rmd-decisions-landing-seed-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "decisions.d"), { recursive: true });
  writeFileSync(join(seed, rel), decisionRecordContent(params));
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed decision T5");
  git(seed, "push", "--quiet", "origin", "main");

  const { gh } = fakeGh("https://github.com/o/r/pull/103");
  const result = withLiveWritesAllowed(() => recordDecision(root, params, { gh }));
  assert.equal(result.landed, false, "already-landed content must be a no-op, never an empty force-push");
  assert.deepEqual(result.files, []);
});

test("W1-T191 acceptance 5: a feedback decision leaves the caller's working tree clean — a console setFeedbackStatus with `land` lands via the bridge", () => {
  const bareOrigin = makeBareOrigin();
  const id = "fb-preexisting-1";

  // Seed origin/main with an ALREADY-TRACKED, ALREADY-MERGED feedback entry — exactly the
  // state a `proposed` entry is in by the time a console accept/reject decision acts on it
  // (captured, landed, and merged in an earlier, unrelated PR/session). Seeding this way
  // (rather than via captureFeedback into `root` itself) avoids conflating THIS task's fix
  // with captureFeedback's own separate, pre-existing, out-of-scope local-write behavior.
  const seed = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-seed-fb-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(
    join(seed, "plan", "feedback", `${id}.yaml`),
    "id: fb-preexisting-1\n" +
      "ts: '2026-01-01T00:00:00.000Z'\n" +
      "raw: needs a decision\n" +
      "attachments: []\n" +
      "origin: cli\n" +
      "status: proposed\n" +
      "proposal_pr: null\n",
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed pre-existing feedback entry");
  git(seed, "push", "--quiet", "origin", "main");

  const root = cloneRoot(bareOrigin); // root's clone TRACKS the entry from the start.
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    "",
    "sanity: root is clean and the entry is tracked before the decision flip",
  );

  const { gh } = fakeGh("https://github.com/o/r/pull/200");
  const updated = withLiveWritesAllowed(() => setFeedbackStatus(root, id, "accepted", { land: { gh } }));
  assert.equal(updated.status, "accepted");

  // The flip never touched root's real working tree — the file on disk is byte-identical to
  // what's in root's own git index (still `status: new`), and `git status --porcelain` proves
  // it: no `M`, no dirt, exactly the property checkCliFreshness's dirty check inspects.
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    "",
    "a console feedback decision must leave root's working tree clean (W1-T191 acceptance 5)",
  );

  // But the flip DID reach a branch — a real, git-durable commit, not only root's own tree.
  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/${id}.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /status: accepted/);
});

test("W1-T191 acceptance 6: a checkout dirtied only by these two writers is not refused — once it falls behind origin/main, checkCliFreshness lets it through", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/201");

  withLiveWritesAllowed(() => recordDecision(root, { taskId: "T6", runId: "T6-1", options: ["a"], chosen: "a", band: "medium", reason: "r" }, { gh }));

  // origin/main moves on (root falls behind) — the steady state self-sync exists to clear.
  const advance = mkdtempSync(join(tmpdir(), "rmd-decisions-landing-advance-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, advance], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(advance, "README.md"), "seed\nmore\n");
  git(advance, "add", "-A");
  git(advance, "commit", "--quiet", "-m", "chore: advance main");
  git(advance, "push", "--quiet", "origin", "main");

  const realGit = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const result = checkCliFreshness(root, {}, { git: realGit, say: () => {}, warn: () => {}, reexec: () => {} });
  assert.notEqual(result.status, "refused", `expected NOT refused, got: ${JSON.stringify(result)}`);
});

test("W1-T191: DECISIONS_LANDING_PR_TITLE passes the REAL commitlint CLI", () => {
  const result = lint(DECISIONS_LANDING_PR_TITLE);
  assert.equal(
    result.status,
    0,
    `decisions-landing commit header must pass commitlint:\n${DECISIONS_LANDING_PR_TITLE}\n${result.stdout}${result.stderr}`,
  );
});

test("W1-T191: recordDecision's full commit message (header + body) passes the REAL commitlint CLI", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const { gh } = fakeGh("https://github.com/o/r/pull/202");
  withLiveWritesAllowed(() => recordDecision(root, { taskId: "T7", runId: "T7-1", options: ["a"], chosen: "a", band: "medium", reason: "r" }, { gh }));

  const message = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "log", "-1", "--format=%B", DECISIONS_LANDING_BRANCH],
    { encoding: "utf8" },
  );
  const result = lint(message);
  assert.equal(result.status, 0, `decisions-landing commit message must pass commitlint:\n${message}\n${result.stdout}${result.stderr}`);
});
