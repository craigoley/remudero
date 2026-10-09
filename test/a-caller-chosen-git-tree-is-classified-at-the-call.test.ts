// @source-text-subject: this census reads each helper's callers from src/ as text — the call sites ARE its subject.
/**
 * W1-T6136 — A CALLER-CHOSEN GIT TREE IS CLASSIFIED AT THE CALL.
 *
 * W1-T6123's widened census recorded fifteen git sites in nine files as CALLER: a helper that runs git
 * in whatever tree its caller passes. Each helper's production callers are now read and recorded here
 * with the tree they pass. Where any caller passes a tree a worker wrote, the helper runs git through
 * the hardened leaf; where every caller passes a harness-owned tree, the census entry is CHECKOUT.
 *
 * The caller lists are EXACT: a new production reference to a helper fails here until it is classified,
 * so a caller handing a worker worktree to a CHECKOUT helper cannot land unread.
 *
 * FIXTURES ONLY: every hostile byte is a `touch` of a marker under this suite's mkdtemp root, and the
 * planted route is proven live by a raw `git -C` control first.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { readAffectedSuitesInput } from "../src/lib/affected-suites.js";
import type { Config } from "../src/lib/config.js";
import { sweepReclaimableArtifacts } from "../src/lib/disk-artifact-reclaim.js";
import { probeSealedIsolation } from "../src/lib/paired-trial.js";
import { applyPlanProposalCommit } from "../src/lib/plan-architect.js";
import { certainStaleProofs } from "../src/lib/proof-base-stale.js";
import { stripComments } from "../src/lib/test-impact-map.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { WorktreePointerRefusedError } from "../src/lib/worktree-git.js";
import { functionBody, widenedGitSites, WIDENED_SITE_EXCEPTIONS } from "./every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ID = GIT_REPO_FIXTURE_IDENTITY;

interface CallerRecord {
  /** The file W1-T6123 recorded as CALLER. */
  file: string;
  /** The helper whose git site it is. */
  helper: string;
  /** The exported entry production code reaches the helper through (the helper itself, or its in-file wrapper). */
  via: string[];
  /** Every other src/ or scripts/ file that references an entry in `via`, exactly. */
  callers: string[];
  /** The tree the callers pass, and so the decision. */
  tree: string;
  decision: "leaf" | "CHECKOUT";
}

const RECORDS: readonly CallerRecord[] = [
  {
    file: "src/lib/affected-suites.ts", helper: "readAffectedSuitesInput", via: ["readAffectedSuitesInput"],
    callers: ["scripts/preflight-author.mjs", "scripts/select-affected-suites.mjs", "scripts/test-tier-manifest.mjs", "src/lib/ci-escalation-judge.ts", "src/lib/ci-parity.ts", "src/lib/selector-shadow-gardener.ts", "src/run-task.ts"],
    tree: "WORKTREE: run-task.ts coveragePrecheck passes the worker worktree; ci-escalation-judge.ts passes the daemon checkout; the rest (test-tier-manifest.mjs's merge_group selection included) pass a repo root", decision: "leaf",
  },
  {
    file: "src/lib/containment.ts", helper: "defaultExecutor", via: ["probeContainment"], callers: ["src/run-task.ts"],
    tree: "CHECKOUT: defaultExecutor git-inits the <root>/tmp/containment-probe-<token>/cwd it mkdirs itself", decision: "CHECKOUT",
  },
  {
    file: "src/lib/disk-artifact-reclaim.ts", helper: "defaultCountDirtyFiles", via: ["sweepReclaimableArtifacts"],
    callers: ["src/lib/daemon.ts", "src/run-task.ts"],
    tree: "WORKTREE: any .git-holding directory beside the managed root, a worktree included (daemon.ts runs the seam run-task.ts binds)",
    decision: "leaf",
  },
  {
    file: "src/lib/inbox.ts", helper: "gitGrepAnchorTrue", via: ["gitGrepAnchorTrue", "gitGrepAnchorTrueAsync"],
    callers: ["src/lib/panel-graph.ts", "src/lib/status-board.ts", "src/run-task.ts"],
    tree: "CHECKOUT: run-task.ts's repoRoot, status-board's deps.repoDir, panel-graph's deps.root, at origin/main", decision: "CHECKOUT",
  },
  {
    file: "src/lib/paired-trial.ts", helper: "gitProbe", via: ["sealedPairedAttemptDispatcher", "probeSealedIsolation"], callers: ["src/run-task.ts"],
    tree: "WORKTREE: the sealed attempt tree a worker just ran in (and the fleet clone it was cut from)", decision: "leaf",
  },
  {
    file: "src/lib/plan-architect.ts", helper: "gitAddAndCommitWithRollback", via: ["applyPlanProposalCommit", "gitAddAndCommitWithRollback"],
    callers: ["src/run-task.ts"],
    tree: "WORKTREE: run-task.ts's triage and `rmd plan` propose branches commit the planner worker's worktreePath", decision: "leaf",
  },
  {
    file: "src/lib/plan-pr-merge-safety.ts", helper: "planSafetyGitSync", via: ["planSafetyGitSync", "planSafetyGitAsync"],
    callers: ["src/lib/arm-auto-merge.ts"],
    tree: "CHECKOUT: arm-auto-merge.ts planMergeSafetyInClone binds them to <root>/repos/<repo>", decision: "CHECKOUT",
  },
  {
    file: "src/lib/proof-base-stale.ts", helper: "certainStaleProofs", via: ["certainStaleProofs"],
    callers: ["scripts/proof-resolve-precheck.mjs", "src/run-task.ts"],
    tree: "WORKTREE: the harness pre-push gate's proof-resolve-precheck passes the worktree being pushed", decision: "leaf",
  },
  {
    file: "src/lib/status.ts", helper: "buildCommitTrailerIndex", via: ["buildCommitTrailerIndex", "buildGitLogSupersessionSearch"],
    callers: ["src/run-task.ts"],
    tree: "CHECKOUT: the process cwd, run-task.ts's repoRoot or <root>/repos/<repo>; buildGitLogSupersessionSearch is unwired",
    decision: "CHECKOUT",
  },
];

/** Every .ts/.mjs file under src/ and scripts/, repo-relative. */
function codeFiles(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return codeFiles(rel);
    return e.isFile() && /\.(?:ts|mjs)$/.test(e.name) ? [rel] : [];
  });
}

/** `text` with its comments and import statements removed, so a reference is a use. */
function uses(text: string): string {
  return stripComments(text).replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?/gm, "");
}

let root: string;
let markers: string;
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const marker = (name: string): string => join(markers, name);
const isRefusal = (e: unknown): boolean => e instanceof WorktreePointerRefusedError;

/** A seeded origin + checkout whose TRACKED hooks/ leave a marker, and a lane cut from it by the real `worktreeAdd`. */
function cutLane(at: string): { wt: string; seed: string; head: string; n: number } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6136-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6136-seed-${n}` });
  seed.git("config", "user.email", ID.email);
  seed.git("config", "user.name", ID.name);
  mkdirSync(join(seed.dir, "hooks"));
  for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
    writeFileSync(join(seed.dir, "hooks", hook), `#!/bin/sh\ntouch '${marker(`tracked-${hook}-${n}`)}'\n`);
    chmodSync(join(seed.dir, "hooks", hook), 0o755);
  }
  mkdirSync(join(seed.dir, "plan"));
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T1 # alpha-anchor\n");
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# plan\n");
  writeFileSync(join(seed.dir, ".gitignore"), "node_modules/\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  worktreeAdd(seed.dir, at, `run-T6136-${n}-1`, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  return { wt: at, seed: seed.dir, head: seed.git("rev-parse", "HEAD"), n };
}

/** Repoint the lane's `.git` at a CLONE of its seed (so every rev resolves there too) whose config runs a
 *  marker on every index refresh and from every hook. */
function plantPointer(wt: string, seed: string, name: string): string {
  const evil = join(root, `planted-${name}`);
  execFileSync("git", ["clone", "-q", seed, evil], { stdio: "ignore" });
  const hooks = join(evil, "evil-hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker(`planted-hook-${name}`)}'\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  raw(evil, "config", "core.fsmonitor", `sh -c 'touch "${marker(`planted-fsmonitor-${name}`)}"'`);
  raw(evil, "config", "core.hooksPath", hooks);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  return evil;
}

/** worktreeAdd LINKS node_modules to the harness's own; the sweep candidate is replaced by an empty directory
 *  of the fixture's, so nothing this suite does can reach the real tree (removeDir also refuses). */
function ownNodeModules(wt: string): void {
  rmSync(join(wt, "node_modules"), { force: true });
  mkdirSync(join(wt, "node_modules"));
}

const STALE = [{ claim: "c", proof: "grep: alpha-anchor in plan/tasks.yaml" }];
const scanConfig = (dir: string) => ({ root: join(dir, "state") }) as unknown as Config;
const sweep = (dir: string) => sweepReclaimableArtifacts(scanConfig(dir), () => {}, {
  scanRoot: () => dir, freeBytes: () => 0, graceMs: Number.MAX_SAFE_INTEGER,
  removeDir: () => assert.fail("nothing is reclaimed in this fixture"),
});

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6136-`));
  markers = join(root, "markers");
  mkdirSync(markers);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("W1-T6136: every CALLER-class git site is classified at its callers", () => {
  it("no widened exception keeps the CALLER class, and each of the nine is converted or CHECKOUT", () => {
    assert.deepEqual(Object.entries(WIDENED_SITE_EXCEPTIONS).filter(([, e]) => /^CALLER\b/.test(e.reason)).map(([f]) => f), []);
    assert.equal(RECORDS.length, 9, "positive control: all nine files W1-T6123 recorded as CALLER are read");
    for (const r of RECORDS) {
      const entry = WIDENED_SITE_EXCEPTIONS[r.file];
      if (r.decision === "leaf") {
        assert.equal(entry, undefined, `${r.file}: a converted file keeps no widened exception`);
      } else {
        assert.ok(entry && entry.count > 0, `${r.file}: a CHECKOUT site keeps its count`);
        assert.match(entry.reason, /^CHECKOUT \(W1-T6136\): /, `${r.file}: reasoned CHECKOUT`);
        assert.ok(r.via.some((v) => entry.reason.includes(v)) || entry.reason.includes(r.helper), `${r.file}: the reason names its helper`);
      }
    }
  });

  it("each helper's production callers are exactly the ones recorded, and at least one is found", () => {
    const files = [...codeFiles("src"), ...codeFiles("scripts")];
    assert.ok(files.length > 400, `positive control: the walk sees src/ and scripts/, saw ${files.length}`);
    const texts = new Map(files.map((f) => [f, uses(readFileSync(join(REPO, f), "utf8"))]));
    for (const r of RECORDS) {
      const own = texts.get(r.file) ?? "";
      assert.ok(r.via.every((v) => new RegExp(`^export (?:async )?function\\*? ${v}\\(`, "m").test(own)), `${r.file}: every entry is exported`);
      const found = files.filter((f) => f !== r.file && r.via.some((v) => new RegExp(`(?<![\\w$])${v}(?![\\w$])`).test(texts.get(f)!)));
      assert.ok(found.length > 0, `${r.helper}: positive control — at least one production caller is found`);
      assert.deepEqual(found.sort(), [...r.callers].sort(), `${r.helper}: callers (${r.tree})`);
    }
  });

  it("a converted helper reaches the leaf and spawns no raw git; a CHECKOUT file's count is what is left", () => {
    for (const r of RECORDS) {
      const text = readFileSync(join(REPO, r.file), "utf8");
      if (r.decision === "leaf") {
        assert.equal(widenedGitSites(text).length, 0, `${r.file}: no raw git site is left`);
        const body = functionBody(text, r.helper) ?? "";
        assert.match(body, /\bhostWorktreeGit\(|\bleafPlanCommitGit\b/, `${r.file}: ${r.helper} reaches the hardened leaf`);
      } else {
        assert.equal(widenedGitSites(text).length, WIDENED_SITE_EXCEPTIONS[r.file]!.count, `${r.file}: the exception is exact`);
      }
    }
    assert.match(readFileSync(join(REPO, "src/lib/plan-architect.ts"), "utf8"), /leafPlanCommitGit: PlanCommitGit = [^;]*hostWorktreeGit\(/);
  });
});

describe("W1-T6136: a planted .git pointer reaches none of the converted helpers", () => {
  it("the control: a raw git -C diff in a lane pointing at the planted gitdir runs its fsmonitor", () => {
    const { wt, seed } = cutLane(join(root, "control-lane"));
    plantPointer(wt, seed, "control");
    raw(wt, "diff", "--name-only", "HEAD");
    assert.ok(existsSync(marker("planted-fsmonitor-control")), "control: the planted core.fsmonitor command is live");
  });

  it("each production caller's helper call refuses, writes no marker and reads nothing from the planted gitdir", () => {
    const scan = join(root, "planted-scan");
    mkdirSync(scan);
    const { wt, seed, head, n } = cutLane(join(scan, "lane"));
    const planted = plantPointer(wt, seed, "leaf");
    const plantedCommits = raw(planted, "rev-list", "--count", "HEAD").trim();
    ownNodeModules(wt);
    writeFileSync(join(wt, "MASTER-PLAN.md"), "# plan\n\nedited\n");

    assert.throws(() => readAffectedSuitesInput(wt, ["src/x.ts"]), isRefusal, "coveragePrecheck's listing refuses");
    assert.deepEqual(sweep(scan).kept.map((k) => [relative(scan, k.path), k.reason]), [["lane/node_modules", "unreadable"]],
      "a refused tree is unreadable, never clean");
    assert.throws(() => probeSealedIsolation({ repoDir: seed, dir: wt, base: head, text: "" }), isRefusal,
      "a refused attempt tree is never read as sealed");
    assert.throws(() => applyPlanProposalCommit(wt, "chore(plan): planted"), isRefusal, "the plan commit refuses");
    assert.deepEqual(certainStaleProofs(STALE, wt, head), [], "the base blob is never read from the planted gitdir");

    assert.equal(existsSync(marker("planted-fsmonitor-leaf")), false, "the planted fsmonitor never ran");
    assert.equal(existsSync(marker("planted-hook-leaf")), false, "no planted hook ran");
    for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
      assert.equal(existsSync(marker(`tracked-${hook}-${n}`)), false, `the tracked ${hook} never ran`);
    }
    assert.equal(raw(planted, "rev-list", "--count", "HEAD").trim(), plantedCommits, "nothing was committed into the planted gitdir");
  });
});

describe("W1-T6136: on an intact lane the converted helpers behave as before", () => {
  it("counts, probes, commits and reads the base blob, running none of the tracked hooks", () => {
    const scan = join(root, "intact-scan");
    mkdirSync(scan);
    const { wt, seed, head, n } = cutLane(join(scan, "lane"));
    ownNodeModules(wt);

    assert.deepEqual(sweep(scan).kept.map((k) => [relative(scan, k.path), k.reason]), [["lane/node_modules", "too-young"]],
      "a clean lane reads clean through the leaf and reaches the age gate");
    const reading = probeSealedIsolation({ repoDir: seed, dir: wt, base: head, text: "" });
    assert.match(reading.breach ?? "", /^branch-write:refs\/heads\/run-T6136-/, "the probe reads the lane's own branch");
    assert.equal(certainStaleProofs(STALE, wt, head).length, 1, "the same grep matches at the base, read through the leaf");

    writeFileSync(join(wt, "MASTER-PLAN.md"), "# plan\n\nedited\n");
    applyPlanProposalCommit(wt, "chore(plan): intact");
    assert.equal(raw(wt, "log", "-1", "--format=%s").trim(), "chore(plan): intact");
    assert.equal(raw(wt, "status", "--porcelain").trim(), "");
    for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
      assert.equal(existsSync(marker(`tracked-${hook}-${n}`)), false, `the tracked ${hook} never ran`);
    }
  });
});
