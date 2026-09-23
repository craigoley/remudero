import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { bestNearDuplicate } from "./knowledge-dedup.js";
import { loadPlan, type RetirementReason, type Task } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { loadCreditStore } from "./status.js";

/**
 * lib/plan-gardener.ts (W1-T4111) — the plan queue tends itself.
 *
 * The queue only grew: filing-time dedup stops a NEW duplicate, but duplicates already filed stay
 * queued forever, and a task whose work already shipped or whose dependency was retired waits
 * for a person to notice. Each pass proposes ONE class of change as ONE pull request:
 *   - MERGE: a queued task whose title matches an older queued task exactly (numbers and case
 *     aside) and that declares the same files is withdrawn in favour of the older one.
 *   - RETIRE: a queued task whose every acceptance proof already holds is closed; one that depends
 *     on a retired task is retired.
 * Both write `retirement:`, which doctrine reserves to a person, so both are `review: "operator"`
 * (gardener.ts): the PR opens as a draft and the class is judged by the operator's decision.
 *
 * REPRIORITIZE is deliberately absent: dispatch already orders the queue by measured value
 * (dispatch-value.ts, W1-T3412), so writing `priority:` from the same evidence would count it twice.
 */

export type PlanGardenClass = "merge" | "retire";
export const PLAN_GARDEN_CLASSES: readonly PlanGardenClass[] = ["merge", "retire"];

export interface PlanGardenAction extends GardenAction<PlanGardenClass> {
  /** For a merge: the older task it is folded into. */
  into?: string;
  retirement: RetirementReason;
}

export interface PlanInventory {
  /** Queued, unretired, uncredited tasks, in plan order. */
  open: Task[];
  all: Task[];
  /** Task id → repo-relative shard path, for tasks that live in their own shard. */
  shards: Map<string, string>;
}

/** Title similarity at which two queued tasks are one task. Exact, because templated titles for
 *  different subjects (one ci-learning lesson per gate) score 0.8 against each other. */
export const DUPLICATE_TITLE_SIMILARITY = 1;

export function planInventory(repoRoot: string, stateDir: string): PlanInventory {
  const layout = resolveRepoLayout(repoRoot);
  const plan = loadPlan(layout.planMonolith);
  const credited = loadCreditStore(join(stateDir, "merge-credit.json"));
  const open = plan.tasks.filter((t) => t.status === "queued" && !t.retirement && !credited[t.id]);
  return { open, all: plan.tasks, shards: planShards(repoRoot) };
}

/** Task id → repo-relative path, for every shard that holds exactly one task — the only shape a
 *  one-line edit can change without touching a neighbour. */
export function planShards(repoRoot: string): Map<string, string> {
  const dir = join(dirname(resolveRepoLayout(repoRoot).planMonolith), "tasks.d");
  const shards = new Map<string, string>();
  if (!existsSync(dir)) return shards;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".yaml")) continue;
    const ids = [...readFileSync(join(dir, ent.name), "utf8").matchAll(/^- id: (\S+)[ \t]*$/gm)].map((m) => m[1]!);
    if (ids.length === 1) shards.set(ids[0]!, relative(repoRoot, join(dir, ent.name)));
  }
  return shards;
}

const filesKey = (t: Task): string => [...(t.files ?? [])].sort().join("\n");

/** Filing order: by id prefix, then task NUMBER, so a three-digit id sorts before a four-digit one. */
function byFilingOrder(a: Task, b: Task): number {
  const parse = (id: string) => /^(.*-T)(\d+)(.*)$/.exec(id) ?? [id, id, "0", ""];
  const [, pa, na, sa] = parse(a.id);
  const [, pb, nb, sb] = parse(b.id);
  return pa!.localeCompare(pb!) || Number(na) - Number(nb) || sa!.localeCompare(sb!);
}

/** [newer, older] pairs of open tasks that are the same task. Each task is folded at most once and
 *  never into a task that is itself folded. */
export function duplicateTasks(queued: Task[]): Array<[Task, Task]> {
  const open = [...queued].sort(byFilingOrder);
  const pairs: Array<[Task, Task]> = [];
  const folded = new Set<string>();
  for (let j = 1; j < open.length; j++) {
    const newer = open[j]!;
    const older = open.slice(0, j).filter((t) => !folded.has(t.id) && filesKey(t) === filesKey(newer));
    const match = bestNearDuplicate({ id: newer.id, text: newer.title }, older.map((t) => ({ id: t.id, text: t.title })));
    if (match && match.score >= DUPLICATE_TITLE_SIMILARITY) {
      pairs.push([newer, older.find((t) => t.id === match.id)!]);
      folded.add(newer.id);
    }
  }
  return pairs;
}

/** Whether a `grep: <pattern> in <path>` proof matches at `repoRoot`, read the way the review
 *  executor reads it. Anything else is not a proof this gardener can check. */
export function grepProofHolds(repoRoot: string, proof: string): boolean {
  const body = /^grep: (.+) in (\S+)$/.exec(proof.trim());
  if (!body) return false;
  try {
    execFileSync("grep", ["-arn", "--", body[1]!, body[2]!], { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    // deliberate: grep exits non-zero for no match and for a missing path alike; either way the
    // proof does not hold, and a task is only proposed when EVERY proof holds.
    return false;
  }
}

export function retirementCandidates(inv: PlanInventory, repoRoot: string): PlanGardenAction[] {
  const retired = new Set(inv.all.filter((t) => t.retirement).map((t) => t.id));
  const out: PlanGardenAction[] = [];
  for (const t of inv.open) {
    const gone = t.depends_on.filter((d) => retired.has(d));
    if (gone.length > 0) {
      out.push({ class: "retire", target: t.id, retirement: "retired", reason: `It depends on ${gone.join(", ")}, which will never be built.` });
      continue;
    }
    // A proof that greps the task's OWN shard holds from the moment it is filed, so it is no evidence the
    // work happened; only proofs about other files count, and there must be at least one.
    const own = inv.shards.get(t.id);
    const proofs = (t.acceptance ?? []).map((c) => c.proof).filter((p) => !own || !p.trim().endsWith(` in ${own}`));
    if (proofs.length > 0 && proofs.every((p) => grepProofHolds(repoRoot, p))) {
      out.push({ class: "retire", target: t.id, retirement: "closed", reason: "Every acceptance proof already holds on main." });
    }
  }
  return out;
}

export function planCandidates(inv: PlanInventory, repoRoot: string): PlanGardenAction[] {
  const inShard = (id: string) => inv.shards.has(id);
  const merges: PlanGardenAction[] = duplicateTasks(inv.open)
    .filter(([newer]) => inShard(newer.id))
    .map(([newer, older]) => ({ class: "merge", target: newer.id, into: older.id, retirement: "withdrawn", reason: "Its title and files repeat an older queued task." }));
  const merging = new Set(merges.map((m) => m.target));
  return [...merges, ...retirementCandidates(inv, repoRoot).filter((a) => inShard(a.target) && !merging.has(a.target))];
}

/** The comment an action leaves in the shard it changed. */
export function planGardenMarker(a: PlanGardenAction): string {
  return `plan gardener: ${a.class} ${a.target}${a.into ? ` into ${a.into}` : ""}`;
}

/** Retire each target in its own shard by editing its `status:` line, so the diff is exactly the
 *  retirement. A shard already retired, or with no `status:` line, is left alone. */
export function applyPlanActions(repoRoot: string, shards: Map<string, string>, actions: PlanGardenAction[]): string[] {
  const changed: string[] = [];
  for (const a of actions) {
    const rel = shards.get(a.target);
    if (!rel) continue;
    const path = join(repoRoot, rel);
    const text = readFileSync(path, "utf8");
    if (/^ {2}retirement:/m.test(text) || !/^ {2}status: \w+[ \t]*$/m.test(text)) continue;
    writeFileSync(path, text.replace(/^ {2}status: \w+[ \t]*$/m, `  status: blocked\n  retirement: ${a.retirement}\n  # ${planGardenMarker(a)} — ${a.reason}`));
    changed.push(rel);
  }
  return changed.sort();
}

function prBody(actions: PlanGardenAction[], shards: Map<string, string>): string {
  const lines = [
    "The plan gardener (W1-T4111) proposes retiring queued tasks. A retirement is a person's call, so this PR is a draft and will not merge itself: mark it ready and merge to accept, or close it to decline — the gardener learns from either.",
    "",
    ...actions.map((a) => `- **${a.class}** \`${a.target}\`${a.into ? ` into \`${a.into}\`` : ""} (\`retirement: ${a.retirement}\`): ${a.reason}`),
    "",
    "## Acceptance",
    ...actions.flatMap((a) => [`- claim: the gardener's ${a.class} of ${a.target} is marked in its shard`, `  proof: grep: ${planGardenMarker(a)} in ${shards.get(a.target)}`]),
  ];
  return lines.join("\n");
}

/** Modification times of the plan and the credit store, so an unchanged queue costs a few stats. */
export function planCheapFingerprint(repoRoot: string, stateDir: string): string {
  const layout = resolveRepoLayout(repoRoot);
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return [mtime(layout.planMonolith), mtime(join(dirname(layout.planMonolith), "tasks.d")), mtime(join(stateDir, "merge-credit.json"))].join(",");
}

/** The plan queue as a gardener spec. */
export function planGardenSpec(deps: GardenerDeps): GardenSpec<PlanGardenClass, PlanInventory, PlanGardenAction, GardenCheckout> {
  return {
    name: "plan",
    classes: PLAN_GARDEN_CLASSES,
    review: {
      merge: "folding a duplicate writes `retirement:`, which doctrine reserves to a person.",
      retire: "a retirement is a judgement call, which doctrine reserves to a person.",
    },
    cheapFingerprint: () => planCheapFingerprint(deps.repoRoot, deps.stateDir),
    inventory: () => planInventory(deps.repoRoot, deps.stateDir),
    fingerprint: (inv) => `${inv.all.length}:${inv.open.map((t) => t.id).join(",")}`,
    candidates: (inv) => planCandidates(inv, deps.repoRoot),
    scorecard: (inv, plan) => ({ open: inv.open.length, tasks: inv.all.length, proposed: plan.actions.length }),
    apply: (ws, plan) => {
      const shards = planShards(ws.root);
      const paths = applyPlanActions(ws.root, shards, plan.actions);
      if (paths.length === 0) return undefined;
      const landed = plan.actions.filter((a) => paths.includes(shards.get(a.target) ?? ""));
      return {
        paths,
        title: `chore(plan): the plan gardener proposes to ${plan.acting[0]} ${landed.length} queued task(s)`,
        body: prBody(landed, shards),
      };
    },
  };
}
