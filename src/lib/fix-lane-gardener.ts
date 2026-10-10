/**
 * W1-T7421 — THE FIX-LANE GARDENER. The PR repair bots improve themselves.
 *
 * On 2026-10-09 an operator hand-fixed 15+ PRs and every one traced to a defect in the fix lane, not the PR. Nothing
 * watched it: the flow gardener prices only `sweep.disposed` blocker-hours. Here once per UTC day the ledger union is
 * clustered into DEFECT CLASSES (an unstated outcome, a refused or stood-down round, a FIXED head that stayed red, a red
 * with no failing test to act on, a branch that moved mid-round, a round that changed nothing, a disposition that
 * disagrees with the ledgered arm, FLAKE answered again on a changing check set, a PR blocked past the fleet's own p90),
 * each priced by blocked hours plus a weight per OPERATOR INTERVENTION attributed to it, and the top class is drafted as
 * ONE remedy through the flow-remedy ladder (`ladderOf`/`ladderGardenSpec`, never a fork): never a second while one is
 * open, its effect measured by the class's share of hours after the remedy merges, the next rung escalated when it did
 * not help. Origin: `fix-lane:<class>`.
 *
 * No fixed threshold gates a draft (operator ruling 2026-10-09, "I hate hard ceilings"): classes are RANKED by price and
 * the machine-filing judge decides whether the top one merits a draft.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { fixedClock, systemClock } from "./clock.js";
import { diffCoverageTargets } from "./diff-coverage-targets.js";
import { checkRunsRestArgs, contentRestArgs } from "./open-prs-rest.js";
import type { CiFrictionPlanState } from "./ci-friction-gardener.js";
import type { OwnerSearch } from "./ci-friction-remedy.js";
import type { Escalation } from "./escalate.js";
import type { GardenerDeps } from "./gardener.js";
import { ghExec } from "./github-transport.js";
import {
  episodesOf, ladderGardenSpec, ladderOf, markEligibility, readLadderPlan, readLadderRecords, readOutcomes, reasonClass,
  type Charge, type Episode, type FlowAction, type Inventory, type LadderKind, type PrOutcome,
} from "./flow-remedy-gardener.js";
import type { LedgerRecord } from "./retro.js";

/** The `fixlane.report` row: one per pass (class, count, hours, interventions, open remedy). */
export const FIXLANE_REPORT_STEP = "fixlane.report";
export const FIXLANE_REPORT_FILE = "fix-lane-report.md";

/** The files a fix-lane remedy may own when no source file mentions the class's text (the fix lane's own code). */
export const FIX_LANE_CODE: readonly string[] = [
  "src/lib/sweep.ts", "src/lib/fix-outcome.ts", "src/lib/fix-progress-judge.ts", "src/run-task.ts",
];

/**
 * One operator intervention is priced as this many PR-hours of blocked time: a person stepping in costs more than the
 * wait it ends. It converts a count into the ranking's one unit; it gates nothing.
 */
export const OPERATOR_INTERVENTION_HOURS = 4;

export const FIX_LANE_LADDER: LadderKind = {
  name: "fix-lane", prefix: "fix-lane", receiptStep: "fix-lane.scorecard", escalatedStep: "fixlane.remedy_escalated", stem: "fix-lane",
  title: a => `THE FIX-LANE GARDENER'S COSTLIEST DEFECT CLASS — ${a.price.key} cost ${a.price.hours.toFixed(2)} PR-hours`,
  commitTitle: cause => `chore(plan): draft a fix-lane remedy for ${cause}`,
  claim: cause => `${cause} no longer needs an operator hand fix`,
  ownerLine: () => "Owner: the fix lane itself (a defect in the harness that repairs PRs, not in the PR).",
  evidenceLine: (pr, hours, reason) => `- ${pr > 0 ? `PR #${pr}` : "a round"}: ${hours.toFixed(2)} PR-hours — ${reason}`,
  escalationSummary: cause => `Fix-lane defect: ${cause} still costs PR-hours`,
  fallbackFiles: FIX_LANE_CODE,
};

export type InterventionKind = "push" | "close" | "unfiled-pr";
export interface OperatorIntervention { pr: number; at: string; kind: InterventionKind; actor: string; detail: string }
/** An unreadable source is UNKNOWN, never zero. */
export type InterventionRead = { ok: true; interventions: readonly OperatorIntervention[] } | { ok: false; reason: string };

export interface FixLaneEvidence {
  readHeadSource?: (head: string, file: string) => string | undefined;
  readCoverageLog?: (head: string) => string | undefined;
}

export interface FixLaneSources extends FixLaneEvidence {
  owner: string; repo: string;
  mintTaskId: (branch?: string) => string;
  ledgerRecords?: () => readonly LedgerRecord[];
  planState?: () => CiFrictionPlanState;
  prOutcomes?: (prs: readonly number[]) => ReadonlyMap<number, PrOutcome>;
  /** Pushes to / closes of fleet PRs by a non-fleet actor, and operator run-unfiled PRs touching fix-lane code. */
  interventions?: (prs: readonly number[], sinceMs: number) => InterventionRead;
  ownerSearch?: OwnerSearch;
  draftShard?: (action: FlowAction, taskId: string) => string;
  escalate?: (escalation: Escalation) => string | null;
}

/** How far back a pass looks: a remedy's effect window. */
export const FIX_LANE_WINDOW_MS = 14 * 24 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FLEET_ACTOR = /remudero-fleet/i;
export const isFleetActor = (actor: string | null | undefined) => typeof actor === "string" && FLEET_ACTOR.test(actor);

const STEPS = ["sweep.disposed", "fix.dispatch", "fix.done", "fix.commit_refused", "fix.stood_down", "pr.terminal", "automerge.arm_skipped"] as const;

interface DefectEvent { pr: number; at: number; key: string; evidence: string; elapsedMs?: number }

const prOfRow = (r: LedgerRecord, byHead: ReadonlyMap<string, number>, byRound: ReadonlyMap<string, number>): number => {
  const direct = Number(r.pr_number);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  const url = /\/pull\/(\d+)$/.exec(String(r.pr_url ?? ""));
  if (url) return Number(url[1]);
  return (typeof r.round_id === "string" ? byRound.get(r.round_id) : undefined) ??
    (typeof r.head_sha === "string" ? byHead.get(r.head_sha) : undefined) ?? 0;
};
const tsOf = (r: LedgerRecord) => Date.parse(String(r.ts));
const checkSet = (r: LedgerRecord): string => failuresOf(r)
  .map(f => `${String(f.check)}=${String(f.signature ?? "")}`).sort().join("|");
const quote = (tail: unknown) => (typeof tail === "string" && tail ? ` — worker saw: ${tail}` : "");
const roundShape = (done: LedgerRecord | undefined) => done === undefined ? "" : ` [${["provider", "selected_model", "model", "effort"]
  .map(k => (typeof done[k] === "string" ? `${k} ${String(done[k])}` : "")).filter(Boolean).join(", ")}${typeof done.elapsed_ms === "number" ? `, ${Math.round(Number(done.elapsed_ms) / 1000)}s` : ""}]`;

type Failure = { check: string; signature?: string; logTail?: string };
const failuresOf = (r: LedgerRecord): Failure[] => (Array.isArray(r.ci_failures) ? r.ci_failures : [])
  .filter((f): f is Failure => f !== null && typeof f === "object" && typeof f.check === "string");
const isCoverage = (f: Failure) => /diff.coverage|coverage-ratchet/i.test(`${f.check} ${f.signature ?? ""}`);
const isCensus = (f: Failure) => /rule-checks|\bcensus\b|reach[-_ ]ratchet|affected-suite-reach-ratchet|negative-reachability-ratchet|coverage-session-blanking|env[-_ ](?:var[-_ ])?registry/i
  .test(`${f.check} ${f.signature ?? ""}`);

function missingSeam(source: string, line: number): string | undefined {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<{ text: string; start: number; end: number }> = [];
  const templates: number[] = [];
  let braceDepth = 0;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken && /^(?:=|\(|\[|\{|,|:|\?|return|case|=>|!|&&|\|\||\?\?)$/.test(tokens.at(-1)?.text ?? "=")) kind = scanner.reScanSlashToken();
    if (scanner.isUnterminated() || kind === SyntaxKind.Unknown) return undefined;
    const start = scanner.getTokenStart();
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === braceDepth - 1) {
      tokens.push({ text: "}", start, end: start + 1 }); braceDepth--;
      kind = scanner.reScanTemplateToken(false);
      if (scanner.isUnterminated()) return undefined;
      if (kind === SyntaxKind.TemplateTail) { templates.pop(); continue; }
    }
    if (kind === SyntaxKind.TemplateHead) templates.push(braceDepth);
    const text = kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle ? "{" : scanner.getTokenText();
    if (text === "{") braceDepth++;
    if (text === "}") braceDepth--;
    tokens.push({ text, start, end: scanner.getTokenEnd() });
  }
  const pairs = new Map<number, number>(), stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (["(", "{", "["].includes(t)) stack.push(i);
    else if ([")", "}", "]"].includes(t)) {
      const open = stack.pop();
      if (open === undefined || tokens[open]!.text !== ({ ")": "(", "}": "{", "]": "[" } as Record<string, string>)[t]) return undefined;
      pairs.set(open, i); pairs.set(i, open);
    }
  }
  if (stack.length) return undefined;
  const imported = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "import") continue;
    for (let n = i + 1; n < tokens.length && !["from", ";"].includes(tokens[n]!.text); n++) {
      if (/^[A-Za-z_$][\w$]*$/.test(tokens[n]!.text)) imported.add(tokens[n]!.text);
    }
  }
  const functions: Array<{ params: number; close: number; body: number; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "function" && tokens[i]!.text !== "=>") continue;
    const arrow = tokens[i]!.text === "=>";
    const params = arrow ? (pairs.get(i - 1) ?? i - 1) : tokens.findIndex((t, n) => n > i && t.text === "(");
    const close = pairs.get(params) ?? params;
    let body = arrow ? i + 1 : close + 1;
    if (!arrow) while (body < tokens.length && !["{", ";", "=>"].includes(tokens[body]!.text)) body++;
    let end = pairs.get(body);
    if (arrow && tokens[body]?.text !== "{") {
      end = body;
      while (end < tokens.length && ![",", ";", ")", "}"].includes(tokens[end]!.text)) end = (pairs.get(end) ?? end) + 1;
      end--;
    }
    if (end === undefined || end < body) continue;
    functions.push({ params, close, body, end });
  }
  const calls = (start: number, end: number) => tokens.slice(start, end).flatMap((t, offset) => {
    const i = start + offset;
    if (!/^[A-Za-z_$][\w$]*$/.test(t.text) || ["if", "for", "while", "switch", "catch", "function"].includes(t.text) || [".", "?."].includes(tokens[i - 1]?.text ?? "")) return [];
    let next = i + 1;
    while ([".", "?."].includes(tokens[next]?.text ?? "")) next += 2;
    return tokens[next]?.text === "(" ? [t.text] : [];
  });
  const lineOf = (pos: number) => source.slice(0, pos).split("\n").length;
  const contains = (start: number, end: number) => line >= lineOf(tokens[start]!.start) && line <= lineOf(tokens[end]!.end);
  const dependency = (fn: typeof functions[number], start: number, end: number) => {
    const params = new Set(tokens.slice(fn.params, fn.close + 1).map(t => t.text));
    const used = calls(start, end);
    for (let i = fn.body + 1; i < start; i++) {
      if (!["const", "let"].includes(tokens[i]!.text) || tokens[i + 2]?.text !== "=") continue;
      let end = i + 3;
      while (end < start && tokens[end]!.text !== ";") end++;
      if (tokens.slice(i + 3, end).some(t => params.has(t.text))) params.add(tokens[i + 1]!.text);
    }
    if (used.some(name => params.has(name))) return undefined;
    return [...new Set(used.filter(name => imported.has(name)))].join(", ") || undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "catch") continue;
    const body = tokens[i + 1]?.text === "(" ? (pairs.get(i + 1) ?? i) + 1 : i + 1;
    const end = pairs.get(body), tryEnd = i - 1, tryStart = pairs.get(tryEnd);
    if (end === undefined || tryStart === undefined || !contains(body, end)) continue;
    const fn = functions.filter(f => f.body < i && f.end > end).sort((a, b) => b.body - a.body)[0];
    if (fn) return dependency(fn, tryStart + 1, tryEnd);
  }
  for (const fn of functions) {
    if (!contains(fn.body, fn.end)) continue;
    const parent = functions.find(f => f.params < fn.params && f.close > fn.end);
    if (parent && tokens.slice(parent.params, fn.params).some(t => t.text === "=")) return dependency(fn, fn.body + (tokens[fn.body]!.text === "{" ? 1 : 0), fn.end);
  }
  return undefined;
}

function unseamedCoverage(r: LedgerRecord, sources: FixLaneEvidence): string | undefined {
  const failures = failuresOf(r).filter(isCoverage);
  if (!failures.length || typeof r.head_sha !== "string") return undefined;
  const tails = failures.flatMap(f => typeof f.logTail === "string" ? [f.logTail] : []);
  if (tails.length !== failures.length) {
    const log = sources.readCoverageLog?.(r.head_sha);
    if (log !== undefined) tails.push(log);
  }
  const parsed = diffCoverageTargets(tails.map(tail => tail.replace(/^\d{4}-\d\d-\d\dT\S+ ?/gm, "")));
  if (!parsed || parsed.unlisted > 0 || !parsed.targets.length) return undefined;
  const evidence: string[] = [];
  for (const target of parsed.targets) {
    const source = sources.readHeadSource?.(r.head_sha, target.file);
    if (source === undefined) return undefined;
    for (const line of target.lines) {
      const dependency = missingSeam(source, line);
      if (dependency === undefined) return undefined;
      evidence.push(`${target.file}:${line} — ${dependency}: missing injectable seam`);
    }
  }
  return `${r.head_sha}: ${evidence.join("; ")}`;
}

export function readFixLaneEvidence(sources: Pick<FixLaneSources, "owner" | "repo">): FixLaneEvidence {
  const json = (args: string[]) => JSON.parse(ghExec(args, { encoding: "utf8" }));
  return {
    readHeadSource: (head, file) => {
      const body = json(contentRestArgs(sources.owner, sources.repo, file, head));
      if (body.encoding !== "base64" || typeof body.content !== "string") throw new Error(`fix-lane source unreadable: ${file}@${head}`);
      return Buffer.from(body.content, "base64").toString("utf8");
    },
    readCoverageLog: head => {
      const pages = json([...checkRunsRestArgs(sources.owner, sources.repo, head), "--paginate", "--slurp"]);
      const checks = (pages as Array<{ check_runs: Array<{ id: number; name: string; conclusion: string; details_url?: string; external_id?: string }> }>)
        .flatMap(p => p.check_runs);
      const latest = new Map<string, typeof checks[number]>();
      for (const c of checks) if (c.id > (latest.get(c.name)?.id ?? 0)) latest.set(c.name, c);
      return [...latest.values()].filter(c => c.conclusion === "failure" && isCoverage({ check: c.name })).map(c => {
        const job = /\/jobs\/(\d+)/.exec(c.details_url ?? "")?.[1] ?? c.external_id ?? String(c.id);
        return ghExec(["api", `repos/${sources.owner}/${sources.repo}/actions/jobs/${job}/logs`], { encoding: "utf8" });
      }).join("\n");
    },
  };
}

/** Clusters the fix lane's ledger rows into defect events, each with a normalised class key. */
export function defectEventsOf(records: readonly LedgerRecord[], now: number, sources: FixLaneEvidence = {}): DefectEvent[] {
  const rows = records.filter(r => Number.isFinite(tsOf(r)) && tsOf(r) <= now).sort((a, b) => tsOf(a) - tsOf(b));
  const byHead = new Map<string, number>(), byRound = new Map<string, number>();
  for (const r of rows) {
    if (r.step === "sweep.disposed" && typeof r.head_sha === "string" && Number(r.pr_number) > 0) byHead.set(r.head_sha, Number(r.pr_number));
  }
  for (const r of rows) {
    if (r.step === "fix.dispatch" && typeof r.round_id === "string") {
      const pr = prOfRow(r, byHead, byRound);
      if (pr > 0) byRound.set(r.round_id, pr);
    }
  }
  const doneByRound = new Map<string, LedgerRecord>();
  for (const r of rows) if (r.step === "fix.done" && typeof r.round_id === "string") doneByRound.set(r.round_id, r);
  const events: DefectEvent[] = [];
  const add = (r: LedgerRecord, key: string, evidence: string, pr = prOfRow(r, byHead, byRound), elapsedMs?: number) =>
    events.push({ pr, at: tsOf(r), key, evidence, elapsedMs: elapsedMs ?? (typeof r.elapsed_ms === "number" ? r.elapsed_ms : undefined) });
  const pushed = new Map<string, { pr: number; done: LedgerRecord }>();
  const previousRound = new Map<number, LedgerRecord>();
  const lastSet = new Map<number, string>(), lastFlake = new Map<number, string>(), lastWasFixed = new Map<number, boolean>();
  for (const r of rows) {
    const pr = prOfRow(r, byHead, byRound);
    const done = typeof r.round_id === "string" ? doneByRound.get(r.round_id) : undefined;
    if (r.step === "fix.dispatch") {
      const coverage = unseamedCoverage(r, sources);
      if (coverage !== undefined) add(r, "coverage-unseamed-catch", coverage);
      const previous = previousRound.get(pr);
      const priorDone = previous && typeof previous.round_id === "string" ? doneByRound.get(previous.round_id) : undefined;
      const oldReds = previous ? failuresOf(previous) : [], newReds = failuresOf(r);
      if (pr > 0 && previous && typeof r.round_id === "string" && r.round_id !== previous.round_id &&
          priorDone && prOfRow(priorDone, byHead, byRound) === pr && tsOf(priorDone) >= tsOf(previous) &&
          tsOf(priorDone) <= tsOf(r) && priorDone.fix_outcome === "FIXED" &&
          typeof r.head_sha === "string" && priorDone.pushed_head_sha === r.head_sha && r.head_sha !== previous.head_sha &&
          oldReds.length > 0 && newReds.length > 0 && newReds.every(isCensus) &&
          !oldReds.some(a => newReds.some(b => a.check === b.check && a.signature === b.signature))) {
        add(r, "fix-swapped-red-for-census", `round ${String(previous.round_id)} cleared ${checkSet(previous)}; round ${r.round_id} sees ${checkSet(r)} at pushed head ${r.head_sha}`);
      }
      if (pr > 0) previousRound.set(pr, r);
      const set = checkSet(r);
      if (set && pr > 0) {
        if (lastSet.get(pr) === set && lastWasFixed.get(pr) !== true) add(r, "same-red-set", `the same red set ${set} across consecutive rounds${roundShape(done)}`);
        lastSet.set(pr, set);
      }
    } else if (r.step === "fix.done") {
      const outcome = String(r.fix_outcome ?? "");
      if (pr > 0) lastWasFixed.set(pr, outcome === "FIXED");
      if (outcome === "unstated") add(r, "fix-outcome:unstated", `the worker's FIX_OUTCOME line was not recognised${roundShape(r)}${quote(r.worker_tail)}`);
      if (outcome === "FIXED" && typeof r.pushed_head_sha === "string") pushed.set(r.pushed_head_sha, { pr, done: r });
      if (outcome === "FLAKE" && pr > 0) {
        const dispatch = rows.find(d => d.step === "fix.dispatch" && d.round_id === r.round_id);
        const set = dispatch ? checkSet(dispatch) : "";
        const prev = lastFlake.get(pr);
        if (set && prev !== undefined && prev !== set) add(r, "flake-repeated", `FLAKE answered again on a different failing set (${prev} then ${set})${quote(r.worker_tail)}`);
        if (set) lastFlake.set(pr, set);
      }
    } else if (r.step === "fix.commit_refused") {
      const reason = String(r.reason ?? "unstated");
      const outside = Array.isArray(r.undeclared) && r.undeclared.length > 0;
      const key = outside ? "commit-refused:outside declared files" : `commit-refused:${reasonClass(reason)}`;
      add(r, key, `${reason}${outside ? ` (${(r.undeclared as unknown[]).slice(0, 5).join(", ")})` : ""}${roundShape(done)}${quote(done?.worker_tail)}`);
    } else if (r.step === "fix.stood_down") {
      if (r.outcome === "handed_off") continue; // a handoff to the sweep is the lane working, not a defect
      const site = String(r.site ?? "unknown");
      const reason = String(r.reason ?? "");
      if (site === "rung.empty_ci_failures") add(r, "red-no-actionable-test", `required checks red with no failing test extractable from the CI log: ${reason}`);
      else add(r, `stood-down:${site}:${reasonClass(reason)}`, reason);
    } else if (r.step === "sweep.disposed" && r.blocker === "own-red" && typeof r.head_sha === "string" && pushed.has(r.head_sha)) {
      const fixed = pushed.get(r.head_sha)!;
      pushed.delete(r.head_sha);
      add(r, "fixed-still-red", `a FIXED push ${r.head_sha.slice(0, 9)} is still red on the next sweep${quote(fixed.done.worker_tail)}`, pr || fixed.pr);
    } else if (r.step === "automerge.arm_skipped" && pr > 0) {
      const armed = [...rows].reverse().find(d => d.step === "sweep.disposed" && d.disposition === "mergeable" && d.acted === true &&
        Number(d.pr_number) === pr && tsOf(d) <= tsOf(r) && tsOf(r) - tsOf(d) <= 10 * 60_000);
      if (armed) add(r, "disposition-disagrees-with-arm", `the sweep disposed PR #${pr} as arming while the ledger shows ${String(r.step)}: ${String(r.reason ?? r.outcome ?? "")}`);
    }
  }
  return events;
}

/** The blocked span of one event: until the PR left the fix lane's hands, ended, or (still open) now. */
function endOfEvent(e: DefectEvent, rows: readonly LedgerRecord[], terminal: ReadonlyMap<number, number>, outcomes: ReadonlyMap<number, PrOutcome>, now: number): number {
  if (e.pr <= 0) return e.at + (e.elapsedMs ?? 0);
  const released = rows.find(r => r.step === "sweep.disposed" && Number(r.pr_number) === e.pr && tsOf(r) > e.at && r.blocker_owner !== "fix-lane");
  const ended = terminal.get(e.pr) ?? (() => { const o = outcomes.get(e.pr); const at = Date.parse(o?.at ?? ""); return o && o.state !== "open" && Number.isFinite(at) ? at : undefined; })();
  const candidates = [released ? tsOf(released) : undefined, ended].filter((n): n is number => n !== undefined && n >= e.at);
  return candidates.length ? Math.min(...candidates) : now;
}

export interface FixLaneInventory extends Inventory {
  interventions: { read: InterventionRead; byClass: Map<string, number>; total: number };
}

/** Builds the fix-lane episodes (one per defect event, plus the fix-lane-owned sweep blockers) and runs the shared ladder. */
export function fixLaneInventoryOf(records: readonly LedgerRecord[], tasks: Parameters<typeof ladderOf>[3], outcomes: ReadonlyMap<number, PrOutcome>,
  interventions: InterventionRead, now: number, sources: FixLaneEvidence = {}): FixLaneInventory {
  const events = defectEventsOf(records, now, sources);
  const terminal = new Map<number, number>();
  for (const r of records) {
    const pr = Number(r.pr_number) || Number(/\/pull\/(\d+)$/.exec(String(r.pr_url ?? ""))?.[1]);
    if (r.step === "pr.terminal" && pr > 0 && Number.isFinite(tsOf(r))) terminal.set(pr, tsOf(r));
  }
  const sweepRows = records.filter(r => r.step === "sweep.disposed" && Number(r.pr_number) > 0 && Number.isFinite(tsOf(r))).sort((a, b) => tsOf(a) - tsOf(b));
  const byClass = new Map<string, number>();
  const list = interventions.ok ? [...interventions.interventions].filter(i => Number.isFinite(Date.parse(i.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const episodes: Episode[] = [];
  const weight = new Map<DefectEvent, number>();
  const standalone: Array<{ i: OperatorIntervention; key: string }> = [];
  for (const i of list) {
    // expiring-fixture: exempt -- `now` only caps the span; intervention fixtures pass a fixed now, so no outcome ages with the calendar.
    const at = Date.parse(i.at);
    const cause = [...events].reverse().find(e => e.pr === i.pr && i.pr > 0 && e.at <= at);
    if (cause) { weight.set(cause, (weight.get(cause) ?? 0) + 1); byClass.set(cause.key, (byClass.get(cause.key) ?? 0) + 1); }
    else { const key = `operator-intervention:${i.kind}`; standalone.push({ i, key }); byClass.set(key, (byClass.get(key) ?? 0) + 1); }
  }
  for (const e of events) {
    const end = Math.min(Math.max(e.at, endOfEvent(e, sweepRows, terminal, outcomes, now)), now);
    const hours = (end - e.at) / HOUR + (weight.get(e) ?? 0) * OPERATOR_INTERVENTION_HOURS;
    const charge: Charge = { pr: e.pr, key: e.key, start: e.at, end, hours, reason: e.evidence, owner: "fix-lane" };
    episodes.push({ pr: e.pr, key: e.key, owner: "fix-lane", start: e.at, end, outcome: "cleared", eligible: true, charges: [charge] });
  }
  for (const { i, key } of standalone) {
    // expiring-fixture: exempt -- `now` only caps the span; intervention fixtures pass a fixed now, so no outcome ages with the calendar.
    const at = Date.parse(i.at);
    const end = Math.min(Math.max(at, terminal.get(i.pr) ?? at), now);
    const charge: Charge = { pr: i.pr, key, start: at, end, hours: (end - at) / HOUR + OPERATOR_INTERVENTION_HOURS, reason: `${i.actor}: ${i.detail}`, owner: "fix-lane" };
    episodes.push({ pr: i.pr, key, owner: "fix-lane", start: at, end, outcome: "cleared", eligible: true, charges: [charge] });
  }
  // PRs the fix lane held past the fleet's own p90 for the same blocker: priced by the flow gardener's episodes, owned here.
  const blocked = episodesOf(records, outcomes, now).filter(e => e.owner === "fix-lane").map<Episode>(e => {
    const key = `blocked-past-slo:${e.key}`;
    return { ...e, key, charges: e.charges.map(c => ({ ...c, key })) };
  });
  const thresholds = markEligibility(blocked, now);
  episodes.push(...blocked.filter(e => e.eligible));
  const inventory = ladderOf(FIX_LANE_LADDER, episodes, records, tasks, now, thresholds);
  return { ...inventory, interventions: { read: interventions, byClass, total: list.length } };
}

/** One PR's operator interventions from a GraphQL node: a non-fleet push to, or close of, a fleet-authored PR. */
export function interventionsFromPullRequest(pr: number, node: unknown, sinceMs: number): OperatorIntervention[] {
  const n = node as {
    author?: { login?: string } | null; state?: string;
    commits?: { nodes?: Array<{ commit?: { oid?: string; committedDate?: string; author?: { name?: string; user?: { login?: string } | null } | null } }> };
    timelineItems?: { nodes?: Array<{ createdAt?: string; actor?: { login?: string } | null }> };
  };
  // A null author is a deleted account (not the fleet); an author the answer does not carry at all is unreadable, not "someone else".
  const author = n.author === null ? "ghost" : n.author?.login;
  if (author === undefined) throw new Error(`fix-lane PR #${pr} author unreadable`);
  if (!isFleetActor(author)) return [];
  const out: OperatorIntervention[] = [];
  for (const c of n.commits?.nodes ?? []) {
    const commit = c.commit;
    const at = Date.parse(commit?.committedDate ?? "");
    if (!commit || !Number.isFinite(at) || at < sinceMs) continue;
    const login = commit.author?.user?.login;
    const name = commit.author?.name;
    const who = login ?? name;
    if (who === undefined) throw new Error(`fix-lane PR #${pr} commit ${String(commit.oid)} author unreadable`);
    if (!isFleetActor(login) && !isFleetActor(name)) out.push({ pr, at: commit.committedDate!, kind: "push", actor: who, detail: `commit ${String(commit.oid).slice(0, 9)} pushed to a fleet PR` });
  }
  if (n.state === "CLOSED") for (const e of n.timelineItems?.nodes ?? []) {
    const at = Date.parse(e.createdAt ?? "");
    if (Number.isFinite(at) && at >= sinceMs && e.actor?.login && !isFleetActor(e.actor.login)) out.push({ pr, at: e.createdAt!, kind: "close", actor: e.actor.login, detail: "a fleet PR was closed by a non-fleet actor" });
  }
  return out;
}

const FIX_LANE_PATHS = /^src\/(lib\/(sweep|fix-outcome|fix-progress-judge)\.ts|run-task\.ts)$|^src\/lib\/review.*accept/;

/** Reads operator interventions through the GitHub transport; any failed read is `ok: false` (unknown), never zero. */
export function readOperatorInterventions(sources: Pick<FixLaneSources, "owner" | "repo">, prs: readonly number[], sinceMs: number): InterventionRead {
  try {
    const found: OperatorIntervention[] = [];
    for (let offset = 0; offset < prs.length; offset += 25) {
      const batch = prs.slice(offset, offset + 25);
      const query = `query { repository(owner:${JSON.stringify(sources.owner)}, name:${JSON.stringify(sources.repo)}) { ${batch.map(pr =>
        `p${pr}:pullRequest(number:${pr}) { author { login } state commits(last:100) { nodes { commit { oid committedDate author { name user { login } } } } } timelineItems(itemTypes:[CLOSED_EVENT], last:5) { nodes { ... on ClosedEvent { createdAt actor { login } } } } }`).join(" ")} } }`;
      const body = JSON.parse(ghExec(["api", "graphql", "-f", `query=${query}`], { encoding: "utf8" }));
      const repository = body.data === undefined || body.data === null ? undefined : body.data.repository;
      if (body.errors || repository === undefined || repository === null) throw new Error("fix-lane PR interventions unreadable: GraphQL errors or no repository");
      for (const pr of batch) {
        const node = repository[`p${pr}`];
        if (node === undefined || node === null) throw new Error(`fix-lane PR #${pr} missing from the GraphQL answer`);
        found.push(...interventionsFromPullRequest(pr, node, sinceMs));
      }
    }
    const listed = JSON.parse(ghExec(["pr", "list", "--repo", `${sources.owner}/${sources.repo}`, "--state", "all", "--limit", "100",
      "--json", "number,headRefName,author,createdAt,files"], { encoding: "utf8" })) as Array<{ number: number; headRefName: string; author?: { login?: string }; createdAt: string; files?: Array<{ path: string }> }>;
    for (const p of listed) {
      if (!/^run-unfiled-\d+$/.test(p.headRefName) || isFleetActor(p.author?.login) || Date.parse(p.createdAt) < sinceMs) continue;
      const touched = (p.files ?? []).map(f => f.path).filter(f => FIX_LANE_PATHS.test(f));
      if (touched.length) found.push({ pr: p.number, at: p.createdAt, kind: "unfiled-pr", actor: p.author?.login ?? "unknown", detail: `an operator run-unfiled PR touches fix-lane code (${touched.join(", ")})` });
    }
    return { ok: true, interventions: found };
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error) };
  }
}

function summaryOf(inv: FixLaneInventory, now: number): string {
  const read = inv.interventions.read;
  const lines = [`# Fix-lane report — ${fixedClock(now).iso()}`, "",
    read.ok ? `Operator interventions in the window: ${inv.interventions.total} (target 0).` : `Operator interventions: UNKNOWN — ${read.reason}`, "",
    "| class | PR-hours | PRs | interventions | remedy |", "|---|---|---|---|---|"];
  for (const p of inv.priced) {
    const rung = inv.ladder.find(l => l.cause === p.key);
    lines.push(`| ${p.key} | ${p.hours.toFixed(2)} | ${p.prs} | ${inv.interventions.byClass.get(p.key) ?? 0} | ${rung ? `${rung.state} (rung ${rung.rung})` : "—"} |`);
  }
  return lines.join("\n") + "\n";
}

/** The fix-lane garden: once per UTC day, clusters the lane's defects and files one remedy for the top-priced class. */
export function fixLaneGardenSpec(deps: GardenerDeps, sources: FixLaneSources) {
  const clock = deps.clock ?? systemClock;
  return ladderGardenSpec(deps, {
    kind: FIX_LANE_LADDER, sources, bucket: c => Math.floor(c.now() / DAY),
    inventory: () => {
      const now = clock.now();
      const records = sources.ledgerRecords ? sources.ledgerRecords() : readLadderRecords(deps.stateDir, FIX_LANE_LADDER, STEPS);
      const plan = sources.planState ? sources.planState() : readLadderPlan(deps.repoRoot, FIX_LANE_LADDER);
      if (plan.degraded) deps.log("fix-lane.origins_degraded", { reason: plan.degraded });
      if (plan.unreadable?.length) throw new Error(`fix-lane plan shards unreadable: ${plan.unreadable.join(", ")}`);
      const sinceMs = now - FIX_LANE_WINDOW_MS;
      const native = readFixLaneEvidence(sources);
      const sourceCache = new Map<string, string | undefined>(), logCache = new Map<string, string | undefined>();
      const evidence: FixLaneEvidence = {
        readHeadSource: (head, file) => {
          const key = `${head}:${file}`;
          if (!sourceCache.has(key)) sourceCache.set(key, (sources.readHeadSource ?? native.readHeadSource)!(head, file));
          return sourceCache.get(key);
        },
        readCoverageLog: head => {
          if (!logCache.has(head)) logCache.set(head, (sources.readCoverageLog ?? native.readCoverageLog)!(head));
          return logCache.get(head);
        },
      };
      const events = defectEventsOf(records, now, evidence);
      const prs = [...new Set(events.filter(e => e.pr > 0 && e.at >= sinceMs).map(e => e.pr))];
      const openPrs = [...new Set(events.filter(e => e.pr > 0).map(e => e.pr))];
      const outcomes = sources.prOutcomes ? sources.prOutcomes(openPrs) : readOutcomes(openPrs, sources);
      const read = sources.interventions ? sources.interventions(prs, sinceMs) : readOperatorInterventions(sources, prs, sinceMs);
      return fixLaneInventoryOf(records, plan.tasks, outcomes, read, now, evidence);
    },
    onScorecard: (inv, scorecard) => {
      const full = inv as FixLaneInventory;
      const read = full.interventions.read;
      const now = clock.now();
      for (const p of inv.priced) {
        const rung = inv.ladder.find(l => l.cause === p.key);
        deps.log(FIXLANE_REPORT_STEP, { class: p.key, count: inv.episodes.filter(e => e.key === p.key).length, hours: p.hours, prs: p.prs,
          interventions: read.ok ? (full.interventions.byClass.get(p.key) ?? 0) : null,
          ...(read.ok ? {} : { interventions_unknown: read.reason }),
          open_remedy: rung && (rung.state === "in_progress" || rung.state === "measuring") ? rung.state : null, remedy_state: rung?.state ?? null });
      }
      deps.log(FIXLANE_REPORT_STEP, { class: null, classes: inv.priced.length, hours: scorecard.total_pr_hours, interventions: read.ok ? full.interventions.total : null,
        ...(read.ok ? {} : { interventions_unknown: read.reason }), next: scorecard.next });
      mkdirSync(deps.stateDir, { recursive: true });
      writeFileSync(join(deps.stateDir, FIXLANE_REPORT_FILE), summaryOf(full, now));
    },
  });
}
