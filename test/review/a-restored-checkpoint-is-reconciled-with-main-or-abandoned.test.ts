/**
 * W1-T10752: a restored checkpoint is reconciled with main or abandoned, never built on a stale base.
 *
 * CONSOLE-T127 restored f537386 (114 commits behind main, vitest 5.0.3 against main's 5.0.5) twice on 2026-10-26.
 * Main conflicted, so the restore reset the run onto the checkpoint's own 12-day-old base, the worker was never told,
 * the dependency tree linked for main's lockfile stayed under a checkout pinning another, and the PR open died on
 * "installed Vitest does not match the checkout lockfile pin". These cases drive the real restore and the real
 * `runTask` dispatch against a local bare origin; only the worker, the pre-open gate and the dependency installer
 * are injected.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pendingWorkerBoundaryHandoffs } from "#src/lib/daemon.js";
import { hashInstallInputs } from "#src/lib/install-hash.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { vitestCacheCapability } from "#src/lib/proof-cache.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { restoreBoundaryCheckpoint, runTask, type RunResult } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const ID = "W1-T990752";
const HOUR_MS = 3_600_000;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: refresh", files: ["src/lib/daemon.ts"] }] };

type Row = Record<string, unknown>;

function worker(text: string): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

function planText(withProof: boolean): string {
  return `- id: ${ID}\n  title: reconcile fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/change.ts]\n` +
    (withProof ? "  acceptance:\n    - claim: the change exists\n      proof: \"grep: value = 1 in src/change.ts\"\n" : "");
}

const PACKAGE = "w1-t10752-fixture";
const lockWith = (vitest: string): string => JSON.stringify({ name: PACKAGE, version: "0.0.0", lockfileVersion: 3, requires: true,
  packages: { "": { name: PACKAGE, version: "0.0.0", devDependencies: { vitest } }, "node_modules/vitest": { version: vitest } } }, null, 2) + "\n";

/** Commit everything staged in `repo`, stamped `at` so a "dated after the checkpoint" rule is not left to the clock. */
function commitAt(repo: GitRepo, message: string, at: string): void {
  repo.git("add", "-A");
  const identity = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@remudero.invalid", GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@remudero.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  execFileSync("git", ["-C", repo.dir, "commit", "-q", "-m", message], { env: { ...process.env, ...identity } });
}

interface Fixture {
  root: string;
  origin: GitRepo;
  seed: GitRepo;
  planPath: string;
  checkpoint: { branch: string; headSha: string };
  ledgerPath: string;
  hooksDir: string;
  /** A fresh clone of origin with its own identity, the shape the restore runs in. */
  clone: () => GitRepo;
  moveMain: (files: Record<string, string>, message: string) => string;
}

function buildFixture(opts: { install?: boolean; withProof?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t10752-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  const old = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  mkdirSync(join(seed.dir, "src"), { recursive: true });
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "src/change.ts"), "export const value = 1;\n");
  writeFileSync(join(seed.dir, "plan/tasks.yaml"), planText(opts.withProof === true));
  if (opts.install) {
    writeFileSync(join(seed.dir, "package.json"), JSON.stringify({ name: PACKAGE, version: "0.0.0", devDependencies: { vitest: "5.0.5" } }, null, 2) + "\n");
    writeFileSync(join(seed.dir, "package-lock.json"), lockWith("5.0.5"));
  }
  commitAt(seed, "feat: seed", old);
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repo = gitRepo({ cloneFrom: origin.dir });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  renameSync(repo.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planText(opts.withProof === true));

  const branch = `run-${ID}-${Date.now() - HOUR_MS}`;
  seed.git("checkout", "-q", "-b", branch);
  writeFileSync(join(seed.dir, "src/change.ts"), "export const value = 42;\n");
  if (opts.install) writeFileSync(join(seed.dir, "package-lock.json"), lockWith("5.0.3"));
  commitAt(seed, `wip: retained work\n\n[remudero-context]\nremaining: verification\n\nRemudero-Task: ${ID}`, new Date(Date.now() - HOUR_MS).toISOString());
  const headSha = seed.git("rev-parse", "HEAD");
  seed.git("push", "-q", "origin", branch);
  seed.git("checkout", "-q", "main");

  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: new Date(Date.now() - HOUR_MS).toISOString(), step: "verdict", task_id: ID,
    verdict: "handed_off", reason: "freshness_yield", branch, head_sha: headSha })}\n`);

  // The harness's push hook, reduced to accepting: the cases are not about the census gate.
  const hooksDir = join(root, "harness-hooks");
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(hooksDir, "pre-push"), 0o755);

  return {
    root, origin, seed, planPath, ledgerPath, hooksDir, checkpoint: { branch, headSha },
    clone: () => {
      const clone = gitRepo({ cloneFrom: origin.dir });
      clone.git("config", "user.name", "fixture");
      clone.git("config", "user.email", "fixture@remudero.invalid");
      return clone;
    },
    moveMain: (files, message) => {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(seed.dir, path, ".."), { recursive: true });
        writeFileSync(join(seed.dir, path), body);
      }
      commitAt(seed, message, new Date().toISOString());
      seed.git("push", "-q", "origin", "main");
      return seed.git("rev-parse", "HEAD");
    },
  };
}

const rowsOf = (fx: Fixture): Row[] => readFileSync(fx.ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
const stepRows = (rows: Row[], step: string): Row[] => rows.filter((row) => row.step === step);
const inTree = (fx: Fixture, cwd: string, ...args: string[]): string => fx.seed.git("-C", cwd, ...args);

interface Drive {
  /** What the implement worker does; `n` counts every spawn, recon first. */
  implement?: (args: SpawnWorkerArgs, n: number) => WorkerResult | void;
  /** Gate injected as the pre-open gate; its call count is returned. */
  gate?: boolean;
  /** Yield at the pushing boundary after the gate, so the run ends without a PR. */
  yieldAfterGate?: boolean;
  worktreeBaseDeps?: Record<string, unknown>;
  /** The filed proof passes, so the opener clears it and the (stubbed) `gh pr create` prints no URL. */
  provenProof?: boolean;
}

async function drive(t: TestContext, fx: Fixture, d: Drive = {}) {
  const gh = ghShim([], { kind: "w1-t10752-gh" });
  const priorPath = process.env.PATH;
  const priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${priorPath}`;
  process.env.RMD_HARNESS_HOOKS_DIR = fx.hooksDir;
  t.after(() => {
    process.env.PATH = priorPath;
    if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks;
  });
  let pending = false;
  let spawns = 0;
  const prompts: string[] = [];
  const gateCalls: number[] = [];
  const issues = { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], ensureLabel: () => true };
  const options = {
    config: { claudeBin: "/bin/true", root: fx.root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath: fx.planPath, owner: "acme",
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "w1-t10752-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token: string) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    coveragePrecheckPorts: { changedFiles: () => [] },
    otherOpenPrReader: async () => [],
    prOpenRefusalIssues: issues,
    prCreateExec: () => "",
    // The filed proof passes at the merge base, so the opener refuses it as stale (a returned `failed` verdict, not a throw).
    prOpenProofRunner: async () => d.provenProof ? { status: 0, stdout: "verdict:    pass" }
      : { status: 5, stdout: "verdict:    executed_stale\ncause:      the proof passes at the merge base" },
    externalWaitFreshness: async () => (pending ? stale : undefined),
    ...(d.worktreeBaseDeps ? { worktreeBaseDeps: d.worktreeBaseDeps } : {}),
    ...(d.gate ? { preopenGate: async () => { gateCalls.push(spawns); pending = d.yieldAfterGate === true; return { kind: "pass" as const, durationMs: 1 }; } } : {}),
    spawn: async (args: SpawnWorkerArgs) => {
      if (++spawns === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      prompts.push(String(args.prompt));
      return d.implement?.(args, spawns) ?? worker("REPORT\nnothing to change\n");
    },
  };
  const outcome: RunResult = await withLiveWritesAllowed(() => runTask(ID, options as unknown as Parameters<typeof runTask>[1]));
  return { outcome, rows: rowsOf(fx), prompts, gateCalls, ghCalls: gh.calls() };
}

test("W1-T10752: a conflicting checkpoint is merged with main and the worker resolves the conflict", async (t) => {
  const fx = buildFixture();
  const main = fx.moveMain({ "src/change.ts": "export const value = 7;\n" }, "feat: main moves on");

  // The restore on its own: main, not the checkpoint's stale base, with main's merge left open for the worker.
  const clone = fx.clone();
  const restoreRows: Row[] = [];
  const restored = await restoreBoundaryCheckpoint(fx.checkpoint, ID, async (args) => clone.git(...args), (step, data) => { restoreRows.push({ step, ...data }); });
  assert.equal(restored.base, "main");
  assert.equal(restored.reconciled, "merge");
  assert.deepEqual(restored.mainConflicts, ["src/change.ts"]);
  assert.equal(restored.mainSha, main);
  assert.equal(restored.headSha, fx.checkpoint.headSha, "the checkpoint stays the first parent");
  assert.equal(clone.git("rev-parse", "MERGE_HEAD"), main);
  assert.match(readFileSync(join(clone.dir, "src/change.ts"), "utf8"), /^<{7} /m);
  assert.deepEqual(restoreRows, []);

  // The real dispatch: the worker is told, resolves, commits, and the merge has both parents.
  const seen: { mergeHead?: string; marker?: boolean; resolvedHead?: string } = {};
  const run = await drive(t, fx, {
    gate: true, yieldAfterGate: true,
    implement: (args) => {
      seen.mergeHead = inTree(fx, args.cwd, "rev-parse", "MERGE_HEAD");
      seen.marker = /^<{7} /m.test(readFileSync(join(args.cwd, "src/change.ts"), "utf8"));
      writeFileSync(join(args.cwd, "src/change.ts"), "export const value = 42;\n");
      inTree(fx, args.cwd, "add", "src/change.ts");
      inTree(fx, args.cwd, "commit", "-q", "--no-edit");
      seen.resolvedHead = inTree(fx, args.cwd, "rev-parse", "HEAD");
    },
  });
  const row = stepRows(run.rows, "implement.checkpoint_restored")[0];
  assert.equal(row?.base, "main", "a conflicting main is never left behind as the base");
  assert.equal(row?.reconciled, "merge");
  assert.deepEqual(row?.main_conflicts, ["src/change.ts"]);
  assert.equal(row?.restored_head_sha, fx.checkpoint.headSha);
  assert.equal(seen.mergeHead, main, "MERGE_HEAD is main's sha when the worker starts");
  assert.equal(seen.marker, true, "the conflict markers are in the worker's tree");
  assert.match(run.prompts[0] ?? "", new RegExp(main), "the worker's prompt names main's sha");
  assert.match(run.prompts[0] ?? "", /src\/change\.ts/, "the worker's prompt names the conflicted path");
  assert.deepEqual(inTree(fx, fx.origin.dir, "rev-list", "--parents", "-1", seen.resolvedHead ?? "").split(" ").slice(1), [fx.checkpoint.headSha, main],
    "the worker's commit completes the merge with parents [checkpoint, main]");
  assert.equal(run.outcome.verdict, "handed_off");
  assert.equal(stepRows(run.rows, "implement.checkpoint_dropped").length, 0);

  // A worker that leaves a marker is refused by the pre-open gate, repaired once, then the run ends without a PR.
  const left = buildFixture();
  left.moveMain({ "src/change.ts": "export const value = 7;\n" }, "feat: main moves on");
  const refused = await drive(t, left, { gate: true });
  const gateRows = stepRows(refused.rows, "implement.preopen_gate");
  assert.deepEqual(gateRows.map((r) => r.result), ["fail", "fail"], "the marker is refused before and after the repair round");
  assert.match(String((gateRows[0]?.failed as string[])[0]), /main-merge-conflict: src\/change\.ts/);
  assert.ok(refused.prompts.some((p) => /main-merge-conflict: src\/change\.ts/.test(p)), "the repair round names the unresolved path");
  assert.equal(refused.gateCalls.length, 0, "the base gate never ran over an unresolved merge");
  assert.equal(refused.outcome.verdict, "failed");
  assert.equal(stepRows(refused.rows, "verdict").at(-1)?.stage, "reconcile.unresolved");
  assert.equal(refused.ghCalls.some((call) => call.includes("pr create")), false, "no PR opens over an unresolved merge");
  const kept = stepRows(refused.rows, "implement.checkpoint_kept")[0];
  assert.equal(kept?.head_sha, left.checkpoint.headSha, "the unresolved run keeps the restored checkpoint");
});

test("W1-T10752: a superseded checkpoint is abandoned with its evidence and the run starts from main", async (t) => {
  const cases: Array<{ evidence: string; files: Record<string, string>; message: string }> = [
    { evidence: "tree-equal", files: { "src/change.ts": "export const value = 42;\n" }, message: "feat: an unrelated commit carries the same change" },
    { evidence: "task-credited", files: { "src/change.ts": "export const value = 7;\n" }, message: `fix: land it another way\n\nRemudero-Task: ${ID}` },
  ];
  for (const c of cases) {
    const fx = buildFixture();
    const main = fx.moveMain(c.files, c.message);
    const seen: { head?: string; mergeHead?: string } = {};
    const run = await drive(t, fx, { implement: (args) => {
      seen.head = inTree(fx, args.cwd, "rev-parse", "HEAD");
      try {
        seen.mergeHead = inTree(fx, args.cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD");
      } catch (error) {
        void error; // git exits 1 when no merge is open, which is the state this case asserts
      }
    } });
    const dropped = stepRows(run.rows, "implement.checkpoint_dropped");
    assert.equal(dropped.length, 1, c.evidence);
    assert.equal(dropped[0]?.reason, "superseded");
    assert.equal(dropped[0]?.evidence, c.evidence);
    assert.equal(dropped[0]?.main_sha, main);
    assert.equal(dropped[0]?.source_branch, fx.checkpoint.branch);
    assert.equal(dropped[0]?.head_sha, fx.checkpoint.headSha);
    assert.equal(dropped[0]?.task_id, ID);
    assert.equal(stepRows(run.rows, "implement.checkpoint_restored").length, 0, "a superseded checkpoint is not restored");
    assert.equal(seen.head, main, `${c.evidence}: the worker's worktree is on main`);
    assert.equal(seen.mergeHead, undefined);
    const raw = readFileSync(fx.ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.equal(pendingWorkerBoundaryHandoffs(raw).size, 0, `${c.evidence}: no pending handoff is left`);
    assert.equal(pendingWorkerBoundaryHandoffs(raw.slice(0, raw.findIndex((line) => line.includes("implement.checkpoint_dropped")) + 1)).size, 0,
      "the dropped row alone resolves the receipt");
  }

  // A checkpoint whose paths already hold main's blobs is superseded even when the merge cannot be read.
  const blobs = buildFixture();
  const main = blobs.moveMain({ "src/change.ts": "export const value = 42;\n" }, "feat: an unrelated commit carries the same change");
  const clone = blobs.clone();
  const rows: Row[] = [];
  const restored = await restoreBoundaryCheckpoint(blobs.checkpoint, ID, async (args) => {
    if (args[0] === "merge-tree") throw new Error("merge-tree is unavailable");
    return clone.git(...args);
  }, (step, data) => { rows.push({ step, ...data }); });
  assert.equal(restored.dropped, true);
  assert.equal(restored.headSha, main);
  assert.equal(rows[0]?.evidence, "blobs-equal");

  // Not provably superseded: a conflicting main with no credit is reconciled, never dropped.
  const live = buildFixture();
  live.moveMain({ "src/change.ts": "export const value = 7;\n" }, "feat: main moves on");
  const run = await drive(t, live);
  assert.equal(stepRows(run.rows, "implement.checkpoint_dropped").length, 0, "a conflicted checkpoint that is not superseded is not abandoned");
  assert.equal(stepRows(run.rows, "implement.checkpoint_restored")[0]?.reconciled, "merge");
});

test("W1-T10752: the dependency install matches the restored checkout lockfile", async (t) => {
  const fx = buildFixture({ install: true });
  fx.moveMain({ "src/sibling.ts": "export const sibling = true;\n" }, "feat: main moves on");
  const mainHash = hashInstallInputs(fx.seed.dir);
  const installed: string[] = [];
  const seen: { hash?: string; tree?: string; capability?: ReturnType<typeof vitestCacheCapability> } = {};
  const run = await drive(t, fx, {
    worktreeBaseDeps: {
      depsRoot: join(fx.root, "deps"),
      installDependencies: (dir: string) => {
        const version = (JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> }).packages["node_modules/vitest"]!.version;
        installed.push(version);
        mkdirSync(join(dir, "node_modules/vitest"), { recursive: true });
        writeFileSync(join(dir, "node_modules/vitest/package.json"), JSON.stringify({ name: "vitest", version }));
        writeFileSync(join(dir, "node_modules/vitest/vitest.mjs"), "export {};\n");
      },
    },
    implement: (args) => {
      seen.hash = hashInstallInputs(args.cwd);
      seen.tree = realpathSync(join(args.cwd, "node_modules"));
      seen.capability = vitestCacheCapability(args.cwd);
    },
  });
  assert.notEqual(seen.hash, mainHash, "the restored checkout pins another lockfile than main");
  assert.deepEqual(installed, ["5.0.5", "5.0.3"], "main's tree was provisioned at worktree-add, the restored checkout's own after the restore");
  assert.equal(seen.tree, realpathSync(join(fx.root, "deps", PACKAGE, seen.hash ?? "", "node_modules")), "the linked tree is the one keyed by the restored checkout's hash");
  assert.equal(seen.capability?.supported, true, "the installed Vitest matches the checkout lockfile pin");
  const reprovisioned = stepRows(run.rows, "deps.reprovisioned");
  assert.equal(reprovisioned.length, 1);
  assert.equal(reprovisioned[0]?.from_hash, mainHash);
  assert.equal(reprovisioned[0]?.to_hash, seen.hash);
  assert.equal(reprovisioned[0]?.reason, "checkpoint_restored");
});

test("W1-T10752: a failed restored run keeps the newest head it can prove", async (t) => {
  for (const { moved, refused } of [{ moved: true, refused: true }, { moved: false, refused: true }, { moved: false, refused: false }]) {
    const fx = buildFixture({ withProof: true });
    const run = await drive(t, fx, { provenProof: !refused, implement: (args) => {
      if (!moved) return;
      writeFileSync(join(args.cwd, "src/change.ts"), "export const value = 43;\n");
      inTree(fx, args.cwd, "add", "src/change.ts");
      inTree(fx, args.cwd, "commit", "-q", "-m", "fix(test): the worker's newer head");
    } });
    assert.equal(run.outcome.verdict, "failed");
    const verdictAt = run.rows.findLastIndex((row) => row.step === "verdict");
    const verdict = run.rows[verdictAt];
    if (refused) assert.equal(verdict?.stage, "pr_open.refused");
    else assert.equal(verdict?.reason, "no PR opened");
    const keptAt = run.rows.findIndex((row) => row.step === "implement.checkpoint_kept");
    assert.ok(keptAt > verdictAt, "the kept row lands right after the verdict that consumed the receipt");
    const kept = run.rows[keptAt];
    const pending = pendingWorkerBoundaryHandoffs(readFileSync(fx.ledgerPath, "utf8").split("\n").filter(Boolean)).get(ID);
    if (moved) {
      const pushed = fx.origin.git("rev-parse", `refs/heads/${String(verdict?.branch)}`);
      assert.notEqual(pushed, fx.checkpoint.headSha, "the run really built a newer head");
      assert.equal(kept?.head_sha, pushed, "the kept head is the run's own pushed tip");
      assert.equal(kept?.source_branch, verdict?.branch);
      assert.equal(kept?.failed_stage, "pr_open.refused");
      assert.deepEqual(pending, { branch: String(verdict?.branch), headSha: pushed });
    } else {
      assert.equal(kept?.head_sha, fx.checkpoint.headSha, "a run that built nothing keeps the restored head");
      assert.equal(kept?.source_branch, fx.checkpoint.branch);
      assert.deepEqual(pending, fx.checkpoint);
    }
  }
});
