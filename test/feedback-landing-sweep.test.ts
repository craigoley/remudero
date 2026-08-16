import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { daemonBoot, runDaemon } from "../src/lib/daemon.js";
import { LANDING_BRANCH, sweepFeedbackLanding, type LandFeedbackResult } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";

// ── W1-T530 — THE LEVEL-TRIGGERED FEEDBACK-LANDING SWEEP ────────────────────────────────────
//
// `landFeedback` (feedback-landing.ts, W1-T243) has exactly ONE production call site —
// `captureFeedback` (feedback.ts), fired at capture time only. An entry written before that
// bridge existed, or whose at-capture landing attempt failed (offline, no `gh`, `gh pr create`
// refused — all swallowed by contract), or captured on a host that never captures again, is
// stranded off `origin/main` forever: nothing ever re-scans the inbox. `sweepFeedbackLanding`
// is the thin, named wrapper this task adds (feedback-landing.ts) to re-run that same scan on a
// LEVEL-TRIGGERED cadence; this file proves it is actually WIRED into the daemon's boot and
// poll paths (`daemonBoot`/`runDaemon`, daemon.ts) — the grep proofs at the two wiring sites
// only prove the CALL exists syntactically, not that it reaches a real, correct pass.
//
// Deliberately kept SEPARATE from test/feedback-landing.test.ts (W1-T243/W1-T191's own file,
// pinned by verbatim test title and not to be churned by this task) — this file owns only the
// NEW trigger, never the reconciliation mechanism those tests already cover.
//
// Same hermetic discipline as feedback-landing.test.ts: a real local `git init --bare` origin
// (no network anywhere), a fake `gh` tracking every call. The git half is REAL, the gh half is
// FAKE — never the reverse, and never a stub over `sweepFeedbackLanding`/`landFeedback`
// themselves, per this task's own cross-file-invariant requirement.

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
  const bare = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-sweep-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-sweep-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A real clone of `bareOrigin` — the "operator checkout" a capture (or a pre-existing file) lives in. */
function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-sweep-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  let mergeCount = 0;
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
      mergeCount++;
      return "";
    }
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount, mergeCount: () => mergeCount };
}

/** A `gh` that always refuses `pr create` — models "offline / no auth" at capture time. */
function refusingGh() {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([]);
    if (args[0] === "pr" && args[1] === "create") throw new Error("gh: not authenticated");
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

function writeFeedbackEntry(root: string, id: string, raw: string): void {
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), `id: ${id}\nraw: ${raw}\n`);
}

function tinyPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "feedback-landing-sweep-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "[]\n");
  return loadPlan(f);
}

// ── Criterion 1: THE CROSS-FILE INVARIANT — daemonBoot's OWN pass, REAL sweepFeedbackLanding ──

test("W1-T530 CROSS-FILE INVARIANT: a plan/feedback/*.yaml no capture ever saw lands via daemonBoot's OWN boot pass, driving the REAL sweepFeedbackLanding end to end", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  // Written directly to disk — never through captureFeedback, so NOTHING in this process ever
  // called landFeedback for it. Simulates entries (1) pre-dating the bridge or (2) captured on a
  // host that never captures again.
  writeFeedbackEntry(root, "fb-stranded", "stranded before any capture ran on this host");

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/9001");
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

  // Neither side is stubbed: `sweepFeedbackLanding` is the REAL export from feedback-landing.ts,
  // and it is threaded into the REAL `daemonBoot` boot path — only the git/gh EXEC seams (real
  // local git, faked gh) are stubbed, per the design's own "no stub for either side" rule.
  withLiveWritesAllowed(() =>
    daemonBoot(
      log,
      process.env,
      undefined, // sweepTmp
      undefined, // sweepLocks
      undefined, // unlockWorkerKeychain
      undefined, // crashLoopCheck
      undefined, // resolveClaudeBin
      false, // allowApiKey
      undefined, // sweepOrphanWorkers
      undefined, // bootHeadSha
      () => sweepFeedbackLanding(root, { gh, log }),
    ),
  );

  assert.equal(createCount(), 1, "the boot pass itself opened the shared landing PR — the module alone reaches nothing without this rung");
  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/fb-stranded.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /id: fb-stranded/, "the boot rung alone lands nothing unless it actually drives the real sweep");

  const bootLine = lines.find((l) => l.step === "daemon.feedback_landing_sweep");
  assert.ok(bootLine, "the boot pass must ledger the sweep (daemon.feedback_landing_sweep)");
  assert.equal(bootLine?.extra?.pushed, true);
  assert.equal(bootLine?.extra?.file_count, 1);

  const detailLine = lines.find((l) => l.step === "feedback.landing_sweep");
  assert.ok(detailLine, "sweepFeedbackLanding's own acting-pass line must fire too");
  assert.deepEqual(detailLine?.extra?.files, ["plan/feedback/fb-stranded.yaml"]);
  assert.equal(detailLine?.extra?.pr_url, "https://github.com/o/r/pull/9001");
});

// ── Criterion 2: a captured entry whose AT-CAPTURE landing FAILED is picked up LATER ─────────

test("W1-T530: an entry whose at-capture landing failed (gh pr create refused) is picked up by a LATER periodic sweepFeedbackLanding pass, with no further capture", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-retry", "capture-time landing failed, offline/no-auth");

  // The FIRST (capture-time) attempt: git succeeds (push reaches the branch), but `gh pr create`
  // is refused — exactly captureFeedback's swallowed-failure contract (feedback.ts:907-912).
  const refusing = refusingGh();
  const firstAttempt = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh: refusing.gh }));
  assert.equal(firstAttempt.landed, true, "the push already succeeded — only opening the PR failed");
  assert.ok(firstAttempt.error, "the failed gh pr create is named in the result, never thrown");

  // NO further capture happens on this host. A LATER periodic pass (the daemon's per-poll rung,
  // simulated here directly) with a working `gh` must pick the SAME content up and actually open
  // the PR — without any human git command and without re-writing the local file.
  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/9002");
  const laterPass = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh }));
  assert.equal(laterPass.landed, true);
  // The CONTENT was already pushed by the first attempt (git succeeded there) — the later pass's
  // own job is only to open the PR the first attempt never managed to, so `pushed` (which tracks
  // the git push specifically) is correctly false here; `prUrl`/`createCount` prove the retry.
  assert.equal(laterPass.pushed, false, "content already matched — this pass pushed nothing new");
  assert.equal(laterPass.error, undefined, "the retry succeeded — no error carried forward");
  assert.equal(laterPass.prUrl, "https://github.com/o/r/pull/9002");
  assert.deepEqual(laterPass.files, ["plan/feedback/fb-retry.yaml"]);
  assert.equal(createCount(), 1, "the later pass opened the PR that the capture-time attempt never managed to");

  const onBranch = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:plan/feedback/fb-retry.yaml`],
    { encoding: "utf8" },
  );
  assert.match(onBranch, /id: fb-retry/);
});

// ── Criterion 3: IDEMPOTENCE — a pass over already-landed state does NOTHING observable ──────

test("W1-T530: a sweep pass over already-landed, still-open-PR state pushes nothing, opens no second PR, and calls no gh mutation", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-1", "first pass content");

  const { gh, calls, createCount } = fakeGh("https://github.com/o/r/pull/9003");
  const first = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh }));
  assert.equal(first.pushed, true);
  assert.equal(createCount(), 1);

  const branchShaAfterFirst = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "rev-parse", LANDING_BRANCH],
    { encoding: "utf8" },
  ).trim();
  calls.length = 0; // only inspect gh calls made by the SECOND pass below

  // Nothing changed on disk, nothing merged upstream — the PR is still open. A second periodic
  // pass over this exact same state (the daemon's own poll cadence, unattended) must be a no-op:
  // no branch push, no second PR, no gh mutation (list-to-check is allowed; create/merge is not).
  const second = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh }));
  assert.equal(second.landed, true, "still reports the content as landed — it IS on the branch");
  assert.equal(second.pushed, false, "but this pass did not push anything new");
  assert.equal(createCount(), 1, "no second PR opened");
  assert.equal(calls.some((c) => c[0] === "pr" && c[1] === "create"), false, "no gh pr create on the quiet pass");
  assert.equal(calls.some((c) => c[0] === "pr" && c[1] === "merge"), false, "no gh pr merge on the quiet pass");

  const branchShaAfterSecond = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "rev-parse", LANDING_BRANCH],
    { encoding: "utf8" },
  ).trim();
  assert.equal(branchShaAfterSecond, branchShaAfterFirst, "the landing branch must not move on a quiet pass");
});

// ── Criterion 4: BEST-EFFORT — a throwing/offline sweep costs one logged tick, never the daemon ──

test("runDaemon: a THROWING sweepFeedbackLanding does not kill the loop — it logs daemon.feedback_landing_sweep.failed and keeps polling", async () => {
  const plan = tinyPlan();
  const merged = new Set<string>();
  let sweepCalls = 0;
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-feedback-landing-sweep-throw-"));

  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" as const }),
    sweepFeedbackLanding: () => {
      sweepCalls += 1;
      throw new Error("offline: could not resolve host github.com");
    },
    checkStop: () => (sweepCalls >= 2 ? (requestStop(root, "two failed feedback-landing sweeps seen"), stopDetail(root)) : undefined),
    sleep: async () => {},
    log: (step, extra) => lines.push({ step, extra }),
  });

  assert.ok(sweepCalls >= 2, `the loop kept iterating THROUGH the failures (saw ${sweepCalls} sweeps)`);
  assert.notEqual(s.stopReason, "error", "a failing feedback-landing sweep must never be a daemon error");
  const failLine = lines.find((l) => l.step === "daemon.feedback_landing_sweep.failed");
  assert.ok(failLine, "daemon.feedback_landing_sweep.failed must be logged");
  assert.match(String(failLine?.extra?.error), /offline/);
});

test("runDaemon: sweepFeedbackLanding runs once per tick and logs daemon.feedback_landing_sweep naming pushed/landed/file_count", async () => {
  const plan = tinyPlan();
  const merged = new Set<string>();
  let sweepCalls = 0;
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-feedback-landing-sweep-ok-"));

  const result: LandFeedbackResult = { landed: true, files: ["plan/feedback/fb-x.yaml"], prUrl: "https://github.com/o/r/pull/9004", pushed: true };
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" as const }),
    sweepFeedbackLanding: () => {
      sweepCalls += 1;
      return result;
    },
    checkStop: () => (sweepCalls >= 1 ? (requestStop(root, "one feedback-landing sweep seen"), stopDetail(root)) : undefined),
    sleep: async () => {},
    log: (step, extra) => lines.push({ step, extra }),
  });

  assert.ok(sweepCalls >= 1, "the sweep ran at least once per tick");
  assert.notEqual(s.stopReason, "error");
  const line = lines.find((l) => l.step === "daemon.feedback_landing_sweep");
  assert.ok(line, "daemon.feedback_landing_sweep is logged");
  assert.equal(line?.extra?.pushed, true);
  assert.equal(line?.extra?.landed, true);
  assert.equal(line?.extra?.file_count, 1);
});

test("runDaemon: with no sweepFeedbackLanding injected, the loop behaves exactly as before W1-T530 (no daemon.feedback_landing_sweep line)", async () => {
  const plan = tinyPlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-no-feedback-landing-sweep-"));

  await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" as const }),
    checkStop: () => (requestStop(root, "stop immediately"), stopDetail(root)),
    sleep: async () => {},
    log: (step) => lines.push({ step }),
  });

  assert.equal(lines.filter((l) => l.step.startsWith("daemon.feedback_landing_sweep")).length, 0);
});

// ── Criterion 4b: never mutates the caller's own index/working tree/local HEAD ───────────────

test("W1-T530: sweepFeedbackLanding never mutates the caller's own index, working tree, or local HEAD (W1-T60)", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-clean", "must not dirty root's own checkout");

  const headBefore = git(root, "rev-parse", "HEAD").trim();
  const statusBefore = git(root, "status", "--porcelain").trim();

  const { gh } = fakeGh("https://github.com/o/r/pull/9005");
  withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh }));

  assert.equal(git(root, "rev-parse", "HEAD").trim(), headBefore, "sweepFeedbackLanding must never move root's local HEAD");
  assert.equal(
    git(root, "status", "--porcelain").trim(),
    statusBefore,
    "sweepFeedbackLanding must never change root's own working-tree/index state",
  );
});
