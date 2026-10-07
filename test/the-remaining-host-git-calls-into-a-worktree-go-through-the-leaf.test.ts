/**
 * W1-T6122 — THE REMAINING HOST GIT CALLS INTO A WORKTREE GO THROUGH THE LEAF.
 *
 * W1-T6106 left 36 raw `git -C <worktree>` argv outside src/run-task.ts. Each is classed by what
 * wrote the tree it addresses: WORKER and REVIEWER trees (the sweep's fix-round reads, the retro's
 * citation commit and orientation regeneration, relint's filing reads, the reviewer tree's HEAD
 * reads, the node_modules exclude) now run through `hostWorktreeGit`; the HARNESS-only ones (the
 * worktree cut itself, the sweep's own plan-PR trees cut from origin/main) stay raw with a reason.
 *
 * FIXTURES ONLY: every hostile byte is a `touch` of a marker under this suite's own mkdtemp root,
 * in repositories that root holds. The planted route is proven LIVE by a raw `git -C` control, so a
 * marker that stays absent through the converted paths is evidence, not an inert fixture.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeRealDeps } from "../src/lib/composition-root.js";
import type { Config } from "../src/lib/config.js";
import { regenerateOrientation } from "../src/lib/orientation.js";
import { newMonolithIdsAgainstBase } from "../src/lib/relint.js";
import { buildGather, captureCitationBaselines, stampCitationsAndCommit } from "../src/lib/retro.js";
import { sweepStrandedReviewWorktrees } from "../src/lib/review-worktree-reclaim.js";
import { headIsInWorktree, readBaselineRatchetWorktreeState } from "../src/lib/sweep.js";
import { excludeNodeModulesFromGit, worktreeAdd } from "../src/lib/worker.js";
import { WorktreePointerRefusedError } from "../src/lib/worktree-git.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ID = GIT_REPO_FIXTURE_IDENTITY;

let root: string;
let markers: string;
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function marker(name: string): string {
  return join(markers, name);
}

const SHARD = ["- id: entry-a", "  subsystem: test", "  lifecycle: active", "  files: [x]", "  fact: f", "  src: test",
  '  cited: "2026-07-14"', ""].join("\n");
const TASK = (id: string): string => [`- id: ${id}`, '  title: "t"', "  repo: remudero", "  depends_on: []", "  type: implement",
  "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n");
const TASKS = TASK("W1-T1");

/** A seeded origin + checkout whose TRACKED hooks/ leave a marker, and a lane cut from it by the real
 *  `worktreeAdd` (which records the gitdir and wires `core.hooksPath=hooks`). */
function cutLane(at?: string): { wt: string; n: number } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6122-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6122-seed-${n}` });
  seed.git("config", "user.email", ID.email);
  seed.git("config", "user.name", ID.name);
  mkdirSync(join(seed.dir, "hooks"));
  for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
    writeFileSync(join(seed.dir, "hooks", hook), `#!/bin/sh\ntouch '${marker(`tracked-${hook}-${n}`)}'\n`);
    chmodSync(join(seed.dir, "hooks", hook), 0o755);
  }
  mkdirSync(join(seed.dir, "learnings"));
  mkdirSync(join(seed.dir, "plan"));
  writeFileSync(join(seed.dir, "learnings", "a.yaml"), SHARD);
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), TASKS);
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# plan\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = at ?? join(root, `t6122-wt-${n}`);
  worktreeAdd(seed.dir, wt, `run-T6122-${n}-1`, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  return { wt, n };
}

/** Rewrite the lane's `.git` pointer to a crafted gitdir (with one commit, so HEAD resolves) whose
 *  config runs a marker on every index refresh and from every hook. */
function plantPointer(wt: string, name: string): string {
  const evil = join(root, `planted-${name}`);
  raw(root, "init", "-q", evil);
  raw(evil, "-c", `user.email=${ID.email}`, "-c", `user.name=${ID.name}`, "commit", "-q", "--allow-empty", "-m", "planted");
  const hooks = join(evil, "evil-hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker(`planted-hook-${name}`)}'\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  raw(evil, "config", "core.fsmonitor", `sh -c 'touch "${marker(`planted-fsmonitor-${name}`)}"'`);
  raw(evil, "config", "core.hooksPath", hooks);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  return join(evil, ".git");
}

const isRefusal = (e: unknown): boolean => e instanceof WorktreePointerRefusedError;
const gather = () => buildGather({ ledgerNdjson: "", learningsMd: "# L\n" });
const stamp = (wt: string, baselines?: Map<string, string>) => stampCitationsAndCommit({
  worktreePath: wt,
  learningsDir: join(wt, "learnings"),
  changed: new Map([["entry-a", { cited: "2026-08-23T00:00:00.000Z", citedCount: 4 }]]),
  ...(baselines ? { baselines } : {}),
});
const reclaimConfig = (dir: string) => ({ root: dir }) as unknown as Config;

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6122-`));
  markers = join(root, "markers");
  mkdirSync(markers);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("W1-T6122: every raw git -C <worktree> left outside run-task.ts is a recorded HARNESS site", () => {
  const EIGHT = ["src/lib/sweep.ts", "src/lib/worker.ts", "src/lib/retro.ts", "src/lib/orientation.ts", "src/lib/relint.ts",
    "src/lib/composition-root.ts", "src/lib/review-worktree-reclaim.ts", "src/spike.ts"];
  const TARGET = /"-C",\s*(?:wt|worktreePath|[A-Za-z_$][\w$]*\.worktreePath|worktreeRoot|batchWorktree|ownerPath)\b/g;

  it("the remaining sites sit only in the worktree cut and the sweep's own origin/main plan-PR trees", () => {
    const where: Record<string, number> = {};
    for (const file of EIGHT) {
      const text = readFileSync(join(REPO, file), "utf8");
      const fns = [...text.matchAll(/^(?:export )?(?:async )?function\*? ([\w$]+)\(/gm)];
      for (const m of text.matchAll(TARGET)) {
        const fn = fns.filter((d) => d.index! < m.index!).at(-1)?.[1] ?? "<top>";
        where[`${file}:${fn}`] = (where[`${file}:${fn}`] ?? 0) + 1;
      }
    }
    assert.deepEqual(where, {
      "src/lib/sweep.ts:buildSweepEffects": 7,
      "src/lib/worker.ts:worktreeAdd": 3,
      "src/lib/worker.ts:worktreeAddAsync": 6,
    });
  });

  it("the census exception for each remaining file records its HARNESS class, and the converted files have none", () => {
    const census = readFileSync(join(REPO, "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts"), "utf8");
    for (const [file, count] of [["src/lib/sweep.ts", 7], ["src/lib/worker.ts", 9]] as const) {
      const entry = new RegExp(`"${file.replace(/[./]/g, "\\$&")}": \\{\\s*count: ${count},\\s*reason:\\s*"HARNESS \\(W1-T6122\\)`);
      assert.match(census, entry, `${file} carries count ${count} and a HARNESS reason`);
    }
    for (const file of EIGHT.slice(2)) assert.equal(census.includes(`"${file}": {`), false, `${file} has no exception left`);
  });
});

describe("W1-T6122: a rewritten .git pointer reaches none of the converted paths", () => {
  it("the control: a raw git -C diff in a lane pointing at the planted gitdir runs its fsmonitor", () => {
    const { wt } = cutLane();
    plantPointer(wt, "control");
    raw(wt, "diff", "--name-only", "HEAD");
    assert.ok(existsSync(marker("planted-fsmonitor-control")), "control: the planted core.fsmonitor command is live");
  });

  it("the sweep's fix-round reads, the retro's commits, relint and the exclude refuse, and write no marker", () => {
    const { wt, n } = cutLane();
    const head = raw(wt, "rev-parse", "HEAD").trim();
    const planted = plantPointer(wt, "leaf");
    writeFileSync(join(wt, "learnings", "a.yaml"), `${SHARD}# dirty\n`);

    assert.equal(readBaselineRatchetWorktreeState(wt), undefined, "a refused pointer is unreadable, never a clean tree");
    assert.equal(headIsInWorktree(wt, head), false, "a refused pointer is not provably the worker's push");
    assert.throws(() => stamp(wt), isRefusal, "the citation commit refuses");
    assert.throws(() => regenerateOrientation({ worktreePath: wt, generatedAt: "t", gather: gather() }), isRefusal);
    assert.deepEqual([...newMonolithIdsAgainstBase(wt)], [], "relint's reads refuse to an empty set");
    assert.equal(excludeNodeModulesFromGit(wt), "failed", "the exclude is not aimed at the planted gitdir");
    assert.throws(() => composeRealDeps({ repoRoot: root }).reviewWorktree.revParseHead(wt), isRefusal);

    assert.equal(existsSync(marker("planted-fsmonitor-leaf")), false, "the planted fsmonitor never ran");
    assert.equal(existsSync(marker("planted-hook-leaf")), false, "no planted hook ran");
    assert.equal(existsSync(join(planted, "info", "exclude")) && readFileSync(join(planted, "info", "exclude"), "utf8").includes("node_modules"),
      false, "nothing was written into the planted gitdir");
    assert.equal(raw(planted, "rev-list", "--count", "HEAD").trim(), "1", "nothing was committed into the planted gitdir");
    for (const hook of ["pre-commit", "commit-msg"]) assert.equal(existsSync(marker(`tracked-${hook}-${n}`)), false);
  });

  it("the reviewer reclaim reads a refused tree as git-unreadable and keeps it", () => {
    const dir = join(root, "reclaim-refused");
    const name = "review-PR7-1000";
    const { wt } = cutLane(join(dir, "worktrees", name));
    plantPointer(wt, "reclaim");
    const summary = sweepStrandedReviewWorktrees(reclaimConfig(dir), () => {}, {
      listEntries: () => [name], isDirectory: () => true, clock: { now: () => 10 ** 13 } as never, graceMs: 0,
      resolveRepoDir: () => root, readRemoteHeadSha: () => "x", removeWorktree: () => assert.fail("never removed"),
    });
    assert.deepEqual(summary.kept.map((k) => k.reason), ["git-unreadable"]);
    assert.equal(existsSync(marker("planted-fsmonitor-reclaim")), false);
  });
});

describe("W1-T6122: on an intact lane the converted paths behave as before", () => {
  it("reads, stamps, regenerates and excludes, running none of the tracked hooks", () => {
    const { wt, n } = cutLane();
    const head = raw(wt, "rev-parse", "HEAD").trim();
    assert.equal(headIsInWorktree(wt, head), true);
    writeFileSync(join(wt, "new.txt"), "n\n");
    assert.deepEqual(readBaselineRatchetWorktreeState(wt), { headSha: head, changedPaths: ["new.txt"] });
    rmSync(join(wt, "new.txt"));

    const baselines = captureCitationBaselines(join(wt, "learnings"), ["entry-a"]);
    const stamped = stamp(wt, baselines);
    assert.equal(stamped.committed, true, "the citation commit lands, read against a fresh origin/main");
    assert.deepEqual(stamped.stampedIds, ["entry-a"]);
    assert.match(stamped.diff ?? "", /learnings\/a\.yaml/);
    const regen = regenerateOrientation({ worktreePath: wt, generatedAt: "t", gather: gather() });
    assert.equal(regen.committed, true);
    assert.equal(regenerateOrientation({ worktreePath: wt, generatedAt: "t", gather: gather() }).committed, false, "idempotent");

    writeFileSync(join(wt, "plan", "tasks.yaml"), `${TASKS}${TASK("W1-T2")}`);
    raw(wt, "add", "plan/tasks.yaml");
    assert.deepEqual([...newMonolithIdsAgainstBase(wt)], ["W1-T2"]);
    assert.equal(excludeNodeModulesFromGit(wt), "already-excluded", "worktreeAdd's exclude is found through the pinned common dir");
    assert.equal(composeRealDeps({ repoRoot: root }).reviewWorktree.revParseHead(wt), raw(wt, "rev-parse", "HEAD").trim());
    for (const hook of ["pre-commit", "commit-msg", "post-commit"]) {
      assert.equal(existsSync(marker(`tracked-${hook}-${n}`)), false, `the tracked ${hook} never ran`);
    }
  });

  it("the reviewer reclaim reads an intact tree's HEAD and reclaims it when origin agrees", () => {
    const dir = join(root, "reclaim-intact");
    const { wt } = cutLane(join(dir, "worktrees", "review-PR8-1000"));
    const head = raw(wt, "rev-parse", "HEAD").trim();
    const removed: string[] = [];
    const summary = sweepStrandedReviewWorktrees(reclaimConfig(dir), () => {}, {
      listEntries: () => ["review-PR8-1000"], isDirectory: () => true, clock: { now: () => 10 ** 13 } as never, graceMs: 0,
      resolveRepoDir: () => root, readRemoteHeadSha: () => head, removeWorktree: (_r, p) => removed.push(p),
    });
    assert.deepEqual(summary.reclaimed, ["review-PR8-1000"]);
    assert.deepEqual(removed, [wt]);
  });
});
