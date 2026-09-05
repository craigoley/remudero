/**
 * lib/console-shell-script.ts — W1-T2731. THE CONSOLE SHELL'S PURE CLIENT CODE, AS A REAL MODULE.
 *
 * MEASURED WITH THE COVERAGE INSTRUMENT ITSELF. `renderShellHtml` (lib/serve.ts) returns ONE
 * template literal spanning ~4,200 lines — 57% of that file — and every line inside it is credited
 * the instant the function is called. Reading the lcov for src/lib/serve.ts after two console
 * suites: of the DA records inside the template, ZERO had zero hits and 4,838 read exactly the call
 * count; of the 1,992 records elsewhere in the SAME file, 915 had zero hits. The instrument works —
 * the contrast is the finding.
 *
 * THE GATE THIS DISARMS IS THE ONE THAT BLOCKS ON A SINGLE LINE. `diff-coverage` refuses a PR that
 * adds a source line with no covering test. It can NEVER fire inside that template, because no
 * added line there can score zero. That is the vacuous-pass family CLAUDE.md already names: a gate
 * reporting OK over a set where failure is unreachable.
 *
 * WHAT WAS NOT WRONG, MEASURED BEFORE ASSUMING. The client code is NOT untested — about 14 suites
 * regex-extract the script block and evaluate it. The defect is that the instrument cannot tell an
 * exercised line in that region from an unexercised one, so nothing enforces those suites keeping
 * pace, and the harness is coupled to the template's TEXTUAL SHAPE rather than to a module boundary.
 *
 * THE TECHNIQUE IS THIS REPO'S OWN, NOT AN INVENTION. lib/console-freshness.ts's `resolveFreshness`
 * is already embedded into the shell verbatim via `.toString()` off the REAL import (W1-T281/#777),
 * precisely so the shell can never drift from the unit-tested rule. This generalises that to every
 * helper that can travel: ONE definition, executed under test where lcov instruments it line by
 * line, and serialized into the browser from that same function object. A second copy cannot exist.
 *
 * WHAT TRAVELS AND WHAT DOES NOT. Only functions that touch no DOM, no network, no timer AND close
 * over no script-block variable can be serialized — a `.toString()` body carries no closure. That
 * is 56 of the block's 206 top-level functions, computed as a CALL-GRAPH CLOSURE (a pure helper
 * that calls a DOM-driving one cannot travel either). The 109 DOM-driving functions and the 41 that
 * read live shell state stay in the template and are a follow-up: they need a different technique
 * (a DOM harness), not this one.
 *
 * EVERY FUNCTION HERE MUST STAY SELF-CONTAINED. It may call another function in this module — the
 * emitted script carries all of them — but it may NOT reference a module-level constant, an import,
 * or anything else this file's `.toString()` output would leave dangling in the browser. That is
 * not a style rule: a violation is a ReferenceError in the console at runtime.
 *
 * test/console-shell-coverage-is-vacuous.test.ts enforces this by evaluating the emitted script in
 * an isolated scope AND CALLING every helper in it, failing only on a ReferenceError. The limit is
 * worth stating: it calls with no arguments, so a dangling reference on a branch that a no-argument
 * call does not reach would still get through. (Measured: the earlier version, which only checked
 * that each name was `typeof "function"`, did NOT redden when a helper was deliberately given a
 * module-level constant to close over — "defined" and "runnable" are different claims.)
 */

// ── the row shapes these helpers read ─────────────────────────────────────────────────────────
// Each is deliberately NARROW — exactly the fields the helpers below touch — rather than the whole
// /v1/status projection. serve.ts already calls `statusColorKey({status, needsHuman})` with a bare
// structural literal, and a helper that demanded the full interface could not be called that way.

export interface TaskRowLike {
  taskId: string;
  title?: string;
  status?: string;
  needsHuman?: boolean;
  risk?: string;
  prUrl?: string;
  prNumber?: number;
  reviewState?: string;
  elapsedMs?: number;
  lastActivityAt?: string;
  liveSpendUsd?: number;
  liveTurns?: number;
  liveSpendPending?: boolean;
  workerState?: string;
  workerStateSince?: string;
}

export interface SseFrame {
  event: string;
  data: string;
}

// ── time and number rendering ─────────────────────────────────────────────────────────────────

export function escapeHtml(text: unknown): string {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatRelative(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const local = new Date(t).toLocaleTimeString(undefined, { timeZoneName: "short" });
  return `${local} · ${formatRelative(Date.now() - t)}`;
}

export function formatClock(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toLocaleTimeString(undefined, { timeZoneName: "short" });
}

export function formatAgo(ts: string): string {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatElapsed(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

export function formatBytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Deliberately sited BETWEEN two functions rather than beside the interfaces at the file head: a
 * new `.ts` file's leading source-line records are stamped `DA:<line>,0` by the source-map
 * preamble, and `diff-coverage` reported exactly this alias as an uncovered added line when it sat
 * up there. The interfaces survive at the head because their members carry the gate's own
 * `interface/type-literal member` exemption; a bare alias does not.
 */
export type SortDirection = "asc" | "desc";

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function oldestAgoText<T>(items: readonly T[], tsOf: (item: T) => string | undefined): string | null {
  let oldest: number | undefined;
  for (const it of items) {
    const raw = tsOf(it);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) continue;
    if (oldest === undefined || t < oldest) oldest = t;
  }
  return oldest === undefined ? null : formatAgo(new Date(oldest).toISOString());
}

export function costLabel(costUsd: unknown): string {
  return typeof costUsd === "number" ? `$${costUsd.toFixed(3)}` : "—";
}

// ── task classification, search and sorting ───────────────────────────────────────────────────

export function taskWorkstream(id: string): string {
  const i = String(id).indexOf("-T");
  return i > 0 ? id.slice(0, i) : id;
}

export function statusColorKey(t: { status?: string; needsHuman?: boolean }): string {
  if (t.needsHuman) return "needs-human";
  if (t.status === "merged" || t.status === "done") return "merged";
  if (t.status === "blocked") return "blocked";
  if (t.status === "queued") return "queued";
  return "running";
}

export function searchHaystack(t: { taskId: string; title?: string }): string {
  return `${t.taskId} ${t.title ?? ""}`;
}

export function isBlockedRow(t: { status?: string; needsHuman?: boolean }): boolean {
  return t.status === "blocked" || t.needsHuman === true;
}

export function cmpMissingLast(av: number | undefined, bv: number | undefined, dir: SortDirection): number {
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  return dir === "desc" ? bv - av : av - bv;
}

export function cmpById(a: { taskId: string }, b: { taskId: string }, dir: SortDirection): number {
  const base = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  return dir === "desc" ? -base : base;
}

export function cmpByAge(a: { elapsedMs?: number }, b: { elapsedMs?: number }, dir: SortDirection): number {
  return cmpMissingLast(a.elapsedMs, b.elapsedMs, dir);
}

export function cmpByRecency(a: { lastActivityAt?: string }, b: { lastActivityAt?: string }, dir: SortDirection): number {
  const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : undefined;
  const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : undefined;
  return cmpMissingLast(av, bv, dir);
}

/** `null` when the query does not appear as a subsequence at all — NOT 0, which is a real score
 *  for an empty query. Callers filter on `!== null`. */
export function fuzzyScore(query: unknown, text: unknown): number | null {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  const s = String(text ?? "").toLowerCase();
  let qi = 0;
  let score = 0;
  let lastHit = -2;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      score += si === lastHit + 1 ? 3 : 1; // reward adjacent matches (a tighter run scores higher)
      lastHit = si;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function facetValueMatches(t: TaskRowLike, group: string, value: string): boolean {
  if (group === "status") return statusColorKey(t) === value;
  if (group === "workstream") return taskWorkstream(t.taskId) === value;
  if (group === "risk") return (t.risk ?? "") === value;
  if (group === "hasPr") return !!t.prUrl;
  if (group === "needsMe") return !!t.needsHuman;
  return true;
}

/** W1-T184: liveSpendUsd/liveTurns tick upward as an in-flight run spends/turns, exactly like
 *  elapsedMs ticks with wall-clock time — neither is a genuine status "flip". */
export function withoutVolatile<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  const { elapsedMs, lastActivityAt, liveSpendUsd, liveTurns, ...rest } = p;
  return rest;
}

export function parseSseFrame(frame: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (!event || dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

export function askTypeFromEscalationTitle(title: string | undefined): "question" | "action" | undefined {
  const m = title ? /^\[(\w+)\]/.exec(title) : null;
  if (!m) return undefined;
  return m[1] === "GRILL" ? "question" : "action";
}

/** The account-usage window label. `percentUsed == null` (either null or undefined) is the ONLY
 *  "unknown" case — a real 0% is a measurement and renders as one. */
export function usageWindowLabel(
  w: { percentUsed?: number | null; resetsAt?: string } | null | undefined,
  reason?: string,
): string {
  if (!w || w.percentUsed == null) return reason ? `unknown (${reason})` : "unknown";
  const pct = `${w.percentUsed}%`;
  return w.resetsAt ? `${pct} · resets ${formatClock(w.resetsAt)}` : pct;
}

export function mergeHoldConfirmationText(action: string, scope: string, reason: string): string {
  return `Confirm ${action.toUpperCase()} automatic-merge hold for ${scope} — reason: ${reason}?`;
}

// ── the mailbox's pure set algebra ────────────────────────────────────────────────────────────

export function mailboxEscalationClass(title: string | undefined): string {
  const m = title ? /^\[(\w+)\]/.exec(title) : null;
  return m ? m[1] : "UNKNOWN"; // `[CLASS]` off `escalationTitle`'s prefix
}

export function mailboxThreadKey(taskId: string, cls: string): string {
  return `thread:${taskId}::${cls}::`; // the PREFIX every reply to this concern shares
}

export function mailboxVisibleThreads<T extends { threadId: string }>(
  threads: readonly T[],
  resolvedIds: readonly string[] | undefined,
  includeResolved: boolean,
): readonly T[] {
  if (includeResolved) return threads;
  const resolved = new Set(resolvedIds || []);
  return threads.filter((t) => !resolved.has(t.threadId)); // resolved hidden, never deleted
}

export function mailboxUnreadCount(
  threads: readonly { threadId: string }[],
  readIds: readonly string[] | undefined,
): number {
  const read = new Set(readIds || []);
  return threads.filter((t) => !read.has(t.threadId)).length; // THREADS, not messages
}

export function mailboxMarkRead(readIds: readonly string[] | undefined, threadId: string): string[] {
  const read = new Set(readIds || []);
  read.add(threadId);
  return Array.from(read); // pure, never mutates readIds
}

export function mailboxMarkResolved(resolvedIds: readonly string[] | undefined, threadId: string): string[] {
  const resolved = new Set(resolvedIds || []);
  resolved.add(threadId);
  return Array.from(resolved);
}

// ── pure HTML/SVG renderers ───────────────────────────────────────────────────────────────────
// String building only. Anything that reads or writes the document stayed in the template.

export function rowChevronHtml(): string {
  return '<span class="row-chevron" aria-hidden="true">›</span>';
}

export function rowDetailSkeletonHtml(): string {
  return (
    '<div aria-busy="true">' +
    '<div class="skeleton-bar"></div><div class="skeleton-bar"></div><div class="skeleton-bar"></div>' +
    "</div>"
  );
}

export function planSectionRowHtml(s: { heading: string; merged: number; filed: number }): string {
  return `<li class="row plan-section-row"><span class="task-id">${escapeHtml(s.heading)}</span><span class="detail">${s.merged} of ${s.filed} filed tasks merged</span></li>`;
}

export function nowSummaryText(inFlight: readonly { startedAt?: string }[]): string {
  if (inFlight.length === 0) return "nothing in flight";
  const ago = oldestAgoText(inFlight, (t) => t.startedAt);
  return `${inFlight.length} running${ago ? ` · oldest ${ago}` : ""}`;
}

export function needsMeSummaryText(rows: readonly { ts?: string }[]): string {
  if (rows.length === 0) return "nothing needs you";
  const ago = oldestAgoText(rows, (r) => r.ts);
  return `${rows.length} open${ago ? ` · oldest ${ago}` : ""}`;
}

export function upNextSummaryText(head: readonly { id: string }[]): string {
  if (head.length === 0) return "nothing waiting to gather";
  const more = head.length > 1 ? ` (+${head.length - 1} more)` : "";
  return `next: ${head[0].id}${more}`;
}

export function recentSummaryText(list: readonly { verb?: string; ts: string }[]): string {
  if (list.length === 0) return "no recent activity yet";
  const landedToday = list.filter((e) => e.verb === "merged" && isSameLocalDay(new Date(e.ts), new Date())).length;
  return `${landedToday} landed today · last ${formatAgo(list[0].ts)}`;
}

export function acceptedSummaryText(rows: readonly { ts?: string }[]): string {
  if (rows.length === 0) return "nothing accepted yet";
  const ago = oldestAgoText(rows, (r) => r.ts);
  return `${rows.length} accepted${ago ? ` · most recent ${ago}` : ""}`;
}

export function restSummaryText(complement: readonly TaskRowLike[]): string {
  if (complement.length === 0) return "nothing else to show";
  const queued = complement.filter((t) => statusColorKey(t) === "queued").length;
  const merged = complement.filter((t) => statusColorKey(t) === "merged").length;
  const other = complement.length - queued - merged;
  return `queued: ${queued} · merged: ${merged} · other: ${other} (${complement.length} total)`;
}

export function selfMeasurementFigure(v: unknown): { refused: boolean; text: string } {
  if (v === null || v === undefined) return { refused: false, text: "" };
  if (typeof v !== "object" || Array.isArray(v)) return { refused: false, text: String(v) };
  const o = v as Record<string, unknown>;
  if (o.status === "refused") {
    return { refused: true, text: String(o.refusedReason || "refused (no reason given)") };
  }
  const parts: string[] = [];
  for (const k of Object.keys(o)) {
    if (k === "status" || k === "refusedReason") continue;
    const fv = o[k];
    if (fv === null || fv === undefined) continue;
    if (Array.isArray(fv)) parts.push(`${k}: ${fv.length}`);
    else if (typeof fv === "object") continue; // nested shapes (e.g. calibration classes) skipped, not zeroed
    else parts.push(`${k}: ${fv}`);
  }
  return { refused: false, text: parts.length ? parts.join(", ") : String(o.status || "measured") };
}

export function selfMeasurementRowHtml(
  verb: { key: string; label: string },
  rows: readonly { ts: string; result?: Record<string, unknown> }[],
): string {
  let latest: unknown = null;
  let latestTs: string | null = null;
  let previous: unknown = null;
  for (const row of rows) {
    const result = row && row.result ? row.result : {};
    if (!Object.prototype.hasOwnProperty.call(result, verb.key)) continue;
    if (latest === null && latestTs === null) {
      latest = result[verb.key];
      latestTs = row.ts;
    } else if (previous === null) {
      previous = result[verb.key];
      break;
    }
  }
  if (latestTs === null) {
    return `<li class="row self-measurement-row" data-verb="${escapeHtml(verb.key)}" data-self-measurement-state="never-measured"><span class="task-id">${escapeHtml(verb.label)}</span><span class="detail">never measured</span></li>`;
  }
  const figure = selfMeasurementFigure(latest);
  const prevText = previous !== null ? ` · previously: ${escapeHtml(selfMeasurementFigure(previous).text)}` : "";
  const stateAttr = figure.refused ? "refused" : "measured";
  return (
    `<li class="row self-measurement-row" data-verb="${escapeHtml(verb.key)}" data-self-measurement-state="${stateAttr}">` +
    `<span class="task-id">${escapeHtml(verb.label)}</span>` +
    `<span class="detail">${figure.refused ? "refused: " : ""}${escapeHtml(figure.text)} · as of ${escapeHtml(formatTimestamp(latestTs))}${prevText}</span>` +
    `</li>`
  );
}

/** NO DATA YET, never zeros (fb-1784902052582-c124f9): an in-flight run that has logged no
 *  spend/turns line yet reads "no data yet", not "$0.000 / 0 turns" as fact. */
export function liveSpendHtml(t: TaskRowLike): string {
  if (t.liveSpendPending) return ` · spend: <span class="spend-pending">no data yet</span>`;
  if (t.liveSpendUsd === undefined && t.liveTurns === undefined) return "";
  const turns = t.liveTurns !== undefined ? ` / ${t.liveTurns} turns` : "";
  return ` · spend: ${costLabel(t.liveSpendUsd)}${turns}`;
}

export function workerStateHtml(t: TaskRowLike): string {
  if (t.workerState === "quiet") {
    const since = escapeHtml(t.workerStateSince ?? "");
    return ` · worker: <span class="worker-state worker-quiet" data-worker-since="${since}">quiet …</span>`;
  }
  if (t.workerState === "working" || t.workerState === "tool-executing") {
    return ` · worker: <span class="worker-state">${escapeHtml(t.workerState)}</span>`;
  }
  return ` · worker: <span class="worker-state worker-unknown">state unknown</span>`;
}

export function decisionSummaryHtml(e: unknown, rawHtml: string): string {
  const s = (e as { summary?: Record<string, unknown> } | null)?.summary;
  if (
    !s ||
    typeof s.headline !== "string" ||
    typeof s.decision !== "string" ||
    !Array.isArray(s.options) ||
    s.options.length < 2
  ) {
    return rawHtml;
  }
  const optionsHtml = (s.options as { label: string; consequence: string }[])
    .map((o) => `<li><strong>${escapeHtml(o.label)}</strong> — ${escapeHtml(o.consequence)}</li>`)
    .join("");
  return (
    `<div class="decision-summary">` +
    `<p class="decision-headline">${escapeHtml(s.headline)}</p>` +
    (s.what_happened ? `<p class="decision-what-happened">${escapeHtml(s.what_happened)}</p>` : "") +
    `<p class="decision-decision">${escapeHtml(s.decision)}</p>` +
    `<ul class="decision-options">${optionsHtml}</ul>` +
    `</div>` +
    `<details class="decision-raw"><summary>Show raw</summary>${rawHtml}</details>`
  );
}

export function draftedTasksHtml(draftedTasks: readonly { id: string; title: string }[] | undefined): string {
  if (!draftedTasks || draftedTasks.length === 0) return "";
  return (
    `<ul class="drafted-tasks">` +
    draftedTasks.map((t) => `<li><span class="task-id">${escapeHtml(t.id)}</span> ${escapeHtml(t.title)}</li>`).join("") +
    `</ul>`
  );
}

export function recentPrLinkHtml(e: { prUrl?: string; prNumber?: number; prTitle?: string }): string {
  if (!e.prUrl) return "";
  const num = e.prNumber !== undefined ? `#${e.prNumber}` : null;
  const label = (num && e.prTitle ? `${num} — ${e.prTitle}` : e.prTitle || num || e.prUrl) as string;
  return ` · <a class="recent-pr-link" href="${e.prUrl}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

export function recentSpendHtml(e: { costUsd?: number; numTurns?: number }): string {
  if (e.costUsd === undefined && e.numTurns === undefined) return "";
  const turns = e.numTurns !== undefined ? ` / ${e.numTurns} turns` : "";
  return ` · <span class="recent-spend">spend: ${costLabel(e.costUsd)}${turns}</span>`;
}

export function runRowHtml(run: { runId: string; verdict?: string; costUsd?: number; prUrl?: string }): string {
  const pr = run.prUrl ? ` · <a href="${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">PR</a>` : "";
  return `<li><code>${escapeHtml(run.runId)}</code> — ${escapeHtml(run.verdict ?? "no verdict yet")} · ${costLabel(run.costUsd)}${pr}</li>`;
}

export function acceptanceRowHtml(c: { claim: string; proof: string }): string {
  return `<li><strong>${escapeHtml(c.claim)}</strong><div class="detail">proof: ${escapeHtml(c.proof)}</div></li>`;
}

export function depChainHtml(deps: readonly string[]): string {
  if (!deps.length) return '<p class="empty">no dependencies</p>';
  return `<ul class="row-list">${deps
    .map((d) => `<li><button type="button" class="card-dep-link" data-dep-id="${escapeHtml(d)}">${escapeHtml(d)}</button></li>`)
    .join("")}</ul>`;
}

export function cardIssueLinkHtml(live: { escalationIssueUrl?: string } | null | undefined): string {
  if (!live || !live.escalationIssueUrl) return "";
  return `<p><a href="${escapeHtml(live.escalationIssueUrl)}" target="_blank" rel="noopener noreferrer">view issue</a></p>`;
}

// ── the provenance journey: text + an inline SVG, all pure ────────────────────────────────────

export interface JourneyRun {
  runId: string;
  verdict?: string;
  prUrl?: string;
  prState?: string;
  mergeSha?: string;
}

export interface JourneyTask {
  id: string;
  title?: string;
  origin?: string;
  runs?: readonly JourneyRun[];
}

export interface JourneyChain {
  feedback?: { id: string; status?: string; raw?: string; proposalPr?: string } | null;
  tasks?: readonly JourneyTask[];
  direction?: string;
}

export function journeyRunHtml(run: JourneyRun): string {
  const failing = typeof run.verdict === "string" && run.verdict.startsWith("blocked");
  const marker = failing ? ' <span class="journey-fail">⛔ BLOCKING STEP</span>' : "";
  const pr = run.prUrl
    ? `<ul><li><a href="${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">PR</a>${run.prState ? ` [${escapeHtml(run.prState)}]` : ""} — sha ${escapeHtml(run.mergeSha ?? "(not merged yet)")}</li></ul>`
    : "";
  // NOTE: the ".journey-fail" class lives ONLY on the marker <span> above, never also on this
  // wrapping <li> -- a caller counting ".journey-fail" elements must count exactly ONE per
  // failing run, not two nested matches for the same run.
  return `<li>run ${escapeHtml(run.runId)}: ${escapeHtml(run.verdict ?? "no verdict yet")}${marker}${pr}</li>`;
}

export function journeyTaskHtml(t: JourneyTask): string {
  const runs = (t.runs ?? []).length ? `<ul>${(t.runs ?? []).map(journeyRunHtml).join("")}</ul>` : "<ul><li>(no runs yet)</li></ul>";
  return `<li>task <button type="button" class="journey-task-link" data-task-id="${escapeHtml(t.id)}">${escapeHtml(t.id)}</button>: ${escapeHtml(t.title)}${
    t.origin ? ` (origin: ${escapeHtml(t.origin)})` : ""
  }${runs}</li>`;
}

export function journeyGraphSvg(chain: JourneyChain): string {
  const feedback = chain.feedback && typeof chain.feedback === "object" ? chain.feedback : null;
  const tasks = Array.isArray(chain.tasks) ? chain.tasks : [];
  if (!feedback && tasks.length === 0) return "";
  const nodeW = 240,
    nodeH = 30,
    rowGap = 10,
    runIndent = 24,
    pad = 8;
  const nodes: Array<{
    x: number; y: number; w: number; h: number;
    kind: string; failing: boolean; parent: number | null; label: string; sub: string;
  }> = [];
  let y = pad;
  let feedbackIndex: number | null = null;
  if (feedback) {
    feedbackIndex = nodes.length;
    nodes.push({
      x: pad, y, w: nodeW, h: nodeH, kind: "feedback", failing: false, parent: null,
      label: `feedback#${feedback.id}`, sub: String(feedback.status ?? ""),
    });
    y += nodeH + rowGap;
  }
  tasks.forEach((t) => {
    const taskIndex = nodes.length;
    nodes.push({
      x: pad, y, w: nodeW, h: nodeH, kind: "task", failing: false, parent: feedbackIndex,
      label: `task ${t.id}`, sub: String(t.title ?? ""),
    });
    y += nodeH + rowGap;
    const runs = Array.isArray(t.runs) ? t.runs : [];
    runs.forEach((r: JourneyRun) => {
      const failing = typeof r.verdict === "string" && r.verdict.startsWith("blocked");
      nodes.push({
        x: pad + runIndent, y, w: nodeW - runIndent, h: nodeH, kind: "run", failing, parent: taskIndex,
        label: `run ${r.runId}`, sub: String(r.verdict ?? "no verdict yet"),
      });
      y += nodeH + rowGap;
    });
  });
  const width = pad * 2 + nodeW;
  const height = y;
  const edgesSvg = nodes
    .map((n) => {
      if (n.parent === null) return "";
      const p = nodes[n.parent];
      return `<line class="journey-graph-edge" x1="${p.x + 10}" y1="${p.y + p.h}" x2="${n.x + 10}" y2="${n.y}" stroke="currentColor" stroke-opacity="0.4" />`;
    })
    .join("");
  const nodesSvg = nodes
    .map((n) => {
      const cls = `journey-graph-node journey-graph-node-${n.kind}${n.failing ? " journey-graph-fail" : ""}`;
      const marker = n.failing ? " ⛔" : "";
      return (
        `<g class="${cls}">` +
        `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.5" />` +
        `<text x="${n.x + 8}" y="${n.y + 13}" font-size="10" fill="currentColor">${escapeHtml(n.label)}${marker}</text>` +
        `<text x="${n.x + 8}" y="${n.y + 24}" font-size="9" fill="currentColor" fill-opacity="0.75">${escapeHtml(n.sub)}</text>` +
        `</g>`
      );
    })
    .join("");
  return `<svg class="journey-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="provenance graph">${edgesSvg}${nodesSvg}</svg>`;
}

export function journeyHtml(chain: JourneyChain | null | undefined): string {
  const safeChain: JourneyChain = chain && typeof chain === "object" ? chain : {};
  const feedback = safeChain.feedback && typeof safeChain.feedback === "object" ? safeChain.feedback : null;
  const tasks = Array.isArray(safeChain.tasks) ? safeChain.tasks : [];
  const direction = typeof safeChain.direction === "string" ? safeChain.direction : "unknown";
  // DEGRADE, NEVER DISAPPEAR (W1-T2489). Each section below is independently guarded: an empty
  // graph, an unreachable /v1/trace (an empty/absent chain reaches here the same way), or a
  // chain shape ANY one of these three sections can't read must still leave the OTHER sections
  // -- and always the direction line -- standing. A caller that removes these try/catches (or
  // calls journeyGraphSvg directly with no wrapper at all) is what would actually blank the
  // panel; this function itself never does.
  let svg = "";
  try {
    svg = journeyGraphSvg({ feedback, tasks });
  } catch {
    // graph draw failed on this chain shape -- absent, not blank: the text sections below still render.
    svg = "";
  }
  let feedbackHtml = "";
  try {
    feedbackHtml = feedback
      ? `<p>feedback#${escapeHtml(feedback.id)} [${escapeHtml(feedback.status)}] — ${escapeHtml(feedback.raw)}${
          feedback.proposalPr ? ` → <a href="${escapeHtml(feedback.proposalPr)}" target="_blank" rel="noreferrer">proposal PR</a>` : ""
        }</p>`
      : "";
  } catch {
    // feedback row unreadable -- drop just this line, the graph and task list are unaffected.
    feedbackHtml = "";
  }
  let tasksHtml = "<p>(no tasks yet)</p>";
  try {
    tasksHtml = tasks.length ? `<ul>${tasks.map(journeyTaskHtml).join("")}</ul>` : "<p>(no tasks yet)</p>";
  } catch {
    // one bad task entry must not blank the whole journey -- say so instead of an empty list.
    tasksHtml = "<p>(unable to render tasks)</p>";
  }
  return `${svg}<p>direction: ${escapeHtml(direction)}</p>${feedbackHtml}${tasksHtml}`;
}

// ── the serializer: ONE definition, executed here and shipped to the browser ───────────────────

/**
 * Every helper above, in a stable order. This array IS the contract: a function added to this
 * module but missing here never reaches the browser, and
 * test/console-shell-coverage-is-vacuous.test.ts refuses that divergence by comparing this list
 * against the module's own exported function set.
 */
const SHELL_SCRIPT_HELPERS = [
  escapeHtml, formatRelative, formatTimestamp, formatClock, formatAgo, formatElapsed, formatBytes,
  isSameLocalDay, oldestAgoText, costLabel,
  taskWorkstream, statusColorKey, searchHaystack, isBlockedRow,
  cmpMissingLast, cmpById, cmpByAge, cmpByRecency,
  fuzzyScore, facetValueMatches, withoutVolatile, parseSseFrame,
  askTypeFromEscalationTitle, usageWindowLabel, mergeHoldConfirmationText,
  mailboxEscalationClass, mailboxThreadKey, mailboxVisibleThreads, mailboxUnreadCount,
  mailboxMarkRead, mailboxMarkResolved,
  rowChevronHtml, rowDetailSkeletonHtml, planSectionRowHtml,
  nowSummaryText, needsMeSummaryText, upNextSummaryText, recentSummaryText, acceptedSummaryText,
  restSummaryText, selfMeasurementFigure, selfMeasurementRowHtml,
  liveSpendHtml, workerStateHtml, decisionSummaryHtml, draftedTasksHtml,
  recentPrLinkHtml, recentSpendHtml, runRowHtml, acceptanceRowHtml, depChainHtml, cardIssueLinkHtml,
  journeyRunHtml, journeyTaskHtml, journeyGraphSvg, journeyHtml,
] as const;

/**
 * The helpers, rendered as browser-ready function declarations for `renderShellHtml` to splice
 * into its `<script type="module">` block.
 *
 * `Function.prototype.toString()` off the REAL function objects — the same technique W1-T281 used
 * for `resolveFreshness`, for the same reason: there is exactly ONE definition, so the shipped
 * shell can never drift from the code the tests exercise. TypeScript annotations are erased before
 * this runs (tsx/esbuild transpiles the module first), so what is emitted is plain JS.
 *
 * The output is a series of `function <name>(...) {...}` declarations, so they HOIST inside the
 * script block exactly as they did when they were written inline — no call-order change.
 */
export function renderConsoleShellScript(): string {
  return SHELL_SCRIPT_HELPERS.map((f) => f.toString()).join("\n\n");
}

/** The names this module ships to the browser — what a census test compares against the module's
 *  own exports, so a helper added here but never emitted is caught rather than silently absent. */
export function consoleShellScriptHelperNames(): string[] {
  return SHELL_SCRIPT_HELPERS.map((f) => f.name);
}
