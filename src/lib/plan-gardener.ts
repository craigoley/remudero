import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { landTaskFilesAsync, type LandTaskFilesOpts, type TaskFileInput } from "./feedback-landing.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { bestNearDuplicate } from "./knowledge-dedup.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "./ops-catalog-source.js";
import { loadPlan, type RetirementReason, type Task } from "./plan.js";
import { planDestinationRepository } from "./plan-destination.js";
import { planPrPreflightAtCommitAsync, type PlanPrPreflightInput } from "./plan-pr-emitter.js";
import { preflightOnUnmovedRecords } from "./plan-reconcile-batch.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { loadCreditStore } from "./status.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

/**
 * lib/plan-gardener.ts (W1-T4111) — the plan queue tends itself.
 *
 * The queue only grew: filing-time dedup stops a NEW duplicate, but duplicates already filed stay
 * queued forever, and a task whose work already shipped or whose dependency was retired waits
 * for a person to notice. Each pass proposes ONE class of change as ONE pull request:
 *   - MERGE: a queued task whose title matches an older queued task exactly (numbers and case
 *     aside) and that declares the same files is withdrawn in favour of the older one.
 *   - RETIRE: reconcile shipped work as done with its landing commit (W1-T4861), or retire work
 *     that depends on an abandoned task.
 * Both are judgement calls and `review` classes (gardener.ts): each is judged
 * by whether its PR merges. The PR opens ready for review — never a draft — and flows through the
 * fleet's review and auto-merge like every other PR; closing it is how a person declines it.
 *
 * REPRIORITIZE belongs to the backlog gardener (W1-T4941), which places unprioritized work in
 * coarse bands. W1-T5112 orders within those bands by per-class measured value when available.
 */

export type PlanGardenClass = "merge" | "retire";
export const PLAN_GARDEN_CLASSES: readonly PlanGardenClass[] = ["merge", "retire"];

export interface PlanGardenAction extends GardenAction<PlanGardenClass> {
  /** For a merge: the older task it is folded into. */
  into?: string;
  retirement: RetirementReason;
  landingCommit?: string;
}

/** W1-T14642: the ops catalog as one read left it, at one pinned commit. */
export interface PlanOpsCatalog {
  /** The ops main commit every record's bytes below were read at: the landing's unmoved-records guard is judged against it. */
  pin: string;
  tasks: Task[];
  /** Task id → the record's path in the ops repository, for tasks that sit alone in their own shard. */
  shards: Map<string, string>;
  /** Record path → the bytes read at the pin, which an ops edit is made on. */
  sources: Map<string, string>;
}

/** W1-T14642: what reading the ops catalog answered. `off`: none is configured, so the public plan is the whole
 *  plan. `unavailable`: one is configured and could not be read now, so what it holds is unknown, never absent. */
export type PlanOpsRead = { outcome: "off" } | { outcome: "unavailable"; reason: string } | ({ outcome: "ok" } & PlanOpsCatalog);

/** W1-T14642: the plan gardener's two ops seams: the catalog read, and the ops plan landing an ops edit goes through. */
export interface PlanGardenOps {
  read: () => PlanOpsRead | Promise<PlanOpsRead>;
  /** Starts a landing of edited records, read at `pin`, in the ops repository; the production landing is awaited by its owner. */
  land: (inputs: readonly TaskFileInput[], pin: string) => void;
  /** Every id `refs/rmd-id/` holds, so a reserved, unfiled id is not called unknown; undefined when it cannot be read. */
  reservedIds?: () => Promise<ReadonlySet<string> | undefined>;
}

export interface PlanInventory {
  /** Queued, unretired, uncredited tasks, in plan order: the public catalog's, then the ops catalog's. */
  open: Task[];
  all: Task[];
  /** Task id → repo-relative shard path, for tasks that live in their own shard. */
  shards: Map<string, string>;
  /** W1-T14642: the ops catalog, when one was read. Its tasks are in `open` and `all` too. */
  ops?: PlanOpsCatalog;
  /** W1-T14642: every id a catalog holds or `refs/rmd-id/` reserves; absent when a configured ops catalog was unreadable, so no id can be called unknown. */
  known?: ReadonlySet<string>;
}

/** W1-T14642: the orphaned holds: blocked tasks, in either catalog, with no `retirement:` and no `needs_input:` question
 *  to wait on. Nothing releases or retires them, so they are flagged on the scorecard and never edited. */
export function orphanedHolds(inv: Pick<PlanInventory, "all">): string[] {
  return inv.all.filter((t) => t.status === "blocked" && !t.retirement && t.needs_input === undefined).map((t) => t.id);
}

/** Title similarity at which two queued tasks are one task. Exact, because templated titles for
 *  different subjects (one ci-learning lesson per gate) score 0.8 against each other. */
export const DUPLICATE_TITLE_SIMILARITY = 1;

/** A merge may reach main before the daemon refreshes merge-credit.json. A trailer in reachable
 * main history is a reason to HOLD a retirement proposal, not to grant build credit: the durable
 * credit resolver also checks PR scope and the independent head-branch path. */
export function mainTrailerTaskIds(repoRoot: string): Set<string> {
  const result = spawnSync("git", ["-C", repoRoot, "log", "--format=%B", "--grep=^Remudero-Task:", "HEAD"], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`plan gardener: cannot read task trailers from main history: ${result.error?.message ?? String(result.stderr ?? "").trim()}`);
  }
  return new Set([...result.stdout.matchAll(/^Remudero-Task:[ \t]+([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$/gm)].map((m) => m[1]!));
}

/** `reserved`: the ids `refs/rmd-id/` holds (a reserved id is not unknown), or `"unreadable"` when they cannot be read. */
export function planInventory(repoRoot: string, stateDir: string, opsRead: PlanOpsRead = { outcome: "off" }, reserved: ReadonlySet<string> | "unreadable" = new Set()): PlanInventory {
  const layout = resolveRepoLayout(repoRoot);
  const plan = loadPlan(layout.planMonolith);
  const credited = loadCreditStore(join(stateDir, "merge-credit.json"));
  const inMain = mainTrailerTaskIds(repoRoot);
  const ops = opsRead.outcome === "ok" ? opsRead : undefined;
  const all = [...plan.tasks, ...(ops?.tasks ?? [])];
  const open = all.filter((t) => t.status === "queued" && !t.retirement && !credited[t.id] && !inMain.has(t.id));
  return {
    open, all, shards: planShards(repoRoot),
    ...(ops ? { ops: { pin: ops.pin, tasks: ops.tasks, shards: ops.shards, sources: ops.sources } } : {}),
    ...(opsRead.outcome === "unavailable" || reserved === "unreadable" ? {} : { known: new Set([...all.map((t) => t.id), ...reserved]) }),
  };
}

/** The ids a shard text holds, when exactly one: the only shape a one-line edit can change without touching a neighbour. */
export function soleTaskId(text: string): string | undefined {
  const ids = [...text.matchAll(/^- id: (\S+)[ \t]*$/gm)].map((m) => m[1]!);
  return ids.length === 1 ? ids[0] : undefined;
}

/** Task id → repo-relative path, for every shard that holds exactly one task — the only shape a
 *  one-line edit can change without touching a neighbour. */
export function planShards(repoRoot: string): Map<string, string> {
  const dir = join(dirname(resolveRepoLayout(repoRoot).planMonolith), "tasks.d");
  const shards = new Map<string, string>();
  if (!existsSync(dir)) return shards;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".yaml")) continue;
    const id = soleTaskId(readFileSync(join(dir, ent.name), "utf8"));
    if (id !== undefined) shards.set(id, relative(repoRoot, join(dir, ent.name)));
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

/**
 * The retirements that mean a task was ABANDONED — its work will never exist. `closed` is the other
 * kind: the work was done by other means or a recorded ruling (W1-T3762, "shipped in #5999"; W1-T1260,
 * "its deliverable is this entry"), so a task depending on it is satisfied, not stranded. #6885
 * proposed retiring W1-T3958 because its dependency was `closed`, and was wrong.
 */
export const ABANDONED_RETIREMENTS: ReadonlySet<RetirementReason> = new Set<RetirementReason>(["retired", "withdrawn"]);

/** Whether a `grep: <pattern> in <path>` proof matched in the tree at `ref`, read with the executor's
 *  basic-regex, binary-as-text grep. `undefined` when it cannot be read there (not a grep proof, or git
 *  failed on the ref) — never a guess either way. A path absent at `ref` did not match. */
export function grepProofHeldAt(repoRoot: string, ref: string, proof: string): boolean | undefined {
  const body = /^grep: (.+) in (\S+)$/.exec(proof.trim());
  if (!body) return undefined;
  const r = spawnSync("git", ["-C", repoRoot, "grep", "-q", "-G", "--text", "-e", body[1]!, ref, "--", body[2]!], { stdio: "ignore" });
  return r.status === 0 ? true : r.status === 1 ? false : undefined;
}

/** The commit that filed the shard at `shardRel` — the newest commit that ADDED it — or undefined
 *  when git cannot say (no history, not a repository). */
export function filingRef(repoRoot: string, shardRel: string): string | undefined {
  const r = spawnSync("git", ["-C", repoRoot, "log", "--diff-filter=A", "--format=%H", "--", shardRel], { encoding: "utf8" });
  const sha = r.status === 0 ? r.stdout.split("\n")[0]!.trim() : "";
  return sha === "" ? undefined : sha;
}

/** Walk backwards to the start of the current passing run on main, including a merge's own tree. */
export function proofLandingCommit(repoRoot: string, filed: string, proofs: string[]): string | undefined {
  if (proofs.length === 0) return undefined;
  const r = spawnSync("git", ["-C", repoRoot, "rev-list", "--first-parent", `${filed}..HEAD`], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  let landing: string | undefined;
  for (const ref of r.stdout.split("\n").filter(Boolean)) {
    const held = proofs.map((p) => grepProofHeldAt(repoRoot, ref, p));
    if (held.includes(undefined)) return undefined;
    if (!held.every(Boolean)) break;
    landing = ref;
  }
  return landing;
}

export function retirementCandidates(inv: PlanInventory, repoRoot: string): PlanGardenAction[] {
  const abandoned = new Set(inv.all.filter((t) => t.retirement && ABANDONED_RETIREMENTS.has(t.retirement)).map((t) => t.id));
  const out: PlanGardenAction[] = [];
  const opsIds = new Set((inv.ops?.tasks ?? []).map((t) => t.id));
  for (const t of inv.open) {
    if (t.status !== "queued" || t.retirement) continue;
    const gone = t.depends_on.filter((d) => abandoned.has(d));
    // W1-T14642: an id neither catalog holds names a task that was never filed or is gone; it can never be built.
    const unknown = t.depends_on.filter((d) => inv.known !== undefined && !inv.known.has(d));
    // An abandoned subject may still need a research finding; dependency state alone cannot retire recon.
    if (gone.length + unknown.length > 0 && t.type !== "recon") {
      const why = [...(gone.length > 0 ? [`It depends on ${gone.join(", ")}, which will never be built.`] : []),
        ...(unknown.length > 0 ? [`It depends on ${unknown.join(", ")}, which no catalog holds and no reservation covers.`] : [])];
      out.push({ class: "retire", target: t.id, retirement: "retired", reason: why.join(" ") });
      continue;
    }
    // The acceptance proofs below are read against the public checkout, never an ops record's.
    if (opsIds.has(t.id)) continue;
    // A proof that greps the task's OWN shard holds from the moment it is filed, so it is no evidence the
    // work happened; only proofs about other files count, and there must be at least one.
    const own = inv.shards.get(t.id);
    const allProofs = (t.acceptance ?? []).map((c) => c.proof);
    const proofs = allProofs.filter((p) => !own || !p.trim().endsWith(` in ${own}`));
    if (proofs.length === 0 || !allProofs.every((p) => grepProofHolds(repoRoot, p))) continue;
    // Nor is a proof that already held when the task was FILED: #6885 proposed closing W1-T3980 on
    // greps of symbols that predated it. Some proof must have failed at the filing commit, read there;
    // an unreadable filing commit or proof never closes a task.
    const filed = own ? filingRef(repoRoot, own) : undefined;
    const atFiling = filed ? proofs.map((p) => grepProofHeldAt(repoRoot, filed, p)) : [undefined];
    if (atFiling.includes(undefined) || atFiling.every((held) => held)) continue;
    const landingCommit = proofLandingCommit(repoRoot, filed!, allProofs);
    if (!landingCommit) continue;
    out.push({ class: "retire", target: t.id, retirement: "closed", landingCommit, reason: "Every acceptance proof now holds on main, and did not when it was filed." });
  }
  return out;
}

export function planCandidates(inv: PlanInventory, repoRoot: string): PlanGardenAction[] {
  const inShard = (id: string) => inv.shards.has(id);
  const inAnyShard = (id: string) => inShard(id) || (inv.ops?.shards.has(id) ?? false);
  const merges: PlanGardenAction[] = duplicateTasks(inv.open)
    .filter(([newer]) => inShard(newer.id))
    .map(([newer, older]) => ({ class: "merge", target: newer.id, into: older.id, retirement: "withdrawn", reason: "Its title and files repeat an older queued task." }));
  const merging = new Set(merges.map((m) => m.target));
  return [...merges, ...retirementCandidates(inv, repoRoot).filter((a) => inAnyShard(a.target) && !merging.has(a.target))];
}

/** The comment an action leaves in the shard it changed. */
export function planGardenMarker(a: PlanGardenAction): string {
  return `plan gardener: ${a.class} ${a.target}${a.into ? ` into ${a.into}` : ""}`;
}

/** W1-T14640: the shard without its `needs_input:` block (the line and every deeper-indented line under it). The
 *  question is moot once a merge or retirement settles the task, and lint-plan refuses it off `status: queued`. */
function withoutNeedsInput(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  const child = (line: string): boolean => /^ {3,}\S/.test(line);
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}needs_input:/.test(lines[i]!)) {
      kept.push(lines[i]!);
      continue;
    }
    // A blank line inside the block (a block-scalar question) is the block's while a deeper line follows it.
    let end = i + 1;
    for (let next = end; next < lines.length && (child(lines[next]!) || lines[next]!.trim() === ""); next++) if (child(lines[next]!)) end = next + 1;
    i = end - 1;
  }
  return kept.join("\n");
}

/** The shard text with `a` applied, or undefined when it is no longer a queued, unretired record. A landed task was
 *  BUILT: `done` alone. `retirement:` means it never will be, and is read only on a blocked task
 *  (test/retirement-reaches-its-reader.test.ts); the marker keeps the reason. */
export function planGardenEdit(text: string, a: PlanGardenAction): string | undefined {
  if (/^ {2}retirement:/m.test(text) || !/^ {2}status: queued[ \t]*$/m.test(text)) return undefined;
  const status = a.landingCommit ? "  status: done" : `  status: blocked\n  retirement: ${a.retirement}`;
  return withoutNeedsInput(text.replace(/^ {2}status: queued[ \t]*$/m, `${status}\n  # ${planGardenMarker(a)}${a.landingCommit ? ` commit ${a.landingCommit}` : ""} — ${a.reason}`));
}

/** Reconcile each queued target in its own shard; record a completion's landing commit in its marker. */
export function applyPlanActions(repoRoot: string, shards: Map<string, string>, actions: PlanGardenAction[]): string[] {
  const changed: string[] = [];
  for (const a of actions) {
    const rel = shards.get(a.target);
    if (!rel) continue;
    const path = join(repoRoot, rel);
    const edited = planGardenEdit(readFileSync(path, "utf8"), a);
    if (edited === undefined) continue;
    writeFileSync(path, edited);
    changed.push(rel);
  }
  return changed.sort();
}

/**
 * W1-T14642: the ops landing's inputs for the ops-catalog `actions`: each record's pinned bytes with the action applied,
 * and the criterion the landing PR states for it. A record that no longer reads as queued is left out. The landing
 * itself is guarded twice: its preflight ({@link opsPlanLandingPreflight}) refuses a candidate when any commit since the
 * pin touched a carried record, and the staged copy refuses a record whose blob on the ops main moved after staging.
 */
export function opsLandingInputs(ops: PlanOpsCatalog, actions: readonly PlanGardenAction[]): { inputs: TaskFileInput[]; landed: PlanGardenAction[] } {
  const inputs: TaskFileInput[] = [];
  const landed: PlanGardenAction[] = [];
  for (const a of actions) {
    const rel = ops.shards.get(a.target);
    const source = rel === undefined ? undefined : ops.sources.get(rel);
    const content = source === undefined ? undefined : planGardenEdit(source, a);
    if (rel === undefined || content === undefined) continue;
    inputs.push({
      relPath: rel, content,
      claim: `the gardener's ${a.class} of ${a.target} is marked in its record`,
      proof: `grep: ${planGardenMarker(a)} in ${rel}`,
    });
    landed.push(a);
  }
  return { inputs, landed };
}

function prBody(actions: PlanGardenAction[], shards: Map<string, string>): string {
  const lines = [
    "The plan gardener (W1-T4111) proposes reconciling queued tasks. This PR is reviewed and auto-merges like every fleet PR; close it to decline a proposal — the gardener learns from whether it merges.",
    "",
    ...actions.map((a) => `- **${a.class}** \`${a.target}\`${a.into ? ` into \`${a.into}\`` : ""} (${a.landingCommit ? `\`status: done\`, commit \`${a.landingCommit}\`` : `\`retirement: ${a.retirement}\``}): ${a.reason}`),
    "",
    "## Acceptance",
    ...actions.flatMap((a) => [
      `- claim: the gardener's ${a.class} of ${a.target} is marked in its shard${a.landingCommit ? ` with landing commit ${a.landingCommit}` : ""}`,
      `  proof: grep: ${planGardenMarker(a)}${a.landingCommit ? ` commit ${a.landingCommit}` : ""} in ${shards.get(a.target)}`,
      ...(a.landingCommit ? [`- claim: ${a.target} is done`, `  proof: grep: ^  status: done$ in ${shards.get(a.target)}`] : []),
    ]),
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
export function planGardenSpec(deps: GardenerDeps, opsSeam?: PlanGardenOps): GardenSpec<PlanGardenClass, PlanInventory, PlanGardenAction, GardenCheckout> {
  // The ops catalog the pass's own inventory read: an ops edit is made on those bytes, so apply reads them from here.
  let readOps: PlanOpsCatalog | undefined;
  const inventoryOf = (opsRead: PlanOpsRead, reserved?: ReadonlySet<string> | "unreadable"): PlanInventory => {
    const inv = planInventory(deps.repoRoot, deps.stateDir, opsRead, reserved);
    readOps = inv.ops;
    return inv;
  };
  return {
    name: "plan",
    classes: PLAN_GARDEN_CLASSES,
    review: {
      merge: "folding a duplicate writes `retirement:`, a judgement call.",
      retire: "reconciling completed or abandoned work is a judgement call.",
    },
    cheapFingerprint: () => planCheapFingerprint(deps.repoRoot, deps.stateDir),
    // A sync caller cannot await the catalog read, so with an ops seam it sees the ops catalog as unreadable.
    inventory: () => inventoryOf(opsSeam ? { outcome: "unavailable", reason: "sync-read" } : { outcome: "off" }),
    ...(opsSeam ? { inventoryAsync: async () => {
      const opsRead = await opsSeam.read();
      return inventoryOf(opsRead, opsSeam.reservedIds ? (await opsSeam.reservedIds()) ?? "unreadable" : undefined);
    } } : {}),
    fingerprint: (inv) => `${inv.all.length}:${inv.open.map((t) => t.id).join(",")}`,
    candidates: (inv) => planCandidates(inv, deps.repoRoot),
    scorecard: (inv, plan) => {
      const orphaned = orphanedHolds(inv);
      return {
        open: inv.open.length, tasks: inv.all.length, proposed: plan.actions.length, opsTasks: inv.ops?.tasks.length ?? null,
        orphanedHolds: orphaned.length, orphanedHoldIds: orphaned.slice(0, 20),
      };
    },
    apply: (ws, plan) => {
      const shards = planShards(ws.root);
      const paths = applyPlanActions(ws.root, shards, plan.actions.filter((a) => shards.has(a.target)));
      // An ops record is not in this checkout: it lands through the ops plan landing, beside the public PR.
      if (opsSeam && readOps) {
        const { inputs } = opsLandingInputs(readOps, plan.actions.filter((a) => !shards.has(a.target)));
        if (inputs.length > 0) opsSeam.land(inputs, readOps.pin);
      }
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

/**
 * W1-T14642 — the plan gardener's production ops seams (the ops catalog read, the ops plan landing, the reservation read).
 *
 * READ: the ops task catalog at one pinned commit (ops-catalog-source.ts), each record's bytes read from the ops
 * checkout at that pin. A catalog that cannot be read is `unavailable`, never an empty catalog: what it holds is
 * unknown, so the gardener calls no dependency unknown while it is.
 * LAND: an ops edit goes through the sealed task-files landing into the plan destination, never into the public tree,
 * so one landing never mixes public and ops paths.
 */
/**
 * The part of the ops status landing every ops plan landing shares (buildCatalogPlanReconcileInput in run-task.ts calls
 * it too): the ops checkout must hold `pin`, the commit the catalog was read at. A checkout that lags the API-pinned main
 * is fetched, without switching its branch, and is only used when the fetched main is that same commit; otherwise this
 * throws `ops-status-source-moved`, and a git failure throws as it is.
 */
export async function assertOpsCheckoutAtPin(checkoutDir: string, pin: string): Promise<void> {
  if ((await hostWorktreeGitAsync(checkoutDir, ["rev-parse", "HEAD"])).trim() === pin) return;
  await hostWorktreeGitAsync(checkoutDir, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if ((await hostWorktreeGitAsync(checkoutDir, ["rev-parse", "origin/main"])).trim() !== pin) throw new Error("ops-status-source-moved");
}

export interface OpsPlanLandingPreflightOptions {
  /** The ops repository's checkout the landing builds its candidate in. */
  checkoutDir: string;
  pin: string;
  /** The record paths the landing carries pin-derived bytes for; read when the preflight runs, so it may fill after this is built. */
  carriedPaths: Iterable<string>;
  /** The public code root the plan lint and the task-id check run from. */
  codeRoot: string;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** The plan PR preflight run after the unmoved-records guard; a test's stand-in. */
  inner?: typeof planPrPreflightAtCommitAsync;
}

/**
 * The plan PR preflight of an ops plan landing, shared by the ops status reconcile and the plan gardener: a candidate based
 * on a newer ops main must never overwrite it with bytes read at the older pin (W1-T14574), so the plan preflight (plan-body
 * proofs read against the candidate's plan folder) runs only when no commit since the pin touched a carried record.
 */
export function opsPlanLandingPreflight(o: OpsPlanLandingPreflightOptions): (sha: string, pr: Omit<PlanPrPreflightInput, "cwd">) => Promise<Awaited<ReturnType<typeof planPrPreflightAtCommitAsync>>> {
  const inner = o.inner ?? planPrPreflightAtCommitAsync;
  return preflightOnUnmovedRecords(
    (args) => hostWorktreeGitAsync(o.checkoutDir, args), o.pin, o.carriedPaths,
    (sha, pr: Omit<PlanPrPreflightInput, "cwd">) => inner(o.checkoutDir, sha, { ...pr, codeRoot: o.codeRoot, bodyProofRoot: "plan" }, { log: o.log }),
  );
}

export interface ProductionPlanGardenOpsOptions {
  repoRoot: string;
  stateDir: string;
  /** Daemon state root: the sealed landing's queue waits under it. */
  stateRoot: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  api?: OpsCatalogApi;
  /** The sealed landing, replaceable so a test lands nothing. */
  landTaskFiles?: typeof landTaskFilesAsync;
  /** The plan PR preflight the landing runs once its unmoved-records guard passes; the real one when absent. */
  planPrPreflight?: typeof planPrPreflightAtCommitAsync;
}

export function productionPlanGardenOps(o: ProductionPlanGardenOpsOptions): PlanGardenOps & { settled: () => Promise<void> } {
  const landings: Promise<void>[] = [];
  // One `ls-remote` of the reservation namespace; a read that fails is unknown, never "no reservations".
  const reservedIds = async (): Promise<ReadonlySet<string> | undefined> => {
    try {
      const out = await hostWorktreeGitAsync(o.repoRoot, ["ls-remote", "origin", "refs/rmd-id/*"]);
      return new Set([...out.matchAll(/refs\/rmd-id\/([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$/gm)].map((m) => m[1]!));
    } catch (error) {
      o.log("plan.reservations_unreadable", { error: String((error as Error)?.message ?? error) });
      return undefined;
    }
  };
  const landTaskFiles = o.landTaskFiles ?? landTaskFilesAsync;
  const read = async (): Promise<PlanOpsRead> => {
    const destination = planDestinationRepository(o.stateDir);
    if (destination.outcome === "off") return { outcome: "off" };
    if (destination.outcome !== "named") return { outcome: "unavailable", reason: `plan-destination-${destination.outcome}` };
    const snapshot = await readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, o.api);
    if (snapshot.outcome !== "ok" || !snapshot.plan || !snapshot.binding) return { outcome: "unavailable", reason: `ops-${snapshot.outcome}` };
    const publicPlan = loadPlan(resolveRepoLayout(o.repoRoot).planMonolith);
    // One id held by both catalogs is ambiguous: neither copy can be edited by id.
    if (snapshot.plan.tasks.some((t) => publicPlan.byId.has(t.id))) return { outcome: "unavailable", reason: "ops-duplicate_task_id" };
    const pin = snapshot.binding.commit;
    const shards = new Map<string, string>();
    const sources = new Map<string, string>();
    try {
      // The records' bytes are read at the pin, so the checkout must hold it, exactly as the ops status reconcile requires.
      await assertOpsCheckoutAtPin(destination.checkoutDir, pin);
      for (const task of snapshot.plan.tasks) {
        const source = task.sourcePath;
        if (!source || !/^tasks\.d\/[^/]+\.ya?ml$/.test(source)) continue;
        const path = `plan/${source}`;
        if (!sources.has(path)) sources.set(path, await hostWorktreeGitAsync(destination.checkoutDir, ["show", `${pin}:${path}`]));
        // Only a record that sits alone in its file can be edited without touching a neighbour.
        if (soleTaskId(sources.get(path)!) === task.id) shards.set(task.id, path);
      }
    } catch (error) {
      // A checkout that lags or lacks the pin leaves the ops catalog unknown, never failing the public pass.
      o.log("plan.ops_checkout_unreadable", { error: String((error as Error)?.message ?? error) });
      return { outcome: "unavailable", reason: "ops-checkout-unreadable" };
    }
    return { outcome: "ok", pin, tasks: snapshot.plan.tasks, shards, sources };
  };
  const land = (inputs: readonly TaskFileInput[], pin: string): void => {
    const destination = planDestinationRepository(o.stateDir);
    if (destination.outcome !== "named") {
      o.log("plan.ops_landing_skipped", { reason: `plan-destination-${destination.outcome}`, records: inputs.length });
      return;
    }
    const opts: LandTaskFilesOpts = {
      stateRoot: o.stateRoot, targetRepository: { owner: destination.owner, repo: destination.repo }, log: o.log, lane: "plan",
      // The ops status landing's preflight: refuse a candidate whose carried records moved since the pin.
      planPrPreflight: opsPlanLandingPreflight({
        checkoutDir: destination.checkoutDir, pin, carriedPaths: inputs.map((i) => i.relPath), codeRoot: o.repoRoot, log: o.log,
        ...(o.planPrPreflight ? { inner: o.planPrPreflight } : {}),
      }),
    };
    landings.push(landTaskFiles(destination.checkoutDir, [...inputs], opts).then((result) => {
      o.log("plan.ops_landing", { records: inputs.length, pr_url: result.prUrl ?? null, landed: result.landed.length, waiting: result.waiting.length, refused: result.refused.length, ...(result.error ? { error: result.error } : {}) });
    }, (error: unknown) => {
      o.log("plan.ops_landing_failed", { records: inputs.length, error: String((error as Error)?.message ?? error) });
    }));
  };
  // A landing's failure is logged where it happens, so waiting on the landings never throws.
  return { read, land, reservedIds, settled: async () => void (await Promise.all(landings.splice(0))) };
}
