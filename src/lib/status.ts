import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plan, Task, TaskStatus } from "./plan.js";

/**
 * Derived task status (MASTER-PLAN v2.1 decision, implemented here).
 *
 * Task merge-state is DERIVED FROM GITHUB, never written back to plan/tasks.yaml.
 * A YAML round-trip destroys comments, status commits spam a public repo, and a
 * machine writer racing a human editor is a conflict class we simply do not have.
 * The `status:` field in tasks.yaml is therefore DECORATIVE (initial-state only);
 * the truth of whether a task landed is computed on demand from GitHub, in a
 * fixed precedence, and cached to a machine-owned projection (state/status.json).
 *
 * Precedence for a task id — an operator correction is checked FIRST and is
 * SUPREME (MASTER-PLAN P9 / W1-T75): it is DECLARED ground truth, not inferred
 * evidence, so it outranks every rung below rather than being read only inside
 * rung (c). Then, absent a correction:
 *   (a) state/ledger.ndjson `pr.opened` line for this task -> query that PR's state;
 *   (b) an explicit `pr:` field in tasks.yaml (tasks executed by hand, pre-ledger);
 *   (c) a merged PR whose body carries the trailer `Remudero-Task: <id>` —
 *       ownership-asserted (its head branch must be this task's own `run-<id>-*`),
 *       anchor-verified (the trailer must be an exact line, not a fuzzy search
 *       hit), and correction-aware (a `correction.provenance` line debunking this
 *       exact credit is honored) — MASTER-PLAN P16 / W1-T69, the "W1-T20c
 *       false-credit" class: deriveStatus GATES DISPATCH, so a bad credit here
 *       is worse than the same class W1-T51 fixed in the retro gather.
 * First source that resolves a PR wins. If none resolve, the task is not merged.
 *
 * NOTHING in this module writes tasks.yaml. It reads the plan and the ledger and
 * queries GitHub; the only file it writes is the status.json cache.
 */

/** The three precedence sources, plus `none` when GitHub has no evidence. */
export type StatusSource = "ledger" | "pr-field" | "trailer" | "correction" | "none";

/** A PR's identity + GitHub merge state, as seen by the {@link GitHub} gateway. */
export interface PrRef {
  number: number;
  url: string;
  /** GitHub PR state: "MERGED" | "OPEN" | "CLOSED". */
  state: string;
}

/** One task's projected merge-state, derived from GitHub (never from yaml). */
export interface StatusProjection {
  taskId: string;
  /** Derived status label in the plan's vocabulary. */
  status: TaskStatus;
  /** The single fact dependency-gating cares about: has this task landed? */
  merged: boolean;
  /** Which precedence source resolved it (or `none`). */
  source: StatusSource;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  /**
   * LEGIBILITY (P16 / W1-T69): trailer search hits that were REJECTED by rung (c)'s
   * ownership-assert / anchored-trailer verify, each with a machine-readable reason.
   * A false trailer in the wild is thereby VISIBLE, not silently dropped — the same
   * "surface the rejection" discipline the W1-T20c false-credit reproduction motivated.
   * Present (and non-empty) ONLY when a candidate was actually rejected.
   */
  rejected_candidates?: Array<{ pr: string; reason: string }>;
}

/**
 * The GitHub queries deriveStatus needs, behind an interface so unit tests can
 * inject fixtures for all three precedence sources without touching the network.
 */
export interface GitHub {
  /** Resolve a PR by number or url within the gateway's repo. null if absent. */
  prByRef(ref: string | number): PrRef | null;
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): PrRef | null;
  /**
   * The PR's head branch name, or undefined if it cannot be resolved. Backs
   * rung (c)'s ownership-assert (MASTER-PLAN P16 / W1-T69) — mirrors
   * run-task.ts's `PrHeadGateway` and retro.ts's `ShippedGithub.headRefName`.
   */
  headRefName(prUrl: string): string | undefined;
  /**
   * The PR's raw body text, or undefined if it cannot be resolved. Backs rung
   * (c)'s anchored-trailer verify (P16 / W1-T69): GitHub's body search is a
   * fuzzy full-text match, so a candidate must be re-checked locally for the
   * EXACT `Remudero-Task: <id>` line before it may be credited.
   */
  prBody(prUrl: string): string | undefined;
}

/** Reader for the append-only ledger; injectable for tests. */
export type LedgerReader = (path: string) => Array<Record<string, unknown>>;

export interface DeriveDeps {
  /** Absolute path to state/ledger.ndjson (source (a)). */
  ledgerPath: string;
  /** GitHub gateway scoped to the task's repo. */
  github: GitHub;
  /** Ledger reader; defaults to reading + parsing NDJSON from disk. */
  readLedger?: LedgerReader;
}

/** Default NDJSON ledger reader: one JSON object per non-blank line. */
export function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/** Map a GitHub PR state onto a plan status label + the merged predicate. */
function fromPrState(state: string): { status: TaskStatus; merged: boolean } {
  switch (state.toUpperCase()) {
    case "MERGED":
      return { status: "merged", merged: true };
    case "OPEN":
      return { status: "running", merged: false };
    case "CLOSED":
      return { status: "blocked", merged: false };
    default:
      return { status: "queued", merged: false };
  }
}

/** The most recent `pr.opened` ledger line for a task id, if any. */
function lastPrOpened(
  lines: Array<Record<string, unknown>>,
  taskId: string,
): string | undefined {
  let url: string | undefined;
  for (const line of lines) {
    if (line.step === "pr.opened" && line.task_id === taskId && typeof line.pr_url === "string") {
      url = line.pr_url; // keep scanning: last one wins
    }
  }
  return url;
}

/** Escape a string for literal use inside a `RegExp` (dot/hyphen-safe task ids). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `Remudero-Task: <id>` claimed as false for THIS task by a `correction.provenance`
 * ledger line (P9-iv, a FIRST-CLASS event) — the operator has already established
 * the credit is wrong and deriveStatus must never re-surface it, even if GitHub's
 * search keeps turning it up. Every `claimed_pr_url` named for `taskId` is debunked.
 */
function debunkedTrailerUrls(lines: Array<Record<string, unknown>>, taskId: string): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    if (
      line.step === "correction.provenance" &&
      line.task_id === taskId &&
      typeof line.claimed_pr_url === "string"
    ) {
      out.add(line.claimed_pr_url);
    }
  }
  return out;
}

/**
 * CORRECTIONS WIN, SUPREME (P9-iv / W1-T75, generalizing W1-T69): a `correction.provenance`
 * line is the operator's AUTHORITATIVE override of a mis-attribution — it debunks a
 * `claimed_pr_url` AND names the `actual_pr_url` (the real PR, e.g. #80→#91). deriveStatus
 * credits that actual url directly, checked BEFORE rungs (a)/(b)/(c) — a stale ledger
 * `pr.opened` line or a `pr:` field is no more trustworthy than the fuzzy trailer search
 * this originally only outranked. Crucially the actual PR is NOT re-subjected to the
 * ownership/anchor asserts: the correction is a deliberate human act that SUPERSEDES
 * those automated checks (the real PR is often a hand-authored one from a non-`run-`
 * branch — #91 was a docs PR, #134 a `fix/*` PR). Last correction wins. Returns
 * undefined when the task has no correction.
 */
function latestActualPrUrl(lines: Array<Record<string, unknown>>, taskId: string): string | undefined {
  let url: string | undefined;
  for (const line of lines) {
    if (
      line.step === "correction.provenance" &&
      line.task_id === taskId &&
      typeof line.actual_pr_url === "string"
    ) {
      url = line.actual_pr_url; // keep scanning: last correction wins
    }
  }
  return url;
}

/**
 * RUNG (c) OWNERSHIP-ASSERT (MASTER-PLAN P16 / W1-T69, ratifying the same class
 * W1-T62 fixed on the write side and W1-T51 on the retro read side): a trailer
 * credit is only trustworthy if the PR was opened from THIS task's own branch
 * (`run-<taskId>-<epochMs>`, run-task.ts's naming). A foreign PR that merely
 * mentions the task id in its body — or one whose head ref cannot be resolved —
 * is NOT owned and must never be credited.
 *
 * LOAD-BEARING for the blocked_review FIX RUNG too (W1-T76, absorbs P21): the
 * legit fix workflow amends THIS SAME run branch, never a `fix/*` branch or a
 * fresh PR — creditability here is what lets a fixed task's dependents unblock.
 * Never weaken this assert to accommodate a `fix/*` head.
 */
function ownsBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

/**
 * RUNG (c) ANCHORED-TRAILER VERIFY (P16 / W1-T69): `findMergedByTrailer` is a
 * GitHub full-text body search — fuzzy, tokenized on punctuation, and capable of
 * matching a PR whose trailer actually names a DIFFERENT (e.g. prefix-sharing)
 * task id, the exact "W1-T20c false-credit" class this rung ratifies. The search
 * hit is a first pass only; this is the authoritative local check that the body
 * carries the trailer as its own exact, anchored line.
 */
function hasAnchoredTrailer(body: string | undefined, taskId: string): boolean {
  if (!body) return false;
  return new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m").test(body);
}

/**
 * Derive one task's merge-state from GitHub, in the fixed precedence.
 * Pure over its injected deps — no writes, no tasks.yaml access.
 */
export function deriveStatus(task: Task, deps: DeriveDeps): StatusProjection {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const ledgerLines = readLedger(deps.ledgerPath);

  // SUPREMACY (MASTER-PLAN P9 / W1-T75, ratifying the W1-T20c/#134 stranding): an
  // operator correction is checked FIRST, above rungs (a)/(b)/(c) — not merely
  // inside rung (c) ahead of the trailer search. A correction is DECLARED credit
  // (operator ground truth via the sanctioned `rmd correct` writer), not INFERRED
  // evidence, so it is deliberately EXEMPT from the run-branch ownership-assert
  // (that assert guards rung (c)'s fuzzy trailer search, not a human declaration) —
  // the canonical case is a merged PR on a `fix/*` head (#134), which the assert
  // would otherwise reject, making the un-strand impossible by construction.
  //
  // The un-credit direction (P9-iv): once a correction exists for this task it is
  // authoritative in BOTH directions and deriveStatus never falls through to a
  // stale rung below it — including when the correction's own target PR cannot be
  // resolved (closed/absent/deleted), which derives NOT merged rather than
  // silently re-crediting whatever rung (a)/(b)/(c) would have said.
  const correctedUrl = latestActualPrUrl(ledgerLines, task.id);
  if (correctedUrl) {
    const pr = deps.github.prByRef(correctedUrl);
    if (pr) {
      return { taskId: task.id, source: "correction", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
    return { taskId: task.id, status: "queued", merged: false, source: "correction" };
  }

  // (a) ledger `pr.opened` for this task -> query that PR.
  const openedUrl = lastPrOpened(ledgerLines, task.id);
  if (openedUrl) {
    const pr = deps.github.prByRef(openedUrl);
    if (pr) {
      return { taskId: task.id, source: "ledger", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
  }

  // (b) explicit `pr:` field (hand-executed, pre-ledger).
  if (task.pr !== undefined) {
    const pr = deps.github.prByRef(task.pr);
    if (pr) {
      return { taskId: task.id, source: "pr-field", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
  }

  // (c) a merged PR carrying the `Remudero-Task: <id>` trailer — ownership-
  // asserted, anchor-verified, and correction-aware (MASTER-PLAN P16 / W1-T69).
  // deriveStatus GATES DISPATCH, so a false/foreign credit here is worse than
  // the same attribution class W1-T51 fixed in the retro gather (which only
  // mis-reports); a bad credit here makes the daemon BUILD against an unmet dep.
  const trailerPr = deps.github.findMergedByTrailer(task.id);
  if (trailerPr && !debunkedTrailerUrls(ledgerLines, task.id).has(trailerPr.url)) {
    const head = deps.github.headRefName(trailerPr.url);
    const body = deps.github.prBody(trailerPr.url);
    if (ownsBranch(head, task.id) && hasAnchoredTrailer(body, task.id)) {
      return { taskId: task.id, source: "trailer", ...fromPrState(trailerPr.state), prNumber: trailerPr.number, prUrl: trailerPr.url, prState: trailerPr.state };
    }
    // Rejected: foreign/unresolved head branch or an unanchored search hit — never
    // credited. Surface WHY (legibility, W1-T69): a false trailer in the wild is
    // visible on the projection, not silently dropped. Falls through to "none".
    const reason = !ownsBranch(head, task.id) ? "head-branch-not-owned" : "trailer-not-anchored";
    return {
      taskId: task.id,
      status: "queued",
      merged: false,
      source: "none",
      rejected_candidates: [{ pr: trailerPr.url, reason }],
    };
  }

  // No GitHub evidence: not merged. The yaml `status:` is decorative, not trusted.
  return { taskId: task.id, status: "queued", merged: false, source: "none" };
}

/**
 * Derive every task in a plan and cache the projection to `cachePath`
 * (state/status.json). Returns a taskId -> projection map. Writes ONLY the cache.
 */
export function projectPlan(
  plan: Plan,
  deps: DeriveDeps,
  cachePath?: string,
): Map<string, StatusProjection> {
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) byId.set(task.id, deriveStatus(task, deps));
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    const projection = {
      generated_at: new Date().toISOString(),
      note: "Machine-owned projection derived from GitHub. tasks.yaml is never rewritten.",
      tasks: Object.fromEntries([...byId].map(([id, p]) => [id, p])),
    };
    writeFileSync(cachePath, JSON.stringify(projection, null, 2) + "\n");
  }
  return byId;
}

/**
 * Read a repo's REQUIRED status-check contexts straight from GitHub branch
 * protection (W1-T103, the #170 stuck-ambiguous fix) — the authoritative list
 * {@link checksStateFromRollup} in lib/sweep.ts gates checksState on, read
 * ONCE per repo/branch by the real wiring rather than inferred from whichever
 * checks happen to report on a given PR. Fails SOFT to `undefined` on ANY
 * error (missing protection, an unprivileged token, `gh` absent) — never
 * throws, so an unreadable protection rule degrades the caller to its
 * pre-fix conservative fallback instead of crashing the sweep.
 */
export function ghRequiredStatusCheckContexts(owner: string, repo: string, branch = "main"): string[] | undefined {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/branches/${branch}/protection/required_status_checks`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw) as { contexts?: unknown; checks?: Array<{ context?: unknown }> };
    const fromChecks = (parsed.checks ?? [])
      .map((c) => c.context)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (fromChecks.length > 0) return fromChecks;
    const fromContexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c): c is string => typeof c === "string") : [];
    return fromContexts.length > 0 ? fromContexts : undefined;
  } catch {
    return undefined;
  }
}

// ── Real GitHub gateway (execs `gh`; runs outside the sandbox — TLS only there).

/**
 * Build a {@link GitHub} gateway scoped to `owner/repo`. Every query is fail-soft:
 * a missing PR or a `gh` error resolves to null, so derivation degrades to the
 * next precedence source rather than throwing.
 */
export function ghGateway(owner: string, repo: string): GitHub {
  const slug = `${owner}/${repo}`;
  const tryJson = <T>(args: string[]): T | null => {
    try {
      return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as T;
    } catch {
      return null;
    }
  };
  return {
    prByRef(ref) {
      const pr = tryJson<PrRef>(["pr", "view", String(ref), "--repo", slug, "--json", "number,url,state"]);
      return pr && typeof pr.number === "number" ? pr : null;
    },
    findMergedByTrailer(taskId) {
      // GitHub body search for the exact trailer, merged PRs only, newest first.
      // Fuzzy (P16 / W1-T69) — callers must re-verify via headRefName + prBody
      // before crediting; this is a first pass, never the authority.
      const list = tryJson<PrRef[]>([
        "pr", "list", "--repo", slug, "--state", "merged",
        "--search", `"Remudero-Task: ${taskId}" in:body`,
        "--json", "number,url,state", "--limit", "1",
      ]);
      return list && list.length > 0 ? list[0] : null;
    },
    headRefName(prUrl) {
      const view = tryJson<{ headRefName?: string }>(["pr", "view", prUrl, "--json", "headRefName"]);
      return view?.headRefName;
    },
    prBody(prUrl) {
      const view = tryJson<{ body?: string }>(["pr", "view", prUrl, "--json", "body"]);
      return view?.body;
    },
  };
}
