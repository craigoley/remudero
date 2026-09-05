import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * plan/tasks.yaml loader + validator (schema v1, MASTER-PLAN §2).
 *
 * The control plane flips `status`; humans and the Architect edit narrative.
 * This module only READS and VALIDATES — it never writes the plan (the runner
 * owns status writes separately). A task may carry a pre-authored `prompt` and
 * cited `context` entries (G-2: v0 prompts are pre-authored per task).
 */

export const TASK_STATUSES = [
  "queued",
  "recon",
  "prompted",
  "running",
  "review",
  "fixing",
  "diagnosing",
  "blocked",
  "merged",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Risk band — the second axis of the mount routing table (task_type × risk, §9). */
export const TASK_RISKS = ["low", "medium", "high"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];
/** Default risk when a task omits it (medium — the routing table's middle mount). */
export const DEFAULT_RISK: TaskRisk = "medium";

/**
 * W1-T2503: which of two things a `risk: high` band ASSERTS for THIS task — Rule 19's
 * SPAN measure (`"span"`, ≥2 subsystems/concerns) or genuine BLAST RADIUS unrelated to
 * span (`"blast-radius"`: a boot script, an auth path, a merge arm). Before this field
 * the two facts — different review implications each — shared one value with nothing
 * recording which; fifteen shards filed in a single session wrote the distinction by
 * hand as prose their linter never read. See task-linter.ts's `sizingViolation` for
 * where this is enforced: computed and REPORTED for `"span"`, exempt for
 * `"blast-radius"`, and required only on a task the diff newly files or promotes to
 * `risk: high` — the standing backlog authored before this field existed is read as
 * `undefined` and is reported, never refused.
 */
export const BAND_MEANINGS = ["span", "blast-radius"] as const;
export type BandMeaning = (typeof BAND_MEANINGS)[number];

/** A dependency is "satisfied" only once it has landed. */
const MERGED_STATUSES = new Set<TaskStatus>(["merged", "done"]);

/**
 * Retirement taxonomy (W1-T1287) — the sibling field that replaces the `RETIRED (…)` /
 * `CLOSED UNBUILT (…)` title-prefix convention (carried by 2 of 790 tasks, read by nothing in
 * `src/` or `test/`) with something a reader can actually filter on. Mirrors `learnings.ts`'s
 * `lifecycle` shape: a small closed vocabulary, validated at load, fail-closed on anything else
 * — the SAME three words (W1-T1287's rationale (2)) already found in use as candidate
 * `TASK_STATUSES` members before that task's Q1 ruled a new status-enum member out precisely
 * because it would re-litigate `blocked`'s exclusion semantics at four independent sites. A
 * sibling field on an already-excluded record cannot perturb that exclusion BY CONSTRUCTION.
 */
export const RETIREMENT_REASONS = ["retired", "closed", "withdrawn"] as const;
export type RetirementReason = (typeof RETIREMENT_REASONS)[number];

export interface AcceptanceCriterion {
  claim: string;
  proof: string;
  /**
   * ARCHITECT-ONLY. A PR (url or `#N`) that ALREADY satisfied this criterion in an
   * EARLIER merge. The deterministic judge treats such a criterion as MET, citing
   * that PR as the proof — the reviewer judges diff+report and never repo state, so
   * a criterion satisfied by an earlier PR is otherwise permanently unsatisfiable
   * by a later one. **May ONLY be set by a human/Architect in a plan PR.** A worker
   * adding `satisfied_by` to its own blocking criterion is "editing the criteria to
   * match the diff" (Standing rule 15) — a failed task. (W1-T3F makes the reviewer
   * OBSERVE repo state, which is the real fix; `satisfied_by` is the manual patch.)
   */
  satisfied_by?: string;
  /**
   * W1-T166 (the SpecBench reward-hacking finding): a criterion a worker that can
   * optimize TO the visible test suite would otherwise game. `holdout: true` marks
   * it REVIEWER-VISIBLE but WORKER-HIDDEN — every prompt assembled for a worker
   * (recon, implement, the fix rung's unmet-criteria block, the post-compaction
   * ANCHOR) filters it out via {@link visibleCriteria}; `buildReviewPrompt`
   * (lib/review.ts) deliberately does NOT filter through it, since the reviewer
   * must judge visible AND holdout criteria both — a diff that passes visible-only
   * still yields an overall FAIL (`judgeReview`). The visible-pass vs holdout-pass
   * gap is the reward-hacking measurement, ledgered per run as `reward_hacking_gap`
   * (see `ReviewVerdict.rewardHackingGap`). Absent/false is the default: an
   * ordinary criterion, shown to the worker like any other.
   */
  holdout?: boolean;
}

/**
 * Criteria a WORKER may be shown (W1-T166): every criterion EXCEPT `holdout:
 * true` ones. The single filter every worker-facing prompt assembler routes
 * through — `renderAnchorBlock` (lib/compaction.ts) and the fix rung's
 * unmet-criteria block (run-task.ts) both call this rather than each
 * hand-rolling its own `!c.holdout` predicate, so "never shown to a worker"
 * has exactly ONE implementation to audit. Generic over anything carrying an
 * optional `holdout` flag — both {@link AcceptanceCriterion} (the task's
 * authored list) and `CriterionVerdict` (lib/review.ts's judged list, which
 * copies `holdout` from the criterion it judged) satisfy it.
 */
export function visibleCriteria<T extends { holdout?: boolean }>(criteria: T[]): T[] {
  return criteria.filter((c) => !c.holdout);
}

/** A pre-authored, pre-cited CONTEXT claim (provenance is mandatory — §2). */
export interface ContextClaim {
  claim: string;
  src: string;
}

export interface Task {
  id: string;
  title: string;
  repo: string;
  depends_on: string[];
  type: "recon" | "implement" | "diagnose" | "review" | "manual";
  verify: "auto" | "human";
  /**
   * Risk band (second mount-routing axis, §9) → resolves the run's mount
   * (model/effort/max_turns) via resolveMount(type, risk). Absent ⇒ {@link
   * DEFAULT_RISK} (medium). Schema/CI/telemetry-touching tasks run `high`.
   */
  risk: TaskRisk;
  /**
   * W1-T2503: which of two things THIS task's `risk: high` band means — Rule 19's SPAN
   * (`"span"`) or genuine BLAST RADIUS unrelated to span (`"blast-radius"`). See {@link
   * BandMeaning}'s own doc comment for the full rationale. Optional on every task,
   * including `risk: high` ones — required-ness is enforced by the §5C linter's
   * `sizingViolation` (task-linter.ts), never by this loader, and ONLY for a task the
   * diff newly files or promotes to high; a task already high before that is read as
   * `undefined` and reported, never refused.
   */
  band_meaning?: BandMeaning;
  /**
   * OPTIONAL dispatch priority (lower dispatches sooner; absent ⇒ the default tier,
   * ordered after every task that carries one). The honest successor to file
   * placement in `plan/tasks.yaml`, which `dispatchOrder` (lib/drain.ts) deliberately
   * stopped reading — see that function's impl-DQ comment for the full history. Read
   * ONLY by `compareDispatch`; parsing tolerates absence everywhere, so every task
   * filed before this field existed is unaffected. The §5C linter's `dispatch-priority`
   * check (lib/task-linter.ts) WARNS on a value outside [0, 99] or set on a non-open
   * task, so a stray value degrades to odd ordering rather than rotting silently.
   */
  priority?: number;
  /**
   * DECORATIVE / initial-state only. Real merge-state is DERIVED FROM GITHUB
   * (see lib/status.ts deriveStatus) and never written back here. Kept so the
   * schema is stable and a fresh plan reads sensibly.
   */
  status: TaskStatus;
  attempts: number;
  /**
   * Explicit PR number for a task executed by hand before it had a ledger entry
   * (precedence source (b) in deriveStatus). Never written by the machine.
   */
  pr?: number;
  principles?: Record<string, unknown>;
  budget_usd?: number;
  acceptance?: AcceptanceCriterion[];
  hand_built?: boolean;
  note?: string;
  /**
   * WHY this task exists (the operator-facing prose every task in plan/tasks.yaml already
   * carries — tasks.yaml's own header calls `origin:`/`plan_refs:` "DECLARATIVE metadata";
   * `rationale:` is the same kind of field, just not previously typed here). Read-only,
   * same as every other narrative field on this interface — lib/task-card.ts (W1-T158) is
   * the first real consumer, rendering it on the row-click task card.
   */
  rationale?: string;
  /** Provenance (Rules 16/17): where this task came from — `architect`, `feedback#…`,
   *  `alert#…`, `issue#…`. Never defaulted (unlike `risk`) — its absence is itself
   *  the fact the §5C linter's provenance check reports. */
  origin?: string;
  /** Pre-authored worker instruction (the "what to do"). */
  prompt?: string;
  /** Pre-cited context claims folded into the rendered prompt's CONTEXT block. */
  context?: ContextClaim[];
  /**
   * Repo-relative globs naming the files this task touches. Promptsmith matches
   * these against the `learnings/` corpus (subsystem shards + generated index,
   * W1-T33; originally one flat `plan/learnings.yaml`, W1-T19) to inject only
   * the RELEVANT, non-superseded learnings. Absent → the task is treated as
   * repo-wide (all entries candidate, still budget-bounded).
   */
  files?: string[];
  /**
   * OPERATOR-ONLY retirement category (W1-T1287) — records WHY a `status: "blocked"` task will
   * never be built, so a closed operator ruling (W1-T1261, W1-T1273 — both closed by ruling on
   * 2026-08-23) is no longer indistinguishable from the 41 other `blocked` records that are
   * merely dependency-stalled. NEVER auto-written: nothing in `src/` sets this field, the same
   * way `status` itself is machine-derived-elsewhere but this sibling is not (see W1-T1287 Q3
   * (x) — a retirement is a judgement call, not a re-verifiable assertion, so unlike
   * `learnings.ts`'s `quarantined` arm there is deliberately no auto-flip writer to copy).
   * Absent on every non-retired task, including every other `blocked` one. `blocked`'s own
   * exclusion semantics at `isDispatchEligible` (lib/drain.ts), `assertRunnable` (this file),
   * and `isOpenLintTask` (run-task.ts) read `status` alone and never this field — a task with
   * and without `retirement` filters identically at all three.
   */
  retirement?: RetirementReason;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface Plan {
  tasks: Task[];
  byId: Map<string, Task>;
}

function req<T>(v: T | undefined, field: string, id: string): T {
  if (v === undefined || v === null) throw new PlanError(`task ${id}: missing required field '${field}'`);
  return v;
}

/**
 * Parse + field-validate a YAML task-list BLOB into {@link Task}s (schema v1) — WITHOUT
 * checking that every `depends_on` id actually resolves. Split out of {@link
 * loadPlanFromYaml} so a caller validating a PARTIAL blob (a drafted `plan/tasks.yaml`
 * FRAGMENT that legitimately depends on ids from the rest of the plan it isn't itself
 * carrying — lib/inbox.ts's ratification-candidate drafts, W1-T110) can get real
 * per-task schema validation without a false "unknown task" failure on a dep that is
 * merely OUTSIDE this blob. {@link loadPlanFromYaml} is this function plus the
 * whole-blob dependency-existence check; a caller checking a fragment's deps against
 * a wider, already-merged plan (e.g. {@link "./inbox.js".classifyProposal}) gets a
 * STRONGER check for free — an unresolvable dep there is also necessarily unmerged,
 * so it is reported as unmet rather than as a separate parse failure.
 */
export function parseTasksFromYaml(text: string, sourceLabel: string): Task[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PlanError(`plan is not valid YAML (${sourceLabel}): ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new PlanError("plan must be a YAML list of task entries (schema v1).");

  const byId = new Map<string, Task>();
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new PlanError("each task must be a mapping.");
    const e = entry as Record<string, unknown>;
    const id = req(e.id as string, "id", String(e.id ?? "<unknown>"));
    if (byId.has(id)) throw new PlanError(`duplicate task id '${id}'`);
    const risk = (e.risk ?? DEFAULT_RISK) as TaskRisk;
    if (!TASK_RISKS.includes(risk)) {
      throw new PlanError(`task ${id}: invalid risk '${risk}' (must be ${TASK_RISKS.join("|")})`);
    }
    const status = (e.status ?? "queued") as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      throw new PlanError(`task ${id}: invalid status '${status}' (must be ${TASK_STATUSES.join("|")}; status is decorative/initial-state only — real merge-state is derived from GitHub, never written back here)`);
    }
    const retirement = e.retirement as RetirementReason | undefined;
    if (retirement !== undefined && !RETIREMENT_REASONS.includes(retirement)) {
      throw new PlanError(`task ${id}: invalid retirement '${String(retirement)}' (must be ${RETIREMENT_REASONS.join("|")})`);
    }
    const bandMeaning = e.band_meaning as BandMeaning | undefined;
    if (bandMeaning !== undefined && !BAND_MEANINGS.includes(bandMeaning)) {
      throw new PlanError(`task ${id}: invalid band_meaning '${String(bandMeaning)}' (must be ${BAND_MEANINGS.join("|")})`);
    }
    const task: Task = {
      id,
      title: req(e.title as string, "title", id),
      repo: req(e.repo as string, "repo", id),
      depends_on: Array.isArray(e.depends_on) ? (e.depends_on as string[]) : [],
      type: req(e.type as Task["type"], "type", id),
      verify: (e.verify as Task["verify"]) ?? "auto",
      risk,
      band_meaning: bandMeaning,
      priority: typeof e.priority === "number" ? e.priority : undefined,
      status,
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      principles: e.principles as Record<string, unknown> | undefined,
      budget_usd: e.budget_usd as number | undefined,
      acceptance: e.acceptance as AcceptanceCriterion[] | undefined,
      hand_built: e.hand_built as boolean | undefined,
      pr: typeof e.pr === "number" ? e.pr : undefined,
      note: e.note as string | undefined,
      rationale: e.rationale as string | undefined,
      origin: e.origin as string | undefined,
      prompt: e.prompt as string | undefined,
      context: e.context as ContextClaim[] | undefined,
      files: Array.isArray(e.files) ? (e.files as string[]) : undefined,
      retirement,
    };
    byId.set(id, task);
    return task;
  });
}

/**
 * Parse and validate an already-read plan/tasks.yaml BLOB (schema v1). Split out
 * of {@link loadPlan} so a caller that already has the text some other way (the
 * §5C linter's CI check reads a PAST revision via `git show <ref>:plan/tasks.yaml`,
 * never a second file on disk) can validate it identically — one schema, one
 * source of truth, whether the bytes came from a file or a git ref. Throws
 * {@link PlanError} on any problem; `sourceLabel` names the blob in error text.
 */
export function loadPlanFromYaml(text: string, sourceLabel: string): Plan {
  const tasks = parseTasksFromYaml(text, sourceLabel);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Every declared dependency must reference a real task WITHIN THIS BLOB — the
  // whole-plan-load contract {@link parseTasksFromYaml}'s own callers do not need.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }
  }
  return { tasks, byId };
}

/**
 * List the shard files under `plan/tasks.d/` (sorted, deterministic order) next to
 * `planPath`. Returns `[]` when the directory does not exist — the back-compat case
 * for every plan that has not migrated to sharding yet (W1-T122 design note (iv):
 * migrating the existing single-file entries is a separate, later codemod).
 */
function listShardFiles(shardDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(shardDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
}

/**
 * Load plan/tasks.yaml from disk AND merge in any shards under the sibling
 * `plan/tasks.d/*.yaml` directory (W1-T122: PLAN SHARDING). One task per shard
 * file means two concurrent filings each add a DIFFERENT file — they no longer
 * share an EOF to textually conflict on, which is the whole point (the
 * nine-PR appender train #271 was 437 lines of pure appends to one shared EOF).
 *
 * Every consumer of {@link loadPlan} sees the MERGED view — sharding is invisible
 * above this function. Duplicate ids across `tasks.yaml` and any shard (or across
 * two shards) FAIL LOUD: the uniqueness guarantee the single-file format gave for
 * free must not be lost in the split. When `plan/tasks.d/` does not exist (every
 * plan that has not migrated yet), this is byte-for-byte the old single-file
 * behavior — back-compat is load-bearing so migration can be staged separately.
 *
 * Throws {@link PlanError} on any problem.
 */
/**
 * Which FILE holds `taskId`'s record — the monolith or one of the shards — or `undefined`.
 *
 * WHY THIS IS DERIVED RATHER THAN CONSTRUCTED. `plan/tasks.d/<id>-<slug>.yaml` is the convention,
 * but it is only a convention: the slug is not recoverable from the id, and tasks still live in
 * `plan/tasks.yaml` (measured: 4 of them). A constructed string would be wrong for both cases and
 * wrong SILENTLY — it would name a path that does not exist and send a worker looking for it.
 *
 * IT REUSES `parseTasksFromYaml`, NOT A REGEX, so the answer is the one {@link loadPlan} would
 * resolve. A text scan for `- id: <taskId>` would also match a commented-out line, a `depends_on`
 * entry, or a mention in prose; the parser matches on the record the loader actually builds.
 *
 * FAIL-SOFT BY CONSTRUCTION: every read is guarded and an unreadable or unparseable file is simply
 * not the answer. The only caller renders an advisory prompt line, so a throw here would turn a
 * missing plan file into a failed RUN — strictly worse than the omission it is fixing.
 */
export function taskRecordPath(planPath: string, taskId: string): string | undefined {
  const holdsTask = (p: string): boolean => {
    try {
      return parseTasksFromYaml(readFileSync(p, "utf8"), p).some((t) => t.id === taskId);
    } catch {
      return false;
    }
  };
  // Monolith first, then shards — the same order `loadPlan` merges in. Ids are unique across the
  // merged view (it throws on a duplicate), so the order cannot change which file is returned.
  if (holdsTask(planPath)) return planPath;
  const shardDir = join(dirname(planPath), "tasks.d");
  for (const file of listShardFiles(shardDir)) {
    const shardPath = join(shardDir, file);
    if (holdsTask(shardPath)) return shardPath;
  }
  return undefined;
}

/**
 * W1-T2220: the file-read primitives {@link loadPlan} uses, injectable so a torn/short-read
 * race (a concurrent `git checkout --detach` truncating a shard IN PLACE while a request reads
 * it) can be exercised deterministically in a test instead of only in an 80-cycle live rig. The
 * real default just shells out to `node:fs`; nothing about the merge/dedup/depends_on logic
 * below changes.
 */
export interface FileIntegrityIO {
  statSize: (path: string) => number;
  readFile: (path: string) => string;
}

const defaultIntegrityIO: FileIntegrityIO = {
  statSize: (path) => statSync(path).size,
  readFile: (path) => readFileSync(path, "utf8"),
};

/**
 * Read a WHOLE file, refusing a torn/partial read rather than silently handing back a prefix.
 * `loadPlan` cannot tell "the whole file" from "a prefix of it" from `readFileSync` alone — YAML
 * that stops early is still valid YAML, and every field after the cut DEFAULTS instead of
 * failing (measured: 83.1% of truncated shard cuts still parse). The only honest signal
 * `loadPlan` has, with no expected length of its own, is a stat/read/stat size disagreement: if
 * the byte size on disk before the read, the bytes actually read, and the byte size on disk
 * after the read do not all agree, a writer touched this file DURING the read and the bytes are
 * not trustworthy — retried a few times (the torn window measured ~0.8% of reads and is brief;
 * a request-scoped retry loop costs nothing when no checkout is landing, per this task's design
 * note (iv)), then refused outright rather than ever being handed to the YAML parser. This is
 * remedy (a) of that design note: cheap, and "usually not partial" — see {@link loadPlanAtRef}
 * for the write-gate's stronger "cannot be partial" guarantee.
 */
export function readWholeFile(path: string, io: FileIntegrityIO = defaultIntegrityIO, maxAttempts = 3): string {
  let lastMismatch = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = io.statSize(path);
    const text = io.readFile(path);
    const after = io.statSize(path);
    const readBytes = Buffer.byteLength(text, "utf8");
    if (before === readBytes && after === readBytes) return text;
    lastMismatch = `stat ${before} vs read ${readBytes} bytes vs stat ${after} after`;
  }
  throw new Error(`short/torn read after ${maxAttempts} attempt(s) (${lastMismatch})`);
}

export function loadPlan(path: string, io: FileIntegrityIO = defaultIntegrityIO): Plan {
  let text: string;
  try {
    text = readWholeFile(path, io);
  } catch (err) {
    throw new PlanError(`cannot read plan file (${path}): ${String(err)}`);
  }
  const tasks = parseTasksFromYaml(text, path);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const shardDir = join(dirname(path), "tasks.d");
  for (const file of listShardFiles(shardDir)) {
    const shardPath = join(shardDir, file);
    let shardText: string;
    try {
      shardText = readWholeFile(shardPath, io);
    } catch (err) {
      // A shard that VANISHED BETWEEN THE LISTING AND THIS READ is a race, not corruption, and
      // skipping it is the only correct answer — it is not in the plan any more. Throwing here
      // made `loadPlan` fail whenever anything removed a shard concurrently: measured in CI as a
      // FILE-LEVEL crash of whichever suite happened to be reading the plan while
      // `test/task-linter-wiring.test.ts` cleaned up its probe shard, since `node --test`
      // parallelises across files and 39 suites name this directory. It is reachable in
      // production too — a filing or a `git checkout` can remove a shard mid-read.
      // ENOENT ONLY: every other errno (EACCES, EIO, EISDIR) still throws, because those mean the
      // shard is there and unreadable, which is exactly the corruption this guard must not hide.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw new PlanError(`cannot read plan shard (${shardPath}): ${String(err)}`);
    }
    for (const t of parseTasksFromYaml(shardText, shardPath)) {
      if (byId.has(t.id)) {
        throw new PlanError(`duplicate task id '${t.id}' (shard ${shardPath} collides with an earlier plan entry)`);
      }
      byId.set(t.id, t);
      tasks.push(t);
    }
  }

  // Every declared dependency must resolve WITHIN THE MERGED VIEW (tasks.yaml + all
  // shards) — same contract loadPlanFromYaml enforces for a single blob.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }
  }
  return { tasks, byId };
}

/**
 * W1-T2220 remedy (c): load the plan from committed git objects — `git show <ref>:<path>` —
 * rather than the working tree, for the ONE caller that cannot afford {@link loadPlan}'s
 * stat/read/stat retry (remedy (a), "usually not partial"): `POST /v1/inbox/approve`, a
 * write-scoped, tier-HIGH gate (W1-T404) that hands off to a detached `rmd approve` spawn and
 * so is irreversible in the direction that matters. Git objects are immutable and
 * content-addressed, so a blob at a fixed `ref` CANNOT be torn by a concurrent `git checkout
 * --detach` truncating the working copy in place — this is atomic by construction, not merely
 * unlikely to race, the stronger guarantee a gate needs over a render.
 *
 * `ref` defaults to `"HEAD"` — the commit the shared working tree is already checked out to
 * (`checkout_target`'s `git checkout --detach "$TARGET"`), so this reads exactly what a quiet
 * working tree would show, no network fetch and no second checkout (design note (v): the
 * console/panel gets no checkout of its own). `repoRoot` is `deps.root`, the same repo root
 * every other git-backed helper in this module already runs `-C` against.
 *
 * NAMED COST, NEVER SILENT (design note (iii)(c), acceptance criterion 5): this reads the
 * COMMITTED plan at `ref` — an UNCOMMITTED working-tree edit to `plan/tasks.yaml` or a shard is
 * INVISIBLE here. That is a real behavior difference from {@link loadPlan}, stated here and
 * exercised by `test/main-plan-load-guard.test.ts`, never a silent divergence discovered later.
 *
 * Mirrors {@link loadPlan}'s own merge semantics (duplicate id across monolith/shard fails
 * loud, every `depends_on` must resolve within the merged view) so the two loaders agree on
 * every plan that is not mid-write — only the SOURCE of the bytes differs.
 */
export function loadPlanAtRef(
  repoRoot: string,
  planRelPath: string,
  ref = "HEAD",
  runGit: GitBlobRunner = (args, stdin) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 1 << 26, input: stdin }),
): Plan {
  let monolithBlob: string;
  try {
    monolithBlob = runGit(["show", `${ref}:${planRelPath}`]);
  } catch (err) {
    throw new PlanError(`cannot read plan file at ${ref}:${planRelPath} in ${repoRoot}: ${String(err)}`);
  }
  const blobs: Array<{ label: string; text: string }> = [{ label: `${ref}:${planRelPath}`, text: monolithBlob }];

  // List `tasks.d/` AT THE REF via `git ls-tree`, never `readdirSync` on the working tree — the
  // working tree is exactly what this function exists to not trust. No `tasks.d/` at `ref` (the
  // pre-sharding back-compat case `loadPlan` also honors) reads as an empty listing, same as
  // `listShardFiles`'s ENOENT tolerance.
  const shardRelDir = join(dirname(planRelPath), "tasks.d");
  let shardListing = "";
  try {
    shardListing = runGit(["ls-tree", "--name-only", ref, `${shardRelDir}/`]);
  } catch {
    shardListing = "";
  }
  const shardRelPaths = shardListing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")))
    .sort();
  // ONE `git cat-file --batch` for every shard, never one `git show` per shard: the spawn count
  // is what made this O(tasks ever filed) on a path the write-scoped approve gate runs
  // synchronously (see {@link readBlobsAtRef} for the measurement).
  //
  // Unlike loadPlan's ENOENT-skip for a shard that vanished mid-read off the working tree, there
  // is no analogous benign race here: every `shardRelPath` just came off `git ls-tree` AT THE
  // SAME `ref` this read resolves, and objects at a fixed ref never vanish. A failure here is a
  // real problem (git corruption, a gc mid-read) and must throw, never skip.
  let shardBlobs: string[];
  try {
    shardBlobs = readBlobsAtRef(runGit, ref, shardRelPaths);
  } catch (err) {
    throw new PlanError(`cannot read plan shard at ${ref} in ${repoRoot}: ${String(err)}`);
  }
  shardRelPaths.forEach((shardRelPath, i) => {
    blobs.push({ label: `${ref}:${shardRelPath}`, text: shardBlobs[i] });
  });

  return mergePlanBlobs(blobs);
}

/**
 * Injectable git invoker that can feed STDIN. `git cat-file --batch` takes its object list on
 * stdin, which the older `(args: string[]) => string` shape had no way to supply; the parameter
 * is OPTIONAL so every existing `(args) => string` fake stays assignable and keeps working.
 */
export type GitBlobRunner = (args: string[], stdin?: string) => string;

/**
 * Read every blob at `<ref>:<relPath>` in ONE `git cat-file --batch`, returned in the order
 * `relPaths` was given.
 *
 * WHY A BATCH AND NOT A LOOP. The obvious `git show <ref>:<path>` per path is one PROCESS SPAWN
 * per path, and this repo's plan is one file per task: measured 2026-09-05 at 1,079 shards,
 * 1,079 spawns cost 4,258 ms (3.95 ms each) and one `cat-file --batch` over the same paths
 * returns the same bytes in 208 ms. That loop ran on every dispatching daemon tick and every
 * inbox approval, so it was per-tick cost growing linearly with the number of tasks ever filed.
 *
 * FRAMING. `--batch` answers each stdin line with `<oid> SP <type> SP <size> LF <contents> LF`,
 * or `<input> SP missing LF` for anything it cannot resolve. Sizes are BYTES, so the output is
 * sliced as a Buffer and each blob decoded afterwards — slicing the decoded string would
 * mis-position every blob after the first non-ASCII character (this corpus is full of em
 * dashes). Round-tripping through `Buffer.from(text, "utf8")` is exact for the UTF-8 the old
 * `git show` path already assumed.
 *
 * FAILS LOUD, NEVER PARTIAL: `missing`, a non-blob type, or a truncated stream throws naming the
 * path — the same contract the per-path loop had, where a torn read must never silently drop a
 * task. Callers wrap it in their own error type (`PlanError` here, `GitFetchError` on the
 * dispatch path) exactly as they wrapped the per-path failure before.
 */
export function readBlobsAtRef(runGit: GitBlobRunner, ref: string, relPaths: string[]): string[] {
  if (relPaths.length === 0) return [];
  const request = relPaths.map((p) => `${ref}:${p}`).join("\n") + "\n";
  const raw = runGit(["cat-file", "--batch"], request);
  const buf = Buffer.from(raw, "utf8");
  const texts: string[] = [];
  let off = 0;
  for (const relPath of relPaths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) {
      throw new Error(`git cat-file --batch output ended before ${ref}:${relPath}`);
    }
    const header = buf.toString("utf8", off, nl);
    off = nl + 1;
    const fields = header.split(" ");
    // `<input> missing` and `<input> ambiguous` both land here, as does a tree or a commit.
    if (fields.length < 3 || fields[1] !== "blob") {
      throw new Error(`git cat-file --batch could not read ${ref}:${relPath} (${header})`);
    }
    const size = Number(fields[2]);
    if (!Number.isInteger(size) || size < 0 || off + size > buf.length) {
      throw new Error(`git cat-file --batch gave an unusable size for ${ref}:${relPath} (${header})`);
    }
    texts.push(buf.toString("utf8", off, off + size));
    off = off + size + 1; // the LF git appends after the contents
  }
  return texts;
}

/**
 * Merge already-read plan blobs into one {@link Plan} under {@link loadPlan}'s OWN contract —
 * duplicate ids across blobs fail loud, every `depends_on` must resolve within the merged view.
 * Split out so a caller holding the bytes (from git objects, never the working tree) gets a Plan
 * that is deep-equal to what `loadPlan` builds over the same content on disk, without writing
 * those bytes to a temp directory first just to have a directory to point `loadPlan` at.
 * `label` names each blob in error text and is the ONLY thing that differs from the disk path.
 */
export function mergePlanBlobs(blobs: Array<{ label: string; text: string }>): Plan {
  const tasks: Task[] = [];
  const byId = new Map<string, Task>();
  for (const { label, text } of blobs) {
    for (const t of parseTasksFromYaml(text, label)) {
      if (byId.has(t.id)) {
        throw new PlanError(`duplicate task id '${t.id}' (${label} collides with an earlier plan entry)`);
      }
      byId.set(t.id, t);
      tasks.push(t);
    }
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }
  }
  return { tasks, byId };
}

/** Select one task by id. Throws if absent. */
export function selectTask(plan: Plan, id: string): Task {
  const t = plan.byId.get(id);
  if (!t) throw new PlanError(`no task with id '${id}' in plan`);
  return t;
}

/**
 * Predicate for "has this dependency landed?". The default reads the DECORATIVE
 * yaml `status:` field (used by pure unit tests over fixtures); the runner passes
 * a GitHub-DERIVED resolver (lib/status.ts) so the real gate never trusts yaml.
 */
export type MergedResolver = (task: Task) => boolean;

const yamlStatusMerged: MergedResolver = (t) => MERGED_STATUSES.has(t.status);

/**
 * Refuse to run a task whose dependencies have not merged (§12 rule 3: branch
 * from a landed base). Returns the list of unmet dependency ids; empty = clear.
 * `isMerged` decides landed-ness — DERIVED FROM GITHUB in the real runner.
 */
export function unmetDependencies(
  plan: Plan,
  task: Task,
  isMerged: MergedResolver = yamlStatusMerged,
): string[] {
  return task.depends_on.filter((dep) => {
    const d = plan.byId.get(dep);
    return !d || !isMerged(d);
  });
}

/**
 * Every task that transitively depends on `taskId` (directly, or through a
 * chain of `depends_on`) — computed over the WHOLE plan, never scoped to
 * `isMerged`, since this answers a structural DAG question ("does anything
 * need this task to exist at all"), not a runnability one.
 *
 * Backs W1-T46's block-reasoning (drain/daemon v2): a blocked task with an
 * EMPTY result here is self-contained — nothing in the plan needs it, so its
 * failure is only that task's problem and can be skipped without leaving any
 * dependent to "continue into the gap". A NON-EMPTY result means real
 * downstream work genuinely needs it merged, and the block must never be
 * silently skipped.
 */
export function transitiveDependents(plan: Plan, taskId: string): Set<string> {
  // Build the reverse edge map once: task id -> the task ids that declare it
  // as a dependency.
  const reverse = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      const list = reverse.get(dep);
      if (list) list.push(t.id);
      else reverse.set(dep, [t.id]);
    }
  }
  const out = new Set<string>();
  const queue = [...(reverse.get(taskId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const next of reverse.get(id) ?? []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  return out;
}

/** Throw unless every dependency has merged (per `isMerged`, derived from GitHub). */
export function assertRunnable(
  plan: Plan,
  task: Task,
  isMerged: MergedResolver = yamlStatusMerged,
): void {
  if (task.status === "blocked") {
    throw new PlanError(`task ${task.id} is blocked${task.note ? `: ${task.note}` : ""}`);
  }
  if (task.verify === "human") {
    throw new PlanError(`task ${task.id} is verify:human — not auto-runnable by the proto-runner`);
  }
  const unmet = unmetDependencies(plan, task, isMerged);
  if (unmet.length > 0) {
    throw new PlanError(`task ${task.id} has unmerged dependencies: ${unmet.join(", ")}`);
  }
}
