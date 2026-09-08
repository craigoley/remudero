import { DISK_FAIL_BYTES, DISK_WARN_BYTES, humanBytes } from "./doctor.js";
import type { CrashLoopVerdict, StarvationCensus, StarvationClearedInfo } from "./daemon.js";
import { ghRateLimitWindow, type GhRateLimitProvenance } from "./daemon-health.js";
import { ghIssueGateway, tryEscalate, type IssueGateway } from "./escalate.js";
import { appendLedger, matchesRepoScopedTask } from "./ledger.js";
import type { Task } from "./plan.js";
import { DEFAULT_MAX_TASK_LIFETIME_DISPATCHES, readLedgerLines } from "./status.js";
import type { PostReviewStallVerdict } from "./sweep.js";

/**
 * P29(ii)'s escalation side — called once `nextRunnable`'s `isCircuitTripped`
 * (status.ts's `evaluateDispatchBreaker`, via this file's `breakerGateFor`) reports a
 * task has been dispatched the policy-capped number of times with no new owned PR
 * since — never called merely on "indeterminate" (an absent/rotated ledger read,
 * handled instead by `isIndeterminate` as a skip-and-retry, not an escalation; see
 * `evaluateDispatchBreaker`'s doc). DEDUPED: a
 * task escalates AT MOST ONCE (checked via this module's OWN `dispatch.
 * circuit_broken.escalated` ledger line — never `escalation.issue_opened`
 * alone, which a genuine_blocker escalation for the SAME task could also have
 * written, for an unrelated reason) — mirrors ops.ts's alert-escalation dedup
 * discipline (a ledger line as the dedup key), never a second store.
 */

/**
 * THE DEDUP KEY IS WRITTEN WHETHER OR NOT DELIVERY SUCCEEDS. The ledger-derived,
 * cross-boot dedup above was already the right shape; its defect was that the
 * marker was recorded only AFTER `escalate()` returned, so a THROWING `gh` wrote
 * nothing and every subsequent boot retried the same escalation — which is how a
 * transport failure became an unbounded relaunch loop (1 such marker in the
 * ledger against 460 boots). Marking the attempt makes the dedup durable across
 * the process death it is supposed to survive.
 *
 * The trade-off is deliberate and stated: a task whose escalation failed will not
 * be retried automatically. That is the correct side to err on for a BACKSTOP
 * NOTIFICATION — an undelivered notice is visible as an `escalation.failed` line
 * and costs one operator read, whereas retry-until-success costs the fleet.
 */
export function escalateCircuitBreak(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // W1-T429: repo-scoped dedup — a same-id task in ANOTHER repo must never dedup off (or be
  // dedup'd off by) this task's own escalation marker. `matchesRepoScopedTask` also honors a
  // marker ledgered before this task existed (no `repo` field at all) as still matching.
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.circuit_broken.escalated" && matchesRepoScopedTask(l, ctx.repo, task.id),
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: dispatch circuit breaker tripped — repeated dispatch with no new owned PR`,
      detail:
        `MASTER-PLAN P29(ii): ${task.id} has been dispatched with no new owned PR appearing since — the ` +
        `W1-T1/W1-T29 redispatch-storm shape (~130 dispatches / ~$130 / ~10h on one task, five hours of it ` +
        `AFTER the task's own PR had already merged under a sibling run). Dispatch is now HALTED for this ` +
        `task until a human resolves the underlying block; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying block (a manual patch or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    // W1-T429: the repo dimension the dedup read above (and any future one) matches against —
    // see repoScopedTaskKey's doc for why this rides alongside `task_id` rather than folding
    // into it.
    repo: ctx.repo,
    step: "dispatch.circuit_broken.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T316's escalation side — `escalateCircuitBreak`'s twin for the LIFETIME dispatch cap
 * (W1-T271): called once `nextRunnable`'s `isLifetimeCapExceeded` (status.ts's
 * `isLifetimeDispatchCapExceeded`, via this file's `breakerGateFor`) reports a task has been
 * dispatched (`run.start`) at least `DEFAULT_MAX_TASK_LIFETIME_DISPATCHES` times across its
 * WHOLE recorded history — a count `pr.opened` never resets, unlike the streak breaker's own,
 * so this fires for the shape that evades that breaker entirely (W1-T254: five dispatches in
 * eighty minutes, each one opening and merging its own genuine no-op PR).
 *
 * DEDUP + ORDERING mirror `escalateCircuitBreak` exactly, on the sibling ledger step
 * (`dispatch.lifetime_capped.escalated`, DECISION_RELEVANT so a rotation never re-arms it):
 * checked via this module's OWN ledger line (never `escalation.issue_opened` alone), and the
 * marker is written whether or not delivery succeeds, for the same reason `escalateCircuitBreak`'s
 * own doc gives — an undelivered notice costs one operator read, not an unbounded retry loop.
 */
export function escalateLifetimeCapExceeded(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // W1-T429: repo-scoped dedup — see escalateCircuitBreak's identical comment above.
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.lifetime_capped.escalated" && matchesRepoScopedTask(l, ctx.repo, task.id),
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: lifetime dispatch cap exceeded — dispatched ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES}+ times, ever`,
      detail:
        `W1-T271: ${task.id} has been dispatched (\`run.start\`) at least ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES} ` +
        `times across its whole recorded ledger history. UNLIKE the per-task circuit breaker above, this count is ` +
        `NEVER reset by a \`pr.opened\` line — so a task that merges a genuine no-op PR every cycle (the W1-T254 ` +
        `shape: five dispatches in eighty minutes, each one opening and merging its own PR) still trips this ` +
        `backstop even though the streak breaker alone never would. Dispatch is now HALTED for this task until a ` +
        `human resolves the underlying loop; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying loop (a manual patch, a task re-scope, or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    // W1-T429: see escalateCircuitBreak's identical field for why this rides alongside `task_id`.
    repo: ctx.repo,
    step: "dispatch.lifetime_capped.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T215's escalation side, wired at last — `escalateCircuitBreak`'s sibling for the daemon
 * BOOT-RATE invariant: called by `daemonBoot`'s `crashLoopCheck.onBreach` (lib/daemon.ts) when
 * `detectDaemonCrashLoop` finds MORE than `maxBoots` boots inside one rolling `windowMs`. The
 * detector merged 2026-07-22 (#590) and sat unasked while the 2026-08-03 ENOSPC storm relaunched
 * the daemon ten times with ZERO escalation — four dispatches died and the only operator signal
 * was "progress seems slow". This function is what a breach DOES: it opens a needs-human issue
 * carrying the verdict's own evidence (the densest window's boot timestamps), so the loop is
 * legible the moment it exists instead of after a hand-read of raw ledger timestamps.
 */

/**
 * CROSS-BOOT DEDUP keyed on the STORM, not a task (there is none) and not a per-process flag
 * (every relaunch IS a new process — a process flag would open one issue per boot, ~one a
 * minute). The episode rule, same discipline as `escalateHeadroomReserveBreach`'s `resets_at`
 * key: skip iff a prior `daemon.crashloop.escalated` marker's `window_newest` falls within
 * `windowMs` of THIS verdict's newest boot — an ongoing storm keeps every subsequent boot inside
 * one escalation, while a genuinely NEW storm (a quiet gap longer than the window, then fresh
 * boots) escalates again. The marker is written whether or not delivery succeeds, for
 * `escalateCircuitBreak`'s own stated reason: an undelivered notice costs one operator read, not
 * an unbounded retry loop. The step is in DECISION_RELEVANT_LEDGER_STEPS (ledger.ts) — this
 * function READS it to dedup, so a rotation archiving it would re-open a duplicate issue per
 * boot for as long as the storm lasts (the #977 class).
 *
 * DELIBERATELY NOT A BOOT BLOCKER: daemonBoot logs `daemon.crashloop_check` either way and boot
 * continues — KeepAlive keeps relaunching until the operator acts, and `state/PAUSE` remains the
 * stop. This surfaces; it does not gate.
 */
export function escalateCrashLoop(
  verdict: CrashLoopVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const newest = verdict.windowBoots[verdict.windowBoots.length - 1];
  const newestMs = Date.parse(newest ?? "");
  if (!verdict.breached || !Number.isFinite(newestMs)) return;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "daemon.crashloop.escalated") return false;
    const priorMs = Date.parse(String(l.window_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= verdict.windowMs;
  });
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `daemon crash-loop: ${verdict.windowBoots.length} boots inside ${Math.round(verdict.windowMs / 60_000)} minutes`,
      detail:
        `W1-T215: detectDaemonCrashLoop found ${verdict.windowBoots.length} daemon boots inside one rolling ` +
        `${Math.round(verdict.windowMs / 60_000)}-minute window (threshold: more than ${verdict.maxBoots}). ` +
        `launchd's KeepAlive relaunches a nonzero-exiting daemon every ThrottleInterval, so a boot rate like ` +
        `this means the daemon is DYING during or shortly after boot, being restarted, and dying again — the ` +
        `2026-08-03 shape, where an ENOSPC write in the boot path crash-looped ten boots with no signal. The ` +
        `densest window's boots, oldest first: ${verdict.windowBoots.join(", ")}. Boot itself is NOT blocked ` +
        `by this notice; the loop is still running until acted on.`,
      options: [
        {
          label: "read the last boot's failure and fix the cause",
          detail:
            "The crash is whatever kills the process between `daemon.boot` and its next tick — check the newest " +
            "ledger lines after the last `daemon.boot`, then the launchd stderr log. Disk-full, a thrown ledger " +
            "write, and a bad deploy are the observed causes.",
        },
        {
          label: "pause the fleet while diagnosing",
          detail: "Drop `state/PAUSE` (the daemon idles in-process, no relaunch storm) or `launchctl bootout` the unit.",
        },
      ],
      recommendation: "read the last boot's failure and fix the cause",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "daemon.crashloop.escalated",
    window_newest: newest,
    window_boots: verdict.windowBoots.length,
    window_ms: verdict.windowMs,
    max_boots: verdict.maxBoots,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The post-review STALL notice: the sweep's `postReview` path has failed {@link
 * POST_REVIEW_STALL_THRESHOLD} times in a row with no success between.
 *
 * THE DEFECT, MEASURED. `sweep.post_review.failed` fired 91 times across a week — every one a
 * GraphQL rate-limit — and produced NO operator-visible signal. Green PRs sat unreviewed while the
 * sweep retried each tick and appended another identical line; an operator found it by hand after a
 * full session. That is the week's recurring shape: a mechanism failing correctly and saying
 * nothing. A transport fix removes this CAUSE; only a signal removes the CLASS.
 */

/**
 * WHY A NEW CLASS RATHER THAN AN EXISTING ONE. A decision-authority audit found the escalation
 * funnel INVERTED — of 369 needs-human issues, roughly 80% were things the machine resolved itself
 * and were never retracted — so adding noise is the failure mode to avoid. This qualifies on the
 * test that audit implies: the machine CANNOT resolve it. Every existing class names a task or a PR
 * the fleet can act on (`dispatch.circuit_broken`, `dispatch.lifetime_capped`,
 * `dispatch.starvation`, `daemon.crashloop`, `daemon.headroom_reserve`); a post-review stall is
 * fleet-wide, blocks EVERY green PR at once, and its observed cause — an exhausted API quota — is
 * outside the fleet's power to fix. Reusing `daemon.crashloop` would misname it and reusing a
 * per-task class would file one issue per stuck PR, which is the inversion again.
 */

/**
 * DEDUP IS THE WHOLE DESIGN, NOT A DETAIL. `escalate()` gates its entire dedup block on
 * `if (prRef && deps.issues.listOpen)`, so an escalation naming no PR skips dedup and opens a FRESH
 * issue every call — the observed eight-identical-"dispatch queue starved"-issues shape. This
 * escalation names no single PR (the condition is fleet-wide), so it dedups the way
 * `escalateCrashLoop` does: an EPISODE key in the ledger. Skip iff a prior
 * `sweep.post_review.stalled.escalated` marker's `episode_newest` is within `episodeMs` of THIS
 * verdict's newest failure. An ongoing stall therefore escalates ONCE however many ticks it spans,
 * while a genuinely new stall after a quiet gap escalates again. The marker is written whether or
 * not delivery succeeded, for `escalateCircuitBreak`'s stated reason: an undelivered notice costs
 * one operator read, not an unbounded retry loop. The step is registered in
 * DECISION_RELEVANT_LEDGER_STEPS (ledger.ts) because THIS function reads it back.
 */
export const POST_REVIEW_STALL_EPISODE_MS = 60 * 60 * 1000;

export function escalatePostReviewStall(
  verdict: PostReviewStallVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway; episodeMs?: number },
): void {
  const newestMs = Date.parse(verdict.newestFailureTs ?? "");
  if (!verdict.stalled || !Number.isFinite(newestMs)) return;
  const episodeMs = ctx.episodeMs ?? POST_REVIEW_STALL_EPISODE_MS;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "sweep.post_review.stalled.escalated") return false;
    const priorMs = Date.parse(String(l.episode_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= episodeMs;
  });
  if (already) return;
  const quota = verdict.rateLimited
    ? " Every failure in the run is an API quota exhaustion, which is fleet-stopping but self-clearing at the " +
      "bucket's reset — check `gh api rate_limit` before assuming a code fault."
    : "";
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `post-review stalled: ${verdict.consecutiveFailures} consecutive failures, no review posted`,
      detail:
        `The sweep's post-review path has failed ${verdict.consecutiveFailures} times in a row with no success ` +
        `between (first ${verdict.oldestFailureTs}, newest ${verdict.newestFailureTs}). While this holds, a PR ` +
        `whose checks are green never receives its remudero-review status, so it cannot merge and the sweep ` +
        `re-attempts it every tick — silently, which is why this notice exists.${quota} The failing call, with ` +
        `digits normalised so one stall does not read as many: ${verdict.normalisedError}`,
      options: [
        {
          label: "clear the cause, then let the next sweep tick post the reviews",
          detail:
            "No manual re-drive is needed — the sweep re-attempts every tick, so the backlog clears itself once " +
            "the cause is gone." +
            // Only offered when it actually applies: naming a quota remedy on a stall that is not a
            // quota problem sends the operator to the wrong instrument, which is the failure mode
            // this whole notice exists to avoid.
            (verdict.rateLimited ? " `gh api rate_limit` shows the reset." : ""),
        },
        {
          label: "post the blocked reviews by hand",
          detail: "`rmd review <pr>` per stuck PR — the same deterministic verb the sweep calls.",
        },
      ],
      recommendation: "clear the cause, then let the next sweep tick post the reviews",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "sweep.post_review.stalled.escalated",
    episode_newest: verdict.newestFailureTs,
    consecutive_failures: verdict.consecutiveFailures,
    rate_limited: verdict.rateLimited,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * P34 clause (c), W1-T249: the daemon's `onHeadroomBreach` hook, called when a
 * weekly (or session) window first crosses the operator reserve. Dispatch is
 * ALREADY paused by the time this fires (`runDaemon`'s own in-process idle,
 * driven by the SAME reading) — this is a pure notification, mirroring
 * `escalateCircuitBreak` immediately above rather than a second mechanism.
 *
 * CROSS-BOOT DEDUP keyed on `resetsAt` — NOT task id (there is no task; the
 * breach is a property of the account, not one candidate change) and NOT a
 * per-process flag alone (`runDaemon`'s own `headroomReserveEscalated` already
 * bounds ONE daemon run, but a restart forgets it and would re-open the SAME
 * issue for the SAME still-unresolved window). The window's own `resets_at` is
 * the natural episode key: unchanged for as long as the breach persists, and a
 * NEW value the moment the window actually resets, so a later breach escalates
 * again rather than staying silenced by a stale marker (the same "write the
 * dedup key whether or not delivery succeeded" discipline
 * `escalateCircuitBreak` documents, so a throwing `gh` is never retried into an
 * unbounded relaunch loop).
 */
export function escalateHeadroomReserve(
  info: { window: string; percentUsed: number; limitPct: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.headroom_reserve.escalated" && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "HARD_STOP",
      taskId: "daemon",
      runId: ctx.runId,
      // THE WINDOW IS DATA, NEVER A LITERAL. This summary hardcoded "weekly" while the detail
      // below has always interpolated `info.window` correctly, so every session exhaustion opened
      // an issue TITLED weekly with a BODY reading `session (5h)`. MEASURED on #3483: the title
      // said "weekly headroom reserve reached — dispatch paused until 2026-09-01T12:00:00.000Z"
      // while its own body said "session (5h) is at 100% used", and the daemon telemetry for that
      // episode named `session (5h)` throughout. The daemon could always tell the two apart
      // (`resolveHeadroomWindows` labels them separately); only this line could not.
      summary: `${info.window} headroom reserve reached — dispatch paused until ${info.resetsAt}`,
      detail:
        `P34 clause (c): ${info.window} is at ${info.percentUsed}% used (>= the ${info.limitPct}% operator ` +
        `reserve ceiling). Dispatch is paused — drain-and-hold, in-flight work finishes, no new spawn — until ` +
        `the window resets at ${info.resetsAt}; imputed ledger dollar figures never gate this decision, only ` +
        `the subscription window itself does.`,
      options: [
        {
          label: "wait for reset",
          detail: `Dispatch resumes on its own once the window resets at ${info.resetsAt} — no action needed.`,
        },
        {
          label: "raise the reserve",
          detail: "If 5% is too conservative for this account, retune the HEADROOM_LIMIT_PCT policy curve.",
        },
      ],
      recommendation: "wait for reset",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.headroom_reserve.escalated",
    // W1-T2603: the window this escalation was raised FOR, so a later recovery reading can be
    // matched against the SAME window rather than merely the same class. Absent on every row this
    // repo wrote before this task — `buildHeadroomRecoveryCandidates` below treats that as
    // unmatchable (never a false match), so the pre-existing #3334/#3384/#3483-shaped issues stay
    // exactly what they already are: manually closed, not silently retired on a guess.
    window: info.window,
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): the daemon's `onDiskHeadroomBreach`
 * hook — real free space, read off the daemon's own `startInFlightTicker` cadence
 * (`daemon.ts`), has crossed below WARN (`DISK_WARN_BYTES`, 2 GiB) or FAIL (`DISK_FAIL_BYTES`,
 * 512 MiB), judged by the SAME `judgeDiskHeadroom` `rmd doctor` reports against (doctor.ts) —
 * imported, never re-derived, so the two surfaces cannot disagree mid-incident.
 */

/**
 * ESCALATES AT WARN, NOT ONLY FAIL, AND THAT IS THE WHOLE POINT (design (iv)). By FAIL, the
 * issue body, this function's OWN dedup marker below and the ledger row it lives on are all
 * writes that may themselves lose to the same ENOSPC this hook exists to report ahead of —
 * `escalateCrashLoop`'s own doc names the shape exactly: "a detector whose input can only be
 * recorded by a write that ENOSPC rejects is structurally incapable of being the FIRST signal;
 * it is the autopsy." This fires while writes still succeed.
 */

/**
 * DEDUP IS TWO LAYERS, NOT ONE. `runDaemon`'s own in-process latch (daemon.ts's
 * `diskHeadroomLatch`, shared across every phase this daemon run ticks) already calls this hook
 * AT MOST ONCE per continuous breach — cleared the moment a later reading is back at OK — so a
 * disk sitting below WARN for six hours produces exactly one call from a single continuous
 * process (the #977 duplicate-issue class this repo has already paid for twice). This
 * function's OWN ledger read exists for what the in-process latch cannot cover: a daemon
 * RESTART mid-episode (disk pressure can itself crash-loop the daemon — the 2026-08-03 shape)
 * resets that latch to `false`, and the very next tick would call this hook again for the SAME
 * still-unresolved episode. Skip iff a prior `daemon.disk_headroom.escalated` marker's OWN `ts`
 * (ledger-stamped at write, `appendLedger`'s contract) is within `episodeMs` of THIS reading's
 * `ts` — the same "compare against an episode window" shape `escalatePostReviewStall` applies
 * for a condition with no natural reset boundary (unlike `escalateHeadroomReserve`'s
 * `resets_at`). The marker is written whether or not delivery succeeds — `escalateCircuitBreak`'s
 * own stated reason: an undelivered notice costs one operator read, not an unbounded retry loop.
 * The step is in `DECISION_RELEVANT_LEDGER_STEPS` (ledger.ts) because THIS function reads it
 * back — a rotation dropping it would re-open one duplicate needs-human issue on every tick this
 * condition persists, once the marker falls out of the retained view.
 */
export const DISK_HEADROOM_EPISODE_MS = 60 * 60 * 1000;

export function escalateDiskHeadroomBreach(
  info: { freeBytes: number; verdict: "WARN" | "FAIL"; ts: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway; episodeMs?: number },
): void {
  const newestMs = Date.parse(info.ts);
  if (!Number.isFinite(newestMs)) return;
  const episodeMs = ctx.episodeMs ?? DISK_HEADROOM_EPISODE_MS;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "daemon.disk_headroom.escalated") return false;
    const priorMs = Date.parse(String(l.ts ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= episodeMs;
  });
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `disk headroom ${info.verdict}: ${humanBytes(info.freeBytes)} free`,
      detail:
        `W1-T1082: the daemon's own poll path read ${humanBytes(info.freeBytes)} free on its own filesystem, ` +
        `below the ${humanBytes(DISK_WARN_BYTES)} WARN threshold ` +
        `\`rmd doctor\` also judges against (\`doctor.ts\`'s \`judgeDiskHeadroom\`, one shared definition — the ` +
        `two surfaces cannot disagree). This escalates at WARN rather than waiting for FAIL ` +
        `(${humanBytes(DISK_FAIL_BYTES)}) because by FAIL the ledger this very notice writes to may itself fail ` +
        `to append — the 2026-08-03 ENOSPC storm's own shape, where the first signal anyone had was ` +
        `\`appendLedger\` throwing.`,
      options: [
        {
          label: "reclaim disk space",
          detail:
            "`rmd doctor` names every other measured source on this host; scratch reaping, worker-home reaping " +
            "and the tmp backstop are the usual owners (each has its own task — this notice only surfaces).",
        },
        {
          label: "grow the volume",
          detail: "If this host is routinely this close to full, the ceiling itself may be too small for its workload.",
        },
      ],
      recommendation: "reclaim disk space",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "daemon.disk_headroom.escalated",
    free_bytes: info.freeBytes,
    verdict: info.verdict,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The daemon's `onHeadroomParkCeiling` hook: the headroom park outlived its ceiling, so the fleet
 * dispatched BLIND for one tick rather than idling forever.
 *
 * DEDUPED ACROSS BOOTS, and the key is "has the governor SEEN anything since we last paged?".
 * `escalateHeadroomReserve` above keys on `resets_at` because a reserve breach has a natural
 * boundary; a blind stretch has none, so its identity is the last moment the governor could read
 * at all. Concretely: skip when an `.escalated` row is NEWER than the newest `daemon.headroom`
 * (the row a READABLE probe writes). That gives exactly one page per blind stretch —
 *   - a daemon that restart-loops while still blind re-derives the same answer and stays quiet,
 *     which the in-process guard alone could never do;
 *   - a probe that RECOVERS writes a newer `daemon.headroom`, so the next blind stretch pages
 *     again rather than staying silenced forever.
 * Both rows are in {@link DECISION_RELEVANT_LEDGER_STEPS}, so rotation cannot make this
 * re-page — and if the readable row somehow vanished first, the comparison fails QUIET (an
 * existing escalation wins), which is the right direction for a notification.
 */
export function escalateHeadroomParkCeiling(
  info: { consecutiveUnreadable: number; parkedMs: number; ceilingMs: number },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // BOTH READS COMPARE AGAINST A STRING LITERAL INLINE, DELIBERATELY, rather than through a
  // helper taking the step name as a parameter. `test/ledger-rotation.test.ts` discovers
  // decision-relevant steps by scanning consumer source for that exact comparison form, so a
  // parameterised helper is INVISIBLE to it — and the rotation-set membership this dedup depends
  // on stops being self-enforcing. Measured: with the loop factored into a generic helper,
  // deleting either entry from DECISION_RELEVANT_LEDGER_STEPS left that test green.
  const lines = readLedgerLines(ctx.ledgerPath);
  let lastReadable: string | undefined;
  let lastEscalated: string | undefined;
  for (const l of lines) {
    const ts = typeof l.ts === "string" ? l.ts : undefined;
    if (!ts) continue;
    if (l.step === "daemon.headroom" && (lastReadable === undefined || ts > lastReadable)) lastReadable = ts;
    if (l.step === "daemon.headroom.park_ceiling.escalated" && (lastEscalated === undefined || ts > lastEscalated)) {
      lastEscalated = ts;
    }
  }
  // Already paged for THIS blind stretch: no readable row at all since, or none newer.
  if (lastEscalated !== undefined && (lastReadable === undefined || lastEscalated > lastReadable)) return;

  const minutes = Math.round(info.ceilingMs / 60_000);
  const issueUrl = tryEscalate(
    {
      // MANUAL, not HARD_STOP: dispatch is NOT paused here — it is proceeding riskily, which is
      // the opposite posture from `escalateHeadroomReserve`'s breach and needs saying.
      class: "MANUAL",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `headroom unreadable for ${minutes}m — dispatching BLIND past the park ceiling`,
      detail:
        `The usage probe has failed ${info.consecutiveUnreadable} consecutive times and the park ` +
        `outlived its ${minutes}-minute ceiling, so the daemon dispatched with NO headroom reading ` +
        `rather than idling forever. The spend bound this bypasses is deliberately accepted, not ` +
        `satisfied: the fleet may now be spending against an exhausted account. The ceiling re-arms, ` +
        `so exposure is one blind dispatch per ${minutes} minutes until a probe succeeds — but the ` +
        `probe itself is the thing to fix. Check the usage.probe_failed rows for the stage and ` +
        `reason, and the worker-home grant rows for a lost .claude slot.`,
      options: [
        {
          label: "fix the probe",
          detail: "Read the usage.probe_failed stage: spawn, parse or grant each point somewhere different.",
        },
        {
          label: "disable the governor",
          detail: "Setting headroom.enabled false skips the park entirely — dispatch stops being gated on a read that cannot succeed.",
        },
      ],
      recommendation: "fix the probe",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.headroom.park_ceiling.escalated",
    consecutive_unreadable: info.consecutiveUnreadable,
    parked_ms: info.parkedMs,
    ceiling_ms: info.ceilingMs,
    // Forensics: the moment the governor last saw anything, which is also this dedup's key.
    blind_since: lastReadable ?? "never",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T372: the daemon's `onQuotaExhausted` hook, called when a `gh api rate_limit` bucket
 * (REST/core or GraphQL — read independently, `daemon.ts`'s tick) first crosses from having
 * budget to having none. UNLIKE `escalateHeadroomReserve` immediately above, dispatch is NOT
 * paused by the time this fires — W1-T372 is observe-and-surface only (this task's design
 * (vii): no threshold change, no governing action) — so this notice exists purely so an
 * operator is not the one who discovers the exhaustion by watching `gh pr create` die at a
 * push boundary (the a2b904d recon this task cites: W1-T333 lost ~40 minutes of completed
 * work that way, silently, because nothing observed the crossing).
 */

/**
 * CROSS-BOOT DEDUP keyed on (bucket, resetsAt) — the SAME "episode key = the window's own
 * reset instant" discipline `escalateHeadroomReserve` documents just above, kept PER BUCKET
 * (design (iv)) so a core exhaustion and a GraphQL exhaustion in the same hour each get their
 * own notice rather than one suppressing the other, and so a bucket that exhausts again after
 * its own reset (a genuinely new episode) escalates again rather than staying silenced by a
 * stale marker from the PRIOR window.
 */

/**
 * SELF-CLEARING, STATED IN THE BODY ITSELF (design (v)): a quota exhaustion clears on its own
 * bucket's hourly reset, so this notice names its own expiry (`resetsAt`) rather than asking
 * for a human close — W1-T345 is the filed retraction mechanism this notice does not depend
 * on; until it lands (or if it never does), the reset timestamp alone tells a human reading
 * this later that no action closes it.
 */

/**
 * W1-T2305 — `deps.provenanceBracket` is THE BRACKET RULE (design (ii)), applied at the one
 * place this task's own design (iv) names as consequential: when a caller HAS two provenanced
 * readings (same actor, same resource) taken at different times, this checks — via
 * {@link ghRateLimitWindow}, lib/daemon-health.ts — that they agree on actor AND reset epoch
 * before letting the escalation through; a mismatched bracket describes two different identities
 * or two different reset periods and is DISCARDED (ledgered as such, never escalated), which is
 * the one outcome design (iv) says this task must make impossible. Optional and omitted by every
 * call site today (`reportDrainQuotaExhaustion` below and `runDaemon`'s own tick both hand this
 * a single `GhRateLimitBucket` reading with no second, provenanced reading to bracket against —
 * see this task's follow-ups for wiring a real second reading in) — an omitted bracket escalates
 * exactly as before, so no existing caller's behavior changes and the escalation paths keep
 * their ability to fire (design (v)): "dispatch is NOT paused by this hook" remains true, and so
 * does "this notice still opens."
 */
export function escalateQuotaExhaustion(
  info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
  deps: { provenanceBracket?: { start: GhRateLimitProvenance; end: GhRateLimitProvenance } } = {},
): void {
  if (deps.provenanceBracket && !ghRateLimitWindow(deps.provenanceBracket.start, deps.provenanceBracket.end)) {
    appendLedger(ctx.ledgerPath, {
      run_id: ctx.runId,
      task_id: "daemon",
      step: "daemon.quota_exhausted.provenance_discarded",
      bucket: info.bucket,
      resets_at: info.resetsAt,
    });
    return;
  }
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.quota_exhausted.escalated" && l.bucket === info.bucket && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const spent =
    info.bucket === "graphql"
      ? "`gh pr create`, `gh pr view --json`, and therefore `rmd review` — a run that finishes its work and " +
        "then cannot open or update its own PR at this bucket's exhaustion loses that work silently, exactly " +
        "as W1-T333 did"
      : "the board's own `gh pr view`/`pr list`/`issue view` reads (status.ts's `ghGateway`/`buildBatchedGithub`)";
  const issueUrl = tryEscalate(
    {
      class: "HARD_STOP",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `gh api rate_limit ${info.bucket} bucket exhausted — resets ${info.resetsAt}`,
      detail:
        `W1-T372: the daemon's tick observed the ${info.bucket} bucket cross from having budget to ${info.remaining} ` +
        `remaining. This bucket backs ${spent}. This is a NOTICE, not a hold: dispatch is not paused and no ` +
        `existing consumer's behavior changed — the bucket refills on its own at ${info.resetsAt}, and this notice ` +
        `is self-clearing at that instant with no action required; a human reading this after that time can close ` +
        `it on sight.`,
      options: [
        {
          label: "wait for reset",
          detail: `The bucket refills on its own at ${info.resetsAt} — no action needed.`,
        },
        {
          label: "check what spent it",
          detail: "`gh api rate_limit` shows the live figure; a runaway caller against this bucket is the thing worth finding, not this notice.",
        },
      ],
      recommendation: "wait for reset",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.quota_exhausted.escalated",
    bucket: info.bucket,
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * Recon oper#queue-starvation-2026-08-03: the daemon's `onStarvation` hook, called on an idle
 * tick whose dispatch-filter census names at least one RECOVERABLE-class blocker (circuit-
 * broken, blocked, or unmet-deps — see daemon.ts's `StarvationCensus`/starvation predicate)
 * rather than every remaining task being already-merged or verify:human. THE ASYMMETRY THIS
 * FIXES: a FAILING run already escalates (`escalateCircuitBreak` above fires once per tripped
 * breaker), but a queue that has run OUT of dispatchable work used to be indistinguishable
 * from one quietly healthy between tasks — both logged only `daemon.idle`. Dispatch is
 * already idle by the time this fires (the same in-process bound `runDaemon`'s own
 * `starvationEscalated` applies before ever calling this) — a pure notification, mirroring
 * `escalateCircuitBreak`/`escalateHeadroomReserve` immediately above rather than a second
 * mechanism.
 */

/**
 * CROSS-BOOT DEDUP, KEYED ON "has anything actually dispatched since this last escalated" —
 * never a fixed key (there is only ever one starvation state at a time, unlike
 * `escalateCircuitBreak`'s per-task-id dedup) and never the census contents (the exact set of
 * blocked ids can churn while the queue stays starved throughout — that is still the SAME
 * episode, not a new one). `run.start` (status.ts's own dispatch-attempt marker, already
 * decision-relevant) is the natural episode boundary: it is written the moment ANY task is
 * next attempted, which is exactly what ends a starvation episode ("a new dispatchable task
 * ends the episode and re-arms"). If the most recent `dispatch.starvation.escalated` line
 * postdates the most recent `run.start` line, this starvation has already been reported and
 * nothing has dispatched since — no-op. Otherwise a dispatch happened since the last notice
 * (or none was ever sent), so the episode is fresh: escalate and write the marker, whether or
 * not delivery succeeded (`escalateCircuitBreak`'s discipline — an undelivered notice must
 * never retry into an unbounded relaunch loop).
 */
export function escalateStarvation(
  census: StarvationCensus,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const lines = readLedgerLines(ctx.ledgerPath);
  let lastEscalatedIdx = -1;
  let lastDispatchIdx = -1;
  lines.forEach((l, i) => {
    if (l.step === "dispatch.starvation.escalated") lastEscalatedIdx = i;
    if (l.step === "run.start") lastDispatchIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastDispatchIdx) return;

  const name = (label: string, bucket: { count: number; ids: readonly string[]; truncated: number }): string | null =>
    bucket.count === 0
      ? null
      : `${label}: ${bucket.count} (${bucket.ids.join(", ")}${bucket.truncated > 0 ? `, +${bucket.truncated} more` : ""})`;
  const parts = [
    name("circuit-broken", census.circuitBroken),
    name("blocked", census.blocked),
    name("unmet-deps", census.unmetDeps),
  ].filter((p): p is string => p !== null);

  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `dispatch queue starved — zero dispatchable, ${parts.length} recoverable class(es) blocking`,
      detail:
        `oper#queue-starvation-2026-08-03: the queue has nothing dispatchable, but this is NOT ` +
        `every task being done or needing a human — at least one RECOVERABLE-class blocker is ` +
        `holding it back: ${parts.join("; ")}. The fleet has headroom to spend and is sitting idle ` +
        `instead; the only prior symptom was a bare \`daemon.idle\` line every poll.`,
      options: [
        {
          label: "resolve the blockers",
          detail:
            "Fix the named ids: a circuit-broken task needs a manual patch or `rmd fix` (then a " +
            "fresh owned PR clears the breaker); a `blocked:` task needs the plan mark lifted; an " +
            "unmet-deps task clears itself once its dependency merges.",
        },
        {
          label: "acknowledge and wait",
          detail: "If the blockers are already being worked, no action is needed — the daemon keeps polling and re-arms this notice once it next dispatches.",
        },
      ],
      recommendation: "resolve the blockers",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    circuit_broken: census.circuitBroken.count,
    blocked: census.blocked.count,
    unmet_deps: census.unmetDeps.count,
    circuit_broken_ids: census.circuitBroken.ids,
    blocked_ids: census.blocked.ids,
    unmet_deps_ids: census.unmetDeps.ids,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * THE CLEARED HALF (this task) — `escalateStarvation` above opens an issue and this closes it,
 * fired from `runDaemon`'s `onStarvationCleared` hook on the SAME edge that resets
 * `starvationEscalated` (daemon.ts): a queue that stopped being starved, either because nothing
 * recoverable is blocking anymore or because a dispatchable task appeared. THE PRODUCER ALREADY
 * KNOWS which — `info.reason` names it and `info.taskId` names the task where there is one — so
 * the closing comment says WHY, never a bare "resolved" a week-later reader could not act on.
 *
 * THE REFERENT IS THE LEDGER, NEVER A LOOKUP: the issue to close is whichever URL THIS episode's
 * OWN `dispatch.starvation.escalated` row named (the most recent one, unless a LATER
 * `dispatch.starvation.cleared` row already closed it) — never any other open issue, so no
 * escalation of another class is ever touched by this path. Absent (delivery failed, or already
 * cleared) ⇒ nothing to close, a silent no-op.
 *
 * CANNOT-OBSERVE MEANS WAIT (W1-T130), applied to the closer: a gateway that cannot close (no
 * `closeWithComment`) or one whose close call throws leaves the issue OPEN and costs one ledger
 * row (`delivered: false`) — never a throw propagated into the daemon loop, matching
 * `deriveStatus`'s own polarity and `escalateStarvation`'s own "write the marker whether or not
 * delivery succeeded" discipline. The marker is written on EVERY call that found an issue to
 * close (success or failure alike), so an episode ending is countable on the ledger either way.
 */
export function escalateStarvationCleared(
  info: StarvationClearedInfo,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const lines = readLedgerLines(ctx.ledgerPath);
  let issueUrl: string | null = null;
  for (const l of lines) {
    if (l.step === "dispatch.starvation.escalated") {
      issueUrl = typeof l.issue_url === "string" ? l.issue_url : null;
    } else if (l.step === "dispatch.starvation.cleared") {
      // A prior clear already closed (or gave up on) whatever the last escalation opened —
      // never re-derive a referent from an OLDER escalated row past this point.
      issueUrl = null;
    }
  }
  if (!issueUrl) return;

  const reasonText =
    info.reason === "no-recoverable-blockers"
      ? "nothing recoverable is blocking the queue anymore"
      : `a dispatchable task appeared${info.taskId ? ` (${info.taskId})` : ""} and ended the episode`;
  const comment =
    `oper#queue-starvation-2026-08-03: this starvation episode has ended — ${reasonText}. ` +
    `Closing automatically; a fresh episode opens its own issue if the queue starves again.`;

  const issues = ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo);
  let delivered = false;
  let failure: string | undefined;
  if (!issues.closeWithComment) {
    failure = "issue gateway cannot close issues";
  } else {
    try {
      issues.closeWithComment(issueUrl, comment);
      delivered = true;
    } catch (e) {
      // CANNOT-OBSERVE MEANS WAIT (W1-T130): never rethrown into the daemon loop -- the
      // ledger row appended below carries this as its own `failure` field instead.
      failure = String((e as Error)?.message ?? e);
    }
  }

  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId ?? "daemon",
    step: "dispatch.starvation.cleared",
    reason: info.reason,
    issue_url: issueUrl,
    delivered,
    ...(failure ? { failure } : {}),
  });
}
