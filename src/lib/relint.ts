import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { loadPlan, parseTasksFromYaml } from "./plan.js";
import { lintTask, type LintOpts } from "./task-linter.js";

/**
 * THE RELINT LOOP, shared by every lane that files plan tasks with a paid worker.
 *
 * THE CLASS THIS EXISTS TO KILL (recon-FT). A worker prompt is written against the rules of its
 * day; a blocking gate is added later; nothing connects them. Two instances have cost money —
 * triage's prompt never stated the acceptance-proof grammar, so a $1.48 run filed W1-T286 and
 * `lint-plan` rejected it with six violations a human then hand-edited away; plan's prompt directed
 * new tasks into the monolith that `monolith-filing` blocks.
 *
 * WHY A REACTIVE LOOP AND NOT A PROMPT RULE. A prompt rule is a RESTATEMENT of a gate, and it goes
 * stale the moment the gate changes — measurably: recon-FT found BOTH known instances had their
 * prompt edited AFTER the gate landed, for unrelated reasons, and still missed it. This asks the
 * REAL {@link lintTask} and hands back its REAL message, so it cannot drift out of sync. The
 * inbox draft rung (lib/inbox.ts) has had exactly this since cc71f2; this module is that mechanism
 * extracted so triage and plan share ONE copy of it rather than growing a second.
 */
export const MAX_RELINT_ATTEMPTS = 3;

/** A relint finding: the linter's own violations (whose `check` is a strict LintCheck) PLUS a
 *  lane's own parse/load findings, structurally typed so both flow through one path without
 *  widening the linter's closed check union. Identical in shape to inbox's `DraftLintViolation`,
 *  which is now an alias of this. */
export type RelintViolation = { check: string; severity: "block" | "warn"; message: string };

/**
 * Checks a REDRAFT CANNOT RESOLVE, so a loop that keeps re-prompting on them only burns money.
 *
 * `post-merge-amendment` is the only such class today, and it is here for completeness rather than
 * reach: it returns `[]` unless the caller supplies `opts.postMergeAmendment`
 * (lib/task-linter.ts), which no relint call site does — so it cannot fire here at all. Every other
 * BLOCKING check is a property of the task text the worker just wrote (`proof-dialect`,
 * `proof-resolvability`, `proof-grep-safety`, `proof-shape`, `provenance`, `headless-fitness`,
 * `monolith-filing`) or of its decomposition (`sizing`), and a redraft can change all of those.
 *
 * A lane's own non-linter findings (a fragment that will not parse, a plan that will not load) are
 * fixable BY DEFINITION — they are the worker's own malformed output.
 */
export const WORKER_UNFIXABLE_CHECKS: ReadonlySet<string> = new Set(["post-merge-amendment"]);

/** True when EVERY violation is one a redraft cannot resolve — the early-stop condition. Empty is
 *  false: nothing to fix is not the same as nothing fixable. */
export function allWorkerUnfixable(violations: ReadonlyArray<RelintViolation>): boolean {
  return violations.length > 0 && violations.every((v) => WORKER_UNFIXABLE_CHECKS.has(v.check));
}

/**
 * The doctrine block a redraft prompt carries — ONE copy, shared by every lane.
 *
 * Extracted VERBATIM from `inboxDraftRelintPrompt`, which is now composed from it. The two
 * paragraphs below are the only guidance that is genuinely per-CHECK rather than per-lane: what a
 * `[call-site]` violation means and why the open paren matters, and how to resolve a `[sizing]`
 * (Rule 19) violation via the #588 merits test. A second copy of either is the exact duplication
 * this repo has paid for twice.
 */
export function relintGuidanceLines(violations: ReadonlyArray<RelintViolation>): string[] {
  return [
    "BLOCKING VIOLATIONS:",
    ...violations.map((v) => `  - [${v.check}] ${v.message}`),
    "",
    "For a [call-site] violation (impl-DO): the task CREATES a src/ module and no criterion proves anything CALLS it. Eleven modules have merged green and unreached — console-freshness.ts shipped 111 lines with 83 lines of tests that serve.ts never imported, and the bug it fixed is still on screen. Add a criterion whose proof is 'grep: <symbol>( in <the file that calls it>'. THE OPEN PAREN IS THE WHOLE POINT: 'grep: foo in x.ts' passes on a COMMENT mentioning foo, which is how a proof once exited 0 against entirely unbuilt work; 'grep: foo( in x.ts' can only be satisfied by something shaped like a call. The path must be a DIFFERENT file from the module being created — a module calling itself proves nothing about whether the program reaches it.",
    "",
    "For a [sizing] (Rule 19) violation apply the #588 MERITS TEST: does that task's acceptance assert ONE cross-file invariant that is unsatisfiable piecewise (a single test needing all its files together)? If YES — raise that task to risk:high and record the one-line rationale in the task. If NO — DECOMPOSE it into one task per subsystem with an explicit depends_on spine preserving order, budgets resized per piece, every resulting task keeping the same origin: provenance. Keep every proof executable ('unit test: <path or exact test-title substring>' or 'grep: <pattern> in <path>').",
  ];
}

/**
 * The ids NEW to the monolith on this worktree versus `baseRef` — the context `monolith-filing`
 * needs to fire at all (`lib/task-linter.ts` returns `[]` without it).
 *
 * Mirrors what `rmd lint-plan --base` computes in run-task.ts: a per-FILE comparison against the
 * MONOLITH ALONE, never the merged plan, so a task filed correctly as a shard leaves the set and a
 * task appended to the monolith enters it. Best-effort: an unreadable base ref yields an empty set
 * (the check then simply does not fire) rather than throwing inside a lane's paid run.
 */
export function newMonolithIdsAgainstBase(worktreeRoot: string, baseRef = "origin/main"): ReadonlySet<string> {
  const relPath = "plan/tasks.yaml";
  try {
    const baseRaw = execFileSync("git", ["-C", worktreeRoot, "show", `${baseRef}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    const headRaw = execFileSync("git", ["-C", worktreeRoot, "show", `:${relPath}`], { encoding: "utf8", maxBuffer: 1 << 26 });
    const base = new Set(parseTasksFromYaml(baseRaw, `${baseRef}:${relPath}`).map((t) => t.id));
    return new Set(parseTasksFromYaml(headRaw, relPath).map((t) => t.id).filter((id) => !base.has(id)));
  } catch {
    return new Set();
  }
}

/**
 * Lint the tasks THIS RUN filed, exactly as `rmd lint-plan` would, and return every BLOCKING
 * violation.
 *
 * SCOPED TO `filedIds` ON PURPOSE, and this is the load-bearing decision. The plan carries 193
 * tasks that fail the linter today; linting the whole plan would hand a worker other people's
 * violations, and every run would relint to exhaustion on findings it did not cause and cannot
 * own. Only the ids this run reserved are its responsibility.
 *
 * A plan that will not LOAD is itself one blocking violation, so a malformed filing drives a
 * redraft rather than falling through to a PR that every plan-loading check rejects — the same
 * treatment inbox gives an unparseable fragment.
 */
export function lintFiledTasks(
  worktreeRoot: string,
  filedIds: ReadonlyArray<string>,
  opts: LintOpts = {},
): RelintViolation[] {
  let plan;
  try {
    plan = loadPlan(join(worktreeRoot, "plan", "tasks.yaml"));
  } catch (e) {
    return [
      {
        check: "plan-load",
        severity: "block",
        message: `the filed plan does not load — fix before re-emitting: ${String((e as Error)?.message ?? e)}`,
      },
    ];
  }
  const wanted = new Set(filedIds);
  const out: RelintViolation[] = [];
  for (const task of plan.tasks) {
    if (!wanted.has(task.id)) continue;
    for (const v of lintTask(task, opts).violations) if (v.severity === "block") out.push(v);
  }
  return out;
}

/**
 * The redraft prompt for a lane whose worker EDITS FILES IN A WORKTREE (triage, plan) rather than
 * emitting a fragment between markers (inbox). The framing differs — "the files you edited" vs
 * "re-emit the fragment" — but the doctrine is {@link relintGuidanceLines}, shared.
 */
/** Why a relint loop stopped — carried on the ledger and, on `exhausted`, shown to the operator. */
export type RelintStop = "clean" | "not-filed" | "unfixable" | "exhausted";

/**
 * THE LOOP ITSELF, shared by triage and plan — spawn, lint what was filed, hand the real violations
 * back, bounded.
 *
 * Deliberately generic over the lane's own decision type: each lane parses its worker's output into
 * its own verdict (`decideTriage` / `decidePlanArchitect`) and this must not know or change that.
 * It owns exactly four things — the attempt bound, when to stop early, what to ledger, and which
 * prompt the next attempt gets.
 *
 * FOUR EXITS, and the last two are the ones that matter:
 *   `clean`     — the filed tasks lint clean; proceed exactly as before this existed.
 *   `not-filed` — CLEAR/GRILL touched nothing, so there is nothing to lint. Never spends an extra turn.
 *   `unfixable` — every violation is one a redraft cannot resolve; stop NOW rather than buying
 *                 attempts that cannot change the answer (~$1/attempt on the triage lane).
 *   `exhausted` — the bound ran out with violations outstanding. The caller must refuse, and say why.
 */
export async function runRelintLoop<D>(opts: {
  lane: string;
  filedIds: ReadonlyArray<string>;
  initialPrompt: string;
  maxAttempts?: number;
  /** Spawn the worker with this prompt and reduce its output to the lane's own decision. */
  run: (prompt: string, attempt: number) => Promise<D>;
  /** Did this decision actually file tasks? A CLEAR/GRILL has nothing to lint. */
  filed: (decision: D) => boolean;
  lint: () => RelintViolation[];
  log: (step: string, extra?: Record<string, unknown>) => void;
}): Promise<{ decision: D; violations: RelintViolation[]; attempts: number; stop: RelintStop }> {
  const maxAttempts = opts.maxAttempts ?? MAX_RELINT_ATTEMPTS;
  let prompt = opts.initialPrompt;
  let decision!: D;
  let violations: RelintViolation[] = [];
  let attempt = 0;
  let stop: RelintStop = "exhausted";

  while (attempt < maxAttempts) {
    attempt++;
    decision = await opts.run(prompt, attempt);
    if (!opts.filed(decision)) {
      violations = [];
      stop = "not-filed";
      break;
    }
    violations = opts.lint();
    if (violations.length === 0) {
      stop = "clean";
      break;
    }
    if (allWorkerUnfixable(violations)) {
      // Buying more attempts cannot change the answer — name it and stop.
      opts.log(`${opts.lane}.relint_unfixable`, { attempt, violations: violations.map((v) => v.message) });
      stop = "unfixable";
      break;
    }
    if (attempt < maxAttempts) {
      opts.log(`${opts.lane}.relint`, { attempt, filed: [...opts.filedIds], violations: violations.map((v) => v.message) });
      prompt = filedTaskRelintPrompt(opts.lane, opts.filedIds, violations);
    }
  }
  return { decision, violations, attempts: attempt, stop };
}

/**
 * The operator-facing reason a lane refuses after a relint failed. THE POINT of this string: today
 * a violating filing becomes a PR that spends money, opens, and stalls at "ci failure" — a symptom
 * indistinguishable from a flaky test, a lint error elsewhere, or an infrastructure blip. This says
 * which checks failed, on which ids, and after how many attempts, BEFORE any PR exists.
 */
export function relintRefusalMessage(
  lane: string,
  filedIds: ReadonlyArray<string>,
  violations: ReadonlyArray<RelintViolation>,
  attempts: number,
  stop: RelintStop,
): string {
  const checks = [...new Set(violations.map((v) => v.check))].sort().join(", ");
  const why =
    stop === "unfixable"
      ? "the violation(s) cannot be fixed by rewriting the task"
      : `${attempts} attempt(s) did not clear them`;
  return (
    `${lane}: the filed task(s) ${filedIds.join(", ")} FAIL the plan linter [${checks}] and ${why} — ` +
    `no PR opened (CI would have rejected it). Violations:\n` +
    violations.map((v) => `  - [${v.check}] ${v.message}`).join("\n")
  );
}

export function filedTaskRelintPrompt(lane: string, filedIds: ReadonlyArray<string>, violations: ReadonlyArray<RelintViolation>): string {
  return [
    `The task(s) you just filed (${filedIds.join(", ")}) FAILED the plan's own linter (rmd lint-plan) and CANNOT be proposed as-is. CI runs this same linter as a REQUIRED check, so a PR filed this way could not merge. Fix EVERY blocking violation below by editing the plan files in this working directory, then print your verdict line again.`,
    `Do NOT re-file under different ids and do NOT touch any task other than ${filedIds.join(", ")} — every other violation in this plan belongs to someone else.`,
    "If a violation names a missing or empty `files:`, declare the repo-relative paths that task will touch — an undeclared scope is fail-closed at dispatch and serialises the lane. Never omit it and never leave it empty.",
    "",
    ...relintGuidanceLines(violations),
    "",
    `(relint for ${lane})`,
  ].join("\n");
}
