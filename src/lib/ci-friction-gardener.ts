import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { startGarden } from "./gardener.js";
import { writeAtomic } from "./fs-race-safe.js";
import { gateFireRatesPath, type GateFireRateReport } from "./gate-fire-rate.js";
import { ledgerLivePath } from "./ledger-union.js";
import { loadPlanFromYaml } from "./plan.js";
import { lintTask } from "./task-linter.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import type { LedgerRecord } from "./retro.js";

/**
 * lib/ci-friction-gardener.ts (W1-T4435) — the fleet prices its own slowest gate.
 *
 * INVARIANT: every cause is ranked by PR MINUTES LOST, never fire count — a frequent one-minute
 * check must never outrank a rare 25-minute one (this module's own falsifier). gate-gardener
 * (W1-T4116) already counts how often each gate fires; it never prices a fire in PR time.
 *
 * FOUR CAUSE KINDS, priced from what the fleet already measures — no new GitHub calls: `check`
 * (a red gate's own minutes, from gate-fire-rate.ts's persisted report, W1-T4115); `main_merge`
 * (a `fix.base_refreshed` round — GitHub auto-merging main in, named by the shared file it
 * blames); `conflict` (a `fix.dispatch` round whose `mode` is `"merge-conflict"`); `fix_refusal`
 * (a round whose `fix.commit_refused` fired — the harness refused that round's commit, so it
 * bought no progress; design point (iv)). Each ledger round's minutes are the wall-clock gap
 * since the run's PREVIOUS round (or its `pr.opened`) — every row already carries `ts`.
 *
 * ONE class, `draft` (a `review` class, gardener.ts): the costliest cause with no queued task
 * already tracking it (`origin: ci-friction:<cause>`) is filed as a parked, `verify: human`,
 * `author_class: machine` task, same idempotency shape as measurement-cadence.ts's CI-learning
 * rung, judged by whether its PR merges. The SAME pass appends a row to
 * {@link CI_FRICTION_GARDEN_LOG} so the trend reads as the total moving (design point (iii)).
 */

// ── Pricing: rounds → causes, never fire count ──────────────────────────────────────────────

export type CiFrictionCauseKind = "check" | "main_merge" | "conflict" | "fix_refusal";

export interface CiFrictionCause {
  kind: CiFrictionCauseKind;
  name: string;
}

/** The one key every idempotency and ranking lookup uses. */
export function ciFrictionCauseKey(c: CiFrictionCause): string {
  return `${c.kind}:${c.name}`;
}

/** One extra-head round, already attributed to a cause and priced in PR minutes. */
export interface CiFrictionRound {
  pr: number;
  cause: CiFrictionCause;
  minutes: number;
}

export interface CiFrictionCausePrice {
  cause: CiFrictionCause;
  /** PR minutes lost to this cause — the ONLY field this module ranks by. */
  minutes: number;
  /** How often it fired — reported for context; ranking by this instead of minutes is the
   *  falsifier: a frequent one-minute check must never outrank a rare 25-minute one. */
  rounds: number;
  prs: number;
}

/** Sum priced rounds and a gate-fire-rate report into one row per cause, ranked by MINUTES. */
export function priceCiFrictionCauses(
  ledgerRounds: readonly CiFrictionRound[],
  gateFireRates?: GateFireRateReport,
): CiFrictionCausePrice[] {
  const rows = new Map<string, { cause: CiFrictionCause; minutes: number; rounds: number; prSet: Set<number>; prs: number }>();
  for (const r of ledgerRounds) {
    const key = ciFrictionCauseKey(r.cause);
    const row = rows.get(key) ?? { cause: r.cause, minutes: 0, rounds: 0, prSet: new Set<number>(), prs: 0 };
    row.minutes += r.minutes;
    row.rounds += 1;
    row.prSet.add(r.pr);
    rows.set(key, row);
  }
  if (gateFireRates?.status === "measured") {
    for (const g of gateFireRates.gates) {
      if (g.minutes <= 0) continue;
      const cause: CiFrictionCause = { kind: "check", name: g.gate };
      rows.set(ciFrictionCauseKey(cause), { cause, minutes: g.minutes, rounds: g.redRuns, prSet: new Set(), prs: g.prs });
    }
  }
  return [...rows.values()]
    .map(({ cause, minutes, rounds, prSet, prs }) => ({
      cause,
      minutes: Math.round(minutes * 10) / 10,
      rounds,
      prs: prSet.size > 0 ? prSet.size : prs,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.rounds - a.rounds);
}

// ── Loading rounds from the ledger union ────────────────────────────────────────────────────

const PR_URL_RE = /\/pull\/(\d+)(?:[/?#].*)?$/;

function prNumberFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") return undefined;
  const m = PR_URL_RE.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** `run_id -> pull request number`, from `pr.opened` — every implement/fix run logs it once, the
 *  moment the pull request the fix rung's rounds belong to exists. A run this cannot attribute
 *  contributes no rounds, never a guessed pull request. */
export function runPrIndex(records: readonly LedgerRecord[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "pr.opened" || typeof r.run_id !== "string") continue;
    const pr = prNumberFromUrl(r.pr_url);
    if (pr !== undefined && !index.has(r.run_id)) index.set(r.run_id, pr);
  }
  return index;
}

const minutesBetween = (fromIso: unknown, toIso: unknown): number | undefined => {
  if (typeof fromIso !== "string" || typeof toIso !== "string") return undefined;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : undefined;
};

function causeFromDispatchMode(mode: unknown): CiFrictionCause {
  return mode === "merge-conflict" ? { kind: "conflict", name: "merge-conflict" } : { kind: "check", name: typeof mode === "string" ? mode : "unknown" };
}

interface RoundBoundary {
  ts: string;
  round?: number;
  cause: CiFrictionCause;
}

/**
 * Every `fix.dispatch` / `fix.base_refreshed` round, attributed to a cause and priced by the
 * wall-clock minutes since the run's previous round (or its `pr.opened`, for the first). A round
 * whose own `fix.commit_refused` fired is priced as `fix_refusal` instead of whatever triggered it
 * — the harness bought no progress that round, which is the waste design point (iv) asks for.
 */
export function ciFrictionRoundsFromLedger(records: readonly LedgerRecord[]): CiFrictionRound[] {
  const prByRun = runPrIndex(records);
  const refusedRounds = new Map<string, Set<number>>();
  for (const r of records) {
    if (r.step === "fix.commit_refused" && typeof r.run_id === "string" && typeof r.round === "number") {
      const set = refusedRounds.get(r.run_id) ?? new Set<number>();
      set.add(r.round);
      refusedRounds.set(r.run_id, set);
    }
  }
  const byRun = new Map<string, RoundBoundary[]>();
  const opens = new Map<string, string>();
  for (const r of records) {
    if (typeof r.run_id !== "string" || typeof r.ts !== "string") continue;
    if (r.step === "pr.opened" && !opens.has(r.run_id)) {
      opens.set(r.run_id, r.ts);
      continue;
    }
    if (r.step === "fix.dispatch") {
      const round = typeof r.round === "number" ? r.round : undefined;
      const refused = round !== undefined && refusedRounds.get(r.run_id)?.has(round);
      const cause: CiFrictionCause = refused ? { kind: "fix_refusal", name: "commit_refused" } : causeFromDispatchMode(r.mode);
      const list = byRun.get(r.run_id) ?? [];
      list.push({ ts: r.ts, round, cause });
      byRun.set(r.run_id, list);
    } else if (r.step === "fix.base_refreshed") {
      const files = Array.isArray(r.matching_base_files) ? (r.matching_base_files as unknown[]).filter((f): f is string => typeof f === "string") : [];
      const list = byRun.get(r.run_id) ?? [];
      list.push({ ts: r.ts, cause: { kind: "main_merge", name: files[0] ?? "main" } });
      byRun.set(r.run_id, list);
    }
  }
  const rounds: CiFrictionRound[] = [];
  for (const [runId, list] of byRun) {
    const pr = prByRun.get(runId);
    if (pr === undefined) continue;
    const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    let prevTs = opens.get(runId) ?? sorted[0]?.ts;
    for (const boundary of sorted) {
      const minutes = minutesBetween(prevTs, boundary.ts);
      if (minutes !== undefined) rounds.push({ pr, cause: boundary.cause, minutes });
      prevTs = boundary.ts;
    }
  }
  return rounds;
}

/** The persisted gate-fire-rate report (W1-T4115) — `undefined` when it has never been measured,
 *  never a guessed report. */
export function readGateFireRateReport(stateDir: string): GateFireRateReport | undefined {
  const p = gateFireRatesPath(stateDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GateFireRateReport;
  } catch {
    // deliberate: an unreadable report prices zero check causes this pass, never a fabricated one.
    return undefined;
  }
}

// ── Drafting the costliest untracked cause ──────────────────────────────────────────────────

/** The idempotency key a filed task's `origin:` carries — matched against every `origin:` the plan
 *  already holds so a tracked cause is never re-drafted. */
export function ciFrictionOrigin(cause: CiFrictionCause): string {
  return `ci-friction:${ciFrictionCauseKey(cause)}`;
}

/** The costliest priced cause with no queued task already tracking it — `undefined` when every
 *  measured cause already has one, which proposes nothing rather than a duplicate. */
export function costliestUntrackedCause(priced: readonly CiFrictionCausePrice[], planOrigins: readonly string[]): CiFrictionCausePrice | undefined {
  const held = new Set(planOrigins);
  return priced.find((p) => !held.has(ciFrictionOrigin(p.cause)));
}

/** Where a person records that a drafted cause's remedy landed — a task's acceptance proof points
 *  here, and the file need not exist yet at filing time (an absent path is simply no match). */
export const CI_FRICTION_REMEDIES_FILE = "docs/ci-friction-remedies.md";
export const CI_FRICTION_GARDEN_LOG = "docs/ci-friction-garden-log.md";
const CI_FRICTION_SLUG_MAX = 72;

/** Render ONE draft as a single-element YAML task list — the shard file's whole contents. */
export function ciFrictionShardYaml(price: CiFrictionCausePrice, taskId: string): string {
  const q = (v: string) => JSON.stringify(v);
  const key = ciFrictionCauseKey(price.cause);
  const origin = ciFrictionOrigin(price.cause);
  const title = `THE CI FRICTION GARDENER'S COSTLIEST UNTRACKED CAUSE — ${key} cost ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s), and nothing tracks it`;
  return [
    `- id: ${taskId}`,
    `  title: ${q(title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    // PARKED: isDispatchEligible refuses `verify !== "auto"`, so this waits for a person.
    "  verify: human",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    // LAW 5: the author class rides the record.
    "  author_class: machine",
    `  origin: ${q(origin)}`,
    "  files:",
    `    - ${CI_FRICTION_REMEDIES_FILE}`,
    "  acceptance:",
    `    - claim: ${q(`the ${key} cause of PR friction has a recorded remedy`)}`,
    `      proof: ${q(`grep: ${origin} in ${CI_FRICTION_REMEDIES_FILE}`)}`,
    `  note: ${q(`Filed by the ci-friction gardener (W1-T4435) from a weekly pass over the ledger and gate-fire-rate.ts's own measurement. ${key} priced at ${price.minutes} PR minute(s) across ${price.rounds} round(s) on ${price.prs} pull request(s) — the costliest cause with no open task. MACHINE-AUTHORED AND PARKED — a person decides the remedy, and records it in ${CI_FRICTION_REMEDIES_FILE} naming "${origin}" once it lands.`)}`,
    "",
  ].join("\n");
}

/** Parse rendered shard bytes back and lint them — a record this rung cannot get past the repo's
 *  own linter must never reach the disk. */
export function ciFrictionRecordVerdict(contents: string, label: string): { ok: boolean; reason: string } {
  try {
    const task = loadPlanFromYaml(contents, label).tasks[0];
    const lint = lintTask(task);
    return lint.ok ? { ok: true, reason: "" } : { ok: false, reason: lint.violations.map((v) => `${v.severity}:${v.check}`).join(", ") };
  } catch (e) {
    return { ok: false, reason: `unparseable: ${(e as Error).message}` };
  }
}

/** One row for {@link CI_FRICTION_GARDEN_LOG}: the total priced this pass and its costliest cause,
 *  so an improvement is visible as the total moving, not just the newest draft. */
export function ciFrictionTrendRow(atIso: string, priced: readonly CiFrictionCausePrice[]): string {
  const total = Math.round(priced.reduce((s, p) => s + p.minutes, 0) * 10) / 10;
  const top = priced[0];
  return `| ${atIso} | ${total} | ${top ? `${ciFrictionCauseKey(top.cause)} (${top.minutes}m)` : "none"} |`;
}

// ── The gardener spec ────────────────────────────────────────────────────────────────────────

export type CiFrictionGardenClass = "draft";
export const CI_FRICTION_GARDEN_CLASSES: readonly CiFrictionGardenClass[] = ["draft"];

export interface CiFrictionGardenAction extends GardenAction<CiFrictionGardenClass> {
  price: CiFrictionCausePrice;
  origin: string;
}

export interface CiFrictionInventory {
  priced: CiFrictionCausePrice[];
  untracked?: CiFrictionCausePrice;
}

export interface CiFrictionGardenerDeps extends GardenerDeps {
  /** The ledger union's own records — read once per pass, never parsed twice for one tick. */
  ledgerRecords: () => readonly LedgerRecord[];
  gateFireRates?: () => GateFireRateReport | undefined;
  /** Every `origin:` the plan already holds. */
  planOrigins: () => readonly string[];
  /** THE RESERVATION PATH (task-id-reservation.ts via `ciLearningTaskIdMinter`, run-task.ts),
   *  never `max(id)+1` — see that minter's own doc for why. */
  mintTaskId: () => string;
}

function draftCandidates(inv: CiFrictionInventory): CiFrictionGardenAction[] {
  if (!inv.untracked) return [];
  const cause = inv.untracked.cause;
  return [
    {
      class: "draft",
      target: ciFrictionCauseKey(cause),
      origin: ciFrictionOrigin(cause),
      price: inv.untracked,
      reason: `${ciFrictionCauseKey(cause)} cost ${inv.untracked.minutes} PR minute(s) across ${inv.untracked.rounds} round(s) on ${inv.untracked.prs} pull request(s) — the costliest cause with no open task.`,
    },
  ];
}

/** The repo's own CI friction as a gardener spec (gardener.ts, W1-T4110). */
export function ciFrictionGardenSpec(deps: CiFrictionGardenerDeps): GardenSpec<CiFrictionGardenClass, CiFrictionInventory, CiFrictionGardenAction, GardenCheckout> {
  const clock: Clock = deps.clock ?? systemClock;
  return {
    name: "ci-friction",
    classes: CI_FRICTION_GARDEN_CLASSES,
    review: { draft: "filing a new task from priced friction is a judgement call — a person decides the remedy." },
    cheapFingerprint: () => {
      const head = execFileSync("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const live = ledgerLivePath(deps.stateDir);
      const size = existsSync(live) ? statSync(live).size : 0;
      const report = gateFireRatesPath(deps.stateDir);
      return `${head}:${size}:${existsSync(report) ? statSync(report).size : 0}`;
    },
    inventory: () => {
      const rounds = ciFrictionRoundsFromLedger(deps.ledgerRecords());
      const priced = priceCiFrictionCauses(rounds, deps.gateFireRates?.());
      return { priced, untracked: costliestUntrackedCause(priced, deps.planOrigins()) };
    },
    fingerprint: (inv) => `${inv.priced.map((p) => `${ciFrictionCauseKey(p.cause)}:${p.minutes}`).join(",")}|${inv.untracked ? ciFrictionCauseKey(inv.untracked.cause) : ""}`,
    candidates: (inv) => draftCandidates(inv),
    scorecard: (inv) => ({
      causes: inv.priced.length,
      total_minutes: Math.round(inv.priced.reduce((s, p) => s + p.minutes, 0) * 10) / 10,
      untracked: inv.untracked ? ciFrictionCauseKey(inv.untracked.cause) : null,
      priced: inv.priced,
    }),
    apply: (ws, plan, scorecard) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      const taskId = deps.mintTaskId();
      const contents = ciFrictionShardYaml(action.price, taskId);
      const verdict = ciFrictionRecordVerdict(contents, `ci-friction:${taskId}`);
      if (!verdict.ok) throw new Error(`ci-friction gardener: drafted record failed lint (${verdict.reason})`);
      const stem = kebabSlug(ciFrictionCauseKey(action.price.cause), CI_FRICTION_SLUG_MAX).replace(/-+$/, "");
      const relPath = `plan/tasks.d/${taskId}${stem ? `-${stem}` : ""}.yaml`;
      mkdirSync(join(ws.root, "plan", "tasks.d"), { recursive: true });
      writeFileSync(join(ws.root, relPath), contents);

      const heading = `## Pass ${clock.iso()}`;
      const priced = (scorecard.priced as CiFrictionCausePrice[] | undefined) ?? [action.price];
      const row = ciFrictionTrendRow(clock.iso(), priced);
      const logPath = join(ws.root, CI_FRICTION_GARDEN_LOG);
      const prior = existsSync(logPath)
        ? readFileSync(logPath, "utf8")
        : "# CI friction garden log\n\nEach row is one weekly pass of the ci-friction gardener (W1-T4435): the total\nPR minutes it priced across every cause, and the costliest one.\n\n| pass | total PR minutes | costliest cause |\n| --- | --- | --- |\n";
      writeAtomic(logPath, prior.replace(/\n*$/, "\n") + row + "\n");

      const body = [
        "The ci-friction gardener (W1-T4435) prices CI-round causes in PR minutes, ranked by minutes lost — never fire count.",
        "",
        `- **draft** \`${action.target}\`: ${action.reason}`,
        "",
        "## Acceptance",
        `- claim: this pass is recorded in the ci-friction garden log`,
        `  proof: grep: ^${heading}$|${row.replace(/[|]/g, "\\|")} in ${CI_FRICTION_GARDEN_LOG}`,
        `- claim: the costliest untracked cause is filed as a parked task`,
        `  proof: grep: ${action.origin} in ${relPath}`,
      ].join("\n");
      return { paths: [relPath, CI_FRICTION_GARDEN_LOG], title: `chore(plan): the ci-friction gardener drafts a fix for ${action.target}`, body };
    },
  };
}

/** Run ci-friction gardener passes on their own timer (gardener.ts's `startGarden`). */
export function startCiFrictionGardener(deps: CiFrictionGardenerDeps, intervalMs: number): { stop: () => void } {
  return startGarden(ciFrictionGardenSpec(deps), deps, intervalMs);
}
