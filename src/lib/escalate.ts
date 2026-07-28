import { execFileSync } from "node:child_process";
import { appendLedger } from "./ledger.js";

/**
 * Escalations as GitHub issues (W1-T8, MASTER-PLAN §4 "Escalation taxonomy").
 *
 * The loop never waits on a human except for four classes: BLOCKED (post-diagnose,
 * two-strikes exhausted), MANUAL (secrets, repo creation, deploys, eyeball/playtest
 * gates), HARD_STOP (the deterministic hard-stop list — destructive ops, spend
 * beyond cap, force-push, secret handling), and GRILL (an ambiguous feedback item
 * the intake triage cannot decide alone — MASTER-PLAN §7B, W1-T42; reuses this SAME
 * machinery rather than a second one, per the task's own directive). Every one of
 * these opens a `needs-human` labeled issue carrying the OPTIONS available and the
 * machine's RECOMMENDATION, so the issue itself is actionable rather than a bare
 * alert. (DECISION/DIRECTION classes are absorbed elsewhere — auto-choose and
 * idle-groom respectively — and ASYNC-QUESTION deliberately never escalates; see
 * §2/§4. GRILL does not block the loop either — like BLOCKED it collapses to the
 * digest, never a real-time ping — but it IS a needs-human issue, unlike
 * ASYNC-QUESTION, because MASTER-PLAN §7B names this specific case as reusing §4's
 * escalation taxonomy verbatim.)
 */
export type EscalationClass = "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";

/** One choice a human can make to resolve the escalation. */
export interface EscalationOption {
  label: string;
  detail: string;
}

export interface Escalation {
  class: EscalationClass;
  taskId: string;
  runId?: string;
  /** Short human summary; becomes the issue title. */
  summary: string;
  /** Longer context: what happened, why it's stuck, relevant links. */
  detail: string;
  /** The choices a human can make — REQUIRED; an escalation with no options is a bare alert. */
  options: EscalationOption[];
  /** Which option the machine recommends (auto-choose doctrine, §4) — must be one of options[].label. */
  recommendation: string;
}

/** One open issue as the reconciler reads it (fb-1784756088300-6a481e). */
export interface OpenIssue {
  number: number;
  url: string;
  title?: string;
  /** Raw body — carries the `**Task:** <id>` line {@link renderIssueBody} writes, which the
   *  escalation-lifecycle reconciler parses to derive the referenced task's current state. */
  body?: string;
}

/** GitHub issue creation, behind an interface so tests never touch the network. */
/**
 * The `gh api repos/<slug>/issues?labels=…` argv every labelled-issue read in this repo uses.
 *
 * WHY REST, NOT `gh issue list --label`: `gh` implements `--label` filtering on issue lists over
 * GitHub's GraphQL `search()` connection. That connection is throttled account-wide here, so the
 * `--label` form failed 100% of the time — `board_gateway.issue_fetch_ok` never once appeared in
 * the ledger against 505 failures, and the escalation reconciler read an empty list every tick
 * while 79 needs-human issues sat open. REST's `/issues` endpoint answers the same question off
 * the deterministic list API, with no search connection involved.
 *
 * `--slurp` (NOT bare `--paginate`) is load-bearing: `--paginate` alone concatenates one JSON
 * array per page, which `JSON.parse` rejects outright — and the `state=all` read is genuinely
 * multi-page (223 rows over 3 pages when this landed). `--slurp` wraps the pages in one outer
 * array that parses cleanly; {@link parseLabelledIssuesRest} flattens it.
 */
export function labelledIssuesRestArgs(repoArg: string, label: string, state: "open" | "all"): string[] {
  const q = `labels=${encodeURIComponent(label)}&state=${state}&per_page=100`;
  return ["api", `repos/${repoArg}/issues?${q}`, "--paginate", "--slurp"];
}

/** An {@link OpenIssue} plus the `state` field the BATCHED board gateway's own consumer needs
 *  (`state=all` there, so open-vs-closed is the whole question). Superset of both consumer
 *  shapes, so one parse serves the reconciler AND the board gateway. */
export interface LabelledIssue extends OpenIssue {
  /** Lowercase "open"/"closed" as REST reports it — `resolveEscalation` upper-cases before
   *  comparing, so this coexists with `gh --json state`'s "OPEN"/"CLOSED" unchanged. */
  state: string;
}

/** One row exactly as GitHub's REST `/issues` endpoint returns it — the wire shape, never the
 *  shape any consumer here reads (see {@link parseLabelledIssuesRest} for the translation). */
interface RestIssueRow {
  number: number;
  /** The api.github.com URL. Deliberately DROPPED — see parseLabelledIssuesRest. */
  url: string;
  /** The github.com WEB url — what escalate.ts writes into the ledger and consumers match on. */
  html_url: string;
  /** Lowercase "open"/"closed" (REST), where `gh --json state` reports "OPEN"/"CLOSED". */
  state: string;
  title?: string;
  body?: string;
  /** Present ONLY on pull requests: REST's `/issues` returns PRs alongside issues. */
  pull_request?: unknown;
}

/**
 * Flatten `--slurp`'s pages, drop pull requests, and translate the wire shape to the one every
 * consumer reads. THROWS on malformed input (the callers treat a failed read as "do nothing this
 * cycle", never as a confirmed "zero open") — never returns [] to paper over a broken payload.
 *
 * TWO translations are load-bearing:
 *  1. `url` is taken from REST's `html_url`, NOT its `url`. Consumers match against the web URLs
 *     {@link renderIssueBody}/escalate write into the ledger; surfacing api.github.com would make
 *     every lookup miss SILENTLY, a fail-open that reads as "escalation not found".
 *  2. Rows carrying `pull_request` are dropped. REST's `/issues` returns PRs too, and an
 *     escalation is always an issue.
 */
export function parseLabelledIssuesRest(raw: string): LabelledIssue[] {
  const parsed = JSON.parse(raw) as unknown;
  // `--slurp` yields pages-of-rows; tolerate a bare single page so a fixture (or a future gh
  // that stops wrapping) is read correctly rather than silently as zero rows.
  const pages: RestIssueRow[][] = Array.isArray(parsed)
    ? (parsed as unknown[]).every((p) => Array.isArray(p))
      ? (parsed as RestIssueRow[][])
      : [parsed as RestIssueRow[]]
    : [];
  return pages
    .flat()
    .filter((i) => i?.pull_request === undefined)
    .map((i) => ({ number: i.number, url: i.html_url, state: i.state, title: i.title, body: i.body }));
}

export interface IssueGateway {
  /** Create a labeled issue; returns its URL. */
  create(title: string, body: string, labels: string[]): string;
  /**
   * List OPEN issues carrying `label` (fb-1784756088300-6a481e — the escalation-lifecycle
   * reconciler's read side): the queue of live needs-human issues whose referenced task the
   * reconciler re-derives each sweep. THROWS on a `gh` read failure (never returns [] on an
   * outage — the caller treats a failed read as "do nothing this cycle", never "zero open").
   * Optional so create-only fakes keep working unchanged; a gateway omitting it yields no
   * reconciler candidates at all.
   */
  listOpen?(label: string): OpenIssue[];
  /**
   * Close one issue, posting `comment` as the closing citation (fb-1784756088300-6a481e). Used
   * ONLY by the reconciler when a referenced task has resolved — the comment names the resolver
   * (the merged PR) so the closure is legible, never a silent disappearance. Optional, same
   * fail-soft discipline as {@link ensureLabel}.
   */
  closeWithComment?(url: string, comment: string): void;
  /**
   * Ensure ONE label exists on the repo (create-if-missing, tolerate-already-exists).
   * Returns true when the label is now safe to attach, false when provisioning itself
   * failed. Optional: a gateway that omits this is treated as "every label already
   * exists" (today's `create()`-only fakes keep working unchanged).
   *
   * LIVE INCIDENT (2026-07-17, W1-T99): the first BLOCKED-class escalation ever fired
   * called `gh issue create --label escalation-blocked`, and the label had never been
   * provisioned on the repo — `gh` failed the WHOLE create outright, so the rendered
   * clarification question was generated and then lost, and the throw propagated
   * through `runSweep` and killed the reconciler for every other open PR. Provisioning
   * is the transport's job, never the operator's memory — see `escalate()`'s
   * ENSURE-LABELS step below, which calls this before every `create()`.
   */
  ensureLabel?(label: string): boolean;
}

/** Per-class label, alongside the blanket `needs-human` queue label. */
const CLASS_LABEL: Record<EscalationClass, string> = {
  BLOCKED: "escalation-blocked",
  MANUAL: "escalation-manual",
  HARD_STOP: "escalation-hard-stop",
  GRILL: "escalation-grill",
};

/** The label every escalation issue carries — the queue the control panel reads (§4). */
export const NEEDS_HUMAN_LABEL = "needs-human";

/** Render the issue body: context, the options, and the recommendation called out. */
export function renderIssueBody(e: Escalation): string {
  const lines = [
    `**Class:** ${e.class}`,
    `**Task:** ${e.taskId}`,
    e.runId ? `**Run:** ${e.runId}` : undefined,
    "",
    e.detail,
    "",
    "## Options",
    ...e.options.map((o) => `- **${o.label}** — ${o.detail}`),
    "",
    "## Recommendation",
    e.recommendation,
    "",
    "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
    "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

export interface EscalateDeps {
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
}

/**
 * Open a labeled GitHub issue for one escalation + log the ledger line. Returns the
 * issue URL. An escalation with zero options is refused — bare alerts with no
 * actionable choice are exactly what this taxonomy exists to avoid (§4).
 *
 * ENSURE-LABELS, DEGRADE DON'T LOSE (W1-T99): every wanted label is passed through
 * `deps.issues.ensureLabel` first (a gateway lacking that method is treated as
 * "already exists"). A label whose provisioning fails is DROPPED from the `create()`
 * call rather than taking the whole issue down with it — the payload (the options +
 * recommendation a human needs to act on) outranks its label decoration. The drop is
 * never silent: it's noted both in the issue body and on this escalation's ledger
 * line as `degraded_labels`.
 */
export function escalate(e: Escalation, deps: EscalateDeps): string {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  const title = `[${e.class}] ${e.taskId}: ${e.summary}`;
  const wanted = [NEEDS_HUMAN_LABEL, CLASS_LABEL[e.class]];
  const labels: string[] = [];
  const degradedLabels: string[] = [];
  for (const label of wanted) {
    if (!deps.issues.ensureLabel || deps.issues.ensureLabel(label)) {
      labels.push(label);
    } else {
      degradedLabels.push(label);
    }
  }
  let body = renderIssueBody(e);
  if (degradedLabels.length > 0) {
    body +=
      `\n\n_Degraded: label(s) ${degradedLabels.join(", ")} could not be provisioned on this repo — ` +
      `this issue was opened without them so the escalation itself is never lost (W1-T99)._`;
  }
  const url = deps.issues.create(title, body, labels);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    ...(degradedLabels.length > 0 ? { degraded_labels: degradedLabels } : {}),
    step: "escalation.issue_opened",
    class: e.class,
    issue_url: url,
    labels,
  });
  return url;
}

/**
 * NON-THROWING escalation, for callers inside a SUPERVISED LOOP.
 *
 * `escalate()` reaches GitHub through `gh issue create` via execFileSync, which throws on any
 * nonzero exit — a rate-limit, an expired token, a network partition. That contract is right for
 * a one-shot command (a failed escalation should fail the run loudly), and wrong inside
 * `rmd daemon`'s `for(;;)`, where the throw is not contained: an uncaught escalation ends the
 * PROCESS, launchd's KeepAlive{SuccessfulExit:false} reads the nonzero exit as a crash and
 * relaunches, the fresh process re-selects the same circuit-broken task, escalates, and throws
 * again. Observed 2026-07-21 04:02-04:13 as one boot per minute (460 `daemon.boot` lines since
 * Jul 19) — the SECOND boot-loop cause, distinct from W1-T197's headroom exit-1 loop, and NOT
 * headroom: that window is post-reset.
 *
 * Returns the issue URL, or `null` when the escalation could not be delivered. Never throws.
 * A failure is recorded on its own `escalation.failed` ledger step, so an undelivered
 * escalation is degraded and legible rather than silent.
 *
 * NOTE: this also catches `escalate()`'s zero-options programming error. That is deliberate —
 * inside a supervised loop even a bug in the escalation payload must not take the fleet down;
 * the `escalation.failed` line carries the message.
 */
export function tryEscalate(e: Escalation, deps: EscalateDeps): string | null {
  try {
    return escalate(e, deps);
  } catch (err) {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: e.taskId,
      step: "escalation.failed",
      class: e.class,
      error: String((err as Error)?.message ?? err),
    });
    return null;
  }
}

/**
 * Real gateway: `gh issue create`, scoped to `owner/repo`. Runs outside the sandbox
 * (gh is documented to fail TLS verification under Seatbelt, §4A) but still inside
 * bypass + the deny-hook floor, carrying only the scoped PAT.
 *
 * `ensureLabel` provisions the label via `gh label create ... --force` (create-or-update,
 * so an existing label is a no-op rather than an error — the "tolerate-exists" half of
 * W1-T99's design) BEFORE `create()` is ever asked to attach it. A hard failure (no repo
 * access, rate-limited, network partition) returns false so `escalate()` degrades that one
 * label instead of losing the whole issue to it — the 2026-07-17 incident this task fixes.
 *
 * `opts.exec` (mirrors {@link ghGateway} in status.ts, W1-T119) is an INJECTABLE stand-in
 * for the raw `gh` invocation — real callers omit it and get the actual
 * `execFileSync("gh", args, ...)` call; unit tests inject a fake that returns a canned
 * string or throws, so both `ensureLabel`'s tolerate-failure branch and `create`'s URL
 * plumbing are exercised deterministically WITHOUT shelling out.
 */
export function ghIssueGateway(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => string } = {},
): IssueGateway {
  const repoArg = `${owner}/${repo}`;
  const run =
    opts.exec ??
    ((args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  return {
    ensureLabel(label) {
      try {
        run(["label", "create", label, "--repo", repoArg, "--color", "ededed", "--force"]);
        return true;
      } catch {
        return false;
      }
    },
    create(title, body, labels) {
      const args = ["issue", "create", "--repo", repoArg, "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      return run(args).trim();
    },
    listOpen(label) {
      // OPEN issues only, with body (carries `**Task:** <id>`). Read over REST's `/issues`
      // endpoint, NOT `gh issue list --label`: the latter routes label filtering through
      // GitHub's GraphQL `search()` connection, which is throttled account-wide here and made
      // this read fail 100% of the time (the reconciler saw "zero open" every tick while 79
      // needs-human issues were open). The pre-REST comment here claimed this was "never a
      // full-text search" — it was, via `gh`'s own implementation; that is now literally true.
      // THROWS on a `gh` failure (the caller degrades to no action this cycle, never "zero open").
      return parseLabelledIssuesRest(run(labelledIssuesRestArgs(repoArg, label, "open")));
    },
    closeWithComment(url, comment) {
      run(["issue", "close", url, "--repo", repoArg, "--comment", comment]);
    },
  };
}
