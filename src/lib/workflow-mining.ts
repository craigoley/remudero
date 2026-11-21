/**
 * lib/workflow-mining.ts — W1-T4668, W1-T13857. THE MINER FINDS THE COMMAND SEQUENCES RUNS REPEAT.
 *
 * Each `tool-executing` `worker.activity` row carries a `tool_signature` (since 2026-10-13): `Bash:<program>
 * [<subcommand>]` or `<file tool>:<path>`. A skill saves the work a run repeats, whether or not the run later needed
 * a fix. So {@link mineRecurringProcedures} returns the ordered action-step sequences that recur across runs of two
 * or more tasks, scored by how much work each one spans. Reads and searches are LOOK steps, never actions: with
 * them kept, the top sequences were read noise (`Bash:sed`, `Bash:grep`). `skill-workshop.ts` drafts the top one.
 *
 * PURE: no LLM, no I/O. Every input type is STRUCTURAL, duplicating the retro.ts shapes this reads rather than
 * importing them, so retro.ts can hand this a real `RunSummary[]`/`LedgerRecord[]` with no import cycle.
 */

/** The run fields this module reads. `RunSummary` (retro.ts) satisfies it structurally. */
export interface TranscriptRun {
  runId: string;
  taskId: string;
  type: string;
  verdict: string;
  /** Summed worker output tokens; absent or 0 means not measured. */
  outputTokens?: number;
}

/** The ledger-row fields this module reads. `LedgerRecord` (retro.ts) satisfies it structurally:
 *  its own index signature types every field but `ts`/`run_id`/`task_id`/`step` as `unknown`, so
 *  `event_kind`/`tool_name` are read defensively below rather than assumed to be strings. */
export interface TranscriptLedgerRow {
  run_id?: string;
  step?: string;
  [k: string]: unknown;
}

/** The `step` a real transcript row rides — see `WORKER_ACTIVITY_LEDGER_STEP` (src/run-task.ts).
 *  Duplicated as a literal rather than imported: this module reads the ledger's own wire shape,
 *  not run-task.ts's internals, and run-task.ts sits well above this file in the dependency
 *  graph. */
const WORKER_ACTIVITY_STEP = "worker.activity";

/** Fix rounds per implementing run. Since 2026-08-13 the sweep dispatches fix rounds under its OWN run id
 *  (`DAEMON-…`: 2,023 rows, against 35 task-run-keyed ones last seen 2026-09-13), so keying by `run_id` alone
 *  credited every merged run with zero fixes. A row whose `run_id` is not a started run is attributed to the
 *  latest run of its `task_id` that started at or before it. */
export function fixDispatchCountsAttributed(records: readonly TranscriptLedgerRow[]): Map<string, number> {
  const starts = new Map<string, Array<{ runId: string; ts: string }>>();
  const started = new Set<string>();
  for (const r of records) {
    if (r.step !== "run.start" || !r.run_id || typeof r.task_id !== "string" || typeof r.ts !== "string") continue;
    started.add(r.run_id);
    const list = starts.get(r.task_id) ?? [];
    list.push({ runId: r.run_id, ts: r.ts });
    starts.set(r.task_id, list);
  }
  for (const list of starts.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "fix.dispatch" || !r.run_id) continue;
    let runId: string | undefined = started.has(r.run_id) ? r.run_id : undefined;
    if (!runId && typeof r.task_id === "string" && typeof r.ts === "string") {
      const ts = r.ts;
      runId = (starts.get(r.task_id) ?? []).filter((s) => s.ts <= ts).at(-1)?.runId;
    }
    const key = runId ?? r.run_id;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** A file-tool signature's path when it names no file to coarsen. */
const VERBATIM_PATHS: ReadonlySet<string> = new Set(["<outside>", "."]);

/** How many directory segments a nested path keeps. */
const KEPT_DIRECTORIES = 2;

/**
 * One tool-call signature as a census step. Bash signatures and bare tool names pass through. A file-tool signature
 * keeps a top-level path, `<outside>` and `.` verbatim; a nested path keeps its first two directories and the file's
 * full extension (from the basename's first `.`), with the basename replaced by `*`:
 * `Read:src/lib/review.ts` → `Read:src/lib/*.ts`, `Edit:test/ci/x.test.ts` → `Edit:test/ci/*.test.ts`.
 */
export function normalizeProcedureStep(raw: string): string {
  const colon = raw.indexOf(":");
  if (colon < 0 || raw.startsWith("Bash:")) return raw;
  const tool = raw.slice(0, colon);
  const path = raw.slice(colon + 1);
  const segments = path.split("/");
  if (VERBATIM_PATHS.has(path) || segments.length === 1) return raw;
  const base = segments[segments.length - 1]!;
  const dot = base.indexOf(".");
  const extension = dot < 0 ? "" : base.slice(dot);
  return `${tool}:${segments.slice(0, Math.min(KEPT_DIRECTORIES, segments.length - 1)).join("/")}/*${extension}`;
}

/**
 * The ordered census steps of ONE run: each `tool-executing` `worker.activity` row of `runId`, in ledger order, as
 * {@link normalizeProcedureStep} of its `tool_signature`, or its bare `tool_name` when the row carries no signature
 * (every row before 2026-10-13). Each step's first occurrence only.
 */
export function procedureStepsForRun(records: readonly TranscriptLedgerRow[], runId: string): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.run_id !== runId || r.step !== WORKER_ACTIVITY_STEP || r.event_kind !== "tool-executing") continue;
    const signature = typeof r.tool_signature === "string" && r.tool_signature.length > 0 ? r.tool_signature : undefined;
    const step = signature !== undefined ? normalizeProcedureStep(signature) : typeof r.tool_name === "string" ? r.tool_name : "";
    if (step === "" || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
  }
  return steps;
}
/** Match Node by its full signature so Node commands that name a script still count as actions. */
const LOOK_STEPS = {
  prefix: new Set([
    "sed", "grep", "cat", "rg", "tail", "head", "ls", "wc", "find", "awk", "jq", "echo", "printf", "ps", "pgrep",
    "sleep", "for", "until", "while", "timeout", "python3", "pwd", "cd", "date", "which", "stat", "sort",
    "cut", "tr", "true", "test",
    "git show", "git status", "git log", "git diff", "git grep", "git rev-parse", "git remote", "git ls-files",
    "git ls-tree", "git rev-list", "git cat-file", "git merge-base", "git blame", "git config",
  ]),
  exact: new Set(["node", "node --test"]),
};

/** File tools and bare tool names that only read. */
const LOOK_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob"]);

/** Whether a census step only looks: a read or search tool, a path outside the worktree, or a {@link LOOK_STEPS} command. */
function isLookStep(step: string): boolean {
  if (step === "<outside>" || step.endsWith(":<outside>")) return true;
  const colon = step.indexOf(":");
  const tool = colon < 0 ? step : step.slice(0, colon);
  if (LOOK_TOOLS.has(tool)) return true;
  if (tool !== "Bash" || colon < 0) return false;
  const command = step.slice(colon + 1);
  const [program = "", subcommand] = command.split(/\s+/, 2);
  return LOOK_STEPS.exact.has(command) || LOOK_STEPS.prefix.has(program) ||
    (subcommand !== undefined && LOOK_STEPS.prefix.has(`${program} ${subcommand}`));
}

/** One ordered action-step sequence that recurs across runs, with the work it spans. */
export interface RecurringProcedure {
  steps: string[];
  /** Distinct runs that hold every step in this order, not necessarily next to each other. */
  recurrence: number;
  runIds: string[];
  taskIds: string[];
  /** Median tool calls from the first step to the last step in a run, both included. */
  medianSpannedCalls: number;
  /** Median of a run's output tokens over its tool calls, over the runs that measured tokens; `null` when none did. */
  medianOutputTokensPerCall: number | null;
  estimatedTokensPerRun: number | null;
  /** `recurrence * medianSpannedCalls * (medianOutputTokensPerCall ?? 1)`. */
  score: number;
}

interface MinedRun {
  runId: string;
  taskId: string;
  /** Action steps in first-occurrence order; each step once. */
  actions: string[];
  position: Map<string, number>;
  /** Each step's first tool-call index among all of the run's tool calls. */
  firstCall: Map<string, number>;
  tokensPerCall: number | null;
}

interface Member {
  run: MinedRun;
  last: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function minedRun(run: TranscriptRun, rows: readonly TranscriptLedgerRow[]): MinedRun {
  const firstCall = new Map<string, number>();
  let calls = 0;
  for (const r of rows) {
    if (r.step !== WORKER_ACTIVITY_STEP || r.event_kind !== "tool-executing") continue;
    const signature = typeof r.tool_signature === "string" && r.tool_signature.length > 0 ? r.tool_signature : undefined;
    const step = signature !== undefined ? normalizeProcedureStep(signature) : typeof r.tool_name === "string" ? r.tool_name : "";
    if (step !== "" && !firstCall.has(step)) firstCall.set(step, calls);
    calls += 1;
  }
  const actions = procedureStepsForRun(rows, run.runId).filter((step) => !isLookStep(step));
  const tokens = run.outputTokens ?? 0;
  return {
    runId: run.runId,
    taskId: run.taskId,
    actions,
    position: new Map(actions.map((step, i) => [step, i])),
    firstCall,
    tokensPerCall: tokens > 0 && calls > 0 ? tokens / calls : null,
  };
}

/** Whether one step lies in the same gap of `steps` in every member run. Inserting it then keeps the same runs for
 *  this procedure and for every extension of it, so no extension can be kept and the branch is cut. */
function insertableInEveryRun(steps: readonly string[], members: readonly Member[]): boolean {
  const first = members[0]!.run;
  for (let gap = 0; gap < steps.length; gap++) {
    const low = gap === 0 ? -1 : first.position.get(steps[gap - 1]!)!;
    const high = first.position.get(steps[gap]!)!;
    for (const step of first.actions.slice(low + 1, high)) {
      const fits = members.every(({ run }) => {
        const at = run.position.get(step);
        const before = gap === 0 ? -1 : run.position.get(steps[gap - 1]!)!;
        return at !== undefined && at > before && at < run.position.get(steps[gap]!)!;
      });
      if (fits) return true;
    }
  }
  return false;
}

function procedureOf(steps: readonly string[], members: readonly Member[]): RecurringProcedure {
  const firstStep = steps[0]!;
  const lastStep = steps[steps.length - 1]!;
  const spans = members.map(({ run }) => run.firstCall.get(lastStep)! - run.firstCall.get(firstStep)! + 1);
  const rates = members.map(({ run }) => run.tokensPerCall).filter((rate): rate is number => rate !== null);
  const medianSpannedCalls = median(spans);
  const medianOutputTokensPerCall = rates.length > 0 ? median(rates) : null;
  return {
    steps: [...steps],
    recurrence: members.length,
    runIds: members.map(({ run }) => run.runId).sort(),
    taskIds: [...new Set(members.map(({ run }) => run.taskId))].sort(),
    medianSpannedCalls,
    medianOutputTokensPerCall,
    estimatedTokensPerRun: medianOutputTokensPerCall === null ? null : medianSpannedCalls * medianOutputTokensPerCall,
    score: members.length * medianSpannedCalls * (medianOutputTokensPerCall ?? 1),
  };
}

/**
 * The ordered action-step sequences of two or more steps that recur in at least `opts.minRuns` (default 2) runs of
 * at least `opts.minTaskIds` (default 2) tasks. Each step comes after the one before it in a run, not necessarily
 * next to it. A procedure is kept only when no longer procedure with the same recurrence contains it. Sorted by
 * score, highest first, then by the steps joined.
 */
export function mineRecurringProcedures(
  runs: readonly TranscriptRun[],
  records: readonly TranscriptLedgerRow[],
  opts: { minRuns?: number; minTaskIds?: number } = {},
): RecurringProcedure[] {
  const minRuns = opts.minRuns ?? 2;
  const minTaskIds = opts.minTaskIds ?? 2;
  const rowsByRun = new Map<string, TranscriptLedgerRow[]>();
  for (const r of records) {
    if (r.step !== WORKER_ACTIVITY_STEP || !r.run_id) continue;
    const list = rowsByRun.get(r.run_id);
    if (list) list.push(r);
    else rowsByRun.set(r.run_id, [r]);
  }
  const seen = new Set<string>();
  const mined: MinedRun[] = [];
  for (const run of runs) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    mined.push(minedRun(run, rowsByRun.get(run.runId) ?? []));
  }
  const qualifies = (members: readonly Member[]): boolean =>
    members.length >= minRuns && new Set(members.map(({ run }) => run.taskId)).size >= minTaskIds;
  const out: RecurringProcedure[] = [];
  const grow = (steps: string[], members: Member[]): void => {
    if (insertableInEveryRun(steps, members)) return;
    const extensions = new Map<string, Member[]>();
    for (const { run, last } of members) {
      for (let i = last + 1; i < run.actions.length; i++) {
        const step = run.actions[i]!;
        const list = extensions.get(step);
        if (list) list.push({ run, last: i });
        else extensions.set(step, [{ run, last: i }]);
      }
    }
    let longest = true;
    for (const [step, next] of extensions) {
      if (!qualifies(next)) continue;
      if (next.length === members.length) longest = false;
      grow([...steps, step], next);
    }
    if (longest && steps.length >= 2) out.push(procedureOf(steps, members));
  };
  const roots = new Map<string, Member[]>();
  for (const run of mined) {
    run.actions.forEach((step, i) => {
      const list = roots.get(step);
      if (list) list.push({ run, last: i });
      else roots.set(step, [{ run, last: i }]);
    });
  }
  for (const [step, members] of roots) if (qualifies(members)) grow([step], members);
  const key = (p: RecurringProcedure): string => p.steps.join("\n");
  return out.sort((a, b) => b.score - a.score || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
