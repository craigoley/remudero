import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { ciFrictionRecordVerdict, ciFrictionRecencyWeight, gitCiFrictionOwnerSearch, type CiFrictionPlanState } from "./ci-friction-gardener.js";
import { CI_FRICTION_EFFECT_MAX_WINDOW_MS, CI_FRICTION_ESCALATE_RUNG, type CiFrictionRemedyTask, type OwnerSearch, type RemedyEffect } from "./ci-friction-remedy.js";
import type { Escalation } from "./escalate.js";
import { slug } from "./feedback-docket.js";
import { gardenLedgerBucket, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { ghExec } from "./github-transport.js";
import { ledgerRotationEntries, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardFilingRefusal, machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { loadPlanFromYaml } from "./plan.js";
import { PR_BLOCKERS, type PrBlocker } from "./pr-blocker.js";
import { resolveRepoLayout } from "./repo-layout.js";
import type { LedgerRecord } from "./retro.js";

export interface PrOutcome { state: "open" | "closed" | "merged"; at?: string; mergedBy?: string }
export interface Charge { pr: number; key: string; start: number; end: number; hours: number; reason: string; owner: string }
export interface Episode {
  pr: number; key: string; owner: string; start: number; end: number;
  outcome: "open" | "cleared" | "failed" | "unknown"; eligible: boolean;
  charges: Charge[];
}
export interface Price { key: string; hours: number; prs: number; owners: string[]; thresholdHours?: number }
interface Prior { task: CiFrictionRemedyTask; effect?: RemedyEffect }
export interface FlowAction extends GardenAction<"draft"> {
  price: Price; origin: string; rung: number; prior?: Prior; escalation?: string;
  charges: Charge[]; population: number[];
}
export interface Inventory {
  charges: Charge[]; episodes: Episode[]; priced: Price[]; candidates: Price[];
  next?: FlowAction; ladder: Array<{ cause: string; state: string; rung: number; effect?: RemedyEffect }>;
}
export interface FlowGardenSources {
  owner: string; repo: string;
  mintTaskId: (branch?: string) => string;
  ledgerRecords?: () => readonly LedgerRecord[];
  planState?: () => CiFrictionPlanState;
  prOutcomes?: (prs: readonly number[]) => ReadonlyMap<number, PrOutcome>;
  ownerSearch?: OwnerSearch;
  draftShard?: (action: FlowAction, taskId: string) => string;
  escalate?: (escalation: Escalation) => string | null;
}

/**
 * W1-T7421: the draft -> measure effect -> escalate ladder, kept ONE implementation. A garden that prices a
 * cause and files one remedy per cause names its {@link LadderKind}; the flow gardener is one (`flow-blocker`),
 * the fix-lane gardener another (`fix-lane`). Nothing below forks on which.
 */
export interface LadderKind {
  /** The garden's spec name (ledger prefix, branch stem). */
  name: string;
  /** The `origin:` prefix a remedy task carries: `<prefix>:<cause key>[#r<rung>]`. */
  prefix: string;
  /** The ledger step whose pr_url rows prove a filing is in flight, and the one an escalation is recorded on. */
  receiptStep: string;
  escalatedStep: string;
  /** The stem of the remedy's shard and test names. */
  stem: string;
  title: (action: FlowAction) => string;
  commitTitle: (cause: string) => string;
  claim: (cause: string) => string;
  ownerLine: (action: FlowAction) => string;
  evidenceLine: (pr: number, hours: number, reason: string) => string;
  escalationSummary: (cause: string) => string;
  /** Files a remedy may own when no source file mentions the cause's text. */
  fallbackFiles?: readonly string[];
}

export const FLOW_LADDER: LadderKind = {
  name: "flow-remedy", prefix: "flow-blocker", receiptStep: "flow.scorecard", escalatedStep: "flow.remedy_escalated", stem: "flow",
  title: a => `THE FLOW GARDENER'S COSTLIEST UNOWNED BLOCKER — ${a.price.key} cost ${a.price.hours.toFixed(2)} PR-hours`,
  commitTitle: cause => `chore(plan): draft a flow remedy for ${cause}`,
  claim: cause => `${cause} is cleared by its owner without manual intervention`,
  ownerLine: a => `Owner ${a.price.owners.includes("NONE") ? "NONE is absent" : a.price.owners.join(", ") + " failed to clear eligible episodes"}.`,
  evidenceLine: (pr, hours, reason) => `- PR #${pr}: ${hours.toFixed(2)} PR-hours — ${reason}`,
  escalationSummary: cause => `Flow blocker: ${cause} still costs PR-hours`,
};

const originOf = (kind: LadderKind, key: string, rung: number) => `${kind.prefix}:${key}${rung > 1 ? `#r${rung}` : ""}`;
const parseOrigin = (kind: LadderKind, origin: string) =>
  new RegExp(`^${kind.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(.+?)(?:#r(\\d+))?$`).exec(origin);
/** Normalises a free-text reason into a class key: shas, PR numbers and counts collapse, the detail after " — " drops. */
export const reasonClass = (reason: string) => reason.split(" — ")[0]!
  .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
  .replace(/\/pull\/\d+/g, "/pull/<n>").replace(/\b\d+(?:\.\d+)?\b/g, "<n>").trim();
export const isFleet = (actor: string | undefined) => actor === "remudero-fleet[bot]" || actor === "app/remudero-fleet";

/** The ledger union the ladder reads: `steps` plus the kind's own receipt and escalation rows. */
export function readLadderRecords(stateDir: string, kind: LadderKind, steps: readonly string[] = ["sweep.disposed"]): LedgerRecord[] {
  const read = readLedgerUnionRecordsSync(stateDir, {
    step: [...new Set([...steps, kind.receiptStep, kind.escalatedStep])], requireArchives: true, refuseIncomplete: true,
  });
  if (!read.ok) throw new Error(`${kind.stem} ledger union unreadable: ${read.unread.join(", ") || "missing or incomplete rotations"}`);
  return read.rows as LedgerRecord[];
}

export function readLadderPlan(repoRoot: string, kind: LadderKind): CiFrictionPlanState {
  const git = (args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let degraded: string | undefined;
  try { git(["fetch", "--quiet", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]); }
  catch (error) {
    const reason = `fetch failed (${String(error)}); read the last fetched origin/main`;
    degraded = reason;
  }
  const shards = relative(repoRoot, join(resolveRepoLayout(repoRoot).planDir, "tasks.d"));
  let listed = "";
  try { listed = git(["grep", "-l", "-E", `^[[:space:]]*origin:[[:space:]]*[\"']?${kind.prefix}:`, "origin/main", "--", shards]); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const merges = new Map<string, string>();
  for (const line of git(["log", "origin/main", "--format=%cI%x09%(trailers:key=Remudero-Task,valueonly,separator=%x2C)"]).split("\n")) {
    const [at, ids] = line.split("\t");
    for (const id of (ids ?? "").split(",").map(s => s.trim()).filter(Boolean)) if (at) merges.set(id, at);
  }
  const tasks: CiFrictionRemedyTask[] = [];
  const unreadable: string[] = [];
  for (const path of listed.trim().split("\n").filter(Boolean).map(p => p.replace("origin/main:", ""))) {
    try {
      for (const task of loadPlanFromYaml(git(["show", `origin/main:${path}`]), path).tasks) {
        if (!task.origin || !parseOrigin(kind, task.origin)) continue;
        tasks.push({ id: task.id, origin: task.origin, status: task.status, retired: task.retirement !== undefined,
          files: [...(task.files ?? [])], path, mergedAt: merges.get(task.id) });
      }
    } catch (error) {
      const reason = `${path}: ${String(error)}`;
      unreadable.push(reason);
    }
  }
  return { tasks, degraded, unreadable };
}

export function readOutcomes(prs: readonly number[], sources: FlowGardenSources): ReadonlyMap<number, PrOutcome> {
  const result = new Map<number, PrOutcome>();
  // W1-T5538: one batched read per fifty PRs; a missing merger remains unknown, never owner-cleared.
  for (let offset = 0; offset < prs.length; offset += 50) {
    const batch = prs.slice(offset, offset + 50);
    const query = `query { repository(owner:${JSON.stringify(sources.owner)}, name:${JSON.stringify(sources.repo)}) { ${batch.map(pr =>
      `p${pr}:pullRequest(number:${pr}) { state mergedAt closedAt mergedBy { login } }`).join(" ")} } }`;
    const body = JSON.parse(ghExec(["api", "graphql", "-f", `query=${query}`], { encoding: "utf8" }));
    if (body.errors) throw new Error("flow PR outcomes unreadable: GraphQL errors");
    if (body.data === undefined || body.data === null) throw new Error("flow PR outcomes unreadable: data missing");
    const repository = body.data.repository;
    if (repository === undefined || repository === null) throw new Error("flow PR outcomes unreadable: repository missing");
    for (const pr of batch) {
      const row = repository[`p${pr}`];
      if (!row || !["OPEN", "CLOSED", "MERGED"].includes(row.state)) throw new Error(`flow PR #${pr} outcome missing`);
      result.set(pr, { state: row.state.toLowerCase(), at: row.mergedAt ?? row.closedAt ?? undefined, mergedBy: row.mergedBy?.login });
    }
  }
  return result;
}

export function episodesOf(records: readonly LedgerRecord[], outcomes: ReadonlyMap<number, PrOutcome>, now: number): Episode[] {
  const byPr = new Map<number, LedgerRecord[]>();
  for (const r of records) {
    if (r.step !== "sweep.disposed" || !Number.isSafeInteger(r.pr_number) || Number(r.pr_number) <= 0 ||
        !PR_BLOCKERS.includes(r.blocker as PrBlocker) || typeof r.ts !== "string" || !Number.isFinite(Date.parse(r.ts)) ||
        Date.parse(r.ts) > now || typeof r.reason !== "string" || typeof r.blocker_owner !== "string") continue;
    const pr = Number(r.pr_number);
    const rows = byPr.get(pr) ?? [];
    rows.push(r);
    byPr.set(pr, rows);
  }
  const episodes: Episode[] = [];
  for (const [pr, observations] of byPr) {
    const rows = [...new Map(observations.sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!)).map(r => [r.ts!, r])).values()];
    let episode: Episode | undefined;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const start = Date.parse(r.ts!);
      const key = `${r.blocker}:${reasonClass(String(r.reason))}`;
      if (!episode || episode.key !== key || episode.owner !== r.blocker_owner) {
        if (episode) { episode.outcome = "cleared"; episode.end = start; }
        episode = { pr, key, owner: String(r.blocker_owner), start, end: start, outcome: "open", eligible: false, charges: [] };
        episodes.push(episode);
      }
      const next = rows[i + 1];
      if (next) {
        const end = Date.parse(next.ts!);
        episode.end = end;
        episode.charges.push({ pr, key, start, end, hours: (end - start) / 3_600_000, reason: String(r.reason), owner: episode.owner });
      }
    }
    if (!episode) continue;
    const terminal = outcomes.get(pr);
    if (terminal && terminal.state !== "open") {
      const at = Date.parse(terminal.at ?? "");
      episode.end = Number.isFinite(at) ? Math.max(episode.end, at) : episode.end;
      episode.outcome = terminal.state === "closed" ? "failed" : terminal.mergedBy === undefined ? "unknown" : isFleet(terminal.mergedBy) ? "cleared" : "failed";
    }
  }
  return episodes;
}

function priceEpisodes(episodes: readonly Episode[], now: number): Price[] {
  const byKey = new Map<string, { hours: number; prs: Set<number>; owners: Set<string> }>();
  for (const episode of episodes) {
    const hours = episode.charges.reduce((sum, c) => sum + c.hours * ciFrictionRecencyWeight(fixedClock(c.end).iso(), now), 0);
    if (hours <= 0) continue;
    const price = byKey.get(episode.key) ?? { hours: 0, prs: new Set<number>(), owners: new Set<string>() };
    price.hours += hours; price.prs.add(episode.pr); price.owners.add(episode.owner);
    byKey.set(episode.key, price);
  }
  return [...byKey].map(([key, p]) => ({ key, hours: p.hours, prs: p.prs.size, owners: [...p.owners].sort() }))
    .sort((a, b) => b.hours - a.hours || b.prs - a.prs || a.key.localeCompare(b.key));
}

function effectOf(charges: readonly Charge[], key: string, merge: number, now: number): RemedyEffect {
  const span = Math.min(Math.max(0, now - merge), CI_FRICTION_EFFECT_MAX_WINDOW_MS);
  const before = { k: 0, n: 0 }, after = { k: 0, n: 0 };
  for (const charge of charges) {
    for (const [side, start, end] of [[before, merge - span, merge], [after, merge, merge + span]] as const) {
      const hours = Math.max(0, Math.min(charge.end, end) - Math.max(charge.start, start)) / 3_600_000;
      side.n += hours;
      if (charge.key === key) side.k += hours;
    }
  }
  const windowDays = span / 86_400_000;
  const share = (w: typeof before) => w.n > 0 ? w.k / w.n : 0;
  const pooled = (before.k + after.k) / (before.n + after.n || 1);
  const se = before.n > 0 && after.n > 0 ? Math.sqrt(pooled * (1 - pooled) * (1 / before.n + 1 / after.n)) : 0;
  const z = se > 0 ? (share(after) - share(before)) / se : 0;
  const verdict = before.k === 0 ? "unmeasurable" : after.n > 0 && z <= -1.6449 ? "credit" :
    share(before) * after.n >= before.k ? "debit" : "pending";
  return { verdict, before, after, windowDays, z,
    reason: `${verdict}: share of PR-hours ${(share(before) * 100).toFixed(1)}% (${before.k}/${before.n}) before, ${(share(after) * 100).toFixed(1)}% (${after.k}/${after.n}) after, ${windowDays} day(s) each side` };
}

/** Marks which episodes are worth a remedy: no owner, a failed end, or an open wait past the p90 of cleared ones. */
export function markEligibility(episodes: Episode[], now: number): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const key of new Set(episodes.map(e => e.key))) {
    const cleared = episodes.filter(e => e.key === key && e.owner !== "NONE" && e.outcome === "cleared")
      .map(e => (e.end - e.start) / 3_600_000).sort((a, b) => a - b);
    if (cleared.length) thresholds.set(key, cleared[Math.ceil(cleared.length * 0.9) - 1]!);
  }
  for (const e of episodes) {
    const threshold = thresholds.get(e.key);
    e.eligible = e.owner === "NONE" || e.outcome === "failed" ||
      (e.outcome === "open" && threshold !== undefined && (now - e.start) / 3_600_000 > threshold);
  }
  return thresholds;
}

function inventoryOf(records: readonly LedgerRecord[], tasks: readonly CiFrictionRemedyTask[], outcomes: ReadonlyMap<number, PrOutcome>, now: number): Inventory {
  const episodes = episodesOf(records, outcomes, now);
  const thresholds = markEligibility(episodes, now);
  return ladderOf(FLOW_LADDER, episodes, records, tasks, now, thresholds);
}

/**
 * The shared rung logic: price the episodes' cause keys, find each cause's remedy among the plan's tasks, measure the
 * effect of a merged one, and name the next draft or escalation. A cause with a remedy still open drafts nothing.
 */
export function ladderOf(kind: LadderKind, episodes: Episode[], records: readonly LedgerRecord[], tasks: readonly CiFrictionRemedyTask[],
  now: number, thresholds: ReadonlyMap<string, number> = new Map()): Inventory {
  const charges = episodes.flatMap(e => e.charges);
  const priced = priceEpisodes(episodes, now);
  const candidates = priceEpisodes(episodes.filter(e => e.eligible), now).map(p => ({ ...p, thresholdHours: thresholds.get(p.key) }));
  const ladder: Inventory["ladder"] = [];
  let next: FlowAction | undefined;
  const receipts = new Set(records.filter(r => r.step === kind.receiptStep && typeof r.pr_url === "string" && /\/pull\/\d+$/.test(r.pr_url))
    .map(r => (r.next as { origin?: string } | undefined)?.origin).filter((s): s is string => typeof s === "string"));
  const escalated = new Set(records.filter(r => r.step === kind.escalatedStep && typeof r.issue_url === "string").map(r => r.origin));
  for (const price of candidates.slice(0, 8)) {
    const mine = tasks.filter(t => parseOrigin(kind, t.origin)?.[1] === price.key);
    const top = [...mine].sort((a, b) => Number(parseOrigin(kind, b.origin)?.[2] ?? 1) - Number(parseOrigin(kind, a.origin)?.[2] ?? 1))[0];
    let rung = top ? Number(parseOrigin(kind, top.origin)?.[2] ?? 1) : 1;
    let state = "draft";
    let effect: RemedyEffect | undefined;
    let prior: Prior | undefined;
    if (mine.some(t => !t.retired && !t.mergedAt)) state = "in_progress";
    else if (top?.retired && !top.mergedAt) state = "retired";
    else if (top?.mergedAt) {
      // expiring-fixture: exempt -- effect fixtures use an injected fixed Clock, independent of wall time
      const merge = Date.parse(top.mergedAt);
      if (!Number.isFinite(merge)) state = "in_progress";
      else {
        effect = effectOf(charges, price.key, merge, now);
        state = effect.verdict === "pending" ? "measuring" : effect.verdict === "debit" ? "draft" : "resolved";
        if (state === "draft") { rung++; prior = { task: top, effect }; }
      }
    }
    const origin = originOf(kind, price.key, rung);
    if (receipts.has(origin) && !mine.some(t => t.origin === origin)) state = "in_progress";
    if (escalated.has(origin)) state = "escalated";
    if (state === "draft" && rung >= CI_FRICTION_ESCALATE_RUNG) state = "escalate";
    ladder.push({ cause: price.key, state, rung, effect });
    if (!next && (state === "draft" || state === "escalate")) {
      next = { class: "draft", target: origin, origin, rung, price, prior,
        charges: episodes.filter(e => e.eligible && e.key === price.key).flatMap(e => e.charges),
        population: candidates.map(p => p.hours), reason: `${price.key} cost ${price.hours.toFixed(2)} PR-hours; owner ${price.owners.join(", ")}`,
        ...(state === "escalate" ? { escalation: `${rung - 1} remedy rungs did not reduce the share of PR-hours` } : {}) };
    }
  }
  return { episodes, charges, priced, candidates, ladder, next };
}

function draftShard(action: FlowAction, taskId: string, search: OwnerSearch, kind: LadderKind): string {
  const [blocker, ...reason] = action.price.key.split(":");
  const matches = search.filesContaining(reason.join(":"));
  const found = matches.length ? matches : search.filesContaining(blocker!);
  const files = (found.length ? found : (kind.fallbackFiles ?? []).filter(f => search.fileExists(f)).map(file => ({ file, hits: 0 })))
    .sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file));
  if (!files.length) throw new Error(`${kind.stem} gardener: no source owner found for ${action.price.key}`);
  const stem = slug(action.price.key, 80);
  const testPath = `test/${kind.stem}-${stem}.test.ts`;
  const evidence = new Map<number, { hours: number; reason: string }>();
  for (const c of action.charges) {
    const prior = evidence.get(c.pr);
    evidence.set(c.pr, { hours: (prior?.hours ?? 0) + c.hours, reason: c.reason });
  }
  return renderMachineShard({ taskId, origin: action.origin,
    title: kind.title(action),
    files: [files[0]!.file, testPath], cost: action.price.hours, costPopulation: action.population,
    acceptance: [{ claim: kind.claim(action.price.key),
      proof: `grep: test("${taskId}: ${kind.stem}-${stem} clears without a person" in ${testPath}` }],
    note: `Filed by ${kind.stem} at rung ${action.rung}; measure the cause's share of PR-hours after the build merges.`,
    rationale: [action.reason, kind.ownerLine(action),
      `Source owner: ${files[0]!.file}. Top five PRs by observed hours, with original blocker reasons:`,
      ...[...evidence].sort((a, b) => b[1].hours - a[1].hours || a[0] - b[0]).slice(0, 5)
        .map(([pr, e]) => kind.evidenceLine(pr, e.hours, e.reason)),
      ...(action.prior ? [`Previous remedy ${action.prior.task.id}: ${action.prior.task.files.join(", ")}; ${action.prior.effect?.reason}. Take a structurally different remedy.`] : []),
      "Effect compares this cause's share of total PR-hours in equal windows before and after its build merge; a debit reopens one rung up.",
    ],
  }).text;
}

/** What a ladder garden supplies: its kind, how to read its inventory, and the filing seams. */
export interface LadderSpecInput {
  kind: LadderKind;
  sources: Pick<FlowGardenSources, "mintTaskId" | "ownerSearch" | "draftShard" | "escalate">;
  inventory: () => Inventory;
  /** The pacing bucket the cheap fingerprint carries; the flow ladder re-reads hourly, the fix-lane ladder daily. */
  bucket?: (clock: Clock) => number;
  /** Called once per pass with the scorecard the pass is about to log (the fix-lane garden writes its report here). */
  onScorecard?: (inventory: Inventory, scorecard: Record<string, unknown>) => void;
}

/** The draft -> measure -> escalate ladder as a garden spec (W1-T7421: one implementation for every ladder). */
export function ladderGardenSpec(deps: GardenerDeps, input: LadderSpecInput): GardenSpec<"draft", Inventory, FlowAction, GardenCheckout> {
  const { kind, sources } = input;
  const clock = deps.clock ?? systemClock;
  const bucket = input.bucket ?? gardenLedgerBucket;
  return {
    name: kind.name, landingRefusal: machineShardLandingGuard(deps, sources.ownerSearch?.fileExists), classes: ["draft"], review: { draft: "a remedy task is a judgement call for the machine-filing judge or a person" },
    cheapFingerprint: () => {
      const head = execFileSync("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 60_000 }).trim();
      const archives = ledgerRotationEntries(readdirSync(deps.stateDir), deps.stateDir).map(e => {
        const s = statSync(e.path); return `${basename(e.path)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
      }).join("|");
      return `${head}:${bucket(clock)}:${archives}`;
    },
    inventory: input.inventory,
    unfinished: inv => inv.next !== undefined,
    fingerprint: inv => `${inv.candidates.map(p => `${p.key}:${p.hours}`).join(",")}|${inv.next?.origin ?? ""}`,
    candidates: inv => inv.next ? [inv.next] : [],
    scorecard: inv => {
      const scorecard = { causes: inv.priced.length, total_pr_hours: inv.priced.reduce((sum, p) => sum + p.hours, 0),
        next: inv.next ? { origin: inv.next.origin, rung: inv.next.rung } : null, ladder: inv.ladder };
      input.onScorecard?.(inv, scorecard);
      return scorecard;
    },
    apply: (ws, plan) => {
      const action = plan.actions[0];
      if (!action) return undefined;
      if (action.escalation) {
        const escalation: Escalation = { class: "BLOCKED", taskId: `${kind.stem}-${slug(action.price.key, 60)}`,
          summary: kind.escalationSummary(action.price.key), detail: `${action.reason}\n${action.escalation}\n${action.prior?.effect?.reason ?? ""}`,
          options: [{ label: "design-remedy", detail: "name a structural remedy and file it" }, { label: "accept-cost", detail: `retire ${action.origin}` }],
          recommendation: "design-remedy", headDedup: "independent" };
        const issue = sources.escalate ? sources.escalate(escalation) : deps.escalate?.(escalation);
        deps.log(kind.escalatedStep, { origin: action.origin, rung: action.rung, reason: action.escalation, issue_url: issue ?? null });
        return undefined;
      }
      if (!ws.branch) throw new Error(`${kind.stem} gardener: filing workspace has no reservation branch`);
      const id = sources.mintTaskId(ws.branch);
      const search = sources.ownerSearch ?? gitCiFrictionOwnerSearch(args => execFileSync("git", ["-C", deps.repoRoot, ...args], { encoding: "utf8", timeout: 60_000 }));
      const contents = sources.draftShard ? sources.draftShard(action, id) : draftShard(action, id, search, kind);
      const verdict = ciFrictionRecordVerdict(contents, `${kind.stem}:${id}`);
      if (!verdict.ok) throw new Error(`${kind.stem} gardener: drafted record failed lint (${verdict.reason})`);
      const draftedPlan = loadPlanFromYaml(contents, `${kind.stem}:${id}`);
      if (draftedPlan.tasks.length !== 1) throw new Error(`${kind.stem} gardener: drafted shard must contain exactly one task (found ${draftedPlan.tasks.length})`);
      const dir = join(resolveRepoLayout(ws.root).planDir, "tasks.d");
      const path = join(dir, `${id}-${kind.stem}-${slug(action.price.key, 80)}.yaml`);
      // lint-plan's verdict before the draft reaches disk; the spec's `landingRefusal` re-reads the landing.
      const refused = machineShardFilingRefusal(contents, relative(ws.root, path), {
        pathExists: p => existsSync(join(ws.root, p)) || existsSync(join(deps.repoRoot, p)),
        pathExistsAtBase: search.fileExists
      });
      if (refused !== undefined) throw new Error(`${kind.stem} gardener: drafted record failed machine-filing admission (${refused})`);
      mkdirSync(dir, { recursive: true }); writeFileSync(path, contents);
      const relPath = relative(ws.root, path);
      const originPattern = JSON.stringify(action.origin).slice(1, -1).replace(/[.\[\]*^$\\]/g, "\\$&");
      return { paths: [relPath], title: kind.commitTitle(slug(action.price.key, 55)),
        body: `${action.reason}\n\nAcceptance:\n- the costliest unowned blocker is filed once | grep: ${originPattern} in ${relPath}` };
    },
  };
}

/** W1-T5538: prices observed PR waits and files one admitted remedy for an unowned or uncleared cause. */
export function flowGardenSpec(deps: GardenerDeps, sources: FlowGardenSources): GardenSpec<"draft", Inventory, FlowAction, GardenCheckout> {
  const clock = deps.clock ?? systemClock;
  return ladderGardenSpec(deps, {
    kind: FLOW_LADDER, sources,
    inventory: () => {
      const records = sources.ledgerRecords ? sources.ledgerRecords() : readLadderRecords(deps.stateDir, FLOW_LADDER);
      const plan = sources.planState ? sources.planState() : readLadderPlan(deps.repoRoot, FLOW_LADDER);
      if (plan.degraded) deps.log("flow.origins_degraded", { reason: plan.degraded });
      if (plan.unreadable?.length) throw new Error(`flow plan shards unreadable: ${plan.unreadable.join(", ")}`);
      const prs = [...new Set(episodesOf(records, new Map(), clock.now()).filter(e => e.outcome === "open" && e.owner !== "NONE").map(e => e.pr))];
      const outcomes = sources.prOutcomes ? sources.prOutcomes(prs) : readOutcomes(prs, sources);
      return inventoryOf(records, plan.tasks, outcomes, clock.now());
    },
  });
}
