import { buildFixProgressInput, resolveFixProgress, type FixProgressJudge } from "./fix-progress-judge.js";
import type { OpenPrView } from "./sweep.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";
import {
  CONFLICT_GARDEN_TIERS, CONFLICT_GARDEN_WINDOW_MS, conflictGardenGovernorVerdict, conflictP90, conflictRowTime,
  type ConflictGardenControls, type ConflictGardenRow, type ConflictGardenTier, type ConflictGardenAct,
} from "./conflict-gardener-governor.js";
export type { ConflictGardenAct } from "./conflict-gardener-governor.js";
/** BACKSTOP: bound untrusted intent evidence before it reaches the fix prompt. */
export const CONFLICT_GARDEN_INTENT_CHARS = 16_000;
export interface ConflictGardenVerification {
  headSha: string; mergeableState?: string; checksState: "green" | "red" | "pending" | "none"; reverted?: boolean;
}
export interface ConflictGardenPorts {
  now: () => number;
  runId: string;
  snapshot: () => Promise<{ prs: OpenPrView[]; mainSha: string }>;
  ledger: () => Promise<ConflictGardenRow[]>;
  log: (step: string, fields: ConflictGardenRow) => void;
  skip: (pr: OpenPrView, rows: readonly ConflictGardenRow[]) => Promise<string | undefined>;
  dependents: (pr: OpenPrView) => number;
  act: (pr: OpenPrView, tier: ConflictGardenTier, mainSha: string, approach?: string) => Promise<ConflictGardenAct>;
  verify: (pr: Pick<OpenPrView, "prNumber" | "prUrl" | "headSha">, act?: ConflictGardenRow) => Promise<ConflictGardenVerification>;
  judge?: FixProgressJudge;
  controls?: () => ConflictGardenControls;
  escalate: (pr: OpenPrView, reason: string) => Promise<string | undefined>;
}

/** Archives are immutable; repeated daemon ticks read only new live evidence. */
export function conflictGardenLedgerReader(stateDir: string, governorOnly = false): () => Promise<ConflictGardenRow[]> {
  const keep = (row: ConflictGardenRow) => typeof row.step === "string" &&
    (row.step.startsWith("conflict_garden.") || !governorOnly &&
      ["sweep.", "fix.", "review.", "run_child.", "daemon.", "automerge.", "pr."].some(prefix => String(row.step).startsWith(prefix)));
  const memo = createLedgerRotationMemo(rows => rows.filter(keep), { holder: governorOnly ? "conflict-governor" : "conflict-garden" });
  return async () => {
    const read = await readLedgerUnionRecordsMemoized(stateDir, memo, { refuseIncomplete: true });
    if (!read.ok) throw new Error(`conflict garden ledger incomplete: ${read.unread.join(", ")}`);
    return read.rows.filter(keep);
  };
}

function episodes(rows: readonly ConflictGardenRow[]) {
  const active = new Map<number, { head: unknown; start: number }>();
  const durations: number[] = [];
  for (const r of rows) {
    if (typeof r.pr_number !== "number" || !Number.isFinite(conflictRowTime(r))) continue;
    const dirty = r.step === "sweep.merge_probe" && r.verdict === "conflict" ||
      r.step === "sweep.disposed" && (r.disposition === "conflicted" || r.merge_state === "dirty");
    const cleared = r.step === "sweep.merge_probe" && r.verdict === "clean" ||
      r.step === "sweep.disposed" && (["clean", "behind"].includes(String(r.merge_state)) ||
        ["mergeable", "post-review", "armed"].includes(String(r.disposition))) || r.step === "pr.terminal";
    const before = active.get(r.pr_number);
    if (before && (cleared || dirty && before.head !== r.head_sha)) {
      durations.push(conflictRowTime(r) - before.start);
      active.delete(r.pr_number);
    }
    if (dirty && !active.has(r.pr_number)) active.set(r.pr_number, { head: r.head_sha, start: conflictRowTime(r) });
  }
  return { active, durations };
}

export function conflictGardenCandidates(prs: readonly OpenPrView[], rows: readonly ConflictGardenRow[], mainSha: string, now: number) {
  const recent = rows.filter(r => conflictRowTime(r) >= now - CONFLICT_GARDEN_WINDOW_MS && conflictRowTime(r) <= now)
    .sort((a, b) => conflictRowTime(a) - conflictRowTime(b));
  const record = episodes(recent);
  const p90 = record.durations.length < 2 ? undefined : conflictP90(record.durations);
  const observed: number[] = [];
  const candidates = prs.flatMap(pr => {
    const probe = recent.findLast(r => r.step === "sweep.merge_probe" && r.pr_number === pr.prNumber &&
      r.head_sha === pr.headSha && r.main_sha === mainSha);
    if (pr.mergeState !== "dirty" && pr.mergeableState !== "dirty" && pr.mergeable !== false && probe?.verdict !== "conflict") return [];
    observed.push(pr.prNumber);
    const episode = record.active.get(pr.prNumber);
    const start = episode?.head === pr.headSha ? episode.start : now;
    const age = now - start;
    if (p90 !== undefined && age <= p90) return [];
    return [{ pr, start, blockedHours: age / 3_600_000 }];
  });
  return { candidates, p90, observed };
}

async function verifyAct(ports: ConflictGardenPorts, pr: Pick<OpenPrView, "prNumber" | "prUrl" | "headSha">, act: ConflictGardenRow): Promise<ConflictGardenRow> {
  const observed = await ports.verify(pr, act);
  const current = observed.headSha === act.new_head_sha;
  const outcome = !current || !observed.mergeableState || observed.mergeableState === "unknown" ? "pending"
    : observed.mergeableState === "dirty" ? "still-dirty" : observed.checksState === "red" ? "ci-red"
      : observed.checksState === "green" ? "verified" : "pending";
  const row = { ...act, ts: new Date(ports.now()).toISOString(), step: "conflict_garden.verified", outcome,
    observed_head_sha: observed.headSha, mergeable_state: observed.mergeableState,
    checks_state: observed.checksState, reverted: observed.reverted === true };
  ports.log(row.step, row);
  return row;
}

/** One pass yields when a judge is unavailable; no retry counter can escalate a conflict. */
export async function runConflictGarden(ports: ConflictGardenPorts): Promise<void> {
  const report: ConflictGardenRow = { ranked: [], skipped: [], acts: 0 };
  try {
    const now = ports.now();
    const { prs, mainSha } = await ports.snapshot();
    const rows = (await ports.ledger()).sort((a, b) => conflictRowTime(a) - conflictRowTime(b));
    const record = (step: string, fields: ConflictGardenRow) => {
      const row = { ts: new Date(ports.now()).toISOString(), ...fields, step };
      ports.log(step, row);
      rows.push(row);
      return row;
    };
    for (const act of rows.filter(r => r.step === "conflict_garden.act" && r.mode === "live" && typeof r.new_head_sha === "string" &&
      conflictRowTime(r) >= now - CONFLICT_GARDEN_WINDOW_MS)) {
      const latest = rows.findLast(r => r.step === "conflict_garden.verified" && r.act_id === act.act_id);
      if (latest?.reverted === true) continue;
      const pr = prs.find(p => p.prNumber === act.pr_number) ?? (typeof act.pr_url === "string" && typeof act.pr_number === "number"
        ? { prNumber: act.pr_number, prUrl: act.pr_url, headSha: String(act.head_sha) } : undefined);
      if (pr) rows.push(await verifyAct(ports, pr, act));
    }
    const { candidates, p90, observed } = conflictGardenCandidates(prs, rows, mainSha, now);
    report.p90_ms = p90 ?? null;
    report.observed = observed;
    const ranked = [];
    const skipped: { pr_number: number; reason: string }[] = [];
    for (const c of candidates) {
      const reason = await ports.skip(c.pr, rows) ?? (rows.some(r => r.step === "sweep.disposed" &&
        r.pr_number === c.pr.prNumber && r.head_sha === c.pr.headSha && r.acted === true &&
        conflictRowTime(r) >= Math.max(c.start, now - (p90 ?? 0)))
        ? "sweep acted at this head" : undefined);
      if (reason) skipped.push({ pr_number: c.pr.prNumber, reason });
      else ranked.push(c);
    }
    ranked.sort((a, b) => b.blockedHours - a.blockedHours || ports.dependents(b.pr) - ports.dependents(a.pr) || a.pr.prNumber - b.pr.prNumber);
    report.ranked = ranked.map(c => ({ pr_number: c.pr.prNumber, blocked_pr_hours: c.blockedHours }));
    report.skipped = skipped;
    // EARNED BOUND: one PR initially, widened only by distinct verified repairs in this window.
    const verified = new Set(rows.filter(r => r.step === "conflict_garden.verified" && r.outcome === "verified" &&
      conflictRowTime(r) >= now - CONFLICT_GARDEN_WINDOW_MS).map(r => r.pr_number));
    for (const { pr } of ranked.slice(0, Math.max(1, verified.size))) {
      if (rows.some(r => r.step === "conflict_garden.escalated" && r.pr_number === pr.prNumber && r.head_sha === pr.headSha)) continue;
      const pending = rows.findLast(r => r.step === "conflict_garden.act" && r.pr_number === pr.prNumber &&
        typeof r.new_head_sha === "string" && (r.head_sha === pr.headSha || r.new_head_sha === pr.headSha) &&
        rows.findLast(v => v.step === "conflict_garden.verified" && v.act_id === r.act_id)?.outcome === "pending");
      if (pending) continue;
      let approach = rows.findLast(r => r.step === "conflict_garden.judged" && r.pr_number === pr.prNumber &&
        r.verdict === "change-approach")?.approach as string | undefined;
      for (const tier of CONFLICT_GARDEN_TIERS) {
        const verdict = conflictGardenGovernorVerdict(tier, rows, ports.controls?.() ?? {}, ports.now());
        const common = { pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha, main_sha: mainSha, tier,
          parent_green: pr.checksState === "green", act_id: `${ports.runId}:${pr.prNumber}:${tier}:${ports.now()}` };
        if (verdict.tier !== "live") {
          if (verdict.tier === "shadow") {
            const hold = await ports.skip(pr, await ports.ledger());
            record("conflict_garden.act", { ...common, mode: "shadow", outcome: hold ? "held" : "clean",
              reason: hold ?? verdict.reason, would_act: tier });
          }
          break;
        }
        const hold = await ports.skip(pr, await ports.ledger());
        if (hold) { skipped.push({ pr_number: pr.prNumber, reason: hold }); break; }
        let result: ConflictGardenAct;
        try { result = await ports.act(pr, tier, mainSha, approach); }
        catch (error) { result = { outcome: "error", reason: String(error) }; }
        const act = record("conflict_garden.act", { ...common, mode: "live", outcome: result.outcome,
          new_head_sha: result.newHeadSha, reason: result.reason });
        report.acts = Number(report.acts) + 1;
        const verification = result.newHeadSha ? await verifyAct(ports, pr, act) : undefined;
        if (verification) rows.push(verification);
        if (tier !== "deterministic") {
          const history = rows.filter(r => r.step === "conflict_garden.act" && r.pr_number === pr.prNumber);
          const input = { ...buildFixProgressInput({ ledger: rows, prNumber: pr.prNumber, taskId: pr.taskId,
            headSha: result.newHeadSha ?? pr.headSha,
            ...(verification?.outcome === "pending" ? { parkedReason: "mergeability or required checks pending" } : {}),
            currentRed: verification?.outcome === "verified" ? [] : ["merge-conflict"] }), remedyHistory: history };
          const { decision } = await resolveFixProgress(input, rows, { judge: ports.judge });
          const judgedPr = { ...pr, headSha: result.newHeadSha ?? pr.headSha };
          record("conflict_garden.judged", { ...common, head_sha: judgedPr.headSha, ...decision });
          if (decision.verdict === "unavailable") break;
          if (decision.verdict === "escalate") {
            const fresh = await ports.ledger();
            if (!fresh.some(r => r.step === "conflict_garden.escalated" && r.pr_number === pr.prNumber && r.head_sha === judgedPr.headSha)) {
              const url = await ports.escalate(judgedPr, decision.reason);
              if (url) record("conflict_garden.escalated", { ...common, head_sha: judgedPr.headSha, issue_url: url, reason: decision.reason });
            }
            break;
          }
          if (decision.verdict === "change-approach") approach = decision.approach;
        }
        if (result.newHeadSha || result.outcome === "held" || result.outcome === "lease-mismatch") break;
      }
    }
  } catch (error) {
    report.error = String(error);
    ports.log("conflict_garden.failed", { reason: String(error) });
  } finally {
    ports.log("conflict_garden.report", report);
  }
}

export async function conflictGardenIntent(
  pr: OpenPrView, mainSha: string, git: (args: readonly string[]) => Promise<string>,
): Promise<string> {
  const base = (await git(["merge-base", pr.headSha, mainSha])).trim();
  const files = pr.mergeConflict?.files ?? [];
  const count = files.length + 1;
  const share = Math.max(0, Math.floor((CONFLICT_GARDEN_INTENT_CHARS - 2 * count) / count));
  const sections = [`PR body (branch intent):\n${pr.body ?? "(not captured)"}`.slice(0, share)];
  for (const file of files) {
    const log = await git(["log", "--format=%s%n%b", `${base}..${mainSha}`, "--", file.path]);
    sections.push(`Main intent per conflicted file:\n${file.path}:\n${log}`.slice(0, share));
  }
  return sections.join("\n\n").slice(0, CONFLICT_GARDEN_INTENT_CHARS);
}
