import { parse } from "yaml";
import { posix } from "node:path";
import { isInPlanScope } from "./plan-scope.js";

type FilingTask = { id: string; files: string[]; acceptance: { claim: string; proof?: string }[] };
function proofText(proof: string | undefined): string {
  const text = proof?.trim() ?? "";
  return /^(`+)\s*([\s\S]*?)\s*\1$/.exec(text)?.[2].trim() ?? text;
}
export interface PlanFilingFixRoundInput {
  baselineDiffFiles?: readonly string[];
  introducedTaskIds?: readonly string[];
  newCommitMessages?: readonly { sha: string; message: string }[];
  priorShards?: Readonly<Record<string, string>>;
  nextShards?: Readonly<Record<string, string>>;
  /** Resolved unit-test proof -> matching paths that already exist on main. */
  mainTestPaths?: Readonly<Record<string, readonly string[]>>;
  declaredFilesByTask?: Readonly<Record<string, readonly string[]>>;
  unreadable?: string;
}

function tasks(text: string): FilingTask[] {
  const rows = parse(text);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("expected a non-empty task shard");
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || (row.files !== undefined &&
      (!Array.isArray(row.files) || row.files.some((file: unknown) => typeof file !== "string"))) ||
      (row.acceptance !== undefined && (!Array.isArray(row.acceptance) || row.acceptance.some((c: { claim?: unknown; proof?: unknown } | null) =>
        !c || typeof c.claim !== "string" || (c.proof !== undefined && typeof c.proof !== "string"))))) {
      throw new Error("invalid task id, files or acceptance");
    }
  }
  return rows.map(row => ({ ...row, files: row.files ?? [], acceptance: row.acceptance ?? [] }));
}

/** Preserve a filing's future contract; implementation rounds keep their existing credit rules. */
export function planFilingFixRoundRefusal(input: PlanFilingFixRoundInput): string | undefined {
  if (!input.baselineDiffFiles) return "unreadable baselineDiffFiles";
  if (!input.baselineDiffFiles.length || !input.baselineDiffFiles.every(isInPlanScope)) return undefined;
  if (input.unreadable) return `unreadable plan filing evidence: ${input.unreadable}`;
  const { introducedTaskIds, newCommitMessages, priorShards, nextShards, mainTestPaths, declaredFilesByTask } = input;
  for (const key of ["introducedTaskIds", "newCommitMessages", "priorShards", "nextShards", "mainTestPaths", "declaredFilesByTask"] as const) {
    if (input[key] === undefined) return `missing or unreadable ${key}`;
  }
  for (const commit of newCommitMessages!) {
    for (const match of commit.message.matchAll(/^Remudero-Task:[ \t]*(\S+)[ \t]*$/gm)) {
      if (introducedTaskIds!.includes(match[1])) return `commit ${commit.sha} carries Remudero-Task: ${match[1]}; ` +
        "plan-pr-emitter invariant: a plan filing must never credit the task it introduces";
    }
  }
  try {
    const seen = new Set<string>();
    for (const [path, before] of Object.entries(priorShards!)) {
      if (nextShards![path] === undefined) return `missing or unreadable introduced shard ${path}`;
      const after = tasks(nextShards![path]);
      for (const prior of tasks(before).filter(row => introducedTaskIds!.includes(row.id))) {
        seen.add(prior.id);
        const next = after.find(row => row.id === prior.id);
        if (!next) return `missing introduced task ${prior.id} in ${path}`;
        if (declaredFilesByTask![prior.id] === undefined) return `missing declared files for ${prior.id}`;
        if (next.acceptance.length < prior.acceptance.length) return `${prior.id} criterion count fell in ${path}`;
        for (const [index, criterion] of prior.acceptance.entries()) {
          const replacement: FilingTask["acceptance"][number] = next.acceptance[index];
          if (criterion.claim !== replacement.claim) return `${prior.id} criterion ${index + 1} claim changed in ${path}`;
          const proof = replacement.proof ?? "";
          if (proofText(criterion.proof) && !proofText(proof)) return `${prior.id} criterion ${index + 1} dropped its proof`;
          if (/^grep:/i.test(proofText(criterion.proof))) {
            const replacementSymbols = new Set<string>(proof.match(/[A-Za-z_$][\w$]*/g) ?? []);
            for (const symbol of (criterion.proof ?? "").matchAll(/([A-Za-z_$][\w$]*)\s*\\?\(/g)) {
              if (!replacementSymbols.has(symbol[1])) {
                return `${prior.id} criterion ${index + 1} dropped symbol ${symbol[1]} from its proof`;
              }
            }
          }
          if (proof !== criterion.proof && /^unit test:/i.test(proofText(proof))) {
            if (mainTestPaths![proof] === undefined) return `unreadable test paths for ${proof}`;
            const declared = new Set(declaredFilesByTask![prior.id].map(file => posix.normalize(file)));
            const outside = mainTestPaths![proof].filter(file => !declared.has(posix.normalize(file)));
            if (outside.length) return `${prior.id} criterion ${index + 1} targets existing tests outside declared files: ${outside.join(", ")}`;
          }
        }
      }
    }
    for (const id of introducedTaskIds!) if (!seen.has(id)) return `missing or unreadable prior shard for ${id}`;
  } catch (error) {
    const reason = `unreadable plan filing criteria: ${String(error)}`;
    return reason;
  }
  return undefined;
}

/** Read immutable prior/result trees through the caller's worktree git port. */
export async function readPlanFilingFixRoundInput(
  baselineDiffFiles: readonly string[], priorHead: string, nextHead: string,
  git: (args: string[]) => string | Promise<string>,
): Promise<PlanFilingFixRoundInput> {
  const input: PlanFilingFixRoundInput = { baselineDiffFiles };
  try {
    const mainPaths = new Set((await git(["ls-tree", "-r", "--name-only", "origin/main"])).split("\n").filter(Boolean).map(file => posix.normalize(file)));
    const priorShards: Record<string, string> = {};
    const nextShards: Record<string, string> = {};
    const declaredFilesByTask: Record<string, string[]> = {};
    const introducedTaskIds: string[] = [];
    const mainTestPaths: Record<string, string[]> = {};
    for (const path of baselineDiffFiles.filter(file => /^plan\/tasks\.d\/.*\.ya?ml$/.test(file) && !mainPaths.has(file))) {
      priorShards[path] = await git(["show", `${priorHead}:${path}`]);
      nextShards[path] = await git(["show", `${nextHead}:${path}`]);
      for (const task of tasks(priorShards[path])) {
        introducedTaskIds.push(task.id);
        declaredFilesByTask[task.id] = task.files;
      }
      for (const task of tasks(nextShards[path])) for (const criterion of task.acceptance) {
        const proof = criterion.proof ?? "";
        const target = /^unit test:\s*(.+)$/i.exec(proofText(proof))?.[1].trim();
        if (!target || mainTestPaths[proof] !== undefined) continue;
        const canonicalTarget = posix.normalize(target);
        if (/^test\/\S+\.[cm]?[jt]sx?$/.test(canonicalTarget)) {
          mainTestPaths[proof] = mainPaths.has(canonicalTarget) ? [canonicalTarget] : [];
        } else {
          let matches: string;
          try {
            matches = await git(["grep", "-l", "-F", "--", target, nextHead, "--", "test/"]);
          } catch (error) {
            const status = error as { status?: number; code?: number };
            if (status.status !== 1 && status.code !== 1) throw error;
            matches = ""; // Git exit 1 proves no title match; every other error refuses the round.
          }
          mainTestPaths[proof] = matches.split("\n").map(file => file.slice(file.indexOf(":") + 1)).filter(file => mainPaths.has(file));
        }
      }
    }
    const commits = (await git(["rev-list", `${priorHead}..${nextHead}`])).split("\n").filter(Boolean);
    const newCommitMessages = [];
    for (const sha of commits) newCommitMessages.push({ sha, message: await git(["show", "-s", "--format=%B", sha]) });
    Object.assign(input, { introducedTaskIds, priorShards, nextShards, mainTestPaths, declaredFilesByTask, newCommitMessages });
  } catch (error) {
    const reason = String(error);
    input.unreadable = reason;
  }
  return input;
}
