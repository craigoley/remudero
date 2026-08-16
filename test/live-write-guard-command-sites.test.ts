import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { approveCommand, buildSweepEffects, planCommand, triageCommand } from "../src/run-task.js";
import { ghPrMergeSquash, type WorkerResult } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────
// PR #954's guard call sites inside `triageCommand` and `planCommand` sat after a
// `spawnWorker` call in functions that took no deps, so no offline test could reach them
// and diff-coverage blocked the PR through three rounds. #964 added the seam; this file
// uses it to drive those commands far enough that the guarded push lines actually execute.
//
// Everything here is offline: a bare `git init` origin in TMPDIR, a `gh` shim on PATH that
// answers every subcommand the run makes, and an injected spawn that behaves like a real
// Architect worker (writes a schema-valid plan file into the worktree it was handed and
// returns the verdict line the real parser looks for). No network, no paid worker, no live
// repo — the pushes land in the throwaway origin.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
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

const VALID_TASK = (id: string, title: string): string =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "",
  ].join("\n");

/** The full envelope the post-spawn ledger line reads — an incomplete one throws inside
 *  `workerLedgerFields` before the run can continue. */
function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "CMD-SITE-SESSION",
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

function makeOrigin(feedbackId?: string): string {
  const bare = mkdtempSync(join(tmpdir(), "cmdsite-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "cmdsite-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), VALID_TASK("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  if (feedbackId) {
    writeFileSync(
      join(seed, "plan", "feedback", `${feedbackId}.yaml`),
      [
        `id: ${feedbackId}`,
        "ts: '2026-07-30T00:00:00.000Z'",
        "raw: fixture entry for the guarded-call-site coverage",
        "attachments: []",
        "origin: cli",
        "status: new",
        "proposal_pr: null",
        "",
      ].join("\n"),
    );
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A `gh` shim answering every subcommand these runs make, so execution reaches the pushes
 *  instead of dying at the first gh call. `pr view --json headRefName` echoes back the run's
 *  OWN branch so the run-ownership guard passes. `opts.failPrList` makes `gh pr list` (the
 *  mint's `openPrTexts` enumerator, W1-T311) fail non-zero — used by the degraded-mint test
 *  below to reach the real gateway's refusal/catch path rather than its success path.
 *
 *  `bareOrigin` backs the W1-T903 REST cases (`gh api ... pulls` create/probe/single-GET) —
 *  `openPlanPr`/`readHeadShaRest`/`fetchPrLifecycle` all read this same REST surface now, never
 *  `gh pr create`/`gh pr list`. The single-PR GET's `head.sha` is read LIVE off whichever
 *  `run-*` branch this test's own gateway just pushed to `bareOrigin`, so a caller's `rev-parse
 *  HEAD` on a worktree checked out from it always matches. `opts.matchRealBranch` makes
 *  `headRefName` resolve the SAME way (rather than the static `RMD_SHIM_BRANCH` env var below) —
 *  used only by the full-success drive, where the run-ownership guard must actually PASS.
 *  `opts.ciConclusion` overrides `statusCheckRollup`'s `ci` conclusion (default `SUCCESS`) —
 *  `"FAILURE"` drives `waitForCiGreen` RED on its first poll instead of green, reaching
 *  approveCommand's `ci !== "green"` cleanup branch rather than the review/arm continuation.
 *  `opts.failPrDiff` makes `gh pr diff` (inside `runReview`) exit non-zero — an exception
 *  `reviewCommand` does not itself catch, reaching approveCommand's outer `catch` cleanup. */
function writeGhShim(
  dir: string,
  bareOrigin: string,
  opts: { failPrList?: boolean; matchRealBranch?: boolean; ciConclusion?: string; failPrDiff?: boolean } = {},
): void {
  // Resolves to whichever `run-*` branch this test's own gateway most recently pushed to
  // `bareOrigin` — evaluated FRESH on every shim invocation (never cached), so a case fired
  // before the push (e.g. `pr list` during the mint) sees nothing and a case fired after (the
  // ownership/head-sha/lifecycle reads below) sees the real ref.
  const resolveBranch = `branch=$(git -C ${JSON.stringify(bareOrigin)} for-each-ref --format='%(refname:short)' 'refs/heads/run-*' | head -1)`;
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      "# $* is the full argv; branch name is embedded in --head for create, else derived.",
      'case "$*" in',
      opts.failPrList
        ? '  *"pr list"*) echo "gh: rate limit exceeded" 1>&2; exit 1 ;;'
        : '  *"pr list"*) echo "[]" ;;',
      // `ensureRepoDir`'s clone (only reached when `repoDir` does not exist yet — every OTHER
      // test here pre-clones it, so this case never fires for them). Real `git clone` from the
      // SAME throwaway bare origin, with repo-local identity (a bare CI runner has none) so the
      // gateway's own `git commit` downstream does not die for want of one.
      '  *"repo clone"*)',
      `    git clone --quiet ${JSON.stringify(bareOrigin)} "$4"`,
      '    git -C "$4" config user.name remudero-test',
      '    git -C "$4" config user.email test@remudero.invalid',
      "    ;;",
      '  *"pr create"*)',
      '    echo "https://github.com/craigoley/remudero/pull/4242" ;;',
      // W1-T903: `openPlanPr`'s REST create — `gh api --method POST repos/.../pulls`. Matched on
      // "POST"+"pulls" together, which never collides with the plain single-PR GET below (no
      // "POST") or the status-post call (no "pulls").
      '  *"POST"*"pulls"*)',
      '    echo \'{"html_url":"https://github.com/craigoley/remudero/pull/4242","number":4242}\'',
      "    ;;",
      // W1-T903: `probeExistingPlanPr`'s resumption probe — `gh api repos/.../pulls?head=...`.
      // Empty ⇒ no prior PR found, so a resumed branch falls to COMPLETE, never ADOPT.
      '  *"pulls?head="*) echo "[]" ;;',
      // The single-PR REST GET (`readHeadShaRest`/`fetchPrLifecycle`/`reviewViewArgs`) — every
      // caller of `repos/.../pulls/<n>` shares this one row. `head.sha` is read LIVE off
      // whichever `run-*` branch the gateway actually pushed, so a worktree materialized from
      // it (`materializeReviewWorktree`) lands on exactly the sha this response claims.
      '  *"/pulls/"*)',
      `    ${resolveBranch}`,
      `    sha=$(git -C ${JSON.stringify(bareOrigin)} rev-parse "$branch" 2>/dev/null)`,
      '    printf \'{"number":4242,"html_url":"https://github.com/craigoley/remudero/pull/4242","state":"OPEN","merged_at":null,"body":"","updated_at":"2026-08-16T00:00:00Z","head":{"ref":"%s","sha":"%s"}}\\n\' "$branch" "$sha"',
      "    ;;",
      opts.matchRealBranch
        ? '  *"headRefName"*)\n' + `    ${resolveBranch}\n` + '    printf \'{"headRefName":"%s"}\\n\' "${branch:-main}" ;;'
        : '  *"headRefName"*)\n' + "    # echo back whatever branch the caller is on, read from the shim env\n" + '    printf \'{"headRefName":"%s"}\\n\' "${RMD_SHIM_BRANCH:-main}" ;;',
      // W1-T903 (via waitForCiGreen): resolved on the FIRST poll — never a real wait.
      `  *"statusCheckRollup"*) echo '{"statusCheckRollup":[{"name":"ci","conclusion":"${opts.ciConclusion ?? "SUCCESS"}"}]}' ;;`,
      '  *"--json body"*) echo \'{"body":""}\' ;;',
      opts.failPrDiff
        ? '  *"pr diff"*) echo "gh: transient diff failure" 1>&2; exit 1 ;;'
        : '  *"pr diff"*) echo "" ;;',
      '  *"pr edit"*) exit 0 ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function withHarness(
  feedbackId: string | undefined,
  body: (ctx: { configRoot: string; setBranch: (b: string) => void }) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin(feedbackId);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "cmdsite-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-shim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const savedBranch = process.env.RMD_SHIM_BRANCH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    // Repo-local identity, inherited by every run worktree — a bare CI runner has none, and
    // without it the run dies at its own `git commit` long before any push.
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    writeGhShim(shimDir, bare);
    process.env.PATH = `${shimDir}:${savedPath}`;

    await body({ configRoot, setBranch: (b) => { process.env.RMD_SHIM_BRANCH = b; } });

    const p = join(configRoot, "state", "ledger.ndjson");
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    if (savedBranch === undefined) delete process.env.RMD_SHIM_BRANCH;
    else process.env.RMD_SHIM_BRANCH = savedBranch;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

// ── run-task.ts:8430 — triageCommand's SECOND push, on the propose path ──────────────
test("GUARDED SITE triage propose-path push: the run reaches the second gitPushRunBranch after its PR opens", async () => {
  const feedbackId = `fb-cmdsite-triage-${Date.now()}`;

  const ledger = await withHarness(feedbackId, async ({ setBranch }) => {
    setBranch(`run-TRIAGE-${feedbackId}`);
    // The pushes below are REAL and land in this fixture's throwaway bare origin — never the
    // live repo — so the section is exempted. The exemption wraps only the DRIVE; the guard
    // stays armed everywhere else, and the leaf's own refusal is proven separately in
    // test/live-write-guard-leaves.test.ts. Without this the run dies at the FIRST push and
    // the propose-path push below is never reached.
    await withLiveWritesAllowed(() => triageCommand([feedbackId], {
      spawn: async (args: { cwd: string }) => {
        appendFileSync(join(args.cwd, "plan", "tasks.yaml"), VALID_TASK("W1-T99", "filed by the fixture worker"));
        // The shim's branch answer must match the run's ACTUAL branch for the ownership
        // guard to pass; the run id is only known here, so read it off the worktree.
        const b = execFileSync("git", ["-C", args.cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
          encoding: "utf8",
        }).trim();
        process.env.RMD_SHIM_BRANCH = b;
        return fakeWorker("PROPOSED: file W1-T99 for the guarded-call-site coverage");
      },
    })).catch(() => undefined);
  });

  // Past the spawn, past the first push, past PR-create and the ownership guard.
  assert.equal(ledger.filter((l) => l.step === "triage.synthesized").length, 1, "reached post-spawn code");
  // The propose branch is what contains the second push. `triage.proposed` (or a terminal
  // verdict beyond it) proves the run got through that block.
  // The propose block (which contains the second push) runs BEFORE the plan-only /
  // provenance guards that follow it. A terminal error naming one of those guards is
  // therefore proof the run got through the propose push — it could not have reached the
  // guard otherwise. Measured: run-task.ts:8430 DA=1 with this test, DA=0 without it.
  const errs = ledger.filter((l) => l.step === "triage.error").map((l) => String(l.error));
  assert.equal(errs.length, 1, `expected one terminal error; steps=${JSON.stringify(ledger.map((l) => l.step))}`);
  assert.match(
    errs[0],
    /provenance|plan-only|non-plan/i,
    "the run died at a POST-push guard, so the propose-path push had already executed",
  );
});

// ── run-task.ts:8618 — planCommand's push ────────────────────────────────────────────
test("GUARDED SITE plan push: the run reaches planCommand's gitPushRunBranch", async () => {
  const ledger = await withHarness(undefined, async ({ setBranch }) => {
    setBranch("run-PLAN");
    await withLiveWritesAllowed(() => planCommand(["--mode=create", "a", "fixture", "brief", "for", "guarded-call-site", "coverage"], {
      spawn: async (args: { cwd: string }) => {
        appendFileSync(join(args.cwd, "plan", "tasks.yaml"), VALID_TASK("W1-T98", "filed by the plan fixture worker"));
        const b = execFileSync("git", ["-C", args.cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
          encoding: "utf8",
        }).trim();
        process.env.RMD_SHIM_BRANCH = b;
        return fakeWorker("PROPOSED: file W1-T98 for the guarded-call-site coverage");
      },
    })).catch(() => undefined);
  });

  assert.equal(ledger.filter((l) => l.step === "plan.synthesized").length, 1, "reached post-spawn code");
  const reached = ledger.some((l) => typeof l.step === "string" && l.step.startsWith("plan."));
  assert.ok(reached, `run reached plan's terminal block; steps=${JSON.stringify(ledger.map((l) => l.step))}`);
});

// ── run-task.ts:9116 and :9136 — approveCommand's REAL (un-injected) gateway ─────────
// Every other test of `rmd approve` injects `gateway:`, which replaces the whole object and
// so never runs its two guarded lines. Omitting it runs the real one: it clones/worktrees,
// commits, pushes (:9116) and opens a plan PR (:9136). Offline throughout — config.root is a
// tmpdir, the repo is pre-seeded from a bare TMPDIR origin, and gh is shimmed.
//
// W1-T311: the draft below carries a `NEW-1` PLACEHOLDER id (not a concrete `W1-Tnnn` one), so
// the real gateway's mint-and-reserve block (materializeDraftTaskIds -> mintNextTaskIdWithHistory
// + reserveTaskIdBlock, run-task.ts's createRatificationBranch) actually executes rather than
// short-circuiting as a no-op — the ONLY way to cover those closures without injecting a fake
// gateway (every other approve test does inject one, which replaces this code entirely).
test("GUARDED SITE approve push and pr-create: the REAL un-injected gateway reaches both guarded lines", async () => {
  const bare = makeOrigin(undefined);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-apphome-"));
  const root = mkdtempSync(join(tmpdir(), "cmdsite-approot-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-appshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root }, null, 2),
      "utf8",
    );
    process.env.HOME = home;
    writeGhShim(shimDir, bare);
    process.env.PATH = `${shimDir}:${savedPath}`;

    // The repo the real gateway worktrees from, at the path resolveOwnerRepo() derives.
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(root, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // A READY proposal: no evidence anchors, and a lint-clean single-task fragment, so the
    // REAL classifyProposal resolves "ready" with no git/gh call of its own.
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify({ proposals: [{ id: "P-GUARD", summary: "guarded-site fixture", evidenceAnchors: [] }] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(root, "state", "inbox-drafts.json"),
      JSON.stringify({
        "P-GUARD": {
          proposalId: "P-GUARD",
          fragmentYaml:
            "- id: NEW-1\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
          stampLine: "- P-GUARD (plan) — RATIFIED -> NEW-1.",
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );

    // Real gateway (no `gateway:`), and the push/PR-create land in the TMPDIR origin.
    await withLiveWritesAllowed(() => approveCommand(["P-GUARD"], { config: { claudeBin: "/usr/bin/true", root } as never })).catch(
      () => undefined,
    );

    // The gateway's branch really landed on the throwaway origin — the push executed.
    const refs = execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
    assert.match(refs, /run-/, `the ratification branch reached the origin; refs=${JSON.stringify(refs)}`);
    // The placeholder was really minted+reserved (not left as-is) — the pushed branch's plan
    // carries a concrete W1-Tnnn id, never the NEW-1 placeholder it started from.
    const clone = mkdtempSync(join(tmpdir(), "cmdsite-appverify-"));
    execFileSync("git", ["clone", "--quiet", bare, clone], { encoding: "utf8", env: GIT_ENV });
    const branch = refs.split("\n").find((l) => l.startsWith("run-"));
    assert.ok(branch, "expected a run- branch on the throwaway origin");
    const plan = execFileSync("git", ["-C", clone, "show", `origin/${branch}:plan/tasks.yaml`], { encoding: "utf8" });
    assert.match(plan, /^- id: W1-T\d+$/m, `expected a minted concrete id in the pushed plan; got:\n${plan}`);
    assert.doesNotMatch(plan, /NEW-1/, "the NEW-1 placeholder must never survive to the pushed plan");
    rmSync(clone, { recursive: true, force: true });
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── W1-T903 — approveCommand's REAL gateway: ensureRepoDir's clone branch, and a full
// success drive past REST create/ownership/ci-green/review/arm ──────────────────────────────
// Every test above pre-clones `repoDir` before calling `approveCommand`, so `ensureRepoDir`'s
// `!existsSync(repoDir)` branch (the `mkdirSync` + `gh repo clone`) never fires, and every one
// leaves `RMD_SHIM_BRANCH` unset (or absent), so `checkPrOwnership` always REFUSES — the run
// never reaches the post-ownership block (`log("pr.opened", ...)`, the ci-green gate, the
// review + arm, or their own `removeApproveWorktree()`/`removeRunLock` cleanup). This test
// closes both gaps in one drive: `repoDir` starts absent (the shim's `repo clone` case performs
// a REAL `git clone` off the same throwaway origin), and `writeGhShim`'s `matchRealBranch`
// option makes `headRefName` answer with the gateway's OWN pushed branch, so the ownership
// guard actually PASSES. `spawnReviewer` is hardcoded `false` inside `reviewCommand`'s own call
// to `runReview` (the deterministic keyword/proof floor, never an LLM) — the ONLY reason this
// is reachable offline at all. `materializeReviewWorktree` genuinely attempts a `git fetch` +
// `worktree add` against THIS repo's real checkout (see its own doc — `reviewCommand` has no
// injectable seam here), but the fixture's branch was never pushed to the REAL github.com
// origin, so that add fails fast and gracefully (a named `MaterializationFailure`, never a
// throw) and review falls back to keyword-only, exactly as it does for any operator's
// `rmd review` run against a checkout with no matching ref.
test("GUARDED SITE approve fresh-clone + full drive: ensureRepoDir clones, and the run reaches ci-green + review + the post-arm cleanup", async () => {
  const bare = makeOrigin(undefined);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-appfullhome-"));
  const root = mkdtempSync(join(tmpdir(), "cmdsite-appfullroot-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-appfullshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root }, null, 2),
      "utf8",
    );
    process.env.HOME = home;
    writeGhShim(shimDir, bare, { matchRealBranch: true });
    process.env.PATH = `${shimDir}:${savedPath}`;

    // Deliberately NO pre-clone here (the one thing every other approve fixture does) — this is
    // the whole point: `config.root/repos/<repo>` starts absent, so the real gateway's own
    // `ensureRepoDir` performs the `mkdirSync` + `gh repo clone` itself.

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify({ proposals: [{ id: "P-FULL", summary: "full-drive fixture", evidenceAnchors: [] }] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(root, "state", "inbox-drafts.json"),
      JSON.stringify({
        "P-FULL": {
          proposalId: "P-FULL",
          fragmentYaml:
            "- id: NEW-1\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
          stampLine: "- P-FULL (plan) — RATIFIED -> NEW-1.",
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );

    const code = await withLiveWritesAllowed(() => approveCommand(["P-FULL"], { config: { claudeBin: "/usr/bin/true", root } as never }));

    // ensureRepoDir really cloned it (never pre-created by this test).
    const repoDir = join(root, "repos", "remudero");
    assert.ok(existsSync(join(repoDir, ".git")), "ensureRepoDir must have cloned repoDir itself");

    const ledgerLines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Past the ownership guard (this run's own branch, unlike the pr-create test above, which
    // leaves it unset and so refuses) — `pr.opened` only logs once ownership clears.
    const opened = ledgerLines.find((l) => l.step === "pr.opened");
    assert.ok(opened, `expected a pr.opened ledger line; steps=${JSON.stringify(ledgerLines.map((l) => l.step))}`);
    assert.equal(opened?.adopted, false, "a fresh PROCEED PR is never adopted");
    // No approve.error — the run reached its own return, never an uncaught throw.
    assert.ok(!ledgerLines.some((l) => l.step === "approve.error"), "the full drive must not throw");
    // The worktree this run created is gone — proof `removeApproveWorktree()` actually ran
    // AFTER the arm attempt (the post-review cleanup this test exists to reach), not merely
    // defined.
    const worktrees = existsSync(join(root, "worktrees")) ? readdirSync(join(root, "worktrees")).filter((d) => d.startsWith("run-")) : [];
    assert.deepEqual(worktrees, [], `expected the approve run's own worktree to be removed; found ${JSON.stringify(worktrees)}`);
    // reviewCommand always returns a number; the CLI's own exit code is that number verbatim.
    assert.equal(typeof code, "number");
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── W1-T903 — approveCommand's REAL gateway: RESUME (findPushedBranch confirmed, no PR found,
// completeRatificationBranch checks the pushed branch out and reads its ALREADY-filed ids) ────
// A prior run's OWN ledger evidence (`priorApproveRunBranch`) plus a real remote read is what
// `findPushedBranch` requires — this seeds both: a ledger line shaped exactly like the one
// `approveCommand`'s own `log()` appends, and an already-pushed branch (with a CONCRETE id
// already committed, never a placeholder) on the SAME throwaway origin the fresh gateway
// clones from. `writeGhShim`'s default `pulls?head=` probe answers `[]` (no PR found), so
// `approveProposal` (lib/inbox.ts) falls to COMPLETE, never ADOPT — the only way to drive
// `completeRatificationBranch` itself (checkout, no re-mint, filed-id extraction from the
// branch's own diff) rather than a fresh `createRatificationBranch`.
test("GUARDED SITE approve resume: findPushedBranch/completeRatificationBranch drive the REAL RESUME gateway", async () => {
  const bare = makeOrigin(undefined);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-appresumehome-"));
  const root = mkdtempSync(join(tmpdir(), "cmdsite-appresumeroot-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-appresumeshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root }, null, 2),
      "utf8",
    );
    process.env.HOME = home;
    writeGhShim(shimDir, bare, { matchRealBranch: true });
    process.env.PATH = `${shimDir}:${savedPath}`;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(root, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // A PRIOR run's branch, already pushed to the SAME origin, carrying a CONCRETE id (never
    // NEW-1 — completeRatificationBranch must read it back as-is, no re-mint).
    const priorBranch = "run-APPROVE-P-RESUME-1700000000000";
    const priorClone = mkdtempSync(join(tmpdir(), "cmdsite-appresumeprior-"));
    execFileSync("git", ["clone", "--quiet", bare, priorClone], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", priorClone, "checkout", "--quiet", "-b", priorBranch], { encoding: "utf8", env: GIT_ENV });
    appendFileSync(join(priorClone, "plan", "tasks.yaml"), VALID_TASK("W1-T50", "filed by a prior approve run"));
    execFileSync("git", ["-C", priorClone, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", priorClone, "commit", "--quiet", "-m", "chore(plan): ratify P-RESUME via rmd approve"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    execFileSync("git", ["-C", priorClone, "push", "--quiet", "origin", priorBranch], { encoding: "utf8", env: GIT_ENV });
    rmSync(priorClone, { recursive: true, force: true });

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify({ proposals: [{ id: "P-RESUME", summary: "resume fixture", evidenceAnchors: [] }] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(root, "state", "inbox-drafts.json"),
      JSON.stringify({
        "P-RESUME": {
          proposalId: "P-RESUME",
          fragmentYaml:
            "- id: NEW-1\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
          stampLine: "- P-RESUME (plan) — RATIFIED -> NEW-1.",
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );
    // The ledger evidence `priorApproveRunBranch` reads — shaped exactly like the run this
    // branch was really pushed by would have appended (run_id `APPROVE-<id>-<epoch>`, task_id
    // the proposal id). `priorApproveRunBranch` keys ONLY on `run_id`/`task_id`, never `step` —
    // NEVER `ratify.approved` here: that step is what marks a proposal ALREADY RATIFIED
    // (`ledgerAlreadyApproved`, lib/inbox.ts) and would refuse this approve before either
    // gateway method fires, the opposite of what this fixture needs. `worktree.prune` is the
    // step the PRIOR run's own `createRatificationBranch` really appends first.
    writeFileSync(
      join(root, "state", "ledger.ndjson"),
      JSON.stringify({ run_id: "APPROVE-P-RESUME-1700000000000", task_id: "P-RESUME", step: "worktree.prune", lane: "approve" }) + "\n",
      "utf8",
    );

    await withLiveWritesAllowed(() => approveCommand(["P-RESUME"], { config: { claudeBin: "/usr/bin/true", root } as never })).catch(
      () => undefined,
    );

    const ledgerLines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // COMPLETE, never ADOPT/PROCEED: exactly one `pr.opened`, on the PRIOR branch, and no
    // SECOND run- branch (a fresh createRatificationBranch) ever reached the origin.
    const opened = ledgerLines.filter((l) => l.step === "pr.opened");
    assert.equal(opened.length, 1, `expected exactly one pr.opened line; steps=${JSON.stringify(ledgerLines.map((l) => l.step))}`);
    assert.equal(opened[0]?.branch, priorBranch, "the resumed run must open its PR on the PRIOR branch, never a new one");
    const refs = execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
    const runBranches = refs.split("\n").filter((l) => l.startsWith("run-"));
    assert.deepEqual(runBranches, [priorBranch], `expected no second branch to reach the origin; refs=${JSON.stringify(runBranches)}`);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

/** Shared setup for the two ownership-passed, post-`result.ok` cleanup-branch drives below —
 *  both need a pre-cloned `repoDir`, a READY `NEW-1` proposal, and `matchRealBranch` (the
 *  ownership guard must PASS so execution reaches PAST it, unlike the plain pr-create test
 *  above), differing only in what `gh` answers once it does. */
async function withApproveFullHarness(
  proposalId: string,
  shimOpts: { ciConclusion?: string; failPrDiff?: boolean },
  drive: (root: string) => Promise<number | undefined>,
): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin(undefined);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-appcleanhome-"));
  const root = mkdtempSync(join(tmpdir(), "cmdsite-appcleanroot-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-appcleanshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root }, null, 2), "utf8");
    process.env.HOME = home;
    writeGhShim(shimDir, bare, { matchRealBranch: true, ...shimOpts });
    process.env.PATH = `${shimDir}:${savedPath}`;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(root, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify({ proposals: [{ id: proposalId, summary: "cleanup-branch fixture", evidenceAnchors: [] }] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(root, "state", "inbox-drafts.json"),
      JSON.stringify({
        [proposalId]: {
          proposalId,
          fragmentYaml:
            "- id: NEW-1\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
          stampLine: `- ${proposalId} (plan) — RATIFIED -> NEW-1.`,
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );

    await drive(root);

    return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

// ── run-task.ts's `if (ci !== "green") { ...; removeApproveWorktree(); return 1; }` ─────────
// The full-drive test above resolves `ci` GREEN on its first poll, so it never reaches THIS
// branch. `ciConclusion: "FAILURE"` makes `waitForCiGreen` return RED on that same first poll
// instead — the run never reaches `reviewCommand` at all, but does reach its own
// cleanup-and-return-1 immediately after ownership clears.
test("GUARDED SITE approve ci-red: the REAL gateway reaches the ci!==green cleanup branch", async () => {
  let code: number | undefined;
  const ledgerLines = await withApproveFullHarness("P-CIRED", { ciConclusion: "FAILURE" }, async (root) => {
    code = await withLiveWritesAllowed(() => approveCommand(["P-CIRED"], { config: { claudeBin: "/usr/bin/true", root } as never }));
    return code;
  });
  assert.equal(code, 1, "a red ci must exit 1 (the PR is left open for inspection, never armed)");
  assert.ok(ledgerLines.some((l) => l.step === "ci.stalled" || l.step === "pr.opened"), "the run must have reached past ownership");
  assert.ok(!ledgerLines.some((l) => l.step === "approve.error"), "a red ci is a clean return, never a throw");
});

// ── run-task.ts's `catch (e) { ...; removeApproveWorktree(); throw e; }` ────────────────────
// Neither drive above ever throws PAST `result.ok` (the full-success test completes cleanly;
// the ci-red test returns 1 cleanly) — this is the only remaining branch: `gh pr diff` (inside
// `runReview`, called only once `ci` IS green) fails non-zero, an exception `reviewCommand`
// does not itself catch, unwinding through approveCommand's own `catch` — proving it removes
// the worktree/run-lock and RE-THROWS, rather than swallowing a genuine mid-review failure.
test("GUARDED SITE approve review-throws: the REAL gateway reaches the catch-cleanup-and-rethrow branch", async () => {
  let threw: unknown;
  const ledgerLines = await withApproveFullHarness("P-REVTHROW", { failPrDiff: true }, async (root) => {
    await withLiveWritesAllowed(() => approveCommand(["P-REVTHROW"], { config: { claudeBin: "/usr/bin/true", root } as never })).catch(
      (e) => {
        threw = e;
      },
    );
    return undefined;
  });
  assert.ok(threw, "a mid-review gh failure must unwind all the way out of approveCommand, never resolve silently");
  assert.ok(ledgerLines.some((l) => l.step === "approve.error"), "the catch block's own ledger line must have fired");
  assert.ok(ledgerLines.some((l) => l.step === "pr.opened"), "the throw happened AFTER the PR opened (mid-review), not before");
});

// ── run-task.ts:12761-12775 and :12841-12855 — approveCommand's REAL gateway on a DEGRADED
// mint (W1-T311) ───────────────────────────────────────────────────────────────────────────
// The success test above proves the mint+reserve closures execute; this one proves the
// REFUSAL path they guard: `gh pr list` (the mint's `openPrTexts` enumerator) fails, so
// mintNextTaskIdWithHistory reports a degraded source, materializeDraftTaskIds refuses, and
// createRatificationBranch's real (un-injected) gateway throws BEFORE any write/commit/push —
// caught by approveCommand's own catch, which removes the worktree/run-lock and rethrows.
// Offline throughout, same fixture shape as the success test above.
test("GUARDED SITE approve degraded-mint refusal: the REAL gateway throws before any write and approveCommand cleans up + rethrows", async () => {
  const bare = makeOrigin(undefined);
  const home = mkdtempSync(join(tmpdir(), "cmdsite-apphome2-"));
  const root = mkdtempSync(join(tmpdir(), "cmdsite-approot2-"));
  const shimDir = mkdtempSync(join(tmpdir(), "cmdsite-appshim2-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root }, null, 2),
      "utf8",
    );
    process.env.HOME = home;
    writeGhShim(shimDir, bare, { failPrList: true });
    process.env.PATH = `${shimDir}:${savedPath}`;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(root, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox-proposals.json"),
      JSON.stringify({ proposals: [{ id: "P-DEGRADE", summary: "degraded-mint fixture", evidenceAnchors: [] }] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(root, "state", "inbox-drafts.json"),
      JSON.stringify({
        "P-DEGRADE": {
          proposalId: "P-DEGRADE",
          fragmentYaml:
            "- id: NEW-1\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
          stampLine: "- P-DEGRADE (plan) — RATIFIED -> NEW-1.",
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );

    let threw: unknown;
    await withLiveWritesAllowed(() => approveCommand(["P-DEGRADE"], { config: { claudeBin: "/usr/bin/true", root } as never })).catch(
      (e) => {
        threw = e;
      },
    );
    assert.ok(threw, "a degraded mint must throw all the way out of approveCommand, never succeed silently");
    assert.match(String((threw as Error)?.message ?? threw), /refusing to materialize task id/i);

    // Nothing reached the origin — the throw happened before the gateway's commit/push.
    const refs = execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
    assert.doesNotMatch(refs, /run-/, `no ratification branch may reach the origin on a refusal; refs=${JSON.stringify(refs)}`);

    // approveCommand's catch removed the worktree it had already created (best-effort cleanup,
    // run-task.ts:12843-12854) rather than leaving an orphaned directory behind.
    const worktrees = existsSync(join(root, "worktrees")) ? readdirSync(join(root, "worktrees")) : [];
    assert.deepEqual(worktrees, [], `expected the refused run's worktree to be removed; found ${JSON.stringify(worktrees)}`);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── run-task.ts:7348 — the SWEEP fix rung's best-effort push ─────────────────────────
// The last of PR #954's guarded call sites with no coverage. `buildSweepEffects().dispatchFix`
// drives `runFixRung`, which calls `deps.push(...)` once the fix worker returns. That spawn
// was hardcoded until now; it is injectable here for exactly the reason `reviewRunner` beside
// it already is. Offline: a bare TMPDIR origin carrying the run branch, a gh shim, and a fake
// spawn. The push is real and lands in that origin, so the drive is exempted.
test("GUARDED SITE sweep fix-rung push: dispatchFix drives runFixRung to its best-effort push", async () => {
  const TASK = "W1-TSWEEP";
  const branch = `run-${TASK}-1785100000003`;
  const bare = mkdtempSync(join(tmpdir(), "sweepfix-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "sweepfix-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(seed, "work.txt"), "work\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "work");
  git(seed, "push", "--quiet", "origin", branch);
  rmSync(seed, { recursive: true, force: true });

  const root = mkdtempSync(join(tmpdir(), "sweepfix-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "sweepfix-shim-"));
  const savedPath = process.env.PATH;
  try {
    const repoDir = join(root, "repos", "sandboxrepo");
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"headRefName"*) printf '{"headRefName":"%s"}\\n' "${branch}" ;;`,
        '  *"statusCheckRollup"*) echo \'{"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}]}\' ;;',
        '  *"--json state"*) echo \'{"state":"OPEN"}\' ;;',
        '  *"--json body"*) echo \'{"body":""}\' ;;',
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    let fixSpawns = 0;
    const steps: string[] = [];
    const effects = buildSweepEffects(
      "acme",
      "sandboxrepo",
      { claudeBin: "/usr/bin/true", root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-FIX-1",
      { tasks: [{ id: TASK, title: "sweep fixture", repo: "sandboxrepo", type: "implement", risk: "low", verify: "auto", status: "queued", attempts: 0, depends_on: [] }] } as never,
      (step, extra) => { steps.push(`${step} ${JSON.stringify(extra ?? {})}`); },
      undefined,
      undefined,
      async () => {
        fixSpawns += 1;
        return fakeWorker("REPORT\nfix applied\n");
      },
    );

    try {
      await withLiveWritesAllowed(() =>
        effects.dispatchFix(
          { prNumber: 7, prUrl: "https://github.com/acme/sandboxrepo/pull/7", taskId: TASK, reviewState: "failure" } as never,
          { unmetCriteria: [{ claim: "c1", proof: "unit test: p", met: false, why: "unmet" }], ciFailures: [] } as never,
        ),
      );
    } catch {
      /* the rung may end non-zero once the fix worker returns — reaching it is the assertion */
    }

    assert.ok(fixSpawns >= 1, `fixSpawns=${fixSpawns} steps=${JSON.stringify(steps)}`);
  } finally {
    process.env.PATH = savedPath;
    for (const d of [bare, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── W1-T921: THE CLOSE MUST NOT DELETE THE HEAD BRANCH ───────────────────────────────
// DECISIONS.md's 2026-08-16 ruling (W1-T919) gates the fleet on IRREVERSIBILITY rather than
// outwardness, and rests that on closing preserving the head branch while merging destroys it.
// #1873 (closed, branch intact) vs #1874 (merged, branch taken) is the measured pair — but #1873
// was closed BY A HUMAN, and the fleet's own close carried `--delete-branch` until this change.
//
// THE ASSERTION IS THE ARGUMENT VECTOR, AND IT IS A PAIR. A single "close keeps the branch" read
// cannot tell "survived a closure" from "survives generally", which is the control failure the
// ruling itself records. So both acts are driven through one recording `gh` shim and shown to
// DIFFER: the close carries no `--delete-branch`; the merge still does. The second direction is
// mandatory — W1-T447 wants merged branches reaped, and this must not regress that.
function recordingGhShim(dir: string, logPath: string): void {
  writeFileSync(
    join(dir, "gh"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
}

test("W1-T921: a sweep close does not delete the head branch", () => {
  const root = mkdtempSync(join(tmpdir(), "w1t921-close-"));
  const captured: string[][] = [];
  try {
    const effects = buildSweepEffects(
      "acme",
      "sandboxrepo",
      { claudeBin: "/usr/bin/true", root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-CLOSE-1",
      { tasks: [] } as never,
      () => {},
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      (file, args) => { captured.push([file, ...args]); },
    );
    effects.close(
      { prNumber: 42, prUrl: "https://github.com/acme/sandboxrepo/pull/42" } as never,
      "superseded-by #43",
    );
    assert.equal(captured.length, 1, `expected one gh invocation, got ${JSON.stringify(captured)}`);
    const argv = captured[0];
    assert.ok(argv.includes("close"), `not a close invocation: ${JSON.stringify(argv)}`);
    assert.ok(
      !argv.includes("--delete-branch"),
      `the fleet close must not delete the head branch — argv was ${JSON.stringify(argv)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T921: a merge still deletes its branch", () => {
  const shimDir = mkdtempSync(join(tmpdir(), "w1t921-merge-shim-"));
  const logPath = join(shimDir, "argv.log");
  const savedPath = process.env.PATH;
  try {
    recordingGhShim(shimDir, logPath);
    process.env.PATH = `${shimDir}:${savedPath}`;
    withLiveWritesAllowed(() => ghPrMergeSquash("https://github.com/acme/sandboxrepo/pull/44"));
    const merged = readFileSync(logPath, "utf8").trim();
    assert.ok(merged.includes("pr merge"), `not a merge invocation: ${merged}`);
    assert.ok(
      merged.includes("--delete-branch"),
      `the merge path must keep deleting its branch (W1-T447) — argv was ${merged}`,
    );
  } finally {
    process.env.PATH = savedPath;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("W1-T921: the close argv is pinned against silent reinstatement", () => {
  const root = mkdtempSync(join(tmpdir(), "w1t921-pin-"));
  const captured: string[][] = [];
  try {
    const effects = buildSweepEffects(
      "acme",
      "sandboxrepo",
      { claudeBin: "/usr/bin/true", root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-CLOSE-2",
      { tasks: [] } as never,
      () => {},
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      (file, args) => { captured.push([file, ...args]); },
    );
    effects.close(
      { prNumber: 7, prUrl: "https://github.com/acme/sandboxrepo/pull/7" } as never,
      "superseded-by #8",
    );
    assert.deepEqual(captured[0], [
      "gh",
      "pr",
      "close",
      "https://github.com/acme/sandboxrepo/pull/7",
      "--comment",
      "Closed by rmd sweep: superseded-by #8",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The three cases above all INJECT `ghRunImpl`, which would leave its DEFAULT body — the real
// `execFileSync` — unreachable, the exact shape CLAUDE.md records from #978 (every test supplies
// its own seam, so the default and its catch arm never run). This one takes the default and really
// shells out, against a recording `gh` shim on PATH rather than the live one.
test("W1-T921: the default close runner really shells out and still omits the flag", () => {
  const root = mkdtempSync(join(tmpdir(), "w1t921-default-"));
  const shimDir = mkdtempSync(join(tmpdir(), "w1t921-default-shim-"));
  const logPath = join(shimDir, "argv.log");
  const savedPath = process.env.PATH;
  try {
    recordingGhShim(shimDir, logPath);
    process.env.PATH = `${shimDir}:${savedPath}`;
    const effects = buildSweepEffects(
      "acme",
      "sandboxrepo",
      { claudeBin: "/usr/bin/true", root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-CLOSE-3",
      { tasks: [] } as never,
      () => {},
    );
    effects.close(
      { prNumber: 9, prUrl: "https://github.com/acme/sandboxrepo/pull/9" } as never,
      "superseded-by #10",
    );
    const argv = readFileSync(logPath, "utf8").trim();
    assert.ok(argv.includes("pr close"), `the default runner did not shell out: ${argv}`);
    assert.ok(!argv.includes("--delete-branch"), `default runner reinstated the flag: ${argv}`);
  } finally {
    process.env.PATH = savedPath;
    for (const d of [root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});
