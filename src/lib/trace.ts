import { execFileSync } from "node:child_process";
import type { FeedbackEntry } from "./feedback.js";
import type { Plan, Task } from "./plan.js";

/**
 * `rmd trace <id>` — render the provenance chain (MASTER-PLAN §7B / Standing rule 17,
 * W1-T43): feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha.
 *
 * Two entry points into the SAME chain, both built from the SAME declarative sources —
 * never a bespoke second read path:
 *   - FORWARD, from a feedback id (`plan/feedback/<id>.yaml`): the entry's own
 *     `proposal_pr` field names the plan-only PR; every task in `plan/tasks.yaml`
 *     carrying `origin: feedback#<id>` (the exact string `rmd triage` writes,
 *     lib/triage.ts) is a child; each task's ledger lines (`state/ledger.ndjson`,
 *     keyed by `task_id`/`run_id`) name its run(s), and each run's `pr.opened` line
 *     names the PR that run opened.
 *   - REVERSE, from a task id (`plan/tasks.yaml`): the task's own `origin:` field
 *     (Architect-only provenance, task-linter-enforced) names where it came from —
 *     `feedback#<id>` resolves back to that same feedback entry; anything else
 *     (`architect`, `alert#…`, `issue#…`) has no feedback entry to resolve, and the
 *     chain renders that plainly rather than guessing.
 *
 * Every source here is READ-ONLY (no writes, same discipline as lib/status.ts's
 * deriveStatus) — trace only renders what already exists.
 */

// ── GitHub (PR state + merge sha) ───────────────────────────────────────────────

/** The one PR fact this module needs beyond lib/status.ts's `GitHub`: the merge commit sha. */
export interface TracePrView {
  number: number;
  url: string;
  /** GitHub PR state: "MERGED" | "OPEN" | "CLOSED". */
  state: string;
  /** The merge commit sha, present only once `state === "MERGED"`. */
  mergeCommitSha?: string;
}

/** The GitHub query trace needs, behind an interface so tests inject fixtures. */
export interface TraceGithub {
  /** Resolve a PR by number or url within the gateway's repo. null if absent. */
  prView(ref: string | number): TracePrView | null;
}

/** Real `gh`-backed gateway — runs outside the sandbox (TLS only there), fail-soft to null. */
export function ghTraceGateway(owner: string, repo: string): TraceGithub {
  const slug = `${owner}/${repo}`;
  return {
    prView(ref) {
      try {
        const raw = execFileSync(
          "gh",
          ["pr", "view", String(ref), "--repo", slug, "--json", "number,url,state,mergeCommit"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const parsed = JSON.parse(raw) as {
          number?: unknown;
          url?: unknown;
          state?: unknown;
          mergeCommit?: { oid?: unknown } | null;
        };
        if (typeof parsed.number !== "number" || typeof parsed.url !== "string" || typeof parsed.state !== "string") {
          return null;
        }
        const oid = parsed.mergeCommit && typeof parsed.mergeCommit.oid === "string" ? parsed.mergeCommit.oid : undefined;
        return { number: parsed.number, url: parsed.url, state: parsed.state, mergeCommitSha: oid };
      } catch {
        return null;
      }
    },
  };
}

// ── Runs (ledger) ────────────────────────────────────────────────────────────────

export interface TraceRun {
  runId: string;
  /** The last `verdict` ledger line's `verdict` field for this run, if any. */
  verdict?: string;
  /** The last `pr.opened` ledger line's `pr_url` field for this run, if any. */
  prUrl?: string;
  prState?: string;
  mergeSha?: string;
}

/**
 * Every run this task's ledger lines name, oldest first (ledger append order),
 * grouped by `run_id`. `pr.opened`/`verdict` are read exactly as lib/status.ts's
 * deriveStatus reads them — same field names, same "last one wins" precedent for
 * a run that logged more than one (a retry within the same run_id).
 *
 * A `task_id` match ALONE is not enough to credit a `run_id` as one of this
 * task's own runs. `task_id` on a ledger line means "this line concerns this
 * task" — the daemon/sweep/retro/drain/fix control loops (run-task.ts:
 * `runId = \`DAEMON-${Date.now()}\`` etc.) legitimately stamp a swept task's id
 * onto lines like `sweep.disposed`/`escalation.issue_opened` while ACTING ON
 * it, but their own `run_id` is scoped to the daemon loop, not the task — a
 * task that's ever been polled by a sweep (i.e. every task with an open PR)
 * would otherwise drag in every `DAEMON-*`/`SWEEP-*` tick as a spurious
 * "no verdict yet" run, burying the real chain (caught by actually running
 * `rmd trace W1-T40` against the live ledger, W1-T43 review round 2). Only a
 * `run_id` actually MINTED for this task — `taskId` itself, or run-task.ts's own
 * `runId = \`${taskId}-${Date.now()}\`` convention (the per-task implement
 * runner, the ONE place that opens this task's PR) — is one of its runs.
 */
export function runsForTask(
  lines: Array<Record<string, unknown>>,
  taskId: string,
  github: TraceGithub,
): TraceRun[] {
  const order: string[] = [];
  const byRun = new Map<string, Array<Record<string, unknown>>>();
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    const runId = line.run_id;
    if (typeof runId !== "string") continue;
    if (runId !== taskId && !runId.startsWith(`${taskId}-`)) continue;
    let bucket = byRun.get(runId);
    if (!bucket) {
      bucket = [];
      byRun.set(runId, bucket);
      order.push(runId);
    }
    bucket.push(line);
  }
  return order.map((runId) => {
    const runLines = byRun.get(runId) as Array<Record<string, unknown>>;
    let verdict: string | undefined;
    let prUrl: string | undefined;
    for (const line of runLines) {
      if (line.step === "verdict" && typeof line.verdict === "string") verdict = line.verdict;
      if (line.step === "pr.opened" && typeof line.pr_url === "string") prUrl = line.pr_url;
    }
    const pr = prUrl ? github.prView(prUrl) : null;
    return { runId, verdict, prUrl, prState: pr?.state, mergeSha: pr?.mergeCommitSha };
  });
}

// ── The chain ────────────────────────────────────────────────────────────────────

export interface TraceFeedbackNode {
  id: string;
  raw: string;
  ts: string;
  origin: string;
  status: string;
  proposalPr?: string;
  proposalPrState?: string;
  proposalMergeSha?: string;
}

export interface TraceTaskNode {
  id: string;
  title: string;
  origin?: string;
  runs: TraceRun[];
}

export interface TraceChain {
  direction: "forward" | "reverse";
  feedback?: TraceFeedbackNode;
  tasks: TraceTaskNode[];
}

export interface TraceDeps {
  plan: Plan;
  /** Every parsed line of `state/ledger.ndjson` (lib/status.ts's readLedgerLines shape). */
  ledgerLines: Array<Record<string, unknown>>;
  github: TraceGithub;
}

function feedbackNode(entry: FeedbackEntry, github: TraceGithub): TraceFeedbackNode {
  const pr = entry.proposal_pr ? github.prView(entry.proposal_pr) : null;
  return {
    id: entry.id,
    raw: entry.raw,
    ts: entry.ts,
    origin: entry.origin,
    status: entry.status,
    proposalPr: entry.proposal_pr ?? undefined,
    proposalPrState: pr?.state,
    proposalMergeSha: pr?.mergeCommitSha,
  };
}

/** The exact provenance string `rmd triage` writes (lib/triage.ts) onto a task it proposes. */
export function feedbackOriginTag(feedbackId: string): string {
  return `feedback#${feedbackId}`;
}

/**
 * FORWARD: feedback#<id> → its proposal PR → every task carrying `origin:
 * feedback#<id>` → each task's run(s) → PR(s) → sha. A feedback entry not yet
 * triaged (no `proposal_pr`, no tasks) renders with those legs empty rather
 * than erroring — the chain is a snapshot of however far provenance has landed.
 */
export function traceForward(entry: FeedbackEntry, deps: TraceDeps): TraceChain {
  const tag = feedbackOriginTag(entry.id);
  const tasks = deps.plan.tasks
    .filter((t) => t.origin === tag)
    .map((t) => taskNode(t, deps));
  return { direction: "forward", feedback: feedbackNode(entry, deps.github), tasks };
}

function taskNode(task: Task, deps: TraceDeps): TraceTaskNode {
  return { id: task.id, title: task.title, origin: task.origin, runs: runsForTask(deps.ledgerLines, task.id, deps.github) };
}

/**
 * REVERSE: a task → its `origin:` field → (if `feedback#<id>`) the feedback entry
 * that originated it, resolved back through its own `proposal_pr` → the task's own
 * run(s) → PR(s) → sha. `feedbackEntry` is the caller's resolution of `task.origin`
 * (an fs read — this module stays pure over injected data, same split lib/status.ts's
 * deriveStatus keeps between "resolve the reference" and "derive from it").
 */
export function traceReverse(task: Task, deps: TraceDeps, feedbackEntry?: FeedbackEntry): TraceChain {
  return {
    direction: "reverse",
    feedback: feedbackEntry ? feedbackNode(feedbackEntry, deps.github) : undefined,
    tasks: [taskNode(task, deps)],
  };
}

// ── Rendering (pure — no I/O) ──────────────────────────────────────────────────────

function renderRun(run: TraceRun, indent: string): string[] {
  const lines = [`${indent}-> run ${run.runId}${run.verdict ? `: verdict=${run.verdict}` : " (no verdict yet)"}`];
  if (run.prUrl) {
    lines.push(`${indent}  -> PR ${run.prUrl}${run.prState ? ` [${run.prState}]` : ""}`);
    lines.push(`${indent}    -> sha ${run.mergeSha ? run.mergeSha : "(not merged yet)"}`);
  }
  return lines;
}

function renderTask(task: TraceTaskNode, indent: string): string[] {
  const lines = [`${indent}-> task ${task.id}: ${task.title}${task.origin ? ` (origin: ${task.origin})` : ""}`];
  if (task.runs.length === 0) {
    lines.push(`${indent}  (no runs yet — task not dispatched)`);
  } else {
    for (const run of task.runs) lines.push(...renderRun(run, `${indent}  `));
  }
  return lines;
}

function renderFeedback(feedback: TraceFeedbackNode, indent: string): string[] {
  const lines = [
    `${indent}feedback#${feedback.id} "${feedback.raw}" (origin=${feedback.origin}, status=${feedback.status}, captured ${feedback.ts})`,
  ];
  if (feedback.proposalPr) {
    lines.push(`${indent}  -> proposal PR: ${feedback.proposalPr}${feedback.proposalPrState ? ` [${feedback.proposalPrState}]` : ""}`);
    lines.push(`${indent}    -> sha ${feedback.proposalMergeSha ? feedback.proposalMergeSha : "(not merged yet)"}`);
  } else {
    lines.push(`${indent}  -> proposal PR: none yet (not triaged, or triage did not propose)`);
  }
  return lines;
}

// ── Discharge (read-time decoration, W1-T1257) ──────────────────────────────────

/**
 * The merged-set credit sources a discharge check needs — a narrowed structural subset of
 * lib/status.ts's `GitHub` (its `findMergedByTrailer`/`findMergedByHeadBranch`/`readFailed`/
 * `readTruncated`), the SAME batched gateway panel-graph.ts's three existing `projectPlan` call
 * sites already share — declared here rather than importing `GitHub` outright so this module's
 * own test fixtures need not implement every unrelated method that interface carries. A real
 * `GitHub` instance satisfies this structurally; no adapter is needed at the call site.
 */
export interface DischargeGithub {
  /** Find a MERGED PR whose body contains the anchored `Remudero-Task: <taskId>` trailer. */
  findMergedByTrailer(taskId: string): { state: string } | null;
  /** CORROBORATION: MERGED PRs whose head branch is `run-<taskId>-<digits>` (W1-T256's shape). */
  findMergedByHeadBranch?(taskId: string): Array<{ state: string; headRefName?: string }> | null;
  /** True if a read this gateway attempted actually FAILED (W1-T119). */
  readFailed?(): boolean;
  /** True if the most recent read succeeded but only PARTIALLY (W1-T415). */
  readTruncated?(): boolean;
}

export type DischargeState = "discharged" | "not_discharged" | "undecidable";

export interface FeedbackDischarge {
  state: DischargeState;
  /** Every task id `plan.tasks` carries `origin: feedback#<id>` for — the predicate's own input. */
  taskIds: string[];
}

/** `run-<taskId>-<digits>` — the SAME structured head-ref shape status.ts's own `ownsBranch` matches. */
function ownsRunBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^run-${escaped}-\\d+$`).test(head);
}

/** Is `taskId` credited MERGED — anchored trailer OR structured head-branch, unioned (W1-T1257). */
function taskCreditedMerged(taskId: string, github: DischargeGithub): boolean {
  const trailerHit = github.findMergedByTrailer(taskId);
  if (trailerHit && trailerHit.state.toUpperCase() === "MERGED") return true;
  const branchHits = github.findMergedByHeadBranch?.(taskId);
  if (!branchHits) return false; // null (read failed/method absent) or [] (no such branch) — no credit here
  return branchHits.some((pr) => pr.state.toUpperCase() === "MERGED" && ownsRunBranch(pr.headRefName, taskId));
}

/**
 * W1-T1257: THE FEEDBACK INBOX HAS NO DISCHARGE PATH. `FEEDBACK_STATUSES` (lib/feedback.ts) is a
 * closed five-member enum and every member names a decision about the PROPOSAL (new/grilling/
 * proposed/accepted/rejected) — none names the WORK the proposal's filed tasks eventually ship.
 * An entry whose every filed task has long since merged still reads `proposed` forever, and
 * `renderNeedsMe` (serve.ts) keeps pushing it into the live decision queue on every render.
 *
 * DERIVED, NEVER STORED (Q2/Q3 of this task's own rationale): no sixth enum member, no
 * `plan/feedback/*.yaml` write, nothing auto-advanced or hidden — the SAME read-time-decoration
 * shape as `ReconciledFeedbackEntry.unverified` (panel-graph.ts), computed fresh on every read
 * and never persisted, so there is nothing for it to drift from.
 *
 * REUSES `feedbackOriginTag` — the exact `origin: feedback#<id>` string `rmd triage`
 * (lib/triage.ts) stamps on every task it files, already walked by `traceForward` above — but
 * sources merged-ness from the projection's own credit (`findMergedByTrailer` ∪
 * `findMergedByHeadBranch`, status.ts's rungs (c)/(c2)), NEVER `runsForTask`'s ledger walk: the
 * dominant merge path is gate-side (a PR merges after its run already ended blocked), so a
 * shipped task can have no usable `pr.opened` ledger row and would read as unmerged if sourced
 * from the ledger instead.
 *
 * THREE-VALUED, never boolean:
 *   - `"discharged"` — the filed task set is NON-EMPTY and every member is credited merged.
 *   - `"not_discharged"` — the filed task set is EMPTY (the load-bearing falsifier: an entry
 *     that filed nothing is a refuted investigation or a standing ruling, not archaeology, and
 *     must keep its row), OR at least one filed task is uncredited.
 *   - `"undecidable"` — the merged-set read FAILED (`readFailed()`) or was TRUNCATED
 *     (`readTruncated()`): a partial read must not be mistaken for a live decision.
 * The empty-task-set check runs BEFORE the read-health check: an entry that filed nothing has a
 * definite answer regardless of whether GitHub is reachable right now.
 */
export function feedbackDischargeState(entry: FeedbackEntry, plan: Plan, github: DischargeGithub): FeedbackDischarge {
  const tag = feedbackOriginTag(entry.id);
  const taskIds = plan.tasks.filter((t) => t.origin === tag).map((t) => t.id);
  if (taskIds.length === 0) return { state: "not_discharged", taskIds };
  if (github.readFailed?.() || github.readTruncated?.()) return { state: "undecidable", taskIds };
  const discharged = taskIds.every((id) => taskCreditedMerged(id, github));
  return { state: discharged ? "discharged" : "not_discharged", taskIds };
}

/** Render a {@link TraceChain} to the plain-text tree `rmd trace` prints. Pure — no I/O. */
export function renderTraceChain(chain: TraceChain): string {
  const lines: string[] = [];
  if (chain.direction === "forward") {
    if (chain.feedback) lines.push(...renderFeedback(chain.feedback, ""));
    if (chain.tasks.length === 0) {
      lines.push(`    (no tasks in plan/tasks.yaml carry origin: ${feedbackOriginTag(chain.feedback?.id ?? "")} yet)`);
    } else {
      for (const task of chain.tasks) lines.push(...renderTask(task, "    "));
    }
  } else {
    for (const task of chain.tasks) {
      lines.push(`task ${task.id}: ${task.title}`);
      if (task.origin) {
        lines.push(`  -> origin: ${task.origin}`);
        if (chain.feedback) lines.push(...renderFeedback(chain.feedback, "    "));
      } else {
        lines.push(`  -> origin: (none recorded — a provenance violation, Rules 16/17)`);
      }
      if (task.runs.length === 0) {
        lines.push(`  (no runs yet — task not dispatched)`);
      } else {
        for (const run of task.runs) lines.push(...renderRun(run, "  "));
      }
    }
  }
  return lines.join("\n");
}
