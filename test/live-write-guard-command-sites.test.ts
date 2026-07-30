import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { approveCommand, planCommand, triageCommand } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
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
 *  OWN branch so the run-ownership guard passes. */
function writeGhShim(dir: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      "# $* is the full argv; branch name is embedded in --head for create, else derived.",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      '  *"pr create"*)',
      '    echo "https://github.com/craigoley/remudero/pull/4242" ;;',
      '  *"headRefName"*)',
      '    # echo back whatever branch the caller is on, read from the shim env',
      '    printf \'{"headRefName":"%s"}\\n\' "${RMD_SHIM_BRANCH:-main}" ;;',
      '  *"--json body"*) echo \'{"body":""}\' ;;',
      '  *"pr diff"*) echo "" ;;',
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

    writeGhShim(shimDir);
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
    writeGhShim(shimDir);
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
            "- id: W1-TGUARD\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n",
          stampLine: "- P-GUARD (plan) — RATIFIED -> W1-TGUARD.",
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
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, root, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});
