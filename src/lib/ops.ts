import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { appendLedger } from "./ledger.js";
import { escalate, type Escalation, type IssueGateway } from "./escalate.js";
import { readLedgerLines } from "./status.js";
import { captureFeedback, feedbackEntryPath, type FeedbackEntry } from "./feedback.js";

/**
 * Alert intake v0+v1 (W1-T55 / W1-T56, MASTER-PLAN §5D lane 2, §7B).
 *
 * "Provisioning scanners (W1-T23) is one-time; RESPONDING to their alerts is
 * continuous and did not exist." This module is the response loop's read side:
 * it polls code-scanning, Dependabot, and secret-scanning alerts for THIS repo
 * (v0 scope — a single managed repo, resolved by the caller via
 * resolveOwnerRepo(); a multi-repo "managed repo set" is explicitly deferred,
 * see the decision note in the PR that shipped this), folds them into the
 * counts+ages block the daily digest renders (digest.ts), and opens exactly
 * ONE `needs-human` escalation (the SHIPPED escalate() path, lib/escalate.ts)
 * per alert that is BOTH new (never escalated before) AND critical/high.
 *
 * v1 (W1-T56, §7B): "an alert is MACHINE-ORIGIN FEEDBACK — it flows through
 * the §7B inbox, not a parallel loop." SURFACING (v0) becomes ACTING — the
 * SAME poll that already fetches every open alert now ALSO writes a
 * `plan/feedback/<id>.yaml` entry (origin: `alert#<source>-<id>`, ANY
 * severity, not just critical/high) for each open alert not already
 * captured, so `rmd triage` (W1-T41) can ground it and propose a corrective
 * task citing the alert id. One fetch, one dedup key ({@link alertTaskId}),
 * two effects (escalate the criticals, capture everything) — deliberately
 * NOT a second poller re-hitting the same three `gh api` endpoints.
 *
 * SCOPE FENCE (P20, MASTER-PLAN.md:466 — "the alert loop reviews and triages
 * but never fixes without a human per alert"): this module only reads GitHub,
 * opens issues, and writes `plan/feedback/` entries. It never dismisses an
 * alert, never opens a fix PR itself, and never edits the repo. Turning a
 * feedback entry into a corrective task is `rmd triage` (W1-T41, already
 * shipped and origin-agnostic); auto-fixing under a ratified policy is
 * W1-T90 — both explicitly out of scope here.
 *
 * DEDUP (mirrors sweep.ts's ledger-keyed idempotence, W1-T77): a re-poll of
 * the SAME open alerts must escalate NOTHING new AND capture NOTHING new.
 * Escalation dedup reuses the ledger escalate() ALREADY writes — every
 * escalation.issue_opened line's task_id IS the alert's dedup key
 * ({@link alertTaskId}). Feedback-capture dedup mirrors issues-intake.ts's
 * discipline instead: each alert's feedback id is DETERMINISTIC
 * ({@link alertFeedbackId}), so `existsSync` on that one path IS the dedup
 * check — no second store, no ledger read needed for this half.
 *
 * All GitHub reads go through `gh api` (never Octokit, matching every other
 * gateway in this repo — status.ts, trace.ts, escalate.ts) and are FAIL-SOFT:
 * a disabled scanner, an unprivileged token, or `gh` itself being absent
 * degrades that one source to zero alerts rather than crashing the poll.
 */

// ── Alerts, normalized across the three GitHub alert APIs ──────────────────

export type AlertSource = "code-scanning" | "dependabot" | "secret-scanning";

/** low < medium < high < critical, the same total order risk-score.ts's RiskBand uses. */
export type AlertSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export const ALERT_SOURCES: readonly AlertSource[] = ["code-scanning", "dependabot", "secret-scanning"];

/** One alert, normalized to the shape this module reasons over regardless of its source API. */
export interface RawAlert {
  source: AlertSource;
  /** The source API's own alert `number`, stringified — unique WITHIN a source, not across. */
  id: string;
  severity: AlertSeverity;
  /** Raw GitHub state string ("open" is the only one this module treats as active). */
  state: string;
  createdAt: string;
  /** Short one-line description — becomes the escalation issue's summary/title. */
  summary: string;
  /** html_url — the human-facing link into GitHub's own alert UI. */
  url: string;
}

/** `${source}-${id}` — the escalation taskId AND the dedup key ({@link alertTaskId}). */
export function alertTaskId(alert: Pick<RawAlert, "source" | "id">): string {
  return `alert-${alert.source}-${alert.id}`;
}

/** `${source}-${id}` — the `alert#<...>` feedback origin's payload (W1-T56). */
export function alertOriginId(alert: Pick<RawAlert, "source" | "id">): string {
  return `${alert.source}-${alert.id}`;
}

/**
 * `fb-alert-<owner>-<repo>-<source>-<id>` — the feedback entry's id AND the dedup key
 * (mirrors issues-intake.ts's `issueFeedbackId`). Owner/repo are slugged (lowercased,
 * non-alnum collapsed to `-`) so the id is a safe filename regardless of what characters
 * GitHub allows in an org/repo name; source+id are already filename-safe.
 */
export function alertFeedbackId(owner: string, repo: string, alert: Pick<RawAlert, "source" | "id">): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `fb-alert-${slug(owner)}-${slug(repo)}-${alertOriginId(alert)}`;
}

/** One `plan/feedback/<id>.yaml` `raw` body per alert (mirrors issues-intake.ts's `renderIssueRaw`). */
export function renderAlertRaw(owner: string, repo: string, alert: RawAlert): string {
  return `${owner}/${repo} ${alert.source} alert #${alert.id} [${alert.severity}]: ${alert.summary}\n\n${alert.url}`.trim();
}

// ── Normalizers: GitHub's three alert-list response shapes → RawAlert ──────

interface GhCodeScanningAlertJson {
  number?: number;
  state?: string;
  created_at?: string;
  html_url?: string;
  rule?: { id?: string; description?: string; security_severity_level?: string; severity?: string };
}

/**
 * `rule.security_severity_level` is CodeQL's own critical/high/medium/low band
 * (present whenever a security query produced the alert). Third-party SARIF
 * uploads don't always set it — degrade to `rule.severity` (error/warning/note,
 * SARIF's own scale), and only fall to "unknown" when neither is present. Never
 * invented past what the API actually reported.
 */
export function normalizeCodeScanningAlert(raw: GhCodeScanningAlertJson): RawAlert {
  const explicit = raw.rule?.security_severity_level?.toLowerCase();
  const severity: AlertSeverity =
    explicit === "critical" || explicit === "high" || explicit === "medium" || explicit === "low"
      ? explicit
      : raw.rule?.severity === "error"
        ? "high"
        : raw.rule?.severity === "warning"
          ? "medium"
          : raw.rule?.severity === "note" || raw.rule?.severity === "recommendation"
            ? "low"
            : "unknown";
  return {
    source: "code-scanning",
    id: String(raw.number ?? "?"),
    severity,
    state: raw.state ?? "unknown",
    createdAt: raw.created_at ?? "",
    summary: raw.rule?.description ?? raw.rule?.id ?? "code-scanning alert",
    url: raw.html_url ?? "",
  };
}

interface GhDependabotAlertJson {
  number?: number;
  state?: string;
  created_at?: string;
  html_url?: string;
  security_advisory?: { severity?: string; summary?: string };
  dependency?: { package?: { name?: string } };
}

/** Dependabot's own severity scale spells the third tier "moderate", not "medium" — normalized here. */
export function normalizeDependabotAlert(raw: GhDependabotAlertJson): RawAlert {
  const s = raw.security_advisory?.severity?.toLowerCase();
  const severity: AlertSeverity =
    s === "critical" || s === "high" || s === "low" ? s : s === "moderate" ? "medium" : "unknown";
  const pkg = raw.dependency?.package?.name;
  return {
    source: "dependabot",
    id: String(raw.number ?? "?"),
    severity,
    state: raw.state ?? "unknown",
    createdAt: raw.created_at ?? "",
    summary: raw.security_advisory?.summary ?? (pkg ? `vulnerable dependency: ${pkg}` : "dependabot alert"),
    url: raw.html_url ?? "",
  };
}

interface GhSecretScanningAlertJson {
  number?: number;
  state?: string;
  created_at?: string;
  html_url?: string;
  secret_type_display_name?: string;
  secret_type?: string;
}

/**
 * Secret-scanning alerts carry NO severity field — GitHub's API does not band
 * them. A live leaked credential is definitionally critical regardless of
 * which secret type matched, so severity is a deliberately ASSIGNED policy
 * constant here, not inferred or defaulted-to-unknown like the other two
 * normalizers' missing-data cases.
 */
export function normalizeSecretScanningAlert(raw: GhSecretScanningAlertJson): RawAlert {
  return {
    source: "secret-scanning",
    id: String(raw.number ?? "?"),
    severity: "critical",
    state: raw.state ?? "unknown",
    createdAt: raw.created_at ?? "",
    summary: raw.secret_type_display_name ?? raw.secret_type ?? "secret-scanning alert",
    url: raw.html_url ?? "",
  };
}

// ── Gateway: `gh api`, fail-soft per source (a disabled scanner ⇒ zero alerts) ──

export interface AlertGateway {
  codeScanning(owner: string, repo: string): RawAlert[];
  dependabot(owner: string, repo: string): RawAlert[];
  secretScanning(owner: string, repo: string): RawAlert[];
}

/**
 * Real gateway: `gh api repos/<owner>/<repo>/<kind>/alerts --paginate`, scoped to
 * `owner/repo` (the v0 single-repo target). `--paginate` is `gh`'s own flag for
 * merging every page of a list endpoint into one JSON array — no separate
 * page-loop here, and no silent truncation past page 1. Each source's `gh`
 * call is wrapped independently so ONE disabled/forbidden scanner (a 404/403,
 * or `gh` erroring for any other reason) degrades only that source to `[]`,
 * mirroring status.ts's `ghRequiredStatusCheckContexts` fail-soft discipline —
 * never throws, never crashes the other two sources' reads.
 */
export function ghAlertGateway(): AlertGateway {
  function tryList<T>(args: string[]): T[] {
    try {
      const raw = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return {
    codeScanning(owner, repo) {
      return tryList<GhCodeScanningAlertJson>([
        "api",
        `repos/${owner}/${repo}/code-scanning/alerts`,
        "--paginate",
      ]).map(normalizeCodeScanningAlert);
    },
    dependabot(owner, repo) {
      return tryList<GhDependabotAlertJson>([
        "api",
        `repos/${owner}/${repo}/dependabot/alerts`,
        "--paginate",
      ]).map(normalizeDependabotAlert);
    },
    secretScanning(owner, repo) {
      return tryList<GhSecretScanningAlertJson>([
        "api",
        `repos/${owner}/${repo}/secret-scanning/alerts`,
        "--paginate",
      ]).map(normalizeSecretScanningAlert);
    },
  };
}

// ── The digest's counts+ages block — pure over a fetched alert list ────────

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

const ZERO_SEVERITY_COUNTS = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

export interface SourceAlertSummary {
  counts: SeverityCounts;
  total: number;
  /** Oldest OPEN alert's age in days for this source; undefined when total === 0. */
  oldestOpenAgeDays?: number;
}

export interface AlertsPollSummary {
  /** When this poll ran — the digest shows the LATEST such snapshot inside its window. */
  polledAt: string;
  bySource: Record<AlertSource, SourceAlertSummary>;
  totalOpen: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Fold a fetched (any-state) alert list into the digest's counts+ages block —
 * PURE and deterministic given `now`. Filters to OPEN alerts only ("open" is
 * the one active state shared verbatim across all three GitHub alert APIs;
 * code-scanning/dependabot's other terminal states vary, secret-scanning's is
 * "resolved" not "closed" — filtering strictly on `state === "open"` is
 * correct across all three without needing a per-source terminal-state map).
 */
export function summarizeAlerts(alerts: RawAlert[], now: number = Date.now()): AlertsPollSummary {
  const bySource = Object.fromEntries(
    ALERT_SOURCES.map((s) => [s, { counts: ZERO_SEVERITY_COUNTS(), total: 0, oldestOpenAgeDays: undefined }]),
  ) as Record<AlertSource, SourceAlertSummary>;

  let totalOpen = 0;
  for (const a of alerts) {
    if (a.state !== "open") continue;
    const bucket = bySource[a.source];
    bucket.counts[a.severity]++;
    bucket.total++;
    totalOpen++;
    const created = Date.parse(a.createdAt);
    if (!Number.isNaN(created)) {
      const ageDays = (now - created) / MS_PER_DAY;
      bucket.oldestOpenAgeDays = bucket.oldestOpenAgeDays === undefined ? ageDays : Math.max(bucket.oldestOpenAgeDays, ageDays);
    }
  }
  return { polledAt: new Date(now).toISOString(), bySource, totalOpen };
}

/** One-line-per-source render of an {@link AlertsPollSummary} — what the digest prints. */
export function renderAlertsSummary(s: AlertsPollSummary): string {
  return ALERT_SOURCES.map((src) => {
    const b = s.bySource[src];
    if (b.total === 0) return `${src} (none open)`;
    const bands = (["critical", "high", "medium", "low", "unknown"] as const)
      .filter((sev) => b.counts[sev] > 0)
      .map((sev) => `${b.counts[sev]} ${sev}`)
      .join(", ");
    const age = b.oldestOpenAgeDays !== undefined ? ` (oldest ${Math.floor(b.oldestOpenAgeDays)}d)` : "";
    return `${src} ${bands}${age}`;
  }).join("; ");
}

// ── New-critical detection + escalation, deduped against the ledger ────────

/**
 * Open, critical/high-severity alerts NOT already escalated. Dedup key is
 * {@link alertTaskId} against `priorEscalatedTaskIds` — the SET of every
 * `escalation.issue_opened` ledger line's task_id a caller has already read
 * (any class, any source; see {@link priorEscalatedAlertIds}). PURE — takes
 * the prior-escalated set as data, never reads the ledger itself.
 */
export function newCriticalAlerts(alerts: RawAlert[], priorEscalatedTaskIds: ReadonlySet<string>): RawAlert[] {
  return alerts.filter(
    (a) =>
      a.state === "open" &&
      (a.severity === "critical" || a.severity === "high") &&
      !priorEscalatedTaskIds.has(alertTaskId(a)),
  );
}

/** Every alert taskId the ledger already recorded an `escalation.issue_opened` line for. */
export function priorEscalatedAlertIds(lines: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string") ids.add(l.task_id);
  }
  return ids;
}

/**
 * Build the {@link Escalation} for one new critical/high alert — class MANUAL
 * (mirrors dep-review.ts's major-bump escalation: needs a human, this loop
 * never fixes it itself, P20's scope fence). `taskId` is {@link alertTaskId},
 * so escalate()'s own ledger line becomes next poll's dedup entry with no
 * separate bookkeeping.
 */
export function buildAlertEscalation(alert: RawAlert): Escalation {
  return {
    class: "MANUAL",
    taskId: alertTaskId(alert),
    summary: `new ${alert.severity} ${alert.source} alert: ${alert.summary}`,
    detail: [
      `GitHub opened ${alert.source} alert #${alert.id} (severity: ${alert.severity}, created ${alert.createdAt}).`,
      alert.url ? `Alert: ${alert.url}` : undefined,
      ``,
      alert.summary,
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n"),
    options: [
      { label: "fix", detail: `address the underlying issue (${alert.source} alert #${alert.id}) and let GitHub close it` },
      {
        label: "dismiss",
        detail: `dismiss the alert on GitHub with a stated reason (false positive / acceptable risk / won't fix) — this loop never dismisses alerts itself`,
      },
    ],
    recommendation: "fix",
  };
}

// ── The poll entry point: fetch → summarize → escalate new criticals ───────

export interface OpsPollDeps {
  alerts: AlertGateway;
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
  /** Repo root `plan/feedback/` is written under — the harness's OWN checked-out repo (W1-T56). */
  root: string;
  /** Injectable ledger reader (dedup source); defaults to readLedgerLines. */
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  now?: () => number;
  /** Preview only: fetch + summarize, escalate/capture/ledger NOTHING. Mirrors sweep.ts's --dry-run. */
  dryRun?: boolean;
}

export interface OpsPollResult {
  summary: AlertsPollSummary;
  /** New critical/high alerts this poll found (dedup already applied) — populated even under --dry-run, as a preview. */
  newCritical: RawAlert[];
  /** Alerts actually escalated this poll — always `[]` under --dry-run (no effects, no ledger line). */
  escalated: Array<{ alert: RawAlert; issueUrl: string }>;
  /**
   * `plan/feedback/` entries created this poll (origin: `alert#<source>-<id>`), ONE per open
   * alert not already captured, ANY severity — W1-T56. Always `[]` under --dry-run.
   */
  feedbackCreated: FeedbackEntry[];
}

/**
 * Fetch all three alert sources for `owner/repo`, fold them into the digest block, escalate
 * every NEW critical/high alert exactly once (v0, W1-T55), and capture a `plan/feedback/` entry
 * (origin: `alert#<source>-<id>`) for every open alert not already captured, ANY severity (v1,
 * W1-T56) — one `rmd triage` inbox for the whole alert stream, not just the escalated slice.
 * Ledgers ONE `ops.alerts_polled` line (digest.ts reads the latest such line inside its window)
 * carrying the full {@link AlertsPollSummary} plus counts of both effects — skipped under
 * `dryRun`, matching sweep.ts's "a preview must leave no trace" discipline (a real poll
 * afterward must still act, and must not see a phantom dedup entry from a preview that never
 * actually escalated/captured).
 */
export async function pollAlerts(owner: string, repo: string, deps: OpsPollDeps): Promise<OpsPollResult> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const now = deps.now ? deps.now() : Date.now();

  const open = [
    ...deps.alerts.codeScanning(owner, repo),
    ...deps.alerts.dependabot(owner, repo),
    ...deps.alerts.secretScanning(owner, repo),
  ].filter((a) => a.state === "open");

  const summary = summarizeAlerts(open, now);
  const prior = priorEscalatedAlertIds(readLedger(deps.ledgerPath));
  const newCritical = newCriticalAlerts(open, prior);

  const escalated: Array<{ alert: RawAlert; issueUrl: string }> = [];
  const feedbackCreated: FeedbackEntry[] = [];
  if (!deps.dryRun) {
    for (const alert of newCritical) {
      const issueUrl = escalate(buildAlertEscalation(alert), {
        issues: deps.issues,
        ledgerPath: deps.ledgerPath,
        runId: deps.runId,
      });
      escalated.push({ alert, issueUrl });
    }
    for (const alert of open) {
      const id = alertFeedbackId(owner, repo, alert);
      if (existsSync(feedbackEntryPath(deps.root, id))) continue;
      feedbackCreated.push(
        captureFeedback(deps.root, {
          id,
          raw: renderAlertRaw(owner, repo, alert),
          origin: `alert#${alertOriginId(alert)}`,
        }),
      );
    }
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: "OPS",
      step: "ops.alerts_polled",
      owner,
      repo,
      alerts: summary,
      new_critical_count: newCritical.length,
      feedback_created: feedbackCreated.length,
    });
  }

  return { summary, newCritical, escalated, feedbackCreated };
}
