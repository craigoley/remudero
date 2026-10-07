/**
 * W1-T5824 — A PLAN-SCOPED FIX ROUND READS TASK IDS WITH ITS OWN HEAD REF.
 *
 * `runPlanScopedFixRound` preflights the PR it is repairing in a `git worktree add --detach` tree.
 * task-id-existence names its own PR by `--head-ref`, then `GITHUB_HEAD_REF`, then the checked-out
 * branch; a detached tree on the daemon has none of the three, so the open-PR half could not
 * exclude the PR under repair and refused that PR's own new id as "ALREADY CLAIMED by another OPEN
 * PR" (#9253, fix.commit_refused 06:31:06Z 2026-10-05). The round now passes `pr.headRefName` to
 * every preflight call, and the preflight hands it to the check as `--head-ref`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as runner from "../src/run-task.js";
import {
  planPrPreflightAtCommit,
  planPrPreflightAtCommitAsync,
  type PlanPrPreflightReading,
  type PlanPrPreflightResult,
} from "../src/lib/plan-pr-emitter.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD_REF = "run-W1-T90002-1791000000000";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const SHARD = "plan/tasks.d/W1-T90002-fixture.yaml";
const BODY = `## Acceptance\n- the shard is filed | grep: id: W1-T90002 in ${SHARD}`;
const clean: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const red: PlanPrPreflightResult = { ok: false, failures: [{ check: "lint-plan", firstLine: "rationale is missing" }], unreadable: [] };
const pass: PlanPrPreflightReading = { status: 0, output: "" };

const pr: OpenPrView = {
  prNumber: 9253, prUrl: "https://github.com/acme/remudero/pull/9253", headSha: HEAD,
  headRefName: HEAD_REF, isPlanFiling: true, planFilingSource: "github-files",
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  ciFailures: [{ name: "task-id-existence", logTail: "ALREADY CLAIMED", conclusion: "FAILURE" }], body: BODY,
};

/** A round whose every preflight call is recorded; the first answers red so the worker runs. */
function round(body: string) {
  const preflights: Array<{ title: string; body: string; headRef?: string }> = [];
  const written: Array<Record<string, unknown>> = [];
  let committed = false;
  const input = {
    pr, worktreePath: "/fixture", title: "chore(plan): ratify W1-T90002", body,
    task: { id: "PR-9253", title: "fixture", files: [SHARD] },
    deps: {
      runGit(args: string[]) {
        if (args[0] === "commit") committed = true;
        if (args[0] === "rev-parse") return committed ? NEXT : HEAD;
        if (args[0] === "status") return ` M ${SHARD}\0`;
        if (args[0] === "show") return "- id: W1-T90002\n";
        return "";
      },
      preflight: async (_tree: string, _sha: string, meta: { title: string; body: string; headRef?: string }) => {
        preflights.push(meta);
        return preflights.length === 1 ? red : clean;
      },
      spawn: async () => "COMMIT_MESSAGE: fix(plan): supply rationale",
      push: async () => {},
      updateMetadata: async (meta: { title: string; body: string }) => { written.push(meta); },
      log: () => {},
    },
  };
  return { input, preflights, written };
}

test("W1-T5824: a plan-scoped fix round passes the PR's head ref to every preflight call", async () => {
  const pushed = round(BODY);
  assert.equal((await runner.runPlanScopedFixRound(pushed.input)).outcome, "pushed");
  assert.equal(pushed.preflights.length, 2, "the initial read and the commit's verdict");
  for (const meta of pushed.preflights) assert.equal(meta.headRef, HEAD_REF);

  // A self-crediting body is cured before any worker: the candidate body's preflight carries it too.
  const cured = round(`${BODY}\n\nRemudero-Task: W1-T90002`);
  assert.equal((await runner.runPlanScopedFixRound(cured.input)).outcome, "metadata-repaired");
  assert.equal(cured.preflights.length, 2, "the initial read and the repaired body's");
  for (const meta of cured.preflights) assert.equal(meta.headRef, HEAD_REF);
  assert.equal(cured.written.length, 1);
  assert.equal("headRef" in cured.written[0]!, false, "the head ref is the preflight's, never written into the PR");
});

/**
 * A repo whose origin/main declares W1-T90001 and whose head commit ADDS W1-T90002, carrying the
 * real task-id-existence script, and a `gh` that lists ONE open PR: the head itself, declaring the id.
 */
function headAddingAnId() {
  const origin = gitRepo({ bare: true, kind: "w1-t5824-origin" });
  const repo = gitRepo({ seedCommit: false, kind: "w1-t5824-repo" });
  for (const rel of [
    "scripts/task-id-existence-check.mjs",
    "scripts/lib/git.mjs",
    "scripts/lib/argv.mjs",
    "src/lib/reservation-chain.mjs",
  ]) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(repo.dir, rel));
  }
  writeFileSync(join(repo.dir, "scripts/task-id-existence-baseline.json"), "[]\n");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src/index.txt"), "nothing cited\n");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "# empty\n");
  writeFileSync(join(repo.dir, "plan/tasks.d/W1-T90001-base.yaml"), "- id: W1-T90001\n  title: base\n");
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "base");
  repo.addRemote("origin", origin.dir);
  repo.git("push", "--quiet", "origin", "main");
  repo.git("fetch", "--quiet", "origin");
  writeFileSync(join(repo.dir, SHARD), "- id: W1-T90002\n  title: added\n");
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "file W1-T90002");
  const sha = repo.git("rev-parse", "HEAD");
  const gh = ghShim([
    { when: "/files", stdout: JSON.stringify([{ filename: SHARD, patch: "+- id: W1-T90002" }]) },
    { when: "pulls?state=open", stdout: JSON.stringify([
      { number: 9253, html_url: "https://github.com/acme/remudero/pull/9253", title: "chore(plan): ratify W1-T90002", body: "", head: { ref: HEAD_REF } },
    ]) },
  ], { kind: "w1-t5824-gh" });
  return { repo: repo.dir, sha, gh };
}

/** Run with the shim's `gh` first on PATH and no ambient `GITHUB_HEAD_REF` (a CI runner sets one). */
async function withShim<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF };
  process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
  delete process.env.GITHUB_HEAD_REF;
  try {
    return await run();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.GITHUB_HEAD_REF === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = saved.GITHUB_HEAD_REF;
  }
}

test("W1-T5824: a detached preflight's task-id-existence passes the PR's own id only with its head ref", async () => {
  const { repo, sha, gh } = headAddingAnId();
  const others = { lintPlan: () => pass, shardCensus: () => pass, checkProof: () => 0 };
  const othersAsync = { lintPlan: async () => pass, shardCensus: async () => pass, checkProof: async () => 0 };
  const meta = { title: "chore(plan): ratify W1-T90002", body: "" };
  await withShim(gh.dir, async () => {
    const withRef = await planPrPreflightAtCommitAsync(repo, sha, { ...meta, headRef: HEAD_REF }, othersAsync);
    assert.deepEqual(withRef, clean, JSON.stringify(withRef));
    const withoutRef = await planPrPreflightAtCommitAsync(repo, sha, meta, othersAsync);
    assert.equal(withoutRef.ok, false);
    assert.equal(withoutRef.failures[0]?.check, "task-id-existence");
    assert.match(withoutRef.failures[0]!.firstLine, /ALREADY CLAIMED by another OPEN PR/);

    assert.deepEqual(planPrPreflightAtCommit(repo, sha, { ...meta, headRef: HEAD_REF }, others), clean);
    const syncWithout = planPrPreflightAtCommit(repo, sha, meta, others);
    assert.match(syncWithout.failures[0]?.firstLine ?? "", /ALREADY CLAIMED by another OPEN PR/);
  });
  assert.ok(gh.calls().some((c) => c.includes("pulls?state=open")), "the open-PR half really ran");
});

test("W1-T5824: the injected task-id-existence seam receives the head ref, and none when none is given", async () => {
  const { repo, sha } = headAddingAnId();
  const seen: Array<string | undefined> = [];
  const record = (_cwd: string, headRef?: string): PlanPrPreflightReading => { seen.push(headRef); return pass; };
  const checks = { lintPlan: () => pass, shardCensus: () => pass, checkProof: () => 0, taskIdExistence: record };
  const checksAsync = { lintPlan: async () => pass, shardCensus: async () => pass, checkProof: async () => 0,
    taskIdExistence: async (cwd: string, headRef?: string) => record(cwd, headRef) };
  const meta = { title: "chore(plan): ratify W1-T90002", body: "" };
  await planPrPreflightAtCommitAsync(repo, sha, { ...meta, headRef: HEAD_REF }, checksAsync);
  await planPrPreflightAtCommitAsync(repo, sha, meta, checksAsync);
  planPrPreflightAtCommit(repo, sha, { ...meta, headRef: HEAD_REF }, checks);
  planPrPreflightAtCommit(repo, sha, meta, checks);
  assert.deepEqual(seen, [HEAD_REF, undefined, HEAD_REF, undefined]);
});
