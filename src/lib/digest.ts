import { readLedgerLines } from "./status.js";
import { notify, type NotifyDeps } from "./notify.js";
import { renderAlertsSummary, type AlertsPollSummary } from "./ops.js";
import { renderIssuesSummary, type IssuesPollSummary } from "./issues-intake.js";
import { renderInboxPollSummary, type InboxPollSummary } from "./inbox.js";
import type { RundownLine } from "./drain.js";
import type { LastSeenStore } from "./last-seen.js";

/**
 * Daily digest (W1-T8 title; assembled here, delivered here, SCHEDULED by the
 * daemon loop later (W1-T12) — this module owns no clock/cron of its own).
 *
 * MASTER-PLAN §4: "Interrupts collapse to a daily digest; real-time pings only for
 * MANUAL + hard-stop." BLOCKED escalations and ordinary run outcomes (merges,
 * blocked_* verdicts, notional cost) accumulate in the ledger all day and are
 * rolled into ONE message here, instead of paging on every one.
 */

/** One ledger line, loosely typed like {@link readLedgerLines}'s return. */
type LedgerLine = Record<string, unknown>;

/** Ledger lines with `ts >= sinceIso`, in original (chronological) order. */
export function collectSince(lines: LedgerLine[], sinceIso: string): LedgerLine[] {
  return lines.filter((l) => typeof l.ts === "string" && (l.ts as string) >= sinceIso);
}

export interface DigestSummary {
  sinceIso: string;
  merged: string[];
  blocked: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  escalations: Array<{ taskId: string; class: string; issueUrl: string }>;
  costUsd: number;
  /**
   * The LATEST `ops.alerts_polled` snapshot inside the window (W1-T55, lib/ops.ts)
   * — a snapshot of OPEN alert counts+ages, not an additive event count like
   * `merged`/`blocked`, so "latest wins" rather than summing repeated polls.
   * Undefined when `rmd ops` never polled inside this window.
   */
  alerts?: AlertsPollSummary;
  /**
   * The LATEST `issues.polled` snapshot inside the window (W1-T57, lib/issues-intake.ts) — the
   * issues-reviewed count so "issues reviewed regularly" is a ledgered fact, not an intention.
   * Same "latest wins" rule as `alerts`. Undefined when `rmd issues` never polled inside this window.
   */
  issues?: IssuesPollSummary;
  /**
   * The LATEST `inbox.polled` snapshot inside the window (W1-T112, lib/inbox.ts) — the
   * ready-proposal count so the morning pulse answers "what needs me" without a separate
   * `rmd inbox` check. Same "latest wins" rule as `alerts`/`issues`. Undefined when `rmd
   * inbox` never polled inside this window — {@link renderDigest} SOFT-COMPOSES this one:
   * it OMITS the "inbox: N ready" line entirely rather than falling back to a "(no poll
   * this window)" placeholder, so a digest predating `rmd inbox` (or one where it simply
   * hasn't run yet) renders byte-identical to before this field existed.
   */
  inbox?: InboxPollSummary;
  /**
   * W1-T178 (verdict stability): count of `review.downgrade_suppressed` ledger
   * lines inside the window — a semantic-lane downgrade suppressed because the
   * deterministic floor still passed on an unchanged head. This is the signal
   * that tells whether the semantic lane is getting noisier or quieter over
   * time; a suppression is never silent (see run-task.ts's `runReview`), but
   * this is where the COUNT is visible without reading the raw ledger.
   */
  verdictDowngradesSuppressed: number;
}

/** Reduce the day's ledger lines to the counts a digest reports. Pure over its input. */
export function summarize(lines: LedgerLine[], sinceIso: string): DigestSummary {
  const since = collectSince(lines, sinceIso);
  const summary: DigestSummary = {
    sinceIso,
    merged: [],
    blocked: [],
    escalations: [],
    costUsd: 0,
    verdictDowngradesSuppressed: 0,
  };
  for (const l of since) {
    if (l.step === "review.downgrade_suppressed") summary.verdictDowngradesSuppressed++;
    if (l.step === "verdict" && typeof l.task_id === "string") {
      if (l.verdict === "merged") {
        summary.merged.push(l.task_id);
      } else if (typeof l.verdict === "string" && l.verdict.startsWith("blocked")) {
        summary.blocked.push({ taskId: l.task_id, verdict: l.verdict, prUrl: typeof l.pr_url === "string" ? l.pr_url : undefined });
      }
      if (typeof l.cost_usd === "number") summary.costUsd += l.cost_usd;
    }
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string" && typeof l.issue_url === "string") {
      summary.escalations.push({ taskId: l.task_id, class: String(l.class ?? "?"), issueUrl: l.issue_url });
    }
    if (l.step === "ops.alerts_polled" && l.alerts && typeof l.alerts === "object") {
      summary.alerts = l.alerts as AlertsPollSummary;
    }
    if (l.step === "issues.polled" && l.issues && typeof l.issues === "object") {
      summary.issues = l.issues as IssuesPollSummary;
    }
    if (l.step === "inbox.polled" && l.inbox && typeof l.inbox === "object") {
      summary.inbox = l.inbox as InboxPollSummary;
    }
  }
  return summary;
}

/**
 * Deep-link a task id to its console card (W1-T144, MASTER-PLAN §7B). A HASH route —
 * `#task=<id>` — so the link never leaves the client: no bearer token rides along in
 * message-app history, and it layers cleanly on top of whatever base URL (and its own
 * `?token=`, per apps/dashboard's `readConfig`) the operator already has bookmarked.
 * `consoleBaseUrl` is a full origin (e.g. `http://100.x.x.x:4317`, config.ts's
 * `consoleUrl`); a trailing slash is tolerated. `taskId` is percent-encoded so a link
 * for task X can never be mistaken for — or collide with — a link for a different id.
 */
export function consoleCardUrl(consoleBaseUrl: string, taskId: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, "")}/#task=${encodeURIComponent(taskId)}`;
}

/**
 * Render a {@link DigestSummary} as the digest text — what a human reads, once a day.
 * `consoleBaseUrl`, when given, appends a W1-T144 console deep link to each escalation
 * line so a needs-human item read off the message channel jumps straight to its task
 * card. Omitted (the default), the escalations line renders EXACTLY as before this
 * field existed — no caller that predates W1-T144 sees any change.
 */
export function renderDigest(s: DigestSummary, consoleBaseUrl?: string): string {
  const lines = [
    `Remudero daily digest — since ${s.sinceIso}`,
    `merged: ${s.merged.length ? s.merged.join(", ") : "(none)"}`,
    `blocked: ${
      s.blocked.length ? s.blocked.map((b) => `${b.taskId} (${b.verdict}${b.prUrl ? ` — ${b.prUrl}` : ""})`).join(", ") : "(none)"
    }`,
    `escalations: ${
      s.escalations.length
        ? s.escalations
            .map((e) => `[${e.class}] ${e.taskId} — ${e.issueUrl}${consoleBaseUrl ? ` — ${consoleCardUrl(consoleBaseUrl, e.taskId)}` : ""}`)
            .join(", ")
        : "(none)"
    }`,
    `alerts: ${s.alerts ? renderAlertsSummary(s.alerts) : "(no poll this window)"}`,
    `issues reviewed: ${s.issues ? renderIssuesSummary(s.issues) : "(no poll this window)"}`,
    // W1-T112: soft-composed — present only when `rmd inbox` polled inside this window, an
    // absent entirely (not a "(no poll this window)" placeholder) line otherwise, see the
    // `inbox` field's doc on DigestSummary.
    ...(s.inbox ? [`inbox: ${renderInboxPollSummary(s.inbox)}`] : []),
    `verdict downgrades suppressed: ${s.verdictDowngradesSuppressed}`,
    `notional cost: $${s.costUsd.toFixed(2)}`,
  ];
  return lines.join("\n");
}

/**
 * Build the digest text straight from a ledger file, as of `sinceIso`. `consoleBaseUrl`
 * threads through to {@link renderDigest} — see its doc for the W1-T144 deep-link contract.
 */
export function buildDigest(ledgerPath: string, sinceIso: string, consoleBaseUrl?: string): string {
  return renderDigest(summarize(readLedgerLines(ledgerPath), sinceIso), consoleBaseUrl);
}

/** Build the digest from `ledgerPath` and deliver it over the SAME notify channel as real-time pings. */
export function sendDigest(ledgerPath: string, sinceIso: string, deps: NotifyDeps, consoleBaseUrl?: string): string {
  const text = buildDigest(ledgerPath, sinceIso, consoleBaseUrl);
  notify(text, deps);
  return text;
}

/**
 * Render a post-drain {@link RundownLine} array as ONE digest-channel message (W1-T144):
 * the PUSH counterpart to `drain.ts`'s own `renderRundown` (a pull-view printed to the
 * terminal that kicked the drain off). Every non-merged line — `blocked`/`escalated`,
 * the outcomes an operator who stepped away actually needs to see — carries a
 * {@link consoleCardUrl} deep link to that task's card; a `merged` line stays a bare
 * confirmation, since there is nothing to act on. Mirrors `renderRundown`'s own
 * "(no tasks attempted)" empty-state text so the two views never disagree on shape.
 */
export function renderRundownPush(lines: RundownLine[], consoleBaseUrl: string): string {
  const body =
    lines.length === 0
      ? ["(no tasks attempted)"]
      : lines.map((l) => {
          if (l.outcome === "merged") return `merged     : ${l.taskId}`;
          const link = consoleCardUrl(consoleBaseUrl, l.taskId);
          if (l.outcome === "escalated") return `escalated  : ${l.taskId} — [${l.escalation!.class}] ${l.escalation!.issueUrl} — ${link}`;
          return `blocked    : ${l.taskId}${l.detail ? ` — ${l.detail}` : ""} — ${link}`;
        });
  return ["Remudero drain rundown", ...body].join("\n");
}

/**
 * Deliver a post-drain rundown over the SAME notify channel as {@link sendDigest} and
 * `run-task.ts`'s MANUAL/HARD_STOP escalation pings (grep-provable: this is the ONE call
 * to `notify()` a drain's push runs through, not a second/parallel sender — W1-T144
 * acceptance "a drain rundown emits through the SAME channel, not a second transport").
 */
export function sendRundown(lines: RundownLine[], consoleBaseUrl: string, deps: NotifyDeps): string {
  const text = renderRundownPush(lines, consoleBaseUrl);
  notify(text, deps);
  return text;
}

// ── W1-T163: the digest becomes MARKER-AWARE, sharing lib/last-seen.ts's per-token marker with
// the console recap (lib/recap.ts) — so a pushed digest and a pulled recap, read off the SAME
// token's SAME marker, cover the identical window: "push and pull tell ONE story." ────────────

/** The digest's pre-marker default lookback (unchanged from before this feature existed) — used
 *  ONLY the very first time a token is seen, so a first-ever digest for a token still reports
 *  the last day rather than the entire ledger's history. Every later call reads that token's
 *  OWN previously-advanced marker instead. */
export function defaultDigestSinceIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
}

/** The `sinceIso` a marker-aware digest for `tokenId` would use RIGHT NOW, without advancing
 *  anything — the same value {@link buildMarkerAwareDigest}/{@link sendMarkerAwareDigest} resolve
 *  internally, exposed so a caller (e.g. a `--dry-run` preview) can show it explicitly. */
export function resolveMarkerAwareSince(store: LastSeenStore, tokenId: string, nowIso: string): string {
  return store.get(tokenId) ?? defaultDigestSinceIso(nowIso);
}

/**
 * Build (never send, never advance the marker) the digest text for `tokenId` off its CURRENT
 * marker — a read-only preview, exactly like `buildDigest` but marker-aware instead of taking an
 * explicit `sinceIso`. Used by `rmd digest --dry-run` so a preview never mutates state.
 */
export function buildMarkerAwareDigest(
  ledgerPath: string,
  store: LastSeenStore,
  tokenId: string,
  nowIso: string,
  consoleBaseUrl?: string,
): { text: string; sinceIso: string } {
  const sinceIso = resolveMarkerAwareSince(store, tokenId, nowIso);
  return { text: buildDigest(ledgerPath, sinceIso, consoleBaseUrl), sinceIso };
}

/**
 * Send a marker-aware digest for `tokenId`: read its CURRENT marker (or the pre-marker 24h
 * default on a first-ever send), deliver exactly like {@link sendDigest}, then advance the SAME
 * {@link LastSeenStore} `tokenId` to `nowIso` — the identical store `lib/board.ts`'s `GET
 * /v1/status` advances on a board view (see lib/last-seen.ts's module header). Whichever of the
 * two — a digest send or a board view — happens first moves the marker forward; the other then
 * only ever reports what's left, so the two never double-report or silently skip a window.
 */
export function sendMarkerAwareDigest(
  ledgerPath: string,
  store: LastSeenStore,
  tokenId: string,
  deps: NotifyDeps,
  nowIso: string,
  consoleBaseUrl?: string,
): string {
  const sinceIso = resolveMarkerAwareSince(store, tokenId, nowIso);
  const text = sendDigest(ledgerPath, sinceIso, deps, consoleBaseUrl);
  store.advance(tokenId, nowIso);
  return text;
}
