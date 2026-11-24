import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import { buildFixProgressInput, resolveFixProgress, type FixProgressJudge } from "./fix-progress-judge.js";
import {
  CONFLICT_GARDEN_ACT, CONFLICT_GARDEN_TIERS, CONFLICT_GARDEN_VERIFIED, CONFLICT_GARDEN_WINDOW_MS,
  conflictGardenGovernorVerdict, type ConflictGardenTier,
} from "./conflict-gardener-governor.js";
type Row = Record<string, unknown>;
type Act =
  | { outcome: "no-op" | "deferred" | "round"; reason: string; newHead?: string; parentGreen?: boolean }
  | { outcome: "pushed"; reason: string; newHead: string; parentGreen?: boolean };
type Verification = { head?: string; outcome: "verified" | "pending" | "still-dirty" | "ci-red" | "reverted" | "superseded" };
export interface ConflictGardenPr {
  prNumber: number;
  headSha: string;
  taskId?: string;
  mergeState?: string;
  mergeableState?: string;
  mergeConflictSource?: string;
  checksState: string;
}

export interface ConflictGardenPorts<Pr extends ConflictGardenPr> {
  clock: Clock;
  snapshot: () => { prs: readonly Pr[]; mainSha: string | undefined };
  readLedger: () => Promise<readonly Row[]>;
  record: (row: Row & { step: string }) => void;
  dependents: (pr: Pr) => number;
  hold: (pr: Pr) => Promise<string | undefined>;
  staleSweepAct?: (pr: Pr) => Promise<boolean>;
  prepare: (pr: Pr, tier: ConflictGardenTier) => Promise<{ ready: true } | { ready: false; reason: string }>;
  act: (pr: Pr, tier: ConflictGardenTier, mainSha: string, approach?: string) => Promise<Act>;
  verify: (pr: Pr, receipt: Row, sawPushedHead: boolean) => Promise<Verification>;
  judge?: FixProgressJudge;
  escalate: (pr: Pr, reason: string) => Promise<void>;
  stopped?: (tier: ConflictGardenTier) => boolean;
}

export const CONFLICT_GARDEN_REPORT = "conflict_garden.report";
export const CONFLICT_GARDEN_JUDGED = "conflict_garden.judged";
export const CONFLICT_GARDEN_ESCALATED = "conflict_garden.escalated";
const stamp = (row: Row) => Date.parse(String(row.ts));

/** A new head ends an episode. Track GitHub and git independently when they disagree. */
function conflictHistory(rows: readonly Row[], now: number) {
  const active = new Map<number, { head: string; github?: number; git?: number }>();
  const completed: number[] = [];
  for (const row of rows) {
    if (typeof row.pr_number !== "number") continue;
    const n = row.pr_number;
    const ts = stamp(row);
    const probe = row.step === "sweep.merge_probe";
    const disposed = row.step === "sweep.disposed";
    const terminal = row.step === "pr.terminal";
    if ((!probe && !disposed && !terminal) || !Number.isFinite(ts) || ts > now) continue;
    const old = active.get(n);
    const started = old ? Math.min(old.github ?? Infinity, old.git ?? Infinity) : Infinity;
    if (terminal || (old && typeof row.head_sha === "string" && old.head !== row.head_sha)) {
      if (Number.isFinite(started) && ts > started) completed.push(ts - started);
      active.delete(n);
    }
    if (terminal || typeof row.head_sha !== "string") continue;
    const state = active.get(n) ?? { head: row.head_sha };
    if (probe && typeof row.main_sha === "string") {
      if (row.verdict === "conflict") state.git ??= ts;
      if (row.verdict === "clean") state.git = undefined;
    }
    if (disposed) {
      if (row.merge_state === "dirty" || row.blocker === "conflict") {
        const since = Date.parse(String(row.blocker_since));
        state.github ??= since <= ts ? since : ts;
      } else if (row.merge_state === "clean" || row.merge_state === "behind") state.github = undefined;
    }
    if (state.github === undefined && state.git === undefined) {
      if (old?.head === state.head && Number.isFinite(started) && ts > started) completed.push(ts - started);
      active.delete(n);
    } else active.set(n, state);
  }
  completed.sort((a, b) => a - b);
  return { active, p90: completed.length < 2 ? undefined : completed[Math.ceil(completed.length * 0.9) - 1] };
}

export async function runConflictGarden<Pr extends ConflictGardenPr>(ports: ConflictGardenPorts<Pr>): Promise<void> {
  const now = ports.clock.now();
  const cutoff = now - CONFLICT_GARDEN_WINDOW_MS;
  const readErrors: Row[] = [];
  const report: Row = { ranked: [], skipped: [], read_errors: readErrors };
  let found = false;
  const record = (row: Row & { step: string }) => ports.record({ ...row, ts: ports.clock.iso() });
  try {
    const { prs, mainSha } = ports.snapshot();
    const ledger = [...await ports.readLedger()].sort((a, b) => stamp(a) - stamp(b));
    const window = ledger.filter(row => stamp(row) >= cutoff && stamp(row) <= now);
    const { active, p90 } = conflictHistory(window, now);
    report.p90_ms = p90 ?? null;
    report.main_sha = mainSha ?? null;
    const byPr = new Map(prs.map(pr => [pr.prNumber, pr]));
    const acts = window.filter(row => row.step === CONFLICT_GARDEN_ACT);
    const verifications = new Map(window.filter(row => row.step === CONFLICT_GARDEN_VERIFIED).map(row => [row.act_id, row]));
    const waiting = new Set<number>();
    const approaches = new Map<number, string>();
    const outcomes = new Map(window.filter(row => row.step === CONFLICT_GARDEN_JUDGED).map(row => [row.act_id, row]));
    const escalated = new Set(ledger.filter(row => row.step === CONFLICT_GARDEN_ESCALATED).map(row => `${row.pr_number}@${row.head_sha}`));

    const verify = async (pr: Pr, receipt: Row) => {
      const prior = verifications.get(receipt.act_id);
      if (typeof receipt.new_head_sha !== "string") return { outcome: "pending" } as const;
      if (prior && (prior.outcome === "reverted" || prior.outcome === "superseded")) return prior;
      const sawPushedHead = prior?.saw_pushed_head === true || prior?.observed_head_sha === receipt.new_head_sha;
      const observation = await ports.verify(pr, receipt, sawPushedHead);
      const seen: Verification = observation.head !== receipt.new_head_sha &&
        ["verified", "ci-red", "still-dirty"].includes(observation.outcome)
        ? { outcome: "pending", head: observation.head } : observation;
      const harmful = seen.outcome === "reverted" || (seen.outcome === "ci-red" && receipt.parent_green === true);
      if (prior?.outcome !== seen.outcome || prior.observed_head_sha !== seen.head) {
        const row = { step: CONFLICT_GARDEN_VERIFIED, act_id: receipt.act_id, tier: receipt.tier,
          pr_number: pr.prNumber, head_sha: receipt.new_head_sha, observed_head_sha: seen.head,
          outcome: seen.outcome, harmful: harmful || prior?.harmful === true,
          saw_pushed_head: sawPushedHead || seen.head === receipt.new_head_sha, ts: ports.clock.iso() };
        record(row);
        window.push(row);
        verifications.set(row.act_id, row);
        found = true;
      }
      return seen;
    };
    const judge = async (pr: Pr, receipt: Row, observed: unknown) => {
      if (receipt.tier === "deterministic" || receipt.outcome !== "round") return;
      const headSha = typeof receipt.new_head_sha === "string" ? receipt.new_head_sha : String(receipt.head_sha);
      const key = `${pr.prNumber}@${headSha}`;
      const prior = outcomes.get(receipt.act_id);
      let decision = prior;
      if (!prior || prior.verdict === "unavailable") {
        const { decision: answer } = await resolveFixProgress({
          ...buildFixProgressInput({ taskId: pr.taskId, prNumber: pr.prNumber, headSha,
            currentRed: ["merge-conflict"], ledger }),
          remedyHistory: acts.filter(row => row.pr_number === pr.prNumber)
            .map(row => ({ ...row, verification: verifications.get(row.act_id)?.outcome })),
        }, ledger, { judge: ports.judge });
        decision = answer;
        if (prior?.verdict !== answer.verdict || prior.reason !== answer.reason) {
          record({ step: CONFLICT_GARDEN_JUDGED, act_id: receipt.act_id, pr_number: pr.prNumber, head_sha: headSha, ...answer });
          found = true;
        }
      }
      if (decision?.verdict === "unavailable" && (pr.headSha === headSha || pr.headSha === receipt.head_sha)) waiting.add(pr.prNumber);
      if (decision?.verdict === "change-approach" && typeof decision.approach === "string") approaches.set(pr.prNumber, decision.approach);
      const canEscalate = receipt.new_head_sha === undefined || observed === "still-dirty" || observed === "ci-red";
      if (decision?.verdict === "escalate" && canEscalate && !escalated.has(key) && pr.headSha === headSha) {
        const reason = String(decision.reason);
        await ports.escalate(pr, reason);
        record({ step: CONFLICT_GARDEN_ESCALATED, pr_number: pr.prNumber, head_sha: headSha, reason });
        escalated.add(key);
        found = true;
        waiting.add(pr.prNumber);
      }
    };
    for (const receipt of acts) {
      if (typeof receipt.pr_number !== "number") continue;
      const pr = byPr.get(receipt.pr_number);
      if (!pr) continue;
      try {
        const seen = await verify(pr, receipt);
        if (typeof receipt.new_head_sha === "string" && seen.outcome === "pending" &&
            (pr.headSha === receipt.new_head_sha || pr.headSha === receipt.head_sha)) waiting.add(pr.prNumber);
        await judge(pr, receipt, seen.outcome);
      } catch (error) {
        waiting.add(pr.prNumber);
        readErrors.push({ pr_number: pr.prNumber, act_id: receipt.act_id, reason: String(error) });
      }
    }
    const ranked: { pr: Pr; age: number; dependents: number }[] = [];
    const skipped: { pr_number: number; reason: string }[] = [];
    report.skipped = skipped;
    for (const pr of prs) {
      const atHead = (row: Row) => row.pr_number === pr.prNumber && row.head_sha === pr.headSha;
      const probe = mainSha === undefined ? undefined : window.findLast(row =>
        row.step === "sweep.merge_probe" && atHead(row) && row.main_sha === mainSha);
      const github = pr.mergeableState === "dirty" || (pr.mergeableState === undefined && pr.mergeState === "dirty" &&
        pr.mergeConflictSource !== "merge-probe" && pr.mergeConflictSource !== "inherited");
      if (!github && probe?.verdict !== "conflict") continue;
      const episode = active.get(pr.prNumber);
      const start = episode?.head === pr.headSha
        ? Math.min(github ? episode.github ?? now : now, probe?.verdict === "conflict" ? episode.git ?? now : now)
        : now;
      const age = now - start;
      const acted = window.some(row => row.step === "sweep.disposed" && atHead(row) && row.acted === true && stamp(row) >= start);
      let reason: string | undefined;
      try {
        reason = p90 !== undefined && age <= p90 ? "conflict age is within the measured p90"
          : waiting.has(pr.prNumber) ? "awaiting verification or judgment"
          : escalated.has(`${pr.prNumber}@${pr.headSha}`) ? "already escalated at this head"
          : acted && !await ports.staleSweepAct?.(pr) ? "sweep acted at this head" : await ports.hold(pr);
      } catch (error) {
        reason = `conflict eligibility unreadable: ${String(error)}`;
      }
      if (reason) skipped.push({ pr_number: pr.prNumber, reason });
      else ranked.push({ pr, age, dependents: ports.dependents(pr) });
    }
    ranked.sort((a, b) => b.age - a.age || b.dependents - a.dependents || a.pr.prNumber - b.pr.prNumber);
    report.ranked = ranked.map(({ pr }) => pr.prNumber);
    report.blocked_pr_hours = ranked.map(({ pr, age }) => ({ pr_number: pr.prNumber, hours: age / 3_600_000 }));
    if (mainSha === undefined) return;
    // Start with one PR. Increase only with successful, distinct pushed heads in the evidence window.
    const verified = new Set(window.filter(row => row.step === CONFLICT_GARDEN_VERIFIED &&
      row.outcome === "verified" && row.harmful !== true).map(row => row.head_sha)).size;
    const budget = 1 + Math.floor(Math.sqrt(verified));
    let consumed = 0;
    for (const { pr } of ranked) {
      if (consumed >= budget) break;
      let attempted = false;
      for (const tier of CONFLICT_GARDEN_TIERS) {
        if (tier === "deterministic" && acts.some(row => row.pr_number === pr.prNumber && row.head_sha === pr.headSha &&
          row.main_sha === mainSha && row.tier === tier && row.outcome === "no-op")) continue;
        const prepared = await ports.prepare(pr, tier).catch(error => ({ ready: false as const, reason: String(error) }));
        if (!prepared.ready) {
          skipped.push({ pr_number: pr.prNumber, reason: `${tier}: ${prepared.reason}` });
          continue;
        }
        const verdict = conflictGardenGovernorVerdict(tier, window, { nowMs: ports.clock.now(), prNumber: pr.prNumber });
        if (verdict.tier === "stopped" || verdict.tier === "slow" || ports.stopped?.(tier)) {
          skipped.push({ pr_number: pr.prNumber, reason: `${tier}: ${verdict.tier === "live" || verdict.tier === "shadow"
            ? "the daemon governor withheld the tier" : verdict.reason}` });
          break;
        }
        let act: Act | { outcome: "shadow"; reason: string };
        if (verdict.tier === "shadow") act = { outcome: "shadow", reason: `would run ${tier}: ${verdict.reason}` };
        else act = await ports.act(pr, tier, mainSha, approaches.get(pr.prNumber))
          .catch(error => ({ outcome: "deferred" as const, reason: String(error) }));
        const moved = "newHead" in act ? act.newHead : undefined;
        const receipt = {
          step: CONFLICT_GARDEN_ACT, act_id: randomUUID(), pr_number: pr.prNumber, head_sha: pr.headSha,
          main_sha: mainSha, tier, outcome: act.outcome, reason: act.reason, new_head_sha: moved,
          parent_green: "parentGreen" in act && act.parentGreen === true, ts: ports.clock.iso(),
        };
        record(receipt);
        acts.push(receipt);
        window.push(receipt);
        found = attempted = true;
        try {
          const seen = await verify(pr, receipt);
          await judge(pr, receipt, seen.outcome);
        } catch (error) {
          readErrors.push({ pr_number: pr.prNumber, act_id: receipt.act_id, reason: String(error) });
        }
        if (act.outcome !== "no-op") break;
      }
      if (attempted) consumed++;
    }
  } catch (error) {
    const reason = String(error);
    report.error = reason;
  } finally {
    record({ step: CONFLICT_GARDEN_REPORT, ...report, new_evidence: found });
  }
}
