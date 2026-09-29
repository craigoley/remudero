/** Mine sealed, proof-graded repair tasks from merged work. Nothing here writes a plan shard or dispatches. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execWhitelistedProof, parseWhitelistedProof, type ProofExecutor, type WhitelistedProof } from "./review.js";

const PILOT_SIZE = 30;

/** Only the corpus fields the miner reads; the corpus may depend on this module without a cycle. */
interface SyntheticSourceItem {
  readonly taskId: string;
  readonly headSha?: string;
  readonly prUrl?: string;
  readonly spec?: { readonly type: string; readonly verify: string; readonly files: readonly string[] };
  readonly proofs: readonly { readonly claim: string; readonly proof: string; readonly holdout: boolean }[];
}

export interface SyntheticTaskRecord {
  readonly id: string;
  readonly sealed: true;
  readonly dispatchable: false;
  readonly sourceTaskId: string;
  readonly sourcePrUrl?: string;
  readonly spec?: SyntheticSourceItem["spec"];
  readonly mainSha: string;
  readonly mergedSha: string;
  /** A git patch to apply in reverse to main when replaying this task. */
  readonly reversePatch: string;
  readonly grading: { readonly main: "pass"; readonly candidate: "fail" };
  /** The scorer stays inside this sealed record, never in a production task shard. */
  readonly proofs: SyntheticSourceItem["proofs"];
}

export interface SyntheticPilotReport {
  readonly sampled: number;
  readonly kept: readonly SyntheticTaskRecord[];
  readonly excluded: readonly { taskId: string; reason: string }[];
  readonly keepRate: number;
}

export interface SyntheticMiningOptions {
  repoDir: string;
  mainRef?: string;
  /** The pilot never examines more than 30 merged tasks. */
  pilotSize?: number;
  execProof?: ProofExecutor;
}

function git(repoDir: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8", input, maxBuffer: 1 << 24, stdio: ["pipe", "pipe", "pipe"],
  });
}

function mergedCommit(repoDir: string, mainSha: string, item: SyntheticSourceItem): string | undefined {
  const trailer = `Remudero-Task: ${item.taskId}`;
  const matches = git(repoDir, ["log", mainSha, "--format=%H", "--fixed-strings", `--grep=${trailer}`, "-10"])
    .trim().split("\n").filter(Boolean);
  for (const sha of matches) {
    if (git(repoDir, ["show", "-s", "--format=%B", sha]).split("\n").some((line) => line.trim() === trailer)) return sha;
  }
  if (item.headSha && spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", item.headSha, mainSha],
    { stdio: "ignore" }).status === 0) return item.headSha;
  return undefined;
}

function isNonTestPath(path: string): boolean {
  return !path.startsWith("test/") && !path.startsWith("plan/") &&
    !path.split("/").includes("__tests__") && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function taskProofs(item: SyntheticSourceItem): WhitelistedProof[] | undefined {
  const parsed = item.proofs.map((entry) => parseWhitelistedProof(entry.proof));
  if (!parsed.some((proof) => proof !== null && proof.kind === "test")) return undefined;
  return parsed.every((proof) => proof !== null) ? parsed as WhitelistedProof[] : undefined;
}

function grade(proofs: readonly WhitelistedProof[], dir: string, execProof: ProofExecutor): { outcome: "pass" | "fail" | "unmeasurable"; reason: string } {
  const results: ("pass" | "fail" | "no-match")[] = [];
  for (const proof of proofs) {
    try { results.push(execProof(proof, dir)); }
    catch (error) {
      return { outcome: "unmeasurable", reason: `proof ${proof.label} could not execute: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (results.includes("no-match")) return { outcome: "unmeasurable", reason: "a named test did not match" };
  return results.includes("fail") ? { outcome: "fail", reason: "at least one task proof failed" } : { outcome: "pass", reason: "all task proofs passed" };
}

/**
 * Work from the dated golden corpus, which already admits only merged tasks with recorded discrimination.
 * Recheck each task's unit proofs against today's main and a reverse-applied, non-test patch. An
 * unresolvable merge, patch conflict, proof error or no-match is excluded by name, never counted as red.
 */
export function mineSyntheticTasks(items: readonly SyntheticSourceItem[], options: SyntheticMiningOptions): SyntheticPilotReport {
  const pilotSize = Number.isFinite(options.pilotSize) ? Math.trunc(options.pilotSize!) : PILOT_SIZE;
  const sampled = Math.min(items.length, Math.max(0, Math.min(PILOT_SIZE, pilotSize)));
  const kept: SyntheticTaskRecord[] = [];
  const excluded: { taskId: string; reason: string }[] = [];
  const mainSha = git(options.repoDir, ["rev-parse", "--verify", options.mainRef ?? "origin/main"]).trim();
  const execProof = options.execProof ?? execWhitelistedProof;

  for (const item of items.slice(0, sampled)) {
    const reject = (reason: string) => excluded.push({ taskId: item.taskId, reason });
    const proofs = taskProofs(item);
    if (proofs === undefined) { reject("no complete executable proof set with a unit test"); continue; }
    const mergedSha = mergedCommit(options.repoDir, mainSha, item);
    if (mergedSha === undefined) { reject("merged commit with task trailer was not found on main"); continue; }
    const parent = git(options.repoDir, ["rev-parse", "--verify", `${mergedSha}^`]).trim();
    const paths = git(options.repoDir, ["diff", "--name-only", "-z", "--no-renames", parent, mergedSha])
      .split("\0").filter(Boolean).filter(isNonTestPath);
    if (paths.length === 0) { reject("merged change has no non-test paths"); continue; }
    const reversePatch = git(options.repoDir, ["diff", "--binary", "--no-renames", parent, mergedSha, "--", ...paths]);
    if (!reversePatch) { reject("merged change produced no reverse patch"); continue; }

    const root = mkdtempSync(join(tmpdir(), "rmd-synthetic-task-"));
    const candidateDir = join(root, "candidate");
    let added = false;
    try {
      git(options.repoDir, ["worktree", "add", "--quiet", "--detach", candidateDir, mainSha]);
      added = true;
      const modules = join(options.repoDir, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(candidateDir, "node_modules"), "dir");
      const mainGrade = grade(proofs, candidateDir, execProof);
      if (mainGrade.outcome !== "pass") { reject(`proof on main was ${mainGrade.outcome}: ${mainGrade.reason}`); continue; }
      git(candidateDir, ["apply", "--reverse", "--binary", "-"], reversePatch);
      const candidateGrade = grade(proofs, candidateDir, execProof);
      if (candidateGrade.outcome !== "fail") {
        reject(candidateGrade.outcome === "pass" ? "proof stayed green after reversal" : `candidate proof was unmeasurable: ${candidateGrade.reason}`);
        continue;
      }
      kept.push(Object.freeze({ id: `synthetic-${item.taskId}-${mainSha.slice(0, 12)}`,
        sealed: true, dispatchable: false, sourceTaskId: item.taskId,
        ...(item.prUrl ? { sourcePrUrl: item.prUrl } : {}),
        ...(item.spec ? { spec: Object.freeze({ ...item.spec, files: Object.freeze([...item.spec.files]) }) } : {}),
        mainSha, mergedSha, reversePatch, grading: Object.freeze({ main: "pass", candidate: "fail" }),
        proofs: Object.freeze(item.proofs.map((proof) => Object.freeze({ ...proof }))) }));
    } catch (error) {
      reject(`candidate could not be measured: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (added) git(options.repoDir, ["worktree", "remove", "--force", candidateDir]);
      rmSync(root, { recursive: true, force: true });
    }
  }
  return { sampled, kept, excluded, keepRate: sampled === 0 ? 0 : kept.length / sampled };
}
